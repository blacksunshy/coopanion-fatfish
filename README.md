# cortico-world-fatfish · 大肥鱼功能复合包

Coopanion 桌宠的 Cortico World 扩展：桌宠与外界的连接，一体两用。

- **DSH 桥接**：把桌宠接到 DeepSeek Harness（Host 半区 [`coopanion-connector-dsh`](https://github.com/blacksunshy/coopanion-connector-dsh)）。桌宠听见你说的话（可关），DSH 的通知变成事件给桌宠判断；它递给 DSH 的每一句都留一张回执，重启后不会重复转交。桌宠自己开口说的内容由 `relayPet` 决定是否也讲给 DSH 听。
- **语音朗读**：用 Edge TTS 把桌宠的回复读出来（16 个内置音色）。说话就是气泡的回声，唯一的工具是用来让它闭嘴的。

两半共用一次事件扫描，各自记各自的进度：语音从最新一条开始（重启不重播），桥接回看一小段（重启后不重复转交）。

## 安装

在 Coopanion 控制台的扩展页安装本包（tgz 或 npm 包名 `cortico-world-fatfish`），重启应用生效。

从源码安装（git 克隆本仓库后）：仓库里已带构建产物 `dist/console.js`，克隆后装一次依赖即可（`prepare` 脚本会按当前源码重建它）：

```bash
pnpm install
```

只有本扩展、没有 DSH 侧插件，桥不会连上；DSH 侧的安装见 [`coopanion-connector-dsh`](https://github.com/blacksunshy/coopanion-connector-dsh) 的 README。

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
pnpm run build   # 重建 dist/console.js（esbuild）
```

`cortico/*` 的框架类型由 `types/cortico.d.ts` 的类型壳提供（仅编译期）；运行时由 Coopanion 的扩展加载器绑定。

Edge TTS 客户端从 [`msedge-tts`](https://github.com/Migushthe2nd/MsEdgeTTS) v2.1.0（MIT）vendor 进 `src/vendor/msedge-tts/`：上游带 `preinstall: npx only-allow pnpm` 脚本，pnpm 11 默认把未批准的依赖构建脚本当安装失败处理，依赖它会拖垮任何人的扩展安装；vendor 后本包仅剩纯 JS 依赖，无构建脚本。

## License

AGPL-3.0-or-later
