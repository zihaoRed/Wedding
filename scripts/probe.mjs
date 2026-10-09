/**
 * Phase 0：实测三个承重假设。这些答案会改变正式实现的设计，
 * 所以填好 .env 之后先跑这个，别急着开 bot。
 *
 *   node scripts/probe.mjs
 *
 * 需要：.env 里已填 FEISHU_APP_ID / FEISHU_APP_SECRET。
 *
 * 注意顺序：飞书后台的「订阅方式 = 长连接」**必须先有客户端连上来才保存得上**，
 * 所以是「先跑本脚本 → 再去后台保存订阅方式并发布 → 最后手机发消息」。
 * 脚本会一直等着，不着急。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as Lark from '@larksuiteoapi/node-sdk';

import { config, ensureDirs, validateConfig } from '../bot/config.mjs';
import { logger } from '../bot/store.mjs';
import { sendCard, patchCard, downloadImage, buildCard } from '../bot/feishu.mjs';
import { sniffFormat } from '../bot/media.mjs';
import sharp from 'sharp';

ensureDirs();
validateConfig();

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(`\n? ${q}\n  > `);

const findings = [];
const record = (k, v) => { findings.push([k, v]); console.log(`  → ${k}：${v}`); };

// 等待用户私聊机器人发一条消息。tick 非 0 时每分钟报一次进度，
// 这样用户去后台配置时不至于对着一个静止的终端怀疑它挂了。
function waitForMessage({ timeoutMs = 180_000, kind = 'any', tick = 0 } = {}) {
  return new Promise((resolve) => {
    let ticker = null;

    const timer = setTimeout(() => {
      clearInterval(ticker);
      resolve(null);
    }, timeoutMs);

    if (tick) {
      const started = Date.now();
      ticker = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        console.log(`  …仍在等待（已 ${s} 秒，Ctrl+C 可退出）`);
      }, tick);
    }

    pending = (data) => {
      const msg = data?.message;
      if (!msg) return;
      if (kind === 'image' && msg.message_type !== 'image') return;
      clearTimeout(timer);
      clearInterval(ticker);
      pending = null;
      resolve(data);
    };
  });
}
let pending = null;

// 连不上时把 PROBE_LOG=info 打开，能看到握手和重连过程
const LOG_LEVELS = { debug: Lark.LoggerLevel.debug, info: Lark.LoggerLevel.info, warn: Lark.LoggerLevel.warn };
const logLevel = LOG_LEVELS[process.env.PROBE_LOG] ?? Lark.LoggerLevel.warn;

const wsClient = new Lark.WSClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: logLevel,
});

const arrivals = [];
const dispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const id = data.event_id || data.header?.event_id || data.message?.message_id;
    const n = arrivals.filter((a) => a.id === id).length;
    arrivals.push({ id, at: Date.now(), n });
    console.log(`\n[事件] id=${id} 第 ${n + 1} 次到达 (message_type=${data.message?.message_type})`);
    await pending?.(data);
    // 故意睡 10 秒，用来观察飞书会不会因为超过 3 秒而重推
    await new Promise((r) => setTimeout(r, 10_000));
  },
});

wsClient.start({ eventDispatcher: dispatcher });
await new Promise((r) => setTimeout(r, 1500));

console.log('\n' + '═'.repeat(60));
console.log('长连接已建立 —— 趁现在去后台把剩下的配置做完');
console.log('═'.repeat(60));
console.log(`
还剩两步要在这个脚本**运行期间**做（脚本会一直等着，不用急）：

  ① 回后台 →「事件与回调」→ 订阅方式改成「使用长连接接收事件」→ 保存
     （后台要先探测到有客户端连上来才让保存，所以只能趁现在做）

  ② 「版本管理与发布」→ 创建版本并发布          ← ★ 最容易漏的一步
     订阅方式和事件、权限一样，**发布之后才生效**。只保存不发布的话，
     后台会显示已经是长连接（API 查 callback_info 也是 websocket），
     但服务器不会往这条连接推任何事件——表现就是
     「连接好好的、手机发消息却毫无反应」，而且本地日志干净得可疑。

如果①保存时报「应用未建立长连接」或类似错误，通常是这两件事没做完：

  · 「版本管理与发布」→ 创建版本并发布（先有一次发布，长连接才建得起来）
  · 「权限管理」四个权限 + 「事件」im.message.receive_v1 是否都加了
    im:message / im:message:send_as_bot
    im:message.p2p_msg:readonly / im:message.group_at_msg:readonly

两步都做完，再用手机私聊机器人发一条文字消息。
`);

// ── 假设 1：3 秒超时会不会触发重推？────────────────────────────────
console.log('═'.repeat(60));
console.log('假设 1 / 3：飞书会不会因为处理超过 3 秒而重推？');
console.log('═'.repeat(60));
console.log('请用手机给机器人私聊发任意一条文字消息。');
console.log('（回调里会故意 sleep 10 秒。如果几分钟内同一条消息再次到达，就是会重推。）');

// 给足时间去后台配置：等 30 分钟，每分钟报一次进度
const first = await waitForMessage({ timeoutMs: 30 * 60_000, tick: 60_000 });
if (!first) {
  console.log('没等到消息，跳过。');
} else {
  const chatId = first.message.chat_id;
  console.log('\n继续等待 5 分钟，看是否有重推…（可以先去干别的）');
  await new Promise((r) => setTimeout(r, 300_000));

  const dupes = arrivals.filter((a) => a.n > 0);
  if (dupes.length) {
    record('3 秒超时', `会重推（观察到 ${dupes.length} 次重复投递）→ 必须做持久化 event_id 去重`);
  } else {
    record('3 秒超时', '5 分钟内没有观察到重推 → SDK 可能在传输层就 ACK 了');
    console.log('  注意：这只说明本次没触发。稳妥起见仍建议保留去重（成本很低）。');
  }

  // ── 假设 2：patch 是替换还是合并？────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('假设 2 / 3：message.patch 是「整体替换」还是「合并」？');
  console.log('═'.repeat(60));

  const msgId = await sendCard(chatId, buildCard({
    title: 'Phase 0 探针',
    markdown: '第一段：**苹果**\n\n第二段：**香蕉**',
    template: 'turquoise',
  }));
  console.log('\n已发一张卡片，上面有两段：苹果 / 香蕉。');

  // 没有终端时 rl.question() 会立刻拿到空串，如果照旧逻辑走下去会把「合并」
  // 当成结论记下来——那是错的。所以这里必须区分能不能交互。
  const interactive = Boolean(process.stdin.isTTY);

  if (interactive) {
    await ask('请在手机上确认你能看到「苹果」和「香蕉」两段，然后按回车');
  } else {
    console.log('（无终端，跳过回车确认——请留意手机上的这张卡片，15 秒后更新它）');
    await new Promise((r) => setTimeout(r, 15_000));
  }

  await patchCard(msgId, buildCard({
    title: 'Phase 0 探针',
    markdown: '第一段：**西瓜**',
    template: 'turquoise',
  }));
  console.log('已 patch 成只含「西瓜」。请对照手机看现在显示的是什么：');
  console.log('  a) 只有「西瓜」        → patch 是整体替换');
  console.log('  b) 「西瓜」+「香蕉」都在 → patch 是分段合并');

  if (interactive) {
    const answer = await ask('输入 a 或 b');
    if (answer.trim().toLowerCase().startsWith('a')) {
      record('patch 语义', '整体替换 → 每次必须传完整卡片（当前实现即是如此，无需改动）');
    } else {
      record('patch 语义', '合并 → 需要重新设计卡片更新方式，先按元素索引对齐');
    }
  } else {
    record('patch 语义', '⚠️ 需人工确认（本次运行没有终端，无法提问）——请照着手机看是 a 还是 b 再记');
  }

  // ── 假设 3：图片以什么格式、多大到达？────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('假设 3 / 3：手机截图/照片下发的格式与尺寸');
  console.log('═'.repeat(60));
  console.log('请用手机发一张**iPhone 截图**（商家报价截图），再发一张**手机拍的照**。');
  console.log('（照片如果是 HEIC 会在这里暴露出来——Claude 的 Read 工具读不了 HEIC。）');

  pending = null;
  for (let i = 0; i < 2; i += 1) {
    const evt = await waitForMessage({ kind: 'image', timeoutMs: 120_000 });
    if (!evt) break;
    const key = JSON.parse(evt.message.content).image_key;
    const buf = await downloadImage(evt.message.message_id, key);
    const fmt = sniffFormat(buf);
    let dim = '无法解析';
    try {
      const m = await sharp(buf).metadata();
      dim = `${m.width}x${m.height}（比例 ${(m.height / m.width).toFixed(1)}）`;
    } catch { /* 可能是不支持的格式 */ }
    console.log(`  第 ${i + 1} 张：${buf.length} 字节，嗅探格式=${fmt}，尺寸=${dim}`);
    if (i === 1) {
      record('图片格式', `${fmt} / ${dim}`);
      if (fmt === 'heic') {
        console.log('  ⚠️  收到 HEIC —— 说明必须转码，media.mjs 里的逻辑是必需的。');
      } else if (fmt === 'jpeg' || fmt === 'png') {
        console.log('  飞书客户端已经帮你转码过了，HEIC 分支基本用不上（但留着无妨）。');
      }
      const m = await sharp(buf).metadata().catch(() => null);
      if (m && m.height / m.width > 3) {
        console.log('  ⚠️  这是一张长截图 —— 验证长图切分逻辑确实必要。');
      }
    }
  }

  // ── 结论 ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Phase 0 结论');
  console.log('═'.repeat(60));
  for (const [k, v] of findings) console.log(`· ${k}：${v}`);
  console.log('\n把这份结论发回给 Claude，它会据此调整实现。');
}

rl.close();
process.exit(0);
