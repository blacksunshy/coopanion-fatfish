# 更新说明

## 0.3.9

- 修复语音合成完全失效：微软把 Edge 朗读接口的认证升级为 Sec-MS-GEC v2，且 Akamai 边缘节点对「不像 Edge 客户端」的握手直接回 HTTP 200 拒绝升级（报 `Unexpected server response: 200`）。vendor 内的 `MsEdgeTTS` 升级为 v2 token（CS64+SHA256 两段式，算法移植自 readest PR #6751 / rany2/edge-tts PR #492，含官方测试向量），`Sec-MS-GEC-Version` 升到 `2-`，握手头补齐到 Edge 客户端全套（`Cookie: muid`、`Sec-CH-UA*`、`Sec-Fetch-*` 等——Electron 宿主比普通 Node 更挑，只补部分头仍会 200，见 issue #2）。升级后需完全重启 Coopanion（必要时清 `data\tmp\tsx-windows` 与 `data\tmp\node-compile-cache`）

## 0.3.8

- 修 0.3.7 的头像图在扩展市场不显示：图标超过了官方索引仓收录的 512KB 上限（640KB 被拒收，catalog 里没有 icon 字段），重制为 256×256 / 约 180KB，本地卡片与市场卡片都能取到图

## 0.3.7

- 扩展卡片有了自己的头像（`cortico.icon`：蓝发女仆抱大肥鲸，512×512），不再是淡色的 Cortico 默认标志；新建部署时也会被复制成 bot 的头像

## 0.3.6

- 简介补上平台说明：朗读支持 Windows 与 macOS（0.3.5 只写进了更新说明和 README，扩展市场卡片上看不到）

## 0.3.5

- 朗读支持 macOS：播放改走系统自带的 `afplay`（Windows 仍走 winmm MCI），行为一致——播完即结束、新句打断旧句、`tts_hush` 停播清队；其余平台合成可用但暂无播放通道，维持跳过并记一次日志

## 0.3.4

- 桥接从未连上过 DSH 时不再积攒待发队列：启动后 30 秒内（宽限期）句子照旧排队等一个迟到的 DSH；宽限期过了还没连上（没装/没开 DSH Host 的朗读用户），之后说话静默放行——不再积 16 条、不再逐句推"被丢下"通知、不再用 flush 反复唤醒 bot。桥接只要连上过一次，断线期间的排队与补发行为保持不变

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
