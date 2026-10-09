import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { config, paths, ensureDirs, validateConfig } from './config.mjs';
import { acquireLock, touchHeartbeat, logger, readJson, writeJsonAtomic } from './store.mjs';
import { JobQueue, statusLabel } from './queue.mjs';
import { parseMessage, isAllowed } from './events.mjs';
import { buildCard, sendCard, sendText, patchOrResend, sendFile, downloadImage } from './feishu.mjs';
import { ingestImage, pruneRaw } from './media.mjs';
import { runAgent, appendTurn, failureMessage } from './agent.mjs';

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

function handleCommand(cmd, job) {
  switch (cmd) {
    case '/stop': {
      const ok = queue.cancel(job.chatId);
      return ok ? '已请求中断当前任务。' : '当前没有正在处理的任务。';
    }
    case '/status': {
      const running = queue.runningJob;
      const lines = [`排队中/进行中：${queue.depth} 个任务`];
      if (running) lines.push(`正在处理：${running.eventId}`);
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
    case '/重置':
    case '/新对话': {
      try { fs.unlinkSync(path.join(paths.recentChats, `${job.chatId}.jsonl`)); } catch { /* 没有就没有 */ }
      return '已清空短期对话记忆。你的 data/ 数据完全不受影响。';
    }
    default:
      return null;
  }
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
    await sendText(job.chatId, job.commandReply);
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
    if (text.startsWith('/')) {
      const reply = handleCommand(text.split(/\s+/)[0], { chatId: parsed.chatId });
      if (reply) {
        queue.enqueue({
          eventId, chatId: parsed.chatId, messageId: parsed.messageId,
          images: [], text: '', kind: 'command', commandReply: reply,
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
