import fs from 'node:fs';
import path from 'node:path';

// config.mjs 只依赖 node 内置模块，不反向依赖这里，所以没有循环。
import { paths } from './config.mjs';

export function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

/** 写临时文件再 rename —— 崩在写一半也不会留下损坏的 JSON。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ── 日志：飞书的 /日志 命令要读它 ────────────────────────────────────
//
// 两条腿，各管一件事：
//
// 1. 内存缓冲（全部级别）—— 回答「机器人刚才在干嘛」。不落盘，因为 info
//    太吵，落盘会涨得没边。
// 2. state/errors.log（只有 warn/error）—— 回答「出过什么错」。**必须落盘**：
//    内存缓冲重启就没了，而崩溃重启恰恰是最需要看日志的时候 —— systemd
//    会把它拉起来，你只看到自己那条消息没回，别的什么都看不到。
//    warn/error 很稀疏，文件长不大，超了就把前半段丢掉。

const BUFFER_MAX = 400;
const buffer = [];

const ERRLOG_MAX_BYTES = 64 * 1024;
const errLogPath = () => path.join(paths.state, 'errors.log');

/** 拼成一行给人看的文本。对象要能显示，Error 要取 message 而不是 {} */
function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function appendErrorLog(line) {
  try {
    fs.mkdirSync(paths.state, { recursive: true });
    fs.appendFileSync(errLogPath(), `${line}\n`);

    // 超了就留最后 200 行。不做按日轮转 —— 那会多出几个文件，
    // 而这里要的只是「最近出过什么错」，翻旧账不是它的活。
    if (fs.statSync(errLogPath()).size > ERRLOG_MAX_BYTES) {
      const keep = fs.readFileSync(errLogPath(), 'utf8').split('\n').filter(Boolean).slice(-200);
      fs.writeFileSync(errLogPath(), `${keep.join('\n')}\n`);
    }
  } catch { /* 日志写不进去不该把机器人带崩 */ }
}

const emit = (level, args) => {
  // 控制台照旧分开传参，这样对象/SDK 的多行输出还能正常展开
  console[level](`${ts()} [${level.toUpperCase()}]`, ...args);

  const line = `${ts()} [${level.toUpperCase()}] ${args.map(fmt).join(' ')}`;
  buffer.push(line);
  if (buffer.length > BUFFER_MAX) buffer.shift();

  if (level !== 'log') appendErrorLog(line);
};

export const logger = {
  info: (...a) => emit('log', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/** 内存里最近几行（所有级别）。给 /日志 用。 */
export function recentLines(limit = 10) {
  return buffer.slice(-limit);
}

/** 落盘的 warn/error，跨重启保留。给 /日志 用。 */
export function recentErrors(limit = 10) {
  try {
    return fs.readFileSync(errLogPath(), 'utf8').split('\n').filter(Boolean).slice(-limit);
  } catch { return []; }
}

export const logBuffered = () => buffer.length;

/**
 * 单实例锁。部署期双进程会导致两个 WSClient 同时存在，而飞书的集群投递会把
 * 不同事件发给不同进程（不广播），于是两处并发写同一份 Markdown。必须拦住。
 */
/**
 * @param {string} lockFile
 * @param {string} [what] 报错里怎么称呼这个进程。bot 和 watcher 共用这个函数，
 *   而「已经有一个 bot 进程在跑」对 watcher 来说是误导 —— 装上开机自启之后，
 *   手动跑 npm run watch 撞锁是**最常见**的报错，得让它说人话。
 */
export function acquireLock(lockFile, what = 'bot') {
  const stale = () => {
    const prev = readJson(lockFile, null);
    if (!prev?.pid) return true;
    try { process.kill(prev.pid, 0); return false; } catch { return true; }
  };

  if (fs.existsSync(lockFile) && !stale()) {
    const prev = readJson(lockFile, {});
    console.error(`[lock] 已经有一个 ${what} 进程在跑（pid ${prev.pid}）。` +
      `如果确认它已死，删除 ${lockFile} 后重试。`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));

  const release = () => {
    try {
      if (readJson(lockFile, {})?.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* 退出路径上尽力而为 */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
  return release;
}

/**
 * 心跳只是给外部 cron 看的监控辅助。写不出去（路径配错、磁盘满、权限不足）
 * 绝不能把机器人整个带崩——那会变成「监控把被监控的东西搞死了」。
 * 所以这里吞掉异常，只留一条 warn。
 */
export function touchHeartbeat(heartbeatFile) {
  try {
    fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
    fs.writeFileSync(heartbeatFile, new Date().toISOString());
  } catch (err) {
    logger.warn(`[store] 心跳写入失败（不影响运行）：${heartbeatFile} — ${err.message}`);
  }
}
