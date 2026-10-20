const $ = (id) => document.getElementById(id);
const kind = new URLSearchParams(location.search).get('kind') === 'cam' ? 'cam' : 'voice';
const label = kind === 'cam' ? '摄像头' : '麦克风';

document.title = `允许使用${label}`;
$('title').textContent = `允许「一起看」使用${label}`;
$('desc').textContent = kind === 'cam'
  ? '视频通话需要摄像头权限。只需授权一次，画面通过 P2P 直接发给房间里的朋友。'
  : '语音通话需要麦克风权限。只需授权一次，声音通过 P2P 直接发给房间里的朋友。';
$('grant').textContent = `允许使用${label}`;

async function grant() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'cam' ? { video: true } : { audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $('title').textContent = '✓ 已授权';
    $('desc').textContent = `${label}已开启，可以回到视频页面了。此页面即将关闭。`;
    $('grant').hidden = true;
    await chrome.runtime.sendMessage({ to: 'bg', cmd: kind, on: true });
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    $('title').textContent = `没有拿到${label}权限`;
    $('desc').textContent = `请点地址栏左侧的图标，把「${label}」改为允许，然后再点一次下面的按钮。`;
  }
}

$('grant').onclick = grant;
grant();
