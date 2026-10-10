/**
 * 自检：把不依赖飞书凭据的纯逻辑跑一遍真实数据。
 * 运行：node scripts/selftest.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { paths, config, ensureDirs, CATEGORIES } from '../bot/config.mjs';
import { sniffFormat, ingestImage } from '../bot/media.mjs';
import { parseMessage, isAllowed } from '../bot/events.mjs';
import { renderXlsx, renderWeb } from '../bot/render.mjs';
import { betterDirection, comparableNumber, computeEmphasis } from '../bot/emphasis.mjs';
import { JobQueue } from '../bot/queue.mjs';
import { writeGuard } from '../bot/agent.mjs';
import { createRenderServer, renderToolDefinition } from '../bot/tools.mjs';
import ExcelJS from 'exceljs';

// ── 沙箱：自检绝不能碰真实的 workspace/ 和 state/ ──────────────────
// 这里以前是直接对着真实路径跑的，队列那节上来就 `rmSync(paths.journal)`。
// 而 journal 同时就是飞书事件去重表，于是在**跑着机器人的机器**上执行
// `npm test`，会把去重记录一并清空 —— 飞书 7 小时窗口内的重推（实测会推到
// +6 分钟）就会被当成新消息，重复跑 Agent、重复写文件、重复花钱。
// 现在把所有落盘路径改指到临时目录，退出时删除。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-selftest-'));
for (const key of Object.keys(paths)) {
  if (key === 'root') continue;          // root 只作展示，没有落盘行为
  paths[key] = path.join(SANDBOX, key);
}
process.on('exit', () => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 退出路径上尽力而为 */ }
});

ensureDirs();

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 52 - t.length))}`);

// ── 1. magic bytes 嗅探 ────────────────────────────────────────────
section('图片格式嗅探（不信扩展名）');
{
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  const junk = Buffer.alloc(32, 0x7f);

  ok('PNG', sniffFormat(png) === 'png');
  ok('JPEG', sniffFormat(jpg) === 'jpeg');
  ok('GIF', sniffFormat(gif) === 'gif');
  ok('WEBP', sniffFormat(webp) === 'webp');
  ok('HEIC（iPhone 照片）', sniffFormat(heic) === 'heic');
  ok('垃圾数据判为 unknown', sniffFormat(junk) === 'unknown');
}

// ── 2. 图片落地：转码 / 长图切分 / 去重 ────────────────────────────
section('图片落地');
{
  // 尺寸带随机性，否则连跑两次会命中上一轮的去重记录（那是在测测试，不是测代码）
  const w = 600 + Math.floor(Math.random() * 40);
  const png = await sharp({ create: { width: w, height: 400, channels: 3, background: '#369' } }).png().toBuffer();

  const first = await ingestImage(png, { label: 'test' });
  ok('落盘成功', first.paths.length === 1 && fs.existsSync(first.paths[0]), JSON.stringify(first));
  ok('转成 Agent 能读的 .jpg', first.paths[0]?.endsWith('.jpg'));

  const second = await ingestImage(png, { label: 'test' });
  ok('同一张图第二次被去重', second.duplicate === true && second.paths.length === 0);

  // 长截图：比例 > 3，应该被切分
  const tall = await sharp({
    create: { width: 1080, height: 5800 + Math.floor(Math.random() * 400), channels: 3, background: '#eee' },
  }).png().toBuffer();
  const tiled = await ingestImage(tall, { label: 'tall' });
  ok('长截图被切分', tiled.paths.length > 1, `切了 ${tiled.paths.length} 张`);
  ok('切分时给出了提示', typeof tiled.note === 'string' && tiled.note.includes('长截图'));
  const maxEdgeOk = await Promise.all(tiled.paths.map(async (p) => {
    const m = await sharp(p).metadata();
    return Math.max(m.width, m.height) <= 2048;
  }));
  ok('每张切片都在 2048px 以内', maxEdgeOk.every(Boolean));

  // 清理（含之前跑失败留下的）
  for (const p of [...first.paths, ...tiled.paths]) fs.rmSync(p, { force: true });
  for (const day of fs.readdirSync(paths.raw)) {
    const dir = path.join(paths.raw, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^(test|tall)-/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

// ── 3. 飞书事件解析与访问控制 ──────────────────────────────────────
section('事件解析');
{
  const textEvt = {
    event_id: 'ev1',
    sender: { sender_id: { open_id: 'ou_a' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '@_user_1 这是XX摄影的报价' }),
    },
  };
  const t = parseMessage(textEvt);
  ok('文本消息解析', t.text === '这是XX摄影的报价', t.text);
  ok('@提及占位符被清掉', !t.text.includes('@_user_1'));
  ok('私聊无白名单时放行', isAllowed(t) === true);

  const imgEvt = {
    event_id: 'ev2',
    sender: { sender_id: { open_id: 'ou_a' } },
    message: {
      message_id: 'om_2', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'image', content: JSON.stringify({ image_key: 'img_v2_abc' }),
    },
  };
  ok('图片消息抽出 image_key', parseMessage(imgEvt).images[0] === 'img_v2_abc');

  const postEvt = {
    event_id: 'ev3',
    sender: { sender_id: { open_id: 'ou_a' } },
    message: {
      message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({
        title: '套餐',
        content: [[{ tag: 'text', text: '总价8999' }, { tag: 'img', image_key: 'img_v2_p1' }]],
      }),
    },
  };
  const post = parseMessage(postEvt);
  ok('富文本里的文字被抽出', post.text.includes('8999'), post.text);
  ok('富文本里的图片被抽出（关键：它不会以 image 类型到达）', post.images[0] === 'img_v2_p1');

  ok('sticker 等无意义类型被忽略', parseMessage({
    event_id: 'ev4', message: { message_type: 'sticker', content: '{}', chat_id: 'c', message_id: 'm' },
  }) === null);

  const groupNoMention = {
    event_id: 'ev5',
    sender: { sender_id: { open_id: 'ou_b' } },
    message: {
      message_id: 'om_5', chat_id: 'oc_g', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text: '好的' }),
    },
  };
  ok('群里没 @机器人 → 不触发（否则每条「好的」都跑一次分析）',
    isAllowed(parseMessage(groupNoMention)) === false);
}

// ── 4. 渲染 ────────────────────────────────────────────────────────
section('渲染产物');
{
  const rows = [
    ['商家', '报价', '精修张数', '服装套数', '需确认'],
    ['某某婚纱摄影', 8999, 40, 5, '是否含跟妆'],
    ['另一家影楼', 12999, 60, 6, '未知'],
    ['价格<含&特殊字符>', 6999, 30, 4, '—'],
  ];
  const xlsx = await renderXlsx(rows, { title: '自检-婚纱照对比' });
  ok('xlsx 生成', fs.existsSync(xlsx) && fs.statSync(xlsx).size > 2000, `${fs.statSync(xlsx).size} bytes`);

  const web = renderWeb(rows, { title: '自检-婚纱照对比', subtitle: '婚纱照' });
  const html = fs.readFileSync(web, 'utf8');
  ok('网页生成', fs.existsSync(web));
  ok('网页是自包含的（无外部依赖）', !/<script|https?:\/\/(?!www\.w3\.org)/i.test(html));
  ok('HTML 特殊字符被转义', html.includes('&lt;含&amp;特殊字符&gt;') && !html.includes('<含&'));
  ok('网页适配深色模式', html.includes('prefers-color-scheme'));
  ok('第一列钉住（纵向滚动时知道自己在看哪个字段）', html.includes('position:sticky'));
  ok('表格不会被内容撑宽（手机上不用左右滑）',
    html.includes('table-layout:fixed') && html.includes('width:100%'));
  ok('字段比对象多 → 转置：字段变行、对象变列',
    html.includes('class="flip"') && html.includes('<th class="field">报价</th>'));
  ok('转置后商家名在表头，不在行首',
    /<tr><th class="corner">商家<\/th><th>某某婚纱摄影<\/th>/.test(html));
  ok('纯数字右对齐（竖着扫一列比价）', html.includes('class="num"'));
  ok('不再是「可左右滑动」的老提示', !html.includes('可左右滑动'));

  // 高亮：只在 <tbody> 里断言。整页 includes('data-emph') 是假阳性 ——
  // 内联 <style> 里的 `td[data-emph=best]` 本身就含这段文字。
  const cells = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  ok('最低价那格标了 best', /data-emph="best"/.test(cells));
  ok('3 家以上才标 worst（用户拍板）', /data-emph="worst"/.test(cells));
  ok('高亮没污染 class（class="num" 原样保留）',
    cells.includes('class="num"') && !cells.includes('class="num '));
  const vagueRow = cells.split('<tr>').find((t) => t.includes('需确认')) ?? '';
  ok('说不清的列（需确认）整行没上色',
    vagueRow !== '' && !vagueRow.includes('data-emph'), vagueRow.slice(0, 90));

  // 反向：对象多、字段少（如按商家列的预算总表）不能转置，否则列数会炸开
  const many = [['商家', '报价'], ...Array.from({ length: 8 }, (_, i) => [`商家${i}`, 1000 + i])];
  const web2 = renderWeb(many, { title: '自检-预算总表' });
  const html2 = fs.readFileSync(web2, 'utf8');
  ok('对象多、字段少时保持原样（不转置）', !html2.includes('class="flip"'));

  // 非转置那条路径（emph[b+1][i]）只有这里覆盖得到
  const cells2 = html2.slice(html2.indexOf('<tbody>'), html2.indexOf('</tbody>'));
  ok('非转置路径也标了高亮', /data-emph="best"/.test(cells2) && /data-emph="worst"/.test(cells2));
  ok('第一列（商家名）永不参与比较', !/<th class="corner"[^>]*data-emph/.test(cells2));

  // 字段特别多的时候必须能横滑。真实数据里出现过 20 家 × 14 字段，那种表格
  // 在 390px 上被压成**一个字一行** —— 那时候上多少高亮都看不见。
  const wide = [
    ['商家', ...Array.from({ length: 14 }, (_, i) => `字段${i}`)],
    ...Array.from({ length: 20 }, (_, r) => [`商家${r}`, ...Array.from({ length: 14 }, () => 100 + r)]),
  ];
  const htmlW = fs.readFileSync(renderWeb(wide, { title: '自检-宽表' }), 'utf8');
  ok('宽表给出下限宽度（宁可横滑，也不能一个字一行）',
    /<table class="[^"]*" style="min-width:\d+px"/.test(htmlW), (htmlW.match(/<table[^>]*>/) || [])[0]);

  // 但 6 家对比（转置后 7 列）在手机上挤是挤、读得下来，不该被推去横滑
  const sixFit = [['商家', '报价', '底片', '精修张数', '服装套数', '拍摄天数', '额外费用', '定金'],
    ...Array.from({ length: 6 }, (_, i) => [`商家${i}`, 2999 + i, 180, 30 + i, 5, 1, '无', 1000])];
  ok('放得下就不给下限宽度（6 家对比仍然不用左右滑）',
    !/<table[^>]*min-width/.test(fs.readFileSync(renderWeb(sixFit, { title: '自检-六家' }), 'utf8')));

  // 2 家对比：只标绿，不标红
  const two = [['商家', '报价'], ['A家', 2999], ['B家', 3288]];
  const web3 = renderWeb(two, { title: '自检-两家对比' });
  const html3 = fs.readFileSync(web3, 'utf8');
  const cells3 = html3.slice(html3.indexOf('<tbody>'), html3.indexOf('</tbody>'));
  ok('两家对比只标绿不标红（标红等于每格都有底色）',
    /data-emph="best"/.test(cells3) && !/data-emph="worst"/.test(cells3));
  ok('图例解释了颜色', html3.includes('class="legend"'));

  // 没有任何高亮时不该出现图例（否则是在解释一个不存在的东西）
  const web4 = renderWeb([['商家', '备注'], ['A家', '送精修35张'], ['B家', '送精修30张']], { title: '自检-无高亮' });
  ok('没有高亮就不出现图例', !fs.readFileSync(web4, 'utf8').includes('class="legend"'));

  // 数据行缺列（Agent 手写 rows 时很容易犯）绝不能抛 ——
  // 一次异常会让 xlsx 和网页**同时**生不出来，比标错严重得多。
  let ragged = null;
  try {
    renderWeb([['商家', '报价'], ['A家']], { title: '自检-缺列' });
    await renderXlsx([['商家', '报价'], ['A家']], { title: '自检-缺列' });
  } catch (err) { ragged = err.message; }
  ok('数据行缺列时两种渲染都不抛异常', ragged === null, ragged || '');

  fs.rmSync(xlsx, { force: true });
  fs.rmSync(web, { force: true });
  fs.rmSync(web2, { force: true });
  fs.rmSync(web3, { force: true });
  fs.rmSync(web4, { force: true });
  fs.rmSync(path.join(paths.output, '自检-缺列.xlsx'), { force: true });
}

// ── 4b. 高亮：哪一列该标、哪一格不该抠 ────────────────────────────
section('高亮 · 方向与取值');
{
  // 第一层：这一列参不参与。以 spec §4 的真实字段名为准（下面会拿 spec 原文核对）。
  const LOW = ['报价', '单价', '总价', '加片单价', '定金', '额外费用',
    '试妆费', '异地费', '早妆加价', '交付周期', '超时费',
    '餐标（每桌）', '服务费比例', '低消', '进场费', '开瓶费'];
  const HIGH = ['底片', '精修张数', '服装套数', '拍摄天数', '跟妆时长', '妆造次数',
    '机位数量', '拍摄时长', '交付张数', '主持时长', '数量', '桌数'];
  const NONE = ['id', '商家', '别名', '状态', '版本', '需确认', '来源',
    '套餐名', '拍摄场景', '是否含跟妆', '相册相框摆台', '有效期', '尾款节点',
    '试妆费可抵', '含妈妈妆', '含伴娘妆', '含新郎妆', '化妆品品牌', '含发型头饰', '档期',
    '是否含摄像', '含快剪预告',
    '含督导策划', '含彩排', '含音响灯光', '语言', '风格', '含助理DJ',
    '名称', '分类', '购买渠道', '采购状态', '优先级', '备注',
    '城市', '酒店', '厅名', '是否含税', '备桌', '婚房', '音响灯光', '停车'];

  const expect = new Map([
    ...LOW.map((f) => [f, 'low']), ...HIGH.map((f) => [f, 'high']), ...NONE.map((f) => [f, null]),
  ]);
  const wrong = [...expect].filter(([f, d]) => (betterDirection(f) ?? null) !== d);
  ok(`${expect.size} 个真实字段的方向判断全部正确`, wrong.length === 0,
    wrong.map(([f, d]) => `${f} 期望 ${d} 实际 ${betterDirection(f)}`).join('；'));

  // 词表会漂移：Agent 改个列名就绕过了。所以拿 spec 原文来对 ——
  // 以后往 §4 里加字段而忘了改 emphasis.mjs，这里会红。
  const specText = fs.readFileSync(path.join(paths.root, 'spec', 'AGENT_SPEC.md'), 'utf8');
  const sec4 = (specText.split(/^## 4\./m)[1] ?? '').split(/^## 5\./m)[0];
  const ENUMS = ['待对比', '已定', '已淘汰', '待购', '已购', '已到货'];
  const specFields = [...new Set(sec4.split('\n').flatMap((line) => {
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const isTableRow = line.trimStart().startsWith('|');
    return (isTableRow ? spans.slice(0, 1) : spans)          // 表格行第一列才是字段名
      .filter((s) => !s.includes('/') && !ENUMS.includes(s));
  }))];
  const uncovered = specFields.filter((f) => !expect.has(f));
  ok(`spec §4 的 ${specFields.length} 个字段全部有归类`, specFields.length > 50 && uncovered.length === 0,
    uncovered.join('、') || `只解析到 ${specFields.length} 个，可能是 §4 结构变了`);
  const extra = [...expect.keys()].filter((f) => !specFields.includes(f));
  ok('这里的字段名没有 spec 里已不存在的', extra.length === 0, extra.join('、'));

  // 第二层：真实语料里抠得出 / 抠不出。每一条都来自磁盘上的真实产物。
  const cases = [
    // 表头点了量词，就只认那个量词
    ['拍摄天数', '1天（拍摄周期 1 DAY）', 1, '1 DAY 里的数字不许冒充天数'],
    ['拍摄天数', '全天（10小时）', null, '10 小时不许冒充 10 天'],
    ['拍摄天数', '3天', 3],
    ['交付周期', '30个工作日', 30, '「个」后面是工作日，仍然认得'],
    ['交付周期', '约1.5个月', null, '「个月」不是量词'],
    ['交付周期', '7天出片', 7],
    ['桌数', '20桌', 20],
    ['餐标（每桌）', '3888元/桌', 3888, '数字和量词之间夹了 元/'],
    ['服装套数', '新娘2套+新郎2套（共4套）', 4, '「共」标的才是一共几套'],
    ['服装套数', '共4套（新娘2套+新郎2套）', 4],
    ['服装套数', '男女各5套（共10套），全场任选', 10],
    ['服装套数', '服装造型3套（全场任选）；另写明「新娘各3套」', 3, '命中值一样就用它'],
    ['服装套数', '新娘3套+新郎3套', 6, '两个量词相加；以前读成 3，那是半个人的量'],
    // 人均口径：和「共几套」不是一个单位，比大小就是错的（数据里同一个商家两种写法都有过）
    ['服装套数', '每人3+1套（含一套登记照）', null, '人均 4 套 ≠ 共 4 套，真的是一共 8 套'],
    ['服装套数', '每人4+1套（含登记照1套）', null],
    ['服装套数', '男女各4套服装、4个造型', null],
    ['服装套数', '男女各5套，共10套', 10, '写了「共」就以「共」为准'],
    // 「N服N造」本来就是总数写法，把人均那几家的真实值救回来
    ['服装套数', '10服10造（男女各5套，含结婚证件照一套）', 10],
    ['服装套数', '妆造8服+8造（未拆新郎/新娘）', 8],
    ['服装套数', '服装造型3套（全场任选）；另写明「新娘各3套」', 3,
      '「各」在第一个数**之后**，那是复述不是人均，不能弃权'],
    ['服装套数', '新娘2套+新郎2套', 4, '两个量词相加，和「共4套」是同一件事'],
    ['服装套数', '两份材料冲突：海报「10服10造」vs 长图「整体造型8套」', null, '冲突的格子作废'],
    // 加法写法：A 张 + 加送 B 张。服务器上那份 20 家对比页里真有「32+5张」。
    ['精修张数', '32+5张', 37, '32 张 + 加送 5 张 = 37'],
    ['精修张数', '41+5张', 46],
    ['精修张数', '40+5张', 45, '只取到 5 的话，45 张的那家会被标成「精修最少」'],
    ['精修张数', '55张', 55, '没有加号时不受影响'],
    ['精修张数', '180+张', 180, '这里的 + 是「以上」不是加法，后面没有第二个数'],
    ['底片', '200+20张', null, '表头没点量词时不猜加法，宁可弃权（180+张 仍认得）'],
    // 表头没点量词
    ['底片', '全程拍摄创作180+张保底，底片全送', 180, '「180+张」里的 + 要容错，否则整列失效'],
    ['底片', '底片全送，保底拍摄200张以上（多拍多送）', 200],
    ['底片', '保底拍摄底片100张；但注意事项写明「本套餐底片不赠送」——两者矛盾，待确认', null,
      '自相矛盾的话不能拿来比大小'],
    ['底片', '未知（图内未提内景/外景）', null],
    ['报价', '8万', 80000],
    ['报价', '8,999元', 8999],
    ['报价', '1万2', null, '口语简写，不猜'],
    ['报价', '2999（含税）', null],
    ['报价', '3288元，2套服装', null, '两种量纲混在一格'],
    ['低消', '低消3万，含10桌', null, '否则会把 10 桌当成低消'],
    ['机位数量', '双机位（含1个主机位+1个游机位）', null, '复合描述，否则双机位变成单机位'],
    ['机位数量', '2', 2],
    ['数量', 12, 12],
    ['数量', '共12件', 12],
    ['服务费比例', '10%', 10],
    ['精修张数', '精修35张（另送5张）', null],
    // 这些列有数字，但第一层就不让它们参与。第二层自己也得挡住。
    ['备注', '含精修35张', null],
    ['版本', '6', null],
    ['需确认项数', '12', null],
    ['是否含跟妆', '含（价值800元）', null],
    ['底片', undefined, null, '缺列不能抛'],
  ];
  const bad = cases.filter(([h, v, want]) => comparableNumber(v, h) !== want);
  ok(`真实语料取值 ${cases.length} 条全部符合预期`, bad.length === 0,
    bad.map(([h, v, want]) => `${h}「${v}」→ ${comparableNumber(v, h)}（期望 ${want}）`).join('；'));

  // 整表：谁该上色
  const e1 = computeEmphasis([
    ['商家', '报价', '底片'], ['A家', 2999, 200], ['B家', 3288, 180], ['C家', 9280, 180],
  ]);
  ok('3 家：最低价标 best、最高价标 worst', e1[1][1] === 'best' && e1[3][1] === 'worst', JSON.stringify(e1));
  ok('3 家：最多的标 best、最少的标 worst（两家并列最少都标）',
    e1[1][2] === 'best' && e1[2][2] === 'worst' && e1[3][2] === 'worst');
  ok('第 0 列永不参与（真实数据里有带数字的商家名）', e1.every((r) => r[0] === null));

  const e2 = computeEmphasis([['商家', '报价'], ['A家', 2999], ['B家', 3288]]);
  ok('2 家：只标 best，绝不出现 worst', e2[1][1] === 'best' && !e2.flat().includes('worst'), JSON.stringify(e2));

  const e3 = computeEmphasis([['商家', '报价'], ['A家', 2999], ['B家', '未知']]);
  ok('只剩一个已知值 → 不比（一个值没有「最」）', e3.flat().every((v) => v === null));

  const e4 = computeEmphasis([['商家', '报价'], ['A家', 100], ['B家', 100], ['C家', 100]]);
  ok('全都一样 → 不比（没有信息）', e4.flat().every((v) => v === null));

  // 「合计」行必须排除，否则它在数量列永远最多、在价格列永远最贵。
  // 注意这里要有 3 家：排除合计后只剩 2 家的话，按规则本来就只标绿。
  const e5 = computeEmphasis([
    ['商家', '报价'], ['A家', 2999], ['B家', 3288], ['C家', 5000], ['合计', 11287],
  ]);
  ok('「合计」行不参与（否则它永远是「最贵」）',
    e5[4].every((v) => v === null) && e5[1][1] === 'best' && e5[3][1] === 'worst', JSON.stringify(e5));

  const e6 = computeEmphasis([['商家', '报价'], ['A家', 2999]]);
  ok('只有表头 + 一行时不抛异常', e6.length === 2 && e6.flat().every((v) => v === null));

  // 「40+5张」是 45 张。要是只抠到 5，这张表会把 45 张的那家标成「精修最少」——
  // 标错比不标危害大得多，所以这条盯的是取值而不是排版。
  const e7 = computeEmphasis([
    ['商家', '精修张数'], ['A家', '40+5张'], ['B家', '42张'], ['C家', '30张'],
  ]);
  ok('加法写法不被读成加数（45 张那家是最多，不是最少）',
    e7[1][1] === 'best' && e7[3][1] === 'worst', JSON.stringify(e7));
}

// ── 5. 写入防线 ────────────────────────────────────────────────────
section('写入防线（PreToolUse hook）');
{
  const ws = paths.workspace;
  const guard = (tool, file) => writeGuard({ tool_name: tool, cwd: ws, tool_input: { file_path: file } });
  const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

  ok('允许在 workspace 内新建文件',
    !denied(await guard('Write', path.join(ws, 'data', '婚纱照', '全新商家.md'))));

  const existing = path.join(ws, 'data', '婚纱照', '__guard_probe__.md');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '---\n商家: 探针\n---\n');
  const r = await guard('Write', existing);
  ok('拦截对已存在数据文件的整体 Write（防静默丢内容）', denied(r), JSON.stringify(r));
  ok('拦截理由说清了该怎么办', /Edit/.test(r?.hookSpecificOutput?.permissionDecisionReason || ''));
  ok('但允许 Edit 同一文件', !denied(await guard('Edit', existing)));
  fs.rmSync(existing, { force: true });

  ok('拦截写 workspace 之外', denied(await guard('Write', '/tmp/evil.md')));
  ok('拦截写 .claude/（防止自我提权改配置）', denied(await guard('Write', path.join(ws, '.claude', 'settings.json'))));
  ok('拦截写 spec/', denied(await guard('Edit', path.join(ws, '..', 'spec', 'AGENT_SPEC.md'))));
}

// ── 6. 队列：去重 / 超时 / 对账 ────────────────────────────────────
section('队列');
{
  fs.rmSync(paths.journal, { force: true });

  const seen = [];
  const q = new JobQueue({
    runner: async (job, { signal }) => {
      if (job.hang) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        });
      }
      seen.push(job.eventId);
    },
    onOrphan: async (job) => seen.push(`orphan:${job.eventId}`),
  });

  await q.reconcile();
  q.enqueue({ eventId: 'e1', chatId: 'c1', text: 'a' });
  q.enqueue({ eventId: 'e2', chatId: 'c1', text: 'b' });
  ok('入队后可立即查重（事件回调里就靠这个）', q.hasSeen('e1') && q.hasSeen('e2'));
  ok('未入队的不算重复', !q.hasSeen('e999'));

  await new Promise((r) => setTimeout(r, 300));
  ok('串行执行完毕', seen.join(',') === 'e1,e2', seen.join(','));
  ok('完成后仍然记得（去重记录要活过重推窗口）', q.hasSeen('e1'));

  // 超时：把墙钟限时调小，验证会中断并推进队列
  const orig = config.run.jobTimeoutMs;
  config.run.jobTimeoutMs = 300;
  const before = seen.length;
  q.enqueue({ eventId: 'e3', chatId: 'c1', text: 'hang', hang: true });
  await new Promise((r) => setTimeout(r, 900));
  const journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
  const e3 = journal.find((j) => j.eventId === 'e3');
  ok('超时任务被中断（不会永久堵死队列）', e3?.status === 'cancelled', JSON.stringify(e3?.status));
  ok('超时后队列继续工作', (() => { q.enqueue({ eventId: 'e4', chatId: 'c1', text: 'after' }); return true; })());
  await new Promise((r) => setTimeout(r, 300));
  ok('后续任务正常执行', seen.includes('e4'), seen.join(','));
  config.run.jobTimeoutMs = orig;

  // 对账：模拟上次崩溃留下的 running 任务
  const j = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
  j.push({ eventId: 'e300', chatId: 'c1', cardId: 'om_x', status: 'running', createdAt: Date.now(), updatedAt: Date.now() });
  fs.writeFileSync(paths.journal, JSON.stringify(j));
  const seen2 = [];
  const q2 = new JobQueue({ runner: async () => {}, onOrphan: async (job) => seen2.push(job.eventId) });
  await q2.reconcile();
  ok('启动对账发现并报告了孤儿任务', seen2.includes('e300'), seen2.join(','));
}

// ── 6b. 连发图片合并 ──────────────────────────────────────────────
// 一次转发 6 张图在飞书里是 6 条独立消息。不合并就是 6 次完整 Agent 回合，
// 实测花掉 $1.76 且轮次逐条递增（后一条要读前一条刚写的文件）。
section('同批合并');
{
  const orig = config.run.coalesceMs;
  config.run.coalesceMs = 400;            // 自检里不用真等 8 秒

  const got = [];
  const q3 = new JobQueue({ runner: async (job) => got.push(job), onOrphan: async () => {} });
  await q3.reconcile();

  for (let i = 0; i < 6; i += 1) {
    q3.enqueue({
      eventId: `img${i}`, chatId: 'c9', messageId: `om_${i}`, kind: 'agent', text: '',
      images: [{ messageId: `om_${i}`, fileKey: `k${i}` }], coalesce: true,
    });
  }
  q3.enqueue({ eventId: 'cap', chatId: 'c9', messageId: 'om_cap', kind: 'agent', text: '这是薇拉的', images: [] });

  ok('6 张图 + 1 句配文只开一个 job', q3.depth === 1, `depth=${q3.depth}`);
  ok('被吸收的消息仍算「已见过」（飞书重推不会重跑）', q3.hasSeen('img5') && q3.hasSeen('cap'));

  await new Promise((r) => setTimeout(r, 700));
  ok('合并后只跑了一次', got.length === 1, `跑了 ${got.length} 次`);
  ok('6 张图在同一个 job 里', got[0]?.images.length === 6, `images=${got[0]?.images?.length}`);
  ok('每张图各自带 messageId（否则取图会串到别的消息上）',
    new Set(got[0]?.images.map((i) => i.messageId)).size === 6);
  ok('配文并进来了', /这是薇拉的/.test(got[0]?.text || ''), got[0]?.text);

  // 命令不能被吸进图片任务里，否则 /stop 会被推迟甚至吞掉
  const q4 = new JobQueue({ runner: async () => {}, onOrphan: async () => {} });
  q4.enqueue({
    eventId: 'i1', chatId: 'c8', kind: 'agent', text: '',
    images: [{ messageId: 'm', fileKey: 'k' }], coalesce: true,
  });
  q4.enqueue({ eventId: 'cmd', chatId: 'c8', kind: 'command', text: '', commandReply: '已停止' });
  ok('/stop 之类不会被并进图片任务', q4.depth === 2, `depth=${q4.depth}`);
  await new Promise((r) => setTimeout(r, 700));

  config.run.coalesceMs = orig;
}

// ── 7. MCP 工具契约 ────────────────────────────────────────────────
section('MCP 渲染工具');
{
  const server = createRenderServer({ onArtifact: () => {} });
  ok('MCP 服务器实例可创建', Boolean(server?.instance));

  const captured = [];
  const tool = renderToolDefinition({ onArtifact: (a) => captured.push(...a) });
  ok('工具名符合 permittedTools 里列的白名单', tool.name === 'render_output');

  const res = await tool.handler({
    title: '自检-工具契约',
    category: '婚纱照',
    rows: [
      ['商家', '报价', '备注'],
      ['A家', 8999, null],          // null 应被规范成「未知」而不是留空
      ['B家', '未知', '含跟妆'],
    ],
  });
  ok('handler 返回 MCP 契约要求的 content 数组', Array.isArray(res?.content) && res.content[0]?.type === 'text');
  ok('两种产物都被生成并记录', captured.length === 2 && captured.some((c) => c.kind === 'xlsx') && captured.some((c) => c.kind === 'web'),
    JSON.stringify(captured.map((c) => c.kind)));
  ok('null 单元格被写成「未知」', /已生成/.test(res.content[0].text));

  const xlsxArt = captured.find((c) => c.kind === 'xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxArt.file);
  const ws = wb.worksheets[0];
  ok('xlsx 里 null 确实变成了「未知」', ws.getCell('C2').value === '未知', String(ws.getCell('C2').value));
  ok('表头被冻结', ws.views?.[0]?.state === 'frozen');

  const webArt = captured.find((c) => c.kind === 'web');
  ok('网页含表格内容', fs.readFileSync(webArt.file, 'utf8').includes('B家'));

  for (const c of captured) fs.rmSync(c.file, { force: true });
}

// ── 汇总 ───────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`品类目录：${CATEGORIES.join(' / ')}`);
process.exit(fail ? 1 : 0);
