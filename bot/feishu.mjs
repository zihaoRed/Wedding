import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.mjs';
import { logger } from './store.mjs';

// 惰性创建：不要在模块加载时就要求凭据，否则这个文件没法被单独 import
// （测试、探针脚本都会受影响），而且缺配置的报错会出现在奇怪的时机。
let _client = null;
function client() {
  if (!_client) {
    _client = new Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
  }
  return _client;
}

// 卡片正文上限 30KB（错误码 230025），留点富文本转义的余量。
const CARD_BODY_LIMIT = 28_000;

function unwrap(res, what) {
  if (res && typeof res === 'object' && 'code' in res && res.code !== 0) {
    throw new Error(`${what} 失败：code=${res.code} msg=${res.msg}`);
  }
  return res;
}

/**
 * 构造 schema 2.0 卡片。
 *
 * 必须是 2.0 —— 1.0 不支持 markdown 组件里的表格，而 lark_md（text 元素的标签）
 * 的白名单里根本没有表格、标题、列表、代码块。写成 1.0 或 lark_md 的话，
 * 对比表会原样显示成一堆竖线和 |---|。
 */
export function buildCard({ title, template = 'blue', markdown = '', buttons = [], elements = [] }) {
  let body = String(markdown);
  if (body.length > CARD_BODY_LIMIT) {
    body = `${body.slice(0, CARD_BODY_LIMIT)}\n\n…（内容过长已截断，完整内容见附件）`;
  }

  const els = [];
  if (body) els.push({ tag: 'markdown', content: body, text_size: 'normal_v2' });
  els.push(...elements);
  for (const b of buttons) {
    // 两种按钮：
    //   · 给了 url   → open_url，直接在浏览器里打开
    //   · 给了 value → callback，点击会作为 card.action.trigger 事件走长连接回来
    // 只传一个字段的话飞书会拒收整张卡片，所以这里必须二选一、不能都塞。
    const behavior = b.value
      ? { type: 'callback', value: b.value }
      : { type: 'open_url', default_url: b.url };

    els.push({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label },
      type: b.type || 'default',
      width: 'default',
      behaviors: [behavior],
    });
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { direction: 'vertical', elements: els },
  };
}

/** 发一张交互卡片，返回 message_id（后面要 patch 它）。 */
export async function sendCard(chatId, card) {
  const res = unwrap(await client().im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
  }), '发送卡片');
  return res.data?.message_id;
}

export async function sendText(chatId, text) {
  const res = unwrap(await client().im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
  }), '发送文本');
  return res.data?.message_id;
}

/**
 * 更新已发出的卡片。注意：patch 是**整体替换**而不是合并（待 Phase 0 实测确认），
 * 所以每次都传完整卡片，不做增量。
 */
export async function patchCard(messageId, card) {
  unwrap(await client().im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  }), '更新卡片');
}

/**
 * 更新卡片，失败就降级成新消息——绝不能让卡片停在「整理中」。
 */
export async function patchOrResend(chatId, messageId, card) {
  try {
    await patchCard(messageId, card);
    return messageId;
  } catch (err) {
    logger.warn(`[feishu] patch 失败（${err.message}），降级为发新消息`);
    return sendCard(chatId, card);
  }
}

const FILE_TYPE = {
  '.xlsx': 'xls',
  '.xls': 'xls',
  '.zip': 'stream',   // 飞书没有专门的 zip 类型，stream 就是通用二进制
  '.pdf': 'pdf',
  '.docx': 'doc',
  '.pptx': 'ppt',
  '.mp4': 'mp4',
};

/** 上传文件并作为文件消息发出。 */
export async function sendFile(chatId, filePath) {
  const name = path.basename(filePath);
  const fileType = FILE_TYPE[path.extname(filePath).toLowerCase()] || 'stream';

  const up = unwrap(await client().im.v1.file.create({
    data: {
      file_type: fileType,
      file_name: name,
      file: fs.createReadStream(filePath),
    },
  }), `上传文件 ${name}`);

  // ⚠️ 这个接口返回的是**扁平**的 `{ file_key }`，没有 `code`/`data` 那层信封 ——
  //    跟 message.create 的 `{ code, msg, data: { message_id } }` 不是一个形状。
  //
  //    这里原来写的是 `up.data.file_key`，于是**每一次上传都抛错**：xlsx 交付
  //    从 10/9 起连续 7 次全败，一次没成功过。之所以一直没被当成代码 bug，
  //    是因为报错写成「未返回 file_key」，读起来像飞书那边没给，而不像读错了字段。
  //
  //    实测过 1KB 和 2.8MB 两种大小，返回都是扁平的，所以不是「大文件才这样」。
  //    两个形状都认，免得哪天 SDK 把信封加回来又炸一次。
  const fileKey = up?.file_key ?? up?.data?.file_key;
  if (!fileKey) {
    throw new Error(`上传 ${name} 未返回 file_key。原始响应：${JSON.stringify(up).slice(0, 500)}`);
  }

  unwrap(await client().im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
  }), `发送文件 ${name}`);

  return fileKey;
}

/** 下载消息里的图片资源，返回 Buffer。 */
export async function downloadImage(messageId, fileKey) {
  const res = await client().im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: 'image' },
  });

  // lark node-sdk 对二进制接口的返回形态在不同版本间有差异，这里逐个兜底。
  if (Buffer.isBuffer(res)) return res;
  if (Buffer.isBuffer(res?.data)) return res.data;

  const stream = typeof res?.getReadableStream === 'function'
    ? res.getReadableStream()
    : (res?.data && typeof res.data[Symbol.asyncIterator] === 'function' ? res.data : null);

  if (stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  if (typeof res?.writeFile === 'function') {
    const tmp = path.join('/tmp', `fs-${Date.now()}-${fileKey}`);
    await res.writeFile(tmp);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf;
  }

  throw new Error(`无法从 messageResource.get 的返回中取出图片字节（fileKey=${fileKey}）`);
}
