// MCP 客户端：按 MCP 规范用 stdio 说 JSON-RPC（一行一条 JSON）
// 只做三件事：initialize / tools/list / tools/call
import { spawn } from 'node:child_process';

export class McpClient {
  constructor({ name, command, args = [], env = {}, cwd = null, timeoutMs = 20000 }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();   // id → {resolve, reject, timer}
    this.tools = [];
    this.serverInfo = null;
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd || undefined,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (s) => { if (this.onStderr) this.onStderr(String(s)); });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('MCP 进程退出（' + code + '）')); }
      this.pending.clear();
    });
    await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ano-anima', version: '1.0.0' },
    });
    this.#notify('notifications/initialized', {});
    return this;
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 错误'));
        else p.resolve(msg.result);
      }
    }
  }

  #send(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('MCP 进程没起来');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  #notify(method, params) {
    try { this.#send({ jsonrpc: '2.0', method, params }); } catch {}
  }

  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP 超时：' + method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools() {
    const r = await this.#request('tools/list', {});
    this.tools = Array.isArray(r?.tools) ? r.tools : [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    const r = await this.#request('tools/call', { name, arguments: args });
    const content = Array.isArray(r?.content) ? r.content : [];
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text);

    // 图片块（截图之类）：存成本地文件，把路径带回去，她才能"看"
    const images = content.filter((c) => c.type === 'image' && c.data);
    if (images.length) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dir = join(process.cwd(), '.data', 'mcp-images');
      await mkdir(dir, { recursive: true });
      const saved = [];
      for (const [i, img] of images.entries()) {
        const ext = (img.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const p = join(dir, name + '-' + Date.now() + '-' + i + '.' + ext);
        await writeFile(p, Buffer.from(img.data, 'base64'));
        saved.push(p);
      }
      texts.push('（图片已存到：' + saved.join(', ') + '，要看画面内容就用 look_at_image）');
    }
    return texts.join('\n') || r;
  }

  close() {
    try { this.proc?.kill(); } catch {}
  }
}
