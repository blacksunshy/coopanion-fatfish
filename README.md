# cortico-world-fatfish · 大肥鱼功能复合包

Coopanion 桌宠的 Cortico World 扩展。一句话：**和 DeepSeek Harness（DSH）对话，让它帮你干活、写代码；宠物回复你的时候，用内置语音包读出声。**

- **让 DSH 干活**：把桌宠接上 DeepSeek Harness（DSH）——它听见你说话就替你转交给 DSH，DSH 干的活、写的代码、调的工具、等的批准，都变成消息回到对话里；没有回执的台词才需要宠物递话，重启后不会重复转交。
- **回复有声音**：内置 16 个 Edge TTS 音色（晓晓、云希、Aria、Jenny 等），宠物回复你的同时读出声；语速、音量可调，桌宠提问时连选项一起读。
- **需要先装 DSH 的 Host 插件**：桥接这半边依赖 DSH 侧的 [`coopanion-connector-dsh`](https://github.com/blacksunshy/coopanion-connector-dsh)，没装它桥不会连（语音朗读不依赖，装完本包就能用）。

两半共用一次事件扫描，各自记各自的进度，都只读启动之后的新消息：语音从启动后的第一条开始（重启不重播），桥接也只转发启动之后你说的话（重启不补发旧的）；启动时还没连上 DSH 的那几句会先排队，连上后补发。

## 安装

在 Coopanion WebUI 的扩展页安装本包（tgz 或 npm 包名 `cortico-world-fatfish`），重启应用生效。

从源码安装（git 克隆本仓库后）：仓库里已带构建产物 `dist/webui.js`，克隆后装一次依赖即可（`prepare` 脚本会按当前源码重建它）：

```bash
pnpm install
```

只有本扩展、没有 DSH 侧插件，桥不会连（语音不受影响）；DSH 侧的安装见 [`coopanion-connector-dsh`](https://github.com/blacksunshy/coopanion-connector-dsh) 的 README。

> **不会装？** 把本仓库（`https://github.com/blacksunshy/coopanion-fatfish`）和 DSH 插件仓库（`https://github.com/blacksunshy/coopanion-connector-dsh`）的地址发给任意 AI 助手，让它带你一步一步装。

## 配置

配置节为 `worlds.fatfish`，一个节管两半：

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `bridgeEnabled` | 启用 DSH 桥接 | `true` |
| `url` | Host 半区的 WebSocket 地址 | `ws://127.0.0.1:19387/coopanion/pet` |
| `relayPerson` | 把你说的话转交给 DSH | `true` |
| `relayPet` | 把桌宠自己说的、做的转交给 DSH | `false` |
| `ttsEnabled` | 朗读桌宠的回复 | `true` |
| `voice` | Edge TTS 音色 ShortName（下拉可选，可手填） | `zh-CN-XiaoxiaoNeural` |
| `rate` / `volume` | 语速 / 音量的相对变化，如 `+15%` | `+0%` |
| `readOptions` | 桌宠提问时把选项也读出来 | `true` |

## 开发

```bash
pnpm test        # vitest：桥接握手、事件转写、双游标扫描与配置组
pnpm run typecheck
pnpm run build   # 重建 dist/webui.js（esbuild）
```

`cortico/*` 的框架类型由 `types/cortico.d.ts` 的类型壳提供（仅编译期）；运行时由 Coopanion 的扩展加载器绑定。

本包面向 Cortico 扩展契约 **world api 6**（Coopanion v0.2.3 / Cortico 0.2.2）：World 的 `webUi()`、manifest 的 `webUiClient`、`describe.json` 自描述均按该契约。旧版（api 5）Coopanion 可经框架过渡层加载，下个大版本将移除。

Edge TTS 客户端从 [`msedge-tts`](https://github.com/Migushthe2nd/MsEdgeTTS) v2.1.0（MIT）vendor 进 `src/vendor/msedge-tts/`：上游带 `preinstall: npx only-allow pnpm` 脚本，pnpm 11 默认把未批准的依赖构建脚本当安装失败处理，依赖它会拖垮任何人的扩展安装；vendor 后本包仅剩纯 JS 依赖，无构建脚本。

## License

AGPL-3.0-or-later
