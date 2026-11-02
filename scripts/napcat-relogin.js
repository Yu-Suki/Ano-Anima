// 用密码重新登录 NapCat，并轮询确认真的上线
// 用法：node scripts/napcat-relogin.js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  napcatPids, stopNapCat, startNapCat, probeNapCat, hasQuickPassword,
} from '../src/net/napcat.js';

const URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
const TOKEN = process.env.ONEBOT_TOKEN || '';
const ACCOUNT = process.env.NAPCAT_QQ || process.env.ONEBOT_SELF_ID || '';
const OWNER = process.env.OWNER_QQ || '';

console.log('='.repeat(56));
console.log('NapCat 重新登录');
console.log('='.repeat(56));
console.log(`账号      : ${ACCOUNT || '(未配置)'}`);
console.log(`自动重登  : ${hasQuickPassword() ? '已配密码（不显示）' : '没配密码，将回退扫码'}`);
console.log('');

if (napcatPids().length) {
  console.log('[1] 停掉现有实例');
  stopNapCat();
  await new Promise((r) => setTimeout(r, 4000));
} else {
  console.log('[1] 当前没有实例');
}

console.log('[2] 启动');
const boot = startNapCat({ root: process.cwd(), account: ACCOUNT });
console.log(`    pid ${boot.pid}`);
console.log(`    日志 ${boot.logFile}`);

console.log('[3] 等待上线（最多 90 秒）');
let online = null;
for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await probeNapCat(URL, TOKEN, { ownerQq: OWNER, timeoutMs: 6000 });
  if (r.online) {
    online = r;
    console.log(`    第 ${(i + 1) * 5} 秒：已上线 ${r.account} / ${r.nickname}`);
    break;
  }
  console.log(`    第 ${(i + 1) * 5} 秒：还没好（${r.error}）`);
}

console.log('');
if (online) {
  console.log('PASS  账号已恢复在线');
} else {
  console.log('FAIL  还没上线，看启动日志：');
  try {
    const raw = await readFile(boot.logFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const l of lines.slice(-14)) {
      console.log('  ' + (l.length > 150 ? l.slice(0, 150) + '…' : l));
    }
  } catch {
    console.log('  (读不到日志)');
  }
}
console.log('='.repeat(56));
process.exit(online ? 0 : 1);