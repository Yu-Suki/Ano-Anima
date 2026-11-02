// 清理人物表：去掉会话 id 污染，给主人定死称呼
import { readFile, writeFile } from 'node:fs/promises';
import 'dotenv/config';

const file = '.data/roster.json';
const d = JSON.parse(await readFile(file, 'utf8'));
const people = d.people || {};
const ownerQq = String(process.env.OWNER_QQ || '');

let removed = 0;
for (const key of Object.keys(people)) {
  if (/^[gp]:/.test(key)) {
    delete people[key];
    removed++;
  }
}

for (const [id, p] of Object.entries(people)) {
  if (id === ownerQq || p.isOwner) {
    p.isOwner = true;
    if (!p.title) p.title = '主人';
  }
  if (!p.title) p.title = '';
}

await writeFile(file, JSON.stringify({ people }, null, 2), 'utf8');

console.log(`删掉 ${removed} 个会话 id 条目`);
console.log('剩下的人：');
for (const [, p] of Object.entries(people)) {
  console.log(`  ${p.isOwner ? '★' : ' '} ${String(p.id).padEnd(12)} 称呼=${p.title || '(自动)'}  昵称=${p.name || '-'}`);
}