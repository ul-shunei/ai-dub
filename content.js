// YouTube content script: loads the transcript, has it translated, voices
// each sentence with Azure Speech and plays it in time with the video.
(() => {
  if (window.__aiDub) return;
  window.__aiDub = true;

  const T = AiDubTranscript;
  const TAG = 'ai-dub';
  const MAX_LAG = 5; // seconds the voice may run behind before the video waits
  const LOOKAHEAD = 40; // seconds of upcoming speech to synthesize ahead
  const KEEP_BEHIND = 120; // seconds of past audio kept for seeking back
  const TRANSLATE_PARALLEL = 2;
  const VOICE_PARALLEL = 2;
  const CACHE_INDEX = 'dubCacheIndex';
  const CACHE_MAX = 30;
  // Changing these needs a fresh transcript run; the rest apply live.
  const RESTART_KEYS = ['targetLang', 'provider', 'model', 'baseUrl', 'videoNotes', 'voiceByLang', 'azureRegion', 'azureEndpoint'];
  // Changing these only needs the voice clips made again.
  const REVOICE_KEYS = ['speechRate'];

  let settings = { ...DEFAULT_SETTINGS };
  let wanted = false; // user turned dubbing on; carries over to the next video
  let session = null; // state for the video being dubbed
  let lastError = '';
  const ui = {};

  // ---------- talking to inject.js (page world) ----------

  let callId = 0;
  const pending = new Map();
  const captureWaiters = new Set();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window || msg?.source !== TAG) return;
    if (msg.dir === 'res' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    } else if (msg.dir === 'event' && msg.type === 'captured') {
      for (const waiter of captureWaiters) {
        if (waiter.videoId === msg.videoId && (!waiter.match || waiter.match(msg))) waiter.resolve(true);
      }
    }
  });

  function pageCall(type, data = {}, timeout = 15000) {
    const id = `${Date.now()}-${++callId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ source: TAG, dir: 'req', id, type, ...data }, location.origin);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('The YouTube page did not respond'));
      }, timeout);
    });
  }

  // match(capture) narrows which caption download counts; any by default.
  function waitForCapture(videoId, timeout, match = null) {
    let waiter;
    return new Promise((resolve) => {
      waiter = { videoId, resolve, match };
      captureWaiters.add(waiter);
      setTimeout(() => resolve(false), timeout);
    }).finally(() => captureWaiters.delete(waiter));
  }

  async function send(type, data) {
    const res = await chrome.runtime.sendMessage({ type, ...data });
    if (!res?.ok) throw new Error(res?.error || 'Extension error');
    return res.result;
  }

  // ---------- start / stop ----------

  async function start() {
    stop();
    lastError = '';
    const videoId = currentVideoId();
    if (!videoId) return fail(null, 'Open a YouTube video to dub it.');
    const s = (session = {
      videoId,
      phase: 'loading',
      fragments: [], // short timed pieces of the captions, in order
      lines: [], // what gets voiced: whole sentences once translated, fragments until then
      batches: [],
      batchLines: [],
      batchState: [],
      batchTries: [],
      translating: 0,
      voicing: 0,
      voiceGen: 0, // bumped when clips must be remade; older replies are dropped
      spoken: new Set(),
      readFrom: 0, // video time from which every line is owed a reading
      speaking: null,
      holding: null,
      listeners: [],
      lastPump: 0,
    });
    settings = await getSettings();
    if (s !== session) return;
    if (!settings.apiKey) return fail(s, 'Add your AI API key in the extension settings first.');
    if (!settings.azureKey) return fail(s, 'Add your Azure Speech key in the extension settings first.');
    renderButton();
    setBadge(s, 'Loading captions...');

    try {
      const info = await getInfo(videoId);
      if (s !== session) return;
      if (!info.tracks.length) throw new Error('This video has no captions, so there is nothing to translate.');
      s.title = info.title;
      s.track = T.pickTrack(info.tracks);
      const pieces = T.parseCaptions(await downloadTrack(videoId, s.track));
      if (s !== session) return;
      s.fragments = T.buildFragments(pieces);
      if (!s.fragments.length) throw new Error('The captions for this video are empty.');
      s.batches = T.makeBatches(s.fragments);
      s.batchLines = s.batches.map(([from, to]) => placeholders(s, from, to));
      rebuildLines(s);
      s.batchState = s.batches.map(() => 'idle');
      s.batchTries = s.batches.map(() => 0);
      s.cacheKey = `dub3:${videoId}:${s.track.lang}:${s.track.kind}:${settings.targetLang}:${settings.provider}:${settings.model}`;
      await loadCache(s);
      if (s !== session) return;

      const video = findVideo();
      if (!video) throw new Error('Could not find the video player.');
      attachVideo(s, video);
      s.readFrom = video.currentTime;
      s.phase = 'ready';
      setBadge(s, '');
      applyPageClasses();

      const excerpt = s.fragments.map((x) => x.text).join(' ').slice(0, 6000);
      s.summary = s.batchState.every((b) => b === 'done')
        ? Promise.resolve('')
        : send('summarize', { title: info.title, description: info.description, excerpt }).catch(() => '');
      scheduleTranslation(s);
      s.timer = setInterval(() => tick(s), 100);
    } catch (err) {
      if (s === session) fail(s, err.message);
    }
  }

  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.timer);
    stopSpeech(s);
    for (const [target, type, fn] of s.listeners) target.removeEventListener(type, fn);
    if (s.video) {
      if (s.userVolume != null) s.video.volume = s.userVolume;
      if (s.holding && s.video.paused) s.video.play().catch(() => {});
    }
    for (const x of s.lines) if (x.audio) URL.revokeObjectURL(x.audio.url);
    document.documentElement.classList.remove('ai-dub-subs-on', 'ai-dub-top');
    ui.subs?.remove();
    setBadge(s, '');
    renderButton();
  }

  function fail(s, message) {
    stop();
    wanted = false;
    showError(s, message);
  }

  function showError(s, message) {
    lastError = message;
    setBadge(s, message, true);
    renderButton();
  }

  // ---------- transcript ----------

  async function getInfo(videoId) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const info = await pageCall('info').catch(() => null);
      if (info?.videoId === videoId) return info;
      await sleep(250);
    }
    throw new Error('Could not read the video details from YouTube.');
  }

  async function downloadTrack(videoId, track) {
    let res = await pageCall('fetchTrack', { videoId, track });
    if (!res.text || res.translated) {
      await captureViaPlayer(videoId, track);
      res = await pageCall('fetchTrack', { videoId, track });
    }
    if (!res.text) throw new Error("Couldn't download this video's captions.");
    return res.text;
  }

  // Turning captions on makes the player fetch them itself; inject.js
  // remembers that request so it can be reused. First asks the player for
  // this exact track, untranslated (the user may have YouTube auto-translate
  // on), then puts the user's caption choice back.
  async function captureViaPlayer(videoId, track) {
    const base = (code) => code?.split('-')[0];
    const original = waitForCapture(
      videoId,
      8000,
      (c) => !c.tlang && base(c.lang) === base(track.lang) && c.kind === (track.kind || ''),
    );
    const switched = await pageCall('showTrack', { track }).catch(() => false);
    if (switched) {
      const ok = await original;
      await pageCall('restoreTrack').catch(() => {});
      if (ok) return;
    }
    const button = document.querySelector('#movie_player .ytp-subtitles-button');
    if (!button) return;
    const wasOn = button.getAttribute('aria-pressed') === 'true';
    const captured = waitForCapture(videoId, 8000);
    button.click();
    if (wasOn) button.click();
    await captured;
    if (!wasOn && button.getAttribute('aria-pressed') === 'true') button.click();
  }

  // ---------- translation ----------

  function scheduleTranslation(s) {
    if (s !== session || !s.video) return;
    const cur = Math.max(0, T.indexAt(s.fragments, s.video.currentTime));
    // Batches from the current position onward first, then earlier ones.
    const order = s.batches
      .map((range, k) => k)
      .filter((k) => s.batchState[k] === 'idle')
      .sort((a, b) => {
        const aAhead = s.batches[a][1] > cur;
        const bAhead = s.batches[b][1] > cur;
        if (aAhead !== bAhead) return aAhead ? -1 : 1;
        return aAhead ? a - b : b - a;
      });
    while (s.translating < TRANSLATE_PARALLEL && order.length) runBatch(s, order.shift());
  }

  async function runBatch(s, k) {
    const [from, to] = s.batches[k];
    s.batchState[k] = 'busy';
    s.translating++;
    try {
      const summary = await s.summary;
      const out = await send('translate', {
        texts: s.fragments.slice(from, to).map((x) => x.text),
        title: s.title,
        summary,
        before: s.fragments.slice(Math.max(0, from - 6), from).map((x) => x.text),
        after: s.fragments.slice(to, to + 4).map((x) => x.text),
      });
      if (s !== session) return;
      setBatchLines(s, k, out.map((x) => ({ last: from + x.last, tr: x.text, ad: x.ad })));
      s.batchState[k] = 'done';
      if (s.batchTries[k] >= 2) setBadge(s, '');
      saveCacheSoon(s);
    } catch (err) {
      if (s !== session) return;
      // A bad key or model fails every batch, so stop instead.
      if (/API error 40[13]|No AI API key|No model set/.test(err.message)) return fail(s, err.message);
      // Otherwise keep trying, more slowly each time, so no sentence is left
      // out; the video waits for it if needed.
      const tries = ++s.batchTries[k];
      s.batchState[k] = 'retry';
      if (tries >= 2) setBadge(s, `Translation failed, retrying: ${err.message}`, true);
      setTimeout(() => {
        if (s !== session) return;
        s.batchState[k] = 'idle';
        scheduleTranslation(s);
      }, Math.min(3000 * 2 ** (tries - 1), 30000));
    } finally {
      s.translating--;
      scheduleTranslation(s);
    }
  }

  // Untranslated stand-ins, one per fragment, so playback knows to wait.
  function placeholders(s, from, to) {
    return s.fragments.slice(from, to).map((f) => ({ start: f.start, end: f.end, text: f.text, tr: null }));
  }

  // sentences: [{ last, tr, ad }] with `last` the absolute index of the
  // sentence's final fragment and `ad` set on sponsor reads the AI found.
  // Each sentence starts after the previous one.
  function setBatchLines(s, k, sentences) {
    let first = s.batches[k][0];
    s.batchLines[k] = sentences.map(({ last, tr, ad }) => {
      const parts = s.fragments.slice(first, last + 1);
      const line = {
        start: parts[0].start,
        end: parts[parts.length - 1].end,
        text: parts.reduce((acc, f) => T.join(acc, f.text), ''),
        tr: (tr || '').trim(),
        last,
        ad: !!ad,
      };
      if (!line.tr) line.skip = true;
      first = last + 1;
      return line;
    });
    rebuildLines(s);
  }

  // Batches cover consecutive fragments, so joining them keeps lines sorted.
  function rebuildLines(s) {
    s.lines = s.batchLines.flat();
  }

  async function loadCache(s) {
    const saved = (await chrome.storage.local.get(s.cacheKey))[s.cacheKey];
    if (saved?.count !== s.fragments.length || JSON.stringify(saved.batches) !== JSON.stringify(s.batches)) return;
    saved.lines.forEach((sentences, k) => {
      if (!sentences) return;
      setBatchLines(s, k, sentences);
      s.batchState[k] = 'done';
    });
  }

  function saveCacheSoon(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(async () => {
      const index = ((await chrome.storage.local.get(CACHE_INDEX))[CACHE_INDEX] || []).filter((key) => key !== s.cacheKey);
      index.push(s.cacheKey);
      const dropped = index.splice(0, Math.max(0, index.length - CACHE_MAX));
      if (dropped.length) await chrome.storage.local.remove(dropped);
      await chrome.storage.local.set({
        [CACHE_INDEX]: index,
        [s.cacheKey]: {
          count: s.fragments.length,
          batches: s.batches,
          lines: s.batchLines.map((lines, k) =>
            s.batchState[k] === 'done' ? lines.map((x) => ({ last: x.last, tr: x.tr, ...(x.ad && { ad: true }) })) : null,
          ),
        },
      });
    }, 1500);
  }

  // ---------- voice ----------

  function pumpVoice(s) {
    const t = s.video.currentTime;
    // Lines the voice is still behind on come first.
    const first = Math.max(0, T.indexAt(s.lines, Math.min(t, s.readFrom)));
    for (let i = first; i < s.lines.length && s.voicing < VOICE_PARALLEL; i++) {
      const x = s.lines[i];
      if (x.start > t + LOOKAHEAD && i > first + 2) break;
      if (x.tr && !x.audio && !x.skip && !x.voicing && !(x.retryAt > performance.now())) voice(s, x);
    }
    for (const x of s.lines) {
      if (x.audio && x.end < t - KEEP_BEHIND) {
        URL.revokeObjectURL(x.audio.url);
        x.audio = null;
      }
    }
  }

  async function voice(s, x) {
    const gen = s.voiceGen;
    x.voicing = true;
    s.voicing++;
    try {
      const { audio, mime } = await send('speak', { text: x.tr });
      if (s !== session || gen !== s.voiceGen) return;
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const duration = await audioDuration(url);
      if (s !== session || gen !== s.voiceGen) return URL.revokeObjectURL(url);
      x.audio = { url, duration };
      if (x.retryAt) setBadge(s, '');
    } catch (err) {
      if (s !== session || gen !== s.voiceGen) return;
      // A bad key or region fails every line, so stop instead.
      if (/401|403|No Azure/.test(err.message)) return fail(s, err.message);
      // Otherwise try the line again shortly; the video waits for it if needed.
      x.retryAt = performance.now() + 5000;
      setBadge(s, `${err.message} (retrying)`, true);
    } finally {
      x.voicing = false;
      s.voicing--;
    }
  }

  // Drops every clip so they are made again with the new voice settings.
  // The line being read starts over; lines already read stay done.
  function revoice(s) {
    s.voiceGen++;
    if (s.speaking) unread(s, s.speaking.x);
    stopSpeech(s);
    for (const x of s.lines) {
      if (x.audio) URL.revokeObjectURL(x.audio.url);
      x.audio = null;
    }
    s.lastPump = 0;
  }

  function audioDuration(url) {
    return new Promise((resolve) => {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
      probe.onerror = () => resolve(0);
      setTimeout(() => resolve(0), 5000);
      probe.src = url;
    });
  }

  // ---------- sync ----------

  function tick(s) {
    if (s !== session) return;
    if (!s.video.isConnected) {
      const video = findVideo();
      if (!video) return;
      attachVideo(s, video);
    }
    const video = s.video;
    const ad = isAd();
    if (ad !== s.ad) {
      s.ad = ad;
      applyVolume(s);
      if (ad) {
        // The sentence the ad cut off is read again after it.
        if (s.speaking) unread(s, s.speaking.x);
        stopSpeech(s);
        release(s);
      }
    }
    if (ad) return renderSubs(s, -1, 0);

    const now = performance.now();
    if (now - s.lastPump > 500) {
      s.lastPump = now;
      pumpVoice(s);
      sizeSubs();
    }

    const t = video.currentTime;
    const i = T.indexAt(s.lines, t);
    renderSubs(s, i, t);
    if (video.paused && !s.holding) return;

    if (s.speaking) {
      // The next line is due but the voice is still talking. The video runs
      // on until the voice is MAX_LAG behind, then waits for it.
      const owed = owedLine(s, t);
      if (settings.holdVideo && owed && t - owed.start > MAX_LAG && !video.paused) hold(s, 'voice');
      return;
    }

    let x = owedLine(s, t);
    // Lines with nothing to say (an empty translation).
    while (x?.skip) {
      markRead(s, x);
      x = owedLine(s, t);
    }
    if (!x) return release(s);
    // Once the video waits for the voice, it keeps waiting until the voice
    // has read every line up to the paused spot.
    if (x.audio) {
      if (now < (s.blockedUntil || 0)) return;
      if (s.holding === 'loading') {
        s.holding = 'voice';
        setBadge(s, '');
      }
      return play(s, x);
    }
    // Still being voiced: the video waits only once it is MAX_LAG ahead.
    if (settings.holdVideo && (s.holding || t - x.start > MAX_LAG)) hold(s, 'loading');
  }

  // The oldest line not read yet that has started and runs past readFrom,
  // or null when the voice is caught up. After a seek this is the sentence
  // under the playhead, read from its start.
  function owedLine(s, t) {
    for (let k = Math.max(0, T.indexAt(s.lines, s.readFrom)); k < s.lines.length && s.lines[k].start <= t; k++) {
      const x = s.lines[k];
      if (x.end > s.readFrom && !s.spoken.has(x)) return x;
    }
    return null;
  }

  function markRead(s, x) {
    s.spoken.add(x);
    s.readFrom = Math.max(s.readFrom, x.start + 0.001);
  }

  function unread(s, x) {
    s.spoken.delete(x);
    s.readFrom = Math.min(s.readFrom, x.start);
  }

  // Always plays at the reading speed it was synthesized with, so the pace
  // stays steady. A long line lets the voice run late, up to MAX_LAG.
  function play(s, x) {
    const audio = new Audio(x.audio.url);
    markRead(s, x);
    s.speaking = { x, audio };
    // tick picks the next line, or lets the video go on if it was held.
    audio.addEventListener('ended', () => {
      if (s.speaking?.audio !== audio) return;
      s.speaking = null;
    });
    audio.play().catch((err) => {
      if (s.speaking?.audio !== audio) return;
      s.speaking = null;
      if (err.name === 'NotAllowedError') {
        unread(s, x);
        s.blockedUntil = performance.now() + 2000;
        setBadge(s, 'Click the video once so the dub can play sound.', true);
      }
    });
  }

  function stopSpeech(s) {
    if (!s.speaking) return;
    s.speaking.audio.pause();
    s.speaking = null;
  }

  function hold(s, reason) {
    if (s.holding === reason && s.video.paused) return;
    s.holding = reason;
    if (!s.video.paused) {
      s.selfPause = true;
      s.video.pause();
    }
    if (reason === 'loading') setBadge(s, 'Preparing dub...');
  }

  function release(s) {
    if (!s.holding) return;
    const reason = s.holding;
    s.holding = null;
    if (reason === 'loading') setBadge(s, '');
    if (s.video.paused) {
      s.selfPlay = true;
      s.video.play().catch(() => {});
    }
  }

  function attachVideo(s, video) {
    for (const [target, type, fn] of s.listeners) target.removeEventListener(type, fn);
    s.listeners = [];
    s.video = video;
    const on = (type, fn) => {
      video.addEventListener(type, fn);
      s.listeners.push([video, type, fn]);
    };
    on('pause', () => {
      if (s.selfPause) return (s.selfPause = false);
      s.holding = null;
      s.speaking?.audio.pause();
    });
    on('play', () => {
      if (s.selfPlay) return (s.selfPlay = false);
      s.holding = null;
      s.speaking?.audio.play().catch(() => {});
    });
    on('seeking', () => {
      stopSpeech(s);
      s.spoken.clear();
      s.readFrom = video.currentTime;
      release(s);
      scheduleTranslation(s);
    });
    on('volumechange', () => {
      if (Math.abs(video.volume - s.ourVolume) < 0.002) return;
      s.userVolume = video.volume; // the user moved YouTube's volume
      applyVolume(s);
    });
    s.userVolume = video.volume;
    s.ad = isAd();
    applyVolume(s);
  }

  // Lowers YouTube's own audio while dubbing (not during ads).
  function applyVolume(s) {
    if (s.userVolume == null) return;
    s.ourVolume = s.ad ? s.userVolume : s.userVolume * settings.originalVolume;
    s.video.volume = s.ourVolume;
  }

  // ---------- page UI ----------

  function player() {
    return document.getElementById('movie_player');
  }

  function findVideo() {
    return player()?.querySelector('video.html5-main-video') || player()?.querySelector('video') || null;
  }

  function isAd() {
    return !!player()?.classList.contains('ad-showing');
  }

  function currentVideoId() {
    return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
  }

  function renderSubs(s, i, t) {
    const x = i >= 0 ? s.lines[i] : null;
    const show = settings.subtitles !== 'off' && x?.tr && t <= x.end + 1.5;
    const host = player();
    if (!show || !host) {
      if (ui.subs) ui.subs.hidden = true;
      return;
    }
    if (!ui.subs) {
      ui.subs = el('div', 'ai-dub-subs');
      ui.subTr = ui.subs.appendChild(el('div', 'ai-dub-tr'));
      ui.subSrc = ui.subs.appendChild(el('div', 'ai-dub-src'));
    }
    if (ui.subs.parentNode !== host) {
      host.appendChild(ui.subs);
      sizeSubs();
    }
    ui.subs.hidden = false;
    ui.subTr.textContent = x.tr;
    ui.subSrc.textContent = settings.subtitles === 'both' ? x.text : '';
    ui.subSrc.hidden = settings.subtitles !== 'both';
  }

  function applyPageClasses() {
    const root = document.documentElement;
    root.classList.toggle('ai-dub-subs-on', settings.subtitles !== 'off');
    root.classList.toggle('ai-dub-top', settings.subtitlePosition === 'top');
  }

  function sizeSubs() {
    const host = player();
    if (!ui.subs || !host) return;
    const base = Math.max(14, host.clientHeight * 0.042);
    ui.subs.style.fontSize = `${Math.round(base * (settings.subtitleSize || 1))}px`;
  }

  function setBadge(s, text, isError = false) {
    if (s && s !== session && session) return;
    clearTimeout(ui.badgeTimer);
    const host = player();
    if (!text || !host) {
      ui.badge?.remove();
      return;
    }
    ui.badge ||= el('div', 'ai-dub-badge');
    ui.badge.textContent = `AI dub: ${text}`;
    ui.badge.classList.toggle('ai-dub-error', isError);
    if (ui.badge.parentNode !== host) host.appendChild(ui.badge);
    if (isError) ui.badgeTimer = setTimeout(() => ui.badge.remove(), 8000);
  }

  // Toggle button in the player's control bar.
  function renderButton() {
    const bar = player()?.querySelector('.ytp-right-controls');
    if (!bar) return;
    if (!ui.button) {
      ui.button = el('button', 'ytp-button ai-dub-button');
      ui.button.title = 'AI dub (Alt+Shift+D)';
      ui.button.setAttribute('aria-label', 'AI dub');
      ui.button.appendChild(buttonIcon());
      ui.button.addEventListener('click', toggle);
    }
    if (ui.button.parentNode !== bar) bar.prepend(ui.button);
    ui.button.setAttribute('aria-pressed', String(wanted));
  }

  function buttonIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const shapes = [
      // speech bubble
      ['path', { d: 'M9 10h14a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-8l-4 4v-4H9a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z', class: 'ai-dub-fill' }],
      // sound waves
      ['path', { d: 'M28.5 13.5a7 7 0 0 1 0 6', class: 'ai-dub-stroke' }],
      ['path', { d: 'M31 11a11 11 0 0 1 0 11', class: 'ai-dub-stroke' }],
    ];
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.appendChild(node);
    }
    return svg;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  // ---------- control ----------

  function toggle() {
    wanted = !wanted;
    if (wanted) start();
    else {
      stop();
      lastError = '';
    }
    renderButton();
    return state();
  }

  function state() {
    const s = session;
    const total = s?.fragments.length || 0;
    return {
      on: wanted,
      onVideo: !!currentVideoId(),
      phase: s?.phase || (lastError ? 'error' : 'off'),
      error: lastError,
      total,
      translated: s ? s.batches.reduce((sum, [from, to], k) => sum + (s.batchState[k] === 'done' ? to - from : 0), 0) : 0,
      track: s?.track ? `${s.track.name}${s.track.kind === 'asr' ? ' (auto-generated)' : ''}` : '',
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'toggle') sendResponse(toggle());
    else if (msg.type === 'getState') sendResponse(state());
    else if (msg.type === 'restart') {
      if (wanted) start();
      sendResponse(state());
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) return;
    const restart = RESTART_KEYS.some((key) => key in changes);
    settings = await getSettings();
    if (SPONSOR_CATEGORIES.some((c) => c.key in changes)) loadSponsors(currentVideoId());
    if (!session) return;
    if (restart && wanted) return start();
    if (REVOICE_KEYS.some((key) => key in changes)) revoice(session);
    applyVolume(session);
    applyPageClasses();
    sizeSubs();
  });

  // YouTube changes videos without reloading the page.
  function onNavigate() {
    renderButton();
    const videoId = currentVideoId();
    if (videoId !== sponsors.videoId) loadSponsors(videoId);
    if (session && session.videoId === videoId) return;
    stop();
    if (wanted && videoId) start();
  }
  document.addEventListener('yt-navigate-finish', onNavigate);
  setInterval(onNavigate, 1000);

  // ---------- sponsor skipping ----------
  // Works whether or not dubbing is on. Segments come from SponsorBlock;
  // while dubbing, sponsor reads the AI marked fill in when SponsorBlock has
  // no sponsor segment for the video.

  const MIN_AI_SPONSOR = 8; // seconds; shorter AI-marked runs are left alone
  const sponsors = { videoId: null, segments: [], skipped: new Set() };

  async function loadSponsors(videoId) {
    sponsors.videoId = videoId;
    sponsors.segments = [];
    sponsors.skipped.clear();
    if (!videoId) return;
    const current = await getSettings();
    const categories = SPONSOR_CATEGORIES.filter((c) => current[c.key]).map((c) => c.category);
    if (!categories.length) return;
    try {
      const segments = await send('sponsors', { videoId, categories });
      if (sponsors.videoId === videoId) sponsors.segments = segments;
    } catch {
      // Offline or SponsorBlock down: the AI backup can still cover sponsors.
    }
  }

  // Runs of consecutive translated sentences the AI marked as a sponsor read.
  function aiSponsorSegments(videoId) {
    const s = session;
    if (!settings.skipSponsor || !settings.aiSponsors || s?.videoId !== videoId) return [];
    const runs = [];
    let run = null;
    for (const x of s.lines) {
      if (!x.ad) {
        run = null;
      } else if (run) {
        run.end = x.end;
      } else {
        run = { start: x.start, end: x.end, category: 'sponsor', ai: true };
        runs.push(run);
      }
    }
    return runs.filter((r) => r.end - r.start >= MIN_AI_SPONSOR);
  }

  // Jumps to the end of a segment once playback enters it. Each segment is
  // skipped once; going back before its start arms it again, and seeking
  // into its middle lets it play.
  function skipSponsors() {
    const video = findVideo();
    const videoId = currentVideoId();
    if (!video || !videoId || videoId !== sponsors.videoId || isAd()) return;
    const t = video.currentTime;
    const hasSponsor = sponsors.segments.some((x) => x.category === 'sponsor');
    const segments = hasSponsor ? sponsors.segments : sponsors.segments.concat(aiSponsorSegments(videoId));
    for (const seg of segments) {
      const key = `${seg.start}-${seg.end}`;
      if (t < seg.start - 0.5) {
        sponsors.skipped.delete(key);
      } else if (t >= seg.start && t < seg.end - 0.5 && !sponsors.skipped.has(key)) {
        sponsors.skipped.add(key);
        video.currentTime = seg.end;
        const label = SPONSOR_CATEGORIES.find((c) => c.category === seg.category)?.label || seg.category;
        showNotice(`Skipped ${label}${seg.ai ? ' found by AI' : ''} (${Math.round(seg.end - seg.start)}s)`);
        return;
      }
    }
  }
  setInterval(skipSponsors, 250);

  function showNotice(text) {
    setBadge(null, text);
    ui.badgeTimer = setTimeout(() => ui.badge?.remove(), 3000);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
