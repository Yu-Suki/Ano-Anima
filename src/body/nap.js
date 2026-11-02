// 小睡：她自己决定睡多久、睡醒找谁说什么
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class Nap {
  constructor({ dir }) {
    this.file = join(dir, 'nap.json');
    this.until = 0;
    this.since = 0;
    this.place = null; // { kind:'group'|'private', id, name }
    this.note = ''; // 她睡前给自己留的话
  }

  async load() {
    try {
      const d = JSON.parse(await readFile(this.file, 'utf8'));
      this.until = d.until || 0;
      this.since = d.since || 0;
      this.place = d.place || null;
      this.note = d.note || '';
    } catch {
      /* 没有就是没睡过 */
    }
    return this;
  }

  async save() {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(
        this.file,
        JSON.stringify({ until: this.until, since: this.since, place: this.place, note: this.note }, null, 2),
        'utf8',
      );
    } catch {
      /* 存不下不影响运行 */
    }
  }

  isSleeping() {
    return this.until > Date.now();
  }

  minutesLeft() {
    return Math.max(0, Math.round((this.until - Date.now()) / 60000));
  }

  /** 她说要睡了：时长由她自己给 */
  async start(minutes, place, note = '') {
    const m = Math.min(240, Math.max(5, Number(minutes) || 90));
    this.since = Date.now();
    this.until = Date.now() + m * 60000;
    this.place = place || null;
    this.note = String(note || '').slice(0, 100);
    await this.save();
    return m;
  }

  /** 醒了（或被叫醒） */
  async wake() {
    const sleptMin = this.since ? Math.round((Date.now() - this.since) / 60000) : 0;
    const place = this.place;
    this.until = 0;
    this.since = 0;
    this.place = null;
    this.note = '';
    await this.save();
    return { sleptMin, place };
  }
}