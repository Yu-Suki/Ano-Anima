// 一键清空 GitHub 仓库里的所有文件（仓库本身保留）
// 危险操作：会把远端 main 换成一个空提交，之前的内容在远端就看不见了
//
// 用法：
//   node scripts/wipe-repo.js            只看会做什么（不动手）
//   node scripts/wipe-repo.js --yes-真的清空   真的执行
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, '..', 'Ano-Anima-public');
const really = process.argv.includes('--yes-真的清空');

const git = (args, opts = {}) =>
  spawnSync('git', args, { cwd: PUB, stdio: 'inherit', ...opts });

if (!existsSync(PUB)) {
  console.error('找不到公开仓库文件夹：' + PUB);
  process.exit(1);
}

console.log('仓库文件夹：' + PUB);
console.log(really ? '模式：真的要清空' : '模式：试运行（什么都不会发生）');

if (!really) {
  console.log('\n真要清空的话，把命令换成：');
  console.log('  node scripts/wipe-repo.js --yes-真的清空');
  console.log('\n注意：这会 force push 一个空提交，远端历史里旧的文件就访问不到了。');
  console.log('如果你要连历史一起彻底消失，只能在 GitHub 上把仓库删掉再新建。');
  process.exit(0);
}

// 1. 建一个空的孤立分支
console.log('\n== 建空分支 ==');
git(['checkout', '--orphan', 'empty-base']);

// 2. 清空工作区（只留 .git）
console.log('\n== 清空文件 ==');
git(['rm', '-rf', '.', '--cached']);
git(['clean', '-fdx']);

// 3. 只留一个说明文件，避免空提交被拒
const { writeFileSync } = await import('node:fs');
writeFileSync(join(PUB, 'README.md'), '# Ano-Anima\n\n（仓库已清空，等待重新上传。）\n', 'utf8');
git(['add', 'README.md']);
git(['-c', 'user.name=Yu-Suki', '-c', 'user.email=72500806@cityu-dg.edu.cn',
  'commit', '-m', '清空仓库']);

// 4. 覆盖远端
console.log('\n== 推送（会覆盖远端 main）==');
for (let i = 1; i <= 15; i++) {
  const r = spawnSync('git', ['push', '--force', 'origin', 'empty-base:main'], { cwd: PUB, stdio: 'ignore' });
  if (r.status === 0) { console.log('  第 ' + i + ' 次成功'); break; }
  if (i === 15) { console.error('  推送失败，检查网络'); process.exit(1); }
  console.log('  第 ' + i + ' 次失败，重试');
  await new Promise((r2) => setTimeout(r2, 4000));
}

// 5. 本地分支对齐
git(['branch', '-D', 'main']);
git(['checkout', '-b', 'main']);
git(['branch', '-D', 'empty-base']);
console.log('\n清空完成。远端现在只有一个 README。');
