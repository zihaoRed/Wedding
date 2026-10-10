import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const num = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  },
  anthropic: {
    // 两种凭据形态：官方 key 走 x-api-key，中转 token 走 Authorization: Bearer。
    // 只填其中一个即可，SDK 子进程会按各自的方式读。
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
    baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    // 中转（如 DeepSeek）不认 claude-* 型号名，所以 MODEL 必须显式指定；
    // 退回 ANTHROPIC_MODEL 是为了让本机已有的 Claude Code 配置直接可用。
    model: process.env.MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },
  access: {
    users: list(process.env.ALLOWED_USERS),
    chats: list(process.env.ALLOWED_CHATS),
  },
  run: {
    jobTimeoutMs: num(process.env.JOB_TIMEOUT_MS, 240_000),
    maxBudgetUsd: num(process.env.MAX_BUDGET_USD, 1.5),
    maxTurns: num(process.env.MAX_TURNS, 40),
    recentTurns: num(process.env.RECENT_TURNS, 6),
    rawRetentionDays: num(process.env.RAW_RETENTION_DAYS, 90),
    // 连发图片的合并窗口。一次转发 6 张在飞书里是 6 条独立消息，不合并就是
    // 6 次完整 Agent 回合（实测 6 张花了 $1.76，且轮次逐条递增）。
    coalesceMs: num(process.env.COALESCE_MS, 8_000),
  },
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  heartbeatFile: process.env.HEARTBEAT_FILE || path.join(ROOT, 'state', 'heartbeat'),

  // 「把数据弄回本地」这件事跨越两台机器，配置必须两边都能读到 ——
  // 所以统一放在这里，由 bot/ 和 scripts/ 共同 import。
  export: {
    // 服务器地址。本地的 watch/pull 用它连上去；机器人自己不用。
    host: process.env.DEPLOY_HOST || '',
    remoteRoot: process.env.DEPLOY_ROOT || '/srv/wedding',
    // 本地的落地目录
    dir: process.env.EXPORT_DIR || path.join(os.homedir(), 'wedding-export'),
    // 本地 watcher 多久问一次服务器
    pollMs: num(process.env.EXPORT_POLL_MS, 15_000),
    // 多久没收到 Mac 报活就算它离线。给足冗余：网络抖一下不该让卡片
    // 谎报「Mac 不在线」，那会把你引到多余的下载上。
    macAliveMs: num(process.env.EXPORT_MAC_ALIVE_MS, 90_000),
    // 服务器上保留几个导出包（给飞书下载用的）
    keep: num(process.env.EXPORT_KEEP, 2),
  },
};

export const paths = {
  root: ROOT,
  workspace: path.join(ROOT, 'workspace'),
  data: path.join(ROOT, 'workspace', 'data'),
  inbox: path.join(ROOT, 'workspace', 'inbox'),
  raw: path.join(ROOT, 'workspace', 'raw'),
  output: path.join(ROOT, 'workspace', 'output'),
  spec: path.join(ROOT, 'spec', 'AGENT_SPEC.md'),
  state: path.join(ROOT, 'state'),
  web: path.join(ROOT, 'web'),
  journal: path.join(ROOT, 'state', 'jobs.json'),   // 任务日志，同时就是事件去重表（见 queue.mjs 的 DEDUPE_TTL_MS）
  mediaIndex: path.join(ROOT, 'state', 'media-index.json'),
  lock: path.join(ROOT, 'state', 'bot.lock'),
  recentChats: path.join(ROOT, 'state', 'chats'),
};

export const CATEGORIES = ['婚纱照', '化妆师', '摄影师', '司仪', '婚礼用品', '婚宴场地'];

export function ensureDirs() {
  const dirs = [
    paths.workspace, paths.data, paths.inbox, paths.raw, paths.output,
    paths.state, paths.web, paths.recentChats,
    ...CATEGORIES.map((c) => path.join(paths.data, c)),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

/** 是否有可用的模型凭据（官方 key 或中转 token 任一）。 */
export function hasAnthropicCredentials() {
  return Boolean(config.anthropic.apiKey || config.anthropic.authToken);
}

/** 启动前校验，缺配置就直接退出而不是跑起来才发现。 */
export function validateConfig() {
  const missing = [];
  if (!config.feishu.appId) missing.push('FEISHU_APP_ID');
  if (!config.feishu.appSecret) missing.push('FEISHU_APP_SECRET');
  if (!hasAnthropicCredentials()) missing.push('ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
  if (missing.length) {
    console.error(`[config] 缺少必要配置：${missing.join(', ')}\n` +
      `         请复制 .env.example 为 .env 并填写。`);
    process.exit(1);
  }
  if (!config.publicBaseUrl) {
    console.warn('[config] 未设置 PUBLIC_BASE_URL，对比页的链接按钮将无法使用（仍会附 xlsx）。');
  }
}
