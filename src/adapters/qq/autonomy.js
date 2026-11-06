// 自主行为：由"内在需求"驱动，不是掷骰子。
//
// 旧版是每 10 分钟掷一次 25% 的骰子，中了才去问模型想干嘛 —— 那不叫自主，叫抽奖。
// 现在改成：四条需求各自按不同速度往上攒，哪条先攒满 100，就由它决定做什么。
// 什么时候动、为什么动，都能算得出来、说得清楚。
//
// 频率由"活力值"约束：活力每天刷新一次，只有"聊天 / 查资料"以外的事才扣。
// 精力耗尽自然就停了，不需要硬编码"一天最多几件"。
import { envNum } from '../../util/env.js';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isAsleep } from '../../text/humanize.js';

const HOUR = 3600000;
const FULL = 100;


// 每条需求攒的速度可以在面板改，改完立即生效
const RATE_KEY = {
  boredom: 'AUTONOMY_RATE_BOREDOM',
  social: 'AUTONOMY_RATE_SOCIAL',
  expression: 'AUTONOMY_RATE_EXPRESSION',
  curiosity: 'AUTONOMY_RATE_CURIOSITY',
};

// 每件事扣多少活力，同样可以改
const COST_KEY = {
  signature: 'AUTONOMY_COST_SIGNATURE',
  avatar: 'AUTONOMY_COST_AVATAR',
  card: 'AUTONOMY_COST_CARD',
  message: 'AUTONOMY_COST_MESSAGE',
  moment: 'AUTONOMY_COST_MOMENT',
  diary: 'AUTONOMY_COST_DIARY',
  search: 'AUTONOMY_COST_SEARCH',
  tidy: 'AUTONOMY_COST_TIDY',
  review: 'AUTONOMY_COST_REVIEW',
};

// 四条需求，各自攒的速度（每分钟）
const DRIVES = {
  boredom: { zh: '无聊', rate: 1.0, hint: '没人理，闲得慌' },
  social: { zh: '社交欲', rate: 0.5, hint: '想找人说说话' },
  expression: { zh: '表达欲', rate: 0.4, hint: '心里有话想说' },
  curiosity: { zh: '好奇', rate: 0.3, hint: '想知道点什么' },
};

// 每件事：属于哪条需求、扣多少活力、多久冷却
// 活力只扣"聊天查资料以外"的事；发消息和搜索不扣。
const ACTIONS = {
  signature: { drive: 'expression', vitality: 10, cooldown: 0, desc: '改个性签名', content: true },
  avatar: { drive: 'boredom', vitality: 25, cooldown: 0, desc: '换一张头像' },
  card: { drive: 'expression', vitality: 10, cooldown: 0, desc: '改群名片', content: true },
  message: { drive: 'social', vitality: 0, cooldown: 0, desc: '主动找主人说话', content: true },
  group_message: { drive: 'social', vitality: 0, cooldown: 0, desc: '在群里说句话', content: true },
  poke: { drive: 'boredom', vitality: 8, cooldown: 0, desc: '戳一戳某个人', content: true },
  moment: { drive: 'expression', vitality: 20, cooldown: 0, desc: '发一条说说', content: true },
  diary: { drive: 'expression', vitality: 5, cooldown: 0, desc: '写一篇日记（只存本地）', content: true },
  search: { drive: 'curiosity', vitality: 0, cooldown: 0, desc: '去搜个好奇的东西', content: true },
  tidy: { drive: 'curiosity', vitality: 5, cooldown: 0, desc: '整理一遍记忆' },
  review: { drive: 'curiosity', vitality: 3, cooldown: 0, desc: '翻翻以前的事' },
  nothing: { drive: null, vitality: 0, cooldown: 0, desc: '什么都不做' },
};

export class Autonomy {
  constructor({ llm, tools, brain, mood, state, cfg, log = () => {}, dataDir, isAsleepFn = null, onSpoke = null }) {
    this.llm = llm;
    this.tools = tools;
    this.brain = brain;
    this.mood = mood;
    this.state = state;
    this.cfg = cfg;
    this.log = log;
    this.isAsleepFn = isAsleepFn;
    this.onSpoke = onSpoke || null;   // 自己开口之后，告诉外面一声（记进上下文）

    this.file = join(dataDir, 'autonomy.json');
    this.diaryDir = join(dataDir, 'diary');

    this.enabled = String(process.env.AUTONOMY ?? 'false') === 'true';
    this.threshold = Number(process.env.AUTONOMY_THRESHOLD || FULL);
    this.vitalityMax = Number(process.env.AUTONOMY_VITALITY_MAX || FULL);
    this.resetHour = Number(process.env.AUTONOMY_VITALITY_RESET_HOUR || 4);

    // 四条需求，0 ~ 100
    this.drives = { boredom: 0, social: 0, expression: 0, curiosity: 0 };
    this.vitality = this.vitalityMax;
    this.vitalityDay = '';

    this.lastActed = {};
    this.history = [];
    this.lastActivityAt = Date.now();
    this.lastTickAt = Date.now();

    // 每分钟算一次需求：只有攒满才可能去问模型，所以平时几乎零开销
    this.tickMs = Number(process.env.AUTONOMY_TICK_MIN || 1) * 60000;
    this.timer = null;
    this.busy = false;
  }

  // ---------- 存取 ----------
  async load() {
    try {
      const d = JSON.parse(await readFile(this.file, 'utf8'));
      if (d.drives) Object.assign(this.drives, d.drives);
      this.vitality = Number(d.vitality ?? this.vitalityMax);
      this.vitalityDay = d.vitalityDay || '';
      this.lastActed = d.lastActed || {};
      this.history = d.history || [];
      this.lastActivityAt = d.lastActivityAt || Date.now();
    } catch {
      /* 第一次跑 */
    }
    // 启动时把活力按新的一天校正一次
    this.#refreshVitality();
    return this;
  }

  async save() {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(
        this.file,
        JSON.stringify(
          {
            drives: this.drives,
            vitality: this.vitality,
            vitalityDay: this.vitalityDay,
            lastActed: this.lastActed,
            lastActivityAt: this.lastActivityAt,
            history: this.history.slice(-40),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* 存不下就算了 */
    }
  }

  // ---------- 生命周期 ----------
  start() {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        // QQ 掉线的时候每次 tick 都会失败，日志里刷屏没意义，只提一次
        if (/未连接/.test(e.message)) {
          if (!this._offlineWarned) {
            this._offlineWarned = true;
            this.log('warn', 'QQ 不在线，自主行为先停着（连上后自动恢复）');
          }
          return;
        }
        this._offlineWarned = false;
        this.log('warn', `自主行为出错：${e.message}`);
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (on) this.lastTickAt = Date.now();
    return this.enabled;
  }

  /** 有人跟她说话：把相关需求压下去 */
  noteActivity() {
    this.lastActivityAt = Date.now();
    this.drives.boredom = 0;
    this.drives.social = Math.max(0, this.drives.social - 50);
    this.drives.curiosity = Math.max(0, this.drives.curiosity - 10);
  }

  /**
   * 她自己说了一句：社交欲会降一点（说过了就不那么想说了）。
   * 一句降 6，聊天越多降得越多；说话不扣活力，只降需求。
   */
  noteReply(n = 1) {
    const cut = 6 * Math.max(1, Number(n) || 1);
    this.drives.social = Math.max(0, this.drives.social - cut);
    this.lastActivityAt = Date.now();
  }

  /** 把她主动做的事记下来，让她自己也"知道"（kind=initiative） */
  #report(text, where = {}) {
    try { if (this.onSpoke) this.onSpoke(text, where, 'initiative'); } catch {}
  }

  // ---------- 活力值 ----------
  #dayKey(now = Date.now()) {
    const d = new Date(now);
    if (d.getHours() < this.resetHour) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  #refreshVitality(now = Date.now()) {
    const key = this.#dayKey(now);
    if (key === this.vitalityDay) return false;
    const before = this.vitality;
    this.vitalityDay = key;
    this.vitality = this.vitalityMax;
    if (before !== this.vitality) {
      this.log('info', `活力值刷新：${Math.round(before)} → ${this.vitality}`);
    }
    return true;
  }

  // ---------- 需求积累 ----------
  rateOf(driveKey) {
    return Math.max(0, envNum(RATE_KEY[driveKey], DRIVES[driveKey].rate));
  }

  costOf(actionKey) {
    return Math.max(0, envNum(COST_KEY[actionKey], ACTIONS[actionKey].vitality));
  }

  #advance(minutes) {
    // 睡着了，需求不涨（人睡觉不会越来越想聊天）
    try { if (typeof this.isAsleepFn === 'function' && this.isAsleepFn()) return; } catch {}
    if (minutes <= 0) return;
    // 情绪越强烈，越想表达
    const emo = 1 + Math.abs(this.mood?.valence ?? 0);
    for (const k of Object.keys(DRIVES)) {
      const rate = k === 'expression' ? this.rateOf(k) * emo : this.rateOf(k);
      this.drives[k] = Math.min(FULL, this.drives[k] + rate * minutes);
    }
  }

  #topDrive() {
    let key = 'boredom';
    let value = -1;
    for (const [k, v] of Object.entries(this.drives)) {
      if (v > value) {
        key = k;
        value = v;
      }
    }
    return { key, value, zh: DRIVES[key].zh, hint: DRIVES[key].hint };
  }

  // ---------- 能不能做 ----------
  /** 花活力做一件事（工具里用到），返回剩余活力；不够就不做 */
  spend(action) {
    const cost = this.costOf(action);
    if (this.vitality < cost) return null;
    this.vitality = Math.max(0, this.vitality - cost);
    this.lastActed[action] = Date.now();
    this.save?.();
    return Math.round(this.vitality);
  }

  canDo(action) {
    const a = ACTIONS[action];
    if (!a) return false;
    const last = this.lastActed[action] || 0;
    if (Date.now() - last < a.cooldown) return false;
    if (this.vitality < this.costOf(action)) return false;
    return true;
  }

  // ---------- 主循环 ----------
  async tick(now = Date.now()) {
    const minutes = Math.max(0, (now - this.lastTickAt) / 60000);
    this.lastTickAt = now;

    if (!this.enabled || this.busy) return { skipped: '关着或正忙' };
    if (!this.llm.apiKey) return { skipped: '没有模型' };

    if (this.#refreshVitality(now)) await this.save();
    this.#advance(minutes);

    const asleep = this.isAsleepFn ? this.isAsleepFn() : isAsleep(this.cfg?.schedule);
    if (asleep) return { skipped: '睡着了，不动', drives: this.snapshot() };

    const top = this.#topDrive();
    if (top.value < this.threshold) {
      return { skipped: `还没憋够（${top.zh} ${Math.round(top.value)}/${this.threshold}）`, drives: this.snapshot() };
    }

    // 这条需求现在能做的事
    const eligible = Object.keys(ACTIONS).filter(
      (k) => ACTIONS[k].drive === top.key && this.canDo(k),
    );

    if (!eligible.length) {
      // 想动但没本钱/都在冷却：压一压，别每 10 分钟重复问
      this.drives[top.key] = Math.max(0, this.drives[top.key] - 15);
      await this.save();
      return { skipped: `${top.zh}满了，但没活力或都在冷却`, drives: this.snapshot() };
    }

    this.busy = true;
    try {
      const choice = await this.#decide(top, eligible);
      if (!choice || choice.action === 'nothing') {
        this.drives[top.key] = Math.max(0, this.drives[top.key] - 15);
        this.history.push({ at: Date.now(), action: 'nothing', drive: top.key, reason: choice?.reason || '' });
        await this.save();
        return { action: 'nothing', drives: this.snapshot() };
      }

      const meta = ACTIONS[choice.action];
      const cost = this.costOf(choice.action);   // group_message 的消耗读 AUTONOMY_COST_GROUP_MESSAGE（默认 5）
      const result = await this.#act(choice);
      const ok = result?.ok !== false;

      this.vitality = Math.max(0, this.vitality - cost);
      // 社交欲做完清空；表达欲/无聊/好奇各降 60~100
      this.drives[top.key] = Math.max(0, this.drives[top.key] - 100);
      // 做成一件事，别的念想也顺带淡一点
      for (const k of Object.keys(this.drives)) {
        if (k !== top.key) this.drives[k] = Math.max(0, this.drives[k] - 10);
      }
      this.lastActed[choice.action] = Date.now();
      this.history.push({
        at: Date.now(),
        action: choice.action,
        drive: top.key,
        content: choice.content || '',
        reason: choice.reason || '',
        vitalityLeft: this.vitality,
        result: ok ? '成功' : '失败',
      });
      await this.save();

      this.log(
        'ok',
        `自主行为（${top.zh}满了）：${meta.desc} —— ${choice.content || ''}` +
          ` ${ok ? '' : '（失败）'} ｜ 活力剩 ${this.vitality}`,
      );
      return { action: choice.action, content: choice.content, vitality: this.vitality, result };
    } finally {
      this.busy = false;
    }
  }

  // ---------- 让她自己挑 ----------
  async #decide(top, eligible) {
    const driveLines = Object.entries(this.drives)
      .map(([k, v]) => `${DRIVES[k].zh} ${Math.round(v)}`)
      .join('、');

    const recent = this.history
      .slice(-5)
      .map((h) => `${ACTIONS[h.action]?.desc || h.action}${h.content ? `：${h.content}` : ''}`);

    // 最近真正被想起过的几条记忆（不再用关键词乱搜）
    const learned = this.brain && this.brain.items
      ? [...this.brain.items]
          .filter((m) => m.layer !== 'merged')
          .sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0))
          .slice(0, 3)
          .map((m) => String(m.text).slice(0, 24))
          .join('；')
      : '';


    const prompt = `我是「阿糯」，现在一个人待着。

我的状态：心情「${this.mood ? this.mood.label() : '平静'}」，精力 ${this.mood ? Math.round(this.mood.energy * 100) : 50}%。
我现在最强烈的念头是「${DRIVES[top.key].zh}」——${DRIVES[top.key].hint}。
其余念头：${driveLines}。
今天还剩多少活力：${this.vitality}（做要花活力的事会扣，说话和查东西不扣）。
最近做过：${recent.length ? recent.join('；') : '没什么'}。
我最近说过的话（这些别再重复了）：${this.state.lastSaid || '（还没说过）'}。
说一件今天真实发生的事，或者我最近真正在想、但还没说过的事。别接着自己上一句往下绕。
我记得：${learned || '刚认识'}。

这个念头推着我想做点什么，可以选：
${eligible.map((a) => `- ${a}：${ACTIONS[a].desc}（耗活力 ${this.costOf(a)}）`).join('\n')}
- nothing：算了，不想做

选一个我此刻真的想做的；不想做就选 nothing，别为了做而做。
只输出 JSON：
{"action":"从上面选一个","content":"要写的话（40 字内）","reason":"为什么想做，一句话"}`;

    const res = await fetch(`${this.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: this.llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.2,
        stream: false,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';

    try {
      const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (!eligible.includes(obj.action) && obj.action !== 'nothing') {
        return { action: 'nothing', reason: '模型选了个不可用的' };
      }
      return obj;
    } catch {
      return { action: 'nothing', reason: '解析失败' };
    }
  }

  // ---------- 执行 ----------
  async #act(choice) {
    const ctx = {
      selfId: this.state.bot?.selfId || '',
      isOwner: true,
      groupId: null,
      userId: process.env.OWNER_QQ || '',
      senderId: process.env.OWNER_QQ || '',
    };

    const call = async (toolName, args) => {
      const t = this.tools.byName.get(toolName);
      if (!t) throw new Error(`没有工具 ${toolName}`);
      return t.run(args, ctx);
    };

    const said = String(choice.content || '');
    if (said) { this.state.lastSaid = said; }

    switch (choice.action) {
      case 'signature': {
        const txt = (said || '今天也没什么想说的').slice(0, 30);
        const r = await call('qq_set_signature', { text: txt });
        this.#report('（我自己改了签名：' + txt + '）');
        return r;
      }

      case 'avatar': {
        const r = await call('qq_set_avatar', {});
        this.#report('（我自己换了个头像）');
        return r;
      }

      case 'moment': {
        const txt = said.slice(0, 120);
        const r = await call('qq_post_moment', { text: txt, visibility: 'private' });
        this.#report('（我自己发了条说说：' + txt + '）');
        return r;
      }

      case 'card': {
        const gid = process.env.AUTONOMY_GROUP_ID || '';
        if (!gid) return { ok: false, error: '没配 AUTONOMY_GROUP_ID' };
        const card = (said || '阿糯').slice(0, 12);
        const r = await call('qq_set_card', { group_id: gid, card });
        this.#report('（我自己改了群名片：' + card + '）', { groupId: gid });
        return r;
      }

      case 'group_message': {
        const gid = process.env.AUTONOMY_GROUP_ID || '';
        if (!gid) return { ok: false, error: '没配 AUTONOMY_GROUP_ID' };
        const txt = (said || '在群里冒个泡').slice(0, 60);
        this.log && this.log('info', '自主发群：说「' + txt.slice(0, 40) + '」');
        const r = await call('qq_send_text', { group_id: gid, text: txt });
        try { if (this.onSpoke) this.onSpoke(txt, { groupId: gid }, 'initiative'); } catch {}
        return r;
      }

      case 'message': {
        const owner = process.env.OWNER_QQ || '';
        if (!owner) return { ok: false, error: '没配 OWNER_QQ' };
        const txt = (said || '在干嘛').slice(0, 40);
        const r = await call('qq_send_text', { user_id: owner, text: txt });
        try { if (this.onSpoke) this.onSpoke(txt, { userId: owner }, 'initiative'); } catch {}
        return r;
      }

      case 'poke': {
        // 找一个可以戳的人：最近聊过的人 > 群里的人 > 主人
        let target = String(choice.targetUin || '').trim();
        if (!target) {
          const recent = (this.state.recentPeople || []).filter((x) => x && x !== this.state.bot?.selfId);
          target = String(recent[0] || process.env.OWNER_QQ || '');
        }
        if (!target) return { ok: false, error: '没有可以戳的人' };
        const r = await call('qq_poke', { user_id: target });
        this.#report('（我自己戳了 ' + target + ' 一下）');
        return r;
      }

      case 'search': {
        const q = said || '最近有什么新鲜事';
        return call('web_search', { query: q });
      }

      // ---- 下面这些不碰 QQ，掉线也能做 ----
      case 'diary': {
        await mkdir(this.diaryDir, { recursive: true });
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const line = `\n## ${time}\n\n${said || '（今天没写什么）'}\n`;
        await appendFile(join(this.diaryDir, `${stamp}.md`), line, 'utf8');
        return { ok: true, saved: join(this.diaryDir, `${stamp}.md`) };
      }

      case 'tidy': {
        if (!this.brain?.dedupeAll) return { ok: false, error: '记忆模块不支持整理' };
        const r = this.brain.dedupeAll({ dryRun: false });
        if (r.removed) await this.brain.save().catch(() => {});
        return { ok: true, removed: r.removed, groups: r.groups };
      }

      case 'review': {
        if (!this.brain) return { ok: false, error: '没有记忆' };
        const all = this.brain.items || [];
        if (!all.length) return { ok: true, recalled: 0 };
        const picks = [];
        for (let i = 0; i < Math.min(3, all.length); i++) {
          picks.push(all[Math.floor(Math.random() * all.length)]);
        }
        for (const m of picks) this.brain.reinforce(m);
        return { ok: true, recalled: picks.length, texts: picks.map((m) => m.text) };
      }

      default:
        return { ok: false, error: '未知动作' };
    }
  }

  /** 把"从上次 tick 到现在"的时间也补上，面板看到的才是实时值 */
  #projected(now = Date.now()) {
    const minutes = Math.max(0, (now - this.lastTickAt) / 60000);
    const emo = 1 + Math.abs(this.mood?.valence ?? 0);
    const out = {};
    for (const k of Object.keys(DRIVES)) {
      const base = this.rateOf(k);
      const rate = k === 'expression' ? base * emo : base;
      out[k] = Math.min(FULL, this.drives[k] + rate * minutes);
    }
    return out;
  }

  // ---------- 手动设定（面板里拖滑块） ----------
  setDrives(obj = {}) {
    for (const k of Object.keys(DRIVES)) {
      if (obj[k] == null) continue;
      const v = Number(obj[k]);
      if (Number.isFinite(v)) this.drives[k] = Math.max(0, Math.min(FULL, v));
    }
    this.lastTickAt = Date.now();
    return this.snapshot();
  }

  setVitality(v) {
    const n = Number(v);
    if (Number.isFinite(n)) {
      this.vitality = Math.max(0, Math.min(this.vitalityMax, n));
      this.vitalityDay = this.#dayKey();
    }
    return this.vitality;
  }

  // ---------- 给界面看 ----------
  snapshot() {
    const live = this.#projected();
    const out = {};
    for (const [k, v] of Object.entries(live)) {
      out[k] = { zh: DRIVES[k].zh, value: Math.round(v), rate: this.rateOf(k) };
    }
    return out;
  }

  /** 照当前速度，还要多少分钟才会憋不住 */
  etaMinutes() {
    const live = this.#projected();
    let key = 'boredom';
    for (const [k, v] of Object.entries(live)) if (v > live[key]) key = k;
    const rate = DRIVES[key].rate;
    if (!rate) return null;
    return Math.round(Math.max(0, this.threshold - live[key]) / rate);
  }

  status() {
    const live = this.#projected();
    const snap = this.snapshot();
    // 最强烈的那条
    let topKey = 'boredom';
    for (const [k, v] of Object.entries(live)) if (v > live[topKey]) topKey = k;

    return {
      enabled: this.enabled,
      threshold: this.threshold,
      vitality: Math.round(this.vitality),
      vitalityMax: this.vitalityMax,
      vitalityResetHour: this.resetHour,
      drives: snap,
      topDrive: { key: topKey, value: Math.round(live[topKey]), zh: DRIVES[topKey].zh, hint: DRIVES[topKey].hint },
      etaMinutes: this.etaMinutes(),
      idleMinutes: Math.floor((Date.now() - this.lastActivityAt) / 60000),
      todayCount: this.history.filter(
        (h) => h.at >= new Date().setHours(0, 0, 0, 0) && h.action !== 'nothing',
      ).length,
      lastActed: this.lastActed,
      history: this.history.slice(-10).reverse(),
    };
  }
}