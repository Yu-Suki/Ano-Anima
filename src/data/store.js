// 持久化：所有状态存成 JSON 文件，原子写入（先写临时文件再改名，避免写一半崩了）
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
  }

  path(name) {
    return join(this.dir, name);
  }

  async read(name, fallback = null) {
    try {
      const raw = await readFile(this.path(name), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      // 文件不存在 = 正常首次运行
      if (err.code === 'ENOENT') return fallback;
      // 权限不足 / JSON 坏了 = 异常！绝不能当成"没数据"，否则会被空数据覆盖
      throw err;
    }
  }

  async write(name, data) {
    const file = this.path(name);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }
}

/** 环形缓冲：只留最近 N 条 */
export class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.shift();
    return item;
  }

  all() {
    return [...this.items];
  }

  get length() {
    return this.items.length;
  }
}