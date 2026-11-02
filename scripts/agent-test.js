// 能力层测试：验证 Agent 的工具调用循环 + 真实 NapCat 的只读接口
// 用法：node scripts/agent-test.js
import http from 'node:http';
import WebSocket from 'ws';
import { Agent } from '../src/agent.js';
import { createTools } from '../src/tools.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};

console.log('='.repeat(56));
console.log('能力层测试');
console.log('='.repeat(56));

// ================= A. Agent 工具循环（假 OneBot + 假模型）=================
console.log('\n[A] Agent 会不会自己决定调工具');

const fakeCalls = [];
const fakeOneBot = {
  async call(action, params) {
    fakeCalls.push({ action, params });
    if (action === 'get_friend_list') {
      return [
        { user_id: 10002, nickname: '三鹿乃粉', remark: '本人' },
        { user_id: 10003, nickname: '俞', remark: '' },
      ];
    }
    if (action === 'send_private_msg') return { message_id: 4242 };
    return {};
  },
};

const tools = createTools({ onebot: fakeOneBot, log: () => {} });

// 假模型：第一轮要工具，第二轮出结论
let llmRound = 0;
const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmRound++;
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (llmRound === 1) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'qq_list_friends', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '你有两个好友，三鹿乃粉和俞' } }],
      }),
    );
  });
});
await new Promise((r) => llmServer.listen(3911, r));

const agent = new Agent({
  llm: {
    baseUrl: 'http://127.0.0.1:3911',
    apiKey: 'mock',
    model: 'mock',
    temperature: 1,
    maxTokens: 200,
    timeoutMs: 8000,
  },
  tools,
  persona: '你是大肥鱼。',
  policy: {},
  log: () => {},
});

const out = await agent.respond({
  conversationId: 'p:10002',
  userText: '我都有哪些好友',
  ctx: { selfId: '10001', userId: '10002', senderId: '10002', isOwner: true },
  meta: { scene: 'private', userName: '三鹿乃粉' },
});

console.log(`  模型轮次: ${llmRound}`);
console.log(`  工具调用: ${fakeCalls.map((c) => c.action).join(', ') || '(无)'}`);
console.log(`  最终回复: ${out.text}`);
check('模型主动调用了工具', fakeCalls.some((c) => c.action === 'get_friend_list'));
check('调完工具后给了人话回复', out.text === '你有两个好友，三鹿乃粉和俞');
check('记录了用过的工具', out.usedTools.includes('qq_list_friends'));

llmServer.close();

// ================= B. 破坏性操作的闸门 =================
console.log('\n[B] 破坏性操作的安全闸门');

const ownerCtx = { selfId: '10001', groupId: '123', senderId: '10002', isOwner: true };
const strangerCtx = { selfId: '10001', groupId: '123', senderId: '999999', isOwner: false };

const r1 = await tools.runTool('qq_kick_member', { user_id: '999999', confirm: false }, ownerCtx);
check('主人没确认时拒绝执行', JSON.parse(r1).error?.includes('破坏性'), r1.slice(0, 40));

const r2 = await tools.runTool('qq_kick_member', { user_id: '999999', confirm: true }, strangerCtx);
check('非主人即使确认也拒绝', JSON.parse(r2).error?.includes('主人'), r2.slice(0, 40));

const r3 = await tools.runTool('qq_kick_member', { user_id: '999999', confirm: true }, ownerCtx);
check('主人确认后放行', JSON.parse(r3).ok === true, r3.slice(0, 40));

// ================= C. 危险接口没被暴露 =================
console.log('\n[C] 不该暴露的接口');
const names = tools.tools.map((t) => t.name);
const forbidden = ['get_cookies', 'get_credentials', 'send_packet', 'bot_exit'];
const leaked = forbidden.filter((f) => names.includes(f));
check('没有暴露凭据/底层接口', leaked.length === 0, leaked.length ? leaked.join(',') : '干净');
console.log(`  可用工具共 ${names.length} 个`);

// ================= D. 真实 NapCat 只读接口 =================
console.log('\n[D] 真实 NapCat 只读接口');

const ws = new WebSocket('ws://127.0.0.1:3001');
// NapCat 没起来时（比如账号掉线）这段是集成测试，跳过而不是崩掉
ws.on('error', () => {
  console.log('  SKIP  NapCat 没在运行，跳过真机接口测试');
  console.log('\n' + '='.repeat(56));
  const ok = results.filter((r) => r.pass).length;
  console.log(`${ok} 通过 / ${results.length - ok} 失败`);
  console.log('='.repeat(56));
  process.exit(0);
});
const pending = new Map();
ws.on('message', (buf) => {
  const d = JSON.parse(buf.toString());
  if (d.echo && pending.has(d.echo)) {
    const { resolve } = pending.get(d.echo);
    pending.delete(d.echo);
    resolve(d);
  }
});

const realOneBot = {
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      const echo = `t-${Math.random().toString(36).slice(2)}`;
      pending.set(echo, { resolve: (d) => (d.status === 'ok' ? resolve(d.data) : reject(new Error(d.message || d.status))) });
      ws.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (pending.has(echo)) {
          pending.delete(echo);
          reject(new Error('超时'));
        }
      }, 8000);
    });
  },
};

await new Promise((r) => ws.on('open', r));
console.log('  已连上 NapCat');

const realTools = createTools({ onebot: realOneBot, log: () => {} });

try {
  const friends = await realTools.byName.get('qq_list_friends').run({}, {});
  console.log(`  好友: ${friends.length} 个  ${friends.map((f) => f.昵称).join('/')}`);
  check('能查真实好友列表', Array.isArray(friends) && friends.length > 0);
} catch (e) {
  check('能查真实好友列表', false, e.message);
}

try {
  const groups = await realTools.byName.get('qq_list_groups').run({}, {});
  console.log(`  群: ${Array.isArray(groups) ? groups.length : 0} 个`);
  check('能查真实群列表', Array.isArray(groups));
} catch (e) {
  check('能查真实群列表', false, e.message);
}

try {
  const clients = await realTools.byName.get('qq_online_clients').run({}, {});
  console.log(`  在线设备: ${JSON.stringify(clients).slice(0, 120)}`);
  check('能查在线设备', clients != null);
} catch (e) {
  check('能查在线设备', false, e.message);
}

try {
  const info = await realTools.byName.get('qq_user_info').run({ user_id: '10002' }, {});
  console.log(`  资料: ${info.昵称} 等级 ${info.等级}`);
  check('能查 QQ 资料', Boolean(info.昵称));
} catch (e) {
  check('能查 QQ 资料', false, e.message);
}

ws.close();

// ================= 汇总 =================
const pass = results.filter((r) => r.pass).length;
console.log('\n' + '='.repeat(56));
console.log(`结果：${pass}/${results.length} 通过`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
const all = pass === results.length;
console.log(`\n总判定：${all ? 'PASS —— 能动手了' : 'FAIL —— 见上面'}`);
console.log('='.repeat(56));
process.exit(all ? 0 : 1);