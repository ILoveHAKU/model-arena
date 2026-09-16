// 单元测试：白图判定（isBlankShot）—— SVG 渲染链路用它识别"没画出东西"并触发模型自修兜底。
// 浏览器成像本身无法在 Node 里跑，这里用可控桩验证判定逻辑的边界。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, e !== undefined ? '→ ' + JSON.stringify(e).slice(0, 200) : '')); };

const grabFn = name => {
  const single = src.match(new RegExp('^function ' + name + '\\([^\\n]*\\n?', 'm'));
  if (single && single[0].includes('}')) return single[0];
  return src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'))[0];
};

// 可控桩：getImageData 每次调用时读取注入的像素；Image 可控制 onload/onerror
globalThis.__pixels = new Uint8ClampedArray(4).fill(255);   // 默认纯白
globalThis.__failImage = false;
const stubs = `
class FakeCtx { fillRect(){} drawImage(){} getImageData(){ return {data: globalThis.__pixels}; } }
class FakeCanvas { constructor(){ this.width=0; this.height=0; } getContext(){ return new FakeCtx(); } }
class FakeImage { set src(v){ setTimeout(()=>{ globalThis.__failImage ? (this.onerror&&this.onerror()) : (this.onload&&this.onload()) },0) } }
const Image = FakeImage;
const document = { createElement(){ return new FakeCanvas(); } };
`;
let F;
try {
  F = new Function('globalThis', stubs + '\n' + grabFn('isBlankShot') +
    '\nreturn {isBlankShot};')(globalThis);
  ok('可从页面源码取出 isBlankShot 并执行', true);
} catch (e) {
  ok('可从页面源码取出 isBlankShot 并执行', false, e.message);
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(1);
}

(async () => {
  console.log('\nisBlankShot 测试：');
  const shot = (w = 4, h = 4) => ({ img: 'data:image/png;base64,AAA', w, h });

  let r = await F.isBlankShot(shot());
  ok('整张纯白 → 判定为空白', r === true, r);

  globalThis.__pixels = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]);
  r = await F.isBlankShot(shot());
  ok('画面有内容（非白像素）→ 不算空白', r === false, r);

  globalThis.__pixels = new Uint8ClampedArray([250, 250, 250, 255, 255, 255, 255, 255, 250, 250, 250, 255, 255, 255, 255, 255]);
  r = await F.isBlankShot(shot());
  ok('接近纯白（>246 阈值）→ 仍判定为空白', r === true, r);

  globalThis.__failImage = true;
  r = await F.isBlankShot(shot());
  ok('图片解码失败 → 不拦截（交给后续流程）', r === false, r);

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
