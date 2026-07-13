# Contributing to WhisperSubTranslate

Thanks for helping out. This guide covers branching, commit style, the manual
test checklist, and the manual whisper.cpp build. To add a UI language or
translation target, see the [Translation Guide](docs/TRANSLATION.md).

## Branching model

Single-trunk: `main` is the only long-lived branch. Changes normally go through
a short-lived branch and Pull Request, then are squash-merged into `main`.
The maintainer tags releases (for example `v2.5.0`).

Contributors: open a Pull Request from your fork. Any short-lived
`feature/<scope>` branch is welcome.

| Pattern | Use for |
| --- | --- |
| `feature/<scope>-<short-desc>` | All changes (features, fixes, docs) |

Recommended `<scope>` values: i18n, ui, translation, whisper, model, download, queue, progress, ipc, main, renderer, updater, config, build, logging, perf, docs, readme.

Examples:

```text
feature/i18n-api-modal
feature/ui-progress-smoothing
feature/translation-deepl-test
```

## Commit style (Conventional Commits)

Use prefixes like `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `build:`.

```text
feat: add DeepL connection test
fix: localize target language note
```

## Code guidelines

| Topic | Guideline |
| --- | --- |
| I18N | Don't inline UI/log strings. Add them to the I18N tables and reference by key |
| UX | Keep progress, ETA, and queue states consistent; avoid regressions |
| Scope | Prefer small, focused changes with clear function names |
| Multi-language UI | Update ko/en/ja/zh/pl together when adding UI |
| Translation target | Update selector, names, provider maps, docs, and tests |

## Manual test checklist

| Scenario | Verify |
| --- | --- |
| Extraction only | Start/stop flows, progress behavior |
| Extraction + translation | End-to-end result and final SRT naming |
| Model download | Missing model path; cancel/stop mid-download |
| I18N switch | Target-language label and modal texts update correctly |
| Translation engines | MyMemory (no key), DeepL/OpenAI (with keys), local Hy-MT2 |
| Build | `npm run build-win` completes |

## Pull Request checklist

| Item | Expectation |
| --- | --- |
| Description | Clear explanation of changes |
| UI impact | Screenshots for visual changes |
| Testing | Steps to reproduce and verify |
| Assets | No large binaries in Git; screenshots under `assets/` |

## Manual whisper.cpp build (Linux)

`npm install` builds whisper.cpp from source automatically. If that fails, build it manually:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

# CPU only
cmake -B build && cmake --build build --config Release

# With CUDA (NVIDIA GPU)
cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release

# Copy the binary into the app
cp build/bin/whisper-cli /path/to/WhisperSubTranslate/whisper-cpp/
```

On Windows, if the automatic download during `npm install` fails, download a build from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and extract it into the `whisper-cpp/` folder.
