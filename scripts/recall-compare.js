// 三种召回方式对比实验（不改任何东西，只出数字）
// A. 碎片关键词（现状）
// B. 锚点向量（自己算，纯本地）
// C. 阿里 text-embedding-v3（已存的 vectors.json）
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const brain = JSON.parse(await readFile(join(ROOT, '.data', 'brain.json'), 'utf8'));
const items = (brain.items || []).filter((m) => !m.archived && m.text).slice(0, 200);

// ---------- 探针：一句"人话"，看能不能找到该找的那条 ----------
const PROBES = [
  { q: '我出生的日子', want: '生日' },
  { q: '给我起的名字', want: '阿糯' },
  { q: '我妈喜欢什么', want: '妈妈' },
  { q: '那个猫的表情', want: '猫' },
  { q: '我答应过什么', want: '答应' },
  { q: '主人几点睡的', want: '睡' },
  { q: '上次吃的什么', want: '吃' },
  { q: '群里谁在说话', want: '群' },
];

// ---------- 方法 A：碎片关键词 ----------
function tokenize(s) {
  const out = new Set();
  const t = String(s).toLowerCase();
  for (const seg of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  return out;
}
function scoreKeyword(q, text) {
  const a = tokenize(q);
  const b = tokenize(text);
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return a.size ? hit / a.size : 0;
}

// ---------- 方法 B：锚点向量 ----------
// 锚点 = 从记忆里挑出的高频概念词（2 字以上，去掉太常见的）
const STOP = new Set(['主人', '就是', '这个', '那个', '什么', '自己', '时候', '现在', '可以', '还是', '但是', '因为', '所以', '已经', '没有', '一个', '不是']);
const freq = new Map();
for (const m of items) {
  for (const seg of String(m.text).match(/[\u4e00-\u9fa5]{2,4}/g) || []) {
    for (let len = 2; len <= Math.min(4, seg.length); len++) {
      for (let i = 0; i + len <= seg.length; i++) {
        const w = seg.slice(i, i + len);
        if (STOP.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
}
const ANCHORS = [...freq.entries()]
  .filter(([, c]) => c >= 3)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 80)
  .map(([w]) => w);

function anchorVec(text) {
  const s = String(text);
  return ANCHORS.map((a) => (s.includes(a) ? 1 : 0));
}
function cos(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
const anchorVectors = items.map((m) => anchorVec(m.text));

// ---------- 方法 C：阿里向量 ----------
let ali = [];
try {
  const v = JSON.parse(await readFile(join(ROOT, '.data', 'vectors.json'), 'utf8'));
  ali = v.items || [];
} catch {}
const aliByText = new Map(ali.map((x) => [x.text, x.v]));
const aliItems = items.filter((m) => aliByText.has(m.text));
console.log(`其中 ${aliItems.length} 条有阿里向量，阿里那列只在这批里比\n`);

// 现场把探针句也算成阿里向量（只 8 次调用）
const EKEY = process.env.EMBED_API_KEY || process.env.VISION_API_KEY || '';
const EBASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
async function embedOne(text) {
  if (!EKEY) return null;
  const r = await fetch(EBASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + EKEY },
    body: JSON.stringify({ model: 'text-embedding-v3', input: [text], encoding_format: 'float' }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.data[0].embedding;
}

// ---------- 跑分 ----------
function rankA(q) {
  return items
    .map((m, i) => ({ i, s: scoreKeyword(q, m.text) }))
    .sort((a, b) => b.s - a.s);
}
function rankB(q) {
  const qv = anchorVec(q);
  return items
    .map((m, i) => ({ i, s: cos(qv, anchorVectors[i]) }))
    .sort((a, b) => b.s - a.s);
}
async function rankC(q) {
  const qv = aliByText.get(q) || (await embedOne(q));
  if (!qv) return null;
  return aliItems
    .map((m) => ({ i: items.indexOf(m), s: cos(qv, aliByText.get(m.text)) }))
    .sort((a, b) => b.s - a.s);
}

function hitAt(ranked, want, k = 3) {
  if (!ranked) return false;
  return ranked.slice(0, k).some((r) => String(items[r.i].text).includes(want));
}

console.log(`记忆 ${items.length} 条 / 锚点 ${ANCHORS.length} 个\n`);
console.log('锚点样例：' + ANCHORS.slice(0, 20).join(' '));

console.log('\n探针            关键词   锚点    阿里');
let a1 = 0;
let b1 = 0;
let c1 = 0;
let cn = 0;
for (const p of PROBES) {
  const A = hitAt(rankA(p.q), p.want);
  const B = hitAt(rankB(p.q), p.want);
  const rc = await rankC(p.q);
  const C = rc ? hitAt(rc, p.want) : null;
  if (A) a1++;
  if (B) b1++;
  if (C) c1++;
  if (c1 !== null && rc) cn++;
  console.log(`${p.q.padEnd(14)}  ${A ? '✅' : '❌'}      ${B ? '✅' : '❌'}     ${C === null ? '—' : C ? '✅' : '❌'}`);
}
console.log(`\n命中率(top3)：关键词 ${a1}/${PROBES.length}   锚点 ${b1}/${PROBES.length}   阿里 ${c1}/${PROBES.length}`);
console.log('\n注：阿里那列只有在"原句本身"存过向量时才算得出来，所以它的分数天生偏高。');