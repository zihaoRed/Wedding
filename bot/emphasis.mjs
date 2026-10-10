/**
 * 对比表格的「重点」判断：每一列里谁最好、谁最差。
 *
 * 单独一个文件的理由：这是整个功能里**唯一**需要长期维护的判断 —— 以后加字段、
 * 调方向，只动这里的词表。render.mjs 那边只管排版。
 *
 * ── 为什么分两层（这是防误标的核心）────────────────────────────────
 *
 *   第一层 betterDirection(表头)     —— 这一列**参不参与**比较
 *   第二层 comparableNumber(值, 表头) —— 这一格**能不能**拿出一个可信的数
 *
 * 分开的意义：`备注`（值是「含精修35张」）、`版本`（值是 6）、`需确认项数`
 * （值是 12）、`是否含跟妆`（值是「含（价值800元）」）这些列里**有数字，但那个
 * 数字没有比较意义**。要是只有第二层，就只能靠「抠不出数」兜底，而这些格子
 * 恰恰抠得出数。是第一层整列拦住它们的。
 *
 * ── 贯穿的原则 ──────────────────────────────────────────────────
 *
 * **标错比不标危害大得多。** 真实报价里全是「全天（10小时）」「约1.5个月」
 * 「新娘2套+新郎2套（共4套）」「双机位（含1个主机位+1个游机位）」这类自由文本，
 * 抠错一个数字就会把最贵的那家标成绿的。取不出可信数字就弃权 —— 与
 * spec 里「不确定写未知，绝不猜测」同一条原则。
 */

// ── 第一层：这一列参不参与 ──────────────────────────────────────────
//
// 词表以 spec/AGENT_SPEC.md §4 的真实字段名为准逐个核对过，不是拍脑袋想的。
// 有一条测试会把 §4 里的字段全过一遍，**以后加字段不改这里，测试会红**。

/** 说不清的列：是/否、日期、枚举、自由文本，以及「费用之外的东西」。 */
const ABSTAIN_HEADER =
  /含|是否|可抵|档期|有效期|尾款|备注|来源|渠道|状态|优先级|分类|名称|套餐名|品牌|场景|相册|摆台|婚房|音响|停车|备桌|厅名|酒店|城市|语言|风格|别名|^id$|^商家$|^版本$|需确认|待确认/;

/** 越少越好。 */
const LOW_DIR = /报价|单价|总价|价|费用|餐标|低消|最低消费|定金|订金|押金|进场费|开瓶费|超时费|异地费|试妆费|加价|周期|比例/;

/** 越多越好。 */
const HIGH_DIR = /底片|张数|套数|数量|桌数|次数|时长|天数/;

/**
 * @returns {'low'|'high'|null} low = 越少越好，high = 越多越好，null = 这一列不参与
 */
export function betterDirection(header) {
  const h = String(header ?? '').trim();
  if (!h) return null;
  if (ABSTAIN_HEADER.test(h)) return null;   // 必须先判：`试妆费可抵` 里含 `试妆费`
  if (LOW_DIR.test(h)) return 'low';
  if (HIGH_DIR.test(h)) return 'high';
  return null;                               // 词表外的列名一律不参与，宁可漏标
}

// ── 第二层：这一格能不能拿出一个可信的数 ─────────────────────────────

/** 认的量词。`人` 故意不在里面：否则「含10人桌，3888元」会抠出 10。 */
const UNITS = ['小时', '分钟', '天', '张', '套', '个', '本', '次', '桌', '件', '款', '组'];

/**
 * `个` 后面跟「月/小时」时不是量词：「约1.5个月」不能被读成 1.5。
 * 前瞻里**不能**写「工作日」——「30个工作日」是交付周期，必须认得。
 */
const unitAlt = (u) => (u === '个' ? '个(?!月|小时)' : u);

const UNIT_IN_HEADER = new RegExp(UNITS.map(unitAlt).join('|'));

const NUM = '\\d[\\d,]*(?:\\.\\d+)?';

/**
 * 数字后面（允许夹 +、货币符号、斜杠）紧跟某个量词。认得「180+张」「3888元/桌」。
 *
 * 那个可选的第二加数是为了 `32+5张` 这种**加法写法**（32 张底片 + 加送 5 张 = 37）。
 * 少于它的话正则只能从「5张」那里起匹配，于是 45 张的那家被读成 5 张、直接标成
 * 「精修最少」—— 真实数据（服务器上那份 20 家对比页）里就有 `32+5张`/`41+5张`，
 * 而 32+5 和 41+5 恰好都低于 55，蒙对了；换成 `40+5张` 对 `42张` 就会标错。
 * 而 `180+张` 的加号是「以上」不是加法，后面没有第二个数，所以仍是 180。
 */
function unitHits(text, unit) {
  const re = new RegExp(
    `(${NUM})\\s*(?:[+＋]\\s*(?:(${NUM})\\s*)?)?(?:元|块钱|块)?\\s*[/／]?\\s*${unitAlt(unit)}`,
    'g',
  );
  const out = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(addend(m));
  return out;
}

/** 「共4套」这种明确的总计，比逐个命中更可信。 */
function totalFor(text, unit) {
  const re = new RegExp(
    `(?:共|合计|总计|一共)\\s*(?:计|为|是|有)?\\s*[+＋]?\\s*(?:元|块钱|块)?\\s*(${NUM})`
    + `\\s*(?:[+＋]\\s*(?:(${NUM})\\s*)?)?(?:元|块钱|块)?\\s*[/／]?\\s*${unitAlt(unit)}`,
  );
  const m = re.exec(text);
  return m ? addend(m) : null;
}

/** 加法写法的两个加数相加；只有一个数时就是它本身。 */
const addend = (m) => toNum(m[1]) + (m[2] ? toNum(m[2]) : 0);

/** 整格就是一个数字（可带千分位、%、万/千、货币符号）。 */
const BARE_RE = new RegExp(`^[¥￥]?\\s*(${NUM})\\s*([万千])?\\s*(?:元|块钱|块|%|％)?$`);

function bareNumber(text) {
  const m = BARE_RE.exec(text);
  if (!m) return null;
  return scale(toNum(m[1]), m[2]);
}

/** 表头里点名的量词。有它就只能拿这个量词的数字，别的单位一律不算数。 */
function headerUnit(head) {
  const m = UNIT_IN_HEADER.exec(head);
  return m ? m[0] : null;
}

/** 表头没点量词时，用这个扫出「所有带量词或带货币的数」。 */
const TOKEN_RE = new RegExp(
  `(${NUM})\\s*[+＋]?\\s*(?:[¥￥]\\s*)?(${UNITS.map(unitAlt).join('|')}|元|块钱|块|万|千|%|％)?`,
  'g',
);

const CUR_KINDS = new Set(['元', '块钱', '块', '万', '千', '￥', '¥']);

/**
 * 表头没点量词时只能靠猜，所以规则更严：一格里有两种量纲、或者数字和量词对不上号，
 * 都弃权。`低消3万，含10桌` 就是靠这条废掉的 —— 否则会把 10 桌当成低消。
 */
function fromAllTokens(text) {
  const toks = [];
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex += 1;   // 空匹配防呆
    const u = m[2];
    toks.push({ n: scale(toNum(m[1]), u), kind: kindOf(u) });
  }
  if (!toks.length) return null;

  const kinds = new Set(toks.map((t) => t.kind));
  if (kinds.size > 1) return null;                      // 两种量纲混在一格
  if (kinds.has('none')) return null;                   // 有量词的数字和光秃秃的数字混着
  if (toks.length > 1 && /含|各|每/.test(text)) return null;   // 复合描述，取哪个都是猜
  return allSame(toks.map((t) => t.n)) ? toks[0].n : null;
}

const kindOf = (u) => {
  if (!u) return 'none';
  if (CUR_KINDS.has(u)) return 'CUR';
  return u === '%' || u === '％' ? 'PCT' : u;
};

/** 值里出现这些词就整格作废：自相矛盾的话不能拿来比大小。 */
const ABSTAIN_VALUE = /未知|待确认|需确认|待定|矛盾|不赠送|不包含|另付|另计|另收|面议/;

/**
 * 取出这一格的可比值。
 *
 * @param {string|number|null|undefined} value
 * @param {string} header 表头，用来说明这一列的量词是什么
 * @returns {number|null}
 */
export function comparableNumber(value, header) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const head = String(header ?? '');
  const text = String(value).trim();
  if (!text) return null;

  // 表头也过一遍弃权词：`价格待确认`「待确认数量」这种列名本身就是不确定的。
  // 正常流程走不到这里（第一层已经整列跳过），留着是为了让这一层**自己也安全**。
  if (ABSTAIN_VALUE.test(text) || ABSTAIN_HEADER.test(head)) return null;
  if (/\d\s*[万千]\s*\d/.test(text)) return null;      // 「1万2」这种口语简写，不猜

  const unit = headerUnit(head);
  if (unit) {
    // 表头写明了量词，就只认这个量词 —— 认不出就弃权，绝不拿别的单位顶替。
    // 否则「全天（10小时）」的 10 会冒充 10 天，把所有人比下去。
    const total = totalFor(text, unit);
    if (total !== null) return total;
    const hits = unitHits(text, unit);
    if (hits.length) return allSame(hits) ? hits[0] : null;
    return bareNumber(text);
  }

  const bare = bareNumber(text);
  return bare !== null ? bare : fromAllTokens(text);
}

const toNum = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const scale = (n, u) => (n === null ? null : u === '万' ? n * 10000 : u === '千' ? n * 1000 : n);
const allSame = (a) => a.every((x) => x === a[0]);

// ── 高亮规则 ────────────────────────────────────────────────────────

/** 「合计」行整行不参与：它会在每个数量列都被标成最多、每个价格列都被标成最贵。 */
const SKIP_ROW = /^\s*(?:合计|总计|小计|总共|共计)/;

/**
 * 用户拍板的：2 家对比时只标绿。
 * 只有 2 家时「最差」就是「唯一另一家」，标红等于每格都有底色，反而把重点淹了。
 */
const MIN_KNOWN_FOR_WORST = 3;

/**
 * 算出每一格该不该上色。返回**与 rows 同下标**的矩阵，
 * 两个渲染器只做查表 —— 这是 xlsx 和手机网页永不打架的保证。
 *
 * @param {Array<Array<string|number|null>>} rows 第一行是表头
 * @returns {Array<Array<'best'|'worst'|null>>}
 */
export function computeEmphasis(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const emph = rows.map(() => new Array(width).fill(null));
  if (rows.length < 2 || width < 2) return emph;

  const header = rows[0] ?? [];
  for (let c = 1; c < width; c += 1) {
    // 第 0 列是商家名（或转置后的字段名），永不参与 —— 真实数据里出现过带数字的商家名
    const dir = betterDirection(header[c]);
    if (!dir) continue;

    const known = [];
    for (let r = 1; r < rows.length; r += 1) {
      if (SKIP_ROW.test(String(rows[r]?.[0] ?? ''))) continue;
      const n = comparableNumber(rows[r]?.[c], header[c]);
      if (n !== null) known.push({ r, n });
    }
    if (known.length < 2) continue;                    // 只有一个值，没有「最」

    const nums = known.map((k) => k.n);
    const best = dir === 'low' ? Math.min(...nums) : Math.max(...nums);
    const worst = dir === 'low' ? Math.max(...nums) : Math.min(...nums);
    if (best === worst) continue;                      // 全都一样，标了等于没标

    for (const k of known) if (k.n === best) emph[k.r][c] = 'best';
    if (known.length >= MIN_KNOWN_FOR_WORST) {
      for (const k of known) if (k.n === worst) emph[k.r][c] = 'worst';
    }
  }
  return emph;
}

// ── 颜色 ────────────────────────────────────────────────────────────
//
// **只此一处。** 原来想的是方向逻辑统一、颜色在 CSS 和 xlsx 的 ARGB 里各写一份 ——
// 那正好是「xlsx 和网页永不打架」这句话最容易被自己违背的地方。

export const EMPH_COLORS = {
  best: { bg: '#e3f5e9', ink: '#0b6b39', darkBg: '#16351f', darkInk: '#84e0a6', bold: true },
  worst: { bg: '#fdeaea', ink: '#a1272c', darkBg: '#3a1d1f', darkInk: '#ffb3ad', bold: false },
};

/** #rrggbb → exceljs 要的 AARRGGBB。 */
export const toArgb = (hex) => `FF${String(hex).replace('#', '').toUpperCase()}`;
