/* eslint-disable no-unused-vars -- classic renderer scripts share this global lexical state */
let fileQueue = []; // processing queue (처리 대기열)
let cachedApiConfig = {}; // 마지막으로 불러온 공급자 설정 (모델명 표시·옵션 구성용)
let cachedDefaultPrompt = ''; // 기본 번역 프롬프트 (저장 시 기본값과 같으면 비워 저장)
let cachedModelPresets = {}; // 키 없이도 고를 수 있는 알려진 모델 목록 (공급자별)
let isProcessing = false;
let currentProcessingIndex = -1;
let availableModels = {};
let shouldStop = false; // stop flag (중지 플래그)
let lastProgress = 0; // last displayed progress (마지막 표시된 진행률)
let targetProgress = 0; // target progress (목표 진행률)
let targetText = '';
let progressTimer = null;
let indeterminateTimer = null; // pseudo progress timer (의사 진행률 타이머)
let _extractionMaxProgress = 95; // 현재 파일 추출 단계가 차지하는 진행률 상한(번역 있으면 50)
let _extractionWarmupProgress = 0; // 의사 진행률(모델 로딩 구간)이 기어갈 상한. 실제 -pp 값은 이 위에서 이어받는다.
let _currentPhase = null;
let translationSessionActive = false; // translation in progress (번역 진행 상태)
let _translationProgressFromZero = false; // 추출 없이 번역만 하는(SRT 단독) 세션이면 0-100 그대로 사용
let _stoppedAt = 0; // timestamp when stopProcessing() was called
// 세션 epoch: startProcessing 진입 시 증가. 이전 세션의 비동기 콜백/이벤트는
// 캠처한 epoch와 현재 epoch가 다르면 무시한다 (중지 후 재시작 stale 이벤트 방지).
let _processingEpoch = 0;
let _lastFocusedBeforeModal = null; // 설정 모달 열기 직전 포커스 (닫을 때 복원용)
let _settingsApiDirty = false;
let _settingsEditRevision = 0;
let _settingsLoadToken = 0;
let _maxTranslatedCurrent = 0; // monotonic counter for parallel translation progress display
let _curLangIndex = 0; // 다국어 번역 시 현재 언어 순번(변경되면 X/total 카운터 리셋)

// UI 업데이트 디바운스 (UI freeze 방지)
let updateQueueDisplayTimer = null;
let lastQueueUpdateTime = 0;
const MIN_QUEUE_UPDATE_INTERVAL = 200; // 최소 200ms 간격으로 UI 업데이트

// Sound settings (알림음 설정)
let soundVolume = parseFloat(localStorage.getItem('soundVolume') ?? '0.6');
let soundMuted = localStorage.getItem('soundMuted') === 'true';
// 실패 항목 자동 재시도 상한 — 무한루프 방지 (파일당 autoRetryCount로 추적)
const AUTO_RETRY_MAX = 2;

let currentUiLang = 'ko';
