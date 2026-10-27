const $ = (id) => document.getElementById(id);

let tabId = null;
let state = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const settings = await getSettings();

  for (const lang of LANGUAGES) $('lang').add(new Option(lang.name, lang.name));
  $('lang').value = settings.targetLang;
  $('subtitleSize').value = settings.subtitleSize;
  showSubtitleSize();
  $('speechRate').value = settings.speechRate;
  showSpeechRate();
  $('skipSponsor').checked = settings.skipSponsor;

  if (!settings.apiKey || !settings.azureKey) {
    $('toggle').disabled = true;
    setStatus('Add your AI key and Azure Speech key in Settings first.', true);
    return;
  }
  if (!/^https:\/\/www\.youtube\.com\//.test(tab?.url || '')) {
    $('toggle').disabled = true;
    setStatus('Open a YouTube video to use this.');
    return;
  }
  await refresh();
  setInterval(refresh, 1000);
}

async function refresh() {
  try {
    state = await chrome.tabs.sendMessage(tabId, { type: 'getState' });
  } catch {
    $('toggle').disabled = true;
    setStatus('Reload this YouTube tab once so the extension can attach to it.', true);
    return;
  }
  render();
}

$('toggle').addEventListener('click', async () => {
  try {
    state = await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch {
    setStatus('Reload this YouTube tab once so the extension can attach to it.', true);
    return;
  }
  render();
});

$('lang').addEventListener('change', async () => {
  // The YouTube tab restarts the dub itself when the language changes.
  await chrome.storage.local.set({ targetLang: $('lang').value });
});

// The YouTube tab resizes its subtitles as soon as this is saved.
$('subtitleSize').addEventListener('input', () => {
  showSubtitleSize();
  chrome.storage.local.set({ subtitleSize: Number($('subtitleSize').value) });
});

function showSubtitleSize() {
  $('subtitleSizeValue').textContent = `${Math.round($('subtitleSize').value * 100)}%`;
}

// Saved on release only: each change makes the tab remake its voice clips.
$('speechRate').addEventListener('input', showSpeechRate);
$('speechRate').addEventListener('change', () => {
  chrome.storage.local.set({ speechRate: Number($('speechRate').value) });
});

// The YouTube tab reloads its sponsor segments as soon as this is saved.
$('skipSponsor').addEventListener('change', () => {
  chrome.storage.local.set({ skipSponsor: $('skipSponsor').checked });
});

function showSpeechRate() {
  $('speechRateValue').textContent = `${Number($('speechRate').value).toFixed(1)}x`;
}

$('settings').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

function render() {
  if (!state) return;
  $('toggle').disabled = !state.onVideo;
  $('toggle').textContent = state.on ? 'Stop dubbing' : 'Dub this video';
  if (!state.onVideo) return setStatus('Open a video to use this.');
  if (state.error) return setStatus(state.error, true);
  if (!state.on) return setStatus('');
  if (state.phase === 'loading') return setStatus('Loading captions...');
  const from = state.track ? `From: ${state.track}. ` : '';
  setStatus(
    state.translated < state.total
      ? `${from}Translated ${state.translated} of ${state.total} lines...`
      : `${from}All ${state.total} lines translated.`,
  );
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}
