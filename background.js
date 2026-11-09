// X 新消息语音提醒 — 后台 service worker v1.0.1
// 原理：在用户自己的浏览器里，用已登录的 X 会话（cookie + ct0）
// 每分钟轮询一次 X 的通知和私信接口，有新内容就用中文语音播报。
// 不经过任何第三方服务器，不保存账号密码。
// v1.0.3：通知改走 GraphQL NotificationsTimeline（X 网页版用的就是这个）。
// 旧的 REST 接口都死了：all.json 返回 0 条，badge_count 报 HTTP 500。
// queryId 与 features 取自 fa0311/twitter-openapi 2026-11-07 的快照；
// 每次检查把查到的数据写进 state，弹窗里能看到；
// 加清除基线：下一轮把当前最新消息当新消息报出来。
// v1.0.4：多语音选择。语音下拉取系统中文语音；语气分正常 / 蜡笔小新
// （高音+快语速的模仿，不是真的小新声音）/ 温柔慢速。
// v1.0.5：通知按类型开关（点赞/回复/@提到/关注/转推），类型按模板名 +
// 文案 + 图标里的关键词猜，猜不出的算其他、照常提醒。
// v1.0.7：提醒总开关 / 私信播报发信人名字（仅私信，可关）/ 没看再提醒一次
// （只一次）/ 在 X 上时不语音 / 点通知打开 X / 角标未看数。
// v1.0.8：登录过期提醒一次 / 通知主接口挂了自动切 ViewerBadgeCounts 备用
// 接口 / 音量滑块。
// v1.0.9：蜡笔小新改放真录音（Fish Audio 蜡笔小新模型合成的
// “您有新的消息，请及时回复”，shinchan-reminder.mp3，3.4 秒）。
// 用户听过：不算很像小新，但能用。MV3 的 service worker 不能直接播
// 音频，录音放 offscreen.html 里播；录音放不出来或要说的内容不是
// 这句固定词时，退回 TTS 高音模仿。

// v1.0.10：语音下拉删了（Mac/Edge 里 30 多个中文语音全列出来又长
// 又重复，用户说乱七八糟），只留系统默认；语气三档保留，小新还是
// 放录音；旧存的 voiceName 作废，保存时顺手清掉。
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const DEFAULTS = {
  dmEnabled: true, // 私信提醒
  notifEnabled: true, // 通知提醒（@、回复等）
  phrase: '您有新的消息，请及时回复',
  intervalMin: 1, // 轮询间隔（分钟）
  voiceStyle: 'normal', // normal | shinchan | gentle
  notifTypes: { like: true, reply: true, mention: true, follow: true, repost: true },
  remindersEnabled: true, // 总开关：关 = 完全不提醒
  speakSenderName: true, // 私信播报发信人名字
  repeatEnabled: true, // 没看就再提醒一次（只一次）
  volume: 1.0, // 播报音量 0-1
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

async function xFetch(path, csrf, extraHeaders) {
  const res = await fetch('https://x.com' + path, {
    credentials: 'include',
    headers: {
      authorization: 'Bearer ' + BEARER,
      'x-csrf-token': csrf,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      ...(extraHeaders || {}),
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

// 通知分类：按模板名 + 文案 + 图标里的关键词猜类型；
// 猜不出的算 other（照常提醒，不会因为猜错而漏报）。
function notifKind(entry) {
  const item = entry?.content?.itemContent || {};
  const hay = [
    item?.template?.__typename || '',
    item?.template?.additional_context?.text || '',
    item?.rich_message?.text || '',
    item?.notification_icon || '',
    item?.__typename || '',
  ].join(' ');
  if (/like/i.test(hay) || /赞/.test(hay)) return 'like';
  if (/repost|retweet/i.test(hay) || /转推|转发/.test(hay)) return 'repost';
  if (/reply|replied/i.test(hay) || /回复/.test(hay)) return 'reply';
  if (/mention/i.test(hay) || /提及|提到/.test(hay)) return 'mention';
  if (/follow/i.test(hay) || /关注/.test(hay)) return 'follow';
  return 'other';
}
const NOTIF_KIND_LABEL = {
  like: '点赞',
  reply: '回复',
  mention: '@提到',
  follow: '关注',
  repost: '转推',
  other: '其他',
};

// 通知：取时间线里最大的 sortIndex，和上次比对
async function checkNotifs(csrf, state, settings) {
  const variables = encodeURIComponent(
    JSON.stringify({ timeline_type: 'All', count: 20 })
  );
  const features = encodeURIComponent(JSON.stringify(NOTIF_FEATURES));
  const data = await xFetch(
    `/i/api/graphql/${NOTIF_QUERY_ID}/NotificationsTimeline?variables=${variables}&features=${features}`,
    csrf
  );
  // GraphQL 报错（如 queryId 被轮换）或返回结构异常 → 抛给上层切备用接口
  if (Array.isArray(data?.errors) && data.errors.length) {
    throw new Error('GraphQL 报错: ' + (data.errors[0]?.message || '未知错误'));
  }
  if (!data?.data?.viewer_v2?.user_results?.result?.notification_timeline) {
    throw new Error('通知接口返回异常');
  }
  const instructions =
    data?.data?.viewer_v2?.user_results?.result?.notification_timeline
      ?.timeline?.instructions || [];
  // 基线兼容：'0' 是清除基线后的标记（下一轮一定报）；
  // 10 位以上的长数字串是 v1.0.3 的 sortIndex 基线；
  // v1.0.2 存的未读数（短数字）直接作废，静默重记一次。
  const baseRaw = state.notifBaseline || '';
  let base = '';
  if (baseRaw === '0') base = '0';
  else if (/^\d{10,}$/.test(baseRaw)) base = baseRaw;
  let latest = ''; // 只算要提醒的类型
  let latestAll = ''; // 所有类型里最新的（诊断用）
  let latestKind = 'other';
  let count = 0;
  let newCount = 0;
  const types = settings.notifTypes || {};
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
      if (!si) continue;
      const kind = notifKind(e);
      if (maxNumStr(si, latestAll) === si) {
        latestAll = si;
        latestKind = kind;
      }
      const wanted = kind === 'other' || types[kind] !== false;
      if (wanted) {
        latest = maxNumStr(latest, si);
        if (base && maxNumStr(si, base) === si && si !== base) newCount++;
      }
    }
  }
  await saveState({
    lastNotifCount: count,
    lastNotifLatest: latestAll || '—',
    lastNotifKind: NOTIF_KIND_LABEL[latestKind] || '其他',
  });
  if (!latest) return { isNew: false, newCount: 0 };
  if (!base) {
    await saveState({ notifBaseline: latest });
    return { isNew: false, newCount: 0 }; // 首次只记基线，不报旧消息
  }
  // 只在新标记比基线大时才报：关掉的类型不该把基线拉低、也不该误报。
  if (maxNumStr(latest, base) === latest && latest !== base) {
    await saveState({ notifBaseline: latest });
    return { isNew: true, newCount };
  }
  return { isNew: false, newCount: 0 };
}

// 备用接口：主接口挂了时按未读数判断。queryId 与返回结构取自
// fa0311/twitter-openapi 2026-11-07 快照：
// data.viewer_v2.user_results.result.badge_counts
//   .{ntab_unread_count, dm_unread_count, total_unread_count}。
// 降级模式：分不出通知类型（点赞也会报），读过的会把数拉低、可能漏报。
const BADGE_QUERY_ID = 'q4Npr1-FYRWyXsRzPckwEA';
async function checkNotifsFallback(csrf, state) {
  const data = await xFetch(
    `/i/api/graphql/${BADGE_QUERY_ID}/ViewerBadgeCounts?variables=${encodeURIComponent('{}')}`,
    csrf,
    { 'x-twitter-polling': 'true' }
  );
  const counts =
    data?.data?.viewer_v2?.user_results?.result?.badge_counts;
  if (!counts || typeof counts.ntab_unread_count !== 'number') {
    throw new Error('备用接口无数据');
  }
  const n = counts.ntab_unread_count;
  const prev =
    typeof state.lastNtabUnread === 'number' ? state.lastNtabUnread : null;
  await saveState({ lastNtabUnread: n, notifFallback: true });
  if (prev === null) return { isNew: false, newCount: 0 }; // 首次只记数
  if (n > prev) return { isNew: true, newCount: n - prev };
  return { isNew: false, newCount: 0 };
}

// 私信：取所有会话里最大的 sort_timestamp，和上次比对；
// 同时找出最新会话的发信人名字（只用于播报）。
// 结构按 mautrix-twitter 的 TwitterInboxData：
// 会话 {conversation_id, type, name, sort_timestamp, sort_event_id,
//   participants: [{user_id}]}, 用户 {id_str, name, screen_name}，
// 消息 entry {message: {id, conversation_id, time,
//   message_data: {sender_id, text}}}。
async function checkDMs(csrf, state) {
  const data = await xFetch('/i/api/1.1/dm/inbox_initial_state.json', csrf);
  const inner = data.inbox_initial_state || {};
  const convs = inner.conversations || data.conversations || {};
  const users = inner.users || data.users || {};
  const entries = Array.isArray(inner.entries) ? inner.entries : [];
  const list = Object.values(convs);
  let maxTs = '';
  let newest = null;
  for (const c of list) {
    const ts = String(c.sort_timestamp || '');
    if (ts && maxNumStr(ts, maxTs) === ts) {
      maxTs = ts;
      newest = c;
    }
  }
  await saveState({ lastDmCount: list.length, lastDmLatest: maxTs || '—' });
  if (!maxTs) {
    if (!state.dmBaseline) await saveState({ dmBaseline: '0' });
    return { isNew: false, newCount: 0, senderName: '' };
  }
  // 自己：出现在所有会话里的参与者
  const partLists = list.map((c) =>
    (c.participants || []).map((p) => String(p?.user_id ?? p ?? ''))
  );
  let selfId = '';
  if (partLists.length && partLists[0].length) {
    selfId =
      partLists[0].find((id) => id && partLists.every((ids) => ids.includes(id))) || '';
  }
  // 某会话最新事件的发信人：先找 sort_event_id 对应的 entry，
  // 找不到就取该会话最新一条消息
  function senderOf(conv) {
    if (!conv) return '';
    const sortEventId = String(conv.sort_event_id || '');
    let hit = null;
    if (sortEventId) {
      hit = entries.find((e) => String(e?.message?.id || '') === sortEventId) || null;
    }
    if (!hit) {
      const mine = entries
        .filter((e) => e?.message?.conversation_id === conv.conversation_id)
        .sort((a, b) =>
          String(b?.message?.time || '').localeCompare(String(a?.message?.time || ''))
        );
      hit = mine[0] || null;
    }
    return String(hit?.message?.message_data?.sender_id || '');
  }
  // 某会话的名字：发信人名字优先，退回对方参与者名字、群名
  function nameOf(conv) {
    if (!conv) return '';
    const sid = senderOf(conv);
    if (sid) {
      const n = dmUserName(users, sid);
      if (n) return n;
    }
    const others = (conv.participants || [])
      .map((p) => String(p?.user_id ?? p ?? ''))
      .filter((id) => id && id !== selfId);
    for (const id of others) {
      const n = dmUserName(users, id);
      if (n) return n;
    }
    return String(conv.name || '');
  }
  const newestSender = senderOf(newest);
  const isSelfSend = !!(newestSender && selfId && newestSender === selfId);
  if (!state.dmBaseline) {
    await saveState({ dmBaseline: maxTs });
    return { isNew: false, newCount: 0, senderName: '' }; // 首次只记基线
  }
  const base = state.dmBaseline;
  let newCount = 0;
  let targetConv = null;
  for (const c of list) {
    const ts = String(c.sort_timestamp || '');
    if (!ts || maxNumStr(ts, base) !== ts || ts === base) continue;
    if (c === newest && isSelfSend) continue; // 自己刚发的，不算
    newCount++;
    if (
      !targetConv ||
      maxNumStr(ts, String(targetConv.sort_timestamp || '')) === ts
    ) {
      targetConv = c;
    }
  }
  const senderName = targetConv ? nameOf(targetConv) : '';
  await saveState({ lastDmSender: senderName || '—' });
  const isNew = newCount > 0;
  if (isNew) await saveState({ dmBaseline: maxTs });
  return { isNew, newCount, senderName };
}

// 语气：正常原样；蜡笔小新 = 高音 + 快语速（模仿，不是真声）；
// 温柔慢速 = 低音 + 慢速。
function speakOptions(settings) {
  const opts = {
    lang: 'zh-CN',
    rate: 1.0,
    pitch: 1.0,
    volume: Math.min(1, Math.max(0, Number(settings.volume ?? 1))),
    enqueue: false,
  };
  if (settings.voiceStyle === 'shinchan') {
    opts.pitch = 1.7;
    opts.rate = 1.3;
  } else if (settings.voiceStyle === 'gentle') {
    opts.pitch = 0.7;
    opts.rate = 0.8;
  }
  return opts;
}

// 录音只录了默认提醒词这一句。语气是蜡笔小新、且要说的内容正好是
// 这句时放录音；其他内容（改过的提醒词、私信发信人名、登录过期）
// 录音说不了，退回 TTS；录音放不出来也退回 TTS 模仿音。
const CLIP_PHRASE = '您有新的消息，请及时回复';

async function ensureOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      if (await chrome.offscreen.hasDocument()) return true;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: '播放蜡笔小新提醒录音',
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function playClip(settings) {
  try {
    if (!(await ensureOffscreen())) return false;
    const res = await chrome.runtime.sendMessage({
      type: 'playClip',
      volume: Math.min(1, Math.max(0, Number(settings.volume ?? 1))),
    });
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

async function speakPhrase(settings, phrase) {
  if (settings.voiceStyle === 'shinchan' && phrase === CLIP_PHRASE) {
    if (await playClip(settings)) return;
    // 录音失败：往下走 TTS 模仿音
  }
  try {
    await chrome.tts.speak(phrase, speakOptions(settings));
  } catch (e) {}
}

// 他是不是正开着 X（在看就不用语音喊，横幅照常）
async function isOnX() {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      url: ['*://x.com/*', '*://twitter.com/*'],
    });
    return tabs.length > 0;
  } catch (e) {
    return false; // 查不到就当他不在 X 上，照常提醒
  }
}

// 角标：自上次打开弹窗以来新到的消息数
async function updateBadge() {
  try {
    const { state } = await getSettings();
    const n = state.newCount || 0;
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  } catch (e) {}
}

// 私信用户名字：name 优先，退回 screen_name
function dmUserName(users, id) {
  const u = users[id] || users[String(id)];
  return String(u?.name || u?.screen_name || '');
}

async function alert(settings, phrase, target, skipVoice) {
  await saveState({
    lastAlertAt: Date.now(),
    lastAlertPhrase: phrase,
    lastAlertTarget: target,
    repeatAt: Date.now(),
  });
  if (!skipVoice) {
    await speakPhrase(settings, phrase); // 语音失败也不影响下面的横幅通知
  }
  chrome.notifications.create('x-' + target, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'X 新消息',
    message: phrase,
  });
}

async function check() {
  const { settings, state } = await getSettings();
  const csrf = await getCsrf();
  if (!csrf) {
    // 登录过期：只提醒一次，重新登录后恢复
    const alerted = !!state.loginAlerted;
    await saveState({
      lastCheckAt: Date.now(),
      loggedIn: false,
      lastError: '未登录 X（请先在 Edge 里登录 x.com）',
    });
    if (!alerted && settings.remindersEnabled !== false) {
      await saveState({ loginAlerted: true });
      await speakPhrase(settings, 'X 登录已过期，请重新登录');
      chrome.notifications.create('x-login', {
        type: 'basic',
        iconUrl: 'icon128.png',
        title: 'X 新消息语音提醒',
        message: 'X 登录已过期，请在 Edge 里重新登录 x.com',
      });
    }
    await updateBadge();
    return;
  }
  const onX = await isOnX();
  let notifNew = 0;
  let dmNew = 0;
  let dmSender = '';
  let notifErr = '';
  let dmErr = '';
  if (settings.notifEnabled) {
    try {
      const r = await checkNotifs(csrf, state, settings);
      notifNew = r.newCount;
      await saveState({ notifFallback: false });
    } catch (e) {
      // 主接口挂了（queryId 被轮换等），切备用计数接口降级提醒
      try {
        const r2 = await checkNotifsFallback(csrf, state);
        notifNew = r2.newCount;
        notifErr = '通知主接口失败，已切备用接口: ' + e.message;
      } catch (e2) {
        notifErr =
          '通知接口失败: ' + e.message + '；备用接口也失败: ' + e2.message;
      }
    }
  }
  if (settings.dmEnabled) {
    try {
      const r = await checkDMs(csrf, state);
      dmNew = r.newCount;
      dmSender = r.senderName || '';
    } catch (e) {
      dmErr = '私信接口失败: ' + e.message;
    }
  }
  const totalNew = notifNew + dmNew;
  const isNew = totalNew > 0;
  await saveState({
    lastCheckAt: Date.now(),
    loggedIn: true,
    loginAlerted: false,
    lastNotifError: notifErr,
    lastDmError: dmErr,
    lastError: [notifErr, dmErr].filter(Boolean).join('；'),
  });
  // 在 X 上 = 已看到：清掉待重复提醒
  if (onX) await saveState({ repeatAt: 0 });
  // 总开关关了：基线已推进，不报也不攒角标
  if (settings.remindersEnabled === false) {
    await saveState({ newCount: 0, repeatAt: 0 });
    await updateBadge();
    return;
  }
  if (isNew) {
    const target =
      dmNew > 0 && notifNew > 0 ? 'both' : dmNew > 0 ? 'dm' : 'notif';
    let phrase = settings.phrase;
    if (target !== 'notif' && settings.speakSenderName !== false && dmSender) {
      phrase = dmSender + '发来私信，请及时回复';
    }
    await saveState({ newCount: (state.newCount || 0) + totalNew });
    await alert(settings, phrase, target, onX);
    await updateBadge();
    return;
  }
  // 没新消息：到时间就再提醒一次（只一次）
  if (
    settings.repeatEnabled !== false &&
    state.repeatAt &&
    !onX &&
    Date.now() - state.repeatAt >= (settings.intervalMin || 1) * 60000
  ) {
    await speakPhrase(settings, state.lastAlertPhrase || settings.phrase);
    await saveState({ repeatAt: 0 });
  }
  await updateBadge();
}

// 点系统通知直接打开 X：私信→私信页，其他→通知页
chrome.notifications.onClicked.addListener(async (id) => {
  const { state } = await getSettings();
  const target = state.lastAlertTarget || 'notif';
  const url =
    target === 'dm' ? 'https://x.com/messages' : 'https://x.com/notifications';
  try {
    await chrome.tabs.create({ url });
  } catch (e) {}
  chrome.notifications.clear(id);
  await saveState({ newCount: 0, repeatAt: 0 });
  await updateBadge();
});

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
      const merged = {
        ...settings,
        voiceStyle:
          msg.voiceStyle !== undefined ? msg.voiceStyle : settings.voiceStyle,
      };
      speakPhrase(merged, msg.phrase || settings.phrase);
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === 'saveSettings') {
    // v1.0.10：语音下拉已删，旧存的 voiceName 作废
    const settings = { ...msg.settings };
    delete settings.voiceName;
    chrome.storage.local.set({ settings }).then(async () => {
      await chrome.alarms.clear('xcheck');
      chrome.alarms.create('xcheck', {
        periodInMinutes: settings.intervalMin,
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
  if (msg.type === 'clearBadge') {
    // 打开弹窗 = 已看到：清角标和待重复提醒
    saveState({ newCount: 0, repeatAt: 0 }).then(async () => {
      await updateBadge();
      reply({ ok: true });
    });
    return true;
  }
});
