// OneBot 链路探针：验证 NapCat 的 WS 能不能连、账号信息对不对、有哪些群
// 用法：node scripts/onebot-probe.js
import WebSocket from 'ws';

const url = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
const token = process.env.ONEBOT_TOKEN || '';

console.log('='.repeat(52));
console.log(`探测 ${url}`);
console.log('='.repeat(52));

const headers = token ? { Authorization: `Bearer ${token}` } : {};
const ws = new WebSocket(url, { headers });

const call = (action, params = {}) =>
  new Promise((resolve) => {
    const echo = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const onMsg = (buf) => {
      let d;
      try {
        d = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (d.echo === echo) {
        ws.off('message', onMsg);
        resolve(d);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => resolve({ status: 'timeout' }), 8000);
  });

ws.on('open', async () => {
  console.log('已连接 WebSocket');

  const login = await call('get_login_info');
  console.log('\n[1] 登录信息');
  if (login.status === 'ok') {
    console.log(`    账号: ${login.data.user_id}`);
    console.log(`    昵称: ${login.data.nickname}`);
  } else {
    console.log(`    失败: ${JSON.stringify(login)}`);
  }

  const groups = await call('get_group_list');
  console.log('\n[2] 群列表');
  if (groups.status === 'ok' && Array.isArray(groups.data)) {
    if (!groups.data.length) console.log('    还没加任何群');
    for (const g of groups.data) {
      console.log(`    ${g.group_id}  ${g.group_name}  (${g.member_count} 人)`);
    }
  } else {
    console.log(`    失败: ${JSON.stringify(groups)}`);
  }

  const friends = await call('get_friend_list');
  console.log('\n[3] 好友数');
  if (friends.status === 'ok' && Array.isArray(friends.data)) {
    console.log(`    ${friends.data.length} 个好友`);
  } else {
    console.log(`    失败: ${JSON.stringify(friends)}`);
  }

  console.log('\n' + '='.repeat(52));
  console.log('链路正常。');
  console.log('='.repeat(52));
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.log(`连接失败: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.log('超时：连不上 OneBot 服务');
  process.exit(1);
}, 30000);