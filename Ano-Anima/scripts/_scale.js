import { readFile, writeFile } from 'node:fs/promises';
const p = 'src/panel/script.js';
let c = (await readFile(p, 'utf8')).split('\n');

// ---------- 1) 框跟着镜头缩放：整体按 tq.k 缩放 ----------
{
  const s = c.findIndex((l) => l.includes('function drawCallout()'));
  if (s < 0) throw new Error('找不到 drawCallout');
  // 在函数体开头插入缩放系数
  c.splice(s + 1, 0, '  var SC = Math.max(0.75, Math.min(2.2, (tq && tq.k ? tq.k : 1) * 0.95));');
  // 但 tq 在下一行才定义 → 把系数改成在 tq 定义之后
  c.splice(s + 1, 1);
}

const idxTq = c.findIndex((l) => l.includes('var target = null, tq = null;'));
if (idxTq < 0) throw new Error('找不到 tq 定义');
c.splice(idxTq, 0, '  var SC = 1;   // 缩放系数：跟着星星远近变');

// 在算出 tq 之后设置 SC
const idxIf = c.findIndex((l, k) => k > idxTq && l.includes('if (target && tq && tq.k > 0.05) {'));
if (idxIf >= 0) c.splice(idxIf + 1, 0, '    SC = Math.max(0.8, Math.min(2.4, tq.k * 0.95));   // 近了框变大，远了变小');

// 让字号、内边距、行高、圆角都乘 SC
const subs = [
  ['g.font = "300 13px', 'g.font = "300 " + (13 * SC).toFixed(1) + "px'],
  ['g.font = "300 10px', 'g.font = "300 " + (10 * SC).toFixed(1) + "px'],
  ['var padx = 14, pady = 10, lineH = 18;', 'var padx = 14 * SC, pady = 10 * SC, lineH = 18 * SC;'],
  ['var maxW = Math.min(W - 40, 300);', 'var maxW = Math.min(W - 40, 300 * SC);'],
  ['var bh = lines.length * lineH + pady * 2 + 16;', 'var bh = lines.length * lineH + pady * 2 + 16 * SC;'],
  ['var by = tq.sy - 46 - bh;', 'var by = tq.sy - (46 * SC) - bh;'],
  ['if (g.roundRect) g.roundRect(bx, by, bw, bh, 10); else g.rect(bx, by, bw, bh);', 'if (g.roundRect) g.roundRect(bx, by, bw, bh, 10 * SC); else g.rect(bx, by, bw, bh);'],
  ['g.fillText(extra, bx + padx, by + bh - pady - 10);', 'g.fillText(extra, bx + padx, by + bh - pady - (10 * SC));'],
];
for (const [a, b] of subs) {
  for (let i = 0; i < c.length; i++) if (c[i].includes(a)) c[i] = c[i].replace(a, b);
}

// ---------- 2) 框跟着"它那颗星"的深度画：画完那颗星马上画框 ----------
{
  // 删掉旧的插入逻辑
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i].includes('if (!calloutDrawn && selZ != null')) c.splice(i, 1);
    else if (c[i].includes('var selZ = null;')) c.splice(i, 1);
    else if (c[i].includes('} else if') ) break;
  }
  // 删除 selZ 计算块
  const s2 = c.findIndex((l) => l.includes('if (starState.selectedId) {'));
  if (s2 >= 0) {
    const block = c.slice(s2, s2 + 5).join('\n');
    if (block.includes('selZ')) {
      let e2 = s2;
      while (e2 < c.length && !(c[e2].trim() === '}' && c[e2 - 1].includes('}'))) e2++;
      c.splice(s2, 6);
    }
  }
  // 循环里：画完选中的那颗星就画框
  const li = c.findIndex((l) => l.includes('order.forEach(function (o, idx) {'));
  const target = c.findIndex((l, k) => k > li && l.includes('g.globalAlpha = Math.max(0.8, Math.min(1, twinkle));'));
  if (target > 0) {
    c.splice(target, 0, '    var isSel = starState.selectedId && o.p.id === starState.selectedId;');
  }
}

await writeFile(p, c.join('\n'), 'utf8');
console.log('SC 缩放: ' + c.join('\n').includes('SC = Math.max(0.8'));
console.log('selZ 已清: ' + !c.join('\n').includes('selZ'));