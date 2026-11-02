import { sameFact } from './memory2.js';
// Agent：带工具调用 + 记忆 + 情绪的对话循环
const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 20;
const MAX_TOOL_RESULT_CHARS = 4000;

const RULES = '';   // 真正的内容在 prompts/core.md

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 没有大模型时用的兜底抽取规则
// 规则抽取：{who} 会被换成对方在这个场景里的称呼（主人/俞/小鲸鱼）
// 规则提取全部删掉：中文里「我有个…」「我喜欢什么…」几乎无法用正则区分陈述和提问，
// 误判成本远高于省下的那一次模型调用。记忆一律交给模型判断。

export class Agent {
  constructor({ llm, tools, persona, policy = {}, memory = null, mood = null, roster = null, vec = null, log = () => {} }) {
    this.llm = llm;
    this.tools = tools;
    this.persona = persona || '';
    this.policy = policy;
    this.memory = memory;
    this.vec = vec;
    this.mood = mood;
    this.roster = roster;
    this.log = log;
    this.coreRules = '';   // prompts/core.md 的内容
    this.memory_ = new Map(); // 会话短历史（和长期记忆分开）
    this.recentLines = [];   // 最近聊过的消息（跨会话，按时间），原生上下文
    this.extractBuf = new Map();   // 会话缓冲：一次会话攒着，等安静下来一起提取
    this.extractDelay = 3 * 60 * 1000;   // 她自己 3 分钟没说话就提取
  }

  /** 读某个平台的提示词文件 prompts/<name>.md，没有就返回空 */
  /** 载入核心提示词（她是谁、怎么说话）——平台无关 */
  async loadCoreRules() {
    const text = await this.platformPrompt('core');
    if (!text) {
      this.log && this.log('warn', '!! prompts/core.md 没读到或为空 —— 她这次会缺少基本行为规则');
    }
    this.coreRules = text;
    return this.coreRules;
  }

  async platformPrompt(name) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      return (await readFile(join(root, 'prompts', `${name}.md`), 'utf8')).trim();
    } catch {
      return '';
    }
  }

  setPersona(text) {
    this.persona = text || '';
  }

  /** 调试用：把最终拼出来的系统提示词拿出来看 */
  async previewSystem(ctx, meta, query = '') {
    return await this.#system(ctx || {}, meta || {}, query);
  }

  async #system(ctx, meta, query) {
    const plat = ctx.platform || '';   // 由 adapter 告诉我们这是哪个平台
    const platText = plat ? (this.platCache?.[plat] || '') : '';
    const lines = [this.persona.trim(), '', this.coreRules || RULES, '', platText, '', '## 当前环境',
      `- 你在这边的帐号：${ctx.selfId || '未知'}`,
      `- 现在是 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}`];

    // 精力会影响她的措辞（累了就短、就懒得解释）
    if (this.mood) {
      const e = Number(this.mood.energy);
      const level = e > 0.66 ? 'high' : e > 0.33 ? 'mid' : e > 0.02 ? 'low' : 'empty';
      // 精力不只是数字：它直接决定你此刻有多想说话
      const hint = {
        high: '精神很好：可以利索、有精神、爱开玩笑',
        mid: '状态一般：正常说话',
        low: '有点累：句子短一些，少修饰，少发几条',
        empty: '几乎没力气：只说很短的话，不想解释',
      }[level];
      lines.push('', '## 现在的精力', '- ' + hint);
      lines.push('- 精力越低，你越不想开口：可能只回一两个字、敷衍，或者干脆不理。这不是规矩，是你此刻真实的状态。');
    }
    // 称呼一律走人物表（按账号绑定），不要用对方昵称——昵称随时会改
    const who = (ctx.who || '对方');

    // 这段时间里收到的消息（可能不止一个人说的），原样给她看
    if (Number(meta.burst) > 1) {
      lines.push('- 刚刚收到了这些消息：');
      lines.push(String(userText || '').split('\n').map((x) => '  ' + x).join('\n'));
    }

    if (meta.scene === 'group') {
      lines.push(`- 你在群 ${meta.groupName || ctx.groupId} 里，群号 ${ctx.groupId}`);
      lines.push(`- 群里正在跟你说话的是「${who}」，号码 ${ctx.senderId || ctx.userId || ''}`);
      lines.push('- 群里还有别人，说话别像在跟机器人对话。');
    } else {
      lines.push(`- 你在私聊，对面是「${who}」，号码 ${ctx.senderId || ctx.userId || ''}`);
    }
    lines.push(ctx.isOwner ? '- 对方是你的主人。' : '- 对方不是你的主人。');
    lines.push(`- 称呼对方就用「${who}」。对方改昵称、改群名片都不影响，你只认这个称呼，不要叫昵称。`);
    if (meta.extra) lines.push(`- ${meta.extra}`);

    // 群聊上下文：带说话人，否则「对方」指的是谁根本没法判断
    if (meta.hint) {
      lines.push('', '## 刚才群里在聊什么（带说话人）', meta.hint);
      lines.push(
        '',
        '看这段记录时记住：',
        '- 最后一条说话的人才是在跟你说话的这个，前面的是别人。',
        '- 有人问「他是谁 / 她是谁 / 那个谁」——指的是记录里刚被提到、或者刚 @ 过的那个人，**不是你自己**，也不是提问的人。',
        '- 拿不准就别猜，直接问一句「谁呀」。乱认人比不回答更糟。',
      );
    }

    // 她自己叫什么、她认识谁 —— 不分群聊私聊都要给
    if (this.roster) {
      const names = this.roster.selfNames?.() || [];
      if (names.length) {
        lines.push(`- 别人喊你「${names.slice(0, 5).join('」「')}」的时候，就是在叫你。`);
      }

      const everyone = this.roster.all().filter((x) => !x.isSelf);
      const inGroup = ctx.groupId
        ? everyone.filter((x) => (x.groups || []).includes(String(ctx.groupId)))
        : everyone;

      if (inGroup.length) {
        const list = inGroup
          .slice(0, 15)
          .map((x) => {
            const rel = x.relation ? `，你${x.relation}` : x.isOwner ? '，主人' : '';
            return `${this.roster.nameOf(x.id)}(${x.id}${rel})`;
          })
          .join('、');
        lines.push(`- 你认识的人：${list}`);
        lines.push('- 上面括号里是号码。关系写着的（比如"你妈妈"）就是你和他的关系，别忘了。');
      }
    }

    if (this.mood) {
      // 心情和精力先不进提示词：数值照样记着，面板能看，但不拿它去影响她怎么说话
    }

    if (this.memory) {
      // 先让向量空间联想一圈：想到的不只是"最像的"，还有"由它牵出来的"
      let extra = [];
      this.log && this.log('info', '召回检查 vec=' + (this.vec ? (this.vec.ok ? 'ok' : 'not-ok') : 'null') + ' query=' + (query ? query.length : 0));
        if (this.vec && this.vec.ok && query) {
        try {
          const r = await this.vec.recall(query, {
        maxItems: 6,
        getMeta: (id) => {
          const it = this.memory.items.find((x) => x.id === id);
          return it ? { layer: it.layer, weight: it.weight, children: it.children || [] } : null;
        },
      });
          if (r && r.items) {
            this.log && this.log('info', '召回 ' + r.items.length + ' 条记忆');
            extra = r.items.map((x) => x.id).filter(Boolean);
            // 种子和被扩散带到的点，都算"想起来了"：一起刷新时间和分数基准
            try {
              const trace = r.breadth && r.breadth.trace;
              const ids = trace
                ? Object.values(trace).flat().filter(Boolean)
                : extra;
              const n = this.memory.activate(ids);          // 寿命：包括扩散到的
              this.memory.touch(extra);                     // 上次提起：只有选中的
              if (n) this.log && this.log('info', '激活 ' + n + ' 条（其中选中 ' + extra.length + ' 条记为提起）');
            } catch (e) {
              this.log && this.log('warn', '刷新激活记忆失败：' + e.message);
            }
            try { if (this.onRecall) this.onRecall(r.items, r.breadth && r.breadth.trace); } catch (e) { this.log && this.log('warn', '激活回调失败：' + e.message); }
          }
        } catch (e) {
          this.log && this.log('warn', '向量召回失败：' + e.message);
        }
      }
      const block = this.memory.promptBlock(query, ctx.senderId ? String(ctx.senderId) : '', {
        convId: ctx.conversationId || '',
        extra,
      });
      if (block) lines.push('', block);
    }

    // 最近聊过的消息（跨会话，按时间）——这是原生上下文，跟平台无关
    if (this.recentLines && this.recentLines.length) {
      const recent = this.recentLines
        .slice(-10)
        .map((x) => `- [${x.place}] ${x.who}：${x.text}`)
        .join('\n');
      lines.push('', '## 最近聊过的消息（按时间，可能来自不同地方）', recent);
    }

    return lines.join('\n');
  }

  // flash 有个毛病：会把人名写成"这五个字""那个名字"。记忆里出现这种，就是废的
  #sanitizeName(text, who) {
    const name = String(who || '').trim();
    if (!text) return text;
    return String(text).replace(/这[几二三四五]个字|那个名字|某个名字/g, name || '主人');
  }

  // 模型偶尔拿"这五个字"代替人名，出口统一换成真名
  #fixPlaceholderOut(t) {
    const who = this.roster && this.roster.nameOf && this.ownerQq ? this.roster.nameOf(String(this.ownerQq)) : '';
    const name = who || '主人';
    return String(t || '')
      .replace(/这[几二三四五]个字|那[几二三四五]个字|那个名字|某个名字|那个人|某某人/g, name)
      .replace(new RegExp(name + name, 'g'), name);
  }

  /** 记一条到全局时间线（最多留 20 条） */
  #pushRecent(ctx, who, text) {
    const place = ctx?.scene === 'group' ? (ctx.groupName || '群') : ctx?.scene === 'panel' ? '面板' : '私聊';
    this.recentLines.push({ at: Date.now(), place, who: who || '对方', text: String(text || '').slice(0, 80) });
    while (this.recentLines.length > 20) this.recentLines.shift();
  }

  #hist(id) {
    if (!this.memory_.has(id)) this.memory_.set(id, []);
    return this.memory_.get(id);
  }

  #remember(id, role, content) {
    const h = this.#hist(id);
    h.push({ role, content });
    while (h.length > MAX_HISTORY) h.shift();
  }

  /**
   * 连发：主回复之后，再补 0~2 句。
   * 触发条件不是随机数——刚查过资料、或者刚说了一大段，才更可能"还有话说"。
   */
  /** 这一轮允许用哪些工具：本地面谈只放行查资料类的，避免误发消息 */
  #allowedTool(name, ctx) {
    if (ctx?.noTools) return false;
    if (Array.isArray(ctx?.allowTools)) return ctx.allowTools.includes(name);
    return true;
  }

  async #followUps(ctx, mainText, usedTools, userText = '') {
    if (ctx?.noBurst) return [];
    const maybeMore = usedTools.length > 0 || mainText.length >= 40;
    if (!maybeMore) return [];

    const prompt =
      `刚才的对话：\n${this.recentLines.slice(-6).map((x) => `${x.who}：${x.text}`).join('\n')}\n\n` +
      `你刚回了这样一句：\n「${mainText}」\n\n` +
      (usedTools.length ? '（你刚为这件事查过资料）\n' : '') +
      '真人在聊天里常常说完一句又想起点别的，接着补一两条。\n' +
      '接下来还想说什么就接着说，一条也行、两条也行，没有就什么都别写（这个人就是说完这句就走了）。\n' +
      '每条 20 字以内，口语，别复述，别旁白。\n' +
      '**必须是刚才那句里没有的新内容**：新的反应、新的问题、新的补充。\n' +
      '同义反复、换个说法再说一遍、语气词复读，都算没有，直接输出空的。\n' +
      '只能接**这轮对方刚说的话**，不许把之前别的话题翻出来。\n' +
      '如果没有，就输出 {"more":[]}。\n' +
      '只输出 JSON：{"more":["第一句","第二句"]}';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(`${this.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: this.llm.model,
          messages: [
            { role: 'system', content: '你就是刚才那个人，说话口语、简短、像随手补一句。' },
            { role: 'user', content: prompt },
          ],
          temperature: 1.2,
          thinking: { type: 'disabled' },
          stream: false,
        }),
        signal: ac.signal,
      });
      if (!res.ok) return [];
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content || '';
      const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const list = Array.isArray(obj?.more) ? obj.more : [];
      return list
        .map((s) => String(s || '').trim())
        .filter((s) => s.length >= 1 && s.length <= 40 && s !== mainText)
        .slice(0, 2);
    } finally {
      clearTimeout(timer);
    }
  }

  async respond({ conversationId, userText, ctx, meta = {} }) {
    // 精力耗尽：她撑不住了，处理方式和累的时候不一样
    const energy = this.mood ? Number(this.mood.energy) : 1;
    // 先看她还有没有力气说这一句：不够就不回（不是 55% 概率，是干脆不回）
    const oneReplyCost = this.mood ? this.mood.energyCost('reply') : 0.02;
    if (this.mood && energy < oneReplyCost) {
      this.log && this.log('info', '精力不够说一句了（' + Math.round(energy * 100) + '%）→ 不回');
      return { text: null, followUps: [], usedTools: [], exhausted: true };
    }
    if (this.mood) this.mood.tick();


    this.#pushRecent(ctx, ctx.who || '对方', userText);
    const messages = [
      { role: 'system', content: await this.#system(ctx, meta, userText) },
      ...this.#hist(conversationId),
      { role: 'user', content: userText },
    ];

    const usedTools = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await this.#callLLM(messages, ctx);
      const choice = data?.choices?.[0]?.message;
      if (!choice) return { text: null, usedTools };

      const calls = choice.tool_calls || [];

      if (!calls.length) {
        const text = (choice.content || '').trim();
        if (text) {
          this.#remember(conversationId, 'user', userText);
          this.#remember(conversationId, 'assistant', text);
          this.#afterTurn(userText, text, ctx);
        }
        // 人聊天经常说完一句再补一句：查过资料、或者说了挺多的时候更容易接着发
        // 精力低就别补话了：累的时候一嘴说完就完了
        const tooTired = this.mood && Number(this.mood.energy) < 0.35;
        let followUps = text && !tooTired ? await this.#followUps(ctx, text, usedTools, userText).catch(() => []) : [];
  // 和主回复重复、或者自己重复自己，都不要
  // 发几条她自己定：0 条也行，别硬凑
  followUps = followUps
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 3);

        if (usedTools.includes('stay_silent')) {
          this.#remember(conversationId, 'user', userText);
          return { text: null, followUps: [], usedTools, silent: true };
        }
        // 按发出的条数扣精力：说一句累一点，说三句累三点
        if (this.mood && text) {
          const sent = 1 + followUps.length;
          for (let k = 0; k < sent; k++) this.mood.drain(this.mood.energyCost('reply'));
        }
        // 只有回复里真的用上了某条记忆，才算"想起"
        if (text) this.memory?.reinforceUsed?.(text);
        const fixed = text ? this.#fixPlaceholderOut(text) : null;
        return { text: fixed, followUps: (followUps || []).map((x) => this.#fixPlaceholderOut(x)), usedTools };
      }

      messages.push({ role: 'assistant', content: choice.content || '', tool_calls: calls });

      for (const tc of calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        const out = this.#allowedTool(tc.function.name, ctx)
          ? await this.tools.runTool(tc.function.name, args, ctx)
          : '（这个工具在当前场景不可用）';
        // 动手也要耗精力：查东西、发消息、改资料都算
        if (this.mood) this.mood.drain(this.mood.energyCost('tool'));
        usedTools.push(tc.function.name);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(out).slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }

    return { text: '行了，弄完了', usedTools };
  }

  // ---------- 回合之后：情绪 + 记忆 ----------
  #afterTurn(userText, replyText, ctx) {
    // 提示词自己拼出来的句子（群聊上下文、"没人叫你"之类）不是对方说的话，不能当记忆
    // 拼出来的提示词不进记忆；但群里"没被 @、自己接话"时，
    // 真正说的话在 rememberText 里，那部分要照常记
    const rememberText = String(ctx?.rememberText || '').trim() || userText;
    if (ctx?.synthetic && !ctx?.rememberText) return;

    if (this.mood) {
      this.mood.feel(userText, { fromOwner: ctx.isOwner });
      this.mood.save().catch(() => {});
    }

    if (!this.memory) return;

    // 太短的寒暄不值得记
    if (!String(rememberText).trim()) return;   // 只有完全是空的才跳过，短句也要记

    // 不再每轮提取：攒进这次会话的缓冲，等安静 5 分钟再整体提取一次
    this.#bufferTurn(rememberText, replyText, ctx);
  }

  /** 把这一轮的话攒进会话缓冲；同一会话只留一个定时器，每次说话都往后推 */
  #bufferTurn(userText, replyText, ctx) {
    const key = String(ctx?.conversationId || 'default');
    let buf = this.extractBuf.get(key);
    if (!buf) { buf = { lines: [], ctx: null, timer: null }; this.extractBuf.set(key, buf); }
    const who = ctx?.mine ? '我' : (ctx?.who || '对方');
    buf.lines.push(who + '：' + String(userText).slice(0, 200));
    if (replyText) buf.lines.push('我：' + String(replyText).slice(0, 200));
    buf.ctx = ctx;
    if (buf.lines.length > 40) buf.lines = buf.lines.slice(-40);   // 别攒太多

    // 计时按"她自己多久没说话"算：她说了话才重新计时；
    // 对方连发几句、她还没回，就让它到点先提一次
    if (replyText) {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => this.#flushExtract(key), this.extractDelay);
    } else if (!buf.timer) {
      buf.timer = setTimeout(() => this.#flushExtract(key), this.extractDelay);
    }
  }

  /** 会话安静下来了：把整段对话交给模型，只提取一次 */
  #flushExtract(key) {
    const buf = this.extractBuf.get(key);
    if (!buf || !buf.lines.length) return;
    this.extractBuf.delete(key);
    const transcript = buf.lines.join('\n');
    if (transcript.length < 8) return;
    this.#extractByLLM(transcript, '', { ...buf.ctx, batch: true })
      .catch((e) => this.log && this.log('warn', '整段提取出错：' + (e && e.message)));
  }


  async #extractByLLM(userText, replyText, ctx, attempt = 1) {
    if (!this.memory || !this.llm.apiKey) return;

    const subject = ctx.senderId ? String(ctx.senderId) : '';
    let who = (ctx.who || '对方');
    const place = ctx.scene === 'group' ? ctx.groupName || `群${ctx.groupId || ''}` : ctx.scene === 'panel' ? '面板' : '私聊';
    // 平台 + 位置分开存：platform 由 adapter 给，where 只放具体是哪
    const platform = ctx.platform || '';   // 由 adapter 决定
    const where = ctx.scene === 'panel' ? ''
      : ctx.scene === 'group' ? 'group:' + String(ctx.groupId || '')
      : 'private:' + String(ctx.senderId || '');

    const prompt = `你正在以「阿糯」的身份和「${who}」聊天。把这一轮里你觉得值得记的东西记下来。

## 打分（weight 1-10，0.5 一档，你自己判断）
- 10：一辈子都不该忘的
- 8-9：很重要，隔很久想起来还会在意
- 5-7：值得记，过一阵子会淡
- 1-4：小事。日常寒暄照记（在吗、起床了、迟到了、在干嘛），分给低，它自己会淡掉
分数多少由你定，要谨慎判断。

## 下面是一整段对话
- 整体看一遍再动笔：同一件事在几轮里说了几遍，只记一条。

## 怎么分条
- 两件事不要糊成一条；一句话就能说清的事，别写成两段。

## 记什么
- 至少 1 条、最多 7 条。哪怕只是问了一句"在吗"，那也是"他来找我了"这件事。
- 写完回头看一遍：这些事里，有多少是以后还能讲出来的？讲得出来的才算记对了。
- **先看清这段对话里有谁**：说话的人、被提到的人、被讨论的人，可能不止一个。
  群聊里经常是在聊别人，别把被聊的人当成说话的人。
- 每条要能独立看懂：**谁**对谁做了什么、谁被说了什么。不要用"他""她""你"这种代词，直接写称呼。
- who 填这条记忆的主语（这件事是关于谁的），people 填所有牵涉进来的人。
- gist 一句话说清这件事；detail 写当时的具体细节（最多 150 字）；raw 抄他的原话，保留语气词。
- 该不该记，你自己判断。

## 称呼和昵称
- who：你平时怎么叫他
- nick：他的昵称（原名），只当线索，不要拿来喊他

## kind
fact（事实）/ event（发生过的事）/ feeling（我的感受）/ joke（玩笑）


只输出 JSON 数组。没有 [] 这个选项——这段对话里一定发生过至少一件事：
[{"gist":"主人说他面试挂了","detail":"面试官问项目经历，主人答得很糟，回来还淋了雨","raw":"我今天面试挂了","weight":8,"why":"他第一次说自己这么挫败","kind":"event","layer":"surface","people":["主人"],"places":[],"feeling":"低落","tags":["工作"],"nick":"三鹿乃粉"}]

这轮对话发生在「${place}」：
${ctx.batch ? userText : who + '说：' + userText + '\n我回：' + replyText}`;

    // 有时候模型会图省事直接回 []，再问它一遍
    const finalPrompt = attempt > 1
      ? prompt + '\n\n（上一遍你什么都没记。再看一遍这段对话：谁做了什么、说了什么？至少写一条出来。只有真的全是招呼语，才算没有。）'
      : prompt;

    const res = await fetch(`${this.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: this.llm.model,
        messages: [{ role: 'user', content: finalPrompt }],
        temperature: 0.3,
        thinking: { type: 'disabled' },
        stream: false,
      }),
    });

    if (!res.ok) { if (this.log) this.log('warn', '提取请求失败 HTTP ' + res.status); return; }
    const data = await res.json();
    const rawReply = data?.choices?.[0]?.message?.content || '';
    if (this.log) this.log('info', '提取返回 ' + String(rawReply).length + ' 字：' + String(rawReply).slice(0, 100));

    let arr = [];
    try {
      const start = rawReply.indexOf('[');
      const end = rawReply.lastIndexOf(']');
      arr = JSON.parse(rawReply.slice(start, end + 1));
    } catch {
      return;
    }

    if (!Array.isArray(arr)) return;
    // 回了空数组：再问一遍（只重试一次，不无限循环）
    if (!arr.length) {
      if (attempt < 2) return this.#extractByLLM(userText, replyText, ctx, 2);
      if (this.log) this.log('info', '这轮确实没什么可记的');
      return;
    }
    const KINDS = new Set(['fact', 'joke', 'feeling', 'event']);
    let n = 0;
    for (const x of arr.slice(0, 7)) {   // 最多 7 条，至少 1 条   // 一轮最多 7 条
      const gist = String(x?.gist || x?.fact || x?.text || '').trim();
      if (gist.length < 4) continue;

      const weight = Math.min(10, Math.max(1, Number(x?.weight) || 5));   // 打分从 1 分起
      const kind = KINDS.has(x?.kind) ? x.kind : 'fact';
      const layer = 'surface';   // 只有表层/整合/核心三层，提取出来的一律是表层（10 分会自动进核心）
      const big = weight >= 5;   // 5 分以上就留细节和原话

      this.log && this.log('info', '记下：' + weight + ' 分 「' + String(gist).slice(0, 24) + '」');
      // 这一轮刚记过的相似记忆，不再重复写（她复述别人的话时最容易撞上）
      const recentCut = Date.now() - 15 * 60 * 1000;
      const clash = (this.memory.items || []).find(
        (m) => (m.createdAt || 0) > recentCut && String(m.subject || '') === String(subject || '') && sameFact(m.text, gist),
      );
      if (clash) {
        this.log && this.log('info', '这条和刚记的重复，跳过：「' + String(gist).slice(0, 20) + '」');
        continue;
      }
      // 模型经常"编"一句像原话的话。校验一下：剪掉标点后必须在对话里出现
      const norm = (t) => String(t || '').replace(/[\s，。！？、,.!?~～…「」“”"'（）()]/g, '');
      let rawText = big ? String(x?.raw || '').trim().slice(0, 400) : '';
      if (rawText && !norm(userText).includes(norm(rawText))) {
        this.log && this.log('warn', '原话在对话里找不到，丢掉：「' + rawText.slice(0, 24) + '」');
        rawText = '';
      }

      const item = this.memory.remember({
        layer,
        text: this.#sanitizeName(gist, who || '主人').slice(0, 60),
        kind,
        detail: big ? String(x?.detail || '').trim().slice(0, 300) : '',
        raw: rawText,
        weight,
        weightWhy: String(x?.why || '').trim().slice(0, 60),
        feeling: String(x?.feeling || '').trim().slice(0, 20),
        places: [place],
        people: Array.isArray(x?.people) ? x.people.slice(0, 4) : [who],
        tags: Array.isArray(x?.tags) ? x.tags.slice(0, 4) : [],
        subject,
        whoName: who,
        where,
        platform,

        source: 'llm',
      });
      if (!item) continue;
      n++;
      // 10 分的直接单独放进核心
      if (weight >= 10) this.memory.moveToCore(item);
    }
    if (n) {
      await this.memory.save().catch(() => {});
      this.log('info', `记住 ${n} 条（最高 ${Math.max(...arr.map((x) => Number(x?.weight) || 0))} 分）`);
    }
  }

  async #callLLM(messages, ctx) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.llm.timeoutMs ?? 25000);
    const temp = (this.llm.temperature ?? 1.0) + (this.mood ? this.mood.temperatureBias() : 0);

    try {
      const res = await fetch(`${this.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: this.llm.model,
          messages,
          // 本地面谈时不给工具：没有对外连接，给了反而可能误发
          ...(this.tools.schemas.filter((s) => this.#allowedTool(s.function.name, ctx)).length
            ? {
                tools: this.tools.schemas.filter((s) => this.#allowedTool(s.function.name, ctx)),
                tool_choice: 'auto',
              }
            : {}),
          temperature: Math.min(Math.max(temp, 0), 1.6),
          thinking: { type: 'disabled' },
          stream: false,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}