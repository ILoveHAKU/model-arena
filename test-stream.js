// 单元测试：代码出图模式的流式链路（readStream / ssePickOpenAI / ssePickAnthropic / pickReply / codeGen）
// 这三个函数在 index.html 里是连续的一段，测试直接从页面源码中切出那一段来跑（真正在跑的代码），
// 只在测试里替换掉它依赖的 apiFetchRaw（改用 Node 的 Response 喂 SSE 文本）。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''));
};

// ---- 切出流式链路那一段（从 ssePickOpenAI 定义到 codeGen 结束）----
const start = src.indexOf('const ssePickOpenAI');
const endMark = src.indexOf('// SVG 模式作答：流式让模型吐 SVG 代码');
if (start < 0 || endMark < 0) { console.log('✗ 未能定位流式链路代码段'); process.exit(1); }
const block = src.slice(start, endMark);
for (const fn of ['readStream', 'ssePickOpenAI', 'ssePickAnthropic', 'codeChat', 'pickReply', 'codeGen']) {
  if (!block.includes(fn)) { console.log('✗ 代码段缺少 ' + fn); process.exit(1); }
}
ok('可从页面源码切出流式链路（readStream/codeChat/pickReply/codeGen）', true);

// extractSvg / parseVerdictJson 用页面真实实现，其余为测试桩
const grabFn = name => {
  const single = src.match(new RegExp('^function ' + name + '\\([^\\n]*\\n?', 'm'));
  if (single && single[0].includes('}')) return single[0];
  return src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'))[0];
};

const harness = `
${grabFn('extractSvg')}
${grabFn('parseVerdictJson')}
let __api = null;                                   // 测试注入：返回 {ok,status,headers,body,text()}，可拿到 (url,key,body,proto)
async function apiFetchRaw(){ return await __api(...arguments); }
async function apiFetch(){ throw new Error('unused'); }
async function withTransientRetry(fn){ return await fn(); }
async function httpErr(r){ const t=await r.text().catch(()=>''); let d=''; try{ const j=JSON.parse(t); d=(j.error&&(typeof j.error==='string'?j.error:j.error.message))||j.message||''; }catch(e){ d=t.slice(0,80) } return new Error('HTTP '+r.status+(d?'：'+d:'')); }
function apiUrl(base,path){ return base+path; }
${block}
return {readStream, ssePickOpenAI, ssePickAnthropic, pickReply, codeChat, codeGen, extractSvg, parseVerdictJson, setApi:fn=>{__api=fn}};
`;
let F;
try { F = new Function(harness)(); ok('测试夹具注入成功', true); }
catch (e) { ok('测试夹具注入成功', false, e.message); console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败'); process.exit(1); }

const sseOpenAI = parts => parts.map(p => 'data: ' + JSON.stringify(p) + '\n\n').join('') + 'data: [DONE]\n\n';
const sseAnthropic = parts => parts.map(p => 'event: x\ndata: ' + JSON.stringify(p) + '\n\n').join('');
const res = (body, ct = 'text/event-stream; charset=utf-8') => new Response(body, { status: 200, headers: { 'content-type': ct } });

(async () => {
  console.log('\nreadStream 测试（OpenAI SSE）：');
  const chunks = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">', '<rect width="512" height="512" fill="#1d7a4f"/>', '</svg>'];
  let r = await F.readStream(res(sseOpenAI([
    { choices: [{ index: 0, delta: { content: chunks[0] } }] },
    { choices: [{ index: 0, delta: { content: chunks[1] } }] },
    { choices: [{ index: 0, delta: { content: chunks[2] }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }
  ])).body, F.ssePickOpenAI);
  ok('多分片正文正确拼接', r.raw === chunks.join(''), r.raw);
  ok('读取到 finish_reason 与 usage', r.finish === 'stop' && r.usage && r.usage.completion_tokens === 20, r);

  r = await F.readStream(res(sseOpenAI([
    { choices: [{ index: 0, delta: { reasoning_content: '先想构图…' } }] },
    { choices: [{ index: 0, delta: { content: '<svg>ok</svg>' } }] }
  ])).body, F.ssePickOpenAI);
  ok('reasoning_content 单独收集，不污染正文', r.raw === '<svg>ok</svg>' && r.think === '先想构图…', r);

  r = await F.readStream(res(sseOpenAI([
    { choices: [{ index: 0, delta: { content: '<svg>被截断的代码' }, finish_reason: 'length' }] }
  ])).body, F.ssePickOpenAI);
  ok('截断时仍保住已收到的内容', r.raw === '<svg>被截断的代码' && r.finish === 'length', r);

  // 一次网络读取里只到了一半 JSON（真实网关很常见）→ 必须靠缓冲拼回来，不能半包解析失败就丢内容
  const halfPacket = 'data: {"choices":[{"delta":{"content":"半';
  const restPacket = '包被拆开"}}]}\n\ndata: [DONE]\n\n';
  r = await F.readStream(new Response(halfPacket + restPacket).body, F.ssePickOpenAI);
  ok('同一行被拆成两段时能拼回完整 JSON', r.raw === '半包被拆开', r.raw);

  r = await F.readStream(res('data: 这不是JSON\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n').body, F.ssePickOpenAI);
  ok('非法 JSON 行被跳过而不是抛错', r.raw === 'ok', r.raw);

  console.log('\nreadStream 测试（Anthropic SSE）：');
  r = await F.readStream(res(sseAnthropic([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考中' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<svg></svg>' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }
  ])).body, F.ssePickAnthropic);
  ok('Anthropic 文本块与思考块分别收集', r.raw === '<svg></svg>' && r.think === '思考中', r);
  ok('Anthropic 结束原因与用量可取', r.finish === 'end_turn' && r.usage && r.usage.output_tokens === 7, r);

  console.log('\npickReply 测试：');
  ok('正文优先', F.pickReply({ raw: 'CODE', think: 'THINK' }).text === 'CODE');
  let pr = F.pickReply({ raw: '   ', think: '  <svg>x</svg>  ' });
  ok('正文为空时改用思考内容并标注', pr.text.includes('<svg>x</svg>') && pr.tail.includes('改用思考内容'), pr);
  pr = F.pickReply({ raw: '', think: '', finish: 'length' });
  ok('两者都空时给出可诊断的说明', pr.text === '' && pr.tail.includes('预算被截断'), pr);
  ok('截断回复带 truncated 标记', pr.truncated === true, pr);
  pr = F.pickReply({ raw: '<svg>x</svg>', finish: 'stop' });
  ok('正常结束不带 truncated 标记', pr.truncated === false, pr);

  console.log('\ncodeChat 测试：');
  F.setApi(async () => res(sseOpenAI([{ choices: [{ delta: { content: '<b>hi</b>' } }] }])));
  ok('真流式响应走流式解析', (await F.codeChat({ genProto: 'openai' }, 'x', 100)).raw === '<b>hi</b>');
  // 只拒绝 stream_options（不认识该参数的网关很常见）→ 应去掉该参数后继续用流式，而不是退回非流式
  let shapes = [];
  F.setApi(async (url, key, body) => {
    shapes.push(body);
    if (body.stream_options) return new Response(JSON.stringify({ error: { message: 'unknown parameter: stream_options' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return res(sseOpenAI([{ choices: [{ delta: { content: '<u>stream-ok</u>' } }] }]));
  });
  const s1 = await F.codeChat({ genProto: 'openai' }, 'x', 100);
  ok('仅 stream_options 被拒时去掉它继续走流式', s1.raw === '<u>stream-ok</u>' && shapes.length === 2 && shapes[1].stream === true && !shapes[1].stream_options, { raw: s1.raw, shapes });
  // 完全不支持流式 → 退回非流式
  shapes = [];
  F.setApi(async (url, key, body) => {
    shapes.push(body);
    if (body.stream) return new Response(JSON.stringify({ error: { message: 'stream is not supported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<i>plain</i>' }, finish_reason: 'stop' }], usage: { completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const s2 = await F.codeChat({ genProto: 'openai' }, 'x', 100);
  ok('网关不支持流式时退回非流式并解析 message.content', s2.raw === '<i>plain</i>' && shapes.length === 3 && shapes[2].stream === false, { raw: s2.raw, shapes: shapes.length });
  F.setApi(async () => new Response(JSON.stringify({ choices: [{ message: { content: '<i>json</i>' } }], usage: { completion_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const jsonRes = await F.codeChat({ genProto: 'openai' }, 'x', 100);
  ok('网关无视 stream 参数直接回 JSON 时也能解析', jsonRes.raw === '<i>json</i>', jsonRes);
  F.setApi(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
  let msg = '';
  try { await F.codeChat({ genProto: 'openai' }, 'x', 100); } catch (e) { msg = e.message; }
  ok('5xx 直接抛错（交由上层退避重试）', /HTTP 500/.test(msg), msg);

  console.log('\ncodeGen 测试（逐级加预算 + 思考内容兜底）：');
  const bigSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1d7a4f"/></svg>';
  let attempt = 0;
  // 第一次只回思考内容，第二次回真代码
  F.setApi(async () => {
    attempt++;
    if (attempt === 1) return res(sseOpenAI([
      { choices: [{ delta: { reasoning_content: '思考中：先规划构图…' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 8000 } }
    ]));
    return res(sseOpenAI([{ choices: [{ delta: { content: bigSvg }, finish_reason: 'stop' }] }]));
  });
  const g = await F.codeGen({ genProto: 'openai', genModel: 'm' }, 'prompt', F.extractSvg, { what: 'SVG 代码', onProgress: () => {} });
  ok('第一次只给思考内容 → 自动加预算重试后拿到代码', g.code.includes('fill="#1d7a4f"') && attempt === 2, { attempt, code: (g.code || '').slice(0, 40) });
  ok('失败一次后会带上"第 2 次尝试"提示', g.tail !== undefined && typeof g.level === 'number' && g.level === 8000, { level: g.level });

  // 全失败：应抛出带诊断信息的错误，并把最长的回复留给上层展示
  attempt = 0;
  F.setApi(async () => res(sseOpenAI([{ choices: [{ delta: { reasoning_content: '只有思考，没有代码' }, finish_reason: 'length' }] }])));
  let err = null;
  try { await F.codeGen({ genProto: 'openai', genModel: 'm' }, 'prompt', F.extractSvg, { what: 'SVG 代码' }); }
  catch (e) { err = e; }
  ok('两次都抽不出代码时抛出诊断错误', !!err && /已尝试 2 次、最高 8000 tokens/.test(err.message), err && err.message);
  ok('错误对象带着原始回复（供「查看代码」展示）', !!err && err.raw.includes('只有思考，没有代码'), err && (err.raw || '').slice(0, 40));
  ok('诊断信息含思考/正文长度与截断原因', !!err && /思考内容 \d+ 字符、正文 0 字符/.test(err.message) && /预算被截断/.test(err.message), err && err.message);

  // 截断的半份 SVG 也要能用（extractSvg 负责补全闭合标签）
  F.setApi(async () => res(sseOpenAI([{ choices: [{ delta: { content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0f0"' }, finish_reason: 'length' }] }])));
  const half = await F.codeGen({ genProto: 'openai', genModel: 'm' }, 'prompt', F.extractSvg, { what: 'SVG 代码' });
  ok('被截断的半份 SVG 也能提取（extractSvg 自动补闭合）', half.code.includes('fill="#0f0"') && half.code.includes('</svg>'), (half.code || '').slice(0, 90));

  console.log('\ncodeGen 截断防线测试：');
  // 第一次回复被截断（finish=length）但抽得出代码 → 不立刻采用，加预算重试拿完整版
  //（真实场景：推理型模型边想边写，8000 tokens 时正文已是一份烂尾草稿）
  attempt = 0;
  F.setApi(async () => {
    attempt++;
    if (attempt === 1) return res(sseOpenAI([{ choices: [{ delta: { content: bigSvg.slice(0, 80) }, finish_reason: 'length' }] }]));
    return res(sseOpenAI([{ choices: [{ delta: { content: bigSvg }, finish_reason: 'stop' }] }]));
  });
  const tr = await F.codeGen({ genProto: 'openai', genModel: 'm' }, 'prompt', F.extractSvg, { what: 'SVG 代码' });
  ok('被截断的回复不直接采用，加预算重试后拿到完整代码', attempt === 2 && tr.code.includes('fill="#1d7a4f"') && tr.code.endsWith('</svg>'), { attempt, code: (tr.code || '').slice(0, 50) });
  // 两次都被截断但都抽得出可渲染片段 → 兜底采用其中一版，不再抛"没有可用代码"
  attempt = 0;
  F.setApi(async () => {
    attempt++;
    return res(sseOpenAI([{ choices: [{ delta: { content: bigSvg.slice(0, 81 + attempt) }, finish_reason: 'length' }] }]));
  });
  const tr2 = await F.codeGen({ genProto: 'openai', genModel: 'm' }, 'prompt', F.extractSvg, { what: 'SVG 代码' });
  ok('多次截断时兜底采用可渲染版本而不报错', typeof tr2.code === 'string' && tr2.code.startsWith('<svg'), (tr2.code || '').slice(0, 60));

  console.log('\nparseVerdictJson 评审解析测试：');
  let pv = F.parseVerdictJson('{"score":86,"comment":"构图清晰，主体准确"}');
  ok('正常评审 JSON 解析', pv.score === 86 && pv.comment === '构图清晰，主体准确', pv);
  pv = F.parseVerdictJson('{"score":"77","comment":"分数写成了字符串"}');
  ok('分数写成字符串也能解析', pv.score === 77 && pv.comment === '分数写成了字符串', pv);
  pv = F.parseVerdictJson('{"score":8,"comment":"画面仅为零散线条，未见鹈鹕与自行车主体，完全不符题');
  ok('被 max_tokens 掐断的评审 JSON 也能抠出分数与点评', pv.score === 8 && pv.comment.includes('画面仅为'), pv);
  pv = F.parseVerdictJson('好的。{"score": 72, "comment": "还行"} 以上。');
  ok('JSON 夹在解释文字里也能解析', pv.score === 72 && pv.comment === '还行', pv);
  pv = F.parseVerdictJson('{"score"');
  ok('score 后被掐断且无点评 → 分数空但不抛错', pv.score === null, pv);
  pv = F.parseVerdictJson('我欣赏这幅作品。');
  ok('完全没有 JSON → 分数空、原文留档', pv.score === null && pv.comment.includes('我欣赏'), pv);

  console.log('\nparseVerdictJson 模板复述防线测试（带思考的裁判会复述提示词里的 JSON 模板）：');
  const TPL = '{"score":0到100整数,"comment":"不超过40字的中文点评"}';
  pv = F.parseVerdictJson('我需要按 ' + TPL + ' 的格式输出评分。画面里鹈鹕骑自行车，主体清晰，我给 78 分。');
  ok('复述模板不得被抠成 0 分', pv.score === null, pv);
  pv = F.parseVerdictJson('按 ' + TPL + ' 格式。结论：{"score":78,"comment":"鹈鹕骑车，构图清晰"}');
  ok('思考里的模板之后有真评分 → 取真分', pv.score === 78 && pv.comment === '鹈鹕骑车，构图清晰', pv);
  pv = F.parseVerdictJson('{"score":0,"comment":"画面空白"}');
  ok('真实的 0 分（数字后是逗号）正常保留', pv.score === 0 && pv.comment === '画面空白', pv);
  pv = F.parseVerdictJson('{"score":0到100,"comment":"x"}');
  ok('数字后紧跟中文的假分数被拒绝', pv.score === null, pv);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
