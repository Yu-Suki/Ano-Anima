// 拟人化层：让机器人的"行为节奏"像人
// 注意：这里只做行为层（延迟/分段/错字/作息），不涉及任何平台检测规避

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);
export const randInt = (min, max) => Math.floor(rand(min, max + 1));
export const chance = (p) => Math.random() < p;

/** 打字耗时 = 基础反应时间 + 每字击键时间 */
export function typingDelay(text, cfg) {
  const chars = [...String(text ?? '')].length;
  const base = rand(cfg.reactionMin, cfg.reactionMax);
  const keys = chars * rand(cfg.charDelayMin, cfg.charDelayMax);
  return Math.round(base + keys);
}

/** 回复前的犹豫，小概率"在忙"拖很久 */
export function replyDelay(cfg) {
  if (chance(cfg.busyChance)) return Math.round(rand(cfg.busyDelayMin, cfg.busyDelayMax));
  return Math.round(rand(cfg.replyDelayMin, cfg.replyDelayMax));
}



const SENTENCE_END = /(?<=[。！？!?～~…])/;
const SOFT_END = /(?<=[，,、；;])/;

/** 把长回复拆成几条短消息，模拟边想边打 */

/** 统一标点：三个点写成规范的省略号 */
export function fixPunct(text) {
    const out0 = String(text ?? "")
    .replace(/\[Image\]/gi, "")     // 图片占位符不是话
    .replace(/\[图片\]/g, "")
    .replace(/\[CQ:image[^\]]*\]/g, "")
    .replace(/\.{2,}/g, "……")        // ... / .... → ……
    .replace(/。{2,}/g, "……")        // 。。。 → ……
    .replace(/…+/g, "……")            // 不管几个 …，统一成 ……
    .replace(/\s{2,}/g, " ")
    .trim();
  return out0;
}

export function segment(text, cfg) {
  const clean = fixPunct(text).trim();
  if (!clean) return [];
  // 太短就别拆了，拆开只剩碎渣
  if (clean.length < (cfg.minSplitChars ?? 35)) return [clean];
  if (!cfg.enabled || !chance(cfg.splitChance)) return [clean];

  let parts = clean.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = clean.split(SOFT_END).map((s) => s.trim()).filter(Boolean);
  }
  if (parts.length <= 1) return [clean];

  // 只处理标点：纯标点的碎片并进前一句；去掉句尾多余的逗号句号
  const PUNCT_ONLY = /^[，。、；：…~～!！?？·\s]+$/;
  parts = parts.reduce((acc, cur) => {
    if (PUNCT_ONLY.test(cur)) {
      if (acc.length) acc[acc.length - 1] += cur;
      return acc;
    }
    if (acc.length && PUNCT_ONLY.test(acc[acc.length - 1])) {
      acc[acc.length - 1] += cur;
      return acc;
    }
    acc.push(cur);
    return acc;
  }, []);

  // 引号/括号没配对的别拆开（「略——」不能被劈成两半）
  const PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['《', '》'], ['（', '）'], ['(', ')'], ['【', '】']];
  const bracketBalanced = (s) =>
    PAIRS.every(([a, b]) => {
      const na = (s.match(new RegExp('\\' + a, 'g')) || []).length;
      const nb = (s.match(new RegExp('\\' + b, 'g')) || []).length;
      return na === nb;
    });
  parts = parts.reduce((acc, cur) => {
    if (acc.length && !bracketBalanced(acc[acc.length - 1])) {
      acc[acc.length - 1] += cur;
      return acc;
    }
    acc.push(cur);
    return acc;
  }, []);
  // 最后一块如果还开着引号，直接并进上一块
  while (parts.length > 1 && !bracketBalanced(parts[parts.length - 1])) {
    parts[parts.length - 2] += parts[parts.length - 1];
    parts.pop();
  }

  // 句尾挂着一个逗号/句号很难看，去掉（问号感叹号保留，那是语气）
  parts = parts
    .map((p) => p.replace(/[，。、；：,;:\s]+$/, "").trim())
    .filter(Boolean);

  return mergeToLimit(parts, cfg.maxSegments);
}

function mergeToLimit(parts, max) {
  const limit = Math.max(1, max);
  if (parts.length <= limit) return parts;
  const head = parts.slice(0, limit - 1);
  const tail = parts.slice(limit - 1).join('');
  return [...head, tail];
}

// 常见同音错字，只替换一处，避免整句变味
const TYPO_PAIRS = [
  ['的', '得'], ['了', '啦'], ['在', '再'], ['吗', '嘛'],
  ['那', '哪'], ['他', '她'], ['做', '作'], ['已经', '以经'],
  ['时候', '时后'], ['因为', '因位'], ['这样', '这洋'],
];

/** 随机造一个错字，返回 { text, wrong, right }；造不出就返回 null */
export function introduceTypo(text) {
  const src = String(text ?? '');
  if (!src) return null;
  for (const [right, wrong] of shuffle([...TYPO_PAIRS])) {
    const idx = src.indexOf(right);
    if (idx < 0) continue;
    return {
      text: src.slice(0, idx) + wrong + src.slice(idx + right.length),
      wrong,
      right,
    };
  }
  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 当前小时（按配置时区换算） */
export function localHour(tzOffset, now = new Date()) {
  return (now.getUTCHours() + tzOffset + now.getUTCMinutes() / 60 + 24) % 24;
}

/** 是否处于"睡着"时段 */
export function isAsleep(sched, now = new Date()) {
  const h = localHour(sched.tzOffset, now);
  const { sleepStart: s, sleepEnd: e } = sched;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/** 早上刚醒，回复更迟钝 */
export function wakeJitter(sched) {
  return Math.round(rand(sched.wakeJitterMin, sched.wakeJitterMax) * 1000);
}

/** 简单令牌桶，防止刷屏 */
export class RateLimiter {
  constructor(perMinute) {
    this.perMinute = Math.max(1, perMinute);
    this.hits = new Map();
  }

  take(key) {
    const now = Date.now();
    const win = 60_000;
    const arr = (this.hits.get(key) || []).filter((t) => now - t < win);
    if (arr.length >= this.perMinute) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}