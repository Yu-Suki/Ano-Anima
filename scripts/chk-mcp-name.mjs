import 'dotenv/config';
import { createTools } from '../src/tools.js';
import { loadMcp, attachMcp } from '../src/mcp/index.js';
const reg = createTools({ onebot: { call: async()=>({}) }, log: ()=>{} });
const mcp = await loadMcp(undefined, { log: ()=>{} });
const n = attachMcp(reg, mcp.tools);
console.log('  接上 ' + n + ' 个，名字: ' + reg.tools.filter(t=>t.lib==='mcp').map(t=>t.name).join(', '));
