# Changelog

All notable changes to WhisperSubTranslate are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [2.4.2] — 2026-06-24

Sync accuracy release: a dedicated Faster-Whisper engine repairs subtitle drift, the unreliable SenseVoice timing path is gone, and local translation no longer fails silently or shows misleading API errors.

### Added

- **large-v2 Sync model** — a separate Faster-Whisper-XXL engine, selectable from the model dropdown, that fixes subtitle timing drift on videos where the normal models slip out of sync. It is most accurate on non-English video (Japanese, Korean, Chinese); English is usually fine with `large-v3-turbo`. The engine downloads automatically on first use (~4.4GB) with no Python or manual setup. Device behavior is consistent: CPU runs CPU only, GPU runs GPU only, Auto tries GPU first then falls back to CPU.
- **large-v2 Sync Lite model** — runs the same Sync model file with int8 compute for lower VRAM (~3GB vs ~4.5GB), for lower-end GPUs. No extra download: Sync and Sync Lite share one model file, so installing or deleting either covers both. Both appear in the model dropdown and Model Manager, localized in all 5 UI languages.

### Changed

- **Model Manager wording and VRAM figures** — sync model cards spell out what each mode is for and list realistic VRAM (Sync ~4.5GB, Sync Lite ~3GB) from the Faster-Whisper benchmark; `large-v3-turbo` ~2GB and `large-v3` ~4GB corrected from measured runs. Device-lock note clarified so "Auto" no longer reads as GPU-only.
- **README and translated docs** — trimmed and corrected (settings file name, build output path, model tables), Contributing split into `CONTRIBUTING.md`, and all four translations synced.

### Fixed

- **Silent untranslated output safety net** — if local translation leaves most segments untranslated (the local model crashed mid-run), the job now fails with a clear message instead of saving a subtitle file identical to the source.
- **Misleading "check API key/quota" error on local translation** — failures are now reported by method: a local-model failure suggests trying CPU, only online-engine failures mention API keys. Local translation no longer falls back to online engines, respecting the offline choice.
- **Completion sound** — no longer hangs waiting on a media event that may never fire; plays reliably on job completion.

### Removed

- **SenseVoice timing refinement** — the onset-correction path could shift dialogue out of place and is replaced by the large-v2 Sync engine. The bundled SenseVoice model and the `sherpa-onnx` dependencies are removed, reducing install size.
- **Dead code** — unused ETA/formatting helpers, an unused optimal-settings probe, and orphaned split/wrap utilities removed.

## [2.4.1] — 2026-06-21

Feature + fix release on top of 2.4.0: translate to several target languages in one run, an honest real-time extraction progress bar, and always-on natural sentence segmentation for better translation quality.

### Added

- **Multi-language target selection** — pick several target languages at once and get one SRT per language from a single extraction pass. The single target dropdown is replaced by a compact multi-select list (collapsed so it does not shift the layout); selections persist across restarts, and the translation start log lists every selected target.
- **Real-time extraction progress** — the progress bar now follows Whisper's own `--print-progress` (`-pp`) output instead of an indeterminate creep, and over-long cues are split so subtitle timing tracks the actual speech.

### Changed

- **Natural sentence-level transcription is always on** — the old 50-character forced split (`-ml 50 -sow`) that garbled code-switched English terms and chopped sentences mid-clause is gone, improving translation quality. The per-feature toggle was removed.
- **Model picker wording** — the recommended `large-v3-turbo` now leads with its strength (fastest, good enough for most videos) and states plainly that `large-v3` is a bit more accurate, instead of tagging the recommended model with "may miss speech". Updated in all 5 UI languages.

### Fixed

- **Over-long cue splitting no longer chops short words apart** — a short line stretched over a long span (e.g. a sung "감사합니다" held across ~27 s) was split purely by duration, so a CJK line with no spaces was cut character-by-character into "감사 / 합니 / 다." (and spaced text along word boundaries). Splitting now requires each piece to be at least a sensible minimum length, so genuinely long sentences are still split while short held lines stay intact.
- **Progress bar pinned at 50%** — on a slow model load the pseudo-progress reached the extraction ceiling (50% when translation follows, 95% otherwise) before the first real percentage arrived; because the bar only moves forward it stayed stuck there while only the log timeline advanced. Extraction now warms up to a low cap and then resumes from the real `-pp` percentage up to that ceiling.
- **Transcript lines containing the word "error" are no longer flagged as errors** in the log view.
- **Action bar stays visible when the update banner is shown.**

### Internal

- Removed dead references to the old single-target language `<select>`, fully replaced by the multi-target list (`getSelectedTargetLangs` / `restoreTargetLangs`, persisted via localStorage `targetLangs`).

## [2.4.0] — 2026-06-10

Reliability release: the local Hy-MT2 engine no longer silently saves untranslated text (reported on Reddit: a Japanese video "translated" to English produced a Japanese SRT), failed queue items can retry themselves on long unattended runs, and the Gemini API key no longer travels in request URLs.

### Added

- **Auto-retry failed items (opt-in)** — new "Processing → Auto-retry failed items" toggle in Settings. When the queue finishes, failed files are automatically re-queued for up to 2 attempts each, so a transient extraction/translation failure no longer stalls a long unattended batch; attempt counters reset on every manual start, and manually stopped items are never auto-retried. Requested in a community comment. Localized in all 5 UI languages.
- **Target language in the start log** — the translation start line now reads "Starting translation (Hy-MT2 Local → English)..." instead of naming only the engine, so a wrong target (e.g. the Korean default) is visible immediately rather than after the whole job finishes.

### Fixed

- **Local Hy-MT2 returning untranslated text (echo)** — the local model occasionally echoes the source line unchanged, and the app saved that echo as the "translation" (the Reddit JA→EN report). The local engine now uses the official Hunyuan-MT prompt templates verbatim (English template for non-Chinese targets, Chinese template for zh/zh-Hant/yue), samples deterministically first (temperature 0) and retries once at the official 0.7, and a CJK-ratio heuristic (`looksUntranslated`, guarded against false positives on symbol-only cues and CJK targets) verifies the output. If both passes still echo, the line is handed to the existing MyMemory → ChatGPT fallback chain instead of being written out untranslated. Verified against the real 1.8B GGUF (8/8 tricky JA→EN cues, JA→KO unaffected); the 7B model shares the same code path.
- **Gemini API key in request URLs** — the key was sent as a `?key=` query parameter in three call sites, where proxies and request logs could record it. It now travels in the `x-goog-api-key` header; behavior is unchanged.

## [2.3.0] — 2026-06-09

Feature release: stops Whisper's repeated/hallucinated subtitles on silent and music sections (the most common quality complaint), adds opt-in subtitle cleanup, and improves queue/history management. Closes #27.

### Added

- **Repetition & hallucination suppression (on by default)** — videos with long non-speech stretches (music, silence, ambient/sound-effect parts) made Whisper loop the previous line over and over, or invent unrelated text. A new "Output cleanup → Suppress repeated/hallucinated lines" toggle runs the transcription through Silero **VAD (Voice Activity Detection)**, so only actual speech segments are transcribed. On a real test clip this took a 39-line repeated block (`1840年アヘン戦争` over and over) down to 5 clean dialogue lines. The Silero VAD model is downloaded automatically by `postinstall.js` (~0.9 MB); if it is missing, extraction still works and simply skips VAD. Whisper is additionally run with `--max-context 0` and `--suppress-nst` to break repetition loops.
- **Remove speaker-change markers (`>>`)** — optional toggle that strips the leading `>>` / `>>>` markers Whisper adds when it thinks the speaker changed. Dialogue text is preserved. (issue #27)
- **Remove SDH (deaf/hard-of-hearing) tags** — optional toggle that deletes sound-description lines such as `[music]`, `(applause)`, `♪`. Conservative by design: a cue is removed only when the **entire** line is a sound description, so parentheses inside real dialogue (e.g. `(sighs) I can't believe it`) are kept. Off by default. (issue #27)
- **"Clear completed" queue button** — removes only finished items from the processing queue, leaving in-progress and pending items untouched. (issue #27)
- **Per-item history deletion** — each history row now has a Delete button that removes just that entry (the log record only — the actual subtitle/video files are never touched), alongside the existing "Clear all".

### Fixed

- **Renderer crash hardening** — the app could close silently if the renderer hit an unhandled error right after transcription. `main.js` now logs `render-process-gone` / `child-process-gone` to `errors.log` and auto-reloads the renderer, with a backoff (stops after 3 reloads in 30s and shows a dialog) so a persistently crashing renderer can't loop forever.

### Internal

- New `srt-cleanup.js` — a pure (no Electron/fs) module for the speaker-tag and SDH cleanup, unit-tested via `scripts/smoke-test.js`.
- `package.json` `build.files` now includes `srt-cleanup.js` (a missing-from-package bug caught during build verification that would have crashed the packaged app on startup).
- Subtitle cleanup is applied to the extracted `.srt` before the translation stage reads it, so tags never reach the translator.

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
