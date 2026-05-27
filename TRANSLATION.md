# Translation Guide

Want to help translate WhisperSubTranslate into a new language? This guide covers everything you need.

## Current Languages

| Language | Code | UI  | Translation Target | Maintainer |
| -------- | ---- | --- | ------------------ | ---------- |
| Korean   | `ko` | ✅  | ✅                 | @Blue-B    |
| English  | `en` | ✅  | ✅                 | @Blue-B    |
| Japanese | `ja` | ✅  | ✅                 | @Blue-B    |
| Chinese  | `zh` | ✅  | ✅                 | @Blue-B    |
| Polish   | `pl` | ✅  | ✅                 | @Blue-B    |

## How to Add a New UI Language

### 1. Add translation strings

Translatable strings are split **per language as JSON**, and the bundled `locales/i18n.js` is **generated** from them — do not edit `locales/i18n.js` by hand.

1. Copy `locales/en.json` to `locales/<code>.json` (e.g. `locales/de.json`) and translate every value.
2. If a string needs interpolation/pluralization (e.g. `"Removed: ${name}"`), it lives in `locales/i18n.functions.js` as a small arrow function — copy the `en` entry there for your language too.
3. Regenerate the bundled global the app loads:

```bash
npm run i18n:build      # writes locales/i18n.js from the JSON + functions
npm run i18n:check      # verifies i18n.js is in sync (also runs in `npm run check` / CI)
```

> **Translate online**: You can also use [Weblate](https://hosted.weblate.org/engage/whispersubtranslate/), which edits the same `locales/*.json` files.
>
> **Important**: All keys must be present (236 strings + 25 interpolation helpers). Missing keys fall back to English.

### 2. Add LOG_I18N mappings (renderer.js)

In `renderer.js`, find the `LOG_I18N` object and add a mapping array for your language. This translates Korean log output into your language:

```js
const LOG_I18N = {
  en: [ ... ],
  ja: [ ... ],
  zh: [ ... ],
  pl: [ ... ],
  // Add your language:
  xx: [
    { re: /자막 추출을 시작합니다/g, to: 'Starting subtitle extraction' },
    { re: /처리 중:/g, to: 'Processing:' },
    // ... add patterns for log messages
  ]
};
```

### 3. Add language selector option

In `index.html`, add an `<option>` to the language selector:

```html
<select id="uiLangSelect">
  <option value="ko">한국어</option>
  <option value="en">English</option>
  <!-- Add your language -->
  <option value="xx">Your Language</option>
</select>
```

### 4. Add MODEL_I18N, LANG_NAMES_I18N entries (renderer.js)

In `renderer.js`, add your language to these objects:

- `MODEL_I18N.xx` — model descriptions
- `LANG_NAMES_I18N.xx` — language names in your language

### 5. (Optional) Add a README translation

Create `README.xx.md` following the same structure as `README.md`, and add a link to it in all existing READMEs.

### 6. Submit a Pull Request

- Branch: `feature/i18n-add-<language>`
- Include all modified files
- Test with `npm start` and switch the UI language to verify

## How to Add a Translation Target Language

Translation target languages allow users to translate subtitles into that language.

### 1. Add to i18n.js

In each language block, add your language to the `LANG_NAMES_I18N` mapping:

```js
LANG_NAMES_I18N = {
  ko: { ..., xx: '새언어' },
  en: { ..., xx: 'New Language' },
  // ... for all UI languages
};
```

### 2. Add to translator-enhanced.js

- `mapToHumanLang()` — add your language code mapping
- `mapToDeepLLang()` — add DeepL language code (if supported by DeepL)

### 3. Add to index.html

Add an `<option>` to the target language selector:

```html
<select id="targetLanguageSelect">
  <!-- Add your language -->
  <option value="xx">New Language</option>
</select>
```

## Tips

- Use the `en` block as the source of truth — it has the most neutral phrasing
- Keep translations concise — UI space is limited
- Test all screens: main UI, settings modal, queue display, error messages
- Edit `locales/*.json` (+ `i18n.functions.js` for interpolated strings), then run `npm run i18n:build`
- Run `npm run check` before submitting (lint + i18n sync + tests)

## Questions?

Open an [issue](https://github.com/Blue-B/WhisperSubTranslate/issues) with the label `i18n` if you need help.
