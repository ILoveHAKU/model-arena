# 掺水试金石 · 模型真伪检测

用「短提问 + 唯一确定答案」的区分度考题，探测一个模型是不是被悄悄换成了量化版、蒸馏版或更小的模型。

零依赖、零构建的单文件应用：整个界面就是 `index.html`，配套一个测试用的模拟网关。

## 它做什么

同一个模型名，背后可能已经换了芯。这个工具把「抽样检测」做成开箱即用的一件事：

- **图片考场**——让考生模型画同一道题，用独立的评委模型打分，同题多次运行看稳定性。
- **文本考场**——10 道区分度考题（比较陷阱 / 多步计算 / 推理链 / 引用语义 / 事件循环 / SQL / 冷门知识 / 严格指令），全部在本地判分，不消耗评审 Token。
- **能力记录**——历史成功率、单题记录、逐次趋势。

题目的特点是「短提问 + 唯一确定答案」：`9.11 和 9.8 哪个更大`、`a=10,b=20; a=b; b=a;` 之后两个变量分别是多少。掺水的模型往往在这里露馅，而全程只需要几百个输出 Token。

## 出图有两种方式

| 方式 | 谁在画 | 成本 |
| --- | --- | --- |
| `svg` | 文本模型只输出 SVG 代码，浏览器本地渲染 | 不消耗图像 Token，普通对话模型即可 |
| `image` | 走图像生成接口（`gpt-image-1` / `dall-e-3` / `seedream` …） | 按图像接口计费 |

`svg` 模式对「换芯检测」特别有用：同一个文本模型在代码出图上的退化，比图像接口更难被掩盖，而且便宜到可以反复抽样。

## 快速开始

`index.html` 完全自包含（没有任何本地 `<script src>` / `<link>` / 相对路径请求），双击就能用。但更推荐起本地服务——原因见下面的「配置与安全」：

```bash
node mock-server.js 8787
# 然后打开 http://127.0.0.1:8787/
```

`mock-server.js` 是测试用的模拟网关（OpenAI + Anthropic 双协议），同时把 `index.html` 挂在 `/` 上。真跑检测时，在「接口配置」里把考生与评委的地址换成你自己的端点即可。

## 测试

纯 Node 单元测试，不需要起服务：

```bash
node test-config.js   # 配置读取兜底、题目文本兜底
node test-svg.js      # 从模型回复里抽取可渲染的 SVG
node test-render.js   # 白图判定
node test-stream.js   # 流式链路（OpenAI / Anthropic SSE）
node test-probes.js   # 题库判分正确性
```

需要先起 mock 网关的：

```bash
node mock-server.js 8799
node test-mock-stream.js
```

端到端（headless Edge + CDP，含 `svg` / `svg-bad` / `prompt-undefined` / `codegen-fail` 四个场景）：

```powershell
powershell -ExecutionPolicy Bypass -File run-e2e.ps1
```

注意 `run-e2e.ps1` 每次运行都会重建 `.edge-profile`（测试专用的浏览器 profile）。

## 配置与安全

配置全部存在浏览器 localStorage，没有服务端、也没有配置文件：

| 键 | 内容 |
| --- | --- |
| `arena_cfg_v1` | 接口配置（考生/评委的地址、模型、协议）与题目，外加 `history` 历史记录 |
| `arena_presets_v1` | 配置方案列表 `[{id,name,cfg}]`，用于一键切换多套端点 |
| `arena_active_preset` | 当前选中的方案 id（仅界面态） |

历史记录里的图片会先压成 256px 缩略图再落盘，SVG 源码不持久化。

**三点提醒：**

1. `genKey` / `judgeKey` 是**明文**存在 localStorage 里的。本地自用没问题，别把 `API Key` 填进任何会被提交的文件。
2. 用 `file://` 打开时，Chromium/Edge 把所有本地 HTML 视为**同一个 origin**，localStorage 是共享的——任何下载来的 `.html` 双击打开都能读走你的 Key。所以请用 `http://127.0.0.1:端口` 访问，origin 才隔离。
3. `.edge-profile/` 是浏览器 profile，里面同样含有明文配置，已在 `.gitignore` 中排除，不要手动提交。

想要「配置跟着项目走」，建议把密钥与配置分开：端点、模型名、题目、方案预设可以随便导出携带，API Key 单独处理（每次手输，或用口令加密后再落盘）。

## 文件结构

```
index.html        整个应用（界面 + 逻辑，单文件）
mock-server.js    模拟网关：OpenAI + Anthropic 双协议，同时提供页面
e2e-serve.js      端到端测试用的静态服务（注入预置配置后跑场景）
test-browser.js   基于 CDP 的浏览器测试
run-e2e.ps1       一键跑端到端：拉起网关与 headless Edge，跑完自动清理
test-*.js         单元测试
patch-rename.js   一次性的改名脚本（已执行，留档）
```
