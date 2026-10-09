import fs from 'node:fs';
import path from 'node:path';

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
const emit = (level, args) => console[level](`${ts()} [${level.toUpperCase()}]`, ...args);

export const logger = {
  info: (...a) => emit('log', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/**
 * 单实例锁。部署期双进程会导致两个 WSClient 同时存在，而飞书的集群投递会把
 * 不同事件发给不同进程（不广播），于是两处并发写同一份 Markdown。必须拦住。
 */
export function acquireLock(lockFile) {
  const stale = () => {
    const prev = readJson(lockFile, null);
    if (!prev?.pid) return true;
    try { process.kill(prev.pid, 0); return false; } catch { return true; }
  };

  if (fs.existsSync(lockFile) && !stale()) {
    const prev = readJson(lockFile, {});
    console.error(`[lock] 已经有一个 bot 进程在跑（pid ${prev.pid}）。` +
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
