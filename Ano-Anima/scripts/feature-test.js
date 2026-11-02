// 形象 / 语音 能力实测：接真 NapCat
// 用法：node scripts/feature-test.js
import WebSocket from 'ws';
import { createTools } from '../src/tools.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};

console.log('='.repeat(56));
console.log('形象 / 语音 能力实测');
console.log('='.repeat(56));

const ws = new WebSocket('ws://127.0.0.1:3001');
const pending = new Map();
ws.on('message', (buf) => {
  const d = JSON.parse(buf.toString());
  if (d.echo && pending.has(d.echo)) {
    const { resolve } = pending.get(d.echo);
    pending.delete(d.echo);
    resolve(d);
  }
});

const onebot = {
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      const echo = `f-${Math.random().toString(36).slice(2)}`;
      pending.set(echo, {
        resolve: (d) => (d.status === 'ok' ? resolve(d.data) : reject(new Error(d.message || d.status))),
      });
      ws.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (pending.has(echo)) {
          pending.delete(echo);
          reject(new Error('超时'));
        }
      }, 20000);
    });
  },
};

await new Promise((r, j) => {
  ws.on('open', r);
  ws.on('error', j);
});
console.log('已连上 NapCat\n');

const tools = createTools({ onebot, log: (k, m) => console.log(`  [${k}] ${m}`) });
const ctx = { selfId: '3902064605', groupId: '619837801', senderId: '15125287', isOwner: true };

console.log(`[1] 工具总数：${tools.tools.length} 个`);
console.log(`    新加的：${['qq_set_avatar', 'qq_list_ai_voices', 'qq_send_voice', 'qq_post_moment'].filter((n) => tools.byName.has(n)).join(', ')}`);
check('四个新工具都注册了', ['qq_set_avatar', 'qq_list_ai_voices', 'qq_send_voice', 'qq_post_moment'].every((n) => tools.byName.has(n)));

console.log('\n[2] 查 AI 语音角色');
let voices = null;
try {
  voices = await tools.byName.get('qq_list_ai_voices').run({}, ctx);
  const list = voices?.data ?? voices;
  console.log(`    返回：${JSON.stringify(list).slice(0, 300)}`);
  check('能拿到语音角色列表', Boolean(list));
} catch (e) {
  console.log(`    失败：${e.message}`);
  check('能拿到语音角色列表', false, e.message);
}

console.log('\n[3] 换头像（从 assets/avatars 随机挑）');
try {
  const r = await tools.byName.get('qq_set_avatar').run({}, ctx);
  console.log(`    ${JSON.stringify(r)}`);
  check('换头像成功', r.ok === true, r.换成 || r.error);
} catch (e) {
  console.log(`    失败：${e.message}`);
  check('换头像成功', false, e.message);
}

console.log('\n[4] 说说功能默认关闭（安全）');
const moment = await tools.byName.get('qq_post_moment').run({ text: '测试' }, ctx);
check('默认拒绝发说说', Boolean(moment.error), (moment.error || '').slice(0, 40));

console.log('\n[5] 改群名片（改自己）');
try {
  const r = await tools.byName.get('qq_set_card').run({ card: '大肥鱼' }, ctx);
  console.log(`    ${JSON.stringify(r)}`);
  check('能改自己的群名片', r.ok === true);
} catch (e) {
  console.log(`    失败：${e.message}`);
  check('能改自己的群名片', false, e.message);
}

ws.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n' + '='.repeat(56));
console.log(`结果：${pass}/${results.length} 通过`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
console.log('='.repeat(56));
process.exit(pass === results.length ? 0 : 1);