// Minecraft：她的手和脚
// 只跟本机的身体服务打交道，不碰 QQ
const mcCall = async (path, body = {}) => {
    const http = await import('node:http');
    const payload = JSON.stringify(body);
    return await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: 8790, path, method: path === '/status' ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 15000 },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ error: '身体没回话' }); } });
        },
      );
      req.on('error', () => resolve({ error: '她不在游戏里' }));
      req.on('timeout', () => { req.destroy(); resolve({ error: '身体反应太慢' }); });
      req.write(payload); req.end();
    });
  };

  const mcSay = {
    name: 'mc_say',
    description: '在 Minecraft 里说话（游戏里的聊天框，不是 QQ）',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run(args = {}) { return mcCall('/do', { action: 'say', text: args.text }); },
  };

  const mcStatus = {
    name: 'mc_status',
    description: '看看自己在游戏里什么样：位置、血、饿不饿',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() { return mcCall('/status'); },
  };

  const mcGoto = {
    name: 'mc_goto',
    description: '走到游戏里的某个坐标',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
    async run(args = {}) { return mcCall('/do', { action: 'goto', x: args.x, y: args.y, z: args.z }); },
  };

  const mcFollow = {
    name: 'mc_follow',
    description: '跟着某个人走（填游戏 ID，比如 Yu_Suki）',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(args = {}) { return mcCall('/do', { action: 'follow', name: args.name }); },
  };

  const mcMine = {
    name: 'mc_mine',
    description: '挖附近的方块（默认 oak_log，也可以填 stone 等）',
    parameters: { type: 'object', properties: { block: { type: 'string' } }, required: [] },
    async run(args = {}) { return mcCall('/do', { action: 'mine', block: args.block || 'oak_log' }); },
  };

/** 返回游戏里的那 5 个工具 */
export function mcTools() {
  return [mcSay, mcStatus, mcGoto, mcFollow, mcMine];
}
