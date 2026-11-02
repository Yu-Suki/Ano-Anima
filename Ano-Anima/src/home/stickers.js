// 表情包收藏夹：她自己决定存什么、发什么
import { readFile, writeFile, mkdir, readdir, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Stickers {
  constructor({ dir }) {
    this.dir = join(dir, 'stickers');
    this.index = join(dir, 'stickers.json');
    this.items = [];
  }

  async load() {
    try {
      const d = JSON.parse(await readFile(this.index, 'utf8'));
      this.items = Array.isArray(d.items) ? d.items : [];
    } catch {
      this.items = [];
    }
    try {
      await mkdir(this.dir, { recursive: true });
    } catch {}
    return this;
  }

  async saveIndex() {
    await writeFile(this.index, JSON.stringify({ items: this.items }, null, 2), 'utf8');
  }

  /** 存一张：她自己说为什么喜欢 */
  async add(buf, ext = 'png', why = '') {
    const id = randomUUID().slice(0, 6);
    const file = join(this.dir, `${id}.${ext}`);
    await writeFile(file, buf);
    const it = { id, file: `${id}.${ext}`, why: String(why || '').slice(0, 60), at: Date.now(), used: 0 };
    this.items.push(it);
    // 上限 100，满了淘汰最久没用的
    if (this.items.length > 100) {
      const old = [...this.items].sort((a, b) => (a.used || 0) - (b.used || 0) || a.at - b.at)[0];
      this.items = this.items.filter((x) => x.id !== old.id);
      await unlink(join(this.dir, old.file)).catch(() => {});
    }
    await this.saveIndex();
    return it;
  }

  list() {
    return [...this.items].sort((a, b) => b.at - a.at);
  }

  get(id) {
    return this.items.find((x) => x.id === id) || null;
  }

  /** 随机挑一张，可以按"为什么喜欢"筛 */
  pick(keyword = '') {
    let pool = this.items;
    if (keyword) {
      const k = String(keyword).toLowerCase();
      const hit = pool.filter((x) => (x.why || '').toLowerCase().includes(k));
      if (hit.length) pool = hit;
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async markUsed(id) {
    const it = this.get(id);
    if (!it) return;
    it.used = (it.used || 0) + 1;
    await this.saveIndex();
  }

  pathOf(it) {
    return join(this.dir, it.file);
  }
}