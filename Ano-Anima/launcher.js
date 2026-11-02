// 启动器 / 面板主机
// 它自己不会退出：负责起停机器人子进程，并把面板挂在 8787
// 机器人跑在 8788 的内部接口上，面板的 /api/* 转发过去
import { SETUP_PAGE } from './src/setup-page.js';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import 'dotenv/config';
import { PANEL_PAGE } from './src/panel-page.js';
// NapCat 时代的功能已停用：协议端换成 SnowLuma（它自己管登录）。
// 这里保留同名空实现，避免老代码里还有引用时报 ReferenceError。
const napcatPids = () => [];
const isNapCatRunning = () => false;
const napcatQqCount = () => 0;
const desktopQqCount = () => 0;
const probeNapCat = async () => ({ online: false, error: '协议端是 SnowLuma，由它自己管' });
const startNapCat = () => ({ pid: 0, logFile: '' });
const stopNapCat = () => {};
const scanBootLog = async () => ({ state: 'unknown', hint: '' });

// 面板「接入」页还在读这些字段，给个空状态，避免 ReferenceError
const napcatState = {
  online: false, error: '', account: '', checkedAt: 0,
  restarts: 0, deadStreak: 0, revives: 0,
  manualNeeded: false, blockedUntil: 0, attempts: [],
  restarting: false, loginState: '', loginHint: '',
};

const ROOT = dirname(fileURLToPath(import.meta.url));
const PANEL_PORT = Number(process.env.WEBUI_PORT || 8787);
const BOT_PORT = Number(process.env.BOT_API_PORT || 8788);
const HOST = process.env.PANEL_HOST || '0.0.0.0';

// ---------- 面板登录 ----------
// 本机（127.0.0.1）免密，其它设备（手机、别的电脑）必须输密码。
// 没配密码时，外部一律进不来 —— 宁可打不开，也不能裸奔。
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const SESSION_TTL = 7 * 24 * 3600e3;
const sessions = new Map(); // token -> 过期时间
const loginTries = new Map(); // ip -> { n, resetAt }

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopback(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionValid(req) {
  const token = parseCookies(req).panel;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function authed(req) {
  return isLoopback(req) || sessionValid(req);
}

function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#14161a">
<title>大肥鱼 · 解锁</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#14161a;color:#dfe3e8;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
       padding:20px;user-select:none}
  .box{width:min(320px,92vw);text-align:center}
  h1{font-size:17px;margin:0 0 4px;font-weight:600}
  .sub{color:#8b949e;font-size:12px;margin-bottom:22px}
  .dots{display:flex;gap:12px;justify-content:center;margin-bottom:8px}
  .dot{width:15px;height:15px;border-radius:50%;border:1.5px solid #3a4150;transition:.15s}
  .dot.on{background:#4a9eff;border-color:#4a9eff;transform:scale(1.12)}
  .err{color:#ff9a9a;font-size:12px;height:18px;margin-bottom:10px}
  .pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .key{background:#1b1e24;border:1px solid #2a2f38;border-radius:12px;padding:16px 0;
       font-size:22px;color:#dfe3e8;cursor:pointer;transition:.1s}
  .key:active{background:#2d333d;transform:scale(.97)}
  .key.fn{font-size:15px;color:#9aa4b2}
  @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
  .shake{animation:shake .3s}
</style></head><body>
<div class="box" id="box">
  <h1>大肥鱼 · 控制台</h1>
  <div class="sub">输入 6 位数字密码</div>
  <div class="dots" id="dots"></div>
  <div class="err" id="err"></div>
  <div class="pad" id="pad"></div>
</div>
<script>
var PIN_LEN = 6;
var input = '';
var busy = false;
var dots = document.getElementById('dots');
var errEl = document.getElementById('err');

for (var i = 0; i < PIN_LEN; i++) {
  var d = document.createElement('div');
  d.className = 'dot';
  dots.appendChild(d);
}

function paint() {
  var ds = dots.children;
  for (var i = 0; i < ds.length; i++) ds[i].className = 'dot' + (i < input.length ? ' on' : '');
}

function shake() {
  var b = document.getElementById('box');
  b.classList.remove('shake');
  void b.offsetWidth;
  b.classList.add('shake');
}

function submit() {
  busy = true;
  errEl.textContent = '';
  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: input })
  })
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.ok) { location.reload(); return; }
    errEl.textContent = d.error || '密码不对';
    input = ''; paint(); shake(); busy = false;
  })
  .catch(function (e) {
    errEl.textContent = '连不上：' + e.message;
    input = ''; paint(); busy = false;
  });
}

function press(k) {
  if (busy) return;
  if (k === 'del') { input = input.slice(0, -1); paint(); return; }
  if (k === 'clear') { input = ''; paint(); return; }
  if (input.length >= PIN_LEN) return;
  input += k;
  paint();
  if (input.length === PIN_LEN) setTimeout(submit, 120);
}

var layout = ['1','2','3','4','5','6','7','8','9','clear','0','del'];
var pad = document.getElementById('pad');
layout.forEach(function (k) {
  var b = document.createElement('button');
  b.className = 'key' + (k === 'clear' || k === 'del' ? ' fn' : '');
  b.textContent = k === 'del' ? '⌫' : k === 'clear' ? '清空' : k;
  b.onclick = function () { press(k); };
  pad.appendChild(b);
});

// 电脑上也能直接敲键盘
document.addEventListener('keydown', function (e) {
  if (/^[0-9]$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') press('del');
  else if (e.key === 'Escape') press('clear');
});
</script></body></html>`;

// ---------- NapCat 看门狗配置 ----------
const NAPCAT_URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
const NAPCAT_WEBUI_PORT = Number(process.env.NAPCAT_WEBUI_PORT || 6099);
const NAPCAT_TOKEN = process.env.ONEBOT_TOKEN || '';
const NAPCAT_ACCOUNT = process.env.NAPCAT_QQ || process.env.ONEBOT_SELF_ID || '';
const OWNER_QQ = process.env.OWNER_QQ || '';
const WATCHDOG_MS = Number(process.env.WATCHDOG_INTERVAL_MIN || 2) * 60000;

// 自动重登的硬限流。
// 反复用密码撞登录会让 QQ 风控升级（这次就撞出了图形验证），
// 所以宁可停下来等人，也不要一遍遍去试。
const RELOGIN_LIMITS = {
  perWindow: 2, // 一个窗口内最多试 2 次
  windowMs: 6 * 3600e3, // 窗口 6 小时
  blockAfterFailMs: 12 * 3600e3, // 撞失败后静默 12 小时
  releaseAfterMin: 20, // 人工处理后仍不通，把账号释放掉（停掉半登录实例）
};

const DATA_DIR = join(ROOT, '.data');
const WATCHDOG_FILE = join(DATA_DIR, 'watchdog.json');

const mcState = { pid: 0, startedAt: 0 };


async function loadWatchdogState() {
  try {
    const raw = await readFile(WATCHDOG_FILE, 'utf8');
    const d = JSON.parse(raw);
    Object.assign(napcatState, {
      manualNeeded: Boolean(d.manualNeeded),
      blockedUntil: Number(d.blockedUntil) || 0,
      attempts: Array.isArray(d.attempts) ? d.attempts : [],
      revives: Number(d.revives) || 0,
      restarts: Number(d.restarts) || 0,
    });
    if (napcatState.manualNeeded) {
      log('info', 'QQ 协议端：SnowLuma（不自动探测；要看状态去「接入」页）');
    }
  } catch {
    /* 第一次跑没有状态文件 */
  }
}

async function saveWatchdogState() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      WATCHDOG_FILE,
      JSON.stringify(
        {
          manualNeeded: napcatState.manualNeeded,
          blockedUntil: napcatState.blockedUntil,
          attempts: napcatState.attempts.slice(-10),
          revives: napcatState.revives,
          restarts: napcatState.restarts,
          savedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* 存不下也不影响运行 */
  }
}
  // ---------- 日志 ----------
const logs = [];
const subscribers = new Set();

const TAGS = { info: '··', ok: 'OK', warn: '!!', err: 'XX', send: '->' };

function log(a, b) {
  // 支持两种调用：log('文本') 和 log('warn', '文本')
  const kind = b === undefined ? '' : String(a);
  const body = b === undefined ? String(a) : String(b);
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const prefix = kind ? `${TAGS[kind] ?? kind} ` : '';
  const line = /^\[\d{2}:\d{2}:\d{2}\]/.test(body) ? body : `[${t}] ${prefix}${body}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 800) logs.shift();
  for (const fn of subscribers) {
    try {
      fn(JSON.stringify({ type: 'log', line }));
    } catch {
      /* ignore */
    }
  }
}

// ---------- 子进程 ----------
let child = null;
let startedAt = 0;
let manualStop = false;
let restarts = 0;

function startBot() {
  if (child) return { ok: false, msg: '已经在运行' };

  manualStop = false;
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedAt = Date.now();

  const pipe = (stream, prefix = '') => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) log(prefix + l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr, '[err] ');

  child.on('exit', (code, signal) => {
    log(`机器人退出（code=${code} signal=${signal ?? '-'}）`);
    child = null;
    startedAt = 0;
    if (!manualStop && code !== 0) {
      restarts++;
      if (restarts <= 3) {
        log('异常退出，5 秒后自动重启…');
        setTimeout(() => {
          if (!child && !manualStop) startBot();
        }, 5000);
      } else {
        log('连续异常，停止自动重启，请到面板手动启动');
      }
    }
  });

  log(`机器人已启动（pid ${child.pid}）`);
  return { ok: true, pid: child.pid };
}

function stopBot() {
  if (!child) return { ok: false, msg: '本来就没在跑' };
  manualStop = true;
  const pid = child.pid;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child && child.pid === pid) child.kill('SIGKILL');
  }, 4000);
  log(`正在停止机器人（pid ${pid}）`);
  return { ok: true, pid };
}

function configured() {
  const need = ['LLM_API_KEY', 'ONEBOT_WS_URL', 'ONEBOT_SELF_ID', 'OWNER_QQ'];
  return need.every((k) => String(process.env[k] || '').trim());
}

function restartBot() {
  if (child) {
    manualStop = true;
    const pid = child.pid;
    child.kill('SIGTERM');
    log(`重启中（先停 pid ${pid}）`);
    setTimeout(() => {
      if (child && child.pid === pid) child.kill('SIGKILL');
      setTimeout(() => startBot(), 1200);
    }, 1500);
    return { ok: true, restarting: true, msg: '重启中，约 15 秒', at: Date.now() };
  }
  return startBot();
}

// ---------- NapCat 看门狗 ----------
// QQ 会话会静默死掉：WS 还连着，但账号已经不在线了。
// 所以不能只看端口，得真的打一次依赖登录核心的接口。




async function startWatchdog() {
  await loadWatchdogState();
  // 不做自动探测了：只在打开「接入」页或点刷新时查一次。
  // 之前每 2 分钟探一次，日志吵，而且一旦联网开着也容易让人误以为"它在自己重连"。
  log('info', 'QQ 状态：SnowLuma 那边看，这里不自动探测');
}

// ---------- 与机器人通信 ----------
function askBot(path, method = 'GET') {
  return new Promise((resolveP) => {
    const req = http.request(
      { host: HOST, port: BOT_PORT, path, method, timeout: 4000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolveP(JSON.parse(raw));
          } catch {
            resolveP(null);
          }
        });
      },
    );
    req.on('error', () => resolveP(null));
    req.on('timeout', () => {
      req.destroy();
      resolveP(null);
    });
    req.end();
  });
}

async function botAlive() {
  const s = await askBot('/api/state');
  return s && !s.error;
}

// ---------- HTTP ----------
const OFFLINE_STATE = {
  offline: true,
  account: '-',
  connected: false,
  uptimeSec: 0,
  llmMode: '-',
  llmModel: '-',
  hasKey: false,
  stats: { received: 0, sent: 0, toolCalls: 0 },
  mood: { valence: 0, energy: 0, label: '-', describe: '', recent: [] },
  memory: { total: 0, byKind: {} },
  sleep: false,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---------- 登录门禁 ----------
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const rec = loginTries.get(ip);
      if (rec && rec.resetAt > Date.now() && rec.n >= 6) {
        return json(res, { error: '试太多次了，等一分钟再来' }, 429);
      }
      if (!PANEL_PASSWORD) {
        return json(res, { error: '没有设置面板密码，外部访问已关闭' }, 403);
      }
      const body = await readBody(req).catch(() => ({}));
      if (!sameSecret(body.password || '', PANEL_PASSWORD)) {
        const now = Date.now();
        const next = !rec || rec.resetAt < now ? { n: 0, resetAt: now + 60000 } : rec;
        next.n++;
        loginTries.set(ip, next);
        log('warn', `面板登录失败：${ip}`);
        return json(res, { error: '密码不对' }, 401);
      }
      const token = randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      loginTries.delete(ip);
      log('ok', `面板已解锁：${ip}`);
      res.setHeader(
        'Set-Cookie',
        `panel=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
      );
      return json(res, { ok: true });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req).panel;
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'panel=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, { ok: true });
    }

    if (!authed(req)) {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_PAGE);
      }
      return json(res, { error: '未解锁，请先输入密码' }, 401);
    }

    // ---------- NapCat 面板反代 ----------
    // NapCat 的 WebUI 只绑 127.0.0.1，手机打不开。
    // 挂到 /napcat/ 下面，复用面板密码，任何设备都能扫码/过验证。
    

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!configured()) {
        res.writeHead(302, { Location: '/setup' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      });
      return res.end(PANEL_PAGE);
    }
    if (req.method === 'GET' && p === '/favicon.ico') return res.writeHead(204).end();

    // SSE 日志
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const client = (chunk) => res.write(`data: ${chunk}\n\n`);
      subscribers.add(client);
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        subscribers.delete(client);
      });
      return;
    }

    // 启停
    if (p === '/api/control' && req.method === 'GET') {
      return json(res, {
        running: Boolean(child),
        pid: child?.pid ?? null,
        since: startedAt,
        restarts,
        panelPort: PANEL_PORT,
        botPort: BOT_PORT,
      });
    }
    if (p === '/api/control' && req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      let out;
      if (action === 'start') out = startBot();
      else if (action === 'stop') out = stopBot();
      else if (action === 'restart') out = restartBot();
      else return json(res, { error: 'action 只能是 start/stop/restart' }, 400);
      return json(res, { ...out, running: Boolean(child) });
    }

    // ---------- 接入总览 ----------
    // 把"她接进了哪些软件"集中在一个地方看
    // ---------- Minecraft：她进游戏 ----------
    if (p === '/api/mc/start' && req.method === 'POST') {
      const running = (await import('node:child_process')).execSync
        ? null : null;
      // 真的查一下有没有 bot.js 在跑
      const { execSync } = await import('node:child_process');
      let alive = [];
      try {
        const out = execSync(
          'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \"*bot.js*\" } | Select-Object -ExpandProperty ProcessId) -join \",\""',
          { encoding: 'utf8', timeout: 8000 },
        );
        alive = String(out).trim().split(',').filter(Boolean);
      } catch {}
      if (alive.length) {
        log('warn', '她已经在游戏里了（pid ' + alive.join(',') + '），不重复进');
        return json(res, { ok: true, already: true, pid: Number(alive[0]) });
      }
      const { spawn } = await import('node:child_process');
      const nodeExe = ROOT + '/tools/node/node.exe';
      // 把她的输出写到文件里，不然出问题什么都看不到
      const { openSync } = await import('node:fs');
      const logFd = openSync(ROOT + '/mc/mc-bot.log', 'a');
      const child = spawn(nodeExe, ['bot.js'], {
        cwd: ROOT + '/mc', detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      });
      child.unref();
      mcState.pid = child.pid;
      mcState.startedAt = Date.now();
      log('ok', '她进 Minecraft 了（pid ' + child.pid + '）');
      return json(res, { ok: true, pid: child.pid });
    }
    if (p === '/api/mc/stop' && req.method === 'POST') {
      if (mcState.pid) {
        try { process.kill(mcState.pid); } catch {}
        log('warn', '她离开 Minecraft 了');
        mcState.pid = 0;
      }
      return json(res, { ok: true });
    }
    if (p === '/api/mc/status') {
      let alive = false;
      if (mcState.pid) { try { process.kill(mcState.pid, 0); alive = true; } catch {} }
      return json(res, { pid: mcState.pid, alive, startedAt: mcState.startedAt || 0 });
    }

    if (p === '/api/integrations' && req.method === 'GET') {
      // integrations 也要真实状态（之前漏了定义，整个接口 500）
      let realOnline = false;
      try {
        const bs = await askBot('/api/state');
        realOnline = Boolean(bs && bs.connected);
      } catch {}
      let webuiUrl = '';
      try {
        const cfg = JSON.parse(
          await readFile(join(ROOT, 'napcat', 'config', 'webui.json'), 'utf8'),
        );
        const token = cfg?.token || cfg?.Token || '';
        if (token) webuiUrl = `http://127.0.0.1:6099/webui?token=${token}`;
      } catch {
        /* 没装或没配就没有入口 */
      }

      return json(res, {
        qq: {
          app: 'QQ',
          via: 'SnowLuma + OneBot 11',
          running: isNapCatRunning(),
          online: realOnline,
          error: napcatState.error || '',
          account: NAPCAT_ACCOUNT,
          ws: NAPCAT_URL,
          webui: webuiUrl,
          needsManual: napcatState.manualNeeded,
          checkedAt: napcatState.checkedAt,
          deadStreak: napcatState.deadStreak,
          restarting: napcatState.restarting,
          loginState: napcatState.loginState,
          loginHint: napcatState.loginHint || '',
          // 桌面 QQ 开着的话，账号很可能被它占着
          desktopQq: desktopQqCount(),
        },
        minecraft: {
          app: 'Minecraft',
          via: 'mineflayer',
          host: process.env.MC_HOST || '127.0.0.1',
          port: process.env.MC_PORT || '25565',
          username: process.env.MC_USERNAME || 'DaFeiYu',
          note: '独立进程，用 start-mc.cmd 启动，不在这个控制台里管',
        },
        planned: [
          { app: 'Telegram', state: '未接入', why: '要先把大脑抽成 HTTP 服务，多个身体共用一个记忆' },
          { app: 'Discord', state: '未接入', why: '同上' },
        ],
      });
    }

    if (p === '/api/logs') return json(res, logs.map((line) => ({ line })));


    // 状态：合并启停信息
      // 首次设置：机器人没起来也要能查（面板是这里提供的）
      if (p === '/api/setup/status') {
        const need = [
          { key: 'LLM_API_KEY', zh: '聊天模型 key', required: true },
          { key: 'EMBED_API_KEY', zh: '记忆向量 key', required: true },
          { key: 'VISION_API_KEY', zh: '看图 key', required: false },
          { key: 'ONEBOT_WS_URL', zh: 'QQ 协议端地址', required: true },
          { key: 'ONEBOT_SELF_ID', zh: '机器人 QQ 号', required: true },
          { key: 'OWNER_QQ', zh: '主人 QQ 号', required: true },
          { key: 'PANEL_PASSWORD', zh: '面板密码（手机访问才需要）', required: false },
        ].map((x) => ({
          ...x,
          done: Boolean(String(process.env[x.key] || '').trim()) ||
                (x.key === 'EMBED_API_KEY' && Boolean(String(process.env.VISION_API_KEY || '').trim())),
        }));
        const missing = need.filter((x) => x.required && !x.done).map((x) => x.key);
        return json(res, { ok: missing.length === 0, need, missing });
      }

    // ---------- 首次设置 ----------
    if (req.method === 'GET' && p === '/setup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(SETUP_PAGE);
    }
    if (req.method === 'POST' && p === '/api/setup/save') {
      try {
        const raw = await new Promise((ok, bad) => {
          let n = 0; const parts = [];
          req.on('data', (d) => { n += d.length; if (n > 40 * 1024 * 1024) bad(new Error('文件太大')); parts.push(d); });
          req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
          req.on('error', bad);
        });
        const b = JSON.parse(raw);
        const patch = {
          LLM_API_KEY: b.llm || '',
          EMBED_API_KEY: b.embed || '',
          VISION_API_KEY: b.vision || '',
          ONEBOT_WS_URL: b.ws || 'ws://127.0.0.1:3001',
          ONEBOT_SELF_ID: b.self || '',
          OWNER_QQ: b.owner || '',
          PANEL_PASSWORD: b.pwd || '',
        };
        const envPath = join(ROOT, '.env');
        let text = '';
        try { text = await readFile(envPath, 'utf8'); } catch {}
        const lines = text ? text.split(/\r?\n/) : [];
        const done = new Set();
        const out = lines.map((l) => {
          const m = l.match(/^([A-Z0-9_]+)=/);
          if (m && Object.prototype.hasOwnProperty.call(patch, m[1])) {
            done.add(m[1]);
            return m[1] + '=' + patch[m[1]];
          }
          return l;
        });
        for (const k of Object.keys(patch)) if (!done.has(k)) out.push(k + '=' + patch[k]);
        await writeFile(envPath, out.join('\n') + '\n', 'utf8');
        Object.assign(process.env, patch);

        if (b.pack) {
          const { applyPack } = await import('./src/pkg/persona-pack.js');
          await applyPack(ROOT, Buffer.from(String(b.pack), 'base64'));
          log('设置：已导入人格');
        } else if (b.mode === 'fresh' && b.persona) {
          await writeFile(join(ROOT, 'persona.md'), '# 她是谁\n\n' + String(b.persona).slice(0, 8000) + '\n', 'utf8');
          log('设置：写入人设');
        }

        log('设置：配置已保存');
        restartBot();
        return json(res, { ok: true });
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
    }

    if (p === '/api/state') {
      if (!child) return json(res, { ...OFFLINE_STATE, running: false });
      const s = await askBot('/api/state');
      if (!s) return json(res, { ...OFFLINE_STATE, running: true, starting: true });
      return json(res, { ...s, offline: false, running: true, pid: child.pid });
    }

    // 其余全部转发给机器人
    if (p.startsWith('/api/')) {
      if (!child) return json(res, { error: '机器人没在运行' }, 503);
      return proxy(req, res, p + url.search);
    }

    return json(res, { error: 'not found' }, 404);
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
});

function proxy(req, res, path) {
  const up = http.request(
    { host: HOST, port: BOT_PORT, path, method: req.method, headers: req.headers, timeout: 60000 },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) json(res, { error: '机器人没响应' }, 503);
  });
  up.on('timeout', () => {
    up.destroy();
    if (!res.headersSent) json(res, { error: '机器人超时' }, 504);
  });
  req.pipe(up);
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolveP) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolveP(raw ? JSON.parse(raw) : {});
      } catch {
        resolveP({});
      }
    });
  });
}

// ---------- 启动 ----------
server.listen(PANEL_PORT, HOST, () => {
  log(`面板：http://127.0.0.1:${PANEL_PORT}`);
  if (PANEL_PASSWORD) {
    log(`局域网/手机也能开，但要输密码（本机不用）`);
  } else {
    log('warn', '没有设置 PANEL_PASSWORD，只允许本机访问');
  }
  startBot();
  startWatchdog();
});

const bye = () => {
  if (child) {
    manualStop = true;
    child.kill('SIGTERM');
  }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);