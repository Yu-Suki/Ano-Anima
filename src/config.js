// 配置加载：全部走环境变量，.env 里改，代码不动
import 'dotenv/config';

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  onebot: {
    // LLOneBot / NapCat 的 OneBot 11 正向 WebSocket 地址
    url: process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001',
    token: process.env.ONEBOT_TOKEN || '',
    selfId: process.env.ONEBOT_SELF_ID || '',
  },

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    temperature: num(process.env.LLM_TEMPERATURE, 1.15),
    maxTokens: int(process.env.LLM_MAX_TOKENS, 220),
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 45000),
    // 调试用：不调真模型，回固定几句话，用来验证收消息→回复这条链路
    mock: bool(process.env.LLM_MOCK, false),
  },

  // 拟人化参数：这是"像人"的主战场
  human: {
    enabled: bool(process.env.HUMANIZE, true),
    charDelayMin: int(process.env.CHAR_DELAY_MIN_MS, 55),
    charDelayMax: int(process.env.CHAR_DELAY_MAX_MS, 95),
    reactionMin: int(process.env.REACTION_MIN_MS, 300),
    reactionMax: int(process.env.REACTION_MAX_MS, 900),
    replyDelayMin: int(process.env.REPLY_DELAY_MIN_MS, 1200),
    replyDelayMax: int(process.env.REPLY_DELAY_MAX_MS, 4500),
    // 偶尔"在忙"，隔很久才回
    busyChance: num(process.env.BUSY_CHANCE, 0.12),
    busyDelayMin: int(process.env.BUSY_DELAY_MIN_MS, 15000),
    busyDelayMax: int(process.env.BUSY_DELAY_MAX_MS, 60000),
    // 长消息拆成几条发
    splitChance: num(process.env.SPLIT_CHANCE, 0.55),
    maxSegments: int(process.env.MAX_SEGMENTS, 3),
    // 少于这么多字就不拆，避免拆成一堆没信息量的碎片
    minSplitChars: int(process.env.SPLIT_MIN_CHARS, 35),
    // 偶尔打错字，然后撤回改正
    typoChance: num(process.env.TYPO_CHANCE, 0.03),
    recallChance: num(process.env.RECALL_CHANCE, 0.5),
    recallDelayMin: int(process.env.RECALL_DELAY_MIN_MS, 1800),
    recallDelayMax: int(process.env.RECALL_DELAY_MAX_MS, 5200),
  },

  // 作息：深夜不回，早上有起床延迟
  schedule: {
    tzOffset: int(process.env.TZ_OFFSET_HOURS, 8),
    sleepStart: int(process.env.SLEEP_START_HOUR, 1),
    sleepEnd: int(process.env.SLEEP_END_HOUR, 8),
    wakeJitterMin: int(process.env.WAKE_JITTER_MIN, 3),
    wakeJitterMax: int(process.env.WAKE_JITTER_MAX, 35),
  },

  // 行为边界
  policy: {
    // 主人 QQ 号：只有这个号能授权破坏性操作（踢人/禁言/删好友…）
    ownerQq: (process.env.OWNER_QQ || '').trim(),
    groupAllow: list(process.env.GROUP_ALLOW), // 空 = 全部允许
    groupDeny: list(process.env.GROUP_DENY),
    groupRequireAt: bool(process.env.GROUP_REQUIRE_AT, true),
    // 不 @ 也回：按"和自己的相关性"打分，过线就回
    replyThreshold: num(process.env.GROUP_REPLY_THRESHOLD, 0.55),
    softThreshold: num(process.env.GROUP_SOFT_THRESHOLD, 0.3),
    softChance: num(process.env.GROUP_SOFT_CHANCE, 0.12),
    // 群里没被 @ 时，按这个概率主动接话（旧逻辑，作兜底）
    groupAmbientChance: num(process.env.GROUP_AMBIENT_CHANCE, 0.06),
    privateEnabled: bool(process.env.PRIVATE_ENABLED, true),
    rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 20),
    // 被直接质疑是不是机器人时，如实承认
    discloseAI: bool(process.env.DISCLOSE_AI, true),
  },

  personaFile: process.env.PERSONA_FILE || './persona.md',
  dryRun: process.argv.includes('--dry-run'),
};

export function assertUsableConfig(cfg = config) {
  const problems = [];
  if (!cfg.llm.mock && !cfg.llm.apiKey) problems.push('LLM_API_KEY 未设置（.env）');
  if (!cfg.onebot.url) problems.push('ONEBOT_WS_URL 未设置');
  return problems;
}