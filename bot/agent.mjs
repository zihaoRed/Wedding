import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, paths } from './config.mjs';
import { createRenderServer } from './tools.mjs';
import { logger } from './store.mjs';

/**
 * Claude Agent SDK 封装。
 *
 * 关键决策：**完全不用 resume**。
 * resume 会把整个历史 transcript 重新作为输入发一遍，而 maxBudgetUsd 并不
 * 覆盖这部分开销——用到第三个月，一句「把那家删掉」就可能超预算并返回
 * error_max_budget_usd。所以每条消息都是全新的 query()，上下文只由
 * 「行为规范 + 最近几轮对话摘要」构成，Agent 需要的其他信息自己去读文件。
 * 这样成本恒定、会话永不过期、重启无感，也让「状态存在文件里」这条原则真正落地。
 */

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 各平台常见的系统根证书包位置。 */
const CA_BUNDLE_CANDIDATES = [
  '/etc/ssl/cert.pem', // macOS
  '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu
  '/etc/pki/tls/certs/ca-bundle.crt', // RHEL / CentOS
  '/etc/ssl/ca-bundle.pem', // openSUSE
];

function findCaBundle() {
  for (const p of CA_BUNDLE_CANDIDATES) {
    try {
      if (fs.statSync(p).size > 0) return p;
    } catch { /* 该平台没有这个路径 */ }
  }
  return null;
}

/** 只把必要变量交给子进程，不要把整个 process.env 展开过去。 */
export function subprocessEnv() {
  const keep = [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TZ',
    // 允许 .env / 外部显式指定，指定了就不自动探测
    'NODE_EXTRA_CA_CERTS',
  ];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];

  // 凭据按「有值才设」写入。之前无条件写 ANTHROPIC_API_KEY 是个 bug：
  // 中转场景下它为空，会把字符串 "undefined" 塞进子进程环境，覆盖掉真正
  // 该用的 ANTHROPIC_AUTH_TOKEN，结果是每条消息都认证失败。
  if (config.anthropic.apiKey) env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
  if (config.anthropic.authToken) env.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
  if (config.anthropic.baseUrl) env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
  // SDK 自带的 CLI 内置信任库认不出部分中间 CA。已实测：访问 api.deepseek.com 时
  // SDK 的 2.1.295 报 UNABLE_TO_GET_ISSUER_CERT，而同一台机器、同一份环境下
  // Homebrew 的 2.1.267 正常。补上系统根证书即可，零成本，所以默认就带上。
  if (!env.NODE_EXTRA_CA_CERTS) {
    const bundle = findCaBundle();
    if (bundle) env.NODE_EXTRA_CA_CERTS = bundle;
  }

  // 状态一律存文件，关掉自动 memory 保证行为可预测
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

// ── 最近对话（替代 resume 的短期记忆）──────────────────────────────

const chatFile = (chatId) => path.join(paths.recentChats, `${chatId}.jsonl`);

export function appendTurn(chatId, role, text) {
  try {
    fs.mkdirSync(paths.recentChats, { recursive: true });
    fs.appendFileSync(chatFile(chatId), `${JSON.stringify({ role, text: truncate(text, 600), at: Date.now() })}\n`);
  } catch (err) {
    logger.warn('[agent] 写对话记录失败：', err.message);
  }
}

function recentTurns(chatId, n) {
  try {
    return fs.readFileSync(chatFile(chatId), 'utf8')
      .split('\n').filter(Boolean).slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── 写入防线 ──────────────────────────────────────────────────────

const PROTECTED = ['.claude', 'spec', 'state', 'bot'];

/**
 * PreToolUse hook：canUseTool 对预批准的调用不生效，所以硬约束只能放在 hook 里。
 * 两道拦截：
 *  1. 不许写 workspace 之外（含 .claude/spec/state）
 *  2. 不许用 Write 整体覆盖**已存在**的数据文件——只能 Edit 改具体行。
 *     整体覆盖会丢掉没注意到的内容，而且不可察觉。
 */
export const writeGuard = async (input) => {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  const deny = (reason) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

  if (!target) return {};
  const abs = path.resolve(input.cwd || paths.workspace, target);
  const ws = paths.workspace;

  if (!abs.startsWith(`${ws}${path.sep}`)) {
    return deny(`只能写 workspace 内的文件，${abs} 超出范围。`);
  }
  const rel = path.relative(ws, abs);
  if (PROTECTED.some((p) => rel === p || rel.startsWith(`${p}${path.sep}`))) {
    return deny(`${rel} 是受保护目录，不能写。`);
  }
  if (input.tool_name === 'Write' && rel.startsWith(`data${path.sep}`) && fs.existsSync(abs)) {
    return deny(
      `${rel} 已存在。不要用 Write 整体覆盖数据文件（会丢掉你没注意到的内容），` +
      `请改用 Edit 修改具体行；确实要重写就先 Read 完整内容再逐段改。`,
    );
  }
  return {};
};

// ── 主入口 ────────────────────────────────────────────────────────

function buildPrompt({ text, mediaPaths = [], mediaNotes = [] }, chatId) {
  const parts = [];
  const history = recentTurns(chatId, config.run.recentTurns);

  if (history.length) {
    parts.push('【最近对话，仅供理解指代，不作为事实依据】');
    for (const t of history) {
      parts.push(`${t.role === 'user' ? '用户' : '你'}：${truncate(t.text, 200)}`);
    }
    parts.push('');
  }

  parts.push('【本次消息】');
  parts.push(text?.trim() || '（没有文字，只有附件）');

  if (mediaPaths.length) {
    parts.push('');
    parts.push('【附件】以下是用户这次发来的图片，请用 Read 工具逐张读取：');
    for (const p of mediaPaths) parts.push(`- ${p}`);
    for (const n of mediaNotes.filter(Boolean)) parts.push(`注意：${n}`);
  }

  parts.push('');
  parts.push('（如果附件归属不明或关键字段看不清，按规范先反问，不要猜。）');

  return parts.join('\n');
}

export async function runAgent({ job, mediaPaths = [], mediaNotes = [], onArtifact, onProgress, signal }) {
  const spec = fs.readFileSync(paths.spec, 'utf8');

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  let text = '';
  let subtype = null;
  let isError = false;
  let costUsd = 0;
  let turns = 0;
  let q;

  try {
    q = query({
      prompt: buildPrompt({ ...job, mediaPaths, mediaNotes }, job.chatId),
      options: {
        cwd: paths.workspace,
        model: config.anthropic.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: spec },
        permissionMode: 'dontAsk',            // 清单外的调用直接拒绝，绝不挂起等人批准
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__wedding__render_output', 'mcp__wedding__field_health'],
        disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
        settingSources: [],                   // 硬边界：不加载任何文件系统设置
        mcpServers: { wedding: createRenderServer({ onArtifact }) },
        hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit', hooks: [writeGuard] }] },
        maxTurns: config.run.maxTurns,
        maxBudgetUsd: config.run.maxBudgetUsd,
        abortController: controller,
        env: subprocessEnv(),
      },
    });

    // signal 触发时同时走 interrupt()，让 SDK 走优雅关闭而不是硬杀
    signal?.addEventListener('abort', () => { try { q?.interrupt?.(); } catch { /* 已结束 */ } }, { once: true });

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) onProgress?.(block.text.trim());
        }
      } else if (msg.type === 'result') {
        subtype = msg.subtype;
        isError = Boolean(msg.is_error);
        costUsd = msg.total_cost_usd ?? 0;
        turns = msg.num_turns ?? 0;
        // result 字段只在 success 时存在，必须先判 subtype
        if (msg.subtype === 'success' && !msg.is_error) text = msg.result ?? '';
      }
    }
  } catch (err) {
    // 单次 query() 在产出 error result 之后还会抛异常，所以这里捕获后
    // 仍要看 subtype 判断到底是哪一类失败。
    if (controller.signal.aborted) {
      return { ok: false, aborted: true, reason: String(controller.signal.reason?.message || 'aborted'), costUsd, turns };
    }
    logger.error('[agent] query 抛异常：', err?.message || err);
    subtype = subtype || 'error_during_execution';
    isError = true;
  }

  const ok = subtype === 'success' && !isError;
  return { ok, text, subtype, isError, costUsd, turns, aborted: false };
}

/** 把 result 的各种失败类型翻译成用户看得懂的话。 */
export function failureMessage({ subtype, aborted, reason }) {
  if (aborted) {
    return reason === 'timeout'
      ? '这条处理超时了（已超过设定时长），我把它中断了。可以拆小一点再发一次。'
      : '已按你的要求中断这次处理。';
  }
  switch (subtype) {
    case 'error_max_turns':
      return '这次要处理的步骤太多，到上限就停了。试试把范围缩小一点（比如只汇总一个品类）。';
    case 'error_max_budget_usd':
      return '这次分析的开销到了单次上限就停了。如果内容确实很多，可以分几次处理。';
    case 'error_during_execution':
      return '处理过程中出错了，这次没有改动任何数据。可以重发一次试试。';
    default:
      return '这次没能处理成功。可以重发一次，或者换个说法描述你想要什么。';
  }
}
