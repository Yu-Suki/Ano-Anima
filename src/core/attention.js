// 群聊注意力：判断一条消息跟她有多大关系
// 核心不是关键词，是"话轮"——她是不是这个话题里正在被回应的人
import { tokenize } from '../util/tokenize.js';

const MAX_TRACK = 14;

const QUESTION_RE = /[?？]|吗|么|呢|怎么|为什么|啥|什么|哪|谁|多少|几|是不是|能不能|要不要|有没有/;

export class Attention {
  constructor({ brain, selfNames = [] }) {
    this.brain = brain;
    this.selfNames = selfNames.filter(Boolean).map((s) => String(s));
    this.tracks = new Map();
  }

  setSelfNames(names) {
    this.selfNames = (names || []).filter(Boolean).map((s) => String(s));
  }

  observe(groupId, { from, text, mine = false, id = null }) {
    const arr = this.tracks.get(String(groupId)) || [];
    arr.push({ from, text: String(text || ''), mine, at: Date.now(), id });
    while (arr.length > MAX_TRACK) arr.shift();
    this.tracks.set(String(groupId), arr);
  }

  track(groupId) {
    return this.tracks.get(String(groupId)) || [];
  }

  /**
   * 打分。返回 { score, reasons }
   * 每个加分项都是可读的，出问题能解释为什么回/不回
   */
  score(groupId, { text, from, isReplyToMe = false, atOthers = false, atAll = false }) {
    const s = String(text || '').trim();
    const reasons = [];
    let score = 0;
    const track = this.track(groupId);

    // ---------- 话轮状态 ----------
    let lastMineIdx = -1;
    for (let i = track.length - 1; i >= 0; i--) {
      if (track[i].mine) {
        lastMineIdx = i;
        break;
      }
    }
    const afterMe = lastMineIdx >= 0 ? track.slice(lastMineIdx + 1) : [];
    const myLastLine = lastMineIdx >= 0 ? track[lastMineIdx].text : '';
    // 我最后说的那句还没被别人接走
    const inMyTurn = lastMineIdx >= 0 && afterMe.length <= 1;

    // 1. 直接叫名字
    const mentioned = this.selfNames.some((n) => s.includes(n));
    if (mentioned) {
      score += 0.55;
      reasons.push('叫了我名字');
    }

    // 2. 引用/回复的是我的话
    if (isReplyToMe) {
      score += 0.6;
      reasons.push('在回我的话');
    }

    // 3. 明确 @ 了别人 —— 最强排除信号
    if (atOthers && !mentioned) {
      score -= 0.55;
      reasons.push('@了别人');
    }

    // 4. @全体 —— 跟我有关，但不算冲我来
    if (atAll) {
      score += 0.15;
      reasons.push('@全体');
    }

    // 5. 轮到我了：我刚说的话还没人接，这时对方开口大概率是冲我
    if (inMyTurn && !mentioned && !atOthers) {
      score += 0.42;
      reasons.push('我刚说完还没人接');
    }

    // 6. 我还在话轮里，对方用了"你"
    if (inMyTurn && /你/.test(s) && !atOthers) {
      score += 0.22;
      reasons.push('说了"你"，我在等回应');
    }

    // 7. 我上句是问句，这条像在回答
    if (QUESTION_RE.test(myLastLine) && s.length <= 60 && !atOthers) {
      score += 0.25;
      reasons.push('在回我问的问题');
    }

    // 8. 同一人追着我说
    if (afterMe.length >= 1 && afterMe[afterMe.length - 1].from === from && !atOthers) {
      score += 0.12;
      reasons.push('追着我说话');
    }

    // 9. 接着我具体说过的话（词面重合）
    const mineLines = track.filter((m) => m.mine).slice(-3);
    if (mineLines.length) {
      const incoming = tokenize(s);
      let bestHit = 0;
      for (const m of mineLines) {
        const t = tokenize(m.text);
        let hit = 0;
        for (const tok of incoming) if (t.has(tok) || m.text.includes(tok)) hit++;
        bestHit = Math.max(bestHit, hit);
      }
      if (bestHit >= 1) {
        score += Math.min(0.3, 0.15 + 0.08 * bestHit);
        reasons.push(`接着我的话（${bestHit} 个词）`);
      }
    }

    // 10. 话题相关性（只读，不因打分而巩固记忆）
    if (this.brain && s.length >= 4) {
      const hits = this.brain.recall(s, { limit: 3, reinforce: false });
      if (hits.length) {
        score += Math.min(0.2, hits[0].weight / 56);
        reasons.push(`聊到我记得的事「${hits[0].text.slice(0, 12)}」`);
      }
    }

    // 11. 是问句
    if (QUESTION_RE.test(s)) {
      score += 0.1;
      reasons.push('是问句');
    }

    // 12. 明显在叫别人
    const others = [...new Set(track.filter((m) => !m.mine).map((m) => m.from))];
    if (!mentioned && others.some((n) => n && n !== from && s.includes(n))) {
      score -= 0.18;
      reasons.push('在叫别人');
    }

    // 13. 太短没信息量
    if (s.replace(/\s/g, '').length <= 2 && !mentioned) {
      score -= 0.2;
      reasons.push('太短');
    }

    return { score: Math.max(0, Math.min(1, score)), reasons };
  }
}

/** 是否出手：过线直接回；差一点时给个小概率 */
export function shouldReply(score, { threshold = 0.55, softThreshold = 0.3, softChance = 0.12 } = {}) {
  if (score >= threshold) return { reply: true, why: '过线' };
  if (score >= softThreshold && Math.random() < softChance * (score / threshold)) {
    return { reply: true, why: '差一点，赌一把' };
  }
  return { reply: false, why: '不够相关' };
}