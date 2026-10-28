// fatfish package.json 0.6.10: version bump + description + locales 全更新
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:\\myfriend\\coopanion-coopanion-fatfish';
const pkgPath = path.join(ROOT, 'package.json');
const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

p.version = '0.6.10';

// 压缩版 description（npm 顶层硬限 255 UTF-8 字节）
// 砍冗余：中文核心信息 + 极简英文，locale 完整双语放 cortico.locales
const zh = 'DSH 对话/语音。需 connector-dsh（仅GitHub, ≥0.2.10）。relayPerson & relayPet 默认关。升级 connector 有持久化转发 + CSWSH 安全。';
const en = 'DSH chat/voices. Needs connector-dsh (GitHub only, ≥0.2.10). Both relays off. Upgrade for fix.';
p.description = zh + ' / ' + en;
const bytes = Buffer.byteLength(p.description, 'utf8');
console.log('description:', bytes, '字节 (限 255)');
if (bytes > 255) { console.log('⚠️ 超 255，需压缩'); process.exit(1); }

// 完整 locales 双语描述（扩展市场 UI 读这个，不受 255 限制）
const zhDesc = [
  '和 DeepSeek Harness（DSH）对话，让它帮你干活、写代码；宠物回复你的时候用内置语音包读出声（Windows 与 macOS）。桥接需要先装 DSH 的 Host 插件才会连——不会装就看源码仓库说明，或把仓库地址交给 AI 帮你装。固定会话需 Host 插件 coopanion-connector-dsh ≥ 0.2.10（仅 GitHub 分发，未上 npm）。',
  '',
  '### 新装用户请注意：两个转发开关默认都关',
  '',
  '- **relayPerson**（转发人物打字到 DSH）默认关 → 想让打字自动进 DSH，在配置里打开它。这是主路径功能，旧版本曾默认开，本次回归 opt-in',
  '- **relayPet**（转发桌宠台词到 DSH）默认关 → 想让桌宠说的话也变成 DSH 的 user/message，打开它。但注意：如果同时开了 relayPerson + connector 侧 forwarding，容易形成"桌宠↔DSH"两嘴互聊循环，通常保持默认关更安全',
  '',
  '### 为什么必须升级 connector-dsh 到 ≥ 0.2.10',
  '',
  '- v0.2.10 修复 CSWSH 安全漏洞（任意网页可构造 WS 升级劫持桥接）',
  '- v0.2.10 自动转发默认开 + 持久化：用户关掉的转发开关写入 coopanion-forward.json，插件重启不丢。低于 0.2.9 默认关，升级后桥连着但打字递不进去',
  '- connector 是独立仓库：https://github.com/blacksunshy/coopanion-connector-dsh （仅 GitHub 分发，未上 npm）',
].join('\n');

const enDesc = [
  'Chat with DeepSeek Harness (DSH) so it does the work and writes code for you, and hear the pet replies read aloud with built-in voices (Windows and macOS). The bridge needs the DSH Host extension installed first — if that sounds hard, open the source repo and let an AI walk you through it. Pinning a session needs the DSH host extension coopanion-connector-dsh ≥ 0.2.10 (GitHub only, not on npm).',
  '',
  '### Fresh install note: both forward switches default OFF',
  '',
  '- **relayPerson** (relays your typing into DSH) defaults off → open it if you want auto-flow from your keyboard. Main path, previously default-on in older releases.',
  '- **relayPet** (relays pet lines into DSH) defaults off → open it if you want pet words as DSH user/messages. Warning: with relayPerson + connector forwarding on, pet↔DSH chat loops can form.',
  '',
  '### Why upgrade connector-dsh to ≥ 0.2.10',
  '',
  '- v0.2.10 fixes a CSWSH security hole (any webpage could forge a WS upgrade to hijack the bridge)',
  '- v0.2.10 auto-forward default ON + persistence: user opt-outs are written to coopanion-forward.json, surviving plugin restarts. Below 0.2.9 default-off, bridge connects but words never arrive after upgrade',
  '- Connector lives in its own repo: https://github.com/blacksunshy/coopanion-connector-dsh  (GitHub only, not on npm)',
].join('\n');

p.cortico.locales.zh.description = zhDesc;
p.cortico.locales.en.description = enDesc;

fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n', 'utf8');
console.log('✅ package.json');
console.log('version:', p.version);
console.log('bom:', fs.readFileSync(pkgPath)[0] === 0xEF);
