// 把外部 MCP Server 的工具接进她的工具表
// 配置：.data/mcp.json
// {
//   "servers": {
//     "filesystem": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","D:\\"], "enabled": true },
//     "echo": { "command": "node", "args": ["scripts/mcp-echo.js"] }
//   },
//   "maxPerServer": 40,
//   "maxTotal": 60
// }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpClient } from './client.js';

const ROOT = process.cwd();

export async function loadMcp(configPath = join(ROOT, '.data', 'mcp.json'), { log = () => {} } = {}) {
  let cfg;
  try {
    const raw = (await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '');
    cfg = JSON.parse(raw);
  } catch {
    return { clients: [], tools: [], note: '没有 mcp.json，跳过' };
  }
  const servers = cfg.servers || {};
  const maxPer = Number(cfg.maxPerServer || 40);
  const maxTotal = Number(cfg.maxTotal || 60);

  const clients = [];
  const tools = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || s.enabled === false) continue;
    const c = new McpClient({
      name,
      command: s.command,
      args: s.args || [],
      env: s.env || {},
      cwd: s.cwd || ROOT,
      timeoutMs: Number(s.timeoutMs || 20000),
    });
    c.onStderr = (s2) => log('warn', '[mcp:' + name + '] ' + String(s2).slice(0, 200));
    try {
      await c.start();
      const all = await c.listTools();
      const pick = Array.isArray(s.tools) && s.tools.length
        ? all.filter((t) => s.tools.some((p) => String(t.name) === p || String(t.name).startsWith(p)))
        : all;
      const list = pick.slice(0, maxPer);
      for (const t of list) {
        tools.push({
          name: 'mcp_' + String(t.name).replace(/[^a-zA-Z0-9_]/g, '_'),   // 名字短一点，她更容易挑中
          description: '[' + name + '] ' + (t.description || ''),
          parameters: t.inputSchema || { type: 'object', properties: {} },
          lib: 'mcp',
          platforms: Array.isArray(s.platforms) ? s.platforms : null,   // 不写 = 哪个平台都能用
          mcp: { server: name, tool: t.name },
          async run(args = {}) {
            try { return await c.callTool(t.name, args); }
            catch (e) { return { error: 'MCP 调用失败：' + e.message }; }
          },
        });
      }
      clients.push(c);
      log('ok', 'MCP 接上「' + name + '」：' + list.length + ' 个工具');
    } catch (e) {
      log('warn', 'MCP 连不上「' + name + '」：' + e.message);
      try { c.close(); } catch {}
    }
    if (tools.length >= maxTotal) break;
  }
  return { clients, tools, note: tools.length + ' 个外部工具' };
}

// 把 MCP 工具并进 createTools 的产物
export function attachMcp(registry, mcpTools) {
  if (!mcpTools?.length) return 0;
  for (const t of mcpTools) {
    if (registry.byName.has(t.name)) continue;
    registry.tools.push(t);
    registry.byName.set(t.name, t);
    if (registry.schemas) {
      registry.schemas.push({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      });
    }
    if (registry.manifest) {
      registry.manifest.push({ lib: 'mcp', name: t.name, description: t.description, destructive: false, category: '外部工具', parameters: t.parameters });
    }
  }
  return mcpTools.length;
}
