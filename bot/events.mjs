import { config } from './config.mjs';

const MENTION_RE = /@_user_\d+/g;

/**
 * 解析飞书消息事件，抽出「要处理什么」。
 *
 * 注意 message_type 远不止 text/image —— 还有 post（富文本）、file、audio、
 * sticker、share_chat、system 等。而且**富文本和合并转发里的图片不会以
 * message_type: image 出现**，必须单独从 post 结构里捞 image_key。
 */
export function parseMessage(data) {
  const msg = data?.message;
  if (!msg) return null;

  const eventId = data.event_id || data.header?.event_id;
  const chatId = msg.chat_id;
  const messageId = msg.message_id;
  const chatType = msg.chat_type;
  const senderId = data.sender?.sender_id?.open_id;

  let payload = {};
  try { payload = JSON.parse(msg.content || '{}'); } catch { /* 某些类型 content 不是 JSON */ }

  const images = [];
  let text = '';

  switch (msg.message_type) {
    case 'text':
      text = (payload.text || '').replace(MENTION_RE, '').trim();
      break;

    case 'image':
      if (payload.image_key) images.push(payload.image_key);
      break;

    case 'post': {
      // 富文本：结构是 { title, content: [[{tag, text|image_key}, ...], ...] }
      text = collectPostText(payload);
      images.push(...collectPostImages(payload));
      break;
    }

    case 'file':
      text = `[收到文件：${payload.file_name || '未命名'}]`;
      break;

    case 'audio':
    case 'media':
    case 'sticker':
    case 'share_chat':
    case 'system':
      return null;   // 这些类型对备婚整理没有意义，直接忽略

    default:
      return null;
  }

  return {
    eventId,
    chatId,
    messageId,
    chatType,
    senderId,
    messageType: msg.message_type,
    text,
    images,
    mentionsBot: Array.isArray(msg.mentions) && msg.mentions.length > 0,
  };
}

function walkPost(node, visit) {
  if (Array.isArray(node)) { for (const n of node) walkPost(n, visit); return; }
  if (node && typeof node === 'object') visit(node);
}

function collectPostText(payload) {
  const parts = [];
  walkPost(payload.content, (n) => {
    if (n.tag === 'text' && n.text) parts.push(n.text);
    if (n.tag === 'a' && n.text) parts.push(n.text);
  });
  return [payload.title, ...parts].filter(Boolean).join(' ').replace(MENTION_RE, '').trim();
}

function collectPostImages(payload) {
  const keys = [];
  walkPost(payload.content, (n) => {
    if (n.tag === 'img' && n.image_key) keys.push(n.image_key);
  });
  return keys;
}

/**
 * 访问控制。群里每条「好的」都会触发一次 Agent 分析，必须挡住。
 * 策略：私聊放行（可选白名单）；群聊必须 @机器人 且在允许列表里。
 */
export function isAllowed(parsed) {
  const { access } = config;
  if (!parsed) return false;

  if (parsed.chatType === 'p2p') {
    return access.users.length === 0 || access.users.includes(parsed.senderId);
  }
  if (parsed.chatType === 'group') {
    if (!parsed.mentionsBot) return false;
    return access.chats.length === 0 || access.chats.includes(parsed.chatId);
  }
  return false;
}

/** 卡片标题里显示谁在说话，两人共用时便于区分。 */
export function senderLabel(parsed) {
  return parsed.chatType === 'p2p' ? '备婚助手' : '备婚助手 · 群';
}
