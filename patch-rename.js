const fs = require('fs');
const f = __dirname + '/index.html';
let s = fs.readFileSync(f, 'utf8');
const reps = [
  ['<title>黑盒竞技场 · 模型能力测试</title>', '<title>掺水试金石 · 模型真伪检测</title>'],
  ['    黑盒竞技场', '    掺水试金石'],
  ['>⚔ 竞技场<', '>🎨 图片考场<'],
  ['点击「开始挑战」生成', '点击「开始检测」生成'],
  ['>✓ 开始挑战<', '>✓ 开始检测<'],
  ['[竞技场] 服务暂时不可用', '[试金石] 服务暂时不可用'],
  ['[竞技场] 生成参数被拒', '[试金石] 生成参数被拒'],
  ['用 5 道「短提问 + 唯一确定答案」的区分度考题探测模型真实性，外加 3 项免费指纹（Token 计数 / temperature 上限 / logprobs 支持）。',
   '用 10 道「短提问 + 唯一确定答案」的区分度考题探测模型真实性（数学陷阱 / 推理链 / 编程 / 前端 / SQL / 冷门知识 / 严格指令），外加 3 项免费指纹（Token 计数 / temperature 上限 / logprobs 支持）。'],
  ['全程仅约 <b>300 输出 Token</b>。使用「接口配置」里的考生模型与协议（文本走对话端点）。',
   '全程仅约 <b>500~700 输出 Token</b>，判分在本地完成、无评审消耗。使用「接口配置」里的考生模型与协议（文本走对话端点）。'],
  ['检测进行中…（预计 30 秒内完成）', '检测进行中…（10 道题 + 3 项指纹，预计 1 分钟内完成）']
];
let changed = 0;
for (const [oldS, newS] of reps) {
  if (s.includes(oldS)) { s = s.split(oldS).join(newS); changed++; }
}
fs.writeFileSync(f, s);
console.log('应用替换:', changed, '/', reps.length);
// 校验
const must = ['试金石 · 模型真伪检测', '模型试金石', '🎨 图片考场', '开始检测', '[试金石]', '10 道「短提问', '1 分钟内完成'];
const mustNot = ['黑盒竞技场', '竞技场', '开始挑战', '5 道「短提问'];
let ok = true;
for (const k of must) if (!s.includes(k)) { console.log('✗ 缺少:', k); ok = false; }
for (const k of mustNot) if (s.includes(k)) { console.log('✗ 残留:', k); ok = false; }
new Function(s.match(/<script>([\s\S]*)<\/script>/)[1]);
console.log(ok ? '✅ 全部替换完成，JS 语法 OK' : '❌ 有缺失或残留');
