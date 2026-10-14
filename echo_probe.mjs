/**
 * 回音探针：逐帧测量「谁在发音频」，定位回音的软件来源
 *
 * 回音只可能来自两条路：
 *  ① 软件回路：我正在说话时，对方的麦克风居然也在发音频 → 对方喇叭里的我的声音被采回去
 *  ② 声学耦合：两台设备同处一室，喇叭声被对方麦克风拾取（物理现象，软件测不出）
 *
 * 本脚本把 ① 测死：如果对方在我发言期间 outbound 音频能量恒为 0，
 * 那软件侧就是干净的，回音只能来自 ②。
 *
 *   运行: node echo_probe.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(__dirname, 'www');
const PORT = 8089;
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

/* ---------------- 页内逐帧采样器 ---------------- */
const START_SAMPLER = `
(() => {
  const S = window.__walkie.S;
  window.__samples = [];
  window.__sampling = true;
  (async () => {
    while (window.__sampling) {
      const rec = { ts: Date.now(),
        pressing: S.pressing,
        floor: S.floorHolder === S.selfId ? 'me' : (S.floorHolder ? 'other' : 'free'),
        micOn: S.micOn,
        track: S.localStream ? S.localStream.getAudioTracks()[0].enabled : null,
        out: {}, in: {}, inLvl: {}, srcLvl: null };
      for (const [id, slot] of S.links) {
        const pc = slot.call && slot.call.peerConnection;
        if (!pc) continue;
        const key = id === 'HOST' ? 'HOST' : id.slice(-4);
        try {
          const stats = await pc.getStats();
          stats.forEach(r => {
            if (r.type === 'outbound-rtp' && r.kind === 'audio') rec.out[key] = r.totalAudioEnergy ?? 0;
            if (r.type === 'inbound-rtp'  && r.kind === 'audio') { rec.in[key] = r.totalAudioEnergy ?? 0; rec.inLvl[key] = r.audioLevel ?? 0; }
            if (r.type === 'media-source' && r.kind === 'audio') rec.srcLvl = r.audioLevel ?? 0;
          });
        } catch (e) {}
      }
      window.__samples.push(rec);
      await new Promise(r => setTimeout(r, 150));
    }
  })();
})()`;

/** 把采样序列压成「某人发言期间，对方在发多少音频」 */
function analyze(samples, label) {
  if (!samples.length) return { label, error: '无采样' };
  const sumOf = rec => Object.values(rec.out || {}).reduce((a, b) => a + b, 0);
  const sumIn = rec => Object.values(rec.in || {}).reduce((a, b) => a + b, 0);
  const first = samples[0], last = samples[samples.length - 1];
  const e = (a, b) => Math.max(0, b - a);

  let peakInLvl = 0, peakSrcLvl = 0, micOnFrames = 0;
  for (const s of samples) {
    if (s.micOn) micOnFrames++;
    for (const v of Object.values(s.inLvl || {})) peakInLvl = Math.max(peakInLvl, v);
    if (typeof s.srcLvl === 'number') peakSrcLvl = Math.max(peakSrcLvl, s.srcLvl);
  }
  return {
    label,
    帧数: samples.length,
    麦克风开启帧: micOnFrames,
    本机发送音频能量: +e(sumOf(first), sumOf(last)).toFixed(5),
    本机接收音频能量: +e(sumIn(first), sumIn(last)).toFixed(5),
    本机接收峰值level: +peakInLvl.toFixed(5),
    本机麦克风源峰值level: +peakSrcLvl.toFixed(5)
  };
}

async function startSampler(page) { await page.evaluate(START_SAMPLER); }
async function stopSampler(page) {
  return page.evaluate(() => { window.__sampling = false; return window.__samples; });
}

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage']
});

let bad = 0;
try {
  console.log('=== 建立两台「手机」 ===');
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const ctxB = await browser.newContext({ permissions: ['microphone'] });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [p, n] of [[A, '台长'], [B, '成员']]) {
    p.on('pageerror', e => console.log(`  [${n} pageerror] ${e.message}`));
    await p.goto(BASE, { waitUntil: 'load' });
  }

  await A.fill('#nameInput', '台长'); await A.click('#btnCreate');
  await A.waitForFunction(() => window.__walkie?.S.connected, null, { timeout: 25000 });
  const code = (await A.textContent('#roomCode')).trim();
  await B.fill('#nameInput', '成员'); await B.fill('#codeInput', code); await B.click('#btnJoin');
  await B.waitForFunction(() => window.__walkie?.S.connected, null, { timeout: 25000 });
  await A.waitForFunction(() => window.__walkie.S.links.size > 0, null, { timeout: 20000 });
  await B.waitForFunction(() => window.__walkie.S.links.size > 0, null, { timeout: 20000 });
  await sleep(2500);
  console.log('  频道码 =', code);

  /* ---------- 阶段1：A 正常按住说话 ---------- */
  console.log('\n=== 阶段1：台长按住说话 3 秒，看成员是否也在发音频 ===');
  await startSampler(A); await startSampler(B);
  await A.evaluate(() => window.__walkie.pressPTT());
  await sleep(3000);
  await A.evaluate(() => window.__walkie.releasePTT());
  await sleep(600);
  const sA1 = await stopSampler(A), sB1 = await stopSampler(B);

  console.log('  台长 :', JSON.stringify(analyze(sA1, '台长')));
  console.log('  成员 :', JSON.stringify(analyze(sB1, '成员')));

  /* ---------- 阶段2：B 按住说话 ---------- */
  console.log('\n=== 阶段2：成员按住说话 3 秒 ===');
  await startSampler(A); await startSampler(B);
  await B.evaluate(() => window.__walkie.pressPTT());
  await sleep(3000);
  await B.evaluate(() => window.__walkie.releasePTT());
  await sleep(600);
  const sA2 = await stopSampler(A), sB2 = await stopSampler(B);
  console.log('  台长 :', JSON.stringify(analyze(sA2, '台长')));
  console.log('  成员 :', JSON.stringify(analyze(sB2, '成员')));

  /* ---------- 阶段3：同时按（抢麦竞态）---------- */
  console.log('\n=== 阶段3：双方「同时」按住，测双开麦窗口 ===');
  await startSampler(A); await startSampler(B);
  await Promise.all([
    A.evaluate(() => window.__walkie.pressPTT()),
    B.evaluate(() => window.__walkie.pressPTT())
  ]);
  await sleep(2500);
  await A.evaluate(() => window.__walkie.releasePTT());
  await B.evaluate(() => window.__walkie.releasePTT());
  await sleep(600);
  const sA3 = await stopSampler(A), sB3 = await stopSampler(B);

  const bothOnA = sA3.filter(s => s.micOn).length * 150;
  const bothOnB = sB3.filter(s => s.micOn).length * 150;
  console.log(`  台长开麦时长: ${bothOnA}ms   成员开麦时长: ${bothOnB}ms`);
  // 统计「双方同时开麦」的帧数
  let overlap = 0;
  const n = Math.min(sA3.length, sB3.length);
  for (let i = 0; i < n; i++) if (sA3[i].micOn && sB3[i].micOn) overlap++;
  console.log(`  ★ 双方同时开麦的帧数: ${overlap} / ${n}  (${overlap * 150}ms)`);
  if (overlap > 2) { console.log('  >>> ⚠ 存在明显的双端同时开麦窗口 —— 这是软件侧回音来源'); bad++; }
  else console.log('  >>> ✅ 双端同时开麦窗口可忽略');

  /* ---------- 阶段4：A 说话时 A 自己听到多少（回音的直接体现）---------- */
  console.log('\n=== 阶段4：A 说话期间，A 自己播放通道里的电平（应为 0）===');
  await A.evaluate(() => window.__walkie.pressPTT());
  await sleep(500);
  const lvDuring = await A.evaluate(async () => {
    const S = window.__walkie.S;
    const ctx = new AudioContext(); await ctx.resume();
    const out = { ctxSampleRate: ctx.sampleRate };
    for (const [id, el] of S.audioEls) {
      if (!el.srcObject) continue;
      const src = ctx.createMediaStreamSource(el.srcObject);
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      src.connect(an); an.connect(ctx.destination);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        await new Promise(r => setTimeout(r, 40));
      }
      // 顺带把 AEC 实际生效情况读出来
      const t = S.localStream.getAudioTracks()[0];
      out[id === 'HOST' ? 'HOST' : id.slice(-4)] = { peak: +peak.toFixed(5) };
      out.trackSettings = t.getSettings();
      try { src.disconnect(); an.disconnect(); } catch (e) {}
    }
    await ctx.close(); return out;
  });
  await A.evaluate(() => window.__walkie.releasePTT());
  console.log('  A 侧播放电平 + 麦克风实际设置:', JSON.stringify(lvDuring, null, 1));

  /* ---------- 结论 ---------- */
  // 判据说明：Chrome 的 outbound-rtp.totalAudioEnergy 恒为 0（未实现），
  // 所以「某人有没有在发声音」只能用对端 inbound-rtp.totalAudioEnergy 反推。
  const a1 = analyze(sA1, '台长'), b1 = analyze(sB1, '成员');
  const a2 = analyze(sA2, '台长'), b2 = analyze(sB2, '成员');

  console.log('\n=== 结论 ===');
  const memSentDuringHostTalk = a1['本机接收音频能量'];   // 台长发言时，台长从成员收到多少
  const hostSentDuringMemTalk = b2['本机接收音频能量'];   // 成员发言时，成员从台长收到多少
  const listenerMicFrames = b1.麦克风开启帧 + a2.麦克风开启帧;   // 听的人开了几次麦
  const selfHearPeak = Math.max(0, ...Object.values(lvDuring).filter(v => v && typeof v.peak === 'number').map(v => v.peak));

  console.log(`  ① 台长发言期间，成员发出的音频能量 : ${memSentDuringHostTalk}`);
  console.log(`  ② 成员发言期间，台长发出的音频能量 : ${hostSentDuringMemTalk}`);
  console.log(`  ③ 听者误开麦帧数（应为 0）       : ${listenerMicFrames}`);
  console.log(`  ④ 发言方播放通道电平（应为 0）   : ${selfHearPeak}`);
  console.log(`  ⑤ 双端同时开麦窗口               : ${overlap * 150}ms`);

  const clean = memSentDuringHostTalk < 0.01 && hostSentDuringMemTalk < 0.01 &&
                listenerMicFrames === 0 && selfHearPeak < 0.01 && overlap <= 2;
  if (clean) {
    console.log('\n  ✅ 软件侧完全干净：对方说话时本机麦克风确实关着，本机也不会播放自己的声音。');
    console.log('     → 回音只可能来自「声学耦合」：两台设备外放且距离近时，');
    console.log('       对方喇叭里放出的声音被本机麦克风拾取并回传，延迟后形成回声。');
    console.log('     → 工程侧可改善项：① 压低端到端延迟 ② 播放切听筒/降音量 ③ 用耳机');
  } else {
    console.log('\n  ❌ 存在软件侧回音源，需要修门控/播放逻辑');
    bad++;
  }
} catch (e) {
  console.error('探针异常:', e);
  bad++;
} finally {
  await browser.close();
  server.close();
}
process.exit(bad ? 1 : 0);
