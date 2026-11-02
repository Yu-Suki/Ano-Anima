var S = { tools: [], voices: [], voicePick: '', snaps: [] };

function toast(m) {
  var t = document.getElementById('toast');
  t.textContent = m; t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 1800);
}
function api(p, o) {
  return fetch(p, o).then(function (r) { return r.json(); }).catch(function (e) {
    // 后台还没起来 / 刚重启时会发生，安静地返回空对象，别把 Failed to fetch 甩到界面上
    console.warn('请求失败：' + p, e && e.message);
    return { error: 'offline' };
  });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}
function uptime(sec) {
  var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h + ' 小时 ' + m + ' 分';
}

document.querySelectorAll('nav button').forEach(function(b){
  b.onclick = function(){
    document.querySelectorAll('nav button').forEach(function(x){ x.classList.remove('active'); });
    document.querySelectorAll('section').forEach(function(x){ x.classList.remove('active'); });
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    var t = b.dataset.tab;
    if (t === 'overview') drawStarMap();
    if (t === 'logs') loadLogs();
    if (t === 'persona') { loadPersona(); loadAllPrompts(); }
    if (t === 'settings') loadSettings();
    if (t === 'memory') { loadMemory(); loadRoster(); loadSnaps(); }
    if (t === 'mood') { loadMood(); loadStatusSettings(); loadNap(); }
    if (t === 'tools') loadTools();
    if (t === 'voice') prefillVoiceGroup();
    if (t === 'connect') loadConnect(false);
  };
});

// ---------------- 概览 ----------------
function ctrl(action) {
  if (action === 'stop' && !confirm('确定停止机器人？')) return;
  var pl = document.getElementById('procline');
  var btns = document.querySelectorAll('#tab-overview button');
  var label = { start: '启动中…（约 15 秒）', stop: '停止中…', restart: '重启中…（约 15 秒）' }[action] || '处理中…';
  if (pl) { pl.textContent = label; pl.style.color = '#d29922'; }
  btns.forEach(function(b){ b.disabled = true; b.style.opacity = '0.5'; });
  api('/api/control', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: action }) })
    .then(function(r){
      toast(r.msg || (r.ok ? '已' + (action === 'restart' ? '重启' : action === 'start' ? '启动' : '停止') : '失败'));
      var last = document.getElementById('lastctrl');
      if (last) last.textContent = '最后操作：' + new Date().toLocaleTimeString('zh-CN') + ' ' + (r.ok ? '成功' : '失败');
      setTimeout(loadState, 3000);
      setTimeout(loadState, 8000);
      setTimeout(function(){
        btns.forEach(function(b){ b.disabled = false; b.style.opacity = ''; });
        loadState();
      }, 12000);
    })
    .catch(function(){ toast('请求失败'); btns.forEach(function(b){ b.disabled = false; b.style.opacity = ''; }); });
}
function setAutonomy(on) {
  api('/api/autonomy', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: on }) })
    .then(function(r){ if (r.error) toast(r.error); else { toast(on ? '自主行为已开启' : '已关闭'); loadState(); } });
}
function loadState() {
  api('/api/state').then(function(d){
    if (d.error) return;
    var pl = document.getElementById('procline');
    if (d.running === false || d.offline === true) {
      pl.textContent = d.starting ? '启动中…' : '已停止'; pl.style.color = '#e5534b';
    } else {
      pl.textContent = '运行中 · pid ' + d.pid; pl.style.color = '#3fb950';
    }
    document.getElementById('dot').className = 'dot' + (d.connected ? ' on' : '');
    var pd = document.getElementById('pendinghint');
    if (pd) {
      if (d.sleep && d.pendingCount) { pd.textContent = '睡着中 · 攒了 ' + d.pendingCount + ' 条，醒来会看'; pd.style.color = '#d29922'; }
      else if (d.sleep) { pd.textContent = '睡着中'; pd.style.color = '#d29922'; }
      else { pd.textContent = ''; }
    }
    document.getElementById('hdrinfo').textContent =
      (d.account || '-') + ' · ' + (d.connected ? '在线' : '离线') + ' · ' +
      (d.llmMode === 'mock' ? '模拟大脑' : (d.llmModel || '-'));

    var stats = [
      ['运行时长', uptime(d.uptimeSec)],
      ['收到消息', d.stats.received],
      ['发出消息', d.stats.sent],
      ['工具调用', d.stats.toolCalls],
      ['记忆条数', d.memory.total]
    ];
    document.getElementById('stats').innerHTML = stats.map(function(s){
      return '<div><div class="k">' + s[0] + '</div><div class="v">' + s[1] + '</div></div>';
    }).join('');

    document.getElementById('moodline').textContent = (d.mood.describe || '').replace(/\n/g, ' ');
    var names = { surface: '表层', merged: '整合', core: '核心' };
    var bl = (d.memory && d.memory.byLayer) || {};
    document.getElementById('layers').textContent = Object.keys(names).map(function(k){
      return names[k] + ' ' + (bl[k] || 0);
    }).join('   ') + '   共 ' + d.memory.total + ' 条';

    var a = d.autonomy;
    if (a) {
      document.getElementById('autoOn').checked = a.enabled;
      document.getElementById('autohint').textContent = a.enabled
        ? ('今天动了 ' + a.todayCount + ' 次 · 活力 ' + a.vitality + '/' + a.vitalityMax +
           (a.etaMinutes != null ? ' · 最快 ' + a.etaMinutes + ' 分钟后憋不住' : '') + '（详细在「状态」页）')
        : '关着（闲下来不会自己动）';
    }
    loadChat();
  });
}

// ---------------- 对话 ----------------
function loadChat() {
  api('/api/messages?limit=200').then(function(msgs){
    var seen = {}, opts = [];
    msgs.forEach(function(m){ if (m.scope && !seen[m.scope]) { seen[m.scope] = 1; opts.push(m); } });
    var sel = document.getElementById('sendtarget');
    var cur = sel.value;
    sel.innerHTML = '<option value="">选会话…</option>' + opts.map(function(o){
      return '<option value="' + o.scope + '">' + esc(o.scopeName) + '</option>';
    }).join('');
    sel.value = cur;
    document.getElementById('chatlist').innerHTML = msgs.slice(-80).reverse().map(function(m){
      return '<div class="msg ' + (m.dir === 'out' ? 'out' : 'in') + '">' +
        '<div class="meta">' + (function(){ var t = m.createdAt || m.at || m.time || 0; return t ? new Date(t).toLocaleTimeString() : ''; })() + ' · ' + esc(m.scopeName) + ' · ' + esc(m.from) + '</div>' +
        esc(m.text) + '</div>';
    }).join('');
  });
}
function doSend() {
  var scope = document.getElementById('sendtarget').value;
  var text = document.getElementById('sendtext').value.trim();
  if (!scope) return toast('先选会话');
  if (!text) return toast('内容为空');
  var p = scope.split(':');
  api('/api/send', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ targetKind: p[0], targetId: p[1], text: text }) })
    .then(function(r){ if (r.error) toast(r.error); else { toast('已发送'); document.getElementById('sendtext').value = ''; loadState(); } });
}

// 本地面谈
// ---------------- 感官：给她看图 / 听语音 ----------------
function readAsDataURL(file, cb) {
  var r = new FileReader();
  r.onload = function () { cb(r.result); };
  r.readAsDataURL(file);
}

function sendImageTo(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var box = document.getElementById('chatbox');
  if (box) { box.innerHTML += '<div class="msg out"><div class="meta">你</div>[图片] ' + esc(f.name) + '</div>'; box.scrollTop = box.scrollHeight; }
  readAsDataURL(f, function (data) {
    api('/api/sense/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data }) })
      .then(function (r) {
        if (box) { box.innerHTML += '<div class="msg in"><div class="meta">她 · 看到了</div>' + esc(r.text) + '</div>'; box.scrollTop = box.scrollHeight; }
        api('/api/local-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '（我刚给你发了张图，你看到的是：' + r.text + '）' }) })
          .then(function (c) {
            (c.texts || []).forEach(function (t) {
              if (box) { box.innerHTML += '<div class="msg in"><div class="meta">她</div>' + esc(t) + '</div>'; }
            });
            if (box) box.scrollTop = box.scrollHeight;
          });
      })
      .catch(function () { toast('图片没传上去'); });
  });
  input.value = '';
}

function sendVoiceTo(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var box = document.getElementById('chatbox');
  if (box) { box.innerHTML += '<div class="msg out"><div class="meta">你</div>[语音] ' + esc(f.name) + '</div>'; box.scrollTop = box.scrollHeight; }
  readAsDataURL(f, function (data) {
    var ext = (f.name.split('.').pop() || 'mp3').toLowerCase();
    api('/api/sense/audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data, ext: ext }) })
      .then(function (r) {
        if (box) { box.innerHTML += '<div class="msg in"><div class="meta">她 · 听到了</div>' + esc(r.text) + '</div>'; box.scrollTop = box.scrollHeight; }
      })
      .catch(function () { toast('语音没传上去'); });
  });
  input.value = '';
}

function doLocalChat() {
  var el = document.getElementById('localtext');
  var text = el.value.trim();
  if (!text) return toast('说点什么');
  el.value = '';
  var box = document.getElementById('localreplies');
  box.innerHTML += '<div class="msg out"><div class="meta">你</div>' + esc(text) + '</div>';
  box.innerHTML += '<div class="msg in" id="localpending"><div class="meta">她</div>正在想…</div>';
  box.scrollTop = box.scrollHeight;
  // 加个超时：后台卡住时不要一直转圈
  var ac = new AbortController();
  var hardTimer = setTimeout(function () { ac.abort(); }, 90000);
  var t0 = Date.now();
  var tick = setInterval(function () {
    var p = document.getElementById('localpending');
    if (p) p.innerHTML = '<div class="meta">她</div>正在想… ' + Math.round((Date.now() - t0) / 1000) + 's';
  }, 1000);

  api('/api/local-chat', { method:'POST', headers:{'Content-Type':'application/json'},
    signal: ac.signal,
    body: JSON.stringify({ text: text }) })
    .then(function (r) {
      var p = document.getElementById('localpending');
      if (!p) return;
      if (r.error) { p.innerHTML = '<div class="meta">她</div>' + esc(r.error); return; }

      var texts = (r.texts && r.texts.length) ? r.texts : (r.text ? [r.text] : []);
      p.removeAttribute('id');
      p.innerHTML = '<div class="meta">她 · ' + r.ms + 'ms' +
        (r.usedTools && r.usedTools.length ? ' · 用了 ' + r.usedTools.join(',') : '') +
        (texts.length > 1 ? ' · 连发 ' + texts.length + ' 条' : '') +
        '</div>' + esc(texts[0] || '（没说话）');
      box.scrollTop = box.scrollHeight;

      // 后面的补发一条条来，间隔像真人在打字
      for (var i = 1; i < texts.length; i++) {
        (function (t, k) {
          setTimeout(function () {
            box.innerHTML += '<div class="msg in"><div class="meta">她</div>' + esc(t) + '</div>';
            box.scrollTop = box.scrollHeight;
          }, 600 * k + Math.random() * 900);
        })(texts[i], i);
      }

      loadChat();
    })
    .catch(function (e) {
      var p = document.getElementById('localpending');
      if (p) p.innerHTML = '<div class="meta">她</div>' + (e && e.name === 'AbortError' ? '等了 90 秒还没回，可能是模型接口卡了（检查 key 和网络）' : '请求失败：' + (e && e.message));
    })
    .finally(function () { clearTimeout(hardTimer); clearInterval(tick); })
    .catch(function(e){
      var p = document.getElementById('localpending');
      if (p) p.innerHTML = '<div class="meta">她</div>出错了：' + esc(e.message);
    });
}

// ---------------- 记忆 ----------------
// ---------------- 记忆：四个板块 ----------------
var MEM_TAB = 'surface';

var ALIAS = { episodic: 'merged', semantic: 'surface', working: 'surface' };
function memTab(name) {
  name = ALIAS[name] || name;
  MEM_TAB = name;
  ['surface', 'merged', 'core'].forEach(function (k) {
    var pane = document.getElementById('memPane' + k.charAt(0).toUpperCase() + k.slice(1));
    if (pane) pane.style.display = k === name ? '' : 'none';
  });
  document.querySelectorAll('.memtab').forEach(function (b) {
    b.classList.toggle('on', b.dataset.mtab === name);
  });
  if (name === 'surface') { renderSem(); }
    if (name === 'merged') { renderEpi(); }
  if (name === 'core') renderCore();
  loadMemParams();
}

function loadToday() {
  api('/api/memory/today').then(function (list) {
    var box = document.getElementById('todayList');
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<div class="muted">今天还没有记忆</div>';
      return;
    }
    var LAYER = { episodic: '经历', semantic: '事实', core: '核心', working: '刚聊' };
    box.innerHTML = list.map(function (m) {
      return memCard(m, { todayLayer: LAYER[m.layer] || m.layer });
    }).join('');
  }).catch(function () {});
}

function memTime(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 一条记忆的卡片：普通的一句话，important 的展开 */
// 把"还能记多久"说成人话
function fmtRemain(h) {
  if (h == null) return '';
  if (h >= 24 * 365) return '记一年以上';
  if (h >= 24 * 60) return '还能记 ' + Math.round(h / 24 / 30) + ' 个月';
  if (h >= 24) return '还能记 ' + Math.round(h / 24) + ' 天';
  if (h >= 1) return '还能记 ' + Math.round(h) + ' 小时';
  return '快忘了';
}

function memCard(m, opts) {
  opts = opts || {};
  var w = m.weight || 0;
  var big = w >= 7;
  var tags = '';
  if (m.kind && m.kind !== 'fact') tags += '<span class="tag warn">' + ({ joke: '玩笑', feeling: '感受', event: '事件', ask: '提问' }[m.kind] || m.kind) + '</span>';
  if (m.places && m.places.length) tags += '<span class="tag">' + esc(m.places.join('·')) + '</span>';
  if (m.feeling) tags += '<span class="tag">' + esc(m.feeling) + '</span>';
  (m.tags || []).slice(0, 3).forEach(function (t) { tags += '<span class="tag">' + esc(t) + '</span>'; });
  if (m.hits) tags += '<span class="tag">想起 ' + m.hits + '</span>';
  if (m.children && m.children.length) tags += '<span class="tag">统辖 ' + m.children.length + ' 条</span>';

  var body = '<div class="memhead">' +
      '<span class="memtime">' +
        memTime(m.createdAt || m.lastAt) +
        ' · 上次提起 ' + memTime(m.lastAt || m.createdAt) +
        (m.spanFrom ? ' · 内容 ' + memTime(m.spanFrom) + '~' + memTime(m.spanTo) : '') +
      '</span>' +
      '<span class="wbadge' + (w >= 9 ? ' hot' : w >= 7 ? ' warm' : '') + '">' + w + '分</span>' +
      (m.frozen ? '<span class="tag">不衰减</span>' : (m.remainHours != null ? '<span class="tag">' + fmtRemain(m.remainHours) + '</span>' : '')) +
      tags +
    '</div>' +
    '<div class="memtext">' + esc(m.text) + '</div>';

  if (m.weightWhy) body += '<div class="muted" style="font-size:11.5px">为什么 ' + w + ' 分：' + esc(m.weightWhy) + '</div>';
  if (m.detail) body += '<div class="memdetail">' + esc(m.detail) + '</div>';
  if (m.raw && big) body += '<div class="memraw">原话：「' + esc(m.raw) + '」</div>';

  var btns = '';
  if (opts.core) btns += '<button class="act mini shrink" onclick="unCore(\'' + m.id + '\')">取消核心</button>';
  else if (w >= 10) btns += '<button class="act mini shrink" onclick="toCore(\'' + m.id + '\')">标为核心</button>';
  btns += '<button class="act mini danger shrink" onclick="delMem(\'' + m.id + '\')">删</button>';

  return '<div class="mem"><div class="body">' + body + '</div><div class="memacts">' + btns + '</div></div>';
}

var MERGED_LEVEL = 1;
function mergedLevel(lv) {
  MERGED_LEVEL = lv;
  var a = document.getElementById('mergedLevel1');
  var b = document.getElementById('mergedLevel2');
  if (a) a.classList.toggle('on', lv === 1);
  if (b) b.classList.toggle('on', lv === 2);
  renderEpi();
}

function renderEpi() {
  var range = Number((document.getElementById('epiRange') || {}).value || 7);
  api('/api/memory?layer=merged').then(function (list) {
    var cut = range > 0 ? Date.now() - range * 86400000 : 0;
    var who = (document.getElementById('epiWho') || {}).value || '';
    list = list.filter(function (m) { return (Number(m.depth) || 1) === MERGED_LEVEL; });
    var rows = list.filter(function (m) {
      if (m.lastAt < cut) return false;
      if (who && !(m.people || []).includes(who) && m.whoName !== who) return false;
      return true;
    });
    // 人物下拉
    var sel = document.getElementById('epiWho');
    if (sel && sel.options.length <= 1) {
      var names = {};
      list.forEach(function (m) { (m.people || []).forEach(function (p) { names[p] = 1; }); if (m.whoName) names[m.whoName] = 1; });
      sel.innerHTML = '<option value="">所有人</option>' + Object.keys(names).map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
      }).join('');
    }
    document.getElementById('epiList').innerHTML = rows.length
      ? rows.map(function (m) { return memCard(m, {}); }).join('')
      : '<div class="muted">这段时间没有情景记忆</div>';
    document.getElementById('memcount').textContent =
      (MERGED_LEVEL === 1 ? '第一层整合 ' : '第二层整合 ') + list.length + ' 条';
  });
}

function renderSem() {
  api('/api/memory?layer=surface').then(function (list) {
    var groups = {};
    list.forEach(function (m) {
      // 按 QQ 号分组：同一个人换过名字也只算一个
      var k = m.subject || m.whoName || '其他人的事';
      (groups[k] = groups[k] || []).push(m);
    });
    var order = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; });
    document.getElementById('semList').innerHTML = order.length
      ? order.map(function (k) {
          var label = k;
          if (window.__rosterById && window.__rosterById[k]) label = window.__rosterById[k];
          else if (k === '其他人的事') label = '跨人的概括';
          else if (/^\d+$/.test(k)) label = 'QQ ' + k;
          return '<div class="sect">' + esc(label) + '（' + groups[k].length + '）</div>' +
            groups[k].map(function (m) { return memCard(m, {}); }).join('');
        }).join('')
      : '<div class="muted">还没有确定的事实</div>';
    document.getElementById('memcount').textContent = '语义 ' + list.length + ' 条';
  });
}

function renderCore() {
  api('/api/memory?layer=core').then(function (list) {
    document.getElementById('coreList').innerHTML = list.length
      ? list.map(function (m) { return memCard(m, { core: true }); }).join('')
      : '<div class="muted">还没有核心记忆。在情景或语义里点「标为核心」</div>';
    document.getElementById('memcount').textContent = '核心 ' + list.length + '/50';
  });
}



function toCore(id) {
  api('/api/memory/core', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function () { toast('已挪进核心'); memTab(MEM_TAB); });
}
function unCore(id) {
  api('/api/memory/core', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
    .then(function () { toast('已退回原层'); memTab(MEM_TAB); });
}
function archiveMem(id, on) {
  api('/api/memory/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, on: on }) })
    .then(function () { toast(on ? '已归档（没删）' : '已还原'); memTab(MEM_TAB); });
}

function loadMemParams() {
  // 记忆的寿命规则已经写死在代码里（由分数决定），面板不再有可调参数。
  // 这个函数留着是为了兼容旧页面元素，拿到什么就填什么。
  api('/api/memory/params').then(function (p) {
    p = p || {};
    document.querySelectorAll('[data-p]').forEach(function (el) {
      var v = p[el.dataset.p];
      if (v !== null && v !== undefined && typeof v !== 'object') el.value = v;
    });
  }).catch(function () {});
}


function loadMemory() {
  memTab(MEM_TAB);
}
// ---------------- 人物表 ----------------
function loadRoster() {
  api('/api/roster').then(function (list) {
    list = list || [];
    var self = list.filter(function (p) { return p.isSelf; });
    var others = list.filter(function (p) { return !p.isSelf; });

    var selfBox = document.getElementById('selfCard');
    if (selfBox) {
      selfBox.innerHTML = self.length
        ? self.map(function (p) {
            return '<div class="mem"><div class="body">' +
              '<div class="memhead"><span class="wbadge hot">她自己</span>' +
              '<span class="tag">QQ ' + esc(p.id) + '</span></div>' +
              '<div class="memtext">称呼：' + esc(p.title || '(未设置)') + '</div>' +
              '<div class="muted" style="font-size:11.5px">别人喊这些名字就是在喊她：' +
                esc((p.names || []).join('、') || '(未设置)') + '</div>' +
              '</div></div>';
          }).join('')
        : '<div class="muted">还没登记她自己</div>';
    }

    var box = document.getElementById('rosterList');
    if (!box) return;
    box.innerHTML = others.map(function (p) {
      var nick = p.name || p.card || '(未知昵称)';
      return '<div class="srow">' +
        '<div class="slabel">' +
          '<div class="zh">' + (p.isOwner ? '★ ' : '') + esc(nick) +
            ' <span class="tag">QQ ' + esc(p.id) + '</span>' +
            (p.title ? ' <span class="tag live">叫 ' + esc(p.title) + '</span>' : '') +
            (p.relation ? ' <span class="tag warn">她' + esc(p.relation) + '</span>' : '') + '</div>' +
          '<div class="desc">' + (p.card && p.card !== p.name ? '群名片：' + esc(p.card) + ' · ' : '') +
            (p.groups && p.groups.length ? '在 ' + p.groups.length + ' 个群' : '还没在群里见过') + '</div>' +
        '</div>' +
        '<div class="sinput" style="flex:0 0 330px">' +
          '<input value="' + esc(p.title || '') + '" data-rid="' + esc(p.id) + '" placeholder="她怎么叫" style="width:92px">' +
          '<input value="' + esc(p.relation || '') + '" data-rel="' + esc(p.id) + '" placeholder="关系(妈妈/朋友)" style="width:110px">' +
          '<button class="act mini shrink" onclick="saveRosterTitle(\'' + esc(p.id) + '\')">改</button>' +
        '</div>' +
      '</div>';
    }).join('') || '<div class="muted">还没认识人</div>';
  });
}

function syncRoster() {
  var hint = document.getElementById('rostersync');
  if (hint) hint.textContent = '正在从 QQ 拉取…';
  api('/api/roster/sync', { method: 'POST' }).then(function (r) {
    if (hint) hint.textContent = '同步了 ' + (r.updated || 0) + ' 个人';
    loadRoster();
  }).catch(function () {
    if (hint) hint.textContent = 'QQ 没连上，等上线再同步';
  });
}
function saveRosterTitle(id) {
  var el = document.querySelector('#rosterList [data-rid="' + id + '"]');
  var rel = document.querySelector('#rosterList [data-rel="' + id + '"]');
  if (!el) return;
  api('/api/roster', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, title: el.value, relation: rel ? rel.value : undefined }) })
    .then(function () { toast('已保存'); loadRoster(); });
}

function doAddMem() {
  var text = document.getElementById('memtext').value.trim();
  if (!text) return toast('写点东西');
  api('/api/memory', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text: text, subject: document.getElementById('memsub').value.trim(),
        }) })
    .then(function(r){ if (r.error) toast(r.error); else { document.getElementById('memtext').value = ''; loadMemory(); toast('记住了'); } });
}
function delMem(id) { api('/api/memory/' + id, { method:'DELETE' }).then(function(){ loadMemory(); toast('删了'); }); }

// 清理重复记忆
function doDedupe(dry) {
  if (!dry && !confirm('合并后重复的那几条会被删掉。合并前会自动存一份快照，删错了能退回来。继续？')) return;
  api('/api/memory/dedupe', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ dryRun: dry }) })
    .then(function(r){
      var el = document.getElementById('deduperesult');
      if (r.error) { el.textContent = r.error; return; }
      var lines = ['发现 ' + r.groups + ' 组重复，' + (dry ? '可合并 ' : '已合并 ') + r.removed + ' 条'];
      (r.details || []).forEach(function(g){
        lines.push('  留下：' + g.keep);
        (g.folded || []).forEach(function(f){ lines.push('  并入：' + f); });
      });
      el.textContent = lines.join('\n');
      if (!dry) { toast('合并了 ' + r.removed + ' 条'); loadMemory(); loadSnaps(); loadState(); }
    });
}

// 记忆版本
function loadSnaps() {
  api('/api/snapshots').then(function(d){
    if (d.error) { document.getElementById('snapinfo').textContent = d.error; return; }
    var v = d.verify || {};
    document.getElementById('snapinfo').textContent =
      '共 ' + d.snapshots.length + ' 个存档（上限 ' + d.keep + '）' +
      (v.ok ? ' · 校验通过' : ' · 有异常，看日志');
    S.snaps = d.snapshots;
    document.getElementById('snaplist').innerHTML = d.snapshots.map(function(s, i){
      return '<div class="mem"><div class="body">' +
        '<div>' + esc(s.label || 'auto') +
          ' <span class="tag">' + (s.items == null ? '?' : s.items + ' 条') + '</span>' +
          (s.mood ? ' <span class="tag">' + (s.mood.valence||0).toFixed(2) + '/' + (s.mood.energy||0).toFixed(2) + '</span>' : '') +
        '</div>' +
        '<div class="muted" style="font-size:11px">' + new Date(s.at).toLocaleString() +
          ' · ' + (s.bytes / 1024).toFixed(0) + 'KB</div>' +
      '</div>' +
      '<button class="act mini" onclick="diffSnap(' + i + ')">对比上一条</button>' +
      '<button class="act danger mini" onclick="restoreSnap(\'' + s.id + '\')">恢复</button>' +
      '</div>';
    }).join('') || '<div class="muted">还没有存档</div>';
  });
}
function diffSnap(i) {
  var list = S.snaps || [];
  if (i + 1 >= list.length) return toast('这是最早的一条，没有上一条可对比');
  var to = list[i].id, from = list[i + 1].id;
  api('/api/snapshots/diff?from=' + from + '&to=' + to).then(function(d){
    var head = '对比「' + list[i + 1].label + '」→「' + list[i].label + '」，' +
      d.changed + ' 处变化（' + d.from.items + ' 条 → ' + d.to.items + ' 条）';
    document.getElementById('snapdiff').textContent =
      head + '\n' + (d.lines.length ? d.lines.join('\n') : '（没有差异）');
  });
}
function restoreSnap(id) {
  if (!confirm('确定回滚到这个存档？当前状态会先自动存一份，可以再退回来。')) return;
  api('/api/snapshots', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'restore', id: id }) })
    .then(function(r){
      if (r.error) return toast(r.error);
      toast('已回滚，记忆 ' + ((r.stats && r.stats.total) || '?') + ' 条');
      loadSnaps(); loadMemory(); loadState();
    });
}
function doSnap() {
  api('/api/snapshots', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'snapshot', label: '手动' }) })
    .then(function(r){ if (r.error) toast(r.error); else { toast('已存档'); loadSnaps(); } });
}

// ---------------- 人设 ----------------
function loadPersona() {
  api('/api/persona').then(function(d){ document.getElementById('persona').value = d.content || ''; });
}
var PROMPT_TITLES = {
  qq: 'QQ 平台提示词 · 在 QQ 上怎么做事',
  mc: 'Minecraft 平台提示词 · 在游戏里怎么做事',
  reincarnate: '换身体 · 换模型那天用（一次性）',
};

function loadAllPrompts() {
  api('/api/prompts').then(function (list) {
    var box = document.getElementById('promptFiles');
    if (!box) return;
    box.innerHTML = (list || []).map(function (f) {
      var title = PROMPT_TITLES[f.name] || f.name;
      return '<div style="margin-bottom:16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<b style="font-size:13px">' + esc(title) + '</b>' +
          '<span class="muted" style="font-size:11px">' + f.size + ' 字 · prompts/' + f.name + '.md</span>' +
        '</div>' +
        '<textarea id="pf-' + f.name + '" style="min-height:200px;font-size:12.5px">' + esc(f.text) + '</textarea>' +
        '<div style="margin-top:8px"><button class="act primary shrink" onclick="savePromptFile(\'' + f.name + '\')">保存</button>' +
        '<span class="muted shrink" id="pfh-' + f.name + '" style="margin-left:8px"></span></div>' +
      '</div>';
    }).join('') || '<div class="muted">还没有提示词文件</div>';
  }).catch(function () {});
}

function savePromptFile(name) {
  var el = document.getElementById('pf-' + name);
  if (!el) return;
  api('/api/prompt/' + name, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: el.value }) })
    .then(function () {
      var h = document.getElementById('pfh-' + name);
      if (h) h.textContent = '已保存，立即生效';
      toast('已保存');
    })
    .catch(function () { toast('保存失败'); });
}

function loadPlatformPrompt() {
  api('/api/prompt/qq').then(function (r) {
    var el = document.getElementById('platformPrompt');
    if (!el) return;
    el.value = r.text || '';
    var h = document.getElementById('platformhint');
    if (h) h.textContent = (r.text || '').length + ' 字';
  }).catch(function () {});
}

function doSavePlatformPrompt() {
  var el = document.getElementById('platformPrompt');
  if (!el) return;
  api('/api/prompt/qq', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: el.value }) })
    .then(function () {
      var h = document.getElementById('platformhint');
      if (h) h.textContent = '已保存，立即生效';
      toast('平台提示词已保存');
    })
    .catch(function () { toast('保存失败'); });
}

function doSavePersona() {
  api('/api/persona', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ content: document.getElementById('persona').value }) })
    .then(function(){ toast('人设已保存，立即生效'); });
}

// ---------------- 心情 ----------------
// ---------------- 小睡 ----------------
function loadNap() {
  api('/api/nap').then(function (n) {
    var card = document.getElementById('napCard');
    if (!card) return;
    if (n && n.sleeping) {
      card.style.display = '';
      document.getElementById('napInfo').textContent =
        '她在睡觉，还剩 ' + n.minutesLeft + ' 分钟' +
        (n.place && n.place.name ? '（睡前在：' + n.place.name + '）' : '');
    } else {
      card.style.display = 'none';
    }
  }).catch(function () {});
}

function wakeHer() {
  api('/api/nap/wake', { method: 'POST' }).then(function (r) {
    toast(r.sleptMin ? '已叫醒（睡了 ' + r.sleptMin + ' 分钟）' : '她本来就醒着');
    loadNap();
  });
}

function loadMood() {
  Promise.all([api('/api/mood'), api('/api/autonomy')]).then(function (r) {
    var d = r[0];
    var a = r[1];
    document.getElementById('valence').value = Math.round(d.valence * 100);
    document.getElementById('energy').value = Math.round(d.energy * 100);
    if (a && a.vitalityMax) {
      var vs = document.getElementById('vitalitySlider');
      vs.max = a.vitalityMax;
      vs.value = a.vitality;
    }
    paintMood();
    document.getElementById('moodrecent').textContent = (d.recent || []).map(function (x) {
      return new Date(x.at).toLocaleTimeString() + ' ' + (x.dv > 0 ? '↑' : '↓') + Math.abs(x.dv) + ' 「' + x.text + '」';
    }).join('   ') || '还没波动';
  });
}

function paintMood() {
  var v = Number(document.getElementById('valence').value);
  var e = Number(document.getElementById('energy').value);
  var vit = Number(document.getElementById('vitalitySlider').value);
  var vmax = Number(document.getElementById('vitalitySlider').max) || 100;

  document.getElementById('vfill').style.width = Math.abs(v) + '%';
  document.getElementById('vfill').style.marginLeft = (v < 0 ? (50 - Math.abs(v) / 2) : 50) + '%';
  document.getElementById('efill').style.width = e + '%';
  document.getElementById('vitalityfill').style.width = Math.round((vit / vmax) * 100) + '%';
  document.getElementById('moodhint').textContent = '心情 ' + v + ' / 精力 ' + e + ' / 活力 ' + vit;
}

function doSaveMood() {
  var body = JSON.stringify({
    valence: Number(document.getElementById('valence').value) / 100,
    energy: Number(document.getElementById('energy').value) / 100,
  });
  var vmax = Number(document.getElementById('vitalitySlider').max) || 100;
  var vit = Number(document.getElementById('vitalitySlider').value);
  Promise.all([
    api('/api/mood', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body }),
    api('/api/autonomy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vitality: vit }) }),
  ])
    .then(function () {
      toast('已应用（活力 ' + vit + '/' + vmax + '）');
      loadState();
    });
}

// 四条需求：滑块改当前值，右边小框改涨速
var DRIVE_KEYS = {
  AUTONOMY_RATE_BOREDOM: 'boredom',
  AUTONOMY_RATE_SOCIAL: 'social',
  AUTONOMY_RATE_EXPRESSION: 'expression',
  AUTONOMY_RATE_CURIOSITY: 'curiosity',
};
var DRIVE_NAMES = { boredom: '无聊', social: '社交欲', expression: '表达欲', curiosity: '好奇' };
var DRIVE_TIPS = {
  boredom: '没人理，闲得慌 → 改签名/换头像/改名片',
  social: '想找人说话 → 主动找你',
  expression: '心里有话 → 发说说/写日记',
  curiosity: '想知道点什么 → 搜索/整理记忆/翻旧事',
};

function loadStatusSettings() {
  Promise.all([api('/api/autonomy'), api('/api/settings')]).then(function (r) {
    var a = r[0];
    var list = r[1];
    var byKey = {};
    list.forEach(function (m) { byKey[m.key] = m; });

    // ---- 需求区 ----
    document.getElementById('drivesEdit').innerHTML = Object.keys(DRIVE_NAMES).map(function (k) {
      var rateKey = Object.keys(DRIVE_KEYS).find(function (rk) { return DRIVE_KEYS[rk] === k; });
      var m = byKey[rateKey] || { value: '', min: 0, max: 10, step: 0.1 };
      var val = a && a.drives && a.drives[k] ? a.drives[k].value : 0;
      return '<div class="srow">' +
        '<div class="slabel">' +
          '<div class="zh">' + DRIVE_NAMES[k] + '<span class="en">' + k + '</span>' +
            (a && a.topDrive && a.topDrive.key === k ? ' <span class="tag live">最强烈</span>' : '') + '</div>' +
          '<div class="desc">' + DRIVE_TIPS[k] + '</div>' +
        '</div>' +
        '<div class="sinput" style="flex:0 0 340px">' +
          '<input type="range" min="0" max="100" value="' + val + '" data-drive="' + k +
            '" oninput="paintDrives()" style="flex:1">' +
          '<span class="driveval" id="dv-' + k + '" style="width:30px;text-align:right">' + val + '</span>' +
          '<input type="number" data-key="' + rateKey + '" value="' + esc(m.value) + '" min="' + m.min +
            '" max="' + m.max + '" step="' + m.step + '" style="width:66px" title="每分钟涨多少">' +
          '<span class="muted" style="font-size:11px">/分</span>' +
        '</div>' +
      '</div>';
    }).join('');

    // ---- 恢复区 ----
    var recover = list.filter(function (m) { return m.group === '情绪恢复'; });
    document.getElementById('recoverSettings').innerHTML = recover.map(renderRow).join('');

    // ---- 消耗区 ----
    var costs = list.filter(function (m) { return m.group === '精力消耗' || m.group === '活力消耗'; });
    var html = '';
    ['精力消耗', '活力消耗'].forEach(function (g) {
      var rows = costs.filter(function (m) { return m.group === g; });
      if (!rows.length) return;
      html += '<div class="sect">' + g + '</div>' + rows.map(renderRow).join('');
    });
    document.getElementById('costSettings').innerHTML = html;

    // ---- 摘要 ----
    if (a) {
      document.getElementById('moodrules').textContent =
        '活力 ' + a.vitality + '/' + a.vitalityMax + '（每天 ' + a.vitalityResetHour + ' 点补满）· ' +
        '最强烈的是「' + (a.topDrive ? a.topDrive.zh : '-') + '」' +
        (a.etaMinutes != null ? '，最快 ' + a.etaMinutes + ' 分钟后憋不住' : '');
    }
  });
}

function paintDrives() {
  Object.keys(DRIVE_NAMES).forEach(function (k) {
    var el = document.querySelector('[data-drive="' + k + '"]');
    var out = document.getElementById('dv-' + k);
    if (el && out) out.textContent = el.value;
  });
}

function doSaveDrives() {
  var drives = {};
  document.querySelectorAll('#drivesEdit [data-drive]').forEach(function (el) {
    drives[el.dataset.drive] = Number(el.value);
  });
  var rates = {};
  document.querySelectorAll('#drivesEdit [data-key]').forEach(function (el) {
    rates[el.dataset.key] = el.value;
  });

  Promise.all([
    api('/api/autonomy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drives: drives }) }),
    api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rates) }),
  ]).then(function () {
    document.getElementById('drivehint').textContent = '已保存';
    toast('需求已更新');
    loadMood();
  });
}

// ---------------- 能力 ----------------
function loadTools() {
  api('/api/tools').then(function(list){
    S.tools = list;
    document.getElementById('toolcount').textContent = '共 ' + list.length + ' 个工具';
    renderTools();
  });
}
function renderTools() {
  var kw = (document.getElementById('toolfilter').value || '').toLowerCase();
  var LIB_NAME = { local: '原生工具', qq: 'QQ 工具', mc: 'Minecraft 工具', memory: '记忆工具', sticker: '表情工具' };
  var LIB_HINT = {
    local: '不依赖任何软件的通用能力',
    qq: '只有接上 QQ 才用得到',
    mc: '只有她在 Minecraft 里才用得到',
    memory: '记忆、人物表、作息',
    sticker: '表情收藏与发送',
  };
  var LIB_ORDER = ['local', 'qq', 'mc', 'memory', 'sticker'];

  var groups = {}, order = [];
  S.tools.forEach(function(t){
    if (kw && t.name.toLowerCase().indexOf(kw) < 0 && t.description.toLowerCase().indexOf(kw) < 0) return;
    var lib = t.lib || 'local';
    if (!groups[lib]) { groups[lib] = []; order.push(lib); }
    groups[lib].push(t);
  });
  order.sort(function(a, b){
    var ia = LIB_ORDER.indexOf(a), ib = LIB_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  document.getElementById('toollist').innerHTML = order.map(function(lib){
    var hint = LIB_HINT[lib] ? '<span class="muted" style="font-size:11.5px;font-weight:400;margin-left:8px">' + esc(LIB_HINT[lib]) + '</span>' : '';
    return '<div class="card"><h3>' + esc(LIB_NAME[lib] || lib) + '（' + groups[lib].length + '）' + hint + '</h3>' +
      groups[lib].map(function(t){
        var required = (t.parameters && t.parameters.required) || [];
        var example = {};
        Object.keys((t.parameters && t.parameters.properties) || {}).forEach(function(k){
          if (required.indexOf(k) >= 0) example[k] = '';
        });
        return '<div class="tool" id="tool-' + t.name + '">' +
          '<div class="head" onclick="toggleTool(\'' + t.name + '\')">' +
            '<span class="name">' + t.name + '</span>' +
            (t.destructive ? '<span class="tag warn">破坏性</span>' : '') +
          '</div>' +
          '<div class="desc">' + esc(t.description) + '</div>' +
          '<div class="body">' +
            '<textarea id="args-' + t.name + '" rows="4">' + esc(JSON.stringify(example, null, 2)) + '</textarea>' +
            '<div class="row" style="margin-top:6px">' +
              '<button class="act primary mini shrink" onclick="callTool(\'' + t.name + '\')">执行</button>' +
              '<span class="muted shrink">返回会显示在下面</span>' +
            '</div>' +
            '<pre class="muted" id="res-' + t.name + '" style="white-space:pre-wrap;font-size:11.5px"></pre>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  }).join('') || '<div class="muted">没有匹配的工具</div>';
}
function toggleTool(name) {
  var el = document.getElementById('tool-' + name);
  el.classList.toggle('open');
}
function callTool(name) {
  var raw = document.getElementById('args-' + name).value;
  var args;
  try { args = JSON.parse(raw || '{}'); } catch (e) { return toast('参数不是合法 JSON'); }
  var out = document.getElementById('res-' + name);
  out.textContent = '执行中…';
  api('/api/tool-call', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: name, args: args }) })
    .then(function(r){ out.textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2); })
    .catch(function(e){ out.textContent = '失败：' + e.message; });
}

// ---------------- 语音 ----------------
function prefillVoiceGroup() {
  api('/api/settings').then(function(list){
    var g = '';
    list.forEach(function(m){ if (m.key === 'AUTONOMY_GROUP_ID' && m.value) g = m.value; });
    var el = document.getElementById('vgroup');
    if (!el.value && g) el.value = g;
  });
}
function loadVoices() {
  var gid = document.getElementById('vgroup').value.trim();
  if (!gid) return toast('先填群号');
  document.getElementById('voicelist').textContent = '加载中…';
  api('/api/voices?group_id=' + encodeURIComponent(gid)).then(function(r){
    if (r.error) { document.getElementById('voicelist').textContent = '失败：' + r.error; return; }
    S.voices = r.voices || [];
    document.getElementById('voicelist').innerHTML = S.voices.map(function(v){
      return '<div class="voice">' +
        '<div class="vname"><div>' + esc(v.name) + '</div><div class="muted" style="font-size:11px">' + esc(v.id) + '</div></div>' +
        (v.preview ? '<audio controls preload="none" src="' + esc(v.preview) + '" style="height:30px;width:180px"></audio>' : '') +
        '<button class="act mini shrink" onclick="pickVoice(\'' + esc(v.id) + '\',\'' + esc(v.name) + '\')">用这个</button>' +
      '</div>';
    }).join('') || '<div class="muted">没拿到声音列表</div>';
  }).catch(function(e){ document.getElementById('voicelist').textContent = '失败：' + e.message; });
}
function pickVoice(id, name) {
  S.voicePick = id;
  document.getElementById('vcur').textContent = '当前选中：' + name + '（' + id + '）';
  toast('已选 ' + name);
}
function sendVoiceTest() {
  var gid = document.getElementById('vgroup').value.trim();
  var text = document.getElementById('vtext').value.trim();
  if (!gid) return toast('先填群号');
  if (!text) return toast('写点内容');
  api('/api/voice-send', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ group_id: gid, text: text, character: S.voicePick || '' }) })
    .then(function(r){ toast(r.ok ? '语音已发出' : ('失败：' + (r.error || ''))); });
}

// ---------------- 接入 ----------------
function loadConnect(check) {
  var render = function (d) {
    if (d.error) { document.getElementById('connectsummary').textContent = d.error; return; }
    renderConnect(d);
  };
  if (check) {
    document.getElementById('connectsummary').textContent = '检测中…';
    api('/api/integrations').then(render);
  } else {
    api('/api/integrations').then(render);
  }
}

function renderConnect(d) {
  var q = d.qq || {};
  var state, color;
  if (!q.checkedAt) { state = '未检测'; color = '#8b949e'; }
  else if (q.online) { state = '在线'; color = '#3fb950'; }
  else if (q.running) { state = '掉线'; color = '#e0a458'; }
  else { state = '没在运行'; color = '#e5534b'; }

  document.getElementById('connectsummary').textContent =
    'QQ ' + state +
    (q.error && !q.online && q.checkedAt ? ' · ' + q.error : '') +
    (q.checkedAt ? ' · 上次检测 ' + new Date(q.checkedAt).toLocaleTimeString() : ' · 点「刷新」看当前状态');

  // 登录卡住的明确原因（已登录在别处 / 要验证 / 要扫码）
  var hintBox = document.getElementById('loginHint');
  if (hintBox) {
    if (q.loginHint) {
      hintBox.style.display = '';
      hintBox.innerHTML = '<b>为什么登不上：</b>' + esc(q.loginHint);
    } else if (q.loginState === 'needQr') {
      hintBox.style.display = '';
      hintBox.innerHTML =
        '<b>需要扫码登录：</b>用手机 QQ 扫下面的码' +
        '" style="width:240px;height:240px;background:#fff;border-radius:8px;padding:8px" ' +
        'onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{textContent:\'二维码还没生成，等一下点刷新\'}))"></div>' +
        '<div class="muted" style="font-size:11.5px;margin-top:6px">码有时效，过期就点「刷新」重新获取</div>';
    } else if (q.loginState === 'needVerification') {
      hintBox.style.display = '';
      hintBox.innerHTML =
        '<b>需要验证：</b>点下面这个链接完成验证，然后在「接入」页点重连。' +
        (q.verifyUrl ? '<br><a href="' + esc(q.verifyUrl) + '" target="_blank">打开验证页</a>' : '');
    } else {
      hintBox.style.display = 'none';
    }
  }

  var qqCard =
    '<div class="card"><h3>' + esc(q.app) + ' · 通过 ' + esc(q.via) + '</h3>' +
    '<div class="grid" style="margin-bottom:12px">' +
      '<div><div class="k">状态</div><div class="v" style="color:' + color + '">' + state + '</div></div>' +
      '<div><div class="k">账号</div><div class="v">' + esc(q.account || '—') + '</div></div>' +
      '<div><div class="k">OneBot 地址</div><div class="v" style="font-size:13px">' + esc(q.ws || '—') + '</div></div>' +
    '</div>' +
    (q.online ? '' :
      '<div class="muted" style="margin-bottom:10px">' +
      '掉的通常是「登录态失效」：端口还通、消息收不到。要恢复得在桌面 QQ 上登录小号，再回来点重连。' +
      '</div>') +
    '<div class="row">' +
      (q.webui ? '<a class="act shrink" style="text-decoration:none;text-align:center" href="' + esc(q.webui) + '" target="_blank">打开 SnowLuma 面板</a>' : '') +
      '<button class="act shrink" onclick="loadConnect(true)">重新检测</button>' +
    '</div></div>';

  var mc = d.minecraft || {};
  var mcCard =
    '<div class="card"><h3>' + esc(mc.app) + ' · 通过 ' + esc(mc.via) + '</h3>' +
    '<div class="grid" style="margin-bottom:8px">' +
      '<div><div class="k">服务器</div><div class="v" style="font-size:15px">' + esc(mc.host + ':' + mc.port) + '</div></div>' +
      '<div><div class="k">游戏 ID</div><div class="v" style="font-size:15px">' + esc(mc.username) + '</div></div>' +
    '</div>' +
    '<div class="muted">' + esc(mc.note) + '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;align-items:center">' +
      '<button class="act primary shrink" onclick="mcStart()">加入世界</button>' +
      '<button class="act danger shrink" onclick="mcStop()">离开</button>' +
      '<span class="muted shrink" id="mchint"></span>' +
    '</div></div>';

  var others = (d.planned || []).map(function (p) {
    return '<div class="mem"><div class="body"><div>' + esc(p.app) + ' <span class="tag">' + esc(p.state) + '</span></div>' +
      '<div class="muted" style="font-size:11.5px">' + esc(p.why) + '</div></div></div>';
  }).join('');

  document.getElementById('connectlist').innerHTML = qqCard + mcCard +
    '<div class="card"><h3>还没接的软件</h3>' + (others || '<div class="muted">没有</div>') + '</div>';
}

function mcStart() {
  toast('正在让她进游戏…');
  api('/api/mc/start', { method: 'POST' }).then(function (r) {
    document.getElementById('mchint').textContent = '已启动（pid ' + r.pid + '），等几秒进世界';
  }).catch(function () { toast('启动失败'); });
}

function mcStop() {
  api('/api/mc/stop', { method: 'POST' }).then(function () {
    document.getElementById('mchint').textContent = '已离开';
  });
}

// ---------------- 设置（数据驱动） ----------------
var SETTINGS = [];
var SECTION_ORDER = ['基础', '聊天行为', '群聊', '安全与权限', '自主行为', '记忆与数据', '实验', '其他'];

function loadSettings() {
  api('/api/settings').then(function (list) {
    SETTINGS = list;
    var showAll = document.getElementById('showAll').checked;
    var kw = (document.getElementById('setfilter').value || '').trim().toLowerCase();

    var secs = {};
    var order = [];
    list.forEach(function (m) {
      if (m.page !== 'settings') return; // 情绪/精力相关在「心情」页
      if (!showAll && !m.useful) return;
      if (kw) {
        var hay = (m.zh + ' ' + m.en + ' ' + m.key + ' ' + m.desc + ' ' + m.group).toLowerCase();
        if (hay.indexOf(kw) < 0) return;
      }
      if (!secs[m.section]) {
        secs[m.section] = {};
        order.push(m.section);
      }
      if (!secs[m.section][m.group]) secs[m.section][m.group] = [];
      secs[m.section][m.group].push(m);
    });

    order.sort(function (a, b) {
      var ia = SECTION_ORDER.indexOf(a);
      var ib = SECTION_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    var html = order.map(function (sec) {
      var groups = secs[sec];
      var body = Object.keys(groups).map(function (g) {
        return '<details class="grp" open><summary>' + esc(g) +
          ' <span class="tag">' + groups[g].length + '</span></summary>' +
          '<div class="inner">' + groups[g].map(renderRow).join('') + '</div></details>';
      }).join('');
      return '<div class="card"><div class="sect" style="margin-top:0">' + esc(sec) + '</div>' + body + '</div>';
    }).join('');

    document.getElementById('settingsbox').innerHTML =
      html || '<div class="card muted">没有匹配的设置项</div>';

    var hidden = list.filter(function (m) { return m.page === 'settings' && !m.useful; }).length;
    document.getElementById('savehint').textContent = showAll ? '' : '已隐藏 ' + hidden + ' 个不常用的';
  });
}

function renderRow(m) {
  var input;
  if (m.type === 'bool') {
    input = '<input type="checkbox" data-key="' + m.key + '"' + (String(m.value) === 'true' ? ' checked' : '') + '>';
  } else if (m.type === 'number') {
    input = '<input type="number" data-key="' + m.key + '" value="' + esc(m.value) + '"' +
      (m.min != null ? ' min="' + m.min + '"' : '') + (m.max != null ? ' max="' + m.max + '"' : '') +
      (m.step != null ? ' step="' + m.step + '"' : '') + '>';
  } else {
    input = '<input type="text" data-key="' + m.key + '" value="' + esc(m.value) + '">';
  }
  return '<div class="srow">' +
    '<div class="slabel"><div class="zh">' + esc(m.zh) + '<span class="en">' + esc(m.en) + '</span>' +
      (m.live ? ' <span class="tag live">热更新</span>' : '') + '</div>' +
      '<div class="desc">' + esc(m.desc) + '</div></div>' +
    '<div class="sinput">' + input + '</div>' +
  '</div>';
}

// 从指定容器里收集输入并保存
function saveSettingsFrom(rootId, hintId) {
  var body = {};
  document.querySelectorAll('#' + rootId + ' [data-key]').forEach(function (el) {
    var k = el.dataset.key;
    if (el.type === 'checkbox') body[k] = el.checked ? 'true' : 'false';
    else body[k] = el.value;
  });
  if (!Object.keys(body).length) return toast('没有可保存的项');

  api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) {
      if (r.error) return toast(r.error);
      var msg = '已保存';
      if (r.applied && r.applied.length) msg += '，' + r.applied.length + ' 项立即生效';
      if (r.needRestart) msg += '，其余重启后生效';
      toast(msg);
      if (hintId) document.getElementById(hintId).textContent = msg;
    });
}

// ---------------- 日志 ----------------
function loadLogs() {
  api('/api/logs').then(function(lines){
    var b = document.getElementById('logbox');
    b.textContent = lines.map(function(l){ return l.line; }).join('\n');
    b.scrollTop = b.scrollHeight;
  });
}
var es = new EventSource('/api/events');
es.onmessage = function(e) {
  var d = JSON.parse(e.data);
  if (d.type === 'log') {
    var b = document.getElementById('logbox');
    b.textContent += d.line + '\n';
    if (b.textContent.length > 80000) b.textContent = b.textContent.slice(-50000);
    b.scrollTop = b.scrollHeight;
  }
};

setInterval(loadState, 3000);
loadState();

// 记忆星图（三维）
// 相机：绕原点转（yaw/pitch）+ 距离（dist）+ 焦点（focus）
var starState = {
  pts: null, edges: null, activation: null, actAt: 0, actLoop: 0,
  yaw: 0.6, pitch: 0.35, dist: 4.2,
  focus: { x: 0, y: 0, z: 0 }, wantFocus: null, zoomTo: null,
  dragging: null, info: '', t0: Date.now()
};

// 预渲染星点贴图（一次画好，之后只 drawImage）
var starSprites = {};
function starSprite(color) {
  if (starSprites[color]) return starSprites[color];
  var S = 64, c = document.createElement('canvas');
  c.width = S; c.height = S;
  var g = c.getContext('2d');
  var grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.10, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.22, color);
  grd.addColorStop(0.40, color.replace('rgb(', 'rgba(').replace(')', ',0.20)'));
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  g.fill();
  starSprites[color] = c;
  return c;
}

function hexToRgbStr(hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return 'rgb(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ')';
}

function starProject(p, W, H) {
  var x = p.x - starState.focus.x;
  var y = p.y - starState.focus.y;
  var z = p.z - starState.focus.z;
  var cy = Math.cos(starState.yaw), sy = Math.sin(starState.yaw);
  var cp = Math.cos(starState.pitch), sp = Math.sin(starState.pitch);
  var x1 = x * cy - z * sy;
  var z1 = x * sy + z * cy;
  var y1 = y * cp - z1 * sp;
  var z2 = y * sp + z1 * cp;
  var d = starState.dist;
  var k = 2.0 / (d + z2 + 0.6);   // 距离越近放大越多
  return { sx: W / 2 + x1 * k * W * 0.42, sy: H / 2 + y1 * k * H * 0.42, k: k, z: z2 };
}

function renderStarMap() {
  var cv = document.getElementById('starmap');
  if (!cv) return;
  var g = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  var info = document.getElementById('starmapinfo');
  if (!starState.pts) {
    if (info) info.textContent = '正在算星图…（第一次会慢一点）';
    return;
  }
  var colors = { core: '#e5484d', merged: '#b06ff5', merged2: '#e07be0', surface: '#4f7fa8' };
  var proj = starState.pts.map(function (p) { return starProject(p, W, H); });

  // 连线：按相关度，越相关越粗越亮
  var selZForEdges = null;
  if (starState.selectedId) {
    for (var se = 0; se < starState.pts.length; se++) {
      if (starState.pts[se].id === starState.selectedId) { selZForEdges = proj[se].z; break; }
    }
  }
  var NEAR_ONLY = false;
  function drawEdges() {
  (starState.edges || []).forEach(function (e) {
    if (e.a == null || e.b == null) return;
    var a = proj[e.a], b = proj[e.b];
    var ez = (a.z + b.z) / 2;
    if (selZForEdges != null) {
      var isNear = ez < selZForEdges;
      if (isNear !== NEAR_ONLY) return;
    }
    if (!a || !b) return;
    var sim = Math.max(0, Math.min(1, e.s || 0));
      if (e.kind === 'owns') {
        // 子记忆在第几跳，就从父节点"传"到子节点
        var childId = (starState.pts[e.b] || {}).id;
        var childHop = starState.hitMap ? starState.hitMap[childId] : null;
        var glow = 0, ea = 0;
        if (childHop != null && starState.actLoop) {
          var et = ((Date.now() - starState.actLoop) / 1000) % 3.6;
          ea = et - childHop * 0.75 + 0.32;
          if (ea > 0 && ea < 0.5) glow = Math.sin((ea / 0.5) * Math.PI);
        }
        g.strokeStyle = 'rgba(255,255,255,' + (0.34 + glow * 0.66).toFixed(3) + ')';
        g.lineWidth = 0.9 + glow * 1.8;
        g.beginPath();
        g.moveTo(a.sx, a.sy); g.lineTo(b.sx, b.sy);
        g.stroke();
        if (glow > 0.2) {
          var q = Math.min(1, Math.max(0, ea / 0.5));
          g.fillStyle = 'rgba(200,240,255,' + glow.toFixed(3) + ')';
          g.beginPath();
          g.arc(a.sx + (b.sx - a.sx) * q, a.sy + (b.sy - a.sy) * q, 1.8 + glow * 1.6, 0, Math.PI * 2);
          g.fill();
        }
        return;
      }
    var near = Math.max(0, Math.min(1, (sim - 0.6) / 0.35));
    g.beginPath();
    g.moveTo(a.sx, a.sy);
    g.lineTo(b.sx, b.sy);
    g.strokeStyle = 'rgba(255,255,255,' + (0.05 + near * 0.42).toFixed(3) + ')';
    g.lineWidth = 0.2 + near * 1.25;   // 比原来更细，最粗 1.45
    g.stroke();
  });
  }
  drawEdges();

  // 星核用原色画，别用叠加（叠多了会发白），发光交给 bloom
  g.globalCompositeOperation = 'source-over';
  var order = starState.pts.map(function (p, i) { return { p: p, q: proj[i] }; })
    .sort(function (x, y) { return y.q.z - x.q.z; });
  var t = (Date.now() - starState.t0) / 1000;

  // bloom 的原料：只画"实心球"，模糊后球内是平的，只在外面才衰减
  var bs = starState._bsrc || (starState._bsrc = document.createElement('canvas'));
  if (bs.width !== W || bs.height !== H) { bs.width = W; bs.height = H; }
  var bg = bs.getContext('2d');
  bg.clearRect(0, 0, W, H);
  bg.globalCompositeOperation = 'source-over';
  // 指向框：按深度插入，前面的星星会挡住它
  function drawCallout() {
  if (!(starState.info && starState.selectedId)) return;
    var target = null, tq = null;
    for (var pi = 0; pi < starState.pts.length; pi++) {
      if (starState.pts[pi].id === starState.selectedId) { target = starState.pts[pi]; tq = proj[pi]; break; }
    }
    if (target && tq && tq.k > 0.05) {
      g.save();
      var SC = Math.max(0.4, Math.min(1.4, tq.k * 0.5));   // 跟着镜头缩放
      g.translate(tq.sx, tq.sy);
      g.scale(SC, SC);
      g.translate(-tq.sx, -tq.sy);
      g.font = "300 13px 'HarmonyOS Sans SC', 'MiSans', 'Source Han Sans SC', 'PingFang SC', system-ui, sans-serif";
      var label = String(target.text || "");
      var extra = (target.layer === "core" ? "核心" : target.layer === "merged" ? "整合 · " + (target.depth >= 2 ? "二层" : "一层") : "表层") + " · " + (target.w || 1) + " 分";
      var padx = 14, pady = 10, lineH = 18;
      var maxW = Math.min(W - 40, 300);
      g.letterSpacing = "1.2px";
      var lines = [], cur2 = "";
      for (var ci2 = 0; ci2 < label.length; ci2++) {
        if (g.measureText(cur2 + label[ci2]).width > maxW - padx * 2) { lines.push(cur2); cur2 = label[ci2]; }
        else cur2 += label[ci2];
      }
      if (cur2) lines.push(cur2);
      var bw = Math.min(maxW, Math.max.apply(null, lines.map(function (t) { return g.measureText(t).width; }).concat([g.measureText(extra).width])) + padx * 2);
      starState._box = { x: bx, y: by, w: bw, h: bh };
      var bh = lines.length * lineH + pady * 2 + 16;
      var bx = tq.sx - bw / 2;
      var by = tq.sy - 46 - bh;
      if (by < 8) by = tq.sy + 30;
      bx = Math.max(8, Math.min(W - bw - 8, bx));
      // 光晕
      g.shadowColor = "rgba(120,190,255,0.55)";
      g.shadowBlur = 18;
      g.fillStyle = "rgba(8,14,26,0.90)";
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, bw, bh, 10); else g.rect(bx, by, bw, bh);
      g.fill();
      g.shadowBlur = 0;
      // 细边 + 顶部高光
      var bg2 = g.createLinearGradient(bx, by, bx, by + bh);
      bg2.addColorStop(0, "rgba(160,215,255,0.55)");
      bg2.addColorStop(1, "rgba(90,130,200,0.10)");
      g.strokeStyle = bg2;
      g.lineWidth = 1;
      g.stroke();
      // 指向线：框底 → 星星
      g.strokeStyle = "rgba(150,210,255,0.55)";
      g.beginPath();
      g.moveTo(tq.sx, by + bh);
      g.lineTo(tq.sx, tq.sy - 8);
      g.stroke();
      g.beginPath();
      g.arc(tq.sx, tq.sy - 8, 2, 0, Math.PI * 2);
      g.fillStyle = "rgba(190,230,255,0.9)";
      g.fill();
      // 文字
      g.textBaseline = "top";
      g.fillStyle = "rgba(226,240,255,0.95)";
      lines.forEach(function (line, li2) { g.fillText(line, bx + padx, by + pady + li2 * lineH); });
      g.font = "300 10px 'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', system-ui, sans-serif";
      g.fillStyle = "rgba(140,195,245,0.62)";
      g.fillText(extra, bx + padx, by + bh - pady - 10);
      g.restore();
    }
  }

  order.forEach(function (o, idx) {
    var w = Number(o.p.w) || 1;

    var base = hexToRgbStr(colors[o.p.layer === 'merged' && Number(o.p.depth) >= 2 ? 'merged2' : o.p.layer] || '#8b949e');
    var sp = starSprite(base);
    var r = Math.max(1.6, (2.2 + Math.min(4.5, w / 2.2)) * o.q.k);
    var twinkle = 0.85 + 0.15 * Math.sin(t * 1.7 + (idx % 17));
    // 记忆激活：从种子开始闪，再依次亮到扩散出来的点
    if (starState.activation && starState.actLoop) {
      var el = ((Date.now() - starState.actLoop) / 1000) % 3.6;
      var hop = starState.hitMap[o.p.id];
      if (hop != null) {
        var age = el - hop * 0.75;
        if (age > 0 && age < 0.9) {
          var k2 = age / 0.9;
          var b2 = Math.pow(1 - k2, 2.2) * (k2 < 0.18 ? 1.8 : 1);
          twinkle = twinkle + Math.min(1.4, b2);
        }
      }
    }

    // 外围光晕
    var heat = Math.max(0, Math.min(1, (w - 1) / 9));

    // 星核
    g.globalAlpha = Math.max(0.75, Math.min(1, twinkle));
    g.drawImage(sp, o.q.sx - r, o.q.sy - r, r * 2, r * 2);
    if (starState.selectedId && o.p.id === starState.selectedId) drawCallout();
    // 记忆激活：画一圈扩散的光环（看得很明显）
    if (starState.hitMap && starState.actLoop) {
      var elA = ((Date.now() - starState.actLoop) / 1000) % 3.6;
      var hopA = starState.hitMap[o.p.id];
      if (hopA != null) {
        var ageA = elA - hopA * 0.75;
        if (ageA > 0 && ageA < 0.75) {
          var prog = ageA / 0.75;
          var fade = 1 - prog;
          g.save();
          var coreR = r * (1 + prog * 3.2);
          var grd = g.createRadialGradient(o.q.sx, o.q.sy, 0, o.q.sx, o.q.sy, coreR);
          grd.addColorStop(0, 'rgba(255,255,255,' + (0.95 * fade).toFixed(3) + ')');
          grd.addColorStop(0.35, 'rgba(170,225,255,' + (0.65 * fade).toFixed(3) + ')');
          grd.addColorStop(1, 'rgba(120,190,255,0)');
          g.fillStyle = grd;
          g.beginPath();
          g.arc(o.q.sx, o.q.sy, coreR, 0, Math.PI * 2);
          g.fill();
          for (var ri = 0; ri < 2; ri++) {
            var pr = prog - ri * 0.18;
            if (pr <= 0) continue;
            g.globalAlpha = Math.max(0, (1 - pr)) * (ri ? 0.35 : 0.75);
            g.strokeStyle = 'rgba(190,235,255,0.95)';
            g.lineWidth = Math.max(0.8, (ri ? 1.2 : 2.4) * (1 - pr));
            g.beginPath();
            g.arc(o.q.sx, o.q.sy, r * (1.3 + pr * (ri ? 9 : 6)), 0, Math.PI * 2);
            g.stroke();
          }
          g.restore();
        }
      }
    }

    // 给 bloom 用的实心球（半径等于星核，不加渐变）
    bg.globalAlpha = 1;
    bg.beginPath();
    bg.arc(o.q.sx, o.q.sy, r, 0, Math.PI * 2);
    bg.fillStyle = base;
    bg.fill();

    // 只有最重的几颗有十字光芒；越近越明显，拉远了就消失
    var spikeScore = Math.max(0.08, Math.min(1, (w - 1) / 9));   // 每颗都有，重的长
    var nearEnough = Math.max(0, Math.min(1, (o.q.k - 0.55) / 0.45));  // 太远就看不见
    if (nearEnough > 0.02) {
      var vary = 0.6 + ((idx % 7) / 7) * 0.8;         // 每颗长短不一样
      var len = r * (2.0 + spikeScore * 5.5) * vary;
      var sa = (0.22 + spikeScore * 0.42) * twinkle * nearEnough;
      g.globalAlpha = 1;
      g.lineWidth = Math.max(0.5, r * 0.12);
      // 横芒：中间亮，两端透明
      var gx = g.createLinearGradient(o.q.sx - len, o.q.sy, o.q.sx + len, o.q.sy);
      gx.addColorStop(0, 'rgba(255,255,255,0)');
      gx.addColorStop(0.5, 'rgba(255,255,255,' + sa.toFixed(3) + ')');
      gx.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = gx;
      g.beginPath();
      g.moveTo(o.q.sx - len, o.q.sy); g.lineTo(o.q.sx + len, o.q.sy);
      g.stroke();
      // 竖芒
      var gy = g.createLinearGradient(o.q.sx, o.q.sy - len, o.q.sx, o.q.sy + len);
      gy.addColorStop(0, 'rgba(255,255,255,0)');
      gy.addColorStop(0.5, 'rgba(255,255,255,' + sa.toFixed(3) + ')');
      gy.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = gy;
      g.beginPath();
      g.moveTo(o.q.sx, o.q.sy - len); g.lineTo(o.q.sx, o.q.sy + len);
      g.stroke();
    }
  });
  if (starState._box) {
    g.save();
    g.beginPath();
    g.rect(starState._box.x, starState._box.y, starState._box.w, starState._box.h);
    g.clip();
    NEAR_ONLY = true; drawEdges(); NEAR_ONLY = false;
    g.restore();
  } else {
    NEAR_ONLY = true; drawEdges(); NEAR_ONLY = false;
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  // bloom：把画面模糊一份叠回去，亮点自然炸开柔光
  try {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.filter = 'blur(9px)';
    g.globalAlpha = 0.85;
    g.drawImage(bs, 0, 0);
    g.filter = 'none';
    g.restore();
  } catch (e) {}


  if (info) {
    var n = starState.pts.length;
    var core = starState.pts.filter(function (p) { return p.layer === 'core'; }).length;
    info.textContent = starState.info || (n + ' 条记忆 · ' + core + ' 条核心 · 红=核心 蓝=事件 绿=语义 黄=工作 · 拖动转 / 滚轮缩放 / 点星聚焦，点空白回到整体');
  }
}

// 聚焦动画：镜头慢慢移过去
function starAnimate() {
  var need = false;
  if (starState.wantFocus) {
    var f = starState.wantFocus;
    ['x', 'y', 'z'].forEach(function (k) {
      starState.focus[k] += (f[k] - starState.focus[k]) * 0.045;   // 慢一点，飘过去
      if (Math.abs(f[k] - starState.focus[k]) > 0.001) need = true;
    });
    if (starState.zoomTo != null) {
      starState.dist += (starState.zoomTo - starState.dist) * 0.05;
      if (Math.abs(starState.zoomTo - starState.dist) > 0.01) need = true;
      else starState.zoomTo = null;
    }
  }
  if (starState.actLoop && starState.hitMap) need = true;   // 一直按最近一次调取循环
  renderStarMap();
  if (need) requestAnimationFrame(starAnimate);
}

// 全屏看星图
function toggleStarFullscreen() {
  var wrap = document.getElementById('starmapwrap') || document.getElementById('starmap');
  if (!wrap) return;
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (wrap.requestFullscreen) wrap.requestFullscreen();
}

// 全屏切换时调整画布尺寸
setInterval(pollActivation, 3000);
document.addEventListener('fullscreenchange', function () {
  var cv = document.getElementById('starmap');
  if (!cv) return;
  if (document.fullscreenElement) {
    var box = cv.parentElement;
    cv.width = Math.max(640, box.clientWidth);
    cv.height = Math.max(420, box.clientHeight - 60);
  } else {
    cv.width = 640;
    cv.height = 420;
  }
  renderStarMap();
});

// 拉最近一次记忆激活，用来做"星光爆发"动画
function pollActivation() {
  api('/api/star/activation').then(function (a) {
    if (!a || !a.at) return;
    if (starState.actAt === a.at) return;
    starState.activation = a;
    starState.actAt = a.at;
    starState.actLoop = Date.now();
    // 一次整理好：id → 第几跳。每帧再算会卡
    var map = {}, maxHop = 0;
    (a.hits || []).forEach(function (h) {
      if (!h || !h.id) return;
      var hop = Number(h.hop) || 0;
      if (map[h.id] == null || hop < map[h.id]) map[h.id] = hop;
      if (hop > maxHop) maxHop = hop;
    });
    // 全是同一跳（没有统辖扩散）时，按激活强度分三层，动画才看得出层次
    if (maxHop === 0 && (a.hits || []).length > 3) {
      var ids = (a.hits || []).filter(function (h) { return h && h.id; })
        .slice().sort(function (x, y) { return (y.act || 0) - (x.act || 0); });
      var per = Math.max(2, Math.ceil(ids.length / 3));
      ids.forEach(function (h, i) {
        map[h.id] = Math.min(2, Math.floor(i / per));
      });
      maxHop = 2;
    }
    starState.hitMap = map;
    starState.maxHop = maxHop;
    try { requestAnimationFrame(starAnimate); } catch (e) {}
  }).catch(function () {});
}

function drawStarMap() {
  var cv = document.getElementById('starmap');
  if (!cv || !cv.getContext) return;
  renderStarMap();
  if (!cv.dataset.wired) {
    cv.dataset.wired = '1';
    cv.style.cursor = 'grab';
    cv.addEventListener('mousedown', function (e) {
      starState.dragging = { x: e.clientX, y: e.clientY };
      starState.downAt = { x: e.clientX, y: e.clientY };
      starState.moved = 0;
      cv.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', function () {
      starState.dragging = null;
      cv.style.cursor = 'grab';
    });
    window.addEventListener('mousemove', function (e) {
      if (!starState.dragging) return;
      starState.moved += Math.abs(e.clientX - starState.dragging.x) + Math.abs(e.clientY - starState.dragging.y);
      starState.wantFocus = null;
      starState.yaw += (e.clientX - starState.dragging.x) * 0.01;
      starState.pitch = Math.max(-1.4, Math.min(1.4, starState.pitch + (e.clientY - starState.dragging.y) * 0.01));
      starState.dragging = { x: e.clientX, y: e.clientY };
      if (!(starState.actLoop && starState.hitMap)) renderStarMap();   // 动画在跑就交给帧循环
    });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      starState.zoomTo = null;   // 手动缩放优先
      // 向下滚 = 拉近（和你手的方向一致）
      starState.dist = Math.max(0.16, Math.min(9, starState.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      if (!(starState.actLoop && starState.hitMap)) renderStarMap();
    }, { passive: false });
    cv.addEventListener('click', function (e) {
      if (!starState.pts) return;
      // 拖动过就别当点击（松手那一下不算）
      if ((starState.moved || 0) > 6) return;
      var rect = cv.getBoundingClientRect();
      var mx = (e.clientX - rect.left) * (cv.width / rect.width);
      var my = (e.clientY - rect.top) * (cv.height / rect.height);
      var best = null, bd = 18;
      starState.pts.forEach(function (p) {
        var q = starProject(p, cv.width, cv.height);
        var d = Math.hypot(q.sx - mx, q.sy - my);
        if (d < bd) { bd = d; best = p; }
      });
      if (!best) {
        // 点空白：回到整体视角
        starState.wantFocus = { x: 0, y: 0, z: 0 };
        starState.info = '';
        starState.selectedId = null;
        starState.zoomTo = 3.6;
        requestAnimationFrame(starAnimate);
        return;
      }
      if (best) {
        starState.wantFocus = { x: best.x, y: best.y, z: best.z };
        starState.zoomTo = 0.16;   // 聚焦：推得更近
        starState.info = '「' + best.text + '」 · ' + best.layer + ' · ' + best.w + ' 分';
        starState.selectedId = best.id || null;
        requestAnimationFrame(starAnimate);
      }
    });
  }
  if (starState.pts) { renderStarMap(); return; }
  api('/api/vectors/map').then(function (d) {
    if (!d || !d.points) { renderStarMap(); return; }
    starState.pts = d.points;
    starState.edges = d.edges || [];
    renderStarMap();
  }).catch(function () {});
}
if (typeof window !== 'undefined') window.drawStarMap = drawStarMap;


// 页面一打开就先画星图（概览是默认页，不点导航也要画）
(function () {
  function boot() {
    var info = document.getElementById('starmapinfo');
    if (info) info.textContent = '正在算星图…';
    try {
      if (typeof drawStarMap === 'function') drawStarMap();
    } catch (err) {
      if (info) info.textContent = '星图出错：' + (err && err.message ? err.message : err);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 150); });
  else setTimeout(boot, 150);
})();


// ---------------- 人格包：导出 / 导入 ----------------
function exportPersona() {
  var hint = document.getElementById('packHint');
  if (hint) hint.textContent = '正在打包…';
  var name = (window.__personaName || '阿糯');
  window.location.href = '/api/pack/export?name=' + encodeURIComponent(name);
  setTimeout(function () { if (hint) hint.textContent = '已开始下载'; }, 800);
}

function pickPersonaFile() {
  var f = document.getElementById('packFile');
  if (f) f.click();
}

function importPersona(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  var hint = document.getElementById('packHint');
  if (!confirm('导入会替换掉现在的记忆和人设（会先自动备份一份）。确定？')) { input.value = ''; return; }
  if (hint) hint.textContent = '导入中…';
  var reader = new FileReader();
  reader.onload = function () {
    fetch('/api/pack/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: reader.result })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { if (hint) hint.textContent = '失败：' + d.error; return; }
        if (hint) hint.textContent = '导入完成（' + d.written + ' 个文件），重启后生效';
      })
      .catch(function (e) { if (hint) hint.textContent = '失败：' + e.message; });
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}


// ---------------- 首次设置提醒 ----------------
function checkSetup() {
  api('/api/setup/status').then(function (d) {
    if (!d || d.ok) return;
    var box = document.getElementById('setupBanner');
    if (!box) return;
    var names = d.need.filter(function (x) { return !x.done && x.required; }).map(function (x) { return x.zh; });
    box.innerHTML = '<b>还没配好，她现在用不了：</b>' + names.join('、') +
      '<br><span style="font-size:11.5px;opacity:.8">在「设置」里填上，保存后重启一次</span>' +
      ' <button class="act mini" onclick="gotoSettings()">去设置</button>';
    box.style.display = 'block';
  }).catch(function () {});
}

function gotoSettings() {
  var tabs = document.querySelectorAll('[data-tab]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].dataset.tab === 'settings') { tabs[i].click(); break; }
  }
}

setTimeout(checkSetup, 1500);
