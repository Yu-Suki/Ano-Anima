// 她自己身体的工具：睡觉、决定不回。跟哪个平台无关。
export function bodyTools({ nap = null, log = null } = {}) {
// ---------- 她自己的作息：想睡就睡 ----------
  const goSleep = {
    name: 'go_sleep',
    description:
      '你觉得累了想睡一会儿时用。睡多久完全由你自己判断：看你有多困、现在几点、醒来后要不要做事。最短 5 分钟，最长 240 分钟，睡着期间别人叫你也听不见。醒来会主动去找睡前跟你说话的人。',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: '你打算睡多久（分钟），自己估，5-240' },
        note: { type: 'string', description: '睡前给自己留一句话，醒来会看到' },
      },
      required: ['minutes'],
    },
    async run(args = {}, ctx = {}) {
      if (!nap) return { error: '作息模块没加载' };
      const place = ctx.groupId
        ? { kind: 'group', id: String(ctx.groupId), name: ctx.groupName || `群${ctx.groupId}` }
        : { kind: 'private', id: String(ctx.userId || ''), name: ctx.who || '对方' };
      const m = await nap.start(args.minutes, place, args.note);
      log?.('info', `她说要去睡了，自己定了 ${m} 分钟`);
      return { 睡了: true, 分钟: m, 醒来时间: new Date(Date.now() + m * 60000).toLocaleTimeString('zh-CN') };
    },
  };
  
  

  const staySilent = {
    name: 'stay_silent',
    description:
      '你不想回这条消息时用。调用后这条就不发出去，对方收不到任何东西。用不用完全看你自己——不想聊、没兴趣、觉得没必要回，都可以不回。',
    parameters: {
      type: 'object',
      properties: { why: { type: 'string', description: '为什么不想回（可空）' } },
      required: [],
    },
    async run(args = {}) {
      log?.('info', `她决定不回这条${args.why ? '：' + args.why : ''}`);
      return { 已跳过: true };
    },
  };

  return [staySilent, goSleep];
}
