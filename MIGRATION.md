# 目录重构迁移清单

目标结构已经建好（空文件夹），下面按顺序搬，**每搬完一步都必须验证**。

## 验证口令（每次改完都跑）

```powershell
node --check 改过的文件
# 重启
taskkill /F /IM node.exe 之后重开 launcher.js
# 三条铁律
记忆条数没少
连接 = True
工具 = 51 个
```

**任何一条不对，立刻回滚（.backups 里最新那份）。**

---

## 步骤 ② 拆分工具（风险最低，先做）

```
src/tools.js  (1367 行)
   ↓ 拆成
src/tools/index.js    注册表 + runTool + TOOL_LIB
src/tools/qq.js       38 个 qq_*
src/tools/mc.js       5 个 mc_*
src/tools/mem.js      4 个 memory 类
src/tools/local.js    4 个本地能力（web_search / web_fetch / recall / correct）
```

**要点**
- 每个文件导出数组 `export const tools = [...]`
- `index.js` 合并四个数组，仍导出 `createTools(...)`
- **共享的辅助函数**（call / textSeg / resolveTarget / faceHttp）先放 `src/tools/shared.js`
- 拆完 `tools.js` 只留一行 `export * from './tools/index.js'`（保险层，出问题可秒回）

**验收**：工具 51 个，lib 分布 local 4 / mc 5 / qq 38 / memory 4

---

## 步骤 ③ 感官

```
src/senses.js    → src/senses/image.js + src/senses/audio.js
src/facemap.js   → src/senses/facemap.js
src/phash.js     → src/senses/phash.js
src/similar.js   → src/util/similar.js
```

**改 import 的地方**：index.js（动态 import）、tools.js、vecindex.js

**验收**：发一张图她还能描述；表情替换还正常

---

## 步骤 ④ 大脑

```
src/memory2.js   → src/core/memory.js
src/agent.js     → src/core/agent.js
src/attention.js → src/core/attention.js
src/vecindex.js  → src/core/vecindex.js
src/health.js    → src/core/health.js
```

**验收**：能正常回话、记忆仍在增长、体检正常

---

## 步骤 ⑤ 身体

```
src/mood.js      → src/body/mood.js
src/nap.js       → src/body/nap.js
src/autonomy.js  → src/body/autonomy.js
```

**验收**：状态页数值正常、小睡能用

---

## 步骤 ⑥ 面板（最大，最后做）

```
src/panel-page.js (1512 行)
   ↓ 拆成
src/panel/page.js      结构（HTML 模板）
src/panel/style.css    样式
src/panel/script.js    交互逻辑
src/panel/render.js    各页渲染函数
```

**验收**：六个标签页都能打开、按钮都点得动

---

## 步骤 ⑦ 主流程

```
src/index.js (968 行)
   ↓ 拆成
src/index.js          只做启动和串联
src/boot.js           初始化（记忆、人物、情绪、连接）
src/handlers.js       收消息 → 判断 → 回复
src/jobs.js           定时任务（心跳、整理、快照）
```

**最后做，因为它最容易把她弄失联。**

---

## 清理项（随手带着做）

```
□ src/brain.js        确认没人用后删除（旧版记忆，已被 memory2 取代）
□ src/memory.js       只留 tokenize，其余删（如果 memory2 不再依赖别的）
□ scripts/vec2.js     和 vec.js 重复，删一个
□ .env 里没用的键       FACE_PACK / NAPCAT_* 之类
```

---

## 原则

1. **一次只搬一组**，搬完立刻验证
2. **先建新文件，再改 import，最后删旧的**——任何一步错了都能退
3. **不追求一次完成**，宁可多跑几轮验证
4. **index.js 最后动**