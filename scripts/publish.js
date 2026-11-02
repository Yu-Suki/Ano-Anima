// 把"可以公开的部分"同步到一个干净的文件夹，再从那里推 GitHub
// 好处：开发目录里有 .env / .data / node_modules，永远碰不到仓库
// 用法：node scripts/publish.js [提交说明]
import { cp, mkdir, rm, stat, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, '..', 'Ano-Anima-public');   // 仓库文件夹（在项目外面）

// 只复制这些（白名单，宁少不错）
const FILES = [
  'README.md', 'LICENSE', 'MIGRATION.md',
  'package.json', 'package-lock.json',
  '.env.example', '.gitignore',
  'persona.example.md',
  'launcher.js', 'start.cmd', 'start-mc.cmd',
];
const DIRS = ['src', 'prompts', 'scripts', 'docs', 'assets'];

const note = process.argv[2] || '同步';
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', cwd: PUB, ...opts });

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// 1. 清空重建（保留 .git，这样历史不断）
console.log('== 同步到 ' + PUB + ' ==');
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

// 2. 安全检查：不许有私密东西
const banned = ['\\.env$', '^\\.data/', '^tools/', 'node_modules', '^persona\\.md$', '\\.exe$', '\\.ano$'];
const fs = await import('node:fs/promises');
async function walk(dir, out = []) {
  for (const n of await fs.readdir(dir)) {
    if (n === '.git') continue;
    const p = join(dir, n);
    const s = await fs.stat(p);
    if (s.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}
const all = await walk(PUB);
const bad = all.filter((p) => {
  const rel = p.slice(PUB.length + 1).replace(/\\/g, '/');
  return banned.some((re) => new RegExp(re).test(rel));
});
if (bad.length) {
  console.error('\n!! 发现不该公开的文件，已中止：');
  for (const b of bad) console.error('   ' + b.slice(PUB.length + 1));
  process.exit(1);
}
console.log('  私有文件检查：通过（' + all.length + ' 个文件）');

// 3. 提交并推
console.log('\n== 提交 ==');
if (!(await exists(join(PUB, '.git')))) {
  run('git', ['init', '-b', 'main']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/Yu-Suki/Ano-Anima.git']);
}
run('git', ['add', '-A']);
const st = spawnSync('git', ['status', '--porcelain'], { cwd: PUB, encoding: 'utf8' }).stdout || '';
if (!st.trim()) {
  console.log('  没有改动');
} else {
  run('git', ['-c', 'user.name=Yu-Suki', '-c', 'user.email=72500806@cityu-dg.edu.cn',
    'commit', '-m', note]);
  console.log('\n== 推送（网络不稳会自动重试）==');
  let ok = false;
  for (let i = 1; i <= 15; i++) {
    const r = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: PUB, stdio: 'ignore' });
    if (r.status === 0) { ok = true; console.log('  第 ' + i + ' 次成功'); break; }
    console.log('  第 ' + i + ' 次失败，等 4 秒重试');
    await new Promise((r2) => setTimeout(r2, 4000));
  }
  if (!ok) { console.error('!! 推送失败，检查网络后重跑'); process.exit(1); }
}
console.log('\n完成：' + PUB);
