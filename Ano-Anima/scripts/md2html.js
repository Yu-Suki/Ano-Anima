// Markdown → HTML（够用的子集：标题、表格、代码块、列表、加粗、引用）
import { readFile, writeFile } from 'node:fs/promises';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

export async function mdToHtml(md, title) {
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let inTable = false;
  let listOpen = false;

  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    if (line.startsWith('```')) {
      closeList(); closeTable();
      if (inCode) { out.push('</pre>'); inCode = false; }
      else { out.push('<pre>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }

    // 表格
    if (/^\|/.test(line)) {
      const next = lines[i + 1] || '';
      if (!inTable) {
        closeList();
        out.push('<table>');
        inTable = true;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        out.push('<tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>');
        if (/^\|[\s:-]+\|/.test(next)) i += 1;
        continue;
      }
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();

    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ''))}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }

    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push('</pre>');
  closeList(); closeTable();

  const css = `
    body { font-family: "微软雅黑","Microsoft YaHei",sans-serif; font-size: 11pt; line-height: 1.75; color: #222; }
    h1 { font-size: 20pt; color: #111; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
    h2 { font-size: 15pt; margin-top: 22px; color: #1a1a1a; }
    h3 { font-size: 12.5pt; margin-top: 16px; }
    h4 { font-size: 11.5pt; }
    p { margin: 6px 0; }
    ul { margin: 6px 0 6px 18px; }
    li { margin: 2px 0; }
    code { font-family: Consolas,"Courier New",monospace; background: #f3f3f3; padding: 1px 3px; }
    pre { font-family: Consolas,"Courier New",monospace; background: #f6f8fa; border: 1px solid #e5e5e5;
          padding: 8px; font-size: 9.5pt; line-height: 1.5; white-space: pre-wrap; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 10pt; }
    th { background: #f0f0f0; border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
    td { border: 1px solid #ccc; padding: 5px 8px; }
    blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding-left: 10px; color: #555; }
    hr { border: none; border-top: 1px solid #ddd; margin: 14px 0; }
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${css}</style></head><body>${out.join('\n')}</body></html>`;
}

const files = [
  ['文档-三天历程.md', '文档-三天历程.html', '阿糯 · 三天历程'],
  ['文档-架构与实现.md', '文档-架构与实现.html', '阿糯 · 架构与实现'],
];
for (const [src, dst, title] of files) {
  const md = await readFile(src, 'utf8');
  await writeFile(dst, await mdToHtml(md, title), 'utf8');
  console.log('生成 ' + dst);
}