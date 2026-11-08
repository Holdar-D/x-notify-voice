// X 新消息语音提醒 — 后台 service worker v1.0.1
// 原理：在用户自己的浏览器里，用已登录的 X 会话（cookie + ct0）
// 每分钟轮询一次 X 的通知和私信接口，有新内容就用中文语音播报。
// 不经过任何第三方服务器，不保存账号密码。
// v1.0.1：通知取列表里最大的 id（不怕接口正序倒序）；
// 每次检查把查到的数据写进 state，弹窗里能看到；
// 加清除基线：下一轮把当前最新消息当新消息报出来。

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const DEFAULTS = {
  dmEnabled: true, // 私信提醒
  notifEnabled: true, // 通知提醒（@、回复等）
  phrase: '您有新的消息啦，请及时回复',
  intervalMin: 1, // 轮询间隔（分钟）
};

async function getSettings() {
  const s = await chrome.storage.local.get(['settings', 'state']);
  return {
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    state: s.state || {},
  };
}

async function saveState(patch) {
  const { state } = await getSettings();
  await chrome.storage.local.set({ state: { ...state, ...patch } });
}

// X 的 id / 时间戳是数字字符串，按长度再按字典序取最大
function maxNumStr(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a > b ? a : b;
}

// 读 X 登录态的 csrf token（cookie ct0）
async function getCsrf() {
  const c = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
  return c ? c.value : null;
}

async function xFetch(path, csrf) {
  const res = await fetch('https://x.com' + path, {
    credentials: 'include',
    headers: {
      authorization: 'Bearer ' + BEARER,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// 通知：取列表里最大的 id，和上次比对
async function checkNotifs(csrf, state) {
  const data = await xFetch('/i/api/2/notifications/all.json?count=20', csrf);
  const list = Array.isArray(data.notifications) ? data.notifications : [];
  let latest = '';
  for (const n of list) {
    const id = String(n.id ?? n.sort_index ?? '');
    if (id) latest = maxNumStr(latest, id);
  }
  await saveState({ lastNotifCount: list.length, lastNotifLatest: latest || '—' });
  if (!latest) {
    if (!state.notifBaseline) await saveState({ notifBaseline: '0' });
    return false;
  }
  if (!state.notifBaseline) {
    await saveState({ notifBaseline: latest });
    return false; // 首次只记基线，不报旧消息
  }
  if (latest !== state.notifBaseline) {
    await saveState({ notifBaseline: latest });
    return true;
  }
  return false;
}

// 私信：取所有会话里最大的 sort_timestamp，和上次比对
async function checkDMs(csrf, state) {
  const data = await xFetch('/i/api/1.1/dm/inbox_initial_state.json', csrf);
  const convs =
    data.inbox_initial_state?.conversations || data.conversations || {};
  let maxTs = '';
  for (const c of Object.values(convs)) {
    const ts = String(c.sort_timestamp || '');
    if (ts) maxTs = maxNumStr(maxTs, ts);
  }
  await saveState({ lastDmCount: Object.keys(convs).length, lastDmLatest: maxTs || '—' });
  if (!maxTs) {
    if (!state.dmBaseline) await saveState({ dmBaseline: '0' });
    return false;
  }
  if (!state.dmBaseline) {
    await saveState({ dmBaseline: maxTs });
    return false; // 首次只记基线，不报旧消息
  }
  if (maxTs !== state.dmBaseline) {
    await saveState({ dmBaseline: maxTs });
    return true;
  }
  return false;
}

async function alert(settings) {
  await saveState({ lastAlertAt: Date.now() });
  try {
    await chrome.tts.speak(settings.phrase, {
      lang: 'zh-CN',
      rate: 1.0,
      enqueue: false,
    });
  } catch (e) {
    // 语音失败也不影响下面的横幅通知
  }
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'X 新消息',
    message: settings.phrase,
  });
}

async function check() {
  const { settings, state } = await getSettings();
  const csrf = await getCsrf();
  if (!csrf) {
    await saveState({
      lastCheckAt: Date.now(),
      loggedIn: false,
      lastError: '未登录 X（请先在 Edge 里登录 x.com）',
    });
    return;
  }
  let isNew = false;
  let notifErr = '';
  let dmErr = '';
  if (settings.notifEnabled) {
    try {
      isNew = (await checkNotifs(csrf, state)) || isNew;
    } catch (e) {
      notifErr = '通知接口失败: ' + e.message;
    }
  }
  if (settings.dmEnabled) {
    try {
      isNew = (await checkDMs(csrf, state)) || isNew;
    } catch (e) {
      dmErr = '私信接口失败: ' + e.message;
    }
  }
  await saveState({
    lastCheckAt: Date.now(),
    loggedIn: true,
    lastNotifError: notifErr,
    lastDmError: dmErr,
    lastError: [notifErr, dmErr].filter(Boolean).join('；'),
  });
  if (isNew) await alert(settings);
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getSettings();
  await chrome.storage.local.set({ settings });
  chrome.alarms.create('xcheck', { periodInMinutes: settings.intervalMin });
  check();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xcheck') check();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'testVoice') {
    getSettings().then(({ settings }) => {
      chrome.tts.speak(msg.phrase || settings.phrase, {
        lang: 'zh-CN',
        rate: 1.0,
        enqueue: false,
      });
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === 'saveSettings') {
    chrome.storage.local.set({ settings: msg.settings }).then(async () => {
      await chrome.alarms.clear('xcheck');
      chrome.alarms.create('xcheck', {
        periodInMinutes: msg.settings.intervalMin,
      });
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === 'getStatus') {
    getSettings().then(({ settings, state }) =>
      reply({ settings, state })
    );
    return true;
  }
  if (msg.type === 'checkNow') {
    check().then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === 'clearBaseline') {
    // 下一轮检查把当前最新消息当新消息报出来
    saveState({ notifBaseline: '0', dmBaseline: '0' }).then(() =>
      reply({ ok: true })
    );
    return true;
  }
});
