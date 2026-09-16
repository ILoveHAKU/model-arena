// 端到端测试专用静态服务：在真实 index.html 里注入「预置配置 + 自动开考 + 输出结果」脚本，
// 配合 Chrome headless --dump-dom 使用（本机 agent-browser 不可用时的替代方案）。
// 用法：node e2e-serve.js <port> <scenario>
//   scenario: svg | svg-bad | prompt-undefined | codegen-fail
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PORT = Number(process.argv[2] || 8090);
const SCENARIO = process.argv[3] || 'svg';
const MOCK = 'http://127.0.0.1:' + (process.env.MOCK_PORT || 8787) + '/v1';

const SCENARIOS = {
  'svg': { genMode: 'svg', genModel: 'mock-svg-1', judgeModel: 'mock-vision-1', prompt: '一只鹈鹕骑自行车' },
  'svg-bad': { genMode: 'svg', genModel: 'mock-svg-bad-1', judgeModel: 'mock-vision-1', prompt: '一只鹈鹕骑自行车' },
  // 关键回归：存储里没有 prompt 字段（老配置）时，实际发出去的题目不能是 "undefined"
  'prompt-missing': { genMode: 'svg', genModel: 'mock-svg-1', judgeModel: 'mock-vision-1', dropPrompt: true },
  'codegen-fail': { genMode: 'svg', genModel: 'mock-svg-broken-1', judgeModel: 'mock-vision-1', prompt: '一只鹈鹕骑自行车' }
};

function buildCfg(s) {
  const c = {
    genMode: s.genMode, genProto: 'openai', genBase: MOCK, genKey: 'sk-mock', genModel: s.genModel,
    genSize: '512x512', genQuality: 'low',
    judgeProto: 'openai', judgeBase: MOCK, judgeKey: 'sk-mock', judgeModel: s.judgeModel
  };
  if (!s.dropPrompt) c.prompt = s.prompt;
  return c;
}

function RUNNER(scenario, cfgJson) { return `
<pre id="__e2e" style="white-space:pre-wrap;font:12px monospace">PENDING</pre>
<script>
(function(){
  var SCEN='${scenario}', FLAG='__e2e_seeded_'+SCEN;
  // 第一步：把测试配置写进 localStorage 后重载一次（页面加载时就已读过配置，必须刷新才生效）
  try{
    if(!localStorage.getItem(FLAG)){
      localStorage.setItem('arena_cfg_v1', JSON.stringify(${cfgJson}));
      localStorage.setItem(FLAG,'1');
      location.reload();
      return;
    }
  }catch(e){}

  var t0=Date.now(), doneOnce=false, phase='boot';
  var el=function(){ return document.getElementById('__e2e'); };
  function mark(p, extra){
    phase=p;
    try{ el().textContent='PHASE '+p+(extra?(' '+extra):''); }catch(e){}
    try{ fetch('/__phase?p='+encodeURIComponent(p+' '+(extra||''))); }catch(e){}
  }
  function out(o){
    if(doneOnce) return; doneOnce=true;
    try{ o.elapsed=Date.now()-t0; }catch(e){}
    o.scen=SCEN;
    var txt='E2E_RESULT '+JSON.stringify(o);
    try{ el().textContent=txt; }catch(e){}
    for(var k=0;k<3;k++){ try{ fetch('/__result',{method:'POST',body:txt}); }catch(e){} }
  }
  function snap(tag){
    var h=(typeof history!=='undefined' && history[0])||{};
    return {tag:tag, n:(typeof history!=='undefined'?history.length:-1), type:h.type, mode:h.mode, model:h.model,
      score:h.score, self:h.selfScore, judge:h.judgeScore, hasImg:!!h.img, imgLen:(h.img||'').length,
      codeLen:((h.code||h.svg||'')+'').length, comment:((h.comment||'')+'').slice(0,180),
      verdict:(document.getElementById('verdictText')||{}).textContent,
      usage:((document.getElementById('usageRow')||{}).textContent||'').slice(0,160),
      promptSent:((typeof lastPromptText!=='undefined'?lastPromptText:'')+'').slice(0,320),
      promptHasUndef: /undefined/.test((typeof lastPromptText!=='undefined'?lastPromptText:'')+'')};
  }
  function go(){
    try{
      mark('init');
      var pre={};
      try{ if(typeof loadSettings==='function') loadSettings();
        var c=(typeof getCfg==='function')?getCfg():{};
        pre={genModel:c.genModel, prompt:c.prompt, genMode:c.genMode};
      }catch(e){ pre={cfgErr:String(e&&e.message||e)}; }
      mark('calling', JSON.stringify(pre));
      try{ runArena(); }catch(e){ out({phase:'sync-throw', err:String(e&&e.message||e), cfg:pre}); return; }
      var LIMIT=12000;
      var iv=setInterval(function(){
        var h=(typeof history!=='undefined' && history[0])||null;
        var errEl=document.getElementById('commentText');
        var isErr=errEl && errEl.classList.contains('err');
        var left=LIMIT-(Date.now()-t0);
        mark('waiting', 'left='+left+' hist='+((typeof history!=='undefined')?history.length:'?')+' err='+!!isErr);
        if(h || isErr || left<=0){
          clearInterval(iv);
          var s=snap('after-arena'); s.cfgRead=pre;
          if(isErr) s.errorText=(errEl.textContent||'').slice(0,400);
          out(s);
        }
      },400);
    }catch(e){ out({phase:'boot', err:String(e&&e.message||e)}); }
  }
  if(document.readyState==='complete') setTimeout(go,60);
  else window.addEventListener('load',function(){ setTimeout(go,60); });
})();
</script>
`; }

http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && urlPath === '/__result') {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      fs.writeFileSync(path.join(DIR, '_e2e-result.json'), buf);
      console.log(buf);
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
    });
    return;
  }
  const file = urlPath === '/' ? '/index.html' : urlPath;
  if (urlPath !== '/__phase') console.log(new Date().toISOString().slice(11, 19), req.method, urlPath);
  if (urlPath === '/__phase') { console.log('   PHASE', decodeURIComponent((req.url.split('p=')[1] || ''))); res.end('ok'); return; }
  const full = path.join(DIR, file);
  if (!full.startsWith(DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  let body = fs.readFileSync(full);
  const isHtml = file.endsWith('.html');
  if (isHtml) {
    // 配置 + 测试脚本都追加到文档最末尾：页面里别处也可能出现 "</body>" 字样，用替换会插错位置
    const q = (req.url.split('?')[1] || '');
    const m = /(?:^|&)s=([^&]+)/.exec(q);
    const sc = m ? decodeURIComponent(m[1]) : SCENARIO;
    const spec = SCENARIOS[sc] || SCENARIOS.svg;
    let html = body.toString('utf8');
    html = html + RUNNER(sc, JSON.stringify(buildCfg(spec)));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log('e2e server on http://127.0.0.1:' + PORT + '  scenario=' + SCENARIO));
