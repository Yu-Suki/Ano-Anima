// 记忆星图实验：把记忆算成向量，看看它们自然聚成什么形状
// 只做观察，不接入对话
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.data', 'vectors.json');

const key = process.env.EMBED_API_KEY || process.env.VISION_API_KEY || '';
const base = (process.env.EMBED_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
const model = process.env.EMBED_MODEL || 'text-embedding-v3';

if (!key) {
  console.log('没有 embedding key（EMBED_API_KEY 或 VISION_API_KEY）');
  process.exit(1);
}

async function embed(texts) {
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.data.map((d) => d.embedding);
}

function cos(a, b) {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const brain = JSON.parse(await readFile(join(ROOT, '.data', 'brain.json'), 'utf8'));
const items = (brain.items || [])
  .filter((m) => !m.archived && m.text)
  .sort((a, b) => (b.weight || 0) - (a.weight || 0))
  .slice(0, 120);

console.log(`取 ${items.length} 条记忆来算向量（模型 ${model}）`);

const vectors = [];
for (let i = 0; i < items.length; i += 10) {
  const batch = items.slice(i, i + 10);
  const vs = await embed(batch.map((m) => m.text));
  vs.forEach((v) => vectors.push(v));
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 200));
}
console.log(' 完成\n');

// 1) 找每条记忆最近的 3 条，看是不是同一类事
console.log('=== 每条最近的三条（看像不像同一类事）===');
for (let i = 0; i < Math.min(8, items.length); i++) {
  const sims = vectors
    .map((v, k) => ({ k, s: cos(vectors[i], v) }))
    .filter((x) => x.k !== i)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  console.log(`\n【${items[i].text.slice(0, 26)}】`);
  for (const s of sims) {
    console.log(`   ${s.s.toFixed(3)}  ${items[s.k].text.slice(0, 26)}`);
  }
}

// 2) 自召回测试：拿原句去搜，能不能搜回自己
console.log('\n=== 自召回测试 ===');
let hit = 0;
const probe = [];
for (let t = 0; t < 10; t++) {
  const idx = Math.floor(Math.random() * items.length);
  const probeV = (await embed([items[idx].text]))[0];
  const best = vectors
    .map((v, k) => ({ k, s: cos(probeV, v) }))
    .sort((a, b) => b.s - a.s)[0];
  const ok = best.k === idx;
  if (ok) hit++;
  probe.push({ idx, ok, top: best.k, score: best.s });
}
console.log(`  10 次里命中自己 ${hit} 次`);

// 3) 按相似度聚类（贪心，0.78 以上算同一团）
const used = new Set();
const clusters = [];
for (let i = 0; i < vectors.length; i++) {
  if (used.has(i)) continue;
  const group = [i];
  used.add(i);
  for (let j = i + 1; j < vectors.length; j++) {
    if (used.has(j)) continue;
    if (cos(vectors[i], vectors[j]) >= 0.78) {
      group.push(j);
      used.add(j);
    }
  }
  if (group.length >= 2) clusters.push(group);
}
clusters.sort((a, b) => b.length - a.length);

console.log(`\n=== 自然聚成 ${clusters.length} 团（>=2 条）===`);
for (const g of clusters.slice(0, 6)) {
  console.log(`\n【${g.length} 条】`);
  for (const k of g.slice(0, 4)) console.log(`   · ${items[k].text.slice(0, 30)}`);
}

await writeFile(
  OUT,
  JSON.stringify({ model, at: Date.now(), items: items.map((m, i) => ({ id: m.id, text: m.text, v: vectors[i] })) }),
  'utf8',
);
console.log(`\n向量已存到 .data/vectors.json（${items.length} 条 × ${vectors[0].length} 维）`);