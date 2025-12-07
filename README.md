# WhisperSubTranslate

English | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [中文](./README.zh.md)

A fast, local desktop app for turning video into subtitles (SRT) and translating them into the language you need. Powered by whisper.cpp for extraction and optional online engines for translation.

> Important: This app creates new SRT subtitles from your video's audio using whisper.cpp. It does not extract existing embedded subtitle tracks or on‑screen text (no OCR).

## Preview

![WhisperSubTranslate main UI](docs/preview_en.png)

## Why use WhisperSubTranslate

Subtitle extraction runs 100% locally — your video never leaves your machine. No cloud uploads, no accounts, no credit cards. Create accurate SRT offline; translation requires internet connection (free MyMemory, or your own DeepL/OpenAI API keys).

### Value at a glance

| Need | What you get |
| --- | --- |
| Privacy & control | 100% local STT; no cloud uploads |
| Zero signup | No account, no credit card, no personal data |
| Unlimited use | No app‑level daily/monthly limits |
| Understand foreign videos | Extract + translate SRT in one run |
| Avoid setup pain | Auto model download; no Python required |
| Clear feedback | Queue, smooth progress, ETA |

> Note: When using online translation engines, provider‑side limits may apply (e.g., MyMemory quota). The app itself does not impose usage caps.

## Getting started

### For users: run the portable release

## Quick Start (Portable)

- Download the latest portable archive from Releases: `WhisperSubTranslate-v1.2.0-portable.zip`
- Open the extracted folder and run `WhisperSubTranslate.exe`

That's it — extraction runs fully offline on your PC. Translation is optional (free MyMemory is pre‑wired; DeepL/OpenAI require your own API keys).

### For developers: run from source

```bash
npm install
npm start
```
- **whisper-cpp** is automatically downloaded during `npm install` (~700MB CUDA version)
- **FFmpeg** is automatically included via npm package
- First run will download the selected GGML model into `_models/` when missing

> If auto-download fails, manually download from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and extract to `whisper-cpp/` folder.

### Build (Windows)
```bash
npm run build-win
```
Artifacts are emitted to `dist2/`.

## Tech Stack

[![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=for-the-badge&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![DeepL](https://img.shields.io/badge/DeepL_API-0F2B46?style=for-the-badge&logo=deepl&logoColor=white)](https://www.deepl.com/pro-api) [![OpenAI](https://img.shields.io/badge/OpenAI_API-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)

| Area | Details |
| --- | --- |
| Runtime | Electron, Node.js, JavaScript |
| Packaging | electron‑builder |
| Networking | axios |
| Speech‑to‑text | whisper.cpp (GGML models) |
| Translation (optional) | DeepL API, OpenAI (GPT-5-nano), MyMemory |

## Translation engines

| Engine | Cost | API key | Limits / Notes |
| --- | --- | --- | --- |
| MyMemory | Free | No | ~50K chars/day per IP |
| DeepL | Free 500K/month | Yes | Paid tiers available |
| GPT-5-nano (OpenAI) | Paid | Yes | Very low cost ($0.05/1M input) |

API keys and preferences are saved locally on your PC under `app.getPath('userData')` with basic encoding to prevent casual exposure. The configuration file is never uploaded to Git or included in builds.

## Language support

### UI Languages
Korean, English, Japanese, Chinese (4 languages)

### Translation Target Languages (12)
Korean (ko), English (en), Japanese (ja), Chinese (zh), Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Russian (ru), **Hungarian (hu)**, **Arabic (ar)**

### Audio Recognition Languages
whisper.cpp supports 100+ languages including all major world languages (English, Spanish, French, German, Italian, Portuguese, Russian, Chinese, Japanese, Korean, Arabic, Hindi, Turkish, and many more).

## Models & performance

Models are stored under `_models/` and auto‑downloaded on demand. Choose a size that fits your machine; larger models are slower but may be more accurate. CUDA is used when available; otherwise CPU runs by default.

| Model | Size | VRAM | Speed | Quality |
| --- | --- | --- | --- | --- |
| tiny | ~75MB | ~1GB | Fastest | Basic |
| base | ~142MB | ~1GB | Fast | Good |
| small | ~466MB | ~2GB | Medium | Better |
| medium | ~1.5GB | ~5GB | Slow | Great |
| large-v3 | ~3GB | ~10GB | Slowest | Best |

## Branching model (simple trunk)

Trunk-based development: keep a single `main` as the trunk; work in short‑lived branches and merge fast via PR.

| Branch | Purpose | Rule |
| --- | --- | --- |
| main | Always releasable | Tag releases, e.g. `v1.0.0` |
| feature/* | Small, focused work | Branch from `main`, merge via PR into `main` |

## Contributing

### 1) Branching & naming

Use one branch type for everything (features, fixes, docs):

| Pattern | Use for |
| --- | --- |
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

| Topic | Guideline |
| --- | --- |
| I18N | Don't inline UI/log strings. Add them to I18N tables and reference by key |
| UX | Keep progress/ETA/queue states consistent; avoid regressions |
| Scope | Prefer small, focused changes with clear function names |
| Multi‑language UI | Update ko/en/ja/zh together when adding UI |

### 4) Manual test checklist

| Scenario | Verify |
| --- | --- |
| Extraction only | Start/stop flows, progress/ETA behavior |
| Extraction + translation | End‑to‑end result and final SRT naming |
| Model download | Missing model path; cancel/stop mid‑download |
| I18N switch | Target‑language label, API modal texts update correctly |
| Translation engines | MyMemory (no key), DeepL/OpenAI (with keys) |
| Build | `npm run build-win` completes |

### 5) Pull Request checklist

| Item | Expectation |
| --- | --- |
| Description | Clear explanation of changes |
| UI impact | Screenshots for visual changes |
| Testing | Steps to reproduce/verify |
| Assets | No large binaries in Git; screenshots under `docs/` |

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

## License

ISC. External APIs/services (DeepL, OpenAI, etc.) require compliance with their own terms.
