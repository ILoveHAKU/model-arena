// 端到端测试（真实浏览器）：用 Edge headless（CDP over WebSocket）跑一遍 SVG 出图模式
// 覆盖：mock 网关 → 抽取 SVG → 本地渲染 → 自评/再审 → 记录与画廊 → 回看与灯箱
//
// 跑法（必须在同一个进程里做完，见 run-e2e.ps1 顶部说明）：
//   powershell -ExecutionPolicy Bypass -File run-e2e.ps1
//
// ⚠️ 环境限制：Edge headless 不能用 --single-process（DevTools HTTP 端口不会绑定），run-e2e.ps1 已处理。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8799);        // mock 网关
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 8800); // Edge DevTools
const KEY = 'sk-mock';
const SHOT = path.join(__dirname, 'test-browser-arena.png');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 400) : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, timeout = 1500) {
  return new Promise(res => {
    const req = http.get(url, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b }));
    });
    req.on('error', () => res(null));
    req.setTimeout(timeout, () => { req.destroy(); res(null); });
  });
}

// ---- 极简 CDP 客户端（Node 内置 WebSocket，纯 TCP，不涉及管道 stdio）----
class CDP {
  constructor(ws, sessionId) { this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
    return new CDP(ws);
  }
  attach(sessionId) { return new CDP(this.ws, sessionId); }
  _wire() {
    if (this._wired) return;
    this._wired = true;
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) this.events.push(m);
    };
  }
  send(method, params = {}, timeout = 15000) {
    this._wire();
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(method + ' 超时（' + timeout + 'ms）')); }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, 120000);
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

// ---- 页面内测试脚本（在浏览器里执行，返回结构化结果）----
const RUN_ONE = `(async (model, judgeModel, genMode) => {
  const cfg = {
    genMode: genMode || 'svg', genProto: 'openai',
    genBase: 'http://127.0.0.1:${PORT}/v1', genKey: '${KEY}', genModel: model,
    judgeProto: 'openai',
    judgeBase: 'http://127.0.0.1:${PORT}/v1', judgeKey: '${KEY}', judgeModel: judgeModel,
    prompt: '一只鹈鹕骑自行车'
  };
  localStorage.setItem('arena_cfg_v1', JSON.stringify(cfg));
  loadSettings();
  const before = history.length;
  await runArena();
  const rec = history[0];
  return {
    added: history.length - before,
    mode: rec && rec.mode,
    score: rec && rec.score,
    selfScore: rec && rec.selfScore,
    judgeScore: rec && rec.judgeScore,
    repaired: !!(rec && rec.repaired),
    hasImg: !!(rec && rec.img && rec.img.startsWith('data:image/png')),
    codeLen: rec ? (rec.code || '').length : 0,
    svgClean: !rec || (/^<svg/i.test(rec.code || rec.svg || '') && !/<script/i.test(rec.code || rec.svg || '')),
    comment: (rec && rec.comment) || '',
    judgeComment: (rec && rec.judgeComment) || '',
    verdict: document.getElementById('verdictText').textContent,
    usage: document.getElementById('usageRow').textContent,
    errText: document.getElementById('commentText').className.includes('err') ? document.getElementById('commentText').textContent : '',
    galleryCards: document.querySelectorAll('#gallery .g-card').length,
    btnSvgVisible: document.getElementById('btnSvg').style.display !== 'none',
    imgCardHasImg: document.getElementById('resultImg').style.display !== 'none'
  };
})`;

(async () => {
  let cdp = null;
  try {
    const gateway = await get(`http://127.0.0.1:${PORT}/`);
    ok('mock 网关已托管页面', !!gateway && gateway.code === 200 && gateway.body.includes('svgGenPrompt'),
      gateway ? 'HTTP ' + gateway.code : '连不上 → 请用 run-e2e.ps1 运行');

    // DevTools 端点可能在页面就绪后才真正可用：轮询拿 webSocketDebuggerUrl，别再让空 URL 直接把用例打断
    let browserWs = null, lastRaw = '（没有任何响应）';
    for (let i = 0; i < 40 && !browserWs; i++) {
      const v = await get(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      lastRaw = v ? ('HTTP ' + v.code + ' ' + v.body.slice(0, 200)) : '连不上 ' + DEBUG_PORT;
      try { browserWs = JSON.parse(v.body).webSocketDebuggerUrl; } catch (e) {}
      if (!browserWs) await sleep(500);
    }
    ok('Edge 调试端点提供 webSocketDebuggerUrl', !!browserWs, browserWs ? null : lastRaw);
    if (!browserWs) throw new Error('DevTools 端点不可用（Edge 渲染进程未起来，见 .e2e/edge.err.log）');
    const browser = await CDP.connect(browserWs);
    const bv = await browser.send('Browser.getVersion').catch(e => ({ err: e.message }));
    ok('浏览器端点 CDP 可用', !!bv.product, bv);
    const t = await browser.send('Target.createTarget', { url: 'about:blank' }).catch(e => ({ err: e.message }));
    const att = t.targetId ? await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(e => ({ err: e.message })) : { err: 'no target' };
    ok('可创建并附加到页面 target', !!att.sessionId, { createTarget: t, attach: att });
    if (!att.sessionId) throw new Error('无法附加到页面 target（渲染进程不可用）');
    cdp = browser.attach(att.sessionId);
    const rt = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 10000).catch(e => ({ err: e.message }));
    ok('页面会话可执行脚本（渲染进程存活）', rt.result && rt.result.value === 2, rt);
    if (!rt.result || rt.result.value !== 2) throw new Error('渲染进程无法执行脚本');
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Log.enable').catch(() => {});

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(2000);
    const boot = await cdp.eval(`({ title: document.title, genMode: document.getElementById('genMode').value, noFrame: !document.getElementById('resultFrame'), subbar: document.getElementById('subbarText').textContent, sec: document.getElementById('secGen').textContent })`);
    ok('页面加载成功（标题 / 默认出图方式 svg）',
      boot.title.includes('试金石') && boot.genMode === 'svg', boot);
    ok('界面文案已联动且 HTML 预览 iframe 已移除', boot.subbar.includes('SVG') && boot.sec.includes('SVG') && boot.noFrame, boot);

    console.log('\n用例 1 · 正常 SVG 出图');
    const r1 = await cdp.eval(`${RUN_ONE}('mock-svg-1','mock-vision-1')`);
    ok('生成成功并写入 1 条记录', r1.added === 1 && r1.mode === 'svg', { added: r1.added, mode: r1.mode, err: r1.errText });
    ok('渲染出 PNG 位图（data:image/png 非空）', r1.hasImg, { hasImg: r1.hasImg });
    ok('保存了 SVG 源码且干净（无 script，svg 开头）', r1.codeLen > 200 && r1.svgClean, { codeLen: r1.codeLen, svgClean: r1.svgClean });
    ok('不触发自修兜底', r1.repaired === false, { repaired: r1.repaired });
    ok('用量行标注本地渲染', /SVG 源码/.test(r1.usage) && /未消耗图像 Token/.test(r1.usage), r1.usage);
    ok('自评 / 再审分数都拿到', typeof r1.selfScore === 'number' && typeof r1.judgeScore === 'number', { s: r1.selfScore, j: r1.judgeScore });
    ok('点评非空且无错误', !!r1.comment && !r1.errText, { comment: r1.comment, err: r1.errText });
    ok('画廊有记录且「查看代码」按钮可用', r1.galleryCards === 1 && r1.btnSvgVisible);
    ok('左侧显示作品（截图）', r1.imgCardHasImg === true);

    console.log('\n用例 2 · 围栏与解释文字包裹的回复');
    const r2 = await cdp.eval(`${RUN_ONE}('mock-svg-md-1','mock-vision-1')`);
    const r3 = await cdp.eval(`${RUN_ONE}('mock-svg-explain-1','mock-vision-1')`);
    ok('```svg 围栏可抽取', r2.hasImg && r2.mode === 'svg' && !r2.errText, r2.errText);
    ok('前后夹解释文字可抽取', r3.hasImg && r3.mode === 'svg' && !r3.errText, r3.errText);

    console.log('\n用例 3 · 脏代码（脚本 / 事件 / 命名实体 / 未闭合）');
    const r4 = await cdp.eval(`${RUN_ONE}('mock-svg-dirty-1','mock-vision-1')`);
    ok('脏代码经自动修复后仍能出图', r4.hasImg && !r4.errText && r4.mode === 'svg', { img: r4.hasImg, err: r4.errText });
    ok('修复结果干净（无 script / on* 事件）', r4.svgClean, { svgClean: r4.svgClean });
    ok('用量行标注「已自动修复模型输出」', /已自动修复模型输出/.test(r4.usage), r4.usage);

    console.log('\n用例 4 · 坏代码（修复也救不回 → 回贴给模型自修）');
    const r5 = await cdp.eval(`${RUN_ONE}('mock-svg-broken-1','mock-vision-1')`);
    ok('自修兜底后出图', r5.hasImg && !r5.errText && r5.mode === 'svg', { img: r5.hasImg, err: r5.errText });
    ok('用量行标注「已自动修复模型输出」', /已自动修复模型输出/.test(r5.usage), r5.usage);

    console.log('\n用例 5 · 模型不给代码（失败路径）');
    const r6 = await cdp.eval(`${RUN_ONE}('mock-svg-bad-1','mock-vision-1')`);
    ok('报错信息指出没有返回可用的 SVG 代码', /没有返回可用的 SVG 代码/.test(r6.errText), r6.errText);
    ok('失败也计入战绩（掺水监控需要失败样本）', r6.added === 1 && r6.mode === 'svg', { added: r6.added, mode: r6.mode });
    ok('失败时把模型原始回复留档供「查看代码」排查', r6.codeLen > 0 && r6.btnSvgVisible, { codeLen: r6.codeLen, btn: r6.btnSvgVisible });

    console.log('\n用例 6 · 推理模型把输出预算烧在思考上（线上报错场景）');
    const r7 = await cdp.eval(`${RUN_ONE}('mock-svg-reasoner-1','mock-vision-1')`);
    ok('思考内容被兜底采用后仍能出图（不再"回复为空"）', r7.hasImg && !r7.errText, { img: r7.hasImg, err: r7.errText });
    ok('流式请求也带回了 Token 用量', /生成 in:\d+ out:\d+/.test(r7.usage || ''), r7.usage);

    console.log('\n用例 6b · 裁判返回空正文（自动重试一次后拿到评分）');
    const r7b = await cdp.eval(`${RUN_ONE}('mock-svg-1','mock-vision-shy-1')`);
    ok('裁判空回复重试后拿到再审分', r7b.hasImg && !r7b.errText && typeof r7b.judgeScore === 'number', { img: r7b.hasImg, err: r7b.errText, judge: r7b.judgeScore });
    ok('重试拿到的评语正常展示', (r7b.judgeComment || '').includes('(再审)'), r7b.judgeComment);

    console.log('\n用例 7 · 截断防线（烂尾草稿不直接采用，加预算重试）');
    const r8 = await cdp.eval(`${RUN_ONE}('mock-svg-draft-1','mock-vision-1')`);
    ok('截断的草稿重试后拿到完整作品并出图', r8.hasImg && !r8.errText && r8.mode === 'svg', { img: r8.hasImg, err: r8.errText });
    ok('重试成功不算"自修"', r8.repaired === false && r8.codeLen > 200, { repaired: r8.repaired, codeLen: r8.codeLen });

    console.log('\n用例 8 · 切到图片接口出图模式');
    const r9 = await cdp.eval(`${RUN_ONE}('mock-image-1','mock-vision-1','image')`);
    ok('图片模式出图成功（首次 503 自动退避重试）', r9.hasImg && !r9.errText && r9.mode === 'image', { img: r9.hasImg, err: r9.errText });
    ok('图片模式无源码按钮', r9.btnSvgVisible === false, { btn: r9.btnSvgVisible });

    console.log('\n用例 9 · 记录页与画廊');
    const r10 = await cdp.eval(`(() => {
      showView('records');
      const badges = [...document.querySelectorAll('#recGrid .rec-badge')].map(b => b.textContent);
      const cards = document.querySelectorAll('#recGrid .rec-card').length;
      const subbar = document.getElementById('subbarText').textContent;
      showView('arena');
      return { badges, cards, subbar };
    })()`);
    ok('记录页同时出现 SVG 与图片徽章', r10.badges.some(t => t.includes('SVG')) && r10.badges.some(t => t.includes('图片')), r10.badges);
    ok('记录页能看到全部历史记录', r10.cards >= 8, r10.cards);

    console.log('\n用例 10 · 历史记录回看与大图灯箱');
    const r11 = await cdp.eval(`(() => {
      const svgRec = history.find(h => h.mode === 'svg' && h.img && h.code);
      if (!svgRec) return { error: '没有带源码的 SVG 记录' };
      loadRecord(svgRec);
      const imgShown = document.getElementById('resultImg').style.display === 'block';
      const btnVisible = document.getElementById('btnSvg').style.display !== 'none';
      const modelName = document.getElementById('modelName').textContent;
      const usageFollows = !svgRec.usage || document.getElementById('usageRow').textContent === svgRec.usage;
      openLightbox();
      const open = document.getElementById('lightbox').style.display === 'flex';
      const lightboxImg = document.getElementById('lightboxImg').src.startsWith('data:image');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      const escClosed = document.getElementById('lightbox').style.display === 'none';
      return { imgShown, btnVisible, modelName, usageFollows, usage: svgRec.usage, open, lightboxImg, escClosed };
    })()`);
    ok('回看 SVG 记录：截图与代码按钮恢复', r11.imgShown === true && r11.btnVisible === true, r11);
    ok('用量行跟随所选记录（不再停留在最后一次检测）', r11.usageFollows === true, r11);
    ok('大图灯箱可开可关（ESC 关闭，展示截图）', r11.open && r11.lightboxImg && r11.escClosed, r11);

    const errors = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    const pageErrs = errors.map(e => e.method === 'Runtime.exceptionThrown'
      ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
      : e.params.entry.text);
    ok('页面无 JS 异常', pageErrs.filter(t => !/Failed to load resource|net::|ERR_|Content Security Policy/i.test(t || '')).length === 0, pageErrs.slice(0, 3));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    ok('已保存页面截图用于人工复核', fs.existsSync(SHOT) && fs.statSync(SHOT).size > 10000, SHOT);

    cdp.close();
  } catch (e) {
    console.log('\n✗ 测试异常：' + (e && e.stack || e));
    fail++;
    if (cdp) cdp.close();
  }
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
