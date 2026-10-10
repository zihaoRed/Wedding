import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { writeZip } from './zip.mjs';

/**
 * 「把服务器上的数据弄回本地」这件事的服务器侧。
 *
 * 有两条路，共用同一份内容清单（下面的 EXPORT_ITEMS）：
 *   · 下载 —— 打成一个 zip 传到飞书，人在外面用手机也能拿
 *   · 同步 —— Mac 上的 watcher 发现请求后自己拉（见 scripts/watch.mjs）
 * 清单只有这一处定义，scripts/pull.mjs 也 import 它。两个地方各写一份的话，
 * 迟早会分叉，而分叉的表现是「下载的和同步的内容不一样」——很难发现。
 *
 * ⚠️ 这个模块**刻意不 import 任何飞书 SDK**。scripts/pull.mjs 也要用它，
 *    不该因为拉个数据就把整个 Lark SDK 拖进来。
 */

// 拉什么。三者合起来才是「内容」：结构化数据、对比页、以及出问题时排查要用的状态。
// 代码不在里面 —— 代码以本地 git 仓库为准。
export const EXPORT_ITEMS = ['workspace', 'web', 'state'];

// 不拉什么：
//   bot.lock  运行时的锁，拉回去会造成「本地好像也有个实例在跑」的错觉
//   pending   未归属附件的临时挂起，只对运行中的那个进程有意义
//   export    就是导出包本身，拉它等于自己套自己
export const EXPORT_EXCLUDES = ['state/bot.lock', 'state/pending', 'state/export'];

// 归档体积上限。这台机器只有 1.6G 内存、systemd 里限了 1G，而打 zip 要把
// 全部内容读进内存。raw/ 会随截图累积，所以必须有个闸门 —— 宁可明确报错，
// 也不要 OOM 被内核干掉（那时倒下的可能不止机器人）。
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

const exportDir = () => path.join(paths.state, 'export');
// 握手用的三个文件。**相对仓库根**的路径，只有这一处定义 ——
// 机器人直接在本地读写它们，Mac 上的 watcher 则通过 ssh 操作远端同名文件。
// 两边各写一份文件名的话，改名字时会只改一边，而症状是「按钮点了没反应」，
// 排查起来要绕过一整条 ssh + 轮询链路才知道是路径对不上。
export const STATE_FILES = {
  request: 'state/export-request.json',   // 机器人写：盖戳
  result: 'state/export-result.json',     // Mac 写：回执
  alive: 'state/mac-alive',               // Mac 写：报活（mtime 即最后在线时间）
};

const requestFile = () => path.join(paths.root, STATE_FILES.request);
const resultFile = () => path.join(paths.root, STATE_FILES.result);
const aliveFile = () => path.join(paths.root, STATE_FILES.alive);

// ── 遍历 ────────────────────────────────────────────────────────────

const isExcluded = (rel) => EXPORT_EXCLUDES.some((e) => rel === e || rel.startsWith(`${e}/`));

/**
 * 列出要导出的文件。
 * @returns {{name: string, abs: string, size: number, mtime: Date}[]}
 *          name 是相对仓库根的路径，正斜杠分隔
 */
export function collectFiles(root = paths.root, items = EXPORT_ITEMS) {
  const out = [];

  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isExcluded(childRel)) continue;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        // .DS_Store 之类是 macOS 的噪音，拉过去只会让目录看着乱
        if (e.name === '.DS_Store' || e.name.startsWith('._')) continue;
        try {
          const st = fs.statSync(childAbs);
          out.push({ name: childRel, abs: childAbs, size: st.size, mtime: st.mtime });
        } catch { /* 遍历途中文件消失，跳过 */ }
      }
    }
  };

  for (const item of items) {
    const abs = path.join(root, item);
    if (fs.existsSync(abs)) walk(abs, item);
  }
  return out;
}

/** 把文件清单归纳成给人看的数字。 */
export function describe(files) {
  const under = (p) => files.filter((f) => f.name.startsWith(`${p}/`));
  const countExt = (list, ext) => list.filter((f) => f.name.toLowerCase().endsWith(ext)).length;

  const data = under('workspace/data');
  const raw = [...under('workspace/raw'), ...under('workspace/inbox')];
  const output = under('workspace/output');
  const web = under('web');

  return {
    vendors: countExt(data, '.md'),
    images: raw.length,
    tables: countExt(output, '.xlsx'),
    pages: countExt(web, '.html'),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
}

export function formatSummary(d) {
  const mb = d.bytes < 1024 * 1024
    ? `${(d.bytes / 1024).toFixed(0)} KB`
    : `${(d.bytes / 1024 / 1024).toFixed(1)} MB`;
  const parts = [];
  if (d.vendors) parts.push(`${d.vendors} 家`);
  if (d.images) parts.push(`${d.images} 张图`);
  if (d.tables) parts.push(`${d.tables} 张表`);
  if (d.pages) parts.push(`${d.pages} 个页面`);
  return `${parts.join(' · ')}｜${mb}`;
}

// ── 打包 ────────────────────────────────────────────────────────────

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 只留最新的 n 个导出包，其余删掉。返回删了几个。 */
function pruneExports(keep) {
  const dir = exportDir();
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.zip')); } catch { return 0; }
  names.sort();                       // 文件名带时间戳，字典序就是时间序
  let removed = 0;
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.unlinkSync(path.join(dir, n)); removed += 1; } catch { /* 尽力而为 */ }
  }
  return removed;
}

/**
 * 打包成 zip。每次调用都会产出新文件（数据在变，缓存一个旧的没意义）。
 * @returns {{file: string, entries: number, bytes: number, summary: object}}
 */
export function buildExportZip() {
  const files = collectFiles();
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `要打包的内容有 ${(total / 1024 / 1024).toFixed(0)} MB，超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB 上限。` +
      `主要是 raw/ 里的截图，可以先清理早期的日期目录。`,
    );
  }

  const entries = files.map((f) => ({
    name: f.name,
    data: fs.readFileSync(f.abs),
    mtime: f.mtime,
  }));

  const out = path.join(exportDir(), `wedding-data-${stamp()}.zip`);
  const r = writeZip(out, entries);
  pruneExports(config.export.keep);

  return { file: out, entries: r.entries, bytes: r.bytes, summary: describe(files) };
}

/** 最近一次打包产出的文件（可能已经被清掉了）。 */
export function latestExport() {
  try {
    const names = fs.readdirSync(exportDir()).filter((n) => n.endsWith('.zip')).sort();
    const last = names[names.length - 1];
    return last ? path.join(exportDir(), last) : null;
  } catch { return null; }
}

// ── 「同步到 Mac」的握手 ────────────────────────────────────────────
// 按钮点下去只能落到服务器上。要把这个意图传达到 Mac，只能靠 Mac 自己来问
// （它没有公网 IP，外网连不进去）。所以这里放一个 seq，Mac 轮询它。
//
// 两个文件，**各写各的**：
//   export-request.json  机器人写（它盖戳：seq 递增）
//   export-result.json   Mac 写（它回执：我处理到第几号了）
//
// 刻意不让 Mac 回写 request 文件的 status，虽然那样看着更直观。原因是两边
// 会同时写同一个文件：机器人刚盖了新戳(seq 5)，Mac 恰好把「seq 3 已完成」
// 写回去，新请求就被静默吞掉了 —— 表现是「点了按钮没反应」，而且极难复现。
// 分成两个文件之后，「有没有待处理的请求」变成推导出来的：request.seq > result.seq。

/** 卡片上愿意显示「正在等 Mac」的窗口。超了就不再那么说，免得挂着骗人。 */
export const PENDING_UI_MS = 2 * 60_000;

/** watcher 还认领多老的请求。Mac 睡一觉醒来之后仍然该把这事办完。 */
export const PENDING_ACT_MS = 24 * 3600_000;

export const readRequest = () => readJson(requestFile(), null);
export const readResult = () => readJson(resultFile(), null);

/** 盖一个新戳。seq 单调递增，Mac 靠它判断「这是个新请求」。 */
export function bumpRequest(byUserId) {
  const prev = readRequest();
  const seq = (prev?.seq ?? 0) + 1;
  writeJsonAtomic(requestFile(), { seq, at: Date.now(), by: byUserId || null });
  return seq;
}

/**
 * 有没有还没被 Mac 认领的请求。
 * @param {number} maxAgeMs 超过这么久的请求就不算了
 * @returns {object|null} 待处理的请求
 */
export function pendingRequest(maxAgeMs) {
  const req = readRequest();
  if (!req?.seq) return null;
  if ((readResult()?.seq ?? 0) >= req.seq) return null;      // 已经被处理过了
  if (Date.now() - (req.at ?? 0) > maxAgeMs) return null;    // 太老，不再算数
  return req;
}

/** 给卡片用：现在是不是「刚点过、正在等 Mac」。 */
export const requestInFlight = () => pendingRequest(PENDING_UI_MS);

// ── 「Mac 在不在线」─────────────────────────────────────────────────
// Mac 每次轮询都会 touch 一下 alive 文件，所以它的 mtime 就是最后报活时间。

export function macAliveAge() {
  try { return Date.now() - fs.statSync(aliveFile()).mtimeMs; } catch { return Infinity; }
}

export const macOnline = () => macAliveAge() < config.export.macAliveMs;

/** 「12 秒前」「3 分钟前」这种人话。 */
export function humanAge(ms) {
  if (!Number.isFinite(ms)) return '从未';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
