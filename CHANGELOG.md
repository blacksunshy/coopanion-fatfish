# 更新说明

## 0.6.7 — 修复 npm description 被截断

npm registry 对 `description` 字段有 **255 字节硬上限**。0.6.6 的 package.json 写了 772 字符的中英双语完整 description，publish 时被强制截断到 255 字节，安全提醒的后半段全没了。这次把双语 description 压缩到 254 字节内，同时保留所有关键信息：默认关转发 + DSH 升 v0.2.9 修 CSWSH。

> 注意：255 字节是 UTF-8 字节不是字符数，中文 1 字 = 3 字节，英文 1 字母 = 1 字节。以后每次写 description 都要 `[Text.Encoding]::UTF8.GetByteCount()` 算一遍再 publish。

## 0.6.6

- 默认关闭「转发人物的话」(`relayPerson`)：之前只有「转发桌宠的话」默认关，现在两边都默认关。要让桌宠自动把你说的话（打字、语音转写）转交给 DSH，需要手动在配置里开回去；**这是安全默认值，避免未经审视的自动转交**
- ⚠️ **安全提醒（DSH 侧）**：如果你同时在用 DSH 侧的 `coopanion-connector-dsh` Host 插件，请把它升到 **v0.2.9**（仅 GitHub 分发：`https://github.com/blacksunshy/coopanion-connector-dsh`）。旧版存在 CSWSH 安全漏洞——任意网页可构造 WS 升级请求劫持桌宠与 DSH 之间的桥接（漏洞详情见 connector 仓库 issue #6）。v0.2.9 已修复，升级后建议确认桥接还能正常连上

## 0.6.5

- 补上 DSH 侧的版本要求：**「固定到当前会话」与 `dsh_pick_session` 需要 Host 侧插件 `coopanion-connector-dsh` ≥ 0.2.4**
- 该 Host 插件**只在 GitHub 分发**（`https://github.com/blacksunshy/coopanion-connector-dsh`），**没有发布到 npm**——DSH 插件市场里来源要填仓库地址，不要填 npm 包名；两边版本要配对，桌宠侧用本版（0.6.5）
- 补回 0.6.4 的说明：0.6.4 的 npm 包内 CHANGELOG.md 漏了 0.6.4 段，所以市场详情页当时读不到，这次随 0.6.5 一并带上

## 0.6.4

- 补上 `package.json` 里缺失的 `homepage` 与 `bugs` 字段：Co 扩展市场卡片现在能显示「项目主页」和「问题反馈」两个链接（此前只有 fatfish 没有，其它扩展都有）
- 扩写市场里的简介文案，中英双语：说明这是「DSH 对话 + 语音朗读」的复合包，以及桥接这半边需要先装 DSH Host 插件（`coopanion-connector-dsh`）
- 补 `keywords`，方便在扩展市场里被搜到（tts / voice / edge-tts / dsh / bridge / desktop-pet）

## 0.6.3

- 新增 DSH 桥接面板：「固定到当前会话 / 解除固定 / 刷新测试」三颗按钮，详情见 README 的「桥接面板」段
- 固定会话后，DSH 默认 owner 切到别的会话时桌宠自动 `pick` 回来，不跟着跑
- 刷新测试按钮强制读一次 bridge 状态，标注 session id / model 是否有变化
- 修复面板按钮永远灰色：此前 `setAttribute('disabled', …)` 两个分支都返回空串，等于无条件禁用；改为 `toggleAttribute('disabled', 布尔值)`
- 修复 invoke 期间 3 秒轮询把按钮状态刷回去的竞态：bind/unbind 期间 `show()` 跳过按钮刷新

> ⚠️ 固定会话功能**仅在 DSH 桌面版（Electron）里可靠**，CLI 模式（`dsh web --no-open`）会话重启即丢，固定的 session id 会失效。

## 0.6.2

- 修复 DSH 换了端口后要等很久才连上：此前只在「连接失败」后才扫端口，且扫空了要等 20 秒冷却，实测能空等 80 秒。现在启动时先扫一次（不再等第一次连接失败），扫空了按 3 秒起步、翻倍到 30 秒重试，找到就立刻重连
- 记住上次连上的端口（`<dataDir>/fatfish-bridge.json`）：Co 重启而 DSH 没重启时直接连旧端口，不再扫一遍；DSH 重启后该端口失效，回落到扫描，只多一条连接被拒的日志
- 全段扫描的并发从 512 降到 64：本机实测扫描耗时几乎不变，但避免部分 Windows 环境因瞬间句柄/临时端口耗尽而整个扫描失败
- 升级握手被 DSH 拒绝时补一条日志：`DSH bridge upgrade rejected: HTTP <状态码>`（503 通常意味着 DSH 的 web server 在、但插件没接管这条升级），不再只表现为一句 socket 断开

## 0.6.1

- 修复 `dsh_pick_session` 没有写进自描述：运行时一直提示「工具不在 describe.tools 里」，World 页的工具列表也看不到它。现在和 `dsh_send`、`tts_hush` 一样正常列出
- 修复网络抖动后一直没声音：合成失败（如 Edge TTS 连接超时）后不再复用那条坏掉的 WebSocket，会自动换新连接重试一次，仍失败才跳过这句并进入冷却；此前坏连接会一直留在手里，往往要等 World 重启才恢复
- 语音包下拉在英文界面显示英文标签
- 语音包说明写明：「自定义」沿用你现有的音色、语速、音高与音量，升级不会改动它们

## 0.6.0

- 新增「语音包」：一套现成的音色、语速、音高与音量组合，选一个就整体生效（温柔女声、活泼少女、少年音、播音腔、东北口音、陕西口音、粤语女声、台湾女声、English）。选「自定义」才用你自己调的几项
- 新增「音高」设置，语速多了 ±5% 两档
- 音色列表补全：新增陕西晓妮、台湾曉雨、台湾雲哲、粤语曉佳；移除已下线的晓墨（旧版本选到它会合成失败、没有声音）
- 列表外的 Edge TTS 音色仍可让 Coo 手填

## 0.5.0

- 新增 `dsh_pick_session` 工具：把桌宠说话的对象切到指定的 DSH 会话（按 id）。默认桌宠跟着最新的会话走，归档当前会话后可用它切回某个还开着的旧会话；会话不存在会被拒绝。需要 Host 侧 coopanion-connector-dsh ≥ 0.2.0 才支持

## 0.4.0

- 新增 DSH 断线自动找回（来自 @hitenkeifans 的 PR #4）：DSH 桌面端每次启动都换临时端口，配置的地址会失效。现在连不上时会扫回环临时端口段（49152–65535，约 2 秒、20 秒冷却、只在断线后扫），用 `/coopanion/status` 认出 Host 后自动改地址重连；发现的地址失效时回落到配置地址。测试可用 `discover: false` 关掉

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
