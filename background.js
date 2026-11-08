// X 新消息语音提醒 — 后台 service worker v1.0.1
// 原理：在用户自己的浏览器里，用已登录的 X 会话（cookie + ct0）
// 每分钟轮询一次 X 的通知和私信接口，有新内容就用中文语音播报。
// 不经过任何第三方服务器，不保存账号密码。
// v1.0.3：通知改走 GraphQL NotificationsTimeline（X 网页版用的就是这个）。
// 旧的 REST 接口都死了：all.json 返回 0 条，badge_count 报 HTTP 500。
// queryId 与 features 取自 fa0311/twitter-openapi 2026-11-07 的快照；
// 每次检查把查到的数据写进 state，弹窗里能看到；
// 加清除基线：下一轮把当前最新消息当新消息报出来。

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const DEFAULTS = {
  dmEnabled: true, // 私信提醒
  notifEnabled: true, // 通知提醒（@、回复等）
  phrase: '您有新的消息，请及时回复',
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

// v1.0.3：通知改走 GraphQL NotificationsTimeline（X 网页版用的就是这个）。
// 旧的 REST 接口都死了：all.json 返回 0 条，badge_count 报 HTTP 500。
// queryId 与 features 取自 fa0311/twitter-openapi 2026-11-07 的快照
// （src/config/placeholder.json，HEAD 10a5fe8）。
// 响应路径：data.viewer_v2.user_results.result.notification_timeline
//   .timeline.instructions[]，取 TimelineAddEntries 里最大的 sortIndex
// 当最新标记；首次只记基线，不报旧消息。
const NOTIF_QUERY_ID = 'YX7xisHsNjDlFHW-MVXINQ';
const NOTIF_FEATURES = {"rweb_video_screen_enabled":false,"rweb_cashtags_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":true,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"rweb_cashtags_composer_attachment_enabled":true,"responsive_web_jetfuel_frame":true,"rweb_sports_post_context_enabled":true,"x_elections_post_context_enabled":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_nested_quote_preview_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_made_on_x_label_enabled":false,"responsive_web_grok_community_note_auto_translation_is_enabled":true,"responsive_web_enhance_cards_enabled":false};

// 通知：取时间线里最大的 sortIndex，和上次比对
async function checkNotifs(csrf, state) {
  const variables = encodeURIComponent(
    JSON.stringify({ timeline_type: 'All', count: 20 })
  );
  const features = encodeURIComponent(JSON.stringify(NOTIF_FEATURES));
  const data = await xFetch(
    `/i/api/graphql/${NOTIF_QUERY_ID}/NotificationsTimeline?variables=${variables}&features=${features}`,
    csrf
  );
  const instructions =
    data?.data?.viewer_v2?.user_results?.result?.notification_timeline
      ?.timeline?.instructions || [];
  let latest = '';
  let count = 0;
  for (const inst of instructions) {
    if (inst.type !== 'TimelineAddEntries' || !Array.isArray(inst.entries))
      continue;
    for (const e of inst.entries) {
      if (
        typeof e.entryId === 'string' &&
        e.entryId.startsWith('notification-')
      )
        count++;
      const si = String(e.sortIndex || '');
      if (si) latest = maxNumStr(latest, si);
    }
  }
  await saveState({ lastNotifCount: count, lastNotifLatest: latest || '—' });
  if (!latest) return false;
  // 基线兼容：'0' 是清除基线后的标记（下一轮一定报）；
  // 10 位以上的长数字串是 v1.0.3 的 sortIndex 基线；
  // v1.0.2 存的未读数（短数字）直接作废，静默重记一次。
  const baseRaw = state.notifBaseline || '';
  let base = '';
  if (baseRaw === '0') base = '0';
  else if (/^\d{10,}$/.test(baseRaw)) base = baseRaw;
  if (!base) {
    await saveState({ notifBaseline: latest });
    return false; // 首次只记基线，不报旧消息
  }
  if (latest !== base) {
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
