// 她的感官：把图片/语音变成她能理解的东西
// 只写一次，任何入口（面板 / QQ / 以后别的）都走这里
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

// 同一张图不重复识别
const cache = new Map();
const CACHE_MAX = 120;

function cacheGet(k) {
  return cache.get(k);
}
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** 有没有配视觉模型 */
export function hasVision() {
  return Boolean(process.env.VISION_API_KEY || process.env.LLM_API_KEY);
}

/** 看图：base64 → 一句描述 */
export async function describeImage(base64, hint = '', kind = 'photo') {
  const key = base64.slice(-64);
  const hit = cacheGet(key);
  if (hit) return hit;

  const apiKey = process.env.VISION_API_KEY || process.env.LLM_API_KEY || '';
  const baseUrl = process.env.VISION_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
  const model = process.env.VISION_MODEL || 'qwen-vl-plus';

  if (!apiKey) return '（收到一张图，但我暂时看不见——还没配视觉模型）';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
              (kind === 'sticker'
                ? '这是聊天里的一个表情包。只用一句短话说明它的情绪或梗（15 字以内），不要描述画面细节。'
                : '用一句中文描述这张图，40 字以内。有人的话说人物在做什么、什么表情；有文字的话把文字念出来。') +
                (hint ? `（对方说：${hint}）` : ''),
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          ],
        },
      ],
      temperature: 0.2,
    }),
  }).catch(() => null);

  if (!res || !res.ok) return '（图片发过来了，但识别失败）';
  const data = await res.json().catch(() => null);
  const text = (data?.choices?.[0]?.message?.content || '').trim().slice(0, 120);
  const out = text || '（一张看不懂的图）';
  cacheSet(key, out);
  return out;
}

/** 听语音：音频文件（silk/amr/wav）→ 文字 */
export async function transcribeAudio(buf, ext = 'silk') {
  const dir = await mkdtemp(join(tmpdir(), 'sense-'));
  const src = join(dir, `in.${ext}`);
  const wav = join(dir, 'out.wav');
  try {
    await writeFile(src, buf);
    // silk / amr / mp3 → wav（ffmpeg 在 NapCat 里自带，PATH 里也有）
    await run('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', wav], { timeout: 30000 }).catch(() => {});

    const apiKey = process.env.ASR_API_KEY || process.env.LLM_API_KEY || '';
    if (!apiKey) return '（收到一条语音，但我暂时听不见——还没配语音识别）';

    const { readFile } = await import('node:fs/promises');
    const wavBuf = await readFile(wav).catch(() => null);
    if (!wavBuf) return '（语音格式转不动）';
    return `（语音 ${Math.round(wavBuf.length / 32000)} 秒，内容还没接识别模型）`;
  } finally {
    await unlink(src).catch(() => {});
    await unlink(wav).catch(() => {});
  }
}