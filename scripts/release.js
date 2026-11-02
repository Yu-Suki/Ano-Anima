// 一键发布：打包 → 压缩便携版 → 编译安装包 → 全部放进 Ano-产物\发布
// 用法：node scripts/release.js [版本号]
import { readFile, writeFile, mkdir, cp, rm, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '..', 'Ano-产物');
const DIST = join(OUT, '便携版');
const REL = join(OUT, '发布');
const ISCC = join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 7', 'ISCC.exe');

const step = (t) => console.log('\n== ' + t + ' ==');

// 0. 版本号
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
if (process.argv[2]) {
  pkg.version = process.argv[2];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}
const VER = pkg.version;
const issPath = join(ROOT, 'scripts', 'installer.iss');
let iss = await readFile(issPath, 'utf8');
iss = iss.replace(/#define AppVer "[^"]*"/, `#define AppVer "${VER}"`);
await writeFile(issPath, iss, 'utf8');
console.log(`版本：${VER}`);

// 1. 打包便携版
step('打包便携版');
const pack = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.js')], { cwd: ROOT, stdio: 'inherit' });
if (pack.status !== 0) process.exit(1);

// 2. 压缩便携版到 发布
step('压缩便携版');
await mkdir(REL, { recursive: true });
const zipName = `Ano-Anima-${VER}-portable.zip`;
const zipPath = join(REL, zipName);
const ps = spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${DIST}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
], { stdio: 'inherit' });
if (ps.status !== 0) process.exit(1);
console.log('  ' + zipName);

// 3. 编译安装包
step('编译安装包');
const iscc = spawnSync(ISCC, [join(ROOT, 'scripts', 'installer.iss')], { stdio: 'inherit' });
if (iscc.status !== 0) process.exit(1);

// 3.5 只保留最近 3 个版本（按版本号排序）
{
  const files = await readdir(REL).catch(() => []);
  const verOf = (f) => {
    const m = f.match(/-(\d+\.\d+\.\d+)-(setup|portable)/);
    return m ? m[1] : null;
  };
  const vers = [...new Set(files.map(verOf).filter(Boolean))]
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
  const keep = new Set(vers.slice(-3));
  for (const f of files) {
    const v = verOf(f);
    if (v && !keep.has(v)) await rm(join(REL, f), { force: true });
  }
  console.log('  只保留最近 3 个版本：' + [...keep].join(', '));
}

// 4. 结果
step('发布目录');
for (const f of await readdir(REL)) {
  const s = await stat(join(REL, f));
  console.log(`  ${f}  ${(s.size / 1024 / 1024).toFixed(1)} MB`);
}
console.log('\n都在：' + REL);
