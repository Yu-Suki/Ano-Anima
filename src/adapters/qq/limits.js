// QQ 的规矩：每个会话每分钟最多回几条
// 放这儿是因为它是平台策略（QQ 上刷屏会被骂/被踢），跟"她怎么想"无关
import { RateLimiter } from '../../text/humanize.js';

export function createQqLimiter(perMin = 20) {
  let limit = new RateLimiter(perMin);
  const api = {
    perMin,
    /** 面板改了立刻生效，不用重启 */
    setPerMin(n) {
      const v = Math.max(1, Number(n) || 20);
      if (v === api.perMin) return;
      api.perMin = v;
      limit = new RateLimiter(v);   // 换一个新的窗口，旧计数作废
    },
    /** 这个会话还能不能回；不能就返回 false，调用方直接放弃这一条 */
    allow(convId) {
      if (!convId) return true;
      return limit.take(convId);
    },
  };
  return api;
}
