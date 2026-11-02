// 人格包：导出 / 导入
//
// 分三堆：
//   IN  能打包的      —— 她是谁 + 她记得什么
//   OUT 不能打包的    —— 运行时产物、密钥、备份快照
//   FILL 导入后要填的 —— key、OneBot 地址、QQ 号

import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipStore, unzipStore } from './zip.js';

export const SCHEMA = 2;
export const PACK_EXT = '.ano';

// 能进包的（相对项目根）
// 包里只有"她是谁"和"她记得什么"——其余都是程序自己的事
const INCLUDE_FILES = [
  'persona.md',
  '.data/brain.json',    // 记忆
  '.data/roster.json',   // 她认识的人
];
const INCLUDE_DIRS = [];

// 绝对不能进包的
export const NEVER = [
  '.env',                      // 密钥
  '.data/vectors.json',        // 依赖 embedding 模型，导入后重建
  '.data/snapshots',           // 自动备份，体积大
  '.data/nap.json',            // 运行时状态
  '.data/watchdog.json',
  '.data/stickers.json',       // 表情库依赖 QQ 收藏夹
  '.data/sticker-meta.json',
];

// 导入后必须自己填的
export const NEEDS_FILL = [
  { key: 'LLM_API_KEY', note: '聊天用的大模型 key' },
  { key: 'EMBED_API_KEY', note: '算记忆向量用的 key（不填记忆就不能按意思检索）' },
  { key: 'VISION_API_KEY', note: '看图用的 key（可选）' },
  { key: 'ONEBOT_WS_URL', note: 'QQ 协议端地址，比如 ws://127.0.0.1:3001' },
  { key: 'ONEBOT_SELF_ID', note: '机器人自己的 QQ 号' },
  { key: 'OWNER_QQ', note: '主人的 QQ 号' },
];

export async function buildPack(root, { name = '阿糯' } = {}) {
  const entries = [];
  const now = new Date();

  for (const f of INCLUDE_FILES) {
    try { entries.push({ name: f.replace(/^\.\//, ''), data: await readFile(join(root, f)) }); } catch {}
  }
  for (const d of INCLUDE_DIRS) {
    let files = [];
    try { files = await readdir(join(root, d)); } catch { continue; }
    for (const f of files) {
      try { entries.push({ name: `${d}/${f}`, data: await readFile(join(root, d, f)) }); } catch {}
    }
  }

  const brain = entries.find((e) => e.name === '.data/brain.json');
  let counts = { memory: 0 };
  if (brain) {
    try { counts.memory = JSON.parse(brain.data.toString('utf8')).items?.length || 0; } catch {}
  }

  const manifest = {
    kind: 'ano-persona',
    schema: SCHEMA,
    name,
    createdAt: now.toISOString(),
    counts,
    needsFill: NEEDS_FILL.map((x) => x.key),
    note: '这是她的人设和记忆。导入后需要重新填 key 和 QQ 连接信息。',
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return { buffer: zipStore(entries), filename: `${name}-${stamp}${PACK_EXT}`, manifest };
}

export async function readPack(buffer) {
  const files = unzipStore(buffer);
  const mf = files.find((f) => f.name === 'manifest.json');
  if (!mf) throw new Error('不是人格包：缺少 manifest.json');
  let manifest;
  try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('manifest.json 坏了'); }
  if (manifest.kind !== 'ano-persona') throw new Error('这个包不是她（kind 不对）');
  return { manifest, files };
}

/** 把包里的文件写进去；先备份当前 .data */
export async function applyPack(root, buffer) {
  const { manifest, files } = await readPack(buffer);
  if (Number(manifest.schema) > SCHEMA) {
    throw new Error(`包是更新版本做的（schema ${manifest.schema}），当前程序只认到 ${SCHEMA}，请先升级`);
  }

  // 备份当前状态
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(root, '.data', 'snapshots', `import-${stamp}`);
  for (const f of INCLUDE_FILES) {
    try {
      await mkdir(join(backupDir, f.split('/')[0]), { recursive: true });
      await copyFile(join(root, f), join(backupDir, f));
    } catch {}
  }

  let written = 0;
  for (const f of files) {
    if (f.name === 'manifest.json') continue;
    if (!/^(persona\.md$|\.data\/)/.test(f.name)) continue;   // 只认：人设 + 记忆数据
    if (/\.\./.test(f.name)) continue;                                    // 防目录穿越
    if (NEVER.some((n) => f.name.startsWith(n))) continue;                // 黑名单
    const target = join(root, f.name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, f.data);
    written++;
  }

  return { written, schema: manifest.schema, name: manifest.name || '她', backupDir, needsFill: NEEDS_FILL };
}

export function packStatus() {
  return { schema: SCHEMA, ext: PACK_EXT, includes: INCLUDE_FILES, never: NEVER, needsFill: NEEDS_FILL };
}
