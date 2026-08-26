// Queue-based renderer for multi-file processing (memory-leak safe) (대기열 기반 렌더러 - 다중 파일 처리)
console.log('[Renderer] renderer.js v1.5.1 loaded');

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

// 번역 상태 문자열은 locales의 <strong>/<br>만 허용해 DOM으로 만든다.
function setStatusMarkup(element, markup) {
  const fragment = document.createDocumentFragment();
  let parent = fragment;
  String(markup || '')
    .split(/(<strong(?:\s[^>]*)?>|<\/strong>|<br\s*\/?>)/gi)
    .filter(Boolean)
    .forEach((part) => {
      if (/^<strong/i.test(part)) {
        const strong = document.createElement('strong');
        if (/color\s*:\s*#e74c3c/i.test(part)) strong.style.color = '#e74c3c';
        fragment.appendChild(strong);
        parent = strong;
      } else if (/^<\/strong/i.test(part)) {
        parent = fragment;
      } else if (/^<br/i.test(part)) {
        fragment.appendChild(document.createElement('br'));
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    });
  element.replaceChildren(fragment);
}

function setSafeHtml(element, markup) {
  const doc = new DOMParser().parseFromString(String(markup || ''), 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,link,meta,style,base').forEach((node) => node.remove());
  doc.body.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        (['href', 'src', 'xlink:href', 'formaction'].includes(name) && /^\s*(?:javascript|vbscript):/i.test(attr.value))
      ) {
        node.removeAttribute(attr.name);
      }
    });
  });
  element.replaceChildren(...Array.from(doc.body.childNodes, (node) => document.importNode(node, true)));
}

// Toast notification (토스트 알림)
function showToast(message, options = {}) {
  // 기존 토스트 제거
  const existingToast = document.querySelector('.toast-notification');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #333;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    animation: slideIn 0.3s ease;
  `;

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (options.label && options.onClick) {
    const btn = document.createElement('button');
    btn.textContent = options.label;
    btn.style.cssText = `
      background: #4CAF50;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    btn.onclick = () => {
      options.onClick();
      toast.remove();
    };
    toast.appendChild(btn);
  }

  document.body.appendChild(toast);

  // 5초 후 자동 제거
  setTimeout(() => toast.remove(), 5000);
}

// Utility: sleep function for delays (지연용 sleep 함수)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Supported video extensions (지원되는 비디오 파일 확장자)
const SUPPORTED_EXTENSIONS = [
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.ts',
  '.mts',
  '.m2ts',
  '.mpg',
  '.mpeg',
  '.3gp',
];

function isVideoFile(filePath) {
  const ext = filePath.toLowerCase().substr(filePath.lastIndexOf('.'));
  return SUPPORTED_EXTENSIONS.includes(ext);
}

// Check if file is SRT subtitle file (SRT 파일 확인)
function isSrtFile(filePath) {
  const ext = filePath.toLowerCase().substr(filePath.lastIndexOf('.'));
  return ext === '.srt';
}

// Check if queue contains only SRT files (큐에 SRT 파일만 있는지 확인)
// 완료 토스트 키 결정: SRT-only 모드면 srt 도와 설명, 그 외에는 기존 키
function getAllDoneKey(method) {
  if (typeof hasOnlySrtFiles === 'function' && hasOnlySrtFiles()) return 'allDoneSrtOnly';
  return !method || method === 'none' ? 'allDoneNoTr' : 'allDoneWithTr';
}

function hasOnlySrtFiles() {
  if (fileQueue.length === 0) return false;
  return fileQueue.every((file) => isSrtFile(file.path));
}

// Check if queue contains any SRT files (큐에 SRT 파일이 있는지 확인)
function hasAnySrtFiles() {
  return fileQueue.some((file) => isSrtFile(file.path));
}

// Update UI mode based on queue contents (큐 내용에 따라 UI 모드 전환)
let _updateUIModeInProgress = false;
function updateUIMode() {
  if (_updateUIModeInProgress) return;
  _updateUIModeInProgress = true;
  try {
    const modelCard = document.getElementById('modelSelect')?.closest('.setting-card');
    const languageCard = document.getElementById('languageSelect')?.closest('.setting-card');
    const deviceCard = document.getElementById('deviceSelect')?.closest('.setting-card');
    const translationCard = document.getElementById('translationSelect')?.closest('.setting-card');
    const translationSelect = document.getElementById('translationSelect');

    const srtOnlyMode = hasOnlySrtFiles();
    const hasSrt = hasAnySrtFiles();
    const d = I18N[currentUiLang] || I18N.ko;

    // 처리/번역 중에는 번역 방식을 바꿀 수 없게 한다. 중간에 'none'으로 바꾸면
    // 완료 이벤트가 드롭되어 다음 파일 자동 진행이 멈추는 99% 동결이 발생한다 (F2).
    if (translationSelect) {
      translationSelect.disabled = isProcessing || translationSessionActive;
    }

    if (srtOnlyMode) {
      // SRT 전용 모드: whisper 모델·언어 숨김. device는 local 번역일 때만 표시
      if (modelCard) modelCard.style.display = 'none';
      if (languageCard) languageCard.style.display = 'none';
      const method = translationSelect?.value;
      if (deviceCard) deviceCard.style.display = method === 'local' ? '' : 'none';
      if (translationCard) translationCard.style.display = '';
      // 드롭존 힌트 변경
      const dropHint1 = document.getElementById('dropHint1');
      if (dropHint1) dropHint1.textContent = d.srtModeHint || 'SRT translation mode - select a translation method';
    } else {
      // 일반 모드: whisper는 device 항상 필요
      if (modelCard) modelCard.style.display = '';
      if (languageCard) languageCard.style.display = '';
      if (deviceCard) deviceCard.style.display = '';
      if (translationCard) translationCard.style.display = '';
      // 드롭존 힌트 복원
      const dropHint1 = document.getElementById('dropHint1');
      if (dropHint1) dropHint1.textContent = d.dropHint1;
    }

    // 혼합 모드 경고 (동영상 + SRT 섞여 있을 때)
    if (hasSrt && !srtOnlyMode && fileQueue.length > 0) {
      let mixedWarning = document.getElementById('mixedFileWarning');
      const warningText =
        d.mixedFileWarning || 'Mixed video and SRT files. Each file type will be processed accordingly.';

      if (!mixedWarning) {
        mixedWarning = document.createElement('div');
        mixedWarning.id = 'mixedFileWarning';
        mixedWarning.className = 'mixed-file-warning';
        const queueContainer = document.getElementById('queueContainer');
        if (queueContainer) {
          queueContainer.insertBefore(mixedWarning, queueContainer.firstChild);
        }
      }
      // 항상 내용 업데이트 (언어 변경 대응)
      // "번역 안함" 선택 시 SRT 스킵 예고 경고 추가
      const translationValue = translationSelect?.value;
      const warning = document.createElement('span');
      warning.textContent = warningText;
      if (translationValue === 'none') {
        const skipWarningText =
          d.srtWillBeSkipped ||
          'SRT files will be skipped without translation settings. Please select a translation method.';
        const skipWarning = document.createElement('span');
        skipWarning.className = 'skip-warning';
        skipWarning.textContent = skipWarningText;
        mixedWarning.replaceChildren(warning, skipWarning);
      } else {
        mixedWarning.replaceChildren(warning);
      }
    } else {
      const mixedWarning = document.getElementById('mixedFileWarning');
      if (mixedWarning) mixedWarning.remove();
    }

    // translationStatus 재동기화 (SRT 추가/제거 시 상태 표시 갱신)
    // 값이 실제로 바뀌었을 때만 change를 강제 dispatch한다 (설정 파일 IPC 쓰기 증폭 방지).
    const ts = document.getElementById('translationSelect');
    if (ts && ts.dataset.lastSyncedValue !== ts.value) {
      ts.dataset.lastSyncedValue = ts.value;
      ts.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } finally {
    _updateUIModeInProgress = false;
  }
}

// Check model status and update UI (모델 상태 확인 및 UI 업데이트)
async function checkModelStatus() {
  try {
    availableModels = await window.electronAPI.checkModelStatus();
    updateModelSelect();
  } catch (error) {
    console.error('Model status check failed:', error);
  }
}

// Note: updateModelSelect is defined in the i18n section below
// Note: updateQueueDisplay / updateQueueDisplayImmediate are defined below (~line 1790+)

// 대기열 드래그 앤 드롭 설정
let draggedItem = null;
let draggedIndex = null;

function setupQueueDragAndDrop() {
  const queueList = document.getElementById('queueList');
  if (!queueList) return;

  const items = queueList.querySelectorAll('.queue-item.draggable');
  const dragHandles = queueList.querySelectorAll('.drag-handle');
  console.log('[DragDrop] Draggable items:', items.length, 'Drag handles:', dragHandles.length);

  items.forEach((item) => {
    // 처음에는 드래그 비활성화 (핸들로만 드래그 가능하게)
    item.setAttribute('draggable', 'false');

    // 드래그 핸들에서만 드래그 시작 허용
    const handle = item.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', (e) => {
        console.log('[DragDrop] Handle mousedown - drag activated');
        item.setAttribute('draggable', 'true');
        e.stopPropagation(); // 이벤트 전파 방지
      });

      // 마우스 업 시 드래그 비활성화 복원
      handle.addEventListener('mouseup', () => {
        // dragend 에서 처리하므로 여기서는 불필요
      });
    }

    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', function (e) {
      // 드래그 끝나면 다시 비활성화
      this.setAttribute('draggable', 'false');
      handleDragEnd.call(this, e);
    });
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
  });
}

function handleDragStart(e) {
  console.log('[DragDrop] dragstart event fired, index:', this.dataset.index);
  draggedItem = this;
  draggedIndex = parseInt(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedIndex);
}

function handleDragEnd(_e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.queue-item').forEach((item) => {
    item.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
  });
  draggedItem = null;
  draggedIndex = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const targetIndex = parseInt(this.dataset.index);
  if (targetIndex === draggedIndex) return;

  // 마우스 위치에 따라 위/아래 표시
  const rect = this.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;

  this.classList.remove('drag-over-top', 'drag-over-bottom');
  if (e.clientY < midY) {
    this.classList.add('drag-over-top');
  } else {
    this.classList.add('drag-over-bottom');
  }
}

function handleDragEnter(e) {
  e.preventDefault();
  if (this !== draggedItem) {
    this.classList.add('drag-over');
  }
}

function handleDragLeave(_e) {
  this.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  console.log('[DragDrop] drop event fired, target:', this.dataset.index, 'dragged:', draggedIndex);

  const targetIndex = parseInt(this.dataset.index);
  if (targetIndex === draggedIndex || isNaN(targetIndex) || isNaN(draggedIndex)) {
    console.log('[DragDrop] Drop cancelled - same position or invalid index');
    return;
  }
  // 처리 중에는 재정렬 금지: currentProcessingIndex가 어긋나 미처리 파일이
  // completed로 마킹되거나 누락될 수 있다. (드래그 시작 후 처리 시작된 경우 방어)
  if (isProcessing) {
    console.log('[DragDrop] Drop cancelled - processing in progress');
    return;
  }

  // 마우스 위치에 따라 삽입 위치 결정
  const rect = this.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  let insertIndex = e.clientY < midY ? targetIndex : targetIndex + 1;

  // 드래그된 아이템이 타겟보다 앞에 있으면 인덱스 조정
  if (draggedIndex < insertIndex) {
    insertIndex--;
  }

  // 배열 순서 변경
  const [movedItem] = fileQueue.splice(draggedIndex, 1);
  fileQueue.splice(insertIndex, 0, movedItem);

  // UI 업데이트
  updateQueueDisplay();
  updateUIMode();

  this.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
}

function updateProgress(progress, text) {
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const progressPercent = document.getElementById('progressPercent');
  const progressTitle = document.getElementById('progressTitle');

  // Keep visible during processing; update width only on numeric (항상 표시 유지, 숫자일 때만 폭 업데이트)
  progressContainer.style.display = 'block';
  if (typeof progress === 'number' && !isNaN(progress)) {
    lastProgress = Math.max(0, Math.min(100, progress));
    progressFill.style.width = lastProgress + '%';
  }
  // 진행률 퍼센트와 텍스트를 함께 표시 (예: "25% - 번역 중...")
  const pctStr = `${Math.round(lastProgress)}%`;

  // 오른쪽 상단 퍼센트 표시 업데이트
  if (progressPercent) {
    progressPercent.textContent = pctStr;
  }

  // 상단 타이틀도 상태에 맞게 업데이트
  if (progressTitle) {
    const d = I18N[currentUiLang];
    if (lastProgress >= 100) {
      progressTitle.textContent = d.progressComplete || 'Complete!';
    } else if (lastProgress > 0) {
      progressTitle.textContent = d.progressProcessing || 'Processing...';
    } else {
      progressTitle.textContent = d.progressPreparing || 'Preparing...';
    }
  }

  // Step stepper update
  const stepExtract = document.getElementById('stepExtract');
  const stepTranslate = document.getElementById('stepTranslate');
  const stepDone = document.getElementById('stepDone');
  const stepLine1 = document.getElementById('stepLine1');
  const stepLine2 = document.getElementById('stepLine2');
  if (stepExtract && stepTranslate && stepDone) {
    // Detect translation phase across all UI languages
    const d_step = I18N[currentUiLang] || I18N.ko;
    const translatingLabel = (d_step.progressTranslating || '').toLowerCase();
    const isTranslating =
      text &&
      ((translatingLabel && text.toLowerCase().includes(translatingLabel.replace('...', '').trim().toLowerCase())) ||
        text.includes('번역') ||
        text.includes('翻訳') ||
        text.includes('翻译') ||
        text.toLowerCase().includes('translat') ||
        text.toLowerCase().includes('tłumacze'));
    const isDone = lastProgress >= 100;
    stepExtract.className =
      'progress-step ' + (isDone ? 'done' : isTranslating ? 'done' : lastProgress > 0 ? 'active' : '');
    stepTranslate.className = 'progress-step ' + (isDone ? 'done' : isTranslating ? 'active' : '');
    stepDone.className = 'progress-step ' + (isDone ? 'done' : '');
    if (stepLine1)
      stepLine1.className =
        'progress-step-line ' + (isTranslating || isDone ? 'done' : lastProgress > 0 ? 'active' : '');
    if (stepLine2) stepLine2.className = 'progress-step-line ' + (isDone ? 'done' : '');
  }

  if (text && text.trim()) {
    progressText.textContent = `${pctStr} - ${text}`;
  } else {
    progressText.textContent = pctStr;
  }
}

function startProgressAnimation() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    if (lastProgress < targetProgress) {
      // Ease by 20% of delta (min 1%) for smoothness (현재 차이의 20%만큼 증가)
      const gap = targetProgress - lastProgress;
      const step = Math.max(1, Math.round(gap * 0.2));
      const next = Math.min(targetProgress, lastProgress + step);
      updateProgress(next, targetText);
    } else if (lastProgress >= 100 && targetProgress >= 100) {
      // Stop timer at completion (완료 시 타이머 종료)
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }, 100);
}

function stopProgressAnimation() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function setProgressTarget(progress, text) {
  const safe = typeof progress === 'number' && !isNaN(progress) ? Math.max(0, Math.min(100, progress)) : lastProgress;
  targetProgress = safe;
  if (text) targetText = text;
  // Show once immediately so the bar appears early (즉시 한 번 표시)
  updateProgress(lastProgress, targetText);
  startProgressAnimation();
}

// startIndeterminate는 하단에 i18n 버전으로 정의됨 (1728줄)

function stopIndeterminate() {
  if (indeterminateTimer) {
    clearInterval(indeterminateTimer);
    indeterminateTimer = null;
  }
}

// resetProgress는 하단에 i18n 버전으로 정의됨 (1751줄)

// ---------------------------------------------------------------------------
// Log output: timestamp + icon + category color + consecutive group collapse.
// Classifies each line by message text and renders <div class="log-line">.
// ---------------------------------------------------------------------------
// Order matters: 'stop' must be checked before 'process' (“처리 중지”
// contains the word “처리” which would otherwise match the process rule).
const _LOG_CATS = [
  { id: 'stop', icon: '■', re: /(중지|stopp|stopped by user|停止|中止|中断|zatrzym)/i },
  { id: 'error', icon: '✗', re: /(실패|fail|error|エラー|失败|错误|błąd|nieuda)/i },
  { id: 'skip', icon: '»', re: /(스킵|skip|スキップ|跳过|忽略|pomiń)/i },
  { id: 'success', icon: '✓', re: /(완료|complete|finished|完了|完成|zakończon|^Smoke tests passed)/i },
  {
    id: 'remove',
    icon: '−',
    re: /(대기열에서 제거됨|removed from queue|キューから削除|已从队列中移除|已从队列中删除|Usunięto z kolejki)/i,
  },
  { id: 'translate', icon: '⇄', re: /(번역|translat|翻訳|翻译|tłumacz)/i },
  { id: 'process', icon: '▶', re: /(처리 중|processing|処理中|处理中|przetwarz)/i },
  { id: 'add', icon: '+', re: /(추가됨|added|追加|已添加|已添加到|dodan|already in queue|이미 대기열)/i },
  { id: 'info', icon: '·', re: /.*/ },
];
// whisper 전사 출력 줄 감지: " [00:00:15.320 --> 00:00:19.460]   text" 형태.
const _TRANSCRIPT_LINE_RE = /\[\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->/;
function _classifyLog(line) {
  // 전사 줄은 상태 메시지가 아니라 자막 "내용"이다. 내용에 error/errors/fail 같은
  // 단어가 들어있어도(예: TypeScript errors 강의) 에러 줄로 오분류하면 안 되므로
  // 키워드 매칭을 건너뛰고 info(·)로 처리한다.
  if (_TRANSCRIPT_LINE_RE.test(line)) return _LOG_CATS[_LOG_CATS.length - 1];
  for (const c of _LOG_CATS) if (c.re.test(line)) return c;
  return _LOG_CATS[_LOG_CATS.length - 1];
}
function _ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
let _lastLog = { cat: null, count: 0, groupEl: null };
const _LOG_GROUP_THRESHOLD = 3; // 3개 이상 연속이면 "... 외 N개"

function _appendLogLine(output, line) {
  const cat = _classifyLog(line);
  const sameAsPrev = _lastLog.cat && _lastLog.cat.id === cat.id;

  if (sameAsPrev) {
    _lastLog.count += 1;
    if (_lastLog.count >= _LOG_GROUP_THRESHOLD) {
      // Collapse: keep the first 2 개의 visible 줄 + 1개의 summary 줄.
      // clearOutput()/prune 등으로 groupEl이 DOM에서 제거된 뒤에도 재사용하면
      // 줄이 화면에 붙지 않으므로 연결 상태를 확인하고 재생성한다.
      if (!_lastLog.groupEl || !_lastLog.groupEl.isConnected) {
        const el = document.createElement('div');
        el.className = `log-line log-${cat.id} log-group`;
        output.appendChild(el);
        _lastLog.groupEl = el;
      }
      const extras = _lastLog.count - 2;
      const foldFn = I18N[currentUiLang]?.logGroupMoreItems;
      _lastLog.groupEl.textContent = `${_ts()}  ${cat.icon}  (... ${foldFn ? foldFn(extras) : `외 ${extras}개 항목`})`;
      return;
    }
  } else {
    _lastLog = { cat, count: 1, groupEl: null };
  }

  const el = document.createElement('div');
  el.className = `log-line log-${cat.id}`;
  el.textContent = `${_ts()}  ${cat.icon}  ${line}`;
  el.title = line;
  output.appendChild(el);
}

function addOutput(text) {
  const output = document.getElementById('output');
  if (!output) return;
  // Split incoming text into lines; ignore empty lines (the old code dumped lots of \n).
  const lines = String(text)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of lines) _appendLogLine(output, line);
  // Prune to last 500 lines to keep DOM light during long batches.
  while (output.childNodes.length > 500) output.removeChild(output.firstChild);
  output.scrollTop = output.scrollHeight;
}

function clearOutput() {
  const output = document.getElementById('output');
  if (output) output.textContent = '';
  _lastLog = { cat: null, count: 0, groupEl: null };
  _translatingLineEl = null; // 진행 줄 참조도 초기화 (이전 세션 div는 이미 제거됨)
}

// File selector (multi-select) (파일 선택 함수, 다중 선택 지원)**
async function selectFile() {
  try {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'], // allow multi-selection (다중 선택 허용)
      filters: [
        {
          name: 'Video & Subtitle Files',
          extensions: [
            'mp4',
            'avi',
            'mkv',
            'mov',
            'wmv',
            'flv',
            'webm',
            'm4v',
            'ts',
            'mts',
            'm2ts',
            'mpg',
            'mpeg',
            '3gp',
            'srt',
          ],
        },
        {
          name: 'Video Files',
          extensions: [
            'mp4',
            'avi',
            'mkv',
            'mov',
            'wmv',
            'flv',
            'webm',
            'm4v',
            'ts',
            'mts',
            'm2ts',
            'mpg',
            'mpeg',
            '3gp',
          ],
        },
        { name: 'Subtitle Files (SRT)', extensions: ['srt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      addToQueueBatch(result.filePaths);

      addOutput(`${I18N[currentUiLang].filesAddedToQueue(result.filePaths.length)}\n`);
    }
  } catch (error) {
    console.error('File select error:', error);
    addOutput(`${I18N[currentUiLang].fileSelectError(error.message)}\n`);
  }
}

// Queue management helpers (대기열 관리)
// Batch 모드: 여러 개 일괄 추가 시 UI 갱신 억제로 메인스레드 점유 방지
let _addBatchActive = false;
function addToQueue(filePath) {
  // deduplicate files (중복 파일 체크)
  if (fileQueue.some((file) => file.path === filePath)) {
    addOutput(`${I18N[currentUiLang].alreadyInQueue(filePath.split('\\').pop() || filePath.split('/').pop())}\n`);
    return;
  }

  fileQueue.push({
    path: filePath,
    status: 'pending',
    progress: 0,
    addedAt: new Date(),
  });

  if (!_addBatchActive) {
    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
  }
}

// 여러 파일을 한 번에 추가할 때 사용 (DOM 갱신 1회로 압축)
function addToQueueBatch(filePaths) {
  _addBatchActive = true;
  try {
    for (const p of filePaths) addToQueue(p);
  } finally {
    _addBatchActive = false;
  }
  updateQueueDisplay();
  updateUIMode();
}

function retryQueueItem(index) {
  if (index >= 0 && index < fileQueue.length) {
    const file = fileQueue[index];
    if (file.status === 'stopped' || file.status === 'error') {
      file.status = 'pending';
      file.progress = 0;
      updateQueueDisplay();
    }
  }
}

function removeFromQueue(index) {
  if (index >= 0 && index < fileQueue.length) {
    const file = fileQueue[index];

    // cannot remove item currently processing (처리 중 파일 삭제 불가)
    if (file.status === 'processing' || file.status === 'translating') {
      addOutput(`${I18N[currentUiLang].cannotRemoveProcessing}\n`);
      return;
    }

    const removedFile = fileQueue.splice(index, 1)[0];
    const fileName = removedFile.path.split('\\').pop() || removedFile.path.split('/').pop();

    // adjust current index (현재 처리 인덱스 조정)
    if (currentProcessingIndex > index) {
      currentProcessingIndex--;
    }

    addOutput(`${I18N[currentUiLang].removedFromQueue(fileName)}\n`);
    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
  }
}

function clearQueue() {
  if (!isProcessing) {
    // when idle: clear all (처리 중 아님 → 전체 삭제)
    fileQueue = [];
    currentProcessingIndex = -1;
    // 이전 완료 상태(100% / 완료 텍스트) 완전 리셋
    if (typeof resetProgress === 'function') resetProgress();
    _maxTranslatedCurrent = 0;
    _stoppedAt = 0;
    shouldStop = false;
    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
    addOutput(`${I18N[currentUiLang].queueCleared}\n`);
  } else {
    // when busy: remove only pending items (처리 중엔 대기 항목만 삭제)
    // clearCompletedFromQueue의 removedBefore 패턴 재사용: 제거된 항목이 현재
    // 처리 인덱스보다 앞이면 차감하지 않으면 translating이 영구 스턱한다.
    let removedBefore = 0;
    fileQueue.forEach((file, idx) => {
      if (file.status === 'pending' && idx < currentProcessingIndex) removedBefore++;
    });
    currentProcessingIndex -= removedBefore;
    const pendingFiles = fileQueue.filter((file) => file.status === 'pending');
    fileQueue = fileQueue.filter((file) => file.status !== 'pending');

    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
    addOutput(`${I18N[currentUiLang].pendingFilesRemoved(pendingFiles.length)}\n`);
  }
}

// 완료된(completed) 항목만 큐에서 일괄 제거. 진행 중/대기 중 항목은 보존.
function clearCompletedFromQueue() {
  const completed = fileQueue.filter((file) => file.status === 'completed');
  if (completed.length === 0) {
    addOutput(`${I18N[currentUiLang].noCompletedToClear}\n`);
    return;
  }

  // 현재 처리 인덱스가 제거되는 항목들 뒤로 밀리지 않도록 보정
  let removedBefore = 0;
  fileQueue.forEach((file, idx) => {
    if (file.status === 'completed' && idx < currentProcessingIndex) removedBefore++;
  });
  currentProcessingIndex -= removedBefore;

  fileQueue = fileQueue.filter((file) => file.status !== 'completed');
  updateQueueDisplay();
  updateUIMode(); // SRT/동영상 모드 전환
  addOutput(`${I18N[currentUiLang].completedFilesRemoved(completed.length)}\n`);
}

// 출력 정리(Output cleanup) 설정값을 읽어 extract IPC로 전달.
// 사운드 설정과 동일하게 localStorage에 영구 저장된다. 기본값: 모두 꺼짐.
function getCleanupOptions() {
  return {
    removeSpeakerTags: localStorage.getItem('removeSpeakerTags') === 'true',
    removeSDH: localStorage.getItem('removeSDH') === 'true',
  };
}

function stopProcessing() {
  if (isProcessing || translationSessionActive) {
    shouldStop = true;
    isProcessing = false;
    translationSessionActive = false;
    _stoppedAt = Date.now();
    // 진행 중인 비동기 콜백을 무효화: 캠처한 epoch와 달라져 stale 이벤트가 무시된다.
    _processingEpoch++;
    stopIndeterminate();
    stopProgressAnimation(); // 진행률 애니메이션 interval도 함께 정지 (타이머 누수 방지)
    addOutput(`\n${I18N[currentUiLang].stopRequested}\n`);

    // force-stop current work (현재 진행 작업 강제 중지)
    window.electronAPI.stopCurrentProcess();

    // revert processing item back to stopped
    // 2초 finalize 창에 이미 completed로 마킹된 파일은 revert하지 않는다 (MED-11)
    if (currentProcessingIndex >= 0 && currentProcessingIndex < fileQueue.length) {
      const _curFile = fileQueue[currentProcessingIndex];
      if (_curFile.status !== 'completed') {
        _curFile.status = 'stopped';
        _curFile.progress = 0;
      }
    }

    currentProcessingIndex = -1;
    // 즉시 UI 되돌림: 진행률/상태 텍스트 초기화, 버튼 표시 재평가
    try {
      lastProgress = 0;
      setProgressTarget(0, I18N[currentUiLang].allStopped || 'Processing stopped.');
    } catch (_) {
      /* noop */
    }
    updateQueueDisplay();
    if (typeof updateUIMode === 'function') updateUIMode();
  }
}

function openFileLocation(filePath) {
  window.electronAPI.openFileLocation(filePath);
}

// 클립보드 복사 함수
function copyToClipboard(text, type) {
  const d = I18N[currentUiLang] || I18N.ko;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const toast = document.getElementById('copyToast');
      toast.textContent = type === 'filename' ? d.fileNameCopied : d.pathCopied;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 1500);
    })
    .catch((err) => {
      console.error('Copy failed:', err);
    });
}

async function openOutputFolder() {
  if (fileQueue.length > 0) {
    const firstFile = fileQueue.find((f) => f.status === 'completed') || fileQueue[0];
    const sep = firstFile.path.includes('/') ? '/' : '\\';
    const folderPath = firstFile.path.substring(0, firstFile.path.lastIndexOf(sep));
    window.electronAPI.openFolder(folderPath);
  }
}

// 처리 계속 함수 (일시정지 재개 시에도 사용) - 전역 함수로 선언
async function continueProcessing() {
  console.log('[continueProcessing] Called, isProcessing:', isProcessing);
  console.log(
    '[continueProcessing] Queue status:',
    fileQueue.map((f) => ({ path: f.path.split('\\').pop() || f.path.split('/').pop(), status: f.status }))
  );

  const model = document.getElementById('modelSelect').value;
  const language = document.getElementById('languageSelect').value;
  const device = document.getElementById('deviceSelect').value;

  // 중지 요청이 들어왔으면 즉시 종료 (shouldStop 무조건 리셋 금지)
  if (shouldStop) {
    console.log('[continueProcessing] shouldStop=true, exiting');
    return;
  }

  // 처리할 파일 찾기
  let fileToProcess = null;
  let fileIndex = -1;

  console.log('[continueProcessing] Searching for files, queue length:', fileQueue.length);

  for (let i = 0; i < fileQueue.length; i++) {
    const file = fileQueue[i];
    console.log(
      `[continueProcessing] File ${i}: status=${file.status}, path=${file.path.split('\\').pop() || file.path.split('/').pop()}`
    );

    if (
      file.status !== 'completed' &&
      file.status !== 'error' &&
      file.status !== 'stopped' &&
      file.status !== 'skipped' &&
      file.status !== 'translating' &&
      file.status !== 'processing'
    ) {
      fileToProcess = file;
      fileIndex = i;
      console.log(`[continueProcessing] Found file to process at index ${i}`);
      break;
    }
  }

  console.log('[continueProcessing] Search complete, file found:', fileToProcess ? 'yes' : 'no');

  // 처리할 파일이 없으면 완료
  if (!fileToProcess) {
    isProcessing = false;
    shouldStop = false;
    currentProcessingIndex = -1;
    updateQueueDisplay();
    // 번역 select 재활성화 (완료 경로와 동일하게 — 안 하면 영구 비활성)
    if (typeof updateUIMode === 'function') updateUIMode();

    const completedCount = fileQueue.filter((f) => f.status === 'completed').length;
    const errorCount = fileQueue.filter((f) => f.status === 'error').length;
    const stoppedCount = fileQueue.filter((f) => f.status === 'stopped').length;
    const skippedCount = fileQueue.filter((f) => f.status === 'skipped').length;

    {
      const d = I18N[currentUiLang];
      if (stoppedCount > 0 || (_stoppedAt && Date.now() - _stoppedAt < 10000)) {
        showToast(d.allStopped || 'Processing stopped.');
      } else if (errorCount > 0 && completedCount === 0) {
        setProgressTarget(100, getAllFailedMsg());
        showToast(getAllFailedMsg());
      } else if (skippedCount > 0 && completedCount === 0) {
        // 전부 skip: '완료' 토스트는 오해를 부르므로 생략 (출력 로그에 skip 사유가 이미 남음)
        setProgressTarget(100, d.allDoneNoTr || 'All files completed!');
      } else if (errorCount > 0) {
        setProgressTarget(100, d.allDoneWithErrors || `Done with ${errorCount} error(s)`);
        showToast(d.allDoneWithErrors || `Done with ${errorCount} error(s)`, {
          label: d.toastOpenFolder,
          onClick: openOutputFolder,
        });
      } else {
        const _k = getAllDoneKey(document.getElementById('translationSelect')?.value);
        setProgressTarget(100, d[_k]);
        showToast(d[_k], { label: d.toastOpenFolder, onClick: openOutputFolder });
        try {
          playCompletionSound();
        } catch (error) {
          console.log('[Audio] Failed to play completion sound:', error.message);
        }
      }
      addOutput(`\n${d.allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
    }
    return;
  }

  // 단일 파일 처리
  const i = fileIndex;
  const file = fileToProcess;

  // 현재 시작 시점의 번역 사용 여부를 캡쳐 (중간 변경과 무관하게 처리 일관성 확보)
  const methodAtStart = document.getElementById('translationSelect')?.value || 'none';

  // SRT 파일 직접 번역 처리
  if (isSrtFile(file.path)) {
    const fileName = file.path.split('\\').pop() || file.path.split('/').pop();

    // SRT 파일은 번역만 수행 - 번역 방법이 선택되지 않으면 스킵
    if (methodAtStart === 'none') {
      file.status = 'skipped';
      updateQueueDisplay();
      const d = I18N[currentUiLang] || I18N.ko;
      addOutput(`⏭️ ${d.srtSkippedNoTranslation || 'SRT file skipped (no translation settings)'}: ${fileName}\n`);
      // 다음 파일 처리 계속
      setTimeout(() => continueProcessing(), 100);
      return;
    }

    // 중지 요청 확인
    if (shouldStop) {
      addOutput(`${I18N[currentUiLang].userStopped}\n`);
      return;
    }

    console.log('[continueProcessing] SRT file direct translation start, index:', i, 'fileName:', fileName);
    currentProcessingIndex = i;
    file.status = 'translating';
    file.progress = 0;
    updateQueueDisplay();
    const srtEpoch = _processingEpoch; // 세션 epoch 캠처 (중지/재시작 후 stale 콜백 방지)
    _translationProgressFromZero = true; // 추출 없이 번역만 하므로 0-100 그대로 표시

    // 프로그래스바 초기화
    resetProgress('prepare');
    addOutput(`\n${I18N[currentUiLang].processingFile(i + 1, fileQueue.length, fileName)}\n`);

    const srtDirectMsg = {
      ko: 'SRT 파일 직접 번역 모드',
      en: 'Direct SRT file translation mode',
      ja: 'SRTファイル直接翻訳モード',
      zh: 'SRT文件直接翻译模式',
      pl: 'Tryb bezpośredniego tłumaczenia SRT',
    };
    addOutput(`${srtDirectMsg[currentUiLang] || srtDirectMsg.ko}\n`);

    try {
      translationSessionActive = true;
      setProgressTarget(10, I18N[currentUiLang].translationStarting || 'Starting translation...');

      // 번역 방식에 따른 안내 메시지
      const translationInfo = getTranslationLabel(methodAtStart);

      const targetLangs = getSelectedTargetLangs();
      // 시작 로그에 타깃 언어 표시 — 기본값(한국어)을 모르고 돌렸다가 끝나고 알아차리는 일 방지. 다중 선택 시 쉼표로 나열.
      const targetLangNames = targetLangs
        .map((lc) => (I18N[currentUiLang].langNames || I18N.ko.langNames)[lc] || lc)
        .join(', ');
      addOutput(`${I18N[currentUiLang].translationStarting2(`${translationInfo} → ${targetLangNames}`)}\n`);

      const translationResult = await window.electronAPI.translateSubtitle({
        filePath: file.path,
        method: methodAtStart,
        targetLangs: targetLangs,
        sourceLang: language === 'auto' ? null : language,
        device: document.getElementById('deviceSelect')?.value || 'auto',
        localModelId: typeof getSelectedLocalModelId === 'function' ? getSelectedLocalModelId() : '1.8b',
        sessionId: _processingEpoch,
      });

      // 중지 후 재시작된 세션이면 이 결과를 반영하지 않는다 (stale 콜백 방지).
      if (srtEpoch !== _processingEpoch) {
        console.log('[continueProcessing] Stale SRT translation result ignored (epoch changed)');
        return;
      }

      if (translationResult.success) {
        // 일부 언어만 실패한 경우 부분 실패를 사용자에게 알린다 (F5).
        if (translationResult.failedLangs?.length) {
          addOutput(
            `${I18N[currentUiLang].translationFailed}${translationResult.failedLangs.join(', ')} (${translationResult.outputPaths?.length ?? 0}/${translationResult.failedLangs.length + (translationResult.outputPaths?.length ?? 0)} languages succeeded)\n`
          );
        }
        // 성공: 파일 상태만 갱신. 완료 토스트/사운드/allTasksComplete는
        // translation-progress 'completed' 이벤트 핸들러가 단독 처리 (중복 방지)
        file.status = 'completed';
        file.progress = 100;
        if (translationResult.outputPath) file.outputPath = translationResult.outputPath;
        saveFileToHistory(file);
      } else {
        file.status = 'error';
        file.progress = 0;
        translationSessionActive = false;
        addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(translationResult.error)}\n`);
        saveFileToHistory(file, translationResult.error);
      }
    } catch (error) {
      console.error('[continueProcessing] SRT translation error:', error);
      translationSessionActive = false;
      file.status = 'error';
      file.progress = 0;
      addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(error.message)}\n`);
      saveFileToHistory(file, error.message);
    }

    updateQueueDisplay();
    // SRT 성공 시 다음 파일 이어가기 또는 완료 마무리는
    // onTranslationProgress completed 핸들러가 처리함. 여기서는 return만.
    return;
  }

  // 일반 비디오 파일 처리
  if (!isVideoFile(file.path)) {
    file.status = 'error';
    try {
      saveFileToHistory(file, 'unsupported format');
    } catch (_e) {}
    updateQueueDisplay();
    addOutput(`${I18N[currentUiLang].unsupportedFormat(file.path.split('\\').pop() || file.path.split('/').pop())}\n`);
    // 다음 파일 처리 계속
    setTimeout(() => continueProcessing(), 100);
    return;
  }

  // 중지 요청 확인
  if (shouldStop) {
    addOutput(`${I18N[currentUiLang].userStopped}\n`);
    return;
  }

  // Models 화면과 동일하게, Run 경로에서도 대용량 모델을 받기 전에 동의를 받는다.
  const availabilityKey = model.startsWith('large-v2-sync') ? 'large-v2-sync' : model;
  if (!availableModels[availabilityKey]) {
    // Sync 엔진은 main 프로세스가 추출 중 설치하므로 renderer 캐시가 뒤처질 수 있다.
    // 디스크를 다시 확인해 이미 설치된 모델에 확인창을 반복 표시하지 않는다.
    try {
      Object.assign(availableModels, (await window.electronAPI.checkModelStatus()) || {});
    } catch (_e) {}
  }
  if (!availableModels[availabilityKey]) {
    const modelSelect = document.getElementById('modelSelect');
    const modelLabel = modelSelect?.selectedOptions?.[0]?.textContent?.trim() || model;
    if (!confirm(`${modelLabel}\n\n${I18N[currentUiLang].confirmDownloadModel || 'Start download?'}`)) {
      isProcessing = false;
      currentProcessingIndex = -1;
      updateQueueDisplay();
      updateUIMode();
      return;
    }
  }

  console.log(
    '[continueProcessing] Processing file, index:',
    i,
    'fileName:',
    file.path.split('\\').pop() || file.path.split('/').pop()
  );
  currentProcessingIndex = i;
  file.status = 'processing';
  file.progress = 0;
  updateQueueDisplay();

  // 파일별 처리 시작 시 프로그래스바 초기화
  resetProgress('prepare');

  const fileName = file.path.split('\\').pop() || file.path.split('/').pop();
  addOutput(`\n${I18N[currentUiLang].processingFile(i + 1, fileQueue.length, fileName)}\n`);

  try {
    // 모델 다운로드가 필요한 경우 먼저 다운로드
    // 싱크 엔진(large-v2-sync / large-v2-sync-lite)은 GGML 다운로드 대상이 아니다. 엔진+모델은
    // 추출 시점에 main.js가 자동으로 받고 진행률을 로그에 표시하므로 여기서 선다운로드하지 않는다.
    if (model !== 'large-v2-sync' && model !== 'large-v2-sync-lite' && !availableModels[model]) {
      addOutput(`${I18N[currentUiLang].downloadingModel}: ${model}\n`);
      const dlResult = await window.electronAPI.downloadModel(model);
      // 다운로드 취소/실패 시 모델을 설치된 것으로 표시하지 않는다 (F1).
      // 취소(cancelled)면 사용자가 중지한 것이므로 이 파일은 멈추고 배치를 종료한다.
      if (!dlResult || !dlResult.success) {
        const dlErr = dlResult?.error || 'Model download failed';
        stopIndeterminate();
        if (String(dlErr).toLowerCase().includes('cancelled') || String(dlErr).toLowerCase().includes('canceled')) {
          file.status = 'stopped';
          addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorStopped}: ${fileName}\n`);
          isProcessing = false;
          shouldStop = false;
          currentProcessingIndex = -1;
          setProgressTarget(0, '');
          updateQueueDisplay();
          const stoppedCompletedCount = fileQueue.filter((f) => f.status === 'completed').length;
          const stoppedErrorCount = fileQueue.filter((f) => f.status === 'error').length;
          const stoppedStopCount = fileQueue.filter((f) => f.status === 'stopped').length;
          addOutput(
            `\n${I18N[currentUiLang].allTasksComplete(stoppedCompletedCount, stoppedErrorCount, stoppedStopCount)}\n`
          );
          return; // 배치 종료 — 추출을 시작하지 않는다
        }
        // 다운로드 실패(네트워크 등): 이 파일만 에러 처리하고 다음 파일로.
        file.status = 'error';
        file.progress = 0;
        try {
          saveFileToHistory(file, dlErr);
        } catch (_e) {}
        addOutput(
          `[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorFailed}: ${fileName} - ${getLocalizedError(dlErr)}\n`
        );
        updateQueueDisplay();
        setTimeout(() => continueProcessing(), 100);
        return;
      }
      availableModels[model] = true;
      updateModelSelect();
    }

    // 다운로드가 오래 걸리는 사이 사용자가 중지했을 수 있으므로 추출 직전 재확인한다 (F1).
    if (shouldStop) {
      file.status = 'stopped';
      addOutput(`${I18N[currentUiLang].userStopped}\n`);
      isProcessing = false;
      currentProcessingIndex = -1;
      shouldStop = false;
      updateQueueDisplay();
      if (typeof updateUIMode === 'function') updateUIMode();
      return;
    }

    // 자막 추출 단계 의사 진행률 시작
    // 번역 포함 시 추출 0-50%, 번역 50-100% / 추출만 시 0-95%
    const hasTranslation = methodAtStart && methodAtStart !== 'none';
    const extractionMaxProgress = hasTranslation ? 50 : 95;
    _extractionMaxProgress = extractionMaxProgress;
    // 번역 진행률 매핑 기준: 추출 단계가 있었으면 50-100% 구간 매핑, 없었으면(SRT 단독
    // 번역) main이 보낸 0-100을 그대로 쓴다 (50% 점프 방지).
    _translationProgressFromZero = !hasTranslation;
    // 의사 진행률은 "모델 로딩" 구간만 채우도록 낮은 상한까지만 기어가게 한다.
    // (추출 예산 전체를 의사 진행률로 써버리면 실제 -pp 값이 이미 차버린 지점을 넘지 못해
    //  진행바가 그 상한(예: 50%)에서 멈춰버린다. 실제 원인이었던 버그.)
    _extractionWarmupProgress = Math.min(10, Math.round(extractionMaxProgress * 0.15));
    startIndeterminate(_extractionWarmupProgress, 'extract');

    console.log('[continueProcessing] extractSubtitles call started');
    const myEpoch = _processingEpoch; // 세션 epoch 캠처 (중지/재시작 후 이 콜백이 실행되면 무시)
    const result = await window.electronAPI.extractSubtitles({
      filePath: file.path,
      model: model,
      language: language,
      device: device,
      cleanup: getCleanupOptions(),
      // 메이저장 안 key면 기본 ON (whisper 반복/환각 억제)
      reduceRepetition: localStorage.getItem('reduceRepetition') !== 'false',
      // 자연 문장 단위 전사는 항상 ON (main.js 기본값). 별도 토글 없음.
      // 싱크 엔진은 model='large-v2-sync' 하나로 결정된다(별도 플래그 없음).
    });

    // 중지 후 재시작된 세션의 콜백은 상태를 덮어쓰지 않도록 여기서 중단한다.
    if (myEpoch !== _processingEpoch) {
      console.log('[continueProcessing] Stale extract result ignored (epoch changed)');
      return;
    }

    // 추출 단계 종료 → 의사 진행률 중지하고 현재 진행률 고정
    stopIndeterminate();
    // 추출 완료 시 해당 단계 최대값으로 설정
    setProgressTarget(extractionMaxProgress, I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName));

    if (result.userStopped) {
      file.status = 'stopped';
      addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorStopped}: ${fileName}\n`);
      stopIndeterminate();
      isProcessing = false;
      shouldStop = false;
      currentProcessingIndex = -1;
      setProgressTarget(0, '');
      updateQueueDisplay();

      const stoppedCompletedCount = fileQueue.filter((f) => f.status === 'completed').length;
      const stoppedErrorCount = fileQueue.filter((f) => f.status === 'error').length;
      const stoppedStopCount = fileQueue.filter((f) => f.status === 'stopped').length;
      addOutput(
        `\n${I18N[currentUiLang].allTasksComplete(stoppedCompletedCount, stoppedErrorCount, stoppedStopCount)}\n`
      );
      return; // 즉시 종료 — 100%로 가지 않음
    } else if (!result.success) {
      file.status = 'error';
      file.progress = 0;
      try {
        saveFileToHistory(file, result.error);
      } catch (_e) {}
      addOutput(
        `[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorFailed}: ${fileName} - ${getLocalizedError(result.error)}\n`
      );
      // 추출 실패 시 진행률 바 되돌림 (더 이상 처리할 파일이 없으면)
      stopIndeterminate();
      const remaining = fileQueue.filter(
        (f) => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped'
      ).length;
      if (remaining === 0) {
        setProgressTarget(100, I18N[currentUiLang].allFailed || 'Processing failed');
      }
      updateQueueDisplay();
      // 추출 실패도 다음 파일로 계속 진행 (다운로드 실패 경로와 동일).
      // autoRetryFailed 상호작용: 배치에 성공 파일이 있으면 후속 tail에서 error 항목이
      // 재시도되고, 전부 실패하면 여기서 배치가 끝나 재시도 없이 종료된다.
      setTimeout(() => continueProcessing(), 100);
      return;
    } else {
      addOutput(`${I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName)}\n`);

      // 번역 처리
      const translationMethod = methodAtStart;
      console.log('[continueProcessing] Translation method:', translationMethod);
      let translationDelegated = false;
      if (translationMethod && translationMethod !== 'none') {
        // 번역이 있는 경우 상태를 'translating'으로 설정 (completed 아님!)
        file.status = 'translating';
        file.progress = 50;
        translationSessionActive = true;
        updateQueueDisplay();
        // 프로그레스바: 추출 완료(50%) → 번역 시작으로 자연스럽게 연결
        setProgressTarget(
          Math.max(lastProgress, 51),
          I18N[currentUiLang].translationStarting || 'Starting translation...'
        );
        try {
          // 번역 방식에 따른 안내 메시지
          const translationInfo = getTranslationLabel(translationMethod);

          const targetLangs = getSelectedTargetLangs();
          const targetLangNames = targetLangs
            .map((lc) => (I18N[currentUiLang].langNames || I18N.ko.langNames)[lc] || lc)
            .join(', ');
          addOutput(`${I18N[currentUiLang].translationStarting2(`${translationInfo} → ${targetLangNames}`)}\n`);
          const srtPathFromResult =
            (typeof result?.srtFile === 'string' && result.srtFile) ||
            (Array.isArray(result?.results) && result.results.length > 0 ? result.results[0]?.srtPath : null);
          if (!srtPathFromResult || typeof srtPathFromResult !== 'string') {
            throw new Error('SRT file path missing after extraction');
          }

          const translationResult = await window.electronAPI.translateSubtitle({
            filePath: srtPathFromResult,
            method: translationMethod,
            targetLangs: targetLangs,
            sourceLang: language === 'auto' ? null : language,
            device: document.getElementById('deviceSelect')?.value || 'auto',
            localModelId: typeof getSelectedLocalModelId === 'function' ? getSelectedLocalModelId() : '1.8b',
            sessionId: _processingEpoch,
          });
          translationDelegated = true;

          // 중지 후 재시작된 세션이면 이 결과를 반영하지 않는다 (stale 콜백 방지).
          if (myEpoch !== _processingEpoch) {
            console.log('[continueProcessing] Stale video translation result ignored (epoch changed)');
            return;
          }

          // 번역 단계 종료 표시는 translation-progress의 'completed'에서 처리

          if (translationResult.success) {
            // 일부 언어만 실패한 경우 부분 실패를 사용자에게 알린다 (F5).
            if (translationResult.failedLangs?.length) {
              addOutput(
                `${I18N[currentUiLang].translationFailed}${translationResult.failedLangs.join(', ')} (${translationResult.outputPaths?.length ?? 0}/${translationResult.failedLangs.length + (translationResult.outputPaths?.length ?? 0)} languages succeeded)\n`
              );
            }
            // 성공한 언어만 완료 문구에 포함 (실패 언어가 '번역 완료'에 끼지 않게)
            const okLangs = targetLangs.filter((l) => !(translationResult.failedLangs || []).includes(l));
            if (okLangs.length > 0) {
              addOutput(`${I18N[currentUiLang].translationDone(fileName, okLangs.join(', '))}\n`);
            }
            // 히스토리 조기 저장 (completed 이벤트 눌지거나 누락되는 경우 대비 안전망)
            file.status = 'completed';
            file.progress = 100;
            // 영상 처리는 file.path 를 원본 영상으로 유지 (플레이어가 _ko.srt 자동 로드)
            // outputPath 는 기록만 함. saveFileToHistory 에서는 file.outputPath 가 있으면 우선되지만
            // 영상 처리란 걸 구분하기 위해 영상 파일입으로 유지함
            try {
              saveFileToHistory(file);
            } catch (_e) {}
          } else if (translationResult.userStopped) {
            file.status = 'stopped';
            translationSessionActive = false;
            addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorStopped}: ${fileName}\n`);
            updateQueueDisplay();
            return;
          } else {
            addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(translationResult.error)}\n`);
          }
        } catch (error) {
          console.error('[continueProcessing] Translation error:', error);
          translationSessionActive = false;
          file.status = 'error';
          file.progress = 0;
          try {
            saveFileToHistory(file, error?.message);
          } catch (_e) {}
          addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(error.message)}\n`);
          setProgressTarget(
            Math.max(lastProgress, 95),
            I18N[currentUiLang].translationFailed + getLocalizedError(error.message || '')
          );
          updateQueueDisplay();
        }

        // 번역이 있는 경우 onTranslationProgress 이벤트에서 자동 처리 담당
        // 여기서는 종료하고 이벤트 핸들러에 맡김
        if (translationDelegated) {
          return;
        }
      } else {
        // 번역이 없는 경우만 여기서 completed 처리
        console.log('[continueProcessing] No translation, marking as completed');
        file.status = 'completed';
        file.progress = 100;
        saveFileToHistory(file);
        // 추출만 하는 경우 진행률 100%로 설정
        setProgressTarget(100, I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName));
      }
    }
  } catch (error) {
    console.error('[continueProcessing] Processing error:', error);
    file.status = 'error';
    file.progress = 0;
    addOutput(
      `[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].processingError}: ${fileName} - ${error.message}\n`
    );
    saveFileToHistory(file, error.message);
    setProgressTarget(0, I18N[currentUiLang].processingError);
    updateQueueDisplay();
  } finally {
    // 단계 전환 누수 방지
    stopIndeterminate();
  }

  updateQueueDisplay();

  // 중지/에러면 완료 처리 건너뛰기
  if (file.status === 'stopped' || file.status === 'error' || shouldStop) {
    isProcessing = false;
    shouldStop = false;
    currentProcessingIndex = -1;
    updateQueueDisplay();
    // 번역 select 재활성화 (완료 경로와 동일하게 — 안 하면 영구 비활성)
    if (typeof updateUIMode === 'function') updateUIMode();
    return;
  }

  // 단일 파일 처리 완료 후 잠시 대기 (GPU 메모리 정리 시간 확보)
  addOutput(`${I18N[currentUiLang].cleaningMemory}\n`);
  await sleep(2000);

  // 번역 없이 자막 추출만 한 경우 즉시 완료 처리
  if (file.status === 'completed') {
    setProgressTarget(
      100,
      I18N[currentUiLang].fileProcessed(file.path.split('\\').pop() || file.path.split('/').pop())
    );
  }

  // 자동 처리: 다음 파일 확인 및 처리 (재귀 호출)
  const remainingFiles = fileQueue.filter(
    (f) => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped'
  ).length;

  console.log('[continueProcessing] Auto-process check:', {
    remainingFiles,
    shouldStop,
    fileQueue: fileQueue.map((f) => ({ path: f.path.split('\\').pop() || f.path.split('/').pop(), status: f.status })),
  });

  if (remainingFiles > 0 && !shouldStop) {
    // 다음 파일이 있으면 자동으로 계속 처리
    addOutput(`${I18N[currentUiLang].processingNext(remainingFiles)}\n\n`);
    await continueProcessing(); // 재귀 호출로 다음 파일 처리
  } else {
    // 실패 항목 자동 재시도(옵션): 큐가 끝난 시점에 error 항목을 상한 회수까지 다시 태운다.
    // 사용자가 직접 중지한 경우(shouldStop/stopped)는 건드리지 않는다.
    if (!shouldStop && localStorage.getItem('autoRetryFailed') === 'true') {
      const retryables = fileQueue.filter((f) => f.status === 'error' && (f.autoRetryCount || 0) < AUTO_RETRY_MAX);
      if (retryables.length > 0) {
        retryables.forEach((f) => {
          f.autoRetryCount = (f.autoRetryCount || 0) + 1;
          f.status = 'pending';
          f.progress = 0;
        });
        addOutput(`${I18N[currentUiLang].autoRetryingFailed(retryables.length)}\n\n`);
        updateQueueDisplay();
        await continueProcessing();
        return;
      }
    }
    // 모든 파일 처리 완료
    isProcessing = false;
    shouldStop = false;
    currentProcessingIndex = -1;
    updateQueueDisplay();
    // 번역 select 재활성화 (완료 경로와 동일하게 — 안 하면 영구 비활성)
    if (typeof updateUIMode === 'function') updateUIMode();

    const completedCount = fileQueue.filter((f) => f.status === 'completed').length;
    const errorCount = fileQueue.filter((f) => f.status === 'error').length;
    const stoppedCount = fileQueue.filter((f) => f.status === 'stopped').length;
    const skippedCount = fileQueue.filter((f) => f.status === 'skipped').length;

    {
      const d = I18N[currentUiLang];
      if (stoppedCount > 0 || (_stoppedAt && Date.now() - _stoppedAt < 10000)) {
        showToast(d.allStopped || 'Processing stopped.');
      } else if (errorCount > 0 && completedCount === 0) {
        setProgressTarget(100, getAllFailedMsg());
        showToast(getAllFailedMsg());
      } else if (skippedCount > 0 && completedCount === 0) {
        // 전부 skip: '완료' 토스트는 오해를 부르므로 생략 (출력 로그에 skip 사유가 이미 남음)
        setProgressTarget(100, d.allDoneNoTr || 'All files completed!');
      } else if (errorCount > 0) {
        setProgressTarget(100, d.allDoneWithErrors || `Done with ${errorCount} error(s)`);
        showToast(d.allDoneWithErrors || `Done with ${errorCount} error(s)`, {
          label: d.toastOpenFolder,
          onClick: openOutputFolder,
        });
      } else {
        const _k = getAllDoneKey(document.getElementById('translationSelect')?.value);
        setProgressTarget(100, d[_k]);
        showToast(d[_k], { label: d.toastOpenFolder, onClick: openOutputFolder });
        try {
          playCompletionSound();
        } catch (error) {
          console.log('[Audio] Failed to play completion sound:', error.message);
        }
      }
      addOutput(`\n${d.allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
    }
  }
}

// Drag & drop handling (드래그앤드롭 처리)
document.addEventListener('DOMContentLoaded', () => {
  // 외부 링크를 기본 브라우저에서 열기
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="http"]');
    if (link) {
      e.preventDefault();
      window.electronAPI.openExternal(link.href);
    }
  });

  // 비밀번호 표시/숨기기 토글 버튼
  document.querySelectorAll('.toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;

      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';

      // 아이콘 토글
      const eyeIcon = btn.querySelector('.eye-icon');
      const eyeOffIcon = btn.querySelector('.eye-off-icon');
      if (eyeIcon && eyeOffIcon) {
        eyeIcon.style.display = isPassword ? 'none' : 'block';
        eyeOffIcon.style.display = isPassword ? 'block' : 'none';
      }

      // 툴팁 업데이트
      const d = I18N[currentUiLang] || I18N.ko;
      btn.title = isPassword ? d.togglePasswordHide || 'Hide password' : d.togglePasswordShow || 'Show password';
    });
  });

  const dropZone = document.getElementById('dropZone');
  const runBtn = document.getElementById('runBtn');
  const selectFileBtn = document.getElementById('selectFileBtn');

  // drag & drop events (드래그앤드롭 이벤트)
  if (!dropZone) {
    console.error('dropZone element not found');
    return;
  }

  dropZone.ondragover = (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
    dropZone.classList.add('dragover');
  };

  dropZone.ondragleave = (e) => {
    if (draggedItem) return;
    // Only remove class when leaving the dropzone itself, not child elements
    if (e.relatedTarget && dropZone.contains(e.relatedTarget)) return;
    e.preventDefault();
    dropZone.classList.remove('dragover');
  };

  dropZone.ondrop = (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) {
      console.log('[DragDrop] Ignoring queue drag on file dropzone');
      return;
    }
    e.preventDefault();
    dropZone.classList.remove('dragover');

    console.log('Drop event triggered');

    const files = Array.from(e.dataTransfer.files);
    console.log('Dropped files:', files);

    if (files.length > 0) {
      const paths = [];
      let rejectedCount = 0;

      files.forEach((file) => {
        // 폴더/지원하지 않는 확장자는 큐에 넣기 전에 거부한다 (안내 로그만).
        const name = file.name || '';
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
        const isDir = file.type === '' && ext === '' && (file.size === 0 || file.size === undefined);
        if (isDir || !(SUPPORTED_EXTENSIONS.includes(ext) || ext === '.srt')) {
          console.log('[DragDrop] Rejected unsupported drop:', name, '(dir:', isDir + ')');
          rejectedCount++;
          return;
        }

        let extractedPath = null;
        if (file.path && typeof file.path === 'string' && file.path.trim()) {
          extractedPath = file.path;
        } else {
          try {
            extractedPath = window.electronAPI.getFilePathFromFile(file);
          } catch (error) {
            console.error('Method 2 failed:', error);
          }
        }

        if (extractedPath && extractedPath !== 'undefined' && extractedPath.trim()) {
          paths.push(extractedPath);
        } else {
          addOutput(`${I18N[currentUiLang].cannotExtractPath(file.name)}\n`);
        }
      });

      if (rejectedCount > 0) {
        addOutput(`${I18N[currentUiLang].unsupportedFormat(rejectedCount + ' file(s)')}\n`);
      }

      if (paths.length > 0) {
        addToQueueBatch(paths);
        addOutput(`${I18N[currentUiLang].filesAddedToQueue(paths.length)}\n`);
      }
    } else {
      console.log('No files dropped');
      // 빈 드롭(폴더 등)은 안내 문구를 처리 로그에 남기지 않고 조용히 무시한다.
    }
  };

  // start processing (처리 시작 함수)
  async function startProcessing() {
    // 중복 클릭을 먼저 막고, 저장된 키를 다시 읽어 번역 설정을 실행 직전에 확인한다.
    // 키 없는 유료 엔진이면 추출부터 시작하지 않고 사용자가 설정을 고치게 한다.
    isProcessing = true;
    if (await updateTranslationEngineOptions()) {
      isProcessing = false;
      updateQueueDisplay();
      updateUIMode();
      return;
    }

    // 새 배치 시작 시 상태 완전 리셋 (이전 중지로 인한 잔존 값 제거)
    shouldStop = false;
    _stoppedAt = 0;
    _maxTranslatedCurrent = 0;
    translationSessionActive = false;
    currentProcessingIndex = -1;
    _translationProgressFromZero = false; // 배치 시작 시 리셋 (비디오+번역이 기본 가정)
    // 세션 epoch 증가: 이전 세션에서 도착하는 stale 이벤트/콜백을 새 배치가 무시하게 한다.
    _processingEpoch++;
    // 새 런 시작 시 자동 재시도 카운트 리셋 — 이전 런에서 소진한 기회가 이월되지 않게
    fileQueue.forEach((f) => {
      f.autoRetryCount = 0;
    });
    updateQueueDisplay();
    // 시작 즉시 번역 select 비활성 (완료/중지 경로의 updateUIMode와 짝을 이룬다)
    if (typeof updateUIMode === 'function') updateUIMode();

    const model = document.getElementById('modelSelect').value;
    const language = document.getElementById('languageSelect').value;
    const device = document.getElementById('deviceSelect').value;

    const lang = I18N[currentUiLang];
    const langDisplay = language === 'auto' ? lang.langAuto : language;
    const deviceDisplay = device === 'auto' ? lang.deviceAutoLabel : device === 'cuda' ? 'GPU' : 'CPU';

    addOutput(`\n${lang.processingStart(fileQueue.length)}\n`);
    addOutput(`${lang.processingInfo(model, langDisplay, deviceDisplay)}\n\n`);

    await continueProcessing();
  }

  // 버튼 이벤트
  runBtn.onclick = async () => {
    if (fileQueue.length === 0) return;

    // 이미 처리 중이면 리턴
    if (isProcessing) return;

    startProcessing();
  };

  // 파일 선택 버튼 이벤트
  selectFileBtn.onclick = selectFile;

  // 드롭존 전체 클릭도 파일 선택을 연다 (안내 문구는 "드래그 또는 클릭"이라
  // 클릭 동작이 없으면 안내와 불일치한다). 버튼 클릭이 이벤트 버블로 중복
  // 다이얼로그를 열지 않게 버튼에서는 stopPropagation 한다.
  dropZone.onclick = (e) => {
    if (isProcessing) return;
    if (e.target.closest('#selectFileBtn')) return; // 버튼은 자기 핸들러에 맡긴다
    if (e.target.closest('.drop-mascot-frame')) return;
    selectFile();
  };
  selectFileBtn.addEventListener('click', (e) => e.stopPropagation());

  // 대기열 관리 버튼들
  document.getElementById('stopBtn').onclick = stopProcessing;
  document.getElementById('clearQueueBtn').onclick = clearQueue;
  const clearCompletedBtn = document.getElementById('clearCompletedBtn');
  if (clearCompletedBtn) clearCompletedBtn.onclick = clearCompletedFromQueue;
  document.getElementById('openFolderBtn').onclick = openOutputFolder;

  // Event delegation for queue list — replaces all inline onclick handlers
  const queueListEl = document.getElementById('queueList');
  if (queueListEl) {
    queueListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) {
        // Copy on name/path click
        const copyName = e.target.closest('.queue-copy-name');
        const copyPath = e.target.closest('.queue-copy-path');
        if (copyName) copyToClipboard(copyName.dataset.copy, 'filename');
        if (copyPath) copyToClipboard(copyPath.dataset.copy, 'path');
        return;
      }
      const action = btn.dataset.action;
      const index = parseInt(btn.dataset.index, 10);
      if (action === 'open') {
        const file = fileQueue[index];
        openFileLocation(file?.outputPath || file?.path);
      }
      if (action === 'retry') retryQueueItem(index);
      if (action === 'remove') removeFromQueue(index);
    });
  }

  // API 키 테스트 버튼 (설정 모달 내에서 사용)
  document.getElementById('testApiKeysBtn').onclick = testApiKeys;

  // 초기 설정
  checkModelStatus(); // 모델 상태 확인
  updateQueueDisplay();

  // 전역 초기화 함수 호출
  initApp();
});

// Electron IPC 이벤트 처리
// 현재 UI 언어 보관
let currentUiLang = 'ko';

// 로그 메시지 간단 현지화 매핑(패턴→치환)
const LOG_I18N = {
  en: [
    { re: /^\[(\d+)\/(\d+)\] 처리 중: (.*)$/m, to: '[$1/$2] Processing: $3' },
    { re: /자막 추출 시작/g, to: 'Start subtitle extraction' },
    { re: /자막 추출 완료/g, to: 'Subtitle extraction completed' },
    { re: /오류:/g, to: 'Error:' },
    { re: /오류/g, to: 'Error' },
    { re: /중지됨/g, to: 'Stopped' },
    { re: /다음 파일/g, to: 'Next file' },
    { re: /모든 파일 처리 완료/g, to: 'All files completed' },
    { re: /번역 시작/g, to: 'Translation started' },
    { re: /번역 완료/g, to: 'Translation completed' },
    { re: /번역 실패/g, to: 'Translation failed' },
    { re: /번역 진행/g, to: 'Translation progress' },
    { re: /GPU 메모리 정리/g, to: 'GPU memory cleanup' },
    { re: /자동 장치 선택: CUDA 사용/g, to: 'Auto device: using CUDA' },
    { re: /자동 장치 선택: CPU 사용/g, to: 'Auto device: using CPU' },
    // 추가 일반 로그 패턴
    { re: /^(\d+)개 파일이 대기열에 추가되었습니다\./m, to: '$1 files added to queue.' },
    { re: /^(\d+)개 파일 순차 처리 시작/m, to: 'Starting sequential processing of $1 file(s)' },
    { re: /CUDA 장치로 자막 추출을 시작합니다\.\.\./g, to: 'Starting extraction with CUDA device...' },
    { re: /CPU 장치로 자막 추출을 시작합니다\.\.\./g, to: 'Starting extraction with CPU device...' },
    { re: /파일 선택 중 오류 발생:/g, to: 'File selection error:' },
    { re: /이미 대기열에 있는 파일입니다:/g, to: 'Already in queue:' },
    { re: /대기열이 모두 삭제되었습니다\./g, to: 'Queue cleared.' },
    { re: /대기 중인 (\d+)개 파일이 삭제되었습니다\./g, to: 'Removed $1 pending files.' },
    { re: /처리 중지 요청됨\. 현재 파일 완료 후 중지됩니다\./g, to: 'Stop requested. Will stop after current file.' },
    { re: /대기열에서 제거됨:/g, to: 'Removed from queue:' },
    { re: /지원되지 않는 파일 형식:/g, to: 'Unsupported file type:' },
    { re: /모델 다운로드 중:/g, to: 'Downloading model:' },
    { re: /다음 파일을 위한 메모리 정리 중\. \(10초 대기\)/g, to: 'Cleaning up memory for next file... (wait 10s)' },
    { re: /모델: /g, to: 'Model: ' },
    { re: /언어: /g, to: 'Language: ' },
    { re: /장치: /g, to: 'Device: ' },
    { re: /자동감지/g, to: 'Auto-detect' },
    { re: /자동/g, to: 'Auto' },
    // 영어 원문 → 영어 유지 (불필요), 하지만 호환을 위해 그대로 둠
    { re: /🌐\s*번역을 시작 \[(MyMemory) \(무료\)\]/g, to: '🌐 Start translation [$1 (free)]' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: 'Cleaning up memory... (please wait)' },
  ],
  ja: [
    { re: /^\[(\d+)\/(\d+)\] 처리 중: (.*)$/m, to: '[$1/$2] 処理中: $3' },
    { re: /자막 추출 시작/g, to: '字幕抽出を開始' },
    { re: /자막 추출 완료/g, to: '字幕抽出が完了しました' },
    { re: /오류:/g, to: 'エラー:' },
    { re: /오류/g, to: 'エラー' },
    { re: /중지됨/g, to: '停止しました' },
    { re: /다음 파일/g, to: '次のファイル' },
    { re: /모든 파일 처리 완료/g, to: 'すべてのファイルの処理が完了しました' },
    { re: /번역 시작/g, to: '翻訳を開始' },
    { re: /번역 완료/g, to: '翻訳が完了しました' },
    { re: /번역 실패/g, to: '翻訳に失敗しました' },
    { re: /번역 진행/g, to: '翻訳の進行状況' },
    { re: /GPU 메모리 정리/g, to: 'GPUメモリのクリーンアップ' },
    { re: /자동 장치 선택: CUDA 사용/g, to: '自動デバイス: CUDAを使用' },
    { re: /자동 장치 선택: CPU 사용/g, to: '自動デバイス: CPUを使用' },
    // 追加: 예시 로그 문구들 변환
    { re: /^(\d+)개 파일이 대기열에 추가되었습니다\./m, to: '$1 件のファイルをキューに追加しました。' },
    { re: /^(\d+)개 파일 순차 처리 시작/m, to: '$1 件のファイルを順次処理開始' },
    { re: /CUDA 장치로 자막 추출을 시작합니다\.\.\./g, to: 'CUDA デバイスで字幕抽出を開始します...' },
    { re: /CPU 장치로 자막 추출을 시작합니다\.\.\./g, to: 'CPU デバイスで字幕抽出を開始します...' },
    { re: /파일 선택 중 오류 발생:/g, to: 'ファイル選択エラー:' },
    { re: /이미 대기열에 있는 파일입니다:/g, to: 'すでにキューにあります:' },
    { re: /대기열이 모두 삭제되었습니다\./g, to: 'キューをすべて削除しました。' },
    { re: /대기 중인 (\d+)개 파일이 삭제되었습니다\./g, to: '待機中の $1 件のファイルを削除しました。' },
    {
      re: /처리 중지 요청됨\. 현재 파일 완료 후 중지됩니다\./g,
      to: '停止要求を受けました。現在のファイル終了後に停止します。',
    },
    { re: /대기열에서 제거됨:/g, to: 'キューから削除:' },
    { re: /지원되지 않는 파일 형식:/g, to: '未対応のファイル形式:' },
    { re: /모델 다운로드 중:/g, to: 'モデルをダウンロード中:' },
    { re: /다음 파일을 위한 메모리 정리 중\. \(10초 대기\)/g, to: '次のファイルのためメモリを整理中...（10秒待機）' },
    { re: /모델: /g, to: 'モデル: ' },
    { re: /언어: /g, to: '言語: ' },
    { re: /장치: /g, to: 'デバイス: ' },
    { re: /자동감지/g, to: '自動検出' },
    { re: /자동/g, to: '自動' },
    // 영어 원문 → 일본어
    {
      re: /Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/g,
      to: 'Standalone Faster-Whisper-XXL 実行環境: $1',
    },
    { re: /Starting to process:\s*/g, to: '処理開始: ' },
    { re: /Starting translation\.\.\./g, to: '翻訳を開始します...' },
    { re: /Translating\.\.\. (\d+)\/(\d+)/g, to: '翻訳中... $1/$2' },
    { re: /Translation completed\. Finalizing\.\.\./g, to: '翻訳が完了しました。最終処理中...' },
    { re: /Translation failed: (.*)$/g, to: '翻訳に失敗しました: $1' },
    { re: /🌐\s*번역을 시작 \[(MyMemory) \(무료\)\]/g, to: '🌐 翻訳を開始 [$1（無料）]' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: 'メモリを整理中...（少々お待ちください）' },
  ],
  pl: [
    { re: /^\[(\d+)\/(\d+)\] 처리 중: (.*)$/m, to: '[$1/$2] Przetwarzanie: $3' },
    { re: /자막 추출 시작/g, to: 'Rozpoczęcie ekstrakcji napisów' },
    { re: /자막 추출 완료/g, to: 'Ekstrakcja napisów zakończona' },
    { re: /오류:/g, to: 'Błąd:' },
    { re: /오류/g, to: 'Błąd' },
    { re: /중지됨/g, to: 'Zatrzymano' },
    { re: /다음 파일/g, to: 'Następny plik' },
    { re: /모든 파일 처리 완료/g, to: 'Przetwarzanie wszystkich plików zakończone' },
    { re: /번역 시작/g, to: 'Rozpoczęcie tłumaczenia' },
    { re: /번역 완료/g, to: 'Tłumaczenie zakończone' },
    { re: /번역 실패/g, to: 'Tłumaczenie nieudane' },
    { re: /번역 진행/g, to: 'Postęp tłumaczenia' },
    { re: /GPU 메모리 정리/g, to: 'Czyszczenie pamięci GPU' },
    { re: /자동 장치 선택: CUDA 사용/g, to: 'Auto urządzenie: CUDA' },
    { re: /자동 장치 선택: CPU 사용/g, to: 'Auto urządzenie: CPU' },
    { re: /^(\d+)개 파일이 대기열에 추가되었습니다\./m, to: 'Dodano $1 plik(ów) do kolejki.' },
    { re: /^(\d+)개 파일 순차 처리 시작/m, to: 'Rozpoczęcie przetwarzania $1 plik(ów)' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: 'Czyszczenie pamięci... (proszę czekać)' },
  ],
  zh: [
    { re: /^\[(\d+)\/(\d+)\] 처리 중: (.*)$/m, to: '[$1/$2] 处理中: $3' },
    { re: /자막 추출 시작/g, to: '开始提取字幕' },
    { re: /자막 추출 완료/g, to: '字幕提取完成' },
    { re: /오류:/g, to: '错误:' },
    { re: /오류/g, to: '错误' },
    { re: /중지됨/g, to: '已停止' },
    { re: /다음 파일/g, to: '下一个文件' },
    { re: /모든 파일 처리 완료/g, to: '所有文件处理完成' },
    { re: /번역 시작/g, to: '开始翻译' },
    { re: /번역 완료/g, to: '翻译完成' },
    { re: /번역 실패/g, to: '翻译失败' },
    { re: /번역 진행/g, to: '翻译进度' },
    { re: /GPU 메모리 정리/g, to: '清理GPU内存' },
    { re: /자동 장치 선택: CUDA 사용/g, to: '自动设备: 使用CUDA' },
    { re: /자동 장치 선택: CPU 사용/g, to: '自动设备: 使用CPU' },
    // 追加: 예시 로그 변환
    { re: /^(\d+)개 파일이 대기열에 추가되었습니다\./m, to: '已将 $1 个文件添加到队列。' },
    { re: /^(\d+)개 파일 순차 처리 시작/m, to: '开始顺序处理 $1 个文件' },
    { re: /CUDA 장치로 자막 추출을 시작합니다\.\.\./g, to: '使用 CUDA 设备开始提取字幕...' },
    { re: /CPU 장치로 자막 추출을 시작합니다\.\.\./g, to: '使用 CPU 设备开始提取字幕...' },
    { re: /파일 선택 중 오류 발생:/g, to: '选择文件时出错:' },
    { re: /이미 대기열에 있는 파일입니다:/g, to: '已在队列中:' },
    { re: /대기열이 모두 삭제되었습니다\./g, to: '已清空队列。' },
    { re: /대기 중인 (\d+)개 파일이 삭제되었습니다\./g, to: '已删除 $1 个等待中文件。' },
    { re: /처리 중지 요청됨\. 현재 파일 완료 후 중지됩니다\./g, to: '已请求停止。当前文件完成后停止。' },
    { re: /대기열에서 제거됨:/g, to: '已从队列中移除:' },
    { re: /지원되지 않는 파일 형식:/g, to: '不支持的文件类型:' },
    { re: /모델 다운로드 중:/g, to: '正在下载模型:' },
    { re: /다음 파일을 위한 메모리 정리 중\. \(10초 대기\)/g, to: '为下一个文件清理内存...（等待10秒）' },
    { re: /모델: /g, to: '模型: ' },
    { re: /언어: /g, to: '语言: ' },
    { re: /장치: /g, to: '设备: ' },
    { re: /자동감지/g, to: '自动检测' },
    { re: /자동/g, to: '自动' },
    // 영어 원문 → 중국어
    {
      re: /Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/g,
      to: 'Standalone Faster-Whisper-XXL 运行于: $1',
    },
    { re: /Starting to process:\s*/g, to: '开始处理: ' },
    { re: /Starting translation\.\.\./g, to: '开始翻译...' },
    { re: /Translating\.\.\. (\d+)\/(\d+)/g, to: '翻译中... $1/$2' },
    { re: /Translation completed\. Finalizing\.\.\./g, to: '翻译完成。正在收尾...' },
    { re: /Translation failed: (.*)$/g, to: '翻译失败: $1' },
    { re: /🌐\s*번역을 시작 \[(MyMemory) \(무료\)\]/g, to: '🌐 开始翻译 [$1（免费）]' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: '正在清理内存...（请稍候）' },
  ],
};

// === UI 텍스트 I18N ===
// I18N object moved to locales/i18n.js

// 에러 메시지 다국어 변환 헬퍼
// "all translations failed" summary message, chosen by translation method.
// Local translation has no API key, so never show the API key/quota hint here
// (that wrong hint was the source of user confusion).
function getAllFailedMsg() {
  const d = I18N[currentUiLang] || I18N.ko;
  const method = document.getElementById('translationSelect')?.value;
  if (method === 'local') return d.allFailedLocal || d.allFailed || 'All translations failed';
  if (method && method !== 'none') return d.allFailedApi || d.allFailed || 'All translations failed';
  return d.allFailed || 'All tasks failed';
}

function getLocalizedError(errorMessage) {
  if (!errorMessage) return I18N[currentUiLang].errorUnknown;

  const lang = I18N[currentUiLang];

  // 모델 다운로드 경로들의 공통 디스크 부족 메시지.
  const diskSpace = String(errorMessage).match(/Not enough disk space: need ([\d.]+) GB, free ([\d.]+) GB/i);
  if (diskSpace) {
    return (lang.errorDiskSpace || 'Not enough disk space. Required: {required} GB, free: {free} GB.')
      .replace('{required}', diskSpace[1])
      .replace('{free}', diskSpace[2]);
  }

  // main.js에서 오는 영어 에러 메시지 → 현지화
  if (errorMessage.includes('GPU memory shortage') || errorMessage.includes('GPU 메모리 부족')) {
    return lang.errorGpuMemory;
  }
  if (errorMessage.includes('Process terminated abnormally') || errorMessage.includes('프로세스가 비정상적으로')) {
    return lang.errorProcessCrash;
  }
  if (errorMessage.includes('Whisper processing failed') || errorMessage.includes('Whisper 처리 실패')) {
    return lang.errorWhisperFailed;
  }
  // main.js는 "파일이 없음"과 "있는데 실행이 막힘"을 구분해서 보낸다.
  // 복구 방법이 서로 다르므로 하나의 문구로 합치지 않는다.
  if (errorMessage.includes('whisper-cli')) {
    if (errorMessage.includes('is missing from')) {
      return lang.errorWhisperMissing;
    }
    if (errorMessage.includes('could not be launched') || errorMessage.includes('code 127')) {
      return lang.errorWhisperBlocked;
    }
  }
  if (errorMessage.includes('CPU build is available') || errorMessage.includes('CPU 빌드가 설치')) {
    return lang.errorDllCpuAvailable || lang.errorDllEntryPointNotFound;
  }
  if (errorMessage.includes('DLL entry point not found') || errorMessage.includes('0xC0000139')) {
    return lang.errorDllEntryPointNotFound;
  }
  if (errorMessage.includes('Required DLL not found') || errorMessage.includes('0xC0000135')) {
    return lang.errorDllNotFound;
  }
  if (errorMessage.includes('MyMemory daily quota exceeded')) {
    return lang.myMemoryQuotaExceeded;
  }
  if (errorMessage.includes('SRT file path missing') || errorMessage.includes('SRT 파일 경로')) {
    return lang.errorSrtPathMissing;
  }
  if (errorMessage.includes('TRANSLATION_PASSTHROUGH') || errorMessage.includes('LOCAL_TIMEOUT')) {
    return lang.errorTranslationPassthrough || lang.errorEmptyTranslation;
  }
  if (errorMessage.includes('empty translation') || errorMessage.includes('번역 결과가 비어')) {
    return lang.errorEmptyTranslation;
  }
  if (
    errorMessage.includes('API_QUOTA_EXCEEDED') ||
    /\b429\b/.test(errorMessage) ||
    errorMessage.includes('quota exceeded') ||
    errorMessage.includes('Too Many Requests')
  ) {
    return lang.errorApiQuotaExceeded;
  }

  return errorMessage;
}

// 모델 이름 현지화 — select 드롭다운 욵은 한 줄이라 길면 잘린다. 여긴 이름+용량+추천마크만 짧게.
// 긴 설명은 MODEL_DESC_I18N으로 분리해 select 아래 줄에서 풀로 보여준다.

// 장치/번역 메서드 옵션 현지화
const DEVICE_OPTIONS_I18N = (lang) => ({
  auto: I18N[lang].deviceAuto,
  cuda: I18N[lang].deviceCuda,
  cpu: I18N[lang].deviceCpu,
});
const TR_METHOD_I18N = (lang) => ({
  none: I18N[lang].trNone,
  local: I18N[lang].trLocal,
  mymemory: I18N[lang].trMyMemory,
  deepl: I18N[lang].trDeepL,
  chatgpt: I18N[lang].trChatGPT,
  gemini: I18N[lang].trGemini,
  claude: I18N[lang].trClaude,
});

// 내장 LLM 옵션은 설정된 모델명을 뒤에 붙여준다 — 모델을 바꿔도 드롭다운이 같이 따라가도록.
const TR_METHOD_MODEL_FIELDS = {
  chatgpt: 'openaiModel',
  gemini: 'geminiModel',
  claude: 'claudeModel',
};

function rebuildLanguageSelectOptions(lang) {
  const d = I18N[lang];
  const sel = document.getElementById('languageSelect');
  if (!sel) return;
  const originalValue = sel.value;
  const codes = ['auto', 'ko', 'en', 'ja', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'hu', 'ar', 'pl'];
  sel.replaceChildren();
  codes.forEach((code) => {
    const opt = document.createElement('option');
    opt.value = code;
    if (code === 'auto') opt.textContent = d.langAutoOption;
    else opt.textContent = (I18N[lang].langNames || {})[code] || code;
    sel.appendChild(opt);
  });
  if (codes.includes(originalValue)) sel.value = originalValue;
}

// GPU 감지 결과를 언어와 분리해 캐시한다. HTML을 캐시하면 언어 변경 시
// 이전 언어 텍스트가 그대로 복원되는 문제가 있다(F1). 언어별 문구는 표시 시점에
// 현재 UI 언어로 생성한다.
let _gpuStatusData = null; // { name, computeCap, backend: 'cuda'|'vulkan'|'cpu', legacyNvidia } | null

// 현재 언어로 장치 상태 문구를 만든다. 감지 전이면 기본 안내를 그대로 쓴다.
function getDeviceStatusMarkup(lang) {
  const l = I18N[lang] || I18N[currentUiLang];
  if (!_gpuStatusData) return l.deviceStatusHtml;
  // 구형 NVIDIA이면서 Vulkan도 못 쓰는 경우만 기존 경고를 유지한다.
  if (_gpuStatusData.legacyNvidia && _gpuStatusData.backend === 'cpu' && l.gpuIncompatibleHtml) {
    return l.gpuIncompatibleHtml(_gpuStatusData.name, _gpuStatusData.computeCap);
  }
  return l.gpuDetectedHtml ? l.gpuDetectedHtml(_gpuStatusData.name, _gpuStatusData.backend) : l.deviceStatusHtml;
}

function rebuildDeviceSelectOptions(lang) {
  const sel = document.getElementById('deviceSelect');
  if (!sel) return;
  const original = sel.value;
  const map = DEVICE_OPTIONS_I18N(lang);
  ['auto', 'cuda', 'cpu'].forEach((v) => {
    const o = sel.querySelector(`option[value="${v}"]`);
    if (o) o.textContent = map[v];
  });
  sel.value = original;
  const deviceStatus = document.getElementById('deviceStatus');
  if (deviceStatus) {
    // 감지된 장치와 실제 가속 방식을 보여준다.
    // (감지 결과는 데이터로 캐시되고 여기서 현재 언어로 생성된다 — 언어 변경 반영)
    setStatusMarkup(deviceStatus, getDeviceStatusMarkup(lang));
  }
}

function rebuildTranslationSelectOptions(lang) {
  const sel = document.getElementById('translationSelect');
  if (!sel) return;
  const original = sel.value;
  const map = TR_METHOD_I18N(lang);
  ['none', 'local', 'mymemory', 'deepl', 'chatgpt', 'gemini', 'claude'].forEach((v) => {
    const o = sel.querySelector(`option[value="${v}"]`);
    if (!o) return;
    const model = cachedApiConfig[TR_METHOD_MODEL_FIELDS[v]];
    o.textContent = model ? `${map[v]} · ${model}` : map[v];
  });
  sel.value = original;
  const translationStatus = document.getElementById('translationStatus');
  if (translationStatus) {
    let statusMarkup = I18N[lang].translationEnabledHtml;
    if (original === 'none') statusMarkup = I18N[lang].translationDisabledHtml;
    else if (original === 'local') {
      updateLocalModelStatus();
      statusMarkup = null;
    } else if (original === 'deepl')
      statusMarkup = I18N[lang].translationDeeplHtml || I18N[lang].translationEnabledHtml;
    else if (original === 'chatgpt')
      statusMarkup = I18N[lang].translationChatgptHtml || I18N[lang].translationEnabledHtml;
    else if (original === 'gemini')
      statusMarkup = I18N[lang].translationGeminiHtml || I18N[lang].translationEnabledHtml;
    else if (original === 'claude')
      statusMarkup = I18N[lang].translationClaudeHtml || I18N[lang].translationEnabledHtml;
    if (statusMarkup) setStatusMarkup(translationStatus, statusMarkup);
  }
  // Local 서브-셀렉트 가시성 토글 (local일 때만 표시)
  const localGrp = document.getElementById('localModelGroup');
  if (localGrp) localGrp.style.display = original === 'local' ? 'block' : 'none';
}

// GPU 호환성 체크 및 UI 반영
async function checkGpuCompatibility() {
  if (!window.electronAPI?.getGpuInfo) return;
  const info = await window.electronAPI.getGpuInfo();
  if (!info) return;
  // 사용자는 자기 그래픽카드가 CUDA인지 Vulkan인지 모른다. 감지 결과를
  // 그대로 보여줘서 어떤 가속이 실제로 쓰이는지 한 줄로 알려준다.
  // nvidia-smi가 없는 AMD/Intel 머신은 info.name이 비어 있다. 그대로 보간하면
  // "현재 장치: null · Vulkan 가속"이 된다. Vulkan의 주 대상이 바로 이 경우다.
  _gpuStatusData = {
    name: info.name || 'GPU',
    computeCap: info.computeCap,
    backend: info.cudaCompatible ? 'cuda' : info.vulkanAvailable ? 'vulkan' : 'cpu',
    legacyNvidia: !!(info.available && !info.cudaCompatible),
  };
  const deviceStatus = document.getElementById('deviceStatus');
  if (deviceStatus) setStatusMarkup(deviceStatus, getDeviceStatusMarkup(currentUiLang));
}

function getModelDisplayName(lang, id) {
  const m = I18N[lang].modelSelectNames || {};
  return m[id] || id;
}

function rebuildTargetLanguageNames(lang) {
  const list = document.getElementById('targetLanguageList');
  if (!list) return;
  const map = I18N[lang].langNames || {};
  list.querySelectorAll('.lang-check').forEach((lab) => {
    const cb = lab.querySelector('input');
    const span = lab.querySelector('span');
    if (cb && span && map[cb.value]) span.textContent = `${map[cb.value]} (${cb.value})`;
  });
  updateLangSummary();
}

// 선택된 번역 대상 언어 목록(체크되고 비활성화 아닌 것). 하나도 없으면 기본 ['ko'].
function getSelectedTargetLangs() {
  const list = document.getElementById('targetLanguageList');
  if (!list) return ['ko'];
  const checked = Array.from(list.querySelectorAll('input[type="checkbox"]'))
    .filter((c) => c.checked && !c.disabled)
    .map((c) => c.value);
  return checked.length ? checked : ['ko'];
}

// 체크박스 선택을 localStorage에 저장/복원
function saveTargetLangs() {
  try {
    localStorage.setItem('targetLangs', JSON.stringify(getSelectedTargetLangs()));
  } catch (_e) {
    /* ignore */
  }
}
function restoreTargetLangs() {
  const list = document.getElementById('targetLanguageList');
  if (!list) return;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('targetLangs') || 'null');
  } catch (_e) {
    saved = null;
  }
  if (Array.isArray(saved) && saved.length) {
    const set = new Set(saved);
    list.querySelectorAll('input[type="checkbox"]').forEach((c) => {
      c.checked = set.has(c.value);
    });
  }
  updateLangSummary();
}

// 트리거에 표시할 요약 텍스트 갱신: "한국어" 또는 "한국어 외 2개"
function updateLangSummary() {
  const summary = document.getElementById('langMsSummary');
  if (!summary) return;
  const map = I18N[currentUiLang].langNames || {};
  const langs = getSelectedTargetLangs();
  const firstName = map[langs[0]] || langs[0];
  if (langs.length <= 1) {
    summary.textContent = firstName;
  } else {
    const d = I18N[currentUiLang] || I18N.ko;
    summary.textContent =
      typeof d.langMoreSummary === 'function'
        ? d.langMoreSummary(firstName, langs.length - 1)
        : `${firstName} +${langs.length - 1}`;
  }
}

// 떠오르는 패널 열기/닫기 (position:fixed, 트리거 기준 좌표). 카드 overflow:hidden 탈출.
function _positionLangPanel() {
  const trigger = document.getElementById('langMsTrigger');
  const panel = document.getElementById('targetLanguageList');
  if (!trigger || !panel) return;
  const r = trigger.getBoundingClientRect();
  panel.style.left = r.left + 'px';
  panel.style.top = r.bottom + 4 + 'px';
  panel.style.minWidth = Math.max(r.width, 240) + 'px';
  // 화면 아래로 넘치면 위로 띄움
  const ph = panel.offsetHeight || 320;
  if (r.bottom + 4 + ph > window.innerHeight - 8) {
    panel.style.top = Math.max(8, r.top - 4 - ph) + 'px';
  }
}
function openLangPanel() {
  const panel = document.getElementById('targetLanguageList');
  const trigger = document.getElementById('langMsTrigger');
  if (!panel || !trigger) return;
  // 다른 오버레이(커스텀 셀렉트 드롭다운)가 떠 있으면 함께 떠 있지 않게 닫는다.
  document.querySelectorAll('.custom-select-wrapper.open').forEach((w) => {
    if (typeof w.close === 'function') w.close();
    else w.classList.remove('open');
  });
  panel.hidden = false;
  _positionLangPanel();
  trigger.setAttribute('aria-expanded', 'true');
}
function closeLangPanel() {
  const panel = document.getElementById('targetLanguageList');
  const trigger = document.getElementById('langMsTrigger');
  if (panel) panel.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}
function isLangPanelOpen() {
  const panel = document.getElementById('targetLanguageList');
  return panel && !panel.hidden;
}
// 트리거/외부클릭/ESC/스크롤 배선 (1회만)
let _langPanelWired = false;
function initLangMultiSelect() {
  if (_langPanelWired) return;
  const trigger = document.getElementById('langMsTrigger');
  const panel = document.getElementById('targetLanguageList');
  if (!trigger || !panel) return;
  _langPanelWired = true;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLangPanelOpen()) closeLangPanel();
    else openLangPanel();
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (isLangPanelOpen()) closeLangPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isLangPanelOpen()) closeLangPanel();
  });
  // 스크롤/리사이즈 시 위치가 어긋나므로 닫는다(가장 견고)
  window.addEventListener('resize', () => closeLangPanel());
  document.addEventListener('scroll', () => closeLangPanel(), true);
}

function updateProgressInitial(lang) {
  const t = document.getElementById('progressText');
  if (
    t &&
    (!t.textContent ||
      t.textContent.trim() === '' ||
      t.textContent.includes('준비') ||
      t.textContent.includes('Ready') ||
      t.textContent.includes('Preparing'))
  ) {
    t.textContent = I18N[lang].progressReady;
  }
}

// applyI18n 확장: 동적 요소도 갱신
function applyI18n(lang) {
  currentUiLang = lang || 'ko';
  const d = I18N[currentUiLang] || I18N.ko;
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // Generic data-i18n / data-i18n-title / data-i18n-placeholder sweep
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && d[key] != null) el.textContent = d[key];
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key && d[key] != null) el.title = d[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key && d[key] != null) el.placeholder = d[key];
  });
  setText('titleText', d.titleText);
  setText('dropTitle', d.dropTitle);
  setText('dropHint1', d.dropHint1);
  // dropHint2는 이제 포멧 chip 행이고 도는 textContent로 덮어쓰면 안됨 — 스킵
  setText('queueTitle', d.queueTitle);
  setText('clearQueueBtn', d.clearQueueBtn);
  setText('openFolderBtn', d.openFolderBtn);
  setText('labelModel', d.labelModel);
  setText('labelLanguage', d.labelLanguage);
  const langInfo = document.getElementById('langStatusInfo');
  if (langInfo) langInfo.innerText = d.langStatusInfo;
  setText('labelDevice', d.labelDevice);
  setText('labelTranslation', d.labelTranslation);
  setText('labelLocalModel', d.labelLocalModel);
  setText('runBtn', d.runBtn);
  setText('selectFileBtn', d.selectFileBtn);
  setText('stopBtnText', d.stopBtn);
  setText('logTitle', d.logTitle);

  // View headers (History / Models)
  if (d.historyTitleText) setText('historyTitle', d.historyTitleText);
  if (d.historySubtitleText) setText('historySubtitle', d.historySubtitleText);
  if (d.modelsTitleText) setText('modelsTitle', d.modelsTitleText);
  if (d.modelsSubtitleText) setText('modelsSubtitle', d.modelsSubtitleText);
  if (d.refreshBtnText) {
    const rb = document.getElementById('refreshModelsBtn');
    if (rb) rb.textContent = d.refreshBtnText;
  }

  // Sidebar (rail) tooltips
  const rail = (sel, txt) => {
    const el = document.querySelector(sel);
    if (el && txt) el.title = txt;
  };
  rail('.rail-btn[data-view="workspace"]', d.railWorkspaceTitle);
  rail('.rail-btn[data-view="history"]', d.railHistoryTitle);
  rail('.rail-btn[data-view="models"]', d.railModelsTitle);
  rail('#railSettingsBtn', d.railSettingsTitle);

  // Refresh dynamic views if currently open
  const currentView = document.querySelector('.main-container')?.getAttribute('data-view');
  if (currentView === 'history' && typeof renderHistory === 'function') {
    try {
      renderHistory();
    } catch (_e) {}
  }
  if (currentView === 'models' && typeof renderModels === 'function') {
    try {
      renderModels();
    } catch (_e) {}
  }

  // 새로 추가된 i18n 요소
  setText('labelTargetLanguage', d.labelTargetLanguage);
  // targetLangNote: only show generic hint when no method-specific message is active
  const tnote = document.getElementById('targetLangNote');
  if (tnote && !tnote.dataset.methodOverride) tnote.textContent = d.targetLangNote;

  // Progress step labels (i18n)
  if (d.stepExtract) setText('stepLabelExtract', d.stepExtract);
  if (d.stepTranslate) setText('stepLabelTranslate', d.stepTranslate);
  if (d.stepDone) setText('stepLabelDone', d.stepDone);

  // Empty queue state
  if (d.emptyQueueTitle) setText('emptyQueueTitle', d.emptyQueueTitle);
  if (d.emptyQueueHint) {
    const hint = document.getElementById('emptyQueueHint');
    if (hint) setSafeHtml(hint, d.emptyQueueHint.replace(/\n/g, '<br>'));
  }

  // 설정 모달 i18n
  setText('settingsModalTitle', d.settingsModalTitle);
  const soundSection = document.getElementById('soundSectionTitle');
  if (soundSection)
    setSafeHtml(
      soundSection,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> ${d.soundSectionTitle}`
    );
  setText('soundEnabledLabel', d.soundEnabled);
  setText('soundVolumeLabelModal', d.soundVolume);
  setText('soundTestLabelModal', d.soundTest);
  // 히스토리 섹션
  setText('historySectionTitleText', d.historySectionTitle || d.historyTitleText || '히스토리');
  setText('historyEnabledLabel', d.historyEnabledLabel || '작업 이력 기록');
  if (d.historyToggleHint) setText('historyHint', d.historyToggleHint);
  const apiSection = document.getElementById('apiSectionTitle');
  if (apiSection)
    setSafeHtml(
      apiSection,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> ${d.apiSectionTitle}`
    );
  setText('labelDeeplKey', d.labelDeeplKey);
  setText('labelOpenaiKey', d.labelOpenaiKey);
  setText('labelGeminiKey', d.labelGeminiKey);
  setText('labelClaudeKey', d.labelClaudeKey);
  setText('testApiKeysBtn', d.testConnBtn);
  setText('saveSettingsBtn', d.saveBtn);
  // 공급자 모델 · 프롬프트 · 커스텀 공급자
  setText('labelOpenaiModel', d.modelFieldLabel);

  setText('labelGeminiModel', d.modelFieldLabel);
  setText('labelClaudeModel', d.modelFieldLabel);
  setText('labelTranslationPrompt', d.labelTranslationPrompt);
  setText('promptHint', d.promptHint);
  setText('resetPromptBtn', d.resetPromptBtn);
  setText('resetPromptHint', d.resetPromptHint);
  setText('labelCustomProviders', d.labelCustomProviders);
  setText('addCustomProviderBtn', d.addCustomProviderBtn);
  setText('customProviderTab', d.customProviderTab);
  document.querySelectorAll('.model-refresh').forEach((btn) => {
    btn.title = d.modelRefreshTitle || '';
  });
  setText('customProvidersHint', d.customProvidersHint);
  // placeholders & help
  const deeplInput = document.getElementById('deeplApiKey');
  if (deeplInput) deeplInput.placeholder = d.deeplPlaceholder;
  const deeplHelp = document.getElementById('deeplHelp');
  if (deeplHelp) setSafeHtml(deeplHelp, d.deeplHelpHtml);
  const openaiInput = document.getElementById('openaiApiKey');
  if (openaiInput) openaiInput.placeholder = d.openaiPlaceholder;
  const openaiHelp = document.getElementById('openaiHelp');
  if (openaiHelp) setSafeHtml(openaiHelp, d.openaiHelpHtml);
  const geminiInput = document.getElementById('geminiApiKey');
  if (geminiInput) geminiInput.placeholder = d.geminiPlaceholder;
  const geminiHelp = document.getElementById('geminiHelp');
  if (geminiHelp) setSafeHtml(geminiHelp, d.geminiHelpHtml);
  const claudeInput = document.getElementById('claudeApiKey');
  if (claudeInput) claudeInput.placeholder = d.claudePlaceholder;
  const claudeHelp = document.getElementById('claudeHelp');
  if (claudeHelp) setSafeHtml(claudeHelp, d.claudeHelpHtml);
  // 이미 그려진 커스텀 공급자 카드의 라벨도 새 언어로 다시 그린다.
  if (document.getElementById('customProviderList')?.children.length) {
    renderCustomProviders(readCustomProvidersFromUI());
  }
  // 토글 버튼 툴팁
  document.querySelectorAll('.toggle-password').forEach((btn) => {
    btn.title = d.togglePasswordShow || 'Show password';
  });

  // 동적 셀렉트/상태 갱신
  rebuildLanguageSelectOptions(currentUiLang);
  rebuildDeviceSelectOptions(currentUiLang);
  rebuildTranslationSelectOptions(currentUiLang);
  rebuildTargetLanguageNames(currentUiLang);
  updateProgressInitial(currentUiLang);

  // 내장 공급자 카드의 Base URL 라벨도 새 언어로 갱신한다.
  const baseUrlLabel = I18N[currentUiLang]?.customProviderBaseUrlLabel || 'Base URL';
  document.querySelectorAll('#openaiBaseUrlLabel, #geminiBaseUrlLabel, #claudeBaseUrlLabel').forEach((el) => {
    el.textContent = baseUrlLabel;
  });

  updateModelSelect();
  updateQueueDisplay(); // 언어 변경 시 큐 표시도 즉시 업데이트
  updateUIMode(); // 언어 변경 시 혼합 파일 경고도 즉시 업데이트

  // 업데이트 배너 언어도 업데이트 (배너가 표시 중일 때)
  if (typeof updateBannerLanguage === 'function') {
    updateBannerLanguage();
  }
}

// 싱크 우선 엔진(Faster-Whisper large-v2)이 선택되면 장치 카드에 동작 힌트를 띄운다.
// 장치 선택은 일반 모델과 동일하게 따른다: CPU=CPU만, GPU=GPU만, 자동=GPU 먼저 후 CPU 폴백.
// 모델 변경/설정 로드/모델목록 재구성 후 호출.
function updateSyncModelUI() {
  const _mv = document.getElementById('modelSelect')?.value;
  const isSync = _mv === 'large-v2-sync' || _mv === 'large-v2-sync-lite';
  // 장치 카드에 싱크 엔진 장치 선택 힌트(잠금 아님)를 표시. 싱크 모델일 때만 표시.
  const deviceNote = document.getElementById('deviceSyncLockNote');
  if (deviceNote) deviceNote.style.display = isSync ? '' : 'none';
}

// updateModelSelect를 현지화 지원하도록 보강
function updateModelSelect() {
  const modelSelect = document.getElementById('modelSelect');
  const modelStatus = document.getElementById('modelStatus');

  // 현재 선택된 모델 저장 (언어 변경 시 유지)
  const previousValue = modelSelect.value;

  modelSelect.replaceChildren();

  // 성능 좋은 순서 (위가 더 좋음). large-v2-sync는 별도 엔진(Faster-Whisper-XXL). 장치 선택을 따른다.
  const ids = ['large-v3-turbo', 'large-v2-sync', 'large-v2-sync-lite', 'large-v3', 'medium', 'small', 'base', 'tiny'];
  const models = ids.map((id) => ({ id, name: getModelDisplayName(currentUiLang, id) }));

  const availableGroup = document.createElement('optgroup');
  availableGroup.label = I18N[currentUiLang].modelAvailableGroup;

  const needDownloadGroup = document.createElement('optgroup');
  needDownloadGroup.label = I18N[currentUiLang].modelNeedDownloadGroup;

  let hasAvailable = false;
  let hasNeedDownload = false;

  const needTag = I18N[currentUiLang].modelOptionNeedDownload || '↓ Install needed';
  const readyTag = I18N[currentUiLang].modelOptionReady || '✓';
  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    if (availableModels[model.id]) {
      option.textContent = `${readyTag}  ${model.name}`;
      availableGroup.appendChild(option);
      hasAvailable = true;
    } else {
      option.textContent = `${needTag}  ${model.name}`;
      needDownloadGroup.appendChild(option);
      hasNeedDownload = true;
    }
  });

  if (hasAvailable) modelSelect.appendChild(availableGroup);
  if (hasNeedDownload) modelSelect.appendChild(needDownloadGroup);

  // 이전 선택 복원, 없으면 large-v3-turbo → medium 순으로 기본 선택
  if (previousValue && ids.includes(previousValue)) {
    modelSelect.value = previousValue;
  } else if (availableModels['large-v3-turbo']) {
    modelSelect.value = 'large-v3-turbo';
  } else if (availableModels['medium']) {
    modelSelect.value = 'medium';
  }

  // Update status message (localized) (상태 메시지 업데이트, 현지화)
  const availableCount = Object.keys(availableModels).filter((k) => availableModels[k]).length;
  if (modelStatus) {
    const base = I18N[currentUiLang].modelStatusText(availableCount);
    const manageLabel = I18N[currentUiLang].modelManageHint || 'Pre-download in Model Manager';
    setSafeHtml(modelStatus, `${base} <a href="#" id="openModelsLink" class="inline-link">${manageLabel} →</a>`);
    const openLink = document.getElementById('openModelsLink');
    if (openLink)
      openLink.addEventListener('click', (e) => {
        e.preventDefault();
        const btn = document.querySelector('.rail-btn[data-view="models"]');
        if (btn) btn.click();
      });
  }

  // 모델 요구사항 표시 초기화 및 이벤트 리스너
  updateModelRequirements(modelSelect.value);
  modelSelect.onchange = (e) => {
    updateModelRequirements(e.target.value);
    updateSyncModelUI();
  };

  // Rebuild custom dropdown so it reflects new option list
  const wrapper = modelSelect.closest('.custom-select-wrapper');
  if (wrapper) {
    // Remove old custom wrapper and re-init
    delete modelSelect.dataset.customized;
    modelSelect.classList.remove('custom-hidden');
    wrapper.replaceWith(modelSelect);
  }
  if (typeof buildCustomSelect === 'function') buildCustomSelect(modelSelect);

  // 모델 목록을 다시 만들면 선택이 바뀥 수 있으므로 싱크 모델 UI 재적용
  updateSyncModelUI();
}

// 모델별 시스템 요구사항 표시
function updateModelRequirements(modelId) {
  const requirementsEl = document.getElementById('modelRequirements');
  if (!requirementsEl) return;

  // whisper.cpp uses GGML quantization - requires much less VRAM than PyTorch (~10GB)
  // Source: https://github.com/ggerganov/whisper.cpp
  // Tested: large-v3 works on 6GB VRAM GPU
  const requirements = {
    tiny: { vram: '~1GB', ram: '~1GB', speed: '★★★★★' },
    base: { vram: '~1GB', ram: '~1GB', speed: '★★★★☆' },
    small: { vram: '~1GB', ram: '~2GB', speed: '★★★☆☆' },
    medium: { vram: '~2GB', ram: '~3GB', speed: '★★★☆☆' },
    'large-v3': { vram: '~4GB', ram: '~5GB', speed: '★★☆☆☆' },
    'large-v3-turbo': { vram: '~2GB', ram: '~3GB', speed: '★★★★☆' },
    'large-v2-sync': { vram: '~4.5GB', ram: '~5GB', speed: '★★☆☆☆' },
    'large-v2-sync-lite': { vram: '~3GB', ram: '~4GB', speed: '★★★☆☆' },
  };

  const req = requirements[modelId];
  if (!req) {
    requirementsEl.textContent = '';
    return;
  }

  const texts = {
    ko: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / 속도: ${req.speed}`,
    en: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / Speed: ${req.speed}`,
    ja: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / 速度: ${req.speed}`,
    zh: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / 速度: ${req.speed}`,
    pl: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / Prędkość: ${req.speed}`,
  };

  const reqText = texts[currentUiLang] || texts.en;
  // 모델 상세 설명(select 드롭다운 잘림 피해 이리로 옮긴 것). select 아래에 풀로 표시.
  const descMap = I18N[currentUiLang].modelSelectDescs || {};
  const descText = descMap[modelId] || '';
  const descHtml = descText ? `<span class="model-req-desc">${descText}</span><br>` : '';

  const isInstalled = !!(typeof availableModels !== 'undefined' && availableModels && availableModels[modelId]);
  if (isInstalled) {
    setSafeHtml(requirementsEl, `${descHtml}${reqText}`);
    requirementsEl.classList.remove('need-download');
  } else {
    const warn = {
      ko: '⚠ 설치 필요 — 시작 시 자동 다운로드되거나, 모델 관리에서 미리 받을 수 있습니다.',
      en: '⚠ Not installed — will auto-download on start, or fetch ahead in Model Manager.',
      ja: '⚠ 未インストール — 開始時に自動ダウンロード、またはモデル管理で事前取得できます。',
      zh: '⚠ 未安装 — 启动时自动下载，或在模型管理中预先下载。',
      pl: '⚠ Nie zainstalowano — pobierze się automatycznie lub możesz pobrać wcześniej w Menedżerze modeli.',
    };
    setSafeHtml(
      requirementsEl,
      `${descHtml}${reqText}<br><span class="need-download-msg">${warn[currentUiLang] || warn.en}</span>`
    );
    requirementsEl.classList.add('need-download');
  }
}

// 큐 UI도 현지화된 상태/버튼 텍스트 사용 (디바운스로 UI freeze 방지)
function updateQueueDisplay() {
  const now = Date.now();
  const timeSinceLastUpdate = now - lastQueueUpdateTime;

  // 최소 간격 미만이면 디바운스
  if (timeSinceLastUpdate < MIN_QUEUE_UPDATE_INTERVAL) {
    if (updateQueueDisplayTimer) clearTimeout(updateQueueDisplayTimer);
    updateQueueDisplayTimer = setTimeout(() => {
      updateQueueDisplayImmediate();
    }, MIN_QUEUE_UPDATE_INTERVAL - timeSinceLastUpdate);
    return;
  }

  updateQueueDisplayImmediate();
}

function updateQueueDisplayImmediate() {
  lastQueueUpdateTime = Date.now();
  const queueList = document.getElementById('queueList');
  const runBtn = document.getElementById('runBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearQueueBtn = document.getElementById('clearQueueBtn');
  const d = I18N[currentUiLang];

  // queueCount 업데이트
  const queueCount = document.getElementById('queueCount');
  if (queueCount) queueCount.textContent = fileQueue.length;

  if (fileQueue.length === 0) {
    // queueContainer는 항상 표시, queueList만 빈 상태 표시
    runBtn.disabled = true;
    runBtn.textContent = d.runBtn;
    stopBtn.style.display = 'none';
    // 빈 상태 메시지 표시
    setSafeHtml(
      queueList,
      `<div class="queue-empty">
      <div class="queue-empty-icon queue-empty-pixel">
        <img src="assets/px-empty-queue.png?v=3" alt="" aria-hidden="true"/>
      </div>
      <p class="queue-empty-title">${d.emptyQueueTitle || d.queueEmpty || 'Queue is empty'}</p>
      <p class="queue-empty-hint">${(d.emptyQueueHint || 'Drop a video or SRT file onto the dropzone').replace(/\n/g, '<br>')}</p>
    </div>`
    );
    return;
  }

  if (isProcessing) {
    runBtn.textContent = d.qProcessing;
    runBtn.disabled = true;
    runBtn.className = 'btn-secondary';
    stopBtn.style.display = 'inline-block';
    clearQueueBtn.textContent = d.clearQueueWaiting || d.clearQueueBtn;
  } else {
    // 대기 중인 파일만 카운트 (완료되지 않은 파일들)
    const pendingCount = fileQueue.filter(
      (f) => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped'
    ).length;
    runBtn.textContent = typeof d.runBtnCount === 'function' ? d.runBtnCount(pendingCount) : d.runBtn;
    runBtn.disabled = pendingCount === 0;
    runBtn.className = pendingCount > 0 ? 'btn-success' : 'btn-secondary';
    stopBtn.style.display = 'none';
    clearQueueBtn.textContent = d.clearQueueBtn;
  }

  // Escape user-controlled strings for HTML attribute values
  function escAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  setSafeHtml(
    queueList,
    fileQueue
      .map((file, index) => {
        const fullFileName = file.path.split('\\').pop() || file.path.split('/').pop();
        const ext = fullFileName.lastIndexOf('.') > 0 ? fullFileName.substring(fullFileName.lastIndexOf('.')) : '';
        const isSrt = ext.toLowerCase() === '.srt';

        // 파일명 표시: 이름 부분만 줄이고 확장자는 뱃지로 표시
        const nameWithoutExt = fullFileName.substring(0, fullFileName.length - ext.length);
        const maxNameLength = 25;
        let displayName = nameWithoutExt;
        if (nameWithoutExt.length > maxNameLength) {
          displayName = nameWithoutExt.substring(0, maxNameLength) + '...';
        }
        // 확장자 뱃지 (SRT는 보라색, 동영상은 초록색)
        const extBadge = isSrt
          ? `<span class="ext-badge srt">SRT</span>`
          : `<span class="ext-badge video">${escAttr(ext.toUpperCase().substring(1))}</span>`;

        const isValid = isVideoFile(file.path) || isSrtFile(file.path);

        let statusText = d.qWaiting;
        let itemClass = 'queue-item';

        if (file.status === 'completed') {
          statusText = d.qCompleted;
          itemClass = 'queue-item completed';
        } else if (file.status === 'processing') {
          statusText = d.qProcessing;
          itemClass = 'queue-item processing';
        } else if (file.status === 'translating') {
          statusText = d.qTranslating;
          itemClass = 'queue-item processing';
        } else if (file.status === 'stopped') {
          statusText = d.qStopped;
          itemClass = 'queue-item error';
        } else if (file.status === 'skipped') {
          statusText = d.qSkipped || 'Skipped';
          itemClass = 'queue-item skipped';
        } else if (file.status === 'error') {
          statusText = d.qError;
          itemClass = 'queue-item error';
        } else if (!isValid) {
          statusText = d.qUnsupported;
          itemClass = 'queue-item error';
        }

        const maxPathLength = 80;
        const displayPath =
          file.path.length > maxPathLength ? file.path.substring(0, maxPathLength) + '...' : file.path;

        const btnOpen = d.btnOpen;
        const btnRemove = d.btnRemove;
        const processingBadge = `<span style="color: #ffc107; font-size: 12px; font-weight: 600;">${d.qProcessing}</span>`;

        // 처리 중이 아닌 경우에만 드래그 가능 (처리 중에는 pending 항목도 잠금:
        // 재정렬 시 currentProcessingIndex가 어긋나 미처리 파일이 누락된다)
        const isDraggable = !isProcessing && file.status !== 'processing' && file.status !== 'translating';
        const dragAttr = isDraggable ? `draggable="true" data-index="${index}"` : '';

        // Safe HTML generation: all user data in data-* attrs only, no inline JS
        let actionButtons = '';
        if (file.status === 'completed') {
          actionButtons = `<button class="btn-success btn-sm" data-action="open" data-index="${index}">${escAttr(btnOpen)}</button>`;
        } else if (file.status === 'processing' || file.status === 'translating') {
          actionButtons = processingBadge;
        } else if (file.status === 'error' || file.status === 'stopped') {
          actionButtons =
            `<button class="btn-warning btn-sm" style="margin-right:4px;" data-action="retry" data-index="${index}">${escAttr(d.btnRetry || 'Retry')}</button>` +
            `<button class="btn-danger btn-sm" data-action="remove" data-index="${index}">${escAttr(btnRemove)}</button>`;
        } else {
          actionButtons = `<button class="btn-danger btn-sm" data-action="remove" data-index="${index}">${escAttr(btnRemove)}</button>`;
        }

        return `
      <div class="${itemClass}${isDraggable ? ' draggable' : ''}" ${dragAttr}>
        ${isDraggable ? `<div class="drag-handle" title="${escAttr(d.dragHandleTooltip || 'Drag to reorder')}">&#9776;</div>` : ''}
        <div class="file-info">
          <div class="file-name"><span class="name-text queue-copy-name" data-copy="${escAttr(fullFileName)}" title="${escAttr(fullFileName)} (${escAttr(d.clickToCopy || 'Click to copy')})">${escAttr(displayName)}</span>${extBadge}</div>
          <div class="file-path queue-copy-path" data-copy="${escAttr(file.path)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(file.path)} (${escAttr(d.clickToCopy || 'Click to copy')})">${escAttr(displayPath)}</div>
          <div class="file-status">${statusText}${file.progress ? ` (${file.progress}%)` : ''}</div>
        </div>
        <div>${actionButtons}</div>
      </div>
    `;
      })
      .join('')
  );

  // 드래그 앤 드롭 이벤트 설정
  setupQueueDragAndDrop();
}

// 진행 단계 텍스트도 현지화 사용
function startIndeterminate(maxCap, labelKey) {
  stopIndeterminate();
  const d = I18N[currentUiLang];
  const label = labelKey === 'extract' ? d.progressExtracting : d.progressTranslating;
  _currentPhase = label;
  indeterminateTimer = setInterval(() => {
    const cap = Math.max(0, Math.min(100, maxCap));
    if (lastProgress < cap) {
      setProgressTarget(Math.min(cap, lastProgress + 1), label);
    }
  }, 400);
}

function resetProgress(textKey) {
  stopIndeterminate();
  stopProgressAnimation();
  lastProgress = 0;
  targetProgress = 0;
  const d = I18N[currentUiLang];
  targetText = textKey === 'prepare' ? d.progressPreparing : '';
  updateProgress(0, targetText);
  // 'prepare'(작업 시작) 외의 리셋은 유휴 복귀다: updateProgress가 켜둔 패널을 다시 숨긴다.
  if (textKey !== 'prepare') {
    const progressContainer = document.getElementById('progressContainer');
    if (progressContainer) progressContainer.style.display = 'none';
  }
}

function localizeLog(text) {
  if (!text || currentUiLang === 'ko') return text;
  const rules = LOG_I18N[currentUiLang];
  if (!rules) return text;
  let out = text;
  for (const { re, to } of rules) {
    out = out.replace(re, to);
  }
  return out;
}

// RAW 출력 함수(현지화 없이 실제 출력만 수행)
function appendOutputRaw(text) {
  // Route through the styled addOutput (defined earlier) so every log path
  // gets timestamp + icon + category color + group collapsing.
  addOutput(text);
}

// translating 단계 진행 줄: div 로그와 같은 방식으로 추가하고, 다음 이벤트에서 같은 div만 교체한다.
// (이전 구현은 output.textContent.split('\n')로 전체 로그를 textContent로 바꿔 기존 div 로그를 소멸시킴)
let _translatingLineEl = null;
function updateTranslatingLine(text) {
  const output = document.getElementById('output');
  if (!output) return;
  const clean = String(text).replace(/\n$/, '');
  if (_translatingLineEl && output.contains(_translatingLineEl)) {
    // 같은 진행 줄 갱신 (타임스탬프 유지)
    _translatingLineEl.textContent = clean;
    _translatingLineEl.title = clean;
  } else {
    // 새 진행 줄 추가
    const el = document.createElement('div');
    el.className = 'log-line log-translating';
    el.textContent = clean;
    el.title = clean;
    output.appendChild(el);
    _translatingLineEl = el;
    // DOM 가벌게 유지 (addOutput과 동일한 프루닝)
    while (output.childNodes.length > 500) output.removeChild(output.firstChild);
  }
  output.scrollTop = output.scrollHeight;
}

// addOutput도 현지화 적용: 원본 addOutput를 백업한 뒤 현지화 래퍼로 교체.
const _addOutputRaw = addOutput;
addOutput = function (text) {
  _addOutputRaw(localizeLog(text));
};

// IPC를 통한 로그도 동일 현지화 적용
function addOutputLocalized(text) {
  appendOutputRaw(localizeLog(text));
}

// onOutputUpdate 현지화 적용
if (window?.electronAPI) {
  const origOnOutput = window.electronAPI.onOutputUpdate;
  if (typeof origOnOutput === 'function') {
    window.electronAPI.onOutputUpdate((text) => {
      addOutputLocalized(text);
    });
  }
  const origOnTranslation = window.electronAPI.onTranslationProgress;
  if (typeof origOnTranslation === 'function') {
    // 세션 ID 기반 가드: renderer는 translate-subtitle invoke마다 현재 _processingEpoch를
    // sessionId로 실어 보내고, main이 translation-progress 이벤트에 그대로 에코한다.
    // 중지→즉시 재실행 시 이전 세션의 지연 completed/error는 sessionId 불일치로 즉시 차단된다.
    // (기존 'starting' 재무장 방식은 이전 세션의 completed가 새 세션 'starting'보다 먼저
    //  도착하면 걸러내지 못해 새 세션을 오염시켰다)
    window.electronAPI.onTranslationProgress((data) => {
      const methodNow = document.getElementById('translationSelect')?.value;
      // 번역 비활성(none) 시 무시하되, completed/error는 예외 — 이벤트가 도착했다는 건
      // 실제 번역 세션이 있었던 것이고, completed가 자동-다음파일 트리거를 담당하므로
      // 버리면 99%에서 동결된다 (F2). stale 이벤트는 아래 sessionId 가드가 걸러낸다.
      const isTerminalStage = data?.stage === 'completed' || data?.stage === 'error';
      if ((!methodNow || methodNow === 'none') && !isTerminalStage) return;

      // 이전 세션에서 남은 이벤트는 sessionId 불일치로 무시한다.
      if (data?.sessionId !== _processingEpoch) return;

      // completed 단계는 항상 처리해야 함 (자동 처리 로직 실행을 위해)
      if (!translationSessionActive && data?.stage !== 'completed') return; // 완료 이후 추가 이벤트 무시
      // 중지 이후 들어온 진행 이벤트는 UI에 반영하지 않음 (파일 남아있는 청크 완료 수준)
      if (shouldStop && (data?.stage === 'translating' || data?.stage === 'starting')) return;

      // 메시지를 I18N으로 생성
      let msg = '';
      if (data?.stage === 'starting') {
        msg = I18N[currentUiLang].translationStarting;
        _maxTranslatedCurrent = 0; // 세션 시작 시 리셋
      } else if (data?.stage === 'translating') {
        // 다국어: 언어가 바뀌면 X/total 카운터 리셋
        if (typeof data?.langIndex === 'number' && data.langIndex !== _curLangIndex) {
          _curLangIndex = data.langIndex;
          _maxTranslatedCurrent = 0;
        }
        if (data?.current && data?.total) {
          // 병렬 배치로 current 값이 올라갔다 내려갔다 하지 않도록 단조 증가
          _maxTranslatedCurrent = Math.max(_maxTranslatedCurrent, data.current);
          msg = I18N[currentUiLang].translationTranslatingProgress(_maxTranslatedCurrent, data.total);
          // 현재 세그먼트 텍스트 미리보기 (있으면)
          if (data?.currentText) {
            const preview = String(data.currentText).replace(/\s+/g, ' ').trim().slice(0, 80);
            if (preview) msg += `  · “${preview}${data.currentText.length > 80 ? '…' : ''}”`;
          }
        } else {
          msg = I18N[currentUiLang].translationTranslating;
        }
        // 다국어 동시 번역 시 현재 언어 표시: (2/3 ja)
        if (data?.langTotal > 1 && data?.lang) {
          msg = `(${data.langIndex}/${data.langTotal} ${data.lang}) ${msg}`;
        }
      } else if (data?.stage === 'completed') {
        msg = I18N[currentUiLang].translationCompleted;
      } else if (data?.stage === 'error') {
        msg = I18N[currentUiLang].translationFailed + getLocalizedError(data?.errorMessage || '');
      }

      if (msg) {
        if (data?.stage === 'translating') {
          updateTranslatingLine(`${I18N[currentUiLang].translationProgress}${msg}\n`);
        } else {
          addOutput(`${I18N[currentUiLang].translationProgress}${msg}\n`);
        }
      }
      // 진행률 갱신 - 번역 진행률(0-100)을 전체 진행률로 변환
      if (typeof data?.progress === 'number') {
        const translationPct = Math.max(0, Math.min(100, data.progress));
        // 추출이 없던 세션(SRT 단독 번역)은 main이 보낸 0-100을 그대로 쓴다.
        // 추출이 있었던 세션은 번역이 50-100% 구간이다.
        let overallPct = _translationProgressFromZero ? translationPct : 50 + (translationPct / 100) * 50; // 50-100 범위로 매핑
        // 'translating' 단계에서는 100%(="완료!")에 도달하지 않도록 99%로 상한 제한.
        // 마지막 배치가 current===total로 progress=100을 보내더라도, SRT 조립·파일 저장 등
        // 후처리가 아직 남아 있으므로 진짜 완료(=completed 단계)에서만 100%로 마무리한다.
        if (data?.stage !== 'completed') overallPct = Math.min(overallPct, 99);
        setProgressTarget(Math.max(lastProgress, overallPct), I18N[currentUiLang].progressTranslating);
      }
      if (data?.stage === 'completed' || data?.stage === 'error') {
        // 중지 후 3초 이내에 도착한 completed/error 이벤트는 무시
        if (_stoppedAt && Date.now() - _stoppedAt < 3000) {
          _stoppedAt = 0;
          return;
        }
        _stoppedAt = 0;
        const isErrorStage = data?.stage === 'error';
        // 번역 완료: 100%로 설정 후 세션 종료
        stopIndeterminate();
        translationSessionActive = false;
        const stageProgressTarget = isErrorStage ? 95 : 100;
        // 100%에 도달하는 완료 단계에서는 텍스트도 "완료" 계열로 맞춰 타이틀(완료!)과 일치시킨다.
        // (이전에는 progressTranslating="번역 중..."이 남아 100%인데도 "번역 중"이 표시됐음)
        const stageText = isErrorStage
          ? data?.message || I18N[currentUiLang].progressTranslating
          : data?.message || I18N[currentUiLang].translationCompleted || I18N[currentUiLang].progressComplete;
        setProgressTarget(Math.max(lastProgress, stageProgressTarget), stageText);

        // 완료 처리 시 select 재활성화 상태 반영 (updateUIMode는 완료/중지 경로에서 호출됨)
        if (typeof updateUIMode === 'function') updateUIMode();
        // 현재 처리 중인 파일을 completed로 마킹
        if (currentProcessingIndex >= 0 && currentProcessingIndex < fileQueue.length) {
          const _f = fileQueue[currentProcessingIndex];
          _f.status = isErrorStage ? 'error' : 'completed';
          _f.progress = isErrorStage ? 0 : 100;
          console.log(
            `[onTranslationProgress] File status changed to ${isErrorStage ? 'error' : 'completed'}, index:`,
            currentProcessingIndex
          );
          // 히스토리 저장 (비디오+번역 흐름은 이 경로만 완료되므로 누락되면 기록 안 남음)
          try {
            saveFileToHistory(_f, isErrorStage ? data?.errorMessage : undefined);
          } catch (_e) {
            /* noop */
          }
        }

        // 단일 파일 처리 완료 후 잠시 대기 (메모리 정리 시간 확보)
        const completeEpoch = _processingEpoch; // 완료 콜백 epoch 캡처 (중지/재시작 시 무효화)
        setTimeout(async () => {
          // 중지/재시작으로 epoch가 바뀌었으면 stale 콜백이므로 무시한다.
          if (completeEpoch !== _processingEpoch) {
            console.log('[onTranslationProgress] stale completed callback ignored (epoch mismatch)');
            return;
          }
          try {
            console.log('[onTranslationProgress] completed setTimeout executing, isProcessing:', isProcessing);
            updateQueueDisplay();

            // 대기 중인 파일이 더 있는지 확인
            const remainingFiles = fileQueue.filter(
              (f) =>
                f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped' && f.status !== 'translating'
            ).length;
            console.log('[onTranslationProgress] remainingFiles:', remainingFiles, 'shouldStop:', shouldStop);

            if (remainingFiles > 0 && !shouldStop) {
              addOutput(`${I18N[currentUiLang].processingNext(remainingFiles)}\n\n`);

              // 다음 파일 처리 시작
              await continueProcessing();
            } else {
              // 모든 파일 완료 또는 중지됨
              isProcessing = false;
              currentProcessingIndex = -1;
              shouldStop = false;
              updateQueueDisplay();
              // 번역 select 비활성 해제 (배치 종료 후 변경 가능)
              if (typeof updateUIMode === 'function') updateUIMode();

              const completedCount = fileQueue.filter((f) => f.status === 'completed').length;
              const errorCount = fileQueue.filter((f) => f.status === 'error').length;
              const stoppedCount = fileQueue.filter((f) => f.status === 'stopped').length;

              // UX: 짧은 지연 후 100%로 마무리
              setTimeout(() => {
                // 이 콜백도 stale이면 (완료 도중 중지/재시작) 토스트/사운드를 건드리지 않는다.
                if (completeEpoch !== _processingEpoch) return;
                const d = I18N[currentUiLang];
                if (stoppedCount > 0 || (_stoppedAt && Date.now() - _stoppedAt < 10000)) {
                  showToast(d.allStopped || 'Processing stopped.');
                } else if (errorCount > 0 && completedCount === 0) {
                  // 전원 실패: 완료 효과음 X, 실패 토스트
                  setProgressTarget(100, getAllFailedMsg());
                  showToast(getAllFailedMsg());
                } else if (errorCount > 0) {
                  // 부분 실패: 경고 토스트, 효과음 X
                  setProgressTarget(100, d.allDoneWithErrors || `Done with ${errorCount} error(s)`);
                  showToast(d.allDoneWithErrors || `Done with ${errorCount} error(s)`, {
                    label: d.toastOpenFolder,
                    onClick: openOutputFolder,
                  });
                } else {
                  {
                    const _k = getAllDoneKey(document.getElementById('translationSelect')?.value);
                    setProgressTarget(100, d[_k]);
                    showToast(d[_k], { label: d.toastOpenFolder, onClick: openOutputFolder });
                  }
                  try {
                    playCompletionSound();
                  } catch (error) {
                    console.log('[Audio] Failed to play completion sound:', error.message);
                  }
                }
                addOutput(`\n${d.allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
              }, 400);
            }
          } catch (error) {
            console.error('[onTranslationProgress] autoProcessNext error:', error);
            addOutput(`${I18N[currentUiLang].autoProcessError(error.message)}\n`);
          }
        }, 2000);
      }
    });
  }
  // 추출 실시간 진행률(whisper -pp). main.js가 stderr의 progress=N%를 파싱해 0~100으로 보냄.
  // 첫 실제 값이 오면 의사 진행률(startIndeterminate)을 멈추고 실제 값으로 전환.
  const origOnProgress = window.electronAPI.onProgressUpdate;
  if (typeof origOnProgress === 'function') {
    window.electronAPI.onProgressUpdate((data) => {
      if (!data || data.stage !== 'extracting' || typeof data.percent !== 'number') return;
      stopIndeterminate(); // 가짜 진행률 중지, 이제 실제 값이 주도
      // 표시는 전체 작업 기준 숫자 하나만: 실제 진행률 0~100을 [워밍 상한 ~ 추출 최대] 구간으로 매핑
      // → 의사 진행률이 멈춘 지점에서 자연스럽게 이어받으며 max(=50/95)까지 채운다.
      // 라벨엔 단계명만(숫자 중복 제거) → "25% - 자막 추출 중..." 처럼 한 개의 진행률만 보임.
      const span = Math.max(0, _extractionMaxProgress - _extractionWarmupProgress);
      const mapped = _extractionWarmupProgress + (data.percent / 100) * span;
      const d = I18N[currentUiLang];
      setProgressTarget(Math.max(lastProgress, mapped), d.progressExtracting);
    });
  }
}

// UI 언어 드롭다운 연동 (설정 저장 포함)
function initUiLanguageDropdown() {
  const sel = document.getElementById('uiLanguageSelect');
  if (!sel) return;

  const apply = (lang) => {
    applyI18n(lang);
  };
  const validLangs = ['ko', 'en', 'ja', 'zh', 'pl'];

  // 저장된 설정 읽기 전에 기본 적용해 옵션 라벨이 빈 칸으로 표시되는 깜박임 방지
  apply(currentUiLang || 'ko');

  // 저장된 언어 설정 불러오기 (config 파일에서)
  window.electronAPI
    .loadApiKeys()
    .then((res) => {
      if (res && res.success && res.keys && res.keys.uiLanguage) {
        const savedLang = res.keys.uiLanguage;
        if (validLangs.includes(savedLang)) {
          sel.value = savedLang;
          apply(savedLang);
        }
      }
    })
    .catch(() => {
      apply(sel.value || 'ko');
    });

  // 언어 변경 시 저장 (config 파일에)
  sel.addEventListener('change', async () => {
    const newLang = sel.value;
    apply(newLang);
    try {
      await window.electronAPI.saveApiKeys({ uiLanguage: newLang });
    } catch (e) {
      console.warn('[UI Language] Failed to save language preference:', e);
    }
  });
}

// 번역 설정 초기화 (번역 안함일 때 대상 언어 숨김)
function initTranslationSelect() {
  const translationSelect = document.getElementById('translationSelect');
  const targetLanguageGroup = document.getElementById('targetLanguageGroup');
  const translationStatus = document.getElementById('translationStatus');
  const targetLanguageList = document.getElementById('targetLanguageList');
  if (!translationSelect || !targetLanguageGroup) return;
  const update = () => {
    const method = translationSelect.value;
    if (method === 'none') {
      targetLanguageGroup.style.display = 'none';
      if (translationStatus) setStatusMarkup(translationStatus, I18N[currentUiLang].translationDisabledHtml);
    } else {
      targetLanguageGroup.style.display = '';
      if (translationStatus) {
        // 선택한 번역 방법에 따라 다른 메시지 표시
        if (method === 'mymemory') {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationEnabledHtml);
        } else if (method === 'deepl') {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationDeeplHtml);
        } else if (method === 'chatgpt') {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationChatgptHtml);
        } else if (method === 'gemini') {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationGeminiHtml);
        } else if (method === 'claude') {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationClaudeHtml);
        } else if (method === 'local') {
          // Check model install status
          updateLocalModelStatus();
        } else {
          setStatusMarkup(translationStatus, I18N[currentUiLang].translationEnabledHtml);
        }
      }
    }
    // Per-method unsupported target languages
    // DeepL: 페르시아어 미지원
    // Local (Hy-MT2 기반): 헝가리어 미지원 → 드롭다운에서 아예 숨김 + 클라우드 엔진으로 아내
    const unsupportedByMethod = {
      deepl: ['fa'],
      local: ['hu'],
    };
    if (targetLanguageList) {
      const unsupported = new Set(unsupportedByMethod[method] || []);
      targetLanguageList.querySelectorAll('.lang-check').forEach((lab) => {
        const cb = lab.querySelector('input');
        if (!cb) return;
        const isUnsupported = unsupported.has(cb.value);
        cb.disabled = isUnsupported;
        lab.style.display = isUnsupported ? 'none' : '';
        if (isUnsupported) cb.checked = false; // 미지원 언어는 자동 선택 해제
      });
      const note = document.getElementById('targetLangNote');
      if (note) {
        // 엔진별 미지원 언어 안내는 locales/*.json 의 engineSupportNote 로 이동.
        const localized = I18N[currentUiLang].engineSupportNote || I18N.en.engineSupportNote;
        // 다국어 체크박스 모드: 해당 엔진이 미지원 언어(숨김)를 가질 때 안내를 표시.
        if (method === 'local') {
          note.textContent = localized.local;
          note.dataset.methodOverride = '1';
        } else if (method === 'deepl') {
          note.textContent = localized.deepl;
          note.dataset.methodOverride = '1';
        } else {
          note.textContent = '';
          delete note.dataset.methodOverride;
        }
      }
    }
    // 미지원 언어 자동 해제가 있을 수 있으므로 요약 갱신
    updateLangSummary();
  };
  translationSelect.addEventListener('change', () => {
    update();
    // 혼합 모드 경고 업데이트 (SRT 스킵 예고)
    if (typeof updateUIMode === 'function') {
      updateUIMode();
    }
    // Local 선택 시 모델 서브-셀렉트 표시/갱신
    if (typeof updateLocalModelStatus === 'function') {
      updateLocalModelStatus();
    }
  });

  // Local 모델 서브-셀렉트 변경 시 상태/사양 갱신
  const localModelSelect = document.getElementById('localModelSelect');
  if (localModelSelect) {
    localModelSelect.addEventListener('change', () => {
      if (typeof updateLocalModelStatus === 'function') {
        updateLocalModelStatus();
      }
      // 설정 자동 저장
      try {
        window.electronAPI.saveApiKeys({ localModelId: localModelSelect.value });
      } catch (_e) {
        /* ignore */
      }
    });
  }
  // 다국어 체크박스: 패널 토글 배선 + 저장된 선택 복원 + 변경 시 저장·요약 갱신
  initLangMultiSelect();
  restoreTargetLangs();
  if (targetLanguageList) {
    targetLanguageList.addEventListener('change', () => {
      saveTargetLangs();
      updateLangSummary();
    });
  }
  update();
}

// 저장된 설정 불러오기 (앱 시작 시)
async function loadSavedSettings() {
  try {
    const res = await window.electronAPI.loadApiKeys();
    if (!res || !res.success || !res.keys) return;

    const keys = res.keys;
    console.log('[Settings] Loading saved settings:', Object.keys(keys));

    // 모델 선택
    if (keys.selectedModel) {
      const modelSelect = document.getElementById('modelSelect');
      if (modelSelect) {
        // 옵션이 존재하는지 확인
        const optionExists = Array.from(modelSelect.options).some((opt) => opt.value === keys.selectedModel);
        if (optionExists) {
          modelSelect.value = keys.selectedModel;
          // 모델 요구사항 표시 업데이트
          if (typeof updateModelRequirements === 'function') {
            updateModelRequirements(keys.selectedModel);
          }
          console.log('[Settings] Restored model:', keys.selectedModel);
        } else {
          console.log('[Settings] Saved model not available:', keys.selectedModel);
        }
      }
    }

    // 음성 언어 선택
    if (keys.selectedLanguage) {
      const languageSelect = document.getElementById('languageSelect');
      if (languageSelect) {
        languageSelect.value = keys.selectedLanguage;
        console.log('[Settings] Restored language:', keys.selectedLanguage);
      }
    }

    // 처리 장치 선택
    if (keys.selectedDevice) {
      const deviceSelect = document.getElementById('deviceSelect');
      if (deviceSelect) {
        deviceSelect.value = keys.selectedDevice;
        console.log('[Settings] Restored device:', keys.selectedDevice);
      }
    }

    // 번역 엔진 선택
    if (keys.selectedTranslation) {
      const translationSelect = document.getElementById('translationSelect');
      if (translationSelect) {
        const saved = keys.selectedTranslation;
        const optionExists = Array.from(translationSelect.options).some((opt) => opt.value === saved);
        if (optionExists) {
          translationSelect.value = saved;
        }
        console.log('[Settings] Restored translation:', translationSelect.value);
        translationSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Local 모델 항목 복원
    if (keys.localModelId) {
      const localSel = document.getElementById('localModelSelect');
      if (localSel && Array.from(localSel.options).some((o) => o.value === keys.localModelId)) {
        localSel.value = keys.localModelId;
      }
    }

    // Sync custom dropdown display values after all native selects are set
    document.querySelectorAll('.setting-card .setting-select[data-customized]').forEach((sel) => {
      sel.dispatchEvent(new Event('change', { bubbles: false }));
    });
  } catch (error) {
    console.error('[Settings] Failed to load saved settings:', error.message);
  }
}

// 설정 자동 저장 (select 변경 시)
async function autoSaveSettings() {
  try {
    const res = await window.electronAPI.loadApiKeys();
    const keys = res?.keys || {};

    // 현재 선택값 저장
    const modelSelect = document.getElementById('modelSelect');
    const languageSelect = document.getElementById('languageSelect');
    const deviceSelect = document.getElementById('deviceSelect');
    const translationSelect = document.getElementById('translationSelect');
    const uiLanguageSelect = document.getElementById('uiLanguageSelect');

    if (modelSelect) keys.selectedModel = modelSelect.value;
    if (languageSelect) keys.selectedLanguage = languageSelect.value;
    if (deviceSelect) keys.selectedDevice = deviceSelect.value;
    if (translationSelect) keys.selectedTranslation = translationSelect.value;
    if (uiLanguageSelect) keys.uiLanguage = uiLanguageSelect.value;

    await window.electronAPI.saveApiKeys(keys);
    console.log('[Settings] Auto-saved settings');
  } catch (error) {
    console.error('[Settings] Auto-save failed:', error.message);
  }
}

// 설정 변경 이벤트 연결
function initSettingsAutoSave() {
  const selects = ['modelSelect', 'languageSelect', 'deviceSelect', 'translationSelect'];

  selects.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        console.log(`[Settings] ${id} changed to:`, el.value);
        autoSaveSettings();
      });
    }
  });
  console.log('[Settings] Auto-save listeners initialized');
}

// 전역 초기화
/* ============================================================
   Custom dropdown — replaces native <select> in setting cards
   ============================================================ */
// ── Local Hy-MT2 Model UI ────────────────────────────────────────────────────
let _localDownloading = false;
let _localModelList = null; // 캐시

function getSelectedLocalModelId() {
  const sel = document.getElementById('localModelSelect');
  return sel?.value || '1.8b';
}

async function rebuildLocalModelSelect() {
  const sel = document.getElementById('localModelSelect');
  if (!sel) return;
  if (!_localModelList && window.electronAPI?.localModelList) {
    try {
      _localModelList = await window.electronAPI.localModelList();
    } catch (_e) {
      _localModelList = [];
    }
  }
  const d = I18N[currentUiLang] || I18N.ko;
  Array.from(sel.options).forEach((opt) => {
    const meta = (_localModelList || []).find((m) => m.id === opt.value);
    if (!meta) return;
    const installed = meta.installed ? ' ✓' : '';
    const sizeGb = (meta.sizeBytes / 1024 / 1024 / 1024).toFixed(1);
    if (opt.value === '1.8b') {
      opt.textContent = (d.localModel18bLabel || 'Hy-MT2 1.8B · Fast') + ` (${sizeGb} GB${installed})`;
    } else if (opt.value === '7b') {
      opt.textContent = (d.localModel7bLabel || 'Hy-MT2 7B · High quality') + ` (${sizeGb} GB${installed})`;
    }
  });
}

function renderLocalModelRequirements(modelId) {
  const el = document.getElementById('localModelRequirements');
  if (!el) return;
  const meta = (_localModelList || []).find((m) => m.id === modelId);
  if (!meta) {
    el.textContent = '';
    return;
  }
  const d = I18N[currentUiLang] || I18N.ko;
  const r = meta.requirements || {};
  const label = d.localReqLabel || 'Recommended';
  const speedKey = r.speed && r.speed.includes('빠') ? 'fast' : r.speed && r.speed.includes('느') ? 'slow' : 'normal';
  const speedMap = {
    ko: { fast: '빠름', slow: '느림 (고품질)', normal: '보통' },
    en: { fast: 'Fast', slow: 'Slow (high quality)', normal: 'Normal' },
    ja: { fast: '高速', slow: '低速（高品質）', normal: '通常' },
    zh: { fast: '快速', slow: '较慢（高品质）', normal: '普通' },
    pl: { fast: 'Szybko', slow: 'Wolno (wysoka jakość)', normal: 'Normalnie' },
  };
  const speed = (speedMap[currentUiLang] || speedMap.en)[speedKey];
  setSafeHtml(
    el,
    `<span style="font-size:10.5px;color:var(--text-muted)">${label}: VRAM ${r.vram} / RAM ${r.ram} · ${speed}</span>`
  );
}

async function updateLocalModelStatus() {
  const statusEl = document.getElementById('translationStatus');
  if (!statusEl) return;

  await rebuildLocalModelSelect();
  const modelId = getSelectedLocalModelId();
  renderLocalModelRequirements(modelId);

  // Local 모델 서브-셀렉트 표시 (translation === 'local'일 때만)
  const grp = document.getElementById('localModelGroup');
  const trSel = document.getElementById('translationSelect');
  if (grp) grp.style.display = trSel?.value === 'local' ? 'block' : 'none';

  // Translation method가 local이 아니면 상태 바를 덮어쓰지 않음 (Gemini/DeepL 등 선택 시 Hy-MT2가 잘못 리턴하는 버그 방지)
  if (trSel?.value !== 'local') return;

  const info = await window.electronAPI.localModelStatus(modelId);
  const d = I18N[currentUiLang] || I18N.ko;
  const sizeText = info.sizeMB ? ` (${(info.sizeMB / 1024).toFixed(1)} GB)` : '';

  if (info.installed) {
    setSafeHtml(
      statusEl,
      `<span style="color:var(--accent)">${d.localModelInstalledHtml || '&#10003; Hy-MT2 model installed'}${sizeText}</span>`
    );
  } else if (_localDownloading) {
    setSafeHtml(
      statusEl,
      `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${d.localModelDownloadingHtml || 'Downloading Hy-MT2 Q4...'} <span id="localDlPercent">0%</span></div>
      <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;width:100%">
        <div id="localDlBar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
      </div>`
    );
  } else {
    setSafeHtml(
      statusEl,
      `<span style="color:var(--text-muted);font-size:11px">${d.localModelMissingHtml || '⚠ Hy-MT2 model not installed — auto-downloads on start'}${sizeText}</span>`
    );
  }
}

// 자동 다운로드 진행률 리스너 (main에서 local-model-progress 이벤트 수신)
if (window.electronAPI?.onLocalModelProgress) {
  window.electronAPI.onLocalModelProgress(({ percent }) => {
    _localDownloading = percent < 100;
    // local 번역이 선택되지 않은 상태에서는 상태 바를 건드리지 않음
    const trSel = document.getElementById('translationSelect');
    if (trSel?.value !== 'local') return;
    const statusEl = document.getElementById('translationStatus');
    if (!statusEl) return;
    let bar = document.getElementById('localDlBar');
    let pct = document.getElementById('localDlPercent');
    if (!bar || !pct) {
      setSafeHtml(
        statusEl,
        `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${I18N[currentUiLang].localModelDownloadingHtml || 'Downloading Hy-MT2 Q4...'} <span id="localDlPercent">${percent}%</span></div>
        <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;width:100%">
          <div id="localDlBar" style="height:100%;width:${percent}%;background:var(--accent);transition:width 0.3s;"></div>
        </div>`
      );
    } else {
      bar.style.width = percent + '%';
      pct.textContent = percent + '%';
    }
    if (percent >= 100) {
      _localDownloading = false;
      setTimeout(updateLocalModelStatus, 500);
    }
  });
}

// ── Custom Dropdown ─────────────────────────────────────────────────────
// 커스텀 셀렉트 옵션 id에 쓰는 전역 카운터 (aria-activedescendant 참조용, F3).
let _customSelectSeq = 0;

function buildCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customized) return;
  selectEl.dataset.customized = '1';

  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-wrapper';

  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('tabindex', '0');
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'listbox');

  const valueEl = document.createElement('span');
  valueEl.className = 'custom-select-value';

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('width', '12');
  chevron.setAttribute('height', '12');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('stroke-width', '2.5');
  chevron.className = 'custom-select-chevron';
  const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevPath.setAttribute('d', 'M6 9l6 6 6-6');
  chevron.appendChild(chevPath);

  trigger.appendChild(valueEl);
  trigger.appendChild(chevron);

  const dropdown = document.createElement('div');
  dropdown.className = 'custom-select-dropdown';
  dropdown.setAttribute('role', 'listbox');

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);

  // Insert wrapper before the select, move select inside wrapper, hide native
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);
  selectEl.classList.add('custom-hidden');

  function refreshOptions() {
    dropdown.replaceChildren();
    const opts = Array.from(selectEl.options);
    opts.forEach((opt) => {
      if (opt.hidden) return;
      const item = document.createElement('div');
      item.className =
        'custom-select-option' + (opt.disabled ? ' disabled' : '') + (opt.value === selectEl.value ? ' selected' : '');
      item.textContent = opt.text;
      item.dataset.value = opt.value;
      item.setAttribute('role', 'option');
      // aria-selected는 실제 선택 상태에만 부여한다 (키보드 강조와 구분 — F3).
      if (opt.value === selectEl.value) item.setAttribute('aria-selected', 'true');
      if (!opt.disabled) {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          close();
        });
      }
      dropdown.appendChild(item);
    });
    dropdown.removeAttribute('aria-activedescendant');
  }

  function updateValue() {
    const sel = selectEl.options[selectEl.selectedIndex];
    valueEl.textContent = sel ? sel.text : '';
    refreshOptions();
  }

  function open() {
    // 다른 오버레이(언어 다중 선택 패널)가 떠 있으면 함께 떠 있지 않게 닫는다.
    if (typeof closeLangPanel === 'function' && isLangPanelOpen()) closeLangPanel();
    document.querySelectorAll('.custom-select-wrapper.open').forEach((w) => {
      if (w !== wrapper) {
        if (typeof w.close === 'function') w.close();
        else w.classList.remove('open');
      }
    });
    refreshOptions();
    // Show first so scrollHeight is accurate
    dropdown.style.display = 'block';
    const rect = trigger.getBoundingClientRect();
    const dropW = Math.max(rect.width, 240);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const dropH = Math.min(dropdown.scrollHeight, 280);
    dropdown.style.width = dropW + 'px';
    // Align to the setting-card's left edge if possible
    const card = wrapper.closest('.setting-card');
    const cardRect = card ? card.getBoundingClientRect() : rect;
    const leftEdge = cardRect.left;
    dropdown.style.left = Math.min(leftEdge, window.innerWidth - dropW - 8) + 'px';
    if (spaceBelow >= dropH || spaceBelow >= spaceAbove) {
      dropdown.style.top = rect.bottom + 4 + 'px';
      dropdown.style.bottom = '';
      dropdown.style.maxHeight = Math.max(spaceBelow - 4, 120) + 'px';
    } else {
      dropdown.style.top = '';
      dropdown.style.bottom = window.innerHeight - rect.top + 4 + 'px';
      dropdown.style.maxHeight = Math.max(spaceAbove - 4, 120) + 'px';
    }
    dropdown.style.display = '';
    wrapper.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }

  function close() {
    wrapper.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }
  // 외부에서 닫을 때(openLangPanel/글로벌 mousedown) aria-expanded까지 동기화되도록 노출
  wrapper.close = close;

  // 키보드 탐색: 현재 강조/선택된 옵션 인덱스를 트래킹해 ArrowUp/Down으로 이동하고
  // Enter로 확정한다. dropdown의 옵션은 refreshOptions()에서 재생성되므로 그때 읽는다.
  function focusOptionByIndex(index) {
    const items = Array.from(dropdown.querySelectorAll('.custom-select-option:not(.disabled)'));
    if (!items.length) return;
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((it, i) => {
      it.classList.toggle('kbd-active', i === clamped);
      // aria-selected는 실제 선택에만 쓰고, 키보드 강조는 aria-activedescendant로
      // 표현한다 (화면낭독기가 '선택됨'과 '이동 중'을 구분하게 한다 — F3).
      if (i === clamped) {
        if (!it.id) it.id = `custom-select-opt-${++_customSelectSeq}`;
        dropdown.setAttribute('aria-activedescendant', it.id);
      }
    });
    // 강조 옵션이 max-height(280px) 스크롤 밖이면 보이도록 스크롤한다 (F4).
    const active = items[clamped];
    if (active) active.scrollIntoView({ block: 'nearest' });
    return clamped;
  }

  function activeOptionIndex() {
    const items = Array.from(dropdown.querySelectorAll('.custom-select-option:not(.disabled)'));
    const current = items.findIndex((it) => it.classList.contains('kbd-active'));
    return current >= 0
      ? current
      : Math.max(
          0,
          items.findIndex((it) => it.classList.contains('selected'))
        );
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectEl.disabled) return; // 싱크 우선 엔진 등으로 잠긴 select는 열지 않음
    wrapper.classList.contains('open') ? close() : open();
  });

  trigger.addEventListener('keydown', (e) => {
    if (selectEl.disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!wrapper.classList.contains('open')) {
        open();
        focusOptionByIndex(activeOptionIndex());
      } else {
        // 열린 상태에서 Enter/Space: 현재 강조된 옵션을 선택하고 닫는다.
        const active = dropdown.querySelector('.custom-select-option.kbd-active');
        if (active && !active.classList.contains('disabled')) {
          selectEl.value = active.dataset.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        close();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!wrapper.classList.contains('open')) {
        open();
        focusOptionByIndex(activeOptionIndex());
      }
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      focusOptionByIndex(activeOptionIndex() + dir);
      return;
    }
    if (e.key === 'Escape') {
      close();
    }
  });

  // Tab/blur 시 드롭다운을 닫아 키보드 포커스가 떠난 뒤에도 열린 채 남지 않게 한다.
  trigger.addEventListener('blur', () => close());

  // 카드 클릭 위임은 initCustomSelects 내 본문 delegation으로 처리함. 여기서는 cursor만 설정.
  const clickArea = wrapper.closest('#localModelGroup, .setting-card');
  if (clickArea) {
    clickArea.style.cursor = 'pointer';
  }

  // 바깥 클릭 닫기 리스너는 문서당 한 번만 등록한다 (buildCustomSelect는 모델
  // 목록 갱신마다 재호출돼 여기서 등록하면 리스너가 계속 쌓인다).
  // 열려 있는 wrapper 중 클릭 지점을 포함하지 않는 것만 닫는다.
  if (!document.body.dataset.customSelectMousedownBound) {
    document.body.dataset.customSelectMousedownBound = '1';
    document.addEventListener(
      'mousedown',
      (e) => {
        document.querySelectorAll('.custom-select-wrapper.open').forEach((w) => {
          const area = w.closest('#localModelGroup, .setting-card');
          if (!w.contains(e.target) && !(area && area.contains(e.target))) {
            if (typeof w.close === 'function') w.close();
            else w.classList.remove('open');
          }
        });
      },
      true
    );
  }

  // Sync when native select changes (e.g. from loadSavedSettings)
  selectEl.addEventListener('change', updateValue);

  // Watch for option mutations (e.g. hidden/disabled changes)
  const obs = new MutationObserver(updateValue);
  obs.observe(selectEl, { childList: true, subtree: true, attributes: true });

  updateValue();
}

function initCustomSelects() {
  document.querySelectorAll('.setting-card .setting-select').forEach(buildCustomSelect);
  const obs = new MutationObserver(() => {
    document.querySelectorAll('.setting-card .setting-select:not([data-customized])').forEach(buildCustomSelect);
  });
  obs.observe(document.querySelector('.settings-grid') || document.body, { childList: true, subtree: true });

  // 카드 전체 클릭시 dropdown trigger를 직접 호출 (이전 buildCustomSelect 안의 cardClickBoundFor 핸들러가 점유되었습니다 잘 안 동작하므로 원샷 위임하기)
  if (!document.body.dataset.cardDelegationBound) {
    document.body.dataset.cardDelegationBound = '1';
    document.body.addEventListener('click', (e) => {
      const card = e.target.closest('.setting-card, #localModelGroup');
      if (!card) return;
      // 이미 interactive 요소 클릭이면 양보
      if (e.target.closest('input, textarea, button, a, .custom-select-trigger, .custom-select-dropdown')) return;
      // 그동안 이우어서 다른 wrapper를 직접 클릭한 경우도 양보
      if (e.target.closest('.custom-select-wrapper')) return;
      const wrappers = card.querySelectorAll(':scope > .custom-select-wrapper, :scope > * > .custom-select-wrapper');
      if (wrappers.length === 1) {
        const trig = wrappers[0].querySelector('.custom-select-trigger');
        trig?.click();
      }
    });
  }
}

// Call after loadSavedSettings — fires change event so custom display syncs
function syncCustomSelects() {
  document.querySelectorAll('.setting-card .setting-select[data-customized]').forEach((sel) => {
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function initApp() {
  // 히스토리 파일 맨 먼저 로드 (시작 직후 사이드바에서 히스토리 열어도 바로 그려지도록)
  try {
    await ensureHistoryLoaded();
  } catch (error) {
    console.error('[Init] Failed to load history file:', error.message);
  }
  try {
    initUiLanguageDropdown();
  } catch (error) {
    console.error('[Init] Failed to initialize UI language dropdown:', error.message);
  }
  try {
    // 모델 상태 체크 완료 대기 (옵션이 추가되어야 설정 복원 가능)
    await checkModelStatus();
  } catch (error) {
    console.error('[Init] Failed to check model status:', error.message);
  }
  // initTranslationSelect 먼저 연결 후 설정 복원 (순서 중요)
  try {
    initTranslationSelect();
  } catch (error) {
    console.error('[Init] Failed to initialize translation select:', error.message);
  }
  // 저장된 설정 불러오기 (모델 상태 체크 완료 후)
  try {
    await loadSavedSettings();
    console.log('[Init] Settings loaded successfully');
  } catch (error) {
    console.error('[Init] Failed to load saved settings:', error.message);
  }
  // 설정 자동 저장 이벤트 리스너 연결
  try {
    initSettingsAutoSave();
  } catch (error) {
    console.error('[Init] Failed to initialize settings auto-save:', error.message);
  }
  try {
    updateQueueDisplay();
  } catch (error) {
    console.error('[Init] Failed to update queue display:', error.message);
  }
  try {
    initCustomSelects();
    syncCustomSelects();
  } catch (error) {
    console.error('[Init] Failed to initialize custom selects:', error.message);
  }
  try {
    initSettingsModal();
  } catch (error) {
    console.error('[Init] Failed to initialize settings modal:', error.message);
  }
  // API 키 상태에 따라 번역 엔진 옵션 활성화/비활성화
  try {
    updateTranslationEngineOptions();
  } catch (error) {
    console.error('[Init] Failed to update translation engine options:', error.message);
  }
  // GPU 호환성 체크 + 장치 상태 업데이트
  try {
    await checkGpuCompatibility();
  } catch (error) {
    console.error('[Init] Failed to check GPU compatibility:', error.message);
  }
  // 드래그 하이라이트 초기화
  try {
    initDragHighlight();
  } catch (error) {
    console.error('[Init] Failed to initialize drag highlight:', error.message);
  }
  // 업데이트 리스너 초기화 (main.js에서 푸시 방식)
  try {
    initUpdateListener();
  } catch (error) {
    console.error('[Init] Failed to initialize update listener:', error.message);
  }
  // 버전 배지 자동 업데이트 (package.json에서 버전 가져오기)
  try {
    initVersionBadge();
  } catch (error) {
    console.error('[Init] Failed to initialize version badge:', error.message);
  }
}

// ===== Settings Modal 초기화 =====
function initSettingsModal() {
  // 실제 설정 진입점은 사이드바 railSettingsBtn (기존 우상단 settingsBtn은
  // display:none 데드 요소여서 제거됨).
  const settingsBtn = document.getElementById('railSettingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');

  // Sound settings elements
  const soundEnabledCheckbox = document.getElementById('soundEnabledCheckbox');
  const soundVolumeSlider = document.getElementById('soundVolumeSliderModal');
  const soundVolumeValue = document.getElementById('soundVolumeValueModal');
  const soundTestBtn = document.getElementById('soundTestBtnModal');
  const soundVolumeRow = document.getElementById('soundVolumeRow');

  if (!settingsBtn || !settingsModal) return;

  // 초기 상태 설정
  soundEnabledCheckbox.checked = !soundMuted;
  soundVolumeSlider.value = Math.round(soundVolume * 100);
  soundVolumeValue.textContent = `${Math.round(soundVolume * 100)}%`;
  updateVolumeRowState();

  // 설정 모달 열기 (railSettingsBtn; 우상단 settingsBtn은 데드 요소로 제거)
  settingsBtn.addEventListener('click', () => {
    showSettingsModal();
  });

  // ========== Sidebar Rail · View Switching ==========
  function setView(view) {
    // view = 'workspace' | 'history' | 'models'
    const container = document.querySelector('.main-container');
    if (!container) return;
    if (view === 'workspace') {
      container.removeAttribute('data-view');
    } else {
      container.setAttribute('data-view', view);
      if (view === 'history') renderHistory();
      if (view === 'models') renderModels();
    }
    document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
  }
  window.setView = setView;

  document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  // railSettingsBtn의 설정 열기 리스너는 initSettingsModal 상단에서 등록됨
  // (settingsBtn 데드 요소 제거로 여기 중복 등록 제거)
  // 키보드: 1 = workspace, 2 = history, 3 = models, , = settings
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 모달이 열려 있으면 뷰 전환 단축키를 무시한다 (포커스 트랩이 우선).
    const settingsModalOpen = document.getElementById('settingsModal')?.classList.contains('active');
    if (settingsModalOpen) return;
    if (e.key === '1') setView('workspace');
    else if (e.key === '2') setView('history');
    else if (e.key === '3') setView('models');
    else if (e.key === ',') showSettingsModal();
  });

  // History clear
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      const D = I18N[currentUiLang] || I18N.ko;
      if (!confirm(D.confirmClearHistory || 'Clear all history?')) return;
      // 먼저 렌더러 측 조기 제거 (UI 즉시 반영)
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch (_e) {}
      try {
        localStorage.removeItem('wst_history');
      } catch (_e) {}
      // IPC로 LevelDB 디스크 공간 안전 회수 — 실패 시 캐시를 유지해
      // 화면만 비어 보이고 재시작 시 기록이 부활하는 상태를 방지한다
      try {
        const res = await window.electronAPI?.secureClearHistory?.();
        if (res && res.success) {
          // 캐시도 함께 비운다 (안 비우면 목록 잔존 + 다음 저장 시 복원됨)
          _historyCache = [];
          _historyLoadedOnce = true;
          renderHistory();
        } else {
          console.error('[History] secureClearHistory failed:', res);
        }
      } catch (e) {
        console.error('[History] secureClearHistory error:', e);
      }
    });
  }
  // History search
  const historySearch = document.getElementById('historySearch');
  if (historySearch) {
    historySearch.addEventListener('input', () => renderHistory(historySearch.value));
  }
  // Models refresh
  const refreshModelsBtn = document.getElementById('refreshModelsBtn');
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener('click', () => renderModels());
  }
  // 모델 저장 폴더 열기 — 수동으로 받은 모델을 어디에 넣어야 하는지 바로 보여준다.
  const openModelsFolderBtn = document.getElementById('openModelsFolderBtn');
  if (openModelsFolderBtn && window.electronAPI?.openModelsFolder) {
    openModelsFolderBtn.addEventListener('click', async () => {
      try {
        const res = await window.electronAPI.openModelsFolder();
        // 파일 관리자가 없는 환경에서는 버튼이 먹힌 것처럼 보이므로 경로라도 알린다.
        if (!res?.success && res?.path) showToast(res.path);
      } catch (e) {
        console.log('[Models] Failed to open models folder:', e.message);
      }
    });
  }

  // API/provider 입력만 저장 버튼 대상이다. 사운드·정리 토글은 즉시 저장되므로
  // 닫기 경고 대상에서 제외한다. 동적으로 추가되는 custom provider도 위임으로 잡는다.
  const markApiSettingsDirty = (event) => {
    if (
      event.target.matches(
        '.provider-panel input, .provider-panel select, .provider-panel textarea, #translationPrompt'
      )
    ) {
      _settingsApiDirty = true;
      _settingsEditRevision++;
    }
  };
  settingsModal.addEventListener('input', markApiSettingsDirty);
  settingsModal.addEventListener('change', markApiSettingsDirty);

  // 설정 모달 닫기
  closeSettingsBtn.addEventListener('click', () => {
    requestHideSettingsModal();
  });

  // 모달 열림 중 키보드: ESC 닫기 + 포커스 트랩 (Tab 순환)
  settingsModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestHideSettingsModal();
      return;
    }
    if (e.key === 'Tab') {
      // 포커스 트랩: 모달 안의 포커스 가능 요소 사이에서만 순환
      const focusables = settingsModal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // 모달 외부 클릭시 닫기
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      requestHideSettingsModal();
    }
  });

  // 알림음 토글
  soundEnabledCheckbox.addEventListener('change', () => {
    soundMuted = !soundEnabledCheckbox.checked;
    localStorage.setItem('soundMuted', soundMuted.toString());
    updateVolumeRowState();
  });

  // 볼륨 슬라이더 변경
  soundVolumeSlider.addEventListener('input', () => {
    const value = parseInt(soundVolumeSlider.value);
    soundVolume = value / 100;
    soundVolumeValue.textContent = `${value}%`;
    localStorage.setItem('soundVolume', soundVolume.toString());
  });

  // 테스트 버튼
  soundTestBtn.addEventListener('click', () => {
    // 테스트시 일시적으로 음소거 해제
    const wasMuted = soundMuted;
    soundMuted = false;
    playCompletionSound();
    soundMuted = wasMuted;
  });

  // 저장 버튼 (API 키 저장 + 설정 저장)
  saveSettingsBtn.addEventListener('click', async () => {
    const saveRevision = _settingsEditRevision;
    const saved = await saveApiKeys();
    if (!saved || saveRevision !== _settingsEditRevision) return;
    _settingsApiDirty = false;
    // 성공 메시지를 읽을 시간을 주되, 같은 세션에서 새 입력이 생기거나 모달을
    // 닫았다 다시 열었으면 이전 timer가 현재 입력을 닫지 못하게 한다.
    const savedSession = _settingsLoadToken;
    setTimeout(() => {
      const modal = document.getElementById('settingsModal');
      if (savedSession === _settingsLoadToken && !_settingsApiDirty && modal?.classList.contains('active')) {
        hideSettingsModal();
      }
    }, 1500);
  });

  // 커스텀 공급자 추가
  const addCustomProviderBtn = document.getElementById('addCustomProviderBtn');
  if (addCustomProviderBtn) {
    addCustomProviderBtn.addEventListener('click', () => {
      const current = readCustomProvidersFromUI();
      current.push({ id: `custom-${Date.now()}`, name: '', format: 'openai', baseUrl: '', apiKey: '', model: '' });
      renderCustomProviders(current);
      _settingsApiDirty = true;
      _settingsEditRevision++;
    });
  }

  // 공급자 탭 전환
  document.querySelectorAll('.provider-tab').forEach((tab) => {
    tab.addEventListener('click', () => showProviderPanel(tab.dataset.panel));
  });

  // 모델 목록 새로고침 — 공급자에게 직접 물어서 콤보박스 목록을 채운다.
  document.querySelectorAll('.model-refresh').forEach((btn) => {
    btn.addEventListener('click', () => refreshModelList(btn));
  });

  // Base URL 프리셋·모델 칸을 콤보박스로 전환 (datalist는 이 환경에서 클릭이 불안정).
  document.querySelectorAll('.provider-panel input[list]').forEach(initCombo);

  // 번역 프롬프트를 기본값으로 채우기 (비워두면 어차피 기본값이라 내용 확인용)
  const resetPromptBtn = document.getElementById('resetPromptBtn');
  if (resetPromptBtn) {
    resetPromptBtn.addEventListener('click', async () => {
      const textarea = document.getElementById('translationPrompt');
      if (!textarea || !window.electronAPI?.getProviderDefaults) return;
      try {
        const res = await window.electronAPI.getProviderDefaults();
        if (res?.success) {
          textarea.value = res.defaults.prompts.translationPrompt;
          _settingsApiDirty = true;
          _settingsEditRevision++;
        }
      } catch (error) {
        console.error('[resetPrompt] Failed:', error);
      }
    });
  }

  // 출력 정리(Output cleanup) 토글 — localStorage에 즉시 영구 저장
  const removeSpeakerTagsCheckbox = document.getElementById('removeSpeakerTagsCheckbox');
  if (removeSpeakerTagsCheckbox) {
    removeSpeakerTagsCheckbox.addEventListener('change', () => {
      localStorage.setItem('removeSpeakerTags', removeSpeakerTagsCheckbox.checked.toString());
    });
  }
  const removeSDHCheckbox = document.getElementById('removeSDHCheckbox');
  if (removeSDHCheckbox) {
    removeSDHCheckbox.addEventListener('change', () => {
      localStorage.setItem('removeSDH', removeSDHCheckbox.checked.toString());
    });
  }
  const reduceRepetitionCheckbox = document.getElementById('reduceRepetitionCheckbox');
  if (reduceRepetitionCheckbox) {
    reduceRepetitionCheckbox.addEventListener('change', () => {
      localStorage.setItem('reduceRepetition', reduceRepetitionCheckbox.checked.toString());
    });
  }
  const autoRetryCheckbox = document.getElementById('autoRetryCheckbox');
  if (autoRetryCheckbox) {
    autoRetryCheckbox.addEventListener('change', () => {
      localStorage.setItem('autoRetryFailed', autoRetryCheckbox.checked.toString());
    });
  }

  function updateVolumeRowState() {
    if (soundMuted) {
      soundVolumeRow.classList.add('disabled');
    } else {
      soundVolumeRow.classList.remove('disabled');
    }
  }
}

function setProviderSettingsLoading(loading) {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.setAttribute('aria-busy', loading ? 'true' : 'false');
  modal
    .querySelectorAll(
      '.provider-panel input, .provider-panel select, .provider-panel textarea, .provider-panel button, #translationPrompt, #saveSettingsBtn'
    )
    .forEach((element) => {
      element.disabled = loading;
    });
}

function showSettingsLoadError(error, loadToken, modal, retryLoad) {
  if (loadToken !== _settingsLoadToken || !modal?.classList.contains('active')) return;
  const status = document.getElementById('apiKeyStatus');
  if (!status) return;
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'btn-warning btn-sm';
  retryButton.textContent = (I18N[currentUiLang] || I18N.ko).btnRetry || 'Retry';
  retryButton.addEventListener('click', () => {
    if (loadToken === _settingsLoadToken && modal.classList.contains('active')) {
      showSettingsModal(retryLoad);
    }
  });
  status.className = 'api-status error';
  status.replaceChildren(document.createTextNode(`Settings load failed: ${error.message || error} `), retryButton);
  status.style.display = 'block';
}

function requestHideSettingsModal() {
  if (_settingsApiDirty) {
    const prompts = {
      ko: '저장하지 않은 API 및 공급자 설정이 있습니다. 변경사항을 버리고 닫을까요?',
      en: 'You have unsaved API and provider settings. Discard them and close?',
      ja: '保存していないAPI・プロバイダー設定があります。変更を破棄して閉じますか？',
      zh: 'API 和服务商设置尚未保存。要放弃更改并关闭吗？',
      pl: 'Masz niezapisane ustawienia API i dostawców. Odrzucić zmiany i zamknąć?',
    };
    if (!confirm(prompts[currentUiLang] || prompts.ko)) return false;
  }
  _settingsApiDirty = false;
  hideSettingsModal();
  return true;
}

function showSettingsModal(loadApiKeys = () => window.electronAPI.loadApiKeys()) {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    _settingsApiDirty = false;
    setProviderSettingsLoading(true);
    const status = document.getElementById('apiKeyStatus');
    if (status) {
      status.replaceChildren();
      status.style.display = 'none';
    }
    // 포커스 복원용: 열기 직전 활성 요소 저장
    _lastFocusedBeforeModal = document.activeElement || null;
    modal.classList.add('active');
    // 배경(앱 본문/사이드 패널)을 접근성 트리에서 제외해 모달 바깥 포커스 이동 차단
    document.querySelectorAll('.main-container, .right-panel').forEach((el) => el.setAttribute('inert', ''));
    // 모달이 열릴 때마다 현재 설정값 반영
    const soundEnabledCheckbox = document.getElementById('soundEnabledCheckbox');
    const soundVolumeSlider = document.getElementById('soundVolumeSliderModal');
    const soundVolumeValue = document.getElementById('soundVolumeValueModal');
    const soundVolumeRow = document.getElementById('soundVolumeRow');

    if (soundEnabledCheckbox) soundEnabledCheckbox.checked = !soundMuted;
    if (soundVolumeSlider) soundVolumeSlider.value = Math.round(soundVolume * 100);
    if (soundVolumeValue) soundVolumeValue.textContent = `${Math.round(soundVolume * 100)}%`;

    // 출력 정리 토글 현재값 반영
    const removeSpeakerTagsCheckbox = document.getElementById('removeSpeakerTagsCheckbox');
    if (removeSpeakerTagsCheckbox)
      removeSpeakerTagsCheckbox.checked = localStorage.getItem('removeSpeakerTags') === 'true';
    const removeSDHCheckbox = document.getElementById('removeSDHCheckbox');
    if (removeSDHCheckbox) removeSDHCheckbox.checked = localStorage.getItem('removeSDH') === 'true';
    const reduceRepetitionCheckbox = document.getElementById('reduceRepetitionCheckbox');
    if (reduceRepetitionCheckbox)
      reduceRepetitionCheckbox.checked = localStorage.getItem('reduceRepetition') !== 'false';
    updateSyncModelUI();
    const autoRetryCheckbox = document.getElementById('autoRetryCheckbox');
    if (autoRetryCheckbox) autoRetryCheckbox.checked = localStorage.getItem('autoRetryFailed') === 'true';
    if (soundVolumeRow) {
      if (soundMuted) {
        soundVolumeRow.classList.add('disabled');
      } else {
        soundVolumeRow.classList.remove('disabled');
      }
    }
    // 포커스를 모달 안으로 이동 (키보드 사용자가 모달 밖에 계속 있지 않게)
    const closeBtn = document.getElementById('closeSettingsBtn');
    const firstFocusable = settingsModal.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const target = closeBtn || firstFocusable;
    if (target && typeof target.focus === 'function') {
      try {
        target.focus();
      } catch (_e) {}
    }
    // 히스토리 토글 반영
    const historyChk = document.getElementById('historyEnabledCheckbox');
    if (historyChk) {
      historyChk.checked = isHistoryEnabled();
      if (!historyChk._wstBound) {
        historyChk._wstBound = true;
        historyChk.addEventListener('change', () => {
          setHistoryEnabled(historyChk.checked);
        });
      }
    }
  }
  // API 키 · 공급자 설정 로드. 입력은 로드가 끝날 때까지만 잠가 늦게 도착한
  // IPC 응답이 사용자가 먼저 입력한 값을 덮어쓰는 경쟁을 없앤다.
  const loadToken = ++_settingsLoadToken;
  try {
    loadApiKeys()
      .then(async (res) => {
        if (loadToken !== _settingsLoadToken || !modal?.classList.contains('active')) return;
        if (res && res.success && res.keys) {
          cachedApiConfig = res.keys;
          // 기본 프롬프트를 미리 받아 둔다 — 저장 시 기본값과 같으면 비워 저장해 향후 기본값 개선을 따라가게 한다.
          try {
            const defaultsRes = await window.electronAPI.getProviderDefaults();
            if (defaultsRes?.success) {
              cachedDefaultPrompt = defaultsRes.defaults.prompts.translationPrompt;
              cachedModelPresets = defaultsRes.defaults.modelPresets || {};
            }
          } catch (_) {}
          if (loadToken !== _settingsLoadToken || !modal?.classList.contains('active')) return;
          const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
          };
          setValue('deeplApiKey', res.keys.deepl);
          setValue('openaiApiKey', res.keys.openai);
          setValue('openaiModel', res.keys.openaiModel);

          setValue('openaiBaseUrl', res.keys.openaiBaseUrl);
          setValue('geminiApiKey', res.keys.gemini);
          setValue('geminiModel', res.keys.geminiModel);
          setValue('geminiBaseUrl', res.keys.geminiBaseUrl);
          setValue('claudeApiKey', res.keys.claude);
          setValue('claudeModel', res.keys.claudeModel);
          setValue('claudeBaseUrl', res.keys.claudeBaseUrl);
          // 저장된 값이 없으면 기본 프롬프트를 보여 준다 (적용은 동일).
          setValue('translationPrompt', res.keys.translationPrompt || cachedDefaultPrompt);
          renderCustomProviders(res.keys.customProviders || []);
          updateProviderTabBadges();
          // 알려진 모델 목록을 채워 키 없이도 드롭다운에서 고를 수 있게 한다.
          fillModelPresets();
          setProviderSettingsLoading(false);
        } else {
          throw new Error(res?.error || 'Settings load returned no configuration');
        }
      })
      .catch((error) => {
        console.error('[Settings] Failed to load API settings:', error);
        showSettingsLoadError(error, loadToken, modal, loadApiKeys);
      });
  } catch (error) {
    console.error('[Settings] Failed to start API settings load:', error);
    showSettingsLoadError(error, loadToken, modal, loadApiKeys);
  }
}

function hideSettingsModal() {
  const modal = document.getElementById('settingsModal');
  _settingsLoadToken++;
  closeAllCombos();
  setProviderSettingsLoading(false);
  if (modal) {
    modal.classList.remove('active');
    // 모달 닫히면 배경 다시 접근 가능하게
    document.querySelectorAll('.main-container, .right-panel').forEach((el) => el.removeAttribute('inert'));
    // 모달을 열었던 요소로 포커스 복원 (키보드 사용자 컨텍스트 유지)
    const prev = _lastFocusedBeforeModal;
    _lastFocusedBeforeModal = null;
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch (_e) {}
    }
    // 상태 메시지 초기화
    const status = document.getElementById('apiKeyStatus');
    if (status) status.style.display = 'none';
  }
}

// initApp은 첫 번째 DOMContentLoaded에서 호출됨

// 오디오 data URL 캐시 (한 번만 로드)
let cachedAudioDataUrl = null;

async function playCompletionSound() {
  console.log('[Audio] playCompletionSound called, muted:', soundMuted, 'volume:', soundVolume);

  // 음소거 상태면 재생 안 함
  if (soundMuted || soundVolume <= 0) {
    console.log('[Audio] Skipping: muted or volume is 0');
    return;
  }

  try {
    // base64 data URL 가져오기 (캐시 사용)
    if (!cachedAudioDataUrl) {
      console.log('[Audio] Fetching audio data from main process...');
      cachedAudioDataUrl = await window.electronAPI.getAudioData('nya.wav');
      console.log('[Audio] Got audio data:', cachedAudioDataUrl ? `${cachedAudioDataUrl.length} chars` : 'null');
    }

    if (cachedAudioDataUrl) {
      console.log('[Audio] Playing nya.wav via data URL');
      const audio = new Audio(cachedAudioDataUrl);
      audio.volume = soundVolume;

      // data URL은 즉시 로드되므로 canplaythrough를 무한정 기다리지 않는다.
      // (일부 Electron/Chromium에서 data URL의 canplaythrough가 안 떠 await가 멈추면
      //  소리가 영영 안 났다.) 준비되면 바로, 안 떠도 최대 300ms 후 그냥 재생한다.
      await new Promise((resolve) => {
        let done = false;
        const go = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        audio.oncanplaythrough = go;
        audio.onerror = go; // 에러여도 play()를 시도(아래서 잡힘)
        if (audio.readyState >= 3) go();
        setTimeout(go, 300);
        audio.load();
      });

      await audio.play();
      console.log('[Audio] nya.wav played successfully');
      return;
    } else {
      console.warn('[Audio] No audio data available, using fallback');
    }
  } catch (error) {
    console.warn('[Audio] WAV file failed:', error.message);
    // packaged build has devTools off, so surface the reason in the on-screen log too.
    try {
      if (typeof addOutput === 'function') addOutput(`[sound] completion sound failed: ${error.message}\n`);
    } catch (_) {}
    // fallback: short 3-note WebAudio beep
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    // long-running/backgrounded jobs can leave the context suspended; resume first.
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (_) {}
    }
    const now = ctx.currentTime;
    const sequence = [
      { freq: 880, dur: 0.12 },
      { freq: 1320, dur: 0.12 },
      { freq: 1760, dur: 0.18 },
    ];
    let t = now;
    const volumeMultiplier = soundVolume * 0.25; // WebAudio는 더 조용하게
    sequence.forEach(({ freq, dur }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volumeMultiplier, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur + 0.03;
    });
  } catch (_) {
    /* ignore */
  }
}

// ===== 드래그 영역 시각적 피드백 개선 =====
function initDragHighlight() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  let dragCounter = 0;

  dropZone.addEventListener('dragenter', (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dropZone.classList.remove('drag-active');
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
  });

  dropZone.addEventListener('drop', (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-active');
  });
}

// ===== API 키 검증 및 저장 =====
// 모델 목록에 없는 이름을 넣으면 경고 — 직접 입력은 막지 않지만 오타를 알려 준다.
// 목록을 아직 한 번도 불러오지 않았으면(빈 목록) 검증하지 않는다.
document.addEventListener('input', (event) => {
  const input = event.target;
  if (input.tagName !== 'INPUT' || input.dataset.combo !== '1') return;
  const menu = comboMenuOf(input);
  if (!menu || menu.children.length === 0) return;

  const value = input.value.trim();
  const known = Array.from(menu.children).some((item) => item.textContent === value);
  let warning = input.parentElement.querySelector('.model-warning');
  if (!warning) {
    warning = document.createElement('div');
    warning.className = 'model-warning';
    input.parentElement.appendChild(warning);
  }
  warning.textContent = known ? '' : I18N[currentUiLang]?.modelNotInList || '모델 목록에 없는 이름입니다.';
});

// ===== 콤보박스 — datalist는 이 Electron/WSLg 환경에서 화살표 클릭이 불안정해,
// input + ▾ 버튼 + 팝업 목록을 직접 만든다. 목록에서 고르거나 직접 타이핑 둘 다 가능.
function comboMenuOf(input) {
  return input?.parentElement?.querySelector('.combo-menu') || null;
}

function addComboOption(menu, value, input) {
  const item = document.createElement('div');
  item.className = 'combo-item';
  item.textContent = value;
  // 항목 클릭 시 label의 기본 동작(연결된 input으로 포커스 이동) 때문에
  // focus 핸들러가 메뉴를 다시 여는 것을 막는다.
  item.addEventListener('mousedown', (event) => event.preventDefault());
  item.addEventListener('click', (event) => {
    event.preventDefault();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    menu.hidden = true;
  });
  menu.appendChild(item);
}

function fillComboEmpty(menu) {
  // 목록이 비어 있으면 ↻ 버튼으로 불러오라는 안내만 보여준다.
  if (menu.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'combo-empty';
    empty.textContent = I18N[currentUiLang]?.comboEmptyHint || '목록이 비어 있습니다. ↻ 버튼으로 불러오세요.';
    menu.appendChild(empty);
  }
}

function closeAllCombos() {
  document.querySelectorAll('.combo-menu:not([hidden])').forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll('.modal-body.combo-open').forEach((body) => body.classList.remove('combo-open'));
}

// 드롭다운을 열 때 최신 모델 목록을 자동으로 불러온다.
// 키가 있으면 API 목록으로 교체되고, 없으면(또는 실패하면) 알려진 프리셋이 유지된다.
// 콤보 메뉴를 열기 전에 viewport 좌표로 배치한다. 모달 스크롤 영역 밖의 필드에서 열어도
// 화면 안에 보이도록 fixed로 붙이고, 남은 공간에 따라 아래/위로 펼친다.
function positionComboMenu(menu) {
  const wrap = menu.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const spaceBelow = viewportH - wrapRect.bottom;
  const spaceAbove = wrapRect.top;

  menu.style.position = 'fixed';
  menu.style.left = wrapRect.left + 'px';
  menu.style.width = wrapRect.width + 'px';
  if (spaceBelow < 220 && spaceAbove > spaceBelow) {
    menu.style.top = 'auto';
    menu.style.bottom = viewportH - wrapRect.top + 'px'; // 위로 펼침
    menu.style.maxHeight = Math.max(80, Math.min(220, spaceAbove - 8)) + 'px';
  } else {
    menu.style.top = wrapRect.bottom + 'px';
    menu.style.bottom = 'auto';
    menu.style.maxHeight = Math.max(80, Math.min(220, spaceBelow - 8)) + 'px';
  }
  menu.closest('.modal-body')?.classList.add('combo-open');
  menu.hidden = false;
}

function autoLoadModels(wrap) {
  const refresh = wrap.querySelector('.model-refresh');
  if (!refresh) return;
  refreshModelList(refresh, { quiet: true });
}

// 알려진 모델 프리셋을 빈 모델 콤보에 채운다. 키가 등록되면 API 조회 결과로 대체된다.
function fillModelPresets() {
  const map = { openaiModel: 'openai', geminiModel: 'gemini', claudeModel: 'claude' };
  Object.entries(map).forEach(([inputId, providerName]) => {
    const input = document.getElementById(inputId);
    const menu = comboMenuOf(input);
    const presets = cachedModelPresets[providerName] || [];
    if (!menu || menu.querySelector('.combo-item') || presets.length === 0) return;
    presets.forEach((model) => addComboOption(menu, model, input));
  });
}

function initCombo(input) {
  if (!input || input.dataset.combo === '1') return;
  input.dataset.combo = '1';

  // 기존 datalist 옵션을 팝업 목록으로 옮긴다.
  const listId = input.getAttribute('list');
  const datalist = listId ? document.getElementById(listId) : null;
  const options = datalist ? Array.from(datalist.options).map((option) => option.value) : [];

  const menu = document.createElement('div');
  menu.className = 'combo-menu';
  menu.hidden = true;
  options.forEach((value) => addComboOption(menu, value, input));

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  btn.textContent = '▾';
  btn.title = I18N[currentUiLang]?.comboSelectTitle || '목록에서 선택';

  const wrap = input.parentElement;
  // ↻ 새로고침 버튼이 함께 있으면 그 앞에, 아니면 input 바로 뒤에 붙인다.
  const refresh = wrap.querySelector('.model-refresh');
  if (refresh) {
    wrap.insertBefore(btn, refresh);
  } else {
    wrap.appendChild(btn);
  }
  wrap.appendChild(menu);

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    closeAllCombos();
    if (open) {
      fillComboEmpty(menu);
      positionComboMenu(menu);
      autoLoadModels(wrap);
    }
  });

  // 목록이 길 때 마우스 휠로 스크롤할 수 있게 한다 (WSLg에서 기본 휠 전달이 불안정한 폴백).
  menu.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.scrollHeight > menu.clientHeight) menu.scrollTop += event.deltaY;
    },
    { passive: false }
  );

  input.addEventListener('focus', () => {
    closeAllCombos();
    fillComboEmpty(menu);
    positionComboMenu(menu);
    autoLoadModels(wrap);
  });

  // 바깥을 클릭하면 닫는다.
  input.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeAllCombos);

  if (datalist) {
    input.removeAttribute('list');
    datalist.remove();
  }
}

// Electron/WSLg에서 마우스 휠이 모달 본문 스크롤로 전달되지 않는 경우가 있어
// 수동으로 scrollTop을 조정하는 폴백을 단다. 스크롤바 드래그는 기존대로 동작한다.
document.querySelectorAll('.modal-body').forEach((body) => {
  body.addEventListener(
    'wheel',
    (event) => {
      if (body.scrollHeight <= body.clientHeight) return;
      event.preventDefault();
      body.scrollTop += event.deltaY;
    },
    { passive: false }
  );
});

// ===== 공급자 설정 패널 =====
// 탭 하나만 보여주어 공급자가 늘어도 설정 화면이 길어지지 않게 한다.
function showProviderPanel(name) {
  document.querySelectorAll('.provider-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === name);
  });
  document.querySelectorAll('.provider-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

// 키가 채워진 공급자 탭에 점을 찍는다 — 탭을 일일이 열어보지 않아도 어디가 설정됐는지 보이도록.
function updateProviderTabBadges() {
  const filled = (id) => !!document.getElementById(id)?.value?.trim();
  const state = {
    deepl: filled('deeplApiKey'),
    openai: filled('openaiApiKey'),
    gemini: filled('geminiApiKey'),
    claude: filled('claudeApiKey'),
    custom: readCustomProvidersFromUI().some((provider) => provider.apiKey),
  };
  document.querySelectorAll('.provider-tab').forEach((tab) => {
    if (state[tab.dataset.panel]) tab.dataset.configured = '1';
    else delete tab.dataset.configured;
  });
}

// 설정 화면에 지금 입력된 공급자 값들. 저장·연결 테스트·모델 조회가 같은 걸 쓴다.
function collectApiConfigFromUI() {
  const readValue = (id) => (document.getElementById(id)?.value || '').trim();
  return {
    deepl: readValue('deeplApiKey'),
    openai: readValue('openaiApiKey'),
    openaiModel: readValue('openaiModel'),

    openaiBaseUrl: readValue('openaiBaseUrl'),
    gemini: readValue('geminiApiKey'),
    geminiModel: readValue('geminiModel'),
    geminiBaseUrl: readValue('geminiBaseUrl'),
    claude: readValue('claudeApiKey'),
    claudeModel: readValue('claudeModel'),
    claudeBaseUrl: readValue('claudeBaseUrl'),
    // 기본 프롬프트 그대로면 비워 저장 — 나중에 기본값이 개선되면 계속 따라간다.
    translationPrompt: (() => {
      const value = document.getElementById('translationPrompt')?.value || '';
      return value === cachedDefaultPrompt ? '' : value;
    })(),
    customProviders: readCustomProvidersFromUI(),
  };
}

// 공급자의 models API를 불러 datalist를 채운다. 목록을 코드에 박지 않아야 신규 모델이 바로 따라온다.
// 공급자의 models API를 불러 콤보박스 목록을 채운다. 목록을 코드에 박지 않아야 신규 모델이 바로 따라온다.
async function refreshModelList(btn, { quiet } = {}) {
  const input = document.getElementById(btn.dataset.target);
  const menu = comboMenuOf(input);
  const status = document.getElementById('apiKeyStatus');
  const d = I18N[currentUiLang] || I18N.ko;
  if (!menu || !window.electronAPI?.listProviderModels) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⋯';
  // 조회 전 목록(프리셋)을 백업해, 실패하면 그대로 복원한다.
  const previousItems = [...menu.children].map((item) => item.textContent);
  try {
    const res = await window.electronAPI.listProviderModels({
      method: btn.dataset.method,
      tempKeys: collectApiConfigFromUI(),
    });
    if (!res?.success) throw new Error(res?.error || 'failed');

    menu.replaceChildren();
    res.models.forEach((model) => addComboOption(menu, model, input));
    showToast(`${res.models.length}${d.modelsLoadedSuffix || '개 모델을 불러왔습니다.'}`);
  } catch (error) {
    console.error('[refreshModelList] Failed:', error);
    // 실패하면 기존 목록(알려진 모델 프리셋)을 복원해 선택지를 잃지 않게 한다.
    menu.replaceChildren();
    previousItems.forEach((model) => addComboOption(menu, model, input));
    // 사용자가 ↻를 직접 누르고, 키 부족이 아닌 경우에만 상단 상태에 사유를 표시한다.
    if (!quiet && status && !/api key|not configured/i.test(error.message)) {
      status.style.display = 'block';
      status.style.background = '#f8d7da';
      status.style.border = '1px solid #f5c6cb';
      status.style.color = '#721c24';
      status.textContent = `${d.modelsLoadFailed || '모델 목록을 불러오지 못했습니다'}: ${error.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ===== 커스텀 공급자 카드 =====
// OpenAI 호환 서버(DeepSeek · OpenRouter · Groq · Ollama 등)는 openai 형식으로 그대로 붙는다.
function createCustomProviderCard(provider) {
  const d = I18N[currentUiLang] || I18N.ko;
  const card = document.createElement('div');
  card.className = 'custom-provider-card';
  card.dataset.providerId = provider.id;

  const header = document.createElement('div');
  header.className = 'custom-provider-card-header';
  const title = document.createElement('span');
  title.className = 'custom-provider-card-title';
  title.textContent = provider.name || d.customProviderNewLabel || '새 공급자';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'custom-provider-remove';
  removeBtn.textContent = d.customProviderRemoveBtn || '삭제';
  removeBtn.addEventListener('click', () => {
    renderCustomProviders(readCustomProvidersFromUI().filter((item) => item.id !== provider.id));
    _settingsApiDirty = true;
    _settingsEditRevision++;
  });
  header.append(title, removeBtn);

  const grid = document.createElement('div');
  grid.className = 'provider-grid';

  // 카드마다 조회 결과를 담을 datalist가 따로 필요하다.
  const modelListId = `customModelList-${provider.id}`;
  const modelList = document.createElement('datalist');
  modelList.id = modelListId;

  const addField = (field, labelText, value, options = {}) => {
    const wrap = document.createElement('label');
    wrap.className = options.wide ? 'provider-field provider-field-wide' : 'provider-field';
    const label = document.createElement('span');
    label.className = 'provider-field-label';
    label.textContent = labelText;

    let input;
    if (options.list) {
      // Base URL 프리셋·모델 조회 결과를 고를 수 있게 하되 직접 입력도 막지 않는다.
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-input';
      input.id = `${options.list || 'combo'}-${provider.id}`;
      input.value = value || '';
      input.setAttribute('list', options.list);
      if (options.placeholder) input.placeholder = options.placeholder;
    } else if (options.choices) {
      input = document.createElement('select');
      input.className = 'form-input';
      options.choices.forEach((choice) => {
        const opt = document.createElement('option');
        opt.value = choice;
        opt.textContent = choice;
        input.appendChild(opt);
      });
      input.value = value || options.choices[0];
    } else if (options.multiline) {
      input = document.createElement('textarea');
      input.className = 'form-input form-textarea';
      input.rows = 4;
      input.value = value || '';
    } else {
      input = document.createElement('input');
      input.type = options.password ? 'password' : 'text';
      input.className = 'form-input';
      input.value = value || '';
      if (options.placeholder) input.placeholder = options.placeholder;
    }
    input.spellcheck = false;
    input.dataset.field = field;
    if (field === 'name') {
      input.addEventListener('input', () => {
        title.textContent = input.value || d.customProviderNewLabel || '새 공급자';
      });
    }

    wrap.append(label);
    if (options.refreshMethod) {
      // 모델 칸은 입력기 옆에 조회 버튼을 붙인다.
      const row = document.createElement('div');
      row.className = 'input-with-refresh';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'model-refresh';
      refresh.textContent = '↻';
      refresh.title = d.modelRefreshTitle || '모델 목록 불러오기';
      refresh.dataset.method = options.refreshMethod;
      refresh.dataset.list = options.list;
      refresh.dataset.target = input.id || '';
      refresh.addEventListener('click', () => refreshModelList(refresh));
      row.append(input, refresh);
      wrap.append(row);
    } else {
      wrap.append(input);
    }
    grid.appendChild(wrap);
  };

  addField('name', d.customProviderNameLabel || '이름', provider.name, { placeholder: 'OpenRouter' });
  addField('format', d.customProviderFormatLabel || 'API 형식', provider.format, {
    choices: ['openai', 'anthropic', 'gemini'],
  });
  addField('baseUrl', d.customProviderBaseUrlLabel || 'Base URL', provider.baseUrl, {
    wide: true,
    placeholder: 'https://openrouter.ai/api/v1',
  });
  addField('apiKey', d.customProviderApiKeyLabel || 'API Key', provider.apiKey, { password: true });
  addField('model', d.customProviderModelLabel || '모델', provider.model, {
    placeholder: 'deepseek/deepseek-v3',
    list: modelListId,
    refreshMethod: `custom:${provider.id}`,
  });
  addField('prompt', d.customProviderPromptLabel || '프롬프트 (선택)', provider.prompt, {
    wide: true,
    multiline: true,
  });

  card.append(header, grid, modelList);
  return card;
}

function renderCustomProviders(list) {
  const container = document.getElementById('customProviderList');
  if (!container) return;
  container.replaceChildren();

  if (!Array.isArray(list) || list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'custom-provider-empty';
    const d = I18N[currentUiLang] || I18N.ko;
    empty.textContent = d.customProvidersEmpty || '등록된 커스텀 공급자가 없습니다.';
    container.appendChild(empty);
    return;
  }

  list.forEach((provider) => {
    const card = createCustomProviderCard(provider);
    container.appendChild(card);
    card.querySelectorAll('input[list]').forEach(initCombo);
  });
}

function readCustomProvidersFromUI() {
  const container = document.getElementById('customProviderList');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.custom-provider-card'))
    .map((card) => {
      const read = (field) => card.querySelector(`[data-field="${field}"]`)?.value || '';
      return {
        id: card.dataset.providerId,
        name: read('name').trim(),
        format: read('format'),
        baseUrl: read('baseUrl').trim(),
        apiKey: read('apiKey').trim(),
        model: read('model').trim(),
        prompt: read('prompt'),
      };
    })
    .filter((provider) => provider.name || provider.baseUrl);
}

// 번역 방식 표시명 — 모델명이 설정에서 바뀌므로 저장된 값을 따른다.
function getTranslationLabel(method) {
  const keys = cachedApiConfig || {};
  const withModel = (name, model) => (model ? `${name} ${model}` : name);

  switch (method) {
    case 'mymemory':
      return 'MyMemory';
    case 'deepl':
      return 'DeepL';
    case 'chatgpt':
      return withModel('OpenAI', keys.openaiModel);
    case 'gemini':
      return withModel('Gemini', keys.geminiModel);
    case 'claude':
      return withModel('Claude', keys.claudeModel);
    case 'local':
      return 'Hy-MT2 Local';
    default: {
      if (typeof method === 'string' && method.startsWith('custom:')) {
        const custom = (keys.customProviders || []).find((provider) => `custom:${provider.id}` === method);
        if (custom) return withModel(custom.name, custom.model);
      }
      return method;
    }
  }
}

async function saveApiKeys() {
  const status = document.getElementById('apiKeyStatus');

  // API 키 · 공급자 설정
  const keys = collectApiConfigFromUI();

  // 앱 설정도 함께 저장
  const modelSelect = document.getElementById('modelSelect');
  const languageSelect = document.getElementById('languageSelect');
  const deviceSelect = document.getElementById('deviceSelect');
  const translationSelect = document.getElementById('translationSelect');
  const uiLanguageSelect = document.getElementById('uiLanguageSelect');

  if (modelSelect) keys.selectedModel = modelSelect.value;
  if (languageSelect) keys.selectedLanguage = languageSelect.value;
  if (deviceSelect) keys.selectedDevice = deviceSelect.value;
  if (translationSelect) keys.selectedTranslation = translationSelect.value;
  if (uiLanguageSelect) keys.uiLanguage = uiLanguageSelect.value;

  const successMsg = {
    ko: '설정이 저장되었습니다.',
    en: 'Settings saved.',
    ja: '設定が保存されました。',
    zh: '设置已保存。',
    pl: 'Ustawienia zapisane.',
  };
  const failMsg = {
    ko: '저장 실패',
    en: 'Save failed',
    ja: '保存に失敗しました',
    zh: '保存失败',
    pl: 'Zapis nie powiódł się',
  };
  const errorMsg = {
    ko: '오류',
    en: 'Error',
    ja: 'エラー',
    zh: '错误',
    pl: 'Błąd',
  };

  let saved = false;
  try {
    const res = await window.electronAPI.saveApiKeys(keys);
    saved = !!(res && res.success);
    if (status) {
      if (saved) {
        status.className = 'api-status success';
        status.textContent = successMsg[currentUiLang] || successMsg.ko;
        if (res.insecure) {
          // safeStorage/OS 키링 부재로 AES 폴백 저장됨 — 하드코딩 키라 노출 가능
          showToast(I18N[currentUiLang].insecureStorageWarning || I18N.en.insecureStorageWarning);
        }
      } else {
        status.className = 'api-status error';
        status.textContent = failMsg[currentUiLang] || failMsg.ko;
      }
    }
  } catch (e) {
    if (status) {
      status.className = 'api-status error';
      status.textContent = `${errorMsg[currentUiLang] || errorMsg.ko}: ${e.message || e}`;
    }
  }
  // 설정 저장 후 번역 엔진 옵션 상태 업데이트
  updateProviderTabBadges();
  await updateTranslationEngineOptions();
  return saved;
}

// ===== 번역 엔진 옵션 상태 업데이트 (API 키 없으면 비활성화) =====
async function updateTranslationEngineOptions() {
  const translationSelect = document.getElementById('translationSelect');
  if (!translationSelect) return false;

  try {
    const res = await window.electronAPI.loadApiKeys();
    const keys = res?.success ? res.keys : {};
    cachedApiConfig = keys;
    // 설정을 받은 뒤 내장 옵션 라벨을 다시 그려 현재 모델명이 보이게 한다.
    rebuildTranslationSelectOptions(currentUiLang);

    // 커스텀 공급자 옵션을 설정 기준으로 다시 그린다 (내장 옵션은 index.html에 고정).
    // 선택 중인 옵션을 지웠다가 다시 만들면 선택이 풀리므로, 미리 기억해 두었다가 복원한다.
    const previousMethod = translationSelect.value;
    const customProviders = (keys.customProviders || []).filter((provider) => provider.baseUrl && provider.model);
    translationSelect.querySelectorAll('option[data-custom="1"]').forEach((option) => option.remove());
    customProviders.forEach((provider) => {
      const option = document.createElement('option');
      option.value = `custom:${provider.id}`;
      option.textContent = provider.name;
      option.dataset.custom = '1';
      translationSelect.appendChild(option);
    });
    // 커스텀 옵션은 이 함수에서 뒤늦게 붙는다. 그래서 설정을 불러올 때는 목록에 없어
    // 저장된 커스텀 선택이 복원되지 못하고, 그 상태로 자동 저장되면 선택이 사라진다.
    // 옵션을 다시 만든 지금 저장값을 기준으로 되살린다.
    const desiredMethod =
      previousMethod === 'none' && keys.selectedTranslation ? keys.selectedTranslation : previousMethod;
    if (desiredMethod && Array.from(translationSelect.options).some((option) => option.value === desiredMethod)) {
      const changed = translationSelect.value !== desiredMethod;
      translationSelect.value = desiredMethod;
      if (changed) translationSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const hasOpenAI = !!keys?.openai?.trim();
    const requirements = {
      deepl: !!keys?.deepl?.trim(),
      chatgpt: hasOpenAI,

      gemini: !!keys?.gemini?.trim(),
      claude: !!keys?.claude?.trim(),
    };
    customProviders.forEach((provider) => {
      requirements[`custom:${provider.id}`] = !!provider.apiKey;
    });
    let autoSwitched = false;
    Array.from(translationSelect.options).forEach((option) => {
      if (option.value in requirements) {
        const ok = requirements[option.value];
        option.disabled = !ok;
        if (!ok && option.selected) {
          translationSelect.value = 'none';
          translationSelect.dispatchEvent(new Event('change'));
          autoSwitched = true;
        }
      }
    });
    if (autoSwitched) {
      const d = I18N[currentUiLang] || I18N.ko;
      showToast(d.apiKeyMissingFallback || 'API key missing, switched to "No translation"');
    }
    return autoSwitched;
  } catch (error) {
    console.error('[updateTranslationEngineOptions] Error:', error);
    const requiresStoredConfig =
      ['deepl', 'chatgpt', 'gemini', 'claude'].includes(translationSelect.value) ||
      translationSelect.value.startsWith('custom:');
    if (requiresStoredConfig) {
      translationSelect.value = 'none';
      translationSelect.dispatchEvent(new Event('change'));
      const d = I18N[currentUiLang] || I18N.ko;
      showToast(d.apiKeyMissingFallback || 'API key missing, switched to "No translation"');
      return true;
    }
    return false;
  }
}

async function testApiKeys() {
  const status = document.getElementById('apiKeyStatus');

  // Checking message (확인 중 메시지)
  const checkingMsg = {
    ko: '잠시만요, 키 확인하고 있어요...',
    en: 'Hold on, checking your keys...',
    ja: 'ちょっと待って、キーを確認中...',
    zh: '稍等，正在验证密钥...',
    pl: 'Chwilę, sprawdzam klucze...',
  };

  if (status) {
    status.style.display = 'block';
    status.style.background = '#fff3cd';
    status.style.border = '1px solid #ffeeba';
    status.style.color = '#856404';
    status.textContent = checkingMsg[currentUiLang] || checkingMsg.ko;
  }

  try {
    // 현재 입력된 키들 수집 — 저장 전이라도 모델·Base URL까지 같이 보내야 설정대로 검증된다.
    const config = collectApiConfigFromUI();
    const deeplKey = config.deepl;
    const openaiKey = config.openai;
    const geminiKey = config.gemini;
    const claudeKey = config.claude;
    const customProviders = config.customProviders.filter((provider) => provider.apiKey);

    // 키를 안 넣은 공급자는 검증 대상에서 뺀다.
    const tempKeys = {};
    if (customProviders.length) tempKeys.customProviders = customProviders;
    if (deeplKey) tempKeys.deepl = deeplKey;
    if (openaiKey) {
      tempKeys.openai = openaiKey;
      tempKeys.openaiModel = config.openaiModel;
      tempKeys.openaiBaseUrl = config.openaiBaseUrl;
    }
    if (geminiKey) {
      tempKeys.gemini = geminiKey;
      tempKeys.geminiModel = config.geminiModel;
      tempKeys.geminiBaseUrl = config.geminiBaseUrl;
    }
    if (claudeKey) {
      tempKeys.claude = claudeKey;
      tempKeys.claudeModel = config.claudeModel;
      tempKeys.claudeBaseUrl = config.claudeBaseUrl;
    }

    console.log('[Frontend] Collected temp keys:', {
      hasDeepL: !!deeplKey,
      hasOpenAI: !!openaiKey,
      hasGemini: !!geminiKey,
      hasClaude: !!claudeKey,
      customProviders: customProviders.length,
      keysToTest: Object.keys(tempKeys),
    });

    // 입력된 키가 없으면 안내 메시지
    if (Object.keys(tempKeys).length === 0) {
      if (status) {
        status.style.display = 'block';
        status.style.background = '#fff3cd';
        status.style.border = '1px solid #ffeeba';
        status.style.color = '#856404';
        const noKeyMessage = {
          ko: '테스트할 키가 없네요. 먼저 입력해주세요!',
          en: 'No keys to test. Enter one first!',
          ja: 'テストするキーがないよ。先に入力して！',
          zh: '没有可测试的密钥，先输入一个吧！',
          pl: 'Brak kluczy do przetestowania. Wprowadź najpierw klucz!',
        };
        status.textContent = noKeyMessage[currentUiLang] || noKeyMessage.ko;
      }
      return;
    }

    const res = await window.electronAPI.validateApiKeys(tempKeys);
    if (!res || !res.success) throw new Error(res?.error || 'Validation failed');
    const { results } = res;

    // Success/Failure messages (성공/실패 메시지)
    const successMsg = {
      ko: 'OK',
      en: 'OK',
      ja: 'OK',
      zh: 'OK',
      pl: 'OK',
    };

    const failMsg = {
      ko: '실패',
      en: 'Failed',
      ja: '失敗',
      zh: '失败',
      pl: 'Failed',
    };

    // 키를 입력한 공급자만 결과를 보여준다. 라벨은 지금 입력된 모델명 기준.
    const withModel = (name, model) => (model ? `${name} ${model}` : name);
    const checks = [
      { label: 'DeepL', ok: results?.deepl === true, entered: !!deeplKey },
      {
        label: withModel('OpenAI', tempKeys.openaiModel),
        ok: results?.openai === true,
        entered: !!openaiKey,
      },
      {
        label: withModel('Gemini', tempKeys.geminiModel),
        ok: results?.gemini === true,
        entered: !!geminiKey,
      },
      {
        label: withModel('Claude', tempKeys.claudeModel),
        ok: results?.claude === true,
        entered: !!claudeKey,
      },
      ...customProviders.map((provider) => ({
        label: withModel(provider.name || provider.id, provider.model),
        ok: results?.custom?.[provider.id] === true,
        entered: true,
      })),
    ].filter((check) => check.entered);

    const messages = checks.map((check) =>
      check.ok ? `✓ ${check.label} ${successMsg[currentUiLang]}` : `✗ ${check.label} ${failMsg[currentUiLang]}`
    );
    const totalCount = checks.length;
    const successCount = checks.filter((check) => check.ok).length;

    if (status && messages.length > 0) {
      // All success: green, All fail: red, Mixed: yellow
      const allSuccess = successCount === totalCount;
      const allFail = successCount === 0;

      status.style.display = 'block';
      if (allSuccess) {
        status.style.background = '#d4edda';
        status.style.border = '1px solid #c3e6cb';
        status.style.color = '#155724';
      } else if (allFail) {
        status.style.background = '#f8d7da';
        status.style.border = '1px solid #f5c6cb';
        status.style.color = '#721c24';
      } else {
        // Mixed results - yellow
        status.style.background = '#fff3cd';
        status.style.border = '1px solid #ffeeba';
        status.style.color = '#856404';
      }
      setSafeHtml(status, messages.join('<br>'));
    } else if (status) {
      const pleaseEnterMsg = {
        ko: '키 먼저 입력!',
        en: 'Enter a key first!',
        ja: 'キーを入力して！',
        zh: '先输入密钥！',
        pl: 'Wprowadź najpierw klucz!',
      };
      status.style.display = 'block';
      status.style.background = '#fff3cd';
      status.style.border = '1px solid #ffeeba';
      status.style.color = '#856404';
      status.textContent = pleaseEnterMsg[currentUiLang] || pleaseEnterMsg.ko;
    }

    // 연결 테스트에 성공한 공급자는 실제 모델 목록도 갱신해 드롭다운에 바로 반영한다.
    const modelInputs = { openai: 'openaiModel', gemini: 'geminiModel', claude: 'claudeModel' };
    Object.entries(modelInputs).forEach(([provider, inputId]) => {
      if (results?.[provider] !== true) return;
      const input = document.getElementById(inputId);
      const refresh = input?.closest('.provider-field')?.querySelector('.model-refresh');
      if (refresh) refreshModelList(refresh, { quiet: true });
    });
    customProviders.forEach((provider) => {
      if (results?.custom?.[provider.id] !== true) return;
      const card = document.querySelector(`.custom-provider-card[data-provider-id="${provider.id}"]`);
      const refresh = card?.querySelector('.model-refresh');
      if (refresh) refreshModelList(refresh, { quiet: true });
    });
  } catch (e) {
    if (status) {
      const errorMsg = {
        ko: '앗, 문제 발생',
        en: 'Oops, something went wrong',
        ja: 'あれ、問題が発生',
        zh: '哎呀，出问题了',
        pl: 'Ups, coś poszło nie tak',
      };
      status.style.display = 'block';
      status.style.background = '#f8d7da';
      status.style.border = '1px solid #f5c6cb';
      status.style.color = '#721c24';
      status.textContent = `${errorMsg[currentUiLang]} - ${e.message || e}`;
    }
  }
}

// =============================================
// Panel Resize Functionality (패널 리사이즈 기능)
// =============================================
(function initPanelResize() {
  const resizeHandle = document.getElementById('resizeHandle');
  const rightPanel = document.getElementById('queueContainer');

  if (!resizeHandle || !rightPanel) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  // Load saved width from localStorage
  const savedWidth = localStorage.getItem('queuePanelWidth');
  if (savedWidth) {
    const width = parseInt(savedWidth, 10);
    if (width >= 280 && width <= 600) {
      rightPanel.style.width = width + 'px';
    }
  }

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = rightPanel.offsetWidth;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    // Calculate new width (dragging left increases width)
    const deltaX = startX - e.clientX;
    let newWidth = startWidth + deltaX;

    // Clamp to min/max (280px ~ 70% of viewport)
    const maxWidth = Math.floor(window.innerWidth * 0.7);
    newWidth = Math.max(280, Math.min(maxWidth, newWidth));

    rightPanel.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;

    isResizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Save width to localStorage
    localStorage.setItem('queuePanelWidth', rightPanel.offsetWidth);
  });

  console.log('[Renderer] Panel resize initialized');
})();

// =============================================
// Update Check (업데이트 체크) - main.js에서 푸시 방식
// =============================================

// 현재 표시 중인 업데이트 정보 저장 (언어 변경 시 배너 텍스트 업데이트용)
let currentUpdateInfo = null;

function initUpdateListener() {
  // main.js에서 'update-available' 이벤트를 받아 배너 표시
  window.electronAPI.onUpdateAvailable((updateInfo) => {
    console.log('[Update] Received update-available from main:', updateInfo);
    if (updateInfo && updateInfo.hasUpdate) {
      showUpdateBanner(updateInfo);
    }
  });
  console.log('[Update] Update listener initialized');
}

function showUpdateBanner(updateInfo) {
  const banner = document.getElementById('updateBanner');
  const message = document.getElementById('updateMessage');
  const downloadBtn = document.getElementById('updateDownloadBtn');
  const laterBtn = document.getElementById('updateLaterBtn');

  if (!banner || !message) return;

  // 업데이트 정보 저장 (언어 변경 시 사용)
  currentUpdateInfo = updateInfo;

  // I18N 텍스트 설정
  const t = I18N[currentUiLang] || I18N.ko;
  message.textContent = t.updateMessage(updateInfo.latestVersion);
  if (downloadBtn) downloadBtn.textContent = t.updateDownload;
  if (laterBtn) laterBtn.textContent = t.updateLater;

  // 배너 표시
  banner.style.display = 'flex';
  document.body.classList.add('has-update-banner');

  // 다운로드 버튼 클릭
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      window.electronAPI.openExternal(updateInfo.releaseUrl);
    };
  }

  // 나중에 버튼 클릭
  if (laterBtn) {
    laterBtn.onclick = () => {
      hideUpdateBanner();
      // 세션 동안 다시 표시하지 않음 (localStorage 사용하지 않음 - 매번 알림)
    };
  }
}

// 언어 변경 시 배너 텍스트 업데이트 (배너가 표시 중일 때만)
function updateBannerLanguage() {
  const banner = document.getElementById('updateBanner');
  if (!banner || banner.style.display === 'none') return;

  // main.js의 executeJavaScript에서 설정한 window.currentUpdateInfo 또는 renderer의 currentUpdateInfo 사용
  const updateInfo = window.currentUpdateInfo || currentUpdateInfo;
  if (!updateInfo) {
    console.log('[Update] No update info available for language change');
    return;
  }

  const message = document.getElementById('updateMessage');
  const downloadBtn = document.getElementById('updateDownloadBtn');
  const laterBtn = document.getElementById('updateLaterBtn');

  const t = I18N[currentUiLang] || I18N.ko;
  if (message) message.textContent = t.updateMessage(updateInfo.latestVersion);
  if (downloadBtn) downloadBtn.textContent = t.updateDownload;
  if (laterBtn) laterBtn.textContent = t.updateLater;

  console.log('[Update] Banner language updated to:', currentUiLang);
}

function hideUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (banner) {
    banner.style.display = 'none';
    document.body.classList.remove('has-update-banner');
  }
}

// 버전 배지 자동 업데이트 (package.json에서 버전 가져오기)
async function initVersionBadge() {
  try {
    const version = await window.electronAPI.getCurrentVersion();
    const badge = document.getElementById('versionBadge');
    if (badge && version) {
      badge.textContent = `v${version}`;
      console.log('[Version] Badge updated to:', version);
    }
  } catch (error) {
    console.error('[Version] Failed to get current version:', error.message);
  }
}

// ============================================================
// History · Models (Sidebar Views)
// ============================================================
const HISTORY_KEY = 'wst_history_v1';
const HISTORY_LEGACY_KEY = 'wst_history';
const HISTORY_ENABLED_KEY = 'wst_history_enabled';
const HISTORY_MAX = 200;

// 설정 — 히스토리 기록 ON/OFF (기본 ON)
function isHistoryEnabled() {
  try {
    const v = localStorage.getItem(HISTORY_ENABLED_KEY);
    return v === null ? true : v === '1' || v === 'true';
  } catch (_e) {
    return true;
  }
}
function setHistoryEnabled(on) {
  try {
    localStorage.setItem(HISTORY_ENABLED_KEY, on ? '1' : '0');
  } catch (_e) {}
}
window.isHistoryEnabled = isHistoryEnabled;
window.setHistoryEnabled = setHistoryEnabled;

// Local HTML escape (escAttr is scoped inside an IIFE elsewhere)
function _esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 파일 기반 저장소 (userData/history.json) — localStorage 는 file:// origin 차이로 날아갈 수 있으므로
// IPC 로 메인 프로세스에서 파일 읽고/쓰기. 조회는 동기 인터페이스이므로 캠시한다.
let _historyCache = null;
let _historyLoadedOnce = false;

async function ensureHistoryLoaded() {
  if (_historyLoadedOnce) return _historyCache || [];
  _historyLoadedOnce = true;
  let list = [];
  try {
    const res = await window.electronAPI?.historyLoad?.();
    if (res && res.success && Array.isArray(res.list)) list = res.list;
  } catch (_e) {}
  // 이전 빌드의 localStorage 데이터 일회성 마이그레이션
  if (list.length === 0) {
    try {
      const raw = localStorage.getItem(HISTORY_KEY) || localStorage.getItem(HISTORY_LEGACY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          list = arr;
          try {
            await window.electronAPI?.historySave?.(list);
          } catch (_e) {}
          try {
            localStorage.removeItem(HISTORY_KEY);
            localStorage.removeItem(HISTORY_LEGACY_KEY);
          } catch (_e) {}
        }
      }
    } catch (_e) {}
  }
  _historyCache = list;
  return _historyCache;
}
window.ensureHistoryLoaded = ensureHistoryLoaded;

function loadHistory() {
  if (!_historyLoadedOnce) {
    // 최초 조회 시엔 비동기로 로드하고 완료 되면 한번 더 렌더링
    ensureHistoryLoaded().then(() => {
      try {
        if (typeof renderHistory === 'function') renderHistory();
      } catch (_e) {}
    });
    return [];
  }
  return _historyCache || [];
}

async function saveHistoryList(list) {
  const safe = Array.isArray(list) ? list.slice(0, HISTORY_MAX) : [];
  _historyCache = safe;
  _historyLoadedOnce = true;
  try {
    if (window.electronAPI?.historySave) {
      const res = await window.electronAPI.historySave(safe);
      if (res && res.success === false) {
        console.warn('[History] save rejected by main process:', res.error || 'unknown');
      }
    }
  } catch (e) {
    // IPC 실패(예: 앱 종료 직전)는 치명적이지 않다. 메모리 캐시는 유지된다.
    console.warn('[History] save failed:', e?.message || e);
  }
}

// 히스토리 항목 개별 삭제 (ts 기준). 기록 항목만 지우고 원본 파일은 건드리지 않는다.
function deleteHistoryItem(ts) {
  if (ts == null) return;
  const key = String(ts);
  const list = (_historyCache || []).filter((x) => String(x.ts) !== key);
  saveHistoryList(list);
  const q = document.getElementById('historySearch')?.value || '';
  renderHistory(q);
}
window.deleteHistoryItem = deleteHistoryItem;

function saveFileToHistory(file, errorMsg) {
  if (!file || !file.path) return;
  if (file._historySaved) return;
  if (!isHistoryEnabled()) return; // 설정에서 OFF 면 기록 건너뜀
  file._historySaved = true;
  try {
    const list = loadHistory();
    const fileName = file.path.split(/[\\/]/).pop();
    const entry = {
      name: fileName,
      // path = 열기/재생 대상 경로.
      //   - 영상 처리 완료: 원본 영상을 열면 자막이 자동 로드됨
      //   - SRT 단독 번역 완료: 따로 저장한 번역 결과(_ko.srt)를 열어야 함
      path: file.outputPath || file.path,
      sourcePath: file.path, // 원본 경로 (부가 정보)
      status: file.status === 'completed' ? 'success' : 'failed',
      ts: Date.now(),
      error: errorMsg || undefined,
    };
    list.unshift(entry);
    saveHistoryList(list);
  } catch (e) {
    console.warn('[History] save failed:', e?.message);
  }
}
window.saveFileToHistory = saveFileToHistory;

function timeAgo(ts) {
  const lang = typeof currentUiLang !== 'undefined' ? currentUiLang : 'ko';
  const diff = Math.floor((Date.now() - ts) / 1000);
  const units = {
    ko: { just: '방금', m: '분 전', h: '시간 전', d: '일 전', w: '주 전' },
    en: { just: 'just now', m: 'm ago', h: 'h ago', d: 'd ago', w: 'w ago' },
    ja: { just: 'たった今', m: '分前', h: '時間前', d: '日前', w: '週前' },
    zh: { just: '刚才', m: '分钟前', h: '小时前', d: '天前', w: '周前' },
    pl: { just: 'teraz', m: 'm temu', h: 'h temu', d: 'd temu', w: 't temu' },
  };
  const u = units[lang] || units.en;
  if (diff < 60) return u.just;
  if (diff < 3600) return Math.floor(diff / 60) + (lang === 'en' ? u.m : ' ' + u.m);
  if (diff < 86400) return Math.floor(diff / 3600) + (lang === 'en' ? u.h : ' ' + u.h);
  if (diff < 604800) return Math.floor(diff / 86400) + (lang === 'en' ? u.d : ' ' + u.d);
  return Math.floor(diff / 604800) + (lang === 'en' ? u.w : ' ' + u.w);
}

function renderHistory(filter) {
  const list = loadHistory();
  const listEl = document.getElementById('historyList');
  if (!listEl) return;

  // Stats
  const setNum = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  setNum('statTotalFiles', list.length);
  setNum('statSuccess', list.filter((x) => x.status === 'success').length);
  setNum('statFailed', list.filter((x) => x.status === 'failed').length);
  const weekAgo = Date.now() - 7 * 86400000;
  setNum('statThisWeek', list.filter((x) => x.ts >= weekAgo).length);

  const q = (filter || '').trim().toLowerCase();
  const filtered = q
    ? list.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.path || '').toLowerCase().includes(q))
    : list;

  const d = I18N[currentUiLang] || I18N.ko;
  if (!filtered.length) {
    setSafeHtml(
      listEl,
      `<div class="history-empty">
        <div class="history-empty-pixel">
          <img src="assets/px-empty-history.png?v=3" alt="" aria-hidden="true"/>
        </div>
        <p class="history-empty-title">${q ? d.histNoResult || 'No results' : d.histEmptyTitle || 'No history yet'}</p>
        <p class="history-empty-hint">${q ? d.histNoResultHint || 'Try another search' : d.histEmptyHint || 'Process a file to see it here'}</p>
      </div>`
    );
    return;
  }

  setSafeHtml(
    listEl,
    filtered
      .map(
        (it) => `
    <div class="history-item">
      <span class="history-item-status ${it.status === 'success' ? 'success' : 'failed'}" title="${it.status}"></span>
      <span class="history-item-name" title="${_esc(it.path || it.name)}">${_esc(it.name || '')}</span>
      <span class="history-item-meta">${timeAgo(it.ts)}</span>
      <span class="history-item-actions">
        <button class="history-item-btn" data-hist-open="${_esc(it.path || '')}">${d.histOpen || 'Open'}</button>
        <button class="history-item-btn" data-hist-folder="${_esc(it.path || '')}">${d.histFolder || 'Folder'}</button>
        <button class="history-item-btn history-item-btn-del" data-hist-del="${_esc(String(it.ts))}" title="${d.histDelete || 'Delete'}">${d.histDelete || 'Delete'}</button>
      </span>
    </div>
  `
      )
      .join('')
  );

  // Bind action buttons:
  //  - data-hist-open  → 파일 자체 실행 (영상=플레이어, .srt=에디터)
  //  - data-hist-folder → 파일 있는 폴더를 열고 파일 선택 상태로 표시
  const openFolderFn = window.electronAPI?.openFileLocation; // showItemInFolder
  const openFileFn = window.electronAPI?.openFolder; // shell.openPath — 파일 경로도 이걸로 열림
  listEl.querySelectorAll('[data-hist-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.getAttribute('data-hist-open');
      if (p && openFileFn) {
        try {
          await openFileFn(p);
        } catch (_e) {}
      }
    });
  });
  listEl.querySelectorAll('[data-hist-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.getAttribute('data-hist-folder');
      if (p && openFolderFn) {
        try {
          await openFolderFn(p);
        } catch (_e) {}
      }
    });
  });
  //  - data-hist-del → 해당 기록 항목만 삭제 (실제 파일은 건드리지 않음)
  listEl.querySelectorAll('[data-hist-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteHistoryItem(btn.getAttribute('data-hist-del')));
  });
}
window.renderHistory = renderHistory;

// ============================================================
// Models view
// ============================================================

// Wire up progress listeners once (idempotent)
let _modelProgressWired = false;
function _wireModelProgress() {
  if (_modelProgressWired) return;
  _modelProgressWired = true;
  // Whisper downloads
  if (window.electronAPI?.onWhisperModelProgress) {
    window.electronAPI.onWhisperModelProgress(({ modelName, percent }) => {
      _updateModelCardProgress(`whisper-${modelName}`, percent);
      // 정밀/라이트는 같은 다운로드를 공유하므로 진행률을 두 카드에 함께 표시한다.
      if (modelName === 'large-v2-sync') _updateModelCardProgress('whisper-large-v2-sync-lite', percent);
    });
  }
  // Hy-MT2 (local translator) downloads. Map filename → card id.
  if (window.electronAPI?.onLocalModelProgress) {
    window.electronAPI.onLocalModelProgress((progress) => {
      if (!progress) return;
      // progress: { modelId, progress, percent, downloadedBytes, totalBytes, ... }
      const pct = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            progress.percent != null
              ? progress.percent
              : progress.progress != null
                ? progress.progress * (progress.progress <= 1 ? 100 : 1)
                : 0
          )
        )
      );
      const id = String(progress.modelId || '').toLowerCase();
      if (id.includes('7')) _updateModelCardProgress('hy-mt-7b', pct);
      else _updateModelCardProgress('hy-mt-1.8b', pct);
    });
  }
}

// 다운로드 진행 중인 모델 ID 집합 — renderModels() 가 참조해서 중복 클릭 방지
const _downloadingModels = new Set();
window._downloadingModels = _downloadingModels;

function isCancelledDownloadResult(result) {
  return result?.success === false && (result.userStopped || /cancel(?:l)?ed/i.test(String(result.error || '')));
}

function _updateModelCardProgress(cardId, percent) {
  const card = document.querySelector(`.model-card[data-card-id="${cardId}"]`);
  if (!card) return;
  let bar = card.querySelector('.model-card-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'model-card-progress';
    setSafeHtml(bar, '<div class="model-card-progress-fill"></div><span class="model-card-progress-text"></span>');
    const actions = card.querySelector('.model-card-actions');
    if (actions) actions.parentNode.insertBefore(bar, actions);
  }
  const fill = bar.querySelector('.model-card-progress-fill');
  const text = bar.querySelector('.model-card-progress-text');
  if (fill) fill.style.width = `${percent}%`;
  if (text) text.textContent = `${percent}%`;
  if (percent >= 100) {
    setTimeout(() => {
      try {
        renderModels();
      } catch (_e) {}
    }, 600);
  }
}

async function renderModels() {
  _wireModelProgress();
  const D = I18N[currentUiLang] || I18N.ko;
  const grid = document.getElementById('modelsGrid');
  if (!grid) return;

  // Models metadata: 2 translation (Hy-MT2) + 6 ASR (Whisper) = 8 total
  const models = [
    {
      id: 'hy-mt-1.8b',
      whisperKey: null,
      name: 'Hy-MT2 · 1.8B',
      desc: 'Fast lightweight local translator.',
      size: '1.13 GB',
      vram: '~2.5 GB',
      speedKey: 'fast',
      category: 'translation',
      tag: 'MT',
    },
    {
      id: 'hy-mt-7b',
      whisperKey: null,
      name: 'Hy-MT2 · 7B',
      desc: 'High-quality local translator.',
      size: '6.16 GB',
      vram: '~8 GB',
      speedKey: 'medium',
      category: 'translation',
      tag: 'MT',
    },
    {
      id: 'whisper-tiny',
      whisperKey: 'tiny',
      name: 'Whisper · Tiny',
      desc: 'Smallest and fastest.',
      size: '~75 MB',
      vram: '~1 GB',
      speedKey: 'extreme',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-base',
      whisperKey: 'base',
      name: 'Whisper · Base',
      desc: 'More accurate than Tiny.',
      size: '~142 MB',
      vram: '~1 GB',
      speedKey: 'veryFast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-small',
      whisperKey: 'small',
      name: 'Whisper · Small',
      desc: 'Fast subtitle extraction.',
      size: '~466 MB',
      vram: '~1 GB',
      speedKey: 'fast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-medium',
      whisperKey: 'medium',
      name: 'Whisper · Medium',
      desc: 'Balanced accuracy and speed.',
      size: '~1.5 GB',
      vram: '~2 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-large-v3-turbo',
      whisperKey: 'large-v3-turbo',
      name: 'Whisper · Large v3 Turbo',
      desc: 'Large accuracy with 8x speed.',
      size: '~1.6 GB',
      vram: '~2 GB',
      speedKey: 'fast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-large-v3',
      whisperKey: 'large-v3',
      name: 'Whisper · Large v3',
      desc: 'Most accurate ASR model (F16, slower).',
      size: '~3.1 GB',
      vram: '~4 GB',
      speedKey: 'slow',
      category: 'asr',
      tag: 'ASR',
    },
    {
      // 싱크 엔진: GGML이 아니라 Faster-Whisper-XXL(GPU 자동). whisperKey 대신 syncEngine 마커 사용.
      id: 'whisper-large-v2-sync',
      whisperKey: null,
      syncEngine: true,
      name: 'Whisper · Large v2 Sync',
      desc: 'Best subtitle sync. GPU auto, separate engine.',
      size: '~4.4 GB',
      vram: '~4.5 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
    {
      // 싱크 엔진 라이트(int8): 정밀과 같은 엔진+model.bin을 공유한다. 다운로드/삭제는 정밀 카드와
      // 동일한 download-sync-engine/delete-sync-engine을 쓰고, 설치 판정도 엔진 존재로 함께 처리된다.
      id: 'whisper-large-v2-sync-lite',
      whisperKey: null,
      syncEngine: true,
      name: 'Whisper · Large v2 Sync Lite',
      desc: 'Same file as precise, int8, lower VRAM.',
      sizeKey: 'shared',
      size: '~4.4 GB',
      vram: '~3 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
  ];

  // Check installed status (best-effort) — always fresh from disk
  let installedSet = new Set();
  try {
    if (window.electronAPI?.localModelStatus) {
      try {
        const r18 = await window.electronAPI.localModelStatus('1.8b');
        if (r18?.installed || r18?.exists) installedSet.add('hy-mt-1.8b');
      } catch (e) {
        console.warn('[renderModels] 1.8b status:', e);
      }
      try {
        const r7 = await window.electronAPI.localModelStatus('7b');
        if (r7?.installed || r7?.exists) installedSet.add('hy-mt-7b');
      } catch (e) {
        console.warn('[renderModels] 7b status:', e);
      }
    }
    // Whisper models — re-fetch fresh status each time AND fall back to
    // the workspace-cached global if IPC returns empty (some edge cases).
    let whisperStatus = {};
    if (window.electronAPI?.checkModelStatus) {
      try {
        whisperStatus = await window.electronAPI.checkModelStatus();
      } catch (e) {
        console.warn('[renderModels] checkModelStatus failed:', e);
      }
      console.log('[renderModels] Whisper status (fresh):', whisperStatus);
      // Keep the global in sync for the workspace dropdown
      try {
        availableModels = whisperStatus || availableModels || {};
      } catch (_e) {}
    }
    // Merge with any pre-populated global (covers startup race)
    const mergedWhisper = Object.assign({}, availableModels || {}, whisperStatus || {});
    for (const m of models) {
      if (m.whisperKey && mergedWhisper[m.whisperKey]) installedSet.add(m.id);
      // 싱크 엔진은 check-model-status가 'large-v2-sync' 키로 설치 여부를 보고한다.
      if (m.syncEngine && mergedWhisper['large-v2-sync']) installedSet.add(m.id);
    }
    console.log('[renderModels] merged whisper:', mergedWhisper, 'installedSet:', Array.from(installedSet));
  } catch (_e) {
    /* ignore */
  }

  // Build card HTML helper
  const cardHtml = (m) => {
    const installed = installedSet.has(m.id);
    const badge = installed
      ? `<span class="model-card-badge installed">● ${D.modelInstalled || 'Installed'}</span>`
      : `<span class="model-card-badge available">${D.modelNotInstalled || 'Not installed'}</span>`;
    const downloading = _downloadingModels.has(m.id);
    const actions = installed
      ? `<button class="model-card-btn ghost" data-model-action="delete" data-model-id="${m.id}">${D.modelDeleteBtn || 'Delete'}</button>
         <button class="model-card-btn" disabled>${D.modelReadyBtn || 'Ready'}</button>`
      : downloading
        ? `<button class="model-card-btn primary" disabled>${D.btnDownloading || 'Downloading…'}</button>
           <button class="model-card-btn ghost" data-model-action="cancel-download" data-model-id="${m.id}">${D.btnCancel || 'Cancel'}</button>`
        : `<button class="model-card-btn primary" data-model-action="download" data-model-id="${m.id}">${D.modelDownloadBtn || 'Download'}</button>`;
    const mascot = m.category === 'translation' ? 'assets/px-mascot-mt.png' : 'assets/px-model-asr.png';
    const tagColor = m.category === 'translation' ? 'lavender' : 'pink';
    const catAttr = m.category === 'translation' ? 'mt' : 'asr';
    return `
      <div class="model-card model-card-${m.category}" data-card-id="${m.id}" data-cat="${catAttr}">
        <div class="model-card-media">
          <img class="model-card-mascot" src="${mascot}" alt="" aria-hidden="true"/>
          <span class="model-card-tag model-card-tag-${tagColor}">${_esc(m.category === 'translation' ? D.modelTagTranslation || 'MT' : D.modelTagAsr || 'ASR')}</span>
        </div>
        <div class="model-card-head">
          <div class="model-card-info">
            <h3 class="model-card-name">${_esc((D.modelNames && D.modelNames[m.id]) || m.name)}</h3>
            <p class="model-card-desc">${_esc((D.modelDescriptions && D.modelDescriptions[m.id]) || m.desc)}</p>
          </div>
          ${badge}
        </div>
        <div class="model-card-meta">
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaSize || 'Size'}</span>
            <span class="model-card-meta-value">${m.sizeKey === 'shared' ? D.modelSizeShared || 'Shared' : m.size}</span>
          </div>
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaVram || 'VRAM'}</span>
            <span class="model-card-meta-value">${m.vram}</span>
          </div>
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaSpeed || 'Speed'}</span>
            <span class="model-card-meta-value">${(D.modelSpeed && D.modelSpeed[m.speedKey]) || m.speedKey}</span>
          </div>
        </div>
        <div class="model-card-actions">
          ${actions}
        </div>
      </div>`;
  };

  // Group by category: 번역 (translation) and 음성인식 (asr)
  const translationModels = models.filter((m) => m.category === 'translation');
  const asrModels = models.filter((m) => m.category === 'asr');
  const sectionTrTitle = D.modelSectionTranslation || 'Translation Models';
  const sectionAsTitle = D.modelSectionAsr || 'Speech Recognition Models';
  const sectionTrHint = D.modelSectionTranslationHint || 'Text → another language';
  const sectionAsHint = D.modelSectionAsrHint || 'Audio → subtitle text';

  setSafeHtml(
    grid,
    `<section class="model-section">
      <header class="model-section-header">
        <div class="model-section-title-wrap">
          <span class="model-section-dot lavender"></span>
          <h2 class="model-section-title">${sectionTrTitle}</h2>
          <span class="model-section-hint">${sectionTrHint}</span>
        </div>
        <span class="model-section-count">${translationModels.filter((m) => installedSet.has(m.id)).length} / ${translationModels.length}</span>
      </header>
      <div class="model-section-grid">${translationModels.map(cardHtml).join('')}</div>
    </section>
    <section class="model-section">
      <header class="model-section-header">
        <div class="model-section-title-wrap">
          <span class="model-section-dot pink"></span>
          <h2 class="model-section-title">${sectionAsTitle}</h2>
          <span class="model-section-hint">${sectionAsHint}</span>
        </div>
        <span class="model-section-count">${asrModels.filter((m) => installedSet.has(m.id)).length} / ${asrModels.length}</span>
      </header>
      <div class="model-section-grid">${asrModels.map(cardHtml).join('')}</div>
    </section>`
  );

  // Bind download actions
  grid.querySelectorAll('[data-model-action="download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      // 이미 다운로드 중이면 무시
      if (_downloadingModels.has(m.id)) return;
      if (m.category === 'translation') {
        if (window.electronAPI?.localModelDownload) {
          const hyId = m.id === 'hy-mt-7b' ? '7b' : '1.8b';
          const D2 = I18N[currentUiLang] || I18N.ko;
          if (!confirm(`${m.name} (${m.size}) — ${D2.confirmDownloadModel || 'Start download?'}`)) return;
          _downloadingModels.add(m.id);
          // 카드 재렌더 하여 취소 버튼 노출
          try {
            renderModels();
          } catch (_e) {}
          try {
            _updateModelCardProgress(m.id, 0);
            const result = await window.electronAPI.localModelDownload(hyId);
            if (isCancelledDownloadResult(result)) return;
            if (result?.success === false) throw new Error(result.error || 'failed');
          } catch (e) {
            alert(
              `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
            );
          } finally {
            _downloadingModels.delete(m.id);
            renderModels();
          }
        }
      } else if (m.syncEngine && window.electronAPI?.downloadSyncEngine) {
        const D3 = I18N[currentUiLang] || I18N.ko;
        if (!confirm(`${m.name} (${m.size}) — ${D3.confirmDownloadModel || 'Start download?'}`)) return;
        // 정밀/라이트 카드는 같은 엔진을 공유 → 어느 쪽을 눌러도 두 카드 모두 다운로드 상태로 표시.
        const syncCardIds = ['whisper-large-v2-sync', 'whisper-large-v2-sync-lite'];
        syncCardIds.forEach((cid) => _downloadingModels.add(cid));
        try {
          renderModels();
        } catch (_e) {}
        try {
          syncCardIds.forEach((cid) => _updateModelCardProgress(cid, 0));
          const r = await window.electronAPI.downloadSyncEngine();
          if (isCancelledDownloadResult(r)) return;
          if (r?.success === false) throw new Error(r.error || 'failed');
          // 정밀/라이트는 같은 엔진+모델을 공유 → 한 번 받으면 둘 다 사용 가능.
          availableModels['large-v2-sync'] = true;
          availableModels['large-v2-sync-lite'] = true;
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } catch (e) {
          alert(
            `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
          );
        } finally {
          syncCardIds.forEach((cid) => _downloadingModels.delete(cid));
          renderModels();
        }
      } else if (m.whisperKey && window.electronAPI?.downloadModel) {
        const D3 = I18N[currentUiLang] || I18N.ko;
        if (!confirm(`Whisper ${m.whisperKey} (${m.size}) — ${D3.confirmDownloadModel || 'Start download?'}`)) return;
        _downloadingModels.add(m.id);
        // 카드 재렌더 하여 취소 버튼 노출
        try {
          renderModels();
        } catch (_e) {}
        try {
          _updateModelCardProgress(m.id, 0);
          const result = await window.electronAPI.downloadModel(m.whisperKey);
          if (isCancelledDownloadResult(result)) return;
          if (result?.success === false) throw new Error(result.error || 'failed');
          availableModels[m.whisperKey] = true;
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } catch (e) {
          alert(
            `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
          );
        } finally {
          _downloadingModels.delete(m.id);
          renderModels();
        }
      }
    });
  });

  // Bind cancel-download actions
  grid.querySelectorAll('[data-model-action="cancel-download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      try {
        btn.disabled = true;
        if (m.category === 'translation' && window.electronAPI?.localModelCancel) {
          await window.electronAPI.localModelCancel();
        } else if ((m.whisperKey || m.syncEngine) && window.electronAPI?.whisperModelCancel) {
          await window.electronAPI.whisperModelCancel();
        }
      } catch (_e) {}
      // 진행 플래그는 download 핵들러의 finally 에서 해제됨
    });
  });

  // Bind delete actions
  grid.querySelectorAll('[data-model-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      const D4 = I18N[currentUiLang] || I18N.ko;
      if (!confirm(`${m.name} — ${D4.confirmDeleteModel || 'Delete this model?'}`)) return;
      try {
        btn.disabled = true;
        btn.textContent = (I18N[currentUiLang] || I18N.ko).btnDeleting || 'Deleting…';
        if (m.category === 'translation' && window.electronAPI?.localModelDelete) {
          await window.electronAPI.localModelDelete(m.id === 'hy-mt-7b' ? '7b' : '1.8b');
        } else if (m.syncEngine && window.electronAPI?.deleteSyncEngine) {
          await window.electronAPI.deleteSyncEngine();
          // 공유 파일 삭제 → 정밀/라이트 둘 다 불가 상태로.
          delete availableModels['large-v2-sync'];
          delete availableModels['large-v2-sync-lite'];
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } else if (m.whisperKey && window.electronAPI?.deleteWhisperModel) {
          await window.electronAPI.deleteWhisperModel(m.whisperKey);
          delete availableModels[m.whisperKey];
          if (typeof updateModelSelect === 'function') updateModelSelect();
        }
        renderModels();
      } catch (e) {
        alert(`${(I18N[currentUiLang] || I18N.ko).toastDeleteFailed || 'Delete failed'}: ${e?.message || e}`);
        renderModels();
      }
    });
  });
}
window.renderModels = renderModels;

// =============================================================================
// E2E test hook — only exposed when preload set window.__E2E__ (E2E_SMOKE=1)
// =============================================================================
if (typeof window !== 'undefined' && window.__E2E__) {
  window.__E2E_HOOK__ = {
    get fileQueue() {
      return fileQueue;
    },
    setFileQueue(arr) {
      fileQueue.length = 0;
      for (const f of arr) fileQueue.push(f);
    },
    updateUIMode: () => updateUIMode(),
    updateQueueDisplayImmediate: () =>
      typeof updateQueueDisplayImmediate === 'function' ? updateQueueDisplayImmediate() : null,
    setUiLang(lang) {
      currentUiLang = lang;
      if (typeof applyTranslations === 'function') applyTranslations();
      if (typeof updateUIMode === 'function') updateUIMode();
    },
    getCurrentUiLang: () => currentUiLang,
    hasOnlySrtFiles: () => (typeof hasOnlySrtFiles === 'function' ? hasOnlySrtFiles() : null),
    hasAnySrtFiles: () => (typeof hasAnySrtFiles === 'function' ? hasAnySrtFiles() : null),
    addOutput: (s) => addOutput(s),
    clearOutput: () => clearOutput(),
  };
  console.log('[E2E] hook installed: window.__E2E_HOOK__');
}
