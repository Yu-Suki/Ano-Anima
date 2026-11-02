// 记忆去重 + 情绪恢复 的测试
import { Brain, sameFact } from '../src/memory2.js';
import { Mood } from '../src/mood.js';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
};

const memStore = () => ({
  data: {},
  async read(name, fb) {
    return this.data[name] ?? fb;
  },
  async write(name, d) {
    this.data[name] = d;
  },
});

console.log('='.repeat(56));
console.log('判重 + 情绪恢复');
console.log('='.repeat(56));

// ---------- 判重的基本判断 ----------
console.log('\n[1] 判重逻辑本身');
ok(sameFact('他在做AI项目', '他在做AI相关的项目'), '换个说法 → 同一条');
ok(sameFact('他养了只猫叫小白', '他养了只猫叫小白很粘人'), '详略版本 → 同一条');
ok(!sameFact('他养了只猫叫小白', '他养了只狗叫小白'), '猫 vs 狗 → 不是一条');
ok(!sameFact('他喜欢猫', '他不喜欢猫'), '否定词不能吞');
ok(!sameFact('他有个机器人', '他有个朋友'), '主体不同 → 不是一条');
ok(!sameFact('猫', '猫叫小白'), '太短的文本不判重');

// ---------- 写进脑子 ----------
console.log('\n[2] 入库去重');
const brain = await new Brain({ store: memStore(), file: 'brain.json' }).load();

brain.remember({ text: '他在做AI项目', layer: 'semantic' });
ok(brain.items.length === 1, '第一条写入');

const hitsBefore = brain.items[0].hits;
const merged = brain.remember({ text: '他在做AI相关的项目', layer: 'semantic' });
ok(brain.items.length === 1, '换个说法没有新增条目', `实际 ${brain.items.length}`);
ok(merged.hits >= hitsBefore + 1, '合并时算一次巩固', `合并前 ${hitsBefore} → 合并后 ${merged.hits}`);
ok(merged.stability > 72, '合并后更难忘', `stability=${Math.round(merged.stability)}`);

brain.remember({ text: '他养了只猫叫小白', layer: 'semantic' });
ok(brain.items.length === 2, '无关的记忆正常写入');

brain.remember({ text: '他养了只狗叫小白', layer: 'semantic' });
ok(brain.items.length === 3, '猫和狗没有被误合并', `实际 ${brain.items.length}`);

brain.remember({ text: '他在做AI项目', layer: 'semantic' });
ok(brain.items.length === 3, '完全一样的也不新增');

ok((brain.stats().merged || 0) >= 1, '合并次数有统计', `merged=${brain.stats().merged}`);

// ---------- 情绪：精力恢复 ----------
console.log('\n[3] 精力随时间恢复（线性，6 小时回满）');
const mk = () => new Mood({ store: memStore(), file: 'mood.json' });
const m1 = mk();
m1.energy = 0.1;
m1.valence = 0.1;
m1.updatedAt = Date.now() - 12 * 3600e3;
m1.tick();
ok(m1.energy > 0.99, '12 小时足够回满', `energy=${m1.energy.toFixed(3)}`);

const m1b = mk();
m1b.energy = 0.1;
m1b.updatedAt = Date.now() - 3 * 3600e3;
m1b.tick();
ok(Math.abs(m1b.energy - 0.6) < 0.01, '线性：3 小时正好涨 0.5（0.1→0.6）', `energy=${m1b.energy.toFixed(3)}`);

const m2 = mk();
m2.energy = 0.1;
m2.updatedAt = Date.now() - 1 * 3600e3;
m2.tick();
ok(m2.energy < 0.85, '只过 1 小时不会瞬间回满', `energy=${m2.energy.toFixed(3)}`);

// ---------- 情绪：心情只恢复 20% ----------
console.log('\n[4] 情绪自然恢复上限 20%');
const m3 = mk();
m3.valence = -1;
m3.updatedAt = Date.now() - 200 * 3600e3; // 很久很久
m3.tick();
// 中性是 0.1，从 -1 出发只肯走完 20%：0.1 + 0.8 * (-1 - 0.1) = -0.78
const expected = 0.1 + 0.8 * (-1 - 0.1);
ok(Math.abs(m3.valence - expected) < 0.02, '很久之后停在 20% 的位置', `valence=${m3.valence.toFixed(3)} 期望≈${expected.toFixed(2)}`);
ok(m3.valence < -0.7, '基本还是不高兴', `valence=${m3.valence.toFixed(3)}`);

const m4 = mk();
m4.valence = 0.9;
m4.updatedAt = Date.now() - 200 * 3600e3;
m4.tick();
const expectedHi = 0.1 + 0.8 * (0.9 - 0.1);
ok(Math.abs(m4.valence - expectedHi) < 0.02, '高兴也只回落 20%', `valence=${m4.valence.toFixed(3)}`);

// ---------- 精力：会掉 ----------
console.log('\n[5] 说话做事耗精力');
const m5 = mk();
m5.energy = 0.5;
m5.drain(0.05);
ok(Math.abs(m5.energy - 0.45) < 1e-6, '做事会掉精力', `energy=${m5.energy}`);
m5.energy = 0.01;
m5.drain(0.5);
ok(m5.energy === 0, '不会掉成负数');

console.log('\n' + '='.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);