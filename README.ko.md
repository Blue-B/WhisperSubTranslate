# WhisperSubTranslate

[English](./README.md) | 한국어 | [日本語](./README.ja.md) | [中文](./README.zh.md)

로컬에서 동영상의 음성을 인식해 SRT 자막을 만들고, 원하는 언어로 번역하는 Windows 데스크톱 앱입니다. 추출은 Faster‑Whisper 실행 파일로 안정적으로 처리되며, 번역은 MyMemory(무료), DeepL, ChatGPT(OpenAI)를 선택할 수 있습니다.

## 미리보기

![메인 UI](docs/preview_ko.png)

## 왜 WhisperSubTranslate를 써야 할까요?

모든 처리는 로컬에서 이루어집니다. 영상은 내 PC 밖으로 나가지 않습니다. 계정도 카드도 필요 없습니다. 정확한 SRT를 오프라인으로 만들고, 필요할 때만 번역(무료 MyMemory 또는 내 DeepL/OpenAI 키)을 추가하세요.

### 핵심 가치 한눈에

| 고민 | 제공 가치 |
| --- | --- |
| 프라이버시/통제 | 100% 로컬 STT, 클라우드 업로드 없음 |
| 가입/결제 불필요 | 계정/카드/개인정보 입력 없이 사용 |
| 사용 제한 없음 | 앱 차원의 일/월 사용량 제한 없음 |
| 외국어 영상 이해 | 추출+번역 SRT를 한 번에 생성 |
| 설치/환경 부담 | 모델 자동 다운로드, 파이썬 불필요 |
| 진행률/피드백 | 대기열, 매끄러운 진행률, ETA |

> 참고: 온라인 번역 엔진을 사용할 경우, 제공사(M yMemory 등)의 정책/쿼터는 적용될 수 있습니다. 앱 자체는 별도의 사용 제한을 두지 않습니다.

## 시작하기

```bash
npm install
npm start
```
첫 실행 시 모델이 없으면 `_models/`에 자동 내려받습니다.

### Windows 빌드
```bash
npm run build-win
```
산출물은 `dist/`에 생성됩니다.

## 개발자 설정(로컬 실행/빌드)

로컬 개발 시 Faster‑Whisper 실행파일이 필요합니다.

1) Purfview 릴리스에서 `Faster-Whisper-XXL_r245.4_windows.7z` 다운로드: https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL
2) `.bat` 파일을 제외하고 프로젝트 루트(`main.js`와 같은 위치)로 압축 해제합니다. 예시(7‑Zip):
```powershell
7z x Faster-Whisper-XXL_r245.4_windows.7z -x!*.bat -o.
```
3) 루트에 `faster-whisper-xxl.exe`(필요 DLL 포함)가 있는지 확인
4) 실행:
```bash
npm install
npm start
```
5) 패키징 전에도 exe가 존재해야 합니다:
```bash
npm run build-win
```
참고: exe나 `.bat`는 깃에 커밋하지 마세요. 배포용 설치 파일에만 포함됩니다.

## 기술 스택

[![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=for-the-badge&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![DeepL](https://img.shields.io/badge/DeepL_API-0F2B46?style=for-the-badge&logo=deepl&logoColor=white)](https://www.deepl.com/ko/pro-api) [![OpenAI](https://img.shields.io/badge/OpenAI_API-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)

| 영역 | 설명 |
| --- | --- |
| 런타임 | Electron, Node.js, JavaScript |
| 패키징 | electron‑builder |
| 네트워킹 | axios |
| 음성→텍스트 | Faster‑Whisper 실행 파일 |
| 번역(선택) | DeepL API, OpenAI(ChatGPT), MyMemory |

## 번역 엔진

| 엔진 | 비용 | 키 | 제한 / 비고 |
| --- | --- | --- | --- |
| MyMemory | 무료 | 불필요 | IP당 일 약 5만자 |
| DeepL | 월 50만자 무료 | 필요 | 유료 플랜 제공 |
| ChatGPT(OpenAI) | 유료 | 필요 | 사용량 과금 |

API 키/설정은 `app.getPath('userData')` 아래 `translation-config.json`에 저장되며 Git/배포물에 포함되지 않습니다.

## 모델과 성능

모델은 `_models/`에 저장되고 필요 시 자동 내려받습니다. 큰 모델일수록 느리지만 더 정확할 수 있습니다. CUDA 가능 시 GPU, 아니면 CPU로 동작합니다.

## 브랜치(단순 Trunk)

Trunk 기반 개발: `main`을 단일 기준(트렁크)으로 두고, 짧은 생명의 분기에서 작업한 뒤 PR로 빠르게 머지합니다.

| 브랜치 | 목적 | 규칙 |
| --- | --- | --- |
| main | 항상 배포 가능 | 예: `v1.0.0`으로 태깅 |
| feature/* | 작은 단위 작업 | `main`에서 분기, PR로 `main`에 머지 |

## 기여

### 1) 브랜치/네이밍

모든 변경(기능/수정/문서)은 하나의 타입으로 통일합니다.

| 패턴 | 용도 |
| --- | --- |
| `feature/<scope>-<설명>` | 모든 변경 |

권장 <scope> 예시: i18n, ui, translation, whisper, model, download, queue, progress, ipc, main, renderer, updater, config, build, logging, perf, docs, readme

예시:
```text
feature/i18n-api-modal
feature/ui-progress-smoothing
feature/translation-deepl-test
feature/main-disable-devtools
```

### 2) 커밋 규칙(Conventional Commits)
`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `build:` 접두어를 사용하세요.

```text
feat: add DeepL connection test
fix: localize target language note
```

### 3) 코드 가이드(I18N)

| 주제 | 가이드 |
| --- | --- |
| I18N | UI/로그 문자열을 코드에 직접 쓰지 말고 I18N 테이블 키로 참조 |
| UX | 진행률/ETA/대기열 동작 일관성 유지, 회귀 방지 |
| 범위 | 작은 단위의 집중된 변경, 명확한 함수명 |
| 다국어 UI | UI 추가 시 ko/en/ja/zh 함께 업데이트 |

### 4) 수동 테스트 체크리스트

| 시나리오 | 검증 항목 |
| --- | --- |
| 추출만 | 시작/중지, 진행률/ETA 동작 |
| 추출+번역 | 종단 결과와 최종 SRT 파일명 |
| 모델 다운로드 | 누락 모델 자동 다운로드, 중간 취소/정지 |
| I18N 전환 | 대상 언어 라벨/모달 텍스트가 즉시 갱신 |
| 번역 엔진 | MyMemory(무키), DeepL/OpenAI(키) |
| 빌드 | `npm run build-win` 완료 |

### 5) PR 체크리스트

| 항목 | 기대 사항 |
| --- | --- |
| 설명 | 변경 사항을 명확히 기술 |
| UI 영향 | 시각적 변경 스크린샷 첨부 |
| 테스트 | 재현/검증 절차 제공 |
| 자산 | 대용량 바이너리 금지, 스크린샷은 `docs/` |

## 후원

이 프로젝트가 시간을 아껴주거나 더 나은 자막을 만드는 데 도움이 된다면, 후원은 개발 속도를 직접 높여줍니다.
- 사용처: 버그 수정, 모델 다운로드 안정화, UI 다듬기, 번역 옵션 확장, Windows 빌드/테스트
- 투명성: 데이터 판매 없음. 후원금은 개발 시간, 릴리스 빌드 인프라, 번역 API 테스트 비용에만 사용합니다.
- 일시 후원도 스폰서 명단(README/릴리스 노트)에 이름을 표기합니다(비공개 요청 가능).
- 월 정기 후원($3/mo, GitHub Sponsors 자동결제)은 “Sponsor Request” 이슈 우선 확인(베스트 에포트) 혜택을 추가로 제공합니다.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/일시후원_$3-Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h)

## 감사의 말

- Faster‑Whisper 단독 실행 파일을 제공해 주신 프로젝트에 감사드립니다: [Purfview/whisper-standalone-win](https://github.com/Purfview/whisper-standalone-win)

## 라이선스

ISC. 외부 API/서비스(DeepL, OpenAI 등)는 각 약관을 준수해야 합니다. 