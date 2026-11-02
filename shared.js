// Loaded by background.js (importScripts), popup.html, options.html and the
// YouTube content script.

// locale: Azure Speech locale. voice: default Azure neural voice.
// sample: sentence for the "Play sample" button in settings.
const LANGUAGES = [
  { name: 'Simplified Chinese', locale: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural', sample: '你好，这是配音声音的示例。' },
  { name: 'Traditional Chinese', locale: 'zh-TW', voice: 'zh-TW-HsiaoChenNeural', sample: '你好，這是配音聲音的範例。' },
  { name: 'English', locale: 'en-US', voice: 'en-US-JennyNeural', sample: 'Hello, this is a sample of the dubbing voice.' },
  { name: 'Japanese', locale: 'ja-JP', voice: 'ja-JP-NanamiNeural', sample: 'こんにちは、これは吹き替え音声のサンプルです。' },
  { name: 'Korean', locale: 'ko-KR', voice: 'ko-KR-SunHiNeural', sample: '안녕하세요, 더빙 음성 샘플입니다.' },
  { name: 'Spanish', locale: 'es-ES', voice: 'es-ES-ElviraNeural', sample: 'Hola, esta es una muestra de la voz de doblaje.' },
  { name: 'French', locale: 'fr-FR', voice: 'fr-FR-DeniseNeural', sample: 'Bonjour, voici un exemple de la voix de doublage.' },
  { name: 'German', locale: 'de-DE', voice: 'de-DE-KatjaNeural', sample: 'Hallo, das ist ein Beispiel für die Synchronstimme.' },
  { name: 'Portuguese', locale: 'pt-BR', voice: 'pt-BR-FranciscaNeural', sample: 'Olá, este é um exemplo da voz de dublagem.' },
  { name: 'Italian', locale: 'it-IT', voice: 'it-IT-ElsaNeural', sample: 'Ciao, questo è un esempio della voce di doppiaggio.' },
  { name: 'Russian', locale: 'ru-RU', voice: 'ru-RU-SvetlanaNeural', sample: 'Здравствуйте, это пример голоса для озвучки.' },
  { name: 'Vietnamese', locale: 'vi-VN', voice: 'vi-VN-HoaiMyNeural', sample: 'Xin chào, đây là mẫu giọng lồng tiếng.' },
  { name: 'Thai', locale: 'th-TH', voice: 'th-TH-PremwadeeNeural', sample: 'สวัสดี นี่คือตัวอย่างเสียงพากย์' },
  { name: 'Indonesian', locale: 'id-ID', voice: 'id-ID-GadisNeural', sample: 'Halo, ini contoh suara sulih suara.' },
  { name: 'Arabic', locale: 'ar-SA', voice: 'ar-SA-ZariyahNeural', sample: 'مرحبًا، هذا نموذج لصوت الدبلجة.' },
  { name: 'Hindi', locale: 'hi-IN', voice: 'hi-IN-SwaraNeural', sample: 'नमस्ते, यह डबिंग आवाज़ का एक नमूना है।' },
  { name: 'Turkish', locale: 'tr-TR', voice: 'tr-TR-EmelNeural', sample: 'Merhaba, bu dublaj sesinin bir örneğidir.' },
];

// provider "anthropic" uses the Claude Messages API; "openai" uses any
// OpenAI-compatible /chat/completions endpoint.
const PRESETS = {
  anthropic: { label: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  deepseek: { label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  custom: { label: 'Other OpenAI-compatible service', provider: 'openai', baseUrl: '', model: '' },
};

const DEFAULT_SETTINGS = {
  preset: 'anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: '',
  model: 'claude-sonnet-5-5',
  targetLang: 'Simplified Chinese',
  // Ask the model for a short summary + glossary of the video first and send
  // it with every batch so names and terms stay consistent.
  videoNotes: true,
  azureRegion: 'eastus',
  azureKey: '',
  // Optional, e.g. https://chinaeast2.tts.speech.azure.cn. Empty means
  // https://<region>.tts.speech.microsoft.com.
  azureEndpoint: '',
  // Chosen voice per target language name. Missing means the language default.
  voiceByLang: {},
  // Voice speed Azure synthesizes at, 0.5..2 (1 = the voice's normal pace).
  // Every sentence plays at exactly this speed.
  speechRate: 1,
  // Pause the video when the voice is more than 5 seconds behind.
  holdVideo: true,
  // Jump over these SponsorBlock segment types (see SPONSOR_CATEGORIES).
  skipSponsor: true,
  skipSelfPromo: false,
  skipInteraction: false,
  // While dubbing, let the AI mark sponsor reads when SponsorBlock has none.
  aiSponsors: true,
  // YouTube's own audio level while dubbing, 0..1.
  originalVolume: 0.2,
  // Subtitles in the side panel: 'translation', or 'both' to add the original.
  subtitles: 'translation',
  // Side panel text size relative to the default, SUBTITLE_SIZES.min..max.
  subtitleSize: 1,
  // The side panel's font: an id from PANEL_FONTS, or 'other' for
  // panelFontName.
  panelFont: 'default',
  panelFontName: '',
};

const SUBTITLE_SIZES = { min: 0.7, max: 2, step: 0.1, px: 16 };

// Fonts for the side panel's text. A font must be installed on the computer;
// Chrome finds it by any of the family names listed (fonts register different
// names in Chinese and English, and on Windows and Mac).
//
// Tsanger's 今楷 fonts come in five weights, W01 (the thinnest) to W05 (the
// boldest), as five files that share one family name and all claim the
// normal weight. By that family name Chrome picks the boldest, and by names
// like "仓耳今楷04 W03" it finds only some of them, so each weight is loaded
// by its own full name instead (local() in a FontFace, see panelFontInfo).
// `family` groups the weights in the side panel's list.
const TSANGER_WEIGHTS = ['W01', 'W02', 'W03', 'W04', 'W05'];
const tsangerFonts = (n) =>
  TSANGER_WEIGHTS.map((w) => ({
    id: `jinkai${n}-${w.toLowerCase()}`,
    name: `仓耳今楷${n} ${w}`,
    family: `仓耳今楷${n}`,
    local: [`TsangerJinKai${n}-${w}`, `仓耳今楷${n} ${w}`, `TsangerJinKai${n} ${w}`],
  }));

const PANEL_FONTS = [
  { id: 'default', name: 'Default', stack: '' },
  { id: 'source-han-serif', name: '思源宋体', stack: '"Source Han Serif SC", "Source Han Serif CN", "Noto Serif SC", "Noto Serif CJK SC", "思源宋体"' },
  { id: 'source-han-sans', name: '思源黑体', stack: '"Source Han Sans SC", "Source Han Sans CN", "Noto Sans SC", "Noto Sans CJK SC", "思源黑体"' },
  { id: 'yahei', name: '微软雅黑', stack: '"Microsoft YaHei", "微软雅黑"' },
  { id: 'song', name: '宋体', stack: '"SimSun", "宋体", "Songti SC", "STSong"' },
  { id: 'kai', name: '楷体', stack: '"KaiTi", "楷体", "STKaiti", "Kaiti SC"' },
  { id: 'fangsong', name: '仿宋', stack: '"FangSong", "仿宋", "STFangsong"' },
  { id: 'wenkai', name: '霞鹜文楷', stack: '"LXGW WenKai", "LXGW WenKai Screen", "霞鹜文楷", "霞鹜文楷 屏幕阅读版"' },
  ...tsangerFonts('04'),
  ...tsangerFonts('05'),
];

// The chosen font as { stack, installed }: the CSS font-family list ('' for
// the default) and whether the font is on this computer. Fonts loaded by
// their full names are registered in this page as "AI Dub <id>". A name
// typed in the settings is tried as a family name and as a full name.
async function panelFontInfo(settings) {
  if (settings.panelFont === 'other') {
    const name = (settings.panelFontName || '').replace(/["\\;{}]/g, '').trim();
    if (!name) return { stack: '', installed: true };
    const family = `AI Dub ${name}`;
    const byFullName = await loadPanelFace(family, [name]);
    return { stack: `"${name}", "${family}"`, installed: byFullName || fontInstalled(`"${name}"`) };
  }
  const preset = PANEL_FONTS.find((f) => f.id === settings.panelFont);
  if (preset?.local) {
    const family = `AI Dub ${preset.id}`;
    return { stack: `"${family}"`, installed: await loadPanelFace(family, preset.local) };
  }
  const stack = preset?.stack || '';
  return { stack, installed: fontInstalled(stack) };
}

// Loads an installed font by its full (or PostScript) names into this page as
// `family`. Resolves to whether it was found.
const panelFaces = new Map();
function loadPanelFace(family, names) {
  if (!panelFaces.has(family)) {
    const face = new FontFace(family, names.map((n) => `local("${n}")`).join(', '));
    const found = face.load().then(
      () => (document.fonts.add(face), true),
      () => false,
    );
    panelFaces.set(family, found);
  }
  return panelFaces.get(family);
}

// Whether a font in a font-family list is installed: text drawn with it has
// a different width than with the generic font alone. (CSS can't tell: a
// missing font just falls back.)
function fontInstalled(stack) {
  if (!stack) return true;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  const sample = '春眠不觉晓，处处闻啼鸟 The quick brown fox 0123';
  return ['monospace', 'serif'].some((base) => {
    ctx.font = `40px ${base}`;
    const plain = ctx.measureText(sample).width;
    ctx.font = `40px ${stack}, ${base}`;
    return ctx.measureText(sample).width !== plain;
  });
}

// Setting key -> SponsorBlock category, with the name shown when skipping.
const SPONSOR_CATEGORIES = [
  { key: 'skipSponsor', category: 'sponsor', label: 'sponsor' },
  { key: 'skipSelfPromo', category: 'selfpromo', label: 'self-promotion' },
  { key: 'skipInteraction', category: 'interaction', label: 'subscribe reminder' },
];

function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

function langInfo(name) {
  return LANGUAGES.find((lang) => lang.name === name) || LANGUAGES[0];
}

function voiceFor(settings) {
  return settings.voiceByLang?.[settings.targetLang] || langInfo(settings.targetLang).voice;
}

function azureBase(settings) {
  const custom = settings.azureEndpoint?.trim().replace(/\/+$/, '');
  if (custom) {
    // The portal shows the general Cognitive Services endpoint, but speech
    // synthesis lives on its own host.
    const regional = custom.match(/^https:\/\/([a-z0-9]+)\.api\.cognitive\.microsoft\.com$/i);
    if (regional) return `https://${regional[1].toLowerCase()}.tts.speech.microsoft.com`;
    // Resources with a custom subdomain serve speech synthesis under /tts.
    if (/^https:\/\/[^/]+\.cognitiveservices\.azure\.com$/i.test(custom)) return `${custom}/tts`;
    return custom;
  }
  return `https://${settings.azureRegion.trim().toLowerCase()}.tts.speech.microsoft.com`;
}

// One line on how the dub in a tab is going, from content.js's state().
function dubStatus(state) {
  if (!state.onVideo) return { text: 'Open a video to use this.' };
  if (state.error) return { text: state.error, error: true };
  if (!state.on) return { text: '' };
  if (state.phase === 'loading') return { text: 'Loading captions...' };
  const from = state.track ? `From: ${state.track}. ` : '';
  return {
    text:
      state.translated < state.total
        ? `${from}Translated ${state.translated} of ${state.total} lines...`
        : `${from}All ${state.total} lines translated.`,
  };
}
