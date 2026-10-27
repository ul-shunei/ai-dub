// Pure helpers for turning a YouTube caption file into timed fragments.
// Loaded as a content script before content.js; no DOM or chrome APIs except
// DOMParser for the XML formats.

const AiDubTranscript = (() => {
  const CJK = /[　-ヿ㐀-鿿가-힯＀-￯]/;
  const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/;
  const SOFT_END = /[,;:，；：、]$/;

  // Returns pieces [{ t, end, text }] in seconds, sorted by start time.
  // Auto-generated tracks give one piece per word; manual tracks one per line.
  function parseCaptions(raw) {
    const text = raw.trim();
    const pieces = text.startsWith('{') ? parseJson3(text) : parseXml(text);
    pieces.sort((a, b) => a.t - b.t);
    for (let i = 0; i < pieces.length; i++) {
      const next = pieces[i + 1];
      if (next && next.t < pieces[i].end) pieces[i].end = Math.max(next.t, pieces[i].t);
    }
    return pieces
      .map((p) => ({ ...p, text: clean(p.text) }))
      .filter((p) => p.text)
      .flatMap(splitAtSentences);
  }

  // A caption line can hold the end of one sentence and the start of the
  // next. Splits it there, sharing the line's time out by length.
  function splitAtSentences(p) {
    const parts = p.text.split(/(?<=[.!?。！？…]["'”’)\]]*)\s+/).filter(Boolean);
    if (parts.length < 2) return [p];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const span = Math.max(0, p.end - p.t);
    let t = p.t;
    return parts.map((text) => {
      const piece = { t, end: t + (span * text.length) / total, text };
      t = piece.end;
      return piece;
    });
  }

  function parseJson3(text) {
    const pieces = [];
    for (const ev of JSON.parse(text).events || []) {
      if (!ev.segs) continue;
      const start = (ev.tStartMs || 0) / 1000;
      const end = start + (ev.dDurationMs || 0) / 1000;
      for (const seg of ev.segs) {
        if (!seg.utf8?.trim()) continue;
        pieces.push({ t: start + (seg.tOffsetMs || 0) / 1000, end, text: seg.utf8 });
      }
    }
    return pieces;
  }

  // srv3: <p t="ms" d="ms"><s t="offsetMs">word</s></p>
  // srv1: <text start="s" dur="s">line</text>
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const pieces = [];
    for (const p of doc.querySelectorAll('p')) {
      const start = Number(p.getAttribute('t')) / 1000;
      const end = start + Number(p.getAttribute('d') || 0) / 1000;
      const words = p.querySelectorAll('s');
      if (words.length) {
        for (const s of words) pieces.push({ t: start + Number(s.getAttribute('t') || 0) / 1000, end, text: s.textContent });
      } else {
        pieces.push({ t: start, end, text: p.textContent });
      }
    }
    for (const node of doc.querySelectorAll('text')) {
      const start = Number(node.getAttribute('start'));
      pieces.push({ t: start, end: start + Number(node.getAttribute('dur') || 0), text: decodeEntities(node.textContent) });
    }
    return pieces;
  }

  // srv1 double-encodes entities (&amp;#39;).
  function decodeEntities(text) {
    return text.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (m, code) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()];
      if (named) return named;
      return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
    });
  }

  // Drops sound tags like [Music] and speaker-change marks, which are not speech.
  function clean(text) {
    return text
      .replace(/\[[^\]]*\]|♪+|>>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function join(a, b) {
    if (!a) return b;
    if (CJK.test(a.slice(-1)) || CJK.test(b[0])) return a + b;
    return `${a} ${b}`;
  }

  // Groups pieces into short fragments [{ start, end, text }]. Breaks at
  // sentence punctuation and pauses, and keeps each fragment a few seconds
  // long. Auto-generated captions have little punctuation, so the AI later
  // joins fragments back into whole sentences while translating.
  function buildFragments(pieces) {
    const fragments = [];
    let cur = null;
    pieces.forEach((p, i) => {
      const next = pieces[i + 1];
      if (!cur) cur = { start: p.t, end: p.end, text: '' };
      cur.text = join(cur.text, p.text);
      cur.end = Math.max(cur.end, p.end);
      const dur = p.end - cur.start;
      const gap = next ? next.t - p.end : Infinity;
      const brk =
        !next ||
        SENTENCE_END.test(p.text) ||
        (SOFT_END.test(p.text) && dur >= 2) ||
        (gap >= 0.3 && dur >= 1) ||
        dur >= 5;
      if (brk) {
        fragments.push(cur);
        cur = null;
      }
    });
    return fragments;
  }

  // Splits fragment indexes into translation batches [[from, to), ...].
  // A sentence can't span two batches, so each batch ends where a sentence
  // most likely ends: at closing punctuation, else at the longest pause.
  function makeBatches(fragments, maxItems = 40, maxChars = 2500) {
    const batches = [];
    let from = 0;
    while (from < fragments.length) {
      let to = from;
      let chars = 0;
      while (to < fragments.length && to - from < maxItems && (to === from || chars + fragments[to].text.length <= maxChars)) {
        chars += fragments[to].text.length;
        to++;
      }
      if (to < fragments.length) to = bestCut(fragments, from + Math.ceil((to - from) / 2), to);
      batches.push([from, to]);
      from = to;
    }
    return batches;
  }

  // Best end (exclusive) in (lo, hi]: the latest sentence end, else the
  // longest pause before the next fragment.
  function bestCut(fragments, lo, hi) {
    for (let i = hi; i > lo; i--) if (SENTENCE_END.test(fragments[i - 1].text)) return i;
    let best = hi;
    let bestGap = -Infinity;
    for (let i = hi; i > lo; i--) {
      const gap = fragments[i].start - fragments[i - 1].end;
      if (gap > bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    return best;
  }

  // Index of the last line that started at or before time t, or -1.
  function indexAt(lines, t) {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // English first: human-made, then auto-generated. Otherwise the spoken
  // language (the auto track's): human-made, then auto. Then any track.
  function pickTrack(tracks) {
    const base = (code) => code?.split('-')[0];
    const human = (lang) => tracks.find((t) => t.kind !== 'asr' && base(t.lang) === lang);
    const auto = (lang) => tracks.find((t) => t.kind === 'asr' && (!lang || base(t.lang) === lang));
    const spoken = base(auto()?.lang);
    return human('en') || auto('en') || (spoken && human(spoken)) || auto() || tracks[0] || null;
  }

  return { parseCaptions, buildFragments, makeBatches, indexAt, pickTrack, join };
})();
