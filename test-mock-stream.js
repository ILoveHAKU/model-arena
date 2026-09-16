// 冒烟测试：直接向 mock 网关发流式请求，确认 SSE 分片能被解析、推理模型场景能复现线上报错
// 需要先起 mock（node mock-server.js 8799，或由 run-e2e.ps1 拉起）
const http = require('http');
const PORT = Number(process.argv[2] || 8799);

// 页面里的流式解析器（从 index.html 切出来跑真实实现）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const start = src.indexOf('const ssePickOpenAI');
const endMark = src.indexOf('// SVG 模式作答：流式让模型吐 SVG 代码');
const block = src.slice(start, endMark);
const F = new Function(block + '\nreturn {readStream, ssePickOpenAI, pickReply, nonStreamPick};')();

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, e !== undefined ? '→ ' + JSON.stringify(e).slice(0, 200) : '')); };

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-mock', 'Content-Length': Buffer.byteLength(data) } }, r => res(r));
    req.on('error', rej);
    req.end(data);
  });
}
// 用页面里的 readStream 读网关返回的流
async function streamOnce(model, extra) {
  const r = await post('/v1/chat/completions', Object.assign({ model, stream: true, max_tokens: 8000, messages: [{ role: 'user', content: '你是 SVG 绘图引擎。请画出：一只鹈鹕骑自行车' }] }, extra || {}));
  const ct = String(r.headers['content-type'] || '');
  if (!/event-stream/.test(ct)) return { raw: await collect(r), ct, status: r.statusCode };
  const out = await F.readStream(WebStream(r), F.ssePickOpenAI);
  return Object.assign(out, { ct, status: r.statusCode });
}
// Node 的 http.IncomingMessage → Web ReadableStream
function WebStream(msg) {
  return new ReadableStream({
    start(c) { msg.on('data', d => c.enqueue(new Uint8Array(d))); msg.on('end', () => c.close()); msg.on('error', e => c.error(e)); }
  });
}
// Node 的 IncomingMessage → 完整文本（非流式分支用）
function collect(msg) {
  return new Promise((res, rej) => { let b = ''; msg.on('data', d => b += d); msg.on('end', () => res(b)); msg.on('error', rej); });
}

(async () => {
  console.log('流式冒烟测试（mock 网关 ' + PORT + '）：');
  let r;
  try { r = await streamOnce('mock-svg-1'); }
  catch (e) { console.log('✗ 连不上 mock 网关（先起 mock-server.js）:', e.message); process.exit(1); }

  ok('网关返回 text/event-stream', /event-stream/.test(r.ct), r.ct);
  ok('流式 SVG 完整拼出（含画布与图形元素）', /<svg/i.test(r.raw) && /<rect/i.test(r.raw), (r.raw || '').slice(0, 80));
  ok('流式也带回 usage 与 finish_reason', !!r.usage && r.finish === 'stop', { usage: r.usage, finish: r.finish });

  // SVG 推理模型在预算 < 5000 时只吐思考内容
  const r2 = await streamOnce('mock-svg-reasoner-1', { max_tokens: 4000 });
  ok('推理模型场景：只有思考内容、正文为空（复现线上"回复为空"）', !r2.raw.trim() && r2.think.length > 0, { raw: r2.raw, think: r2.think && r2.think.slice(0, 40) });
  ok('推理模型场景：finish_reason=length（预算被思考吃光）', r2.finish === 'length', r2.finish);
  const picked = F.pickReply(r2);
  ok('pickReply 会把思考内容兜回来并标注', picked.text.includes('构图') && picked.tail.includes('改用思考内容'), picked);

  const r3 = await streamOnce('mock-svg-1', { stream: undefined });   // 非流式
  const j3 = JSON.parse(r3.raw);
  const got3 = F.nonStreamPick(j3);
  ok('非流式 JSON 路径也能解析出 SVG（message.content）', /<svg/i.test(got3.text), got3.text.slice(0, 60));

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
