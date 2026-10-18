# 更新说明

## 0.3.3

- `relayPet` 开启时，桌宠自己的话转交后不再推"已转交"通知：bot 收到这类通知只会接话评论（"我看到你说的话被转过去了"），造成来回接话；桌宠的话 bot 没有理由重发，静默转交即可（用户的话照旧推通知，防重复 `dsh_send`）

## 0.3.2

- 转交失败细分为两类：桥没连上、写入被拒的句子照旧排队补发；超时或被 DSH 拒绝的句子不再盲目重发（可能已在 DSH 会话里，重发会造成同一句出现两次），改为推一条通知，由 bot 判断是否用 `dsh_send` 重发
- 待转交队列满丢句时不再静默：推一条通知说明丢下了哪一句

## 0.3.1

- `relayPet`（转发桌宠的话）开关真正生效：开启后桌宠自己在气泡里说的话也转交给 DSH；默认仍是关闭
- 桥接补上语音转写：你说的话无论是打字还是语音识别（`desktop-pet.speech`），都会转交给 DSH，与配置说明一致
- 桥接改为只转发启动之后的新消息：重启不再补发之前没交出去的旧话；启动时还没连上 DSH 的那几句会先排队，连上后补发（队列上限 16 条），不再直接丢掉
- `tts_hush` 改为停下正在播的句子并清空整个朗读队列，排队中的句子不再继续念
- 新增环境提示词声明（`promptDocs` 的 `role: 'envPrompt'`）：`dsh.status` / `tts.status` 两个变量与 DSH 环境说明现在真正进入 bot 的 system 提示词
- CHANGELOG.md 进入 npm 包的 `files`，扩展市场可以读到各版本更新说明

## 0.3.0

- 升到 Cortico 扩展契约 world api 6：World 的 `console()` 改名 `webUi()`，manifest 的 `consoleClient` 改名 `webUiClient`，面板源码目录 `src/console/` 改名 `src/webui/`，产物改名 `dist/webui.js`
- 新增 `describe.json` 自描述（工具 dsh_send / tts_hush 与事件 fatfish.notice 的声明），扩展市场只读它、不执行包代码
- package.json 新增市场字段：`locales`（中英显示名与简介）、`tags: ["requires-extension"]`（依赖其他扩展）
- 简介重写成小白话：第一句讲清"和 DeepSeek Harness（DSH）对话让它帮你干活写代码，宠物回复时用内置语音包读出声"，并写明桥接需要先装 DSH 的 Host 插件；README 加"不会装？把仓库地址交给 AI 助手带你装"的引导

## 0.2.2

- 音色下拉修复：扩展通过 World 的 `configOptions` 自喂 16 个音色候选，不再依赖应用侧接线，应用升级不再弄丢音色列表

## 0.2.1

- 把 msedge-tts（MIT）vendor 进 `src/vendor/msedge-tts/`，依赖只剩纯 JS 的 `ws`，无构建脚本，任何环境从扩展市场安装都不再被 pnpm 构建脚本拦截报红

## 0.2.0

- 更名 cortico-world-fatfish 首发 npm：DSH 桥接 + Edge TTS 语音朗读复合包

## 0.1.1

- 首个 GitHub Release（原 cortico-world-tts）
