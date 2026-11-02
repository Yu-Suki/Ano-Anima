import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { VecIndex } from '../src/core/vecindex.js';

const brain = JSON.parse(await readFile('.data/brain.json', 'utf8'));
const all = (brain.items || []).filter((m) => m.text && !m.archived);
const byId = new Map(all.map((m) => [m.id, m]));
const idx = new VecIndex();
await idx.load();

const cmd = process.argv[2];
if (cmd === 'build') {
  console.log(`重建 ${all.length} 条 + 近邻表`);
  await idx.rebuild(all, { onProgress: (a, b) => process.stdout.write(`\r${a}/${b}`) });
  console.log('\n树建好了');
  const st = await idx.selfTest(8);
  console.log(`自检 ${st.hit}/${st.total} ${st.ok ? '✅' : '❌'}`);
} else if (cmd === 'recall') {
  const q = process.argv.slice(3).join(' ');
  const r = await idx.recall(q, {
    getMeta: (id) => {
      const m = byId.get(id) || {};
      const ageDays = m.lastAt ? (Date.now() - m.lastAt) / 86400000 : 0;
      const sHours = m.stability ? m.stability * 60 : 24;
      return { r: Math.exp(-(ageDays * 24) / (sHours || 24)), weight: m.weight, layer: m.layer };
    },
  });
  if (!r) { console.log('没索引'); process.exit(0); }
  console.log(`「${q}」→ 种子${r.breadth.seeds} 跳${r.breadth.hops} 宽${r.breadth.breadth}`);
  r.items.forEach((x, i) => console.log(`  ${i + 1}. ${x.final.toFixed(3)} 动${x.activation}  ${x.text.slice(0, 30)}`));
}
