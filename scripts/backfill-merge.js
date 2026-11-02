// 一次性回填：按【天 × 会话】把现有表层记忆整合一遍，再做第二层
// 只跑这一次，不改任何逻辑
import 'dotenv/config';
import { Brain } from '../src/core/memory2.js';
import { Consolidator } from '../src/core/consolidate.js';
import { Store } from '../src/data/store.js';

const store = new Store('.data');
const memory = await new Brain({ store, file: 'brain.json' }).load();
const llm = {
  baseUrl: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
};
const log = (k, m) => console.log('  [' + k + '] ' + m);
const c = new Consolidator({ memory, llm, log });

const dayOf = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const surface = memory.all().filter((m) => m.layer === 'surface');
console.log('表层记忆 ' + surface.length + ' 条');

// 按 (天, 会话) 分组
const groups = new Map();
for (const m of surface) {
  const day = dayOf(m.createdAt || Date.now());
  const who = String(m.subject || m.whoName || '未知');
  const key = day + '|' + who;
  if (!groups.has(key)) groups.set(key, { day, who, items: [] });
  groups.get(key).items.push(m);
}

console.log('分成 ' + groups.size + ' 组（天 × 会话）');
let made1 = 0;
for (const [key, g] of groups) {
  if (g.items.length < 2) continue;
  const made = await c.summarizeSession({
    convId: g.who,
    since: g.day,
    until: g.day + 86400000,
    maxDepth: 1,
    subject: g.who,
  });
  made1 += made.length;
  console.log('  ' + new Date(g.day).toLocaleDateString('zh-CN') + ' / ' + g.who + '：' + g.items.length + ' 条 → ' + made.length + ' 整合');
}

console.log('第一层共 ' + made1 + ' 条');
await memory.save();

// 第二层：按天，把当天的一级整合 + 不属于它们的表层再压一次
const days = [...new Set(surface.map((m) => dayOf(m.createdAt || Date.now())))].sort();
let made2 = 0;
for (const day of days) {
  const made = await c.summarizeSession({
    convId: 'night',
    since: day,
    until: day + 86400000,
    maxDepth: 2,
  });
  made2 += made.length;
  if (made.length) console.log('  ' + new Date(day).toLocaleDateString('zh-CN') + ' 二层：' + made.length + ' 条');
}
console.log('第二层共 ' + made2 + ' 条');
await memory.save();

const stat = memory.stats();
console.log('现在：' + JSON.stringify(stat.byLayer));
process.exit(0);