#!/usr/bin/env node
/**
 * 常驻 watcher：在飞书里点一下「同步到 Mac」，本地文件夹就自己更新。
 *
 *   npm run watch            一直跑着（Ctrl-C 退出）
 *   npm run watch -- --once  只轮询一次，该拉就拉，然后退出（用来验证）
 *
 * ── 为什么要有个常驻进程 ────────────────────────────────────────────
 * 飞书上的按钮点击只能落到**服务器**上。你这台 Mac 在家庭/公司网络后面，
 * 没有公网 IP，外网连不进来；而浏览器打开一个网页也写不了你的硬盘。
 * 所以「点一下让本地更新」只能由本地主动去问 —— 就是这个进程在做的事。
 *
 * ── 为什么不存本地状态 ──────────────────────────────────────────────
 * 每次轮询都同时取回 request 和 result 两个文件，靠
 * 「request.seq > result.seq」判断有没有待办。这样重启 watcher 不会重复拉，
 * 也不会漏掉「你按了按钮、但 Mac 当时在睡觉」的那个请求。
 * 存在内存里的话，重启就丢，两种错都会犯。
 *
 * ⚠️ 这台机器**不要把 npm start 也跑起来**。飞书的集群投递不广播，同一条消息
 *    只会发给其中一个长连接，两个进程同时在线会让消息被随机劈成两半。
 *    watcher 不是长连接，跟机器人不冲突，可以同时跑。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { config, paths } from '../bot/config.mjs';
import { STATE_FILES, PENDING_ACT_MS } from '../bot/export.mjs';
import { acquireLock, logger } from '../bot/store.mjs';
import { runPull, q } from './pull.mjs';

const { host, remoteRoot, dir: dest, pollMs } = config.export;

if (!host) {
  console.error(`没有指定服务器地址。

请在 .env 里加一行：
  DEPLOY_HOST=root@<你的服务器IP>`);
  process.exit(1);
}

// 防止不小心开了两个 —— 两个 watcher 会同时拉、同时回执
acquireLock(path.join(paths.state, 'watch.lock'));

const remote = (rel) => `${remoteRoot}/${rel}`;
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

/**
 * 一次轮询：取回 request + result，并 touch 一下报活文件。
 * 三件事挤在一次 ssh 里，是为了省掉两次连接开销（每 15 秒一次）。
 */
function poll() {
  const cmd = [
    `cat ${q(remote(STATE_FILES.request))} 2>/dev/null`,
    `echo '@@@'`,
    `cat ${q(remote(STATE_FILES.result))} 2>/dev/null`,
    `echo '@@@'`,
    // mtime 就是「Mac 最后在线时间」，机器人靠它决定卡片上给不给「同步」按钮
    `touch ${q(remote(STATE_FILES.alive))}`,
  ].join('; ');

  const res = spawnSync('ssh', [...SSH, host, cmd], { encoding: 'utf8' });
  if (res.status !== 0) {
    return { error: (res.stderr || '').trim().split('\n').pop() || `ssh 退出码 ${res.status}` };
  }

  const [reqRaw, resultRaw] = String(res.stdout || '').split('@@@');
  const parse = (s) => { try { return JSON.parse(String(s).trim()); } catch { return null; } };
  return { req: parse(reqRaw), result: parse(resultRaw) };
}

/** 回执写回服务器。机器人卡片靠它显示「上次同步」。 */
function writeResult(payload) {
  const res = spawnSync('ssh', [...SSH, host, `cat > ${q(remote(STATE_FILES.result))}`], {
    input: JSON.stringify(payload, null, 2),
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    logger.warn(`[watch] 回执写回失败（不影响本地文件）：${(res.stderr || '').trim()}`);
  }
}

/** macOS 桌面通知。其他平台就不弹了，终端里已经打了。 */
function notify(title, text) {
  if (process.platform !== 'darwin') return;
  const esc = (s) => JSON.stringify(String(s).replace(/\s+/g, ' '));
  spawnSync('osascript', ['-e', `display notification ${esc(text)} with title ${esc(title)}`]);
}

async function tick() {
  const r = poll();

  if (r.error) {
    logger.warn(`[watch] 连不上服务器：${r.error}`);
    return;
  }

  const doneSeq = Number(r.result?.seq ?? 0);
  const req = r.req;

  if (!req?.seq || req.seq <= doneSeq) return;          // 没有新请求
  if (Date.now() - (req.at ?? 0) > PENDING_ACT_MS) return;  // 太老了，不认

  logger.info(`[watch] 收到同步请求 seq=${req.seq}，开始拉取…`);
  const pull = runPull({ host, dest, remoteRoot, quiet: true });

  const payload = {
    seq: req.seq,
    at: Date.now(),
    ok: pull.ok,
    files: pull.files,
    bytes: pull.bytes,
    // 卡片上要说清楚「这次到底同步了什么」，光有总数看不出来。
    // 后加的字段：机器人那边缺了也能显示，只是少一段括号。
    added: pull.added.length,
    changed: pull.changed.length,
    error: pull.ok ? null : (pull.stderr || `退出码 ${pull.code}`),
  };
  writeResult(payload);

  if (pull.ok) {
    logger.info(`[watch] ✓ 同步完成：${pull.files} 个文件（新增 ${pull.added.length}，更新 ${pull.changed.length}）→ ${dest}`);
    notify('备婚助手', `已同步 ${pull.files} 个文件到 ${path.basename(dest)}`);
  } else {
    logger.error(`[watch] ✗ 同步失败：${payload.error}`);
    notify('备婚助手', '同步失败，看看终端里的日志');
  }
}

// ── 主循环 ──────────────────────────────────────────────────────────
// 用递归 setTimeout 而不是 setInterval：一次拉取可能比轮询间隔还久
// （比如服务器正忙），setInterval 会让它们叠起来同时跑。

const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });

logger.info(`[watch] 盯着 ${host}:${remoteRoot}`);
logger.info(`[watch] 落地到 ${dest}，每 ${Math.round(pollMs / 1000)} 秒问一次。Ctrl-C 退出。`);

(async () => {
  do {
    try {
      await tick();
    } catch (err) {
      // 单次轮询出任何意外都不该把 watcher 带走 —— 它得能一直跑下去
      logger.error('[watch] 轮询异常：', err?.message || err);
    }
    if (once || stopping) break;
    await new Promise((r) => setTimeout(r, pollMs));
  } while (!stopping);

  if (once) logger.info('[watch] --once 模式，退出。');
})();
