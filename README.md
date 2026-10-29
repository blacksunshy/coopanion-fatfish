# cortico-world-fatfish · 大肥鱼功能复合包

Coopanion 桌宠的 Cortico World 扩展。一句话：**和 DeepSeek Harness（DSH）对话，让它帮你干活、写代码；宠物回复你的时候，用内置语音包读出声。**

> ⚠️ **安全提醒（DSH 侧）**：如果你同时在用 DSH 侧的 `coopanion-connector-dsh` Host 插件，请把它升到 **v0.2.12**（仅 GitHub 分发：`https://github.com/blacksunshy/coopanion-connector-dsh`）。低于 0.2.9 的旧版存在 CSWSH 安全漏洞——任意网页可构造 WS 升级请求劫持桌宠与 DSH 之间的桥接（漏洞详情见 connector 仓库 issue #6）。**fatfish 自己不受这个漏洞影响，但桥接两端要一起升。** 会话选择器与「解除固定」需要 **≥ 0.2.11**，「新建会话」需要 **≥ 0.2.12**。

- **让 DSH 干活**：把桌宠接上 DeepSeek Harness（DSH）——它听见你说话就替你转交给 DSH，DSH 干的活、写的代码、调的工具、等的批准，都变成消息回到对话里；没有回执的台词才需要宠物递话，重启后不会重复转交。
- **回复有声音**：内置 19 个 Edge TTS 音色（晓晓、云希、东北晓北、陕西晓妮、粤语曉曼、台湾曉臻、Aria、Jenny 等），另有一排「语音包」预设——温柔女声、活泼少女、播音腔、东北/陕西口音、粤语、台湾腔、English 各一档，选一个就把音色、语速、音高、音量整套换好；也可以选「自定义」自己调音色、语速、音高、音量。宠物回复你的同时读出声，桌宠提问时连选项一起读。朗读支持 Windows 与 macOS（Linux 合成可用但暂无播放通道）。
- **需要先装 DSH 的 Host 插件**：桥接这半边依赖 DSH 侧的 [`coopanion-connector-dsh`](https://github.com/blacksunshy/coopanion-connector-dsh)，没装它桥不会连（语音朗读不依赖，装完本包就能用）。**会话选择器、「解除固定」、`dsh_pick_session` 要求该插件 ≥ 0.2.11，「新建会话」、`dsh_new_session` 要求 ≥ 0.2.12**；它**只在 GitHub 分发、没有发布 npm**，DSH 插件市场的来源填仓库地址。

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
| `relayPerson` | 把你说的话转交给 DSH | `false` |
| `relayPet` | 把桌宠自己说的、做的转交给 DSH | `false` |
| `notify` | DSH 干活时哪些进度唤醒桌宠：`results` 只报每轮结果与待批准/回答，`all` 每个事件都唤醒，`off` 只发送不接收 | `results` |
| `ttsEnabled` | 朗读桌宠的回复 | `true` |
| `preset` | 语音包预设（`custom` 才用下面几项） | `custom` |
| `voice` | Edge TTS 音色 ShortName（下拉可选，可手填任意官方音色） | `zh-CN-XiaoxiaoNeural` |
| `rate` / `volume` | 语速 / 音量的相对变化，如 `+15%` | `+0%` |
| `pitch` | 音高的相对变化，如 `-2Hz` | `+0Hz` |
| `readOptions` | 桌宠提问时把选项也读出来 | `true` |

## 桥接面板

Coopanion WebUI → Fatfish 面板显示桥接状态：地址、当前会话、模型、协议版本，并有五颗按钮：

- **新建会话**：在 DSH 侧开一个新会话并把桌宠接过去。所有会话都被归档、桥上一句话都没处放时，按这颗；DSH 会把它建在当前会话所属的项目里（没有则用最近见过的目录，再退到第一个项目）。Coo 也有同样的能力：`dsh_new_session`，且 `dsh_send` 无会话时的拒回文案会指向它。
- **固定到当前会话**：把桌宠锁在 DSH 当前这个会话里。之后 DSH 默认 owner 切到别的会话时，桌宠会自动 `pick` 回来，不跟着跑。固定后面板上标的是「已固定（不跟随）」。
- **解除固定**：真的通知 DSH 侧插件清掉那个固定（`unpin`），桌宠重新「跟随 DSH 活动」。以前这一步只清桌宠自己那份状态，DSH 仍把消息送进"已经放开"的会话。
- **刷新测试**：强制重读一次状态，显示当前 session id / model，若与上次不同会标注"会话 ID 已更新"等；会话列表打开着的话一并重读。快速来回切 tab 之后点它一次就对齐了。
- **选择会话**：列出 DSH 全部实时会话（会话 id、模型、哪个是默认、哪个是固定的；子代理会话不列出），点一行就把桌宠切过去。列表读不出来时提示「读取会话列表失败」，与"DSH 真的没有打开的会话"分开。

> ⚠️ **只切 tab 不说话时，DSH 不会通知插件**：`agent/created` 只在某个 tab 首次打开时发一次，`session/event` 只有真有活动才有；`.dsh` 的持久化里也没有"当前会话"字段。所以桌宠无法实时感知静默导航——想立刻对准，点「刷新测试」或「选择会话」；已经固定（pin）的会话不跟着跑本来就是设计如此。

> 会话选择器与解除固定需要 DSH 侧 `coopanion-connector-dsh` **≥ 0.2.11**；低于它的版本没有 `list-sessions` / `unpin` 帧，本版会退化成"读列表超时"和"解除固定只清本地"。「新建会话」（面板按钮与 `dsh_new_session`）需要 **≥ 0.2.12**，低于它没有 `new` / `created` 帧，会连上但一直等不到会话。该插件只在 GitHub 分发（`https://github.com/blacksunshy/coopanion-connector-dsh`），**未发布到 npm**。

> ⚠️ **CLI 模式（`dsh web --no-open`）不建议用固定会话**：CLI 模式的会话不持久化，重启 `dsh web` 后所有会话都会丢，固定的 session id 也就失效了。固定会话功能**仅在 DSH 桌面版（Electron）里可靠**，桌面版会话跨重启保留。

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
