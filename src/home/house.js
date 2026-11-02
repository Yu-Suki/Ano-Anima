// 记忆载体（House）—— 记忆唯一的落盘出口
//
// 为什么单独做一个东西：
//   记忆是她身上唯一"不可再生"的资产。人设可以重写、参数可以再调，
//   但 94 条记忆里那些对话、习惯、关系，丢了就永远没有了。
//   所以它需要的不只是"存下来"，还要能回答三个问题：
//     · 什么时候变成了现在这样？（自动快照）
//     · 两次之间到底改了什么？（对比）
//     · 改坏了能不能退回去？（回滚）
//
// 与 Store 接口一致，可直接替换；额外提供快照/对比/回滚/自检。
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  // 毫秒也要带上：同一秒内连拍多张时，秒级 id 会互相覆盖
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export class House {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.snapDir = join(dir, 'snapshots');
    this.indexFile = join(this.snapDir, 'index.json');

    /** 纳入快照的文件。.md 按文本存，其余按 JSON */
    this.tracked = opts.tracked ?? ['brain.json', 'mood.json', 'persona.md'];
    /** 最多保留多少个快照 */
    this.keep = opts.keep ?? 60;
    /** 两次自动快照的最小间隔 */
    this.minGapMs = opts.minGapMs ?? 20 * 60 * 1000;

    this.lastSnapAt = 0;
    this.lastDigest = '';
    this.index = [];
    this.ready = false;
    /** 写入时是否自动拍快照（测试里关掉，方便精确控制） */
    this.auto = opts.auto !== false;
  }

  // ---------- 基础 ----------
  path(name) {
    return join(this.dir, name);
  }

  isText(name) {
    return name.endsWith('.md') || name.endsWith('.txt');
  }

  async init() {
    await mkdir(this.snapDir, { recursive: true });
    this.index = await this.#loadIndex();
    this.ready = true;
    return this;
  }

  /** 与 Store 一致：文件不存在返回 fallback，其它错误抛出（绝不把"读失败"当成"没数据"） */
  async read(name, fallback = null) {
    try {
      const raw = await readFile(this.path(name), 'utf8');
      return this.isText(name) ? raw : JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  async write(name, data) {
    await this.#writeRaw(name, data);
    if (this.auto) await this.maybeSnapshot().catch(() => {});
  }

  async #writeRaw(name, data) {
    const file = this.path(name);
    await mkdir(dirname(file), { recursive: true });
    const body = this.isText(name) ? String(data) : JSON.stringify(data, null, 2);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  }

  // ---------- 快照 ----------
  async #collect() {
    const files = {};
    for (const name of this.tracked) {
      const v = await this.read(name, undefined);
      if (v !== undefined) files[name] = v;
    }
    return files;
  }

  digestOf(files) {
    const keys = Object.keys(files).sort();
    return sha256(keys.map((k) => `${k}:${JSON.stringify(files[k])}`).join('\n'));
  }

  /** 有变化、且离上次够久，才拍一张 */
  async maybeSnapshot(label = 'auto') {
    const files = await this.#collect();
    if (!Object.keys(files).length) return null;

    const digest = this.digestOf(files);
    if (digest === this.lastDigest) return null;

    const tooSoon = this.lastSnapAt && Date.now() - this.lastSnapAt < this.minGapMs;
    if (tooSoon && this.index.length) return null;

    return this.snapshot(label, files, digest);
  }

  /** 强制拍一张（重要时刻：人设被改、恢复前、管理员操作） */
  async snapshot(label = 'manual', files = null, digest = null) {
    const payloadFiles = files ?? (await this.#collect());
    if (!Object.keys(payloadFiles).length) return null;

    const at = Date.now();
    const id = stamp(new Date(at));
    const body = {
      id,
      at,
      label,
      digest: digest ?? this.digestOf(payloadFiles),
      files: payloadFiles,
    };

    await this.#writeRaw(join('snapshots', `${id}.json`), body);

    const entry = this.#entryOf(body);
    this.index = [entry, ...this.index.filter((e) => e.id !== id)];
    this.index.sort((a, b) => b.at - a.at);
    await this.#saveIndex();

    this.lastSnapAt = at;
    this.lastDigest = body.digest;

    await this.prune().catch(() => {});
    return entry;
  }

  #entryOf(body) {
    const brain = body.files['brain.json'];
    return {
      id: body.id,
      at: body.at,
      label: body.label,
      digest: body.digest,
      bytes: JSON.stringify(body).length,
      items: brain?.items?.length ?? null,
      layers: brain?.items
        ? brain.items.reduce((acc, m) => {
            acc[m.layer || 'surface'] = (acc[m.layer || 'surface'] || 0) + 1;
            return acc;
          }, {})
        : null,
      mood: body.files['mood.json']
        ? { valence: body.files['mood.json'].valence, energy: body.files['mood.json'].energy }
        : null,
      files: Object.keys(body.files),
    };
  }

  async #loadIndex() {
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {
      /* 没有索引就重建 */
    }
    return this.#rebuildIndex();
  }

  async #rebuildIndex() {
    const out = [];
    try {
      const names = await readdir(this.snapDir);
      for (const n of names) {
        if (!n.endsWith('.json') || n === 'index.json') continue;
        try {
          const body = JSON.parse(await readFile(join(this.snapDir, n), 'utf8'));
          if (body.id) out.push(this.#entryOf(body));
        } catch {
          /* 坏掉的快照跳过 */
        }
      }
    } catch {
      /* 目录还没建 */
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  async #saveIndex() {
    await this.#writeRaw('snapshots/index.json', this.index);
  }

  // ---------- 查询 ----------
  async list({ limit = 100 } = {}) {
    return this.index.slice(0, limit);
  }

  async loadSnapshot(id) {
    const raw = await readFile(join(this.snapDir, `${id}.json`), 'utf8');
    const body = JSON.parse(raw);
    // 内容自检：摘要对不上说明文件被改坏了
    const actual = this.digestOf(body.files);
    body.intact = actual === body.digest;
    return body;
  }

  // ---------- 对比 ----------
  async diff(fromId = 'now', toId = 'now') {
    // "now" 表示还没存档的当前状态，不能拿去当文件读
    const side = async (ref) =>
      !ref || ref === 'now'
        ? { files: await this.#collect(), id: 'now', at: Date.now() }
        : await this.loadSnapshot(ref);

    const a = await side(fromId);
    const b = await side(toId);

    const lines = [];
    let changed = 0;

    const A = a.files['brain.json']?.items || [];
    const B = b.files['brain.json']?.items || [];
    const mapA = new Map(A.map((m) => [m.id, m]));
    const mapB = new Map(B.map((m) => [m.id, m]));

    for (const [id, m] of mapB) {
      if (!mapA.has(id)) {
        lines.push(`+ [${m.layer}] ${clip(m.text)}`);
        changed++;
      }
    }
    for (const [id, m] of mapA) {
      if (!mapB.has(id)) {
        lines.push(`- [${m.layer}] ${clip(m.text)}`);
        changed++;
      }
    }
    for (const [id, now] of mapB) {
      const was = mapA.get(id);
      if (!was) continue;
      if (was.text !== now.text) {
        lines.push(`~ 内容  ${clip(was.text)}  →  ${clip(now.text)}`);
        changed++;
      }
      if (was.layer !== now.layer) {
        lines.push(`~ 层级  ${was.layer} → ${now.layer}  ${clip(now.text)}`);
        changed++;
      }
      if ((was.weight || 0) !== (now.weight || 0)) {
        lines.push(`~ 重要度 ${was.weight} → ${now.weight}  ${clip(now.text)}`);
        changed++;
      }
      const s1 = Math.round(was.stability || 0);
      const s2 = Math.round(now.stability || 0);
      if (s1 !== s2) {
        lines.push(`~ 稳定度 ${s1}h → ${s2}h  ${clip(now.text)}`);
        changed++;
      }
    }

    const moodA = a.files['mood.json'];
    const moodB = b.files['mood.json'];
    if (moodA && moodB && (moodA.valence !== moodB.valence || moodA.energy !== moodB.energy)) {
      lines.push(
        `~ 情绪  ${moodA.valence?.toFixed(2)}/${moodA.energy?.toFixed(2)} → ` +
          `${moodB.valence?.toFixed(2)}/${moodB.energy?.toFixed(2)}`,
      );
      changed++;
    }

    const pA = a.files['persona.md'];
    const pB = b.files['persona.md'];
    if (typeof pA === 'string' && typeof pB === 'string' && pA !== pB) {
      lines.push(`~ 人设  改动 ${pB.length - pA.length >= 0 ? '+' : ''}${pB.length - pA.length} 字`);
      changed++;
    }

    return {
      from: { id: a.id, at: a.at, items: A.length },
      to: { id: b.id, at: b.at, items: B.length },
      changed,
      lines: lines.slice(0, 400),
    };
  }

  // ---------- 回滚 ----------
  async restore(id) {
    const body = await this.loadSnapshot(id);
    if (!body.intact) {
      throw new Error(`快照 ${id} 内容校验失败，不敢恢复（文件可能损坏）`);
    }

    // 先给当前状态拍一张，万一恢复错了还能退回来
    await this.snapshot('pre-restore').catch(() => {});

    for (const [name, value] of Object.entries(body.files)) {
      await this.#writeRaw(name, value);
    }

    this.lastDigest = body.digest;
    this.lastSnapAt = Date.now();
    return { ok: true, restored: id, files: Object.keys(body.files) };
  }

  // ---------- 自检 ----------
  async verify({ deep = false } = {}) {
    const problems = [];
    let checked = 0;

    for (const entry of this.index) {
      checked++;
      try {
        const body = await this.loadSnapshot(entry.id);
        if (!body.intact) problems.push(`快照 ${entry.id} 摘要不符（文件被改动或损坏）`);
      } catch (err) {
        problems.push(`快照 ${entry.id} 读不出来：${err.message}`);
      }
    }

    const current = await this.#collect();
    const digest = Object.keys(current).length ? this.digestOf(current) : null;
    const last = this.index[0];
    const drifted = last && digest && digest !== last.digest;

    if (deep) {
      const seen = new Set();
      for (const m of current['brain.json']?.items || []) {
        if (seen.has(m.id)) problems.push(`记忆 id 重复：${m.id}`);
        seen.add(m.id);
        if (!m.text) problems.push(`记忆 ${m.id} 没有内容`);
      }
    }

    return {
      ok: problems.length === 0,
      checked,
      problems,
      currentItems: current['brain.json']?.items?.length ?? null,
      /** 当前状态还没进快照（正常，说明有未存档的新变化） */
      changed: Boolean(drifted),
    };
  }

  // ---------- 清理 ----------
  async prune() {
    if (this.index.length <= this.keep) return { removed: 0 };

    const drop = this.index.slice(this.keep);
    for (const e of drop) {
      await unlink(join(this.snapDir, `${e.id}.json`)).catch(() => {});
    }
    this.index = this.index.slice(0, this.keep);
    await this.#saveIndex();
    return { removed: drop.length };
  }
}

function clip(text, n = 46) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export default House;