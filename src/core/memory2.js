// 多层记忆系统
// 结构借鉴认知科学里可验证的几条机制，不是"神经网络仿真"：
//   · 艾宾浩斯遗忘曲线：保持率 R = e^(-Δt / S)
//   · 间隔重复：每次成功提取，记忆稳定性 S 变大（越用越难忘）
//   · ACT-R 激活扩散：检索到某条，会带起和它共享标签/主体/词的邻近条目
//   · 情绪调制：情绪波动大时形成的记忆，初始权重更高
//   · 工作记忆：容量有限（9 条）、按会话隔离、30 分钟过期
//
// 三层：
//   surface   表层记忆 —— 具体发生过的事
//   merged    整合记忆 —— 把几条表层压成的一句概括
//   core      核心记忆 —— 永不忘的那些
import { envNum } from '../util/env.js';
import { randomUUID } from 'node:crypto';
import { tokenize } from '../util/tokenize.js';

export const LAYERS = ['surface', 'merged', 'core'];   // 表层 / 整合 / 核心

const HOUR = 3600000;


// 每层一套遗忘参数（改完立即生效，不用重启）
//   sHours   基础稳定性（小时）—— 多久忘掉一半
//   capHours 稳定性上限（小时）
//   寿命由分数算，时间到了就删（不再有保持率）
const LAYER_PARAMS = {
  surface: {
    sHours: () => envNum('MEMORY_SURFACE_HOURS', 720),
    capHours: () => envNum('MEMORY_SURFACE_CAP_DAYS', 365) * 24,
  },
  merged: {
    sHours: () => envNum('MEMORY_MERGED_HOURS', 4320),
    capHours: () => envNum('MEMORY_MERGED_CAP_DAYS', 730) * 24,
  },
  core: {
    sHours: () => Infinity,
    capHours: () => Infinity,
  },
};

const paramsOf = (layer) => LAYER_PARAMS[layer] || LAYER_PARAMS.surface;   // 兜底用表层，别再指向已删除的 semantic

/** 情景记忆：1 分 = 10 分钟，10 分 = 1 年，中间指数分布 */
function baseStability(layer, weight) {
  if (layer === 'core') return Infinity;
  // 表层记忆：1 分 10 分钟 ~ 10 分 1 年
  const w = Math.min(10, Math.max(1, Number(weight) || 5));   // 打分从 1 分起，0.5 只用于标记删除
  const MIN = 1;   // 最低 1 分也活 1 小时（原来 10 分钟，低分掉得太快）
  const MAX = 24 * 365;
  return MIN * Math.pow(MAX / MIN, (w - 1) / 9);
}


// ---------- 判重：同一件事的两种说法 ----------
// 只删语气填充词，绝不删「不 / 没 / 别 / 无」这类否定词，否则会把意思改反。
// "他养了只猫" 和 "他养了只狗" 只差一个字，必须是两件事 —— 所以用"包含"判断，
// 而不是用相似度百分比。
const SOFT_WORDS = [
  '之类', '这些', '那些', '相关', '别的', '其他', '一些', '一点', '其实', '应该',
  '可能', '比较', '有点', '已经', '一直', '就是', '东西', '事情', '时候', '现在',
  '真的', '非常', '特别',
];
const FILLER_CHARS = /[的了是在就都也很还有个呀啊呢吧哦嘛么嘟呗啦咯噢诶嗯哈]/g;
const PUNCT = /[\s，。！？、,.!?;；:："'“”‘’（）()\[\]【】…~～\-—_]/g;

// flash 会把人的名字写成"这五个字"。这类句子写进记忆就是废的，统一在这里兜住
function cleanName(s) {
  return String(s || '')
    .replace(/这[几二三四五]个字|那个名字|某个名字|那个人/g, '主人')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeFact(s) {
  let t = String(s || '').toLowerCase().replace(PUNCT, '');
  for (const w of SOFT_WORDS) t = t.split(w).join('');
  return t.replace(FILLER_CHARS, '');
}

function lcsLen(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[n];
}

export function sameFact(a, b) {
  const x = normalizeFact(a);
  const y = normalizeFact(b);
  if (x.length < 4 || y.length < 4) return false; // 太短的不敢判重
  if (x === y) return true;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // ① 短的被长的完整包含 —— 同一件事的详略两种说法
  if (long.includes(short) && (long.length - short.length <= 6 || short.length >= 10)) return true;
  // ② 只差几个字（"一起玩" / "一起去玩了"）—— 按相似度判
  return lcsLen(x, y) / Math.max(x.length, y.length) >= 0.88;
}

export class Brain {
  constructor({ store, file = 'brain.json', legacyFile = 'memory.json' } = {}) {
    this.store = store;
    this.file = file;
    this.legacyFile = legacyFile;
    this.items = [];
    this.dirty = false;
    this.stats_ = { recalled: 0, forgotten: 0, consolidated: 0 };
  }

  async load() {
    try {
      const data = await this.store.read(this.file, null);

      if (data?.items) {
        this.items = data.items;
      } else {
        // 从旧版单层记忆迁移
        const legacy = await this.store.read(this.legacyFile, null);
        if (legacy?.items?.length) {
          for (const m of legacy.items) {
            this.items.push(this.#make({
              layer: 'surface',
              text: m.text,
              subject: m.subject || '',
              createdAt: m.createdAt,
              lastAt: m.lastAt,
            }));
          }
          this.dirty = true;
        }
      }
    } catch (err) {
      // 读不出来（权限/文件损坏）：进入只读模式，绝不覆盖原数据
      this.readonly = true;
      this.loadError = err.message;
      this.items = [];
    }

    // 载入时先衰减一次
    this.consolidate();
    return this;
  }

  async save() {
    // 只读模式：宁可不存，也不能把原有记忆覆盖成空
    if (this.readonly) return;
    this.consolidate();
    await this.store.write(this.file, {
      items: this.items,
      stats: this.stats_,
      savedAt: Date.now(),
    });
    this.dirty = false;
  }

  #make({
    layer,
    text,
    subject = '',
    tags = [],
    emotion = 0,
    createdAt,
    lastAt,
    hits = 0,
    kind = 'fact',
    detail = '',
    where = '',
    platform = '',
    whoName = '',
    nick = '',
    weight = 5,
    children = [],
    weightWhy = '',
    places = [],
    people = [],
    raw = '',
    feeling = '',
    from = '',
  }) {
    const now = Date.now();
    const w = Math.min(10, Math.max(1, Number(weight) || 5));   // 打分从 1 分起
    const capH = paramsOf(layer).capHours();
    // 10 分直接进核心，永不衰减
    const finalLayer = (w >= 10) ? 'core' : layer;
    const initStability = Math.min(
      baseStability(layer, w),
      capH,
    );
    return {
      id: randomUUID().slice(0, 8),
      layer: finalLayer,
      text: String(text).trim(),
      subject: String(subject || ''),
      // 这条记忆的性质：事实 / 玩笑 / 他在问我 / 发生过的事 / 感受
      kind,
      // 重要的事才有细节：当时说了什么、什么感觉（可以比一句话长很多）
      detail: String(detail || ''),
      // 原话切片：当时到底是怎么说的（只有重要的才存）
      raw: String(raw || ''),
      // 她的感受，一句话
      feeling: String(feeling || ''),
      where: String(where || ''),
      platform: String(platform || ''),
      // 地点是标签不是分区：可以同时属于多个群/软件/服务器
      // 地点是人看得懂的位置（"鲸鱼群""私聊""面板"），机器用的场景在 where 里，别混进来
      places: [...new Set(places || [])].filter(Boolean).slice(0, 6),
      // 涉及的人
      people: [...new Set([].concat(people || [], whoName || []).filter(Boolean))].slice(0, 8),
      whoName: String(whoName || ''),
      // 他的昵称（原名）：只当线索，不用来称呼
      nick: String(nick || ''),
      // 1-10，她自己判断值多少分；weightWhy 是她给的理由
      weight: w,
      weightWhy: String(weightWhy || ''),
      // 从哪一层来的（被挪进核心时记录原层）
      from: String(from || ''),
      tags: [...new Set(tags)].slice(0, 8),
      children: [...new Set(children || [])].slice(0, 60),
      emotion: Number(emotion) || 0,
      stability: initStability,
      hits,
      createdAt: createdAt || now,
      lastAt: lastAt || now,
      activation: 1,
    };
  }

  /** 写入（同层同主体同文本视为同一条，做巩固而不是重复存） */
  /**
   * 写入。
   * 两种重复都要处理：
   *   1. 一模一样 —— 直接巩固
   *   2. 换个说法（"他在做AI项目" / "他在做AI相关的项目"）—— 合并成一条
   * 但"他养了只猫"和"他养了只狗"只差一个字，必须当成两件事，所以判重不能只看相似度。
   */
  remember({
    layer = 'surface',
    text,
    subject = '',
    tags = [],
    emotion = 0,
    source = '',
    kind = 'fact',
    detail = '',
    where = '',
    platform = '',
    whoName = '',
    nick = '',
    weight = 5,
    weightWhy = '',
    places = [],
    people = [],
    raw = '',
    feeling = '',
      children = [],
  }) {
    text = cleanName(text);   // 名字写坏的句子，进库前先修
    whoName = cleanName(whoName);
    nick = String(nick || '').trim();
    detail = cleanName(detail);   // 细节里也会被写成「这五个字」，一起修
    raw = cleanName(raw);
    weightWhy = cleanName(weightWhy);
    const t = String(text || '').trim();
    if (t.length < 2) return null;

    const dup = this.items.find(
      (m) =>
        m.text === t &&
        String(m.subject || '') === String(subject || '') &&
        m.layer === layer,
    );
    if (dup) {
      this.reinforce(dup);   // 刷新 lastAt、hits+1、按当前分数重算寿命
      // 又提了一次：只刷新时间。提到第 5、10、15… 次才 +0.5 分
      dup.lastAt = Date.now();
      if (dup.hits > 0 && dup.hits % 5 === 0) {
        dup.weight = Math.min(10, (dup.weight || 5) + 0.5);
        dup.stability = Math.min(baseStability(dup.layer, dup.weight), paramsOf(dup.layer).capHours());
      }
      // 新来的细节/原话比旧的更全就补上
      if (detail && detail.length > (dup.detail || '').length) dup.detail = detail;
      if (raw && raw.length > (dup.raw || '').length) dup.raw = raw;
      if (weight > (dup.weight || 0)) {
        dup.weight = Math.min(10, weight);
        if (weightWhy) dup.weightWhy = weightWhy;
      }
      return dup;
    }

    // 换个说法的同一件事：合并。必须同一个人 —— 否则两个人说的相似的话会被并成一条
    const twin = this.items.find(
      (m) => String(m.subject || '') === String(subject || '') && sameFact(m.text, t),
    );
    if (twin) {
      const merged = this.#mergeInto(twin, { text: t, emotion, layer, tags, detail, kind, raw });
      this.mergedCount = (this.mergedCount || 0) + 1;
      this.lastMerge = { at: Date.now(), kept: merged.text, folded: t };
      this.dirty = true;
      return merged;
    }

    const item = this.#make({
      layer,
      text: t,
      subject,
      tags: [...new Set(tags)].slice(0, 8),
      // 情绪只作为参考，不再直接改稳定性 —— 重要与否由 weight 决定
      emotion,
      kind,
      detail,
      where,
      platform,
      whoName,
      nick,
      weight,
      weightWhy,
      places,
      people,
      raw,
      feeling,
        children,
    });

    item.source = source;
    this.items.push(item);
    this.dirty = true;
    try { this.vecHook?.({ type: 'add', item }); } catch {}
    return item;
  }

  /** 把新说法并进已有那条：留信息量更大的文本，稳定度略升 */
  #mergeInto(item, { text, emotion, layer, tags = [], detail = '', kind = '', raw = '' }) {
    // 相同/类似 = 又提了一次：刷新时间 + 只加一分（不额外放大稳定性）
    item.lastAt = Date.now();
    item.hits = (item.hits || 0) + 1;
    item.weight = Math.min(10, (item.weight || 5) + 0.5);
    item.stability = Math.min(
      baseStability(item.layer, item.weight),
      paramsOf(item.layer).capHours(),
    );
    item.activation = 1;
    this.stats_.consolidated++;
    // 新文本明显更长（信息更多）就换掉旧的
    if (text.length > item.text.length + 2) item.text = text;
    if (detail && detail.length > (item.detail || '').length) item.detail = detail;
    if (raw && raw.length > (item.raw || '').length) item.raw = raw;
    if (kind && item.kind === 'fact' && kind !== 'fact') item.kind = kind;

    if (layer && paramsOf(layer).sHours() > paramsOf(item.layer).sHours()) item.layer = layer;

    const before = Math.abs(item.emotion || 0);
    if (Math.abs(emotion) > before) item.emotion = emotion;

    // 重复出现本身就是"这件事重要"的证据
    item.stability = Math.min((item.stability || 1) * 1.25, 24 * 90);
    item.hits = (item.hits || 0) + 1;
    item.lastAt = Date.now();
    item.activation = 1;
    item.tags = [...new Set([...(item.tags || []), ...tags])].slice(0, 8);
    try { this.vecHook?.({ type: 'add', item }); } catch {}
    return item;
  }

  /**
   * 清理已经存在的重复（入库去重只能防新增，管不了历史数据）。
   * 同一件事的多种说法，留下信息量最大的那条，其余并进去。
   */
  dedupeAll({ dryRun = false } = {}) {
    const taken = new Set();
    const groups = [];

    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      if (taken.has(a.id)) continue;
      taken.add(a.id);

      const group = [a];
      for (let j = i + 1; j < this.items.length; j++) {
        const b = this.items[j];
        if (taken.has(b.id)) continue;
        // 不同人的话不能合并：两个人说"我不喜欢吃饭"是两件事
        if (String(a.subject || '') !== String(b.subject || '')) continue;
        if (sameFact(a.text, b.text)) {
          group.push(b);
          taken.add(b.id);
        }
      }
      if (group.length > 1) groups.push(group);
    }

    const details = [];
    let removed = 0;
    const dropIds = new Set();

    for (const group of groups) {
      // 留下的那条：文本最长 > 重要度最高 > 被想起最多
      const sorted = [...group].sort(
        (x, y) =>
          y.text.length - x.text.length ||
          (y.hits || 0) - (x.hits || 0),
      );
      const keep = sorted[0];
      const drop = sorted.slice(1);

      for (const d of drop) {
        keep.hits = (keep.hits || 0) + (d.hits || 0);
        keep.stability = Math.max(keep.stability || 1, d.stability || 1);
        keep.lastAt = Math.max(keep.lastAt || 0, d.lastAt || 0);
        if (Math.abs(d.emotion || 0) > Math.abs(keep.emotion || 0)) keep.emotion = d.emotion;
        if (paramsOf(d.layer).sHours() > paramsOf(keep.layer).sHours()) keep.layer = d.layer;
        dropIds.add(d.id);
        removed++;
      }

      details.push({ keep: keep.text, folded: drop.map((d) => d.text) });
    }

    if (!dryRun && removed) {
      this.items = this.items.filter((m) => !dropIds.has(m.id));
      this.dirty = true;
    }

    return { groups: details.length, removed, dryRun, details };
  }

  /** 旧接口兼容 */
  add({ text: textIn, kind = 'fact', subject = '', source = '', detail = '', where = '', whoName = '' }) {
    const text = cleanName(textIn);
    return this.remember({
      layer: kind === 'event' ? 'surface' : 'surface',
      text,
      subject,
      source,
      kind,
      detail,
      where,
      whoName,
    });
  }

  /** 巩固：用过一次，遗忘变慢（间隔重复），并且刷新"最后一次提到"的时间 */
  reinforce(item, now = Date.now()) {
    if (!item || item.layer === 'core') return;
    const p = paramsOf(item.layer);
    item.hits = (item.hits || 0) + 1;
    item.lastAt = now;   // 只记"最后一次想起"，发生时间 at 不动
    // 只刷新时间，不再乘倍数 —— 稳定性完全由分数决定，避免和加分重复计算
    item.stability = Math.min(baseStability(item.layer, item.weight), p.capHours());
    item.activation = 1;
    this.stats_.consolidated++;
    this.dirty = true;
  }

  /** 挪进核心：独立存放，不再衰减，也不会被遗忘清掉。传 id 或条目都行 */
  moveToCore(ref) {
    const id = typeof ref === 'string' ? ref : ref?.id;
    const item = this.items.find((m) => m.id === id);
    if (!item || item.layer === 'core') return item || null;
    item.from = item.layer;
    item.layer = 'core';
    item.stability = Infinity;
    item.activation = 1;
    this.dirty = true;
    try { this.vecHook?.({ type: 'add', item }); } catch {}
    return item;
  }

  /** 从核心退回原来的层，重新开始衰减 */
  restoreFromCore(ref) {
    const id = typeof ref === 'string' ? ref : ref?.id;
    const item = this.items.find((m) => m.id === id);
    if (!item || item.layer !== 'core') return item || null;
    const back = item.from || 'surface';
    item.layer = back;
    item.from = '';
    item.stability = baseStability(back, item.weight);
    item.lastAt = Date.now();
    this.dirty = true;
    try { this.vecHook?.({ type: 'add', item }); } catch {}
    return item;
  }

  /** 旧接口兼容 */
  pin(ref, on = true) {
    return on ? this.moveToCore(ref) : this.restoreFromCore(ref);
  }

  /** 夜里睡觉时给整理过的记忆加 0.5 分（睡眠巩固） */
  nightlyBoost(amount = 0.5) {
    let n = 0;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const cutoff = dayStart.getTime();
    for (const m of this.items) {
      // 只巩固今天真的回想过的（lastAt 在今天），没碰过的不加
      if ((m.lastAt || 0) < cutoff) continue;
      if (m.layer !== 'surface') continue;   // 只有表层记忆夜里加分（整合/核心不加）
      if ((m.weight || 0) >= 10) continue;
      m.weight = Math.min(10, Number(((m.weight || 5) + amount).toFixed(2)));
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }


  /** 衰减 + 清理：寿命统一按分数算，只有核心层例外（永不衰减） */
  consolidate(now = Date.now()) {
    const alive = [];
    const liveIds = new Set(this.items.map((x) => x.id));   // 只建一次，后面的子记忆清理用它
    for (const item of this.items) {
      // 核心层永不衰减、永不删除
      if (item.layer === 'core') {
        item.stability = Infinity;
        alive.push(item);
        continue;
      }


      // 整合记忆：只要还统辖着活着的子记忆，就不衰减
      if (item.layer === 'merged') {
        // 先清掉已经不存在的子记忆 id（子记忆可能先被忘了）
        item.children = (item.children || []).filter((id) => liveIds.has(id));
        // 还有子记忆：冻结，不衰减
        if (item.children.length) {
          alive.push(item);
          continue;
        }
        // 子记忆全没了：它变成一条独立的概括，开始按自己的分数衰减
      }

      const p = paramsOf(item.layer);
      // 上限兜底，避免稳定性被手动调爆
      if (Number.isFinite(p.capHours())) item.stability = Math.min(item.stability, p.capHours());

      // 只用"剩多少时间"这一件事：不分档指数、不搞保持率
      if (item.layer !== 'core') {
        const lifeH = Number(item.stability) || 0;                    // 这条记忆的总寿命
        const elapsedH = Math.max(0, (now - item.lastAt) / HOUR);     // 已经过了多久
        const remH = lifeH - elapsedH;                                // 还剩多久

        // ① 时间到了就删
        if (remH <= 0) {
          this.stats_.forgotten++;
          this.dirty = true;
          continue;
        }

        // ② 分数 = 剩余时间落在哪一档
        let tierW = 1;
        for (let k = 10; k >= 1; k -= 0.5) {
          const need = Number.isFinite(baseStability(item.layer, k)) ? baseStability(item.layer, k) : Infinity;
          if (remH >= need) { tierW = k; break; }
        }
        if (tierW !== item.weight) { item.weight = tierW; this.dirty = true; }

        // ③ 快没了就丢细节（只留一句话）
        if (remH < lifeH * 0.25 && (item.detail || item.raw)) {
          item.detail = '';
          item.raw = '';
          this.stats_.faded = (this.stats_.faded || 0) + 1;
          this.dirty = true;
        }
      }

      alive.push(item);
    }
    if (alive.length !== this.items.length) this.dirty = true;
    this.items = alive;
  }

  /**
   * 检索：激活扩散
   * 先按 相关度 × 保持率 × 重要度 排序，再让命中的条目把邻居带起来
   */
  recall(query, { subject = '', limit = 8, spread = true, reinforce = false, now = Date.now() } = {}) {
    const q = tokenize(query);
    const raw = String(query || '').trim();
    if (!q.size && raw.length < 2) return [];

    const matched = new Map(); // id -> { item, base, spread }

    // 第一遍：直接命中
    for (const item of this.items) {
      if (item.layer === 'surface') continue;

      const t = tokenize(`${item.text} ${item.tags.join(' ')} ${item.subject}`);
      let hit = 0;
      for (const tok of q) {
        // 单字（比如"猫"）不在二元组里，用子串兜住
        if (t.has(tok) || item.text.includes(tok)) hit++;
      }
      if (!hit && raw.length >= 2 && item.text.includes(raw)) hit = 2;
      if (!hit) continue;

      const overlap = hit / Math.sqrt(Math.max(q.size, 1) * Math.max(t.size, 1));
      const rel = item.subject && item.subject === subject ? 1.35 : 1;
      const lifeH = Number(item.stability) || 1;
      const act = Math.max(0, (lifeH - (now - item.lastAt) / 3600000) / lifeH);   // 剩余比例，不再是 R

      matched.set(item.id, {
        item,
        base: overlap * 1 * act * rel,
        spread: 0,
      });
    }

    if (!matched.size) return [];

    // 第二遍：扩散激活 —— 把没直接命中、但和"种子"同属一个人/同一批标签的拉进来
    if (spread) {
      const seeds = [...matched.values()].sort((a, b) => b.base - a.base).slice(0, 3);
      const hotSubjects = new Set(seeds.map((s) => s.item.subject).filter(Boolean));
      const hotTags = new Set(seeds.flatMap((s) => s.item.tags));

      for (const item of this.items) {
        if (item.layer === 'surface' || matched.has(item.id)) continue;

        let boost = 0;
        if (item.subject && hotSubjects.has(item.subject)) boost += 0.22;
        for (const tag of item.tags) {
          if (hotTags.has(tag)) {
            boost += 0.1;
            break;
          }
        }
        if (boost > 0) matched.set(item.id, { item, base: 0, spread: boost });
      }

      // 已命中的条目之间也互相点亮
      for (const s of matched.values()) {
        if (s.item.subject && hotSubjects.has(s.item.subject)) s.spread += 0.18;
        for (const tag of s.item.tags) {
          if (hotTags.has(tag)) {
            s.spread += 0.06;
            break;
          }
        }
      }
    }

    const ranked = [...matched.values()]
      .sort((a, b) => {
        // 直接命中的永远排在"只靠扩散被拉进来"的前面
        const tier = (x) => (x.base > 0 ? 1 : 0);
        if (tier(a) !== tier(b)) return tier(b) - tier(a);
        return b.base + b.spread - (a.base + a.spread);
      })
      .slice(0, limit);

    if (reinforce) for (const s of ranked) this.reinforce(s.item, now); // 被想起 = 巩固
    this.stats_.recalled++;
    return ranked.map((s) => s.item);
  }

  // ---------- 给 prompt 用 ----------
  /** 一条记忆该怎么说给模型听 */
  /** 这件事是什么时候的：今天/昨天/N天前 */
  whenLabel(ts) {
    if (!ts) return '';
    const now = new Date();
    const d = new Date(ts);
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day0 - t0) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days === 2) return '前天';
    if (days < 7) return days + '天前';
    if (days < 30) return Math.floor(days / 7) + '周前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  render(m) {
    m = { ...m, text: cleanName(m.text), detail: cleanName(m.detail) };
    const prefix =
      {
        joke: '（玩笑）',
        ask: '（他问过我）',
        feeling: '（我当时觉得）',
      }[m.kind] || '';

    const tag = { core: '（很重要）', merged: '', surface: '' }[m.layer] || '';

    // at = 这件事哪天发生的；lastAt 只是最后一次被想起，不能拿来当发生时间
    // 记忆必须自带日期：以后看到里面的"昨天/昨晚"，都按这个日期算
    const d = m.createdAt ? new Date(m.createdAt) : null;
    const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const md = d
      ? (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WD[d.getDay()] + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      : '';
    const rel = d ? this.whenLabel(m.createdAt) : '';
    const when = d ? md + '，' + rel : '很久以前';
    let line = `- ［${when || '更早'}］${prefix}${tag}${m.text}`;
    // 有地点就说在哪发生的（跨地点，所以必须标出来）
    if (m.places && m.places.length) line += `〔${m.places.join('、')}〕`;
    // 重要的事带细节：另起一行，缩进着写
    if (m.detail) {
      line += `\n    ↳ ${m.detail}`;
    }
    // 原话只在高权重时才放出去，否则太长
    if (m.raw && (m.weight || 0) >= 7) {
      line += `\n    ↳ 对方当时的原话：「${m.raw}」`;
    }
    return line;
  }

  /** 按层取（面板用） */
  byLayer(layer) {
    return this.items
      .filter((m) => m.layer === layer)
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** 最近 N 天发生的事（时间召回，不走关键词） */
  recentEvents(days = 1, limit = 20) {
    const cut = Date.now() - days * 86400000;
    return this.items
      .filter((m) => m.layer === 'surface' && m.lastAt >= cut)
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit);
  }

  /** 这一轮召回过的条目，回复生成后判断有没有真的用上 */
  markRecalled(items) {
    this.lastRecalled = items || [];
  }

  /** 回复里真的提到了某条记忆的关键词，才算"想起"，才刷新强度 */
  reinforceUsed(replyText) {
    const list = this.lastRecalled || [];
    if (!list.length) return 0;
    const r = String(replyText || '');
    if (r.length < 2) return 0;
    let n = 0;
    for (const item of list) {
      const keys = String(item.text || '')
        .split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
        .filter((x) => x.length >= 2);
      const hit = keys.some((k) => r.includes(k));
      if (hit) {
        this.reinforce(item);
        n++;
      }
    }
    this.lastRecalled = [];
    return n;
  }

  promptBlock(query, subject = '', { convId = '', extra = [] } = {}) {
    const q = String(query || '');
    // 问"今天/昨天/最近发生什么" → 直接按时间列事件，不走关键词匹配
    const timeAsk = /今天|昨天|前天|最近|这几天|发生过什么|今天的事/.test(q);
    const days = /今天/.test(q) ? 1 : /昨天/.test(q) ? 2 : /前天/.test(q) ? 3 : 7;

    // 关键词召回已删：现在只走向量检索（agent 传进来的 extra 就是它给的 id）
    const related = (extra || []).map((id) => this.items.find((x) => x.id === id)).filter(Boolean).slice(0, 6);
    const timeline = timeAsk ? this.recentEvents(days, 12) : [];
    // 核心记忆永远在场，不靠关键词碰运气
    const core = this.items
      .filter((m) => m.layer === 'core')
      .sort((a, b) => (b.weight || 0) - (a.weight || 0) || b.lastAt - a.lastAt)
      .slice(0, 6);
    // 上下文里的"刚才聊到的片段"来自对话历史，不再单独存一份
    const daily = [];

    const lines = [];
    lines.push('（下面这些是我想起来的，不是正在发生的对话。');
    lines.push('「阿糯」就是我；「主人」「妈妈」「阿潜」是别人——第三人称只是记事的写法。');
    lines.push('用不用、提哪条，我自己判断，不必全提。）');
    
    const seen = new Set();
    // 核心记忆不再每轮强制塞进来：它权重最高，检索时自然会排到前面
    // （以前每轮都注入，导致"她想起什么"这件事看不出来）

    if (timeline.length) {
      const items = timeline.map((m) => {
        const day = new Date(m.lastAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const where = m.places && m.places.length ? `〔${m.places.join('、')}〕` : '';
        return `- ${day}${where} ${m.text}${m.detail ? `：${m.detail}` : ''}`;
      });
      lines.push('## 这段时间发生的事（按时间排）');
      lines.push(items.join('\n'));
      timeline.forEach((m) => seen.add(m.id));
    }

    for (const m of related) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      lines.push(this.render(m));
    }

    if (!lines.length && !daily.length) return '';

    let out = '';
    if (daily.length) {
      out += `## 刚才聊到的原话片段（不一定是事实，只是上下文）\n${daily.map((d) => `- ${d.text}`).join('\n')}\n`;
    }
    if (lines.length) {
      out += `## 你记得的事\n${lines.join('\n')}`;
    }
    this.markRecalled(related);
    return out.trim();
  }

  /**
   * 被激活（想起来 / 被扩散带到）：刷新"最后想起"的时间和分数基准。
   * 和"提五次加 0.5 分"是两件事——这里不加分，只把时间拨到现在，
   * 分数会在下次 consolidate 里按"剩余时间对应哪一档"自然回到该有的值。
   */
  /**
   * 被想起（扩散带到的也算）：只刷新"寿命"，不动 lastAt。
   * 寿命回到当前分数该有的长度 —— 相当于"又被过了一遍，没那么快忘"。
   */
  activate(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const set = new Set(ids);
    let n = 0;
    for (const it of this.items) {
      if (!set.has(it.id)) continue;
      if (it.layer !== 'core') {
        const base = baseStability(it.layer, it.weight);
        if (Number.isFinite(base)) it.stability = Math.max(it.stability || 0, base);
      }
      it.activation = 1;
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  /** 真正被选进上下文（她要用的那几条）才更新"上次提起" */
  touch(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const now = Date.now();
    const set = new Set(ids);
    let n = 0;
    for (const it of this.items) {
      if (!set.has(it.id)) continue;
      it.lastAt = now;
      n++;
    }
    if (n) this.dirty = true;
    return n;
  }

  all() {
    return [...this.items].sort((a, b) => b.lastAt - a.lastAt);
  }

  // 子记忆没了，就把它从整合记忆的 children 里摘掉
  // 整合记忆的时间 = 自己和子记忆里最早/最晚的那个
  syncMergedTime(item) {
    if (!item || item.layer !== 'merged' || !item.children?.length) return;
    const kids = this.items.filter((x) => item.children.includes(x.id));
    if (!kids.length) return;
    // createdAt 是"这条记忆是什么时候形成的"，永远不改
    const last = Math.max(item.lastAt || 0, ...kids.map((k) => k.lastAt || 0));
    if (last && last !== item.lastAt) item.lastAt = last;
  }

  // 它统辖着哪些（还活着的）
  childrenOf(item) {
    if (!item?.children?.length) return [];
    return item.children.map((id) => this.items.find((x) => x.id === id)).filter(Boolean);
  }

  pruneChildren(id) {
    let n = 0;
    for (const m of this.items) {
      if (m.layer === 'merged' && Array.isArray(m.children) && m.children.includes(id)) {
        m.children = m.children.filter((x) => x !== id);
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
  }

  remove(id) {
    const n = (() => {
    const n = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== n) this.dirty = true;
    return n - this.items.length;})();
    if (n) {
      this.pruneChildren(id);
      for (const p of this.items) if (p.layer === 'merged') this.syncMergedTime(p);
    }
    return n;
  }

  stats() {
    const byLayer = {};
    for (const m of this.items) {
      byLayer[m.layer] = (byLayer[m.layer] || 0) + 1;
    }
    return {
      total: this.items.length,
      byLayer,
      byKind: byLayer, // 兼容旧面板
      forgotten: this.stats_.forgotten,
      consolidated: this.stats_.consolidated,
      merged: this.mergedCount || 0,
      avgStabilityHours: this.items.length
        ? Math.round(this.items.reduce((s, m) => s + m.stability, 0) / this.items.length)
        : 0,
    };
  }
}