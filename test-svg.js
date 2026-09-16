// 单元测试：从 index.html 中抽出 extractSvg()，验证各种模型回复格式都能抠出可渲染的 SVG
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const fnSrc = src.match(/function extractSvg\(text\)\{[\s\S]*?\n\}/)[0];
const extractSvg = new Function(fnSrc + '; return extractSvg;')();

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

const SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

console.log('extractSvg 测试：');
// 1. 裸 SVG
let r = extractSvg(SVG);
ok('裸 SVG 可提取', !!r && r.includes('<circle'));
ok('补全 xmlns', /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(r));
ok('补全 width/height', /width="512"/.test(r));

// 2. markdown 围栏
r = extractSvg('```svg\n' + SVG + '\n```');
ok('去掉 markdown 围栏', !!r && !r.includes('```') && r.startsWith('<svg'));

// 3. 带解释文字
r = extractSvg('好的，这是你要的图：\n' + SVG + '\n希望你喜欢！');
ok('剥离前后解释文字', !!r && r.startsWith('<svg') && r.endsWith('</svg>'));

// 4. 截断（无 </svg>）
r = extractSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10"');
ok('截断时自动补闭合', !!r && r.trim().endsWith('</svg>'));

// 5. 注入防护：script 与事件属性被剥离
r = extractSvg('<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>');
ok('剥离 script 标签', !!r && !/<script/i.test(r));
ok('剥离 on* 事件属性', !!r && !/onload=/i.test(r));

// 6. 无 SVG
ok('纯文本返回 null', extractSvg('我不会画图') === null);
ok('空输入返回 null', extractSvg('') === null && extractSvg(null) === null);

// 7. 多个 svg 时取完整的第一段
r = extractSvg('<svg viewBox="0 0 1 1"></svg>中间<svg viewBox="0 0 2 2"></svg>');
ok('多段时取第一段完整 SVG', !!r && r === '<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');

// 8. 尺寸归一化：百分比尺寸在 <img> 里可能算成 0 尺寸 → 必须换成固定像素，且不能出现重复属性
r = extractSvg('<svg viewBox="0 0 512 512" width="100%" height="100%"><circle cx="10" cy="10" r="5"/></svg>');
ok('百分比尺寸 → 固定 512', /width="512"/.test(r) && !/%/.test(r.split('>')[0]));
ok('不产生重复 width 属性', (r.split('>')[0].match(/\bwidth\s*=/gi) || []).length === 1);
ok('百分比场景仍是合法首标签', /^<svg [^>]*>$/.test(r.slice(0, r.indexOf('>') + 1)));

// 9. 只缺 height 时补齐，且不重复 width
r = extractSvg('<svg viewBox="0 0 512 512" width="800"><rect x="0" y="0" width="10" height="10"/></svg>');
ok('只缺 height → 归一化补全', /width="512"/.test(r) && /height="512"/.test(r));
ok('归一化后 width 不重复', (r.split('>')[0].match(/\bwidth\s*=/gi) || []).length === 1);

// 10. 已是固定像素尺寸 → 原样保留
r = extractSvg('<svg viewBox="0 0 900 900" width="900" height="900"><rect width="9" height="9"/></svg>');
ok('固定像素尺寸原样保留', /width="900"/.test(r) && /height="900"/.test(r));

// ---- xmlFixups：文本层的 XML 合法性修复（<img> 解码走严格 XML，这些是最常见的致命点）----
const fixSrc = src.match(/function xmlFixups\(svgStr\)\{[\s\S]*?\n\}/)[0];
const xmlFixups = new Function(fixSrc + '; return xmlFixups;')();
console.log('\nxmlFixups 测试：');

// 未声明 xlink 前缀 → 补 xmlns:xlink（否则严格 XML 解析直接失败）
r = xmlFixups('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><use xlink:href="#a"/></svg>');
ok('补 xmlns:xlink 声明', !!r && /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/.test(r));
ok('已声明时不重复补', (() => { const x = xmlFixups('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>'); return x === null || (x.match(/xmlns:xlink/g) || []).length === 1; })());

// 自造前缀（pe:bike）→ 抹掉前缀当普通标签，序列化才不会吐出未绑定前缀
r = xmlFixups('<svg viewBox="0 0 512 512"><pe:bike cx="1" pe:r="2"/></svg>');
ok('抹掉自造元素前缀', !!r && !/pe:/.test(r) && r.includes('<bike'));

// 裸 & → &amp;，已有实体不重复转义
r = xmlFixups('<svg><text>鹈鹕 & 自行车</text></svg>');
ok('裸 & 转义为 &amp;', !!r && r.includes('&amp; 自行车'));
r = xmlFixups('<svg><text a="&amp; &lt; &#100;">x</text></svg>');
ok('已有实体不重复转义', r === null);

// 重复属性 → 只留第一个（XML 会直接报错）
r = xmlFixups('<svg viewBox="0 0 512 512"><rect width="10" width="20" height="3"/></svg>');
ok('重复属性去重', !!r && (r.match(/width=/g) || []).length === 1 && r.includes('width="10"'));

// XML 声明只能出现在最开头 → 一律删除（不影响渲染）
r = xmlFixups('<svg viewBox="0 0 1 1"><?xml version="1.0"?></svg>');
ok('删除错位的 XML 声明', !!r && !/<\?xml/.test(r));

// HTML 命名实体（XML 未定义）→ 换成字符
r = xmlFixups('<svg><text>鹈鹕&nbsp;骑&nbsp;车</text></svg>');
ok('&nbsp; 转成不间断空格', !!r && !/&nbsp;/.test(r) && r.includes('\u00a0'));

// 本来就合法 → 返回 null（不必当候选）
ok('合法 SVG 返回 null', xmlFixups('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="5" cy="5" r="4"/></svg>') === null);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
