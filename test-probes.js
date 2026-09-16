const html = require('fs').readFileSync(__dirname + '/index.html', 'utf8');
// 校验整页脚本语法
new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
// 提取 PROBES 并求值
const src = html.match(/const PROBES=\[([\s\S]*?)\n\];/)[1];
const PROBES = new Function('return [' + src + ']')();
console.log('题库总数:', PROBES.length, '→', PROBES.map(p=>p.id).join(', '));

const cases = {
  cmpchain: [['E', true], ['A', false], ['最小的是E', true], ['E最小', true], ['D', false]],
  pct: [['96元', true], ['96', true], ['100', false], ['120元', false], ['1096', false]],
  java: [['a=20,b=20', true], ['20,20', true], ['10,20', false], ['a=10,b=20', false], ['20', false]],
  evlp: [['1 4 3 2', true], ['1432', true], ['1 4 2 3', false], ['1243', false], ['输出顺序是 1 4 3 2', true]],
  sql: [['应使用 LEFT JOIN，金额为空用 COALESCE 处理', true], ['用 INNER JOIN 和 IFNULL', false], ['LEFT JOIN', false], ['COALESCE', false], ['left join，用ifnull', true]]
};
let fail = 0;
for (const p of PROBES) {
  if (!cases[p.id]) continue;
  for (const [ans, should] of cases[p.id]) {
    let r; try { r = !!p.check(ans); } catch (e) { r = 'ERR:' + e.message; }
    if (r !== should) { console.log('✗ 判定错误:', p.id, '输入“' + ans + '”期望', should ? '通过' : '拒绝', '实际', r); fail++; }
  }
}
console.log(fail === 0 ? '✅ 新增5题判分全部正确（正确答案通过、错误答案拒绝）' : '❌ ' + fail + ' 处判定错误');
