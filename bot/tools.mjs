import { z } from 'zod';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { renderXlsx, renderWeb } from './render.mjs';
import { logger } from './store.mjs';

/**
 * 进程内的渲染工具，**取代 Bash**。
 *
 * 不开放 Bash 的原因：预批准的 Bash 加上子进程环境里的 ANTHROPIC_API_KEY /
 * 飞书密钥，等于给「转发截图里夹带一段指令」这种注入留了一条出网通道；
 * 而 PreToolUse 黑名单天生有漏（rm -r -f、$(...)、base64、node -e 都绕得过）。
 * 用一个参数明确的进程内工具，能力边界清楚得多。
 */
export function renderToolDefinition({ onArtifact } = {}) {
  return {
    name: 'render_output',
        description:
          '把对比结果渲染成产物交给用户。xlsx 供用户自己排序筛选，web 是手机可点开的网页。' +
          '每轮对话结束时会自动交付，你不需要说明文件路径。',
        inputSchema: {
          title: z.string().describe('产物标题，如「婚纱照方案对比」「婚礼总预算」'),
          category: z.string().describe('品类名，或「全部」表示总预算表'),
          rows: z
            .array(z.array(z.union([z.string(), z.number(), z.null()])))
            .describe('二维数组，第一行是表头。数值写成数字，未知项写「未知」而不是留空。'),
          types: z
            .array(z.enum(['xlsx', 'web']))
            .optional()
            .describe('产出格式，默认两者都要'),
        },
        handler: async ({ title, category, rows, types }) => {
          const wanted = types?.length ? types : ['xlsx', 'web'];
          const normalized = rows.map((r) => r.map((c) => (c === null || c === undefined ? '未知' : c)));

          const produced = [];
          const failures = [];

          for (const t of wanted) {
            try {
              if (t === 'xlsx') {
                produced.push({ kind: 'xlsx', file: await renderXlsx(normalized, { title }) });
              } else if (t === 'web') {
                produced.push({ kind: 'web', file: renderWeb(normalized, { title, subtitle: category }) });
              }
            } catch (err) {
              logger.error(`[render] ${t} 生成失败：`, err.message);
              failures.push(`${t}: ${err.message}`);
            }
          }

          if (produced.length) onArtifact?.(produced);

          const ok = produced.map((p) => p.kind).join('、');
          const text = failures.length
            ? `已生成 ${ok}，但以下失败：${failures.join('；')}`
            : `已生成 ${ok}（${normalized.length - 1} 行数据）`;

      return { content: [{ type: 'text', text }] };
    },
  };
}

export function createRenderServer(opts = {}) {
  return createSdkMcpServer({
    name: 'wedding',
    version: '1.0.0',
    instructions: '生成备婚对比产物（Excel 与手机可看的网页）。',
    tools: [renderToolDefinition(opts)],
  });
}
