# WhisperSubTranslate

English | [한국어](./docs/README.ko.md) | [日本語](./docs/README.ja.md) | [中文](./docs/README.zh.md) | [Polski](./docs/README.pl.md)

Turn any video into multilingual subtitles, locally. Drop in a video, generate an SRT with whisper.cpp, then translate it offline with the bundled Hy-MT2 model or with free/paid online engines.

> This app creates new subtitles from your video's audio (speech to text). It does not extract embedded subtitle tracks or read on-screen text (no OCR).

## Preview

<p align="center">
  <img src="assets/hero/hero.png" alt="WhisperSubTranslate main UI" width="100%">
</p>

## Features

- 100% local speech to text. Your video never leaves your machine, no account, no upload.
- Offline translation with the bundled Hy-MT2 model, or online engines (MyMemory, DeepL, OpenAI, Gemini) with your own keys.
- Automatic model download. No Python, no manual setup.
- Sync repair models (large-v2 Sync and Sync Lite) for videos where normal models drift out of sync.
- Queue, live progress, and local-only job history.

## Getting started

### Users

Download the latest portable archive from [Releases](https://github.com/Blue-B/WhisperSubTranslate/releases), extract it, and run `WhisperSubTranslate.exe`. Extraction runs fully offline on your PC. Translation is optional.

### Developers

```bash
npm install
npm start
```

- Node.js >= 20.19 or >= 22.12 (Electron 42 toolchain)
- whisper.cpp is downloaded during `npm install` (CUDA build on Windows, ~700MB)
- FFmpeg is included via npm; the selected GGML model downloads on first use

### Linux

```bash
sudo apt install cmake build-essential git ffmpeg   # Ubuntu/Debian
npm install   # whisper.cpp is built from source
npm start
```

For CUDA acceleration, install the NVIDIA CUDA Toolkit before `npm install`. Manual whisper.cpp build steps are in [CONTRIBUTING.md](CONTRIBUTING.md).

### Build (Windows)

```bash
npm run build-win   # artifacts are emitted to dist2/
```

## Translation engines

Translate subtitles fully offline with the bundled Tencent Hy-MT2 model, or route to free/paid online engines using your own API keys.

| Engine | Offline | API key | Cost | Notes |
| --- | :---: | :---: | --- | --- |
| Hy-MT2 1.8B (local, default) | Yes | No | Free | ~1.13GB, VRAM 2GB / RAM 4GB, on-device |
| Hy-MT2 7B (local) | Yes | No | Free | ~6.16GB, VRAM 8GB / RAM 12GB, larger model |
| MyMemory | No | No | Free | ~50K chars/day per IP |
| DeepL | No | Yes | Free 500K/month | Deterministic output |
| OpenAI GPT-5.4 mini | No | Yes | Paid | Context-aware |
| OpenAI GPT-5.4 nano | No | Yes | Paid | Cheaper tier |
| Gemini 3 Flash | No | Yes | Free / low-cost | Recommended low-cost route ([get key](https://aistudio.google.com/app/apikey)) |

The local Hy-MT2 engine is the only option that needs no API key, no network, and no per-use cost, so your dialogue never leaves your machine.

### Translation quality (offline engine)

WhisperSubTranslate ships Tencent's Hy-MT2 models (1.8B default, 7B optional). Tencent's official evaluation shows the Hy-MT2 family competing with leading commercial translation APIs, and ahead of several of them on some benchmarks.

![Hy-MT2 translation benchmark, official Tencent figures, bundled in WhisperSubTranslate](assets/hy-mt2-benchmark.png)

Source: official benchmarks from Tencent: [Hy-MT2 repository](https://github.com/Tencent-Hunyuan/Hy-MT2), [technical report](https://arxiv.org/pdf/2605.22064), [models on HuggingFace](https://huggingface.co/tencent/Hy-MT2-1.8B). The chart is redrawn from Tencent's official Figure 1, with bundled-model (1.8B/7B) numbers checked against the paper tables. These figures measure the underlying model on standard machine translation benchmarks (WildMTBench, WMT25, FLORES-200, etc.), not a WhisperSubTranslate-specific benchmark.

For long videos (1hr+), MyMemory's daily limit can cause slowdowns. Use Gemini, DeepL, or a configured GPT model instead.

## Speech recognition models

Models download on demand into `_models/`. CUDA is used when available, otherwise CPU runs by default. Pick a size that fits your GPU.

| Model | Size | VRAM | Speed | Notes |
| --- | --- | --- | --- | --- |
| tiny | ~75MB | ~1GB | Fastest | Basic |
| base | ~142MB | ~1GB | Fast | Good |
| small | ~466MB | ~1GB | Medium | Better |
| medium | ~1.5GB | ~2GB | Medium | Great |
| large-v3 | ~3GB | ~4GB | Slow | Best transcription |
| large-v3-turbo (default) | ~809MB | ~2GB | Fast | Best all-round |
| large-v2 Sync | ~4.4GB | ~4.5GB | Slow | Separate engine; fixes subtitle sync |
| large-v2 Sync Lite | shared | ~3GB | Slow | Same file as Sync, int8, lower VRAM |

Sync and Sync Lite use a separate Faster-Whisper engine (auto-downloaded once, ~4.4GB) and share the same model file, so one download covers both. Use them only when normal models drift out of sync; they are most accurate on non-English video (Japanese, Korean, Chinese). English is usually fine with large-v3-turbo.

VRAM figures for whisper.cpp models are with GGML optimization, much lower than PyTorch Whisper (~10GB for large). Sync figures are from the Faster-Whisper benchmark.

## Language support

- UI: Korean, English, Japanese, Chinese, Polish
- Translation targets (15): ko, en, ja, zh, es, fr, de, it, pt, ru, hu, ar, pl, tr, fa
- Audio recognition: 100+ languages via whisper.cpp

## Data storage

Everything stays local under your user data folder. Nothing is uploaded.

| Data | Location |
| --- | --- |
| Settings & API keys | `%APPDATA%\whispersubtranslate\translation-config-safe.json` |
| Job history | `%APPDATA%\whispersubtranslate\history.json` (up to 200 entries) |
| Error logs | `%APPDATA%\whispersubtranslate\logs\errors.log` |
| Models | `_models/` (in app folder) |

API keys are stored locally with OS-level safe storage, and the config is never committed or bundled. Job history is optional (toggle in Settings) and capped at 200 entries.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch
naming, commit style, the manual test checklist, and the manual whisper.cpp
build. To add a UI language or translation target, see the
[Translation Guide](docs/TRANSLATION.md).

Help translate the app UI on
[Weblate](https://hosted.weblate.org/engage/whispersubtranslate/); translatable
UI strings live in [`locales/*.json`](locales/).

<a href="https://hosted.weblate.org/engage/whispersubtranslate/">
  <img src="https://hosted.weblate.org/widget/whispersubtranslate/ui/multi-auto.svg" alt="Translation status" />
</a>

## Contributors

Thanks to everyone who helps make WhisperSubTranslate better.

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/matbgn"><img src="https://github.com/matbgn.png?size=80" width="80" alt="matbgn" title="matbgn" /></a>
<a href="https://github.com/AtillaTahak"><img src="https://github.com/AtillaTahak.png?size=80" width="80" alt="AtillaTahak" title="AtillaTahak" /></a>

## Support

If this project saves you time, supporting it directly helps with bug fixes, model reliability, and new translation options.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## Acknowledgments

- whisper.cpp by Georgi Gerganov: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Hy-MT2 by Tencent: [Tencent-Hunyuan/Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## License

GPL-3.0. External APIs and services (DeepL, OpenAI, Gemini, etc.) require compliance with their own terms.
