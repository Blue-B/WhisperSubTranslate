# Changelog

All notable changes to WhisperSubTranslate are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

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
