// 把收藏夹里每张表情都算一遍指纹，补进 sticker-meta.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { imageHash } from '../src/senses/phash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = join(ROOT, '.data', 'sticker-meta.json');

const tok = process.env.ONEBOT_HTTP_TOKEN || '';
const http = await import('node:http');

function post(path, body = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port: 3000, path, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b).data || []); } catch { resolve([]); } });
      },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write(payload);
    req.end();
  });
}

const list = await post('/fetch_custom_face_detail');
const items = Array.isArray(list) ? list : [];
console.log(`收藏夹里有 ${items.length} 张`);

let meta = {};
try { meta = JSON.parse(await readFile(META, 'utf8')); } catch {}

let added = 0;
let skipped = 0;
let failed = 0;

for (const it of items) {
  const key = String(it.md5 || '').toUpperCase();
  if (!key) { failed++; continue; }
  if (meta[key]?.ph) { skipped++; continue; }
  try {
    const res = await fetch(it.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const ph = await imageHash(buf);
    if (!ph) { failed++; continue; }
    meta[key] = { ...(meta[key] || {}), desc: meta[key]?.desc || it.desc || '', ph, at: meta[key]?.at || Date.now() };
    added++;
    process.stdout.write('.');
  } catch {
    failed++;
  }
}

await mkdir(join(ROOT, '.data'), { recursive: true });
await writeFile(META, JSON.stringify(meta, null, 1), 'utf8');

console.log(`\n补录 ${added} 张，已有 ${skipped} 张，失败 ${failed} 张`);
console.log(`现在 meta 里共 ${Object.keys(meta).length} 条`);