// 记忆向量索引 + 联想扩散
// 不是"找最像的 N 条"，而是"想到一件，连着想起一串"
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_MODEL = process.env.EMBED_MODEL || 'text-embedding-v3';
export const DEFAULT_DIM = Number(process.env.EMBED_DIM || 1024);

async function embedRemote(texts) {
  const key = process.env.EMBED_API_KEY || process.env.VISION_API_KEY || '';
  const base = (process.env.EMBED_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  if (!key) throw new Error('没有 embedding key');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: DEFAULT_MODEL, input: texts, encoding_format: 'float' }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return j.data.map((d) => d.embedding);
}

export function cos(a, b) {
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

// 这件事重不重要：重要的问题值得多想一会儿、想得更远
const HEAVY = ['难过', '生气', '吵架', '害怕', '担心', '承诺', '答应', '永远', '离开', '哭', '委屈', '重要', '生日', '名字', '喜欢', '爱'];
const ASK_BACK = ['还记得', '记不记得', '想起来', '以前', '上次', '那次', '为什么', '到底', '是不是'];
const PEOPLE = ['主人', '妈妈', '爸爸', '阿潜', '小鲸鱼', '俞'];

export function questionWeight(query) {
  const q = String(query || '');
  let score = 0;
  for (const w of HEAVY) if (q.includes(w)) score += 0.22;
  for (const w of ASK_BACK) if (q.includes(w)) score += 0.18;
  for (const w of PEOPLE) if (q.includes(w)) score += 0.12;
  if (q.length > 18) score += 0.1;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

// 跳得越远越淡
const HOP_DECAY = [1, 0.6, 0.32];

export class VecIndex {
  constructor({ file = '.data/vectors.json', model = DEFAULT_MODEL, dim = DEFAULT_DIM } = {}) {
    this.file = join(ROOT, file);
    this.model = model;
    this.dim = dim;
    this.items = [];   // { id, text, v, nb: [邻居下标] }
    this.ok = false;
  }

  async load() {
    try {
      const d = JSON.parse(await readFile(this.file, 'utf8'));
      if (d.model !== this.model || d.dim !== this.dim) {
        this.items = [];
        this.ok = false;
        return this;
      }
      this.items = d.items || [];
      this.ok = this.items.length > 0;
    } catch {
      this.items = [];
      this.ok = false;
    }
    return this;
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(
      this.file,
      JSON.stringify({ model: this.model, dim: this.dim, at: Date.now(), items: this.items }),
      'utf8',
    );
  }

  /** 全量重建 + 顺手算好"谁和谁挨着"（近邻表） */
  async rebuild(memoryItems, { batch = 10, onProgress } = {}) {
    const list = memoryItems.filter((m) => m && m.text);
    this.items = [];
    for (let i = 0; i < list.length; i += batch) {
      const slice = list.slice(i, i + batch);
      const vectors = await embedRemote(slice.map((m) => m.text));
      slice.forEach((m, k) => this.items.push({ id: m.id || '', text: m.text, v: vectors[k], nb: [] }));
      onProgress?.(Math.min(i + batch, list.length), list.length);
      await new Promise((r) => setTimeout(r, 120));
    }
    this.#buildGraph();
    this.ok = this.items.length > 0;
    await this.save();
    return this.items.length;
  }

  /** 每条记下最近的 8 个邻居，查询时直接拿来扩散 */
  #buildGraph(k = 8) {
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const sims = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        sims.push({ j, s: cos(this.items[i].v, this.items[j].v) });
      }
      sims.sort((a, b) => b.s - a.s);
      this.items[i].nb = sims.slice(0, k).filter((x) => x.s > 0.45).map((x) => ({ i: x.j, s: Number(x.s.toFixed(3)) }));
    }
  }

  /**
   * 联想召回
   * 不同的事想到的范围不一样：苗头很明确就窄，含糊就宽
   */
  // 沿着"统辖"关系上下扩散：向下看细节，向上看概括
  expandOwnership(hits, memoryItems, byId, breadth) {
    const out = new Map(hits.map((h) => [h.id, { ...h }]));
    for (const h of hits) {
      const item = byId.get(h.id);
      if (!item) continue;
      // 向下：它的子记忆（细节）
      for (const kid of (item.children || [])) {
        const k = byId.get(kid);
        if (!k) continue;
        const prev = out.get(kid);
        const score = (h.score || h.s || 0) * 0.85;
        if (!prev || prev.score < score) out.set(kid, { id: kid, score, item: k, via: 'child' });
      }
      // 向上：统辖它的整合记忆（概括）
      for (const p of memoryItems.filter((x) => x.layer === 'merged' && (x.children || []).includes(h.id))) {
        const prev = out.get(p.id);
        const score = (h.score || h.s || 0) * 0.8;
        if (!prev || prev.score < score) out.set(p.id, { id: p.id, score, item: p, via: 'parent' });
      }
      if (out.size > breadth) break;
    }
    return [...out.values()];
  }

  async recall(query, { getMeta = null, maxItems = 8, questionWeightOverride = null } = {}) {
    if (!this.ok) return null;
    const [qv] = await embedRemote([query]);
    // 只看向量相似度，不做字面匹配
    const scored = this.items.map((x, i) => ({ i, s: cos(qv, x.v), cos: cos(qv, x.v) }));
    scored.sort((a, b) => b.s - a.s);

    const top = scored[0]?.s || 0;
    // 1) 命中越明确，收敛越窄；越含糊，扩散越宽
    let seeds;
    let hops;
    let breadth;
    if (top >= 0.78) {
      seeds = 2; hops = 1; breadth = 3;   // 很明确：就近想想
    } else if (top >= 0.62) {
      seeds = 4; hops = 2; breadth = 4;   // 一般：主流 + 一圈联想
    } else {
      seeds = 6; hops = 2; breadth = 6;   // 很含糊：多抓几把
    }

    // 2) 事情越重要，想得越深越远（跟"准不准"是两个维度）
    const important = questionWeightOverride == null ? questionWeight(query) : questionWeightOverride;
    if (important >= 0.55) {
      seeds += 2; hops = 2; breadth += 2;   // 重要：多想想，往深里挖
    } else if (important <= 0.15) {
      seeds = Math.max(2, seeds - 1); breadth = Math.max(2, breadth - 1); // 无关紧要：快点
    }

    // 分层扩散：激活表
    const act = new Map();
    const depthMap = new Map();   // 每个点离你这句话几跳
    const add = (i, a) => act.set(i, Math.max(act.get(i) || 0, a));

    for (const s of scored.slice(0, seeds)) add(s.i, s.s);

    let frontier = scored.slice(0, seeds).map((s) => ({ i: s.i, a: s.s }));
    for (let hop = 1; hop <= hops; hop++) {
      const next = [];
      for (const f of frontier) {
        const nbs = (this.items[f.i].nb || []).slice(0, breadth);
        for (const nb of nbs) {
          const a = f.a * 0.85 * nb.s;   // 统一衰减
          if (a < 0.5) continue;   // 统一阈值   // 统一阈值 // 太淡的不要，免得想到八竿子外
          if ((act.get(nb.i) || 0) >= a) continue;
          add(nb.i, a);
          next.push({ i: nb.i, a });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    // 最后排序：联想强度 + 记忆本身的轻重
  // 4) 统辖扩散：沿统辖关系上下走，最多 3 层；
  //    相关度低于阈值就直接丢掉，也不从那个点继续扩散
  if (getMeta) {
    const THRESH = 0.5;   // 统一阈值   // 统一阈值      // 低于这个相关度就丢弃
    const idxById = new Map(this.items.map((x, ii) => [x.id, ii]));
    const parentsOfId = new Map();
    for (let j = 0; j < this.items.length; j++) {
      const mj = getMeta(this.items[j].id);
      if (!mj || mj.layer !== 'merged') continue;
      for (const kid of (mj.children || [])) {
        if (!parentsOfId.has(kid)) parentsOfId.set(kid, []);
        parentsOfId.get(kid).push(j);
      }
    }
    let frontier = [...act.entries()].map(([i, a]) => ({ i, a, d: 0 }));
    const visited = new Set(frontier.map((x) => x.i));
    for (const f of frontier) depthMap.set(f.i, 0);
    const CAP = [5, 10];            // 第 1 层取 5 条，第 2 层取 10 条
    while (frontier.length) {
      const cand = [];
      for (const cur of frontier) {
        const sid = this.items[cur.i]?.id;
        if (!sid) continue;
        const meta = getMeta(sid);
        const kids = (meta?.children || []).map((id) => idxById.get(id)).filter((j) => j != null);
        const parents = parentsOfId.get(sid) || [];
        for (const j of [...kids, ...parents]) {
          const a2 = cur.a * 0.85;   // 统一衰减          // 这条记忆与话题的相关度
          if (a2 < THRESH) continue;         // 低于 0.5：丢弃，也不再从它扩散
          cand.push({ j, a2, d: cur.d + 1 });
        }
      }
      if (!cand.length) break;
      // 扩散层不是只看相似度：把权重、层加成也算进来
      cand.forEach((x) => {
        const id = this.items[x.j] && this.items[x.j].id;
        const meta = id ? getMeta(id) || {} : {};
        const wNorm = Math.min(1, (Number(meta.weight) || 1) / 10);
        const layerBoost = meta.layer === 'core' ? 1 : meta.layer === 'merged' ? 0.8 : 0.6;   // 核心不再压死别的
        x.rank = x.a2 * 0.6 + wNorm * 0.3 + layerBoost * 0.1;   // 和最终打分同一套权重
      });
      cand.sort((x, y) => y.rank - x.rank);
      const cap = CAP[frontier[0].d] ?? CAP[CAP.length - 1];
      const next = [];
      for (const x of cand) {
        if (next.length >= cap) break;
        if ((act.get(x.j) || 0) < x.a2) act.set(x.j, x.a2);
        if (!visited.has(x.j)) { visited.add(x.j); depthMap.set(x.j, x.d); next.push({ i: x.j, a: x.a2, d: x.d }); }
      }
      frontier = next;
    }
  }

    const out = [...act.entries()].map(([i, a]) => {
      const it = this.items[i];
      const meta = getMeta ? getMeta(it.id) || {} : {};
      const w = Number.isFinite(meta.weight) ? meta.weight / 10 : 0.5;
      const layerBoost = meta.layer === 'core' ? 1 : meta.layer === 'merged' ? 0.8 : 0.6;
      // 相关度最要紧；分数开根号，免得高分记忆一家独大
      const final = a * 0.5 + Math.sqrt(Math.max(0, w)) * 0.4 + layerBoost * 0.1;
      return { id: it.id, text: it.text, activation: Number(a.toFixed(3)), final: Number(final.toFixed(3)), hop: depthMap.get(i) || 0 };
    });
    out.sort((a, b) => b.final - a.final);
    // 每一层激活了哪些记忆（星图动画用）
    const trace = { 0: [], 1: [], 2: [], 3: [] };
    const seedIdx = new Set(scored.slice(0, seeds).map((x) => x.i));
    for (const idx of act.keys()) {
      const id = this.items[idx]?.id;
      if (!id) continue;
      let d = depthMap.get(idx);
      if (d == null || d === 0) d = seedIdx.has(idx) ? 0 : 1;   // 近邻扩散出来的一律算第一层
      (trace[d] || (trace[d] = [])).push(id);
    }
    return { breadth: { seeds, hops, breadth, questionWeight: important, trace }, items: out.slice(0, maxItems) };
  }

  /**
   * 和记忆库对齐：多的删掉，缺的补上，然后重算邻居
   * 启动时跑一次，整理记忆之后再跑一次
   */
  async sync(memoryItems, { batch = 10, onProgress } = {}) {
    const list = (memoryItems || []).filter((m) => m && m.text);
    const alive = new Map(list.map((m) => [m.id, m]));
    const before = this.items.length;

    // 1) 删掉记忆里已经没有的
    this.items = this.items.filter((x) => x.id && alive.has(x.id));
    const pruned = before - this.items.length;

    // 2) 补上缺的 / 内容变了的
    const have = new Map(this.items.map((x) => [x.id, x]));
    const todo = list.filter((m) => {
      const old = have.get(m.id);
      return !old || old.text !== m.text;
    });

    for (let i = 0; i < todo.length; i += batch) {
      const slice = todo.slice(i, i + batch);
      const vectors = await embedRemote(slice.map((m) => m.text));
      slice.forEach((m, k) => {
        const rec = { id: m.id, text: m.text, v: vectors[k], nb: [] };
        const idx = this.items.findIndex((x) => x.id === m.id);
        if (idx >= 0) this.items[idx] = rec;
        else this.items.push(rec);
      });
      onProgress?.(Math.min(i + batch, todo.length), todo.length);
      await new Promise((r) => setTimeout(r, 100));
    }

    if (pruned || todo.length) {
      this.#buildGraph();
      this.ok = this.items.length > 0;
      await this.save();
    }
    return { pruned, added: todo.length, total: this.items.length };
  }

  async selfTest(n = 10) {
    if (!this.items.length) return { ok: false, reason: '索引是空的' };
    let hit = 0;
    for (let t = 0; t < n; t++) {
      const it = this.items[Math.floor(Math.random() * this.items.length)];
      const [qv] = await embedRemote([it.text]);
      const best = this.items.map((x) => ({ text: x.text, s: cos(qv, x.v) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.text === it.text) hit++;
    }
    return { ok: hit >= Math.ceil(n * 0.9), hit, total: n };
  }
}