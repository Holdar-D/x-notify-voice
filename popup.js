const $ = (id) => document.getElementById(id);

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

async function load() {
  const { settings, state } = await chrome.runtime.sendMessage({
    type: 'getStatus',
  });
  $('dm').checked = !!settings.dmEnabled;
  $('notif').checked = !!settings.notifEnabled;
  $('reminders').checked = settings.remindersEnabled !== false;
  $('senderName').checked = settings.speakSenderName !== false;
  $('repeat').checked = settings.repeatEnabled !== false;
  chrome.runtime.sendMessage({ type: 'clearBadge' }).catch(() => {});
  const types = settings.notifTypes || {};
  $('t-like').checked = types.like !== false;
  $('t-reply').checked = types.reply !== false;
  $('t-mention').checked = types.mention !== false;
  $('t-follow').checked = types.follow !== false;
  $('t-repost').checked = types.repost !== false;
  $('phrase').value = settings.phrase || '';
  const PRESETS = ['1', '2', '5', '10', '30', '60'];
  const iv = String(settings.intervalMin || 1);
  if (PRESETS.includes(iv)) {
    $('interval').value = iv;
    $('intervalCustom').style.display = 'none';
  } else {
    $('interval').value = 'custom';
    $('intervalCustom').value = iv;
    $('intervalCustom').style.display = '';
  }
  $('style').value = settings.voiceStyle || 'normal';
  const vol = Math.round((settings.volume ?? 1) * 100);
  $('volume').value = String(vol);
  $('volVal').textContent = vol + '%';
  const lines = [
    '登录状态：' + (state.loggedIn === false ? '未登录 X' : state.loggedIn ? '已登录' : '未知'),
    '上次检查：' + fmt(state.lastCheckAt),
    '上次提醒：' + fmt(state.lastAlertAt),
    '通知：' + (state.lastNotifCount ?? '—') + ' 条，最新 ' + (state.lastNotifLatest || '—') + (state.lastNotifKind ? '（' + state.lastNotifKind + '）' : '') + (state.notifFallback ? '【备用接口】' : ''),
    '私信：' + (state.lastDmCount ?? '—') + ' 个会话，最新 ' + (state.lastDmLatest || '—') + (state.lastDmSender ? '（' + state.lastDmSender + '）' : ''),
  ];
  if (state.lastNotifError) lines.push('注意：' + state.lastNotifError);
  if (state.lastDmError) lines.push('注意：' + state.lastDmError);
  $('status').textContent = lines.join('\n');
}

$('interval').onchange = () => {
  $('intervalCustom').style.display =
    $('interval').value === 'custom' ? '' : 'none';
};

$('volume').oninput = () => {
  $('volVal').textContent = $('volume').value + '%';
};

$('save').onclick = async () => {
  let intervalMin;
  if ($('interval').value === 'custom') {
    const custom = parseInt($('intervalCustom').value, 10);
    intervalMin = isNaN(custom)
      ? 60
      : Math.min(1440, Math.max(1, custom));
  } else {
    intervalMin = parseInt($('interval').value, 10) || 1;
  }
  const settings = {
    dmEnabled: $('dm').checked,
    notifEnabled: $('notif').checked,
    remindersEnabled: $('reminders').checked,
    speakSenderName: $('senderName').checked,
    repeatEnabled: $('repeat').checked,
    notifTypes: {
      like: $('t-like').checked,
      reply: $('t-reply').checked,
      mention: $('t-mention').checked,
      follow: $('t-follow').checked,
      repost: $('t-repost').checked,
    },
    phrase: $('phrase').value.trim() || '您有新的消息，请及时回复',
    intervalMin,
    voiceStyle: $('style').value || 'normal',
    volume: (parseInt($('volume').value, 10) || 0) / 100,
  };
  await chrome.runtime.sendMessage({ type: 'saveSettings', settings });
  $('status').textContent = '已保存。';
  load();
};

$('test').onclick = async () => {
  await chrome.runtime.sendMessage({
    type: 'testVoice',
    phrase: $('phrase').value.trim(),
    voiceStyle: $('style').value || 'normal',
  });
};

$('check').onclick = async () => {
  $('status').textContent = '检查中…';
  await chrome.runtime.sendMessage({ type: 'checkNow' });
  setTimeout(load, 1500);
};

$('clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clearBaseline' });
  $('status').textContent = '已清除基线，下一轮检查会报当前最新消息。';
  setTimeout(load, 1500);
};

load();
