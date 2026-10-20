// Offscreen 文档：持有 PeerJS / WebRTC 连接。
// 数据：房主(host)与每位成员直连，房主负责转发（星型拓扑）。
// 语音：成员之间两两直连（网状），音频不经过任何服务器。
// 仅握手阶段使用 PeerJS 公共信令服务器交换 SDP。

const PREFIX = 'wtp2p-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let peer = null;
let role = null;
let room = null;
let myName = '';
let hostConn = null;            // guest -> host
const conns = new Map();        // host: peerId -> { conn, name }
let peerList = [];              // guest: 房主下发的 [{ id, name }]
let everConnected = false;
let leaving = false;
let retryTimer = null;
let curStatus = 'idle';

// 语音
let voiceOn = false;
let muted = false;
let localStream = null;
const calls = new Map();        // peerId -> { call, outgoing, at, audio, live }

const emit = (evt, data = {}) => chrome.runtime.sendMessage({ to: 'bg', evt, ...data }).catch(() => {});
const system = (text) => emit('system', { text });

function roster() {
  if (role === 'host') return [{ id: peer && peer.id, name: myName }, ...[...conns].map(([id, c]) => ({ id, name: c.name }))];
  return peerList;
}
const members = () => roster().map((p) => p.name);
const nameOf = (id) => (roster().find((p) => p.id === id) || {}).name || '朋友';
const otherIds = () => roster().map((p) => p.id).filter((id) => id && peer && id !== peer.id);

function status(s, extra = {}) {
  curStatus = s;
  emit('status', {
    status: s,
    room,
    members: members(),
    voice: voiceOn,
    muted,
    talkers: [...calls].filter(([, c]) => c.live).map(([id]) => nameOf(id)),
    ...extra,
  });
}
const refresh = () => status(curStatus);

function genCode() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}
function errText(err) {
  const map = {
    'browser-incompatible': '浏览器不支持 WebRTC',
    'peer-unavailable': '房间不存在或房主已离开',
    network: '无法连接信令服务器，请检查网络',
    'server-error': '信令服务器错误',
    'socket-error': '信令连接出错',
    'socket-closed': '信令连接已关闭',
    webrtc: 'WebRTC 连接失败（可能是网络 NAT 限制）',
  };
  return map[err.type] || err.message || String(err);
}

function destroy() {
  leaving = true;
  clearTimeout(retryTimer);
  stopVoice(false);
  try { peer && peer.destroy(); } catch (_) {}
  peer = null;
  hostConn = null;
  conns.clear();
  peerList = [];
  everConnected = false;
}

function reconnectSignalingLater() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!leaving && peer && peer.disconnected && !peer.destroyed) peer.reconnect();
  }, 3000);
}

// 收到房间内的数据消息（host / guest 共用）
function onData(d) {
  if (d.t === 'voice') {
    system(`${d.from || '朋友'} ${d.on ? '开启' : '退出'}了语音`);
    return;
  }
  emit('peer', { msg: d });
}

// ---------------- 房主 ----------------
function createRoom(name, attempt = 0) {
  destroy();
  leaving = false;
  role = 'host';
  myName = name;
  room = genCode();
  status('connecting');

  peer = new Peer(PREFIX + room, { debug: 1 });
  peer.on('open', () => status('waiting'));
  peer.on('call', onIncomingCall);
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      const n = String(conn.metadata?.name || '朋友').slice(0, 20);
      conns.set(conn.peer, { conn, name: n });
      system(`${n} 加入了房间`);
      syncMembers();
      if (voiceOn) callPeer(conn.peer);
    });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      const c = conns.get(conn.peer);
      d.from = c ? c.name : d.from;
      // 转发给其他成员
      for (const [id, other] of conns) if (id !== conn.peer && other.conn.open) other.conn.send(d);
      onData(d);
    });
    conn.on('close', () => {
      const c = conns.get(conn.peer);
      if (!c) return;
      conns.delete(conn.peer);
      closeCall(conn.peer);
      system(`${c.name} 离开了房间`);
      syncMembers();
    });
    conn.on('error', () => {});
  });
  peer.on('disconnected', () => { if (!leaving) reconnectSignalingLater(); });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && attempt < 5) return createRoom(name, attempt + 1);
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      // 已建立的 P2P 连接不受影响，只重连信令以便新成员加入
      reconnectSignalingLater();
      if (!conns.size) status('reconnecting', { error: errText(err) });
      return;
    }
    if (err.type === 'peer-unavailable') return; // 语音呼叫的对象已离开
    status('error', { error: errText(err) });
  });
}

function syncMembers() {
  const peers = roster();
  for (const { conn } of conns.values()) if (conn.open) conn.send({ t: 'members', peers });
  status(conns.size ? 'connected' : 'waiting');
}

// ---------------- 成员 ----------------
function joinRoom(code, name) {
  destroy();
  leaving = false;
  role = 'guest';
  myName = name;
  room = code;
  status('connecting');

  peer = new Peer({ debug: 1 });
  peer.on('open', connectHost);
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => { if (!leaving) reconnectSignalingLater(); });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      if (hostConn && hostConn.open) return; // 语音呼叫的对象已离开
      if (everConnected) { status('reconnecting'); rejoinLater(); }
      else status('error', { error: errText(err) });
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      reconnectSignalingLater();
      if (!hostConn || !hostConn.open) status('reconnecting', { error: errText(err) });
      return;
    }
    status('error', { error: errText(err) });
  });
}

function connectHost() {
  if (leaving || !peer) return;
  const c = peer.connect(PREFIX + room, { reliable: true, metadata: { name: myName } });
  hostConn = c;
  c.on('open', () => {
    if (everConnected) system('已重新连上房主');
    everConnected = true;
    status('connected');
  });
  c.on('data', (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'members') {
      const ids = new Set(d.peers.map((p) => p.id));
      for (const id of [...calls.keys()]) if (!ids.has(id)) closeCall(id);
      peerList = d.peers;
      if (voiceOn) for (const id of otherIds()) if (!calls.has(id)) callPeer(id);
      status('connected');
      return;
    }
    onData(d);
  });
  c.on('close', () => {
    if (leaving || hostConn !== c) return;
    hostConn = null;
    system('与房主的连接断开，正在重连…');
    status('reconnecting');
    rejoinLater();
  });
  c.on('error', () => {});
}

function rejoinLater() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (leaving || !peer) return;
    if (peer.disconnected) { peer.reconnect(); setTimeout(connectHost, 1500); }
    else connectHost();
  }, 3000);
}

// ---------------- 发送 ----------------
function send(msg) {
  msg.from = myName;
  if (role === 'host') {
    for (const { conn } of conns.values()) if (conn.open) conn.send(msg);
  } else if (hostConn && hostConn.open) {
    hostConn.send(msg);
  }
}

// ---------------- 语音 ----------------
// 没开麦的人也会自动接听（只听不说），所以一方开麦另一方就能听到。
async function startVoice() {
  if (voiceOn || !peer) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    emit('voiceError', { name: e.name });
    return;
  }
  voiceOn = true;
  muted = false;
  // 之前“只听”的通话没有我的音轨，挂断后带着麦克风重新呼叫
  for (const id of [...calls.keys()]) closeCall(id);
  for (const id of otherIds()) callPeer(id);
  send({ t: 'voice', on: true });
  refresh();
}

function stopVoice(announce = true) {
  if (!voiceOn && !calls.size) return;
  const was = voiceOn;
  voiceOn = false;
  muted = false;
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  for (const id of [...calls.keys()]) closeCall(id);
  if (announce && was) send({ t: 'voice', on: false });
  if (announce) refresh();
}

function setMuted(m) {
  muted = !!m;
  if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  refresh();
}

function callPeer(id) {
  if (!peer || !localStream) return;
  setupCall(peer.call(id, localStream), true);
}

function onIncomingCall(call) {
  const old = calls.get(call.peer);
  // 双方同时呼叫：保留 ID 较小一方发起的那通
  if (old && old.outgoing && Date.now() - old.at < 3000 && peer.id < call.peer) {
    call.close();
    return;
  }
  if (old) closeCall(call.peer);
  call.answer(voiceOn ? localStream : undefined);
  setupCall(call, false);
}

function setupCall(call, outgoing) {
  const entry = { call, outgoing, at: Date.now(), audio: null, live: false };
  calls.set(call.peer, entry);
  call.on('stream', (stream) => {
    if (calls.get(call.peer) !== entry) return;
    if (!entry.audio) {
      entry.audio = new Audio();
      entry.audio.autoplay = true;
    }
    entry.audio.srcObject = stream;
    entry.audio.play().catch(() => {});
    entry.live = stream.getAudioTracks().length > 0;
    refresh();
  });
  call.on('close', () => {
    if (calls.get(call.peer) !== entry) return;
    closeCall(call.peer);
    refresh();
  });
  call.on('error', () => {});
}

function closeCall(id) {
  const e = calls.get(id);
  if (!e) return;
  calls.delete(id);
  if (e.audio) { e.audio.pause(); e.audio.srcObject = null; }
  try { e.call.close(); } catch (_) {}
}

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (!m || m.to !== 'offscreen') return false;
  switch (m.cmd) {
    case 'create': createRoom(m.name); break;
    case 'join': joinRoom(m.code, m.name); break;
    case 'send': send(m.msg); break;
    case 'voiceOn': startVoice(); break;
    case 'voiceOff': stopVoice(); break;
    case 'mute': setMuted(m.muted); break;
    case 'leave': destroy(); role = null; room = null; break;
  }
  sendResponse({ ok: true });
  return false;
});
