/**
 * 界面截图：给用户看 v1.3 的新 UI（不用装 APK 也能看）
 *   node shot.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 8090;
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

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage']
});

const shot = async (p, name, note) => {
  await p.screenshot({ path: path.join(__dirname, name) });
  console.log(`✓ ${name}（${note}）`);
};

try {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 400, height: 920 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'load' });

  // 造一个「上次来过」的历史
  await p.evaluate(() => {
    localStorage.setItem('walkie.name', '胖狗');
    localStorage.setItem('walkie.autoRejoin', '0');       // 先停在首页截图
    localStorage.setItem('walkie.lastChannel', JSON.stringify({ code: 'K7M4XQ', role: 'host', name: '胖狗', at: Date.now() }));
    localStorage.setItem('walkie.recent', JSON.stringify([
      { code: 'K7M4XQ', role: 'host', name: '胖狗', at: Date.now() },
      { code: 'AB39X7', role: 'member', name: '胖狗', at: Date.now() - 86400000 }
    ]));
  });
  await p.reload({ waitUntil: 'load' });
  await sleep(900);
  await shot(p, 'shot_home.png', '首页：版本号 + 自定义频道码 + 一键重回');

  // 模拟收到两条局域网广播 → 触发预警
  await p.evaluate(() => {
    window.__walkie.injectBeacon({ code: 'NEARBY', name: '老王', host: '老王', members: 3, ip: '192.168.1.23' });
    window.__walkie.injectBeacon({ code: 'LUCKY7', name: '小李', host: '小李', members: 2, ip: '192.168.1.31' });
  });
  await sleep(500);
  await shot(p, 'shot_nearby_alert.png', '★ 发现可连接频道的预警（一键加入）');

  await p.click('#naClose');
  await sleep(350);
  // 再模拟公共大厅推来一个跨网络的频道（来源标记 = 在线）
  await p.evaluate(() => window.__walkie.applyLobbyList([
    { code: 'PANGOU', name: '老张', host: '老张', members: 4, ts: Date.now() }
  ]));
  await sleep(400);
  await shot(p, 'shot_nearby_list.png', '★ 可连接频道列表：附近(同一WiFi) + 在线(跨网络)' );

  // 设置面板（含公共大厅开关与状态）
  await p.click('#btnSettings');
  await sleep(900);
  await shot(p, 'shot_settings.png', '★ 设置：局域网 + 公共大厅（跨网络发现）与大厅状态');
  await p.evaluate(() => document.querySelector('#settings').classList.add('hidden'));
  await sleep(250);

  // 关于 / 使用说明
  await p.click('#btnAbout');
  await sleep(450);
  await shot(p, 'shot_about.png', '★ ⓘ 使用说明（版本号与全部说明文字都收在这里）');
  await p.click('#btnAboutClose');
  await sleep(300);

  // 进频道页（用随机码，避免上一次跑留下的残留占用）
  const shotCode = await p.evaluate(() => 'SHOT' + String(Math.floor(Math.random() * 90 + 10)));
  await p.fill('#codeInput', shotCode);
  await p.click('#btnCreate');
  await p.waitForFunction(() => window.__walkie?.S.connected === true, null, { timeout: 25000 });
  await sleep(1400);
  await shot(p, 'shot_room.png', '频道页：音质档位 chip + 网络评分徽章');

  // 回音帮助
  await p.click('#btnEchoHelp');
  await sleep(500);
  await shot(p, 'shot_echo.png', '回音帮助');
  await p.click('#btnEchoFix');
  await sleep(700);

  // 诊断面板
  await p.evaluate(() => window.__walkie.showDebug(true));
  await sleep(1800);
  await shot(p, 'shot_debug.png', '诊断面板（含编解码 / 抖动 / 丢包 / 音质评分）');
} finally {
  await browser.close();
  server.close();
}
