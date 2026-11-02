// The dub's subtitles for the active tab: every sentence of the video, with
// the one being read marked and kept in view. Clicking a sentence plays the
// video from there. content.js in the YouTube tab does the work; this
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

init();

async function init() {
  settings = await getSettings();
  applySettings();
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
    $('lines').replaceChildren();
    render();
  });
}

function onMessage(msg) {
  if (msg.type !== 'update') return;
  if (msg.state) state = msg.state;
  if (msg.lines) renderLines(msg.lines);
  if ('current' in msg) setCurrent(msg.current);
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
  $('toggle').textContent = state?.on ? 'Stop dubbing' : 'Dub this video';
  $('toggle').classList.toggle('primary', !state?.on);
  const { text, error } = state ? dubStatus(state) : { text: '' };
  $('status').textContent = state?.onVideo ? text : '';
  $('status').classList.toggle('error', !!error);
  let empty = '';
  if (!state?.onVideo) empty = 'Open a YouTube video. Its dubbed subtitles show here.';
  else if (!state.on) empty = state.error ? '' : 'Click "Dub this video" to start. The subtitles show here.';
  else if (!lines.length) empty = 'Loading captions...';
  $('empty').textContent = empty;
  $('empty').hidden = !empty;
}

$('toggle').addEventListener('click', () => send({ type: 'toggle' }));

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
