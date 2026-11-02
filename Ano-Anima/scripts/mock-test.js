// 端到端联调：不需要真 QQ、不需要真 API Key
// 起一个假 OneBot 服务端 + 假模型接口，让主程序完整跑一遍
// 用法：node scripts/mock-test.js
import http from 'node:http';
import { WebSocketServer } from 'ws';

const WS_PORT = 3901;
const LLM_PORT = 3902;
const SELF_ID = '10001';
const GROUP_ID = '20001';

const sent = [];
let llmCalls = 0;
let recalled = 0;

// ---------- 假模型 ----------
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    const system = payload.messages?.[0]?.content ?? '';
    const user = payload.messages?.at(-1)?.content ?? '';
    llmCalls++;

    console.log(`  [假模型] 收到提问："${user.slice(0, 40)}"`);
    console.log(`  [假模型] 系统提示 ${system.length} 字，人设${system.includes('大肥鱼') ? '已注入' : '缺失'}`);

    // 故意给一个长回复，验证分段
    const content = '刚下课。你也在机房啊。行吧那我一会儿过去找你。';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

// ---------- 假 OneBot ----------
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

wss.on('connection', (ws) => {
  console.log('  [假OneBot] 机器人已连上');

  ws.on('message', (buf) => {
    let req;
    try {
      req = JSON.parse(buf.toString());
    } catch {
      return;
    }

    const ok = (data = {}) =>
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo }));

    switch (req.action) {
      case 'get_login_info':
        return ok({ user_id: Number(SELF_ID), nickname: '大肥鱼' });

      case 'send_group_msg':
      case 'send_private_msg':
        sent.push(req.params.message);
        console.log(`  [假OneBot] 收到发送请求 -> "${req.params.message}"`);
        return ok({ message_id: sent.length });

      case 'delete_msg':
        recalled++;
        console.log(`  [假OneBot] 收到撤回请求 id=${req.params.message_id}`);
        return ok(null);

      default:
        return ok({});
    }
  });

  // 800ms 后推一条"有人在群里 @ 了机器人"的消息
  setTimeout(() => {
    console.log('  [假OneBot] 推送群消息：小明 @ 了大肥鱼「在吗」');
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        group_id: Number(GROUP_ID),
        group_name: '测试群',
        user_id: 99999,
        self_id: Number(SELF_ID),
        sender: { nickname: '小明' },
        message: [
          { type: 'at', data: { qq: SELF_ID } },
          { type: 'text', data: { text: ' 在吗，晚上一起玩吗' } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] 在吗，晚上一起玩吗`,
      }),
    );
  }, 800);
});

// ---------- 环境变量要在导入主程序之前设好 ----------
process.env.ONEBOT_WS_URL = `ws://127.0.0.1:${WS_PORT}`;
process.env.ONEBOT_TOKEN = '';
process.env.LLM_BASE_URL = `http://127.0.0.1:${LLM_PORT}`;
process.env.LLM_API_KEY = 'mock-key';
process.env.LLM_MODEL = 'mock-model';
process.env.SLEEP_START_HOUR = '0';
process.env.SLEEP_END_HOUR = '0'; // 相等 = 从不同步睡
process.env.REPLY_DELAY_MIN_MS = '50';
process.env.REPLY_DELAY_MAX_MS = '150';
process.env.BUSY_CHANCE = '0';
process.env.CHAR_DELAY_MIN_MS = '4';
process.env.CHAR_DELAY_MAX_MS = '9';
process.env.TYPO_CHANCE = '0'; // 关掉随机，保证可复现
process.env.SPLIT_CHANCE = '1';
process.env.RATE_LIMIT_PER_MIN = '20';
process.env.GROUP_REQUIRE_AT = 'true';

console.log('='.repeat(56));
console.log('端到端联调（假 OneBot + 假模型）');
console.log('='.repeat(56));

llm.listen(LLM_PORT);

await import('../src/index.js');

// 收齐 3 条（分段上限）或超时就总结
const deadline = Date.now() + 15_000;
const poll = setInterval(() => {
  if (sent.length >= 3 || Date.now() > deadline) {
    clearInterval(poll);
    finish();
  }
}, 200);

function finish() {
  console.log('\n' + '='.repeat(56));
  console.log('结果');
  console.log('='.repeat(56));
  console.log(`  模型调用      : ${llmCalls} 次   ${llmCalls > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  发出消息      : ${sent.length} 条`);
  sent.forEach((m, i) => console.log(`    ${i + 1}. ${m}`));
  console.log(`  分段是否生效  : ${sent.length > 1 ? 'PASS（长回复被拆开了）' : 'FAIL'}`);
  console.log(`  撤回请求      : ${recalled} 次（本次测试关闭了错字，应为 0）`);

  const pass = llmCalls > 0 && sent.length >= 3;
  console.log(`\n  总判定: ${pass ? 'PASS —— 全链路通了' : 'FAIL —— 看上面的日志'}`);
  console.log('='.repeat(56));

  process.exit(pass ? 0 : 1);
}