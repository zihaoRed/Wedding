import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 最小 ZIP 写盘器。
 *
 * 为什么不用现成的：
 *   · 服务器是 Alibaba Cloud Linux 最小安装，**没有 zip 命令**（连 rsync 都没有）。
 *   · tar.gz 在 iPhone 和 Windows 上都不能双击解开，而「下载」这条路存在的意义
 *     恰恰就是「人不在 Mac 前面」——那时候手上多半是手机。
 *   · Node 标准库只有 zlib，没有 zip。
 * 所以自己写。ZIP 格式公开且稳定，产物可以直接用系统的 unzip -t / unzip -l 验证。
 *
 * 只实现必需的部分：
 *   · store / deflate 两种方式，deflate 之后反而变大的就退回 store
 *     （截图是 JPEG，本来就已经压过了，再 deflate 纯属浪费 CPU）
 *   · UTF-8 文件名标志位 —— 中文文件名必须开，否则解压出来是乱码
 *   · **不做 ZIP64**：超过 4GB 或 65535 个文件直接抛错，而不是产出一个坏包。
 *     坏包是最糟的结果——它看着像个正常文件，等到要恢复数据那天才发现打不开。
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

// CRC-32（IEEE 802.3，ZIP 用的那个）。表是标准的多项式 0xEDB88320。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * ZIP 用的是 MS-DOS 的时间格式：年份从 1980 起算，秒只有 5 位（2 秒精度）。
 * 1980 之前的日期没法表示，钳到 1980 —— 这个项目里不可能出现，但钳一下
 * 比让位运算把年份算成负数（写进去就是垃圾）强。
 */
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & MAX_U16,
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & MAX_U16,
  };
}

/**
 * @param {string} outPath            产出的 .zip 路径
 * @param {{name: string, data: Buffer|string, mtime?: Date}[]} entries
 *        name 用正斜杠分隔的相对路径（ZIP 规范如此，Windows 也认）
 * @returns {{file: string, entries: number, bytes: number}}
 */
export function writeZip(outPath, entries) {
  if (entries.length > MAX_U16) {
    throw new Error(`文件数 ${entries.length} 超过 ZIP 的 65535 上限（本写器不支持 ZIP64）`);
  }

  const local = [];    // 本地头 + 数据
  const central = [];  // 中央目录
  let offset = 0;      // 下一个本地头在文件里的偏移，同时最终就是中央目录的偏移

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { date, time } = dosStamp(e.mtime instanceof Date ? e.mtime : new Date());

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LOCAL, 0);
    lfh.writeUInt16LE(20, 4);          // 解开它需要的版本（2.0 = 支持 deflate）
    lfh.writeUInt16LE(FLAG_UTF8, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);   // 压缩后
    lfh.writeUInt32LE(raw.length, 22);    // 原始
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);             // 扩展字段长度
    local.push(lfh, nameBuf, body);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(SIG_CENTRAL, 0);
    cdfh.writeUInt16LE(20, 4);            // 由什么版本创建
    cdfh.writeUInt16LE(20, 6);            // 需要什么版本
    cdfh.writeUInt16LE(FLAG_UTF8, 8);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt16LE(time, 12);
    cdfh.writeUInt16LE(date, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(body.length, 20);
    cdfh.writeUInt32LE(raw.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);            // 扩展字段
    cdfh.writeUInt16LE(0, 32);            // 注释
    cdfh.writeUInt16LE(0, 34);            // 起始磁盘号
    cdfh.writeUInt16LE(0, 36);            // 内部属性
    cdfh.writeUInt32LE(0, 38);            // 外部属性（不解 Unix 权限位，够用）
    cdfh.writeUInt32LE(offset, 42);       // 对应本地头的偏移
    central.push(cdfh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
    if (offset > MAX_U32) {
      throw new Error('归档超过 4GB，本写器不支持 ZIP64');
    }
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                  // 本磁盘号
  eocd.writeUInt16LE(0, 6);                  // 中央目录所在磁盘号
  eocd.writeUInt16LE(entries.length, 8);     // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10);    // 总条目数
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);            // 中央目录偏移
  eocd.writeUInt16LE(0, 20);                 // 注释长度

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...local, cd, eocd]));

  return { file: outPath, entries: entries.length, bytes: offset + cd.length + eocd.length };
}
