# Contributing to WhisperSubTranslate

Thanks for helping out. This guide covers the code layout, development checks,
branching, commit style, and manual testing. To add a UI language or
translation target, see the [Translation Guide](docs/TRANSLATION.md).

## Branching model

Single-trunk: `main` is the only long-lived branch. Changes normally go through
a short-lived branch and Pull Request, then are squash-merged into `main`.
The maintainer may push release preparation directly after checks, using the
repository's existing administrator exception; do not change protection rules.
The maintainer tags releases as `v<package.json version>` after validation. Pushing
that tag starts the existing Windows build and publishes a GitHub Release;
it is not a draft or a harmless test run.

Contributors: open a Pull Request from your fork. Any short-lived
`feature/<scope>` branch is welcome.

| Pattern                        | Use for                             |
| ------------------------------ | ----------------------------------- |
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

| Topic              | Guideline                                                                     |
| ------------------ | ----------------------------------------------------------------------------- |
| I18N               | Don't inline UI/log strings. Add them to the I18N tables and reference by key |
| UX                 | Keep progress, ETA, and queue states consistent; avoid regressions            |
| Scope              | Prefer small, focused changes with clear function names                       |
| Multi-language UI  | Update ko/en/ja/zh/pl together when adding UI                                 |
| Translation target | Update selector, names, provider maps, docs, and tests                        |

## Code map

| Path                                             | Responsibility                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/main/index.js`                              | App lifecycle and composition; select portable user data **before** loading services |
| `src/main/window.js`                             | Window creation, security policy and binding services to the live window             |
| `src/main/ipc/`                                  | Validate renderer requests and coordinate service calls by feature                   |
| `src/main/services/`                             | Transcription, translation, downloads, configuration and safe file writes            |
| `src/preload/index.js`                           | Explicit `window.electronAPI` methods and event subscriptions                        |
| `src/shared/ipc-channels.js`                     | Shared inventory of request and event channel names                                  |
| `src/renderer/state.js`, `features/`, `index.js` | Shared UI state, feature functions and startup wiring                                |
| `locales/*.json`, `locales/i18n.functions.js`    | Translation sources; regenerate `locales/i18n.js` with `npm run i18n:build`          |
| `scripts/`                                       | Build hooks and executable regression/E2E checks                                     |

Renderer files are classic scripts loaded in the order listed in
`src/renderer/index.html`, not independently imported modules. They share lexical
state and functions. Load translations and state first, feature scripts next,
and `index.js` last. A function with no caller in its own file can still be live
in another script or an event handler; file-level unused-variable warnings are
not deletion evidence. Services currently retain some Electron/window coupling;
they are not standalone, platform-neutral libraries.

To add IPC, add its name to the shared registry, register a main handler using
that constant, and expose only the needed preload method. The sandboxed preload
keeps literal names rather than requiring local CommonJS modules. For events,
return an unsubscribe function. Do not expose unrestricted `invoke`, filesystem
access, or Node integration to the renderer. The layout smoke check compares
both sides of the request contract and checks renderer script order.

Keep cancellation, late-response guards, legacy settings migration and atomic
file writes when moving code. Dependencies flow from IPC to services; services
must not import handlers or renderer code.

## Development and checks

Use Node.js from `package.json` and install with `npm ci` in a clean checkout.
Installation also provisions native engines; it needs network access and disk
space. For code-only checks, `npm ci --ignore-scripts` skips that setup but cannot
prove the app or native engines run.

Use a separate development profile, not your daily-use data. For example:

```bash
WHISPER_PORTABLE_DATA=/absolute/path/to/test-profile npm start
```

PowerShell:

```powershell
$env:WHISPER_PORTABLE_DATA = Join-Path $env:TEMP 'wst-dev-profile'
npm start
```

Development startup clears renderer cache/storage in the selected profile.
Keep API keys, profiles, downloaded models and generated subtitles out of Git.
Never use model delete/download controls against links to your only model copy.

```bash
npm run i18n:check
npm run check          # generated translations, lint, mocked/service regressions
npm run format:check   # non-mutating formatting check
npm run check:full     # lint, service regressions and Electron boot/IPC smoke
npm run build-win -- --publish never
```

`check:full` does not include `i18n:check`; run both. Set `E2E_REQUIRED=1` so a
missing Playwright installation fails instead of skipping. Linux headless runs
need a display such as `xvfb-run --auto-servernum npm run check:full`. Point
`WHISPER_PORTABLE_DATA` at a separate test profile for E2E runs too. `npm run lint`
and `npm run format` modify files; the commands above do not.

`npm test` includes mocked provider requests, configuration migration, download
integrity, IPC/window lifecycle, cancellation, output safety and local-worker
regressions. It does not call paid APIs or prove native inference quality.
`test:e2e:interaction` exercises UI behavior; the all-model and pipeline scripts
can download models or run native workloads. Read each script's requirements
before using it. Build Windows releases on Windows and test a freshly extracted
ZIP, including its native backends. A build or a boot-only test is not enough.

## Manual test checklist

| Scenario                 | Verify                                                    |
| ------------------------ | --------------------------------------------------------- |
| Extraction only          | Start/stop flows, progress behavior                       |
| Extraction + translation | End-to-end result and final SRT naming                    |
| Model download           | Missing model path; cancel/stop mid-download              |
| I18N switch              | Target-language label and modal texts update correctly    |
| Translation engines      | MyMemory (no key), DeepL/OpenAI (with keys), local Hy-MT2 |
| Build                    | `npm run build-win` completes                             |

## Pull Request checklist

| Item        | Expectation                                           |
| ----------- | ----------------------------------------------------- |
| Description | Clear explanation of changes                          |
| UI impact   | Screenshots for visual changes                        |
| Testing     | Steps to reproduce and verify                         |
| Assets      | No large binaries in Git; screenshots under `assets/` |

## Manual whisper.cpp build (Linux)

Dependency installation builds whisper.cpp from source automatically. If that fails, build it manually:

```bash
# Match the engine version pinned in scripts/postinstall.js.
git clone --branch v1.9.1 --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

# CPU only
cmake -B build && cmake --build build --config Release

# With CUDA (NVIDIA GPU)
cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release

# Copy the binary into the app
cp build/bin/whisper-cli /path/to/WhisperSubTranslate/whisper-cpp/
```

On Windows, if the automatic download during `npm install` fails, download a build from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and extract it into the `whisper-cpp/` folder.
