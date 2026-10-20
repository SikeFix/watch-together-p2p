// 内容脚本：找到页面主视频，同步播放状态，显示聊天面板和弹幕。
(() => {
  if (window.__wtp2pLoaded || window.top !== window) return;
  window.__wtp2pLoaded = true;

  let bound = false;
  let state = {};
  let video = null;
  let applyingUntil = 0;     // 正在应用远端操作，期间忽略本地事件
  let lastLocalAction = 0;   // 本地用户最近一次操作
  let lastRemoteAction = 0;
  let pendingKey = null;
  let pendingSince = 0;
  let tickTimer = null;
  let loopTimer = null;
  let ui = null;
  let uiHost = null;

  // 防止在聊天框打字时触发网站快捷键（空格暂停、F 全屏等）。
  // document_start 时注册，保证早于页面自己的捕获监听器。
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (e) => {
      if (uiHost && e.composedPath().includes(uiHost)) e.stopImmediatePropagation();
    }, true);
  }

  const rt = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg }).catch(() => null);
  const send = (msg) => rt({ cmd: 'send', msg });

  // ---------------- 站点适配：当前“视频身份” ----------------
  function douyinActiveVid() {
    const el = document.querySelector('[data-e2e="feed-active-video"]');
    const v = el && el.getAttribute('data-e2e-vid');
    if (v) return v;
    const u = new URL(location.href);
    return u.searchParams.get('modal_id') || (u.pathname.match(/\/video\/(\d+)/) || [])[1] || null;
  }
  function currentKey() {
    const u = new URL(location.href);
    const h = u.hostname;
    let m;
    if (h.endsWith('douyin.com')) {
      const vid = douyinActiveVid();
      if (vid) return { key: 'dy:' + vid, url: 'https://www.douyin.com/video/' + vid };
    }
    if (h.endsWith('bilibili.com')) {
      if ((m = u.pathname.match(/\/video\/(BV\w+|av\d+)/i))) {
        const p = u.searchParams.get('p') || '1';
        return { key: `bili:${m[1]}:${p}`, url: `https://www.bilibili.com/video/${m[1]}/${p !== '1' ? '?p=' + p : ''}` };
      }
      if ((m = u.pathname.match(/\/bangumi\/play\/(ep\d+|ss\d+)/))) {
        return { key: 'bgm:' + m[1], url: 'https://www.bilibili.com/bangumi/play/' + m[1] };
      }
    }
    if (h.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return { key: 'yt:' + v, url: 'https://www.youtube.com/watch?v=' + v };
      if ((m = u.pathname.match(/\/shorts\/([\w-]+)/))) return { key: 'yt:' + m[1], url: 'https://www.youtube.com/shorts/' + m[1] };
    }
    u.hash = '';
    return { key: u.href, url: u.href };
  }

  // ---------------- 找主视频 ----------------
  function findVideo() {
    if (location.hostname.endsWith('douyin.com')) {
      const a = document.querySelector('[data-e2e="feed-active-video"] video');
      if (a) return a;
    }
    let best = null;
    let bestScore = 0;
    for (const v of document.querySelectorAll('video, bwp-video')) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const hgt = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const score = w * hgt * (v.paused ? 1 : 2);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  const EVENTS = ['play', 'pause', 'seeked', 'ratechange'];
  function onLocalEvent(e) {
    if (!bound || !video || Date.now() < applyingUntil) return;
    lastLocalAction = Date.now();
    send(snapshot(e.type));
  }
  function snapshot(action) {
    return {
      t: 'state',
      action,
      time: video.currentTime,
      paused: video.paused,
      rate: video.playbackRate,
      key: currentKey().key,
    };
  }
  function attach(v) {
    if (video) EVENTS.forEach((ev) => video.removeEventListener(ev, onLocalEvent));
    video = v;
    if (video) EVENTS.forEach((ev) => video.addEventListener(ev, onLocalEvent));
  }

  async function applyState(m) {
    if (!video) return;
    if (m.key && m.key !== currentKey().key) return; // 不是同一个视频
    const isTick = m.action === 'tick';
    if (isTick && (Date.now() - lastLocalAction < 2500 || Date.now() - lastRemoteAction < 1500)) return;
    if (!isTick) lastRemoteAction = Date.now();

    applyingUntil = Date.now() + 800;
    if (m.rate && video.playbackRate !== m.rate) video.playbackRate = m.rate;
    const drift = Math.abs(video.currentTime - m.time);
    if (drift > (isTick ? 2 : 0.4)) video.currentTime = m.time;
    if (m.paused && !video.paused) video.pause();
    else if (!m.paused && video.paused) {
      try { await video.play(); }
      catch (_) { ui && ui.line({ system: true, text: '浏览器拦截了自动播放，请点一下视频' }); }
    }
    applyingUntil = Date.now() + 500;
  }

  // ---------------- 主循环 ----------------
  function loop() {
    if (!bound) return;
    const v = findVideo();
    if (v !== video) attach(v);
    const k = currentKey();
    if (k.key !== pendingKey) { pendingKey = k.key; pendingSince = Date.now(); return; }
    // 视频身份稳定 1.2s 且页面上有视频，才上报（避免页面加载中的抖动）
    if (video && Date.now() - pendingSince > 1200) rt({ cmd: 'localKey', key: k.key, url: k.url });
  }
  function tick() {
    if (!bound || state.role !== 'host' || state.status !== 'connected' || !video) return;
    send(snapshot('tick'));
  }

  function onPeer(msg) {
    switch (msg.t) {
      case 'state': applyState(msg); break;
      case 'nav':
        state.lastNavKey = msg.key;
        if (state.follow && msg.key !== currentKey().key) {
          ui && ui.line({ system: true, text: `${msg.from || '对方'} 切换了视频，正在跟随…` });
          setTimeout(() => { location.href = msg.url; }, 300);
        }
        break;
      case 'chat':
        ui && ui.line({ from: msg.from, text: msg.text });
        if (state.danmaku) ui && ui.danmaku(msg.text);
        break;
      case 'system':
        ui && ui.line({ system: true, text: msg.text });
        break;
    }
  }

  async function activate() {
    const r = await rt({ cmd: 'hello' });
    if (!r || !r.bound) return deactivate();
    state = r.state;
    if (!bound) {
      bound = true;
      pendingKey = null;
      ui = ui || createUI();
      ui.show();
      ui.clear();
      r.chat.forEach((c) => ui.line(c));
      loopTimer = setInterval(loop, 500);
      tickTimer = setInterval(tick, 3000);
    }
    ui.render(state);
  }
  function deactivate() {
    bound = false;
    clearInterval(loopTimer);
    clearInterval(tickTimer);
    attach(null);
    ui && ui.hide();
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.evt === 'bind') activate();
    else if (m.evt === 'unbind') deactivate();
    else if (m.evt === 'state') { state = m.state; ui && ui.render(state); }
    else if (m.evt === 'peer' && bound) onPeer(m.msg);
  });

  // ---------------- UI（Shadow DOM，不受页面样式影响） ----------------
  function createUI() {
    const host = document.createElement('wtp2p-root');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    uiHost = host;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
:host{--bg:rgba(24,24,28,.92);--fg:#f2f2f5;--muted:#9a9aa6;--acc:#fb7299;--acc2:#25f4ee;--line:rgba(255,255,255,.1)}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.panel{position:fixed;right:16px;bottom:16px;width:300px;height:400px;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.4);pointer-events:auto;backdrop-filter:blur(10px);font-size:13px;overflow:hidden}
.panel.min{height:auto}
.panel.min .log,.panel.min .tools,.panel.min form{display:none}
.vc{display:flex;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
.vc[hidden]{display:none}
.vc .who{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc button,.tools button.voice{all:unset;cursor:pointer;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.08);color:var(--fg)}
.tools button.voice.on{background:#3ddc84;color:#111}
.vc button.muted{background:#ff4d4f;color:#fff}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:move;user-select:none}
.dot{width:8px;height:8px;border-radius:50%;background:#888;flex:none}
.dot.connected{background:#3ddc84}.dot.waiting,.dot.connecting,.dot.reconnecting{background:#f5b301}.dot.error{background:#ff4d4f}
.title{font-weight:600;letter-spacing:.5px}
.sub{color:var(--muted);font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hd button{all:unset;cursor:pointer;color:var(--muted);padding:0 4px;font-size:16px;line-height:1}
.hd button:hover{color:var(--fg)}
.log{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.msg{line-height:1.45;word-break:break-word}
.msg b{color:var(--acc2);font-weight:500;margin-right:6px}
.msg.self b{color:var(--acc)}
.msg.sys{color:var(--muted);font-size:12px;text-align:center}
.tools{display:flex;flex-wrap:wrap;gap:6px 10px;padding:6px 12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;align-items:center}
.tools button{all:unset;cursor:pointer;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.08);color:var(--fg)}
.tools button:hover{background:rgba(255,255,255,.16)}
.tools label{display:flex;align-items:center;gap:3px;cursor:pointer}
form{display:flex;gap:6px;padding:8px 10px 10px}
input[type=text]{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid transparent;border-radius:8px;color:var(--fg);padding:7px 10px;outline:none;font-size:13px}
input[type=text]:focus{border-color:var(--acc)}
form button{all:unset;cursor:pointer;background:var(--acc);color:#fff;border-radius:8px;padding:0 12px;font-weight:600}
.dm{position:fixed;white-space:nowrap;font-size:22px;font-weight:700;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;will-change:transform;animation:fly linear forwards}
@keyframes fly{from{transform:translateX(0)}to{transform:translateX(var(--dx))}}
</style>
<div class="panel">
  <div class="hd"><span class="dot"></span><span class="title">一起看</span><span class="sub"></span><button class="minbtn" title="收起">–</button></div>
  <div class="vc" hidden><span class="who"></span><button class="mute">🎙 静音</button></div>
  <div class="log"></div>
  <div class="tools">
    <button class="voice" title="开启语音通话（P2P 直连，建议戴耳机）">🎙 语音</button>
    <button class="pull" title="把我当前的进度/播放状态推给所有人">⇆ 让大家同步到我</button>
    <label><input type="checkbox" class="follow">跟随切换视频</label>
    <label><input type="checkbox" class="danmaku">弹幕</label>
  </div>
  <form><input type="text" maxlength="300" placeholder="说点什么，回车发送"><button>发送</button></form>
</div>`;
    const $ = (s) => root.querySelector(s);
    const panel = $('.panel');
    const log = $('.log');
    const input = $('input[type=text]');
    let lane = 0;

    // 拖动
    const hd = $('.hd');
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      hd.setPointerCapture(e.pointerId);
      const move = (ev) => {
        panel.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - ox)) + 'px';
        panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - oy)) + 'px';
        panel.style.right = panel.style.bottom = 'auto';
      };
      const up = () => { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); };
      hd.addEventListener('pointermove', move);
      hd.addEventListener('pointerup', up);
    });
    $('.minbtn').addEventListener('click', () => {
      panel.classList.toggle('min');
      $('.minbtn').textContent = panel.classList.contains('min') ? '+' : '–';
    });
    $('.pull').addEventListener('click', () => {
      if (!video) return api.line({ system: true, text: '当前页面没有找到视频' });
      lastLocalAction = Date.now();
      send(snapshot('pull'));
      api.line({ system: true, text: '已把你的进度推送给大家' });
    });
    $('.voice').addEventListener('click', () => rt({ cmd: 'voice', on: !state.voice }));
    $('.mute').addEventListener('click', () => rt({ cmd: 'mute', muted: !state.muted }));
    $('.follow').addEventListener('change', (e) => rt({ cmd: 'setPref', follow: e.target.checked }));
    $('.danmaku').addEventListener('change', (e) => rt({ cmd: 'setPref', danmaku: e.target.checked }));
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send({ t: 'chat', text });
      api.line({ from: '我', text, self: true });
      if (state.danmaku) api.danmaku(text, true);
    });

    // 全屏时把面板/弹幕挂进全屏元素里，否则看不到
    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
    });

    const STATUS = {
      idle: '未连接', connecting: '连接中…', waiting: '等待朋友加入',
      connected: '已连接', reconnecting: '重连中…', error: '出错',
    };

    const api = {
      show() { if (!host.isConnected) (document.documentElement || document).appendChild(host); host.style.display = ''; },
      hide() { host.style.display = 'none'; },
      clear() { log.textContent = ''; },
      render(s) {
        $('.dot').className = 'dot ' + s.status;
        const who = (s.members || []).length ? ` · ${(s.members || []).length}人` : '';
        $('.sub').textContent = `${s.room || ''} · ${s.error || STATUS[s.status] || ''}${who}`;
        $('.sub').title = (s.members || []).join('、');
        $('.follow').checked = !!s.follow;
        $('.danmaku').checked = !!s.danmaku;
        const talkers = s.talkers || [];
        $('.voice').classList.toggle('on', !!s.voice);
        $('.voice').textContent = s.voice ? '📴 退出语音' : '🎙 语音';
        $('.vc').hidden = !s.voice && !talkers.length;
        $('.who').textContent = talkers.length ? '🔊 ' + talkers.join('、') + (s.voice ? '' : '（你只在听）') : (s.voice ? '语音已开启，等待朋友…' : '');
        $('.mute').hidden = !s.voice;
        $('.mute').classList.toggle('muted', !!s.muted);
        $('.mute').textContent = s.muted ? '🔇 已静音' : '🎙 静音';
      },
      line(c) {
        const d = document.createElement('div');
        if (c.system) { d.className = 'msg sys'; d.textContent = c.text; }
        else {
          d.className = 'msg' + (c.self ? ' self' : '');
          const b = document.createElement('b');
          b.textContent = c.self ? '我' : (c.from || '朋友');
          d.append(b, document.createTextNode(c.text));
        }
        log.appendChild(d);
        while (log.children.length > 200) log.firstChild.remove();
        log.scrollTop = log.scrollHeight;
      },
      danmaku(text, self) {
        if (!video) return;
        const r = video.getBoundingClientRect();
        if (r.width < 100 || r.height < 60) return;
        const s = document.createElement('div');
        s.className = 'dm';
        s.textContent = text;
        if (self) s.style.color = '#ffd1df';
        const lanes = Math.max(1, Math.floor((r.height * 0.4) / 32));
        s.style.top = r.top + 10 + (lane++ % lanes) * 32 + 'px';
        s.style.left = r.right + 'px';
        root.appendChild(s);
        const dx = -(r.width + s.offsetWidth + 20);
        s.style.setProperty('--dx', dx + 'px');
        s.style.animationDuration = Math.min(12, 6 + text.length * 0.08) + 's';
        s.addEventListener('animationend', () => s.remove());
      },
    };
    return api;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', activate, { once: true });
  else activate();
})();
