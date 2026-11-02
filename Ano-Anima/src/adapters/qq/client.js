// OneBot 11 客户端（正向 WebSocket）
// 兼容 LLOneBot / NapCatQQ / Lagrange 等实现了 OneBot 11 的服务端
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OneBot extends EventEmitter {
  constructor({ url, token = '', selfId = '' }) {
    super();
    this.url = url;
    this.token = token;
    this._selfId = String(selfId || '');
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connected = false;
    this.stopped = false;
  }

  get selfId() {
    return this._selfId;
  }

  /** 自动重连的主循环 */
  async start() {
    this.stopped = false;
    let backoff = 1000;
    let fails = 0;

    while (!this.stopped) {
      try {
        await this.#connectOnce();
        backoff = 1000;
        fails = 0;
        this.emit('log', 'ok', '已连上 OneBot 服务');
        await new Promise((resolve) => this.once('close', resolve));
        if (this.stopped) break;
        this.emit('log', 'warn', '连接断开，准备重连');
      } catch (err) {
        fails++;
        // 长期掉线时别每 30 秒刷一行日志：前 4 次照常报，之后每隔 20 次提示一下
        if (fails <= 4 || fails % 20 === 0) {
          this.emit('log', 'warn', `连接失败（第 ${fails} 次）：${err.message}`);
          this.emit('log', 'info', `${Math.round(backoff / 1000)}s 后重试`);
        }
      }
      if (this.stopped) break;
      await sleep(backoff);
      // 试了 8 次还不行，说明对面根本没起来，把间隔拉到 5 分钟，别空转
      // 试了几轮还不行就停手，等人手动点重连（别一直空转）
      if (fails >= 5) {
        this.emit('log', 'warn', '连不上，我先停手了 —— 等你手动点「重连」');
        await new Promise(() => {});
        return;
      }
      backoff = Math.min(backoff * 2, 300_000);
    }
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
      const ws = new WebSocket(this.url, { headers });
      let settled = false;

      ws.on('open', () => {
        settled = true;
        this.ws = ws;
        this.connected = true;
        this.emit('ready');
        resolve();
      });

      ws.on('message', (buf) => this.#onFrame(buf));

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.emit('log', 'warn', `WS 错误：${err.message}`);
        }
      });

      ws.on('close', (code) => {
        this.connected = false;
        this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error('连接已断开'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error(`连接关闭 code=${code}`));
        }
        this.emit('close');
      });
    });
  }

  #onFrame(buf) {
    let data;
    try {
      data = JSON.parse(buf.toString());
    } catch {
      return;
    }

    // API 响应（带 echo）
    if (data.echo != null && this.pending.has(data.echo)) {
      const p = this.pending.get(data.echo);
      this.pending.delete(data.echo);
      if (data.status === 'failed' || (data.retcode != null && data.retcode !== 0)) {
        p.reject(new Error(`${data.status || 'failed'} retcode=${data.retcode} ${data.message ?? ''}`));
      } else {
        p.resolve(data.data);
      }
      return;
    }

    // 事件推送
    if (data.post_type) this.emit('event', data);
  }

  /** 调用任意 OneBot API */
  call(action, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OneBot 未连接'));
    }
    const echo = `req-${++this.seq}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }, timeoutMs);

      this.pending.set(echo, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: groupId, message });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: userId, message });
  }

  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: messageId });
  }

  getLoginInfo() {
    return this.call('get_login_info', {});
  }
}

/** 从消息段数组里抽出纯文本 */
export function extractText(event) {
  const segs = Array.isArray(event.message) ? event.message : [];
  if (segs.length) {
    return segs
      .map((s) => {
        switch (s.type) {
          case 'text': return s.data?.text ?? '';
          case 'at': return `@${s.data?.qq ?? ''}`;
          case 'image': return '[图片]';
          case 'face': return '[表情]';
          case 'record': return '[语音]';
          case 'reply': return '';
          default: return '';
        }
      })
      .join('')
      .trim();
  }
  return String(event.raw_message ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/** 是否 @ 了机器人 */
export function isAtSelf(event, selfId) {
  const segs = Array.isArray(event.message) ? event.message : [];
  const me = String(selfId);
  return segs.some((s) => s.type === 'at' && String(s.data?.qq) === me);
}

/** 去掉 @机器人 之后剩下的内容 */
export function stripAtSelf(event, selfId) {
  const segs = Array.isArray(event.message) ? event.message : [];
  const me = String(selfId);
  return segs
    .filter((s) => !(s.type === 'at' && String(s.data?.qq) === me))
    .map((s) => (s.type === 'text' ? s.data?.text ?? '' : s.type === 'image' ? '[图片]' : ''))
    .join('')
    .trim();
}