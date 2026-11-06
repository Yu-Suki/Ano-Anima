#!/usr/bin/env node
// QQ 的 MCP Server：把 OneBot（SnowLuma）的接口包成 MCP 工具，
// 给别的 MCP 客户端（Claude Desktop / Cursor / 别的 agent）用。
//
// 用法（stdio）：
//   node src/mcp/qq-server.js
// 环境变量：
//   ONEBOT_HTTP_URL   默认 http://127.0.0.1:3000
//   ONEBOT_HTTP_TOKEN Bearer token（跟 .env 里一致）
//
// 安全：不暴露 cookies / 凭据类接口；破坏性操作在描述里写明要先确认。
import 'dotenv/config';

const BASE = (process.env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.ONEBOT_HTTP_TOKEN || '';

async function onebot(action, params = {}) {
  const r = await fetch(`${BASE}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, http: r.status, raw: text.slice(0, 500) }; }
  if (j.retcode !== 0 && j.status !== 'ok') return { ok: false, retcode: j.retcode, wording: j.wording || j.message || '' };
  return { ok: true, data: j.data };
}

/** 把文字 / 图片 / @ / 回复 拼成 OneBot 消息段数组 */
function segs({ text, image, at, reply }) {
  const out = [];
  if (reply) out.push({ type: 'reply', data: { id: String(reply) } });
  if (at) {
    const list = Array.isArray(at) ? at : [at];
    for (const q of list) out.push({ type: 'at', data: { qq: String(q) } });
    out.push({ type: 'text', data: { text: ' ' } });
  }
  if (text) out.push({ type: 'text', data: { text: String(text) } });
  if (image) out.push({ type: 'image', data: { file: String(image) } });
  return out;
}

const TOOLS = [
  {
    name: 'qq_login_info',
    description: '看这个 QQ 号是谁（登录状态）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => onebot('get_login_info'),
  },
  {
    name: 'qq_status',
    description: '看 OneBot 服务是否在线、消息收发是否正常',
    inputSchema: { type: 'object', properties: {} },
    run: async () => onebot('get_status'),
  },
  {
    name: 'qq_send_private',
    description: '给某个人发私聊消息（文字/图片，可 @、可引用）',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '对方 QQ 号' },
        text: { type: 'string', description: '文字内容' },
        image: { type: 'string', description: '图片，可传 URL 或本地路径' },
        reply: { type: 'string', description: '要引用的消息 id（可选）' },
      },
      required: ['user_id'],
    },
    run: async (a) => onebot('send_msg', {
      message_type: 'private', user_id: Number(a.user_id),
      message: segs({ text: a.text, image: a.image, reply: a.reply }),
    }),
  },
  {
    name: 'qq_send_group',
    description: '给某个群发消息（文字/图片，可 @ 某人、可引用）',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群号' },
        text: { type: 'string', description: '文字内容' },
        image: { type: 'string', description: '图片，可传 URL 或本地路径' },
        at: { type: 'array', items: { type: 'string' }, description: '要 @ 的 QQ 号列表' },
        reply: { type: 'string', description: '要引用的消息 id（可选）' },
      },
      required: ['group_id'],
    },
    run: async (a) => onebot('send_msg', {
      message_type: 'group', group_id: Number(a.group_id),
      message: segs({ text: a.text, image: a.image, at: a.at, reply: a.reply }),
    }),
  },
  {
    name: 'qq_recall',
    description: '撤回一条消息（破坏性：确认了再做）',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
    run: async (a) => onebot('delete_msg', { message_id: Number(a.message_id) }),
  },
  {
    name: 'qq_group_history',
    description: '读某个群最近的聊天记录',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        count: { type: 'number', description: '取几条，默认 20，最多 100' },
      },
      required: ['group_id'],
    },
    run: async (a) => onebot('get_group_msg_history', { group_id: Number(a.group_id), count: Math.min(100, Number(a.count) || 20) }),
  },
  {
    name: 'qq_friend_list',
    description: '好友列表（QQ 号、昵称、备注）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => onebot('get_friend_list'),
  },
  {
    name: 'qq_group_list',
    description: '群列表（群号、群名、人数）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => onebot('get_group_list'),
  },
  {
    name: 'qq_group_members',
    description: '某个群的成员列表',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    run: async (a) => onebot('get_group_member_list', { group_id: Number(a.group_id) }),
  },
  {
    name: 'qq_user_info',
    description: '查某人的资料（昵称、签名、性别等）',
    inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] },
    run: async (a) => onebot('get_stranger_info', { user_id: Number(a.user_id) }),
  },
  {
    name: 'qq_poke',
    description: '戳一戳某人（群里或私聊）',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' }, group_id: { type: 'string', description: '在群里戳就填群号' } },
      required: ['user_id'],
    },
    run: async (a) => onebot('send_poke', a.group_id
      ? { user_id: Number(a.user_id), group_id: Number(a.group_id) }
      : { user_id: Number(a.user_id) }),
  },
  {
    name: 'qq_like',
    description: '给某人资料点个赞（可多次）',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' }, times: { type: 'number', description: '点赞次数，默认 1' } },
      required: ['user_id'],
    },
    run: async (a) => onebot('send_like', { user_id: Number(a.user_id), times: Math.min(10, Number(a.times) || 1) }),
  },
  {
    name: 'qq_set_card',
    description: '改某人在群里的名片（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, user_id: { type: 'string' }, card: { type: 'string' } },
      required: ['group_id', 'user_id', 'card'],
    },
    run: async (a) => onebot('set_group_card', { group_id: Number(a.group_id), user_id: Number(a.user_id), card: String(a.card) }),
  },
  {
    name: 'qq_mute',
    description: '禁言某群成员（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, user_id: { type: 'string' }, seconds: { type: 'number', description: '0 = 解除禁言' } },
      required: ['group_id', 'user_id', 'seconds'],
    },
    run: async (a) => onebot('set_group_ban', { group_id: Number(a.group_id), user_id: Number(a.user_id), duration: Number(a.seconds) }),
  },
  {
    name: 'qq_kick',
    description: '踢出群成员（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, user_id: { type: 'string' }, reject_add: { type: 'boolean', description: '是否拒绝再加群' } },
      required: ['group_id', 'user_id'],
    },
    run: async (a) => onebot('set_group_kick', {
      group_id: Number(a.group_id), user_id: Number(a.user_id), reject_add_request: Boolean(a.reject_add),
    }),
  },
  {
    name: 'qq_set_group_name',
    description: '改群名（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, name: { type: 'string' } },
      required: ['group_id', 'name'],
    },
    run: async (a) => onebot('set_group_name', { group_id: Number(a.group_id), group_name: String(a.name) }),
  },
  {
    name: 'qq_set_signature',
    description: '改这个号的个性签名',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (a) => onebot('set_self_longnick', { longNick: String(a.text) }),
  },
  {
    name: 'qq_group_info',
    description: '查某个群的资料（群名、人数、创建时间、公告）',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    run: async (a) => onebot('get_group_info', { group_id: Number(a.group_id) }),
  },
  {
    name: 'qq_member_info',
    description: '查某个群成员的资料（名片、头衔、入群时间、身份）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, user_id: { type: 'string' } },
      required: ['group_id', 'user_id'],
    },
    run: async (a) => onebot('get_group_member_info', { group_id: Number(a.group_id), user_id: Number(a.user_id) }),
  },
  {
    name: 'qq_recent_contacts',
    description: '最近联系人（最近跟谁聊过）',
    inputSchema: { type: 'object', properties: { count: { type: 'number', description: '取几条，默认 10' } } },
    run: async (a) => onebot('get_recent_contact', { count: Math.min(50, Number(a.count) || 10) }),
  },
  {
    name: 'qq_group_notice',
    description: '发群公告（破坏性：会通知全群，确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, content: { type: 'string' }, image: { type: 'string', description: '公告配图，可空' } },
      required: ['group_id', 'content'],
    },
    run: async (a) => onebot('_send_group_notice', {
      group_id: Number(a.group_id), content: String(a.content), image: a.image || '',
    }),
  },
  {
    name: 'qq_group_sign',
    description: '群签到（如果这个群支持）',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    run: async (a) => onebot('send_group_sign', { group_id: Number(a.group_id) }),
  },
  {
    name: 'qq_whole_ban',
    description: '全群禁言 / 解除（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, enable: { type: 'boolean', description: 'true=全员禁言' } },
      required: ['group_id', 'enable'],
    },
    run: async (a) => onebot('set_group_whole_ban', { group_id: Number(a.group_id), enable: Boolean(a.enable) }),
  },
  {
    name: 'qq_set_admin',
    description: '设置/取消群管理员（破坏性：确认了再做）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, user_id: { type: 'string' }, enable: { type: 'boolean' } },
      required: ['group_id', 'user_id', 'enable'],
    },
    run: async (a) => onebot('set_group_admin', { group_id: Number(a.group_id), user_id: Number(a.user_id), enable: Boolean(a.enable) }),
  },
  {
    name: 'qq_leave_group',
    description: '退群（破坏性：不可撤销，确认了再做）',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, dismiss: { type: 'boolean', description: '群主解散群才用' } }, required: ['group_id'] },
    run: async (a) => onebot('set_group_leave', { group_id: Number(a.group_id), is_dismiss: Boolean(a.dismiss) }),
  },
  {
    name: 'qq_set_friend_remark',
    description: '改好友备注',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' }, remark: { type: 'string' } },
      required: ['user_id', 'remark'],
    },
    run: async (a) => onebot('set_friend_remark', { user_id: Number(a.user_id), remark: String(a.remark) }),
  },
  {
    name: 'qq_delete_friend',
    description: '删好友（破坏性：确认了再做）',
    inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] },
    run: async (a) => onebot('delete_friend', { user_id: Number(a.user_id) }),
  },
  {
    name: 'qq_handle_friend_request',
    description: '处理加好友请求（同意/拒绝）',
    inputSchema: {
      type: 'object',
      properties: { flag: { type: 'string' }, approve: { type: 'boolean' }, remark: { type: 'string' } },
      required: ['flag', 'approve'],
    },
    run: async (a) => onebot('set_friend_add_request', { flag: String(a.flag), approve: Boolean(a.approve), remark: a.remark || '' }),
  },
  {
    name: 'qq_handle_group_request',
    description: '处理加群请求 / 邀请（同意/拒绝）',
    inputSchema: {
      type: 'object',
      properties: {
        flag: { type: 'string' },
        type: { type: 'string', description: 'add 或 invite' },
        approve: { type: 'boolean' },
        reason: { type: 'string', description: '拒绝理由，可空' },
      },
      required: ['flag', 'type', 'approve'],
    },
    run: async (a) => onebot('set_group_add_request', {
      flag: String(a.flag), sub_type: String(a.type || 'add'), approve: Boolean(a.approve), reason: a.reason || '',
    }),
  },
  {
    name: 'qq_upload_group_file',
    description: '往群里传文件',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, file: { type: 'string', description: '本地路径或 URL' }, name: { type: 'string' } },
      required: ['group_id', 'file'],
    },
    run: async (a) => onebot('upload_group_file', { group_id: Number(a.group_id), file: String(a.file), name: a.name || '' }),
  },
  {
    name: 'qq_upload_private_file',
    description: '给某人传文件',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' }, file: { type: 'string' }, name: { type: 'string' } },
      required: ['user_id', 'file'],
    },
    run: async (a) => onebot('upload_private_file', { user_id: Number(a.user_id), file: String(a.file), name: a.name || '' }),
  },
  {
    name: 'qq_set_nickname',
    description: '改这个号的昵称',
    inputSchema: { type: 'object', properties: { nickname: { type: 'string' } }, required: ['nickname'] },
    run: async (a) => onebot('set_qq_profile', { nickname: String(a.nickname) }),
  },
  {
    name: 'qq_set_avatar',
    description: '换头像（破坏性：换掉就找不回来，确认了再做）',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: '本地路径或 URL' } }, required: ['file'] },
    run: async (a) => onebot('set_qq_avatar', { file: String(a.file) }),
  },
  {
    name: 'qq_online_clients',
    description: '这个号现在在哪些设备上在线（SnowLuma 需要先观察到一次登录快照，可能返回空）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => onebot('get_online_clients'),
  },
  {
    name: 'qq_ai_voices',
    description: '看某个群里能用的 AI 语音音色',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    run: async (a) => onebot('get_ai_characters', { group_id: Number(a.group_id) }),
  },
  {
    name: 'qq_send_voice',
    description: '在群里发一条 AI 语音（用某个音色念一段话）',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' }, character: { type: 'string', description: '音色 id，先查 qq_ai_voices' }, text: { type: 'string' } },
      required: ['group_id', 'character', 'text'],
    },
    run: async (a) => onebot('send_group_ai_record', {
      group_id: Number(a.group_id), character: String(a.character), text: String(a.text),
    }),
  },
  {
    name: 'qq_raw',
    description: '直接调任意 OneBot 接口（高级用法；action 名参考 OneBot 11 文档，不要传凭据类）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '例如 get_status / send_msg' },
        params: { type: 'object', description: '参数对象' },
      },
      required: ['action'],
    },
    run: async (a) => {
      const blocked = /cookie|credential|password|token|qrcode|login/i;
      if (blocked.test(String(a.action))) return { ok: false, error: '这个接口不对外暴露' };
      return onebot(String(a.action), a.params || {});
    },
  },
];

// ---------- stdio JSON-RPC ----------
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function onRequest(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'qq-onebot', version: '1.0.0' },
      },
    });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
    });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '没有这个工具：' + name } });
    }
    Promise.resolve(tool.run(args))
      .then((r) => send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(r).slice(0, 8000) }] },
      }))
      .catch((e) => send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true },
      }));
    return;
  }
  if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '不支持的方法：' + msg.method } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    onRequest(msg);
  }
});

process.on('uncaughtException', (e) => {
  try { process.stderr.write('[qq-mcp] ' + e.message + '\n'); } catch {}
});
