# WhisperSubTranslate

[English](../README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [中文](./README.zh.md) | Polski

Zamień dowolne wideo na napisy wielojęzyczne, lokalnie. Wrzuć wideo, wygeneruj SRT za pomocą whisper.cpp, a następnie przetłumacz je offline dołączonym modelem Hy-MT2 albo darmowymi/płatnymi silnikami online.

> Aplikacja tworzy nowe napisy z dźwięku wideo (mowa na tekst). Nie wyciąga osadzonych ścieżek napisów ani nie czyta tekstu z ekranu (bez OCR).

## Podgląd

<p align="center">
  <img src="../assets/hero/hero.png" alt="WhisperSubTranslate, główny interfejs" width="100%">
</p>

## Funkcje

- Rozpoznawanie mowy w 100% lokalnie. Twoje wideo nie opuszcza komputera, bez konta, bez wysyłania.
- Tłumaczenie offline dołączonym modelem Hy-MT2 lub silnikami online (MyMemory, DeepL, OpenAI, Gemini) z własnymi kluczami.
- Automatyczne pobieranie modeli. Bez Pythona, bez ręcznej konfiguracji.
- Modele naprawy synchronizacji (large-v2 Sync i Sync Lite) do wideo, gdzie zwykłe modele tracą synchronizację.
- Kolejka, postęp na żywo i lokalna historia zadań.

## Pierwsze kroki

### Użytkownicy

Pobierz najnowsze archiwum przenośne z [Releases](https://github.com/Blue-B/WhisperSubTranslate/releases), rozpakuj je i uruchom `WhisperSubTranslate.exe`. Wyodrębnianie napisów działa w pełni offline. Tłumaczenie jest opcjonalne.

### Programiści

```bash
npm install
npm start
```

- Node.js >= 20.19 lub >= 22.12 (łańcuch narzędzi Electron 42)
- whisper.cpp jest pobierany podczas `npm install` (wersja CUDA na Windows, ~700MB)
- FFmpeg jest dołączony przez npm; wybrany model GGML pobiera się przy pierwszym użyciu

### Linux

```bash
sudo apt install cmake build-essential git ffmpeg   # Ubuntu/Debian
npm install   # whisper.cpp budowany ze źródeł
npm start
```

Aby przyspieszyć przez CUDA, zainstaluj NVIDIA CUDA Toolkit przed `npm install`. Ręczne kroki budowania whisper.cpp są w [CONTRIBUTING.md](../CONTRIBUTING.md).

### Budowanie (Windows)

```bash
npm run build-win   # wynik trafia do dist2/
```

## Silniki tłumaczeń

Tłumacz napisy w pełni offline dołączonym modelem Tencent Hy-MT2 albo kieruj do darmowych/płatnych silników online przy użyciu własnych kluczy API.

| Silnik | Offline | Klucz API | Koszt | Uwagi |
| --- | :---: | :---: | --- | --- |
| Hy-MT2 1.8B (lokalny, domyślny) | Tak | Nie | Darmowy | ~1,13GB, VRAM 2GB / RAM 4GB, na urządzeniu |
| Hy-MT2 7B (lokalny) | Tak | Nie | Darmowy | ~6,16GB, VRAM 8GB / RAM 12GB, większy model |
| MyMemory | Nie | Nie | Darmowy | ~50K znaków/dzień na IP |
| DeepL | Nie | Tak | 500K/mies. darmowo | Stabilny wynik |
| OpenAI GPT-5.4 mini | Nie | Tak | Płatny | Świadomy kontekstu |
| OpenAI GPT-5.4 nano | Nie | Tak | Płatny | Tańszy poziom |
| Gemini 3 Flash | Nie | Tak | Darmowy / tani | Zalecana tania ścieżka ([pobierz klucz](https://aistudio.google.com/app/apikey)) |

Tylko lokalny silnik Hy-MT2 nie wymaga klucza API, sieci ani opłat za użycie, więc dialogi nie opuszczają komputera.

### Jakość tłumaczenia (silnik offline)

WhisperSubTranslate dołącza modele Tencent Hy-MT2 (domyślnie 1.8B, opcjonalnie 7B). W oficjalnej ocenie Tencent rodzina Hy-MT2 konkuruje z czołowymi komercyjnymi API tłumaczeniowymi i w części benchmarków uzyskuje lepsze wyniki.

![Oficjalny benchmark Tencent Hy-MT2, model dołączony do WhisperSubTranslate](../assets/hy-mt2-benchmark.pl.png)

Źródło: oficjalne benchmarki Tencent: [repozytorium Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2), [raport techniczny](https://arxiv.org/pdf/2605.22064), [modele na HuggingFace](https://huggingface.co/tencent/Hy-MT2-1.8B). Wykres jest przerysowany z oficjalnego Figure 1 Tencent, a liczby modeli dołączonych (1.8B/7B) sprawdzono z tabelami w pracy. Liczby mierzą sam model na standardowych benchmarkach tłumaczenia maszynowego (WildMTBench, WMT25, FLORES-200 itd.), nie są osobnym benchmarkiem aplikacji WhisperSubTranslate.

Przy długich filmach (1h+) dzienny limit MyMemory może powodować spowolnienia. Użyj wtedy Gemini, DeepL lub skonfigurowanego modelu GPT.

## Modele rozpoznawania mowy

Modele pobierają się na żądanie do `_models/`. CUDA jest używana, gdy dostępna, w przeciwnym razie CPU. Wybierz rozmiar pasujący do GPU.

| Model | Rozmiar | VRAM | Szybkość | Uwagi |
| --- | --- | --- | --- | --- |
| tiny | ~75MB | ~1GB | Najszybszy | Podstawowy |
| base | ~142MB | ~1GB | Szybki | Dobry |
| small | ~466MB | ~1GB | Średni | Lepszy |
| medium | ~1,5GB | ~2GB | Średni | Bardzo dobry |
| large-v3 | ~3GB | ~4GB | Wolny | Najlepsza transkrypcja |
| large-v3-turbo (domyślny) | ~809MB | ~2GB | Szybki | Najlepszy ogólnie |
| large-v2 Sync | ~4,4GB | ~4,5GB | Wolny | Osobny silnik, naprawa synchronizacji |
| large-v2 Sync Lite | wspólny | ~3GB | Wolny | Ten sam plik co Sync, int8, niższy VRAM |

Sync i Sync Lite używają osobnego silnika Faster-Whisper (pobieranego raz automatycznie, ~4,4GB) i współdzielą ten sam plik modelu, więc jedno pobranie obejmuje oba. Używaj ich tylko, gdy zwykłe modele tracą synchronizację. Są najdokładniejsze przy wideo nieangielskim (japoński, koreański, chiński). Angielski zwykle wystarczy z large-v3-turbo.

VRAM modeli whisper.cpp podano dla optymalizacji GGML, znacznie niżej niż PyTorch Whisper (~10GB dla large). Wartości Sync pochodzą z benchmarku Faster-Whisper.

## Obsługa języków

- Interfejs: koreański, angielski, japoński, chiński, polski
- Cele tłumaczenia (15): ko, en, ja, zh, es, fr, de, it, pt, ru, hu, ar, pl, tr, fa
- Rozpoznawanie mowy: ponad 100 języków przez whisper.cpp

## Przechowywanie danych

Wszystko zostaje lokalnie w folderze użytkownika. Nic nie jest wysyłane.

| Dane | Lokalizacja |
| --- | --- |
| Ustawienia i klucze API | `%APPDATA%\whispersubtranslate\translation-config-safe.json` |
| Historia zadań | `%APPDATA%\whispersubtranslate\history.json` (do 200 wpisów) |
| Logi błędów | `%APPDATA%\whispersubtranslate\logs\errors.log` |
| Modele | `_models/` (folder aplikacji) |

Klucze API są przechowywane lokalnie w bezpiecznym magazynie systemu, a plik konfiguracji nigdy nie trafia do Git ani do builda. Historia zadań jest opcjonalna (przełącznik w Ustawieniach) i ograniczona do 200 wpisów.

## Współtworzenie

Pull Requesty mile widziane. Nazewnictwo gałęzi, styl commitów, lista testów
ręcznych i ręczne budowanie whisper.cpp są w
[CONTRIBUTING.md](../CONTRIBUTING.md). Aby dodać język interfejsu lub język
docelowy tłumaczenia, zobacz [Przewodnik tłumaczeń](./TRANSLATION.md).

Pomóż tłumaczyć interfejs aplikacji na
[Weblate](https://hosted.weblate.org/engage/whispersubtranslate/); teksty
interfejsu są w [`locales/*.json`](../locales/).

## Współtwórcy

Dziękujemy wszystkim, którzy pomagają ulepszać WhisperSubTranslate.

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/matbgn"><img src="https://github.com/matbgn.png?size=80" width="80" alt="matbgn" title="matbgn" /></a>
<a href="https://github.com/AtillaTahak"><img src="https://github.com/AtillaTahak.png?size=80" width="80" alt="AtillaTahak" title="AtillaTahak" /></a>

## Wsparcie

Jeśli ten projekt oszczędza Ci czas, wsparcie pomaga w poprawkach błędów, niezawodności modeli i nowych opcjach tłumaczeń.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## Podziękowania

- whisper.cpp: Georgi Gerganov [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Hy-MT2: Tencent [Tencent-Hunyuan/Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## Licencja

GPL-3.0. Zewnętrzne API i usługi (DeepL, OpenAI, Gemini itd.) wymagają zgodności z ich własnymi warunkami.
