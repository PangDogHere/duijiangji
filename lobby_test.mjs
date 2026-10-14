/**
 * 公共大厅专项测试：竞选收敛 + 掉线自愈
 *
 * 公共大厅没有服务器，是靠「最先打开 App 的那台手机」临时担任的。
 * 所以必须证明两件事：
 *   ① 多个 App 同时打开，最终只会收敛出**唯一**一个大厅（不会各立山头）
 *   ② 大厅那台手机关掉后，剩下的 App 会**自动接任**，发现能力不断线
 *
 *   运行: node lobby_test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 8091;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(WWW, rel);
  if (!file.startsWith(WWW) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}/index.html`;
console.log(`静态服务: ${BASE}\n`);

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage']
});

let failed = false;
const TAKEOVER_CODE = 'TAKEOV';

async function roleOf(p) {
  try { return (await p.evaluate(() => window.__walkie.lobbyInfo())).role; }
  catch (e) { return ''; }
}
async function waitFor(cond, ms, label, tick = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await sleep(tick);
  }
  console.log(`  ⏱ ${label} 超时（${ms}ms）`);
  return false;
}

try {
  /* ---------- 场景 1：多端同时打开 → 收敛出唯一大厅 ---------- */
  console.log('=== 场景1：三个 App 同时打开，应当收敛出「恰好一个」大厅 ===');
  const ctxs = [], pages = [];
  for (let i = 0; i < 3; i++) {
    const c = await browser.newContext({ permissions: ['microphone'] });
    ctxs.push(c);
    const pg = await c.newPage();
    await pg.goto(BASE, { waitUntil: 'load' });
    pages.push(pg);
  }
  const converged = await waitFor(async () => {
    const rs = [];
    for (const pg of pages) rs.push(await roleOf(pg));
    const h = rs.filter(r => r === 'host').length;
    const c = rs.filter(r => r === 'client').length;
    return h === 1 && c === 2;       // 恰好一个主持、两个接入
  }, 60000, '大厅收敛', 1000);
  const roles = [];
  for (const pg of pages) roles.push(await roleOf(pg) || '(未定)');
  console.log(`  三角色 = ${JSON.stringify(roles)}`);
  const uniq = roles.filter(r => r === 'host').length;
  console.log(`  主持数 = ${uniq}（必须恰好 1）`);
  console.log(`  >>> 场景1: ${converged && uniq === 1 ? '✅ 收敛为唯一大厅，无山头分裂' : '❌ 竞选未收敛'}`);
  if (!(converged && uniq === 1)) failed = true;

  /* ---------- 场景 2：杀掉大厅持有者 → 存活端自动接任 ---------- */
  console.log('\n=== 场景2：关掉担任大厅的那个 App，其余 App 应当自动接任 ===');
  let hostIdx = roles.findIndex(r => r === 'host');
  if (hostIdx < 0) hostIdx = 0;
  const aliveIdx = [0, 1, 2].filter(i => i !== hostIdx);
  console.log(`  关闭 p${hostIdx + 1}（原大厅），保留 p${aliveIdx.map(i => i + 1).join('/')}`);
  await ctxs[hostIdx].close();
  const beforeAlive = [];
  for (const i of aliveIdx) beforeAlive.push(await roleOf(pages[i]));
  console.log(`  断线瞬间存活的角色 = ${JSON.stringify(beforeAlive)}（都该掉成空/重连中）`);

  const tookOver = await waitFor(async () => {
    for (const i of aliveIdx) if ((await roleOf(pages[i])) === 'host') return true;
    return false;
  }, 75000, '接任大厅', 1000);
  const afterAlive = [];
  for (const i of aliveIdx) afterAlive.push(await roleOf(pages[i]));
  console.log(`  接任后存活的角色 = ${JSON.stringify(afterAlive)}`);
  const newHostCount = afterAlive.filter(r => r === 'host').length;
  console.log(`  >>> 场景2: ${tookOver && newHostCount === 1 ? '✅ 大厅掉线后自动接任，发现能力不断' : '❌ 未能自愈'}`);
  if (!(tookOver && newHostCount === 1)) failed = true;

  /* ---------- 场景 3：自愈后新开的 App 依旧能发现 ---------- */
  console.log('\n=== 场景3：自愈之后，新打开一个 App 应当立刻接入并看到目录 ===');
  const hi2 = afterAlive.findIndex(r => r === 'host');
  const nIdx = hi2 >= 0 ? aliveIdx[hi2] : aliveIdx[0];
  const keeper = pages[nIdx];
  const ctxNew = await browser.newContext({ permissions: ['microphone'] });
  const pNew = await ctxNew.newPage();
  await pNew.goto(BASE, { waitUntil: 'load' });
  const joined = await waitFor(async () => (await roleOf(pNew)) === 'client', 45000, '新 App 接入新大厅', 900);
  console.log(`  新 App 角色 = ${await roleOf(pNew)}`);

  await keeper.fill('#nameInput', '接任台长');
  await keeper.fill('#codeInput', TAKEOVER_CODE);
  await keeper.click('#btnCreate');
  const keeperIn = await waitFor(async () => {
    try { return await keeper.evaluate(c => window.__walkie.S.connected === true && window.__walkie.S.code === c, TAKEOVER_CODE); }
    catch (e) { return false; }
  }, 30000, '接任者开频道');

  const seen = await waitFor(async () => {
    try { return await pNew.evaluate(c => window.__walkie.nearbyItems().some(i => i.code === c), TAKEOVER_CODE); }
    catch (e) { return false; }
  }, 45000, '新 App 从大厅看到频道', 900);
  const items = await pNew.evaluate(() => window.__walkie.nearbyItems());
  console.log(`  新 App 首页看到 = ${JSON.stringify(items.map(i => i.code + '(' + i.src + ')'))}`);
  console.log(`  >>> 场景3: ${joined && keeperIn && seen ? '✅ 自愈后新 App 照常「打开即发现」' : '❌ 自愈后发现失效'}`);
  if (!(joined && keeperIn && seen)) failed = true;

  await ctxNew.close();
  for (const i of aliveIdx) { try { await ctxs[i].close(); } catch (e) {} }

  console.log(`\n总体: ${failed ? '❌ 大厅机制仍有问题' : '✅ 公共大厅：唯一收敛 + 掉线自愈 + 打开即发现 全部通过'}`);
} catch (e) {
  console.error('\n测试异常:', e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
