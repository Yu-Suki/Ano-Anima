import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'deepseek-flash';

const p = '.data/brain.json';
const b = JSON.parse(await readFile(p, 'utf8'));
const low = b.items.filter((m) => !m.archived && m.layer !== 'core' && (m.weight || 0) <= 1);
console.log('低分记忆 ' + low.length + ' 条，开始重估');

async function ask(batch, base) {
  const prompt = [
    '下面是她的记忆。逐条重新打一个分（0.5~10）：',
    '  10 = 身份级（她是谁、主人是谁、重要承诺）',
    '   7 = 关系/家人/长期习惯',
    '   4 = 一般事实',
    '   1 = 一次性的闲聊',
    ' 0.5 = 噪声（谁说了句什么、无信息量）',
    '只输出 JSON 数组：[{"i":1,"w":6}, ...]',
    batch.map((m, i) => `${i + 1}. ${m.text}`).join('\n'),
  ].join('\n');
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 3000 }),
  });
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 80));
  const j = await res.json();
  const txt = String(j.choices?.[0]?.message?.content || '');
  const m = txt.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : [];
}

const MIN = 10 / 60, MAX = 24 * 365;
let changed = 0;
for (let i = 0; i < low.length; i += 10) {
  const batch = low.slice(i, i + 10);
  let out = [];
  try { out = await ask(batch, i); } catch (e) { console.log('  批次失败: ' + e.message); continue; }
  for (const s of out) {
    const item = batch[Number(s.i) - 1];
    if (!item) continue;
    const w = Math.max(0.5, Math.min(10, Number(s.w) || item.weight));
    const target = b.items.find((x) => x.id === item.id);
    if (!target) continue;
    if (Math.abs(w - target.weight) > 0.01) { target.weight = w; changed++; }
    const st = MIN * Math.pow(MAX / MIN, (w - 1) / 9) * (1 + (Number(target.importance) || 3) / 5);
    target.stability = Math.round(st * 100) / 100;
  }
  await new Promise((r) => setTimeout(r, 300));
}
await writeFile(p, JSON.stringify(b, null, 2), 'utf8');
console.log('改了 ' + changed + ' 条');
const dist = {};
b.items.filter((m) => !m.archived).forEach((m) => { const k = m.weight <= 1 ? '0.5~1' : m.weight <= 3 ? '1.5~3' : m.weight <= 6 ? '3.5~6' : '7+'; dist[k] = (dist[k] || 0) + 1; });
console.log(JSON.stringify(dist));
