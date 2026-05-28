# WhisperSubTranslate

English | [한국어](./docs/README.ko.md) | [日本語](./docs/README.ja.md) | [中文](./docs/README.zh.md) | [Polski](./docs/README.pl.md)

A local-first desktop workflow for turning videos into multilingual subtitles. Drop in a video, generate SRT with whisper.cpp, then translate it with free, paid, or upcoming local translation engines.

> Important: This app creates new SRT subtitles from your video's audio using whisper.cpp. It does not extract existing embedded subtitle tracks or on‑screen text (no OCR).
>
> v2.0 focus: context-aware translation, safer API key storage, local translation routing, and a more polished contributor-friendly codebase.

## Preview

<p align="center">
  <img src="assets/hero/hero.png" alt="WhisperSubTranslate — main UI" width="100%">
</p>

## Why use WhisperSubTranslate

Subtitle extraction runs 100% locally — your video never leaves your machine. No cloud uploads, no accounts, no credit cards. Create accurate SRT offline; translation can run **fully offline** with the bundled local HY-MT model, or use free/paid online engines (MyMemory, your own DeepL/OpenAI/Gemini keys).

### Value at a glance

| Need                      | What you get                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Privacy & control         | 100% local STT; no cloud uploads                                                                      |
| Zero signup               | No account, no credit card, no personal data                                                          |
| Unlimited use             | No app‑level daily/monthly limits                                                                     |
| Understand foreign videos | Extract + translate SRT in one run                                                                    |
| Avoid setup pain          | Auto model download; no Python required                                                               |
| Clear feedback            | Queue, smooth progress, ETA                                                                           |
| Safe interruptions        | Cancel a model download mid-flight; partial files are cleaned up and resumed from scratch on next run |
| History on your terms     | Local-only job history (up to 200 entries), togglable, with forensic-safe clear                       |

> Note: When using online translation engines, provider‑side limits may apply (e.g., MyMemory quota). The app itself does not impose usage caps.

## Getting started

### For users: run the portable release

- Download the latest portable archive from Releases: `WhisperSubTranslate-v2.0.2-win-x64.zip`
- Open the extracted folder and run `WhisperSubTranslate.exe`

That's it — extraction runs fully offline on your PC. Translation is optional (local HY-MT model for 100% offline, free MyMemory, or your own DeepL/OpenAI/Gemini API keys).

### For developers: run from source

```bash
npm install
npm start
```

- **whisper-cpp** is automatically downloaded during `npm install` (~700MB CUDA version on Windows)
- On **Linux/macOS**, if no pre-built binary is available, whisper.cpp is automatically built from source (requires `cmake`, `gcc`/`clang`, and `git`)
- **FFmpeg** is automatically included via npm package
- First run will download the selected GGML model into `_models/` when missing

> If auto-download fails, manually download from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and extract to `whisper-cpp/` folder.

### Linux Setup

WhisperSubTranslate works on Linux with a few extra steps:

**Prerequisites:**

```bash
# Ubuntu/Debian
sudo apt install cmake build-essential git ffmpeg

# For CUDA GPU acceleration (optional, requires NVIDIA GPU + drivers)
# Install CUDA Toolkit: https://developer.nvidia.com/cuda-downloads
```

**Run from source:**

```bash
git clone https://github.com/Blue-B/WhisperSubTranslate.git
cd WhisperSubTranslate
npm install    # whisper.cpp will be auto-built from source
npm start
```

If auto-build fails, build whisper.cpp manually:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

# CPU only
cmake -B build && cmake --build build --config Release

# With CUDA (NVIDIA GPU)
cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release

# Copy the binary
cp build/bin/whisper-cli /path/to/WhisperSubTranslate/whisper-cpp/
```

### Build (Windows)

```bash
npm run build-win
```

Artifacts are emitted to `dist2/`.

## Tech Stack

[![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=for-the-badge&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![DeepL](https://img.shields.io/badge/DeepL_API-0F2B46?style=for-the-badge&logo=deepl&logoColor=white)](https://www.deepl.com/pro-api) [![OpenAI](https://img.shields.io/badge/OpenAI_API-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)

| Area                   | Details                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Runtime                | Electron, Node.js, JavaScript                                                                   |
| Packaging              | electron‑builder                                                                                |
| Networking             | axios                                                                                           |
| Speech‑to‑text         | whisper.cpp (GGML models)                                                                       |
| Translation (optional) | **Local (HY-MT 1.8B/7B GGUF, offline via node-llama-cpp)**, MyMemory, DeepL, OpenAI GPT, Gemini |

## Translation engines

| Engine               | Cost                        | API key | Limits / Notes                                                                       |
| -------------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------ |
| **Local HY-MT 1.8B** | **Free / Offline**          | **No**  | **~1.13GB model, VRAM 2GB / RAM 4GB, fast**                                          |
| **Local HY-MT 7B**   | **Free / Offline**          | **No**  | **~4.4GB model, VRAM 6GB / RAM 8GB, high quality**                                   |
| MyMemory             | Free                        | No      | ~50K chars/day per IP                                                                |
| DeepL                | Free 500K/month             | Yes     | Stable deterministic translation                                                     |
| OpenAI GPT-5.4 mini  | Paid                        | Yes     | $0.075 input / $0.60 output per 1M tokens (context-aware)                            |
| OpenAI GPT-5.4 nano  | Paid                        | Yes     | Cheaper tier — $0.20 input / $1.25 output per 1M tokens                              |
| Gemini 3 Flash       | Free/Paid                   | Yes     | Recommended low-cost LLM route ([Get key](https://aistudio.google.com/app/apikey))   |
| Local (HY-MT)        | Free after ~1.1 GB download | No      | Offline, GPU/CPU selectable. Tencent HY-MT 1.5 1.8B Q4 (auto-downloads on first use) |

> **Tip**: For long videos (1hr+), MyMemory's daily limit can cause slowdowns. Use Gemini, DeepL, or a configured GPT model instead.

API keys and preferences are saved locally on your PC under `app.getPath('userData')` with basic encoding to prevent casual exposure. The configuration file is never uploaded to Git or included in builds.

### Data Storage

| Data                 | Location                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Settings & API Keys  | `%APPDATA%\whispersubtranslate\translation-config-encrypted.json`                            |
| Job History          | `%APPDATA%\whispersubtranslate\history.json` (up to 200 entries, file-based for portability) |
| Error Logs (Windows) | `%APPDATA%\whispersubtranslate\logs\errors.log`                                              |
| Error Logs (macOS)   | `~/Library/Application Support/whispersubtranslate/logs/errors.log`                          |
| Error Logs (Linux)   | `~/.config/whispersubtranslate/logs/errors.log`                                              |
| Models               | `_models/` (in app folder)                                                                   |

### Job History

- Auto-saved per finished job (name, output path, status, timestamp); **capped at 200 entries**.
- Each row has **Open** (play the result file) and **Folder** (reveal in Explorer) actions.
- Toggle on/off any time in **Settings → History** — turning it off only stops _new_ entries; existing ones are preserved.
- **Clear All** performs a forensic-safe wipe: the JSON file is overwritten with zeros, deleted, and any legacy `localStorage` keys are padded out to encourage compaction. SSD wear-leveling means software cannot guarantee 100% unrecoverability — use full-disk encryption for hard guarantees.

### Model Downloads

- While a model is downloading, the card shows a **Cancel** button next to **Downloading…**.
- Closing the window mid-download safely aborts the transfer.
- Whisper GGML files are written to a `.partial` path and only renamed to `ggml-*.bin` on success — so a half-downloaded file is **never** mistaken for an installed model on next launch.

## Language support

### UI Languages

Korean, English, Japanese, Chinese, Polish (5 languages)

### Translation Target Languages (14)

Korean (ko), English (en), Japanese (ja), Chinese (zh), Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Russian (ru), Hungarian (hu), Arabic (ar), Polish (pl), **Persian (fa)**

### Audio Recognition Languages

whisper.cpp supports 100+ languages including all major world languages (English, Spanish, French, German, Italian, Portuguese, Russian, Chinese, Japanese, Korean, Arabic, Hindi, Turkish, and many more).

## Models & performance

Models are stored under `_models/` and auto‑downloaded on demand. Choose a size that fits your machine; larger models are slower but may be more accurate. CUDA is used when available; otherwise CPU runs by default.

| Model             | Size   | VRAM | Speed   | Quality   |
| ----------------- | ------ | ---- | ------- | --------- |
| tiny              | ~75MB  | ~1GB | Fastest | Basic     |
| base              | ~142MB | ~1GB | Fast    | Good      |
| small             | ~466MB | ~2GB | Medium  | Better    |
| medium            | ~1.5GB | ~4GB | Slow    | Great     |
| large-v3          | ~3GB   | ~5GB | Slowest | Best      |
| large-v3-turbo ⭐ | ~809MB | ~4GB | Fast    | Excellent |

> Note: VRAM requirements are for [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with GGML optimization, which is significantly lower than PyTorch Whisper (~10GB for large). Tested: large-v3 works on 6GB VRAM GPU.

## Branching model

Single-trunk: `main` is the only long-lived branch. The maintainer commits directly to `main` and tags releases (e.g. `v2.0.0`).

**Contributors:** open a Pull Request from your fork. Any short-lived `feature/<scope>` branch is welcome; it will be squash-merged into `main`.

## Contributing

> **Want to add a new language?** See the [Translation Guide](docs/TRANSLATION.md).

### 1) Branching & naming

Use one branch type for everything (features, fixes, docs):

| Pattern                        | Use for     |
| ------------------------------ | ----------- |
| `feature/<scope>-<short-desc>` | All changes |

Recommended <scope> values: i18n, ui, translation, whisper, model, download, queue, progress, ipc, main, renderer, updater, config, build, logging, perf, docs, readme

Examples:

```text
feature/i18n-api-modal
feature/ui-progress-smoothing
feature/translation-deepl-test
feature/main-disable-devtools
```

### 2) Commit style (Conventional Commits)

Use prefixes like `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `build:`.

```text
feat: add DeepL connection test
fix: localize target language note
```

### 3) Code guidelines

| Topic             | Guideline                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| I18N              | Don't inline UI/log strings. Add them to I18N tables and reference by key |
| UX                | Keep progress/ETA/queue states consistent; avoid regressions              |
| Scope             | Prefer small, focused changes with clear function names                   |
| Multi‑language UI | Update ko/en/ja/zh/pl together when adding UI                             |

### 4) Manual test checklist

| Scenario                 | Verify                                                  |
| ------------------------ | ------------------------------------------------------- |
| Extraction only          | Start/stop flows, progress/ETA behavior                 |
| Extraction + translation | End‑to‑end result and final SRT naming                  |
| Model download           | Missing model path; cancel/stop mid‑download            |
| I18N switch              | Target‑language label, API modal texts update correctly |
| Translation engines      | MyMemory (no key), DeepL/OpenAI (with keys)             |
| Build                    | `npm run build-win` completes                           |

### 5) Pull Request checklist

| Item        | Expectation                                           |
| ----------- | ----------------------------------------------------- |
| Description | Clear explanation of changes                          |
| UI impact   | Screenshots for visual changes                        |
| Testing     | Steps to reproduce/verify                             |
| Assets      | No large binaries in Git; screenshots under `assets/` |

## Support

If this project saves you time or helps you publish better subtitles, supporting it directly accelerates development:

- Your support helps: bug fixes, model download reliability, UI polish, new translation options, and Windows build/testing.
- Transparency: I don't sell data; funds go to development time, infra for release builds, and test credits for translation APIs.
- One‑time sponsors are credited in README and release notes (opt‑out available).
- Monthly sponsors ($3/mo via GitHub Sponsors, auto‑billing) also get best‑effort priority triage for "Sponsor Request" issues.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/One‑time_$3-Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h)

## Acknowledgments

- whisper.cpp is developed by Georgi Gerganov: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## Contributors

Thanks to everyone who helps make WhisperSubTranslate better! 🙏

<a href="https://github.com/Blue-B/WhisperSubTranslate/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Blue-B/WhisperSubTranslate" alt="Contributors" />
</a>

## Repository activity

![Repobeats analytics image](https://repobeats.axiom.co/api/embed/bb4da4df4fdd4f9193f24a6647d5f10022e9bab9.svg 'Repobeats analytics image')

## Translations

Help translate WhisperSubTranslate into your language! Translatable strings live in [`locales/*.json`](locales/) and are managed on [Weblate](https://hosted.weblate.org/engage/whispersubtranslate/). See the [Translation Guide](docs/TRANSLATION.md).

<a href="https://hosted.weblate.org/engage/whispersubtranslate/">
  <img src="https://hosted.weblate.org/widget/whispersubtranslate/ui/multi-auto.svg" alt="Translation status" />
</a>

## Star History

<a href="https://star-history.com/#Blue-B/WhisperSubTranslate&Date">
  <img src="https://api.star-history.com/svg?repos=Blue-B/WhisperSubTranslate&type=Date" alt="Star History Chart" width="600" />
</a>

## License

GPL-3.0. External APIs/services (DeepL, OpenAI, etc.) require compliance with their own terms.
