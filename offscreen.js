// v1.0.9：MV3 service worker 里不能直接播音频，录音放这里播。
// background.js 发 {type:'playClip', volume} 过来就从头放一遍。
const audio = document.getElementById('clip');

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'playClip') return;
  try {
    audio.volume = Math.min(1, Math.max(0, Number(msg.volume ?? 1)));
    audio.currentTime = 0;
    const p = audio.play();
    if (p && p.then) {
      p.then(() => reply({ ok: true })).catch((e) =>
        reply({ ok: false, error: String(e && e.message ? e.message : e) })
      );
      return true; // 异步回 reply
    }
    reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
