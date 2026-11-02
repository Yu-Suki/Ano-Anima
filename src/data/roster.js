// 人物表：她认识谁、该怎么称呼
//
// 为什么需要：原来记忆里全是"他做了X"，注入时没有任何身份信息，
// 模型只能靠猜。人物表把 QQ 号 ↔ 称呼 ↔ 关系 绑起来，记忆只存 id，
// 渲染时查表 —— 以后改名、改备注，所有记忆自动跟着变。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class Roster {
  constructor({ dir, ownerQq = '' }) {
    this.file = join(dir, 'roster.json');
    this.ownerQq = String(ownerQq || '');
    /** id -> { id, name, card, aliases:[], isOwner, firstSeen, lastSeen, groups:[] } */
    this.people = {};
    this.dirty = false;
  }

  async load() {
    try {
      const d = JSON.parse(await readFile(this.file, 'utf8'));
      this.people = d.people || {};
    } catch {
      /* 第一次跑 */
    }
    return this;
  }

  async save() {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify({ people: this.people }, null, 2), 'utf8');
      this.dirty = false;
    } catch {
      /* 存不下不影响运行 */
    }
  }

  /** 每次收到消息都调：更新昵称，顺便记住出现过哪些群 */
  touch(id, { name = '', card = '', groupId = '', isOwner = false } = {}) {
    const key = String(id || '');
    if (!key) return null;
    // 会话 id（g:群号 / p:QQ号）不是人，别塞进人物表
    if (/^[gp]:/.test(key)) return null;

    const now = Date.now();
    const p = this.people[key] || {
      id: key,
      title: '', // 她该怎么叫：主人 / 俞 —— 按 QQ 号绑死，昵称怎么改都不变
      name: '', // QQ 昵称，只作参考，会变
      card: '',
      aliases: [],
      isOwner: false,
      firstSeen: now,
      lastSeen: now,
      groups: [],
    };

    p.lastSeen = now;
    if (isOwner) p.isOwner = true;
    if (this.ownerQq && key === this.ownerQq) p.isOwner = true;

    // 群名片优先（群里大家这么叫），私聊昵称优先
    if (card) p.card = card;
    if (name) p.name = name;

    for (const alias of [name, card].filter(Boolean)) {
      if (!p.aliases.includes(alias)) p.aliases.push(alias);
    }
    p.aliases = p.aliases.slice(-6);

    if (groupId) {
      const g = String(groupId);
      if (!p.groups.includes(g)) p.groups.push(g);
      p.groups = p.groups.slice(-10);
    }

    this.people[key] = p;
    this.dirty = true;
    return p;
  }

  /** 指定称呼。locked=true 表示这是主人定的，她自己不能改 */
  setTitle(id, title, locked = false) {
    const key = String(id || '');
    const p = this.people[key];
    if (!p) return null;
    p.title = String(title || '').trim().slice(0, 12);
    if (locked) p.titleLocked = true;
    this.dirty = true;
    return p;
  }

  /** 她能不能自己改这个人的称呼 */
  canRename(id) {
    const p = this.people[String(id || '')];
    if (!p) return false;
    return !p.titleLocked;
  }

  /** 加个别名（别人这么喊也算叫她） */
  addAlias(id, alias) {
    const p = this.people[String(id || '')];
    if (!p) return null;
    const v = String(alias || '').trim();
    if (v && !p.aliases.includes(v)) p.aliases.push(v);
    p.aliases = p.aliases.slice(-8);
    this.dirty = true;
    return p;
  }

  /** 记下关系：妈妈/爸爸/朋友…… */
  setRelation(id, relation) {
    const key = String(id || '');
    const p = this.people[key];
    if (!p) return null;
    p.relation = String(relation || '').trim().slice(0, 6);
    this.dirty = true;
    return p;
  }

  /** 把她自己登记进人物表：别人喊这些名字就是在喊她 */
  ensureSelf(id, names = []) {
    const key = String(id || '');
    if (!key) return null;
    const p = this.people[key] || {
      id: key,
      title: '',
      name: '',
      card: '',
      aliases: [],
      isOwner: false,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      groups: [],
    };
    p.isSelf = true;
    if (!p.title) p.title = names[0] || '阿糯';
    for (const n of names) {
      const v = String(n || '').trim();
      if (v && !p.aliases.includes(v)) p.aliases.push(v);
    }
    this.people[key] = p;
    this.dirty = true;
    return p;
  }

  /** 她自己叫什么（别人喊这些名字就是在喊她） */
  selfNames() {
    // 她只认一个名字：当前称呼。叫别的她会自己纠正
    for (const p of Object.values(this.people)) {
      if (p.isSelf && p.title) return [p.title];
    }
    return [];
  }


  /** 最合适的称呼：手动定的 > 主人 > 群名片 > 昵称 > QQ尾号 */
  nameOf(id) {
    const p = this.people[String(id || '')];
    if (!p) return this.#fallback(id);
    if (p.title) return p.title;
    if (p.isOwner) return '主人';
    return p.card || p.name || (p.aliases && p.aliases[p.aliases.length - 1]) || this.#fallback(id);
  }

  /** 带身份说明的称呼：主人（三鹿乃粉）、俞（1229026174） */
  label(id) {
    const p = this.people[String(id || '')];
    if (!p) return this.#fallback(id);
    const name = this.nameOf(id);
    const real = p.card || p.name || '';
    if (!real || real === name) return name;
    return `${name}（${real}）`;
  }

  isOwner(id) {
    return Boolean(this.people[String(id || '')]?.isOwner);
  }

  all() {
    return Object.values(this.people).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 从一句话里找出她认识的人（用于"刚才说到谁"） */
  findIn(text) {
    const s = String(text || '');
    const hits = [];
    for (const p of Object.values(this.people)) {
      const names = [p.card, p.name, p.title, ...(p.names || []), ...(p.aliases || [])].filter(Boolean);
      for (const n of names) {
        if (n && n.length >= 1 && s.includes(n)) {
          hits.push(p);
          break;
        }
      }
    }
    return hits;
  }

  #fallback(id) {
    const k = String(id || '');
    if (!k) return '对方';
    if (this.ownerQq && k === this.ownerQq) return '主人';
    return `QQ${k.slice(-4)}`;
  }
}