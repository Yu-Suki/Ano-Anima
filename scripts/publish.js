// 把"可以公开的部分"同步到仓库文件夹，再从那里推 GitHub
// 用法：node scripts/publish.js "提交说明"
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, '..', 'Ano-产物', '发布', 'Ano-Anima-public');   // 仓库文件夹（放在发布目录里）

const FILES = [
  'README.md', 'LICENSE', 'MIGRATION.md',
  'package.json', 'package-lock.json',
  '.env.example', '.gitignore',
  'persona.example.md',
  'launcher.js', 'start.cmd', 'start-mc.cmd',
];
const DIRS = ['src', 'prompts', 'scripts', 'docs', 'assets'];

// 不许公开的东西
const BANNED = [/\.env$/, /^\.data\//, /^tools\//, /node_modules/, /^persona\.md$/, /\.exe$/, /\.ano$/, /\.zip$/, /^\.git\//];

const note = process.argv[2] || '同步';
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// 1. 清空重建（保留 .git）
await mkdir(PUB, { recursive: true });
for (const name of await readdir(PUB).catch(() => [])) {
  if (name === '.git') continue;
  await rm(join(PUB, name), { recursive: true, force: true });
}
for (const f of FILES) {
  if (await exists(join(ROOT, f))) { await copyFile(join(ROOT, f), join(PUB, f)); console.log('  + ' + f); }
}
for (const d of DIRS) {
  if (await exists(join(ROOT, d))) { await cp(join(ROOT, d), join(PUB, d), { recursive: true }); console.log('  + ' + d + '/'); }
}

// 2. 安全检查
async function walk(dir, out = []) {
  for (const n of await readdir(dir)) {
    if (n === '.git') continue;
    const p = join(dir, n);
    const st = await stat(p);
    if (st.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}
const all = await walk(PUB);
const bad = all.filter((p) => {
  const rel = p.slice(PUB.length + 1).replace(/\\/g, '/');
  return BANNED.some((re) => re.test(rel));
});
if (bad.length) {
  console.error('\n!! 发现不该公开的文件，已中止：');
  for (const b of bad) console.error('   ' + b.slice(PUB.length + 1));
  process.exit(1);
}
console.log('  私有文件检查：通过（' + all.length + ' 个文件）');

// 3. 提交并推
if (!(await exists(join(PUB, '.git')))) {
  spawnSync('git', ['init', '-b', 'main'], { cwd: PUB, stdio: 'inherit' });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/Yu-Suki/Ano-Anima.git'], { cwd: PUB, stdio: 'inherit' });
}
spawnSync('git', ['add', '-A'], { cwd: PUB, stdio: 'inherit' });

const status = spawnSync('git', ['status', '--porcelain'], { cwd: PUB, encoding: 'utf8' }).stdout || '';
if (!status.trim()) {
  console.log('  没有改动，不用提交');
  process.exit(0);
}
spawnSync('git', ['-c', 'user.name=Yu-Suki', '-c', 'user.email=72500806@cityu-dg.edu.cn', 'commit', '-m', note], { cwd: PUB, stdio: 'inherit' });

let ok = false;
for (let i = 1; i <= 15; i++) {
  const r = spawnSync('git', ['push', '--force', '-u', 'origin', 'main'], { cwd: PUB, stdio: 'ignore' });
  if (r.status === 0) { ok = true; console.log('  第 ' + i + ' 次推送成功'); break; }
  console.log('  第 ' + i + ' 次推送失败，等 4 秒重试');
  await new Promise((r2) => setTimeout(r2, 4000));
}
if (!ok) { console.error('!! 推送失败，检查网络后重跑'); process.exit(1); }
console.log('\n完成：' + PUB);
