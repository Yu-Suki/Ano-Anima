// 睡眠复盘：睡前/睡醒后，把今天的事过一遍
// 三件事：加权、合并、抽出新记忆（都带分数）
import 'dotenv/config';

function todayRange(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { from: d.getTime(), to: now };
}

// 一条整合记忆的层数：只含表层 = 1，含一级整合 = 2
function depthOf(memory, item) {
  if (!item || item.layer !== 'merged' || !item.children?.length) return 1;
  const kids = memory.all().filter((x) => item.children.includes(x.id));
  const inner = kids.filter((k) => k.layer === 'merged');
  return 1 + (inner.length ? Math.max(...inner.map((k) => depthOf(memory, k))) : 0);
}

export class Consolidator {
  constructor({ memory, llm, log = () => {} }) {
    this.memory = memory;
    this.llm = llm;
    this.log = log;
  }

  async #ask(prompt) {
    const res = await fetch(this.llm.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.llm.apiKey },
      body: JSON.stringify({
        model: this.llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        thinking: { type: 'disabled' },   // 不要思考过程，只要结果
      }),
    });
    if (!res.ok) throw new Error('LLM ' + res.status);
    const j = await res.json();
    return String(j.choices?.[0]?.message?.content || '').trim();
  }

  #parse(text) {
    const s = String(text).trim();
    // 先整段试试（模型返回的是对象）
    try { return JSON.parse(s); } catch {}
    // 再退回到抓大括号里的内容
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) { try { return JSON.parse(obj[0]); } catch {} }
    const arr = s.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch {} }
    return null;
  }

  /**
   * 一段对话结束了：把这几轮里产生的表层记忆，压成一条"整合记忆"
   * 整合记忆统辖这些表层记忆（children 里存它们的 id），原记忆保留
   */
  async summarizeSession({ convId, since, until = Date.now(), maxDepth = 1, subject = null, mergedOnly = false } = {}) {
    // 这段时间"被提起过"的记忆（lastAt 只在真正选中时更新，所以这就是本次聊到的）
    const pool = this.memory.all().filter((m) =>
      (m.layer === 'surface' || m.layer === 'merged') &&
      (m.lastAt || m.createdAt || 0) >= since &&
      (m.lastAt || m.createdAt || 0) <= until &&
      (subject == null || String(m.subject || m.whoName || '') === String(subject))
    );
    // 可用的下层素材：表层，加上不超过 maxDepth-1 的整合记忆
    const usableMerged = pool.filter((m) => m.layer === 'merged' && depthOf(this.memory, m) < maxDepth);
    // 表层记忆全都可以当素材（包括属于别的一级整合的）
    const kids = pool.filter((m) => m.layer === 'surface');   // 二层也能收表层（但不能是这次收进来的那层整合的子记忆）
    if (kids.length < 2 && usableMerged.length < 2) return [];

    const level2 = mergedOnly && maxDepth >= 2;
    const prompt = [
      level2
        ? '下面是往上抽象的一批记忆（有表层，也有之前压好的整合）。'
        : '下面是刚才聊出来的记忆（表层记忆），也可能有之前压好的整合记忆。',
      level2
        ? '请从里面提炼出抽象的东西：'
        : '请把它们压成整合记忆：',
      ...(level2
        ? [
            '  · 只写抽象出来的东西：概念、事实、规律、我认定的事',
            '  · 一条不超过 30 字',
            '  · 跟这条没关系的不收进来（covers 里不写），它自己单独留着',
            '  · 一条至少要统辖 2 条记忆，否则不要建',
          ]
        : [
            '  · 一条概括只讲一件事：两件不相干的事拆成两条，不许糊在一起',
            '  · 把这几条压成一句话：尽量短，但能带的信息都带上',
            '  · 可以带结论，别写成评语',
            '  · 长短跟着内容走：短就短，该长就长，别为了短丢掉信息',
            '  · 素材能合几条就合几条，不必凑数，也别漏掉',
            '  · 跟这条整合没关系的记忆，不要收进来（covers 里不写它），它自己单独留着',
            '  · 一条整合至少要统辖 2 条记忆，否则不要建',
          ]),
      '概括（summary）：说清这条讲的是什么',
      '统辖（covers）：这条整合了上面哪几条，写序号',
      '只写这些记忆里有的东西，不要编造。',
      '只输出 JSON：',
      '{"items":[{"summary":"...","covers":[1,2],"weight":6}]}',
      '',
      [...kids, ...usableMerged]
        .map((m, i) => (i + 1) + '. ' + m.text).join('\n'),
    ].join('\n');

    let out;
    try { out = this.#parse(await this.#ask(prompt)); } catch (e) { this.log('warn', '整合失败：' + e.message); return []; }
    const list = Array.isArray(out?.items) ? out.items : [];
    if (!list.length) return [];

    const all = [...kids, ...usableMerged];
    const made = [];
    for (const it of list) {
      if (!it || !it.summary) continue;
      let covers = (it.covers || [])
        .map((n) => all[Number(n) - 1])
        .filter(Boolean)
        .map((m) => m.id)
        .filter(Boolean);
      // 模型没指出它统辖哪些 → 说明这些记忆各说各的，就别硬凑成一条
      if (covers.length < 2) { this.log('info', '这条整合只对上 ' + covers.length + ' 条，放弃'); continue; }
      // 这一条如果收了一级整合，就不能再收那些一级整合的子记忆
      const picked = covers.map((id) => this.memory.items.find((x) => x.id === id)).filter(Boolean);
      const pickedMerged = picked.filter((x) => x.layer === 'merged');
      if (pickedMerged.length) {
        const inside = new Set(pickedMerged.flatMap((m) => m.children || []));
        covers = covers.filter((id) => !inside.has(id));
      }
      // 已经有重叠很多的整合记忆：把那几条孩子并进去，别再建一条新的
      const overlap = this.memory.items.find((m) => {
        if (m.layer !== 'merged') return false;
        const old = new Set(m.children || []);
        if (!old.size) return false;
        // 两条整合记忆是"包含"关系（一条的孩子全在另一条里）才算同一条
        const whole = covers.every((id) => old.has(id));
        const reverse = (m.children || []).every((id) => covers.includes(id));
        return whole || reverse;
      });
      if (overlap) {
        const before = (overlap.children || []).length;
        overlap.children = [...new Set([...(overlap.children || []), ...covers])];
        if (overlap.children.length !== before) {
          this.log('info', '整合记忆并进去 ' + (overlap.children.length - before) + ' 条（已有相似的，没新建）');
          this.memory.dirty = true;
        } else {
          this.log('info', '已经有很像的整合记忆，跳过');
        }
        continue;
      }

      const item = this.memory.remember({
        layer: 'merged',
        text: String(it.summary).slice(0, 80),
        weight: Math.max(1, Math.min(10, Number(it.weight) || 6)),
        children: covers,
        depth: 1 + Math.max(0, ...covers.map((id) => {
          const k = this.memory.items.find((x) => x.id === id);
          return k && k.layer === 'merged' ? (Number(k.depth) || 1) : 0;
        })),
        source: 'summary',
      });
      made.push(item);
    }
    if (made.length) {
      this.log('ok', `整合记忆：${kids.length} 条表层 → ${made.length} 条整合`);
      await this.memory.save();
    }
    return made;
  }

  // 夜里：子记忆少了，概括要跟着改（名字/逻辑按剩下的子记忆重写）

  /**
   * 两条整合记忆是"包含"关系（一条的孩子全在另一条里）时，并成一条。
   * 夜里重新概括之后再跑，白天新建时已经拦过一次，这里是补历史数据。
   */
  async mergeSubsetMerged() {
    const list = this.memory.items.filter((m) => m.layer === 'merged' && (m.children || []).length);
    const drop = new Set();
    let mergedCount = 0;
    for (let i = 0; i < list.length; i++) {
      if (drop.has(list[i].id)) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (drop.has(list[j].id)) continue;
        const a = list[i], b = list[j];
        const A = new Set(a.children || []), B = new Set(b.children || []);
        if (!A.size || !B.size) continue;
        const aInB = [...A].every((x) => B.has(x));
        const bInA = [...B].every((x) => A.has(x));
        if (!aInB && !bInA) continue;
        // 保留孩子多、分数高的那条，另一条并进去
        const [keep, gone] = (A.size >= B.size ? [a, b] : [b, a]);
        keep.children = [...new Set([...(keep.children || []), ...(gone.children || [])])];
        if ((gone.weight || 0) > (keep.weight || 0)) keep.weight = gone.weight;
        keep.kidSig = '';                 // 让孩子数变了，下次会重新概括
        drop.add(gone.id);
        mergedCount++;
        this.log('info', '合并包含关系的整合记忆：删「' + String(gone.text).slice(0, 18) + '」，并进「' + String(keep.text).slice(0, 18) + '」');
      }
    }
    if (drop.size) {
      this.memory.items = this.memory.items.filter((m) => !drop.has(m.id));
      this.memory.dirty = true;
    }
    return mergedCount;
  }

  async refreshMerged() {
    const merged = this.memory.all().filter((m) => m.layer === 'merged' && (m.children || []).length);
    let changed = 0;
    for (const it of merged) {
      const kids = this.memory.childrenOf(it);
      if (kids.length < 1) continue;
      const sig = kids.map((k) => k.id).sort().join(',');
      if (it.kidSig === sig) continue;   // 子记忆没变（按 id 比，不按数量）   // 子记忆没变就不动
      const prompt = [
        '这条是我之前写下的整合记忆（概括）：',
        it.text,
        '',
        '但它下面的细节记忆现在只剩这些：',
        ['0. ' + it.text + '   （这条概括自己，也算一份材料）', ...kids.map((k, i) => (i + 1) + '. ' + k.text)].join('\n'),
        '',
        '请按现在剩下的内容，重写这条概括：',
        '  · 已经不在的事，不要提',
        '  · 还是一件事的说法要保留',
        '  · 概括宁可长一点，别丢信息',
        '  顺手给个分数（1~10），表示这条现在多重要',
        '只输出 JSON：{"summary":"...","weight":6}',
      ].join('\n');
      let out;
      try { out = this.#parse(await this.#ask(prompt)); } catch { continue; }
      if (!out?.summary) continue;
      const before = it.text;
      it.text = String(out.summary).slice(0, 300);
      it.kidSig = kids.map((k) => k.id).sort().join(',');
      if (out.weight) it.weight = Math.max(1, Math.min(10, Number(out.weight)));
      this.memory.dirty = true;
      changed++;
      this.log('info', '整合记忆改写：' + before.slice(0, 20) + ' → ' + it.text.slice(0, 20));
    }
    if (changed) await this.memory.save();
    // 概括完之后：把互为子集的整合记忆并掉
    try { const n = await this.mergeSubsetMerged(); if (n) this.log('ok', '并掉 ' + n + ' 条重复的整合记忆'); } catch (e) { this.log('warn', '合并整合记忆失败：' + e.message); }
    return changed;
  }

  // 夜里：把一级整合再压成二级（素材是一级整合 + 不属于它们的表层记忆）
  async deepMerge({ since } = {}) {
    return this.summarizeSession({ convId: 'night', since: since || (Date.now() - 24 * 3600 * 1000), maxDepth: 2, mergedOnly: true });   // 睡眠只做第二层
  }

  /**
   * 复盘今天：返回 { bumped, merged, created, dropped }
   */
  async review({ now = Date.now(), since = null } = {}) {
    const from = since || todayRange(now).from;
    // 从上一次醒来之后到现在，产生的和动过的都要
    const items = this.memory.all().filter((m) => ((m.lastAt || m.createdAt || 0) >= from));
    if (!items.length) return { bumped: 0, merged: 0, created: 0, dropped: 0 };

    // 只把"今天动过"的拿出来，最多 40 条，够模型看
    const sample = items.map((m, i) => ({
      i: i + 1,
      id: m.id,
      text: m.text,
      w: m.weight,
      layer: m.layer,
      layerOk: true,
    }));

    const prompt = [
      '我是记忆整理器。下面是今天动过的记忆。',
      '请做三件事：',
      '1) 重新给每条打分（1~10）：以后还重要吗？',
      '   - 涉及主人/家人/承诺/她的身份 → 至少 5',
      '   - 一次性的闲聊、噪声 → 1~2',
      '2) 指出哪些记忆**说的是完全同一件事**，可以合并（给出要保留的那条序号）',
      '   只有意思完全一致才合并；只是相关、只是提到同一个人，不要合并。',
      '   拿不准就别合并。',
      '3) 从这些事里，能不能总结出 1~3 条"新的认识"（比如"主人晚上常在忙"）',
      '   只写我从这些事里看出来的，不要编造。',
      '',
      '只输出 JSON：',
      '{"scores":[{"i":1,"w":6}],"merge":[{"keep":2,"drop":[3,4]}],"new":[{"text":"...","w":6,"why":"..."}]}',
      '',
      sample.map((m) => `${m.i}. [${m.w}分] ${m.text}`).join('\n'),
    ].join('\n');

    let out;
    try {
      const raw = await this.#ask(prompt);
      if (process.env.REVIEW_DEBUG) console.log('DEBUG 记忆 ' + items.length + ' 条 / 提示词 ' + prompt.length + ' 字 / 返回 ' + String(raw).length + ' 字');
      if (process.env.REVIEW_DEBUG) console.log('DEBUG 返回前 200: ' + String(raw).slice(0, 200));
      out = this.#parse(raw);
    } catch (e) {
      this.log('warn', '复盘失败：' + e.message);
      return { bumped: 0, merged: 0, created: 0, dropped: 0, error: e.message };
    }
    if (!out) return { bumped: 0, merged: 0, created: 0, dropped: 0 };

    let bumped = 0;
    let merged = 0;
    let dropped = 0;
    let created = 0;

    // 1) 调分
    for (const s of out.scores || []) {
      const item = sample[Number(s.i) - 1];
      if (!item) continue;
      const m = this.memory.items.find((x) => x.id === item.id);
      if (!m || m.layer === 'core') continue;
      const w = Math.max(0.5, Math.min(10, Number(s.w) || m.weight));
      if (Math.abs(w - m.weight) < 0.01) continue;
      m.weight = w;
      bumped += 1;
    }

    // 2) 合并
    for (const g of out.merge || []) {
      const keep = sample[Number(g.keep) - 1];
      if (!keep) continue;
      for (const idx of g.drop || []) {
        const d = sample[Number(idx) - 1];
        if (!d || d.id === keep.id) continue;
        const n = this.memory.remove(d.id);
        if (n) { merged += 1; dropped += n; }
      }
    }

    // 3) 新认识
    for (const n of (out.new || []).slice(0, 3)) {
      if (!n || !n.text) continue;
      this.memory.remember({
        layer: 'surface',
        text: String(n.text).slice(0, 60),
        weight: Math.max(0.5, Math.min(10, Number(n.w) || 5)),
        kind: 'fact',
        source: 'inferred',
        detail: String(n.why || '').slice(0, 80),
      });
      created += 1;
    }

    this.memory.dirty = true;
    await this.memory.save();
    this.log('ok', `睡眠复盘：调分 ${bumped} 条、合并 ${merged} 条、新认识 ${created} 条`);
    return { bumped, merged, created, dropped };
  }
}