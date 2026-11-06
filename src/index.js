// 主程序：把 OneBot、大脑、拟人层、记忆、情绪、面板串起来
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config, assertUsableConfig } from './config.js';
import { OneBot, extractText, isAtSelf, stripAtSelf } from './adapters/qq/client.js';
import { Agent } from './core/agent.js';
import { createTools } from './tools.js';
import { loadMcp, attachMcp } from './mcp/index.js';
import { Ring } from './data/store.js';
import { House } from './home/house.js';
import { Roster } from './data/roster.js';
import { Nap } from './body/nap.js';
import { makeIntent } from './pipeline/intent.js';
import { startScheduler } from './scheduler/index.js';
import { kindOf } from './pipeline/format.js';
import { healthCheck, formatHealth } from './core/health.js';
import { Consolidator } from './core/consolidate.js';
import { VecIndex } from './core/vecindex.js';
import { Stickers } from './home/stickers.js';
import { Brain } from './core/memory2.js';
import { Mood } from './body/mood.js';
import { Attention, shouldReply } from './core/attention.js';
import { Autonomy } from './adapters/qq/autonomy.js';
import { createQqLimiter } from './adapters/qq/limits.js';
import { createDelivery } from './adapters/qq/delivery.js';
import { startWebUI } from './webui.js';
import {
  sleep, chance, rand, replyDelay, typingDelay, segment,
  introduceTypo, isAsleep, wakeJitter,
} from './text/humanize.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAGS = { info: '··', ok: 'OK', warn: '!!', err: 'XX', send: '->', recv: '<-' };

const logBuffer = new Ring(600);
const subscribers = new Set();

function log(kind, msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${t}] ${TAGS[kind] ?? '  '} ${msg}`;
  console.log(line);
  logBuffer.push({ at: Date.now(), kind, line });
  for (const fn of subscribers) {
    try {
      fn(JSON.stringify({ type: 'log', line, kind }));
    } catch {
      /* 面板断开就忽略 */
    }
  }
}

const bot = new OneBot(config.onebot);
const recent = new Map(); // 群最近聊天，给"主动接话"提供上下文
const myMsgIds = new Set(); // 自己发出去的消息 id，用来判断"他在回我"

function rememberMyMsg(id) {
  if (id == null) return;
  myMsgIds.add(String(id));
  if (myMsgIds.size > 300) myMsgIds.delete(myMsgIds.values().next().value);
}

let agent;
let attention = null;
let autonomy = null;
let roster = null;
let nap = null;
let stickers = null;
let lastImageBuf = null;

// 面板读取的运行时状态
const state = {
  cfg: config,
  bot,
  memory: null,
  mood: null,
  messages: new Ring(400),
  logBuffer,
  subscribers,
  startedAt: Date.now(),
  llmMode: config.llm.mock ? 'mock' : 'live',
  stats: { received: 0, sent: 0, toolCalls: 0 },
  envPath: join(ROOT, '.env'),
  personaPath: join(ROOT, 'persona.md'),
  napcatPort: config.onebot.url,
  log,
  isAsleep: () => isAsleep(config.schedule),
  send: null,
  reloadPersona: null,
};

/** 记一条对话，给面板看 */
function recordMessage({ dir, scope, scopeName, from, text }) {
  state.messages.push({ at: Date.now(), dir, scope, scopeName, from, text });
  if (dir === 'out') state.stats.sent++;
  else state.stats.received++;
}

// ==================== 一、聊天上下文与记录 ====================
function pushRecent(gid, name, text, id) {
  if (!text) return;
  const arr = recent.get(gid) || [];
  arr.push({ name, text, id });
  while (arr.length > 12) arr.shift();
  recent.set(gid, arr);
  saveRecentSoon();
}

const RECENT_FILE = ROOT + '/.data/recent.json';
  let recentSaveTimer = null;

  async function loadRecent() {
    try {
      const d = JSON.parse(await readFile(RECENT_FILE, 'utf8'));
      for (const [gid, arr] of Object.entries(d || {})) {
        if (Array.isArray(arr)) recent.set(gid, arr.slice(-12));
      }
    } catch { /* 第一次没有就算了 */ }
  }

  function saveRecentSoon() {
    if (recentSaveTimer) return;
    recentSaveTimer = setTimeout(async () => {
      recentSaveTimer = null;
      try {
        const obj = {};
        for (const [gid, arr] of recent.entries()) obj[gid] = arr.slice(-12);
        await writeFile(RECENT_FILE, JSON.stringify(obj), 'utf8');
      } catch { /* 存不下不影响 */ }
    }, 3000);
  }

  function recentHint(gid) {
  const arr = recent.get(gid) || [];
  if (!arr.length) return '';
  const lines = arr.slice(-8).map((m) => (m.id ? `[${m.id}] ${m.name}: ${m.text}` : `${m.name}: ${m.text}`));
  return `最近的聊天记录（方括号里是消息 id）：\n${lines.join('\n')}`;
}

// 称呼和关系的解析搬到了 pipeline/intent.js，数据仍然只有 roster 一份
const { parseRename, applyRename, parseRelation, applyRelation } = makeIntent({ getRoster: () => roster, log });

// ==================== 二、睡醒了自己说话 ====================
async function wakeUp(place, sleptMin) {
  try { await sleepConsolidate(sleptMin); } catch {}
  if (!place) return;
  const target = place.kind === 'group' ? { groupId: place.id } : { userId: place.id };
  const ctx = {
    selfId: bot.selfId,
    groupId: place.kind === 'group' ? place.id : null,
    userId: place.kind === 'private' ? place.id : null,
    senderId: place.kind === 'private' ? place.id : null,
    isOwner: String(place.id) === String(config.policy.ownerQq),
    scene: place.kind === 'group' ? 'group' : 'private',
    groupName: place.kind === 'group' ? place.name : '',
    who: place.name || '主人',
    synthetic: true,
    conversationId: place.kind === 'group' ? `g:${place.id}` : `p:${place.id}`,
  };
  const pending = (state.pending || []).splice(0, 20);
  const pendingText = pending.length
    ? `\n你睡着的时候有 ${pending.length} 条消息：\n` +
      pending.map((p, i) => `  ${i + 1}. ${p.name}（${p.place}）：${p.text}`).join('\n') +
      '\n想回哪个就回，不想回的可以不管。'
    : '';

  try {
    const r = await agent.respond({
      conversationId: ctx.conversationId,
      userText: `（你刚睡醒：睡了 ${sleptMin} 分钟，现在是 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}。${pendingText}\n先用一句话跟${ctx.who}打个招呼，自然一点，别提"系统""提示"。）`,
      ctx,
      meta: { scene: ctx.scene, groupName: ctx.groupName },
    });
    if (r?.text) {
      await deliver(target, r.text);
      log('ok', `睡醒了，去找${ctx.who}说话`);
    }
  } catch (err) {
    log('warn', `睡醒找人失败：${err.message}`);
  }
}

// ==================== 三、发出去（断句、表情、延迟） ====================
// 发出去前的最后一道关：模型偶尔会拿"这五个字"代替人名，这里一律换成真名
function fixPlaceholder(t) {
  const who = (roster && roster.nameOf && config.policy.ownerQq)
    ? roster.nameOf(String(config.policy.ownerQq))
    : '';
  const name = who || '主人';
  return String(t || '')
    .replace(/这[几二三四五]个字|那[几二三四五]个字|那个名字|某个名字|那个人|某某人/g, name)
    .replace(new RegExp(name + name, 'g'), name);
}

async function send(target, text, meta = {}) {
  text = fixPlaceholder(text);
  const scope = target.groupId ? `group:${target.groupId}` : `user:${target.userId}`;
  const scopeName = meta.scopeName || (target.groupId ? `群 ${target.groupId}` : `与 ${target.userId} 私聊`);
  // 她自己也进上下文，不然记不住刚说过什么
  if (target.groupId) pushRecent(String(target.groupId), '我', text);
  else if (target.userId) pushRecent('p:' + target.userId, '我', text);

  if (config.dryRun) {
    log('send', `[dry-run] ${text}`);
    recordMessage({ dir: 'out', scope, scopeName, from: '我(干跑)', text });
    return null;
  }
  try {
    const r = target.groupId
      ? await bot.sendGroup(target.groupId, text)
      : await bot.sendPrivate(target.userId, text);
    rememberMyMsg(r?.message_id);
    recordMessage({ dir: 'out', scope, scopeName, from: '我', text });
    // 说了一句 → 社交欲降一点
    try { if (autonomy) autonomy.noteReply(1); } catch {}
    return r;
  } catch (err) {
    log('err', `发送失败：${err.message}`);
    return null;
  }
}

// 每个会话最后一次收到消息的时间：用来判断"补话期间有没有人接话"
const lastInboundAt = new Map();

// 原生规则：静默 5 秒才开始思考
const SILENCE_MS = 5000;

// QQ 的投递规矩（分条/打字延迟/打错字）交给 adapter
const delivery = createDelivery({
  send,
  log,
  getConfig: () => config,
  fixPlaceholder,
  deleteMsg: (id) => bot.deleteMsg(id),
  respond: (payload) => respond(payload),
});
const scheduleReply = delivery.scheduleReply;
const deliver = delivery.deliver;

// ==================== 四、一轮对话：感知 → 判断 → 想 → 回 ====================
let wasAsleep = false;

// 把 QQ 消息里的图片/语音交给她自己的感官层
// 判断这条图是表情包还是真照片
async function ownedStickers() {
  const http = await import('node:http');
  const tok = process.env.ONEBOT_HTTP_TOKEN || '';
  return await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: 3000, path: '/fetch_custom_face_detail', method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, timeout: 5000 },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b).data || []); } catch { resolve([]); } }); },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write('{}'); req.end();
  });
}

async function perceiveMedia(ev) {
  const segs = Array.isArray(ev?.message) ? ev.message : [];
  const notes = [];
  const { describeImage, transcribeAudio } = await import('./senses/index.js');
  let n = 0;
  for (const seg of segs) {
    if (n >= 3) break;
    const type = seg?.type;
    const file = seg?.data?.file || seg?.data?.url || '';
    const url = seg?.data?.url || (String(file).startsWith('http') ? file : '');
    if (type === 'image' || type === 'record') {
      n++;
      try {
        if (!url) { notes.push(type === 'image' ? '（对方发了张图，但拿不到地址）' : '（对方发了条语音，但拿不到文件）'); continue; }
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        if (type === 'image') {
          lastImageBuf = { buf, url, kind: kindOf(seg), source: 'qq', ext: (String(file).split('.').pop() || 'png').toLowerCase(), at: Date.now() };
        }
        const out = type === 'image'
          ? await describeImage(buf.toString('base64'), '', kindOf(seg))
          : await transcribeAudio(buf, String(file).split('.').pop() || 'silk');
        if (type === 'image' && lastImageBuf) {
          lastImageBuf.desc = out;
          // 用"印象"判断：这张看着眼熟吗
          try {
            const { findSimilar } = await import('./util/similar.js');
            const { imageHash, findSameHash } = await import('./senses/phash.js');
            const myPh = await imageHash(buf);
            const { readFile: rf } = await import('node:fs/promises');
            const meta = JSON.parse(await rf(ROOT + '/.data/sticker-meta.json', 'utf8').catch(() => '{}'));
            const hit = findSameHash(myPh, Object.values(meta)) || findSimilar(out, Object.values(meta));
            if (hit) notes.push('（这张你收藏夹里已经有了，' + (hit.item.desc || '').slice(0, 20) + '）');
          } catch {}
        }
        notes.push(type === 'image' ? '（对方发了张图：' + out + '）' : '（对方发了条语音：' + out + '）');
        log('info', (type === 'image' ? '看图：' : '听语音：') + out);
        const who = (() => {
          try {
            const r = roster && roster.nameOf ? roster.nameOf(String(m.senderId || '')) : '';
            return String(r || m.whoName || '').trim();
          } catch { return String(m.whoName || '').trim(); }
        })();
        if (type === 'image' && out && String(out).length > 4) {
          try {
            memory.remember({
              layer: 'surface',
              text: (who || '对方') + '发了一张图：' + String(out).slice(0, 40),
              weight: 4,
              subject: String(m.senderId || ''),
              whoName: who || '对方',
              kind: 'event',
              source: 'vision',
              where: m.scene === 'group' ? '群' : '私聊',
            });
            memory.save().catch(() => {});
            log('info', '看图已记下：' + String(out).slice(0, 30));
          } catch (e) { log('warn', '看图记忆写入失败：' + e.message); }
        }
      } catch {
        notes.push(type === 'image' ? '（对方发了张图，但我没看清）' : '（对方发了条语音，但我没听清）');
      }
    }
  }
  return notes.join('');
}

async function respond({ target, conversationId, userText, meta, senderId, senderName = '', senderCard = '', synthetic = false, rememberText = '' }) {
  state.lastSpokeAt = Date.now();   // 全局：不管在哪说话，都算她"刚说过话"
  // 作息：睡着了就不理
  if (isAsleep(config.schedule)) {
    wasAsleep = true;
    if (!state.sleepStartedAt) state.sleepStartedAt = Date.now();
    // 和"她自己说要去睡"一样：先记下来，醒来再决定回不回
    state.pending = state.pending || [];
    state.pending.push({
      name: meta?.userName || senderName || '有人',
      text: userText,
      place: target.groupId ? '群' : '私聊',
      at: Date.now(),
    });
    if (state.pending.length > 30) state.pending.shift();
    log('info', `现在是睡觉时间，这条先记下（已攒 ${state.pending.length} 条）`);
    return;
  }
  if (wasAsleep) {
    wasAsleep = false;
    const d = wakeJitter(config.schedule);
    log('info', `刚睡醒，迟钝 ${Math.round(d / 1000)}s`);
    await sleep(d);
  }

  // 她自己说了要睡，睡着期间不接话，但把消息记下来，醒来由她决定回不回
  if (nap && nap.isSleeping()) {
    state.pending = state.pending || [];
    state.pending.push({
      name: meta?.userName || senderName || '有人',
      text: userText,
      place: target.groupId ? '群' : '私聊',
      at: Date.now(),
    });
    if (state.pending.length > 30) state.pending.shift();
    log('info', `她睡着了（还剩 ${nap.minutesLeft()} 分钟），这条记下来先不回`);
    return;
  }


  if (config.human.enabled) {
    // 情绪影响回复速度：越懒、越烦，回得越慢
    const factor = state.mood ? state.mood.speedFactor() : 1;
    const d = replyDelay(config.human) * factor;
    if (d > config.human.replyDelayMax * 1.5) {
      log('info', `${Math.round(d / 1000)}s 后才回（在忙/没精神）`);
    }
    await sleep(d);
  }

  const ctx = {
    selfId: bot.selfId,
    groupId: target.groupId ?? null,
    userId: target.userId ?? null,
    senderId: senderId != null ? String(senderId) : null,
    isOwner:
      Boolean(config.policy.ownerQq) &&
      senderId != null &&
      String(senderId) === String(config.policy.ownerQq),
    scene: meta?.scene || 'private',
    // 平台由这一层决定，core 只管用
    platform: (meta?.scene || 'private') === 'panel' ? 'panel' : 'qq',
    groupName: meta?.groupName || '',
    who: '',
    conversationId,
    // 这句话是不是提示词自己拼出来的（不是对方真说的）——这种不能进记忆
    synthetic,
    // 但要记的东西可能在这里（群里没被 @ 时，userText 是拼的，真话在 rememberText）
    rememberText,
  };

  // 先更新人物表，再让记忆知道"现在是谁在说话"
  if (roster && ctx.senderId) {
    roster.touch(ctx.senderId, {
      name: senderName,
      card: senderCard,
      groupId: target.groupId,
      isOwner: ctx.isOwner,
    });
    ctx.who = roster.nameOf(ctx.senderId);
    if (roster.dirty) roster.save().catch(() => {});
  }
  if (!ctx.who) ctx.who = ctx.isOwner ? '主人' : '对方';

  // 关系陈述：「俞是你妈妈」这种，直接记到那个人身上
  const rel = parseRelation(userText);
  if (rel) applyRelation(rel).catch(() => {});

  // 对方明确说了怎么称呼 → 直接改，别指望模型自己记得调工具
  const wantTitle = synthetic ? '' : parseRename(userText);
  if (wantTitle && ctx.senderId) {
    if (await applyRename(ctx.senderId, wantTitle)) {
      ctx.who = wantTitle;
    }
  }


  let result;
  try {
    result = await agent.respond({ conversationId, userText, ctx, meta });
  } catch (err) {
    log('err', `大脑出错：${err.message}`);
    return;
  }

  const answer = result?.text;
  if (result?.usedTools?.length) {
    state.stats.toolCalls += result.usedTools.length;
    log('info', `这轮用了工具：${result.usedTools.join(', ')}`);
  }

  if (!answer) {
    log('warn', '大脑没给回复，保持沉默');
    return;
  }

  await deliver(target, answer);

  // 补发：人说完一句常常又想起点别的
  // 但如果这期间有人又说话了，就别再补旧的了——那会显得她没在听
  const convKey = target.groupId ? 'g:' + target.groupId : 'p:' + target.userId;
  const inboundBefore = lastInboundAt.get(convKey) || 0;
  for (const extra of result?.followUps || []) {
    if (!extra) continue;
    if ((lastInboundAt.get(convKey) || 0) > inboundBefore) {
      log('info', '补话取消：这期间有人说话了');
      break;
    }
    await sleep(rand(900, 2600));
    await deliver(target, extra);
  }

  // 记下自己说过的话，别人才"接得上"
  if (target.groupId && attention) {
    attention.observe(target.groupId, { from: '我', text: answer, mine: true });
  }
  if (autonomy) autonomy.noteActivity();
}


// 每个会话各自限流：一个群热闹不能把她别的对话堵死
const qqLimiter = createQqLimiter(config.policy.rateLimitPerMin || 20);

// ---------- 连着发好几条：等一下，合成一次 ----------
// ==================== 五、收到消息 ====================
async function handleGroup(ev) {
  const gid = String(ev.group_id);

  if (config.policy.groupDeny.includes(gid)) return;
  if (config.policy.groupAllow.length && !config.policy.groupAllow.includes(gid)) return;

  let text = extractText(ev);
  const seenInGroup = await perceiveMedia(ev);
  if (seenInGroup) text = seenInGroup + (text || '');
  const name = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
  // 记录里也用人物表的称呼，这样"他"才能指到具体的人
  const speaker = roster ? roster.nameOf(ev.user_id) : name;
  pushRecent(gid, speaker, text, ev.message_id);
  recordMessage({
    dir: 'in',
    scope: `group:${gid}`,
    scopeName: ev.group_name || `群 ${gid}`,
    from: name,
    text,
  });

  const at = isAtSelf(ev, bot.selfId);
  if (autonomy) autonomy.noteActivity();

  // @ 了谁、是不是在引用我说的话
  const segs = Array.isArray(ev.message) ? ev.message : [];
  const atTargets = segs.filter((x) => x.type === 'at').map((x) => String(x.data?.qq ?? ''));
  const atAll = atTargets.includes('all');
  const atOthers = atTargets.some((q) => q !== String(bot.selfId) && q !== 'all');
  const replySeg = segs.find((x) => x.type === 'reply');
  const isReplyToMe = Boolean(replySeg && myMsgIds.has(String(replySeg.data?.id)));

  let ambient = false;

  if (!at) {
    if (attention) {
      // 先打分（用之前的对话状态），再把他这句记进去
      const { score, reasons } = attention.score(gid, {
        text,
        from: name,
        isReplyToMe,
        atOthers,
        atAll,
      });
      attention.observe(gid, { from: name, text, mine: false, id: ev.message_id });

      // 不再用相关性阈值筛：给她看到，回不回她自己判断
      log('info', `相关性 ${score.toFixed(2)}（${reasons.join('、') || '弱'}），交给她判断`);
      ambient = true;
    } else if (!config.policy.groupRequireAt && chance(config.policy.groupAmbientChance)) {
      ambient = true;
    } else {
      return;
    }
  } else if (attention) {
    attention.observe(gid, { from: name, text, mine: false, id: ev.message_id });
  }

  const clean = at ? stripAtSelf(ev, bot.selfId) : '';
  let userText = clean;
  // 群聊永远带上最近几条（带说话人），否则她判断不了"他"是谁
  let hint = recentHint(gid);

  if (!clean) {
    // 被 @ 但没打字（比如只 @ 了一下），或者主动接话
    userText = at
      ? '（对方只 @ 了你一下，没说话。随便应一声。）'
      : `${hint}\n\n（没人叫你，你看着群聊想插一句。别太热情，简短点。）`;
  }

  if (!userText) return;

  const build = () => ({
    target: { groupId: gid },
    conversationId: `g:${gid}`,
    senderId: ev.user_id,
    senderName: ev.sender?.nickname || '',
    senderCard: ev.sender?.card || '',
    meta: { scene: 'group', groupName: ev.group_name || gid, hint },
    synthetic: !clean,
    rememberText: ((hint ? hint + '\n' : '') + (text || '')).trim(),
  });
  if (!qqLimiter.allow('g:' + gid)) {
    log('info', `这个群这一分钟回够了（${qqLimiter.perMin} 条），先不接`);
    return;
  }
  // 原生规则：5 秒内没人再说话，才开始想怎么回（连发多条只会回一次）
  lastInboundAt.set('g:' + gid, Date.now());
  scheduleReply('g:' + gid, SILENCE_MS, build, {
    who: (() => {
      try {
        const r = roster && roster.nameOf ? roster.nameOf(String(ev.user_id)) : '';
        return String(r || ev.sender?.card || ev.sender?.nickname || ev.user_id).trim();
      } catch { return String(ev.sender?.nickname || ev.user_id); }
    })(),
    text: userText,
    at: Date.now(),
  });
}

async function handlePrivate(ev) {
  if (!config.policy.privateEnabled) return;

  const uid = String(ev.user_id);
  if (uid === bot.selfId) return;

  if (autonomy) autonomy.noteActivity();

  let text = extractText(ev);
  const seen = await perceiveMedia(ev);
  if (seen) text = seen + (text || "");
  if (!text) return;

  pushRecent('p:' + uid, ev.sender?.card || ev.sender?.nickname || String(uid), text);

  recordMessage({
    dir: 'in',
    scope: `user:${uid}`,
    scopeName: ev.sender?.nickname || `与 ${uid} 私聊`,
    from: ev.sender?.nickname || uid,
    text,
  });

  // 等 3 秒：对方连发几条，只回一次（内容合在一起）
  if (!qqLimiter.allow('p:' + uid)) {
    log('info', `这个私聊这一分钟回够了（${qqLimiter.perMin} 条），先不接`);
    return;
  }
  lastInboundAt.set('p:' + uid, Date.now());
  scheduleReply('p:' + uid, SILENCE_MS, () => ({
    target: { userId: uid },
    conversationId: `p:${uid}`,
    senderId: ev.user_id,
    senderName: ev.sender?.nickname || '',
    senderCard: ev.sender?.card || '',
    meta: {
      scene: 'private',
      userName: ev.sender?.nickname || uid,
    },
  }), {
    who: (() => {
      try {
        const r = roster && roster.nameOf ? roster.nameOf(String(uid)) : '';
        return String(r || ev.sender?.nickname || uid).trim();
      } catch { return String(ev.sender?.nickname || uid); }
    })(),
    text: text,
    at: Date.now(),
  });
}

// ==================== 六、启动和连接 ====================
async function main() {
  log('info', '大肥鱼成精 —— QQ 分身启动中');

  const problems = assertUsableConfig();
  if (problems.length) {
    for (const p of problems) log('err', p);
    log('info', '请复制 .env.example 为 .env 并填好配置');
    process.exit(1);
  }

  // ==================== 七、记忆和情绪 ====================
  // 记忆载体：记忆/情绪/人设的唯一落盘出口，自带版本快照
  const house = await new House(join(ROOT, '.data'), {
    keep: Number(process.env.HOUSE_KEEP || 60),
    minGapMs: Number(process.env.HOUSE_SNAPSHOT_MIN || 20) * 60000,
  }).init();
  const store = house; // 与 Store 同接口，Brain / Mood 无需改动

  const memory = await new Brain({ store, file: 'brain.json' }).load();
  const mood = await new Mood({ store, file: 'mood.json' }).load();
  // 人物表：记忆里存 id，显示时查这张表，改成"主人/俞/小鲸鱼"
  roster = await new Roster({ dir: join(ROOT, '.data'), ownerQq: config.policy.ownerQq }).load();
  nap = await new Nap({ dir: join(ROOT, '.data') }).load();
  stickers = await new Stickers({ dir: join(ROOT, '.data') }).load();
  state.stickers = stickers;
  state.nap = nap;
  // 手动叫醒
  // 睡眠巩固：睡一觉，把这段时间的记忆理一遍
  const consolidator = new Consolidator({ memory, llm: config.llm, log });
  // 每个会话最后一次说话的时间（用来判断"这段聊完了"）
  // 全局会话：她 5 分钟没说话，就算这一轮结束（不分平台、不分群）
  // 会话/复盘的进度要存盘：不然每次重启都会把同一段记忆重新整合一遍（重复的来源）
  const MERGE_STATE = resolve(ROOT, '.data', 'merge-state.json');
  try {
    const ms = JSON.parse(await readFile(MERGE_STATE, 'utf8'));
    state.lastSessionEnd = Number(ms.lastSessionEnd) || 0;
    state.lastReviewAt = Number(ms.lastReviewAt) || 0;
    state.lastNightBoost = ms.lastNightBoost || '';
  } catch { state.lastSessionEnd = 0; state.lastReviewAt = 0; }
  const saveMergeState = async () => {
    try {
      await writeFile(MERGE_STATE, JSON.stringify({
        lastSessionEnd: state.lastSessionEnd || 0,
        lastReviewAt: state.lastReviewAt || 0,
        lastNightBoost: state.lastNightBoost || '',
        savedAt: Date.now(),
      }, null, 1), 'utf8');
    } catch {}
  };

  state.lastSpokeAt = state.lastSpokeAt || 0;
  state.lastSessionEnd = state.lastSessionEnd || 0;
  async function tickSessionMerge() {
    const now = Date.now();
    const last = state.lastSpokeAt || 0;
    if (!last) return;
    if (now - last < 15 * 60 * 1000) return;             // 她自己 15 分钟没说话，才算一次会话结束
    if (last <= (state.lastSessionEnd || 0)) return;      // 这段已经整合过
    // 起点优先用数据里最新的整合记忆时间：重启也不会回退
    const newestMerged = Math.max(0, ...memory.all().filter((m) => m.layer === 'merged').map((m) => m.createdAt || 0));
    const since = Math.max(state.lastSessionEnd || 0, newestMerged) || (last - 6 * 3600 * 1000);
    state.lastSessionEnd = last;
    await saveMergeState();
    try {
      const made = await consolidator.summarizeSession({ convId: 'all', since, until: last + 1000, maxDepth: 1 });
      if (made && made.length) log('ok', '这一轮说完，整合成 ' + made.length + ' 条');
    } catch (e) { log('warn', '会话整合失败：' + e.message); }
  }
  setInterval(() => { tickSessionMerge().catch(() => {}); }, 60 * 1000).unref();
  async function sleepConsolidate(sleptMin) {
    try {
      // 睡眠流程（按顺序）见 onNightReview
      if (Number(sleptMin || 0) < 180) log('info', `只睡了 ${sleptMin} 分钟，是小睡，不处理`);
      const before = memory.all().length;
      const r = memory.dedupeAll({ dryRun: false });
      if (r.removed) await memory.save();
      const after = memory.all().length;
      const merged = before - after;
      if (merged > 0) log('ok', `睡眠巩固（睡了 ${sleptMin} 分钟）：合并了 ${merged} 条重复记忆`);
      else log('ok', `睡眠巩固（睡了 ${sleptMin} 分钟）：没发现重复`);
      return { merged };
    } catch (e) {
      log('warn', '睡眠巩固没做成：' + e.message);
      return { merged: 0 };
    }
  }

  state.wakeUpNow = async () => {
    if (!nap || !nap.isSleeping()) return { sleptMin: 0, place: null };
    const r = await nap.wake();
    if (r.place) wakeUp(r.place, r.sleptMin).catch(() => {});
    log('info', '被手动叫醒了');
    return r;
  };
  state.memory = memory;
  state.mood = mood;
  state.house = house;
  state.roster = roster;
  const ms = memory.stats();
  if (memory.readonly) {
    log('err', `记忆读取失败（${memory.loadError}），已进入只读模式：不会覆盖原文件，先去修权限/文件`);
  }
  const layerTxt = Object.entries(ms.byLayer || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  log('ok', `多层记忆 ${ms.total} 条 ${layerTxt ? `（${layerTxt}）` : ''}，心情「${mood.label()}」`);

  // 人设
  const { readFile } = await import('node:fs/promises');
  let persona = '';
  try {
    persona = await readFile(config.personaFile, 'utf8');
  } catch {
    persona = '你是一个有点懒散、说话随意的年轻人。';
  }

  // 能力层 + Agent
  const qqTools = createTools({ onebot: bot, log, roster, nap, stickers, memory, autonomy: () => autonomy,
    vec: () => vec,
    onActivate: (items) => { state.lastActivation = { at: Date.now(), hits: (items || []).map((x) => ({ id: x.id, act: x.activation || 0, hop: x.hop || 0 })) }; }, lastImage: () => (lastImageBuf && Date.now() - lastImageBuf.at < 600000 ? lastImageBuf : null) });
  // 外部 MCP 工具：能发现就接上，接不上不影响她自己那套
  let mcpClients = [];
  try {
    const mcp = await loadMcp(undefined, { log });
    mcpClients = mcp.clients || [];
    const n = attachMcp(qqTools, mcp.tools);
    if (n) log('ok', '工具表：本地 ' + (qqTools.tools.length - n) + ' + 外部 ' + n + ' 个');
  } catch (e) { log('warn', 'MCP 加载失败：' + e.message); }

  // 向量空间：想起的不只是最像的，还有由它牵出来的
  const vec = await new VecIndex().load();
  // 启动先对齐一次：多的删掉、缺的补上
  try {
    const r = await vec.sync(memory.all());
    if (r.pruned || r.added) log('ok', `向量对齐：删 ${r.pruned} 条、补 ${r.added} 条，现在 ${r.total} 条`);
  } catch (e) {
    log('warn', '向量对齐失败：' + e.message);
  }

  // 新记住的、删掉的，向量索引跟着变（异步，失败不影响说话）
  memory.vecHook = ({ type, item, id }) => {
    if (type === 'add' && item) vec.upsert(item).catch((e) => log('warn', '向量补录失败：' + e.message));
    if (type === 'remove' && id) vec.remove(id).catch((e) => log('warn', '向量删除失败：' + e.message));
  };
  agent = new Agent({
    llm: config.llm,
    tools: qqTools,
    persona,
    policy: config.policy,
    memory,
    mood,
    roster,
    log,
    vec,
  });
  globalThis.__dshState = state;
  state.promptsDir = ROOT + '/prompts';
  // 面板里贴的图也要能被她"存下来"
  state.setLastImage = (buf, ext = 'png') => { lastImageBuf = { buf, ext, source: 'panel', kind: 'photo', at: Date.now() }; };
  state.flushExtracts = async () => (agent ? agent.flushAllExtract() : 0);
  state.tidySession = async (sinceOverride = 0) => {
    const last = state.lastSpokeAt || Date.now();
    const since = Number(sinceOverride) || Math.max(state.lastSessionEnd || 0, state.lastReviewAt || 0) || (last - 6 * 3600 * 1000);
    const made = await consolidator.summarizeSession({ convId: 'all', since, until: Date.now(), maxDepth: 1 });
    state.lastSessionEnd = last;
    await saveMergeState();
    await memory.save();
    return made || [];
  };

  state.reloadPrompt = async () => {
    if (!agent) return;
    agent.platCache = { qq: await agent.platformPrompt('qq'), mc: await agent.platformPrompt('mc') };
    const coreText = await agent.loadCoreRules();
    log('ok', '提示词已重载：core ' + coreText.length + ' 字，qq ' + (agent.platCache.qq?.length || 0) + ' 字，mc ' + (agent.platCache.mc?.length || 0) + ' 字');
  };
  state.reloadPersona = (text) => agent.setPersona(text);
  // 从 QQ 拉好友/群成员昵称，补进人物表
  state.syncRoster = async () => {
    if (!roster) return { updated: 0 };
    let updated = 0;
    try {
      const friends = await bot.call('get_friend_list', {});
      for (const f of friends || []) {
        const p = roster.touch(String(f.user_id), { name: f.nickname || '', card: f.remark || '' });
        if (p) updated++;
      }
    } catch { /* 没连上也别崩 */ }
    try {
      const groups = await bot.call('get_group_list', {});
      for (const g of (groups || []).slice(0, 30)) {
        try {
          const members = await bot.call('get_group_member_list', { group_id: g.group_id });
          for (const m of members || []) {
            if (String(m.user_id) === String(bot.selfId)) continue;
            const p = roster.touch(String(m.user_id), {
              name: m.nickname || '',
              card: m.card || '',
              groupId: g.group_id,
            });
            if (p) updated++;
          }
        } catch { /* 单个群失败跳过 */ }
      }
    } catch { /* ignore */ }
    await roster.save().catch(() => {});
    return { updated };
  };
  // 调试：把某个群此刻会拼出来的提示词拿出来看（"他是谁"这类问题都靠它排查）
  state.previewPrompt = async (gid) => {
    const g = String(gid || '');
    const ownerId = String(config.policy.ownerQq || '');
    const ctx = {
      selfId: bot.selfId,
      groupId: g,
      userId: ownerId,
      senderId: ownerId,
      isOwner: true,
      scene: 'group',
      who: roster ? roster.nameOf(ownerId) : '主人',
    };
    return await agent.previewSystem(ctx, { scene: 'group', groupName: `群 ${g}`, hint: recentHint(g) }, '');
  };
  state.agent = agent;

  // 本地面谈：不经过 QQ，直接和她的大脑对话。
  // 用同一份记忆、同一个情绪、同一个人设 —— 只是把"身体"摘掉了。
  state.localChat = async (text, platform) => {
    // 她睡着了就不接话，连本地面谈也不理
    if (nap && nap.isSleeping()) {
      log('info', `她睡着了（还剩 ${nap.minutesLeft()} 分钟），没回`);
      return { text: null, texts: [], usedTools: [], sleeping: true };
    }
    const owner = String(process.env.OWNER_QQ || 'owner');
    const ctx = {
      selfId: bot.selfId || (process.env.ONEBOT_SELF_ID ?? ''),
      groupId: null,
      userId: owner,
      senderId: owner,
      isOwner: true,
      local: true,
      scene: 'private',
      who: roster ? roster.nameOf(owner) : '主人',
      conversationId: platform === 'mc' ? 'mc:owner' : 'local:owner',
      platform: platform || 'qq',
      // 本地面谈只放行"查资料"和"管人物表"这类只读/本地工具：碰不到 QQ
      // 本地面谈只放行"查资料"和"管人物表"这类只读/本地工具：碰不到 QQ
      // MCP 接进来的外部工具（画图等）也放行——它们不直接动 QQ
      allowTools: ['web_search', 'web_fetch', 'people_list', 'people_rename', 'go_sleep', 'recall_memories', 'qq_sticker_list', 'qq_sticker_send', 'qq_sticker_save', 'qq_recent_messages', 'look_at_image',
        ...(qqTools.tools || []).filter((t) => t.lib === 'mcp').map((t) => t.name)],
    };
    // 本地面谈也一样：说了怎么称呼就直接改
    const wantTitle = parseRename(text);
    if (wantTitle && (await applyRename(owner, wantTitle))) {
      ctx.who = wantTitle;
    }
    const r = await agent.respond({
      conversationId: 'local:owner',
      userText: text,
      ctx,
      meta: { local: true },
    });
    recordMessage({ dir: 'in', scope: 'local:owner', scopeName: '本地面谈', from: '你', text });
    const texts = [r.text, ...(r.followUps || [])].filter(Boolean);
    for (const t of texts) {
      recordMessage({ dir: 'out', scope: 'local:owner', scopeName: '本地面谈', from: '大肥鱼', text: t });
    }
    if (memory.dirty) await memory.save().catch(() => {});
    return { ...r, texts };
  };
  // 回滚之后要用：重新读盘，把内存里的记忆/情绪/人设换成恢复出来的版本
  state.reloadBrain = async () => {
    memory.readonly = false;
    await memory.load();
    await mood.load();
    agent?.setPersona?.((await house.read('persona.md', null)) || persona);
    log('ok', `记忆已重载：${memory.stats().total} 条`);
    return memory.stats();
  };
  // 最近一次记忆激活（星图动画用）
  agent.onRecall = (items, trace) => {
    if (trace) { const e = []; for (const hop of Object.keys(trace)) for (const id of (trace[hop] || [])) e.push({ id, hop: Number(hop) }); if (e.length) { state.lastActivation = { at: Date.now(), hits: e }; return; } }
    state.lastActivation = {
      at: Date.now(),
      hits: (items || []).map((x) => ({ id: x.id, act: x.activation || 0, hop: x.hop || 0 })),
    };
  };

  state.tools = qqTools;
  try {
    const coreText = await agent.loadCoreRules();
    log('ok', `核心提示词已加载：${coreText.length} 字`);
  } catch (e) { log('warn', '核心提示词没读到：' + e.message); }
  log('ok', `人设已加载，可用工具 ${qqTools.tools.length} 个`);

  // ==================== 八、注意力 ====================
  // 她的名字现在存在人物表里（自己也是一条），不再单独做一个设置项
  const seedNames = (process.env.SELF_NAMES || '大肥鱼,deepseek,肥鱼')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selfId = String(bot.selfId || process.env.ONEBOT_SELF_ID || process.env.NAPCAT_QQ || '');
  if (roster) {
    roster.ensureSelf(selfId, seedNames);
    if (roster.dirty) roster.save().catch(() => {});
  }
  const selfNames = [...new Set([...(roster ? roster.selfNames() : []), ...seedNames])];
  attention = new Attention({ brain: memory, selfNames });
  // 她给自己改名后，重新读一遍名字
  state.refreshSelfNames = () => {
    const names = [...new Set([...(roster ? roster.selfNames() : []), ...seedNames])];
    attention.setSelfNames(names);
    log('info', '她的名字已更新：' + names.join('、'));
    return names;
  };
  log('ok', `注意力就绪，认这些名字：${selfNames.join('、')}`);

  // ==================== 九、自主行为 ====================
  autonomy = new Autonomy({
    llm: config.llm,
    tools: qqTools,
    brain: memory,
    mood,
    state,
    cfg: config,
    log,
    dataDir: join(ROOT, '.data'),
    isAsleepFn: () => isAsleep(config.schedule),
    // 她自己开口说的，也要进上下文——不然她不知道自己刚说了什么
    onSpoke: (text, where, kind) => {
      const who = kind === 'initiative' ? '我（主动）' : '我';
      try {
        if (where.groupId) {
          pushRecent(String(where.groupId), who, text);
          recordMessage({ dir: 'out', scope: 'group:' + where.groupId, scopeName: '群 ' + where.groupId, from: '我', text });
        } else if (where.userId) {
          recordMessage({ dir: 'out', scope: 'user:' + where.userId, scopeName: '与 ' + where.userId + ' 私聊', from: '我', text });
        }
        if (autonomy) autonomy.noteReply(1);
        // 主动做的事也记下来，过几天她还能想起来"我自己做过什么"
        const selfId = String(bot.selfId || process.env.ONEBOT_SELF_ID || '');
        const whereText = where.groupId ? '群' + where.groupId : where.userId ? '私聊' + where.userId : '';
        const gist = '我主动' + (where.groupId ? '在群里' : '找') + '说了一句：' + text;
        const now = Date.now();
        const dup = memory.all().some((m) => m.text === gist && Math.abs((m.createdAt || 0) - now) < 10 * 60 * 1000);
        if (!dup && selfId) {
          memory.remember({
            layer: 'surface',
            text: gist.slice(0, 120),
            subject: selfId,
            whoName: '我',
            platform: 'qq',
            where: whereText,
            kind: 'event',
            weight: 3,
            weightWhy: '我自己主动做的事',
            source: 'autonomy',
          });
          log('info', '记成一条记忆：' + gist.slice(0, 30));
        }
      } catch (e) { log('warn', '记录自主发言失败：' + e.message); }
    },
  });
  await autonomy.load();
  state.autonomy = autonomy;
  if (autonomy.enabled) autonomy.start();
  log('ok', `QQ 自主行为：${autonomy.enabled ? '开（闲下来会自己找事做）' : '关'}`);

  // ==================== 十、面板改配置后立刻生效 ====================
  state.applyLive = (patch) => {
    const applied = [];
    const num = (k) => Number(patch[k]);
    const bool = (k) => String(patch[k]).toLowerCase() === 'true';

    const setNum = (key, target, field, label) => {
      if (!(key in patch) || !target || Number.isNaN(num(key))) return;
      target[field] = num(key);
      applied.push(label);
    };

    setNum('REPLY_DELAY_MIN_MS', config.human, 'replyDelayMin', '最短延迟');
    setNum('REPLY_DELAY_MAX_MS', config.human, 'replyDelayMax', '最长延迟');
    setNum('BUSY_CHANCE', config.human, 'busyChance', '在忙概率');
    setNum('SPLIT_CHANCE', config.human, 'splitChance', '分段概率');
    setNum('SPLIT_MIN_CHARS', config.human, 'minSplitChars', '拆段门槛');
    setNum('MAX_SEGMENTS', config.human, 'maxSegments', '最多分段');
    setNum('TYPO_CHANCE', config.human, 'typoChance', '错字概率');
    if ('HUMANIZE' in patch) {
      config.human.enabled = bool('HUMANIZE');
      applied.push('拟人化');
    }

    // 情绪相关的参数由 Mood 在用到时直接读环境变量，这里只需要报告"已生效"
    const MOOD_LIVE = {
      MOOD_ENERGY_RECOVER_HOURS: '精力恢复速度',
      MOOD_ENERGY_RECOVER_CAP: '精力恢复上限',
      MOOD_VALENCE_RECOVER_HOURS: '情绪平复速度',
      MOOD_SELF_RECOVER_PERCENT: '情绪恢复上限',
      MOOD_COST_REPLY: '说话消耗',
      MOOD_COST_TOOL: '做事消耗',
    };
    for (const [k, label] of Object.entries(MOOD_LIVE)) {
      if (k in patch) applied.push(label);
    }

    if ('RATE_LIMIT_PER_MIN' in patch) {
      setNum('RATE_LIMIT_PER_MIN', config.policy, 'rateLimitPerMin', '限流');
      qqLimiter.setPerMin(config.policy.rateLimitPerMin);   // 立刻生效
    }
    if ('GROUP_REQUIRE_AT' in patch) {
      config.policy.groupRequireAt = bool('GROUP_REQUIRE_AT');
      applied.push('必须@');
    }
    if ('PRIVATE_ENABLED' in patch) {
      config.policy.privateEnabled = bool('PRIVATE_ENABLED');
      applied.push('私聊开关');
    }
    if ('GROUP_ALLOW' in patch) {
      config.policy.groupAllow = String(patch.GROUP_ALLOW).split(',').map((s) => s.trim()).filter(Boolean);
      applied.push('群白名单');
    }
    if ('GROUP_DENY' in patch) {
      config.policy.groupDeny = String(patch.GROUP_DENY).split(',').map((s) => s.trim()).filter(Boolean);
      applied.push('群黑名单');
    }
    if ('OWNER_QQ' in patch) {
      config.policy.ownerQq = String(patch.OWNER_QQ).trim();
      applied.push('主人QQ');
    }
    if ('SELF_NAMES' in patch && attention) {
      attention.setSelfNames(String(patch.SELF_NAMES).split(','));
      applied.push('她的名字');
    }
    if ('AUTONOMY' in patch && autonomy) {
      const on = bool('AUTONOMY');
      autonomy.setEnabled(on);
      if (on) autonomy.start();
      else autonomy.stop();
      applied.push('自主行为');
    }
    if ('AUTONOMY_THRESHOLD' in patch && autonomy) {
      autonomy.threshold = num('AUTONOMY_THRESHOLD');
      applied.push('自主阈值');
    }
    if ('AUTONOMY_VITALITY_MAX' in patch && autonomy) {
      autonomy.vitalityMax = num('AUTONOMY_VITALITY_MAX');
      autonomy.vitality = Math.min(autonomy.vitality, autonomy.vitalityMax);
      applied.push('活力上限');
    }
    if ('AUTONOMY_VITALITY_RESET_HOUR' in patch && autonomy) {
      autonomy.resetHour = num('AUTONOMY_VITALITY_RESET_HOUR');
      applied.push('活力刷新时间');
    }
    if ('AUTONOMY_TICK_MIN' in patch && autonomy) {
      autonomy.tickMs = num('AUTONOMY_TICK_MIN') * 60000;
      applied.push('检查间隔');
    }
    if ('LLM_TEMPERATURE' in patch && !Number.isNaN(num('LLM_TEMPERATURE'))) {
      config.llm.temperature = num('LLM_TEMPERATURE');
      applied.push('措辞温度');
    }

    return applied;
  };
  if (!config.policy.ownerQq) {
    log('warn', '没配 OWNER_QQ，破坏性操作（踢人/禁言/删好友）一律会被拒绝');
  }

  // ==================== 十一、面板接口 ====================
  state.send = async ({ targetKind, targetId, text }) => {
    if (targetKind === 'group') await bot.sendGroup(targetId, text);
    else await bot.sendPrivate(targetId, text);
    recordMessage({
      dir: 'out',
      scope: `${targetKind}:${targetId}`,
      scopeName: `${targetKind === 'group' ? '群' : '私聊'} ${targetId}（面板）`,
      from: '我(面板)',
      text,
    });
  };

  // 定时任务集中在 scheduler/ 里
  startScheduler({ mood, memory, nap, state, log, wakeUp, vec, isAsleep: () => isAsleep(config.schedule), onBigWake: (mins) => sleepConsolidate(mins),
    // 她一进入睡眠：缓冲里还有没提取的对话，就先提取 + 做一次"会话结束"那种整合
    onSleepStart: async (why) => {
      try {
        const pending = agent ? agent.pendingExtracts() : 0;
        if (!pending) return;                                  // 没有攒着的话就什么都不做
        // 每次睡眠用一个独立标记：作息看 sleepStartedAt，小睡看这次小睡的结束时间
        const marker = why + ':' + (state.sleepStartedAt || nap?.until || Math.floor(Date.now() / 60000));
        if (state.sleepFlushedFor === marker) return;
        state.sleepFlushedFor = marker;
        log('info', '要睡了（' + why + '）：还有 ' + pending + ' 段对话没整理');
        const last = state.lastSpokeAt || Date.now();
        // 时间窗：上次整合（或上次复盘）到现在。第一次跑才退回 6 小时
        const since = Math.max(state.lastSessionEnd || 0, state.lastReviewAt || 0) || (last - 6 * 3600 * 1000);
        await agent.flushAllExtract();                          // ① 提取（只新增）
        try {
          const made = await consolidator.summarizeSession({ convId: 'all', since, until: Date.now(), maxDepth: 1 });
          if (made && made.length) log('ok', '睡前整合成 ' + made.length + ' 条');
        } catch (e) { log('warn', '睡前整合失败：' + e.message); }
        state.lastSessionEnd = last;
        await saveMergeState();
        await memory.save();
      } catch (e) { log('warn', '睡前处理失败：' + e.message); }
    },
    onNightReview: async (mins) => {
      try {
        await consolidator.review({ since: state.lastReviewAt || null });
        state.lastReviewAt = Date.now();
        await saveMergeState();
        try { await consolidator.deepMerge({ since: state.lastReviewAt - 24 * 3600 * 1000 }); } catch (e) { log('warn', '二层整合失败：' + e.message); }
        try { await consolidator.refreshMerged(); } catch (e) { log('warn', '整合改写失败：' + e.message); }
        try { if (vec) await vec.sync(memory.all()); } catch {}
        log('ok', '熟睡 ' + mins + ' 分钟，复盘完成');
      } catch (e) { log('warn', '复盘失败：' + e.message); }
    } });

  // 启动体检：有问题早发现，别等崩了才知道
  try {
    const hb = await healthCheck({ memory, connected: false });
    const lines = formatHealth(hb);
    log('ok', '启动体检：' + lines[0]);
    for (const l of lines.slice(1)) log(l.startsWith('✗') ? 'err' : 'warn', l);
  } catch (e) {
    log('warn', '体检没跑起来：' + e.message);
  }

  await loadRecent();
  await state.reloadPrompt();

  startWebUI({ state, port: Number(process.env.BOT_API_PORT || 8788), servePage: false });

  if (config.dryRun) log('warn', '当前是 dry-run：只打印不发送');
  if (isAsleep(config.schedule)) log('info', '现在处于睡眠时段，不会回复');

  bot.on('log', (kind, msg) => log(kind, msg));
  // 让面板能读到真实连接状态
  function napcatStateOnline(v) { state.online = v; }
bot.on('ready', () => { state.online = true; napcatStateOnline(true); });
  bot.on('close', () => { state.online = false; napcatStateOnline(false); });

  bot.on('event', (ev) => {
    (async () => {
      try {
        if (ev.post_type !== 'message') return;
        if (String(ev.user_id) === bot.selfId) return;

        if (ev.message_type === 'group') await handleGroup(ev);
        else if (ev.message_type === 'private') await handlePrivate(ev);
      } catch (err) {
        log('err', err?.stack || String(err));
      }
    })();
  });

  bot.start(); // 内部自动重连，不阻塞

  bot.once('ready', async () => {
    try {
      const info = await bot.getLoginInfo();
      if (info?.user_id) bot._selfId = String(info.user_id);
      log('ok', `登录账号：${info?.nickname ?? '?'} (${info?.user_id ?? '?'})`);
    } catch (err) {
      log('warn', `拿不到登录信息：${err.message}`);
    }
  });

  const shutdown = () => {
    log('info', '收到退出信号，收尾中');
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('err', err?.stack || String(err));
  process.exit(1);
});