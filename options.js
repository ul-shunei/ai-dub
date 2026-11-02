const $ = (id) => document.getElementById(id);
const CLAUDE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

let voiceByLang = {};
let voices = []; // from Azure, once loaded

init();

async function init() {
  for (const [key, preset] of Object.entries(PRESETS)) $('preset').add(new Option(preset.label, key));
  for (const lang of LANGUAGES) $('targetLang').add(new Option(lang.name, lang.name));

  const settings = await getSettings();
  for (const key of ['preset', 'baseUrl', 'apiKey', 'model', 'targetLang', 'azureRegion', 'azureKey', 'azureEndpoint']) {
    $(key).value = settings[key];
  }
  $('subtitles').value = settings.subtitles === 'both' ? 'both' : 'translation';
  $('videoNotes').checked = settings.videoNotes;
  $('holdVideo').checked = settings.holdVideo;
  for (const key of ['skipSponsor', 'skipSelfPromo', 'skipInteraction', 'aiSponsors']) $(key).checked = settings[key];
  $('speechRate').value = settings.speechRate;
  $('originalVolume').value = Math.round(settings.originalVolume * 100);
  voiceByLang = { ...settings.voiceByLang };
  for (const f of PANEL_FONTS) $('panelFont').add(new Option(f.name, f.id));
  $('panelFont').add(new Option('Other (type its name)', 'other'));
  $('panelFont').value = settings.panelFont;
  if ($('panelFont').selectedIndex < 0) $('panelFont').value = 'default';
  $('panelFontName').value = settings.panelFontName;
  showFont();
  updateModelList();
  updateRanges();
  renderVoices();
  // The side panel's "Other font..." opens options.html#font.
  if (location.hash === '#font') {
    $('fontSection').scrollIntoView({ block: 'start' });
    $('panelFont').value = 'other';
    showFont();
    $('panelFontName').focus();
  }
}

$('preset').addEventListener('change', () => {
  const preset = PRESETS[$('preset').value];
  $('baseUrl').value = preset.baseUrl;
  $('model').value = preset.model;
  updateModelList();
});

$('targetLang').addEventListener('change', renderVoices);
$('voice').addEventListener('change', () => {
  voiceByLang[$('targetLang').value] = $('voice').value;
});
$('speechRate').addEventListener('input', updateRanges);
$('panelFont').addEventListener('change', showFont);
$('panelFontName').addEventListener('input', showFont);
$('originalVolume').addEventListener('input', updateRanges);

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!(await requestHostAccess())) return;
  await chrome.storage.local.set(readForm());
  setStatus('Saved.');
});

$('test').addEventListener('click', async () => {
  if (!$('form').reportValidity() || !(await requestHostAccess())) return;
  setStatus('Testing translation...');
  const res = await chrome.runtime.sendMessage({ type: 'test', settings: readForm() });
  if (res?.ok) setStatus(`Works: "${res.result}"`);
  else setStatus(res?.error || 'Test failed', true);
});

$('loadVoices').addEventListener('click', async () => {
  if (!checkAzureFields() || !(await requestHostAccess())) return;
  setStatus('Loading voices...');
  const res = await chrome.runtime.sendMessage({ type: 'voices', settings: readForm() });
  if (!res?.ok) return setStatus(res?.error || 'Could not load voices', true);
  voices = res.result;
  renderVoices();
  setStatus(`Loaded ${voices.length} voices.`);
});

$('sample').addEventListener('click', async () => {
  if (!checkAzureFields() || !(await requestHostAccess())) return;
  setStatus('Synthesizing sample...');
  const res = await chrome.runtime.sendMessage({ type: 'testVoice', settings: readForm() });
  if (!res?.ok) return setStatus(res?.error || 'Voice test failed', true);
  const bytes = Uint8Array.from(atob(res.result.audio), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: res.result.mime }));
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
  setStatus('Playing sample.');
});

// Voices for the chosen language: its own locale first, then multilingual
// voices that can also speak it.
function renderVoices() {
  const lang = langInfo($('targetLang').value);
  const chosen = voiceByLang[lang.name] || lang.voice;
  const select = $('voice');
  select.replaceChildren();
  const native = voices.filter((v) => v.locale === lang.locale);
  const multi = voices.filter((v) => v.locale !== lang.locale && v.secondary.includes(lang.locale));
  const option = (v) => new Option(`${v.label} (${v.gender}, ${v.name})`, v.name);
  if (!native.some((v) => v.name === chosen) && !multi.some((v) => v.name === chosen)) {
    select.add(new Option(voices.length ? chosen : `${chosen} (press Load voices to see all)`, chosen));
  }
  native.forEach((v) => select.add(option(v)));
  if (multi.length) {
    const group = document.createElement('optgroup');
    group.label = 'Multilingual voices';
    multi.forEach((v) => group.appendChild(option(v)));
    select.add(group);
  }
  select.value = chosen;
}

function readForm() {
  return {
    preset: $('preset').value,
    provider: PRESETS[$('preset').value].provider,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    targetLang: $('targetLang').value,
    videoNotes: $('videoNotes').checked,
    azureRegion: $('azureRegion').value.trim(),
    azureKey: $('azureKey').value.trim(),
    azureEndpoint: $('azureEndpoint').value.trim(),
    voiceByLang: { ...voiceByLang },
    speechRate: Number($('speechRate').value),
    holdVideo: $('holdVideo').checked,
    skipSponsor: $('skipSponsor').checked,
    skipSelfPromo: $('skipSelfPromo').checked,
    skipInteraction: $('skipInteraction').checked,
    aiSponsors: $('aiSponsors').checked,
    originalVolume: Number($('originalVolume').value) / 100,
    subtitles: $('subtitles').value,
    panelFont: $('panelFont').value,
    panelFontName: $('panelFontName').value.trim(),
  };
}

// ---------- subtitle font ----------

let fontSeq = 0;

async function showFont() {
  const seq = ++fontSeq;
  const other = $('panelFont').value === 'other';
  $('panelFontNameRow').hidden = !other;
  const { stack, installed } = await panelFontInfo({ panelFont: $('panelFont').value, panelFontName: $('panelFontName').value });
  if (seq !== fontSeq) return;
  $('fontPreview').style.fontFamily = stack ? `${stack}, system-ui, sans-serif` : '';
  const preset = PANEL_FONTS.find((f) => f.id === $('panelFont').value);
  const name = other ? $('panelFontName').value.trim() : preset?.name;
  const size = 'The text size is changed with A− and A+ in the side panel, or in the popup.';
  if (other && !name) $('fontHint').textContent = 'Type the font\'s name as Windows (or macOS) lists it, for example 仓耳今楷04 W03.';
  else if (!installed) $('fontHint').textContent = `${name} is not installed on this computer, so the side panel uses the default font. Install it (a font that a website only uses on its own pages is not installed), then reopen the side panel.`;
  else if (preset?.family) $('fontHint').textContent = `${preset.family} comes in weights from W01, the thinnest, to W05, the boldest. ${size}`;
  else $('fontHint').textContent = size;
}

function checkAzureFields() {
  if ($('azureKey').value.trim() && ($('azureRegion').value.trim() || $('azureEndpoint').value.trim())) return true;
  setStatus('Fill in the Azure region and key first.', true);
  return false;
}

// The service worker needs host access to the AI and Azure origins. Must be
// called before any other await so it still counts as part of the click.
async function requestHostAccess() {
  const origins = [];
  try {
    origins.push(`${new URL($('baseUrl').value.trim()).origin}/*`);
  } catch {
    setStatus('API base URL is not a valid URL.', true);
    return false;
  }
  try {
    origins.push(`${new URL(azureBase(readForm())).origin}/*`);
  } catch {
    setStatus('Azure region or endpoint is not valid.', true);
    return false;
  }
  const granted = await chrome.permissions.request({ origins });
  if (!granted) setStatus('Access to the AI and Azure addresses is needed to call them.', true);
  return granted;
}

function updateModelList() {
  const models = PRESETS[$('preset').value].provider === 'anthropic' ? CLAUDE_MODELS : [];
  $('models').replaceChildren(...models.map((m) => new Option(m, m)));
}

function updateRanges() {
  $('speechRateValue').textContent = `${Number($('speechRate').value).toFixed(1)}x`;
  $('originalVolumeValue').textContent = `${$('originalVolume').value}%`;
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}
