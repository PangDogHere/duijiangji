/* =========================================================================
 *  对讲机 (PTT Walkie-Talkie)
 *
 *  信令：PeerJS 公共 broker（无自建服务器）
 *  拓扑：中继台注册频道码 + 仲裁发言权；语音走成员间 P2P 全互联
 *  半双工：源头门控 —— 只有发言权持有者的麦克风 track 是 enabled 的
 *
 *  ⚠ 历史坑（不要再踩）：
 *  早期版本用「中继台 + Web Audio 转发」(createMediaStreamSource(远端流))，
 *  实测在 Chrome 里默认 44100Hz 的 AudioContext 下输出恒为静音
 *  （WebRTC 是 48000Hz，该重采样路径失效），表现为「按住没声音」。
 *  现改用 <audio srcObject> 直接播放远端流 —— WebRTC 播放的标准做法，
 *  全平台可靠，不再依赖 Web Audio 处理远端音频。
 * ========================================================================= */
(() => {
'use strict';

/* ------------------------------ 版本 ------------------------------ */
const APP_VERSION = '1.4.0';
const APP_BUILD   = '4';

/* ------------------------------ 常量 ------------------------------ */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉 I L O 0 1
const CODE_LEN      = 6;
const PEER_PREFIX   = 'pangou-wt-';
const HOST_ID       = 'HOST';                            // 中继台的逻辑 id

const DEFAULT_SIGNALING = { host: '0.peerjs.com', port: 443, secure: true, path: '/' };

/* ---------------------------------------------------------------------
 * 语音质量档位 —— 参考 VoNR(Voice over New Radio) 的质量设计思路。
 *
 * 先把边界说清楚：VoNR 是 3GPP 的 5G 原生语音方案（IMS + EVS 编解码 +
 * 5QI=1 的专用 QoS 承载），属于运营商网络能力，App 层拿不到，不可能"实现 VoNR"。
 * 但它的质量设计原则可以完整照搬到 WebRTC/Opus：
 *   ① 全带宽编解码 —— EVS 音频带宽最高 20kHz；我们用 Opus 全带宽 48kHz / 单声道
 *   ② 信道编码冗余 —— EVS 家族靠 FEC 抗丢包；我们开 Opus 带内 FEC(useinbandfec=1)
 *   ③ 不做粗暴静音压缩 —— EVS 用低速率舒适噪声；我们关 DTX(usedtx=0)，
 *      避免每句话的起头被静音检测削掉（这是"听不清开头"的常见原因）
 *   ④ 编码速率充足但不冒进 —— EVS 13.2~24.6kbps 已相当透明；Opus 给 40kbps 很宽裕，
 *      而盲目冲高码率在弱网下反而更容易丢包、更糊
 *   ⑤ 抖动与延迟控制 —— 优先 UDP 直连、避开 TURN 中继（中继=更大延迟+更多丢包）
 *
 * 编解码层面唯一真正卡住"好不好听"的硬指标：**必须协商到 Opus**。
 * 一旦掉到 PCMU/PCMA 就是 8kHz 电话音质 —— 那才是"通话质量不好"的头号元凶。
 * ------------------------------------------------------------------- */
const QUALITY_PROFILES = {
  lite:     { key: 'lite',     label: '省流',   hint: '省流（约 20kbps，弱网首选）', maxaveragebitrate: 20000, maxBitrate: 24000 },
  standard: { key: 'standard', label: '标准',   hint: '标准（约 40kbps，推荐）',     maxaveragebitrate: 40000, maxBitrate: 48000 },
  hifi:     { key: 'hifi',     label: '高保真', hint: '高保真（约 64kbps，网络好时）', maxaveragebitrate: 64000, maxBitrate: 80000 }
};
const QUALITY_ORDER = ['lite', 'standard', 'hifi'];

/* 附近频道发现：局域网 UDP 广播（端口与原生 WalkieBeaconPlugin 保持一致） */
const BEACON_PORT   = 45871;
const BEACON_TTL_MS = 9000;   // 超过这么久没再听到，就认为对方走了
const BEACON_SWEEP_MS = 3000; // 定期清理过期条目

/* ---------------------------------------------------------------------
 * 公共大厅（跨网络发现）—— 自组织，不依赖任何自建服务器
 *
 * 物理约束：两台设备不在同一网络时，UDP 广播根本到不了。
 * 想互相发现，必须有一个「公共会合点」。App 本来就在用 PeerJS 公共 broker
 * 做信令 —— 这里把它复用成「频道大厅」：
 *   · 约定一个固定 id（LOBBY_ID），谁先打开 App 谁自动当选大厅
 *   · 其他 App 打开即挂上去，心跳上报自己的频道、接收在线频道列表
 *   · 大厅掉了，剩下的人下次心跳失败后自动重新竞选
 * 于是「打开 App 就能发现」不再受 WiFi 限制，也不需要新增任何服务器。
 * ------------------------------------------------------------------- */
const LOBBY_ID       = 'pangou-wt-lobby-v1';
const LOBBY_HB_MS    = 5000;   // 客户端心跳间隔（同时用来探测大厅是否还活着）
const LOBBY_RX_TO    = 15000;  // 客户端：这么久没收到大厅任何回音 → 认定大厅已掉线，重新竞选
const LOBBY_WATCH_MS = 3000;   // 客户端：健康检查周期
const LOBBY_TTL_MS   = 40000;  // 大厅：多久没心跳就剔除该条目
const LOBBY_NET_TTL  = 45000;  // 客户端：多久没收到新列表就丢弃在线条目
const LOBBY_JOIN_TO  = 6500;   // 连大厅超时（超时即认为大厅不存在 → 竞选）
const LOBBY_SWEEP_MS = 4000;   // 大厅：过期条目清理周期

/* 只保留 STUN。
 * 原来的 openrelay 免费 TURN 早已停服，留着只会拖慢 ICE 收集，
 * 还可能把连接挤到高延迟的中继路径上 —— 而回音的"明显程度"直接跟延迟挂钩：
 * 延迟越小，串回来的声音越贴近原声，听起来越像音染而不是"回声"。 */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.hitv.com:3478' }
];

/* ------------------------------ DOM ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const el = {
  home: $('#home'), room: $('#room'),
  nameInput: $('#nameInput'), codeInput: $('#codeInput'), btnDice: $('#btnDice'),
  btnCreate: $('#btnCreate'), btnJoin: $('#btnJoin'), btnSettings: $('#btnSettings'),
  btnAbout: $('#btnAbout'), btnAbout2: $('#btnAbout2'),
  about: $('#about'), btnAboutClose: $('#btnAboutClose'),
  verText: $('#verText'), verText2: $('#verText2'),
  buildText: $('#buildText'), buildText2: $('#buildText2'),
  roomCode: $('#roomCode'), btnLeave: $('#btnLeave'), btnCopy: $('#btnCopy'),
  statusDot: $('#statusDot'), statusText: $('#statusText'), roleBadge: $('#roleBadge'),
  statusBar: $('#statusBar'), qBadge: $('#qBadge'),
  debug: $('#debug'), debugBody: $('#debugBody'), debugClose: $('#debugClose'),
  members: $('#members'), log: $('#log'),
  chatInput: $('#chatInput'), btnSend: $('#btnSend'),
  speakingBar: $('#speakingBar'), speakingText: $('#speakingText'),
  pttBtn: $('#pttBtn'), pttLabel: $('#pttLabel'), pttTip: $('#pttTip'),
  settings: $('#settings'),
  cfgHost: $('#cfgHost'), cfgPort: $('#cfgPort'), cfgPath: $('#cfgPath'), cfgSecure: $('#cfgSecure'),
  cfgAutoRejoin: $('#cfgAutoRejoin'),
  cfgBeaconVisible: $('#cfgBeaconVisible'), cfgBeaconScan: $('#cfgBeaconScan'),
  cfgLobbyOn: $('#cfgLobbyOn'), lobbyState: $('#lobbyState'),
  cfgSave: $('#cfgSave'), cfgReset: $('#cfgReset'),
  reconnectCard: $('#reconnectCard'), reconnectCode: $('#reconnectCode'),
  reconnectRole: $('#reconnectRole'), btnReconnect: $('#btnReconnect'),
  recentBox: $('#recentBox'), recentList: $('#recentList'),
  btnRoute: $('#btnRoute'), volRange: $('#volRange'), btnEchoHelp: $('#btnEchoHelp'),
  btnQuality: $('#btnQuality'),
  echoHelp: $('#echoHelp'), btnEchoFix: $('#btnEchoFix'), btnEchoClose: $('#btnEchoClose'),
  searchHint: $('#searchHint'),
  nearbyCard: $('#nearbyCard'), nearbyList: $('#nearbyList'), nearbyCount: $('#nearbyCount'),
  btnNearbyToggle: $('#btnNearbyToggle'),
  nearbyAlert: $('#nearbyAlert'), naTitle: $('#naTitle'), naSub: $('#naSub'),
  naJoin: $('#naJoin'), naClose: $('#naClose'),
  toast: $('#toast')
};

/* ------------------------------ 状态 ------------------------------ */
const S = {
  role: null,          // 'host' | 'member'
  code: '',
  name: '',
  selfId: '',          // HOST_ID 或本端 PeerJS id
  peer: null,
  localStream: null,
  micOn: false,

  floorHolder: null,   // 当前发言权持有者的逻辑 id
  queue: [],           // 中继台：排队等待发言的 id
  pressing: false,
  denied: false,       // 本次按住已被拒绝（有人在说）→ 立刻闭嘴
  autoJoining: false,  // 正在自动重回上次频道
  connected: false,
  destroyed: false,

  remoteVolume: 1,     // 远端播放音量（压回音用）
  route: 'speaker',    // 音频输出路由：speaker | earpiece
  autoRejoin: true,    // 启动时自动重回上次频道

  soundQuality: 'standard', // 音质档位：lite | standard | hifi
  customCode: false,        // 本次的频道码是用户自己指定的（冲突时不能偷偷换码）
  micSettings: null,        // 采集参数实测值（诊断用）

  /* --- 附近频道发现 --- */
  instance: '',        // 本机实例 id（过滤掉自己发出的广播）
  beaconOn: false,     // 原生信标是否已启动
  beaconVisible: true, // 允许同伴在局域网发现我的频道（台长才会广播）
  beaconScan: true,    // 自动扫描附近的频道
  nearby: new Map(),   // code -> { code, name, host, members, ip, src, seenAt }
  nearbyAlerted: '',   // 已经弹过预警的频道码（避免反复骚扰）
  nearbyCollapsed: false,

  /* --- 公共大厅（跨网络发现）--- */
  lobbyOn: true,       // 是否参与公共大厅
  lobby: {
    role: '',          // '' | 'client' | 'host'
    connecting: false,
    peer: null,        // 客户端：随机 id 的 peer
    conn: null,        // 客户端 → 大厅 的数据连接
    joinTimer: null,
    hostPeer: null,    // 大厅模式：占用 LOBBY_ID 的 peer
    conns: new Map(),  // 大厅模式：peerId -> 连接
    table: new Map(),  // 大厅模式：peerId -> { ts, role, code, name, host, members }
    hbTimer: null, retryTimer: null, sweepTimer: null,
    watchTimer: null, lastRxAt: 0,
    joinedAt: 0, lastListAt: 0
  },

  quality: null,       // 最近一次链路评分 { score, cls, text, detail }

  members: new Map(),  // 中继台：id -> { id, name, muted, conn }
  links: new Map(),    // 所有人：逻辑 id -> { call, initiated }
  audioEls: new Map(), // 所有人：逻辑 id -> <audio>

  hostConn: null,      // 成员：与中继台的数据连接
  roster: [],
  signaling: { ...DEFAULT_SIGNALING }
};

/* ------------------------------ 小工具 ------------------------------ */
function randCode() {
  let s = '';
  const a = new Uint32Array(CODE_LEN);
  (window.crypto || window.msCrypto).getRandomValues(a);
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}
/** 随机实例 id —— 只用来过滤掉自己发出的局域网广播 */
function uid(n) {
  let s = '';
  const a = new Uint32Array(8);
  (window.crypto || window.msCrypto).getRandomValues(a);
  for (let i = 0; i < 8; i++) s += a[i].toString(36);
  return s.slice(0, n || 8).toUpperCase();
}
/** 频道码规范化：只保留大写字母与数字，截到 6 位 */
function normalizeCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LEN);
}
function saveSignaling() {
  try { localStorage.setItem('walkie.signaling', JSON.stringify(S.signaling)); } catch (e) {}
}
function loadSignaling() {
  try {
    const raw = localStorage.getItem('walkie.signaling');
    if (raw) S.signaling = { ...DEFAULT_SIGNALING, ...JSON.parse(raw) };
  } catch (e) {}
}
function loadName() { try { return localStorage.getItem('walkie.name') || ''; } catch (e) { return ''; } }
function saveName(n) { try { localStorage.setItem('walkie.name', n); } catch (e) {} }

/* --- 音质档位 --- */
function loadSoundQuality() {
  try { const v = localStorage.getItem('walkie.quality'); return QUALITY_PROFILES[v] ? v : 'standard'; }
  catch (e) { return 'standard'; }
}
function saveSoundQuality(q) { try { localStorage.setItem('walkie.quality', q); } catch (e) {} }

/* --- 附近发现开关 --- */
function loadBeaconVisible() { try { return localStorage.getItem('walkie.beaconVisible') !== '0'; } catch (e) { return true; } }
function saveBeaconVisible(v) { try { localStorage.setItem('walkie.beaconVisible', v ? '1' : '0'); } catch (e) {} }
function loadBeaconScan() { try { return localStorage.getItem('walkie.beaconScan') !== '0'; } catch (e) { return true; } }
function saveBeaconScan(v) { try { localStorage.setItem('walkie.beaconScan', v ? '1' : '0'); } catch (e) {} }
function loadLobbyOn() { try { return localStorage.getItem('walkie.lobbyOn') !== '0'; } catch (e) { return true; } }
function saveLobbyOn(v) { try { localStorage.setItem('walkie.lobbyOn', v ? '1' : '0'); } catch (e) {} }
function loadInstance() {
  try {
    let v = localStorage.getItem('walkie.instance');
    if (!v) { v = uid(8); localStorage.setItem('walkie.instance', v); }
    return v;
  } catch (e) { return uid(8); }
}

/* --- 频道记忆：免去每次手输频道码 --- */
function saveChannel(code, role, name) {
  try {
    const rec = { code, role, name: name || '', at: Date.now() };
    localStorage.setItem('walkie.lastChannel', JSON.stringify(rec));
    const list = loadRecent().filter(x => x.code !== code);
    list.unshift(rec);
    localStorage.setItem('walkie.recent', JSON.stringify(list.slice(0, 4)));
  } catch (e) {}
}
function loadLastChannel() {
  try { return JSON.parse(localStorage.getItem('walkie.lastChannel') || 'null'); } catch (e) { return null; }
}
function loadRecent() {
  try { return JSON.parse(localStorage.getItem('walkie.recent') || '[]') || []; } catch (e) { return []; }
}
function loadAutoRejoin() {
  try { return localStorage.getItem('walkie.autoRejoin') !== '0'; } catch (e) { return true; }
}
function saveAutoRejoin(v) { try { localStorage.setItem('walkie.autoRejoin', v ? '1' : '0'); } catch (e) {} }

/* --- 音频输出路由：外放 / 听筒（听筒能大幅压低声学泄漏，是不戴耳机也能压回音的关键） --- */
function nativeAudioPlugin() {
  try {
    const C = window.Capacitor;
    if (!C) return null;
    // 网页里没有原生音频路由，直接走音量模拟
    if (typeof C.isNativePlatform === 'function' && !C.isNativePlatform()) return null;
    if (C.Plugins && C.Plugins.WalkieAudio) return C.Plugins.WalkieAudio;
    if (typeof C.registerPlugin === 'function') return C.registerPlugin('WalkieAudio');
  } catch (e) {}
  return null;
}
function hasNativeRoute() { return !!nativeAudioPlugin(); }
function loadRoute() { try { return localStorage.getItem('walkie.route') || 'speaker'; } catch (e) { return 'speaker'; } }
function saveRoute(r) { try { localStorage.setItem('walkie.route', r); } catch (e) {} }

let toastTimer = null;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function nowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function addLog(name, text, isSystem) {
  const div = document.createElement('div');
  div.className = 'log-item' + (isSystem ? ' sys' : '');
  if (isSystem) {
    div.textContent = text;
  } else {
    const b = document.createElement('b');
    b.textContent = name + '：';
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
    const ts = document.createElement('span');
    ts.className = 'ts'; ts.textContent = nowHM();
    div.appendChild(ts);
  }
  el.log.appendChild(div);
  el.log.scrollTop = el.log.scrollHeight;
  while (el.log.childElementCount > 200) el.log.removeChild(el.log.firstChild);
}
function setStatus(kind, text) {
  el.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  el.statusText.textContent = text;
}
function nameOf(id) {
  const h = S.roster.find(r => r.id === id);
  if (h) return h.name;
  return id === HOST_ID ? '中继台' : '成员';
}
/** 逻辑 id ↔ 实际 PeerJS id 的映射（只有中继台需要转换） */
function peerIdOf(logicalId) {
  return logicalId === HOST_ID ? (PEER_PREFIX + S.code) : logicalId;
}
function logicalIdOf(actualPeerId) {
  return actualPeerId === (PEER_PREFIX + S.code) ? HOST_ID : actualPeerId;
}

/* =========================================================================
 *  语音质量：Opus 参数调优（设计思路见文件头 VoNR 那段）
 * ========================================================================= */

/**
 * 把 Opus 的 fmtp 参数改写成本项目要的那一套：
 *   全带宽 48kHz · 单声道 · 带内 FEC（抗丢包）· 关 DTX（不削语音起头）· 按档位限速
 * 这是"能不能好听"的关键一步 —— 默认参数下 Chrome 给的是 minptime=10;useinbandfec=1，
 * 少了带宽与速率约束，弱网时 Opus 会自己降到很低的码率，听起来就"糊、闷、断"。
 */
function mungeOpusSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const prof = QUALITY_PROFILES[S.soundQuality] || QUALITY_PROFILES.standard;
  const m = /a=rtpmap:(\d+)\s+opus\/48000\/\d/i.exec(sdp);
  if (!m) return sdp;                       // 没协商到 Opus，原样返回（诊断面板会报警）
  const pt = m[1];
  const params =
    'minptime=10;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0' +
    ';maxaveragebitrate=' + prof.maxaveragebitrate +
    ';maxplaybackrate=48000';
  const re = new RegExp('a=fmtp:' + pt + ' [^\\r\\n]*');
  if (re.test(sdp)) return sdp.replace(re, 'a=fmtp:' + pt + ' ' + params);
  return sdp.replace(
    new RegExp('(a=rtpmap:' + pt + ' opus/48000/\\d[^\\r\\n]*)'),
    '$1\r\na=fmtp:' + pt + ' ' + params
  );
}

/** 把 Opus 排到音频编解码列表最前 —— 杜绝协商到 PCMU/PCMA 这类 8kHz 窄带编码 */
function preferOpus(pc) {
  try {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('audio');
    if (!caps || !caps.codecs || !caps.codecs.length) return;
    const opus = caps.codecs.filter(c => /opus/i.test(c.mimeType || ''));
    if (!opus.length) return;
    const rest = caps.codecs.filter(c => !/opus/i.test(c.mimeType || ''));
    const wanted = opus.concat(rest);
    const trs = pc.getTransceivers ? pc.getTransceivers() : [];
    for (const tr of trs) {
      try { if (tr.setCodecPreferences) tr.setCodecPreferences(wanted); } catch (e) {}
    }
  } catch (e) {}
}

/**
 * 给所有 RTCPeerConnection 的 SDP 生成过程装改写钩子。
 * PeerJS 没有暴露 sdpTransform（那是 simple-peer 的能力），只能从这里切入。
 */
function installSdpTuning() {
  const RTC = window.RTCPeerConnection;
  if (!RTC || RTC.__walkieTuned) return;
  ['createOffer', 'createAnswer'].forEach(name => {
    const orig = RTC.prototype[name];
    if (typeof orig !== 'function') return;
    RTC.prototype[name] = function (...args) {
      try { preferOpus(this); } catch (e) {}
      const p = orig.apply(this, args);
      if (!p || typeof p.then !== 'function') return p;
      return p.then(desc => {
        try {
          if (desc && desc.sdp) {
            const tuned = mungeOpusSdp(desc.sdp);
            if (tuned && tuned !== desc.sdp) desc.sdp = tuned;
          }
        } catch (e) { console.warn('[sdp] 改写失败，沿用原始 SDP', e); }
        return desc;
      });
    };
  });
  RTC.__walkieTuned = true;
}

/** 给每一路的音频发送器设码率上限（SDP 里的 maxaveragebitrate 之外再加一道保险） */
function tuneSenders() {
  const prof = QUALITY_PROFILES[S.soundQuality] || QUALITY_PROFILES.standard;
  for (const [, slot] of S.links) {
    const pc = slot.call && slot.call.peerConnection;
    if (!pc || !pc.getSenders) continue;
    try {
      for (const sn of pc.getSenders()) {
        if (!sn.track || sn.track.kind !== 'audio') continue;
        const p = sn.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = prof.maxBitrate;
        try { sn.setParameters(p); } catch (e) {}
      }
    } catch (e) {}
  }
}

function updateQualityChip() {
  if (!el.btnQuality) return;
  const p = QUALITY_PROFILES[S.soundQuality] || QUALITY_PROFILES.standard;
  el.btnQuality.textContent = '🎚 ' + p.label;
  el.btnQuality.title = p.hint;
  el.btnQuality.classList.toggle('on', S.soundQuality !== 'standard');
}

/* =========================================================================
 *  链路质量实时评分 —— 让"质量不好"变成看得见的数字
 * ========================================================================= */
const qualityTimerRef = { t: null };

function qualityLabel(score) {
  if (score >= 80) return { cls: 'good', text: '优' };
  if (score >= 55) return { cls: 'fair', text: '良' };
  return { cls: 'poor', text: '差' };
}

async function sampleQuality() {
  if (!S.connected || !S.links.size) { S.quality = null; renderQuality(); return null; }
  let worst = 100;
  const detail = {};
  for (const [id, slot] of S.links) {
    const pc = slot.call && slot.call.peerConnection;
    if (!pc) continue;
    let rtt = null, jitter = null, lostPct = null, limit = null, codec = null;
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach(r => byId.set(r.id, r));
      stats.forEach(r => {
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          const cp = byId.get(r.selectedCandidatePairId);
          if (cp && cp.currentRoundTripTime != null) rtt = cp.currentRoundTripTime * 1000;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (r.jitter != null) jitter = r.jitter;
          const recv = r.packetsReceived || 0, lost = r.packetsLost || 0;
          if (recv + lost > 0) lostPct = lost / (recv + lost) * 100;
          if (r.codecId && byId.get(r.codecId)) codec = byId.get(r.codecId).mimeType;
        }
        if (r.type === 'outbound-rtp' && r.kind === 'audio' && r.qualityLimitationReason) {
          limit = r.qualityLimitationReason;
        }
      });
    } catch (e) { continue; }

    let sc = 100;
    if (rtt != null) { if (rtt > 400) sc -= 35; else if (rtt > 200) sc -= 20; else if (rtt > 120) sc -= 8; }
    if (jitter != null) { if (jitter > 0.06) sc -= 30; else if (jitter > 0.03) sc -= 15; else if (jitter > 0.015) sc -= 5; }
    if (lostPct != null) { if (lostPct > 5) sc -= 35; else if (lostPct > 2) sc -= 20; else if (lostPct > 0.5) sc -= 8; }
    if (limit === 'bandwidth') sc -= 25; else if (limit === 'cpu') sc -= 20;
    if (codec && !/opus/i.test(codec)) sc -= 20;
    sc = Math.max(0, Math.min(100, sc));

    detail[id === HOST_ID ? '中继台' : id.slice(-4)] = {
      rttMs: rtt == null ? null : Math.round(rtt),
      jitterMs: jitter == null ? null : Math.round(jitter * 1000),
      lostPct: lostPct == null ? null : +lostPct.toFixed(2),
      limit, codec
    };
    if (sc < worst) worst = sc;
  }
  S.quality = Object.assign({ score: worst, detail }, qualityLabel(worst));
  renderQuality();
  return S.quality;
}

function renderQuality() {
  const b = el.qBadge;
  if (!b) return;
  const q = S.quality;
  if (!q || !S.connected) { b.className = 'q-badge hidden'; b.textContent = ''; return; }
  b.className = 'q-badge ' + q.cls;
  b.textContent = '网络 ' + q.text;
  b.title = '链路评分 ' + q.score + '/100（延迟 · 抖动 · 丢包 · 编解码 综合）';
}

function startQualityWatch() {
  if (qualityTimerRef.t) return;
  qualityTimerRef.t = setInterval(() => { sampleQuality(); }, 2500);
}
function stopQualityWatch() {
  clearInterval(qualityTimerRef.t);
  qualityTimerRef.t = null;
  S.quality = null;
  renderQuality();
}

/* =========================================================================
 *  附近频道发现（局域网 UDP 广播 → 原生 WalkieBeacon 插件）
 *
 *  设计取舍：只有「中继台」广播自己的频道，所有人都可以监听 ——
 *  这样界面上不会出现同一个频道被多人重复播报。
 *  首页发现新频道 → 预警提示 + 一键加入；在频道里则不打扰。
 * ========================================================================= */
function nativeBeacon() {
  try {
    const C = window.Capacitor;
    if (!C) return null;
    if (typeof C.isNativePlatform === 'function' && !C.isNativePlatform()) return null;
    if (C.Plugins && C.Plugins.WalkieBeacon) return C.Plugins.WalkieBeacon;
    if (typeof C.registerPlugin === 'function') return C.registerPlugin('WalkieBeacon');
  } catch (e) {}
  return null;
}
function hasBeacon() { return !!nativeBeacon(); }

let beaconListenerBound = false;
function bindBeaconListener() {
  if (beaconListenerBound) return;
  const plugin = nativeBeacon();
  if (!plugin || typeof plugin.addListener !== 'function') return;
  beaconListenerBound = true;
  plugin.addListener('nearby', info => {
    try { onBeaconSeen(info); } catch (e) { console.warn('[beacon] 处理失败', e); }
  });
}

/** 当前该不该开广播 / 该不该收听广播 */
function beaconDesired() {
  if (typeof document !== 'undefined' && document.hidden) return { on: false, announce: false };
  const inRoom = el.room.classList.contains('active');
  if (!inRoom) return { on: !!S.beaconScan, announce: false };    // 首页：只扫
  const announce = S.role === 'host' && S.beaconVisible;         // 台长：广播自己
  return { on: true, announce };
}

let beaconSyncTimer = null;
/** 信标状态同步（合并短时间内的多次请求，避免频繁打扰原生层） */
function syncBeacon() {
  clearTimeout(beaconSyncTimer);
  beaconSyncTimer = setTimeout(doSyncBeacon, 150);
}
async function doSyncBeacon() {
  const plugin = nativeBeacon();
  if (!plugin) return false;
  const want = beaconDesired();

  if (!want.on) {
    if (S.beaconOn) { S.beaconOn = false; try { await plugin.stop(); } catch (e) {} }
    return false;
  }
  const opts = {
    instance: S.instance,
    announce: !!want.announce,
    code: want.announce ? S.code : '',
    name: want.announce ? S.name : '',
    host: want.announce ? S.name : '',
    members: want.announce ? (1 + S.members.size) : 1
  };
  try {
    if (!S.beaconOn) {
      await plugin.start(opts);
      S.beaconOn = true;
      bindBeaconListener();
    } else {
      await plugin.update(opts);
    }
  } catch (e) {
    console.warn('[beacon] 启动失败：', e && e.message);
    S.beaconOn = false;
    return false;
  }
  return true;
}

function onBeaconSeen(info) {
  if (!info || !info.code) return;
  const code = String(info.code).toUpperCase();
  if (code === S.code) return;
  const isNew = !S.nearby.has(code);
  S.nearby.set(code, {
    code,
    name: String(info.name || '').slice(0, 20),
    host: String(info.host || info.name || '').slice(0, 20),
    members: Number(info.members) || 1,
    ip: info.ip || '',
    src: 'lan',                     // 局域网广播来源（与公共大厅的 'net' 区分）
    seenAt: Date.now()
  });
  const onHome = el.home.classList.contains('active');
  if (isNew && onHome && S.nearbyAlerted !== code) {
    S.nearbyAlerted = code;
    showNearbyAlert(code);
  }
  renderNearby();
}

function sweepNearby() {
  const now = Date.now();
  let changed = false;
  for (const [code, it] of S.nearby) {
    // 局域网条目靠持续广播续命；大厅条目由列表快照刷新，兜底给更长的窗口
    const ttl = (it.src === 'net') ? LOBBY_NET_TTL : BEACON_TTL_MS;
    if (now - it.seenAt > ttl) { S.nearby.delete(code); changed = true; }
  }
  if (changed) renderNearby();
}

function renderNearby() {
  if (!el.nearbyCard) return;
  const onHome = el.home.classList.contains('active');
  const list = [...S.nearby.values()].sort((a, b) => b.seenAt - a.seenAt);
  updateSearchHint(list, onHome);

  if (!list.length || !onHome || !S.beaconScan) {
    el.nearbyCard.classList.add('hidden');
    if (!onHome) hideNearbyAlert();
    return;
  }
  el.nearbyCard.classList.remove('hidden');
  el.nearbyCount.textContent = String(list.length);
  el.nearbyList.classList.toggle('hidden', !!S.nearbyCollapsed);
  if (el.btnNearbyToggle) el.btnNearbyToggle.textContent = S.nearbyCollapsed ? '展开' : '收起';
  el.nearbyList.innerHTML = '';
  for (const it of list) {
    const b = document.createElement('button');
    b.className = 'nearby-item';
    const tag = document.createElement('span');
    tag.className = 'nb-src ' + (it.src === 'net' ? 'net' : 'lan');
    tag.textContent = it.src === 'net' ? '在线' : '附近';
    const c = document.createElement('span');
    c.className = 'nb-code'; c.textContent = it.code;
    const m = document.createElement('span');
    m.className = 'nb-meta';
    m.textContent = (it.host ? it.host + ' 的频道 · ' : '') + it.members + ' 人在线';
    const g = document.createElement('span');
    g.className = 'nb-go'; g.textContent = '加入';
    b.appendChild(tag); b.appendChild(c); b.appendChild(m); b.appendChild(g);
    b.addEventListener('click', () => joinNearby(it.code));
    el.nearbyList.appendChild(b);
  }
}

/** 首页搜索状态提示 —— 有结果时自动让位给列表，没结果时告诉用户「正在找」 */
function updateSearchHint(list, onHome) {
  if (!el.searchHint) return;
  if (list.length > 0 || !onHome || !S.beaconScan) { el.searchHint.classList.add('hidden'); return; }
  const L = S.lobby;
  let t;
  if (!S.lobby.on) t = '频道发现已关闭（可在设置里开启）';
  else if (L.role === 'host') t = '公共大厅在线 · 正在搜索可连接的频道…';
  else if (L.role === 'client') t = '已连上公共大厅 · 正在搜索可连接的频道…';
  else t = '正在接入公共大厅…';
  el.searchHint.textContent = t;
  el.searchHint.classList.remove('hidden');
}

let nearbyAlertTimer = null;
function showNearbyAlert(code) {
  const it = S.nearby.get(code);
  if (!it || !el.nearbyAlert) return;
  el.naTitle.textContent = '发现可以连接的频道';
  el.naSub.textContent = code + (it.host ? ' · ' + it.host : '') + ' · ' + it.members + ' 人在线';
  el.nearbyAlert.classList.remove('hidden');
  el.nearbyAlert.dataset.code = code;
  buzz([28, 60, 28]);
  clearTimeout(nearbyAlertTimer);
  nearbyAlertTimer = setTimeout(hideNearbyAlert, 12000);
}
function hideNearbyAlert() {
  clearTimeout(nearbyAlertTimer);
  if (el.nearbyAlert) el.nearbyAlert.classList.add('hidden');
}
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
function joinNearby(code) {
  const it = S.nearby.get(code);
  const name = (el.nameInput.value || '').trim() || loadName() || '成员';
  saveName(name);
  hideNearbyAlert();
  if (it && it.host) addLog('', '加入发现频道 ' + code + '（' + it.host + '）', true);
  S.customCode = false;
  joinChannel(name, code);
}

/* =========================================================================
 *  公共大厅（自组织频道目录）—— 突破局域网限制
 *
 *  角色：
 *    host   —— 占用 LOBBY_ID 的 App，维护在线频道表并广播给所有客户端
 *    client —— 连上大厅的 App，心跳上报自己的频道、接收在线频道列表
 *  竞选：连不上大厅 → 自己尝试占用 LOBBY_ID；抢不到（unavailable-id）
 *        → 退避后回到 client 模式重试，最终全网点只有一个大厅。
 * ========================================================================= */
function lobbyConnOpts() { return { reliable: true, serialization: 'json' }; }

/** 大厅专用的 Peer 参数：竞选会主动触发「连不上/ID 被占」这类预期内的错误，
 *  把 debug 关掉，免得日志里一片 ERROR 吓人（它们不是故障）。 */
function lobbyPeerOptions() {
  const o = peerOptions();
  o.debug = 0;
  return o;
}

/** 本机「对外公开的频道」条目 —— 大厅与客户端都用这一份口径 */
function lobbySelfEntry() {
  const inRoom = el.room.classList.contains('active');
  const pub = inRoom && S.role === 'host' && S.beaconVisible;
  const nm = S.name || ((el.nameInput && el.nameInput.value) || '').trim() || '';
  return {
    t: 'hb',
    role: pub ? 'host' : 'idle',
    code: pub ? S.code : '',
    name: nm,
    host: nm,
    members: pub ? (1 + S.members.size) : 0
  };
}

/* ------------------------------ 角色调度 ------------------------------ */
function lobbyStart() {
  const L = S.lobby;
  if (!S.lobby.on || L.role || L.connecting || L.hostPeer) return;
  if (L.peer) { try { L.peer.destroy(); } catch (e) {} L.peer = null; }   // 清理上次遗留
  L.connecting = true;

  let settled = false;
  let peer;
  try { peer = new Peer(null, lobbyPeerOptions()); }
  catch (e) { L.connecting = false; return lobbyRetry(4000); }
  L.peer = peer;

  /* 大厅不存在 / 连接失败 → 我去竞选当大厅 */
  const giveUp = () => {
    if (settled) return;
    settled = true;
    L.connecting = false;
    clearTimeout(L.joinTimer); L.joinTimer = null;
    try { L.conn && L.conn.close(); } catch (e) {}
    L.conn = null;
    try { peer.destroy(); } catch (e) {}
    if (L.peer === peer) L.peer = null;
    lobbyBecomeHost();
  };

  peer.on('error', err => {
    const t = err && err.type;
    if (t === 'peer-unavailable') return giveUp();
    if (t === 'unavailable-id') return;   // 随机 id 不该撞，忽略
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) {
      if (settled) return;
      settled = true;
      L.connecting = false;
      try { peer.destroy(); } catch (e) {}
      if (L.peer === peer) L.peer = null;
      lobbyRetry(6000);                   // 信令本身不通，退避后再来
    }
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });

  peer.on('open', () => {
    if (settled || peer.destroyed) return;
    let conn;
    try { conn = peer.connect(LOBBY_ID, lobbyConnOpts()); } catch (e) { return giveUp(); }
    L.conn = conn;
    clearTimeout(L.joinTimer);
    L.joinTimer = setTimeout(giveUp, LOBBY_JOIN_TO);
    conn.on('open', () => {
      if (settled) return;
      settled = true;
      L.connecting = false;
      clearTimeout(L.joinTimer); L.joinTimer = null;
      lobbyOnJoined(conn);
    });
    conn.on('error', () => giveUp());
  });
  updateLobbyUI();
}

function lobbyRetry(ms) {
  const L = S.lobby;
  clearTimeout(L.retryTimer);
  L.retryTimer = setTimeout(() => {
    L.retryTimer = null;
    lobbyStart();
  }, ms == null ? (1200 + Math.random() * 2200) : ms);
}

/* ------------------------------ 大厅模式 ------------------------------ */
function lobbyBecomeHost() {
  const L = S.lobby;
  if (!S.lobby.on || L.role === 'host' || L.hostPeer) return;
  let p;
  try { p = new Peer(LOBBY_ID, lobbyPeerOptions()); }
  catch (e) { return lobbyRetry(3000); }
  L.hostPeer = p;

  p.on('open', () => {
    if (p !== L.hostPeer) return;
    L.role = 'host';
    L.joinedAt = Date.now();
    ensureLobbySweeper();
    lobbyHostPublishSelf();
    updateLobbyUI();
  });
  p.on('error', err => {
    const t = err && err.type;
    if (t === 'unavailable-id') {
      // 有人抢先当了大厅 → 退避后回到客户端模式
      try { p.destroy(); } catch (e) {}
      if (L.hostPeer === p) L.hostPeer = null;
      L.role = '';
      lobbyRetry(700 + Math.random() * 1600);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) {
      try { p.destroy(); } catch (e) {}
      if (L.hostPeer === p) L.hostPeer = null;
      L.role = '';
      lobbyRetry(6000);
    }
  });
  p.on('disconnected', () => { try { p.reconnect(); } catch (e) {} });
  p.on('connection', conn => lobbyHostAccept(conn));
}

function lobbyHostAccept(conn) {
  const L = S.lobby;
  conn.on('open', () => {
    L.conns.set(conn.peer, conn);
    safeSend(conn, { t: 'list', list: lobbyHostEntries() });   // 立刻先给一份
    conn.on('data', msg => lobbyHostOnData(conn, msg));
    const drop = () => {
      L.conns.delete(conn.peer);
      if (L.table.delete(conn.peer)) lobbyHostBroadcast();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });
}

function lobbyHostOnData(conn, msg) {
  const L = S.lobby;
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'bye') {
    L.table.delete(conn.peer);
    return lobbyHostBroadcast();
  }
  if (msg.t === 'hb' || msg.t === 'hello' || msg.t === 'pub') {
    const prev = L.table.get(conn.peer);
    const next = {
      ts: Date.now(),
      role: msg.role === 'host' ? 'host' : 'idle',
      code: msg.code ? String(msg.code).toUpperCase() : '',
      name: String(msg.name || '').slice(0, 20),
      host: String(msg.host || msg.name || '').slice(0, 20),
      members: Number(msg.members) || 0
    };
    L.table.set(conn.peer, next);
    // 回执：客户端靠它判断大厅是否还活着。
    // 对端页面被直接关掉时，WebRTC 的 close 事件可能要几十秒才触发，
    // 光监听 close 根本来不及自愈 —— 必须靠双向心跳做超时判定。
    safeSend(conn, { t: 'ack' });
    // 只有目录内容真的变了才广播，避免纯心跳引发无谓刷屏
    const changed = !prev || prev.role !== next.role || prev.code !== next.code
      || prev.name !== next.name || prev.members !== next.members;
    if (changed) lobbyHostBroadcast();
  }
}

/** 只有「台长 + 允许被发现」的频道才进目录 */
function lobbyHostEntries() {
  const out = [];
  for (const [, e] of S.lobby.table) {
    if (e.role !== 'host' || !e.code) continue;
    out.push({ code: e.code, name: e.name, host: e.host, members: e.members, ts: e.ts });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function lobbyHostBroadcast() {
  const list = lobbyHostEntries();
  for (const c of S.lobby.conns.values()) safeSend(c, { t: 'list', list });
  applyLobbyList(list);            // 大厅自己也是用户，同样显示这份目录
}

function lobbyHostPublishSelf() {
  const L = S.lobby;
  if (L.role !== 'host') return;
  const s = lobbySelfEntry();
  L.table.set('__self__', {
    ts: Date.now(), role: s.role, code: s.code,
    name: s.name, host: s.host, members: s.members
  });
  lobbyHostBroadcast();
}

function ensureLobbySweeper() {
  const L = S.lobby;
  if (L.sweepTimer) return;
  L.sweepTimer = setInterval(() => {
    if (L.role !== 'host') return;
    const now = Date.now();
    let changed = false;
    for (const [id, e] of L.table) {
      if (id === '__self__') continue;
      if (now - e.ts > LOBBY_TTL_MS) { L.table.delete(id); changed = true; }
    }
    const dead = [];
    for (const [id, c] of L.conns) if (!c.open) dead.push(id);
    for (const id of dead) { L.conns.delete(id); if (L.table.delete(id)) changed = true; }
    if (changed) lobbyHostBroadcast();
  }, LOBBY_SWEEP_MS);
}

/* ------------------------------ 客户端模式 ------------------------------ */
function lobbyOnJoined(conn) {
  const L = S.lobby;
  L.role = 'client';
  L.conn = conn;
  L.joinedAt = Date.now();
  L.lastRxAt = Date.now();

  conn.on('data', msg => {
    L.lastRxAt = Date.now();               // 收到任何回音（list / ack）都算大厅还活着
    if (msg && msg.t === 'list') applyLobbyList(msg.list);
  });
  const down = () => {
    if (L.conn !== conn) return;           // 已经不是当前连接了，忽略
    lobbyClientDead();
  };
  conn.on('close', down);
  conn.on('error', down);

  lobbyClientHello();
  clearInterval(L.hbTimer);
  L.hbTimer = setInterval(lobbyClientHello, LOBBY_HB_MS);
  startLobbyWatch();
  renderNearby();
  updateLobbyUI();
}

/** 客户端健康检查：
 *  大厅可能是一台被关掉 / 息屏的手机，它的 DataChannel 断开会滞后很久，
 *  所以靠「多久没收到任何回音」判定失联，而不是干等 close 事件。 */
function startLobbyWatch() {
  const L = S.lobby;
  clearInterval(L.watchTimer);
  L.watchTimer = setInterval(() => {
    if (L.role !== 'client' || !L.conn) return;
    if (Date.now() - L.lastRxAt > LOBBY_RX_TO) lobbyClientDead();
  }, LOBBY_WATCH_MS);
}

/** 客户端认定大厅已死 → 清理连接，退避后重新竞选 */
function lobbyClientDead() {
  const L = S.lobby;
  if (L.role !== 'client') return;
  const c = L.conn;
  L.conn = null;
  L.role = '';
  clearInterval(L.hbTimer); L.hbTimer = null;
  clearInterval(L.watchTimer); L.watchTimer = null;
  try { c && c.close(); } catch (e) {}
  try { L.peer && L.peer.destroy(); } catch (e) {}   // 不销毁会漏掉整个 WebSocket
  L.peer = null;
  dropNetEntries();
  renderNearby();
  updateLobbyUI();
  lobbyRetry();
}

function lobbyClientHello() {
  const c = S.lobby.conn;
  if (!c) return;
  safeSend(c, lobbySelfEntry());
}

/* --------------------- 收到目录 → 合并进 nearby --------------------- */
function applyLobbyList(list) {
  const L = S.lobby;
  L.lastListAt = Date.now();
  const seen = new Set();
  if (Array.isArray(list)) {
    for (const e of list) {
      const code = String((e && e.code) || '').toUpperCase();
      if (!code || code === S.code) continue;
      seen.add(code);
      const prev = S.nearby.get(code);
      const wasLan = !!(prev && prev.src === 'lan');
      S.nearby.set(code, {
        code,
        name: String(e.name || '').slice(0, 20),
        host: String(e.host || e.name || '').slice(0, 20),
        members: Number(e.members) || 1,
        ip: wasLan ? prev.ip : '',
        // 同一频道若已在局域网里见过，来源标记保留「附近」（更近、信息更准）
        src: wasLan ? 'lan' : 'net',
        seenAt: Date.now()
      });
    }
  }
  for (const [code, it] of S.nearby) {
    if (it.src === 'net' && !seen.has(code)) S.nearby.delete(code);
  }
  renderNearby();
}

function dropNetEntries() {
  for (const [code, it] of S.nearby) if (it.src === 'net') S.nearby.delete(code);
}

function lobbyStop() {
  const L = S.lobby;
  clearTimeout(L.retryTimer); L.retryTimer = null;
  clearTimeout(L.joinTimer); L.joinTimer = null;
  clearInterval(L.hbTimer); L.hbTimer = null;
  clearInterval(L.sweepTimer); L.sweepTimer = null;
  clearInterval(L.watchTimer); L.watchTimer = null;
  try { L.conn && L.conn.close(); } catch (e) {}
  for (const c of L.conns.values()) { try { c.close(); } catch (e) {} }
  try { L.peer && L.peer.destroy(); } catch (e) {}
  try { L.hostPeer && L.hostPeer.destroy(); } catch (e) {}
  L.conn = null; L.peer = null; L.hostPeer = null;
  L.conns.clear(); L.table.clear();
  L.role = ''; L.connecting = false;
  dropNetEntries();
  renderNearby();
  updateLobbyUI();
}

function lobbySetEnabled(on) {
  S.lobby.on = !!on;
  saveLobbyOn(S.lobby.on);
  if (S.lobby.on) lobbyStart();
  else lobbyStop();
  updateLobbyUI();
}

let lobbyPubTimer = null;
/** 进/出频道、成员数变化时同步给大厅（节流，避免发言权切换时刷屏） */
function lobbyPublish() {
  if (!S.lobby.on) return;
  clearTimeout(lobbyPubTimer);
  lobbyPubTimer = setTimeout(() => {
    if (S.lobby.role === 'host') lobbyHostPublishSelf();
    else if (S.lobby.role === 'client') lobbyClientHello();
  }, 250);
}

function updateLobbyUI() {
  if (!el.lobbyState) return;
  const L = S.lobby;
  let t = '未启用';
  if (S.lobby.on) {
    if (L.role === 'host') t = '在线 · 本机担任大厅（附近无其他大厅）';
    else if (L.role === 'client') t = '在线 · 已接入公共大厅';
    else t = '连接中…';
  }
  el.lobbyState.textContent = t;
  el.lobbyState.className = 'lobby-state' + (S.lobby.on && L.role ? ' on' : '');
  if (el.searchHint) renderNearby();   // 首页搜索提示的文案跟着大厅角色变
}

async function setVoiceFocus(on) {
  const plugin = nativeAudioPlugin();
  if (!plugin || typeof plugin.setVoiceFocus !== 'function') return;
  try { await plugin.setVoiceFocus({ on: !!on }); } catch (e) {}
}

/* ------------------------------ 麦克风门控 ------------------------------ */
async function initAudio() {
  if (!S.localStream) {
    // 采集侧就给足带宽：48kHz / 单声道 / 低延迟，三项基础处理全开
    // （AEC/降噪/自动增益要在原生 MODE_IN_COMMUNICATION 下才真正生效）
    const wanted = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      channelCount: 1, sampleRate: 48000, sampleSize: 16, latency: 0.02
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: wanted, video: false });
    } catch (e) {
      // 个别老机型不接受 sampleRate/latency 这类约束 —— 退回最小可用集重试
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false
      });
    }
    S.localStream = stream;
    S.localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    try {
      const tr = S.localStream.getAudioTracks()[0];
      S.micSettings = tr ? tr.getSettings() : null;
    } catch (e) { S.micSettings = null; }
  }
  return S.localStream;
}
function setMic(on) {
  S.micOn = !!on;
  if (S.localStream) S.localStream.getAudioTracks().forEach(t => { t.enabled = !!on; });
  applyPlaybackGate();
}
/** 半双工的核心：什么时候该开麦 */
function micShouldBeOn() {
  if (!S.connected || !S.localStream) return false;
  if (!S.pressing) return false;                          // 松手 → 必闭嘴
  if (S.floorHolder === S.selfId) return true;             // 我拿到发言权
  if (S.floorHolder === null && !S.denied) return true;    // 频道空闲 → 乐观开麦，降起音延迟
  return false;                                            // 别人在说 / 我已被排队 → 闭嘴
}
function applyMicGate() { setMic(micShouldBeOn()); }

/** 真对讲机的听感：自己按住说话时不播远端（对方的尾音不会被自己的麦克风再采一遍） */
function applyPlaybackGate() {
  for (const a of S.audioEls.values()) a.muted = S.micOn;
}
function applyVolume() {
  for (const a of S.audioEls.values()) a.volume = S.remoteVolume;
}

/** 切换音频输出路由。听筒模式能大幅减少"喇叭声串进对方麦克风"，是压回音的主力手段。 */
async function applyAudioRoute(mode, silent) {
  S.route = (mode === 'earpiece') ? 'earpiece' : 'speaker';
  const plugin = nativeAudioPlugin();
  let nativeOk = false;
  if (plugin) {
    try { await plugin.setRoute({ mode: S.route }); nativeOk = true; }
    catch (e) { console.warn('[route] 原生切换失败：', e && e.message); }
  }
  if (!nativeOk) {
    // 浏览器里没有原生路由，只能用音量近似模拟
    S.remoteVolume = (S.route === 'earpiece') ? 0.45 : Math.max(S.remoteVolume, 0.9);
    if (el.volRange) el.volRange.value = String(Math.round(S.remoteVolume * 100));
  }
  applyVolume();
  updateRouteUI();
  saveRoute(S.route);
  if (!silent) {
    if (S.route === 'earpiece') toast('已切到听筒模式（明显压回音）');
    else toast('已切回外放');
  }
}
function updateRouteUI() {
  if (!el.btnRoute) return;
  const ear = S.route === 'earpiece';
  el.btnRoute.textContent = ear ? '👂 听筒' : '🔊 外放';
  el.btnRoute.classList.toggle('on', ear);
}

/** 一次性提示：同屋外放会产生回音 */
function echoTipOnce() {
  try {
    if (localStorage.getItem('walkie.echoTip') === '1') return;
    localStorage.setItem('walkie.echoTip', '1');
  } catch (e) {}
  addLog('', '提示：如果听到回音，多半是两台设备离得太近、都在外放 —— 戴耳机或拉开距离即可消除（也可点上方「回音?」）', true);
}

function releaseAudio() {
  if (S.localStream) {
    S.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    S.localStream = null;
  }
  S.micOn = false;
}

/* ------------------------------ PeerJS ------------------------------ */
function peerOptions() {
  const s = S.signaling;
  return {
    host: s.host,
    port: Number(s.port) || 443,
    secure: !!s.secure,
    path: s.path || '/',
    debug: 1,
    config: { iceServers: ICE_SERVERS, sdpSemantics: 'unified-plan' }
  };
}
function safeSend(conn, obj) {
  if (!conn) return false;
  try { if (!conn.open) return false; conn.send(obj); return true; } catch (e) { return false; }
}
function sendToMember(id, obj) {
  const m = S.members.get(id);
  if (m && m.conn) safeSend(m.conn, obj);
}
function hostBroadcast(obj) {
  for (const m of S.members.values()) safeSend(m.conn, obj);
}

/* =========================================================================
 *  语音链路：成员间 P2P 全互联，用 <audio> 直接播放
 * ========================================================================= */
function syncMesh(wantedIds) {
  if (!S.peer || !S.localStream) return;
  const want = new Set(wantedIds.filter(id => id && id !== S.selfId));
  for (const id of want) if (!S.links.has(id)) openLink(id);
  for (const id of [...S.links.keys()]) if (!want.has(id)) dropLink(id);
}

function openLink(logicalId) {
  const slot = { call: null, initiated: false };
  S.links.set(logicalId, slot);
  // 约定：逻辑 id 字典序小的一方发起，避免双向重复连接
  if (S.selfId < logicalId) {
    try {
      const call = S.peer.call(peerIdOf(logicalId), S.localStream);
      slot.call = call;
      slot.initiated = true;
      wireMediaCall(call, logicalId);
    } catch (e) { console.warn('[mesh] call 失败', logicalId, e); }
  }
  // 否则等对方呼入（peer.on('call')）
}

function onIncomingCall(call) {
  const logicalId = logicalIdOf(call.peer);
  let slot = S.links.get(logicalId);
  if (!slot) { slot = { call: null, initiated: false }; S.links.set(logicalId, slot); }
  if (slot.call) { try { call.close(); } catch (e) {} return; }   // 已有连接，丢弃重复的
  slot.call = call;
  try { call.answer(S.localStream); } catch (e) { console.warn('[mesh] answer 失败', e); }
  wireMediaCall(call, logicalId);
}

function wireMediaCall(call, logicalId) {
  call.on('stream', stream => {
    if (S.destroyed) return;
    playRemote(logicalId, stream);
  });
  call.on('close', () => { if (!S.destroyed) dropLink(logicalId); });
  call.on('error', e => console.warn('[mesh] 媒体错误', logicalId, e && e.type));
  // 等协商落定后再锁码率，避免参数被后续的 setLocalDescription 冲掉
  setTimeout(() => { tuneSenders(); startQualityWatch(); }, 900);
}

/** 用 <audio> 元素播放远端流 —— WebRTC 播放的标准做法 */
function playRemote(logicalId, stream) {
  let a = S.audioEls.get(logicalId);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true;
    a.setAttribute('playsinline', 'true');
    a.style.display = 'none';
    document.body.appendChild(a);
    S.audioEls.set(logicalId, a);
  }
  a.volume = S.remoteVolume;
  a.muted = S.micOn;
  if (a.srcObject === stream) return;
  a.srcObject = stream;
  const p = a.play();
  if (p && p.catch) p.catch(e => console.warn('[mesh] 播放被拒:', e.message));
}

function dropLink(logicalId) {
  const slot = S.links.get(logicalId);
  if (slot && slot.call) { try { slot.call.close(); } catch (e) {} }
  S.links.delete(logicalId);
  const a = S.audioEls.get(logicalId);
  if (a) {
    try { a.srcObject = null; a.remove(); } catch (e) {}
    S.audioEls.delete(logicalId);
  }
}

function dropAllLinks() {
  for (const id of [...S.links.keys()]) dropLink(id);
  S.links.clear();
}

/* =========================================================================
 *  界面
 * ========================================================================= */
function enterRoom() {
  el.home.classList.remove('active');
  el.room.classList.add('active');
  el.roomCode.textContent = S.code;
  el.roleBadge.classList.toggle('hidden', S.role !== 'host');
  el.members.innerHTML = '';
  el.log.innerHTML = '';
  el.chatInput.value = '';
  S.roster = [];
  renderRoster();
  refreshPttUI();
  updateRouteUI();
  updateQualityChip();
  echoTipOnce();
  hideNearbyAlert();
  renderNearby();
  setVoiceFocus(true);
  syncBeacon();
  lobbyPublish();                  // 进频道 → 让公共大厅知道我开了什么频道
  try { history.pushState({ room: 1 }, ''); } catch (e) {}
}
function backToHome() {
  el.room.classList.remove('active');
  el.home.classList.add('active');
  el.members.innerHTML = '';
  el.log.innerHTML = '';
  el.speakingBar.className = 'speaking-bar';
  renderQuality();
  renderNearby();
  syncBeacon();
  lobbyPublish();
}
function leaveRoom(silent) {
  if (S.role === 'host' && !silent) hostBroadcast({ type: 'end' });
  dropAllLinks();
  if (S.hostConn) { try { S.hostConn.close(); } catch (e) {} }
  if (S.peer) { try { S.peer.destroy(); } catch (e) {} }

  S.destroyed = true;
  S.peer = null; S.hostConn = null;
  S.members.clear();
  S.floorHolder = null; S.queue = []; S.pressing = false; S.connected = false;
  S.denied = false; S.autoJoining = false; S.customCode = false;
  S.selfId = ''; S.roster = [];
  stopQualityWatch();
  setVoiceFocus(false);
  releaseAudio();
  backToHome();
  lobbyPublish();
}

function initials(name) {
  if (!name) return '?';
  return name.trim().slice(0, 1).toUpperCase();
}
function renderRoster() {
  el.members.innerHTML = '';
  for (const r of S.roster) {
    const d = document.createElement('div');
    d.className = 'member' + (S.floorHolder === r.id ? ' speaking' : '');
    const av = document.createElement('span');
    av.className = 'av'; av.textContent = initials(r.name);
    const nm = document.createElement('span');
    nm.textContent = r.name;
    d.appendChild(av); d.appendChild(nm);
    if (r.isHost) {
      const hb = document.createElement('span');
      hb.className = 'me'; hb.textContent = '中继台';
      d.appendChild(hb);
    }
    if (r.id === S.selfId) {
      const me = document.createElement('span');
      me.className = 'me'; me.textContent = '你';
      d.appendChild(me);
    }
    el.members.appendChild(d);
  }
}

function refreshPttUI() {
  const btn = el.pttBtn;
  btn.classList.remove('live', 'waiting', 'busy', 'off');

  if (!S.connected) {
    btn.classList.add('off');
    el.pttLabel.innerHTML = '按住<br/>说话';
    el.pttTip.textContent = '未接入频道';
    el.speakingBar.className = 'speaking-bar';
    el.speakingText.textContent = '按住下方按钮开始讲话';
    return;
  }
  const iHold = S.floorHolder === S.selfId;

  if (S.pressing && iHold) {
    btn.classList.add('live');
    el.pttLabel.innerHTML = '正在<br/>讲话';
    el.pttTip.textContent = '松开结束发言';
    el.speakingBar.className = 'speaking-bar live';
    el.speakingText.textContent = '你正在讲话…';
  } else if (S.pressing) {
    btn.classList.add('waiting');
    el.pttLabel.innerHTML = '请求<br/>发言';
    el.pttTip.textContent = '正在申请发言权…';
    el.speakingBar.className = 'speaking-bar busy';
    el.speakingText.textContent = '等待发言权…';
  } else if (S.floorHolder) {
    btn.classList.add('busy');
    el.pttLabel.innerHTML = '频道<br/>占用';
    el.pttTip.textContent = nameOf(S.floorHolder) + ' 正在发言';
    el.speakingBar.className = 'speaking-bar busy';
    el.speakingText.textContent = (S.floorHolder === S.selfId ? '你' : nameOf(S.floorHolder)) + ' 正在讲话';
  } else {
    el.pttLabel.innerHTML = '按住<br/>说话';
    el.pttTip.textContent = '发言权空闲';
    el.speakingBar.className = 'speaking-bar';
    el.speakingText.textContent = '按住下方按钮开始讲话';
  }
  renderRoster();
}

/* =========================================================================
 *  PTT 交互
 * ========================================================================= */
function pressPTT() {
  if (!S.connected || S.pressing) return;
  S.pressing = true;
  S.denied = false;
  if (S.role === 'host') hostRequestFloor(HOST_ID);
  else safeSend(S.hostConn, { type: 'floor-request' });
  applyMicGate();          // 频道空闲则立刻开麦
  refreshPttUI();
}
function releasePTT() {
  if (!S.pressing) return;
  S.pressing = false;
  if (S.role === 'host') hostReleaseFloor(HOST_ID);
  else safeSend(S.hostConn, { type: 'floor-release' });
  applyMicGate();          // 松手必须立刻闭嘴
  refreshPttUI();
}

/* =========================================================================
 *  中继台（HOST）：只做频道码注册 / 成员表 / 发言权仲裁，不碰音频
 * ========================================================================= */
async function startHost(name, code) {
  try { await initAudio(); }
  catch (e) { toast('无法访问麦克风，请检查权限'); addLog('', '麦克风不可用：' + e.message, true); return; }

  S.role = 'host'; S.code = code; S.name = name; S.selfId = HOST_ID; S.destroyed = false;
  saveChannel(code, 'host', name);
  enterRoom();
  addLog('', '频道 ' + code + ' 已建立，你是中继台', true);
  createHostPeer(code);
}

function createHostPeer(code) {
  if (S.destroyed) return;
  const peer = new Peer(PEER_PREFIX + code, peerOptions());
  S.peer = peer;

  peer.on('open', () => {
    if (S.destroyed) return;
    S.connected = true;
    S.autoJoining = false;
    setStatus('on', '在线 · 等待成员加入');
    S.roster = rosterSnapshot();
    renderRoster(); refreshPttUI();
    toast('频道已开启：' + code, 3000);
  });
  peer.on('connection', conn => bindHostConn(conn));
  peer.on('call', call => onIncomingCall(call));

  peer.on('error', err => {
    if (S.destroyed) return;
    console.warn('[host peer error]', err);
    if (err.type === 'unavailable-id') {
      if (S.customCode) {
        // 用户自己指定的频道码，绝不能偷偷换掉 —— 明说让他改
        toast('频道码 ' + S.code + ' 已被占用，换一个吧', 3600);
        addLog('', '「' + S.code + '」已经被别人用着了。回首页换一个自定义频道码，或清空输入框让它自动生成。', true);
        setTimeout(() => { if (!S.destroyed) leaveRoom(true); }, 1300);
      } else {
        const nc = randCode();
        toast('频道码被占用，已自动更换为 ' + nc, 3000);
        try { peer.destroy(); } catch (e) {}
        S.code = nc; S.peer = null;
        saveChannel(nc, 'host', S.name);
        el.roomCode.textContent = nc;
        syncBeacon();
        setTimeout(() => createHostPeer(nc), 400);
      }
    } else if (['network', 'server-error', 'socket-error'].includes(err.type)) {
      setStatus('err', '信令服务器连接失败');
      toast('信令服务器不可用，请在设置中更换', 3200);
    } else {
      setStatus('warn', '信令异常：' + err.type);
    }
  });
  peer.on('disconnected', () => {
    if (S.destroyed) return;
    setStatus('warn', '信令断开，重连中…');
    try { peer.reconnect(); } catch (e) {}
  });
}

function bindHostConn(conn) {
  conn.on('data', msg => { if (!S.destroyed) hostHandleData(conn, msg); });
  conn.on('close', () => hostDropMember(conn.peer));
  conn.on('error', () => hostDropMember(conn.peer));
}

function hostHandleData(conn, msg) {
  const id = conn.peer;
  switch (msg.type) {
    case 'hello': {
      let m = S.members.get(id);
      if (!m) {
        m = { id, name: (msg.name || '匿名').slice(0, 12), muted: false, conn };
        S.members.set(id, m);
        addLog('', m.name + ' 加入频道', true);
      } else {
        m.name = (msg.name || m.name).slice(0, 12);
        m.conn = conn;
      }
      safeSend(conn, {
        type: 'welcome', selfId: HOST_ID, code: S.code,
        roster: rosterSnapshot(), floor: S.floorHolder
      });
      hostBroadcastRoster();
      break;
    }
    case 'floor-request': hostRequestFloor(id); break;
    case 'floor-release': hostReleaseFloor(id); break;
    case 'chat': {
      const m = S.members.get(id);
      const payload = { type: 'chat', id, name: m ? m.name : '成员', text: String(msg.text || '').slice(0, 200) };
      addLog(payload.name, payload.text, false);
      hostBroadcast(payload);
      break;
    }
    case 'state': {
      const m = S.members.get(id);
      if (m) { m.muted = !!msg.muted; hostBroadcastRoster(); }
      break;
    }
  }
}

function hostDropMember(id) {
  const m = S.members.get(id);
  if (!m) return;
  S.members.delete(id);
  dropLink(id);
  S.queue = S.queue.filter(x => x !== id);
  if (S.floorHolder === id) {
    S.floorHolder = null;
    const next = S.queue.shift();
    if (next) hostGrantFloor(next); else hostBroadcastFloor();
  }
  addLog('', m.name + ' 离开频道', true);
  hostBroadcastRoster();
}

function rosterSnapshot() {
  const list = [{
    id: HOST_ID, name: S.name, isHost: true,
    speaking: S.floorHolder === HOST_ID, muted: false
  }];
  for (const m of S.members.values()) {
    list.push({ id: m.id, name: m.name, isHost: false, speaking: S.floorHolder === m.id, muted: !!m.muted });
  }
  return list;
}
function hostBroadcastRoster() {
  S.roster = rosterSnapshot();
  if (S.role === 'host') {
    renderRoster();
    syncMesh(S.roster.map(r => r.id));
    syncBeacon();                    // 成员数变了，让附近的人看到最新人数
    lobbyPublish();                  // 同理同步给公共大厅
  }
  hostBroadcast({ type: 'roster', roster: S.roster });
}
function hostBroadcastFloor() {
  if (S.role === 'host') S.roster = rosterSnapshot();
  hostBroadcast({ type: 'floor', holder: S.floorHolder });
  hostBroadcastRoster();          // 同步成员列表「正在发言」高亮
  applyMicGate();
  refreshPttUI();
}

function hostRequestFloor(id) {
  if (S.floorHolder === null) { hostGrantFloor(id); return; }
  if (S.floorHolder === id) return;
  if (!S.queue.includes(id)) {
    S.queue.push(id);
    if (id !== HOST_ID) sendToMember(id, { type: 'floor-wait' });
    else toast('频道被占用，你已排队');
  }
}
function hostReleaseFloor(id) {
  if (S.floorHolder === id) {
    S.floorHolder = null;
    hostBroadcastFloor();
    const next = S.queue.shift();
    if (next) setTimeout(() => hostGrantFloor(next), 40);
  } else {
    S.queue = S.queue.filter(x => x !== id);
  }
}
function hostGrantFloor(id) {
  S.queue = S.queue.filter(x => x !== id);
  S.floorHolder = id;
  hostBroadcastFloor();
}

/* =========================================================================
 *  成员（MEMBER）
 * ========================================================================= */
async function joinChannel(name, code) {
  try { await initAudio(); }
  catch (e) { toast('无法访问麦克风，请检查权限'); addLog('', '麦克风不可用：' + e.message, true); return; }

  S.role = 'member'; S.code = code; S.name = name; S.selfId = ''; S.destroyed = false;
  saveChannel(code, 'member', name);
  enterRoom();
  addLog('', '正在接入频道 ' + code + '…', true);

  const peer = new Peer(null, peerOptions());
  S.peer = peer;

  peer.on('open', id => {
    if (S.destroyed) return;
    S.selfId = id;
    setStatus('warn', '正在接入频道…');
    connectToHost();
  });
  peer.on('call', call => onIncomingCall(call));

  peer.on('error', err => {
    if (S.destroyed) return;
    console.warn('[member peer error]', err);
    if (err.type === 'peer-unavailable') {
      setStatus('err', '频道不存在或中继台已离线');
      addLog('', '找不到该频道，请确认频道码，或让创建者开启频道', true);
      if (S.autoJoining) {
        S.autoJoining = false;
        toast('上次的频道已经不在了，请重新创建或加入', 3400);
        setTimeout(() => { if (!S.destroyed) leaveRoom(true); }, 900);
      } else {
        toast('频道不存在：' + S.code, 3200);
      }
    } else if (['network', 'server-error', 'socket-error'].includes(err.type)) {
      setStatus('err', '信令服务器连接失败');
      toast('信令服务器不可用，请在设置中更换', 3200);
    } else {
      setStatus('warn', '连接异常：' + err.type);
    }
  });
  peer.on('disconnected', () => {
    if (S.destroyed) return;
    setStatus('warn', '信令断开，重连中…');
    try { peer.reconnect(); } catch (e) {}
  });
}

function connectToHost() {
  const conn = S.peer.connect(PEER_PREFIX + S.code, { reliable: true });
  S.hostConn = conn;
  let opened = false;

  conn.on('open', () => {
    if (S.destroyed) return;
    opened = true;
    S.connected = true;
    S.autoJoining = false;
    setStatus('on', '已接入频道');
    safeSend(conn, { type: 'hello', name: S.name });
    addLog('', '已接入频道 ' + S.code, true);
    refreshPttUI();
  });
  conn.on('data', msg => { if (!S.destroyed) memberHandleMsg(msg); });
  conn.on('close', () => { if (!S.destroyed && opened) onHostLost('与中继台的连接已断开'); });
  conn.on('error', () => { if (!S.destroyed) onHostLost('连接中继台失败'); });
}

function memberHandleMsg(msg) {
  switch (msg.type) {
    case 'welcome':
      S.roster = msg.roster || [];
      S.floorHolder = msg.floor || null;
      setStatus('on', '已接入频道');
      renderRoster(); applyMicGate(); refreshPttUI();
      syncMesh(S.roster.map(r => r.id));
      break;
    case 'roster':
      S.roster = msg.roster || [];
      renderRoster();
      syncMesh(S.roster.map(r => r.id));
      break;
    case 'floor':
      S.floorHolder = msg.holder || null;
      if (msg.holder === S.selfId) S.denied = false;   // 拿到发言权，解除"被拒"状态
      applyMicGate();
      refreshPttUI();
      break;
    case 'floor-wait':
      // 本地可能还以为频道空闲（广播在路上）而开着麦 —— 立刻闭麦，避免双讲
      S.denied = true;
      applyMicGate();
      toast('频道被占用，已进入等待队列');
      break;
    case 'chat':
      addLog(msg.name || '成员', msg.text || '', false);
      break;
    case 'end':
      toast('中继台已关闭频道', 3000);
      addLog('', '中继台已关闭频道', true);
      onHostLost('频道已关闭');
      break;
  }
}

function onHostLost(reason) {
  if (S.destroyed) return;
  S.connected = false;
  setStatus('err', reason || '已断开');
  addLog('', reason || '与中继台的连接已断开', true);
  setMic(false);
  refreshPttUI();
}

/* =========================================================================
 *  诊断
 * ========================================================================= */
async function collectStats() {
  const tr = S.localStream ? S.localStream.getAudioTracks()[0] : null;
  let settings = null;
  try { settings = tr ? tr.getSettings() : null; } catch (e) {}

  const out = {
    time: nowHM(),
    version: APP_VERSION + '+' + APP_BUILD,
    role: S.role || '(未进入频道)',
    code: S.code,
    selfId: S.selfId || '-',
    signaling: S.signaling.host + ':' + S.signaling.port,
    peerOpen: !!(S.peer && !S.peer.destroyed && S.peer.open),
    connected: S.connected,
    floorHolder: S.floorHolder || '(空闲)',
    pressing: S.pressing,
    denied: S.denied,
    micGateOpen: S.micOn,
    route: S.route + (hasNativeRoute() ? '(原生)' : '(网页回退)'),
    volume: S.remoteVolume,
    soundQuality: S.soundQuality,
    quality: S.quality ? { score: S.quality.score, text: S.quality.text, detail: S.quality.detail } : null,
    beacon: { available: hasBeacon(), on: S.beaconOn, scan: S.beaconScan, visible: S.beaconVisible, seen: S.nearby.size },
    mic: S.localStream
      ? S.localStream.getAudioTracks().map(t => ({ enabled: t.enabled, muted: t.muted, state: t.readyState }))
      : null,
    // 回声消除是否真的生效（回音排查的关键一项）
    aec: settings ? {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      latency: settings.latency
    } : null,
    links: []
  };

  for (const [id, slot] of S.links) {
    const pc = slot.call && slot.call.peerConnection;
    const a = S.audioEls.get(id);
    const rec = {
      peer: id === HOST_ID ? '中继台' : id.slice(-4),
      initiated: slot.initiated,
      conn: pc ? pc.connectionState : 'n/a',
      ice: pc ? pc.iceConnectionState : 'n/a',
      audio: a ? {
        paused: a.paused,
        muted: a.muted,
        volume: a.volume,
        time: +a.currentTime.toFixed(2),
        readyState: a.readyState,
        sink: a.srcObject ? a.srcObject.getAudioTracks().map(t => ({ muted: t.muted, enabled: t.enabled, state: t.readyState })) : null
      } : '(无播放元素)'
    };
    if (pc) {
      try {
        const stats = await pc.getStats();
        const byId = new Map();
        stats.forEach(r => byId.set(r.id, r));
        stats.forEach(r => {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            const cp = byId.get(r.selectedCandidatePairId);
            if (cp) {
              const lc = byId.get(cp.localCandidateId), rc = byId.get(cp.remoteCandidateId);
              rec.path = (lc ? lc.candidateType : '?') + '↔' + (rc ? rc.candidateType : '?');
              rec.rttMs = cp.currentRoundTripTime != null ? Math.round(cp.currentRoundTripTime * 1000) : null;
              if ((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay')) rec.viaRelay = true;
            }
          }
          if (r.kind !== 'audio') return;
          if (r.type === 'inbound-rtp') {
            rec.recv = { bytes: r.bytesReceived, pkts: r.packetsReceived, lost: r.packetsLost, level: r.audioLevel, energy: r.totalAudioEnergy };
            if (r.jitter != null) rec.jitterMs = Math.round(r.jitter * 1000);
            if (r.codecId && byId.get(r.codecId)) rec.codec = byId.get(r.codecId).mimeType;
          }
          else if (r.type === 'outbound-rtp') {
            rec.sent = { bytes: r.bytesSent, pkts: r.packetsSent };
            if (r.qualityLimitationReason) rec.limit = r.qualityLimitationReason;
          }
          else if (r.type === 'media-source') rec.micLevel = r.audioLevel;
        });
      } catch (e) { rec.error = String(e); }
    }
    out.links.push(rec);
  }
  return out;
}

function verdict(st) {
  const L = [];       // 真问题
  const H = [];       // 提示（不影响可用性）
  if (!st.peerOpen) { L.push('❌ 没连上信令服务器（后面全免谈）'); return L; }
  if (st.role === 'member' && !st.connected) { L.push('❌ 连上信令但没接进频道（中继台离线？频道码错？）'); return L; }
  if (!st.mic) { L.push('❌ 没拿到麦克风流（权限被拒？）'); return L; }
  if (st.pressing && !st.micGateOpen) L.push('⚠ 正在按住但麦克风门控是关的');
  if (!st.links.length) L.push('❌ 一条语音连接都没建立');
  else {
    const anyRx = st.links.some(l => l.recv && l.recv.pkts > 0);
    const anyTx = st.links.some(l => l.sent && l.sent.pkts > 0);
    if (!anyTx) L.push('❌ 没有一路在往外发音频包（发送侧问题）');
    if (!anyRx) L.push('❌ 没有一路收到音频包（网络/NAT 问题）');
    const badConn = st.links.filter(l => l.conn !== 'connected');
    if (badConn.length) L.push('⚠ ' + badConn.length + ' 条连接未就绪：' + badConn.map(l => l.peer + '=' + l.conn).join(', '));
    const mutedSink = st.links.filter(l => l.audio && l.audio.sink && l.audio.sink.every(t => t.muted));
    if (mutedSink.length) L.push('⚠ ' + mutedSink.length + ' 路收到的音轨处于 muted（对端没在发声音）');
    const pausedSink = st.links.filter(l => l.audio && l.audio !== '(无播放元素)' && l.audio.paused);
    if (pausedSink.length) L.push('❌ ' + pausedSink.length + ' 个播放元素处于暂停状态（自动播放被拦？）');

    /* --- 回音相关（这些是提示，不是故障） --- */
    const highRtt = st.links.filter(l => l.rttMs != null && l.rttMs > 200);
    if (highRtt.length) H.push('· 端到端延迟偏高：' + highRtt.map(l => l.peer + ' ' + l.rttMs + 'ms').join('、') + '（延迟越大回音越明显）');
    const relay = st.links.filter(l => l.viaRelay);
    if (relay.length) H.push('· 走的 TURN 中继：' + relay.map(l => l.peer).join('、') + '（两台设备连同一 WiFi 可避免）');
    if (st.aec && st.aec.echoCancellation === false) H.push('· 本机回声消除(AEC)未生效，外放时回音会更重');
    if (st.route && st.route.indexOf('speaker') === 0) H.push('· 当前外放' + (st.volume >= 0.95 ? '且音量满格' : '') + '：同房间最容易听出回音，可切听筒/降音量/戴耳机');

    /* --- 音质相关 --- */
    const notOpus = st.links.filter(l => l.codec && !/opus/i.test(l.codec));
    if (notOpus.length) L.push('❌ 有链路没走 Opus：' + notOpus.map(l => l.peer + '=' + l.codec).join(', ') + '（会退化成电话音质）');
    if (st.quality && st.quality.score < 55) H.push('· 链路评分偏低 ' + st.quality.score + '/100：' + JSON.stringify(st.quality.detail));
    if (st.aec && st.aec.sampleRate && st.aec.sampleRate < 48000) H.push('· 采集采样率只有 ' + st.aec.sampleRate + 'Hz（理想 48000）');
  }
  if (!L.length) L.push('✅ 各环节看起来正常');
  return L.concat(H);
}

let dbgTimer = null;
async function refreshDebug() {
  try {
    const st = await collectStats();
    el.debugBody.textContent =
      '【结论】\n' + verdict(st).map(x => ' ' + x).join('\n') +
      '\n\n【原始数据】\n' + JSON.stringify(st, null, 2);
  } catch (e) { el.debugBody.textContent = '采集失败: ' + e; }
}
function showDebug(on) {
  clearInterval(dbgTimer);
  if (on) { el.debug.classList.remove('hidden'); refreshDebug(); dbgTimer = setInterval(refreshDebug, 2000); }
  else el.debug.classList.add('hidden');
}
el.debugClose.addEventListener('click', () => showDebug(false));
(function bindDebugLongPress() {
  let t = null;
  const start = () => { t = setTimeout(() => { t = null; showDebug(true); }, 700); };
  const cancel = () => { if (t) { clearTimeout(t); t = null; } };
  el.statusBar.addEventListener('pointerdown', start);
  el.statusBar.addEventListener('pointerup', cancel);
  el.statusBar.addEventListener('pointerleave', cancel);
  el.statusBar.addEventListener('pointercancel', cancel);
})();

/* =========================================================================
 *  事件绑定
 * ========================================================================= */
el.btnCreate.addEventListener('click', () => {
  const name = (el.nameInput.value || '').trim() || '台长';
  const typed = normalizeCode(el.codeInput.value);
  if (typed && typed.length !== CODE_LEN) {
    toast('自定义频道码要正好 ' + CODE_LEN + ' 位（字母或数字）');
    el.codeInput.focus();
    return;
  }
  saveName(name);
  S.customCode = !!typed;
  let code = typed;
  if (!code) {
    // 没指定就用上次自己开的频道码 —— 让团队的频道码固定下来，不用每次重发
    const last = loadLastChannel();
    code = (last && last.role === 'host' && last.code) ? last.code : randCode();
  }
  startHost(name, code);
});
el.btnJoin.addEventListener('click', () => {
  const name = (el.nameInput.value || '').trim() || '成员';
  const code = normalizeCode(el.codeInput.value);
  if (code.length !== CODE_LEN) { toast('请输入 ' + CODE_LEN + ' 位频道码'); el.codeInput.focus(); return; }
  saveName(name);
  S.customCode = false;
  joinChannel(name, code);
});
el.codeInput.addEventListener('input', () => {
  const v = normalizeCode(el.codeInput.value);
  if (el.codeInput.value !== v) el.codeInput.value = v;
});
el.codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.btnJoin.click(); });
el.btnDice.addEventListener('click', () => {
  el.codeInput.value = randCode();
  toast('已生成随机频道码，可以直接创建', 1800);
});

el.btnLeave.addEventListener('click', () => leaveRoom(false));
el.btnCopy.addEventListener('click', async () => {
  const text = S.code;
  try {
    await navigator.clipboard.writeText(text);
    toast('频道码已复制：' + text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('频道码已复制：' + text); }
    catch (e2) { toast('频道码：' + text, 4000); }
    document.body.removeChild(ta);
  }
});

el.btnSend.addEventListener('click', sendChat);
el.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = (el.chatInput.value || '').trim();
  if (!text || !S.connected) return;
  el.chatInput.value = '';
  if (S.role === 'host') {
    addLog(S.name, text, false);
    hostBroadcast({ type: 'chat', id: HOST_ID, name: S.name, text });
  } else {
    safeSend(S.hostConn, { type: 'chat', text });
  }
}

function bindPTT() {
  const btn = el.pttBtn;
  const down = e => { e.preventDefault(); pressPTT(); };
  const up = e => { e.preventDefault(); releasePTT(); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('touchstart', down, { passive: false });
  btn.addEventListener('touchend', up, { passive: false });
  btn.addEventListener('touchcancel', up, { passive: false });

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat && el.room.classList.contains('active') &&
        document.activeElement !== el.chatInput && document.activeElement !== el.nameInput) {
      e.preventDefault(); pressPTT();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') { e.preventDefault(); releasePTT(); }
  });
}
bindPTT();

function openSettings() {
  el.cfgHost.value = S.signaling.host;
  el.cfgPort.value = S.signaling.port;
  el.cfgPath.value = S.signaling.path;
  el.cfgSecure.checked = !!S.signaling.secure;
  el.cfgAutoRejoin.checked = !!S.autoRejoin;
  el.cfgBeaconVisible.checked = !!S.beaconVisible;
  el.cfgBeaconScan.checked = !!S.beaconScan;
  if (el.cfgLobbyOn) el.cfgLobbyOn.checked = !!S.lobby.on;
  updateLobbyUI();
  el.settings.classList.remove('hidden');
}
el.btnSettings.addEventListener('click', openSettings);
el.settings.addEventListener('click', e => { if (e.target === el.settings) el.settings.classList.add('hidden'); });
el.cfgReset.addEventListener('click', () => {
  S.signaling = { ...DEFAULT_SIGNALING };
  saveSignaling(); openSettings(); toast('已恢复默认信令服务器');
});
el.cfgSave.addEventListener('click', () => {
  S.signaling = {
    host: (el.cfgHost.value || '').trim() || DEFAULT_SIGNALING.host,
    port: parseInt(el.cfgPort.value, 10) || DEFAULT_SIGNALING.port,
    path: (el.cfgPath.value || '').trim() || DEFAULT_SIGNALING.path,
    secure: !!el.cfgSecure.checked
  };
  saveSignaling();

  const wasScan = S.beaconScan;
  S.beaconVisible = !!el.cfgBeaconVisible.checked;
  S.beaconScan = !!el.cfgBeaconScan.checked;
  saveBeaconVisible(S.beaconVisible);
  saveBeaconScan(S.beaconScan);
  if (!S.beaconScan) { S.nearby.clear(); S.nearbyAlerted = ''; }
  if (wasScan !== S.beaconScan) hideNearbyAlert();
  syncBeacon();
  renderNearby();

  if (el.cfgLobbyOn) lobbySetEnabled(!!el.cfgLobbyOn.checked);   // 公共大厅开关（跨网络发现）
  lobbyPublish();

  el.settings.classList.add('hidden');
  toast('已保存' + (S.beaconScan ? '，发现已开启' : '，发现已关闭'));
});

window.addEventListener('popstate', () => { if (el.room.classList.contains('active')) leaveRoom(false); });
window.addEventListener('beforeunload', () => { try { leaveRoom(true); } catch (e) {} });

/* =========================================================================
 *  频道记忆 UI（免去每次手输频道码）
 * ========================================================================= */
function renderMemoryUI() {
  const last = loadLastChannel();
  if (last && last.code) {
    el.reconnectCard.classList.remove('hidden');
    el.reconnectCode.textContent = last.code;
    el.reconnectRole.textContent = last.role === 'host' ? '你是中继台' : '你是成员';
  } else {
    el.reconnectCard.classList.add('hidden');
  }

  const recent = loadRecent();
  if (recent.length > 1) {
    el.recentBox.classList.remove('hidden');
    el.recentList.innerHTML = '';
    for (const r of recent) {
      const b = document.createElement('button');
      b.className = 'recent-item';
      b.textContent = r.code + (r.role === 'host' ? ' · 台' : '');
      b.addEventListener('click', () => {
        const name = (el.nameInput.value || '').trim() || loadName() || '成员';
        saveName(name);
        if (r.role === 'host') startHost(name, r.code); else joinChannel(name, r.code);
      });
      el.recentList.appendChild(b);
    }
  } else {
    el.recentBox.classList.add('hidden');
  }
}

async function rejoinLast() {
  const last = loadLastChannel();
  if (!last || !last.code) { toast('还没有可重回的频道'); return; }
  const name = (el.nameInput.value || '').trim() || loadName() || last.name || '台长';
  saveName(name);
  S.autoJoining = true;
  if (last.role === 'host') await startHost(name, last.code);
  else await joinChannel(name, last.code);
}

el.btnReconnect.addEventListener('click', () => rejoinLast());

/* =========================================================================
 *  音频：路由切换 / 音量 / 回音帮助
 * ========================================================================= */
el.btnRoute.addEventListener('click', () => {
  applyAudioRoute(S.route === 'earpiece' ? 'speaker' : 'earpiece');
});
el.volRange.addEventListener('input', () => {
  S.remoteVolume = Math.min(1, Math.max(0.2, Number(el.volRange.value) / 100));
  applyVolume();
});
el.btnEchoHelp.addEventListener('click', () => el.echoHelp.classList.remove('hidden'));
el.echoHelp.addEventListener('click', e => { if (e.target === el.echoHelp) el.echoHelp.classList.add('hidden'); });
el.btnEchoClose.addEventListener('click', () => el.echoHelp.classList.add('hidden'));
el.btnEchoFix.addEventListener('click', async () => {
  el.volRange.value = '60';
  S.remoteVolume = 0.6;
  applyVolume();
  await applyAudioRoute('earpiece', true);
  el.echoHelp.classList.add('hidden');
  toast('已切到听筒 + 音量 60%，回音应明显变小', 3400);
});
el.cfgAutoRejoin.addEventListener('change', () => {
  S.autoRejoin = el.cfgAutoRejoin.checked;
  saveAutoRejoin(S.autoRejoin);
});

/* =========================================================================
 *  音质档位 / 关于 / 附近预警
 * ========================================================================= */
el.btnQuality.addEventListener('click', () => {
  const i = QUALITY_ORDER.indexOf(S.soundQuality);
  S.soundQuality = QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length];
  saveSoundQuality(S.soundQuality);
  updateQualityChip();
  tuneSenders();
  toast('音质档位：' + QUALITY_PROFILES[S.soundQuality].hint);
});

function applyVersion() {
  [el.verText, el.verText2].forEach(n => { if (n) n.textContent = APP_VERSION; });
  [el.buildText, el.buildText2].forEach(n => { if (n) n.textContent = APP_BUILD; });
}
function openAbout() { el.about.classList.remove('hidden'); }
el.btnAbout.addEventListener('click', openAbout);
el.btnAbout2.addEventListener('click', openAbout);
el.btnAboutClose.addEventListener('click', () => el.about.classList.add('hidden'));
el.about.addEventListener('click', e => { if (e.target === el.about) el.about.classList.add('hidden'); });

el.naJoin.addEventListener('click', () => {
  const code = el.nearbyAlert.dataset.code;
  if (code) joinNearby(code);
});
el.naClose.addEventListener('click', hideNearbyAlert);
el.btnNearbyToggle.addEventListener('click', () => {
  S.nearbyCollapsed = !S.nearbyCollapsed;
  renderNearby();
});

/* 附近条目的存活检查 + 前后台切换时重建信标 */
setInterval(sweepNearby, BEACON_SWEEP_MS);
document.addEventListener('visibilitychange', () => {
  syncBeacon();
  // 系统把 App 挂起过，WebSocket 可能已断 —— 回到前台补一次
  if (!document.hidden && S.lobby.on && !S.lobby.role && !S.lobby.connecting && !S.lobby.hostPeer) lobbyStart();
});

/* 供自动化测试 / 远程排查使用 */
window.__walkie = {
  S, collectStats, verdict,
  version: APP_VERSION + '+' + APP_BUILD,
  pressPTT: () => pressPTT(),
  releasePTT: () => releasePTT(),
  showDebug: on => showDebug(!!on),
  setRoute: m => applyAudioRoute(m),
  setVolume: v => { S.remoteVolume = v; applyVolume(); if (el.volRange) el.volRange.value = String(Math.round(v * 100)); },
  rejoinLast: () => rejoinLast(),
  /* 音质 */
  sampleQuality: () => sampleQuality(),
  setSoundQuality: q => {
    if (QUALITY_PROFILES[q]) { S.soundQuality = q; saveSoundQuality(q); updateQualityChip(); tuneSenders(); }
    return S.soundQuality;
  },
  mungeOpus: sdp => mungeOpusSdp(sdp),
  /* 附近发现（浏览器里没有原生插件，可注入模拟事件） */
  nearbyItems: () => [...S.nearby.values()],
  injectBeacon: info => onBeaconSeen(info),
  joinNearby: c => joinNearby(c),
  hasBeacon: () => hasBeacon(),
  syncBeacon: () => syncBeacon(),
  /* 公共大厅（跨网络发现） */
  lobbyInfo: () => ({
    on: S.lobby.on,
    role: S.lobby.role,
    clients: S.lobby.conns.size,
    table: [...S.lobby.table.values()].map(e => ({ role: e.role, code: e.code, name: e.name, members: e.members }))
  }),
  lobbyStart: () => lobbyStart(),
  lobbyStop: () => lobbySetEnabled(false),
  lobbySetEnabled: on => lobbySetEnabled(on),
  applyLobbyList: list => applyLobbyList(list),
  lobbyPublish: () => { if (S.lobby.role === 'host') lobbyHostPublishSelf(); else if (S.lobby.role === 'client') lobbyClientHello(); }
};

/* ------------------------------ 启动 ------------------------------ */
loadSignaling();
S.autoRejoin = loadAutoRejoin();
S.route = loadRoute();
S.soundQuality = loadSoundQuality();
S.beaconVisible = loadBeaconVisible();
S.beaconScan = loadBeaconScan();
S.lobby.on = loadLobbyOn();
S.instance = loadInstance();
applyVersion();
const remembered = loadName();
if (remembered) el.nameInput.value = remembered;
const lastCh = loadLastChannel();
el.cfgAutoRejoin.checked = S.autoRejoin;
el.volRange.value = String(Math.round(S.remoteVolume * 100));
installSdpTuning();
renderMemoryUI();
updateRouteUI();
updateQualityChip();
refreshPttUI();
if (S.route === 'earpiece') applyAudioRoute('earpiece', true);
syncBeacon();
lobbyStart();          // 打开 App 就接入公共大厅 —— 不用输频道码就能看到在线频道

/* 启动即自动重回上次频道 —— 用户不用再手输频道码 */
if (S.autoRejoin && lastCh && lastCh.code) {
  setTimeout(() => {
    if (!el.home.classList.contains('active')) return;
    toast('正在重回频道 ' + lastCh.code + '…', 2200);
    rejoinLast();
  }, 600);
}

})();
