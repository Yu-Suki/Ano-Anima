// 直接生成 .docx（不依赖 Word）：把 markdown 拆成段落，写成 OOXML
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 一行 markdown → 若干 OOXML 段落
function para(text, { bold = false, size = 22, mono = false, indent = 0, color = '000000' } = {}) {
  const rPr = `<w:rPr>${mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''}${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>`;
  const ind = indent ? `<w:ind w:left="${indent}"/>` : '';
  return `<w:p><w:pPr><w:spacing w:before="80" w:after="80" w:line="320" w:lineRule="auto"/>${ind}</w:pPr><w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function mdToBody(md) {
  const out = [];
  let inCode = false;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) { out.push(para(raw, { mono: true, size: 18, indent: 360 })); continue; }
    if (!line.trim()) { out.push('<w:p/>'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const sizes = { 1: 40, 2: 30, 3: 24, 4: 22 };
      out.push(para(h[2], { bold: true, size: sizes[lv] || 22 }));
      continue;
    }
    if (/^---+$/.test(line)) { out.push(para('─'.repeat(40), { size: 18, color: '999999' })); continue; }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) { out.push(para('· ' + li[1], { indent: 420 })); continue; }

    const tr = line.match(/^\|(.+)\|$/);
    if (tr) {
      const cells = tr[1].split('|').map((c) => c.trim()).filter((c) => !/^[-: ]+$/.test(c));
      if (cells.length) out.push(para(cells.join('    |    '), { size: 20, indent: 240 }));
      continue;
    }
    if (/^>\s?/.test(line)) { out.push(para(line.replace(/^>\s?/, ''), { indent: 480, color: '555555' })); continue; }

    out.push(para(line.replace(/\*\*/g, '').replace(/`/g, '')));
  }
  return out.join('');
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

const jobs = [
  ['文档-三天历程.md', 'docx-三天历程'],
  ['文档-架构与实现.md', 'docx-架构与实现'],
];

for (const [src, dir] of jobs) {
  const md = await readFile(join(ROOT, src), 'utf8');
  const target = join(ROOT, '.tmp-docx', dir);
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, '_rels'), { recursive: true });
  await mkdir(join(target, 'word', '_rels'), { recursive: true });
  await writeFile(join(target, '[Content_Types].xml'), contentTypes, 'utf8');
  await writeFile(join(target, '_rels', '.rels'), rels, 'utf8');
  await writeFile(join(target, 'word', '_rels', 'document.xml.rels'), docRels, 'utf8');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${mdToBody(md)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  await writeFile(join(target, 'word', 'document.xml'), doc, 'utf8');
  console.log('已生成 ' + dir);
}