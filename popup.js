const $ = (id) => document.getElementById(id);
const bg = (cmd, data = {}) => chrome.runtime.sendMessage({ to: 'bg', cmd, ...data });

const STATUS = {
  idle: '未连接', connecting: '正在连接信令服务器…', waiting: '房间已创建，等待朋友加入',
  connected: '已连接', reconnecting: '连接中断，正在重连…', error: '出错了',
};
const ADJ = ['快乐', '摸鱼', '熬夜', '干饭', '躺平', '追剧', '刷屏', '佛系'];
const NOUN = ['小猫', '柴犬', '水豚', '企鹅', '熊猫', '海獭', '仓鼠', '狐狸'];

let activeTab = null;

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { name } = await chrome.storage.local.get('name');
  $('name').value = name || ADJ[Math.random() * 8 | 0] + '的' + NOUN[Math.random() * 8 | 0];
  render(await bg('getState'));
  setInterval(async () => render(await bg('getState')), 700);
}

function myName() {
  const n = $('name').value.trim().slice(0, 20) || '朋友';
  chrome.storage.local.set({ name: n });
  return n;
}

function render(s) {
  if (!s) return;
  const inRoom = s.room != null || (s.role && s.status !== 'idle');
  $('lobby').hidden = inRoom;
  $('room').hidden = !inRoom;
  $('err').hidden = !s.error;
  $('err').textContent = s.error || '';
  if (!inRoom) return;
  $('roomCode').textContent = s.room || '------';
  $('dot').className = 'dot ' + s.status;
  $('statusText').textContent = STATUS[s.status] || s.status;
  $('members').textContent = s.members && s.members.length ? '在线：' + s.members.join('、') : '';
  const here = activeTab && s.boundTabId === activeTab.id;
  $('bind').hidden = here;
  $('boundHint').textContent = here ? '✓ 当前标签页正在同步' : (s.boundTabId != null ? '正在同步另一个标签页' : '还没有选择同步的标签页');
}

$('create').onclick = async () => render(await bg('create', { name: myName(), tabId: activeTab?.id }));
$('join').onclick = async () => {
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    $('err').hidden = false;
    $('err').textContent = '请输入 6 位房间码';
    return;
  }
  render(await bg('join', { code, name: myName(), tabId: activeTab?.id }));
};
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('leave').onclick = async () => render(await bg('leave'));
$('bind').onclick = async () => render(await bg('bind', { tabId: activeTab.id }));
$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('roomCode').textContent);
  $('copy').textContent = '已复制';
  setTimeout(() => { $('copy').textContent = '复制'; }, 1200);
};

init();
