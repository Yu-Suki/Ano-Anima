// 网页搜索 / 抓取
// 主力走 Bing 的 HTML 页面（实测直连可用，不需要 key），DuckDuckGo 兜底
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s = '') {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripTags(html = '') {
  const noScript = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  return decode(noScript.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

async function bing(query, count) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${count}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const html = await res.text();

  const out = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const a = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({
      title: stripTags(a[2]).slice(0, 100),
      url: a[1],
      snippet: p ? stripTags(p[1]).slice(0, 220) : '',
    });
    if (out.length >= count) break;
  }
  return out;
}

async function duckduckgo(query, count) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`DDG ${res.status}`);
  const html = await res.text();

  const out = [];
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let href = m[1];
    const u = /uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    out.push({ title: stripTags(m[2]).slice(0, 100), url: href, snippet: '' });
    if (out.length >= count) break;
  }
  return out;
}

/** 搜索，返回 { source, results:[{title,url,snippet}] } */
export async function webSearch(query, { count = 5, timeoutMs = 15000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { source: 'none', results: [], error: '空查询' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const errors = [];
    for (const [name, fn] of [['bing', bing], ['duckduckgo', duckduckgo]]) {
      try {
        const results = await fn(q, count);
        if (results.length) return { source: name, results };
        errors.push(`${name}: 无结果`);
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    return { source: 'none', results: [], error: errors.join('; ') };
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取网页正文（粗提取，够模型读懂） */
export async function fetchUrl(url, { maxChars = 4000, timeoutMs = 15000 } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { error: '只支持 http/https 链接' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, url: target };

    const type = res.headers.get('content-type') || '';
    const raw = await res.text();

    if (!/html|xml|text/i.test(type)) {
      return { url: target, type, text: raw.slice(0, maxChars) };
    }

    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    return {
      url: target,
      status: res.status,
      title: title ? stripTags(title[1]).slice(0, 120) : '',
      text: stripTags(raw).slice(0, maxChars),
    };
  } catch (err) {
    return { error: err.message, url: target };
  } finally {
    clearTimeout(timer);
  }
}

/** 把搜索结果压成给模型看的一段 */
export function formatResults({ source, results, error }) {
  if (!results?.length) return `没搜到结果。${error ? `（${error}）` : ''}`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet || ''}\n   ${r.url}`);
  return `来源：${source}\n${lines.join('\n')}`;
}