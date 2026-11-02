// 记忆载体自测：快照 / 对比 / 回滚 / 自检 / 裁剪
// 全部在临时目录里做，不碰真实记忆
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { House } from '../src/home/house.js';

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

const dir = await mkdtemp(join(tmpdir(), 'house-'));
// auto:false —— 测试里手动控制快照时机，避免自动快照干扰计数
const house = await new House(dir, { keep: 3, minGapMs: 0, auto: false }).init();

console.log('='.repeat(54));
console.log('记忆载体测试');
console.log('='.repeat(54));
console.log('临时目录:', dir, '\n');

// ---------- 1. 写入 + 快照 ----------
console.log('[1] 写入与快照');
await house.write('brain.json', {
  items: [
    { id: 'a1', layer: 'semantic', text: '他养了只猫叫小白', importance: 3, stability: 72 },
    { id: 'a2', layer: 'social', text: '俞是他的好朋友', importance: 4, stability: 480 },
  ],
});
await house.write('mood.json', { valence: 0.3, energy: 0.6 });
await house.write('persona.md', '# 大肥鱼\n22岁，计算机学生');

const snap1 = await house.snapshot('初始');
ok(Boolean(snap1), '拍下第一个快照');
ok(snap1.items === 2, '快照记录了 2 条记忆', `实际 ${snap1.items}`);
ok(snap1.files.length === 3, '三个文件都进快照', JSON.stringify(snap1.files));

// ---------- 2. 增量修改 ----------
console.log('\n[2] 修改后再拍');
await house.write('brain.json', {
  items: [
    { id: 'a1', layer: 'semantic', text: '他养了只猫叫小白，很粘人', importance: 4, stability: 115 },
    { id: 'a2', layer: 'social', text: '俞是他的好朋友', importance: 4, stability: 480 },
    { id: 'a3', layer: 'episodic', text: '今天一起打了方舟', importance: 2, stability: 72 },
  ],
});
const snap2 = await house.snapshot('加了新记忆');
ok(snap2.items === 3, '新快照 3 条记忆');
ok((await house.list()).length === 2, '共 2 个快照');

// ---------- 3. 对比 ----------
console.log('\n[3] 对比');
const d = await house.diff(snap1.id, snap2.id);
ok(d.changed >= 2, '检测到变化', `changed=${d.changed}`);
ok(d.lines.some((l) => l.startsWith('+') && l.includes('方舟')), '识别出新增的方舟记忆');
ok(d.lines.some((l) => l.startsWith('~') && l.includes('粘人')), '识别出内容被修改');
ok(d.to.items === 3 && d.from.items === 2, '条数对得上');

// "now" 是还没存档的当前状态，不能当成快照 id 去读文件（曾经的 500 就是这个）
const dNow = await house.diff(snap1.id, 'now');
ok(typeof dNow.changed === 'number', '能对比「某个快照 → 当前」', String(dNow.changed));
ok(dNow.to.id === 'now', '"now" 被正确识别为当前状态');

// ---------- 4. 回滚 ----------
console.log('\n[4] 回滚');
const r = await house.restore(snap1.id);
ok(r.ok, '回滚成功');
const back = await house.read('brain.json');
ok(back.items.length === 2, '记忆回到 2 条', `实际 ${back.items.length}`);
ok(back.items[0].text === '他养了只猫叫小白', '内容回到旧版本');
const personaBack = await house.read('persona.md');
ok(personaBack.includes('22岁'), '文本文件（人设）也回滚了');
const afterRestore = await house.list();
ok(afterRestore[0].label === 'pre-restore', '回滚前自动存了 pre-restore');

// ---------- 5. 自检 ----------
console.log('\n[5] 自检');
const v = await house.verify();
ok(v.ok, '所有快照校验通过', JSON.stringify(v.problems));
ok(v.checked === 3, '检查了 3 个快照', `实际 ${v.checked}`);

// ---------- 6. 损坏检测 ----------
console.log('\n[6] 损坏检测');
const snapFile = join(dir, 'snapshots', `${snap2.id}.json`);
const raw = JSON.parse(await readFile(snapFile, 'utf8'));
raw.files['brain.json'].items[0].text = '被偷偷改过';
await writeFile(snapFile, JSON.stringify(raw, null, 2), 'utf8');
const v2 = await house.verify();
ok(!v2.ok, '篡改被检测出来');
ok(v2.problems.some((p) => p.includes(snap2.id)), '指出了是哪个快照');

let refused = false;
try {
  await house.restore(snap2.id);
} catch (err) {
  refused = /校验失败/.test(err.message);
}
ok(refused, '损坏的快照拒绝恢复');

// ---------- 7. 裁剪 ----------
console.log('\n[7] 裁剪');
for (let i = 0; i < 5; i++) {
  await house.write('mood.json', { valence: i / 10, energy: 0.5 });
  await house.snapshot(`批量${i}`);
}
const before = (await house.list()).length;
await house.prune();
const after = (await house.list()).length;
ok(after <= 3, `裁剪到上限 3 个`, `裁剪前 ${before}，裁剪后 ${after}`);

// ---------- 8. 读失败不能当空 ----------
console.log('\n[8] 读失败保护');
let thrown = false;
try {
  await house.read('不存在的目录/x.json', null);
} catch {
  thrown = true;
}
ok(!thrown, '文件不存在时返回 fallback（正常首次运行）');

await rm(dir, { recursive: true, force: true });

console.log('\n' + '='.repeat(54));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(54));
process.exit(fail ? 1 : 0);