import { cp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, '..', 'Ano-产物', '便携版');
// 注意：persona.md 是你自己的她，不能打包；这里只放一个空白模板
const COPY = ['src', 'prompts', 'launcher.js', 'package.json', '.env.example'];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const item of COPY) {
  const from = join(ROOT, item);
  if (!(await exists(from))) continue;
  await cp(from, join(DIST, item), { recursive: true });
  console.log('  + ' + item);
}

// 空白人设：让新用户从零开始（不带你的阿糯）
await writeFile(
  join(DIST, 'persona.md'),
  '# 她是谁\n\n（在这里写下她是谁：名字、年龄、说话习惯、和你的关系。\n也可以不管，直接用「导入人格」把现成的人格包放进来。）\n',
  'utf8'
);
console.log('  + persona.md（空白模板）');

// 运行时：便携 node 一起带走（没有就跳过，README 里说明）
const nodeDir = join(ROOT, 'tools', 'node');
if (await exists(join(nodeDir, 'node.exe'))) {
  await cp(nodeDir, join(DIST, 'tools', 'node'), { recursive: true });
  console.log('  + tools/node（便携运行时）');
}

// 空数据目录：第一次启动会自动建
await mkdir(join(DIST, '.data'), { recursive: true });

const bat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "tools\\node\\node.exe" (
  set NODE=tools\\node\\node.exe
) else (
  set NODE=node
)
echo 正在启动阿糯…
start "" "%NODE%" launcher.js
timeout /t 3 >nul
start "" http://127.0.0.1:8787
exit
`;
await writeFile(join(DIST, '启动.bat'), bat, 'utf8');

const readme = (await readFile(join(ROOT, 'README.md'), 'utf8'));

await writeFile(join(DIST, 'README.md'), readme, 'utf8');
await writeFile(join(DIST, 'README.txt'), '阿糯 · 阿糯相关说明\n\n详细说明见同目录的 README.md（Markdown，用记事本打开也能看）。\n\n快速开始：\n  1. 双击「启动.bat」\n  2. 浏览器打开 http://127.0.0.1:8787\n  3. 按提示填 key 和 QQ 号\n', 'utf8');

console.log('\n打包完成：' + DIST);
console.log('  启动方式：双击「便携版\\启动.bat」');
