// Offscreen 文档：持有 PeerJS / WebRTC 连接。
// 房主(host)与每位成员直连，房主负责转发（星型拓扑），数据不经过任何自建服务器。
// 仅握手阶段使用 PeerJS 公共信令服务器交换 SDP。

const PREFIX = 'wtp2p-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let peer = null;
let role = null;
let room = null;
let myName = '';
let hostConn = null;            // guest -> host
const conns = new Map();        // host: peerId -> { conn, name }
let guestMembers = [];
let everConnected = false;
let leaving = false;
let retryTimer = null;

const emit = (evt, data = {}) => chrome.runtime.sendMessage({ to: 'bg', evt, ...data }).catch(() => {});
const system = (text) => emit('system', { text });

function members() {
  if (role === 'host') return [myName, ...[...conns.values()].map((c) => c.name)];
  return guestMembers;
}
function status(s, extra = {}) {
  emit('status', { status: s, room, members: members(), ...extra });
}
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
  try { peer && peer.destroy(); } catch (_) {}
  peer = null;
  hostConn = null;
  conns.clear();
  guestMembers = [];
  everConnected = false;
}

function reconnectSignalingLater() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!leaving && peer && peer.disconnected && !peer.destroyed) peer.reconnect();
  }, 3000);
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
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      const n = String(conn.metadata?.name || '朋友').slice(0, 20);
      conns.set(conn.peer, { conn, name: n });
      system(`${n} 加入了房间`);
      syncMembers();
    });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      const c = conns.get(conn.peer);
      d.from = c ? c.name : d.from;
      // 转发给其他成员
      for (const [id, other] of conns) if (id !== conn.peer && other.conn.open) other.conn.send(d);
      emit('peer', { msg: d });
    });
    conn.on('close', () => {
      const c = conns.get(conn.peer);
      if (!c) return;
      conns.delete(conn.peer);
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
    status('error', { error: errText(err) });
  });
}

function syncMembers() {
  const list = members();
  for (const { conn } of conns.values()) if (conn.open) conn.send({ t: 'members', list });
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
  peer.on('disconnected', () => { if (!leaving) reconnectSignalingLater(); });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
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
    if (d.t === 'members') { guestMembers = d.list; status('connected'); return; }
    emit('peer', { msg: d });
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

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (!m || m.to !== 'offscreen') return false;
  switch (m.cmd) {
    case 'create': createRoom(m.name); break;
    case 'join': joinRoom(m.code, m.name); break;
    case 'send': send(m.msg); break;
    case 'leave': destroy(); role = null; room = null; break;
  }
  sendResponse({ ok: true });
  return false;
});
