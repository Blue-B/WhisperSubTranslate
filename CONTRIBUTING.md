# Contributing to WhisperSubTranslate

Thank you for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
git clone https://github.com/Blue-B/WhisperSubTranslate.git
cd WhisperSubTranslate
npm install
npm start
```

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/Blue-B/WhisperSubTranslate/issues/new?template=bug_report.md) template
- Include your OS, app version, GPU info, and logs

### Suggesting Features

- Use the [Feature Request](https://github.com/Blue-B/WhisperSubTranslate/issues/new?template=feature_request.md) template

### Adding a New Language

- See [TRANSLATION.md](TRANSLATION.md) for a step-by-step guide

### Submitting Code

1. **Fork** this repository
2. **Create a branch**: `feature/<scope>-<short-desc>`
   - Examples: `feature/i18n-add-thai`, `feature/ui-dark-mode`, `feature/translation-libre`
3. **Make your changes** following the code guidelines below
4. **Test** with `npm start`
5. **Lint**: `npm run lint`
6. **Submit a PR** against `main`

## Branch Naming

| Pattern | Use for |
|---------|---------|
| `feature/<scope>-<short-desc>` | All changes (features, fixes, docs) |

Scope examples: `i18n`, `ui`, `translation`, `whisper`, `model`, `queue`, `main`, `renderer`, `build`, `docs`

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Thai language support
fix: resolve ffprobe path on Linux
docs: update README with macOS instructions
refactor: extract progress logic into helper
```

## Code Guidelines

| Topic | Guideline |
|-------|-----------|
| I18N | Never hardcode UI strings. Add to `locales/i18n.js` and reference by key |
| Languages | Update all 5 languages (ko/en/ja/zh/pl) together when adding UI strings |
| Fallback | Use English for fallback strings (`\|\| 'English text'`), not Korean |
| Paths | Use `path.join()` and platform-aware logic, never hardcode `\` or `/` |
| Errors | Write error messages in English for runtime code |
| Comments | Code comments can be in any language |

## Testing Checklist

Before submitting, verify:

- [ ] App starts without errors (`npm start`)
- [ ] Lint passes (`npm run lint`)
- [ ] Extraction works (drag a video, click Start)
- [ ] Translation works (select a method, run end-to-end)
- [ ] UI language switch works for all 5 languages
- [ ] No hardcoded Korean in runtime strings (except i18n `ko:` values)

## Project Structure

```
WhisperSubTranslate/
├── main.js              # Electron main process
├── renderer.js          # UI logic (renderer process)
├── translator-enhanced.js  # Translation engine
├── myMemoryTranslator.js   # MyMemory API client
├── preload.js           # Electron preload script
├── index.html           # Main UI
├── styles.css           # Styles
├── locales/
│   └── i18n.js          # All UI strings (5 languages)
├── scripts/
│   └── postinstall.js   # Auto-downloads whisper-cli
└── .github/
    ├── ISSUE_TEMPLATE/  # Issue templates
    └── PULL_REQUEST_TEMPLATE.md
```

## Need Help?

- Open an [issue](https://github.com/Blue-B/WhisperSubTranslate/issues) for questions
- Check existing issues for `good first issue` labels
