# 更新说明

## 0.6.17 — 未发布

- **选择框提醒（`askRemind`，默认关）**：DSH 弹选择框（`ask_user_question`）时，桌宠直接念一句固定的「请选择」，0/10/60/120 秒各一次，用户选中/跳过/超时立即停；**不叫醒桌面 AI**——省 token，也避免和「DSH 通知」的提醒叠成两句。
- 开关在「DSH 桥接」组里，可随时关；关闭时行为与旧版完全一致。按住说话键（hush）或关掉朗读时，提醒同样不发声。
- 配套：`coopanion-connector-dsh` ≥ 0.2.17（新增 `question` / `question-end` 帧）。旧 Host 不发帧时该开关无副作用；本扩展也忽略它不认识的帧。

## 0.6.16 — 朗读引擎可插拔（edge / http）+ 可选分句流水线（致谢 @ink1453）

合入社区 PR [#11](https://github.com/blacksunshy/coopanion-fatfish/pull/11)（对应 issue [#10](https://github.com/blacksunshy/coopanion-fatfish/issues/10) 的建议 1 与建议 3）。两项都是 opt-in：**不写新键时，行为与 0.6.15 完全一致**。

### 1) 可插拔朗读引擎

- 新增 `engine`：`edge`（默认，内置微软 Edge TTS）或 `http`（你自己的语音服务）
- `http` 引擎按最小契约工作：`POST {input, voice, speed}` 到 `httpUrl`，返回 `audio/wav` 或 `audio/mpeg`；音频落临时文件后仍走原来的播放链路（Windows MCI / macOS afplay），打断与 `tts_hush` 全部不变
- `fallbackEdge`（默认开）：HTTP 服务失败或超时**静默回退 Edge**，宠物不会失声；关掉则跳过该句
- `timeoutMs`（默认 20000）是单次请求上限；`speed`（默认 1，范围 0.25–4）随请求体发出
- Windows 播放入口改为按文件扩展名选设备（`.wav` → `waveaudio`，`.mp3` → `mpegvideo`），HTTP 返回 wav 也能直接播
- 桥接半边零改动，无新依赖（用 Node ≥22 自带的 fetch）

### 2) 分句流水线（opt-in，默认关）

- `sentencePipelineEnabled`（默认 `false`）打开后：不超过 `sentencePipelineMaxChars`（默认 40）的气泡按中英句末标点切开，播第 k 句的同时预合成第 k+1 句，句间空隙只剩剩余合成时间
- 超过阈值的长句仍整段一次合成：首声慢一些，但绝对没有句缝
- `tts_hush` 兼容：预合成但还没播的片段会被丢弃，不会在打断之后补念
- 过短的片段（少于 6 字）会并入下一句，不会单独成片段

### 配置文件写坏也不会失声

非法 `engine` 当 `edge` 处理，数值越界会被钳制，缺省的键全部回落到安全默认值。

关于「说话键取消朗读」和「跨扩展一次只一个声音」：这两项的事件源与约定在 desktop-pet core，本包只消费事件，已在主仓提 issue 跟踪（[Pal-AI-Lab/Coopanion#556](https://github.com/Pal-AI-Lab/Coopanion/issues/556)），不在本版范围。

## 0.6.15 — 启动不再无条件全端口扫描；自动发现可关闭（VPN 兼容）

市场评论里 @Barlthor 报告：使用本扩展会与 VPN（0cloud）冲突，表现为 VPN 内核反复断开。

- **根因（最可能）**：本扩展启动时**无条件**对整个动态端口范围做一轮 TCP 扫描找 DSH（最多 6 万+ 个连接、约 2 秒、并发 64），连不上 DSH 时还会每 3~30 秒重扫。VPN 客户端若用 TUN / LSP / WFP 之类方式钩住回环或全局流量，这批连接会全部穿过它的内核——0cloud 的内核被打到反复重启，重启期间 DSH 还是连不上，桌宠再扫，形成循环
- **修复 1：缓存优先，不再每次启动都扫**。上次连上的端口本来就记在 `fatfish-bridge.json`（7 天内有效），但旧版启动时照样强制全扫；现在启动先拨缓存端口，拨不上（毫秒级失败）才开始扫描——缓存有效时整轮扫描完全不发生
- **修复 2：自动发现做成配置项 `discover`（默认开）**。被 VPN/安全软件误报的用户可以关掉它，改为在「地址」里手填固定端口——配合把 DSH 的 `webserver.port` 在 profile 里钉住（见 DSH 侧 README），彻底没有任何扫描行为
- 新增回归测试：缓存新鲜时启动不扫（哨兵端口 2.6 秒内零连接）、无缓存时启动照常扫
- 语音（Edge TTS）不受影响：它只做出站公网连接，不会反向影响 VPN

本地没有 0cloud 环境，无法直接复现该冲突；升级后若仍复现，请带上插件版本、VPN 的代理模式（TUN/系统代理/虚拟网卡）与断开时机反馈。

## 0.6.14 — 端口发现修盲区、面板显示真实地址、新建会话可指定工作区（致谢 @allisera）

合入社区三个 PR（[#6](https://github.com/blacksunshy/coopanion-fatfish/pull/6) / [#7](https://github.com/blacksunshy/coopanion-fatfish/pull/7) / [#8](https://github.com/blacksunshy/coopanion-fatfish/pull/8)）与 DSH 侧 issue [#9](https://github.com/blacksunshy/coopanion-fatfish/issues/9) 的配套修复：

- **端口发现不再漏扫低段动态端口（PR #6）**：原扫描写死 49152–65535，但有些机器 `netsh int ipv4 show dynamicport tcp` 的范围从 1024 开始（实测 DSH 落在 13141，旧扫描永远找不到）。现在 Windows 上运行时读 netsh 的实际范围（按数字解析，不受系统语言影响），读不到回退 1024–65535，结果缓存一次
- **面板与 `fatfish-bridge.json` 显示实际拨号的地址（PR #7）**：`start()` 拨号后同步 `rediscover(true)` 会清掉发现缓存，面板曾因此显示配置端口（19387）而非真正连上的端口（13141）。现在在拨号瞬间记下目标，连上后记录的就是真实地址
- **新建会话可指定工作区 + 新工具 `dsh_workspaces`（PR #8，需 connector ≥ 0.2.14）**：`dsh_new_session` 增加可选 `workspace` 参数（id 或路径），Host 回执带实际落点——旧 Host 静默忽略时如实报「无法确认落在指定工作区」而不是假装成功；`dsh_workspaces` 列出 DSH 各项目的 id / 路径 / 打开的会话数。connector 0.2.14 起 Host 侧匹配不上指定工作区会直接拒回并列出可用路径，绝不静默落到别处
- **DSH 侧 issue #9 的根因在 connector，已随 0.2.14 修复**：cordis 里未 inject 的服务属性是会抛错的访问器，`apply()` 开头的探测把插件整个炸掉、路由全灭；建议两边一起升

## 0.6.13 — DSH 通知默认只报结果，不再逐条唤醒（致谢 @minekooooo）

- **新增 `notify` 三档**：
  - `results`（默认）：每轮结束合并成一条通知，内容含 DSH 的回复与本轮工具调用次数；等待批准、等待回答、出错仍然立即推送
  - `all`：旧行为，每个事件一条（`turn-start`、每次工具调用、每条回复、`turn-end`）
  - `off`：只发送不接收——桌宠仍能向 DSH 说话，DSH 不再唤醒桌宠
- **根因**：connector 对 `turn-start`、每次 `tool/call`、每条 `assistant/message`、`turn-end` 逐帧发帧，桌宠对每一帧推一条 notice 且 `trigger: 'flush'`（立即唤醒 Co）——每条通知 = 一次模型调用。有人实测 DSH 干活 100 秒被唤醒 26 次，绝大多数是工具调用的过程噪音
- results 档下 5 秒兜底：这一轮迟迟收不到 `turn-end` 时，把已有回复单独报出来，不会因为结束帧丢失而一直沉默
- 合并只发生在桌宠侧，connector 不需要升级，旧版 Host 一样生效
- 想看每一步细节时把 `notify` 切回 `all` 即可，不用降级

## 0.6.12 — 没有会话时新建一个（PR #5，致谢 @ink1453；配合 connector 0.2.12）

- **面板新增「新建会话」按钮，Coo 新增 `dsh_new_session` 工具**：所有会话都被归档后，DSH 侧没有打开的会话，`dsh_send` 会被拒回；现在可以在 DSH 侧开一个新会话，建好即是 owner，桌宠自动接过去（协议新增 `new` / `created` 一对帧）
- 需要 DSH 侧 `coopanion-connector-dsh` **≥ 0.2.12**；旧版 Host 不认识 `new` 帧，会连上但一直等不到会话
- 新建成功会清掉「固定到当前会话」的 pin：你刚换掉的会话不该再把桌宠拉回去
- connector 0.2.12 起 `dsh_send` 的拒回文案在无会话时改为指向 `dsh_new_session`，Coo 能自己补齐这一步
- 本版合入社区 PR [#5](https://github.com/blacksunshy/coopanion-fatfish/pull/5)，commit 保留原作者署名

## 0.6.11 — 会话选择器 + 「解除固定」真正下发（配合 connector 0.2.11）

### 新增「选择会话」

- 桥接面板多一颗「选择会话」按钮：列出 DSH 全部实时会话（会话 id、模型、哪个是默认、哪个是固定的、子代理会话不列出），点一行就把桌宠切过去，不用再猜 id
- 固定状态下分两行显示「已固定（不跟随）」和「跟随 DSH 活动」，谁锁定、谁在跟着活动走一眼看得出

### 修复

- **面板显示「DSH 没有打开的会话」，但 DSH 明明有**：桌宠的帧解析器此前把 connector 的 `session-list` 当成未知帧丢掉，于是每次读列表都干等 10 秒超时后返回空。已补上解析
- **点「解除固定」状态不刷新**：此前只清了桌宠本地的 `pinnedSession`，DSH 侧的固定（pin）还在，DSH 继续把消息送进"已经放开"的会话、面板也还标着已固定。现在先向 connector 下发 `unpin`，成功后才清本地状态；connector 不支持时会直接报错，不再假装成功
- **切 tab 之后「会话」这一行永不更新**：以前只在握手时写一次。现在每次状态轮询都向 connector 问一次真实 owner（2.5 秒超时，问不到就保留旧值）
- **快速来回切换后列表标记错乱、旧响应盖掉新状态**：列表改为每次重绘（当前 / 已固定 / 默认三个标记都重算），并用读序号丢弃迟到的轮询响应；「刷新测试」现在把状态和打开中的列表一起重读
- 读列表失败与"真的没有会话"分开提示：前者显示「读取会话列表失败：DSH 没有回应，稍后再试」，不再误导成 DSH 真的没有会话

### 关于「快速切 tab 后会话 id 卡住」

DSH 只在真有活动（`agent/created`、`session/event`）时才通知插件，**只切 tab、不说话时一条事件都没有**——`agent/created` 只在该 tab 首次打开时发一次，所以多切几次就对不上了；`.dsh` 的持久化里也没有"当前会话"这个字段，桌宠无从得知静默导航。想立刻对准：点「刷新测试」或「选择会话」手动选一个。已经固定（pin）的会话本来就不该跟着跑，这种情况下 id 不动是正确行为。

### 需要 DSH 侧配合

会话列表与解除固定需要 DSH Host 插件 `coopanion-connector-dsh` **≥ 0.2.11**（仅 GitHub 分发，未上 npm）。低于 0.2.11 的 connector 没有 `list-sessions` / `unpin` 帧，本版会退化成"读列表超时"和"解除固定只清本地"。

## 0.6.10 — relayPerson 回归默认关（opt-in）+ DSH connector 升级提醒

### 为什么又把 relayPerson 改回默认关

0.6.6 把 relayPerson（转发人物打字到 DSH）默认从 `true` 改成 `false`，本意是"诚实认识论"——桌宠是第二张嘴，不是静默输入通道，默认关避免两边互聊循环。但那次改默认值**没有在 UI 上给够提示**，导致用户升级后桥明明连着、打字却不自动转 DSH，必须手动开配置才恢复——**默认关等于升级后主路径功能消失**。

0.6.9 改回了 `true`（让主路径先能用）。但回归 opt-in 才是长期方向：**基础设施不替用户做"要不要转发"的决定**。

这次 0.6.10 把 relayPerson 再改回 `false`，但**三个关键变化**保证不再踩 0.6.6 的坑：

1. **所有面向用户的文案（README、package.json locales、扩展市场描述）最显眼位置明确写了怎么开、为什么开**
2. **明确写了为什么要升级 DSH connector 到 ≥ 0.2.10**——v0.2.10 修复 CSWSH 安全漏洞 + 自动转发默认开 + 持久化（关掉的开关重启不丢）
3. **config.ts 里 relayPerson 和 relayPet 对称**——两个都是默认关，用户按自己的场景 opt-in

### 关于 relayPet（保持默认关）

relayPet（转发桌宠台词到 DSH）从 0.6.5 起就默认关，这次不动。原因：桌宠台词 → DSH → 桌宠听到 DSH 回复 → 桌宠再说话，容易形成两嘴互聊循环。只有当你明确要"让桌宠说的每句话也变成 DSH 的 user/message"时才开它。

### 关于 DSH connector-dsh ≥ 0.2.10

这是**强升级要求**。低于 0.2.10 的 connector：
- v0.2.9 只修了 CSWSH（Origin 拒绝），但自动转发仍是默认关，没有持久化
- v0.2.8 之前没有 CSWSH 修复，也没有持久化
- **只有 ≥ 0.2.10** 同时满足：CSWSH 修复 + 自动转发默认开 + 持久化（关掉的开关写入 coopanion-forward.json）

> ⚠️ connector 是独立仓库（https://github.com/blacksunshy/coopanion-connector-dsh），仅 GitHub 分发，不上 npm。DSH desktop profile 里用 `pnpm add github:blacksunshy/coopanion-connector-dsh` 升级。

## 0.6.9 — 把 relayPerson 默认值改回 true

0.6.6 把「转发人物的话」(`relayPerson`) 默认从 `true` 改成 `false`，本意是安全默认值（诚实认识论）。但这是主路径功能——绝大多数用户升级后桥明明连着，打字却自动不转 DSH，要手动开配置才恢复。**默认关 = 升级等于功能消失**，不合适。

这次改回 `true`，`relayPet` 保持 `false`（桌宠自己的台词自动转发进 DSH 容易形成两嘴互聊的循环，仍默认关）。

如果你的产品场景就是默认不开自动转发，**升级后在配置里显式关掉 `relayPerson` 即可**，不要等默认值帮你做这个决定。

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
