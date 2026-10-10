import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { paths } from './config.mjs';
import { computeEmphasis, EMPH_COLORS, toArgb } from './emphasis.mjs';

/**
 * 渲染对比产物。
 *
 * 之所以要两种格式：
 *  - xlsx：用户要自己排序、筛选、加行
 *  - web：手机飞书里点开就能看。**不能把 .html 当文件消息发**——手机端
 *    下载了也打不开，所以走 nginx 静态托管 + 卡片链接按钮。
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** CJK 字符大约占两个字符宽，用来估算 Excel 列宽。 */
const displayWidth = (s) => [...String(s ?? '')]
  .reduce((n, ch) => n + (/[⺀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1), 0);

const safeName = (s) => String(s).replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);

export async function renderXlsx(rows, { title, outDir = paths.output }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows 为空，没有可导出的内容');
  const [header, ...body] = rows;
  const colCount = Math.max(...rows.map((r) => r.length));

  const wb = new ExcelJS.Workbook();
  wb.creator = '备婚助手';
  const ws = wb.addWorksheet(safeName(title || '对比').slice(0, 30));

  ws.addRow(header);
  ws.getRow(1).font = { bold: true, size: 11 };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2FA' } };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 22;

  // 每一格该不该上色，由 emphasis.mjs 算好；这里只查表。
  const emph = computeEmphasis(rows);

  for (const [b, row] of body.entries()) {
    const r = ws.addRow(row);
    r.alignment = { vertical: 'top', wrapText: true };
    for (let c = 0; c < row.length; c += 1) {
      const mark = emph[b + 1]?.[c];
      if (!mark) continue;
      const color = EMPH_COLORS[mark];
      const cell = ws.getCell(b + 2, c + 1);      // 第 1 行是表头，所以 +2
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(color.bg) } };
      cell.font = { color: { argb: toArgb(color.ink) }, bold: color.bold };
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (let c = 1; c <= colCount; c += 1) {
    let w = 8;
    for (const row of rows) w = Math.max(w, displayWidth(row[c - 1]) + 2);
    ws.getColumn(c).width = Math.min(w, 46);   // 太宽在手机上反而难用
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${safeName(title || '对比')}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

export function renderWeb(rows, { title, subtitle = '', outDir = paths.web }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows 为空，没有可展示的内容');
  const [header, ...body] = rows;
  if (body.length === 0) throw new Error('只有表头没有数据行');

  // 手机上竖屏只有 ~390px 宽，而字段有一二十个。横排 = 必须左右滑，
  // 而左右滑在手机上很难受；上下滑则是天经地义的。
  // 所以字段比对象多时转置：字段变行、对象变列，列数从「字段数」降到「对象数」。
  // 反过来（对象多、字段少，比如按商家列的预算总表）保持原样——那时本来就只有
  // 几列，转置反而会把列数炸开。
  const label = header[0];
  const fields = header.slice(1);
  const names = body.map((r) => r[0] ?? '');
  const flip = fields.length > names.length;

  // 每一格该不该上色，由 emphasis.mjs 算好；这里只查表 —— xlsx 和网页共用同一份判断。
  const emph = computeEmphasis(rows);
  const emphAttr = (r, c) => {
    const mark = emph[r]?.[c];
    return mark ? ` data-emph="${mark}"` : '';
  };

  // 纯数字右对齐并等宽，方便竖着扫一列比价
  const isNum = (v) => v !== undefined && v !== null && v !== ''
    && !/[^\d.,%\s]/.test(String(v));
  const td = (v) => (v === undefined || v === null || v === ''
    ? '<span class="na">—</span>'
    : esc(v));
  // 高亮用独立的 data-emph，**不能拼进 class** ——
  // `class="num best"` 会让既有的 `class="num"` 断言失效。
  const numAttr = (v) => (isNum(v) ? ' class="num"' : '');

  const head = flip
    ? `<tr><th class="corner">${esc(label)}</th>`
      + names.map((n) => `<th>${td(n)}</th>`).join('') + '</tr>'
    : `<tr>${header.map((h, i) => `<th${i === 0 ? ' class="corner"' : ''}>${esc(h)}</th>`).join('')}</tr>`;

  const trs = flip
    ? fields.map((f, i) => `<tr><th class="field">${esc(f)}</th>`
        + body.map((r, j) => `<td${numAttr(r[i + 1])}${emphAttr(j + 1, i + 1)}>${td(r[i + 1])}</td>`).join('') + '</tr>').join('\n')
    : body.map((r, b) => `<tr>`
        + header.map((_, i) => (i === 0
          ? `<th class="corner">${td(r[0])}</th>`
          : `<td${numAttr(r[i])}${emphAttr(b + 1, i)}>${td(r[i])}</td>`)).join('') + '</tr>').join('\n');

  const dense = names.length >= 4 ? ' dense' : '';
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

  // 高亮与图例色块的颜色全部来自 EMPH_COLORS，一处定义两处用。
  //
  // 选择器写成 .wrap td[data-emph=...]（0,2,1）压过斑马纹的
  // tbody tr:nth-child(even) td（0,1,3）—— 不去赌源码顺序。
  // 深色模式下必须同时给 background 和 color：--ink 在深色下是浅灰字，
  // 只换底色会变成浅绿底配浅灰字，看不清。
  const emphCss = ['best', 'worst'].map((kind) => {
    const c = EMPH_COLORS[kind];
    const weight = c.bold ? ';font-weight:700' : '';
    return `.wrap td[data-emph=${kind}]{background:${c.bg};color:${c.ink}${weight}}\n`
      + `  .legend .sw.${kind}{background:${c.bg};border-color:${c.ink}}\n`
      + `  @media (prefers-color-scheme:dark){\n`
      + `    .wrap td[data-emph=${kind}]{background:${c.darkBg};color:${c.darkInk}}\n`
      + `    .legend .sw.${kind}{background:${c.darkBg};border-color:${c.darkInk}}\n`
      + `  }`;
  }).join('\n  ');

  // 带颜色的格子不解释就是个谜。只在真有高亮时才出现。
  const legend = emph.some((row) => row.some(Boolean))
    ? '<p class="legend"><span class="sw best"></span>这一列最划算 / 最多'
      + '<span class="sep">·</span><span class="sw worst"></span>最贵 / 最少（3 家以上才标）</p>'
    : '';

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --ink:#1a1d21; --muted:#6b7280;
    --head:#eef2fa; --accent:#3b6ef5;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#14161a; --card:#1c1f24; --line:#2c3138; --ink:#e8eaed; --muted:#9aa2ad; --head:#232830; }
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:20px 16px 48px;
    background:var(--bg); color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    -webkit-text-size-adjust:100%;
  }
  header{max-width:1100px;margin:0 auto 16px}
  h1{font-size:20px;margin:0 0 6px;letter-spacing:.01em}
  .sub{color:var(--muted);font-size:13px;margin:0}
  .wrap{
    max-width:1100px;margin:0 auto;background:var(--card);
    border:1px solid var(--line);border-radius:12px;overflow:hidden;
  }
  .scroller{overflow-x:auto;-webkit-overflow-scrolling:touch}
  /* table-layout:fixed + width:100% —— 内容再长也只换行，不会把表撑宽。
     这是「手机上不用左右滑」的实现基础。 */
  table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:15px}
  th,td{
    padding:11px 12px;text-align:left;border-bottom:1px solid var(--line);
    vertical-align:top;overflow-wrap:anywhere;
  }
  /* 第一列钉在左边：转置后它是字段名，不转置时它是商家名。
     纵向滚动时始终看得见，才知道自己正在看哪一行、哪一家。 */
  .corner,.field{
    position:sticky;left:0;z-index:2;background:var(--card);
    box-shadow:1px 0 0 var(--line);
  }
  .corner{width:7.5em;font-weight:600}
  .field{width:7.5em;font-weight:600;color:var(--muted)}
  thead th{position:sticky;top:0;z-index:3;background:var(--head);font-weight:600;color:var(--ink)}
  thead .corner{z-index:4;background:var(--head)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  /* 斑马纹要连钉住的那一列一起染，否则那一格会突兀地保持纯卡片底色 */
  tbody tr:nth-child(even) td,
  tbody tr:nth-child(even) .corner,
  tbody tr:nth-child(even) .field{background:color-mix(in srgb,var(--bg) 55%,var(--card))}
  tbody tr:last-child>*{border-bottom:none}
  .na{color:var(--muted)}
  ${emphCss}
  .legend{
    max-width:1100px;margin:0 auto 10px;color:var(--muted);font-size:12px;
    display:flex;align-items:center;flex-wrap:wrap;gap:6px;
  }
  .legend .sw{
    width:12px;height:12px;border-radius:3px;display:inline-block;
    border:1px solid transparent;
  }
  .legend .sep{opacity:.45;margin:0 4px}
  /* 对比对象一多，每列就窄，缩紧内边距和字号换取可读性 */
  .dense th,.dense td{padding:9px 6px;font-size:13px}
  .dense .corner,.dense .field{width:5.5em}
  footer{max-width:1100px;margin:14px auto 0;color:var(--muted);font-size:12px}
  .hint{max-width:1100px;margin:0 auto 10px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
</header>
<p class="hint">${flip
    ? `${names.length} 个对比对象 × ${fields.length} 个字段`
    : `共 ${body.length} 条`}</p>
${legend}
<div class="wrap"><div class="scroller">
<table class="${flip ? 'flip' : ''}${dense}">
<thead>${head}</thead>
<tbody>
${trs}
</tbody>
</table>
</div></div>
<footer>生成于 ${esc(stamp)} · 备婚助手</footer>
</body>
</html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const slug = safeName(title || '对比').replace(/\s+/g, '-');
  const file = path.join(outDir, `${slug}-${Date.now().toString(36)}.html`);
  fs.writeFileSync(file, html);
  return file;
}
