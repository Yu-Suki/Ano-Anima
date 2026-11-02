// 自检：不连 QQ、不调模型，只验证拟人层的行为是否符合预期
// 用法：node scripts/selftest.js
import { config } from '../src/config.js';
import {
  segment, typingDelay, replyDelay, introduceTypo,
  isAsleep, localHour, rand,
} from '../src/text/humanize.js';

const cfg = config.human;
const line = (s = '') => console.log(s);

line('='.repeat(56));
line('拟人层自检');
line('='.repeat(56));

// 1. 分段
line('\n【1】长回复会被拆成几条发：');
const long = '今天服务器又崩了。我下午挖了一下午的矿全没了，真的离谱。你说这破游戏还能不能玩了。';
const parts = segment(long, { ...cfg, splitChance: 1 });
parts.forEach((p, i) => line(`  消息${i + 1}（${p.length}字）: ${p}`));
line(`  → 拆成 ${parts.length} 条，上限 ${cfg.maxSegments}`);

// 2. 打字延迟
line('\n【2】不同长度消息的打字耗时：');
for (const t of ['嗯', '确实', '我刚下课回来', '今天服务器又崩了我挖了一下午的矿全没了']) {
  const d = typingDelay(t, cfg);
  line(`  ${String(t.length).padStart(2)}字  "${t}"  →  ${(d / 1000).toFixed(2)}s`);
}

// 3. 回复犹豫
line('\n【3】回复延迟分布（20 次采样）：');
const delays = Array.from({ length: 20 }, () => replyDelay(cfg) / 1000);
const busy = delays.filter((d) => d > cfg.replyDelayMax / 1000);
line(`  正常: ${delays.filter((d) => d <= cfg.replyDelayMax / 1000).map((d) => d.toFixed(1) + 's').join('  ')}`);
line(`  "在忙"（>${(cfg.replyDelayMax / 1000).toFixed(0)}s）: ${busy.length} 次  ${busy.map((d) => d.toFixed(0) + 's').join('  ') || '无'}`);

// 4. 错字
line('\n【4】错字模拟：');
let typoCount = 0;
for (const t of ['这个确实是这样', '他已经走了', '你在干嘛呢']) {
  const r = introduceTypo(t);
  if (r) {
    typoCount++;
    line(`  原句: ${t}`);
    line(`  打错: ${r.text}   （${r.right} → ${r.wrong}）`);
  } else {
    line(`  「${t}」找不到可替换的字，跳过`);
  }
}
line(`  → ${typoCount}/3 句成功制造错字`);

// 5. 作息
line(`\n【5】作息判定（睡眠时段 ${config.schedule.sleepStart}:00 - ${config.schedule.sleepEnd}:00）：`);
for (const h of [0, 3, 7, 8, 12, 18, 23, 1]) {
  const fake = new Date(Date.UTC(2026, 0, 1, h - config.schedule.tzOffset, 0, 0));
  const asleep = isAsleep(config.schedule, fake);
  line(`  ${String(h).padStart(2)}:00  →  ${asleep ? '睡觉中（不回）' : '醒着（会回）'}`);
}

// 6. 一次完整投递模拟
line('\n【6】一次完整回复的投递时间线：');
const reply = '行吧，那就明天再搞。我先去吃饭了，饿死了。';
const segs = segment(reply, { ...cfg, splitChance: 1 });
let t = 0;
t += cfg.replyDelayMin;
line(`  +${(t / 1000).toFixed(1)}s  开始思考`);
for (const s of segs) {
  const typing = typingDelay(s, cfg);
  const gap = rand(500, 1600);
  t += typing;
  line(`  +${(t / 1000).toFixed(1)}s  发出「${s}」`);
  t += gap;
}
line(`  → 整轮耗时约 ${(t / 1000).toFixed(1)}s（真人感的关键就在这）`);

line('\n' + '='.repeat(56));
line('自检完成。要更"像人"就调 .env 里的 HUMANIZE 参数。');