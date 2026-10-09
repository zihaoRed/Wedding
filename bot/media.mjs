import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { paths, config } from './config.mjs';

/**
 * 图片落地。
 *
 * 这里是整个系统最容易静默出错的一环，原因有三个：
 *  1. Claude Code 的 Read 工具只认 PNG/JPEG/GIF/WebP，HEIC 会直接被拒。
 *  2. Read 会把长边压到约 2048px —— 手机整页长截图（如 1080x12000）会被压到
 *     字都看不清，然后模型会「编造」看错的数字。
 *  3. 同一张图被转发两次会产生两份记录。
 * 所以：按 magic bytes 判断真实格式（不信扩展名）→ 不合规就转码 →
 * 长图切分 → 按内容 hash 去重。
 */

const MAX_EDGE = 2048;   // 与 Read 的内部缩放阈值对齐
const TALL_RATIO = 3;    // 高/宽 超过这个比例就认为是长截图
const TILE_OVERLAP = 200;

/** 按 magic bytes 嗅探真实格式，不信任文件扩展名。 */
export function sniffFormat(buf) {
  if (buf.length < 12) return 'unknown';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // ISO-BMFF: [size:4]['ftyp':4][brand:4] —— HEIC/HEIF 走这里
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return 'heic';
    }
  }
  return 'unknown';
}

const READABLE = new Set(['png', 'jpeg', 'gif', 'webp']);

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(paths.mediaIndex, 'utf8')); } catch { return {}; }
}
function saveIndex(idx) {
  fs.mkdirSync(path.dirname(paths.mediaIndex), { recursive: true });
  const tmp = `${paths.mediaIndex}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, paths.mediaIndex);  // 临时文件 + rename，避免写一半崩了
}

/**
 * 把一张图片字节流落盘成 Agent 能读的若干文件。
 * @returns {Promise<{paths: string[], duplicate: boolean, note?: string}>}
 */
export async function ingestImage(buf, { label = 'img' } = {}) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const idx = loadIndex();
  if (idx[hash]) {
    return { paths: [], duplicate: true, note: `这张图之前已经收过（${idx[hash].join(', ')}），已跳过。` };
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(paths.raw, day);
  fs.mkdirSync(dir, { recursive: true });

  const sniffed = sniffFormat(buf);
  const written = [];

  // HEIC 等不合规格式先转 JPEG
  let working = buf;
  if (!READABLE.has(sniffed)) {
    try {
      working = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
    } catch (err) {
      // 转不了就原样存下并明确报告，而不是让 Agent 拿到一个读不了的文件猜
      const fallback = path.join(dir, `${label}-${hash.slice(0, 8)}.bin`);
      fs.writeFileSync(fallback, buf);
      return {
        paths: [],
        duplicate: false,
        note: `收到一张 ${sniffed} 格式的图片，本机无法转码（${err.message}）。` +
              `原图已存到 raw/${day}/，但这张图我读不了，请改用截图重发一次。`,
      };
    }
  }

  const meta = await sharp(working).metadata();
  const { width, height } = meta;
  const isTall = height / width > TALL_RATIO;

  if (isTall) {
    // 长截图切成有重叠的若干块，避免 Read 缩放后文字糊掉
    const step = MAX_EDGE - TILE_OVERLAP;
    let part = 0;
    for (let top = 0; top < height; top += step) {
      const h = Math.min(MAX_EDGE, height - top);
      const file = path.join(dir, `${label}-${hash.slice(0, 8)}-${String(part).padStart(2, '0')}.jpg`);
      await sharp(working)
        .extract({ left: 0, top, width, height: h })
        .jpeg({ quality: 92 })
        .toFile(file);
      written.push(file);
      part += 1;
      if (top + h >= height) break;
    }
  } else {
    const file = path.join(dir, `${label}-${hash.slice(0, 8)}.jpg`);
    const pipeline = sharp(working);
    if (width > MAX_EDGE) pipeline.resize({ width: MAX_EDGE });
    await pipeline.jpeg({ quality: 92 }).toFile(file);
    written.push(file);
  }

  const rel = written.map((p) => path.relative(paths.workspace, p));
  idx[hash] = rel;
  saveIndex(idx);

  return {
    paths: written,
    duplicate: false,
    note: isTall
      ? `这是一张长截图，已切成 ${written.length} 张有重叠的图，务必逐张核对，不要漏读或猜数字。`
      : undefined,
  };
}

/** 清理超过保留期的 raw/ 日期目录。 */
export function pruneRaw() {
  const cutoff = Date.now() - config.run.rawRetentionDays * 86_400_000;
  if (!fs.existsSync(paths.raw)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(paths.raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (new Date(name).getTime() < cutoff) {
      fs.rmSync(path.join(paths.raw, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
