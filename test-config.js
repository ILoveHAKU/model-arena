// 单元测试：配置读取兜底 + 题目文本兜底 + 考生提示词约束
// 背景：runArena()/runTextExam() 读的是 localStorage 里的配置。老版本存的配置、或某些配置方案里
// 可能没有 prompt 字段，此时 c.prompt === undefined —— 留给模型的题目会变成「画出「undefined」」，
// 模型只能自由发挥（典型表现：画成夜景/风景），而界面上文本框显示的是默认题目，完全看不出异常。
// 这组断言锁死这个回归。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, e !== undefined ? '→ ' + JSON.stringify(e).slice(0, 200) : '')); };

// 从页面源码里精确截出需要的常量与函数：用标记切段（提示词是跨行模板字符串，正则很容易截错）
const between = (a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b);
  if (i < 0 || j < 0 || j <= i) throw new Error('切段失败: ' + a + ' → ' + b);
  return src.slice(i, j);
};
const consts = src.match(/^const CFG_DEFAULTS=\{[\s\S]*?\};\s*$/m)[0];
ok('CFG_DEFAULTS 里带默认题目', /prompt\s*:\s*'一只鹈鹕骑自行车'/.test(consts));
ok('默认出图方式为 svg（HTML 出图模式已移除）', /genMode\s*:\s*'svg'/.test(consts));
ok('页面上不再有 html 出图选项', !/<option value="html"/.test(src));

const subjSrc = between('const subjText =', '/* SVG 出图模式的提示词');
const svgPromptSrc = between('const svgGenPrompt =', 'const JUDGE_PROMPT_SVG');

const grabFn = name => src.match(new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'))[0];

const genModesSrc = (src.match(/const GEN_MODES = \{[\s\S]*?\n\};/) || [])[0];
const mod = new Function(
  consts + '\n' + subjSrc + '\n' + svgPromptSrc + '\n' + genModesSrc + '\n' +
  grabFn('cfgWithDefaults') + '\n' + grabFn('genModeOf') + '\n' +
  'return {cfgWithDefaults, genModeOf, subjText, svgGenPrompt};'
)();

// ---- subjText：任何非题目的输入都回退到默认题目 ----
console.log('\nsubjText 兜底：');
const DEF = '一只鹈鹕骑自行车';
ok('undefined → 默认题目', mod.subjText(undefined) === DEF);
ok('null → 默认题目', mod.subjText(null) === DEF);
ok('空串 → 默认题目', mod.subjText('') === DEF);
ok('纯空格 → 默认题目', mod.subjText('   ') === DEF);
ok('字符串 "undefined" → 默认题目', mod.subjText('undefined') === DEF);
ok('字符串 "null" → 默认题目', mod.subjText('null') === DEF);
ok('自定义题目原样保留', mod.subjText('一只猫在弹钢琴') === '一只猫在弹钢琴');
ok('题目首尾空格被去掉', mod.subjText('  一只猫  ') === '一只猫');

// ---- cfgWithDefaults：老配置缺字段时补齐 ----
console.log('\ncfgWithDefaults：');
const bare = mod.cfgWithDefaults({});
ok('空配置 → 题目为默认值', bare.prompt === DEF);
ok('空配置 → 出图方式为 svg', bare.genMode === 'svg');
const noPrompt = mod.cfgWithDefaults({ genMode: 'svg', genBase: 'https://x/v1', genModel: 'm', judgeModel: 'j' });
ok('缺 prompt 字段 → 补默认题目', noPrompt.prompt === DEF);
ok('已有字段不丢', noPrompt.genModel === 'm' && noPrompt.genBase === 'https://x/v1' && noPrompt.genMode === 'svg');
ok('空 prompt → 补默认题目', mod.cfgWithDefaults({ prompt: '' }).prompt === DEF);
ok('prompt 为字符串 "undefined" → 补默认题目', mod.cfgWithDefaults({ prompt: 'undefined' }).prompt === DEF);
ok('自定义题目不被覆盖', mod.cfgWithDefaults({ prompt: '一只猫' }).prompt === '一只猫');
ok('老配置遗留的 genMode:"html" 在运行时回退为 svg', mod.genModeOf({ genMode: 'html' }) === 'svg');

// ---- 提示词：绝不能让 undefined 出现在发给模型的文本里 ----
console.log('\n提示词不出现 undefined：');
const svgUndef = mod.svgGenPrompt(undefined);
ok('SVG 提示词(undefined) 不含 undefined 字样', !/undefined/.test(svgUndef));
ok('SVG 提示词(undefined) 含默认题目', svgUndef.includes(DEF));
const svgCat = mod.svgGenPrompt('一只猫');
ok('SVG 提示词(自定义) 三处都替换成题目', (svgCat.match(/一只猫/g) || []).length >= 3);

// ---- 提示词：必须明确要求"不要思考/推理过程，直接给最终代码"（防推理型模型把草稿当回答） ----
console.log('\n提示词禁止思考过程：');
ok('SVG 提示词明确要求不返回思考/推理过程', /不要输出任何思考|不要返回思考/.test(svgUndef), svgUndef.slice(0, 120));
ok('SVG 提示词要求回复以 </svg> 结束（配合截断防线）', /<\/svg>\s*结束/.test(svgUndef));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
