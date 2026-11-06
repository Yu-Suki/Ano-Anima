import { resolveTarget, textSeg, clip } from '../../tools/shared.js';
import { splitFaces } from '../../senses/facemap.js';
import { fileURLToPath } from 'node:url';

// 表情描述存哪（src/adapters/qq/ → 往上三级到项目根）
const META_FILE = fileURLToPath(new URL('../../../.data/sticker-meta.json', import.meta.url));
const metaPath = () => META_FILE;

// QQ：她在这个平台上的手
// 依赖 onebot（发消息）、roster（人物表）、nap（小睡）、log
export function qqTools({ onebot, roster = null, nap = null, log = null }) {
  const call = (action, params) => onebot.call(action, params);

const asFaceList = (d) => {
    if (!d) return [];
    if (Array.isArray(d)) return d.filter((x) => typeof x === 'string' || (x && (x.url || x.emojiId || x.id)));
    if (typeof d === 'string') return [d];
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.faces)) return d.faces;
    if (Array.isArray(d.faceList)) return d.faceList;
    return [];
  };

const facesOf = (d) => {
    if (!d || d.__error || d.__httpError) return [];
    if (Array.isArray(d)) return d.map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
    if (typeof d === 'string') return [d];
    return [];
  };

const loadMeta = async () => {
    const fs = await import('node:fs/promises');
    try { return JSON.parse(await fs.readFile(metaPath(), 'utf8')); } catch { return {}; }
  };

const saveMeta = async (m) => {
    const fs = await import('node:fs/promises');
    try { await fs.mkdir(process.cwd() + '/.data', { recursive: true }); } catch {}
    await fs.writeFile(metaPath(), JSON.stringify(m, null, 1), 'utf8');
  };

const md5Of = (url) => {
    const m = String(url || '').match(/_([0-9A-Fa-f]{32})_/);
    return m ? m[1].toUpperCase() : '';
  };



  // QQ 表情收藏走的是 HTTP 接口（不是 WS），单独一条路
  const faceHttp = async (action, params = {}) => {
    const http = await import('node:http');
    const tok = process.env.ONEBOT_HTTP_TOKEN || '';
    const body = JSON.stringify(params);
    const j = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: 3000, path: '/' + action, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ retcode: -1 }); } });
        },
      );
      req.on('error', (e) => resolve({ retcode: -1, wording: e.message }));
      req.write(body); req.end();
    });
    if (j.retcode !== 0) { log?.('warn', action + ' 失败：' + (j.wording || j.retcode)); return { __error: j.wording || 'retcode ' + j.retcode }; }
    return j.data;
  };


  const recentMessages = {
      name: 'qq_recent_messages',
      description: '拉这个群最近的消息（谁说的、说了什么、消息 id）。进群发现接不上话、或者想引用某句之前，先看这个。',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: '群号；不填就用当前群' },
          count: { type: 'number', description: '拉多少条，默认 15' },
        },
        required: [],
      },
      async run(args = {}, ctx = {}) {
        const gid = String(args.group_id || ctx.groupId || '');
        if (!gid) return { error: '不在群里，拿不到群记录' };
        const n = Math.min(30, Math.max(3, Number(args.count) || 15));
        const data = await call('get_group_msg_history', { group_id: Number(gid), count: n });
        const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
        if (!list.length) return { 条数: 0, 提示: '这个群最近没有消息' };
        return list.slice(-n).map((m) => {
          const segs = Array.isArray(m.message) ? m.message : [];
          const txt = segs.map((s) => (s.type === 'text' ? s.data?.text : s.type === 'image' ? '[图]' : s.type === 'face' ? '[表情]' : '')).join('');
          const who = m.sender?.card || m.sender?.nickname || String(m.user_id);
          return { id: m.message_id, 谁: who, 说了: txt.slice(0, 80) };
        });
      },
    };
  
  const stickerSave = {
      name: 'qq_sticker_save',
      description: '把刚收到的这张图存进 QQ 的表情收藏夹（用 add_custom_face）。你喜欢就存，不用问。',
      parameters: {
        type: 'object',
        properties: { why: { type: 'string', description: '为什么喜欢，一句话' } },
        required: [],
      },
      async run(args = {}) {
        const img = typeof lastImage === 'function' ? lastImage() : null;
        if (!img) return { error: '这会儿手上没有图，存不了' };
        if (img.source !== 'qq') return { error: '这张不是聊天里收到的，存不了' };
        // QQ 的图常常只有文件没有 url，那就用 base64 传
        const file = img.url || ('base64://' + img.buf.toString('base64'));
        justSavedUrl = img.url || '';
        // 先凭印象判断：这张看着眼熟吗（不花 token）
        const { findSimilar } = await import('../util/similar.js');
        const { imageHash, findSameHash } = await import('../../senses/phash.js');
        const myPh = await imageHash(img.buf);
        const metaNow = await loadMeta();
        const samePix = findSameHash(myPh, Object.values(metaNow));
        const familiar = samePix || findSimilar(img.desc || '', Object.values(metaNow));
        if (familiar) {
          log?.('info', '这张看着眼熟，已经存过了');
          return { 已经存过了: true, 说明: '你记得存过这张：' + (familiar.item.desc || '').slice(0, 20) };
        }
        const pre = await faceHttp('fetch_custom_face_detail');
        const preArr = Array.isArray(pre) ? pre : [];
        const before = await faceHttp('fetch_custom_face_detail');
        const beforeSet = new Set((Array.isArray(before) ? before : []).map((x) => x.md5));
        const r = await faceHttp('add_custom_face', { file });
        if (r && r.__error) {
          // QQ 对重复表情会拒绝：数量没变、最新的也不是这张 → 那就是存过
          const again = await faceHttp('fetch_custom_face_detail');
          const list2 = Array.isArray(again) ? again : [];
          if (list2.length === preArr.length) {
            return { 已经存过了: true, 说明: '这张收藏夹里已经有了，不用再存' };
          }
          return { error: '存不进去：' + r.__error };
        }
        // 记下这张是什么
        const after = await faceHttp('fetch_custom_face_detail');
        const arr = Array.isArray(after) ? after : [];
        const fresh = arr.find((x) => !beforeSet.has(x.md5)) || arr[arr.length - 1] || {};
        const key = fresh.md5 || md5Of(fresh.url || '') || md5Of(img.url);
        const meta = await loadMeta();
        if (key) {
          meta[key] = { desc: img.desc || '', why: args.why || '', ph: myPh, at: Date.now() };
          await saveMeta(meta);
        }
        log?.('info', `存进 QQ 表情收藏：${(img.url || img.desc || '图片').slice(0, 60)}…${args.why ? ' ' + args.why : ''}`);
        return { 存好了: true, 这张是: img.desc || '', 为什么喜欢: args.why || '', 收藏总数: arr.length };
      },
    };
  
  const stickerList = {
      name: 'qq_sticker_list',
      description: '看看这个 QQ 号自己收藏了哪些表情（QQ 原生的收藏夹，不是另外建的）',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const data = await faceHttp('fetch_custom_face');
        if (data && data.__error) return { error: data.__error };
        const urls = facesOf(data);
        if (!urls.length) return { 条数: 0, 提示: '收藏夹是空的，在 QQ 里右键图片 → 添加到表情' };
        const meta = await loadMeta();
        // 没见过就现场看一眼，看完记住
        const { describeImage } = await import('../../senses/index.js');
        let learned = 0;
        for (let x = 0; x < Math.min(urls.length, 10); x++) {
          const k = md5Of(urls[x]);
          if (!k || meta[k]?.desc || learned >= 5) continue;
          try {
            const res = await fetch(urls[x]);
            const buf = Buffer.from(await res.arrayBuffer());
            meta[k] = { desc: await describeImage(buf.toString('base64'), '', 'sticker'), why: '', at: Date.now() };
            learned++;
          } catch {}
        }
        if (learned) await saveMeta(meta);
        return urls.slice(0, 30).map((u, i) => {
          const k = md5Of(u);
          return { 序号: i + 1, 是什么: meta[k]?.desc || '（还没看清）' };
        });
      },
    };
  
    const stickerSend = {
      name: 'qq_sticker_send',
      description: '发一个你在 QQ 里收藏的表情出去。可以给序号（先用 sticker_list 看）。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '第几个，从 1 开始；不填就随便挑一个' },
        },
        required: [],
      },
      async run(args = {}, ctx = {}) {
        const data = await call('fetch_custom_face', {});
        const arr = asFaceList(data).map((x) => (typeof x === 'string' ? { url: x } : x));
        if (!arr.length) return { error: 'QQ 收藏夹是空的 —— 先在 QQ 客户端里收藏几个表情' };
        const i = Math.max(1, Math.min(arr.length, Number(args.index) || 1 + Math.floor(Math.random() * arr.length)));
        const it = arr[i - 1] || {};
        const url = it.url || it.emojiUrl || '';
        const id = it.emojiId || it.id || it.md5 || '';
        const isGroup = Boolean(ctx.groupId);
        const target = isGroup
          ? { message_type: 'group', group_id: Number(ctx.groupId) }
          : { message_type: 'private', user_id: Number(ctx.userId) };
        const where = isGroup ? '群 ' + (ctx.groupName || ctx.groupId) : '私聊 ' + (ctx.who || ctx.userId);
        // 表情通常用 face 段发；没有 id 就退回图片 url
        const seg = id
          ? { type: 'image', data: { file: id, sub_type: 1, summary: '[动画表情]' } }
          : { type: 'image', data: { file: url } };
        await call('send_msg', { ...target, message: [seg] });
        log?.('info', `发了个 QQ 收藏表情（第 ${i} 个）`);
        return { 发出去了: true, 序号: i };
      },
    };
  
    // ---------- 读 ----------
    const listFriends = {
      name: 'qq_list_friends',
      description: '获取好友列表（含 QQ 号、昵称、备注）',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const data = await call('get_friend_list', {});
        return clip(data.map((f) => ({ qq: f.user_id, 昵称: f.nickname, 备注: f.remark || '' })), '好友');
      },
    };
  
    const listGroups = {
      name: 'qq_list_groups',
      description: '获取已加入的 QQ 群列表',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const data = await call('get_group_list', {});
        return clip(data.map((g) => ({ 群号: g.group_id, 群名: g.group_name, 人数: g.member_count })), '群');
      },
    };
  
    const listMembers = {
      name: 'qq_list_group_members',
      description: '获取某个群的成员列表，可按昵称/群名片关键字过滤',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: '群号，不填则用当前群' },
          keyword: { type: 'string', description: '只返回昵称或群名片包含这个关键字的成员' },
        },
        required: [],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '不在群里，需要提供 group_id' };
        let data = await call('get_group_member_list', { group_id: gid });
        if (args.keyword) {
          const k = String(args.keyword).toLowerCase();
          data = data.filter(
            (m) =>
              String(m.nickname || '').toLowerCase().includes(k) ||
              String(m.card || '').toLowerCase().includes(k),
          );
        }
        return clip(
          data.map((m) => ({
            qq: m.user_id,
            昵称: m.nickname,
            群名片: m.card || '',
            角色: m.role,
          })),
          '成员',
        );
      },
    };
  
    const userInfo = {
      name: 'qq_user_info',
      description: '查一个 QQ 号的资料（昵称、性别、年龄、等级）',
      parameters: {
        type: 'object',
        properties: { user_id: { type: 'string', description: 'QQ 号' } },
        required: ['user_id'],
      },
      async run(args) {
        const d = await call('get_stranger_info', { user_id: String(args.user_id) });
        return {
          qq: d.user_id,
          昵称: d.nickname,
          性别: d.sex,
          年龄: d.age,
          等级: d.qqLevel ?? d.level ?? null,
        };
      },
    };
  
    const history = {
      name: 'qq_history',
      description: '拉取聊天记录。群聊传 group_id，私聊传 user_id，都不传则用当前会话',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string' },
          count: { type: 'number', description: '要多少条，默认 20，最多 100' },
        },
        required: [],
      },
      async run(args, ctx) {
        const n = Math.min(Number(args.count) || 20, 100);
        const t = resolveTarget(args, ctx);
        if (!t) return { error: '没有可用的会话' };
        const action = t.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
        const params = t.kind === 'group' ? { group_id: t.id, count: n } : { user_id: t.id, count: n };
        const d = await call(action, params);
        const msgs = d?.messages ?? [];
        return msgs.map((m) => ({
          发送者: m.sender?.nickname || m.user_id,
          内容: (m.message || [])
            .map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`))
            .join(''),
          时间: m.time,
        }));
      },
    };
  
    const recentContacts = {
      name: 'qq_recent_contacts',
      description: '最近联系人列表',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: [],
      },
      async run(args) {
        const d = await call('get_recent_contact', { count: Number(args.count) || 10 });
        return clip(
          (d || []).map((x) => ({ 类型: x.chatType, 对方: x.peerUin, 名称: x.remark || x.peerName })),
          '联系人',
        );
      },
    };
  
    // ---------- 发消息 ----------
    const sendText = {
      name: 'qq_send_text',
      description: '把消息发到别的地方（别的群/别的人）。当前会话不用调这个，直接说话就行。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发的内容' },
          group_id: { type: 'string', description: '发给哪个群' },
          user_id: { type: 'string', description: '发给哪个好友（QQ号）' },
          to: { type: 'string', description: '发给谁（直接写名字，比如"妈妈""俞"，会自动查成 QQ 号）' },
        },
        required: ['text'],
      },
      async run(args, ctx) {
        // 用名字找人：查人物表里的别名
        if (!args.user_id && !args.group_id && args.to) {
          try {
            const hits = roster.findIn(String(args.to));
            if (hits.length === 1) args = { ...args, user_id: hits[0].id };
            else if (hits.length > 1) return { error: '「' + args.to + '」对上了好几个人：' + hits.map((h) => h.title || h.id).join('、') + '，说清楚是哪个' };
            else return { error: '人物表里没有叫「' + args.to + '」的人' };
          } catch (e) { log('warn', '按名字找人失败：' + e.message + '（roster=' + (roster ? '有' : 'null') + '）'); }
        }
        const t = resolveTarget(args, ctx);
        if (!t) return { error: '没有目标会话' };
        // 目标就是当前会话 → 不要用工具发，直接说话（否则同一句会发两遍）
        const here = ctx.groupId ? 'group:' + ctx.groupId : ctx.userId ? 'private:' + ctx.userId : '';
        if (here && here === t.kind + ':' + t.id && !args.force) {
          return { error: '这就在当前会话，直接把话写出来就行，不用调发送工具' };
        }
        const msg = splitFaces(args.text);
        const r =
          t.kind === 'group'
            ? await call('send_group_msg', { group_id: t.id, message: msg })
            : await call('send_private_msg', { user_id: t.id, message: msg });
        return { ok: true, message_id: r?.message_id, 发到: `${t.kind}:${t.id}` };
      },
    };
  
    const sendImage = {
      name: 'qq_send_image',
      description: '发一张图片。file 可以是 http(s) 链接、本地绝对路径，或 base64://...',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '图片地址或路径' },
          group_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['file'],
      },
      async run(args, ctx) {
        const t = resolveTarget(args, ctx);
        if (!t) return { error: '没有目标会话' };
        const msg = [{ type: 'image', data: { file: String(args.file) } }];
        const r =
          t.kind === 'group'
            ? await call('send_group_msg', { group_id: t.id, message: msg })
            : await call('send_private_msg', { user_id: t.id, message: msg });
        return { ok: true, message_id: r?.message_id };
      },
    };
  
    const sendFile = {
      name: 'qq_send_file',
      description: '发一个文件（私聊或群）。path 必须是本机绝对路径',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机文件的绝对路径' },
          name: { type: 'string', description: '对方看到的文件名' },
          group_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['path'],
      },
      async run(args, ctx) {
        const t = resolveTarget(args, ctx);
        if (!t) return { error: '没有目标会话' };
        const name = args.name || String(args.path).split(/[\\/]/).pop();
        const r =
          t.kind === 'group'
            ? await call('upload_group_file', { group_id: t.id, file: args.path, name })
            : await call('upload_private_file', { user_id: t.id, file: args.path, name });
        return { ok: true, result: r ?? null };
      },
    };
  
    const sendAt = {
      name: 'qq_at_member',
      description: '在群里发一条消息并 @ 某个人',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string', description: '要 @ 的 QQ 号' },
          text: { type: 'string' },
        },
        required: ['user_id', 'text'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '只有在群里才能 @ 人' };
        const msg = [
          { type: 'at', data: { qq: String(args.user_id) } },
          textSeg(' ' + args.text),
        ];
        const r = await call('send_group_msg', { group_id: gid, message: msg });
        return { ok: true, message_id: r?.message_id };
      },
    };
  
    const replyQuote = {
      name: 'qq_quote_reply',
      description: '引用某条消息回复',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: '被引用的消息 id' },
          text: { type: 'string' },
          group_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
      async run(args, ctx) {
        const t = resolveTarget(args, ctx);
        if (!t) return { error: '没有目标会话' };
        const msg = [{ type: 'reply', data: { id: String(args.message_id) } }, textSeg(args.text)];
        const r =
          t.kind === 'group'
            ? await call('send_group_msg', { group_id: t.id, message: msg })
            : await call('send_private_msg', { user_id: t.id, message: msg });
        return { ok: true, message_id: r?.message_id };
      },
    };
  
    const poke = {
      name: 'qq_poke',
      description: '戳一戳某人（好友或群成员）',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          group_id: { type: 'string', description: '在群里戳人时填群号' },
        },
        required: ['user_id'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (gid) {
          await call('group_poke', { group_id: gid, user_id: String(args.user_id) });
        } else {
          await call('friend_poke', { user_id: String(args.user_id) });
        }
        return { ok: true };
      },
    };
  
    const like = {
      name: 'qq_like',
      description: '给好友的资料卡点赞',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          times: { type: 'number', description: '点几次，默认 1，最多 10' },
        },
        required: ['user_id'],
      },
      async run(args) {
        const n = Math.min(Number(args.times) || 1, 10);
        await call('send_like', { user_id: String(args.user_id), times: n });
        return { ok: true, times: n };
      },
    };
  
    const recall = {
      name: 'qq_recall',
      description: '撤回一条消息（只能撤自己发的，或管理员撤群员）',
      parameters: {
        type: 'object',
        properties: { message_id: { type: 'string' } },
        required: ['message_id'],
      },
      async run(args) {
        await call('delete_msg', { message_id: String(args.message_id) });
        return { ok: true };
      },
    };
  
    // ---------- 群管理（破坏性，需确认） ----------
    const kick = {
      name: 'qq_kick_member',
      description: '把成员踢出群。破坏性操作，必须用户明确同意后才能调用',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string' },
          reject_add_request: { type: 'boolean', description: '是否同时拒绝此人再次加群' },
          confirm: { type: 'boolean', description: '用户已明确同意才传 true' },
        },
        required: ['user_id', 'confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_kick', {
          group_id: gid,
          user_id: String(args.user_id),
          reject_add_request: Boolean(args.reject_add_request),
        });
        return { ok: true, 已踢出: args.user_id };
      },
    };
  
    const mute = {
      name: 'qq_mute_member',
      description: '禁言群成员。破坏性操作，必须用户明确同意后才能调用',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string' },
          seconds: { type: 'number', description: '禁言秒数，0 表示解除禁言' },
          confirm: { type: 'boolean' },
        },
        required: ['user_id', 'seconds', 'confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_ban', {
          group_id: gid,
          user_id: String(args.user_id),
          duration: Number(args.seconds) || 0,
        });
        return { ok: true, 禁言秒数: Number(args.seconds) || 0 };
      },
    };
  
    const wholeBan = {
      name: 'qq_mute_all',
      description: '开启或关闭全员禁言。破坏性操作，必须用户明确同意',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          enable: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
        required: ['enable', 'confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_whole_ban', { group_id: gid, enable: Boolean(args.enable) });
        return { ok: true, 全员禁言: Boolean(args.enable) };
      },
    };
  
    const setAdmin = {
      name: 'qq_set_admin',
      description: '设置或取消群管理员。破坏性操作，必须用户明确同意',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string' },
          enable: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
        required: ['user_id', 'enable', 'confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_admin', {
          group_id: gid,
          user_id: String(args.user_id),
          enable: Boolean(args.enable),
        });
        return { ok: true };
      },
    };
  
    const renameGroup = {
      name: 'qq_rename_group',
      description: '改群名称。破坏性操作，必须用户明确同意',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          group_name: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['group_name', 'confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_name', { group_id: gid, group_name: String(args.group_name) });
        return { ok: true, 新群名: args.group_name };
      },
    };
  
    const leaveGroup = {
      name: 'qq_leave_group',
      description: '退出某个群。破坏性操作，必须用户明确同意',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          dismiss: { type: 'boolean', description: '群主解散群，仅群主可用' },
          confirm: { type: 'boolean' },
        },
        required: ['confirm'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('set_group_leave', { group_id: gid, is_dismiss: Boolean(args.dismiss) });
        return { ok: true };
      },
    };
  
    // ---------- 群管理（非破坏性） ----------
    const setCard = {
      name: 'qq_set_card',
      description: '改群名片（不填 user_id 就改自己的）',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          user_id: { type: 'string' },
          card: { type: 'string' },
        },
        required: ['card'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        const uid = args.user_id || ctx.selfId;
        await call('set_group_card', { group_id: gid, user_id: String(uid), card: String(args.card) });
        return { ok: true };
      },
    };
  
    const notice = {
      name: 'qq_group_notice',
      description: '发群公告（需要管理员权限）',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['content'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('_send_group_notice', { group_id: gid, content: String(args.content) });
        return { ok: true };
      },
    };
  
    const sign = {
      name: 'qq_group_sign',
      description: '群签到',
      parameters: {
        type: 'object',
        properties: { group_id: { type: 'string' } },
        required: [],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '需要 group_id' };
        await call('send_group_sign', { group_id: gid });
        return { ok: true };
      },
    };
  
    // ---------- 好友 / 资料 ----------
    const setRemark = {
      name: 'qq_set_friend_remark',
      description: '给好友改备注',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          remark: { type: 'string' },
        },
        required: ['user_id', 'remark'],
      },
      async run(args) {
        await call('set_friend_remark', { user_id: String(args.user_id), remark: String(args.remark) });
        return { ok: true };
      },
    };
  
    const deleteFriend = {
      name: 'qq_delete_friend',
      description: '删除好友。破坏性操作，必须用户明确同意',
      destructive: true,
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['user_id', 'confirm'],
      },
      async run(args) {
        await call('delete_friend', { user_id: String(args.user_id) });
        return { ok: true, 已删除: args.user_id };
      },
    };
  
    const handleFriendReq = {
      name: 'qq_handle_friend_request',
      description: '同意或拒绝一个加好友请求',
      parameters: {
        type: 'object',
        properties: {
          flag: { type: 'string', description: '请求的 flag，来自好友请求事件' },
          approve: { type: 'boolean' },
          remark: { type: 'string' },
        },
        required: ['flag', 'approve'],
      },
      async run(args) {
        await call('set_friend_add_request', {
          flag: String(args.flag),
          approve: Boolean(args.approve),
          remark: args.remark || '',
        });
        return { ok: true };
      },
    };
  
    const handleGroupReq = {
      name: 'qq_handle_group_request',
      description: '同意或拒绝一个入群请求',
      parameters: {
        type: 'object',
        properties: {
          flag: { type: 'string' },
          approve: { type: 'boolean' },
          reason: { type: 'string', description: '拒绝理由' },
        },
        required: ['flag', 'approve'],
      },
      async run(args) {
        await call('set_group_add_request', {
          flag: String(args.flag),
          approve: Boolean(args.approve),
          reason: args.reason || '',
        });
        return { ok: true };
      },
    };
  
    const setSignature = {
      name: 'qq_set_signature',
      description: '改自己的个性签名',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async run(args) {
        await call('set_self_longnick', { longNick: String(args.text) });
        return { ok: true, 签名: args.text };
      },
    };
  
    const setNickname = {
      name: 'qq_set_nickname',
      description: '改自己的 QQ 昵称',
      parameters: {
        type: 'object',
        properties: { nickname: { type: 'string' } },
        required: ['nickname'],
      },
      async run(args) {
        await call('set_qq_profile', { nickname: String(args.nickname) });
        return { ok: true, 昵称: args.nickname };
      },
    };
  
    const onlineClients = {
      name: 'qq_online_clients',
      description: '查看这个号现在在哪些设备上在线',
      parameters: { type: 'object', properties: {}, required: [] },
      async run() {
        const d = await call('get_online_clients', {});
        return d;
      },
    };
  
    // ---------- 形象 / 语音 / 动态 ----------
    const setAvatar = {
      name: 'qq_set_avatar',
      description: '换自己的 QQ 头像。file 留空就从 assets/avatars 里随机挑一张（等于"按自己喜好挑"）',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '图片绝对路径或 URL；留空=从图库里随机挑' },
        },
        required: [],
      },
      async run(args) {
        let file = args.file;
        let picked = '';
  
        if (!file) {
          const files = await readdir(AVATAR_DIR).catch(() => []);
          const imgs = files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
          if (!imgs.length) {
            return { error: 'assets/avatars 里没有图片，先放几张进去，或者直接给我一个图片路径' };
          }
          picked = imgs[Math.floor(Math.random() * imgs.length)];
          file = join(AVATAR_DIR, picked);
        } else {
          picked = String(file).split(/[\\/]/).pop();
        }
  
        await call('set_qq_avatar', { file });
        return { ok: true, 换成: picked };
      },
    };
  
    const listVoices = {
      name: 'qq_list_ai_voices',
      description: '列出群里可用的 AI 语音角色（发语音前先查，group_id 是必需的）',
      parameters: {
        type: 'object',
        properties: { group_id: { type: 'string' } },
        required: [],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: '查语音角色需要群号' };
        const d = await call('get_ai_characters', { group_id: gid });
        return d ?? {};
      },
    };
  
    const sendVoice = {
      name: 'qq_send_voice',
      description: '在群里发一条 AI 语音。只能群聊。常用角色：lucy-voice-houge(猴哥)、lucy-voice-laibixiaoxin(小新)',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          text: { type: 'string', description: '要说的话' },
          character: { type: 'string', description: '语音角色 id，不确定就先调 qq_list_ai_voices' },
        },
        required: ['text'],
      },
      async run(args, ctx) {
        const gid = args.group_id || ctx.groupId;
        if (!gid) return { error: 'AI 语音只能发在群里，私聊做不到' };
        const r = await call('send_group_ai_record', {
          group_id: gid,
          text: String(args.text),
          character: args.character || 'lucy-voice-houge',
        });
        return { ok: true, result: r ?? null };
      },
    };
  
    // QQ 空间说说：不在 NapCat 标准 API 里，走网页协议，默认关闭
    const postMoment = {
      name: 'qq_post_moment',
      description: '在 QQ 空间发一条说说。默认关闭，需 .env 里 ENABLE_QZONE=1；这个接口未经充分验证',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '说说正文' },
          visibility: { type: 'string', description: 'public 或 private，默认 private（仅自己可见）' },
        },
        required: ['text'],
      },
      async run(args, ctx) {
        if (process.env.ENABLE_QZONE !== '1') {
          return {
            error:
              '说说功能默认关着。QQ 空间的发布接口不在 NapCat 标准 API 里，是走网页协议，我没有充分验证过。' +
              '要试的话把 .env 里 ENABLE_QZONE 设成 1，然后重启机器人。',
          };
        }
  
        try {
          const csrf = await call('get_csrf_token', {});
          const cookies = await call('get_cookies', { domain: 'user.qzone.qq.com' });
  
          const jar = Array.isArray(cookies) ? cookies : Object.values(cookies || {});
          const cookieStr = jar
            .map((c) => (typeof c === 'string' ? c : c?.name && `${c.name}=${c.value}`))
            .filter((s) => s && s.includes('='))
            .join('; ');
  
          const gtk = typeof csrf === 'string' ? csrf : csrf?.token ?? csrf?.csrfToken ?? '';
          const uin = String(ctx.selfId || '');
          const who = args.visibility === 'public' ? 1 : 4; // 4 = 仅自己可见
  
          const body = new URLSearchParams({
            con: String(args.text),
            hostuin: uin,
            qzreferrer: `https://user.qzone.qq.com/${uin}`,
            who: String(who),
            format: 'json',
          });
  
          const res = await fetch(
            `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${encodeURIComponent(gtk)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookieStr,
                Referer: `https://user.qzone.qq.com/${uin}`,
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
              },
              body: body.toString(),
            },
          );
  
          const raw = await res.text();
          return { ok: res.ok, http: res.status, 返回: raw.slice(0, 300) };
        } catch (err) {
          return { error: `说说接口调用失败：${err.message}` };
        }
      },
    };

  return [recentMessages, stickerSave, stickerList, stickerSend, listFriends, listGroups, listMembers, userInfo, history, recentContacts, sendText, sendImage, sendFile, sendAt, replyQuote, poke, like, recall, kick, mute, wholeBan, setAdmin, renameGroup, leaveGroup, setCard, notice, sign, setRemark, deleteFriend, handleFriendReq, handleGroupReq, setSignature, setNickname, onlineClients, setAvatar, listVoices, sendVoice, postMoment];
}
