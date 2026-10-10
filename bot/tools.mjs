import { z } from 'zod';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { renderXlsx, renderWeb } from './render.mjs';
import { dropEmptyColumns, readCorpus, buildReport } from './fieldhealth.mjs';
import { CATEGORIES, paths } from './config.mjs';
import { logger } from './store.mjs';

/**
 * 进程内的工具，**取代 Bash**。
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
      '每轮对话结束时会自动交付，你不需要说明文件路径。' +
      '表里「有值不足三分之一」的列会被自动拿掉（返回值里会说明拿掉了哪几列）——' +
      '那是为了不让整列「未知」稀释重点，回复里要把它们点名说出来。',
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
      keep: z
        .array(z.string())
        .optional()
        .describe('要保留的列名（表头原文）。默认会丢掉有值不足三分之一的列；用户明确要过某一列时才填。'),
    },
    handler: async ({ title, category, rows, types, keep }) => {
      const wanted = types?.length ? types : ['xlsx', 'web'];
      // 丢了哪些列在渲染之前定，两个格式共用同一份 rows —— 否则 xlsx 和网页会不一样
      const { rows: kept, dropped, kept: exempted } = dropEmptyColumns(rows, { keep });
      const normalized = kept.map((r) => r.map((c) => (c === null || c === undefined ? '未知' : c)));

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
      const notes = [];
      if (dropped.length) {
        // 必须说回去：Agent 以为渲染的和用户看到的是同一张表，就会在回复里
        // 假装那几列还在。空列 ≠ 不重要，是「20 家里最多 5 家写了」。
        notes.push(`已自动略过 ${dropped.length} 个空列：${dropped.join('、')}（有值不足三分之一）。`
          + '回复里向用户点名这几项 —— 那是决策相关的空白，别让它静默消失。');
      }
      if (exempted.length) notes.push(`按你的要求保留了：${exempted.join('、')}。`);

      const head = failures.length
        ? `已生成 ${ok}，但以下失败：${failures.join('；')}`
        : `已生成 ${ok}（${normalized.length - 1} 行 × ${normalized[0]?.length ?? 0} 列）`;
      return { content: [{ type: 'text', text: [head, ...notes].join('\n') }] };
    },
  };
}

/**
 * 字段体检工具。
 *
 * 为什么要做成工具而不是写进 spec：判断依据必须来自**用户自己喂进来的数据**，
 * 而 spec 是每轮注入的静态文本。Agent 又没有 Bash（见上），所以只能是个进程内工具。
 *
 * 它**只报数、只提议**：空列由 render_output 拿走，扩充候选只写进返回值，
 * 改字段表这件事本轮仍然由人来做（字段表现在在 spec/ 下，Agent 无权写、
 * 写了也会被下次部署覆盖）。
 */
export function fieldHealthToolDefinition({ dataDir = paths.data } = {}) {
  return {
    name: 'field_health',
    description:
      '体检某个品类的数据：每个字段有多少家真给了值、哪几列空得该退出表、'
      + '正文里还有哪些反复出现却还没成字段的属性。汇总前先跑一次。',
    inputSchema: {
      category: z.string().describe(`品类名（${CATEGORIES.join('、')}），或「全部」`),
    },
    handler: async ({ category }) => {
      // 一次抛异常会让整轮对话失败，所以任何问题都退回一句人话
      try {
        const asked = String(category ?? '').trim();
        const all = asked === '全部' || asked === '';
        const wanted = all ? CATEGORIES : CATEGORIES.filter((c) => c === asked);
        if (!wanted.length) {
          return { content: [{ type: 'text', text: `没有「${asked}」这个品类。可选的：${CATEGORIES.join('、')}，或「全部」。` }] };
        }
        const docs = readCorpus(dataDir, wanted);
        return { content: [{ type: 'text', text: buildReport(docs, { categories: wanted }) }] };
      } catch (err) {
        logger.error('[field_health] 体检失败：', err.message);
        return { content: [{ type: 'text', text: `体检读数据时出错了（${err.message}）。先把这一轮做完，稍后再试。` }] };
      }
    },
  };
}

export function createRenderServer(opts = {}) {
  return createSdkMcpServer({
    name: 'wedding',
    version: '1.0.0',
    instructions: '生成备婚对比产物（Excel 与手机可看的网页），并按数据体检对比字段是否合适。',
    tools: [renderToolDefinition(opts), fieldHealthToolDefinition(opts)],
  });
}
