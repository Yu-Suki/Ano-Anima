// 自主行为测试：需求累积 / 阈值触发 / 活力预算 / 每日刷新
// 用一个假模型和假工具跑，不发真消息
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Autonomy } from '../src/autonomy.js';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

const dir = await mkdtemp(join(tmpdir(), 'auto-'));
const MIN = 60000;

// 假模型：固定返回 "改签名"
let lastChoice = { action: 'signature', content: '今天也没睡够' };
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(lastChoice) } }] }),
});

const calls = [];
const tools = {
  byName: new Map([
    ['qq_set_signature', { run: async (args) => { calls.push(['signature', args]); return { ok: true }; } }],
    ['web_search', { run: async (args) => { calls.push(['search', args]); return { ok: true }; } }],
  ]),
};

const brain = {
  items: [{ id: 'a', text: '他养了只猫', stability: 72, hits: 1 }],
  recall: () => [],
  reinforce: () => {},
  dedupeAll: () => ({ groups: 0, removed: 0 }),
  save: async () => {},
};

const make = () => {
  const a = new Autonomy({
    llm: { apiKey: 'fake', baseUrl: 'http://x', model: 'm' },
    tools,
    brain,
    mood: { label: () => '平静', energy: 0.8, valence: 0 },
    state: { bot: { selfId: '1' } },
    cfg: { schedule: null },
    log: () => {},
    dataDir: dir,
    isAsleepFn: () => false,
  });
  a.enabled = true; // 测试环境没加载 .env
  return a;
};

console.log('='.repeat(56));
console.log('自主行为：需求驱动 + 活力预算');
console.log('='.repeat(56));

// ---------- 1. 需求按各自速度累积 ----------
console.log('\n[1] 需求累积');
const a = make();
await a.load();
a.drives = { boredom: 0, social: 0, expression: 0, curiosity: 0 };
a.lastTickAt = Date.now() - 10 * MIN;
a.vitality = 100;
a.vitalityDay = a.vitalityDay || 'x';
let r = await a.tick();
ok(Math.round(a.drives.boredom) === 10, '10 分钟无聊涨 10', `实际 ${a.drives.boredom.toFixed(1)}`);
ok(Math.round(a.drives.social) === 5, '10 分钟社交涨 5', `实际 ${a.drives.social.toFixed(1)}`);
ok(Math.round(a.drives.curiosity) === 3, '10 分钟好奇涨 3', `实际 ${a.drives.curiosity.toFixed(1)}`);
ok(r.skipped && r.skipped.includes('还没憋够'), '没到 100 不动手', JSON.stringify(r.skipped));

// ---------- 2. 攒满就动手 ----------
console.log('\n[2] 攒满 100 就动手');
a.drives.boredom = 100;
a.lastTickAt = Date.now();
const before = a.vitality;
r = await a.tick();
ok(r.action === 'signature', '无聊满了去改签名', JSON.stringify(r.action));
ok(a.vitality === before - 10, '扣了 10 点活力', `${before} → ${a.vitality}`);
ok(a.drives.boredom === 0, '做完这条需求清零');
ok(calls.length === 1 && calls[0][0] === 'signature', '确实调了工具');

// ---------- 3. 活力不够就不做 ----------
console.log('\n[3] 活力不够');
a.vitality = 5;
a.drives.boredom = 100;
a.lastActed = {}; // 清冷却
r = await a.tick();
ok(r.skipped && r.skipped.includes('活力'), '活力不够被拦下', JSON.stringify(r.skipped));
ok(a.drives.boredom < 100, '被拦下后需求会降一点，不会每 10 分钟重复撞');
ok(a.vitality === 5, '活力没被扣');

// ---------- 4. 聊天会把无聊压下去 ----------
console.log('\n[4] 聊起来就不无聊了');
a.drives = { boredom: 80, social: 80, expression: 50, curiosity: 50 };
a.noteActivity();
ok(a.drives.boredom === 0, '有人说话，无聊清零');
ok(a.drives.social === 30, '社交欲降一半', `实际 ${a.drives.social}`);

// ---------- 5. 活力每天刷新 ----------
console.log('\n[5] 活力每日刷新');
const b = make();
await b.load();
b.vitality = 12;
b.vitalityDay = '1999-1-1';
b.lastTickAt = Date.now();
await b.tick();
ok(b.vitality === b.vitalityMax, '换天后活力补满', `实际 ${b.vitality}`);

// ---------- 6. 睡眠时段不动 ----------
console.log('\n[6] 睡着不动');
const c = make();
await c.load();
c.isAsleepFn = () => true;
c.drives.boredom = 100;
c.lastTickAt = Date.now();
r = await c.tick();
ok(r.skipped && r.skipped.includes('睡'), '睡着了不动手', JSON.stringify(r.skipped));

// ---------- 7. 不碰 QQ 的内部行为 ----------
console.log('\n[7] 掉线也能做的内部行为');
const d = make();
await d.load();
d.drives.expression = 100;
d.vitality = 100;
d.lastTickAt = Date.now();
lastChoice = { action: 'diary', content: '今天主人没来' };
r = await d.tick();
ok(r.action === 'diary', '表达欲满了写日记');
ok(d.vitality === 95, '写日记扣 5 点活力', `实际 ${d.vitality}`);

lastChoice = { action: 'tidy' };
const e = make();
await e.load();
e.drives.curiosity = 100;
e.vitality = 100;
e.lastTickAt = Date.now();
r = await e.tick();
ok(r.action === 'tidy', '好奇满了去整理记忆');
ok(e.vitality === 95, '整理记忆扣 5 点活力');

// ---------- 8. 状态快照 ----------
console.log('\n[8] 面板要看的数字');
const st = e.status();
ok(typeof st.vitality === 'number' && st.vitalityMax === 100, '有活力和上限');
ok(st.drives && st.drives.boredom && st.drives.boredom.zh === '无聊', '四条需求带中文名');
ok(st.threshold === 100, '阈值 100');

await rm(dir, { recursive: true, force: true });

console.log('\n' + '='.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);