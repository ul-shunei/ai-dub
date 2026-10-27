# AI Video Dub

A Chrome extension that dubs YouTube videos. It reads the video's captions, translates them with an AI model (Claude by default), reads the translation aloud with an Azure Speech voice, and keeps the voice in time with the video.

## What you need

- An AI API key: Anthropic (default model `claude-sonnet-5-5`), or any OpenAI-compatible service.
- An Azure Speech resource: its key and region, from the resource's "Keys and Endpoint" page in the Azure portal.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open the extension's **Settings**, fill in the AI key and the Azure region and key, then click **Save**. Chrome asks for access to those two services; allow it.
4. Optional: click **Load voices** to choose a different voice, and **Play sample** to hear it.
5. Reload any YouTube tabs that were already open.

## Use

Open a YouTube video and do any of these:
- click the speech-bubble button in the player's control bar;
- open the extension popup and click **Dub this video**;
- press **Alt+Shift+D**.

Dubbing stays on for the next video until you turn it off. The popup shows translation progress and lets you change the language.

## How it works

1. **Captions.** The extension reads the video's caption list from the player. It prefers English captions (human-made, then auto-generated), then captions in the spoken language. YouTube often rejects caption downloads that lack a token the player adds itself. When that happens, the extension briefly switches the player to the chosen captions so the player fetches them, reuses that file, and puts your caption setting back. Captions YouTube auto-translated (for example if your player is set to auto-translate into another language) are never used as the source unless nothing else works.
2. **Fragments.** Captions are cut into short timed fragments (a few seconds each) at punctuation and pauses.
3. **Translation.** If "Video notes" is on, the AI first reads the title, description and start of the transcript and writes a short summary and glossary. Fragments are then translated in batches of up to 40, each with the notes and the neighboring text as context. The AI joins the fragments of each batch back into complete sentences (auto-generated captions have little punctuation) and translates each sentence as a whole, so the voice reads full sentences instead of pieces. Batches end where a sentence most likely ends, so a sentence is never split between two batches. Translation starts at the current playback position. Results are cached for the last 30 videos, so watching again costs nothing.
4. **Voice.** About 40 seconds ahead of playback, each translated sentence is sent to Azure Speech (MP3, 2 requests at a time).
5. **Sync.** Each sentence starts at the caption time of its first fragment.
   - Every sentence plays at the same reading speed, so the pace stays steady.
   - If a sentence is too long for its slot, the video pauses briefly until the voice finishes. You can turn this off in Settings; the voice then runs late and sentences it can't reach in time are skipped.
   - The original audio is lowered while dubbing (default 20%) and restored when you stop.
   - Seeking, pausing and ads are handled: the voice stops during ads and picks up at the right line after a seek.
6. **Sponsor skipping.** On every video, dubbing or not, the extension looks up sponsor segments on [SponsorBlock](https://sponsor.ajay.app), a community database of segment times. Only the first 4 hex digits of the video ID's SHA-256 hash are sent, so the server sees a bucket shared by many videos. When playback reaches a segment it jumps to its end and shows "Skipped sponsor (45s)". Each segment is skipped once; seeking into its middle lets it play, and going back before it arms it again. If SponsorBlock has no sponsor segment for the video and you are dubbing, the AI marks sponsor-read sentences while translating, and runs of at least 8 seconds are skipped the same way ("found by AI").

## Settings

| Setting | Default | Notes |
|---|---|---|
| AI service, base URL, key, model | Anthropic, `claude-sonnet-5-5` | Same options as the AI Context Translate extension |
| Dub into | Simplified Chinese | 17 languages, each with a default Azure voice |
| Video notes | on | One extra AI request per video |
| Azure region / key | `eastus` / empty | Leave "Custom endpoint" empty. If the portal's `https://<region>.api.cognitive.microsoft.com/` endpoint is pasted, it is converted to the speech host automatically. Only Azure China or a private speech host needs a value |
| Voice | Language default | Saved per language |
| Reading speed (also in popup) | 1.0x | 0.5x to 2.0x. Azure generates the voice at this speed and every sentence plays at it. Changing it while dubbing remakes the voice clips, keeping the translations |
| Pause video to stay in sync | on | |
| Original audio while dubbing | 20% | |
| Subtitles | Translation | Translation, translation and original, or off. YouTube's own captions are hidden while ours show |
| Subtitle position | Top | Top or bottom of the video. Changes apply right away |
| Subtitle size (popup) | 100% | 50% to 200% of the default size, which follows the player size. Applies right away |
| Skip sponsors / self-promotion / subscribe reminders | on / off / off | SponsorBlock categories to jump over, with or without dubbing. Sponsors can also be toggled in the popup |
| Let the AI find sponsor reads | on | Only while dubbing, only when SponsorBlock has no sponsor segment for the video. No extra AI requests |

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Content scripts run only on `www.youtube.com` |
| `inject.js` | Runs in YouTube's page context. Records the player's caption requests, reads the caption list and downloads caption files |
| `transcript.js` | Pure helpers: caption parsing (json3, srv3, srv1), fragment building, sentence-aware batching, track choice |
| `content.js` | Runs the dub: transcript, translation queue, voice prefetch, sync loop, subtitles, player button |
| `content.css` | Subtitle, status badge and button styles |
| `background.js` | Service worker: AI calls (with retries and batch splitting), Azure Speech synthesis and voice list, SponsorBlock lookup |
| `shared.js` | Languages and default voices, AI presets, default settings |
| `popup.*`, `options.*`, `ui.css` | Toolbar popup and settings page |
| `icons/` | `icon.svg` and the PNG sizes made from it |

## Limits

- Videos without any captions can't be dubbed. That would need speech-to-text, which this doesn't do.
- YouTube changes its page and player often. The parts most likely to break are reading the caption list (`getPlayerResponse`) and the caption download in `inject.js`.
- The Azure free tier allows only a few requests per minute. On busy videos the extension retries after the rate limit, and the video may pause while it waits. A paid (S0) resource avoids this.
- Desktop `www.youtube.com` only: no embedded players, Shorts or `m.youtube.com`.
- Keys are stored in this browser's extension storage, unencrypted.
