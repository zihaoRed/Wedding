import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { config, paths, ensureDirs, validateConfig } from './config.mjs';
import {
  acquireLock, touchHeartbeat, logger, readJson, writeJsonAtomic,
  recentLines, recentErrors, logBuffered,
} from './store.mjs';
import { JobQueue, statusLabel } from './queue.mjs';
import { parseMessage, isAllowed } from './events.mjs';
import { buildCard, sendCard, patchOrResend, sendFile, downloadImage } from './feishu.mjs';
import { ingestImage, pruneRaw } from './media.mjs';
import { runAgent, appendTurn, failureMessage } from './agent.mjs';
import {
  formatSummary, buildExportZip, bumpRequest, requestInFlight, macOnline, readResult,
  macAliveAge, humanAge,
} from './export.mjs';
import { renderExportCard } from './export-card.mjs';

ensureDirs();
validateConfig();
acquireLock(paths.lock);

// ── 回执卡片 ───────────────────────────────────────────────────────

const WORKING = () => buildCard({
  title: '备婚助手',
  markdown: '收到，正在整理…',
  template: 'blue',
});

const replyCard = (text, buttons = [], template = 'blue') =>
  buildCard({ title: '备婚助手', markdown: text, template, buttons });

// ── 未归属附件的短期挂起 ───────────────────────────────────────────
// 「这是哪家的？」→ 用户回答时通常不会再带图。把上一批附件挂起一次，
// 让下一次没有附件的消息也能拿到它们，然后清掉。

const pendingFile = (chatId) => path.join(paths.state, 'pending', `${chatId}.json`);

function setPending(chatId, pathsList) {
  writeJsonAtomic(pendingFile(chatId), { paths: pathsList, at: Date.now() });
}

function takePending(chatId) {
  const p = pendingFile(chatId);
  const saved = readJson(p, null);
  try { fs.unlinkSync(p); } catch { /* 本来就没有 */ }
  if (!saved?.paths?.length) return [];
  if (Date.now() - saved.at > 24 * 3600_000) return [];
  return saved.paths;
}

// ── 命令（不经过 Agent，立刻回）─────────────────────────────────────

/** 进程跑了多久：「3 小时 12 分」。humanAge 说的是「多久以前」，用在这里反着。 */
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return '不到 1 分钟';
}

function handleCommand(cmd, job) {
  switch (cmd) {
    case '/stop': {
      const ok = queue.cancel(job.chatId);
      return ok ? '已请求中断当前任务。' : '当前没有正在处理的任务。';
    }
    // 一个给中文输入法、一个给肌肉记忆，是同一个东西。
    case '/状态':
    case '/status': {
      const running = queue.runningJob;
      const lines = [`服务：已运行 ${fmtUptime(process.uptime())}（pid ${process.pid}）`];
      lines.push(`队列：${queue.depth} 个任务${running ? `，正在处理 ${running.eventId}` : '，空闲'}`);

      // Mac 在不在线决定导出卡片上给不给「同步到 Mac」这个按钮。
      // 「按钮怎么没了」是被问过的，所以这里直接把原因摆出来。
      // 没报活过时 humanAge 给的是「从未」，不能硬拼成「最后报活 从未」。
      const age = macAliveAge();
      if (macOnline()) lines.push(`Mac：在线（${humanAge(age)}报活）`);
      else if (!Number.isFinite(age)) lines.push('Mac：不在线（从未报活过 —— 那台机器上 `npm run watch` 没跑起来）');
      else lines.push(`Mac：不在线（最后报活 ${humanAge(age)}）`);

      const r = readResult();
      if (r?.at) {
        const what = r.ok
          ? `${r.files} 个文件${r.added || r.changed ? `（新增 ${r.added ?? 0}，更新 ${r.changed ?? 0}）` : ''}`
          : `失败 —— ${r.error ?? '原因不明'}`;
        lines.push(`上次同步：${humanAge(Date.now() - r.at)}（${what}）`);
      } else {
        lines.push('上次同步：还没有过');
      }

      lines.push(`模型：${config.anthropic.model}`);
      lines.push(`单次上限：$${config.run.maxBudgetUsd} / ${config.run.maxTurns} 轮`);
      const saved = readJson(paths.journal, []);
      const recent = saved.slice(-5).reverse();
      if (recent.length) {
        lines.push('最近任务：');
        for (const j of recent) lines.push(`· ${statusLabel(j.status)} — ${(j.text || '').slice(0, 24) || '(仅附件)'}`);
      }
      return lines.join('\n');
    }
    // 只读的运维查询：出问题时不用 ssh 上来敲 journalctl。
    // ⚠️ 两段日志分开说清楚，因为它们回答的是不同问题：
    //    错误那段落盘、跨重启还在（「出过什么错」）；
    //    尾部那段只在内存里（「刚才在干嘛」），重启就没了。
    case '/日志':
    case '/log': {
      // 单行可能很长（比如某次把整个 SDK 响应打了出来），一行就能吃掉整张卡片。
      const clip = (l) => (l.length > 300 ? `${l.slice(0, 300)}…（截断）` : l);
      // 用代码块而不是「· 」列表：日志是等宽的，行首时间戳对齐了才扫得动。
      const block = (arr) => ['```', ...arr.map(clip), '```'];

      const errs = recentErrors(12);
      const lines = errs.length
        ? [`**最近的错误**（${errs.length} 条，跨重启保留）：`, ...block(errs)]
        : ['最近没有报错。'];

      const tail = recentLines(8);
      lines.push('');
      if (tail.length) {
        lines.push(`**最近日志**（内存里共 ${logBuffered()} 行）：`);
        lines.push(...block(tail));
      } else {
        lines.push('最近日志：（刚重启，还没有新的）');
      }

      lines.push('');
      lines.push('完整历史在服务器上：`journalctl -u wedding-bot -n 200`');
      return lines.join('\n');
    }
    case '/重置':
    case '/新对话': {
      try { fs.unlinkSync(path.join(paths.recentChats, `${job.chatId}.jsonl`)); } catch { /* 没有就没有 */ }
      return '已清空短期对话记忆。你的 data/ 数据完全不受影响。';
    }
    // 返回对象而不是字符串：这张卡片要按 Mac 在不在线决定给哪些按钮，
    // 而判断在线与否要读文件。放在队列 worker 里做，避免占用事件回调那 3 秒。
    case '/导出':
    case '/export':
      return { action: 'export' };
    default:
      return null;
  }
}

// ── 导出：把数据弄回本地 ────────────────────────────────────────────
// 两条路，同一份内容清单（见 bot/export.mjs）：
//   同步 → 服务器盖个 seq，Mac 上的 watcher 轮询到之后自己拉（scripts/watch.mjs）
//   下载 → 服务器打包成 zip 传上来，人在外面用手机也能拿到
//
// ⚠️ 按钮点击只能落在**服务器**上。你的 Mac 没有公网 IP，外网连不进去，
//    所以「同步」这条路必须由 Mac 主动来问 —— 这就是下面 seq 机制存在的原因。

const CLICK_TTL_MS = 60_000;

// 卡片回调在这条（经典）分发路径上**没有**内置去重，飞书若重复投递就会重复执行。
// 按「卡片 + 人 + 按钮」记一小段时间，双击和重投都吸收掉。
const recentClicks = new Map();

/** 卡片回调的权限判断。比消息那条更严：转出去的卡片谁都能点。 */
function cardAllowed(chatId, openId) {
  const { users, chats } = config.access;
  if (users.length && !users.includes(openId)) return false;
  if (chats.length && !chats.includes(chatId)) return false;
  return true;
}

const sendExportCard = (chatId) => sendCard(chatId, renderExportCard());

/** 打包并上传。会先改卡片说「在打包」，免得看着像卡住了。 */
async function runExportZip(chatId, messageId) {
  let built;
  try {
    built = buildExportZip();
  } catch (err) {
    logger.error('[export] 打包失败：', err.message);
    await patchOrResend(chatId, messageId, renderExportCard(`打包失败：${err.message}`));
    return;
  }

  await patchOrResend(chatId, messageId,
    renderExportCard(`已打包 ${formatSummary(built.summary)}，正在上传…`));

  try {
    await sendFile(chatId, built.file);
  } catch (err) {
    logger.error('[export] 上传失败：', err.message);
    await patchOrResend(chatId, messageId, renderExportCard(`上传失败：${err.message}`));
    return;
  }

  await patchOrResend(chatId, messageId,
    renderExportCard('zip 已经发上来了，往上翻一条就是。'));
}

// 等 Mac 回执要等多久。本机轮询是 15 秒一次，拉一次几秒，所以正常 20 秒上下；
// 给到 2 分钟是留够「Mac 刚睡醒、网慢、或者服务器正忙」的余量。
const MAC_WAIT_MS = 2 * 60_000;
const MAC_POLL_MS = 3_000;

/**
 * 等 Mac 把回执写回来，然后刷新卡片。
 *
 * ── 为什么要轮询，而不是让 Mac 反过来通知 ────────────────────────────
 * Mac 在 NAT 后面没有公网 IP，服务器连不进去。所以只能服务器这边主动看。
 * 回执文件就是这个用途 —— 它不是「给机器读的状态」，是「给卡片读的结果」。
 *
 * 没有这一步的话，卡片会永远停在「正在等它来拉」，哪怕文件其实早就同步完了：
 * 用户按了按钮，却看不出到底成没成。
 */
async function waitForMac(chatId, messageId, seq) {
  const deadline = Date.now() + MAC_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, MAC_POLL_MS));
    const r = readResult();
    if ((r?.seq ?? 0) < seq) continue;      // 还是上一次的回执，继续等

    if (r.ok) {
      // 总数卡片上面那行已经写了（「上次同步：刚刚（53 个文件）」），
      // 这里只说这次变了什么。added/changed 是后加的字段，老回执里没有。
      const detail = (r.added || r.changed)
        ? `新增 ${r.added ?? 0} 个，更新 ${r.changed ?? 0} 个`
        : '内容没有变化';
      logger.info(`[card] Mac 回执到了 seq=${r.seq}，${r.files} 个文件`);
      await patchOrResend(chatId, messageId, renderExportCard(`✓ 同步完成：${detail}`));
    } else {
      logger.warn(`[card] Mac 回执 seq=${r.seq} 是失败：${r.error}`);
      await patchOrResend(chatId, messageId,
        renderExportCard(`✗ 同步失败：${r.error ?? '原因不明'}\n\nMac 那台机器的终端里有完整日志。`));
    }
    return;
  }

  logger.warn(`[card] 等了 ${MAC_WAIT_MS / 1000}s 没等到 Mac 回执（seq=${seq}）`);
  await patchOrResend(chatId, messageId, renderExportCard(
    'Mac 一直没回话。确认它那台机器上 `npm run watch` 还在跑。'));
}

/**
 * 卡片按钮回调。返回值会被 SDK base64 后送回飞书，所以可以当场弹个提示。
 * 这个函数**必须尽快返回** —— 打包上传这些慢活全部丢到后台去。
 */
function onCardAction(data) {
  try {
    const act = data?.action?.value?.act;
    const chatId = data?.context?.open_chat_id;
    const messageId = data?.context?.open_message_id;
    const openId = data?.operator?.open_id;

    if (!act || !chatId) return undefined;
    if (!cardAllowed(chatId, openId)) {
      logger.warn(`[card] 忽略未授权的点击 act=${act} chat=${chatId}`);
      return undefined;
    }

    const key = `${messageId}:${openId}:${act}`;
    const now = Date.now();
    for (const [k, t] of recentClicks) if (now - t > CLICK_TTL_MS) recentClicks.delete(k);
    if (recentClicks.has(key)) {
      logger.info(`[card] 重复点击，已忽略 act=${act}`);
      return { toast: { type: 'info', content: '这次点击已经收到了' } };
    }
    recentClicks.set(key, now);

    logger.info(`[card] 点击 act=${act} chat=${chatId}`);

    if (act === 'export_mac') {
      if (!macOnline()) {
        return { toast: { type: 'error', content: '你的 Mac 现在不在线，改用下载吧' } };
      }
      // 已经有一个请求在等着就不再盖新戳 —— 否则 Mac 会重复拉一遍
      if (requestInFlight()) {
        return { toast: { type: 'info', content: '已经通知过了，Mac 正在处理' } };
      }
      const seq = bumpRequest(openId);
      patchOrResend(chatId, messageId, renderExportCard())
        .catch((err) => logger.warn('[card] 更新卡片失败：', err.message));
      // 丢到后台去等，别阻塞这个必须尽快返回的回调
      waitForMac(chatId, messageId, seq)
        .catch((err) => logger.warn('[card] 等回执异常：', err.message));
      return { toast: { type: 'success', content: '已通知你的 Mac' } };
    }

    if (act === 'export_zip') {
      patchOrResend(chatId, messageId, renderExportCard('正在打包…'))
        .catch((err) => logger.warn('[card] 更新卡片失败：', err.message));
      runExportZip(chatId, messageId)
        .catch((err) => logger.error('[export] 打包/上传异常：', err));
      return { toast: { type: 'info', content: '正在打包…' } };
    }
  } catch (err) {
    logger.error('[card] 回调处理异常：', err);
  }
  return undefined;
}

// ── 队列：真正干活的地方 ───────────────────────────────────────────

const queue = new JobQueue({
  runner: runJob,
  onOrphan: async (job) => {
    // 上次没跑完就崩了。卡片不能永远停在「正在整理…」。
    if (!job.cardId) return;
    try {
      await patchOrResend(job.chatId, job.cardId,
        replyCard('服务重启了，这条没能处理完，麻烦重发一次。', [], 'orange'));
    } catch (err) {
      logger.warn('[orphan] 改卡片失败：', err.message);
    }
  },
});

async function runJob(job, { signal }) {
  // 命令类任务不走 Agent，直接回。放在队列里是为了不阻塞事件回调。
  if (job.kind === 'command') {
    if (job.commandAction === 'export') await sendExportCard(job.chatId);
    // 用卡片而不是纯文本：纯文本不认 markdown，/日志 里的代码块和反引号
    // 会原样露出来。机器人别的回复本来就是卡片，这样也一致。
    else await sendCard(job.chatId, replyCard(job.commandReply));
    return;
  }

  const cardId = await sendCard(job.chatId, WORKING());
  job.cardId = cardId;

  // 1) 附件：下载 → 嗅探/转码/切分 → 去重
  const mediaPaths = [];
  const mediaNotes = [];
  for (const img of job.images ?? []) {
    // 兼容老 journal 里的纯 fileKey 形态（那时一个 job 只对应一条消息）
    const { messageId, fileKey } = typeof img === 'string'
      ? { messageId: job.messageId, fileKey: img }
      : img;
    try {
      const buf = await downloadImage(messageId, fileKey);
      const result = await ingestImage(buf, { label: 'msg' });
      if (result.duplicate) {
        mediaNotes.push(result.note);
      } else {
        mediaPaths.push(...result.paths);
        if (result.note) mediaNotes.push(result.note);
      }
    } catch (err) {
      logger.error('[media] 下载/处理图片失败：', err.message);
      mediaNotes.push(`有一张图没能取到（${err.message}），如果重要请重发一次。`);
    }
  }

  // 本次没带图，但上一批还没归属 → 挂上来一次
  const carried = mediaPaths.length === 0 ? takePending(job.chatId) : [];
  const allPaths = [...mediaPaths, ...carried];
  if (allPaths.length) setPending(job.chatId, allPaths);

  // 2) 跑 Agent
  const artifacts = [];
  let lastPatch = 0;
  const onProgress = (text) => {
    const now = Date.now();
    if (now - lastPatch < 8000) return;   // 卡片 patch 有 5 QPS 限制，别刷
    lastPatch = now;
    const line = text.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160);
    if (!line) return;
    patchOrResend(job.chatId, cardId, buildCard({
      title: '备婚助手', markdown: `正在处理…\n\n_${line}_`, template: 'blue',
    })).catch(() => { /* 进度更新失败无所谓 */ });
  };

  const started = Date.now();
  const res = await runAgent({
    job, mediaPaths: allPaths, mediaNotes,
    onArtifact: (list) => artifacts.push(...list),
    onProgress, signal,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!res.ok) {
    const msg = failureMessage({ subtype: res.subtype, aborted: res.aborted, reason: res.reason });
    appendTurn(job.chatId, 'assistant', msg);
    await patchOrResend(job.chatId, cardId, replyCard(msg, [], 'orange'));
    return;
  }

  // 3) 交付产物：xlsx 发文件，网页给链接按钮
  const buttons = [];
  for (const art of artifacts) {
    if (art.kind === 'xlsx') {
      try { await sendFile(job.chatId, art.file); }
      catch (err) { logger.error('[deliver] xlsx 发送失败：', err.message); }
    } else if (art.kind === 'web') {
      if (config.publicBaseUrl) {
        // 文件名是中文，必须百分号编码。原样塞进 URL 的话，飞书卡片按钮或
        // 它打开的浏览器可能把路径截断 / 转错，表现是「点了没反应」或 404，
        // 而且很难看出是编码问题。
        const name = encodeURIComponent(path.basename(art.file));
        buttons.push({ label: '打开对比页', url: `${config.publicBaseUrl}/${name}`, type: 'primary' });
      } else {
        logger.warn('[deliver] 未配置 PUBLIC_BASE_URL，跳过网页按钮');
      }
    }
  }

  const body = res.text?.trim() || '处理完了。';
  appendTurn(job.chatId, 'assistant', body);
  await patchOrResend(job.chatId, cardId, replyCard(body, buttons));

  logger.info(`[job] 完成 event=${job.eventId} 用时=${elapsed}s 轮次=${res.turns} 花费=$${res.costUsd.toFixed(4)}`);
}

// 这几个词整句匹配时直接当 /导出 处理。不走 Agent 的原因：走 Agent 要花钱、
// 要排队、还慢，而「导出」这种词模型完全可能理解成别的意思（比如导出成表格）。
// 只做**整句**精确匹配，所以「把婚纱照导出成表格」不会误伤，照旧交给 Agent。
const EXPORT_WORDS = new Map([
  ['导出', '/导出'],
  ['导出数据', '/导出'],
  ['下载数据', '/导出'],
  ['同步数据', '/导出'],
]);

// ── 事件入口：只做去重 + 入队，必须立刻 return ──────────────────────
// 飞书要求 3 秒内处理完成，超时或抛异常都会触发重推
// （15s / 5min / 1h / 6h，最长约 7 小时窗口）。所以这里绝不能有网络 I/O ——
// 连回执卡片都交给队列 worker 发。

function onEvent(data) {
  try {
    const parsed = parseMessage(data);
    if (!parsed) return;
    if (!isAllowed(parsed)) {
      logger.warn(`[event] 忽略未授权的消息 chat=${parsed.chatId} type=${parsed.chatType}`);
      return;
    }

    const eventId = parsed.eventId || parsed.messageId;
    if (queue.hasSeen(eventId)) {
      logger.info(`[event] 重复推送，已忽略 event=${eventId}`);
      return;
    }

    const text = parsed.text || '';

    // 命令类消息立刻处理，不进队列（否则要排在长任务后面）
    const cmd = text.startsWith('/')
      ? text.split(/\s+/)[0]
      : EXPORT_WORDS.get(text.trim().replace(/^(?:@\S+\s*)+/, ''));

    if (cmd) {
      // 记一笔。这样 /日志 自己也留下「谁在什么时候发了什么命令」，
      // 「我发了 /状态 怎么没反应」才查得下去。
      logger.info(`[cmd] ${cmd} ← ${parsed.chatId}`);
      const reply = handleCommand(cmd, { chatId: parsed.chatId });
      if (reply) {
        queue.enqueue({
          eventId, chatId: parsed.chatId, messageId: parsed.messageId,
          images: [], text: '',
          kind: 'command',
          commandReply: typeof reply === 'string' ? reply : null,
          commandAction: typeof reply === 'string' ? null : reply.action,
        });
        return;
      }
    }

    if (!text.trim() && parsed.images.length === 0) return;   // 空消息，没什么可做的

    appendTurn(parsed.chatId, 'user', text || '[图片]');
    queue.enqueue({
      eventId,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      // 每张图带着自己的 messageId：合并后一个 job 会横跨多条消息，
      // 而飞书取图的接口是 /messages/{message_id}/resources/{file_key}，两个都要。
      images: parsed.images.map((fileKey) => ({ messageId: parsed.messageId, fileKey })),
      text,
      kind: 'agent',
      coalesce: parsed.images.length > 0,
    });
  } catch (err) {
    // 事件入口抛异常也会触发重推，这里必须全部吞掉并记录
    logger.error('[event] 处理入口异常：', err);
  }
}

// ── 启动 ───────────────────────────────────────────────────────────

const wsClient = new Lark.WSClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => { onEvent(data); },
  // 卡片按钮点击。注册键就是事件类型字符串 —— EventDispatcher.invoke() 是
  // 拿 data.header.event_type 去 handles 里查的，跟消息那条同一条路径。
  // 长连接下 WSClient 用 needCheck:false 调用，所以不需要 verification token。
  'card.action.trigger': (data) => onCardAction(data),
});

await queue.reconcile();
wsClient.start({ eventDispatcher: dispatcher });
logger.info('ws client ready');

setInterval(() => touchHeartbeat(config.heartbeatFile), 30_000);
touchHeartbeat(config.heartbeatFile);

setInterval(() => {
  const n = pruneRaw();
  if (n) logger.info(`[media] 清理了 ${n} 个过期 raw 目录`);
}, 12 * 3600_000);
