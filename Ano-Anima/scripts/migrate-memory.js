// 把旧记忆里的"他…"改写成带称呼的版本
// 用法：node scripts/migrate-memory.js [--apply]
// 不加 --apply 只预览
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import 'dotenv/config';
import { Roster } from '../src/data/roster.js';
import { House } from '../src/home/house.js';

const apply = process.argv.includes('--apply');
const dir = join(process.cwd(), '.data');

const house = await new House(dir, { auto: false }).init();
const roster = await new Roster({ dir, ownerQq: process.env.OWNER_QQ || '' }).load();

// 先给所有出现过的 subject 建名字
const brain = await house.read('brain.json', { items: [] });
const items = brain.items || [];
const subjects = [...new Set(items.map((m) => String(m.subject || '')).filter(Boolean))];

for (const id of subjects) {
  if (!roster.people[id]) {
    roster.touch(id, { name: '', isOwner: String(id) === String(process.env.OWNER_QQ || '') });
  }
}
if (roster.dirty) await roster.save();

console.log('='.repeat(56));
console.log(`记忆迁移${apply ? '（真改）' : '（预览）'}`);
console.log('='.repeat(56));
console.log(`共 ${items.length} 条，涉及 ${subjects.length} 个人\n`);

const JOKE = /自称|我是你|叫我|喊我|我是妈妈|我是爸爸/;
let changed = 0;
const preview = [];

for (const m of items) {
  if (!m.subject) continue;
  if (m.layer === 'working') continue; // 原始片段不动

  const name = roster.nameOf(m.subject);
  let text = m.text;
  let kind = m.kind || 'fact';

  const hadHe = /^他|^她/.test(text);
  if (hadHe) text = text.replace(/^他|^她/, name);
  // "他自称X" / "他自称你的爸爸" 这类是玩笑，不是事实
  if (JOKE.test(text)) {
    kind = 'joke';
  }

  const next = {
    ...m,
    text,
    kind,
    whoName: name,
    where: m.where || '',
  };

  if (text !== m.text || kind !== m.kind || !m.whoName) {
    changed++;
    if (preview.length < 12) {
      preview.push(`  ${String(m.text).padEnd(24)} → ${text}${kind === 'joke' ? '  [玩笑]' : ''}`);
    }
    m.text = text;
    m.kind = kind;
    m.whoName = name;
  }
}

console.log('示例：');
preview.forEach((l) => console.log(l));
console.log(`\n需要改写 ${changed} 条`);

if (apply) {
  await house.snapshot('记忆迁移前').catch(() => {});
  await house.write('brain.json', { ...brain, items });
  console.log('已写入（迁移前的状态存了快照：记忆迁移前）');
} else {
  console.log('预览模式，没有改动。加 --apply 真改。');
}