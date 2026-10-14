/**
 * 对讲机端到端诊断测试
 *
 * 用两个真实 Chrome 页面（合成麦克风 = 440Hz 正弦音）互相对讲，
 * 并测量「实际播放出来的声音电平」，定位「按住没声音」断在哪一段。
 *
 *   运行: node e2e_test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 8088;
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

/* ---------- 测量：把每个 <audio> 实际播出来的声音电平抓出来 ---------- */
async function measurePlayback(page, ms = 1600) {
  return page.evaluate(async (ms) => {
    const S = window.__walkie.S;
    const out = {};
    if (!S.audioEls || S.audioEls.size === 0) return { __error: '没有任何播放元素' };

    const ctx = new AudioContext();
    await ctx.resume();

    for (const [id, el] of S.audioEls) {
      const key = id === 'HOST' ? '中继台' : id.slice(-4);
      if (!el.srcObject) { out[key] = { error: 'srcObject 为空' }; continue; }

      // 注意：这里必须用 createMediaStreamSource —— App 自己的 <audio> 元素
      // 已经是一个「已挂载的 sink」，因此该路径能读到真实音频数据。
      // （单独用 createMediaElementSource 在 Chrome 里实测恒为 0，不可用）
      const src = ctx.createMediaStreamSource(el.srcObject);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      an.connect(ctx.destination);

      const buf = new Float32Array(an.fftSize);
      let peak = 0, sumSq = 0, n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i]);
          if (v > peak) peak = v;
          sumSq += buf[i] * buf[i];
        }
        n += buf.length;
        await new Promise(r => setTimeout(r, 40));
      }
      const t = el.srcObject.getAudioTracks()[0];
      out[key] = {
        peak: +peak.toFixed(5),
        rms: +Math.sqrt(sumSq / n).toFixed(5),
        appPaused: el.paused,
        appTime: +el.currentTime.toFixed(2),
        trackMuted: t ? t.muted : null
      };
      try { src.disconnect(); an.disconnect(); } catch (e) {}
    }
    await ctx.close();
    return out;
  }, ms);
}

/** RTP 层的声音能量（不依赖任何 Web Audio，交叉验证用） */
async function audioEnergy(page) {
  return page.evaluate(async () => {
    const S = window.__walkie.S;
    const out = {};
    for (const [id, slot] of S.links) {
      const pc = slot.call && slot.call.peerConnection;
      if (!pc) continue;
      const key = id === 'HOST' ? '中继台' : id.slice(-4);
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          out[key] = { energy: r.totalAudioEnergy ?? null, level: r.audioLevel ?? null, samples: r.totalSamplesReceived ?? null };
        }
      });
    }
    return out;
  });
}

async function bytesSnapshot(page) {
  return page.evaluate(async () => {
    const S = window.__walkie.S;
    const out = {};
    for (const [id, slot] of S.links) {
      const pc = slot.call && slot.call.peerConnection;
      if (!pc) continue;
      const key = id === 'HOST' ? '中继台' : id.slice(-4);
      const stats = await pc.getStats();
      let rx = 0, tx = 0;
      stats.forEach(r => {
        if (r.kind !== 'audio') return;
        if (r.type === 'inbound-rtp') rx += r.bytesReceived || 0;
        if (r.type === 'outbound-rtp') tx += r.bytesSent || 0;
      });
      out[key] = { rx, tx };
    }
    return out;
  });
}
function diff(a, b) {
  const out = {};
  for (const k of Object.keys(b)) {
    const prev = a[k] || { rx: 0, tx: 0 };
    out[k] = { rx: b[k].rx - prev.rx, tx: b[k].tx - prev.tx };
  }
  return out;
}
async function verdict(page) {
  return page.evaluate(async () => window.__walkie.verdict(await window.__walkie.collectStats()));
}
async function setupPage(ctx, label) {
  const page = await ctx.newPage();
  page.on('console', m => {
    const t = m.text();
    if (/error|fail|被拒|失败/i.test(t)) console.log(`  [${label} console] ${t}`);
  });
  page.on('pageerror', e => console.log(`  [${label} pageerror] ${e.message}`));
  await page.goto(BASE, { waitUntil: 'load' });
  return page;
}

/* ---------- 主流程 ---------- */
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox', '--disable-dev-shm-usage'
  ]
});

let failed = false;
try {
  console.log('=== 1. 建立两个独立浏览器环境（模拟两台手机）===');
  const ctxHost = await browser.newContext({ permissions: ['microphone'] });
  const ctxMem = await browser.newContext({ permissions: ['microphone'] });
  const host = await setupPage(ctxHost, 'HOST');
  const mem = await setupPage(ctxMem, 'MEMBER');

  console.log('=== 2. 台长创建频道 ===');
  await host.fill('#nameInput', '台长');
  await host.click('#btnCreate');
  await host.waitForFunction(() => window.__walkie && window.__walkie.S.connected === true, null, { timeout: 25000 });
  const code = (await host.textContent('#roomCode')).trim();
  console.log(`  频道码 = ${code}`);

  console.log('=== 3. 成员加入频道 ===');
  await mem.fill('#nameInput', '成员甲');
  await mem.fill('#codeInput', code);
  await mem.click('#btnJoin');
  await mem.waitForFunction(() => window.__walkie && window.__walkie.S.connected === true, null, { timeout: 25000 });
  console.log('  成员已接入');

  console.log('=== 4. 等待 P2P 语音连接建立 ===');
  await host.waitForFunction(() => window.__walkie.S.links.size > 0, null, { timeout: 20000 }).catch(() => {});
  await mem.waitForFunction(() => window.__walkie.S.links.size > 0, null, { timeout: 20000 }).catch(() => {});
  await sleep(2500);

  const linkHost = await host.evaluate(() => [...window.__walkie.S.links.entries()].map(([id, s]) => ({ peer: id === 'HOST' ? '中继台' : id.slice(-4), initiated: s.initiated, conn: s.call?.peerConnection?.connectionState })));
  const linkMem = await mem.evaluate(() => [...window.__walkie.S.links.entries()].map(([id, s]) => ({ peer: id === 'HOST' ? '中继台' : id.slice(-4), initiated: s.initiated, conn: s.call?.peerConnection?.connectionState })));
  console.log('  台长侧连接:', JSON.stringify(linkHost));
  console.log('  成员侧连接:', JSON.stringify(linkMem));

  /* ---------- 场景 A：台长按住说话 ---------- */
  console.log('\n=== 5. 场景A：台长按住 PTT 说话（成员应该听到）===');
  const memB0 = await bytesSnapshot(mem), hostB0 = await bytesSnapshot(host);

  await host.evaluate(() => window.__walkie.pressPTT());
  await sleep(1200);
  const hs = await host.evaluate(() => ({ floor: window.__walkie.S.floorHolder, mic: window.__walkie.S.localStream.getAudioTracks().map(t => t.enabled) }));
  console.log(`  台长 floorHolder=${hs.floor}  麦克风track.enabled=${JSON.stringify(hs.mic)}`);

  const lvMemA = await measurePlayback(mem, 1600);
  const enMemA = await audioEnergy(mem);
  const memB1 = await bytesSnapshot(mem), hostB1 = await bytesSnapshot(host);
  await host.evaluate(() => window.__walkie.releasePTT());
  await sleep(500);

  console.log(`  ★ 成员实际播放电平: ${JSON.stringify(lvMemA)}`);
  console.log(`  ★ 成员 RTP 声音能量: ${JSON.stringify(enMemA)}`);
  console.log(`  成员侧字节增量: ${JSON.stringify(diff(memB0, memB1))}`);
  console.log(`  台长侧字节增量: ${JSON.stringify(diff(hostB0, hostB1))}`);

  const aOk = Object.values(lvMemA).some(v => v && typeof v.peak === 'number' && v.peak > 0.01);
  console.log(`  >>> 场景A: ${aOk ? '✅ 成员能听到台长' : '❌ 成员听不到台长'}`);
  if (!aOk) failed = true;

  /* ---------- 场景 B：成员按住说话 ---------- */
  console.log('\n=== 6. 场景B：成员按住 PTT 说话（台长应该听到）===');
  const hostB2 = await bytesSnapshot(host), memB2 = await bytesSnapshot(mem);

  await mem.evaluate(() => window.__walkie.pressPTT());
  await sleep(1200);
  const ms = await mem.evaluate(() => ({ floor: window.__walkie.S.floorHolder, self: window.__walkie.S.selfId.slice(-4), mic: window.__walkie.S.localStream.getAudioTracks().map(t => t.enabled) }));
  console.log(`  成员 floorHolder=${ms.floor === 'HOST' ? '中继台' : String(ms.floor).slice(-4)}  自己=${ms.self}  麦克风track.enabled=${JSON.stringify(ms.mic)}`);

  const lvHostB = await measurePlayback(host, 1600);
  const enHostB = await audioEnergy(host);
  const hostB3 = await bytesSnapshot(host), memB3 = await bytesSnapshot(mem);
  await mem.evaluate(() => window.__walkie.releasePTT());
  await sleep(500);

  console.log(`  ★ 台长实际播放电平: ${JSON.stringify(lvHostB)}`);
  console.log(`  ★ 台长 RTP 声音能量: ${JSON.stringify(enHostB)}`);
  console.log(`  台长侧字节增量: ${JSON.stringify(diff(hostB2, hostB3))}`);
  console.log(`  成员侧字节增量: ${JSON.stringify(diff(memB2, memB3))}`);

  const bOk = Object.values(lvHostB).some(v => v && typeof v.peak === 'number' && v.peak > 0.01);
  console.log(`  >>> 场景B: ${bOk ? '✅ 台长能听到成员' : '❌ 台长听不到成员'}`);
  if (!bOk) failed = true;

  /* ---------- 场景 C：松手后必须静音 ---------- */
  console.log('\n=== 7. 场景C：双方都松手，应当完全静音 ===');
  await sleep(800);
  const lvHostIdle = await measurePlayback(host, 1200);
  const lvMemIdle = await measurePlayback(mem, 1200);
  console.log(`  台长静默时播放电平: ${JSON.stringify(lvHostIdle)}`);
  console.log(`  成员静默时播放电平: ${JSON.stringify(lvMemIdle)}`);
  const idleOk = [...Object.values(lvHostIdle), ...Object.values(lvMemIdle)]
    .every(v => !v || typeof v.peak !== 'number' || v.peak < 0.02);
  console.log(`  >>> 场景C: ${idleOk ? '✅ 松手后确实静音（半双工有效）' : '❌ 松手后仍在传声'}`);
  if (!idleOk) failed = true;

  /* ---------- 场景 D：第三人加入，验证多方互联 ---------- */
  console.log('\n=== 7.5 场景D：第三人加入，验证三方互联 ===');
  const ctxC = await browser.newContext({ permissions: ['microphone'] });
  const c = await setupPage(ctxC, 'MEMBER-B');
  await c.fill('#nameInput', '成员乙');
  await c.fill('#codeInput', code);
  await c.click('#btnJoin');
  await c.waitForFunction(() => window.__walkie && window.__walkie.S.connected === true, null, { timeout: 25000 });

  // 三方各自都应该有 2 条语音连接（全互联）
  await host.waitForFunction(() => window.__walkie.S.links.size === 2, null, { timeout: 25000 }).catch(() => {});
  await mem.waitForFunction(() => window.__walkie.S.links.size === 2, null, { timeout: 25000 }).catch(() => {});
  await c.waitForFunction(() => window.__walkie.S.links.size === 2, null, { timeout: 25000 }).catch(() => {});
  await sleep(3000);

  const mesh = await Promise.all([host, mem, c].map(p => p.evaluate(() =>
    [...window.__walkie.S.links.entries()].map(([id, s]) =>
      (id === 'HOST' ? '中继台' : id.slice(-4)) + (s.initiated ? '(我发起)' : '(对方发起)') + '=' + (s.call?.peerConnection?.connectionState || '?'))
  )));
  console.log('  台长   视角:', JSON.stringify(mesh[0]));
  console.log('  成员甲 视角:', JSON.stringify(mesh[1]));
  console.log('  成员乙 视角:', JSON.stringify(mesh[2]));

  await host.evaluate(() => window.__walkie.pressPTT());
  await sleep(1200);
  const lvA = await measurePlayback(mem, 1600);
  const lvB = await measurePlayback(c, 1600);
  await host.evaluate(() => window.__walkie.releasePTT());
  console.log(`  ★ 成员甲播放电平: ${JSON.stringify(lvA)}`);
  console.log(`  ★ 成员乙播放电平: ${JSON.stringify(lvB)}`);
  const dOk = [lvA, lvB].every(o => Object.values(o).some(v => v && typeof v.peak === 'number' && v.peak > 0.01));
  console.log(`  >>> 场景D: ${dOk ? '✅ 三方互通正常' : '❌ 多人场景有问题'}`);
  if (!dOk) failed = true;

  /* ---------- 场景 E：半双工仲裁（抢麦必须被拦住）---------- */
  console.log('\n=== 7.6 场景E：台长正在发言时，成员抢麦应被拦下 ===');
  await host.evaluate(() => window.__walkie.pressPTT());
  await sleep(600);
  await mem.evaluate(() => window.__walkie.pressPTT());
  await sleep(1000);
  const contend = await mem.evaluate(() => ({
    gotFloor: window.__walkie.S.floorHolder === window.__walkie.S.selfId,
    micOn: window.__walkie.S.micOn
  }));
  console.log(`  成员甲抢麦结果: 拿到发言权=${contend.gotFloor}  麦克风门控开=${contend.micOn}`);
  if (contend.gotFloor || contend.micOn) { console.log('  >>> ❌ 半双工仲裁失效'); failed = true; }
  else console.log('  >>> ✅ 抢麦被正确拦下');
  await mem.evaluate(() => window.__walkie.releasePTT());
  await host.evaluate(() => window.__walkie.releasePTT());
  await sleep(500);

  /* ---------- 场景 F：音频路由 / 音量（压回音手段）---------- */
  console.log('\n=== 7.8 场景F：听筒模式与音量控制 ===');
  const routeRes = await mem.evaluate(async () => {
    await window.__walkie.setRoute('earpiece');
    const S = window.__walkie.S;
    return {
      route: S.route,
      volume: S.remoteVolume,
      chip: document.querySelector('#btnRoute').textContent.trim(),
      slider: document.querySelector('#volRange').value,
      mutedWhileTalking: [...S.audioEls.values()].every(a => typeof a.muted === 'boolean')
    };
  });
  console.log(`  切换结果: ${JSON.stringify(routeRes)}`);
  const routeOk = routeRes.route === 'earpiece' && routeRes.volume < 0.9 && routeRes.chip.includes('听筒');
  console.log(`  >>> 场景F: ${routeOk ? '✅ 听筒模式可用（压回音手段就位）' : '❌ 音频路由切换有问题'}`);
  if (!routeOk) failed = true;
  await mem.evaluate(() => window.__walkie.setRoute('speaker'));

  /* ---------- 场景 G：频道码记忆 & 自动重回 ---------- */
  console.log('\n=== 7.9 场景G：重开 App 应自动重回上次频道（免手输频道码）===');
  const savedCh = await mem.evaluate(() => localStorage.getItem('walkie.lastChannel'));
  console.log('  已记住的频道:', savedCh);
  await mem.reload({ waitUntil: 'load' });
  const autoBack = await mem.waitForFunction(
    c => window.__walkie && window.__walkie.S.connected === true && window.__walkie.S.code === c,
    code, { timeout: 30000 }
  ).then(() => true).catch(() => false);
  const afterReload = await mem.evaluate(() => ({
    connected: window.__walkie.S.connected,
    code: window.__walkie.S.code,
    role: window.__walkie.S.role,
    links: window.__walkie.S.links.size
  }));
  console.log('  重载后状态:', JSON.stringify(afterReload));
  console.log(`  >>> 场景G: ${autoBack ? '✅ 不用输频道码，自动重回成功' : '❌ 自动重回失败'}`);
  if (!autoBack) failed = true;

  /* ---------- 场景 H：Opus 音质参数（VoNR 式取舍）---------- */
  console.log('\n=== 7.95 场景H：Opus 全带宽 + FEC + 关 DTX 是否真的进了 SDP ===');
  const pure = await host.evaluate(() => window.__walkie.mungeOpus(
    'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n'
  ));
  console.log('  改写前: a=fmtp:111 minptime=10;useinbandfec=1');
  console.log('  改写后:', (pure.split(/\r?\n/).find(l => /^a=fmtp:/.test(l)) || '(无)').trim());
  const pureOk = /usedtx=0/.test(pure) && /maxaveragebitrate=40000/.test(pure)
    && /stereo=0/.test(pure) && /useinbandfec=1/.test(pure) && /maxplaybackrate=48000/.test(pure);

  const real = await host.evaluate(() => {
    const out = { quality: window.__walkie.S.soundQuality, links: [] };
    for (const [id, slot] of window.__walkie.S.links) {
      const pc = slot.call && slot.call.peerConnection;
      if (!pc) continue;
      const sdp = ((pc.localDescription && pc.localDescription.sdp) || '') + '\n' +
                  ((pc.remoteDescription && pc.remoteDescription.sdp) || '');
      const fmtp = sdp.split(/\r?\n/)
        .filter(l => /^a=fmtp:/.test(l) && /useinbandfec|maxaveragebitrate|usedtx/.test(l))[0] || null;
      out.links.push({ peer: id === 'HOST' ? '中继台' : id.slice(-4), fmtp: fmtp ? fmtp.trim() : null });
    }
    return out;
  });
  console.log(`  音质档位 = ${real.quality}`);
  real.links.forEach(l => console.log(`  ${l.peer} 的 Opus 参数: ${l.fmtp || '(未找到)'}`));
  const realOk = real.links.length > 0 && real.links.every(l =>
    l.fmtp && /useinbandfec=1/.test(l.fmtp) && /maxaveragebitrate=/.test(l.fmtp) && /usedtx=0/.test(l.fmtp));

  const codecReal = await host.evaluate(async () => {
    const out = {};
    for (const [id, slot] of window.__walkie.S.links) {
      const pc = slot.call && slot.call.peerConnection;
      if (!pc) continue;
      const stats = await pc.getStats();
      const byId = new Map(); stats.forEach(r => byId.set(r.id, r));
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.codecId) {
          const c = byId.get(r.codecId);
          out[id === 'HOST' ? '中继台' : id.slice(-4)] = c ? c.mimeType : '(未知)';
        }
      });
    }
    return out;
  });
  console.log('  实际协商到的编解码:', JSON.stringify(codecReal));
  const codecOk = Object.values(codecReal).length > 0 && Object.values(codecReal).every(v => /opus/i.test(v));

  const hOk = pureOk && realOk && codecOk;
  console.log(`  >>> 场景H: ${hOk ? '✅ Opus 全带宽 + FEC + 关 DTX 已生效，编解码锁定 Opus' : '❌ 音质参数没生效'}`);
  if (!hOk) failed = true;

  /* ---------- 场景 I：自定义频道码 ---------- */
  console.log('\n=== 7.96 场景I：自定义频道码（含自动转大写）===');
  const CUSTOM_CODE = 'NEARBY';                       // 6 位，好记
  const ctxD = await browser.newContext({ permissions: ['microphone'] });
  const d = await setupPage(ctxD, 'HOST-CUSTOM');
  await d.fill('#nameInput', '老王');
  await d.fill('#codeInput', CUSTOM_CODE.toLowerCase());   // 故意输小写
  const typed = await d.inputValue('#codeInput');
  await d.click('#btnCreate');
  const customOk = await d.waitForFunction(
    c => window.__walkie && window.__walkie.S.connected === true && window.__walkie.S.code === c,
    CUSTOM_CODE, { timeout: 25000 }
  ).then(() => true).catch(() => false);
  const customCodeShown = (await d.textContent('#roomCode')).trim();
  console.log(`  输入小写「${CUSTOM_CODE.toLowerCase()}」→ 输入框变成「${typed}」`);
  console.log(`  频道页显示 = ${customCodeShown}  期望 = ${CUSTOM_CODE}`);
  const iOk = customOk && customCodeShown === CUSTOM_CODE && typed === CUSTOM_CODE;
  console.log(`  >>> 场景I: ${iOk ? '✅ 自定义频道码生效（且自动转大写）' : '❌ 自定义频道码没生效'}`);
  if (!iOk) failed = true;

  /* ---------- 场景 J：附近频道发现 + 预警 + 一键加入 ---------- */
  console.log('\n=== 7.97 场景J：附近发现的预警提示与一键加入 ===');
  const ctxE = await browser.newContext({ permissions: ['microphone'] });
  const e = await setupPage(ctxE, 'NEARBY-WATCHER');
  const nb0 = await e.evaluate(() => ({
    hasBeacon: window.__walkie.hasBeacon(),          // 浏览器里应为 false（无原生插件）
    items: window.__walkie.nearbyItems().length,
    cardHidden: document.querySelector('#nearbyCard').classList.contains('hidden'),
    version: window.__walkie.version
  }));
  console.log('  初始状态:', JSON.stringify(nb0));
  console.log(`  首页显示的版本号: ${(await e.textContent('#verText')).trim()}  build ${(await e.textContent('#buildText')).trim()}`);
  const verOk = nb0.version.startsWith('1.4.');

  // 模拟收到一条局域网广播（真机上来自 WalkieBeacon 插件的 nearby 事件）
  await e.evaluate(c => window.__walkie.injectBeacon({ code: c, name: '老王', host: '老王', members: 1, ip: '192.168.1.23' }), CUSTOM_CODE);
  await sleep(400);
  const nbUi = await e.evaluate(() => ({
    count: document.querySelector('#nearbyCount').textContent,
    cardVisible: !document.querySelector('#nearbyCard').classList.contains('hidden'),
    alertVisible: !document.querySelector('#nearbyAlert').classList.contains('hidden'),
    alertSub: document.querySelector('#naSub').textContent,
    listed: [...document.querySelectorAll('.nearby-item .nb-code')].map(n => n.textContent)
  }));
  console.log('  发现后的界面:', JSON.stringify(nbUi));
  const alertOk = nbUi.alertVisible && nbUi.alertSub.includes(CUSTOM_CODE);
  const listOk = nbUi.cardVisible && nbUi.listed.includes(CUSTOM_CODE) && nbUi.count === '1';
  console.log(`  预警横幅: ${alertOk ? '✅ 已弹出' : '❌ 没提示'}   附近列表: ${listOk ? '✅ 已列出' : '❌ 列表异常'}`);

  // 点「一键加入」→ 应当直接连进那个频道，全程不碰频道码输入框
  const codeUntouched = await e.inputValue('#codeInput');
  await e.click('#naJoin');
  const joined = await e.waitForFunction(
    c => window.__walkie && window.__walkie.S.connected === true && window.__walkie.S.code === c,
    CUSTOM_CODE, { timeout: 25000 }
  ).then(() => true).catch(() => false);
  const eState = await e.evaluate(() => ({
    code: window.__walkie.S.code, role: window.__walkie.S.role,
    alertHidden: document.querySelector('#nearbyAlert').classList.contains('hidden')
  }));
  console.log(`  一键加入: ${JSON.stringify(eState)}（点击前频道码输入框内容 =「${codeUntouched}」）`);
  const jOk = alertOk && listOk && joined && verOk;
  console.log(`  >>> 场景J: ${jOk ? '✅ 附近预警 + 一键加入 + 版本号 都正常' : '❌ 附近发现功能有问题'}`);
  if (!jOk) failed = true;

  /* ---------- 场景 K：公共大厅（跨网络发现）----------
   * 目标：证明「打开 App 就能发现」不再受 WiFi 限制 ——
   *  A 在完全独立的浏览器环境开一个频道，B 只是打开 App 停在首页，
   *  B 应当自动从「公共大厅」看到 A 的频道（来源标记 = 在线），并一键直连。
   * 这里的两个 context 完全隔离，等价于两台不同网络下的手机。 */
  console.log('\n=== 7.98 场景K：公共大厅 —— 打开 App 即发现（跨网络）===');
  const LOBBY_CODE = 'LOBBY7';
  const ctxL1 = await browser.newContext({ permissions: ['microphone'] });
  const ctxL2 = await browser.newContext({ permissions: ['microphone'] });
  const lHost = await setupPage(ctxL1, 'LOBBY-A');
  const lWatcher = await setupPage(ctxL2, 'LOBBY-B');

  const waitRole = p => p.waitForFunction(
    () => window.__walkie.lobbyInfo().role !== '', null, { timeout: 35000 }
  ).then(() => true).catch(() => false);
  const okL1 = await waitRole(lHost);
  const okL2 = await waitRole(lWatcher);
  const li1 = await lHost.evaluate(() => window.__walkie.lobbyInfo());
  const li2 = await lWatcher.evaluate(() => window.__walkie.lobbyInfo());
  console.log(`  A 侧大厅角色 = ${li1.role || '(连接失败)'}   B 侧大厅角色 = ${li2.role || '(连接失败)'}`);
  console.log(`  公共大厅状态: 启用=${li1.on && li2.on}   A 侧目录条目=${li1.table.length}   B 侧目录条目=${li2.table.length}`);
  const bothOn = okL1 && okL2;

  // A 开频道（自定义码，方便断言）
  await lHost.fill('#nameInput', '大厅台长');
  await lHost.fill('#codeInput', LOBBY_CODE);
  await lHost.click('#btnCreate');
  const aIn = await lHost.waitForFunction(
    c => window.__walkie.S.connected === true && window.__walkie.S.code === c,
    LOBBY_CODE, { timeout: 25000 }
  ).then(() => true).catch(() => false);
  console.log(`  A 已开频道 ${LOBBY_CODE}：${aIn ? '✅' : '❌'}`);

  // B 停在首页，等大厅把 A 的频道推过来（B 全程没输过任何频道码）
  const saw = await lWatcher.waitForFunction(
    c => window.__walkie.nearbyItems().some(i => i.code === c),
    LOBBY_CODE, { timeout: 35000 }
  ).then(() => true).catch(() => false);

  const items = await lWatcher.evaluate(() => window.__walkie.nearbyItems());
  console.log('  B 首页看到的可连接频道:', JSON.stringify(items));
  const netItem = items.find(i => i.code === LOBBY_CODE);
  const srcOk = !!netItem && netItem.src === 'net';
  console.log(`  来源标记 = ${netItem ? netItem.src : '(无)'}  ${srcOk ? '✅ 来自公共大厅' : '❌ 不是大厅来源'}`);

  const ui = await lWatcher.evaluate(() => ({
    cardVisible: !document.querySelector('#nearbyCard').classList.contains('hidden'),
    listed: [...document.querySelectorAll('.nearby-item .nb-code')].map(n => n.textContent),
    tags: [...document.querySelectorAll('.nearby-item .nb-src')].map(n => n.textContent),
    alertVisible: !document.querySelector('#nearbyAlert').classList.contains('hidden')
  }));
  console.log('  B 的界面:', JSON.stringify(ui));

  // 一键加入（不碰频道码输入框）
  const codeUntouched2 = await lWatcher.inputValue('#codeInput');
  await lWatcher.evaluate(c => window.__walkie.joinNearby(c), LOBBY_CODE);
  const joined2 = await lWatcher.waitForFunction(
    c => window.__walkie.S.connected === true && window.__walkie.S.code === c,
    LOBBY_CODE, { timeout: 25000 }
  ).then(() => true).catch(() => false);
  const members2 = await lHost.evaluate(() => 1 + window.__walkie.S.members.size);
  console.log(`  B 一键加入: ${joined2 ? '✅ 直连成功' : '❌ 失败'}（加入前频道码输入框 =「${codeUntouched2}」）`);
  console.log(`  台长侧成员数 = ${members2}`);

  const kOk = bothOn && aIn && saw && srcOk && ui.cardVisible
    && ui.listed.includes(LOBBY_CODE) && ui.tags.includes('在线')
    && joined2 && members2 >= 2;
  console.log(`  >>> 场景K: ${kOk ? '✅ 公共大厅打通 —— 打开 App 即发现，跨网络可见并一键直连' : '❌ 公共大厅有问题'}`);
  if (!kOk) failed = true;
  await ctxL1.close(); await ctxL2.close();

  /* ---------- 汇总 ---------- */
  console.log('\n=== 8. 汇总 ===');
  console.log('台长侧诊断:'); (await verdict(host)).forEach(x => console.log('  ' + x));
  console.log('成员侧诊断:'); (await verdict(mem)).forEach(x => console.log('  ' + x));
  console.log(`\n总体: ${failed ? '❌ 仍有问题' : '✅ 双向语音链路全部正常'}`);
} catch (e) {
  console.error('\n测试异常:', e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
