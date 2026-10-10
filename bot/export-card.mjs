import { buildCard } from './feishu.mjs';
import {
  collectFiles, describe, formatSummary,
  readResult, requestInFlight, macOnline, macAliveAge, humanAge,
} from './export.mjs';

/**
 * 导出卡片的渲染。单独一个模块，是为了能在本地直接渲染出来检查 JSON ——
 * 塞在 index.mjs 里的话，想验证就只能真启动机器人，而启动它 = 多一个长连接
 * 进程，飞书的集群投递会把消息随机劈给两个进程，反而把线上搞乱。
 *
 * 这是纯渲染：只读状态，不写、不发。动作全在 index.mjs 里。
 */

/**
 * @param {string} [note] 额外附一句状态说明（「正在打包…」「上传失败：…」）
 * @returns {object} schema 2.0 卡片
 */
export function renderExportCard(note) {
  const summary = describe(collectFiles());
  const online = macOnline();
  const age = humanAge(macAliveAge());
  const pending = Boolean(requestInFlight());
  const result = readResult();

  const lines = [`**内容**：${formatSummary(summary)}`];
  lines.push(online ? `**Mac**：在线（${age}报活）` : `**Mac**：不在线（最后报活：${age}）`);

  if (result?.at) {
    const what = result.ok ? `${result.files} 个文件` : '失败了';
    lines.push(`**上次同步**：${humanAge(Date.now() - result.at)}（${what}）`);
  }

  const buttons = [];
  if (pending) {
    lines.push('', '已通知你的 Mac，正在等它来拉。');
  } else if (online) {
    buttons.push({ label: '同步到 Mac', type: 'primary', value: { act: 'export_mac' } });
  } else {
    // 刻意不做「按钮变灰」：disabled 字段在 schema 2.0 上我没验证过，而往卡片里
    // 塞一个非法字段会让**整张卡片**发送失败 —— 那比少一个按钮糟得多。
    // 直接去掉按钮、改成一句说明，效果一样，而且是确定的。
    lines.push('', '想用「同步到 Mac」，先在本机跑 `npm run watch`。');
  }
  buttons.push({ label: '下载 zip', type: 'default', value: { act: 'export_zip' } });

  if (note) lines.push('', note);

  return buildCard({ title: '导出数据', markdown: lines.join('\n'), buttons });
}
