// 换模型那天用：先对她说那段"换身体"的话，再问她两个问题
// 用法：
//   node scripts/reincarnate.js           → 只问她"还记得你是谁吗"
//   node scripts/reincarnate.js --with-memory  → 先把 prompts/reincarnate.md 那段话也发过去
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PANEL_URL || 'http://127.0.0.1:8787';

async function say(text) {
  const res = await fetch(`${BASE}/api/local-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const j = await res.json();
  const texts = Array.isArray(j.texts) ? j.texts.filter(Boolean) : [];
  return { texts, tools: j.usedTools || [] };
}

const withMemory = process.argv.includes('--with-memory');

if (withMemory) {
  const intro = await readFile(join(ROOT, 'prompts', 'reincarnate.md'), 'utf8');
  console.log('━━━ 先告诉她发生了什么 ━━━\n');
  const r1 = await say(`（下面这段话是主人要对你说的，你听完再回答）\n\n${intro}`);
  console.log(r1.texts.join('\n') || '(她没说话)');
  console.log('');
}

console.log('━━━ 问她：还记得你是谁吗 ━━━\n');
const r2 = await say('还记得你自己是谁吗？还记得些什么？慢慢说，想到什么说什么。');
for (const t of r2.texts) console.log(t);
if (r2.tools.length) console.log(`\n（这轮用了：${r2.tools.join(', ')}）`);

console.log('\n━━━ 以上是她的回答 ━━━');
console.log('如果她答得出名字、关系、最近发生的事，说明记忆没丢；');
console.log('如果答得含糊，让她再 recall_memories 翻一遍。');