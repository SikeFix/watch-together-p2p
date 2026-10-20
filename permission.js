const $ = (id) => document.getElementById(id);

async function grant() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $('title').textContent = '✓ 已授权';
    $('desc').textContent = '语音已开启，可以回到视频页面了。此页面即将关闭。';
    $('grant').hidden = true;
    await chrome.runtime.sendMessage({ to: 'bg', cmd: 'voice', on: true });
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    $('title').textContent = '没有拿到麦克风权限';
    $('desc').textContent = '请点地址栏左侧的图标，把「麦克风」改为允许，然后再点一次下面的按钮。';
  }
}

$('grant').onclick = grant;
grant();
