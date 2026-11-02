import { envNum } from '../util/env.js';
// 情绪状态：会随时间回落，会被互动推动
// 不是"真的情感"，是一个让语气和节奏有起伏的状态机
const NEUTRAL = { valence: 0.1, energy: 0.65 };

// 恢复速度、上限、各种消耗都能在面板里改。
// 每次用到时才读环境变量，所以改完立刻生效，不用重启。

const POSITIVE = ['哈哈', '笑死', '谢谢', '爱你', '厉害', '牛', '好耶', '开心', '喜欢', '棒', '赞', '抱抱'];
const NEGATIVE = ['滚', '烦', '闭嘴', '蠢', '垃圾', '讨厌', '傻', '气', '无语', '恶心', '烂'];

export class Mood {
  constructor({ store, file = 'mood.json' } = {}) {
    this.store = store;
    this.file = file;
    this.valence = NEUTRAL.valence;
    this.energy = NEUTRAL.energy;
    this.updatedAt = Date.now();
    this.recent = []; // 最近的刺激，给界面看
    // 情绪冲击的起点：自然恢复从这里往回走
    this.valenceRef = NEUTRAL.valence;
  }

  // ---------- 可调参数（改完立即生效） ----------
  /** 精力：从空到满需要多少小时（线性，写多少就是多少） */
  get energyFullHours() {
    return clamp(envNum('MOOD_ENERGY_RECOVER_HOURS', 6), 0.1, 720);
  }

  /** 精力最高能自然回到百分之多少（100 = 满） */
  get energyCap() {
    return clamp(envNum('MOOD_ENERGY_RECOVER_CAP', 100) / 100, 0, 1);
  }

  /** 情绪：从最差完全平复需要多少小时 */
  get valenceFullHours() {
    return clamp(envNum('MOOD_VALENCE_RECOVER_HOURS', 6), 0.1, 720);
  }

  /** 情绪最多能自己修复百分之多少（100 = 能完全平复） */
  get selfRecover() {
    return clamp(envNum('MOOD_SELF_RECOVER_PERCENT', 20) / 100, 0, 1);
  }

  /** 不同情况消耗多少精力（配置里写百分数，2 就是 2%） */
  energyCost(kind = 'reply') {
    const table = {
      reply: ['MOOD_COST_REPLY', 2], // 说一句话
      tool: ['MOOD_COST_TOOL', 2], // 调一次工具（查、发、改）
    };
    const [key, def] = table[kind] || table.reply;
    return Math.max(0, envNum(key, def)) / 100;
  }

  /** 说话、做事都要消耗精力 */
  drain(amount = 0.02) {
    this.energy = clamp(this.energy - Math.abs(amount), 0, 1);
    this.updatedAt = Date.now();
    return this.energy;
  }

  async load() {
    try {
      const d = await this.store.read(this.file, null);
      if (d) {
        this.valence = clamp(d.valence ?? NEUTRAL.valence, -1, 1);
        this.valenceRef = clamp(d.valenceRef ?? d.valence ?? NEUTRAL.valence, -1, 1);
        this.energy = clamp(d.energy ?? NEUTRAL.energy, 0, 1);
        this.updatedAt = d.updatedAt ?? Date.now();
        this.recent = Array.isArray(d.recent) ? d.recent.slice(-12) : [];
        this.tick();
      }
    } catch (err) {
      // 读不出来就保持默认值，但标记为只读，避免覆盖原文件
      this.readonly = true;
      this.loadError = err.message;
    }
    return this;
  }

  async save() {
    if (this.readonly) return;
    await this.store.write(this.file, {
      valence: this.valence,
      valenceRef: this.valenceRef,
      energy: this.energy,
      updatedAt: this.updatedAt,
      recent: this.recent.slice(-12),
    });
  }

  /** 时间的作用：精力会回满，心情只会自己回到 80% */
  tick(now = Date.now()) {
    const hours = Math.max(0, (now - this.updatedAt) / 3600000);
    if (hours <= 0) return;

    // 精力：线性回涨。写 "6 小时" 就是从空到满正好 6 小时。
    const cap = this.energyCap;
    if (this.energy < cap) {
      this.energy = Math.min(cap, this.energy + hours / this.energyFullHours);
    }

    // 情绪：线性朝中性走，同样"写几小时就几小时走完全程"，
    // 但最多只走 selfRecover 那一部分，剩下的留着等人来哄。
    // 用"更极端的那个"当起点：手动改过 valence 也不会失准
    const neutral = NEUTRAL.valence;
    const ref =
      Math.abs((this.valenceRef ?? neutral) - neutral) >= Math.abs(this.valence - neutral)
        ? this.valenceRef ?? neutral
        : this.valence;
    const span = Math.abs(neutral - ref);
    if (span > 1e-6) {
      const target = neutral + (ref - neutral) * (1 - this.selfRecover);
      const speed = span / this.valenceFullHours; // 每小时走多少
      const dir = Math.sign(target - this.valence);
      if (dir !== 0) {
        this.valence += dir * speed * hours;
        this.valence =
          dir > 0
            ? Math.min(this.valence, target)
            : Math.max(this.valence, target);
      }
    }

    this.updatedAt = now;
  }

  /** 一句话影响情绪 */
  feel(text, { fromOwner = false } = {}) {
    const s = String(text || '');
    let dv = 0;
    for (const w of POSITIVE) if (s.includes(w)) dv += 0.08;
    for (const w of NEGATIVE) if (s.includes(w)) dv -= 0.12;
    if (fromOwner) dv *= 1.3; // 主人的话更影响心情

    // 心情归心情，精力归精力：被夸不会让人不累，所以这里不动精力
    const de = 0;

    this.valence = clamp(this.valence + dv, -1, 1);
    // 记下这次情绪冲击到了哪个位置：自然恢复是从这里往回走的
    if (dv !== 0) this.valenceRef = this.valence;
    this.energy = clamp(this.energy + de, 0, 1);   // 不能因为一次情绪波动就把精力抬回 5%
    this.updatedAt = Date.now();

    if (dv !== 0) {
      this.recent.push({ at: Date.now(), dv: Number(dv.toFixed(2)), text: s.slice(0, 30) });
      this.recent = this.recent.slice(-12);
    }
    return { dv, de };
  }

  /** 手动设定（界面上拖动滑块） */
  set({ valence, energy }) {
    if (Number.isFinite(valence)) {
      this.valence = clamp(valence, -1, 1);
      this.valenceRef = this.valence;
    }
    if (Number.isFinite(energy)) this.energy = clamp(energy, 0, 1);
    this.updatedAt = Date.now();
  }

  label() {
    const v = this.valence;
    const e = this.energy;
    if (e < 0.22) return '困';
    if (v > 0.45) return '心情不错';
    if (v > 0.1) return '平静';
    if (v > -0.25) return '有点无聊';
    return '烦躁';
  }

  /** 注入 prompt 的一句话 */
  describe() {
    const v = this.valence;
    const e = this.energy;
    const body = [];
    const heart = [];

    // 只描述"身上什么感觉"，不告诉她该怎么说话
    if (e < 0.2) {
      body.push('眼皮很沉，抬起来有点费劲');
      body.push('脑子转得慢，一句话要想一下才出得来');
    } else if (e < 0.45) {
      body.push('身上发懒，不太想动');
      body.push('说话有点提不起劲');
    } else if (e < 0.7) {
      body.push('身上还撑得住，没有特别累');
    } else {
      body.push('身体是轻的，说话不费劲');
    }

    if (v > 0.5) {
      heart.push('心里是松的，看什么都顺眼');
      heart.push('有点想找人说话');
    } else if (v > 0.15) {
      heart.push('心里平平静静');
    } else if (v > -0.2) {
      heart.push('心里有点空，说不上来为什么');
    } else if (v > -0.5) {
      heart.push('心里堵着一口气，不太想笑');
    } else {
      heart.push('心里很难受，不太想理人');
    }

    return `## 你现在的身体和心情\n- 身体：${body.join('，')}\n- 心里：${heart.join('，')}\n（这些只是你现在的感觉，怎么说话、说多少，你自己看着办）`;
  }

  /** 情绪影响回复速度：越懒越慢 */
  speedFactor() {
    let f = 1;
    f += (0.65 - this.energy) * 0.8; // 0.05 能量 → 约 1.5 倍慢
    f += this.valence < -0.3 ? 0.25 : 0;
    f -= this.valence > 0.5 ? 0.15 : 0;
    return clamp(f, 0.6, 2.2);
  }

  /** 情绪影响措辞温度 */
  temperatureBias() {
    if (this.valence < -0.35) return -0.15;
    if (this.valence > 0.45) return 0.1;
    return 0;
  }

  toJSON() {
    return {
      valence: Number(this.valence.toFixed(3)),
      energy: Number(this.energy.toFixed(3)),
      label: this.label(),
      describe: this.describe(),
      updatedAt: this.updatedAt,
      recent: this.recent.slice(-8),
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}