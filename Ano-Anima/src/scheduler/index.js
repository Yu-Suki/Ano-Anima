// 定时任务：一件件列清楚，加任务只在这里加一行
// 现在有三件：
//   每分钟   —— 心情恢复、存盘、小睡醒来、凌晨三点加固
//   每两小时 —— 整理记忆（合并相似的）
export function startScheduler({ mood, memory, nap, state, log = () => {}, wakeUp = async () => {}, vec = null, isAsleep = () => false, onBigWake = null, onNightReview = null }) {
  // 定期落盘，防止崩了丢记忆
    setInterval(() => {
      mood.tick(); // 让精力和心情随时间恢复，不然面板显示的是过期数值
      mood.save().catch(() => {});
      if (memory.dirty) memory.save().catch(() => {});
      // 小睡：睡醒了主动去找人
      if (nap) {
        if (nap.isSleeping()) {
          state.napWasSleeping = true;
        } else if (state.napWasSleeping) {
          state.napWasSleeping = false;
          nap.wake().then(({ sleptMin, place }) => {
            // 撞上作息睡眠就不说话（她还在睡）
            if (isAsleep()) { log('info', '作息睡眠中，不主动说话（小睡醒来）'); return; }
            if (place) wakeUp(place, sleptMin).catch(() => {});
          }).catch(() => {});
        }
      }
      // 凌晨 3 点做一夜的巩固：整理过的记忆各加 0.5 分（每天只做一次）
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() === 3 && state.lastNightBoost !== today) {
        state.lastNightBoost = today;
        const n = memory.nightlyBoost(0.5);
        memory.save().catch(() => {});
        if (n) log('info', `夜里巩固：${n} 条记忆各加 0.5 分`);
      }
    }, 60000).unref();
  
    // 熟睡 2 小时后开始复盘（睡着的时候慢慢做，不打扰她）
  setInterval(() => {
    try {
      if (!isAsleep() || !state.sleepStartedAt) return;
      const mins = (Date.now() - state.sleepStartedAt) / 60000;
      if (mins < 120) return;
      if (state.nightReviewed === state.sleepStartedAt) return;
      state.nightReviewed = state.sleepStartedAt;
      if (onNightReview) onNightReview(Math.round(mins));
    } catch {}
  }, 5 * 60 * 1000).unref();

  // 作息睡眠结束：从"睡着"变成"醒着"的那一刻，算一次大睡醒来
  setInterval(() => {
    try {
      const nowAsleep = isAsleep();
      // 一进入睡眠时段就开始计时（不然没人说话就永远不会复盘）
      if (nowAsleep && !state.sleepStartedAt) state.sleepStartedAt = Date.now();
      if (state.wasScheduledAsleep && !nowAsleep) {
        const mins = state.sleepStartedAt ? Math.round((Date.now() - state.sleepStartedAt) / 60000) : 0;
        state.sleepStartedAt = 0;
        if (mins >= 180 && onBigWake) onBigWake(mins);
        else if (mins) log('info', `作息睡眠 ${mins} 分钟结束（不足 3 小时，不复盘）`);
      }
      state.wasScheduledAsleep = nowAsleep;
    } catch {}
  }, 60 * 1000).unref();

  // 每 5 分钟把向量和记忆对齐一次：不依赖任何回调，漏了也会补上
  if (vec) {
    setInterval(async () => {
      try {
        const r = await vec.sync(memory.all());
        if (r.pruned || r.added) log('info', `向量对齐：删 ${r.pruned} 条、补 ${r.added} 条，现在 ${r.total} 条`);
      } catch (e) {
        log('warn', '向量对齐失败：' + e.message);
      }
    }, 5 * 60 * 1000).unref();
  }

  // 每两小时整理一次：把相似/重复的记忆合并，合并时会刷新时间并升级权重
    setInterval(async () => {
      try {
        const r = memory.dedupeAll({ dryRun: false });
        if (r.removed) {
          await memory.save();
          log('info', `记忆整理：合并了 ${r.removed} 条相似记忆（时间已刷新、权重已升级）`);
        }
      } catch (err) {
        log('warn', `记忆整理失败：${err.message}`);
      }
    }, 2 * 60 * 60 * 1000).unref();
}
