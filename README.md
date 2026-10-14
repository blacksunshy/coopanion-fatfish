# coopanion-tts · 桌宠语音朗读扩展

让 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)（Cortico 架构）桌面宠物把回复**读出声来**：Coo 在气泡里说的每一句话，都会用你挑选的音色朗读。

基于 [Edge TTS](https://www.npmjs.com/package/msedge-tts)（微软 Edge 浏览器同款语音，免费、无需任何 API Key），本地合成、本地播放，文本不经过第三方服务器。

## 功能

- **16 个预设音色**，中文下拉直接选：晓晓、晓伊、云希、云扬、云健、云夏、晓北（东北话）、晓臻（陕西话）、云杰（河南话）、晓多（台湾话）、曉曼/曉恩（粤语）、云枫（英语）、奈奈美（日语）、善英（韩语）等
- 列表外的音色直接对 Coo 说，它会帮你填任意 Edge TTS 音色名（如 `zh-CN-XiaoyouNeural`）
- **语速 / 音量** 可调（-30% ~ +30%）
- **朗读开关**、提问选项是否一并朗读
- 配置改动**即时生效**，无需重启
- Coo 可用 `tts_hush` 工具随时停下朗读——对它说「别念了」就行

## 安装

要求：Windows（播放走 winmm MCI）；Coopanion 已运行。

从 Release 下载 `cortico-world-tts-x.y.z.tgz`，然后在 Coopanion 的扩展目录安装：

```powershell
cd <Coopanion 目录>\build\data\extensions
pnpm add <tgz 文件路径或下载直链>
```

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

## 工作原理

Coo 的气泡台词是 `desktop-pet.self` 事件；本扩展以与 DSH 桥接相同的方式扫描事件流，取出 `say` / `ask` 内容，清除 emoji 与 markdown 后交给 Edge TTS 合成 mp3，再用 winmm MCI 在 PowerShell 子进程里播放。新台词到来会打断上一句（与真实对话节奏一致）。非 Windows 平台扩展静默运行，不影响桌宠。

## 许可

AGPL-3.0-or-later，与 Coopanion 主项目一致。
