// The dub's subtitles for the active tab: every sentence of the video, with
// the one being read marked and kept in view. Clicking a sentence plays the
// video from there. The Summary tab shows a summary of the whole video, and
// the Rewrite tab the subtitles as readable paragraphs (also as an EPUB),
// each made when its button is pressed. content.js in the YouTube tab does the work; this
// connects to it and follows the active tab.
const $ = (id) => document.getElementById(id);
const FOLLOW_PAUSE = 5000; // ms the list stays put after the user scrolls it

let port = null;
let tabId = null;
let state = null;
let lines = []; // [{ start, end, text, tr }]; tr is null until translated
let current = -1;
let settings = { ...DEFAULT_SETTINGS };
let userScrolledAt = 0;
let docs = {}; // 'summary' / 'rewrite' -> { videoId, status, data, error, progress } from content.js
let peeked = {}; // kind -> video ID content.js was last asked about
let tab = savedTab();

init();

async function init() {
  settings = await getSettings();
  applySettings();
  showTab(tab);
  attach();
}

chrome.tabs.onActivated.addListener(attach);
// The tab may still be loading, or reloaded (which drops the connection).
setInterval(() => port || attach(), 2000);

async function attach() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || (tab.id === tabId && port)) return;
  connect(tab.id);
}

function connect(id) {
  port?.disconnect();
  tabId = id;
  const p = chrome.tabs.connect(id, { name: 'side', frameId: 0 });
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== p) return;
    port = null;
    state = null;
    lines = [];
    current = -1;
    docs = {};
    peeked = {};
    $('lines').replaceChildren();
    render();
  });
}

function onMessage(msg) {
  if (msg.type !== 'update') return;
  if (msg.state) state = msg.state;
  if (msg.lines) renderLines(msg.lines);
  if ('current' in msg) setCurrent(msg.current);
  if (msg.docs) docs = msg.docs;
  render();
}

function send(msg) {
  try {
    port?.postMessage(msg);
  } catch {}
}

// ---------- header and empty message ----------

function render() {
  $('title').textContent = state?.title || 'AI Video Dub';
  $('toggle').disabled = !state?.onVideo;
  $('toggle').textContent = state?.dub ? 'Stop dubbing' : 'Dub this video';
  $('toggle').classList.toggle('primary', !state?.dub);
  // Translating only: the subtitles without the voice. Dubbing translates too.
  $('translate').disabled = !state?.onVideo;
  $('translate').hidden = !!state?.dub;
  $('translate').textContent = state?.on ? 'Stop translating' : 'Translate';
  const { text, error } = state ? dubStatus(state) : { text: '' };
  $('status').textContent = state?.onVideo ? text : '';
  $('status').classList.toggle('error', !!error);
  let empty = '';
  if (!state?.onVideo) empty = 'Open a YouTube video. Its dubbed subtitles show here.';
  else if (!state.on) empty = state.error ? '' : 'Click "Translate" for translated subtitles, or "Dub this video" to hear them read too.';
  else if (!lines.length) empty = 'Loading captions...';
  $('empty').textContent = empty;
  $('empty').hidden = !empty;
  renderDocs();
  peekDoc();
}

$('toggle').addEventListener('click', () => send({ type: 'toggle' }));
$('translate').addEventListener('click', () => send({ type: 'translate' }));

// ---------- tabs ----------

function savedTab() {
  try {
    const saved = localStorage.getItem('panelTab');
    return ['summary', 'rewrite'].includes(saved) ? saved : 'subs';
  } catch {
    return 'subs';
  }
}

function showTab(name) {
  tab = name;
  try {
    localStorage.setItem('panelTab', name);
  } catch {}
  for (const button of document.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const pane of document.querySelectorAll('.pane')) pane.hidden = pane.id !== `pane-${name}`;
  // "Original" is about the subtitles only.
  $('original-label').hidden = name !== 'subs';
  if (name === 'subs') showCurrent();
  peekDoc();
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

// ---------- sentences ----------

function renderLines(next) {
  const box = $('lines');
  // A batch of translations replaces many rows at once. Unless the list is
  // following the voice, keep the row at the top where it was.
  const anchor = following() ? null : topRow();
  lines = next;
  current = -1;
  box.replaceChildren(...lines.map(lineRow));
  if (anchor) {
    const row = rowAt(anchor.start);
    if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
  }
}

function lineRow(x, i) {
  const row = document.createElement('div');
  row.className = 'line';
  row.dataset.i = i;
  // Translated to nothing: noise or filler the voice skips too.
  row.hidden = x.tr === '';
  row.classList.toggle('pending', x.tr == null);
  row.append(
    textEl('span', 'time', clock(x.start)),
    textEl('div', 'tr', x.tr ?? x.text),
    textEl('div', 'src', x.text),
  );
  row.addEventListener('click', () => send({ type: 'seek', time: x.start }));
  return row;
}

function setCurrent(i) {
  const box = $('lines');
  if (i === current && box.querySelector('.line.current')) return;
  box.querySelector('.line.current')?.classList.remove('current');
  current = i;
  const row = box.children[i];
  if (!row) return;
  row.classList.add('current');
  showCurrent('smooth');
}

function showCurrent(behavior = 'auto') {
  const row = $('lines').children[current];
  if (row && following()) row.scrollIntoView({ block: 'center', behavior });
}

// The first row showing at the top of the list, and how far down it is.
function topRow() {
  const box = $('lines');
  const top = box.getBoundingClientRect().top;
  for (const row of box.children) {
    if (row.hidden) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) return { start: lines[row.dataset.i].start, offset: rect.top - top };
  }
  return null;
}

// The row holding video time t: the last one starting at or before it.
function rowAt(t) {
  let found = null;
  for (const row of $('lines').children) {
    if (lines[row.dataset.i].start > t) break;
    if (!row.hidden) found = row;
  }
  return found;
}

function following() {
  return Date.now() - userScrolledAt > FOLLOW_PAUSE;
}

for (const type of ['wheel', 'touchmove']) {
  $('lines').addEventListener(type, () => (userScrolledAt = Date.now()), { passive: true });
}
// Dragging the scroll bar.
$('lines').addEventListener('mousedown', (event) => {
  if (event.target === $('lines')) userScrolledAt = Date.now();
});
window.addEventListener('resize', () => showCurrent());
window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScrolledAt = Date.now();
});

// ---------- summary and rewrite ----------

// Each is made only when its button is pressed. Opening its tab asks
// content.js once per video whether one is kept from before.
const DOC_TEXT = {
  summary: {
    run: 'Summarize',
    again: 'Summarize again',
    intro: 'Summarize this video in detail, about a tenth of its length. One AI request, up to a minute or two.',
    busy: 'Summarizing. This can take up to a minute or two...',
    none: 'Open a YouTube video to summarize it.',
  },
  rewrite: {
    run: 'Rewrite',
    again: 'Rewrite again',
    intro: 'Rewrite the subtitles as readable paragraphs: the same meaning, without filler words, repetition and false starts. One AI request per 5 minutes of video or so.',
    busy: 'Rewriting...',
    none: 'Open a YouTube video to rewrite its subtitles.',
  },
};
const shownDocs = {}; // kind -> the doc whose content is showing

function peekDoc() {
  if (!(tab in DOC_TEXT) || !port || !state?.onVideo) return;
  if (docs[tab]?.videoId === state.videoId || peeked[tab] === state.videoId) return;
  peeked[tab] = state.videoId;
  send({ type: 'doc', kind: tab, mode: 'peek' });
}

// This video's doc of a kind, or null.
function docFor(kind) {
  const videoId = state?.onVideo ? state.videoId : null;
  return videoId && docs[kind]?.videoId === videoId ? docs[kind] : null;
}

function renderDocs() {
  for (const kind of Object.keys(DOC_TEXT)) renderDoc(kind);
}

function renderDoc(kind) {
  const t = DOC_TEXT[kind];
  const doc = docFor(kind);
  const status = doc?.status || 'none';
  let note = '';
  if (status === 'loading') note = doc.progress?.total > 1 ? `${t.busy} ${doc.progress.done} of ${doc.progress.total} parts done.` : t.busy;
  else if (status === 'error') note = doc.error;
  const run = $(`${kind}-run`);
  run.hidden = !['idle', 'done', 'error'].includes(status);
  run.textContent = status === 'done' ? t.again : status === 'error' ? 'Try again' : t.run;
  run.classList.toggle('primary', status === 'idle');
  $(`${kind}-copy`).hidden = status !== 'done';
  if (kind === 'rewrite') {
    $('rewrite-epub').hidden = status !== 'done';
    $('rewrite-library').hidden = status !== 'done';
    if (status !== 'done') library.close();
  }
  $(`${kind}-status`).textContent = note;
  $(`${kind}-status`).classList.toggle('error', status === 'error');
  $(`${kind}-bar`).hidden = run.hidden && !note;
  let empty = '';
  if (!state?.onVideo) empty = t.none;
  else if (status === 'idle') empty = t.intro;
  $(`${kind}-empty`).textContent = empty;
  $(`${kind}-empty`).hidden = !empty;
  const shown = shownDocs[kind];
  if (doc === shown) return;
  shownDocs[kind] = doc;
  if (kind === 'rewrite') library.refresh();
  const data = doc && ['loading', 'done', 'error'].includes(status) ? doc.data : null;
  $(`${kind}-body`).replaceChildren(...(data ? (kind === 'summary' ? summaryNodes(data) : rewriteNodes(data, status)) : []));
  if (doc?.videoId !== shown?.videoId) $(`pane-${kind}`).scrollTop = 0;
}

for (const kind of Object.keys(DOC_TEXT)) {
  $(`${kind}-run`).addEventListener('click', () => {
    const doc = docFor(kind);
    send({ type: 'doc', kind, mode: doc?.status === 'done' ? 'again' : 'run' });
  });
  $(`${kind}-copy`).addEventListener('click', async () => {
    const doc = docFor(kind);
    if (doc?.status !== 'done') return;
    const button = $(`${kind}-copy`);
    try {
      await navigator.clipboard.writeText(docText(kind, doc.data));
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  });
}

// The rewrite as an e-book, named after the video, with its link and details.
$('rewrite-epub').addEventListener('click', () => {
  const doc = docFor('rewrite');
  if (doc?.status !== 'done') return;
  const meta = doc.meta || { title: state?.title, url: `https://www.youtube.com/watch?v=${state?.videoId}` };
  const title = meta.title || state?.title || 'YouTube video';
  const blob = makeEpub({ ...meta, title, paragraphs: doc.data.parts.flat() });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = epubFileName(title);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// The rewrite as a new chapter of a book in Fukurou Library, named after the video.
const library = FukurouLibrary.panel($('library'), {
  title: () => {
    const doc = docFor('rewrite');
    return doc?.meta?.title || state?.title || '';
  },
  paragraphs: () => {
    const doc = docFor('rewrite');
    return doc?.status === 'done' ? doc.data.parts.flat().filter(Boolean).map((p) => p.text) : [];
  },
  // The video's details, as in the EPUB's first page; the library shows them apart from the text.
  meta: () => {
    const doc = docFor('rewrite');
    if (!doc) return null;
    const m = doc.meta || { title: state?.title, url: `https://www.youtube.com/watch?v=${state?.videoId}` };
    return {
      Video: m.title,
      Channel: m.author,
      Published: m.published,
      Link: m.url,
      Captions: m.track,
      'AI model': m.model,
    };
  },
});
$('rewrite-library').addEventListener('click', () => library.toggle());

function summaryNodes(data) {
  const nodes = summaryParagraphs(data).map((p) => textEl('p', 'summary-para', p));
  if (data.partial) nodes.push(textEl('p', 'note', 'The video is very long, so this covers only its first part.'));
  return nodes;
}

function summaryParagraphs(data) {
  return (data.summary || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

// Parts not done yet show as "...".
function rewriteNodes(data, status) {
  const nodes = [];
  for (const part of data.parts || []) {
    if (!part) {
      nodes.push(textEl('p', 'para-pending', status === 'loading' ? '...' : '(not rewritten yet)'));
      continue;
    }
    for (const p of part) {
      const time = textEl('button', 'time', clock(p.start));
      time.type = 'button';
      time.title = 'Play from here';
      time.addEventListener('click', () => send({ type: 'seek', time: p.start }));
      const row = document.createElement('div');
      row.className = 'para';
      row.append(time, textEl('p', '', p.text));
      nodes.push(row);
    }
  }
  return nodes;
}

function docText(kind, data) {
  if (kind === 'rewrite') return data.parts.flat().map((p) => p.text).join('\n\n');
  return summaryParagraphs(data).join('\n\n');
}

// ---------- settings: original text and text size ----------

function applySettings() {
  document.body.classList.toggle('show-original', settings.subtitles === 'both');
  $('original').checked = settings.subtitles === 'both';
  const size = clampSize(settings.subtitleSize);
  document.body.style.setProperty('--text-size', `${Math.round(SUBTITLE_SIZES.px * size)}px`);
  $('smaller').disabled = size <= SUBTITLE_SIZES.min;
  $('larger').disabled = size >= SUBTITLE_SIZES.max;
  // Rows changed height, so the current one moved.
  showCurrent();
}

function clampSize(size) {
  return Math.min(SUBTITLE_SIZES.max, Math.max(SUBTITLE_SIZES.min, Number(size) || 1));
}

function resize(steps) {
  const size = clampSize(settings.subtitleSize) + steps * SUBTITLE_SIZES.step;
  chrome.storage.local.set({ subtitleSize: Math.round(clampSize(size) * 10) / 10 });
}

$('smaller').addEventListener('click', () => resize(-1));
$('larger').addEventListener('click', () => resize(1));
$('original').addEventListener('change', () => {
  chrome.storage.local.set({ subtitles: $('original').checked ? 'both' : 'translation' });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !('subtitles' in changes || 'subtitleSize' in changes)) return;
  settings = await getSettings();
  applySettings();
});

// ---------- font ----------

// Chosen here from the fonts installed on the computer, or by name in the
// settings ("Other font...").
let font = { panelFont: 'default', panelFontName: '' };
let fontSeq = 0;

async function loadFont() {
  const { panelFont, panelFontName } = await getSettings();
  font = { panelFont, panelFontName };
  const seq = ++fontSeq;
  const { stack } = await panelFontInfo(font);
  if (seq !== fontSeq) return;
  document.body.style.setProperty('--text-font', stack ? `${stack}, system-ui, sans-serif` : 'inherit');
  renderFonts(seq);
}

// Fonts that aren't installed are listed (so they can be installed) but
// can't be chosen. A font that comes in weights lists the installed ones, or
// its name once if none is.
async function renderFonts(seq = fontSeq) {
  const checked = await Promise.all(
    PANEL_FONTS.map(async (f) => ({ f, ok: (await panelFontInfo({ panelFont: f.id })).installed })),
  );
  const custom = font.panelFontName.trim();
  const customOk = custom && (await panelFontInfo({ panelFont: 'other', panelFontName: custom })).installed;
  if (seq !== fontSeq) return;
  const option = (label, value, ok) => {
    const o = new Option(ok ? label : `${label} (not installed)`, value);
    o.disabled = !ok && value !== font.panelFont;
    return o;
  };
  const list = [];
  const families = new Set();
  for (const { f, ok } of checked) {
    if (!f.family) {
      list.push(option(f.name, f.id, ok));
      continue;
    }
    if (families.has(f.family)) continue;
    families.add(f.family);
    const shown = checked.filter((c) => c.f.family === f.family && (c.ok || c.f.id === font.panelFont));
    if (shown.length) list.push(...shown.map((c) => option(c.f.name, c.f.id, c.ok)));
    else list.push(option(f.family, f.id, false));
  }
  if (custom) list.push(option(custom, 'other', customOk));
  list.push(new Option('Other font...', 'more'));
  $('font').replaceChildren(...list);
  $('font').value = font.panelFont === 'other' && !custom ? 'default' : font.panelFont;
  // A font no longer in the list.
  if ($('font').selectedIndex < 0) $('font').value = 'default';
}

$('font').addEventListener('change', () => {
  const value = $('font').value;
  if (value !== 'more') return chrome.storage.local.set({ panelFont: value });
  renderFonts();
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#font') });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('panelFont' in changes || 'panelFontName' in changes)) loadFont();
});
loadFont();

// ---------- helpers ----------

function textEl(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
