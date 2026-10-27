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
  // Pause the video while the voice catches up.
  holdVideo: true,
  // Jump over these SponsorBlock segment types (see SPONSOR_CATEGORIES).
  skipSponsor: true,
  skipSelfPromo: false,
  skipInteraction: false,
  // While dubbing, let the AI mark sponsor reads when SponsorBlock has none.
  aiSponsors: true,
  // YouTube's own audio level while dubbing, 0..1.
  originalVolume: 0.2,
  // 'translation', 'both' or 'off'.
  subtitles: 'translation',
  // 'top' or 'bottom' of the video.
  subtitlePosition: 'top',
  // Subtitle text size relative to the default (which scales with the player).
  subtitleSize: 1,
};

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
