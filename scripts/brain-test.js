// 多层记忆 / 注意力 / 自主行为 测试
// 用法：node scripts/brain-test.js
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { Store } from '../src/data/store.js';
import { Brain } from '../src/memory2.js';
import { Attention, shouldReply } from '../src/attention.js';
import { Autonomy } from '../src/autonomy.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};

const HOUR = 3600000;
const DAY = 24 * HOUR;
const DIR = './.data-test';

console.log('='.repeat(58));
console.log('多层记忆 / 注意力 / 自主行为');
console.log('='.repeat(58));

await rm(DIR, { recursive: true, force: true });

// ================= A. 多层记忆 =================
console.log('\n[A] 多层记忆系统');

const store = new Store(DIR);
const brain = await new Brain({ store, file: 'brain.json', legacyFile: 'none.json' }).load();

brain.remember({ layer: 'semantic', text: '他养了只猫叫小白', subject: '10002', importance: 5 });
brain.remember({ layer: 'semantic', text: '他是个计算机专业的学生', subject: '10002', importance: 4 });
brain.remember({ layer: 'episodic', text: '上周三他通宵打游戏被室友说了', subject: '10002', importance: 3 });
brain.remember({ layer: 'procedural', text: '聊天时习惯在句尾加个嘟', subject: '', importance: 4 });
brain.remember({ layer: 'social', text: '他是我在群里最常聊的人', subject: '10002', importance: 4 });

const st = brain.stats();
console.log(`  写入 ${st.total} 条，分层：${JSON.stringify(st.byLayer)}`);
check('五层都能写进去', st.total === 5 && st.byLayer.semantic === 2);

// 检索
const hit = brain.recall('猫');
console.log(`  检索「猫」-> ${hit.map((m) => m.text).join(' | ')}`);
check('检索能命中', hit.length > 0 && hit[0].text.includes('猫'));

// 扩散激活
const spread = brain.recall('学生');
console.log(`  检索「学生」-> ${spread.map((m) => `[${m.layer}]${m.text.slice(0, 10)}`).join(' | ')}`);
const hasSameSubject = spread.some((m) => m.subject === '10002' && !m.text.includes('学生'));
check('激活会扩散到同一主体的记忆', hasSameSubject, `命中 ${spread.length} 条`);

// 遗忘曲线
const oldItem = brain.items.find((m) => m.text.includes('通宵'));
const freshItem = brain.items.find((m) => m.text.includes('猫'));
oldItem.lastAt = Date.now() - 5 * DAY;
freshItem.lastAt = Date.now() - 5 * DAY;
const rOld = brain.retention(oldItem);
const rFresh = brain.retention(freshItem);
console.log(`  同样放了 5 天：情景记忆保持 ${rOld.toFixed(3)}，语义记忆保持 ${rFresh.toFixed(3)}`);
check('语义记忆比情景记忆忘得慢', rFresh > rOld, `${rFresh.toFixed(2)} > ${rOld.toFixed(2)}`);

// 间隔重复
const beforeStab = oldItem.stability;
brain.reinforce(oldItem);
brain.reinforce(oldItem);
console.log(`  被想起来两次后，稳定性 ${beforeStab.toFixed(1)}h -> ${oldItem.stability.toFixed(1)}h`);
check('用过的记忆更牢固', oldItem.stability > beforeStab * 1.5);

// 清理
brain.remember({ layer: 'episodic', text: '一件早就没人提的小事', importance: 1 });
const junk = brain.items.find((m) => m.text.includes('没人提'));
junk.lastAt = Date.now() - 400 * DAY;
junk.stability = 1;
brain.consolidate();
const stillThere = brain.items.some((m) => m.text.includes('没人提'));
check('没用的旧记忆会被清理', !stillThere, `忘了 ${brain.stats().forgotten} 条`);

// 工作记忆
brain.workingPush('p:1', '第一句');
brain.workingPush('p:1', '第二句');
console.log(`  工作记忆：${brain.workingGet('p:1').map((x) => x.text).join(' / ')}`);
check('工作记忆按会话隔离', brain.workingGet('p:1').length === 2 && brain.workingGet('p:2').length === 0);

// 情绪调制
const calm = brain.remember({ layer: 'semantic', text: '普通的一件事', emotion: 0, importance: 3 });
const intense = brain.remember({ layer: 'semantic', text: '他吼我的那一次', emotion: -0.9, importance: 3 });
console.log(`  情绪平静时稳定性 ${calm.stability.toFixed(0)}h，情绪强烈时 ${intense.stability.toFixed(0)}h`);
check('情绪强烈的记忆更牢', intense.stability > calm.stability);

await brain.save();

// ================= B. 群聊注意力 =================
console.log('\n[B] 群聊相关性判断');

const att = new Attention({ brain, selfNames: ['大肥鱼', 'deepseek'] });

const cases = [
  ['大肥鱼 你在吗', '该回（叫名字）', 0.5, 1],
  ['今天天气不错啊', '不回（无关）', 0, 0.3],
  ['我都有什么群', '不回（在问别人）', 0, 0.45],
  ['刚才说的那个是真的吗', '可能回（问句）', 0, 0.5],
];

for (const [text, label, lo, hi] of cases) {
  const { score, reasons } = att.score('g1', { text, from: '小鲸鱼' });
  const ok = score >= lo - 0.001 && score <= hi + 0.001;
  console.log(`  「${text}」-> ${score.toFixed(2)}  ${reasons.join('、') || '无信号'}   (${label})`);
  check(`打分合理：${text}`, ok, `${score.toFixed(2)} 应在 ${lo}~${hi}`);
}

// 接着自己说的话
att.observe('g2', { from: '我', text: '我昨天去了趟海底，差点被淹死', mine: true });
const follow = att.score('g2', { text: '海底那个事后来怎么样了', from: '小鲸鱼' });
console.log(`  别人接我的话 -> ${follow.score.toFixed(2)}  ${follow.reasons.join('、')}`);
check('能识别在接我的话说', follow.score > 0.25);

check('高分必回', shouldReply(0.9, { threshold: 0.55 }).reply === true);
check('低分不回', shouldReply(0.05, { threshold: 0.55 }).reply === false);

// 话轮：她刚问完一句，对方直接回答（没叫名字、没 @）
att.observe('g3', { from: '我', text: '那你们明天几点上线', mine: true });
const turn = att.score('g3', { text: '八点吧', from: '小鲸鱼' });
console.log(`  她问完，对方答"八点吧" -> ${turn.score.toFixed(2)}  ${turn.reasons.join('、')}`);
check('话轮能接住：她问完别人答', turn.score > 0.5, `${turn.score.toFixed(2)}`);

// 对方明确 @ 了别人，不该插话
const atOther = att.score('g3', { text: '俞 八点吧', from: '小鲸鱼', atOthers: true });
console.log(`  @了别人 -> ${atOther.score.toFixed(2)}  ${atOther.reasons.join('、')}`);
check('@别人时不插话', atOther.score < 0.3, `${atOther.score.toFixed(2)}`);

// ================= C. 自主行为 =================
console.log('\n[C] 自主行为');

const llmChoice = { action: 'signature', content: '困死了', reason: '想改个签名' };
const llmSrv = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmChoice) } }] }));
  });
});
await new Promise((r) => llmSrv.listen(3921, r));

const acted = [];
const fakeTools = {
  byName: new Map([
    ['qq_set_signature', { run: async (a) => { acted.push(['signature', a]); return { ok: true }; } }],
    ['qq_set_avatar', { run: async () => { acted.push(['avatar', {}]); return { ok: true }; } }],
  ]),
};

const mood = { energy: 0.9, label: () => '平静' };
const auto = new Autonomy({
  llm: { baseUrl: 'http://127.0.0.1:3921', apiKey: 'mock', model: 'mock' },
  tools: fakeTools,
  brain,
  mood,
  state: { bot: { selfId: '10001' } },
  cfg: {},
  log: () => {},
  dataDir: DIR,
});
await auto.load();
auto.enabled = true;
auto.chance = 1;
auto.lastActivityAt = Date.now() - 5 * HOUR;

const act1 = await auto.tick();
console.log(`  决策结果：${JSON.stringify(act1).slice(0, 120)}`);
check('能自己决定并执行', acted.length === 1 && acted[0][0] === 'signature');
check('执行时用上了内容', acted[0][1].text === '困死了');

const act2 = await auto.tick();
console.log(`  立刻再来一次：${JSON.stringify(act2).slice(0, 80)}`);
check('冷却期内不会重复做同一件事', acted.length === 1);

auto.enabled = false;
auto.lastActed = {};
const act3 = await auto.tick();
check('关掉后不会再动手', acted.length === 1, act3.skipped || '');

llmSrv.close();

// ================= 汇总 =================
const pass = results.filter((x) => x.pass).length;
console.log('\n' + '='.repeat(58));
console.log(`结果：${pass}/${results.length} 通过`);
for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}`);
console.log(`\n总判定：${pass === results.length ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(58));
process.exit(pass === results.length ? 0 : 1);