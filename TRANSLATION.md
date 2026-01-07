# Translation Guide

This guide explains how to add a new language to WhisperSubTranslate.

## Current Supported Languages

- Korean (ko) - Default
- English (en)
- Japanese (ja)
- Chinese Simplified (zh)
- Polish (pl)

## How to Add a New Language

### Step 1: Find the I18N Object

Open `renderer.js` and search for `const I18N = {`.

```javascript
const I18N = {
  ko: { ... },
  en: { ... },
  ja: { ... },
  zh: { ... },
  pl: { ... },
};
```

### Step 2: Copy an Existing Language Block

Copy the entire `en` block (English is recommended as a base).

### Step 3: Add Your Language

Add a new block with your language code. Use [ISO 639-1 codes](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes).

```javascript
const I18N = {
  ko: { ... },
  en: { ... },
  ja: { ... },
  zh: { ... },
  pl: { ... },
  // Add your language here
  es: {  // Spanish
    titleText: 'WhisperSubTranslate',
    dropTitle: 'Arrastrar y soltar archivos',
    dropHint1: 'Arrastra archivos de video o SRT aquí',
    // ... translate ALL keys
  },
};
```

### Step 4: Translate All Keys

Make sure to translate **every key**. There are approximately 100+ keys.

#### Important Notes:

1. **Function values** - Keep the structure, only translate the text:
   ```javascript
   // Original
   removedFromQueue: (name) => `Removed from queue: ${name}`,
   // Spanish
   removedFromQueue: (name) => `Eliminado de la cola: ${name}`,
   ```

2. **HTML content** - Preserve HTML tags:
   ```javascript
   // Original
   geminiHelpHtml: 'Get a free API key from <a href="...">Google AI Studio</a>.',
   // Spanish
   geminiHelpHtml: 'Obtén una clave API gratuita en <a href="...">Google AI Studio</a>.',
   ```

3. **Variables** - Keep `${variable}` intact:
   ```javascript
   // Original
   processingFile: (idx, total, name) => `[${idx}/${total}] Processing: ${name}`,
   // Spanish
   processingFile: (idx, total, name) => `[${idx}/${total}] Procesando: ${name}`,
   ```

### Step 5: Add Language to Related Objects

Search for these objects in `renderer.js` and add your language:

1. **MODEL_I18N** - Search for `const MODEL_I18N = {` - Model descriptions
2. **LANG_NAMES_I18N** - Search for `const LANG_NAMES_I18N = {` - Language names
3. **DEVICE_OPTIONS_I18N** - Search for `const DEVICE_OPTIONS_I18N` - Device options
4. **TR_METHOD_I18N** - Search for `const TR_METHOD_I18N` - Translation method names

### Step 6: Test Your Translation

1. Run the app: `npm start`
2. Change language in settings (if UI selector exists) or modify `currentUiLang` temporarily
3. Check all screens for missing or broken translations

### Step 7: Submit a Pull Request

1. Fork the repository
2. Create a branch: `git checkout -b add-spanish-translation`
3. Commit your changes: `git commit -m "Add Spanish translation"`
4. Push and create a PR

## Tips

- Use consistent terminology throughout
- Keep translations concise (UI space is limited)
- Test on different screen sizes
- If unsure about a term, check how other apps translate it

## Questions?

Open an issue on GitHub if you need help with translations.
