#!/usr/bin/env node
/**
 * 把服务器上的数据拉回本地。
 *
 *   npm run pull                    → 拉到 ~/wedding-export
 *   npm run pull -- --out ./backup  → 拉到指定目录
 *   npm run pull -- --host root@1.2.3.4
 *
 * 也作为函数被 scripts/watch.mjs 复用（watcher 靠它自动拉）。
 *
 * ── 只拉数据，不拉代码 ──────────────────────────────────────────────
 * 代码以本地 git 仓库为准（bot/、scripts/、deploy/ 都在版本控制里）。
 * 如果把服务器的代码也拉下来覆盖本地，会静默冲掉你在本地的修改，
 * 而且很难发现是这次 pull 干的。所以这里只碰 workspace/ web/ state/。
 *
 * ── .env 是刻意排除的 ──────────────────────────────────────────────
 * 服务器上那份的 PUBLIC_BASE_URL 指向公网地址，拉回来会盖掉本地的
 * 局域网地址，下次本地调试按钮就点不开了。而且密钥没必要多一份副本。
 *
 * 拉什么由 bot/export.mjs 的 EXPORT_ITEMS 唯一定义（跟「下载 zip」共用一份），
 * 这里不另写一份，免得两边分叉成「下载的和同步的内容不一样」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { config } from '../bot/config.mjs';
import { EXPORT_ITEMS, EXPORT_EXCLUDES, formatSummary, collectFiles, describe } from '../bot/export.mjs';

/** 单引号包裹，内部单引号用 '\'' 转义 —— 防止路径里的空格/中文出问题。 */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 递归列出目录下所有文件 → Map<相对路径, mtimeMs>。目录不存在返回空 Map。 */
function snapshot(dir) {
  const map = new Map();
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try { map.set(r, fs.statSync(abs).mtimeMs); } catch { /* 读不到就算了 */ }
      }
    }
  };
  walk(dir, '');
  return map;
}

/**
 * 拉一次。

 * ⚠️ 走 ssh + tar 管道，不用 rsync。目标机是 Alibaba Cloud Linux 最小安装，
 *    **没装 rsync**（也不该为一次导出往生产机上装包）。tar 到处都有。
 *
 * @param {{host: string, dest: string, remoteRoot?: string, quiet?: boolean}} opts
 * @returns {{ok: boolean, code: number, stderr: string, added: string[], changed: string[], files: number, bytes: number, seconds: number}}
 */
export function runPull({ host, dest, remoteRoot = config.export.remoteRoot, quiet = false }) {
  fs.mkdirSync(dest, { recursive: true });

  const before = snapshot(dest);

  const excludeFlags = EXPORT_EXCLUDES.map((e) => `--exclude=${q(e)}`).join(' ');
  const items = EXPORT_ITEMS.map(q).join(' ');
  const remoteCmd = `tar czf - -C ${q(remoteRoot)} ${excludeFlags} ${items}`;
  const pipeline = `ssh -o BatchMode=yes ${q(host)} ${q(remoteCmd)} | tar xzf - -C ${q(dest)}`;

  const t0 = Date.now();
  const res = spawnSync('/bin/bash', ['-c', pipeline], {
    stdio: [quiet ? 'ignore' : 'inherit', quiet ? 'pipe' : 'inherit', 'pipe'],
    encoding: 'utf8',
  });
  const seconds = (Date.now() - t0) / 1000;

  if (res.status !== 0) {
    return {
      ok: false, code: res.status ?? 1, stderr: (res.stderr || '').trim(),
      added: [], changed: [], files: 0, bytes: 0, seconds,
    };
  }

  const after = snapshot(dest);
  const added = [];
  const changed = [];
  for (const [file, mtime] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== mtime) changed.push(file);
  }

  let bytes = 0;
  for (const f of after.keys()) {
    try { bytes += fs.statSync(path.join(dest, f)).size; } catch { /* 刚刚没了 */ }
  }

  return { ok: true, code: 0, stderr: '', added, changed, files: after.size, bytes, seconds };
}

// ── 命令行入口 ──────────────────────────────────────────────────────
// 被 watch.mjs import 时不该执行这一段，所以判一下是不是直接跑的。

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--host' || a === '-H') args.host = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }

  if (args.help) {
    console.log(`用法：npm run pull [-- --out <目录>] [-- --host <user@ip>]

  --out, -o   本地落地目录（默认 ~/wedding-export，或 .env 里的 EXPORT_DIR）
  --host, -H  服务器地址（默认取 .env 里的 DEPLOY_HOST）
`);
    process.exit(0);
  }

  const host = args.host || config.export.host;
  if (!host) {
    console.error(`没有指定服务器地址。

请在 .env 里加一行：
  DEPLOY_HOST=root@<你的服务器IP>

或者用参数：npm run pull -- --host root@1.2.3.4`);
    process.exit(1);
  }

  const dest = path.resolve(args.out || config.export.dir);

  console.log(`拉取 ${host}:${config.export.remoteRoot}  →  ${dest}`);
  console.log(`  内容：${EXPORT_ITEMS.join(' / ')}（不含代码和 .env）\n`);

  const r = runPull({ host, dest });

  if (!r.ok) {
    console.error('\n拉取失败。');
    if (r.stderr) console.error(r.stderr.split('\n').slice(0, 8).join('\n'));
    console.error(`
常见原因：
  · 服务器地址不对，或本机没有免密登录 —— 先手动试 ssh ${host} 'echo ok'
  · 服务器上的负载太高、一时连不上（开机后的头几分钟常见）
  · 目标目录没有写权限：${dest}`);
    process.exit(r.code);
  }

  console.log(`\n✓ 完成（${r.seconds.toFixed(1)}s）`);
  console.log(`  本地 ${dest} 现有 ${r.files} 个文件，${fmtBytes(r.bytes)}`);
  console.log(`  本次新增 ${r.added.length} 个，更新 ${r.changed.length} 个`);
  console.log('  已删除的服务器文件不会从本地移除（合并式拉取，避免误删）');

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n  ${label}：`);
    for (const f of list.slice(0, 12)) console.log(`    ${label === '新增' ? '+' : '~'} ${f}`);
    if (list.length > 12) console.log(`    … 另有 ${list.length - 12} 个`);
  };
  show('新增', r.added);
  show('更新', r.changed);

  // 摘要直接按本地刚落地的文件算。describe() 只看相对路径，跟在哪台机器上无关，
  // 所以这里跟机器人卡片用的是同一个口径，两个数字不会对不上。
  console.log(`\n  摘要：${formatSummary(describe(collectFiles(dest)))}`);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
