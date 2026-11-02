// 分层遗忘：每层用自己那套参数 / 核心不删 / 被提起会变牢
import { Brain } from '../src/memory2.js';

let pass = 0;
let fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${e}`); } };
const store = () => ({ data: {}, async read(n, f) { return this.data[n] ?? f; }, async write(n, d) { this.data[n] = d; } });
const HOUR = 3600000;
const DAY = 86400000;

const mk = () => new Brain({ store: store(), file: 'brain.json' });

console.log('='.repeat(56));
console.log('分层遗忘');
console.log('='.repeat(56));

// ---------- 工作记忆：几小时就没了 ----------
console.log('\n[1] 工作记忆忘得快');
const b1 = await mk();
const w = b1.remember({ layer: 'working', text: '刚才说过的一句话', weight: 3 });
w.lastAt = Date.now() - 12 * HOUR;
console.log(`  12 小时后的保持率 ${b1.retention(w).toFixed(3)}（阈值 0.1）`);
b1.consolidate();
ok(!b1.items.some((m) => m.text.includes('刚才说过')), '12 小时前的工作记忆被清掉');

// ---------- 语义记忆：很久才淡 ----------
console.log('\n[2] 语义记忆记得久，但不是永远');
const b2 = await mk();
const s = b2.remember({ layer: 'semantic', text: '主人19岁', weight: 8 });
s.lastAt = Date.now() - 400 * DAY;
const r400 = b2.retention(s);
b2.consolidate();
console.log(`  400 天后保持率 ${r400.toFixed(2)}`);
ok(b2.items.length === 1, '400 天后还在（语义层阈值 0.02）');

s.lastAt = Date.now() - 3000 * DAY;
const rOld = b2.retention(s);
b2.consolidate();
console.log(`  8 年后保持率 ${rOld.toFixed(4)}`);
ok(!b2.items.length, '放到 8 年后才被清掉');

// ---------- 情景记忆：按权重分档 ----------
console.log('\n[3] 情景记忆按重要性分档');
const b3 = await mk();
const light = b3.remember({ layer: 'episodic', text: '随口聊了两句', weight: 3 });
const heavy = b3.remember({ layer: 'episodic', text: '主人说怕孤单', weight: 9 });
light.lastAt = Date.now() - 30 * DAY;
heavy.lastAt = Date.now() - 30 * DAY;
const rl = b3.retention(light);
const rh = b3.retention(heavy);
console.log(`  30 天后：3 分的 ${rl.toFixed(3)}，9 分的 ${rh.toFixed(3)}`);
ok(rl < rh, '同样 30 天，高权重的记得更牢');
b3.consolidate();
ok(!b3.items.some((m) => m.text.includes('随口')), '3 分的被清掉');
ok(b3.items.some((m) => m.text.includes('怕孤单')), '9 分的还在');

// ---------- 核心：永不衰减 ----------
console.log('\n[4] 核心记忆永不衰减');
const b4 = await mk();
const c = b4.remember({ layer: 'episodic', text: '主人说怕孤单', weight: 9 });
b4.moveToCore(c);
ok(c.layer === 'core', '挪进核心');
ok(c.from === 'episodic', '记住了它来自情景层');
c.lastAt = Date.now() - 3650 * DAY;
b4.consolidate();
ok(b4.items.length === 1, '放了 10 年也没被删');
b4.restoreFromCore(c);
ok(c.layer === 'episodic', '退回情景层');
ok(Number.isFinite(c.stability), '退回后重新有稳定性（开始衰减）');

// ---------- 强化 ----------
console.log('\n[5] 被想起只刷新时间，稳定性由分数决定');
const b5 = await mk();
const m = b5.remember({ layer: 'episodic', text: '主人说她面试挂了', weight: 5 });
const s0 = m.stability;
b5.reinforce(m);
ok(Math.abs(m.stability - s0) < 1, '稳定性不变（由分数决定）');
ok(m.hits === 1, 'hit 记上了');

// ---------- 归档不删 ----------
console.log('\n[6] 归档只是收起来，不删除');
const b6 = await mk();
const a = b6.remember({ layer: 'semantic', text: '一条被归档的旧记忆', weight: 3 });
a.archived = true;
a.lastAt = Date.now() - 5000 * DAY;
b6.consolidate();
ok(b6.items.length === 1, '归档的不会被删');
ok(b6.stats().archived === 1, '统计里算作归档');

console.log('\n' + '='.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);