// 清理被提示词污染的记忆：把"最近的聊天记录：…"整段当记忆存下来的那些
import { readFile, writeFile } from 'node:fs/promises';
import 'dotenv/config';

const file = '.data/brain.json';
const d = JSON.parse(await readFile(file, 'utf8'));
const items = d.items || [];

const isNoise = (m) => {
  const t = String(m.text || '');
  // 提示词自己拼出来的句子
  if (t.startsWith('最近的聊天记录')) return true;
  if (t.includes('没人叫你，你看着群聊想插一句')) return true;
  if (t.includes('对方只 @ 了你一下')) return true;
  // 群号当成了人
  if (/^[gp]:/.test(String(m.subject || ''))) return true;
  return false;
};

const bad = items.filter(isNoise);
const keep = items.filter((m) => !isNoise(m));

console.log(`总 ${items.length} 条，删掉污染 ${bad.length} 条，剩 ${keep.length} 条`);
console.log('\n删掉的举例：');
bad.slice(0, 3).forEach((m) => console.log('  ' + String(m.text).slice(0, 50).replace(/\n/g, ' ')));

if (process.argv.includes('--apply')) {
  await writeFile(file, JSON.stringify({ ...d, items: keep }, null, 2), 'utf8');
  console.log('\n已写入');
} else {
  console.log('\n预览模式，加 --apply 真删');
}