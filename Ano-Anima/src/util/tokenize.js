// 中文按两字切片，纯本地，给召回做粗筛
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) tokens.add(w);
  const cn = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cn) {
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return tokens;
}
