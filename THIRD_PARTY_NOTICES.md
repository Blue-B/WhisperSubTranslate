# Third-Party Notices

WhisperSubTranslate is GPL-3.0 licensed, but it bundles, downloads, or links to
several third-party components with their own licenses. This document lists
them for attribution. Each component remains the property of its respective
copyright holder; their licenses apply to their own code and models, not to
WhisperSubTranslate itself.

## Bundled / downloaded at install time

| Component | Version / artifact | License | Source |
| --- | --- | --- | --- |
| whisper.cpp | downloaded CLI + runtime DLLs (`whisper-cli.exe`, `whisper.dll`, `ggml*.dll`, CUDA build ~700MB) | MIT | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| Silero VAD model | `ggml-silero-v5.1.2.bin` (~0.9MB) | MIT (model weights) | [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad) |
| Faster-Whisper-XXL (Sync engine) | `faster-whisper-xxl.exe` archive (~1.4GB, cuBLAS/cuDNN bundled) | GPL-3.0 | [Purfview/whisper-standalone-win](https://github.com/Purfview/whisper-standalone-win) |
| Whisper GGML models | `ggml-*.bin` (tiny…large-v3, downloaded on demand into `_models/`) | MIT | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| Hy-MT2 models | `Hy-MT2-1.8B-Q4_K_M.gguf` / `HY-MT2-7B-Q6_K.gguf` | Apache-2.0 | [tencent/Hy-MT2-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF), [repo](https://github.com/Tencent-Hunyuan/Hy-MT2) |

## npm dependencies (bundled into the app)

| Package | Version | License |
| --- | --- | --- |
| 7zip-bin | 5.2.0 | MIT |
| axios | 1.19.0 | MIT |
| deepl-node | 1.27.0 | MIT |
| ffmpeg-static | 5.3.0 | GPL-3.0-or-later (bundles FFmpeg build) |
| ffprobe-static | 3.1.0 | MIT |
| node-llama-cpp | 3.18.1 | MIT (LLM inference backend) |
| electron | 43.3.0 | MIT (runtime; Chromium/Node.js under their own licenses) |

## Notes

- **FFmpeg**: distributed by `ffmpeg-static` under GPL-3.0-or-later. The app
  uses FFmpeg for audio conversion only (no re-broadcasting of FFmpeg
  functionality), invoked as a separate process.
- **Hy-MT2**: Apache-2.0. Tencent's official evaluation and technical report:
  <https://arxiv.org/pdf/2605.22064>.
- **whisper.cpp models**: distributed under the MIT license by the ggml-org
  project; the model files themselves are made available under that license.
- **Faster-Whisper-XXL**: a standalone repackaging of
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) with
  CUDA runtime libraries bundled; see its repository for the exact terms of
  the distributed archive.
- External APIs and services used only when you configure your own keys
  (DeepL, OpenAI, Google Gemini, Anthropic Claude, custom OpenAI-compatible
  endpoints, MyMemory) are governed by their own terms of service and are not
  redistributed by this app.
