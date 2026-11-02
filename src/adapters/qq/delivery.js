// QQ 的投递规矩：一条回复怎么变成几条消息发出去
// 这些跟"她想说什么"无关 —— 是平台上"人怎么打字"的模拟
import { sleep, rand, chance, typingDelay, introduceTypo } from '../../text/humanize.js';

/**
 * @param {object} deps
 * @param {(target,text)=>Promise<any>} deps.send   真正发出去（含记录）
 * @param {(kind,msg)=>void} deps.log
 * @param {()=>object} deps.getConfig               取当前配置（热更新）
 * @param {(text:string)=>string} deps.fixPlaceholder
 * @param {(id:number)=>Promise<void>} [deps.deleteMsg]
 * @param {(payload:object)=>Promise<any>} deps.respond  连发合并后真正调她的入口
 */
export function createDelivery({ send, log, getConfig, fixPlaceholder, deleteMsg, respond }) {
  // ---------- 连着发好几条：等一下，合成一次 ----------
  const queue = new Map();   // 会话 → { items, timer, build }
  /**
   * 攒着这一小段时间里的话。条目要带"谁、几点、说了什么"——
   * 群里可能是好几个人在说，不能糊成一个人的话。
   */
  function scheduleReply(key, delayMs, build, entry) {
    let q = queue.get(key);
    if (!q) { q = { items: [], timer: null, build: null }; queue.set(key, q); }
    if (entry && String(entry.text || '').trim()) q.items.push(entry);
    q.build = build;
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      queue.delete(key);
      const items = q.items.filter((x) => String(x.text || '').trim());
      if (!items.length) return;
      const payload = q.build();

      // 拼成"谁在什么时候说了什么"，跟聊天记录一个格式
      const transcript = items.map((x) => {
        const t = new Date(x.at || Date.now());
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        return `${hh}:${mm} ${x.who || '对方'}：${x.text}`;
      }).join('\n');

      const speakers = [...new Set(items.map((x) => x.who || '对方'))];
      const meta = {
        ...(payload.meta || {}),
        burst: items.length,
        multiSpeaker: speakers.length > 1,
        speakers,
      };
      respond({ ...payload, meta, userText: transcript }).catch(() => {});
    }, delayMs);
  }

  // ---------- 一条完整回复的投递：她自己换行分条 + 打字延迟 + 偶发错字撤回 ----------
  async function deliver(target, text) {
    const config = getConfig();
    text = fixPlaceholder(text);
    // 不再由代码决定分不分段：她自己想分几条，就用换行写几条
    const hard = String(text).split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const parts = hard.length ? hard.slice(0, 6) : [String(text).trim()].filter(Boolean);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (i > 0) await sleep(5000);
      if (config.human.enabled) await sleep(typingDelay(part, config.human));

      const makeTypo = config.human.enabled && chance(config.human.typoChance);
      const typo = makeTypo ? introduceTypo(part) : null;

      if (!typo) {
        await send(target, part);
        log('send', part);
        continue;
      }

      // 先发错的
      const sent = await send(target, typo.text);
      log('send', `${typo.text}   （打错：${typo.right}→${typo.wrong}）`);

      await sleep(rand(config.human.recallDelayMin, config.human.recallDelayMax));

      if (chance(config.human.recallChance) && sent?.message_id != null && deleteMsg) {
        try {
          if (!config.dryRun) await deleteMsg(sent.message_id);
          log('info', '撤回错字，重新发');
          await sleep(5000);
          await send(target, part);
          log('send', part);
        } catch (err) {
          log('warn', `撤回失败，错字就留着：${err.message}`);
        }
      }
    }
  }

  return { scheduleReply, deliver };
}
