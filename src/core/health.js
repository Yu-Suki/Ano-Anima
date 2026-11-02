// 启动健康检查：每次起来先体检一遍，有问题早发现
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function exists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回 { ok, issues[], info }
 * issues 每条形如 { level: 'error'|'warn', msg }
 */
export async function healthCheck({ memory, vecindex = null, connected = false } = {}) {
  const issues = [];
  const info = {};

  // 1) 记忆库
  if (!memory) {
    issues.push({ level: 'error', msg: '记忆没加载' });
  } else {
    const all = memory.all ? memory.all() : [];
    info.memories = all.length;
    const noText = all.filter((m) => !m.text || !String(m.text).trim()).length;
    if (noText) issues.push({ level: 'error', msg: `${noText} 条记忆没有正文` });
    const noLayer = all.filter((m) => !m.layer).length;
    if (noLayer) issues.push({ level: 'warn', msg: `${noLayer} 条记忆没有分层（会被当成普通记忆）` });
    const badWeight = all.filter((m) => !(m.weight >= 0.5 && m.weight <= 10)).length;
    if (badWeight) issues.push({ level: 'warn', msg: `${badWeight} 条记忆权重越界` });
    const core = all.filter((m) => m.layer === 'core').length;
    info.core = core;
    if (core > 30) issues.push({ level: 'warn', msg: `核心记忆 ${core} 条，偏多（永不遗忘的东西太多）` });
  }

  // 2) 人物表
  if (await exists(join(ROOT, '.data', 'roster.json'))) {
    try {
      const r = JSON.parse(await readFile(join(ROOT, '.data', 'roster.json'), 'utf8'));
      info.people = Object.keys(r.people || {}).length;
      const self = Object.values(r.people || {}).find((p) => p.isSelf);
      if (!self) issues.push({ level: 'warn', msg: '人物表里没有她自己' });
      else if (!self.title) issues.push({ level: 'warn', msg: '她没有称呼' });
    } catch {
      issues.push({ level: 'error', msg: 'roster.json 读不出来（可能写坏了）' });
    }
  } else {
    issues.push({ level: 'warn', msg: '没有人物表，她还不认识人' });
  }

  // 3) 向量索引
  if (vecindex) {
    info.vectors = vecindex.items?.length || 0;
    if (!vecindex.ok) issues.push({ level: 'warn', msg: '向量索引没建好（会退回关键词召回）' });
    else if (info.memories && info.vectors < info.memories * 0.8) {
      issues.push({
        level: 'warn',
        msg: `索引只覆盖 ${info.vectors}/${info.memories} 条，部分记忆搜不到`,
      });
    }
  }

  // 4) 连接
  if (!connected) issues.push({ level: 'warn', msg: '还没连上聊天平台（等登录）' });

  return { ok: issues.filter((i) => i.level === 'error').length === 0, issues, info };
}

/** 把体检结果排成一行行字，方便打日志 */
export function formatHealth(result) {
  const lines = [];
  const { issues = [], info = {} } = result || {};
  const parts = [];
  if (info.memories != null) parts.push(`记忆 ${info.memories}`);
  if (info.core != null) parts.push(`核心 ${info.core}`);
  if (info.people != null) parts.push(`人物 ${info.people}`);
  if (info.vectors != null) parts.push(`向量 ${info.vectors}`);
  lines.push(parts.join(' · '));
  for (const i of issues) lines.push(`${i.level === 'error' ? '✗' : '!'} ${i.msg}`);
  return lines;
}