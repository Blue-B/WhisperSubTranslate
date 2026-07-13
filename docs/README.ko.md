# WhisperSubTranslate

[English](../README.md) | 한국어 | [日本語](./README.ja.md) | [中文](./README.zh.md) | [Polski](./README.pl.md)

영상을 내 PC에서 다국어 자막으로 만듭니다. 영상을 넣으면 whisper.cpp로 SRT를 생성하고, 번들된 Hy-MT2 모델로 오프라인 번역하거나 무료/유료 온라인 엔진으로 번역합니다.

> 이 앱은 영상의 음성을 받아써서 새 자막을 만듭니다. 영상에 들어 있는 자막 트랙을 추출하거나 화면의 글자를 읽지 않습니다(OCR 아님).

## 미리보기

<p align="center">
  <img src="../assets/hero/hero.png" alt="WhisperSubTranslate 메인 화면" width="100%">
</p>

## 주요 기능

- 음성 인식이 100% 로컬에서 돌아갑니다. 영상이 PC를 벗어나지 않고 계정도 업로드도 없습니다.
- 번들된 Hy-MT2 모델로 오프라인 번역하거나, 본인 키로 온라인 엔진(MyMemory, DeepL, OpenAI, Gemini)을 씁니다.
- 모델 자동 다운로드. 파이썬 설치나 수동 설정이 필요 없습니다.
- 일반 모델로 싱크가 밀릴 때 쓰는 싱크 교정 모델(large-v2 싱크, 싱크 라이트)을 제공합니다.
- 작업 큐, 실시간 진행률, 로컬 전용 작업 히스토리.

## 시작하기

### 사용자

[Releases](https://github.com/Blue-B/WhisperSubTranslate/releases)에서 최신 포터블 파일을 받아 압축을 풀고 `WhisperSubTranslate.exe`를 실행합니다. 자막 추출은 PC에서 완전히 오프라인으로 돌아갑니다. 번역은 선택입니다.

### 개발자

```bash
npm install
npm start
```

- Node.js 20.19 이상 또는 22.12 이상 (Electron 42 빌드 툴체인)
- whisper.cpp는 `npm install` 때 자동으로 받습니다 (윈도우는 CUDA 빌드, 약 700MB)
- FFmpeg는 npm으로 포함되며, 선택한 GGML 모델은 처음 쓸 때 받습니다

### Linux

```bash
sudo apt install cmake build-essential git ffmpeg   # Ubuntu/Debian
npm install   # whisper.cpp를 소스에서 빌드
npm start
```

CUDA 가속이 필요하면 `npm install` 전에 NVIDIA CUDA Toolkit을 설치하세요. whisper.cpp 수동 빌드 방법은 [CONTRIBUTING.md](../CONTRIBUTING.md)에 있습니다.

### Windows 빌드

```bash
npm run build-win   # 결과물은 dist2/에 생성됩니다
```

## 번역 엔진

번들된 Tencent Hy-MT2 모델로 완전히 오프라인 번역하거나, 본인 API 키로 무료/유료 온라인 엔진을 씁니다.

| 엔진 | 오프라인 | API 키 | 비용 | 비고 |
| --- | :---: | :---: | --- | --- |
| Hy-MT2 1.8B (로컬, 기본) | 예 | 불필요 | 무료 | 약 1.13GB, VRAM 2GB / RAM 4GB, 온디바이스 |
| Hy-MT2 7B (로컬) | 예 | 불필요 | 무료 | 약 6.16GB, VRAM 8GB / RAM 12GB, 더 큰 모델 |
| MyMemory | 아니오 | 불필요 | 무료 | IP당 하루 약 5만 자 |
| DeepL | 아니오 | 필요 | 월 50만 자 무료 | 결과가 일정함 |
| OpenAI GPT-5.4 mini | 아니오 | 필요 | 유료 | 문맥 인식 |
| OpenAI GPT-5.4 nano | 아니오 | 필요 | 유료 | 더 저렴한 등급 |
| Gemini 3 Flash | 아니오 | 필요 | 무료 / 저비용 | 추천 저비용 경로 ([키 받기](https://aistudio.google.com/app/apikey)) |

로컬 Hy-MT2 엔진만 API 키도, 네트워크도, 사용 비용도 필요 없어서 대사가 PC를 벗어나지 않습니다.

### 번역 품질 (오프라인 엔진)

WhisperSubTranslate는 Tencent Hy-MT2 모델(기본 1.8B, 선택 7B)을 함께 제공합니다. Tencent 공식 평가에서 Hy-MT2 계열은 주요 상용 번역 API와 경쟁력 있는 결과를 보였고, 일부 벤치마크에서는 앞선 결과도 냈습니다.

![Tencent Hy-MT2 공식 벤치마크, WhisperSubTranslate 번들 모델](../assets/hy-mt2-benchmark.ko.png)

출처: Tencent 공식 벤치마크: [Hy-MT2 저장소](https://github.com/Tencent-Hunyuan/Hy-MT2), [기술 보고서](https://arxiv.org/pdf/2605.22064), [HuggingFace 모델](https://huggingface.co/tencent/Hy-MT2-1.8B). 위 그래프는 Tencent 공식 Figure 1을 재작도한 것이며, 내장 모델(1.8B/7B) 수치는 논문 표와 대조했습니다. 이 수치는 표준 기계번역 벤치마크(WildMTBench, WMT25, FLORES-200 등)에서 모델 자체를 측정한 결과이며, WhisperSubTranslate 앱 자체를 재측정한 것은 아닙니다.

긴 영상(1시간 이상)에서는 MyMemory 일일 한도 때문에 느려질 수 있습니다. 그럴 때는 Gemini, DeepL, 설정한 GPT 모델을 쓰세요.

## 음성 인식 모델

모델은 필요할 때 `_models/`로 받아집니다. CUDA가 있으면 GPU, 없으면 CPU로 돌아갑니다. GPU에 맞는 크기를 고르세요.

| 모델 | 크기 | VRAM | 속도 | 비고 |
| --- | --- | --- | --- | --- |
| tiny | 약 75MB | 약 1GB | 가장 빠름 | 기본 |
| base | 약 142MB | 약 1GB | 빠름 | 양호 |
| small | 약 466MB | 약 1GB | 보통 | 더 좋음 |
| medium | 약 1.5GB | 약 2GB | 보통 | 우수 |
| large-v3 | 약 3GB | 약 4GB | 느림 | 받아쓰기 최고 |
| large-v3-turbo (기본) | 약 809MB | 약 2GB | 빠름 | 전반적으로 가장 무난 |
| large-v2 싱크 | 약 4.4GB | 약 4.5GB | 느림 | 별도 엔진, 자막 싱크 교정 |
| large-v2 싱크 라이트 | 공용 | 약 3GB | 느림 | 싱크와 같은 파일, int8, 저VRAM |

싱크와 싱크 라이트는 별도 Faster-Whisper 엔진(한 번 자동 다운로드, 약 4.4GB)을 쓰고 같은 모델 파일을 공유해서, 한 번 받으면 둘 다 쓸 수 있습니다. 일반 모델로 싱크가 밀릴 때만 쓰세요. 비영어 영상(일본어, 한국어, 중국어)에서 가장 정확하고, 영어는 보통 large-v3-turbo로 충분합니다.

whisper.cpp 모델의 VRAM은 GGML 최적화 기준이라 PyTorch Whisper(large 약 10GB)보다 훨씬 적습니다. 싱크 모델 수치는 Faster-Whisper 벤치마크 기준입니다.

## 언어 지원

- UI: 한국어, 영어, 일본어, 중국어, 폴란드어
- 번역 대상(15개): ko, en, ja, zh, es, fr, de, it, pt, ru, hu, ar, pl, tr, fa
- 음성 인식: whisper.cpp로 100개 이상 언어

## 데이터 저장

모든 데이터는 사용자 폴더에 로컬로만 저장되고 업로드되지 않습니다.

| 데이터 | 위치 |
| --- | --- |
| 설정 및 API 키 | `%APPDATA%\whispersubtranslate\translation-config-safe.json` |
| 작업 히스토리 | `%APPDATA%\whispersubtranslate\history.json` (최대 200개) |
| 에러 로그 | `%APPDATA%\whispersubtranslate\logs\errors.log` |
| 모델 | `_models/` (앱 폴더) |

API 키는 OS 보안 저장소로 로컬에 저장되고, 설정 파일은 깃에 올라가거나 빌드에 포함되지 않습니다. 작업 히스토리는 선택이고(설정에서 토글) 최대 200개까지 보관됩니다.

## 기여

Pull Request를 환영합니다. 브랜치 네이밍, 커밋 규칙, 수동 테스트 체크리스트, whisper.cpp 수동 빌드는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 보세요. 언어 추가는 [번역 가이드](./TRANSLATION.md)를 참고하세요.

[Weblate](https://hosted.weblate.org/engage/whispersubtranslate/)에서 번역에 참여할 수 있습니다. 번역 문자열은 [`locales/*.json`](../locales/)에 있습니다.

## 기여자

WhisperSubTranslate를 함께 만들어주는 모든 분께 감사합니다.

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/matbgn"><img src="https://github.com/matbgn.png?size=80" width="80" alt="matbgn" title="matbgn" /></a>
<a href="https://github.com/AtillaTahak"><img src="https://github.com/AtillaTahak.png?size=80" width="80" alt="AtillaTahak" title="AtillaTahak" /></a>

## 후원

이 프로젝트가 시간을 아껴줬다면, 후원은 버그 수정과 모델 안정화, 새 번역 옵션 작업에 직접 도움이 됩니다.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## 감사의 말

- whisper.cpp: Georgi Gerganov [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Hy-MT2: Tencent [Tencent-Hunyuan/Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## 라이선스

GPL-3.0. 외부 API와 서비스(DeepL, OpenAI, Gemini 등)는 각자의 약관을 따릅니다.
