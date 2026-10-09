/**
 * 前置检查：在跑 Phase 0 之前，把「配置对不对、网通不通、模型能不能干活」确认掉。
 *
 *   npm run check          # 只做本地 + 网络检查，不花钱
 *   npm run check:agent    # 额外跑一次真实的 Agent 回合（会消耗少量 token）
 *
 * 加 --agent 的那一步是整套系统唯一真正的门禁：它会用 bot 实际使用的环境和
 * 参数跑一个回合，验证「凭据 → 模型名 → 工具调用 → 写文件」四件事全通。
 * 走中转时尤其必要——中转对 Messages API 兼容，不代表对 Agent SDK 的工具循环兼容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths, ensureDirs, hasAnthropicCredentials } from '../bot/config.mjs';

const WITH_AGENT = process.argv.includes('--agent');

ensureDirs();

let fail = 0;
const line = (ok, name, detail = '') => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, why) => console.log(`  – ${name}（跳过：${why}）`);
const note = (t) => console.log(`    ${t}`);
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 50 - t.length))}`);

console.log(`备婚助手 · 前置检查${WITH_AGENT ? '（含 Agent 实测）' : ''}`);

// ── 1. 配置 ───────────────────────────────────────────────────────
section('.env 配置');
const envExists = fs.existsSync(path.join(paths.root, '.env'));
line(envExists, '.env 文件存在', envExists ? '' : '先 cp .env.example .env');
line(Boolean(config.feishu.appId), 'FEISHU_APP_ID', config.feishu.appId ? `…${config.feishu.appId.slice(-6)}` : '未填');
line(Boolean(config.feishu.appSecret), 'FEISHU_APP_SECRET', config.feishu.appSecret ? `已填（${config.feishu.appSecret.length} 字符）` : '未填');

const credForm = config.anthropic.apiKey && config.anthropic.authToken
  ? '两个都填了（会以 key 优先，建议只留一个）'
  : config.anthropic.apiKey ? 'ANTHROPIC_API_KEY（官方）'
    : config.anthropic.authToken ? 'ANTHROPIC_AUTH_TOKEN（中转）' : '未填';
line(hasAnthropicCredentials(), '模型凭据', credForm);
note(`模型：${config.anthropic.model}`);
note(`地址：${config.anthropic.baseUrl || 'https://api.anthropic.com（直连）'}`);
note(`对比页：${config.publicBaseUrl || '（未设，本地测试可忽略）'}`);

if (!hasAnthropicCredentials()) {
  console.log('\n模型凭据缺失，后面的连通性检查没法做。先填 .env。');
  process.exit(1);
}

// ── 2. 飞书凭据 ───────────────────────────────────────────────────
section('飞书凭据');
if (!config.feishu.appId || !config.feishu.appSecret) {
  skip('App ID / Secret 校验', '未填');
} else {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (body.code === 0) {
      line(true, 'App ID / Secret 有效', `token 有效期 ${body.expire}s`);
    } else {
      line(false, 'App ID / Secret 校验失败', `code=${body.code} msg=${body.msg}`);
      note('常见原因：Secret 复制错了，或应用还没创建版本并发布。');
    }
  } catch (err) {
    line(false, '无法访问飞书开放平台', err.message);
    note('飞书不需要公网 IP，但需要这台机器能出网。检查网络/防火墙。');
  }
}

// ── 3. 模型接口连通性 ─────────────────────────────────────────────
section('模型接口连通性');
const base = (config.anthropic.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
const headers = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
};
if (config.anthropic.apiKey) headers['x-api-key'] = config.anthropic.apiKey;
// 部分中转只认 Bearer，两个都带；正规服务端会忽略多余的头
if (config.anthropic.authToken) headers.authorization = `Bearer ${config.anthropic.authToken}`;

try {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (res.ok) {
    line(true, `模型 ${config.anthropic.model} 可用`, `HTTP ${res.status}`);
  } else {
    line(false, '接口返回错误', `HTTP ${res.status}`);
    let hint = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      hint = j.error?.message || j.message || hint;
    } catch { /* 原样输出 */ }
    note(hint);
    if (res.status === 401 || res.status === 403) {
      note('→ 凭据无效。走中转的话确认 .env 里是 ANTHROPIC_AUTH_TOKEN 而不是 API_KEY。');
      note('  另外 dotenv 不覆盖环境变量，本机 shell 里的值可能盖过了 .env。');
    } else if (res.status === 404 || /model|not found/i.test(hint)) {
      note(`→ 模型名不对。中转不认 claude-*，把 .env 的 MODEL 改成中转支持的型号。`);
    }
  }
} catch (err) {
  line(false, '连不上模型接口', err.message);
  if (!config.anthropic.baseUrl) {
    note('→ 超时/连接被拒，基本可以确定这台机器直连 api.anthropic.com 不通。');
    note('  在 .env 里设 ANTHROPIC_BASE_URL 指向你的中转地址。');
  }
}

// ── 4. 目录与权限 ─────────────────────────────────────────────────
section('目录与权限');
try {
  const probe = path.join(paths.state, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  line(true, 'state/ 可写');
} catch (err) {
  line(false, 'state/ 不可写', err.message);
}
line(fs.existsSync(paths.spec), 'spec/AGENT_SPEC.md 存在');
line(fs.existsSync(path.join(paths.workspace, 'data')), 'workspace/data/ 存在');

// ── 5. Agent 端到端实测（可选）────────────────────────────────────
if (WITH_AGENT) {
  section('Agent 端到端实测');
  note('这一步会真的调用模型并消耗少量 token。');
  await runAgentCheck();
}

async function runAgentCheck() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { subprocessEnv } = await import('../bot/agent.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-check-'));
  const marker = path.join(dir, 'ping.txt');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);

  let subtype = null;
  let isError = false;
  let text = '';
  let turns = 0;
  const started = Date.now();

  try {
    const q = query({
      prompt: '用 Write 工具在当前目录创建 ping.txt，文件内容写 ok。然后只回复两个字：完成',
      options: {
        cwd: dir,
        model: config.anthropic.model,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'dontAsk',
        allowedTools: ['Write'],
        disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Task'],
        settingSources: [],
        maxTurns: 8,
        maxBudgetUsd: 0.3,
        abortController: controller,
        env: subprocessEnv(),
      },
    });

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) text = b.text.trim();
        }
      } else if (msg.type === 'result') {
        subtype = msg.subtype;
        isError = Boolean(msg.is_error);
        turns = msg.num_turns ?? 0;
      }
    }
  } catch (err) {
    line(false, 'Agent 回合抛异常', err.message);
    note('如果是认证/模型相关，先解决上面「模型接口连通性」那一节。');
    clearTimeout(timer);
    return;
  }
  clearTimeout(timer);

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (subtype === 'success' && !isError) {
    line(true, `回合正常结束（${turns} 轮，${secs}s）`);
    note(`模型回复：${text.slice(0, 80) || '(无文本)'}`);
  } else {
    line(false, `回合异常结束：${subtype}`, `${turns} 轮，${secs}s`);
    if (subtype === 'error_max_turns') note('→ 模型没能在 8 轮内完成任务，可能不擅长按指令用工具。');
    if (subtype === 'error_max_budget_usd') note('→ 超出 0.3 美元上限。中转计费口径可能和官方不同。');
  }

  if (fs.existsSync(marker)) {
    const content = fs.readFileSync(marker, 'utf8').trim();
    line(content === 'ok', '工具调用成功（ping.txt 已写入）', `内容：${JSON.stringify(content)}`);
  } else {
    line(false, '工具调用失败（ping.txt 没生成）');
    note('→ 模型能对话但不能可靠地用工具。这个 Agent 的核心就是读写文件，');
    note('  所以这一项不过的话，换一个工具调用能力更强的模型。');
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. 结论 ───────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
if (fail === 0) {
  console.log('全部通过。下一步：');
  console.log('  1. npm run probe          ← 建立长连接（别关这个窗口）');
  console.log('  2. 回飞书后台，订阅方式选「使用长连接接收事件」并保存');
  console.log('  3. 创建版本并发布应用');
  console.log('  4. 手机上私聊机器人，按探针提示操作');
} else {
  console.log(`有 ${fail} 项没过，先解决再往下走。`);
}
if (!WITH_AGENT && fail === 0) {
  console.log('\n建议再跑一次 npm run check:agent —— 验证模型真的能调工具写文件。');
}
process.exit(fail ? 1 : 0);
