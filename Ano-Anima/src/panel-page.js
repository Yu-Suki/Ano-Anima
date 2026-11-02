// 面板：样式和交互分别放在 src/panel 下，这里只负责拼起来
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('./panel/style.css', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('./panel/script.js', import.meta.url), 'utf8');

// 控制台页面：完全由后端元数据驱动
// 设置项来自 /api/settings（settings-meta.js），能力来自 /api/tools（tools.js）
// 新增功能只要在那边加一条，页面自动出现，不用改这里
export const PANEL_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 控制台</title>
<style>
${CSS}
</style>
</head>
<body>
  <div id="setupBanner" style="display:none;margin:10px 14px;padding:10px 12px;border-radius:10px;
       background:#3a2a12;border:1px solid #6b4a1a;color:#f0c98a;font-size:13px;line-height:1.7"></div>
<header>
  <span class="dot" id="dot"></span>
  <h1>大肥鱼 · 控制台</h1>
  <span class="muted" id="hdrinfo">连接中…</span>
</header>

<nav>
  <button data-tab="overview" class="active">概览</button>
  <button data-tab="chat">对话</button>
  <button data-tab="memory">记忆</button>
  <button data-tab="persona">人设</button>
  <button data-tab="mood">状态</button>
  <button data-tab="tools">能力</button>
  <button data-tab="voice">语音</button>
  <button data-tab="connect">接入</button>
  <button data-tab="settings">设置</button>
  <button data-tab="logs">日志</button>
</nav>

<main>
  <section id="tab-overview" class="active">
      <div class="card" id="starmapwrap">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0">记忆星图</h3>
          <button class="act shrink" onclick="toggleStarFullscreen()">全屏</button>
        </div>
        <div class="muted" style="font-size:12px;margin-bottom:8px">每个点是一条记忆，离得近说明意思相近；点越大越重要</div>
        <canvas id="starmap" width="640" height="420" style="width:100%;height:auto;background:#0d1117;border-radius:8px"></canvas>
        <div class="muted" id="starmapinfo" style="font-size:12px;margin-top:6px"></div>
      </div>
    <div class="card">
      <div class="row">
        <div class="shrink" style="width:200px"><div class="k">机器人进程</div><div class="v" id="procline">—</div><div class="muted" id="pendinghint" style="font-size:11.5px"></div></div>
        <button class="act primary shrink" onclick="ctrl('start')">启动</button>
        <button class="act shrink" onclick="ctrl('stop')">停止</button>
        <button class="act shrink" onclick="ctrl('restart')">重启</button>
      <span class="muted shrink" id="lastctrl" style="font-size:12px"></span>
      </div>
      <div class="row" style="margin-top:10px;border-top:1px solid #2a2f38;padding-top:10px">
        <label class="shrink" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="autoOn" onchange="setAutonomy(this.checked)" style="width:16px"> QQ 自主行为
        </label>
        <span class="muted" id="autohint">—</span>
      </div>
    </div>
    <div class="card grid" id="stats"></div>
    <div class="card">
      <div class="k">当前状态</div>
      <div id="moodline" class="muted" style="margin-top:6px">—</div>
      <div id="layers" class="muted" style="margin-top:6px">—</div>
    </div>
  </section>

  <section id="tab-chat">
    <div class="card">
      <div class="k">本地面谈 · 不经过 QQ（账号离线时也能说话）</div>
      <div class="muted" style="margin:4px 0 8px">用同一份记忆、同一个情绪、同一个人设，只把"身体"摘掉。她不会真的发到 QQ 上。</div>
      <div class="row">
        <input id="localtext" placeholder="跟她说句话…" onkeydown="if(event.key==='Enter')doLocalChat()">
        <button class="act shrink" onclick="document.getElementById('localimg').click()" title="给她看张图">图片</button>
        <input type="file" id="localimg" accept="image/*" style="display:none" onchange="sendImageTo(this)">
        <button class="act shrink" onclick="document.getElementById('localvoice').click()" title="让她听段语音">语音</button>
        <input type="file" id="localvoice" accept="audio/*" style="display:none" onchange="sendVoiceTo(this)">
        <button class="act primary shrink" onclick="doLocalChat()">说</button>
      </div>
      <div id="localreplies" style="max-height:320px;overflow:auto"></div>
    </div>
    <div class="card">
      <div class="row">
        <select id="sendtarget" class="shrink" style="width:190px"><option value="">选会话…</option></select>
        <input id="sendtext" placeholder="以机器人身份发一条…">
        <button class="act primary shrink" onclick="doSend()">发送</button>
      </div>
      <div id="chatlist" style="max-height:520px;overflow:auto"></div>
    </div>
  </section>

  <section id="tab-memory">
    <div class="card" style="padding:10px 12px">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="act mini memtab on" data-mtab="surface" onclick="memTab('surface')">表层记忆</button>
        <button class="act mini memtab" data-mtab="merged" onclick="memTab('merged')">整合记忆</button>
        <button class="act mini memtab" data-mtab="core" onclick="memTab('core')">核心记忆</button>
        <span class="muted" id="memcount" style="margin-left:auto;font-size:11.5px">—</span>
      </div>
    </div>

    <!-- ① 整合记忆 -->
    <div id="memPaneMerged">
      <div class="card" style="padding:10px 12px">
        <div class="row" style="gap:8px">
          <button class="act mini on" id="mergedLevel1" onclick="mergedLevel(1)">第一层整合</button>
          <button class="act mini" id="mergedLevel2" onclick="mergedLevel(2)">第二层整合</button>
          <span class="muted" id="mergedCount" style="margin-left:auto;font-size:11.5px">—</span>
        </div>
      </div>
      <div class="card">
        <h3>今天的记忆 —— 按时间倒序，跨所有板块</h3>
        <div id="todayList"></div>
      </div>
      <div class="card">
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <select id="epiRange" class="shrink" style="width:110px" onchange="renderEpi()">
            <option value="1">今天</option>
            <option value="2">昨天到现在</option>
            <option value="7" selected>最近七天</option>
            <option value="0">全部</option>
          </select>
          <select id="epiWho" class="shrink" style="width:130px" onchange="renderEpi()">
            <option value="">所有人</option>
          </select>
          <span class="muted" style="font-size:11.5px">重要的才展开细节，普通的就一行</span>
        </div>
        <div id="epiList"></div>
      </div>
      <div class="card">
        <h3>记忆寿命怎么算</h3>
        <div class="muted" style="font-size:12.5px;line-height:1.85">
          寿命由<strong>分数</strong>决定：1 分约 10 分钟，6 分约 3 天，10 分约 1 年，核心记忆永不衰减。<br>
          保持率低于 <strong>0.03</strong>（表层）或 <strong>0.02</strong>（整合）就删除。<br>
          这些规则写在代码里，不在这里调。
        </div>
      </div>
      </div>
    </div>

    <!-- ② 表层记忆与人格 -->
    <div id="memPaneSurface" style="display:none">
      <div class="card">
        <div class="row">
          <input id="memtext" placeholder="要记住的事，例如：主人养了只猫叫小白">
          <input id="memsub" class="shrink" style="width:140px" placeholder="关于谁(可空)">
          <select id="memimp" class="shrink" style="width:90px">
            <option value="1">次要</option><option value="3" selected>一般</option><option value="5">重要</option>
          </select>
          <button class="act primary shrink" onclick="doAddMem()">记住</button>
        </div>
        <div id="semList" style="margin-top:12px"></div>
        <div class="row" style="margin-top:10px;border-top:1px solid #232730;padding-top:10px">
          <span class="muted shrink" id="dedupehint">同一件事换个说法会存成两条，可以合并</span>
          <button class="act shrink" onclick="doDedupe(true)">预览重复</button>
          <button class="act shrink" onclick="doDedupe(false)">合并重复</button>
        </div>
        <pre id="deduperesult" class="muted" style="white-space:pre-wrap;font-size:11.5px;max-height:220px;overflow:auto"></pre>
      </div>
      <div class="card">
        <h3>她自己</h3>
        <div id="selfCard"></div>
        <h3 style="margin-top:18px">她认识的人</h3>
        <div class="row" style="margin-bottom:8px">
          <button class="act mini shrink" onclick="syncRoster()">从 QQ 同步昵称</button>
          <span class="muted shrink" id="rostersync" style="font-size:11.5px"></span>
        </div>
        <div id="rosterList"></div>
      </div>
      <div class="card">
        <h3>记忆寿命怎么算</h3>
        <div class="muted" style="font-size:12.5px;line-height:1.85">
          寿命由<strong>分数</strong>决定：1 分约 1 小时，6 分约 6 天，10 分约 1 年，核心记忆永不衰减。<br>
          时间到就删除；分数会随剩余时间一档一档往下掉。
          这些规则写在代码里，不在这里调。
        </div>
      </div>
    </div>

    <!-- ③ 表层记忆（工作记忆已移除） -->
    <div id="memPaneLegacy" style="display:none"></div>

          <div class="card">
        <h3>人格包</h3>
        <div class="muted" style="font-size:12px;line-height:1.8;margin-bottom:10px">
          一个文件装下「她是谁」和「她记得什么」：人设、记忆、人物表。<br>
          这里不包含程序本身，也不包含 key —— 换机器后重新填一次就行。
        </div>
        <div class="row">
          <button class="act primary shrink" onclick="exportPersona()">导出人格</button>
          <button class="act shrink" onclick="pickPersonaFile()">导入人格</button>
          <span class="muted" id="packHint" style="font-size:11.5px"></span>
        </div>
        <input type="file" id="packFile" accept=".ano,.zip" style="display:none" onchange="importPersona(this)">
      </div>

<!-- ④ 核心 -->
    <div id="memPaneCore" style="display:none">
      <div class="card">
        <h3>核心记忆 —— 永不衰减、永不删除</h3>
        <div class="muted" style="font-size:11.5px;margin-bottom:10px">
          从其他板块挪进来的。退回就会回到原来的层，重新开始遗忘。上限 50 条。
        </div>
        <div id="coreList"></div>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <div class="shrink muted" id="snapinfo">—</div>
        <button class="act primary shrink" onclick="doSnap()">立即存档</button>
      </div>
      <div class="muted" style="margin-bottom:10px">
        每隔一段时间自动存档。恢复前会先给当前状态存一份，改错了还能退回来。
      </div>
      <div id="snaplist"></div>
      <pre id="snapdiff" class="muted" style="white-space:pre-wrap;font-size:11.5px;max-height:300px;overflow:auto"></pre>
    </div>
  </section>

  <section id="tab-persona">
    <div class="card">
      <div class="k" style="margin-bottom:8px">persona.md —— 保存立即生效，不用重启</div>
      <textarea id="persona" style="min-height:440px"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="act primary shrink" onclick="doSavePersona()">保存人设</button>
        <span class="muted shrink" id="personahint"></span>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="k" style="margin-bottom:6px">提示词文件 · prompts/ 下的每一项都能改，保存立即生效</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">平台类（qq / mc）按场景加载；一次性类（reincarnate）只在需要时手动触发。</div>
      <div id="promptFiles"></div>
    </div>
    </div>
  </section>

  <section id="tab-mood">
    <div class="card" id="napCard" style="display:none">
      <div class="row">
        <span id="napInfo" class="muted">她在睡觉</span>
        <button class="act primary shrink" onclick="wakeHer()">叫醒她</button>
      </div>
    </div>
    <div class="card">
      <h3>当前状态</h3>
      <div class="bars">
        <div class="bar">
          <div class="k">心情（-100 烦躁 ~ 100 开心）</div>
          <div class="track"><div class="fill" id="vfill" style="background:#e5534b"></div></div>
          <input type="range" id="valence" min="-100" max="100" value="0" oninput="paintMood()">
        </div>
        <div class="bar">
          <div class="k">精力（0 累 ~ 100 精神）</div>
          <div class="track"><div class="fill" id="efill" style="background:#3fb950"></div></div>
          <input type="range" id="energy" min="0" max="100" value="65" oninput="paintMood()">
        </div>
        <div class="bar">
          <div class="k">活力（今天还能折腾多少）</div>
          <div class="track"><div class="fill" id="vitalityfill" style="background:#4a9eff"></div></div>
          <input type="range" id="vitalitySlider" min="0" max="100" value="100" oninput="paintMood()">
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="act primary shrink" onclick="doSaveMood()">应用</button>
        <span class="muted shrink" id="moodhint"></span>
      </div>
      <div class="muted" id="moodrules" style="margin-top:10px;border-top:1px solid #232730;padding-top:8px">—</div>
    </div>

    <div class="card">
      <h3>内在需求 —— 哪条攒满 100，就由它决定做什么</h3>
      <div id="drivesEdit"></div>
      <div class="row" style="margin-top:10px">
        <button class="act primary shrink" onclick="doSaveDrives()">保存</button>
        <span class="muted" id="drivehint"></span>
      </div>
    </div>

    <div class="card">
      <h3>自然恢复 —— 改完立即生效</h3>
      <div id="recoverSettings"></div>
      <div class="row" style="margin-top:10px">
        <button class="act primary shrink" onclick="saveSettingsFrom('recoverSettings','recoverhint')">保存</button>
        <span class="muted" id="recoverhint"></span>
      </div>
    </div>

    <div class="card">
      <h3>消耗 —— 聊天和查资料不扣活力</h3>
      <div id="costSettings"></div>
      <div class="row" style="margin-top:10px">
        <button class="act primary shrink" onclick="saveSettingsFrom('costSettings','costhint')">保存</button>
        <span class="muted" id="costhint"></span>
      </div>
    </div>

    <div class="card">
      <div class="k">最近的情绪波动</div>
      <div id="moodrecent" class="muted" style="margin-top:6px">—</div>
    </div>
  </section>

  <section id="tab-tools">
    <div class="card">
      <div class="row">
        <div class="shrink muted" id="toolcount">—</div>
        <input id="toolfilter" placeholder="过滤工具名…" oninput="renderTools()">
      </div>
      <div class="muted" style="margin-bottom:10px">点一行展开，可以手动调一次看返回。破坏性操作要自己填 confirm:true。</div>
      <div id="toollist"></div>
    </div>
  </section>

  <section id="tab-voice">
    <div class="card">
      <h3>选一个声音</h3>
      <div class="row">
        <input id="vgroup" placeholder="群号，例如 619837801">
        <button class="act primary shrink" onclick="loadVoices()">加载声音列表</button>
      </div>
      <div id="voicelist" class="muted">还没加载。填群号后点上面按钮。</div>
    </div>
    <div class="card">
      <h3>试一句</h3>
      <div class="row">
        <input id="vtext" placeholder="要说的话，例如：我回来啦" value="我回来啦">
        <button class="act shrink" onclick="sendVoiceTest()">发到群里</button>
      </div>
      <div class="muted" id="vcur">当前选中：—</div>
    </div>
  </section>

  <section id="tab-connect">
    <div class="card">
      <div class="row">
        <div class="shrink muted" id="connectsummary">点「刷新」查看当前状态（不会自动探测）</div>
        <button class="act primary shrink" onclick="loadConnect(true)">刷新检测</button>
      </div>
      <div class="muted" style="margin-top:6px">掉线时这里只显示状态，不会自己重连——自动重登每次都触发风控验证，越弄越糟。</div>
    </div>
    <div id="loginHint" class="card" style="display:none;border-color:#5a2828;background:#241a1a;color:#ffb3b3"></div>
    <div id="connectlist"></div>
  </section>

  <section id="tab-settings">
    <div class="card">
      <div class="row">
        <label class="shrink" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="showAll" onchange="loadSettings()" style="width:16px"> 显示不常用的项
        </label>
        <input id="setfilter" placeholder="搜索：群聊 / 延迟 / COST…" oninput="loadSettings()" style="max-width:260px">
        <span class="muted shrink" id="savehint"></span>
        <button class="act primary shrink" onclick="saveSettingsFrom('settingsbox','savehint')">保存</button>
      </div>
      <div class="muted">标了「热更新」的改完立刻生效，其余需要重启机器人。情绪和精力相关的不在这里，在「心情」页。</div>
    </div>
    <div id="settingsbox"></div>
  </section>

  <section id="tab-logs">
    <div class="card"><div id="logbox"></div></div>
  </section>
</main>

<div class="toast" id="toast"></div>

<script>
${SCRIPT}
</script>
</body>
</html>`;