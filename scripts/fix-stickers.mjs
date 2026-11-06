import 'dotenv/config';
// 重新按"图片本身"写一遍表情描述，修掉张冠李戴的那几条
import { readFile, writeFile } from 'node:fs/promises';
import { describeImage } from '../src/senses/index.js';

const env = await readFile('.env', 'utf8');
const tok = (env.match(/^ONEBOT_HTTP_TOKEN=(.*)$/m) || [])[1]?.trim() || '';
const r = await fetch('http://127.0.0.1:3000/fetch_custom_face', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: '{}',
});
const list = (await r.json()).data || [];
const md5Of = (u) => (String(u).match(/_([0-9A-Fa-f]{32})_/) || [])[1]?.toUpperCase() || '';
const metaPath = '.data/sticker-meta.json';
const meta = JSON.parse(await readFile(metaPath, 'utf8'));

for (let i = 0; i < list.length; i++) {
  const k = md5Of(list[i]);
  if (!k) continue;
  try {
    const buf = Buffer.from(await (await fetch(list[i])).arrayBuffer());
    const desc = await describeImage(buf.toString('base64'), '', 'sticker');
    const old = meta[k]?.desc || '';
    if (desc && desc !== old) {
      console.log('  ' + (i + 1) + '. ' + k.slice(0, 8) + ' 改：' + old.slice(0, 24) + ' → ' + String(desc).slice(0, 40));
      meta[k] = { ...(meta[k] || {}), desc: String(desc).slice(0, 120), at: Date.now() };
    } else {
      console.log('  ' + (i + 1) + '. ' + k.slice(0, 8) + ' 对得上：' + String(old).slice(0, 30));
    }
  } catch (e) {
    console.log('  ' + (i + 1) + '. ' + k.slice(0, 8) + ' 失败：' + e.message.slice(0, 40));
  }
  await new Promise((res) => setTimeout(res, 300));
}
await writeFile(metaPath, JSON.stringify(meta, null, 1), 'utf8');
console.log('  已写回 sticker-meta.json');
