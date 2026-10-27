// Runs in YouTube's own JavaScript world (manifest "world": "MAIN") at
// document_start. It watches the player's caption requests and answers
// questions from content.js over window.postMessage.
//
// Why: YouTube now often rejects caption requests that lack a token the
// player adds itself. Remembering the player's own request URL lets us reuse
// that token to download the transcript.
(() => {
  const TAG = 'ai-dub';
  const nativeFetch = window.fetch;
  // videoId -> caption files the player loaded, newest last:
  // [{ url, body, lang, kind, tlang }]. tlang is set when YouTube itself
  // auto-translated the captions, which we don't want as a source.
  const captured = new Map();
  let savedTrack; // the player's caption track before showTrack changed it

  const isCaptionUrl = (url) => typeof url === 'string' && url.includes('/api/timedtext');

  function onCaptured(url, body) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return;
    }
    const videoId = parsed.searchParams.get('v');
    if (!videoId) return;
    const entry = {
      url: parsed.href,
      body: body || '',
      lang: parsed.searchParams.get('lang') || '',
      kind: parsed.searchParams.get('kind') || '',
      tlang: parsed.searchParams.get('tlang') || '',
    };
    const list = (captured.get(videoId) || []).slice(-5);
    list.push(entry);
    captured.set(videoId, list);
    const { lang, kind, tlang } = entry;
    window.postMessage({ source: TAG, dir: 'event', type: 'captured', videoId, lang, kind, tlang }, location.origin);
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__aiDubUrl = String(url);
    return open.call(this, method, url, ...rest);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isCaptionUrl(this.__aiDubUrl)) {
      this.addEventListener('load', () => {
        if (this.status !== 200) return;
        let body = '';
        if (this.responseType === '' || this.responseType === 'text') body = this.responseText;
        onCaptured(this.responseURL || this.__aiDubUrl, body);
      });
    }
    return send.apply(this, args);
  };

  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const promise = nativeFetch.apply(this, arguments);
    if (isCaptionUrl(url)) {
      promise
        .then(async (res) => res.ok && onCaptured(res.url || url, await res.clone().text()))
        .catch(() => {});
    }
    return promise;
  };

  const handlers = {
    info() {
      const res = document.getElementById('movie_player')?.getPlayerResponse?.();
      const details = res?.videoDetails;
      const tracks = res?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return {
        videoId: details?.videoId || null,
        title: details?.title || document.title,
        description: details?.shortDescription || '',
        tracks: tracks.map((t) => ({
          lang: t.languageCode,
          kind: t.kind || '',
          name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode,
          baseUrl: t.baseUrl,
        })),
      };
    },

    // Tries the file the player already loaded for this exact track, then
    // the track's own URL, then the player's captured URL re-pointed at this
    // track, then the captured URL as it was. A file YouTube auto-translated
    // is only used when nothing else works.
    async fetchTrack({ videoId, track }) {
      const list = captured.get(videoId) || [];
      const original = list.findLast(
        (c) => !c.tlang && c.body.trim() && c.lang === track.lang && c.kind === (track.kind || ''),
      );
      if (original) return { text: original.body, captured: true };
      const urls = [];
      const own = new URL(track.baseUrl, location.href);
      own.searchParams.set('fmt', 'json3');
      urls.push(own.href);
      const seen = list[list.length - 1];
      if (seen) {
        const retarget = new URL(seen.url);
        for (const key of ['lang', 'kind', 'name']) {
          const value = own.searchParams.get(key);
          if (value) retarget.searchParams.set(key, value);
          else retarget.searchParams.delete(key);
        }
        retarget.searchParams.delete('tlang');
        retarget.searchParams.set('fmt', 'json3');
        urls.push(retarget.href);
        const asIs = new URL(seen.url);
        asIs.searchParams.delete('tlang');
        asIs.searchParams.set('fmt', 'json3');
        urls.push(asIs.href);
      }
      for (const url of urls) {
        try {
          const res = await nativeFetch(url, { credentials: 'include' });
          const text = res.ok ? await res.text() : '';
          if (text.trim()) return { text, captured: !!seen };
        } catch {}
      }
      const any = list.findLast((c) => c.body.trim());
      return { text: any ? any.body : '', captured: !!seen, translated: !!any?.tlang };
    },

    // Switches the player's captions to this track, untranslated, so the
    // player downloads it with its own token. restoreTrack undoes it.
    showTrack({ track }) {
      const player = document.getElementById('movie_player');
      if (!player?.setOption || !player.getOption) return false;
      player.loadModule?.('captions');
      const list = player.getOption('captions', 'tracklist') || [];
      const target =
        list.find((t) => t.languageCode === track.lang && (t.kind || '') === (track.kind || '')) ||
        { languageCode: track.lang, kind: track.kind || '' };
      if (savedTrack === undefined) savedTrack = player.getOption('captions', 'track') || {};
      player.setOption('captions', 'track', { ...target, translationLanguage: null });
      return true;
    },

    restoreTrack() {
      const player = document.getElementById('movie_player');
      if (!player?.setOption || savedTrack === undefined) return;
      const prev = savedTrack;
      savedTrack = undefined;
      if (prev.languageCode) player.setOption('captions', 'track', prev);
      else player.unloadModule?.('captions'); // captions were off
    },
  };

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (event.source !== window || msg?.source !== TAG || msg.dir !== 'req' || !handlers[msg.type]) return;
    let result = null;
    let error = null;
    try {
      result = await handlers[msg.type](msg);
    } catch (err) {
      error = err?.message || String(err);
    }
    window.postMessage({ source: TAG, dir: 'res', id: msg.id, result, error }, location.origin);
  });
})();
