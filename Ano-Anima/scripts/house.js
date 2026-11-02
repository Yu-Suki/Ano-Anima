// 记忆载体命令行
//
//   node scripts/house.js status          现在有多少记忆、最新快照是什么
//   node scripts/house.js list [n]        列出快照
//   node scripts/house.js diff 2 1        第2新 vs 第1新 有什么区别
//   node scripts/house.js restore 3       回滚到第3新的快照
//   node scripts/house.js snap [说明]     手动拍一张
//   node scripts/house.js verify          校验所有快照有没有坏
//   node scripts/house.js prune           裁掉过老的快照
//
// 注意：机器人正在跑的时候别用 restore（它内存里的旧状态会覆盖回去），
//       请在控制台「记忆」页里恢复，那里会同时重载内存。
import { join } from 'node:path';
import { House } from '../src/home/house.js';

const house = await new House(join(process.cwd(), '.data'), { keep: 60 }).init();
const cmd = process.argv[2] || 'status';
const arg = process.argv[3];
const arg2 = process.argv[4];

const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

/** 支持 "1" 这种序号（1 = 最新）和完整 id */
async function resolve(ref) {
  if (!ref || ref === 'now') return 'now';
  if (/^\d+$/.test(ref) && ref.length <= 3) {
    const list = await house.list();
    const e = list[Number(ref) - 1];
    if (!e) throw new Error(`没有第 ${ref} 个快照（共 ${list.length} 个）`);
    return e.id;
  }
  return ref;
}

switch (cmd) {
  case 'status': {
    const v = await house.verify();
    const list = await house.list({ limit: 1 });
    console.log('记忆载体');
    console.log('  目录     :', house.dir);
    console.log('  当前记忆 :', v.currentItems ?? '(读不到)', '条');
    console.log('  快照数   :', house.index.length, `（上限 ${house.keep}）`);
    if (list[0]) {
      console.log('  最新快照 :', fmtTime(list[0].at), `[${list[0].label}]`, `${list[0].items} 条`);
    }
    if (v.unarchived) console.log('  提示     : 当前状态比最新快照更新，还没存档');
    if (!v.ok) {
      console.log('  !! 发现问题:');
      for (const p of v.problems) console.log('     -', p);
    }
    break;
  }

  case 'list': {
    const list = await house.list({ limit: Number(arg) || 20 });
    if (!list.length) {
      console.log('还没有快照（机器人跑一会儿会自动拍）');
      break;
    }
    console.log('  #  时间                   说明            记忆   情绪      大小');
    for (const [i, e] of list.entries()) {
      const mood = e.mood ? `${e.mood.valence?.toFixed?.(2)}/${e.mood.energy?.toFixed?.(2)}` : '-';
      console.log(
        `  ${String(i + 1).padStart(2)} ${fmtTime(e.at).padEnd(20)} ${String(e.label).padEnd(14)} ` +
          `${String(e.items ?? '-').padStart(3)}  ${mood.padEnd(9)} ${(e.bytes / 1024).toFixed(0)}KB`,
      );
    }
    break;
  }

  case 'diff': {
    const from = await resolve(arg || '2');
    const to = await resolve(arg2 || '1');
    const d = await house.diff(from, to);
    console.log(`对比 ${d.from.id}（${d.from.items} 条）→ ${d.to.id}（${d.to.items} 条）`);
    if (!d.changed) {
      console.log('  没有变化');
      break;
    }
    console.log(`  共 ${d.changed} 处变化：`);
    for (const l of d.lines) console.log('   ', l);
    break;
  }

  case 'restore': {
    if (!arg) {
      console.log('用法: restore <序号或id>');
      break;
    }
    const id = await resolve(arg);
    if (id === 'now') {
      console.log('不能恢复到 now');
      break;
    }
    const r = await house.restore(id);
    console.log(`已恢复到 ${r.restored}，涉及文件：${r.files.join(', ')}`);
    console.log('恢复前的状态已保存为 pre-restore 快照，反悔可以再恢复回来。');
    console.log('!! 如果机器人在跑，请重启它，否则内存里的旧状态会覆盖回去。');
    break;
  }

  case 'snap': {
    const e = await house.snapshot(arg || 'manual');
    if (!e) {
      console.log('没有可拍的内容');
      break;
    }
    console.log(`已保存快照 ${e.id}（${e.items ?? '?'} 条记忆）`);
    break;
  }

  case 'verify': {
    const v = await house.verify({ deep: process.argv.includes('--deep') });
    console.log(`检查了 ${v.checked} 个快照`);
    if (v.ok) console.log('全部正常，内容摘要一致');
    else for (const p of v.problems) console.log('  !!', p);
    break;
  }

  case 'prune': {
    const r = await house.prune();
    console.log(`裁掉 ${r.removed} 个，剩 ${house.index.length} 个`);
    break;
  }

  default:
    console.log('用法: status | list [n] | diff <a> <b> | restore <n|id> | snap [说明] | verify | prune');
}