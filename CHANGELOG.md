# Changelog

All notable changes to WhisperSubTranslate are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-05-21

Major release: context-aware translation, local HY-MT translation engine, durable file-based history, safer downloads, polished UI, and a cleaner contributor-friendly codebase.

### Added

- **Local HY-MT translation engine** — fully offline translation via `node-llama-cpp` (HY-MT 1.5 1.8B Q4, ~1.13 GB; HY-MT 7B optional). GPU/CPU selectable.
- **Job history (up to 200 entries)** — stored in `%APPDATA%\whispersubtranslate\history.json` (file-based, portable across builds/origins). Each row has **Open** (play result file) and **Folder** (reveal in Explorer) actions.
- **History toggle** — Settings → History to switch logging on/off. Turning it off only stops *new* entries; existing data is preserved.
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
