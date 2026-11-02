// 首次设置页：只做一件事 —— 把她配置起来
// 由 launcher 提供，机器人没起来也能打开

export const SETUP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>先把她配置起来</title>
<style>
:root{--bg:#16181d;--card:#1f232b;--line:#2c3138;--txt:#e6e8ea;--dim:#8b939c;--main:#6ea8fe;--ok:#4ec98b;--warn:#f0b45a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px 16px 60px}
.wrap{max-width:620px;margin:0 auto}
h1{font-size:20px;margin:0 0 6px}
.sub{color:var(--dim);font-size:13px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 16px 6px;margin-bottom:14px}
.card h2{font-size:13.5px;color:var(--main);margin:0 0 12px;font-weight:600}
label{display:block;font-size:12.5px;color:var(--dim);margin:10px 0 4px}
input,textarea{width:100%;background:#12141a;border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:9px 11px;font:inherit;outline:none}
input:focus,textarea:focus{border-color:var(--main)}
textarea{min-height:110px;resize:vertical}
.hint{font-size:11.5px;color:#6b737c;margin:4px 0 10px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.opt{display:flex;gap:18px;margin:10px 0 4px;font-size:13px}
.opt label{display:flex;align-items:center;gap:6px;color:var(--txt);margin:0}
.opt input{width:auto}
button{width:100%;padding:12px;border:0;border-radius:10px;background:var(--main);color:#0d1117;font-size:15px;font-weight:600;cursor:pointer;margin-top:18px}
button:disabled{opacity:.5;cursor:default}
#msg{margin-top:14px;font-size:13px;min-height:20px}
.ok{color:var(--ok)}.err{color:#ff7b72}
</style></head>
<body>
<div class="wrap">
  <h1>先把她配置起来</h1>
  <div class="sub">填完点最下面那个按钮。只需要一次，以后在面板里改。</div>

  <div class="card">
    <h2>一、大模型</h2>
    <label>聊天用的 API Key（必填）</label>
    <input id="llm" placeholder="sk-...">
    <label>记忆向量 Key（必填，可以和上面填同一个）</label>
    <input id="embed" placeholder="sk-...">
    <label>看图 Key（可选，留空就不能看图）</label>
    <input id="vision" placeholder="sk-...">
    <div class="hint">记忆靠向量检索 —— 这一项必须能调通，否则她记得但想不起来。</div>
  </div>

  <div class="card">
    <h2>二、QQ 连接</h2>
    <label>协议端地址</label>
    <input id="ws" value="ws://127.0.0.1:3001">
    <div class="row">
      <div><label>机器人 QQ 号</label><input id="self" placeholder="3902064605"></div>
      <div><label>主人 QQ 号</label><input id="owner" placeholder="15125287"></div>
    </div>
    <div class="hint">协议端是 SnowLuma，它自己负责扫码登录。</div>
  </div>

  <div class="card">
    <h2>三、安全</h2>
    <label>面板密码（可选）</label>
    <input id="pwd" placeholder="不填就只有本机能打开">
    <div class="hint">想让手机访问就必须填。</div>
  </div>

  <div class="card">
    <h2>四、她是谁</h2>
    <div class="opt">
      <label><input type="radio" name="who" value="import" checked> 导入现成的人格（.ano）</label>
      <label><input type="radio" name="who" value="fresh"> 从空白开始</label>
    </div>
    <div id="boxImport">
      <label>选择人格包</label>
      <input type="file" id="file" accept=".ano,.zip">
      <div class="hint">人格包里是她的人设和记忆。<b>不包含 key</b>，所以要在这里填。</div>
    </div>
    <div id="boxFresh" style="display:none">
      <label>她是谁（人设，可留空）</label>
      <textarea id="persona" placeholder="比如：阿糯，18 岁，说话带点软糯的尾音，叫主人「主人」，有点小傲娇但很黏人…"></textarea>
      <div class="hint">留空也能用，只是她没什么个性。</div>
    </div>
  </div>

  <button id="go" onclick="submitForm()">开 始</button>
  <div id="msg"></div>
</div>

<script>
document.querySelectorAll('input[name=who]').forEach(function(r){
  r.onchange = function(){
    var imp = document.querySelector('input[name=who]:checked').value === 'import';
    document.getElementById('boxImport').style.display = imp ? '' : 'none';
    document.getElementById('boxFresh').style.display = imp ? 'none' : '';
  };
});

function val(id){ return (document.getElementById(id).value || '').trim(); }
function say(t, cls){ var m = document.getElementById('msg'); m.className = cls || ''; m.textContent = t; }

function readFileAsBase64(file){
  return new Promise(function(res, rej){
    var fr = new FileReader();
    fr.onload = function(){
      var s = String(fr.result);
      res(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

async function submitForm(){
  var btn = document.getElementById('go');
  var body = {
    llm: val('llm'), embed: val('embed'), vision: val('vision'),
    ws: val('ws'), self: val('self'), owner: val('owner'), pwd: val('pwd'),
    mode: document.querySelector('input[name=who]:checked').value,
    persona: val('persona'),
    pack: ''
  };
  if (!body.llm) return say('聊天用的 key 还没填', 'err');
  if (!body.embed) return say('记忆向量 key 还没填', 'err');
  if (!body.self || !body.owner) return say('QQ 号还没填全', 'err');

  var f = document.getElementById('file').files[0];
  if (body.mode === 'import') {
    if (!f) return say('选了"导入人格"，但没选文件', 'err');
    body.pack = await readFileAsBase64(f);
  }

  btn.disabled = true;
  say('正在保存…');
  try {
    var r = await fetch('/api/setup/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.error) { say('失败：' + d.error, 'err'); btn.disabled = false; return; }
    say('配置好了，正在启动她…（约 20 秒）', 'ok');
    setTimeout(function(){ location.href = '/'; }, 22000);
  } catch (e) {
    say('失败：' + e.message, 'err');
    btn.disabled = false;
  }
}
</script>
</body></html>`;
