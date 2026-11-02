// 听懂"称呼"和"关系"这类话
// 数据只有一份：data/roster.js（人物表），这里只做解析和应用
export function makeIntent({ getRoster, log = () => {} }) {
  // ---------- 称呼：主人说了算，代码直接执行，不靠模型自觉 ----------
  const RENAME_STOP = new Set(['什么', '啥', '怎么办', '名字', '啥都', '我', '你', '他', '她']);
  /** 疑问句里出现的"叫"多半不是在定称呼 */
  const RENAME_QUESTION = /[什么啥谁怎哪呢吗]/;
  
  /** 从「叫我X / 以后叫我X吧 / 别叫老板了，叫我主人」里抠出称呼 */
  function parseRename(text) {
    const s = String(text || '').trim();
    // 只在对方发来的真消息里判称呼，别的都不算
    if (!s || s.length > 30) return '';
    // "叫我干嘛嘟""叫我怎么知道" 这种不是在下指令
    if (/(干嘛|怎么|为什么|啥|什么|吗|呢|吧)/.test(s.slice(0, 6))) return '';
    const re = /叫(?:我|俺)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,6}?)(?=吧|就行|就好|好了|啦|呀|哦|喔|[，。！？!?\s]|$)/g;
    let last = '';
    let m;
    while ((m = re.exec(s)) !== null) {
      const t = m[1].trim();
      if (!t || RENAME_STOP.has(t)) continue;
      if (RENAME_QUESTION.test(t)) continue;
      // 「叫我什么好呢」「你觉得叫我啥」这种是在问，不是在下命令
      if (RENAME_QUESTION.test(t.slice(-1))) continue;
      last = t;
    }
    return last;
  }
  
  /** 按 QQ 号把称呼落库，返回是否改了 */
  async function applyRename(senderId, title) {
    if (!getRoster() || !senderId || !title) return false;
    const before = getRoster().nameOf(senderId);
    if (before === title) return false;
    getRoster().setTitle(senderId, title, true); // 主人定的，锁住，她不能改
    await getRoster().save().catch(() => {});
    log('info', `按你说的改称呼：${senderId} 「${before}」→「${title}」`);
    return true;
  }
  
  // ---------- 关系：谁是她妈/爸/朋友，按 QQ 号记 ----------
  const REL_WORDS = ['妈妈', '妈', '爸爸', '爸', '哥哥', '姐姐', '弟弟', '妹妹', '朋友', '主人', '师父'];
  
  /** 从「俞是你妈妈」「你妈是俞」里找出谁是什么关系 */
  function parseRelation(text) {
    const s = String(text || '');
    if (!getRoster()) return null;
  
    // 说法一：某某是你妈妈
    const a = /([\u4e00-\u9fa5A-Za-z0-9]{1,8}?)(?:才|就)?是(?:你|俺)(?:的)?([\u4e00-\u9fa5]{1,4})/g;
    let m;
    while ((m = a.exec(s)) !== null) {
      const who = m[1].replace(/^(你|我|他|她)/, '');
      const rel = REL_WORDS.find((w) => m[2].startsWith(w));
      if (!rel) continue;
      const hits = getRoster().findIn(who);
      if (hits.length === 1) return { id: hits[0].id, relation: rel };
    }
  
    // 说法二：你妈妈是某某
    const b = /(?:你|俺)(?:的)?([\u4e00-\u9fa5]{1,4})(?:就)?是([\u4e00-\u9fa5A-Za-z0-9]{1,8})/g;
    while ((m = b.exec(s)) !== null) {
      const rel = REL_WORDS.find((w) => m[1].startsWith(w));
      if (!rel) continue;
      const hits = getRoster().findIn(m[2]);
      if (hits.length === 1) return { id: hits[0].id, relation: rel };
    }
    return null;
  }
  
  async function applyRelation({ id, relation }) {
    if (!getRoster() || !id || !relation) return false;
    const p = getRoster().people[id];
    if (!p || p.relation === relation) return false;
    getRoster().setRelation(id, relation);
    await getRoster().save().catch(() => {});
    log('info', `记下关系：${getRoster().nameOf(id)}(${id}) 是她${relation}`);
    return true;
  }

  return { parseRename, applyRename, parseRelation, applyRelation };
}
