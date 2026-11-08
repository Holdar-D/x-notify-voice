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
  $('phrase').value = settings.phrase || '';
  $('interval').value = String(settings.intervalMin || 1);
  const lines = [
    '登录状态：' + (state.loggedIn === false ? '未登录 X' : state.loggedIn ? '已登录' : '未知'),
    '上次检查：' + fmt(state.lastCheckAt),
    '上次提醒：' + fmt(state.lastAlertAt),
    '通知：' + (state.lastNotifCount ?? '—') + ' 条，最新 ' + (state.lastNotifLatest || '—'),
    '私信：' + (state.lastDmCount ?? '—') + ' 个会话，最新 ' + (state.lastDmLatest || '—'),
  ];
  if (state.lastNotifError) lines.push('注意：' + state.lastNotifError);
  if (state.lastDmError) lines.push('注意：' + state.lastDmError);
  $('status').textContent = lines.join('\n');
}

$('save').onclick = async () => {
  const settings = {
    dmEnabled: $('dm').checked,
    notifEnabled: $('notif').checked,
    phrase: $('phrase').value.trim() || '您有新的消息，请及时回复',
    intervalMin: parseInt($('interval').value, 10) || 1,
  };
  await chrome.runtime.sendMessage({ type: 'saveSettings', settings });
  $('status').textContent = '已保存。';
  load();
};

$('test').onclick = async () => {
  await chrome.runtime.sendMessage({
    type: 'testVoice',
    phrase: $('phrase').value.trim(),
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
