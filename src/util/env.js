// 公共小工具：统一读环境变量，只有一个实现
// 之前 autonomy / memory2 / mood 各写了一份，改一处忘两处

export function envNum(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function envBool(key, fallback = false) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}