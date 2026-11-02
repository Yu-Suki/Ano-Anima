import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
// 机器人内部的 API 服务（页面由 launcher.js 提供，这里只留接口）
// 只绑 127.0.0.1
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { PANEL_PAGE } from './panel-page.js';
import { describeSettings, SETTINGS_META } from './data/settings-meta.js';

const EDITABLE_KEYS = SETTINGS_META.map((m) => m.key);

const SECRET_KEYS = new Set(['LLM_API_KEY']);

// ---------- .env 读写（保留原文件其他行和注释） ----------
async function readEnv(path) {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function writeEnv(path, patch) {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    raw = '';
  }
  const lines = raw.split(/\r?\n/);
  const seen = new Set();

  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!m) return line;
    const key = m[1];
    if (!(key in patch)) return line;
    seen.add(key);
    return `${key}=${patch[key]}`;
  });

  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }

  await writeFile(path, out.join('\n'), 'utf8');
}

const mask = (v) => (v ? `${v.slice(0, 4)}••••${v.slice(-4)}` : '');

// ---------- HTTP ----------
export function startWebUI({ state, port = 8788, host = '127.0.0.1', servePage = false }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      // 页面默认不在机器人进程里提供（由 launcher 提供）
      if (servePage && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return html(res, PANEL_PAGE);
      }
      // ---------- 立绘（独立页面，OBS 可直接捕获） ----------
      if (req.method === 'GET' && (url.pathname === '/live2d' || url.pathname.startsWith('/live2d/'))) {
        const { readFile: rf2 } = await import('node:fs/promises');
        const { join: j2, extname: e2, normalize: n2 } = await import('node:path');
        const rel = url.pathname === '/live2d' || url.pathname === '/live2d/' ? 'index.html' : decodeURIComponent(url.pathname.slice(8));
        const fp = j2(process.cwd(), 'src', 'live2d', n2(rel).replace(/^(\.\.\/)+/, ''));
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[e2(fp).toLowerCase()] || 'application/octet-stream';
        try { const buf = await rf2(fp); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(buf); } catch { res.writeHead(404); res.end('not found'); }
        return;
      }

      // ---------- 首次设置：还差什么 ----------
      if (req.method === 'GET' && url.pathname === '/api/setup/status') {
        const need = [
          { key: 'LLM_API_KEY', zh: '聊天模型 key', required: true },
          { key: 'EMBED_API_KEY', zh: '记忆向量 key', required: true },
          { key: 'VISION_API_KEY', zh: '看图 key', required: false },
          { key: 'ONEBOT_WS_URL', zh: 'QQ 协议端地址', required: true },
          { key: 'ONEBOT_SELF_ID', zh: '机器人 QQ 号', required: true },
          { key: 'OWNER_QQ', zh: '主人 QQ 号', required: true },
          { key: 'PANEL_PASSWORD', zh: '面板密码（手机访问时才需要）', required: false },
        ].map((x) => ({
          ...x,
          done: Boolean(String(process.env[x.key] || '').trim()) ||
                (x.key === 'EMBED_API_KEY' && Boolean(String(process.env.VISION_API_KEY || '').trim())),
        }));
        const missing = need.filter((x) => x.required && !x.done).map((x) => x.key);
        return json(res, { ok: missing.length === 0, need, missing });
      }

      // ---------- 人格包：导出 / 导入 ----------
      if (req.method === 'GET' && url.pathname === '/api/pack/export') {
        const { buildPack } = await import('./pkg/persona-pack.js');
        const { buffer, filename, manifest } = await buildPack(process.cwd(), { name: url.searchParams.get('name') || '阿糯' });
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"',
          'Content-Length': buffer.length,
        });
        res.end(buffer);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/pack/status') {
        const { packStatus } = await import('./pkg/persona-pack.js');
        return json(res, packStatus());
      }
      if (req.method === 'POST' && url.pathname === '/api/pack/import') {
        const { applyPack } = await import('./pkg/persona-pack.js');
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (!buf.length) return json(res, { error: '没收到文件' }, 400);
        try {
          const r = await applyPack(process.cwd(), buf);
          return json(res, { ok: true, ...r, note: '导入完成。重启后会按新记忆自动重建向量（需要 EMBED_API_KEY 已填好）' });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      // ---------- 页面 ----------
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return html(res, PAGE);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }

      // ---------- SSE 日志 ----------
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
        const client = (chunk) => res.write(`data: ${chunk}\n\n`);
        state.subscribers.add(client);

        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          state.subscribers.delete(client);
        });
        return;
      }

      // ---------- 状态 ----------
    if (req.method === 'GET' && url.pathname === '/api/vectors/map') {
      // 算一次就记着，除非向量文件变了
      globalThis.__starCache = globalThis.__starCache || {};
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        const root = join(here, '..');
        const st = await import('node:fs/promises').then((m) => m.stat(join(root, '.data', 'vectors.json')));
        const stamp = String(st.mtimeMs) + ':' + st.size;
        if (globalThis.__starCache.stamp === stamp) return json(res, globalThis.__starCache.data);
        const vs = JSON.parse(await readFile(join(root, '.data', 'vectors.json'), 'utf8'));
        const br = JSON.parse(await readFile(join(root, '.data', 'brain.json'), 'utf8'));
        const byId = new Map((br.items || []).map((m) => [m.id, m]));
        const pts = (vs.items || []).map((it) => {
          const v = it.v || [];
          let x = 0, y = 0, z = 0;
          for (let i = 0; i < v.length; i++) { x += v[i] * Math.cos(i * 1.1 + 0.3); y += v[i] * Math.sin(i * 1.3 + 0.7); z += v[i] * Math.cos(i * 0.7 + 1.9); }
          const m = byId.get(it.id) || {};
          return { id: it.id, depth: Number(m.depth) || 1, kids: (m.children || []).slice(0, 40), x, y, z, text: String(m.text || it.text || '').slice(0, 40), w: Number(m.weight || 1), layer: m.layer || 'surface' };
        });
        const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
        const mx = (Math.min(...xs) + Math.max(...xs)) / 2 || 0;
        const my = (Math.min(...ys) + Math.max(...ys)) / 2 || 0;
        const sx = Math.max(...xs.map((v) => Math.abs(v - mx))) || 1;
        const sy = Math.max(...ys.map((v) => Math.abs(v - my))) || 1;
        const zs = pts.map((q) => q.z);
        const mz = (Math.min(...zs) + Math.max(...zs)) / 2 || 0;
        const sz = Math.max(...zs.map((v) => Math.abs(v - mz))) || 1;
        for (const q of pts) {
          q.x = Number(((q.x - mx) / sx).toFixed(4));
          q.y = Number(((q.y - my) / sy).toFixed(4));
          q.z = Number(((q.z - mz) / sz).toFixed(4));
        }
        // 连线：直接用建索引时算好的近邻（余弦相似度），不是屏幕上离得近
        const idToIdx = new Map((vs.items || []).map((it, i) => [it.id, i]));
        const seen = new Set();
        const edges = [];
        (vs.items || []).forEach((it, i) => {
          for (const nb of (it.nb || [])) {
            if (!(nb.s >= 0.6)) continue;   // 只连真正相关的
            if (true) continue;   // 不画相似度线，只留统辖关系
            const key = i < nb.i ? i + '-' + nb.i : nb.i + '-' + i;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ a: i, b: nb.i, s: Number(nb.s) });
          }
        });
        // 整合记忆 → 它统辖的子记忆：细线
        const idxById = new Map(pts.map((q, i) => [q.id, i]));
        for (let i = 0; i < pts.length; i++) {
          for (const k of (pts[i].kids || [])) {
            const j = idxById.get(k);
            if (j != null && j !== i) edges.push({ a: i, b: j, s: 1, kind: 'owns' });
          }
        }
        const payload = { dim: (vs.items?.[0]?.v || []).length, count: pts.length, points: pts, edges };
        globalThis.__starCache = { stamp, data: payload };
        return json(res, payload);
      } catch (e) { return json(res, { error: e.message, points: [] }); }
    }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const up = Date.now() - state.startedAt;
        return json(res, {
          account: state.bot.selfId || '未登录',
          connected: state.bot.connected,
          uptimeSec: Math.floor(up / 1000),
          llmMode: state.llmMode,
          llmModel: state.cfg.llm.model,
          hasKey: Boolean(state.cfg.llm.apiKey),
          stats: state.stats,
          mood: state.mood.toJSON(),
          memory: state.memory.stats(),
          autonomy: state.autonomy ? state.autonomy.status() : null,
          sleep: state.isAsleep(),
          pendingCount: (state.pending || []).length,
          napcat: state.napcatPort ? true : false,
        });
      }

      // ---------- 对话 ----------
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const limit = Number(url.searchParams.get('limit') || 80);
        return json(res, state.messages.all().slice(-limit));
      }

      if (req.method === 'POST' && url.pathname === '/api/send') {
        const body = await readBody(req);
        if (!body.text) return json(res, { error: '内容为空' }, 400);
        try {
          await state.send(body);
          state.log('send', `[面板] ${body.text}`);
          return json(res, { ok: true });
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/nap') {
        const n = state.nap;
        return json(res, {
          sleeping: Boolean(n && n.isSleeping()),
          minutesLeft: n ? n.minutesLeft() : 0,
          until: n ? n.until : 0,
          place: n ? n.place : null,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/nap/wake') {
        if (!state.wakeUpNow) return json(res, { error: '不可用' }, 503);
        const r = await state.wakeUpNow();
        return json(res, { ok: true, ...r });
      }

      // ---------- 人物表 ----------
      if (req.method === 'GET' && url.pathname === '/api/debug/prompt') {
        const gid = new URL(req.url, 'http://x').searchParams.get('gid') || '';
        if (!state.previewPrompt) return json(res, { error: '不可用' }, 503);
        return json(res, { prompt: state.previewPrompt(gid) });
      }
      if (req.method === 'POST' && url.pathname === '/api/roster/sync') {
        if (!state.syncRoster) return json(res, { error: '不可用' }, 503);
        const r = await state.syncRoster();
        state.log('info', `从 QQ 同步了 ${r.updated} 个人的昵称`);
        return json(res, r);
      }
      if (req.method === 'GET' && url.pathname === '/api/roster') {
        if (!state.roster) return json(res, { error: '人物表还没加载' }, 503);
        return json(
          res,
          state.roster.all().map((x) => ({
            id: x.id,
            title: x.title || '',
            relation: x.relation || '',
            isSelf: Boolean(x.isSelf),
            names: x.isSelf ? [x.title, ...(x.aliases || [])].filter(Boolean) : [],
            name: x.name || '',
            card: x.card || '',
            isOwner: Boolean(x.isOwner),
            groups: x.groups || [],
            lastSeen: x.lastSeen || 0,
          })),
        );
      }
      if (req.method === 'PUT' && url.pathname === '/api/roster') {
        if (!state.roster) return json(res, { error: '人物表还没加载' }, 503);
        const body = await readBody(req);
        const id = String(body?.id || '');
        if (!id) return json(res, { error: '缺 id' }, 400);
        const person = state.roster.setTitle(id, body.title || '', true); // 面板改的一律锁住，她自己不能改
        if (!person) return json(res, { error: '没有这个人' }, 404);
        if (body.relation !== undefined) state.roster.setRelation(id, body.relation || '');
        await state.roster.save();
        state.log('info', `人物表：${id} 的称呼改成「${person.title || '(自动)'}」`);
        return json(res, { ok: true, id, title: person.title || '' });
      }

      // ---------- Minecraft 接入：同一个她，只是换了身体 ----------
      if (req.method === 'POST' && url.pathname === '/api/mc-chat') {
        const body = await readBody(req);
        const text = String(body?.text || '').trim();
        if (!text) return json(res, { error: '没有内容' }, 400);
        const r = await state.localChat(text, 'mc');
        return json(res, r || { texts: [] });
      }

      // ---------- 所有提示词文件 ----------
      if (req.method === 'GET' && url.pathname === '/api/prompts') {
        const { readdir, readFile: rf } = await import('node:fs/promises');
        let files = [];
        try { files = await readdir(state.promptsDir); } catch {}
        const out = [];
        for (const f of files.filter((x) => x.endsWith('.md')).sort()) {
          const name = f.replace(/\.md$/, '');
          let text = '';
          try { text = await rf(state.promptsDir + '/' + f, 'utf8'); } catch {}
          out.push({ name, text, size: text.length });
        }
        return json(res, out);
      }

      // ---------- 平台提示词 ----------
      if (url.pathname.startsWith('/api/prompt/')) {
        const name = url.pathname.split('/').pop().replace(/[^a-z0-9_-]/gi, '');
        const { readFile, writeFile, mkdir } = await import('node:fs/promises');
        const file = state.promptsDir + '/' + name + '.md';
        if (req.method === 'GET') {
          try {
            return json(res, { name, text: await readFile(file, 'utf8') });
          } catch {
            return json(res, { name, text: '' });
          }
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          await mkdir(state.promptsDir, { recursive: true });
          await writeFile(file, String(body.text || ''), 'utf8');
          await state.reloadPrompt?.();
          state.log('ok', '平台提示词已保存：' + name);
          return json(res, { ok: true });
        }
      }

      // ---------- 感官：看图 / 听语音 ----------
      if (req.method === 'POST' && url.pathname === '/api/sense/image') {
        const body = await readBody(req);
        const raw = String(body?.data || '');
        const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
        if (!b64) return json(res, { error: '没有图片' }, 400);
        const { describeImage } = await import('./senses/index.js');
        try { state.setLastImage?.(Buffer.from(b64, 'base64'), 'png'); } catch {}
        const text = await describeImage(b64, body.hint || '').catch(() => '（图片识别失败）');
        state.log('info', `她看了眼图片：${text}`);
        return json(res, { text });
      }
      if (req.method === 'POST' && url.pathname === '/api/sense/audio') {
        const body = await readBody(req);
        const raw = String(body?.data || '');
        const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
        if (!b64) return json(res, { error: '没有音频' }, 400);
        const { transcribeAudio } = await import('./senses/index.js');
        const text = await transcribeAudio(Buffer.from(b64, 'base64'), body.ext || 'silk').catch(
          () => '（语音识别失败）',
        );
        state.log('info', `她听了条语音：${text}`);
        return json(res, { text });
      }

      // 今天的所有记忆（跨板块）
      if (req.method === 'GET' && url.pathname === '/api/memory/today') {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const list = state.memory
          .all()
          .filter((m) => m.lastAt >= start.getTime())
          .sort((a, b) => b.lastAt - a.lastAt);
        return json(res, list);
      }

      // ---------- 记忆 ----------
      if (req.method === 'GET' && url.pathname === '/api/star/activation') {
        return json(res, state.lastActivation || null);
      }

      if (req.method === 'GET' && url.pathname === '/api/memory') {
        const q = new URL(req.url, 'http://x').searchParams;
        const layer = q.get('layer');
        let list = state.memory.all();
        if (layer) list = list.filter((m) => m.layer === layer);
        // 每条带上"还能记多久"：寿命 − 已经过的时间
        const now = Date.now();
        const HOUR = 3600000;
        list = list.map((m) => {
          const s = Number(m.stability) || 24;
          const passed = Math.max(0, (now - (m.lastAt || now)) / HOUR);
          // 冻结的情况：核心记忆、以及还统辖着子记忆的整合记忆 —— 都不衰减
          const hasKids = Array.isArray(m.children) && m.children.length > 0;
          const frozen = m.layer === 'core' || (m.layer === 'merged' && hasKids);
          const left = frozen ? Infinity : Math.max(0, s - passed);
          const ratio = frozen ? 1 : Math.max(0, Math.min(1, left / s));
          // 整合记忆再带一段"内容涵盖的时间"：孩子里最早到最晚
          let spanFrom = 0, spanTo = 0;
          if (m.layer === 'merged' && hasKids) {
            const kids = state.memory.all().filter((k) => m.children.includes(k.id));
            const ts = kids.map((k) => k.createdAt || 0).filter(Boolean);
            if (ts.length) { spanFrom = Math.min(...ts); spanTo = Math.max(...ts); }
          }
          return {
            ...m,
            frozen,
            spanFrom,
            spanTo,
            remainHours: frozen ? null : Math.round(left),
            retention: Number(ratio.toFixed(3)),
          };
        });
        return json(res, list);
      }

      // 挪进核心 / 退回原层（核心只收 10 分的）
      if (req.method === 'POST' && url.pathname === '/api/memory/core') {
        const body = await readBody(req);
        const id = String(body?.id || '');
        const src = state.memory.items.find((m) => m.id === id);
        if (!src) return json(res, { error: '没有这条记忆' }, 404);
        if ((src.weight || 0) < 10) {
          return json(res, { error: '只有 10 分的记忆才能进核心' }, 400);
        }
        const item = state.memory.moveToCore(id);
        await state.memory.save();
        state.log('info', `挪进核心：${item.text}`);
        return json(res, item);
      }
      if (req.method === 'DELETE' && url.pathname === '/api/memory/core') {
        const body = await readBody(req).catch(() => ({}));
        const item = state.memory.restoreFromCore(String(body?.id || ''));
        if (!item) return json(res, { error: '没有这条记忆' }, 404);
        await state.memory.save();
        state.log('info', `从核心退回「${item.layer}」：${item.text}`);
        return json(res, item);
      }

      // 工作记忆：当前会话缓存

      if (req.method === 'GET' && url.pathname === '/api/memory/params') {
        return json(res, {
          rule: '寿命由分数决定：1 分约 1 小时，6 分约 6 天，10 分约 1 年；时间到就删，分数随剩余时间往下掉。',
          minHours: 1,
          maxHours: 24 * 365,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/memory') {
        const body = await readBody(req);
        const item = state.memory.add({
          text: body.text,
          subject: body.subject || '',
          kind: body.kind || 'fact',

          source: 'panel',
        });
        if (!item) return json(res, { error: '内容太短' }, 400);
        await state.memory.save();
        state.log('info', `[面板] 记下：${item.text}`);
        return json(res, item);
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/dedupe') {
        const body = await readBody(req).catch(() => ({}));
        const dryRun = Boolean(body.dryRun);
        // 真合并之前先存一份，删错了能退回去
        if (!dryRun) await state.house?.snapshot('去重前').catch(() => {});
        const r = state.memory.dedupeAll({ dryRun });
        if (!dryRun && r.removed) {
          await state.memory.save();
          state.log('info', `[面板] 清理重复记忆：合并掉 ${r.removed} 条`);
        }
        return json(res, r);
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/memory/')) {
        const id = url.pathname.split('/').pop();
        const n = state.memory.remove(id);
        await state.memory.save();
        return json(res, { removed: n });
      }

      // ---------- 本地面谈（不经过 QQ） ----------
      if (req.method === 'POST' && url.pathname === '/api/local-chat') {
        if (!state.localChat) return json(res, { error: '大脑还没就绪' }, 503);
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, { error: '说点什么' }, 400);

        const t0 = Date.now();
        const r = await state.localChat(text);
        state.log('info', `[本地面谈] 你：${text.slice(0, 40)}`);
        return json(res, {
          text: r.text,
          texts: r.texts || (r.text ? [r.text] : []),
          usedTools: r.usedTools,
          ms: Date.now() - t0,
        });
      }

      // ---------- 记忆版本（载体快照） ----------
      if (req.method === 'GET' && url.pathname === '/api/snapshots') {
        if (!state.house) return json(res, { error: '载体还没就绪' }, 503);
        const [list, check] = await Promise.all([
          state.house.list({ limit: 50 }),
          state.house.verify(),
        ]);
        return json(res, { snapshots: list, verify: check, keep: state.house.keep });
      }

      if (req.method === 'GET' && url.pathname === '/api/snapshots/diff') {
        if (!state.house) return json(res, { error: '载体还没就绪' }, 503);
        const from = url.searchParams.get('from') || 'now';
        const to = url.searchParams.get('to') || 'now';
        return json(res, await state.house.diff(from, to));
      }

      if (req.method === 'POST' && url.pathname === '/api/snapshots') {
        if (!state.house) return json(res, { error: '载体还没就绪' }, 503);
        const body = await readBody(req);

        if (body.action === 'snapshot') {
          const entry = await state.house.snapshot(body.label || '手动存档');
          return json(res, { ok: true, entry });
        }

        if (body.action === 'restore') {
          if (!body.id) return json(res, { error: '缺少快照 id' }, 400);
          const r = await state.house.restore(body.id);
          const stats = await state.reloadBrain?.();
          state.log('warn', `[面板] 记忆已回滚到 ${body.id}`);
          return json(res, { ...r, stats });
        }

        return json(res, { error: `不认识的动作：${body.action}` }, 400);
      }

      // ---------- 人设 ----------
      if (url.pathname === '/api/persona') {
        if (req.method === 'GET') {
          const content = await readFile(state.personaPath, 'utf8').catch(() => '');
          return json(res, { content });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          await writeFile(state.personaPath, body.content ?? '', 'utf8');
          if (state.reloadPersona) await state.reloadPersona(body.content ?? '');
          state.log('info', '[面板] 人设已更新');
          return json(res, { ok: true });
        }
      }

      // ---------- 心情 ----------
      if (url.pathname === '/api/mood') {
        if (req.method === 'GET') return json(res, state.mood.toJSON());
        if (req.method === 'PUT') {
          const body = await readBody(req);
          state.mood.set({
            valence: body.valence == null ? undefined : Number(body.valence),
            energy: body.energy == null ? undefined : Number(body.energy),
          });
          await state.mood.save();
          state.log('info', `[面板] 心情设为 ${state.mood.label()}`);
          return json(res, state.mood.toJSON());
        }
      }

      // ---------- 自主行为 ----------
      if (url.pathname === '/api/autonomy') {
        if (!state.autonomy) return json(res, { error: '自主行为模块未加载' }, 503);
        if (req.method === 'GET') return json(res, state.autonomy.status());
        if (req.method === 'PUT') {
          const body = await readBody(req);

          // 直接拖滑块设定需求值 / 活力
          if (body.drives || body.vitality != null) {
            if (body.drives) state.autonomy.setDrives(body.drives);
            if (body.vitality != null) state.autonomy.setVitality(body.vitality);
            await state.autonomy.save().catch(() => {});
            state.log(
              'info',
              `[面板] 状态已手动设定：活力 ${state.autonomy.vitality}，` +
                Object.entries(state.autonomy.snapshot())
                  .map(([, v]) => `${v.zh} ${v.value}`)
                  .join('、'),
            );
            return json(res, state.autonomy.status());
          }

          const enabled = state.autonomy.setEnabled(Boolean(body.enabled));
          if (enabled) state.autonomy.start();
          else state.autonomy.stop();
          state.log('info', `[面板] 自主行为${enabled ? '开启' : '关闭'}`);
          return json(res, state.autonomy.status());
        }
      }

      // ---------- 能力清单 / 手动调用 ----------
      if (req.method === 'GET' && url.pathname === '/api/tools') {
        if (!state.tools) return json(res, { error: '机器人还没加载完' }, 503);
        return json(res, state.tools.manifest);
      }

      if (req.method === 'POST' && url.pathname === '/api/tool-call') {
        if (!state.tools) return json(res, { error: '机器人还没加载完' }, 503);
        const body = await readBody(req);
        if (!body.name) return json(res, { error: '缺少工具名' }, 400);

        const selfId = state.bot?.selfId || '';
        const ctx = {
          selfId,
          groupId: null,
          userId: String(process.env.OWNER_QQ || ''),
          senderId: String(process.env.OWNER_QQ || ''),
          isOwner: true,
        };
        state.log('info', `[面板] 手动调用 ${body.name}`);
        const out = await state.tools.runTool(body.name, body.args || {}, ctx);
        return json(res, out);
      }

      // ---------- 语音 ----------
      if (req.method === 'GET' && url.pathname === '/api/voices') {
        const gid = url.searchParams.get('group_id');
        if (!gid) return json(res, { error: '需要 group_id' }, 400);
        try {
          const data = await state.bot.call('get_ai_characters', { group_id: gid });
          const flat = [];
          for (const g of data || []) {
            for (const c of g.characters || []) {
              flat.push({ id: c.character_id, name: c.character_name, preview: c.preview_url || '' });
            }
          }
          return json(res, { voices: flat, raw: data });
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/voice-send') {
        const body = await readBody(req);
        try {
          const character = body.character || process.env.VOICE_CHARACTER || 'lucy-voice-houge';
          await state.bot.call('send_group_ai_record', {
            group_id: String(body.group_id),
            text: String(body.text || ''),
            character,
          });
          state.log('send', `[面板] 发了条语音（${character}）：${body.text}`);
          return json(res, { ok: true, character });
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      // ---------- 设置 ----------
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          const env = await readEnv(state.envPath);
          return json(res, describeSettings(env));
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const patch = {};
          for (const [k, v] of Object.entries(body)) {
            if (!EDITABLE_KEYS.includes(k)) continue;
            if (SECRET_KEYS.has(k) && String(v).includes('••')) continue; // 掩码没改就跳过
            patch[k] = String(v);
          }
          if (!Object.keys(patch).length) return json(res, { ok: true, changed: 0 });
          await writeEnv(state.envPath, patch);

          // 同步进当前进程的环境变量：读 process.env 的设置才能"改完即生效"
          for (const [k, v] of Object.entries(patch)) process.env[k] = String(v);

          // 能热更新的当场生效，不用重启
          let applied = [];
          try {
            applied = state.applyLive ? state.applyLive(patch) : [];
          } catch {
            applied = [];
          }

          const needRestart = Object.keys(patch).length > applied.length;
          state.log(
            'info',
            `[面板] 改了配置：${Object.keys(patch).join(', ')}` +
              (applied.length ? `（${applied.join('、')} 已生效）` : '') +
              (needRestart ? '（其余需重启）' : ''),
          );
          return json(res, { ok: true, changed: Object.keys(patch).length, applied, needRestart });
        }
      }

      // ---------- 日志回放 ----------
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        return json(res, state.logBuffer.all());
      }

      return json(res, { error: 'not found' }, 404);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  server.listen(port, host, () => {
    state.log('ok', `面板已启动：http://${host}:${port}`);
  });

  return server;
}

function json(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}
