# 更新说明

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
