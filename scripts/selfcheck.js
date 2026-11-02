import 'dotenv/config';
const out = [];
const ok = (n, v, extra = '') => out.push(`${v ? '✅' : '❌'} ${n}${extra ? '  ' + extra : ''}`);

// 1) 所有模块能不能干净导入
const mods = [
  '../src/util/env.js', '../src/util/tokenize.js', '../src/util/similar.js',
  '../src/senses/index.js', '../src/senses/facemap.js', '../src/senses/phash.js',
  '../src/core/attention.js', '../src/core/vecindex.js', '../src/core/health.js',
  '../src/body/mood.js', '../src/body/nap.js', '../src/body/autonomy.js',
  '../src/data/store.js', '../src/data/roster.js', '../src/data/settings-meta.js',
  '../src/text/humanize.js', '../src/text/search.js',
  '../src/home/house.js', '../src/home/stickers.js',
  '../src/tools/meta.js', '../src/tools/shared.js', '../src/tools/mc.js', '../src/tools/web.js', '../src/tools/mem.js', '../src/tools/qq.js',
  '../src/pipeline/intent.js', '../src/pipeline/format.js',
  '../src/scheduler/index.js',
];
let bad = [];
for (const m of mods) { try { await import(m); } catch (e) { bad.push(m + ' → ' + e.message); } }
ok('模块导入', bad.length === 0, bad.length ? bad.join('; ') : `${mods.length} 个全过`);

// 2) 表情映射
const { splitFaces } = await import('../src/senses/facemap.js');
const f1 = splitFaces('（笑）你好');
ok('表情替换', f1[0]?.type === 'face' && f1[0]?.data?.id === '13', '（笑）→ ' + f1[0]?.data?.id);
const f2 = splitFaces('我最喜欢笑着说话了');
ok('不碰正文', f2.length === 1 && f2[0].type === 'text');

// 3) 称呼解析（纯函数）
const { makeIntent } = await import('../src/pipeline/intent.js');
const intent = makeIntent({ getRoster: () => ({ nameOf: () => '', people: {} }), log: () => {} });
ok('认出称呼', intent.parseRename('以后叫我哥哥') === '哥哥', '→ ' + intent.parseRename('以后叫我哥哥'));
ok('不误判问句', intent.parseRename('叫我什么呀') === '');

// 4) 向量索引
const { VecIndex } = await import('../src/core/vecindex.js');
const idx = await new VecIndex().load();
ok('向量索引', idx.ok, `${idx.items.length} 条`);
const st = await idx.selfTest(3);
ok('向量自检', st.ok, `${st.hit}/${st.total}`);

// 5) 记忆库
const brain = JSON.parse(await import('node:fs/promises').then(m => m.readFile('.data/brain.json', 'utf8')));
const items = brain.items.filter(m => !m.archived);
ok('记忆条数', items.length > 100, items.length + ' 条');
const noLayer = items.filter(m => !m.layer).length;
ok('全部有分层', noLayer === 0, noLayer ? noLayer + ' 条缺' : '');
const core = items.filter(m => m.layer === 'core').length;
ok('核心记忆', core > 0 && core <= 30, core + ' 条');

console.log(out.join('\n'));
