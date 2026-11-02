// 手动跑一次复盘（不睡觉也能试）
import 'dotenv/config';
import { Brain } from '../src/core/memory2.js';
import { Consolidator } from '../src/core/consolidate.js';
import { Store } from '../src/data/store.js';

const store = new Store('.data');
const memory = await new Brain({ store, file: 'brain.json' }).load();
console.log('载入记忆 ' + memory.all().length + ' 条');

const llm = {
  baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-flash',
};

const c = new Consolidator({ memory, llm, log: (k, m) => console.log('[' + k + '] ' + m) });

const since = process.argv[2] ? Number(process.argv[2]) : null;
const t0 = Date.now();
const r = await c.review({ since });
console.log('用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
console.log(JSON.stringify(r));
console.log('现在记忆 ' + memory.all().length + ' 条');
process.exit(0);
