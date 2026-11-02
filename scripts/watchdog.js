// 自动重登开关（给 launcher 的看门狗用）
// 用法：
//   node scripts/watchdog.js status
//   node scripts/watchdog.js hold [小时]   暂停自动重登
//   node scripts/watchdog.js resume        恢复自动重登
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = join(process.cwd(), '.data', 'watchdog.json');

async function load() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return { manualNeeded: false, blockedUntil: 0, attempts: [], revives: 0, restarts: 0 };
  }
}

async function save(d) {
  await mkdir(join(process.cwd(), '.data'), { recursive: true });
  await writeFile(FILE, JSON.stringify(d, null, 2), 'utf8');
}

const cmd = process.argv[2] || 'status';
const hours = Number(process.argv[3]) || 12;

const d = await load();

if (cmd === 'status') {
  console.log('自动重登状态');
  console.log('  人工待处理 :', d.manualNeeded ? '是（不会自动重启）' : '否');
  console.log(
    '  锁定到     :',
    d.blockedUntil && d.blockedUntil > Date.now()
      ? new Date(d.blockedUntil).toLocaleString()
      : '未锁定',
  );
  console.log('  已尝试次数 :', (d.attempts || []).length);
  console.log('  历史重试   :', d.revives || 0);
} else if (cmd === 'hold') {
  d.manualNeeded = true;
  d.blockedUntil = Date.now() + hours * 3600e3;
  await save(d);
  console.log(`已暂停自动重登 ${hours} 小时（到 ${new Date(d.blockedUntil).toLocaleString()}）`);
} else if (cmd === 'resume') {
  d.manualNeeded = false;
  d.blockedUntil = 0;
  d.attempts = [];
  await save(d);
  console.log('已恢复自动重登');
} else {
  console.log('用法: status | hold [小时] | resume');
}