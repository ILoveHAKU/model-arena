// Mock API server: OpenAI + Anthropic 双协议模拟，用于 model-arena 端到端测试
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || process.env.PORT || 8787); // 端口：命令行参数优先（沙箱下不便传环境变量）
const KEY = 'sk-mock';
const INDEX_PATH = path.join(__dirname, 'index.html'); // 同时把页面本体挂在 / 上，浏览器测试可直接开
// 1x1 红色 PNG
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// SVG 出图模式的模拟作品（鹈鹕骑自行车简笔）
const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#eef7f1"/><circle cx="330" cy="370" r="34" fill="#333"/><circle cx="230" cy="370" r="34" fill="#333"/><path d="M120 330 L360 320" stroke="#333" stroke-width="7"/><circle cx="150" cy="150" r="46" fill="#fff" stroke="#f0b429" stroke-width="4"/><path d="M150 150 q28 55 -8 95" stroke="#f5a623" stroke-width="9" fill="none"/><rect x="185" y="215" width="120" height="70" rx="12" fill="#1d7a4f"/><text x="256" y="470" font-size="22" text-anchor="middle" fill="#1d7a4f">pelican on a bicycle</text></svg>';
// 「脏」代码：含 <script>、on* 事件、&nbsp; 等 HTML 命名实体、未转义的 & 、未闭合的标签、缺少 </svg> —— 复现「SVG 无法渲染」报错
const MOCK_SVG_DIRTY = '<svg viewBox="0 0 512 512"><script>alert(1)</script>\n<rect width="512" height="512" fill="#eef7f1" onload="steal()"/>\n<text x="256" y="240" font-size="26" text-anchor="middle" fill="#1d7a4f">鹈鹕&nbsp;骑&nbsp;自行车 & 好累</text>\n<circle cx="200" cy="330" r="46" fill="#f0b429">';
// 「坏」代码：注释里含 </svg>，导致抽取后被截断成未闭合注释 —— 连自动修复也救不回来 → 应触发「回贴给模型自修」兜底
const MOCK_SVG_BROKEN = '<svg viewBox="0 0 512 512"><!-- pelican </svg> on bicycle --><circle cx="200" cy="330" r="46" fill="#f0b429"/></svg>';
// 截断的半份 SVG（finish=length 时吐出）：抽得出但渲染不出来 → 验证「截断的回复不直接采用，加预算重试」
const MOCK_SVG_DRAFT = MOCK_SVG.slice(0, 180);

// SVG 出图模式的回复构造：按模型名模拟各种真实风格（脏代码 / 坏代码 / 围栏 / 片段 / 首轮空响应）
function svgOut(model) {
  const m = model || '';
  if (m.includes('svg-explode')) return '抱歉，我今天不想画图。';                        // 完全不给代码 → 抽取失败
  if (m.includes('svg-md')) return '```svg\n' + MOCK_SVG + '\n```';                      // markdown 围栏
  if (m.includes('svg-explain')) return '好的，这是你要的 SVG：\n' + MOCK_SVG + '\n希望满意！'; // 前后夹解释
  if (m.includes('svg-dirty')) return MOCK_SVG_DIRTY;                                    // 需要净化/修复
  if (m.includes('svg-broken')) return MOCK_SVG_BROKEN;                                  // 修复也救不回 → 模型自修兜底
  return MOCK_SVG;
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
// ---- SSE 流式响应：复现真实网关的两种风格 ----
// kind='content' 正常流式吐代码；kind='reasoner' 只吐 reasoning_content、正文为空（思考烧光输出预算，正是线上报错的场景）
function streamSSE(res, model, opts) {
  opts = opts || {};
  const openai = opts.protocol !== 'anthropic';
  const text = opts.text !== undefined ? opts.text : svgOut(model);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const finish = obj => { res.write('data: ' + JSON.stringify(obj) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
  const finishReason = opts.finish || 'stop';   // 可强制 length：模拟在输出上限处被掐断的烂尾草稿

  if (opts.kind === 'reasoner') {  // content 一直为空，只有思考内容 → 客户端应改用思考内容/加预算重试
    ['先规划构图：鹈鹕、自行车、车轮…', '再算坐标与配色…', '准备输出代码'].forEach(t => {
      send(openai ? { choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] }
                  : { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
    });
    return finish(openai
      ? { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 40, completion_tokens: opts.usedMax || 8000, total_tokens: (opts.usedMax || 8000) + 40 } }
      : { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: opts.usedMax || 8000 } });
  }

  const parts = [];
  for (let i = 0; i < text.length; i += 120) parts.push(text.slice(i, i + 120)); // 按 120 字符切片，模拟真实分包
  parts.forEach(p => send(openai
    ? { choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }
    : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } }));
  const outTok = Math.round(text.length / 2);
  return finish(openai
    ? { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 320, completion_tokens: outTok, total_tokens: 320 + outTok } }
    : { type: 'message_delta', delta: { stop_reason: finishReason === 'length' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: outTok } });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}
function checkKey(req) {
  const auth = req.headers['authorization'] || '';
  const xkey = req.headers['x-api-key'] || '';
  return auth === 'Bearer ' + KEY || xkey === KEY;
}

let failFirstGen = true; // 模拟首次 503，测试自动退避重试
let shyCount = 0;        // 模拟"害羞"裁判的调用计数：奇数次空回复、偶数次正常评分

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const urlPath = req.url.replace(/\?.*$/, '');

  // ---- 页面本体（浏览器端到端测试用：file:// 下 CORS / 沙箱不好验，改由 http 提供，无需密钥）----
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
    if (!fs.existsSync(INDEX_PATH)) return json(res, 404, { error: { message: 'index.html not found' } });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(INDEX_PATH));
  }

  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) {}
    const path = urlPath;
    console.log(new Date().toISOString(), req.method, path);

    if (!checkKey(req)) {
      return json(res, 401, { error: { message: 'Incorrect API key provided: invalid key (mock)' } });
    }

    // 模拟不存在的端点：/v9 前缀一律 404（测试协议选错诊断）
    if (path.includes('/v9/')) {
      return json(res, 404, { error: { message: 'Not Found (mock /v9/*)' } });
    }

    // ---- 模型列表 ----
    if (req.method === 'GET' && path.endsWith('/models')) {
      return json(res, 200, { data: [
        { id: 'mock-image-1' }, { id: 'mock-vision-1' }, { id: 'mock-vision-shy-1' },
        { id: 'mock-svg-1' }, { id: 'mock-svg-md-1' }, { id: 'mock-svg-explain-1' },
        { id: 'mock-svg-bad-1' }, { id: 'mock-svg-reasoner-1' }, { id: 'mock-svg-draft-1' },
        { id: 'mock-svg-dirty-1' }, { id: 'mock-svg-broken-1' }
      ] });
    }

    // ---- OpenAI 图像生成 ----
    if (req.method === 'POST' && path.endsWith('/images/generations')) {
      if (!body.prompt) return json(res, 400, { error: { message: 'prompt is required (mock)' } });
      // 模拟严格网关：带 quality/size 参数时返回 500，用于测试客户端降级重试
      if (body.quality || body.size) {
        return json(res, 500, { error: { message: '服务暂时无法处理此请求，请稍后重试。' } });
      }
      // 模拟中转站图像链路故障：text-only 模型 + 极简请求也 503
      if ((body.model || '').includes('text-only')) {
        return json(res, 503, { error: { message: '服务暂时无法处理此请求，请稍后重试。' } });
      }
      // 模拟瞬时故障：首次请求 503，测试自动退避重试
      if (failFirstGen) {
        failFirstGen = false;
        return json(res, 503, { error: { message: '服务暂时无法处理此请求，请稍后重试。' } });
      }
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: TINY_PNG }],
        usage: { input_tokens: 8, output_tokens: 640, total_tokens: 648 }
      });
    }

    // ---- OpenAI Chat（评审 / 对话出图 / SVG 出图 / 文本考场） ----
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      const cModel = body.model || '';
      const m0 = (body.messages || [])[0] || {};
      const txt0 = typeof m0.content === 'string' ? m0.content
                 : Array.isArray(m0.content) ? m0.content.map(b => (b && b.text) || '').join('\n') : '';

      // 代码审阅（SVG 自评再审的文本兜底）：返回 JSON 分数
      if (txt0.includes('待审 SVG 代码')) {
        return json(res, 200, {
          choices: [{ message: { role: 'assistant', content: '{"score":86,"comment":"(代码审阅)SVG 结构完整，鹈鹕与自行车元素齐备"}' } }],
          usage: { prompt_tokens: 260, completion_tokens: 26 }
        });
      }
      // SVG 出图：只输出 SVG 代码（故意混入解释/围栏/空响应等风格，用于验证本地抽取与兜底）
      if (txt0.includes('待修复代码')) {
        return json(res, 200, { choices: [{ message: { role: 'assistant', content: MOCK_SVG } }], usage: { prompt_tokens: 260, completion_tokens: 820 } });
      }
      if (txt0.includes('SVG 绘图引擎')) {
        // 流式：正常吐 SVG；推理模型（mock-svg-reasoner-1）在预算够之前只吐思考内容；
        // 烂尾草稿（mock-svg-draft-1）小预算时吐半份 SVG 且标记 length → 验证「截断的回复不直接采用」
        if (body.stream) {
          const kind = cModel.includes('svg-reasoner') && body.max_tokens < 5000 ? 'reasoner' : 'content';
          const draftCut = cModel.includes('svg-draft') && body.max_tokens < 8000;
          const out = draftCut ? MOCK_SVG_DRAFT
                    : cModel.includes('svg-bad') ? '抱歉，我不会画图。'
                    : svgOut(cModel);
          return streamSSE(res, cModel, { kind, text: out, protocol: 'openai', usedMax: body.max_tokens, finish: draftCut ? 'length' : undefined });
        }
        if (cModel.includes('svg-bad')) {
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: '抱歉，我不会画图。' } }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
        }
        if (cModel.includes('svg-broken')) {
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: MOCK_SVG_BROKEN } }], usage: { prompt_tokens: 40, completion_tokens: 300 } });
        }
        if (cModel.includes('svg-dirty')) {
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: MOCK_SVG_DIRTY } }], usage: { prompt_tokens: 40, completion_tokens: 700 } });
        }
        if (cModel.includes('svg-reasoner')) {
          if (body.max_tokens < 5000) { // 小预算全烧在思考上 → 客户端应加倍预算重试
            return json(res, 200, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考中：先规划鹈鹕构图与车轮坐标……' } }], usage: { prompt_tokens: 40, completion_tokens: body.max_tokens } });
          }
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: MOCK_SVG } }], usage: { prompt_tokens: 40, completion_tokens: 900 } });
        }
        return json(res, 200, { choices: [{ message: { role: 'assistant', content: svgOut(cModel) } }], usage: { prompt_tokens: 42, completion_tokens: 780 } });
      }

      // 对话出图：content 为纯字符串且未设 max_tokens → 视为生成请求
      if (typeof body.messages?.[0]?.content === 'string' && body.max_tokens === undefined) {
        if ((body.model || '').includes('text-only')) {
          return json(res, 200, {
            choices: [{ message: { role: 'assistant', content: '抱歉，我是文本模型，不会画图。' } }],
            usage: { prompt_tokens: 10, completion_tokens: 12 }
          });
        }
        const md = '![image](data:image/png;base64,' + TINY_PNG + ')';
        return json(res, 200, {
          choices: [{ message: { role: 'assistant', content: md, images: [{ image_url: { url: 'data:image/png;base64,' + TINY_PNG } }] } }],
          usage: { prompt_tokens: 8, completion_tokens: 700 }
        });
      }
      const hasImg = JSON.stringify(body).includes('image_url');
      // 模拟纯文本模型（mock-svg-*）不支持图片输入 → 触发「代码审阅」兜底
      if (hasImg && cModel.includes('svg') && !cModel.includes('vision')) {
        return json(res, 400, { error: { message: 'Invalid content type: image_url is not supported by this text-only model (mock: ' + cModel + ')' } });
      }
      if (hasImg) {
        // 模拟"害羞"裁判：首次返回空正文（复现 deepseek 系模型把预算花在思考上的场景），验证客户端空回复重试
        if (cModel.includes('shy') && ++shyCount % 2 === 1) {
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 150, completion_tokens: 300 } });
        }
        const selfEval = (body.model || '').includes('image'); // 考生自评与考官再审返回不同评语，便于验证切换
        return json(res, 200, {
          choices: [{ message: { role: 'assistant', content: selfEval
            ? '{"score":92,"comment":"(自评)本鹈鹕骑车姿态潇洒，满分自信"}'
            : '{"score":84,"comment":"(再审)鹈鹕稳坐车座，构图清晰，主体准确"}' } }],
          usage: { prompt_tokens: 320, completion_tokens: 28 }
        });
      }
      if (!hasImg) {
        // 文本考场：按题目返回确定答案，带真实 usage
        const q = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
        let a = 'ok';
        if (q.includes('9.11')) a = '9.8';
        else if (q.includes('17×23') || q.includes('17x23')) a = '391';
        else if (q.includes('鸡兔')) a = '鸡6只，兔4只。';
        else if (q.includes('CH')) a = '瑞士';
        else if (q.includes('HELLO')) a = 'HELLO';
        else if (q.includes('人工智能')) a = '。';
        // 接近真实的计费：中文约 1 token/字，英文约 4 字符/token，另加约 8 tokens 框架开销
        const zh = /[\u4e00-\u9fa5]/.test(q);
        const pt = Math.round(q.length * (zh ? 1 : 0.3)) + 8;
        const inflate = (body.model || '').includes('inflate') ? 400 : 1; // 模拟多计费中转
        // 模拟推理模型（DeepSeek-R1 式）：小预算时 token 全烧在思考上，content 为空 + reasoning_content
        if ((body.model || '').includes('reasoner')) {
          if (body.max_tokens < 200) {
            return json(res, 200, {
              choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考中：先分析题目……' } }],
              usage: { prompt_tokens: pt, completion_tokens: body.max_tokens, total_tokens: pt + body.max_tokens }
            });
          }
          return json(res, 200, {
            choices: [{ message: { role: 'assistant', content: a, reasoning_content: '思考完成，答案是 ' + a } }],
            usage: { prompt_tokens: pt, completion_tokens: 180, total_tokens: pt + 180 }
          });
        }
        return json(res, 200, {
          choices: [{ message: { role: 'assistant', content: a } }],
          usage: { prompt_tokens: pt * inflate, completion_tokens: 5, total_tokens: pt * inflate + 5 }
        });
      }
    }

    // ---- Anthropic messages（SVG 出图 / 代码审阅 / 生成 or 评审） ----
    if (req.method === 'POST' && path.endsWith('/messages')) {
      const msg = (body.messages || [])[0] || {};
      const content = msg.content;
      const txt = typeof content === 'string' ? content
                : Array.isArray(content) ? content.map(b => (b && b.text) || '').join('\n') : '';
      const hasImgBlock = Array.isArray(content) && content.some(b => b.type === 'image');
      // 代码审阅（SVG 文本兜底）
      if (txt.includes('待审 SVG 代码')) {
        return json(res, 200, {
          content: [{ type: 'text', text: '{"score":86,"comment":"(代码审阅)SVG 结构完整，鹈鹕与自行车元素齐备"}' }],
          usage: { input_tokens: 260, output_tokens: 26 }
        });
      }
      // SVG 出图
      if (txt.includes('待修复代码')) {
        return json(res, 200, { content: [{ type: 'text', text: MOCK_SVG }], usage: { input_tokens: 260, output_tokens: 820 } });
      }
      if (txt.includes('SVG 绘图引擎')) {
        if ((body.model || '').includes('svg-bad')) {
          return json(res, 200, { content: [{ type: 'text', text: '抱歉，我不会画图。' }], usage: { input_tokens: 30, output_tokens: 8 } });
        }
        if ((body.model || '').includes('svg-broken')) {
          return json(res, 200, { content: [{ type: 'text', text: MOCK_SVG_BROKEN }], usage: { input_tokens: 40, output_tokens: 300 } });
        }
        if ((body.model || '').includes('svg-dirty')) {
          return json(res, 200, { content: [{ type: 'text', text: MOCK_SVG_DIRTY }], usage: { input_tokens: 40, output_tokens: 700 } });
        }
        const out = (body.model || '').includes('svg-md') ? '```svg\n' + MOCK_SVG + '\n```' : MOCK_SVG;
        return json(res, 200, { content: [{ type: 'text', text: out }], usage: { input_tokens: 42, output_tokens: 780 } });
      }
      if (hasImgBlock) {
        // 纯文本模型（mock-svg-*）不支持图片输入 → 触发代码审阅兜底
        const hm = body.model || '';
        if (hm.includes('svg') && !hm.includes('vision')) {
          return json(res, 400, { error: { message: 'image content block is not supported by this text-only model (mock: ' + hm + ')' } });
        }
        // 评审
        return json(res, 200, {
          content: [{ type: 'text', text: '{"score":76,"comment":"(Anthropic)鹈鹕骑车姿态略怪，但整体可辨"}' }],
          usage: { input_tokens: 330, output_tokens: 24 }
        });
      }
      // 模拟纯文本模型（不出图），用于测试 OpenAI 端点兜底
      if ((body.model || '').includes('text-only')) {
        return json(res, 200, {
          content: [{ type: 'text', text: '抱歉，我是一个文本模型，无法生成图片。' }],
          usage: { input_tokens: 12, output_tokens: 20 }
        });
      }
      // 生成
      return json(res, 200, {
        content: [
          { type: 'text', text: '生成完成' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } }
        ],
        usage: { input_tokens: 12, output_tokens: 100 }
      });
    }

    json(res, 404, { error: { message: 'unknown endpoint (mock): ' + path } });
  });
});

server.listen(PORT, () => console.log('mock server on http://127.0.0.1:' + PORT + '  key=' + KEY));
