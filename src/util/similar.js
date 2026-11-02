// 两张描述像不像：本地算，不花 token
// 关键：不能只看词序。所以「字重合」+「词序片段」两个一起看。

const NOISE = new Set('的了呢吗吧啊呀哦嗯是个一有在和与也就都很还又再把被让给对从到'.split(''));

function norm(s) {
  return String(s || '')
    .replace(/[\s，。、；：！？,.!?;:「」『』“”"'（）()【】\[\]\-—…~～]/g, '')
    .toLowerCase();
}

function chars(s) {
  const out = [];
  for (const ch of s) {
    if (NOISE.has(ch)) continue;
    out.push(ch);
  }
  return out;
}

function bigrams(list) {
  const set = new Set();
  for (let i = 0; i < list.length - 1; i++) set.add(list[i] + list[i + 1]);
  return set;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return (2 * hit) / (a.size + b.size);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / (a.size + b.size - hit);
}

/** 0~1。字重合占 55%，相邻片段占 45%——词序变了，字还在。 */
export function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const cx = chars(x);
  const cy = chars(y);
  if (!cx.length || !cy.length) return 0;

  const sx = new Set(cx);
  const sy = new Set(cy);
  const charScore = Math.max(jaccard(sx, sy), Math.min(sx.size, sy.size) / Math.max(sx.size, sy.size) * 0.9);
  const bigramScore = dice(bigrams(cx), bigrams(cy));

  // 短句（比如"好"）只看包含关系
  if (cx.length <= 3 || cy.length <= 3) {
    return x.includes(y) || y.includes(x) ? 0.95 : charScore * 0.6;
  }

  return charScore * 0.55 + bigramScore * 0.45;
}

/** 按"这句话在收藏里有多稀有"加权：略、鲸、傲骄 这些字更值钱 */
function idfWeight(corpus, ch) {
  const docs = corpus.length || 1;
  let n = 0;
  for (const d of corpus) if (String(d || '').includes(ch)) n++;
  return Math.log((docs + 1) / (n + 0.5));
}

/** 带权重的相似度：稀有字命中 = 强证据 */
export function similarIn(desc, other, corpus) {
  const x = chars(norm(desc));
  const y = chars(norm(other));
  if (!x.length || !y.length) return 0;
  const sx = new Set(x);
  const sy = new Set(y);
  let inter = 0;
  let union = 0;
  const all = new Set([...sx, ...sy]);
  for (const ch of all) {
    const w = idfWeight(corpus || [], ch);
    union += w;
    if (sx.has(ch) && sy.has(ch)) inter += w;
  }
  const weighted = union ? inter / union : 0;
  return Math.max(weighted, similar(desc, other) * 0.9);
}

/** 在一堆描述里找最像的；超过阈值就算同一张 */
export function findSimilar(desc, list, threshold = 0.62) {
  let best = null;
  let bestScore = 0;
  for (const it of list || []) {
    const other = it && it.desc ? it.desc : it;
    const corpus = (list || []).map((z) => (z && z.desc ? z.desc : z));
    const s = similarIn(desc, other, corpus);
    if (s > bestScore) {
      bestScore = s;
      best = it;
    }
  }
  return bestScore >= threshold ? { item: best, score: bestScore } : null;
}