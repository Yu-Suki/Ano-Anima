// 工具冒烟测试：把 51 个工具挨个点一遍，看有没有"拆坏了"的
// 只跑只读和低风险的；破坏性的（踢人、退群、禁言）跳过
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createTools } = await import('../src/tools.js');
const { OneBot } = await import('../src/net/onebot.js');
const { Roster } = await import('../src/data/roster.js');

const UNSAFE = new Set([
  'qq_kick_member', 'qq_leave_group', 'qq_mute_all', 'qq_set_admin',
  'qq_rename_group', 'qq_set_card', 'qq_set_signature', 'qq_set_nickname',
  'qq_set_avatar', 'qq_post_moment', 'qq_recall', 'qq_sticker_save',
  'qq_send_image', 'qq_send_voice', 'qq_send_text', 'qq_sticker_send',
  'qq_at_member', 'qq_quote_reply', 'qq_poke', 'qq_like', 'qq_forward',
  'go_sleep', 'stay_silent', 'correct_memory', 'mc_goto', 'mc_mine', 'mc_follow', 'mc_say',
  'web_search', 'web_fetch', 'recall_memories',
]);

const onebot = new OneBot({
  url: process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001',
  token: process.env.ONEBOT_TOKEN || '',
  log: () => {},
});

const roster = await new Roster({ dir: join(ROOT, '.data'), ownerQq: process.env.OWNER_QQ || '' }).load();
const built = createTools({
  onebot,
  log: () => {},
  roster,
  nap: null,
  stickers: null,
  memory: null,
  autonomy: null,
  lastImage: () => null,
});
const tools = built.tools;

const byName = new Map(tools.map((t) => [t.name, t]));
const results = [];

for (const t of tools) {
  if (UNSAFE.has(t.name)) { results.push({ name: t.name, status: '跳过（破坏性/会发东西）' }); continue; }
  const ctx = { groupId: process.env.AUTONOMY_GROUP_ID || '', userId: process.env.OWNER_QQ || '', senderId: process.env.OWNER_QQ || '', selfId: '' };
  try {
    const r = await Promise.race([
      t.run({}, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('超时 15s')), 15000)),
    ]);
    const bad = r && typeof r === 'object' && (r.error || r.ok === false);
    results.push({ name: t.name, status: bad ? '⚠ ' + String(r.error || r.message || '返回失败').slice(0, 40) : '✅ 正常' });
  } catch (e) {
    const msg = String(e && e.message || e);
    results.push({
      name: t.name,
      status: /is not defined|not a function|Cannot read/.test(msg) ? '❌ 代码坏了：' + msg.slice(0, 60) : '⚠ 参数问题：' + msg.slice(0, 40),
    });
  }
}

const broken = results.filter((r) => r.status.startsWith('❌'));
const warn = results.filter((r) => r.status.startsWith('⚠'));
const ok = results.filter((r) => r.status.startsWith('✅'));
const skip = results.filter((r) => r.status.startsWith('跳过'));

console.log(`\n共 ${results.length} 个工具`);
console.log(`✅ 正常 ${ok.length}   ⚠ 需要注意 ${warn.length}   ❌ 坏了 ${broken.length}   跳过 ${skip.length}\n`);
for (const r of broken) console.log(r.name.padEnd(22), r.status);
if (warn.length) {
  console.log('\n--- 需要注意的 ---');
  for (const r of warn) console.log(r.name.padEnd(22), r.status);
}
if (process.argv.includes('--all')) {
  console.log('\n--- 全部 ---');
  for (const r of results) console.log(r.name.padEnd(22), r.status);
}
process.exit(0);