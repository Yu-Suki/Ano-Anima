// NapCat 管理测试：验证"只杀自己那棵树"，不动桌面 QQ
// 用法：node scripts/napcat-test.js
import { execFileSync } from 'node:child_process';
import { napcatPids, isNapCatRunning, stopNapCat, startNapCat, probeNapCat, napcatQqCount } from '../src/net/napcat.js';

const qqCount = () => {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-Process QQ -ErrorAction SilentlyContinue).Count"],
      { encoding: 'utf8', timeout: 8000 },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
};

console.log('='.repeat(56));
console.log('NapCat 管理测试');
console.log('='.repeat(56));

const pids = napcatPids();
console.log(`\n[1] 现状`);
console.log(`  NapCat 引导进程: ${pids.length ? pids.join(',') : '(没有)'}`);
console.log(`  属于 NapCat 的 QQ 进程: ${napcatQqCount()} 个`);
console.log(`  QQ 进程总数（含你桌面的）: ${qqCount()} 个`);

const before = qqCount();
const napcatBefore = napcatQqCount();

if (!isNapCatRunning()) {
  console.log('\nNapCat 没在跑，跳过停止测试，直接启动');
} else {
  console.log('\n[2] 停止：应该只掉 NapCat 那一棵');
  const r = stopNapCat();
  console.log(`  stopNapCat 返回: ${JSON.stringify(r)}`);
  await new Promise((r2) => setTimeout(r2, 4000));

  const after = qqCount();
  const remaining = napcatPids().length;
  console.log(`  QQ 进程: ${before} → ${after}`);
  console.log(`  NapCat 引导进程: ${remaining} 个`);
  console.log(`  ${after > 0 ? 'PASS' : 'WARN'}  桌面 QQ 还在（剩 ${after} 个进程）`);
  console.log(`  ${remaining === 0 ? 'PASS' : 'FAIL'}  NapCat 树已清空`);
}

console.log('\n[3] 启动');
const boot = startNapCat({ root: process.cwd(), account: process.env.NAPCAT_QQ || '10001' });
console.log(`  已拉起，pid ${boot.pid}`);
console.log(`  启动日志: ${boot.logFile}`);
await new Promise((r) => setTimeout(r, 20000));

console.log('\n[4] 探测是否真的登录成功');
const probe = await probeNapCat(process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001', process.env.ONEBOT_TOKEN || '', {
  ownerQq: process.env.OWNER_QQ || '',
});
console.log(`  结果: ${JSON.stringify(probe)}`);
console.log(`  ${probe.online ? 'PASS  账号在线' : 'FAIL  还没上线：' + (probe.error || '')}`);

console.log('\n' + '='.repeat(56));