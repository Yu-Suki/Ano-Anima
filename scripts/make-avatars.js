// 生成几张头像丢进 assets/avatars，供她"按自己喜好挑"
// 纯 Node 手写 PNG，不装任何依赖
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'avatars');
mkdirSync(OUT, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[p++] = rgb[i];
      raw[p++] = rgb[i + 1];
      raw[p++] = rgb[i + 2];
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画几张 ----------
const SIZE = 256;

function draw(fn) {
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = fn(x / SIZE, y / SIZE, Math.hypot(x - SIZE / 2, y - SIZE / 2) / (SIZE / 2));
      const i = (y * SIZE + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return encodePNG(SIZE, SIZE, rgb);
}

const mix = (a, b, t) => Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));

const list = [
  // 深海蓝渐变 + 圆
  ['deepblue.png', (x, y, d) => {
    const t = y;
    const base = [mix(18, 40, t), mix(42, 110, t), mix(88, 190, t)];
    return d < 0.45 ? [mix(base[0], 230, 0.3), mix(base[1], 240, 0.3), mix(base[2], 250, 0.3)] : base;
  }],
  // 暖橙
  ['ember.png', (x, y, d) => {
    const t = 1 - y;
    const base = [mix(120, 240, t), mix(60, 150, t), mix(30, 60, t)];
    return d < 0.5 ? [Math.min(255, base[0] + 15), Math.min(255, base[1] + 10), base[2]] : base;
  }],
  // 灰绿极简
  ['moss.png', (x, y, d) => {
    const v = 60 + Math.round(30 * (1 - y)) + (d < 0.42 ? 40 : 0);
    return [v, v + 18, v + 6];
  }],
  // 紫粉
  ['dusk.png', (x, y, d) => {
    const t = y;
    const base = [mix(70, 160, t), mix(40, 90, t), mix(120, 200, t)];
    return d < 0.48 ? [Math.min(255, base[0] + 25), Math.min(255, base[1] + 15), Math.min(255, base[2] + 20)] : base;
  }],
  // 黑白棋盘感
  ['mono.png', (x, y, d) => {
    const checker = (Math.floor(x * 8) + Math.floor(y * 8)) % 2 === 0;
    const v = checker ? 225 : 35;
    return [v, v, v];
  }],
];

for (const [name, fn] of list) {
  writeFileSync(join(OUT, name), draw(fn));
  console.log(`生成 ${name}`);
}

console.log(`\n共 ${list.length} 张，位置：${OUT}`);
console.log('往这个目录里丢自己的图片也行，她挑的就是这里面的。');