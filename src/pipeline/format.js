// 消息段的小工具：判断这段是什么
export function kindOf(seg) {
  const d = seg?.data || {};
  const sub = Number(d.sub_type ?? d.subType ?? 0);
  if (sub === 1) return 'sticker';                       // OneBot: 1 = 表情
  if (/\[动画表情\]|\[表情\]/.test(String(d.summary || ''))) return 'sticker';
  if (/emoji|sticker|face|mface/i.test(String(d.file || d.url || ''))) return 'sticker';
  const size = Number(d.file_size || d.size || 0);
  if (size > 0 && size < 120 * 1024) return 'sticker';   // 小于 120KB 多半是表情
  return 'photo';
}

// 她收藏夹里都有什么（md5 列表）
