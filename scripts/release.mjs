// fatfish 一键发布脚本 —— 把记忆里所有发布坑固化进代码
// 用法: node scripts/release.mjs <新版本>          （完整发布）
//       node scripts/release.mjs --verify <版本>  （只跑发布后校验）
//
// 覆盖的坑（2026-10-28 前全部踩过）：
//   1. npm description >255 UTF-8 字节会被静默截断 → 发布前硬断言
//   2. package.json 不能用 PowerShell 写（BOM 炸 JSON.parse）→ 全程 node fs
//   3. npm publish 后 metadata 传播 1~5 分钟 → 轮询等到位再继续
//   4. git push 443 超时 + 本地没有远端 commit 对象 → 全程 GitHub Data API
//   5. sync issue 提太早会收录旧版本 → 必须在 npm 轮询确认后提
//   6. gh release/notes 中文文件必须 node 写（Set-Content 炸编码）
//   7. 发布后必须验证 catalog.json 收录的是新版本（bot 会"成功"地收录旧版）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'cortico-world-fatfish';
const REPO = 'blacksunshy/coopanion-fatfish';
const CATALOG_REPO = 'Pal-AI-Lab/cortico-extensions';
const REGISTRY = 'https://registry.npmjs.org';

const args = process.argv.slice(2);
const verifyOnly = args[0] === '--verify';
const version = verifyOnly ? args[1] : args[0];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/release.mjs <x.y.z> | --verify <x.y.z>');
  process.exit(1);
}

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

// ---------- 阶段 0: 发布前断言 ----------
function preflight() {
  console.log('── 阶段 0: 发布前断言');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // description ≤ 255 UTF-8 字节
  const bytes = Buffer.byteLength(pkg.description ?? '', 'utf8');
  console.log(`  description: ${bytes} 字节`);
  if (bytes > 255) fail(`description ${bytes} 字节超 npm 255 上限，会被静默截断`);

  // CHANGELOG 顶部是新版本
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const firstH2 = cl.match(/^##\s+(.+)$/m)?.[1] ?? '';
  console.log(`  CHANGELOG 首段: ${firstH2}`);
  if (!firstH2.startsWith(version)) fail(`CHANGELOG.md 顶部不是 ## ${version}，先写更新说明`);

  // 版本号没发过重
  return pkg;
}

// ---------- 阶段 1: 版本号 + 构建 + 测试 ----------
function bumpAndTest() {
  console.log('── 阶段 1: 版本号 + build + typecheck + test');
  const p = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const bom = fs.readFileSync(p);
  if (bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf) fail('package.json 带 BOM');
  execSync('corepack pnpm run build', { cwd: ROOT, stdio: 'inherit' });
  execSync('corepack pnpm run typecheck', { cwd: ROOT, stdio: 'inherit' });
  execSync('corepack pnpm test', { cwd: ROOT, stdio: 'inherit' });
}

// ---------- 阶段 2: npm publish + 等传播 ----------
async function publishAndWait() {
  console.log('── 阶段 2: npm publish');
  execSync(`corepack pnpm publish --no-git-checks --registry=${REGISTRY}`, { cwd: ROOT, stdio: 'inherit' });
  process.stdout.write('  等 npm metadata 传播');
  for (let i = 0; i < 12; i++) {
    await sleep(30_000);
    process.stdout.write('.');
    try {
      const r = await fetch(`${REGISTRY}/${PKG}/${version}`);
      if (r.ok) { console.log(` ✅ ${version} 可查`); return; }
    } catch { /* retry */ }
  }
  fail(`npm metadata 6 分钟后仍查不到 ${version}`);
}

// ---------- 阶段 3: Data API 推 main + tag + Release ----------
async function pushGithub(notesZh, notesEn) {
  console.log('── 阶段 3: GitHub Data API 推送（绕开 443 超时）');
  const headRef = await api('GET', `https://api.github.com/repos/${REPO}/git/ref/heads/main`);
  const head = await api('GET', `https://api.github.com/repos/${REPO}/git/commits/${headRef.object.sha}`);
  console.log(`  远端 HEAD: ${headRef.object.sha.slice(0, 8)}`);

  // 改动文件 = 相对上一个 tag 的全部变更；本地没有远端对象，改用工作区与 HEAD 的 diff 加上已 commit 的版本文件
  // 稳妥做法：固定推 release 必改的三个文件 + 工作区有改动的文件
  const always = ['CHANGELOG.md', 'package.json', 'README.md', 'src/config.ts'];
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  const files = [...new Set([...always, ...dirty])]
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && !f.startsWith('node_modules'));
  console.log(`  推送文件: ${files.join(', ')}`);

  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const r = await api('POST', `https://api.github.com/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'), encoding: 'base64',
    });
    entries.push({ path: f.replaceAll('\\', '/'), mode: '100644', type: 'blob', sha: r.sha });
  }
  const tree = await api('POST', `https://api.github.com/repos/${REPO}/git/trees`, {
    base_tree: head.tree.sha, tree: entries,
  });
  const commit = await api('POST', `https://api.github.com/repos/${REPO}/git/commits`, {
    message: `v${version}`,
    tree: tree.sha,
    parents: [head.sha],
    author: { name: 'blacksunshy', email: 'blacksunshy@users.noreply.github.com', date: new Date().toISOString() },
  });
  await api('PATCH', `https://api.github.com/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: true });
  console.log(`  main → ${commit.sha.slice(0, 8)} ✅`);

  // tag（存在则先删）
  try { await api('DELETE', `https://api.github.com/repos/${REPO}/git/refs/tags/v${version}`); } catch { /* 不存在 */ }
  await api('POST', `https://api.github.com/repos/${REPO}/git/refs`, { ref: `refs/tags/v${version}`, sha: commit.sha });
  console.log(`  tag v${version} ✅`);

  // Release（notes 用 node 写 UTF-8，不走 PowerShell）
  const notesFile = path.join(ROOT, 'node_modules', '.cache', `release-${version}.md`);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, `${notesZh}\n\n---\n\n${notesEn}\n`, 'utf8');
  try {
    execSync(`gh release create v${version} --repo ${REPO} --title "v${version}" --notes-file "${notesFile}" --target main`, { stdio: 'inherit' });
  } catch {
    execSync(`gh release edit v${version} --repo ${REPO} --notes-file "${notesFile}"`, { stdio: 'inherit' });
  }
  console.log('  Release ✅');
}

// ---------- 阶段 4: sync issue ----------
async function syncCatalog() {
  console.log('── 阶段 4: 索引仓 sync issue');
  const bodyFile = path.join(ROOT, 'node_modules', '.cache', `sync-${version}.md`);
  fs.writeFileSync(bodyFile, `${PKG} 已发布 ${version} 到 npm：${REGISTRY}/${PKG}/v/${version}\n\nnpm metadata 已确认传播完成，请触发一次 catalog 同步。\n`, 'utf8');
  const out = execSync(
    `gh issue create --repo ${CATALOG_REPO} --title "[sync] ${PKG} ${version}" --body-file "${bodyFile}" --label sync`,
    { encoding: 'utf8' },
  ).trim();
  console.log(`  ${out}`);
  return out.split('/').pop();
}

// ---------- 阶段 5: 验证 catalog 收录的是新版本 ----------
async function verifyCatalog() {
  console.log('── 阶段 5: 验证 catalog（bot 可能"成功"地收录旧版，必须看版本号）');
  for (let i = 0; i < 12; i++) {
    await sleep(60_000);
    try {
      const j = await api('GET', `https://api.github.com/repos/${CATALOG_REPO}/contents/catalog.json`);
      const c = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      const got = c.packages?.[PKG]?.version;
      process.stdout.write(`  第${i + 1}次: catalog=${got}\n`);
      if (got === version) {
        console.log(`\n✅ 全部完成: npm=${version}, GitHub tag=v${version}, catalog=${version}`);
        return;
      }
    } catch (e) { console.log(`  查询失败: ${e.message.slice(0, 80)}`); }
  }
  fail(`catalog 12 分钟后仍不是 ${version}，去索引仓重提 sync issue`);
}

// ---------- 主流程 ----------
if (verifyOnly) {
  await verifyCatalog();
} else {
  const rl = await import('node:readline');
  const r = rl.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => r.question(q, res));
  const notesZh = await ask('Release notes 中文段（单行）: ');
  const notesEn = await ask('Release notes English section (single line): ');
  r.close();
  if (!notesZh || !notesEn) fail('notes 不能为空');

  preflight();
  bumpAndTest();
  await publishAndWait();
  await pushGithub(notesZh, notesEn);
  await syncCatalog();
  await verifyCatalog();
}
