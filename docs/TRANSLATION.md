# Translation Guide

Want to help translate WhisperSubTranslate into a new language? This guide covers everything you need.

## Current Languages

### UI languages

| Language | Code | Maintainer |
| -------- | ---- | ---------- |
| Korean   | `ko` | @Blue-B    |
| English  | `en` | @Blue-B    |
| Japanese | `ja` | @Blue-B    |
| Chinese  | `zh` | @Blue-B    |
| Polish   | `pl` | @Blue-B    |

### Translation targets

The app currently supports these 15 translation targets:

`ko`, `en`, `ja`, `zh`, `es`, `fr`, `de`, `it`, `pt`, `ru`, `hu`, `ar`,
`pl`, `tr`, `fa`

Turkish (`tr`) is a translation target only. It does not provide a Turkish UI
or a Turkish README yet.

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
> **Important**: Every key in `locales/en.json` and every helper in
> `locales/i18n.functions.js` must be present. Missing keys fall back to English.

### 2. Add LOG_I18N mappings (src/renderer/features/logs.js)

In `src/renderer/features/logs.js`, find the `LOG_I18N` object and add a mapping array for your language. This translates Korean status output into your language. Keep patterns anchored to the status prefix so they cannot rewrite filenames, subtitle text or error details. Extend `scripts/test-log-localization.js` with representative producer messages:

```js
const LOG_I18N = {
  en: [ ... ],
  ja: [ ... ],
  zh: [ ... ],
  pl: [ ... ],
  // Add your language:
  xx: [
    { re: /^자막 추출을 시작합니다/, to: 'Starting subtitle extraction' },
    { re: /^처리 중:/, to: 'Processing:' },
    // ... add patterns for log messages
  ]
};
```

### 3. Add language selector option

In `src/renderer/index.html`, add an `<option>` to the language selector:

```html
<select id="uiLanguageSelect">
  <option value="ko">한국어</option>
  <option value="en">English</option>
  <!-- Add your language -->
  <option value="xx">Your Language</option>
</select>
```

Model names, descriptions, and target-language names come from the `modelNames`, `modelDescriptions`, `modelSelectNames`, `modelSelectDescs`, and `langNames` keys in the locale JSON you created in step 1.

### 4. (Optional) Add a README translation

Create `docs/README.xx.md` following the structure of `README.md` and the existing translations. Use `../` for links to root files or assets, and add its language link to all existing READMEs.

### 5. Submit a Pull Request

- Branch: `feature/i18n-add-<language>`
- Include all modified files
- Run `npm run i18n:check` and `npm run check`
- Test with `npm start` using a separate profile as described in [CONTRIBUTING.md](../CONTRIBUTING.md)
- Switch languages and check narrow-window wrapping, keyboard access, logs and settings

## How to Add a Translation Target Language

Translation target languages allow users to translate subtitles into that language.

### 1. Add display names

Add the language code to the `langNames` object in every `locales/*.json` UI language file:

```json
{
  "langNames": {
    "xx": "New Language"
  }
}
```

### 2. Add provider mappings

- In `src/main/services/translator.js`, update `mapToHumanLang()`.
- In `src/main/services/translator.js`, update `mapToDeepLLang()` if DeepL supports the language.
- In `src/main/services/local-translator.js`, update `LANGUAGE_NAMES` for the bundled Hy-MT2 model.

### 3. Add to src/renderer/index.html

Add a checkbox to the `targetLanguageList` panel:

```html
<div id="targetLanguageList">
  <!-- Add your language -->
  <label class="lang-check"> <input type="checkbox" value="xx" /><span>New Language (xx)</span> </label>
</div>
```

### 4. Update docs and tests

- Add the code to the translation-target list in every README.
- Add smoke-test assertions for provider and human-readable mappings.
- Run `npm run check` before submitting.

## Tips

- Use the `en` block as the source of truth — it has the most neutral phrasing
- Keep translations concise — UI space is limited
- Test all screens: main UI, settings modal, queue display, error messages
- Edit `locales/*.json` (+ `i18n.functions.js` for interpolated strings), then run `npm run i18n:build`
- Run `npm run check` before submitting (lint + i18n sync + tests)

## Questions?

Open an [issue](https://github.com/Blue-B/WhisperSubTranslate/issues) with the label `i18n` if you need help.
