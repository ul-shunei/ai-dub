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

To read the translated subtitles without the voice, press **Translate** in the side panel instead. It needs only the AI key, not the Azure Speech key. Pressing **Dub this video** later adds the voice from where the video is, keeping the translation done so far.

Nothing is translated until you press one of these buttons. Translating and dubbing are for the video you turned them on for: when you move to another video they turn off. The popup shows translation progress and lets you change the language.

### Subtitles in the side panel

The subtitles show in Chrome's side panel, not on the video, so nothing covers the picture. Starting the dub from the player button, the popup or the shortcut opens the panel. If you close it, open it again with **Show subtitles** in the popup.

- Every sentence of the video is listed with its time. The sentence being read is highlighted and kept in view. While the voice is quiet, the sentence at the playhead is highlighted.
- Click a sentence to play the video from there.
- Sentences not translated yet show the original in grey until their translation arrives.
- Scrolling the list by hand stops it following the voice for 5 seconds.
- **Original** adds the original sentence under each translation. **A−** / **A+** change the text size. Both are saved.
- The font list next to **A−** sets the subtitles' font (saved). It has fonts often used for Chinese text (思源宋体, 思源黑体, 微软雅黑, 宋体, 楷体, 仿宋, 霞鹜文楷, 仓耳今楷04 and 05); those not installed on this computer are marked "(not installed)" and can't be chosen. 仓耳今楷 comes in five weights, W01 (the thinnest) to W05 (the boldest), each its own file; the list shows each weight that is installed. **Other font...** opens the settings, where any installed font can be named. A font must be installed on the computer: a font that a site downloads for its own pages is not.
- **Translate** / **Stop translating** translates the subtitles without the voice; YouTube's audio stays at its own volume. It is hidden while dubbing, since dubbing translates too.
- **Dub this video** / **Stop dubbing** in the panel works like the player button. **Stop dubbing** stops the translation as well.
- YouTube's own captions are hidden while translating or dubbing.
- The panel follows the active tab. On other tabs it says to open a YouTube video.

### Summary and Rewrite tabs

Next to **Subtitles**, the side panel has two more tabs. Both are written in the dub language and work whether or not you are dubbing. Neither asks the AI until you press its button.

**Summary** summarizes the whole video.

- Press **Summarize**. It takes one AI request, up to a minute or two.
- The summary follows the video from start to end, in paragraphs, about 10% to 15% of the subtitles' length (counted in characters for Chinese and Japanese, words otherwise). Intros, outros and sponsor reads are left out.
- Very long videos (over about 3.5 hours) are summarized from their first part only, and the tab says so.

**Rewrite** turns the subtitles into text that reads like an article.

- Press **Rewrite**. The video is rewritten in parts of about 5 minutes (one AI request each, two at a time). Each part shows as soon as it's done, and the bar shows how many are done.
- The meaning is kept: every point, fact, number, name and example stays, nothing is added or summarized. Filler words, hesitations, repetition, false starts and needless particles are removed, and the sentences are grouped into paragraphs. Sponsor reads and "like and subscribe" reminders are left out.
- Each paragraph shows the time it starts at. Click the time to play the video from there.
- If a part fails, the finished parts stay; **Try again** does only the missing ones.
- **Download EPUB** saves the rewrite as an e-book, named after the video (for example `My video title.epub`). The book's title is the video title. The first page lists the channel, the video link, the publish date, the captions it was made from, the date it was made and the AI model, with a note that the AI may have made mistakes. Then come the paragraphs, without their times. It opens in Apple Books, Google Play Books, Calibre and other e-book readers, and can be sent to a Kindle.

For both:

- Each is kept for the last 30 videos. Opening the tab again shows the kept one without asking the AI. **Summarize again** / **Rewrite again** makes a new one.
- **Copy** copies the text (the summary, or the rewritten paragraphs).
- The tab you were on is remembered. The font and text size are the same as the subtitles'.

## How it works

1. **Captions.** The extension reads the video's caption list from the player. It prefers English captions (human-made, then auto-generated), then captions in the spoken language. YouTube often rejects caption downloads that lack a token the player adds itself. When that happens, the extension briefly switches the player to the chosen captions so the player fetches them, reuses that file, and puts your caption setting back. Captions YouTube auto-translated (for example if your player is set to auto-translate into another language) are never used as the source unless nothing else works.
2. **Fragments.** Captions are cut into short timed fragments (a few seconds each) at punctuation and pauses.
3. **Translation.** If "Video notes" is on, the AI first reads the title, description and start of the transcript and writes a short summary and glossary. Fragments are then translated in batches of up to 40, each with the notes and the neighboring text as context. The AI joins the fragments of each batch back into complete sentences (auto-generated captions have little punctuation) and translates each sentence as a whole, so the voice reads full sentences instead of pieces. Batches end where a sentence most likely ends, so a sentence is never split between two batches. Translation starts at the current playback position. Results are cached for the last 30 videos, so watching again costs nothing.
4. **Voice.** About 40 seconds ahead of playback, each translated sentence is sent to Azure Speech (MP3, 2 requests at a time).
5. **Sync.** Each sentence starts at the caption time of its first fragment.
   - Every sentence plays at the same reading speed, so the pace stays steady.
   - If a sentence is too long for its slot, or its voice clip is not ready yet, the voice runs late and the video keeps playing. Only when the voice falls more than 5 seconds behind does the video pause, and it stays paused until the voice has finished reading every sentence up to that point. No sentence is skipped: after a seek the voice starts with the sentence on screen, a sentence cut off by an ad is read again, and failed translations or voice clips are retried (the video waits for them). You can turn the pausing off in Settings; the voice then keeps reading every sentence but can fall further behind.
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
| Subtitles in the side panel (also **Original** in the panel) | Translation | Translation, or translation and original |
| Subtitle size (popup, or **A−** / **A+** in the panel) | 100% | 70% to 200% of the panel's default 16px text. Applies right away |
| Subtitle font (also in the panel) | Default | A listed font (仓耳今楷 by weight, W01 the thinnest to W05 the boldest), or "Other" with the font's name as Windows or macOS lists it (like `仓耳今楷04 W03`). Only the subtitles change; the buttons keep the system font. A preview shows the font, and the page says when it isn't installed |
| Skip sponsors / self-promotion / subscribe reminders | on / off / off | SponsorBlock categories to jump over, with or without dubbing. Sponsors can also be toggled in the popup |
| Let the AI find sponsor reads | on | Only while dubbing, only when SponsorBlock has no sponsor segment for the video. No extra AI requests |

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Content scripts run only on `www.youtube.com` |
| `inject.js` | Runs in YouTube's page context. Records the player's caption requests, reads the caption list and downloads caption files |
| `transcript.js` | Pure helpers: caption parsing (json3, srv3, srv1), fragment building, sentence-aware batching, track choice |
| `content.js` | Runs the dub: transcript, translation queue, voice prefetch (only when dubbing, not for **Translate**), sync loop, player button. Sends the sentences and the current one to the side panel over a port. Also makes and keeps the summary and rewrite when the panel asks |
| `content.css` | Status badge and button styles. Hides YouTube's captions while dubbing |
| `sidepanel.*` | Side panel: connects to the active tab's `content.js`; Subtitles, Summary and Rewrite tabs |
| `epub.js` | Builds the rewrite's EPUB 3 file (with an EPUB 2 table of contents) in the side panel, as an uncompressed ZIP, with no library |
| `background.js` | Service worker: AI calls (with retries and batch splitting), the summary of the whole video and the rewrite, Azure Speech synthesis and voice list, SponsorBlock lookup, opening the side panel |
| `shared.js` | Languages and default voices, AI presets, default settings, side panel fonts (and whether one is installed, by comparing text widths drawn with and without it, or for a font loaded by its full name, whether it loads). 仓耳今楷's five weight files share one family name and all claim the normal weight, so by family name Chrome picks the boldest; each weight is loaded by its full name (`local()` in a `FontFace`) instead |
| `popup.*`, `options.*`, `ui.css` | Toolbar popup and settings page |
| `icons/` | `icon.svg` and the PNG sizes made from it |

## Limits

- Videos without any captions can't be dubbed. That would need speech-to-text, which this doesn't do.
- YouTube changes its page and player often. The parts most likely to break are reading the caption list (`getPlayerResponse`) and the caption download in `inject.js`.
- The Azure free tier allows only a few requests per minute. On busy videos the extension retries after the rate limit, and the video may pause while it waits. A paid (S0) resource avoids this.
- Desktop `www.youtube.com` only: no embedded players, Shorts or `m.youtube.com`.
- Keys are stored in this browser's extension storage, unencrypted.
