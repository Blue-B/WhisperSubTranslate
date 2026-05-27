# WhisperSubTranslate

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [中文](./README.zh.md) | Polski

Szybka, lokalna aplikacja desktopowa do konwersji wideo na napisy (SRT) i tłumaczenia ich na wybrany język. Wykorzystuje whisper.cpp do ekstrakcji oraz opcjonalne silniki online do tłumaczenia.

> Ważne: Ta aplikacja tworzy nowe napisy SRT z dźwięku wideo za pomocą whisper.cpp. Nie wyodrębnia istniejących osadzonych ścieżek napisów ani tekstu na ekranie (brak OCR).

## Podgląd

![Główny interfejs WhisperSubTranslate](assets/hero/hero.png)

## Dlaczego WhisperSubTranslate

Ekstrakcja napisów działa w 100% lokalnie — Twoje wideo nigdy nie opuszcza Twojego komputera. Brak przesyłania do chmury, brak kont, brak kart kredytowych. Twórz dokładne pliki SRT offline; tłumaczenie też może działać **w pełni offline** z lokalnym modelem HY-MT, albo poprzez darmowe/płatne silniki online (MyMemory, własne klucze DeepL/OpenAI/Gemini).

### Wartość w skrócie

| Potrzeba                        | Co otrzymujesz                                |
| ------------------------------- | --------------------------------------------- |
| Prywatność i kontrola           | 100% lokalne STT; bez przesyłania do chmury   |
| Zero rejestracji                | Bez konta, karty kredytowej, danych osobowych |
| Nieograniczone użycie           | Brak dziennych/miesięcznych limitów aplikacji |
| Zrozumienie obcych filmów       | Ekstrakcja + tłumaczenie SRT za jednym razem  |
| Unikanie problemów z instalacją | Auto-pobieranie modeli; bez Pythona           |
| Przejrzysty feedback            | Kolejka, płynny postęp, ETA                   |

> Uwaga: Podczas korzystania z silników tłumaczenia online mogą obowiązywać limity dostawcy (np. kwota MyMemory). Sama aplikacja nie nakłada ograniczeń użytkowania.

## Rozpoczęcie pracy

### Dla użytkowników: uruchom wersję przenośną

- Pobierz najnowsze archiwum przenośne z Releases: `WhisperSubTranslate-v2.0.0-win-x64.zip`
- Otwórz rozpakowany folder i uruchom `WhisperSubTranslate.exe`

To wszystko — ekstrakcja działa w pełni offline na Twoim PC. Tłumaczenie jest opcjonalne (darmowy MyMemory jest wbudowany; DeepL/OpenAI wymagają własnych kluczy API).

### Dla deweloperów: uruchom ze źródła

```bash
npm install
npm start
```

- **whisper-cpp** jest automatycznie pobierany podczas `npm install` (Windows: ~700MB wersja CUDA)
- Na **Linux/macOS**, jeśli nie ma gotowego pliku binarnego, whisper.cpp jest automatycznie budowany ze źródeł (wymaga `cmake`, `gcc`/`clang`, `git`)
- **FFmpeg** jest automatycznie dołączony przez pakiet npm
- Przy pierwszym uruchomieniu wybrany model GGML zostanie pobrany do `_models/` jeśli brakuje

> Jeśli automatyczne pobieranie nie powiedzie się, pobierz ręcznie z [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) i rozpakuj do folderu `whisper-cpp/`.

### Konfiguracja Linux

WhisperSubTranslate działa na Linuksie po kilku dodatkowych krokach:

**Wymagane pakiety:**

```bash
# Ubuntu/Debian
sudo apt install cmake build-essential git ffmpeg

# Akceleracja CUDA GPU (opcjonalnie, wymaga NVIDIA GPU + sterowników)
# Zainstaluj CUDA Toolkit: https://developer.nvidia.com/cuda-downloads
```

**Uruchom ze źródeł:**

```bash
git clone https://github.com/Blue-B/WhisperSubTranslate.git
cd WhisperSubTranslate
npm install    # whisper.cpp zostanie automatycznie zbudowany ze źródeł
npm start
```

Jeśli automatyczna kompilacja się nie powiedzie, zbuduj whisper.cpp ręcznie:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

# Tylko CPU
cmake -B build && cmake --build build --config Release

# Z CUDA (NVIDIA GPU)
cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release

# Skopiuj plik binarny
cp build/bin/whisper-cli /path/to/WhisperSubTranslate/whisper-cpp/
```

### Budowanie (Windows)

```bash
npm run build-win
```

Artefakty są generowane do `dist2/`.

## Stack technologiczny

[![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=for-the-badge&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![DeepL](https://img.shields.io/badge/DeepL_API-0F2B46?style=for-the-badge&logo=deepl&logoColor=white)](https://www.deepl.com/pro-api) [![OpenAI](https://img.shields.io/badge/OpenAI_API-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)

| Obszar                   | Szczegóły                                        |
| ------------------------ | ------------------------------------------------ |
| Runtime                  | Electron, Node.js, JavaScript                    |
| Pakowanie                | electron-builder                                 |
| Sieć                     | axios                                            |
| Mowa-na-tekst            | whisper.cpp (modele GGML)                        |
| Tłumaczenie (opcjonalne) | DeepL API, OpenAI (GPT-5-nano), Gemini, MyMemory |

## Silniki tłumaczenia

| Silnik              | Koszt                | Klucz API | Limity / Uwagi                                                                                                       |
| ------------------- | -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| MyMemory            | Darmowy              | Nie       | ~50K znaków/dzień na IP                                                                                              |
| DeepL               | Darmowe 500K/miesiąc | Tak       | Dostępne płatne plany                                                                                                |
| GPT-5-nano (OpenAI) | Płatny               | Tak       | $0.05 wejście / $0.40 wyjście za 1M tokenów                                                                          |
| Gemini 3 Flash      | Darmowy/Płatny       | Tak       | Darmowy: 250 napisów/dzień (~20-30min), Płatny: bez limitu ([Pobierz klucz](https://aistudio.google.com/app/apikey)) |

> **Wskazówka**: Dla długich filmów (1h+) MyMemory może osiągnąć dzienny limit. Użyj Gemini lub DeepL.

Klucze API i preferencje są zapisywane lokalnie na Twoim PC w `app.getPath('userData')` z podstawowym kodowaniem, aby zapobiec przypadkowemu ujawnieniu. Plik konfiguracyjny nigdy nie jest przesyłany do Git ani dołączany do buildów.

### Lokalizacja danych

| Dane                    | Lokalizacja                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| Ustawienia & klucze API | `%APPDATA%\whispersubtranslate\translation-config-encrypted.json`   |
| Logi błędów (Windows)   | `%APPDATA%\whispersubtranslate\logs\errors.log`                     |
| Logi błędów (macOS)     | `~/Library/Application Support/whispersubtranslate/logs/errors.log` |
| Logi błędów (Linux)     | `~/.config/whispersubtranslate/logs/errors.log`                     |
| Historia zadań          | `%APPDATA%\whispersubtranslate\history.json` (do 200 wpisów)        |
| Modele                  | `_models/` (w folderze aplikacji)                                   |

### Historia zadań

- Każde zakończone zadanie jest automatycznie zapisywane — do **200 wpisów**.
- Każdy wiersz oferuje przyciski **Otwórz** (odtwarza plik wynikowy) i **Folder** (pokaż w eksploratorze).
- Możesz włączyć/wyłączyć historię w **Ustawienia → Historia**. Wyłączenie wstrzymuje tylko _nowe_ wpisy; istniejące dane są zachowywane.
- **Wyczyść wszystko** wykonuje bezpieczne kasowanie kryminalistyczne (plik nadpisywany zerami, usuwany, oraz wymuszona kompakcja resztek z localStorage). SSD wear leveling oznacza, że 100% nieodtwarzalności nie da się zagwarantować samym oprogramowaniem — dla twardych gwarancji użyj szyfrowania całego dysku.

### Bezpieczeństwo pobierania modeli

- Podczas pobierania na karcie modelu pojawia się przycisk **Anuluj** — możesz przerwać w dowolnym momencie.
- Zamknięcie okna w trakcie pobierania bezpiecznie przerywa transfer.
- Pliki Whisper GGML zapisywane są do ścieżki `.partial` i przenoszone na `ggml-*.bin` dopiero **po pełnym pobraniu** — częściowy plik nigdy nie zostanie pomylony z zainstalowanym modelem przy następnym uruchomieniu.

## Obsługa języków

### Języki interfejsu

Koreański, Angielski, Japoński, Chiński, Polski (5 języków)

### Języki docelowe tłumaczenia (14)

Koreański (ko), Angielski (en), Japoński (ja), Chiński (zh), Hiszpański (es), Francuski (fr), Niemiecki (de), Włoski (it), Portugalski (pt), Rosyjski (ru), Węgierski (hu), Arabski (ar), Polski (pl), **Perski (fa)**

### Języki rozpoznawania audio

whisper.cpp obsługuje ponad 100 języków, w tym wszystkie główne języki świata (angielski, hiszpański, francuski, niemiecki, włoski, portugalski, rosyjski, chiński, japoński, koreański, arabski, hindi, turecki i wiele innych).

## Modele i wydajność

Modele są przechowywane w `_models/` i automatycznie pobierane na żądanie. Wybierz rozmiar odpowiedni dla Twojego komputera; większe modele są wolniejsze, ale mogą być dokładniejsze. CUDA jest używana gdy dostępna; w przeciwnym razie domyślnie CPU.

| Model             | Rozmiar | VRAM | Szybkość      | Jakość     |
| ----------------- | ------- | ---- | ------------- | ---------- |
| tiny              | ~75MB   | ~1GB | Najszybszy    | Podstawowa |
| base              | ~142MB  | ~1GB | Szybki        | Dobra      |
| small             | ~466MB  | ~2GB | Średnia       | Lepsza     |
| medium            | ~1.5GB  | ~4GB | Wolna         | Świetna    |
| large-v3          | ~3GB    | ~5GB | Najwolniejsza | Najlepsza  |
| large-v3-turbo ⭐ | ~809MB  | ~4GB | Szybka        | Doskonała  |

> Uwaga: Wymagania VRAM dotyczą [whisper.cpp](https://github.com/ggerganov/whisper.cpp) z optymalizacją GGML, która jest znacznie niższa niż PyTorch Whisper (~10GB dla large). Przetestowano: large-v3 działa na GPU z 6GB VRAM.

## Strategia gałęzi

Pojedynczy trunk: `main` to jedyna długotrwała gałąź. Maintainer commituje bezpośrednio na `main` i taguje wydania (np. `v2.0.0`).

**Współtworzący:** otwórz Pull Request z forka. Krótkotrwałe gałęzie `feature/<scope>` są mile widziane; zostaną zmergowane przez squash do `main`.

## Współtworzenie

> **Chcesz dodać nowy język?** Zobacz [Przewodnik tłumaczenia](TRANSLATION.md).

### 1) Gałęzie i nazewnictwo

Używaj jednego typu gałęzi do wszystkiego (funkcje, poprawki, dokumentacja):

| Wzorzec                         | Użycie           |
| ------------------------------- | ---------------- |
| `feature/<scope>-<krótki-opis>` | Wszystkie zmiany |

Zalecane wartości <scope>: i18n, ui, translation, whisper, model, download, queue, progress, ipc, main, renderer, updater, config, build, logging, perf, docs, readme

Przykłady:

```text
feature/i18n-api-modal
feature/ui-progress-smoothing
feature/translation-deepl-test
feature/main-disable-devtools
```

### 2) Styl commitów (Conventional Commits)

Używaj prefiksów jak `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `build:`.

```text
feat: add DeepL connection test
fix: localize target language note
```

### 3) Wytyczne dotyczące kodu

| Temat            | Wytyczna                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| I18N             | Nie wstawiaj stringów UI/logów bezpośrednio. Dodaj je do tabel I18N i odwołuj się przez klucz |
| UX               | Utrzymuj spójność stanów postępu/ETA/kolejki; unikaj regresji                                 |
| Zakres           | Preferuj małe, skupione zmiany z czytelnymi nazwami funkcji                                   |
| Wielojęzyczny UI | Aktualizuj ko/en/ja/zh/pl razem przy dodawaniu UI                                             |

### 4) Ręczna lista kontrolna testów

| Scenariusz               | Weryfikacja                                                             |
| ------------------------ | ----------------------------------------------------------------------- |
| Tylko ekstrakcja         | Przepływy start/stop, zachowanie postępu/ETA                            |
| Ekstrakcja + tłumaczenie | Wynik end-to-end i finalna nazwa SRT                                    |
| Pobieranie modelu        | Brakująca ścieżka modelu; anulowanie/zatrzymanie w trakcie pobierania   |
| Przełączanie I18N        | Etykieta języka docelowego, teksty modalu API aktualizują się poprawnie |
| Silniki tłumaczenia      | MyMemory (bez klucza), DeepL/OpenAI (z kluczami)                        |
| Budowanie                | `npm run build-win` kończy się sukcesem                                 |

### 5) Lista kontrolna Pull Request

| Element     | Oczekiwanie                                                   |
| ----------- | ------------------------------------------------------------- |
| Opis        | Jasne wyjaśnienie zmian                                       |
| Wpływ na UI | Zrzuty ekranu dla zmian wizualnych                            |
| Testowanie  | Kroki do odtworzenia/weryfikacji                              |
| Zasoby      | Brak dużych plików binarnych w Git; zrzuty ekranu w `assets/` |

## Wsparcie

Jeśli ten projekt oszczędza Twój czas lub pomaga publikować lepsze napisy, wsparcie bezpośrednio przyspiesza rozwój:

- Twoje wsparcie pomaga: poprawki błędów, niezawodność pobierania modeli, dopracowanie UI, nowe opcje tłumaczenia i budowanie/testowanie Windows.
- Transparentność: Nie sprzedaję danych; fundusze idą na czas rozwoju, infrastrukturę dla buildów i kredyty testowe dla API tłumaczeń.
- Jednorazowi sponsorzy są wymienieni w README i notatkach wydania (możliwość rezygnacji).
- Miesięczni sponsorzy ($3/mies. przez GitHub Sponsors, automatyczne rozliczanie) otrzymują również priorytetową obsługę zgłoszeń "Sponsor Request" (best-effort).

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Jednorazowo_$3-Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h)

## Podziękowania

- whisper.cpp został opracowany przez Georgi Gerganova: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## Współtwórcy

Dziękujemy wszystkim, którzy pomagają ulepszać WhisperSubTranslate! 🙏

<a href="https://github.com/Blue-B/WhisperSubTranslate/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Blue-B/WhisperSubTranslate" alt="Contributors" />
</a>

## Aktywność repozytorium

![Repobeats analytics image](https://repobeats.axiom.co/api/embed/bb4da4df4fdd4f9193f24a6647d5f10022e9bab9.svg 'Repobeats analytics image')

## Tłumaczenia

Pomóż przetłumaczyć WhisperSubTranslate na swój język! Teksty do tłumaczenia znajdują się w [`locales/*.json`](locales/) i są zarządzane w [Weblate](https://hosted.weblate.org/engage/whispersubtranslate/). Zobacz [Przewodnik tłumaczenia](TRANSLATION.md).

<a href="https://hosted.weblate.org/engage/whispersubtranslate/">
  <img src="https://hosted.weblate.org/widget/whispersubtranslate/ui/multi-auto.svg" alt="Stan tłumaczenia" />
</a>

## Historia gwiazdek

<a href="https://star-history.com/#Blue-B/WhisperSubTranslate&Date">
  <img src="https://api.star-history.com/svg?repos=Blue-B/WhisperSubTranslate&type=Date" alt="Star History Chart" width="600" />
</a>

## Licencja

GPL-3.0. Zewnętrzne API/usługi (DeepL, OpenAI itp.) wymagają przestrzegania ich własnych warunków.
