// Service worker: 状态中心 + 消息路由
// popup / content script  <->  background  <->  offscreen (WebRTC/PeerJS)

const DEFAULT_STATE = {
  room: null,          // 房间码
  role: null,          // 'host' | 'guest'
  status: 'idle',      // idle | connecting | waiting | connected | reconnecting | error
  error: null,
  members: [],
  boundTabId: null,    // 正在同步的标签页
  follow: true,        // 跟随对方切换视频
  danmaku: true,       // 聊天消息以弹幕显示
  chat: [],            // 最近 100 条聊天
  lastNavKey: null,    // 房间内最近一次“当前视频”
  lastLocalKey: null,  // 本端最近一次上报的视频
  voice: false,        // 我是否开启了语音
  muted: false,
  talkers: [],         // 正在听到声音的成员
};

// ---------- 状态（storage.session，SW 休眠重启后仍在） ----------
let queue = Promise.resolve();
async function getState() {
  const { s } = await chrome.storage.session.get('s');
  return { ...DEFAULT_STATE, ...(s || {}) };
}
function update(fn) {
  queue = queue.then(async () => {
    const s = await getState();
    const next = (await fn(s)) || s;
    await chrome.storage.session.set({ s: next });
    return next;
  }).catch((e) => { console.error(e); return getState(); });
  return queue;
}
const publicState = (s) => {
  const { chat, ...rest } = s;
  return rest;
};

// ---------- offscreen 文档（承载 P2P 连接，页面跳转也不断线） ----------
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WEB_RTC', 'USER_MEDIA'],
      justification: 'Keep the peer-to-peer watch-together connection and voice chat alive across page navigations',
    }).finally(() => { creating = null; });
  }
  await creating;
}
async function toOffscreen(msg, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// ---------- 标签页 ----------
async function toTab(tabId, msg) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, msg); } catch (_) { /* tab 尚未加载内容脚本 */ }
}
async function bindTab(tabId) {
  const s = await getState();
  if (s.boundTabId != null && s.boundTabId !== tabId) await toTab(s.boundTabId, { evt: 'unbind' });
  await update((st) => ({ ...st, boundTabId: tabId, lastLocalKey: null }));
  // 已加载内容脚本 → 直接通知；否则注入（插件安装前就打开的页面）
  try {
    await chrome.tabs.sendMessage(tabId, { evt: 'bind' });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (e) {
      console.warn('无法注入此页面', e);
    }
  }
}
async function pushChat(entry) {
  await update((s) => ({ ...s, chat: [...s.chat, entry].slice(-100) }));
}
async function broadcastState() {
  const s = await getState();
  await toTab(s.boundTabId, { evt: 'state', state: publicState(s) });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s.boundTabId === tabId) await update((st) => ({ ...st, boundTabId: null }));
});

// ---------- 消息处理 ----------
const handlers = {
  // popup
  async getState() { return publicState(await getState()); },

  async create({ name, tabId }) {
    await ensureOffscreen();
    await update((s) => ({ ...DEFAULT_STATE, follow: s.follow, danmaku: s.danmaku, role: 'host', status: 'connecting' }));
    await toOffscreen({ cmd: 'create', name });
    if (tabId != null) await bindTab(tabId);
    return publicState(await getState());
  },

  async join({ code, name, tabId }) {
    await ensureOffscreen();
    await update((s) => ({ ...DEFAULT_STATE, follow: s.follow, danmaku: s.danmaku, role: 'guest', room: code, status: 'connecting' }));
    await toOffscreen({ cmd: 'join', code, name });
    if (tabId != null) await bindTab(tabId);
    return publicState(await getState());
  },

  async leave() {
    const s = await getState();
    await toOffscreen({ cmd: 'leave' }, 1);
    try { if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument(); } catch (_) {}
    await toTab(s.boundTabId, { evt: 'unbind' });
    await update((st) => ({ ...DEFAULT_STATE, follow: st.follow, danmaku: st.danmaku }));
    return publicState(await getState());
  },

  async bind({ tabId }) {
    await bindTab(tabId);
    return publicState(await getState());
  },

  async setPref({ follow, danmaku }) {
    await update((s) => ({
      ...s,
      ...(follow !== undefined && { follow: !!follow }),
      ...(danmaku !== undefined && { danmaku: !!danmaku }),
    }));
    await broadcastState();
    return publicState(await getState());
  },

  // content script
  async hello(_, sender) {
    const s = await getState();
    const bound = s.room != null && sender.tab && sender.tab.id === s.boundTabId && sender.frameId === 0;
    return { bound, state: publicState(s), chat: bound ? s.chat : [] };
  },

  async send({ msg }, sender) {
    const s = await getState();
    if (!sender.tab || sender.tab.id !== s.boundTabId) return { ok: false };
    if (msg.t === 'chat') await pushChat({ from: msg.from, text: msg.text, self: true, ts: Date.now() });
    await toOffscreen({ cmd: 'send', msg });
    return { ok: true };
  },

  // 本端视频变了：若与房间当前视频不同，则通知对方跟随
  async localKey({ key, url }, sender) {
    const s = await getState();
    if (!sender.tab || sender.tab.id !== s.boundTabId) return;
    if (key === s.lastLocalKey) return;
    const announce = key !== s.lastNavKey;
    await update((st) => ({ ...st, lastLocalKey: key, lastNavKey: key }));
    if (announce) await toOffscreen({ cmd: 'send', msg: { t: 'nav', key, url } });
  },

  // offscreen
  async status(m) {
    await update((s) => ({
      ...s,
      status: m.status,
      error: m.error || null,
      room: m.room ?? s.room,
      members: m.members ?? s.members,
      voice: !!m.voice,
      muted: !!m.muted,
      talkers: m.talkers || [],
    }));
    await broadcastState();
  },

  // 语音（popup / 内容脚本 / 授权页都可以调用）
  async voice({ on }) {
    const s = await getState();
    if (s.room == null) return publicState(s);
    await toOffscreen({ cmd: on ? 'voiceOn' : 'voiceOff' });
    return publicState(s);
  },

  async mute({ muted }) {
    await toOffscreen({ cmd: 'mute', muted: !!muted });
  },

  // offscreen 页面不能弹出麦克风授权框，打开一个扩展页面让用户授权一次
  async voiceError({ name }) {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    } else {
      await handlers.system({ text: name === 'NotFoundError' ? '没有找到麦克风' : '无法打开麦克风：' + name });
    }
  },

  async peer({ msg }) {
    const s = await getState();
    if (msg.t === 'chat') await pushChat({ from: msg.from, text: msg.text, ts: Date.now() });
    if (msg.t === 'nav') await update((st) => ({ ...st, lastNavKey: msg.key }));
    await toTab(s.boundTabId, { evt: 'peer', msg });
  },

  async system({ text }) {
    const s = await getState();
    await pushChat({ system: true, text, ts: Date.now() });
    await toTab(s.boundTabId, { evt: 'peer', msg: { t: 'system', text } });
  },
};

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || m.to !== 'bg') return false;
  const key = m.cmd || m.evt;
  const h = handlers[key];
  if (!h) return false;
  Promise.resolve(h(m, sender)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
