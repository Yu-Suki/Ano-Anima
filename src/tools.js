// QQ 能力层：把 NapCat 的 OneBot 接口包装成 LLM 可调用的工具
// 原则：
//   1. 只做"账号本人能做的事"，不做越权
//   2. 导出凭据（cookies/credentials）、原始数据包 —— 一律不暴露给模型
//   3. 破坏性操作必须 owner + 显式确认
import { splitFaces } from './senses/facemap.js';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webSearch, fetchUrl, formatResults } from './text/search.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_DIR = join(ROOT, 'assets', 'avatars');

import { MAX_LIST, clip, resolveTarget, textSeg } from './tools/shared.js';
import { TOOL_LIB, TOOL_CATEGORY } from './tools/meta.js';
import { mcTools } from './adapters/mc/tools.js';
import { webTools } from './tools/web.js';
import { memTools } from './tools/mem.js';
import { qqTools } from './adapters/qq/tools.js';

export function createTools({ onebot, log, roster = null, nap = null, stickers = null, memory = null, autonomy = null, lastImage = null, vec = null, onActivate = null }) {
  const call = (action, params) => onebot.call(action, params);

  const staySilent = {
    name: 'stay_silent',
    description:
      '你不想回这条消息时用。调用后这条就不发出去，对方收不到任何东西。用不用完全看你自己——不想聊、没兴趣、觉得没必要回，都可以不回。',
    parameters: {
      type: 'object',
      properties: { why: { type: 'string', description: '为什么不想回（可空）' } },
      required: [],
    },
    async run(args = {}) {
      log?.('info', `她决定不回这条${args.why ? '：' + args.why : ''}`);
      return { 已跳过: true };
    },
  };

  /** 把 fetch_custom_face 的各种返回形状统一成数组 */
  const asFaceList = (d) => {
    if (!d) return [];
    if (Array.isArray(d)) return d.filter((x) => typeof x === 'string' || (x && (x.url || x.emojiId || x.id)));
    if (typeof d === 'string') return [d];
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.faces)) return d.faces;
    if (Array.isArray(d.faceList)) return d.faceList;
    return [];
  };

  // ---------- 表情包：全凭她喜欢 ----------
      /** SnowLuma HTTP 动作：POST http://127.0.0.1:3000/{动作名} */
  const faceHttp = async (action, params = {}) => {
    const http = await import('node:http');
    const tok = process.env.ONEBOT_HTTP_TOKEN || '';
    log?.('info', `${action} 发起，token=${tok ? tok.slice(0, 6) + '…' : '(空!)'}`);
    const body = JSON.stringify(params);
    const j = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: 3000, path: '/' + action, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ retcode: -1 }); } });
        },
      );
      req.on('error', (e) => resolve({ retcode: -1, wording: e.message }));
      req.write(body); req.end();
    });
    if (j.retcode !== 0) { log?.('warn', `${action} 失败：${j.wording || j.message || j.retcode}`); return { __error: j.wording || 'retcode ' + j.retcode }; }
    log?.('info', `${action} 成功，${Array.isArray(j.data) ? j.data.length + ' 条' : typeof j.data}`);
    return j.data;
  };

  let justSavedUrl = '';

  const facesOf = (d) => {
    if (!d || d.__error || d.__httpError) return [];
    if (Array.isArray(d)) return d.map((x) => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
    if (typeof d === 'string') return [d];
    return [];
  };

  // 表情名片：这个表情是什么、你为什么喜欢
  const metaPath = () => process.cwd() + '/.data/sticker-meta.json';
  const loadMeta = async () => {
    const fs = await import('node:fs/promises');
    try { return JSON.parse(await fs.readFile(metaPath(), 'utf8')); } catch { return {}; }
  };
  const saveMeta = async (m) => {
    const fs = await import('node:fs/promises');
    try { await fs.mkdir(process.cwd() + '/.data', { recursive: true }); } catch {}
    await fs.writeFile(metaPath(), JSON.stringify(m, null, 1), 'utf8');
  };
  const md5Of = (url) => {
    const m = String(url || '').match(/_([0-9A-Fa-f]{32})_/);
    return m ? m[1].toUpperCase() : '';
  };

    // ---------- 她在游戏里的手脚 ----------
  // 游戏里的工具在 tools/mc.js
  const mc = mcTools();

  const mem = memTools({ memory, autonomy, log, vec, onActivate });

  const qq = qqTools({ onebot, roster, log, nap });

  const tools = [
    ...qq,
    ...mem, ...mc,
    staySilent,
    ...webTools(),
  ];

  // 给模型用的 schema（不含内部字段）
  const schemas = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description + (t.destructive ? '【破坏性：必须先征得用户明确同意】' : ''),
      parameters: t.parameters,
    },
  }));

  const byName = new Map(tools.map((t) => [t.name, t]));

  /**
   * 执行一个工具调用。返回给模型看的字符串。
   * 破坏性工具双保险：必须 owner，且 confirm=true
   */
  async function runTool(name, args, ctx) {
    const tool = byName.get(name);
    if (!tool) return JSON.stringify({ error: `没有这个工具：${name}` });

    // 参数体检：空值/无效 ID 直接拦下，别发给 NapCat
    const badArgs = (a) => {
      if (!a) return null;
      for (const [k, v] of Object.entries(a)) {
        if (v === null || v === undefined) continue;
        if (['group_id', 'user_id', 'message_id', 'qq'].includes(k)) {
          const t = String(v).trim();
          if (!t || t === 'null' || t === 'undefined' || t === 'NaN' || t === '0') return k + ' 不是有效的号';
          if (!/^\d+$/.test(t)) return k + ' 必须是纯数字';
        }
      }
      return null;
    };
    const bad = badArgs(args);
    if (bad) return JSON.stringify({ error: '参数不对：' + bad });

    if (tool.destructive) {
      if (!ctx.isOwner) {
        return JSON.stringify({ error: '只有主人（MC_OWNER 指定的号）才能让我做破坏性操作' });
      }
      if (args?.confirm !== true) {
        return JSON.stringify({
          error: '这个操作有破坏性，我没有执行',
          hint: '先把要做什么告诉用户，等用户明确说"确认/可以/执行"之后，再用 confirm=true 重新调用',
        });
      }
    }

    try {
      const out = await tool.run(args ?? {}, ctx);
      if (log) log('info', `工具 ${name} 执行成功`);
      return JSON.stringify(out ?? { ok: true });
    } catch (err) {
      if (log) log('warn', `工具 ${name} 失败：${err.message}`);
      return JSON.stringify({ error: err.message });
    }
  }

  // 给面板用的能力清单：新增工具自动出现在控制台
  const libOf = (name) => {
    if (TOOL_LIB.qq.test(name)) return 'qq';
    if (TOOL_LIB.mc.test(name)) return 'mc';
    if (TOOL_LIB.sticker.test(name)) return 'sticker';
    if (TOOL_LIB.memory.test(name)) return 'memory';
    return 'local';
  };

  const manifest = tools.map((t) => ({
    lib: libOf(t.name),
    name: t.name,
    description: t.description,
    destructive: Boolean(t.destructive),
    category: TOOL_CATEGORY[t.name] || '其他',
    parameters: t.parameters,
  }));

  return { tools, schemas, runTool, byName, manifest };
}