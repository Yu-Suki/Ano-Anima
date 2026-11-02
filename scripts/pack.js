import { cp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, '..', 'Ano-产物', '便携版');
// 注意：persona.md 是你自己的她，不能打包；这里只放一个空白模板
const COPY = ['src', 'prompts', 'launcher.js', 'package.json', '.env.example'];

const START_BAT = "@echo off\r\ntitle Ano-Anima\r\ncd /d \"%~dp0\"\r\n\r\nset \"NODE=tools\\node\\node.exe\"\r\nif not exist \"%NODE%\" set \"NODE=node\"\r\n\r\necho ============================================\r\necho   Ano-Anima\r\necho ============================================\r\necho.\r\necho Starting... browser will open in a few seconds.\r\necho If it does not open, visit: http://127.0.0.1:8787\r\necho.\r\necho Keep this window open. Closing it stops her.\r\necho.\r\n\r\n\"%NODE%\" launcher.js\r\nif errorlevel 1 (\r\n  echo.\r\n  echo [ERROR] Program exited with an error. Screenshot this window.\r\n)\r\necho.\r\necho [Program stopped]\r\npause\r\n";
const DIAG_BAT = "@echo off\r\ntitle Ano-Anima - Diagnose\r\ncd /d \"%~dp0\"\r\necho ===== Environment =====\r\necho Folder: %CD%\r\necho.\r\nif exist \"tools\\node\\node.exe\" (echo Node: bundled tools\\node\\node.exe) else (echo Node: NOT FOUND - bundled runtime is missing)\r\nif exist \"node_modules\\ws\" (echo Dependencies: OK) else (echo Dependencies: MISSING)\r\nif exist \".env\" (echo Config .env: found) else (echo Config .env: NOT FOUND - will open setup page)\r\necho.\r\necho ===== Trying to start (copy this output if it fails) =====\r\necho.\r\n\"tools\\node\\node.exe\" launcher.js\r\necho.\r\necho Exit code: %ERRORLEVEL%\r\npause\r\n";

const UNINSTALL_BAT = "@echo off\r\ntitle Ano-Anima - Uninstall\r\ncd /d \"%~dp0\"\r\n\r\nif not exist \"unins000.exe\" (\r\n  echo.\r\n  echo This is the PORTABLE version - there is no installer.\r\n  echo To remove it, just delete this folder.\r\n  echo Your memory is in the .data folder - keep it if you want to come back.\r\n  echo.\r\n  pause\r\n  exit /b 0\r\n)\r\n\r\necho This will uninstall Ano-Anima.\r\necho Your memory (.data folder) will be KEPT so she remembers you next time.\r\necho.\r\nchoice /c YN /m \"Continue\"\r\nif errorlevel 2 exit /b 0\r\n\r\nunins000.exe\r\n";
const START_VBS = "Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\nbase = fso.GetParentFolderName(WScript.ScriptFullName)\r\nSet sh = CreateObject(\"WScript.Shell\")\r\nsh.CurrentDirectory = base\r\n\r\nnode = base & \"\\tools\\node\\node.exe\"\r\nIf Not fso.FileExists(node) Then node = \"node\"\r\n\r\nsh.Run \"\"\"\" & node & \"\"\" launcher.js\", 0, False\r\n";

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

// 依赖：在包里装一份生产依赖（ws / dotenv / jimp）
{
  const npmCli = join(DIST, 'tools', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeExe = join(DIST, 'tools', 'node', 'node.exe');
  const has = await exists(join(DIST, 'node_modules'));
  if (!has && (await exists(npmCli))) {
    console.log('  装依赖（npm install --omit=dev）…');
    const r = spawnSync(nodeExe, [npmCli, 'install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], {
      cwd: DIST, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, PATH: dirname(nodeExe) + ';' + (process.env.PATH || '') },
    });
    console.log('  依赖装好: ' + (r.status === 0 ? 'ok' : '失败(' + r.status + ')'));
  }
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
await writeFile(join(DIST, '启动.bat'), START_BAT, 'utf8');
await writeFile(join(DIST, '启动（无窗口）.vbs'), START_VBS, 'utf8');

const readme = (await readFile(join(ROOT, 'README.md'), 'utf8'));

await writeFile(join(DIST, 'README.md'), readme, 'utf8');
await writeFile(join(DIST, '诊断.bat'), DIAG_BAT, 'utf8');
await writeFile(join(DIST, '卸载.bat'), UNINSTALL_BAT, 'utf8');
await writeFile(join(DIST, 'README.txt'), 'Ano-Anima · 彼念（阿糯）\n\n详细说明见同目录的 README.md（Markdown，用记事本打开也能看）。\n\n快速开始：\n  1. 双击「启动.bat」\n  2. 浏览器打开 http://127.0.0.1:8787\n  3. 按提示填 key 和 QQ 号\n', 'utf8');

console.log('\n打包完成：' + DIST);
// 默认配置：所有项都有默认值，用户只需补 key 和 QQ 号
try {
  const tpl = await readFile(join(ROOT, '.env.example'), 'utf8');
  await writeFile(join(DIST, '.env'), tpl, 'utf8');
  console.log('  + .env（默认值）');
} catch (e) { console.log('  默认 .env 写失败: ' + e.message); }

console.log('  启动方式：双击「便携版\\启动.bat」');
