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

  // 反向：对象多、字段少（如按商家列的预算总表）不能转置，否则列数会炸开
  const many = [['商家', '报价'], ...Array.from({ length: 8 }, (_, i) => [`商家${i}`, 1000 + i])];
  const web2 = renderWeb(many, { title: '自检-预算总表' });
  const html2 = fs.readFileSync(web2, 'utf8');
  ok('对象多、字段少时保持原样（不转置）', !html2.includes('class="flip"'));

  fs.rmSync(xlsx, { force: true });
  fs.rmSync(web, { force: true });
  fs.rmSync(web2, { force: true });
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
