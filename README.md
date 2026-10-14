# coopanion-tts · 桌宠语音朗读扩展

让 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)（Cortico 架构）桌面宠物把回复**读出声来**：Coo 在气泡里说的每一句话，都会用你挑选的音色朗读。

基于 [Edge TTS](https://www.npmjs.com/package/msedge-tts)（微软 Edge 浏览器同款语音，免费、无需任何 API Key），本地合成、本地播放，文本不经过第三方服务器。

## 功能

- **16 个预设音色**，中文下拉直接选：晓晓（温暖女声）、晓伊（活泼女声）、晓墨（沉稳女声）、云希（阳光男声）、云扬（播音男声）、云健（浑厚男声）、云夏（少年音）、晓北（东北口音）、曉曼/萬龍（粤语）、曉臻（台湾腔）、Aria/Jenny/Guy（英语）、七海（日语）、선히（韩语）
- 列表外的音色直接对 Coo 说，它会帮你填任意 Edge TTS 音色名（如 `zh-CN-XiaoyouNeural`）
- **语速 / 音量** 可调（-30% ~ +30%）
- **朗读开关**、提问选项是否一并朗读
- 配置改动**即时生效**，无需重启
- Coo 可用 `tts_hush` 工具随时停下朗读——对它说「别念了」就行

## 安装

要求：Windows（播放走 winmm MCI）；Coopanion 已运行；pnpm（安装 Coopanion 时已具备）。

**一键安装**（在 Coopanion 的扩展目录里直接装 Release 包）：

```powershell
cd <Coopanion 目录>\build\data\extensions
pnpm add https://github.com/blacksunshy/coopanion-tts/releases/download/v0.1.1/cortico-world-tts-0.1.1.tgz --ignore-workspace
```

> `--ignore-workspace` 必须带上：扩展目录位于 Coopanion 的 pnpm 工作区内，缺了它 pnpm 会把包装到主项目里，扩展加载不到。

安装末尾出现的 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: msedge-tts` 提示**属正常**，不影响使用（msedge-tts 是纯 JS 库，无需构建脚本）。

已装过旧版时，重跑同一条安装命令即可覆盖升级；改完配置立即生效，升级后重启一次 Coopanion。

国内网络下载慢时，在 URL 前加透传代理：

```powershell
pnpm add https://gh-proxy.com/https://github.com/blacksunshy/coopanion-tts/releases/download/v0.1.1/cortico-world-tts-0.1.1.tgz --ignore-workspace
```

也可以从 [Releases](https://github.com/blacksunshy/coopanion-tts/releases) 页面下载 `cortico-world-tts-x.y.z.tgz` 后本地安装（`pnpm add <tgz 文件路径> --ignore-workspace`）。

重启 Coopanion，扩展即被加载（控制台「扩展」页可见状态为已加载）。

## 配置

打开控制台（默认 `http://127.0.0.1:17788`）→ 设置 → **语音朗读**：

| 项 | 说明 |
|---|---|
| 朗读桌宠的话 | 总开关 |
| 音色 | 下拉选择，或让 Coo 填写任意 Edge TTS ShortName |
| 语速 | 相对速度，正数更快 |
| 音量 | 相对音量，正数更大 |
| 朗读选项 | Coo 提问时把可选项也读出来 |

## 常见问题

**控制台安装框报「不是合法的 npm 包名」？**
那是把 GitHub 链接粘进控制台「安装扩展」输入框了。该输入框只认 npm 包名或本地目录路径，本扩展走 Release 直链，请用上方命令行安装。若想用控制台装：在仓库页 Code → Download ZIP，解压后在安装框里填**解压目录**（含 package.json 那层）的路径。

**「扩展」页看不到本扩展 / 加载失败？**
确认装到了 `build\data\extensions`（命令行 `pnpm ls` 可查），且重启过 Coopanion；`--ignore-workspace` 漏掉也会导致装错位置。

## 工作原理

Coo 的气泡台词是 `desktop-pet.self` 事件；本扩展以与 DSH 桥接相同的方式扫描事件流，取出 `say` / `ask` 内容，清除 emoji 与 markdown 后交给 Edge TTS 合成 mp3，再用 winmm MCI 在 PowerShell 子进程里播放。新台词到来会打断上一句（与真实对话节奏一致）。非 Windows 平台扩展静默运行，不影响桌宠。

## 许可

AGPL-3.0-or-later，与 Coopanion 主项目一致。
