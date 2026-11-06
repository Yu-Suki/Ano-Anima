// 人物表相关的工具：她认识谁、怎么称呼。跟哪个平台无关。
export function peopleTools({ roster = null, log = null } = {}) {
// ---------- 人物表：她自己管称呼 ----------
  const listPeople = {
    name: 'people_list',
    description:
      '看她认识哪些人：每个人的称呼、QQ号、昵称、在哪些群。不确定该怎么称呼对方、或者想知道对方 QQ 号时用。可传 keyword 按称呼/昵称/QQ号过滤。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '只返回称呼、昵称或 QQ 号里含这个词的人' },
      },
      required: [],
    },
    async run(args = {}) {
      if (!roster) return { error: '人物表没加载' };
      let list = roster.all();
      if (args.keyword) {
        const k = String(args.keyword).toLowerCase();
        list = list.filter((p) =>
          [p.title, p.name, p.card, p.id, ...(p.aliases || [])]
            .filter(Boolean)
            .some((x) => String(x).toLowerCase().includes(k)),
        );
      }
      if (!list.length) return { 人数: 0, 提示: '没有匹配的人' };
      return {
        人数: list.length,
        名单: list.slice(0, 30).map((p) => ({
          称呼: p.title || roster.nameOf(p.id),
          昵称: p.name || p.card || '',
          QQ: p.id,
          关系: p.isOwner ? '主人' : '熟人',
          在群数: (p.groups || []).length,
        })),
      };
    },
  };
  
  const renameP = {
    name: 'people_rename',
    description:
      '按 QQ 号给某个人定称呼（她自己决定怎么叫对方）。想换个叫法、或之前叫得不合适时用。称呼只存 QQ 号上，对方改昵称也不影响。',
    parameters: {
      type: 'object',
      properties: {
        qq: { type: 'string', description: '对方的 QQ 号' },
        title: { type: 'string', description: '新的称呼，2-8 个字，例如 主人、阿俞、老张' },
      },
      required: ['qq', 'title'],
    },
    async run(args = {}) {
      if (!roster) return { error: '人物表没加载' };
      const qq = String(args.qq || '').trim();
      const title = String(args.title || '').trim().slice(0, 8);
      if (!qq || !title) return { error: '要同时给 qq 和 title' };
      if (!roster.people[qq]) return { error: `人物表里没有 ${qq}，先用 people_list 看看有谁` };
      if (!roster.canRename(qq)) {
        return {
          error: `「${roster.nameOf(qq)}」这个称呼是主人定下的，你不能改。想换让他自己说。`,
          ok: false,
        };
      }
  
      const before = roster.nameOf(qq);
      // 改的是她自己：旧名和新名都留作别名，别人喊哪个都算叫她
      const self = roster.people[qq];
      if (self && self.isSelf) {
        roster.addAlias(qq, before);
        roster.addAlias(qq, title);
      }
      roster.setTitle(qq, title);
      await roster.save().catch(() => {});
      log?.('info', `她自己改了称呼：${qq} 从「${before}」改成「${title}」`);
      try { globalThis.__dshState?.refreshSelfNames?.(); } catch {}
      return { 改好了: true, QQ: qq, 原来叫: before, 现在叫: title };
    },
  };
  
  

  return [listPeople, renameP];
}
