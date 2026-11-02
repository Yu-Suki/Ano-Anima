// 把括号动作换成 QQ 官方表情（QQ 专用，只在 QQ 发消息时用）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let CATALOG = [];
try {
  CATALOG = JSON.parse(readFileSync(join(ROOT, "src", "face-catalog.json"), "utf8"));
} catch {
  CATALOG = [];
}

function byName(word) {
  const hits = CATALOG.filter((f) => f.name.includes(word));
  if (!hits.length) return null;
  hits.sort((a, b) => Number(a.id) - Number(b.id));
  return hits[0];
}

const HINTS = [
  [["略略略", "略"], "略略略"],
  [["委屈"], "委屈"],
  [["想哭", "快哭", "哭"], "大哭"],
  [["流泪"], "流泪"],
  [["害羞", "脸红"], "害羞"],
  [["得意", "骄傲", "哼哼"], "得意"],
  [["无语", "汗"], "无语"],
  [["大叫", "喊", "吼"], "抓狂"],
  [["困了", "困", "哈欠"], "困"],
  [["生气", "气死"], "生气"],
  [["偷笑", "捂嘴笑", "噗"], "偷笑"],
  [["调皮", "坏笑"], "调皮"],
  [["晚安"], "晚安"],
  [["爱心", "喜欢"], "爱心"],
  [["点赞", "厉害"], "点赞"],
  [["鼓掌", "恭喜"], "鼓掌"],
  [["笑哭", "笑死", "哈哈"], "笑哭"],
  [["难过", "失落", "不开心"], "难过"],
  [["惊讶", "吃惊"], "惊讶"],
  [["馋", "想吃"], "馋"],
  [["笑"], "呲牙"],
];

const FALLBACK = { 笑: "13", 难过: "15", 哭: "5", 害羞: "6", 得意: "4" };

export function faceOf(inner) {
  const t = String(inner || "").trim();
  // 只管括号里的"纯情绪词"：太长的一律当描述保留（"我今天特别想笑" 不换）
  if (t.length > 5) return null;
  for (const [words, official] of HINTS) {
    if (!words.some((w) => t.includes(w))) continue;
    const hit = byName(official);
    if (hit) return hit.id;
  }
  for (const [k, id] of Object.entries(FALLBACK)) {
    if (t.includes(k)) return id;
  }
  return null;
}

export function allFaces() {
  return CATALOG;
}

// 铁律：括号外面的一个字都不许动
export function splitFaces(text) {
  const s = String(text || "");
  const out = [];
  let buf = "";
  const pushText = () => {
    if (buf) out.push({ type: "text", data: { text: buf } });
    buf = "";
  };
  const re = /[（(]([^）)]{1,12})[）)]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const inner = m[1];
    const id = faceOf(inner);
    buf += s.slice(last, m.index);
    if (id != null) {
      pushText();
      out.push({ type: "face", data: { id: String(id) } });
    } else {
      buf += m[0];
    }
    last = m.index + m[0].length;
  }
  buf += s.slice(last);
  pushText();
  return out.length ? out : [{ type: "text", data: { text: s } }];
}
