// 老记忆整理：只归档、不删除
import { readFile, writeFile } from 'node:fs/promises';

const file = '.data/brain.json';
const d = JSON.parse(await readFile(file, 'utf8'));
const items = d.items || [];

const isJunk = (m) => {
  const t = String(m.text || '').trim();
  if (m.kind === 'ask') return true; // "他在问我" —— 不是事实
  if (/自称是谁$/.test(t)) return true; // 残句
  if (t.length < 4) return true; // 真的没内容
  return false;
};

// 先全部还原，再按新规则重新判定（只归档、不删除）
let restored = 0;
for (const m of items) {
  if (m.archived) {
    m.archived = false;
    restored++;
  }
}

let archived = 0;
for (const m of items) {
  if (isJunk(m)) {
    m.archived = true;
    archived++;
  }
}
console.log(`先还原 ${restored} 条，再重新判定`);

// 老数据补上默认字段，方便新面板显示
for (const m of items) {
  if (m.weight === undefined) m.weight = m.importance >= 4 ? 8 : 5;
  if (!m.places) m.places = m.where ? [m.where] : [];
  if (!m.people) m.people = m.whoName ? [m.whoName] : [];
  if (m.layer === 'social' || m.layer === 'procedural') m.layer = 'semantic';
}

const alive = items.filter((m) => !m.archived);
console.log(`总 ${items.length} 条`);
console.log(`归档 ${archived} 条（没删，面板里看不到，需要时能还原）`);
console.log(`留下 ${alive.length} 条`);
console.log('\n归档举例：');
items.filter((m) => m.archived).slice(0, 8).forEach((m) => console.log('  - ' + m.text));
console.log('\n保留举例：');
alive.slice(0, 6).forEach((m) => console.log(`  - ${m.text}`));

if (process.argv.includes('--apply')) {
  await writeFile(file, JSON.stringify({ ...d, items }, null, 2), 'utf8');
  console.log('\n已写入');
} else {
  console.log('\n预览，加 --apply 才写');
}