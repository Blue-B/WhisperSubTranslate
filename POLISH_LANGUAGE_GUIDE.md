Hey! Good question. There are 3 different language settings in this app:

| Setting | Location | Polish Support |
|---------|----------|---------------|
| **Audio detection** (Whisper) | Left dropdown | Use "Auto Detect" - works out of the box |
| **Translation target** | Bottom dropdown | Need to add to dropdown |
| **UI language** (top-right) | Program interface | Need 70+ string translations |

---

## 1. Audio Detection (Whisper)

No changes needed. Just select **"Auto Detect"** and Whisper will recognize Polish audio automatically.

---

## 2. Translation Target Language

Edit 2 files:

**`index.html`** - Add to `targetLanguageSelect` dropdown:
```html
<option value="pl">Polish (pl)</option>
```

**`translator-enhanced.js`** - Find `mapToHumanLang` function and add:
```javascript
pl: 'Polish (Polski)',
```

---

## 3. UI Language (Program Interface - Top Right)

This requires more work:

**`index.html`** - Add to `uiLanguageSelect` dropdown:
```html
<option value="pl">Polski</option>
```

**`renderer.js`** - Add complete `pl` object to `I18N` (around line 50). You need to translate 70+ strings. Here's the structure:

```javascript
pl: {
  titleText: 'WhisperSubTranslate',
  dropTitle: 'Przeciągnij i upuść pliki',
  dropHint1: 'Przeciągnij tutaj pliki wideo',
  dropHint2: 'Obsługiwane: MP4, AVI, MKV, MOV, WMV',
  queueTitle: 'Kolejka przetwarzaniaㅊ',
  clearQueueBtn: 'Wyczyść kolejkę',
  // ... 70+ more strings (copy from 'en' section and translate)
},
```

You can copy the entire `en: { ... }` block and translate each value to Polish.

---

A major UI redesign and architecture update is coming in the next release. I'll consider adding Polish UI support if there's interest!
