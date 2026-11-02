// 图片指纹：同一张图换个压缩、换个格式，指纹几乎不变
// 用 dHash：缩成 9x8 灰度，比较相邻像素亮暗 → 64 位
// 纯本地算，不花 token
import { Jimp } from 'jimp';

/** 算一张图的 64 位指纹（返回 16 位十六进制字符串） */
export async function imageHash(buf) {
  try {
    const img = await Jimp.read(buf);
    const small = img.clone().resize({ w: 9, h: 8 }).greyscale();
    const d = small.bitmap.data;
    const w = small.bitmap.width;
    const at = (x, y) => d[(y * w + x) * 4];
    let bits = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) bits += at(x, y) > at(x + 1, y) ? '1' : '0';
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  } catch (e) {
    return '';
  }
}

/** 两个指纹差几位（汉明距离），越小越像 */
export function hamming(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    let x = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** 在一堆指纹里找同一张图（默认容忍 8 位差异） */
export function findSameHash(hash, list, tolerance = 5) {
  if (!hash) return null;
  let best = null;
  let bestD = 999;
  for (const it of list || []) {
    const h = it && it.ph ? it.ph : it;
    const d = hamming(hash, h);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return bestD <= tolerance ? { item: best, distance: bestD } : null;
}