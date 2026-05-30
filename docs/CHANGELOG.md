# Changelog

All notable changes to WhisperSubTranslate are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.2] — 2026-05-30

Patch release: fixes two long-standing Windows portable issues — the CPU whisper.cpp build failing to launch on GPU-less machines (issue #26), and Korean/Japanese/Chinese Windows account names breaking subtitle extraction (issue #22).

### Fixed

- **CPU whisper.cpp build missing runtime DLLs (issue #26)** — the CPU fallback in `scripts/postinstall.js` only copied `whisper-cli.exe` into `whisper-cpp/cpu/`, leaving its dependent runtime libraries (`whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`) behind. On a CPU-only Windows machine, Windows could not resolve those imports and Node `spawn()` surfaced the dependent-DLL failure as `ENOENT`, which the app then reported as "whisper-cli not found" even though the file was sitting right there in `resources/whisper-cpp/cpu/`. The postinstall script now copies the CLI binary AND every `.dll` next to it from the upstream `whisper-bin-x64.zip` into `whisper-cpp/cpu/`, so the portable build's CPU fallback actually launches on GPU-less machines.
- **Defensive runtime check** — `main.js` now verifies that `cpu/whisper.dll` is present before electing the CPU build at runtime; broken installs (where DLLs were never extracted) auto-fall back to the top-level binary instead of failing with a misleading "not found" message.
- **Clearer launch-failure message** — on Windows, the `ENOENT` error from `spawn()` now mentions that the failure can also mean a dependent DLL such as `whisper.dll` / `ggml*.dll` could not be loaded from the same folder, not only that the binary itself is missing.
- **Non-ASCII Windows account names breaking extraction (issue #22)** — Korean/Japanese/Chinese Windows user names produce non-ASCII paths in `%APPDATA%\whispersubtranslate\_models\...` (the GGML model location passed to whisper-cli via `-m`) and in user file paths handed to ffmpeg. whisper-cli and ffmpeg on Windows did not always survive the argv code-page round-trip, which surfaced as misleading errors like "GPU memory shortage or driver issue". Two new safeguards close the gap so non-Latin Windows accounts work without a separate English profile:
  - `getGgmlModelsDir()` now detects when the resolved userData path contains non-ASCII characters on Windows and falls back to `C:\Users\Public\WhisperSubTranslate\_models`, an ASCII path every user account can write to. All downloads, lookups, and the `-m` argument to whisper-cli automatically use the safe location.
  - `convertToWav()` now stages a non-ASCII input media file into the ASCII safe-temp directory before invoking ffmpeg — via `fs.linkSync` (instant, no extra disk on the same NTFS volume) with a `fs.copyFileSync` fallback for cross-volume cases. The hardlink/copy is cleaned up on every exit path (success, failure, user-stop).

## [2.2.1] — 2026-05-29

Patch release: fixes local GPU/CUDA translation silently falling back to CPU because the bundled `node-llama-cpp` CUDA backend shipped without its CUDA runtime DLLs.

### Fixed

- **CUDA local translation** — `scripts/postinstall.js` installs the cross-platform `node-llama-cpp` binaries with `--ignore-scripts`, so `@node-llama-cpp/win-x64-cuda-ext` never downloaded its CUDA runtime DLLs (`cudart64_12` / `cublas64_12` / `cublasLt64_12`). The packaged `ggml-cuda.dll` could not resolve its imports at runtime and CUDA acceleration silently fell back to Vulkan/CPU, even when the user selected GPU (CUDA). A new electron-builder `afterPack` hook (`scripts/afterPack.js`) copies the CUDA 12 runtime DLLs already bundled with whisper-cpp next to `ggml-cuda.dll` in the packaged app so the CUDA backend can initialize. Windows-only, idempotent, never fails the build.

## [2.1.0] — 2026-05-28

Minor release: upgrades the local translation engine to **Tencent Hy-MT2** (Apache-2.0) and tidies the repository layout.

### Added

- **Hy-MT2 local translation engine** — replaces HY-MT1.5. Default **1.8B (Q4_K_M, ~1.13 GB)**; the high-quality tier is upgraded to **7B (Q6_K, ~6.16 GB)**. Same `hunyuan-dense` GGUF architecture (drop-in via `node-llama-cpp`), now **Apache-2.0** licensed with **33+ supported languages**.
- **Automatic cleanup of legacy HY-MT1.5 model files** — orphaned `HY-MT1.5-*.gguf` downloads are removed once on first model listing/translation.

### Changed

- Prompt aligned to Hy-MT2's official default template; `LANG_NAMES` expanded from 24 to 38; app-side `maxTokens` raised 256 → 1024 for long subtitle lines.
- UI strings rebranded HY-MT → Hy-MT2 across all 5 locales (`i18n.js` regenerated).

### Internal

- Repository layout tidied: localized READMEs, `TRANSLATION.md`, and `CHANGELOG.md` moved into `docs/`; app icons moved into `build/`; the generated `log-preview.png` is no longer tracked; local-only tooling (`.playwright-cli/`, `release-kit/`) is now ignored. Root tracked files reduced 27 → 18.

## [2.0.2] — 2026-05-27

Patch release: better local (HY-MT) translation quality and broader Linux compatibility. Thanks to community contributor [@matbgn](https://github.com/matbgn).

### Fixed

- **Local translation (HY-MT) hallucinations & runaway generation** — chat history is now reset before every segment so context no longer accumulates across an SRT file, and `chatWrapper: 'auto'` lets Hunyuan-MT select the correct chat template. Adopts Tencent's recommended sampling (`temperature 0.7`, `topK 20`, `topP 0.6`, `repeatPenalty 1.05`) and adds `maxTokens: 256` as an app-side safety cap (not a Tencent recommendation) to curb runaway output.

### Improvements

- **Linux build fallback** — when no prebuilt whisper.cpp binary is available, the installer attempts a CUDA build and only retries a CPU-only build when a CUDA build was actually attempted (e.g. unsupported GPU architectures such as RTX 5090 with nvcc 12.0).
- **Cross-platform Electron launcher (`scripts/start.js`)** — `npm start` now runs a Node launcher that unsets a leaked `ELECTRON_RUN_AS_NODE` so the app always starts in GUI mode. On Linux, when `chrome-sandbox` lacks the setuid bit it injects `--no-sandbox` to prevent SIGILL crashes and prints a `console.warn` noting the sandbox is reduced. Extra CLI args are forwarded to Electron.

### Internal

- **Translations are now Weblate-ready** — UI strings were split into per-language `locales/*.json` (interpolation/plural helpers kept in `locales/i18n.functions.js`). The bundled `locales/i18n.js` is now generated via `npm run i18n:build` and verified in CI with `npm run i18n:check`; no runtime/behaviour change (the generated object is equivalent to the previous hand-written one).

## [2.0.1] — 2026-05-25

### Fixed

- **Premature "Complete!" title during translation** — the progress title flipped to "Complete!" while the job was still translating. The final batch reported `progress: 100` on the `translating` stage, pushing the overall bar to 100% before subtitle assembly and file writing finished. Translation-stage progress is now capped at 99%; 100% is only reached on the genuine `completed` stage. Most visible in high-quality (context-aware) mode, where post-translation processing takes longer.
- **Stale "Translating…" text at 100%** — on the completed stage the progress text now reads "Translation completed!" instead of leaving the stale "Translating…" label next to a 100% bar.

## [2.0.0] — 2026-05-21

Major release: context-aware translation, local HY-MT translation engine, durable file-based history, safer downloads, polished UI, and a cleaner contributor-friendly codebase.

### Added

- **Local HY-MT translation engine** — fully offline translation via `node-llama-cpp` (HY-MT 1.5 1.8B Q4, ~1.13 GB; HY-MT 7B optional). GPU/CPU selectable.
- **Job history (up to 200 entries)** — stored in `%APPDATA%\whispersubtranslate\history.json` (file-based, portable across builds/origins). Each row has **Open** (play result file) and **Folder** (reveal in Explorer) actions.
- **History toggle** — Settings → History to switch logging on/off. Turning it off only stops _new_ entries; existing data is preserved.
- **Forensic-safe Clear All** — overwrites the history file with zeros, deletes it, and pads out any legacy `localStorage` residue to encourage compaction. (SSD wear-leveling means software cannot guarantee 100% unrecoverability — use full-disk encryption for hard guarantees.)
- **Cancel button while downloading a model** — both Whisper GGML and local HY-MT.
- **Safe download interruption** — closing the window mid-download aborts the transfer; `before-quit` cancels active downloads.
- **`.partial` rename pattern for Whisper GGML** — downloads go to `ggml-*.bin.partial` and are renamed to `ggml-*.bin` only on success. Half-downloaded files are never mistaken for installed models on next launch.
- **Persian (fa) translation target language**.
- **Unified error log** — `%APPDATA%\whispersubtranslate\logs\errors.log` with rotation (2 MB / 1000 lines).
- 5-locale README updates (en/ko/ja/zh/pl) covering data storage, history, and download safety.

### Changed

- **Default window size raised to 1280×900** (min 1000×760). The drop zone is roomier and the file-select button sits naturally above the format chips.
- **History is now file-based, not localStorage.** Legacy `wst_history_v1` / `wst_history` keys are auto-migrated on first run.
- Settings & API keys remain in `%APPDATA%\whispersubtranslate\translation-config-encrypted.json` (never touched by history operations).
- Models page: the active downloading card shows a disabled "Downloading…" button paired with a ghost **Cancel** button; duplicate clicks are blocked.

### Fixed

- History entries surviving across exe relocations / new builds (file:// origin churn no longer wipes them).
- SRT-only translation runs now record the translated output path in history.
- Stop button enlarged; progress no longer stalls at the end of long jobs.
- Duplicate log lines and Gemini engine label corrected.

### Removed

- GitHub Pages site (`docs/`) and the `pages.yml` workflow. The marketing/blog pages were superseded by the in-app docs and the README. Disable Pages in repo Settings → Pages after this release.
- `CONTRIBUTING.md` standalone file — its content is now folded into the README.

### Notes

- App name and `userData` folder name are unchanged (`whispersubtranslate`) so existing settings carry over.
- Tested on Windows 10/11 x64. Linux/macOS source builds remain supported per the README.
