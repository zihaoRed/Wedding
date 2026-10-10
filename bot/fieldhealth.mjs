/**
 * 字段体检：这张对比表该长哪几列。
 *
 * 回答两件事，判据完全不同 —— 分开写是因为它们会互相带偏：
 *   一、哪一列该退出表 —— 有值的行数不足三分之一（20 行里 6 行以下）
 *   二、正文里还有哪些反复出现、却还没有字段的属性 —— 只当候选报出去，不自己改表
 *
 * 单独一个文件的理由和 emphasis.mjs 一样：以后要调的是**这里的词表和阈值**，
 * tools.mjs 那边只管接线。
 *
 * ── 贯穿全文的一条：提到了几家 ≠ 有几家给了值 ────────────────────────
 *
 * 实测（20 份真实婚纱照数据）：「门票」在 14 份文件的正文里出现过，但真给了值的
 * 只有 4 家，另外 10 家是「额外费用: 未知（图内未提门票/交通/餐食）」这类
 * **空白记录**。按「提到」开列，就会做出一个 10/20 是「未知」的新列 ——
 * 而那恰好是用户抱怨「表格没有重点」的成因。所以每次提及都先判是「给了值」
 * 还是「只记空白」，每条属性分开计数，一律按「有值家数」说话。
 *
 * ── 一条刻意的不复用 ──────────────────────────────────────────────
 *
 * 这里的 hasValue 和 emphasis.mjs 的 ABSTAIN_VALUE **判断相反，不能合并**：
 * 「底片不赠送」对配色是「不能拿来比大小」（弃权），对覆盖率却是一个**真值**
 * （这家明确说了不给）。混用会同时错两次 —— 所以宁可留两份词表，并用测试钉住。
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 判据：这一格算不算「有值」 ──────────────────────────────────────

/** 出现这些 = 这一句没说事：未知、待定，或记的是「图上没写」。 */
const NO_INFO = '未知|待确认|需确认|待定|未写|未提|未明确|未列|不明|不详|无佐证|面议';
const NO_INFO_RE = new RegExp(NO_INFO);

/** 分句。逗号**不切**（原因见下），其余句读都切。 */
const splitClauses = (text) => String(text ?? '').split(/[\n。；;！!？?]+/);

/**
 * 这一格算不算「有值」。
 *
 * **按句子判，不按整格判** —— 实测这一步差出 8 家：`拍摄场景` 里大量是
 * `内景+外景（图内只列热门风格推荐：…）` 这种写法，前半句给了值、括号里说明
 * 「图上没列具体景点」。整格判会把它们全算成空，得出 3/20 的结论，
 * 于是这一列被当成空列踢掉 —— 而它其实 11/20 都有内容。用户看得见的内容，
 * 体检就不该报成没有。
 *
 * 逗号**不切**是因为 `未知（图内未提门票、交通、餐食）` 必须留在一句里，
 * 否则「门票」会和那个「未知」分开，被判成有值 —— 那是本模块最怕的一类错。
 *
 * @param {unknown} v 一格的原始值
 * @returns {boolean} 有没有信息
 */
export function hasValue(v) {
  const s = String(v ?? '').trim();
  if (s === '') return false;
  return splitClauses(s).some((c) => c.trim() && !NO_INFO_RE.test(c));
}

/**
 * 一句里出现这些，就算「没给值」：除了 NO_INFO 那批，还要加上疑问句的骨架。
 * `需确认` 栏里列的全是问题（「加片单价（超出 40 张后每张多少钱）」），
 * 它们问的正是商家没说的事 —— 算成有值会把所有填充率整体抬高。
 */
const NO_VALUE_CLAUSE = new RegExp(`${NO_INFO}|是否|多少钱|几本|几张|几套|几个|几份|几次|如何|哪种|哪家|需商家|待商家`);

// ── 读语料 ──────────────────────────────────────────────────────────

/**
 * 最小的 frontmatter 解析。全仓没有 YAML 解析器（store.mjs 只管 JSON，
 * package.json 里也没有依赖），而数据文件只用到三种形状：
 *
 *   键: 值                    报价: 8999
 *   键: [a, b]                别名: [20岁婚纱摄影, 20岁]
 *   键: [a,\n  b,\n  c]       需确认 —— 真实文件里这栏有 15 项、跨好几行
 *
 * 所以不引依赖，手写这十几行就够。看不懂的行**保留原文**而不是丢弃：
 * 体检报错可以，把人家的数据读没了不行。
 */
export function parseDoc(raw, name) {
  const text = String(raw ?? '');
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  const fm = end > 0 ? text.slice(3, end) : '';
  const body = end > 0 ? text.slice(end + 4) : text;

  const values = {};
  let key = null;
  for (const line of fm.split('\n')) {
    const m = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1].trim();
      values[key] = m[2].trim();
    } else if (key && line.trim()) {
      values[key] += ` ${line.trim()}`;   // 跨行数组的续行，接着上一把键
    }
  }
  return { name, values, body, raw: text };
}

/**
 * 通用字段不是「对比项」，不参与覆盖率：
 * 前四个是元数据，`需确认` 里装的是问题不是值（它的内容只当空白证据用）。
 */
const META_KEYS = new Set(['id', '商家', '别名', '来源', '版本', '需确认']);

/**
 * 读一个或几个品类下的所有 `.md`。
 *
 * 品类由调用方给（tools.mjs 用 config.mjs 的 CATEGORIES 校验并展开「全部」），
 * 这里不认识品类名，也就不存在两处品类清单打架的问题。
 *
 * @param {string} dataDir workspace/data
 * @param {string[]} categories
 * @returns {Array<{category:string, name:string, values:object, body:string, raw:string}>}
 */
export function readCorpus(dataDir, categories) {
  const docs = [];
  for (const category of categories ?? []) {
    const dir = path.join(dataDir, category);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      docs.push({ category, ...parseDoc(raw, f.replace(/\.md$/, '')) });
    }
  }
  return docs;
}

// ── 一、覆盖率与空列 ────────────────────────────────────────────────

/**
 * 每个字段「有值」的家数，按有值降序。
 * @returns {Array<{key:string, known:number, total:number}>}
 */
export function fieldCoverage(docs) {
  const keys = [...new Set(docs.flatMap((d) => Object.keys(d.values)))]
    .filter((k) => !META_KEYS.has(k));
  return keys
    .map((k) => ({ key: k, known: docs.filter((d) => hasValue(d.values[k])).length, total: docs.length }))
    .sort((a, b) => b.known - a.known);
}

/**
 * 这一列该不该算「空列」：有值不足总量的三分之一。
 *
 * 用比例不用绝对值 —— 三家对比时 2/3 有值的列必须留着，20 行里 2/20 的必须走。
 *
 * @param {number} known 有值的行数
 * @param {number} total 总行数
 */
export function sparseColumn(known, total) {
  return total > 0 && (known === 0 || known * 3 < total);
}

/**
 * 渲染前拿掉「空列」——**有值不足三分之一**的列。
 *
 * 为什么是比例而不是「整列全空」：全空的列真实数据里只剩一列（`尾款节点`），
 * 而用户嫌胖的是另有 5 列 20 行里 18 行都写着「未知」。他嘴里的「空列」就是这个，
 * 判据得跟他的眼睛对齐。
 *
 * 用户拍板的规则是**不进表、但回复里点名** —— 所以这里只负责拿掉并把名单交出去，
 * tools.mjs 会把名单写进工具返回值，spec §8 要求 Agent 在回复里点出来。
 * 丢弃是可复现的；这不是「少显示点」，是把一个原本随机的决定（Agent 上一轮砍了
 * `拍摄场景`、却留着 0/20 的 `有效期`）钉成一条规则。
 *
 * `keep` 是给用户留的门：他说「定金那列我还要」时，Agent 带上来即可豁免。
 * 数据还在文件里，丢掉无损。
 *
 * 返回新数组，且**不动原 rows**：两个格式要渲染同一份数据。
 *
 * @param {Array<Array<string|number|null>>} rows 第一行是表头
 * @param {{keep?: string[]}} [opts] 豁免的列名（表头文字）
 * @returns {{rows: Array, dropped: string[], kept: string[]}} 没有可丢的就原样返回
 */
export function dropEmptyColumns(rows, { keep: exempt = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return { rows, dropped: [], kept: [] };
  const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const body = rows.slice(1);
  const header = rows[0] ?? [];
  const exemptSet = new Set(exempt.map((s) => String(s).trim()));

  const cols = [];
  const dropped = [];
  const kept = [];
  for (let c = 0; c < width; c += 1) {
    const title = String(header[c] ?? `第 ${c + 1} 列`);
    const known = body.filter((r) => hasValue(Array.isArray(r) ? r[c] : undefined)).length;
    // 第 0 列是商家名，永不丢
    if (c === 0 || !sparseColumn(known, body.length)) cols.push(c);
    else if (exemptSet.has(title)) { cols.push(c); kept.push(title); }
    else dropped.push(title);
  }
  // 只剩商家名就不叫表了 —— 宁可原样返回，也别交出一张空表
  if (!dropped.length || cols.length < 2) return { rows, dropped: [], kept: [] };
  return {
    rows: rows.map((r) => cols.map((c) => (Array.isArray(r) ? r[c] ?? null : null))),
    dropped,
    kept,
  };
}

// ── 二、扩充候选 ────────────────────────────────────────────────────
//
// 两份清单都**写在代码里**，可审阅、可测试 —— 不是让模型每次凭空想字段名。
// 我试过无监督那条路：真实语料上 17 个候选里 14 个是垃圾（`vs`、
// `程无任何隐形消`、`拍一套看一套`），因为正文里大量是 Agent 自己写的分析
// 文字和元话语。骨架 + 词表不是「更聪明」，是**更诚实**。

/** 句式骨架：把「赠送X」「X费」「X 是否另计」里的 X 抠出来。 */
const SKELETON = [
  /赠送([^，。；、\n（）()]{2,10})/g,
  /(?:包含|含有|含)([^，。；、\n（）()]{2,10})/g,
  /([^，。；、\n（）()]{2,8})(?:是否另计|另计|另收|另付|自费|另算)/g,
  /([^，。；、\n（）()【】]{2,7})(?:费|金)(?=[，。；、\s）)】]|$)/gm,
  /([^，。；、\n（）()]{2,7})(?:一幅|一组|一件|一套|一本|一个|一张|一辑|一份|一对)/g,
];

/**
 * 小词表：婚庆报价里反复出现、又最容易漏记的属性名词。
 * 骨架抓不到它们（既不跟费用、也不跟量词），但缺口是真的 ——
 * 比如「城市」：婚宴场地有这个字段，婚纱照没有，而 10 家其实都写了。
 */
const NOUNS = [
  '城市', '门店', '地址', '海报', '包邮', '邮寄', '邮费', '登记照', '花絮',
  '原片', 'RAW', '双格式', '网盘', 'U盘', '门票', '交通', '餐食', '接机', '住宿', '车费',
  '免租', '秀禾', '婚纱租赁', '伴手礼', '喜糖', '请柬', '席位卡', '放大', '机位',
];

/**
 * 已经收录的字段（含近义说法）—— 命中的一律不算「新候选」。
 *
 * **故意不锚定两端**：这是最容易出错的一侧。骨架抠出来的是碎词（
 * `含相册`、`相册本定`、`婚礼当天跟妆`），锚定 `^$` 会让它们全部漏过过滤器，
 * 于是体检报告里出现「相册」「底片」这种明明有字段的东西 —— 用户会立刻
 * 认定这工具没在读他的数据。宁可漏报（少提一个真候选），不可误报已收录。
 *
 * `放大`/`桌摆` 归在这是有意的：它们是「相册相框摆台」那一列的内容，
 * 而那一列已被明确判定不可拆（值是「施华洛24*30英寸放大框*1」这种，比的是
 * 尺寸型号不是数量）。`拍摄` 同理 —— 场景、天数都是字段了。
 */
const ALREADY =
  /商家|别名|报价|套餐|底片|精修|服装|拍摄|跟妆|相册|相框|摆台|桌摆|放大|加片|有效期|定金|尾款|额外费用|机位|服务|状态|版本/;

/**
 * 元话语、行业通用话术、营销词：不是「这家和那家不一样」的东西。
 * 里面夹了几个实测抓到的具体噪声（`挂画`/`相架`/`修图`/`选片`/`妆造` 是
 * 婚纱照正文明细里的碎词，`迎宾`/`视频` 分别是 `海报`/`花絮` 的同义说法 ——
 * 留着会让候选栏出现两条说同一件事的行）。
 */
const STOP =
  /不满意|可重拍|独家|影棚|化妆间|包间|联机屏|推销|嫁衣馆|限量|先抢先得|截止|活动|优惠|预约|到店|领取|衬衣|滴滴|接驾|油补|礼物|加油|叠加|大吉|马年|绝版|仅限|本数|页数|材质|口径|文案|图上|图内|未写|未确认|确认|例如|比如|包括|以上|以下|其他|如果|因为|所以|这一|那家|本档|全系列|三档|任选|全场|同一家|隐形消|拍一套|挂画|相架|修图|选片|妆造|迎宾|视频|FREE|来源|对比|建议|预算|方案|整体|部分|方式|时间|当天|额外|相关|说明|备注/;

/**
 * 去噪：去掉数字和 markdown/单位记号，剩下必须是 2~8 个汉字，且没被上面三张表否掉。
 *
 * `碎片` 那一步是实测补的：骨架抠出来的是**半截话**（`一套登记照`、
 * `cm迎宾海报`、`产品全国包邮`、`官宣定制桌摆`），它们和词表里的
 * `登记照`/`海报`/`包邮`…… 是同一个属性，一起报出来会让候选栏看起来像没在读数据。
 * 判据：包含某个词表名词又不是它本身，就当碎片扔掉。
 */
function tidy(s) {
  const w = String(s ?? '').replace(/[\d\s*＊x×+\-—–~、,，。.:：;；()（）【】[\]"'“”|/\\]/g, '').trim();
  if (w.length < 2 || w.length > 8) return '';
  if (ALREADY.test(w) || STOP.test(w)) return '';
  if (NOUNS.some((n) => w !== n && w.includes(n))) return '';
  return w;
}

/** 一段文字里所有候选词：骨架抠出来的 + 词表命中的。**两条路都过同一道过滤**。 */
function discover(text) {
  const out = new Set();
  for (const re of SKELETON) {
    for (const m of text.matchAll(re)) {
      const w = tidy(m[1]);
      if (w) out.add(w);
    }
  }
  for (const n of NOUNS) {
    if (!text.includes(n)) continue;
    const w = tidy(n);
    if (w) out.add(w);
  }
  return out;
}

/**
 * 在语料里找「反复出现、却还没有字段」的属性，每条带**有值份数 / 空白份数**。
 *
 * 值来自 frontmatter（**不含 `需确认`** —— 那一栏列的就是商家没说的事）+ 正文；
 * `需确认` 只作为「空白证据」参与判断。
 *
 * @returns {Array<{w:string, val:number, gap:number, sample:string}>} 按有值家数降序
 */
export function mineAttributes(docs) {
  const acc = new Map();   // 候选词 → { val:Set<文件>, gap:Set<文件>, sample }
  for (const doc of docs) {
    // 需确认 栏本身就是「空白证据」，所以要从取值文本里摘出去
    const valueText = `${Object.entries(doc.values)
      .filter(([k]) => k !== '需确认')
      .map(([, v]) => v)
      .join('\n')}\n${doc.body}`;
    // 计数按「品类/文件名」去重：做全部品类的总表时，两个品类里同名商家不该被算成一家
    const who = `${doc.category ?? ''}/${doc.name}`;
    const valueClauses = splitClauses(valueText);
    const gapText = String(doc.values['需确认'] ?? '');

    for (const w of discover(valueText)) {
      const hit = valueClauses.filter((c) => c.includes(w));
      const valued = hit.find((c) => !NO_VALUE_CLAUSE.test(c));   // 有一处给了值就算有值
      const rec = acc.get(w) ?? { val: new Set(), gap: new Set(), sample: '' };
      if (valued) {
        rec.val.add(who);
        if (!rec.sample) rec.sample = valued.replace(/\s+/g, ' ').trim().slice(0, 40);
      } else if (hit.length || gapText.includes(w)) {
        rec.gap.add(who);
      }
      acc.set(w, rec);
    }
  }
  return [...acc]
    .map(([w, r]) => ({ w, val: r.val.size, gap: r.gap.size, sample: r.sample }))
    .sort((a, b) => b.val - a.val || b.gap - a.gap);
}

// ── 报告 ────────────────────────────────────────────────────────────
//
// 直接进 Agent 的上下文，所以**必须有上限**：只报前几条。
// 报告不是给人看的文档，是给 Agent 的判据。

const CAND_LIMIT = 6;
const GAP_LIMIT = 6;
const MIN_SEEN = 3;        // 至少出现在几家里才值得说（三家以下谈不上「反复出现」）
const MIN_VAL_FOR_CANDIDATE = 2;   // 候选至少要两家人给了值，否则列出来也没法比

const join = (items, sep = ' · ') => items.join(sep);
const hits = (arr) => arr.filter((m) => m.val + m.gap >= MIN_SEEN);
/** ★候选：真有几家给了值，且给值的不少于只记空白的 —— 这才配叫「漏了一个字段」。 */
const candidatesOf = (mined) => hits(mined).filter((m) => m.val >= MIN_VAL_FOR_CANDIDATE && m.val >= m.gap);
/** 空白：只是反复被记成「没人写」。它们属于回复里的一句话，不属于表。 */
const blanksOf = (mined) => hits(mined).filter((m) => m.val < m.gap && m.gap >= MIN_SEEN);

/**
 * 一个品类的体检报告（纯文本）。
 *
 * @param {string} category
 * @param {Array} docs readCorpus 里该品类的那些
 */
function block(category, docs) {
  const total = docs.length;
  const cov = fieldCoverage(docs);
  const sparse = cov.filter((c) => sparseColumn(c.known, c.total));
  const mined = mineAttributes(docs);
  const cands = candidatesOf(mined).slice(0, CAND_LIMIT);
  const blanks = blanksOf(mined).slice(0, GAP_LIMIT);
  const withPending = docs.filter((d) => String(d.values['需确认'] ?? '').trim()).length;

  const lines = [`${category} · ${total} 份`];
  lines.push(`字段填充（有值/总数）：${join(cov.map((c) => `${c.key} ${c.known}/${c.total}`))}`);
  lines.push(sparse.length
    ? `空列（有值不足三分之一）→ 不进表，但回复里点名：${join(sparse.map((c) => `${c.key} ${c.known}/${c.total}`), '、')}`
    : '空列：无（每列都有三分之一以上的家数给了值）');
  lines.push(cands.length
    ? `正文里有值、却还没字段的属性（★候选，只提议别自己加列）：${
      join(cands.map((m) => `★${m.w} ${m.val}家给了值${m.gap ? `/${m.gap}家空白` : ''}${m.sample ? `（例：${m.sample}）` : ''}`), ' · ')}`
    : '扩充候选：无（正文里的属性都已有字段）');
  if (blanks.length) {
    lines.push(`只是反复记成「没人写」的项 → 别开列，回复里带一句：${
      join(blanks.map((m) => `${m.w} ${m.val}家给了值/${m.gap}家空白`), '、')}`);
  }
  if (withPending) {
    lines.push(`（这些空白在各家的 \`需确认\` 栏里有记录，${withPending}/${total} 家填了 —— 回复里点一句即可，不必逐个复述。）`);
  }
  return lines.join('\n');
}

/**
 * @param {Array} docs readCorpus 的结果
 * @param {{categories?: string[]}} [opts] 只在没数据时用来把话说明白
 */
export function buildReport(docs, { categories } = {}) {
  if (!docs.length) {
    const which = categories?.length ? `（${join(categories, '、')}）` : '';
    return `还没有可体检的数据${which} —— 先让用户把商家信息发给你建档，建完再看字段够不够。`;
  }
  const byCat = new Map();
  for (const d of docs) byCat.set(d.category, [...(byCat.get(d.category) ?? []), d]);
  return [...byCat].map(([cat, list]) => block(cat, list)).join('\n\n');
}
