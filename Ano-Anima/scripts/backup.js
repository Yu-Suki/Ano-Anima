// 每次改动前跑一次：把要动的文件存一份
// 用法：node scripts/backup.js [说明]
import { cp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, join('..', 'Ano-产物', '备份'));

const TARGETS = [
  'src',
  'prompts',
  'launcher.js',
  'persona.md',
  '.env.example',
  '.data/brain.json',
  '.data/mood.json',
  '.data/roster.json',
  '.data/sticker-meta.json',
];

const KEEP = 30; // 最多留 30 份

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const note = process.argv.slice(2).join(' ') || '';
const name = `${stamp()}${note ? '-' + note.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) : ''}`;
const dst = join(DIR, name);

await mkdir(dst, { recursive: true });

const saved = [];
for (const t of TARGETS) {
  try {
    await cp(join(ROOT, t), join(dst, t), { recursive: true });
    saved.push(t);
  } catch {
    // 没有就跳过
  }
}

await writeFile(
  join(dst, '_info.txt'),
  `时间：${new Date().toLocaleString('zh-CN')}\n说明：${note || '(没写)'}\n包含：${saved.join(', ')}\n`,
  'utf8',
);

// 只留最近 KEEP 份
try {
  const all = (await readdir(DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  while (all.length > KEEP) {
    const old = all.shift();
    await rm(join(DIR, old), { recursive: true, force: true });
  }
} catch {}

console.log(`备份好了：Ano-产物/备份/${name}`);
console.log(`包含：${saved.join(', ')}`);