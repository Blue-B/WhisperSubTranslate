// Queue-based renderer for multi-file processing (memory-leak safe) (대기열 기반 렌더러 - 다중 파일 처리)
let fileQueue = []; // processing queue (처리 대기열)
let isProcessing = false;
let currentProcessingIndex = -1;
let availableModels = {};
let shouldStop = false; // stop flag (중지 플래그)
let lastProgress = 0; // last displayed progress (마지막 표시된 진행률)
let targetProgress = 0; // target progress (목표 진행률)
let targetText = '';
let progressTimer = null;
let indeterminateTimer = null; // pseudo progress timer (의사 진행률 타이머)
let currentPhase = null; // 'extract' | 'translate' | null
let translationSessionActive = false; // translation in progress (번역 진행 상태)

// UI 업데이트 디바운스 (UI freeze 방지)
let updateQueueDisplayTimer = null;
let lastQueueUpdateTime = 0;
const MIN_QUEUE_UPDATE_INTERVAL = 200; // 최소 200ms 간격으로 UI 업데이트

// Sound settings (알림음 설정)
let soundVolume = parseFloat(localStorage.getItem('soundVolume') ?? '0.6');
let soundMuted = localStorage.getItem('soundMuted') === 'true';

// Utility: sleep function for delays (지연용 sleep 함수)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ETA state (ETA 계산 상태)
let etaStartTime = null;
let etaLastUpdate = null;
let etaTotalWork = 100; // 0~100 스케일

function formatETA(ms) {
  if (!ms || ms < 0) return '';
  const sec = Math.ceil(ms / 1000);
  const lang = currentUiLang || 'ko';
  const suffix = {
    ko: '남음',
    en: 'left',
    ja: '残り',
    zh: '剩余',
  }[lang] || '남음';
  if (sec < 60) return `${sec}s ${suffix}`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s ${suffix}`;
}

// Supported video extensions (지원되는 비디오 파일 확장자)
const SUPPORTED_EXTENSIONS = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

function isVideoFile(filePath) {
  const ext = filePath.toLowerCase().substr(filePath.lastIndexOf('.'));
  return SUPPORTED_EXTENSIONS.includes(ext);
}

// Check model status and update UI (모델 상태 확인 및 UI 업데이트)
async function checkModelStatus() {
  try {
    availableModels = await window.electronAPI.checkModelStatus();
    updateModelSelect();
  } catch (error) {
    console.error('모델 상태 확인 실패:', error);
  }
}

function updateModelSelect() {
  const modelSelect = document.getElementById('modelSelect');
  const modelStatus = document.getElementById('modelStatus');
  
  modelSelect.innerHTML = '';
  
  const models = [
    { id: 'tiny', name: 'tiny (39MB) - 가장 빠름, 낮은 정확도' },
    { id: 'base', name: 'base (74MB) - 빠름, 기본 정확도' },
    { id: 'small', name: 'small (244MB) - 빠른 처리' },
    { id: 'medium', name: 'medium (769MB) - 균형잡힌 성능' },
    { id: 'large', name: 'large (1550MB) - 느림, 높은 정확도' },
    { id: 'large-v2', name: 'large-v2 (1550MB) - 개선된 정확도' },
    { id: 'large-v3', name: 'large-v3 (1550MB) - 최신 버전' }
  ];
  
  // Available models (사용 가능한 모델)
  const availableGroup = document.createElement('optgroup');
  availableGroup.label = '[OK] 사용 가능한 모델';
  
  // Models that need download (다운로드 필요한 모델)
  const needDownloadGroup = document.createElement('optgroup');
  needDownloadGroup.label = '[DL] 다운로드 필요 (자동 다운로드됨)';
  
  let hasAvailable = false;
  let hasNeedDownload = false;
  
  models.forEach(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    
    if (availableModels[model.id]) {
      availableGroup.appendChild(option);
      hasAvailable = true;
      if (model.id === 'medium') option.selected = true; // 기본 선택
    } else {
      needDownloadGroup.appendChild(option);
      hasNeedDownload = true;
    }
  });
  
  if (hasAvailable) modelSelect.appendChild(availableGroup);
  if (hasNeedDownload) modelSelect.appendChild(needDownloadGroup);
  
  // 상태 메시지 업데이트
  const availableCount = Object.keys(availableModels).length;
  modelStatus.innerHTML = `
    <span style="color: #28a745;">${availableCount}개 모델 사용 가능</span> | 
    <span style="color: #ffc107;">부족한 모델은 자동 다운로드됩니다</span>
  `;
}

// Update queue UI (대기열 UI 업데이트)
function updateQueueDisplay() {
  const queueContainer = document.getElementById('queueContainer');
  const queueList = document.getElementById('queueList');
  const runBtn = document.getElementById('runBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearQueueBtn = document.getElementById('clearQueueBtn');
  
  // queueCount 업데이트
  const queueCount = document.getElementById('queueCount');
  if (queueCount) queueCount.textContent = fileQueue.length;

  if (fileQueue.length === 0) {
    // queueContainer는 항상 표시, queueList만 빈 상태 표시
    runBtn.disabled = true;
    runBtn.textContent = I18N[currentUiLang].runBtn;
    pauseBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    // 빈 상태 메시지 표시
    queueList.innerHTML = `<div class="queue-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>${I18N[currentUiLang].queueEmpty || '파일을 드래그하여 추가하세요'}</span>
    </div>`;
    return;
  }

  if (isProcessing) {
    runBtn.textContent = I18N[currentUiLang].runBtnProcessing;
    runBtn.disabled = true;
    runBtn.className = 'btn-secondary';
    stopBtn.style.display = 'inline-block';
    clearQueueBtn.textContent = I18N[currentUiLang].clearQueueWaiting;
  } else {
    // 대기 중인 파일만 카운트 (완료되지 않은 파일들)
    const pendingCount = fileQueue.filter(f => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped').length;
    runBtn.textContent = I18N[currentUiLang].runBtnCount(pendingCount);
    runBtn.disabled = pendingCount === 0;
    runBtn.className = pendingCount > 0 ? 'btn-success' : 'btn-secondary';
    stopBtn.style.display = 'none';
    clearQueueBtn.textContent = I18N[currentUiLang].clearQueueAll;
  }
  
  const d = I18N[currentUiLang] || I18N.ko;
  queueList.innerHTML = fileQueue.map((file, index) => {
    const fileName = file.path.split('\\').pop() || file.path.split('/').pop();
    const isValid = isVideoFile(file.path);

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
    } else if (file.status === 'error') {
      statusText = d.qError;
      itemClass = 'queue-item error';
    } else if (!isValid) {
      statusText = d.qUnsupported;
      itemClass = 'queue-item error';
    }
    
    // Constrain filename to one line; ellipsis on overflow (파일명 한 줄 표시, 길면 ...)
    const maxPathLength = 80; // max path length (최대 경로 길이)
    const displayPath = file.path.length > maxPathLength ? 
      file.path.substring(0, maxPathLength) + '...' : 
      file.path;
    
    return `
      <div class="${itemClass}">
        <div class="file-info">
          <div class="file-name">${fileName}</div>
          <div class="file-path" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${file.path}">${displayPath}</div>
          <div class="file-status">${d.statusLabel}: ${statusText} ${file.progress ? `(${file.progress}%)` : ''}</div>
        </div>
        <div>
          ${file.status === 'completed' ?
            `<button onclick="openFileLocation('${file.path.replace(/\\/g, '\\\\')}')" class="btn-success btn-sm">${d.btnOpen}</button>` :
            file.status === 'processing' || file.status === 'translating' ?
            `<span style="color: #ffc107; font-size: 12px; font-weight: 600;">${statusText}</span>` :
            (file.status === 'error' || file.status === 'stopped') ?
            `<button onclick="removeFromQueue(${index})" class="btn-danger btn-sm">${d.btnRemove}</button>` :
            `<button onclick="removeFromQueue(${index})" class="btn-danger btn-sm">${d.btnRemove}</button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

function updateProgress(progress, text) {
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const progressPercent = document.getElementById('progressPercent');
  const progressTitle = document.getElementById('progressTitle');

  // Reset ETA (ETA 초기화)
  if (progress === 0 || etaStartTime === null) {
    etaStartTime = Date.now();
    etaLastUpdate = etaStartTime;
  } else {
    etaLastUpdate = Date.now();
  }

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
      progressTitle.textContent = d.progressComplete || '완료!';
    } else if (lastProgress > 0) {
      progressTitle.textContent = d.progressProcessing || '처리 중...';
    } else {
      progressTitle.textContent = d.progressPreparing || '준비 중...';
    }
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

function addOutput(text) {
  const output = document.getElementById('output');
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

// File selector (multi-select) (파일 선택 함수, 다중 선택 지원)**
async function selectFile() {
  try {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'], // allow multi-selection (다중 선택 허용)
      filters: [
        { name: '동영상 파일', extensions: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      result.filePaths.forEach(filePath => {
        addToQueue(filePath);
      });
      
      addOutput(`${result.filePaths.length}개 파일이 대기열에 추가되었습니다.\n`);
    }
  } catch (error) {
    console.error('파일 선택 오류:', error);
    addOutput(`파일 선택 중 오류 발생: ${error.message}\n`);
  }
}

// Queue management helpers (대기열 관리)
function addToQueue(filePath) {
  // deduplicate files (중복 파일 체크)
  if (fileQueue.some(file => file.path === filePath)) {
    addOutput(`이미 대기열에 있는 파일입니다: ${filePath.split('\\').pop()}\n`);
    return;
  }
  
  fileQueue.push({
    path: filePath,
    status: 'pending',
    progress: 0,
    addedAt: new Date()
  });
  
  updateQueueDisplay();
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
  }
}

function clearQueue() {
  if (!isProcessing) {
    // when idle: clear all (처리 중 아님 → 전체 삭제)
    fileQueue = [];
    currentProcessingIndex = -1;
    updateQueueDisplay();
    addOutput(`${I18N[currentUiLang].queueCleared}\n`);
  } else {
    // when busy: remove only pending items (처리 중엔 대기 항목만 삭제)
    const pendingFiles = fileQueue.filter(file => file.status === 'pending');
    fileQueue = fileQueue.filter(file => file.status !== 'pending');

    updateQueueDisplay();
    addOutput(`${I18N[currentUiLang].pendingFilesRemoved(pendingFiles.length)}\n`);
  }
}


function stopProcessing() {
  if (isProcessing) {
    shouldStop = true;
    isProcessing = false;
    addOutput(`\n${I18N[currentUiLang].stopRequested}\n`);
    
    // force-stop current work (현재 진행 작업 강제 중지)
    window.electronAPI.stopCurrentProcess();
    
    // revert processing item back to pending (처리 중 항목 되돌림)
    if (currentProcessingIndex >= 0 && currentProcessingIndex < fileQueue.length) {
      fileQueue[currentProcessingIndex].status = 'pending';
      fileQueue[currentProcessingIndex].progress = 0;
    }
    
    currentProcessingIndex = -1;
    updateQueueDisplay();
  }
}

function openFileLocation(filePath) {
  window.electronAPI.openFileLocation(filePath);
}

async function openOutputFolder() {
  if (fileQueue.length > 0) {
    const firstFile = fileQueue.find(f => f.status === 'completed') || fileQueue[0];
    const folderPath = firstFile.path.substring(0, firstFile.path.lastIndexOf('\\'));
    window.electronAPI.openFolder(folderPath);
  }
}

// 처리 계속 함수 (일시정지 재개 시에도 사용) - 전역 함수로 선언
async function continueProcessing() {
  console.log('[continueProcessing] Called, isProcessing:', isProcessing);
  console.log('[continueProcessing] Queue status:', fileQueue.map(f => ({ path: f.path.split('\\').pop(), status: f.status })));

  const model = document.getElementById('modelSelect').value;
  const language = document.getElementById('languageSelect').value;
  const device = document.getElementById('deviceSelect').value;

  // 대기 중인 파일 중 첫 번째만 처리 (한 번에 하나씩)
  shouldStop = false;

  // 처리할 파일 찾기
  let fileToProcess = null;
  let fileIndex = -1;

  console.log('[continueProcessing] Searching for files, queue length:', fileQueue.length);

  for (let i = 0; i < fileQueue.length; i++) {
    const file = fileQueue[i];
    console.log(`[continueProcessing] File ${i}: status=${file.status}, path=${file.path.split('\\').pop()}`);

    if (file.status !== 'completed' &&
        file.status !== 'error' &&
        file.status !== 'stopped' &&
        file.status !== 'translating' &&
        file.status !== 'processing') {
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

    const completedCount = fileQueue.filter(f => f.status === 'completed').length;
    const errorCount = fileQueue.filter(f => f.status === 'error').length;
    const stoppedCount = fileQueue.filter(f => f.status === 'stopped').length;

    setProgressTarget(100, I18N[currentUiLang].allDoneNoTr);
    showToast(I18N[currentUiLang].allDoneNoTr, { label: I18N[currentUiLang].toastOpenFolder, onClick: openOutputFolder });
    try {
      playCompletionSound();
    } catch (error) {
      console.log('[Audio] Failed to play completion sound:', error.message);
    }

    addOutput(`\n전체 작업 완료! (성공: ${completedCount}개, 실패: ${errorCount}개, 중지: ${stoppedCount}개)\n`);
    return;
  }

  // 단일 파일 처리
  const i = fileIndex;
  const file = fileToProcess;

    // 현재 시작 시점의 번역 사용 여부를 캡쳐 (중간 변경과 무관하게 처리 일관성 확보)
    const methodAtStart = (document.getElementById('translationSelect')?.value || 'none');

    if (!isVideoFile(file.path)) {
      file.status = 'error';
      updateQueueDisplay();
      addOutput(`${I18N[currentUiLang].unsupportedFormat(file.path.split('\\').pop())}\n`);
      return;
    }

    // 중지 요청 확인
    if (shouldStop) {
      addOutput(`${I18N[currentUiLang].userStopped}\n`);
      return;
    }

    console.log('[continueProcessing] 파일 처리 시작, index:', i, 'fileName:', file.path.split('\\').pop());
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
      if (!availableModels[model]) {
        addOutput(`${I18N[currentUiLang].downloadingModel}: ${model}\n`);
        await window.electronAPI.downloadModel(model);
        availableModels[model] = true;
        updateModelSelect();
      }

      // 자막 추출 단계 의사 진행률 시작
      // 번역 포함 시 추출 0-50%, 번역 50-100% / 추출만 시 0-95%
      const hasTranslation = methodAtStart && methodAtStart !== 'none';
      const extractionMaxProgress = hasTranslation ? 50 : 95;
      startIndeterminate(extractionMaxProgress, 'extract');

      console.log('[continueProcessing] extractSubtitles 호출 시작');
      const result = await window.electronAPI.extractSubtitles({
        filePath: file.path,
        model: model,
        language: language,
        device: device
      });

      // 추출 단계 종료 → 의사 진행률 중지하고 현재 진행률 고정
      stopIndeterminate();
      // 추출 완료 시 해당 단계 최대값으로 설정
      setProgressTarget(extractionMaxProgress, I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName));

      if (result.userStopped) {
        file.status = 'stopped';
        addOutput(`[${i + 1}/${fileQueue.length}] 중지됨: ${fileName}\n`);
      } else if (!result.success) {
        file.status = 'error';
        addOutput(`[${i + 1}/${fileQueue.length}] 실패: ${fileName} - ${result.error || '알 수 없는 오류'}\n`);
      } else {
        addOutput(`${I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName)}\n`);

        // 번역 처리
        const translationMethod = methodAtStart;
        console.log('[continueProcessing] Translation method:', translationMethod);
        let translationDelegated = false;
        if (translationMethod && translationMethod !== 'none') {
          // 번역이 있는 경우 상태를 'translating'으로 설정 (completed 아님!)
          file.status = 'translating';
          file.progress = 90;
          translationSessionActive = true;
          // 프로그레스바도 90%로 업데이트 (파일 큐와 동기화)
          setProgressTarget(90, I18N[currentUiLang].translationStarting || '번역 시작 중...');
          try {
            // 번역 방식에 따른 안내 메시지
            let translationInfo = '';
            switch (translationMethod) {
              case 'mymemory':
                translationInfo = 'MyMemory (무료)';
                break;
              case 'deepl':
                translationInfo = 'DeepL (API 키 확인 중...)';
                break;
              case 'chatgpt':
                translationInfo = 'GPT-5-nano (API 키 확인 중...)';
                break;
              case 'offline':
                translationInfo = 'Offline (오프라인 번역)';
                break;
              default:
                translationInfo = translationMethod;
            }

            addOutput(`번역 시작 (${translationInfo})...\n`);

            const targetLang = (document.getElementById('targetLanguageSelect')?.value || 'ko');
            const srtPathFromResult =
              (typeof result?.srtFile === 'string' && result.srtFile) ||
              (Array.isArray(result?.results) && result.results.length > 0 ? result.results[0]?.srtPath : null);
            if (!srtPathFromResult || typeof srtPathFromResult !== 'string') {
              throw new Error('SRT file path missing after extraction');
            }

            const translationResult = await window.electronAPI.translateSubtitle({
              filePath: srtPathFromResult,
              method: translationMethod,
              targetLang: targetLang
            });
            translationDelegated = true;

            // 번역 단계 종료 표시는 translation-progress의 'completed'에서 처리

            if (translationResult.success) {
              addOutput(`번역 완료: ${fileName}_${targetLang}.srt\n`);
            } else {
              addOutput(`번역 실패: ${translationResult.error}\n`);
            }
          } catch (error) {
            console.error('[continueProcessing] Translation error:', error);
            translationSessionActive = false;
            file.status = 'error';
            file.progress = 0;
            addOutput(`${I18N[currentUiLang].translationError}: ${error.message}\n`);
            setProgressTarget(Math.max(lastProgress, 95), I18N[currentUiLang].translationFailed + (error.message || ''));
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
          // 추출만 하는 경우 진행률 100%로 설정
          setProgressTarget(100, I18N[currentUiLang].extractionComplete(i + 1, fileQueue.length, fileName));
        }
      }



    } catch (error) {
      console.error('[continueProcessing] Processing error:', error);
      file.status = 'error';
      file.progress = 0;
      addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].processingError}: ${fileName} - ${error.message}\n`);
      setProgressTarget(0, I18N[currentUiLang].processingError);
      updateQueueDisplay();
    } finally {
      // 단계 전환 누수 방지
      stopIndeterminate();
    }

  updateQueueDisplay();

  // 단일 파일 처리 완료 후 잠시 대기 (GPU 메모리 정리 시간 확보)
  addOutput(`${I18N[currentUiLang].cleaningMemory}\n`);
  await sleep(2000);

  // 번역 없이 자막 추출만 한 경우 즉시 완료 처리
  setProgressTarget(100, I18N[currentUiLang].fileProcessed(file.path.split('\\').pop()));

  // 자동 처리: 다음 파일 확인 및 처리 (재귀 호출)
  const remainingFiles = fileQueue.filter(f => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped').length;

  console.log('[continueProcessing] Auto-process check:', {
    remainingFiles,
    shouldStop,
    fileQueue: fileQueue.map(f => ({ path: f.path.split('\\').pop(), status: f.status }))
  });

  if (remainingFiles > 0 && !shouldStop) {
    // 다음 파일이 있으면 자동으로 계속 처리
    addOutput(`${I18N[currentUiLang].processingNext(remainingFiles)}\n\n`);
    await continueProcessing(); // 재귀 호출로 다음 파일 처리
  } else {
    // 모든 파일 처리 완료
    isProcessing = false;
    shouldStop = false;
    currentProcessingIndex = -1;
    updateQueueDisplay();

    const completedCount = fileQueue.filter(f => f.status === 'completed').length;
    const errorCount = fileQueue.filter(f => f.status === 'error').length;
    const stoppedCount = fileQueue.filter(f => f.status === 'stopped').length;

    setProgressTarget(100, I18N[currentUiLang].allDoneNoTr);
    showToast(I18N[currentUiLang].allDoneNoTr, { label: I18N[currentUiLang].toastOpenFolder, onClick: openOutputFolder });
    try {
      playCompletionSound();
    } catch (error) {
      console.log('[Audio] Failed to play completion sound:', error.message);
    }

    addOutput(`\n${I18N[currentUiLang].allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
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

  const dropZone = document.getElementById('dropZone');
  const runBtn = document.getElementById('runBtn');
  const clearBtn = document.getElementById('clearBtn');
  const selectFileBtn = document.getElementById('selectFileBtn');
  
  // drag & drop events (드래그앤드롭 이벤트)
  if (!dropZone) {
    console.error('dropZone element not found');
    return;
  }
  
  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  };
  
  dropZone.ondragleave = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  };
  
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    console.log('Drop event triggered');
    
    const files = Array.from(e.dataTransfer.files);
    console.log('Dropped files:', files);
    
    if (files.length > 0) {
      let addedCount = 0;
      
      files.forEach(file => {
        console.log('=== 드래그앤드롭 파일 분석 ===');
        console.log('File:', file.name);
        
        // Try multiple ways to read file path (여러 방법으로 파일 경로 시도)
        let extractedPath = null;
        
        // Method 1: direct file.path access (방법 1)
        if (file.path && typeof file.path === 'string' && file.path.trim()) {
          extractedPath = file.path;
          console.log('[OK] 방법 1 성공 (file.path):', extractedPath);
        }
        // Method 2: use webUtils (방법 2)
        else {
          try {
            extractedPath = window.electronAPI.getFilePathFromFile(file);
            console.log('[OK] 방법 2 시도 (webUtils):', extractedPath);
          } catch (error) {
            console.error('방법 2 실패:', error);
          }
        }
        
        if (extractedPath && extractedPath !== 'undefined' && extractedPath.trim()) {
          addToQueue(extractedPath);
          addedCount++;
        } else {
          addOutput(`파일 경로를 추출할 수 없습니다: ${file.name}\n`);
        }
      });
      
      if (addedCount > 0) {
        addOutput(`${addedCount}개 파일이 대기열에 추가되었습니다.\n`);
      }
    } else {
      console.log('No files dropped');
      addOutput('파일이 선택되지 않았습니다.\n');
    }
  };
  
  // start processing (처리 시작 함수)
  async function startProcessing() {
    isProcessing = true;
    currentProcessingIndex = -1;
    updateQueueDisplay();
    
    const model = document.getElementById('modelSelect').value;
    const language = document.getElementById('languageSelect').value;
    const device = document.getElementById('deviceSelect').value;
    const translationMethod = document.getElementById('translationSelect').value;
    
    addOutput(`\n${fileQueue.length}개 파일 순차 처리 시작\n`);
    addOutput(`모델: ${model} | 언어: ${language === 'auto' ? '자동감지' : language} | 장치: ${device === 'auto' ? '자동' : device === 'cuda' ? 'GPU' : 'CPU'}\n\n`);
    
    // 오프라인 번역 사전 준비
    if (translationMethod === 'offline') {
      addOutput(`오프라인 번역을 위한 모델 상태 확인/준비 중...\n`);
      setProgressTarget(Math.max(lastProgress, 1), '오프라인 모델 준비 중...');
      try {
        const warm = await window.electronAPI.warmupOfflineModel();
        if (warm?.success) {
          addOutput(`오프라인 모델 준비 완료\n`);
        } else {
          addOutput(`오프라인 모델 준비 실패: ${warm?.error || '알 수 없는 오류'}\n`);
        }
      } catch (e) {
        addOutput(`오프라인 모델 준비 오류: ${e.message}\n`);
      }
    }

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
  
  // 대기열 관리 버튼들
  document.getElementById('stopBtn').onclick = stopProcessing;
  document.getElementById('clearQueueBtn').onclick = clearQueue;
  document.getElementById('openFolderBtn').onclick = openOutputFolder;
  
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
    { re: /처리 중지 요청됨\. 현재 파일 완료 후 중지됩니다\./g, to: '停止要求を受けました。現在のファイル終了後に停止します。' },
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
    { re: /Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/g, to: 'Standalone Faster-Whisper-XXL 実行環境: $1' },
    { re: /Starting to process:\s*/g, to: '処理開始: ' },
    { re: /Starting translation\.\.\./g, to: '翻訳を開始します...' },
    { re: /Translating\.\.\. (\d+)\/(\d+)/g, to: '翻訳中... $1/$2' },
    { re: /Translation completed\. Finalizing\.\.\./g, to: '翻訳が完了しました。最終処理中...' },
    { re: /Translation failed: (.*)$/g, to: '翻訳に失敗しました: $1' },
    { re: /🌐\s*번역을 시작 \[(MyMemory) \(무료\)\]/g, to: '🌐 翻訳を開始 [$1（無料）]' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: 'メモリを整理中...（少々お待ちください）' },
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
    { re: /Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/g, to: 'Standalone Faster-Whisper-XXL 运行于: $1' },
    { re: /Starting to process:\s*/g, to: '开始处理: ' },
    { re: /Starting translation\.\.\./g, to: '开始翻译...' },
    { re: /Translating\.\.\. (\d+)\/(\d+)/g, to: '翻译中... $1/$2' },
    { re: /Translation completed\. Finalizing\.\.\./g, to: '翻译完成。正在收尾...' },
    { re: /Translation failed: (.*)$/g, to: '翻译失败: $1' },
    { re: /🌐\s*번역을 시작 \[(MyMemory) \(무료\)\]/g, to: '�� 开始翻译 [$1（免费）]' },
    { re: /메모리 정리 중\. \(잠시만 기다려주세요\)/g, to: '正在清理内存...（请稍候）' },
  ],
};

// === UI 텍스트 I18N ===
const I18N = {
  ko: {
    titleText: 'WhisperSubTranslate',
    dropTitle: '파일 드래그 & 드롭',
    dropHint1: '동영상 파일을 여기에 드래그하세요',
    dropHint2: '지원 형식: MP4, AVI, MKV, MOV, WMV',
    queueTitle: '처리 대기열',
    clearQueueBtn: '대기열 삭제',
    openFolderBtn: '출력 폴더',
    labelModel: '모델 선택',
    labelLanguage: '언어 선택',
    langStatusInfo: '자동 감지 권장: 각 동영상의 언어를 자동으로 판별합니다\n고정 언어: 모든 파일을 동일한 언어로 처리합니다',
    labelDevice: '처리 장치 선택',
    labelTranslation: '번역 설정',
    runBtn: '자막 추출 시작',
    runBtnProcessing: '처리 중...',
    clearQueueWaiting: '대기 파일 삭제',
    clearQueueAll: '대기열 전체 삭제',
    apiBtn: 'API 키 설정',
    selectFileBtn: '파일 선택',
    stopBtn: '중지',
    logTitle: '처리 로그',
    cannotRemoveProcessing: '현재 처리 중인 파일은 삭제할 수 없습니다.',
    removedFromQueue: (name) => `대기열에서 제거됨: ${name}`,
    queueCleared: '대기열이 모두 삭제되었습니다.',
    pendingFilesRemoved: (n) => `대기 중인 ${n}개 파일이 삭제되었습니다.`,
    stopRequested: '처리 중지 요청됨. 현재 파일 완료 후 중지됩니다.',
    userStopped: '사용자가 처리를 중지했습니다.',
    unsupportedFormat: (name) => `지원되지 않는 파일 형식: ${name}`,
    processingFile: (idx, total, name) => `[${idx}/${total}] 처리 중: ${name}`,
    extractionComplete: (idx, total, name) => `[${idx}/${total}] 자막 추출 완료: ${name}`,
    cleaningMemory: '메모리 정리 중...',
    fileProcessed: (name) => `파일 처리 완료: ${name}`,
    allTasksComplete: (success, error, stopped) => `전체 작업 완료! (성공: ${success}개, 실패: ${error}개, 중지: ${stopped}개)`,
    translationProgress: '번역 진행: ',
    translationStarting: '번역 시작 중...',
    translationTranslatingProgress: (current, total) => `번역 중... ${current}/${total}`,
    translationTranslating: '번역 중...',
    translationCompleted: '번역 완료!',
    translationFailed: '번역 실패: ',
    // 동적 텍스트
    modelAvailableGroup: '사용 가능한 모델',
    modelNeedDownloadGroup: '다운로드 필요 (자동 다운로드됨)',
    modelStatusText: (count) => `${count}개 모델 사용 가능 | 부족한 모델은 자동 다운로드됩니다`,
    deviceStatusHtml: '<strong>GPU 권장:</strong> NVIDIA GPU가 있으면 훨씬 빠른 처리 가능<br><strong>CPU:</strong> GPU가 없거나 메모리 부족 시 안정적',
    translationEnabledHtml: '<strong>MyMemory 추천:</strong> 완전 무료, 안정적인 번역<br><strong>일일 5만글자</strong> 무료 (약 5시간 분량)',
    translationDisabledHtml: '번역을 사용하지 않습니다.',
    translationDeeplHtml: '<strong>DeepL:</strong> 월 50만글자 무료, API키 필요<br><strong>고품질</strong> 번역 서비스',
    translationChatgptHtml: '<strong>GPT-5-nano:</strong> 사용자 API 키 필요<br><strong>자연스러운</strong> 번역 가능',
    // 셀렉트 옵션
    langAutoOption: '자동 감지 (각 파일별로 자동 판별)',
    deviceAuto: '자동 (GPU 있으면 GPU, 없으면 CPU)',
    deviceCuda: 'GPU (CUDA) - 빠른 처리',
    deviceCpu: 'CPU - 안정적 처리',
    trNone: '번역 안함',
    trMyMemory: 'MyMemory (일 5만글자 무료, 추천)',
    trDeepL: 'DeepL (월 50만글자, API키 필요)',
    trChatGPT: 'GPT-5-nano (사용자 API 키 필요)',
    // 큐/버튼/상태
    qWaiting: '대기 중', qProcessing: '처리 중', qTranslating: '번역 중', qCompleted: '완료', qError: '오류', qStopped: '중지됨', qUnsupported: '지원되지 않는 형식',
    btnOpen: '열기', btnRemove: '제거',
    // 진행 텍스트
    progressReady: '준비 중...', progressExtracting: '자막 추출 중...', progressTranslating: '번역 중...', progressPreparing: '자막 추출 준비 중...', progressCleaning: '메모리 정리 중...', progressProcessing: '처리 중...', progressComplete: '완료!',
    // 완료 텍스트
    allDoneNoTr: '모든 파일 처리 완료!', allDoneWithTr: '모든 파일(추출+번역) 처리 완료! 창을 닫아도 됩니다.',
    fileCompleteRemaining: (n) => `파일 완료! 대기 중인 파일 ${n}개가 있습니다. 처리 시작 버튼을 눌러주세요.`,
    processingNext: (n) => `다음 파일 처리 중... (남은 파일: ${n}개)`,
    statusLabel: '상태',
    runBtnCount: (n) => `${n}개 파일 처리 시작`,
    toastOpenFolder: '폴더 열기',
    downloadingModel: '모델 다운로드 중',
    labelTargetLanguage: '번역 대상 언어',
    targetLangNote: '번역을 사용할 때만 적용됩니다.',
    apiModalTitle: '번역 API 키 설정',
    labelDeeplKey: 'DeepL API 키 (선택사항)',
    labelOpenaiKey: 'OpenAI API 키 (선택사항)',
    testConnBtn: '연결 테스트',
    saveBtn: '저장',
    cancelBtn: '취소',
    mymemoryInfoHtml: 'MyMemory는 API 키 없이 무료로 사용할 수 있습니다.<br>무료 한도는 대략 IP 기준 일일 약 5만 글자 수준이며 상황에 따라 변동될 수 있습니다.<br><br><strong>사용법 안내:</strong><br>• API 키를 입력한 후 "연결 테스트"로 즉시 확인 가능<br>• 또는 키를 먼저 저장한 후 테스트할 수도 있습니다<br>• 저장하지 않고도 입력된 키로 실시간 테스트 지원',
    openaiLinkText: 'OpenAI API 키 발급 받기',
    openaiHelpSuffix: ' (유료)',
    deeplPlaceholder: 'DeepL API 키를 입력하세요 (무료 50만글자/월)',
    deeplHelpHtml: '<strong>무료 가입 방법:</strong><br>1. <a href="https://www.deepl.com/ko/pro-api" target="_blank">DeepL API 페이지</a> 접속<br>2. "API 무료로 시작하기" 클릭<br>3. 이메일 인증 후 API 키 복사<br>4. 월 50만글자 무료 사용!',
    openaiPlaceholder: 'OpenAI API 키를 입력하세요 (GPT-5-nano)',
    queueEmpty: '파일을 드래그하여 추가하세요',
    soundLabel: '알림음',
    soundTest: '테스트',
    settingsBtn: '설정',
    settingsModalTitle: '설정',
    soundSectionTitle: '알림음',
    soundEnabled: '알림음 사용',
    soundVolume: '볼륨',
    apiSectionTitle: '번역 API 키',
  },
  en: {
    titleText: 'WhisperSubTranslate',
    dropTitle: 'Drag & Drop Files',
    dropHint1: 'Drag your video files here',
    dropHint2: 'Supported: MP4, AVI, MKV, MOV, WMV',
    queueTitle: 'Processing Queue',
    clearQueueBtn: 'Clear Queue',
    openFolderBtn: 'Open Output Folder',
    labelModel: 'Model',
    labelLanguage: 'Language',
    langStatusInfo: 'Recommended: Auto-detect language per file\nFixed: Use the same language for all files',
    labelDevice: 'Processing Device',
    labelTranslation: 'Translation',
    runBtn: 'Start Extraction',
    runBtnProcessing: 'Processing...',
    clearQueueWaiting: 'Remove waiting files',
    clearQueueAll: 'Clear all queue',
    apiBtn: 'API Keys',
    selectFileBtn: 'Select Files',
    stopBtn: 'Stop',
    logTitle: 'Logs',
    cannotRemoveProcessing: 'Cannot remove file currently being processed.',
    removedFromQueue: (name) => `Removed from queue: ${name}`,
    queueCleared: 'Queue cleared.',
    pendingFilesRemoved: (n) => `${n} pending file(s) removed.`,
    stopRequested: 'Stop requested. Will stop after current file completes.',
    userStopped: 'User stopped processing.',
    unsupportedFormat: (name) => `Unsupported file format: ${name}`,
    processingFile: (idx, total, name) => `[${idx}/${total}] Processing: ${name}`,
    extractionComplete: (idx, total, name) => `[${idx}/${total}] Extraction complete: ${name}`,
    cleaningMemory: 'Cleaning memory...',
    fileProcessed: (name) => `File processed: ${name}`,
    allTasksComplete: (success, error, stopped) => `All tasks complete! (Success: ${success}, Failed: ${error}, Stopped: ${stopped})`,
    translationProgress: 'Translation progress: ',
    translationStarting: 'Starting translation...',
    translationTranslatingProgress: (current, total) => `Translating... ${current}/${total}`,
    translationTranslating: 'Translating...',
    translationCompleted: 'Translation completed!',
    translationFailed: 'Translation failed: ',
    modelAvailableGroup: 'Available Models',
    modelNeedDownloadGroup: 'Download Required (auto-download)',
    modelStatusText: (count) => `${count} models available | Missing models will be downloaded automatically`,
    deviceStatusHtml: '<strong>GPU recommended:</strong> Much faster if NVIDIA GPU is available<br><strong>CPU:</strong> Use when no GPU or memory is limited',
    translationEnabledHtml: '<strong>Recommended:</strong> MyMemory is free and stable<br><strong>~50K chars/day</strong> free (approx.)',
    translationDisabledHtml: 'Translation is disabled.',
    translationDeeplHtml: '<strong>DeepL:</strong> 500K chars/month free, API key required<br><strong>High quality</strong> translation service',
    translationChatgptHtml: '<strong>GPT-5-nano:</strong> User API key required<br><strong>Natural</strong> translation possible',
    langAutoOption: 'Auto-detect (per file)',
    deviceAuto: 'Auto (Use GPU if available, otherwise CPU)',
    deviceCuda: 'GPU (CUDA) - Fast',
    deviceCpu: 'CPU - Stable',
    trNone: 'No translation',
    trMyMemory: 'MyMemory (Free ~50K/day)',
    trDeepL: 'DeepL (Free 500K/month with API key)',
    trChatGPT: 'GPT-5-nano (Requires API key)',
    qWaiting: 'Waiting', qProcessing: 'Processing', qTranslating: 'Translating', qCompleted: 'Completed', qError: 'Error', qStopped: 'Stopped', qUnsupported: 'Unsupported format',
    btnOpen: 'Open', btnRemove: 'Remove',
    progressReady: 'Ready...', progressExtracting: 'Extracting...', progressTranslating: 'Translating...', progressPreparing: 'Preparing extraction...', progressCleaning: 'Cleaning up memory...', progressProcessing: 'Processing...', progressComplete: 'Complete!',
    allDoneNoTr: 'All files completed!', allDoneWithTr: 'All files (extract+translate) completed! You may close the window.',
    fileCompleteRemaining: (n) => `File completed! ${n} file(s) remaining in queue. Please click Start button.`,
    processingNext: (n) => `Processing next file... (${n} remaining)`,
    statusLabel: 'Status',
    runBtnCount: (n) => `Start processing ${n} files`,
    toastOpenFolder: 'Open folder',
    downloadingModel: 'Downloading model',
    labelTargetLanguage: 'Target language',
    targetLangNote: 'Applied only when translation is enabled.',
    apiModalTitle: 'Translation API Keys',
    labelDeeplKey: 'DeepL API Key (optional)',
    labelOpenaiKey: 'OpenAI API Key (optional)',
    testConnBtn: 'Test Connection',
    saveBtn: 'Save',
    cancelBtn: 'Cancel',
    mymemoryInfoHtml: 'MyMemory can be used for free without an API key.<br>Daily quota is roughly ~50K characters per IP (subject to change).<br><br><strong>Usage Guide:</strong><br>• Enter API keys and test immediately with "Test Connection"<br>• Or save keys first, then test saved keys<br>• Real-time testing supported without saving',
    openaiLinkText: 'Get OpenAI API Key',
    openaiHelpSuffix: ' (paid, low cost)',
    deeplPlaceholder: 'Enter DeepL API key (Free 500K chars/month)',
    deeplHelpHtml: '<strong>How to get free key:</strong><br>1. Visit <a href="https://www.deepl.com/pro-api" target="_blank">DeepL API page</a><br>2. Click "Start for free"<br>3. Verify email and copy API key<br>4. Enjoy 500K chars/month free',
    openaiPlaceholder: 'Enter OpenAI API key (GPT-5-nano)',
    queueEmpty: 'Drag files here to add',
    soundLabel: 'Sound',
    soundTest: 'Test',
    settingsBtn: 'Settings',
    settingsModalTitle: 'Settings',
    soundSectionTitle: 'Notification Sound',
    soundEnabled: 'Enable sound',
    soundVolume: 'Volume',
    apiSectionTitle: 'Translation API Keys',
  },
  ja: {
    titleText: 'WhisperSubTranslate',
    dropTitle: 'ファイルをドラッグ＆ドロップ',
    dropHint1: 'ここに動画ファイルをドラッグしてください',
    dropHint2: '対応形式: MP4, AVI, MKV, MOV, WMV',
    queueTitle: '処理キュー',
    clearQueueBtn: 'キューを削除',
    openFolderBtn: '出力フォルダ',
    labelModel: 'モデル選択',
    labelLanguage: '言語選択',
    langStatusInfo: '推奨: ファイルごとに自動検出\n固定: すべてのファイルで同じ言語を使用',
    labelDevice: '処理デバイス',
    labelTranslation: '翻訳設定',
    runBtn: '抽出開始',
    runBtnProcessing: '処理中...',
    clearQueueWaiting: '待機ファイルを削除',
    clearQueueAll: 'キュー全体を削除',
    apiBtn: 'APIキー設定',
    selectFileBtn: 'ファイルを選択',
    stopBtn: '停止',
    logTitle: '処理ログ',
    cannotRemoveProcessing: '処理中のファイルは削除できません。',
    removedFromQueue: (name) => `キューから削除: ${name}`,
    queueCleared: 'キューをクリアしました。',
    pendingFilesRemoved: (n) => `待機中の${n}件のファイルを削除しました。`,
    stopRequested: '停止要求を受けました。現在のファイル終了後に停止します。',
    userStopped: 'ユーザーが処理を停止しました。',
    unsupportedFormat: (name) => `未対応のファイル形式: ${name}`,
    processingFile: (idx, total, name) => `[${idx}/${total}] 処理中: ${name}`,
    extractionComplete: (idx, total, name) => `[${idx}/${total}] 抽出完了: ${name}`,
    cleaningMemory: 'メモリを整理中...',
    fileProcessed: (name) => `ファイル処理完了: ${name}`,
    allTasksComplete: (success, error, stopped) => `全作業完了！ (成功: ${success}件, 失敗: ${error}件, 停止: ${stopped}件)`,
    translationProgress: '翻訳進行: ',
    translationStarting: '翻訳を開始中...',
    translationTranslatingProgress: (current, total) => `翻訳中... ${current}/${total}`,
    translationTranslating: '翻訳中...',
    translationCompleted: '翻訳完了！',
    translationFailed: '翻訳失敗: ',
    modelAvailableGroup: '利用可能なモデル',
    modelNeedDownloadGroup: 'ダウンロードが必要（自動ダウンロード）',
    modelStatusText: (count) => `${count}件のモデルが利用可能 | 不足分は自動でダウンロードされます` ,
    deviceStatusHtml: '<strong>GPU 推奨:</strong> NVIDIA GPU があれば高速処理<br><strong>CPU:</strong> GPU がない場合やメモリ不足時に安定',
    translationEnabledHtml: '<strong>おすすめ:</strong> MyMemory は無料で安定した翻訳\n<strong>1日約5万文字</strong>（目安）',
    translationDisabledHtml: '翻訳は使用しません。',
    translationDeeplHtml: '<strong>DeepL:</strong> 月50万文字無料、APIキー必要<br><strong>高品質</strong>翻訳サービス',
    translationChatgptHtml: '<strong>GPT-5-nano:</strong> ユーザーAPIキー必要<br><strong>自然な</strong>翻訳が可能',
    langAutoOption: '自動検出（ファイルごと）',
    deviceAuto: '自動（GPUがあればGPU、なければCPU）',
    deviceCuda: 'GPU (CUDA) - 高速',
    deviceCpu: 'CPU - 安定',
    trNone: '翻訳しない',
    trMyMemory: 'MyMemory（無料 約5万/日）',
    trDeepL: 'DeepL（月50万/無料APIキー）',
    trChatGPT: 'GPT-5-nano（APIキー必要）',
    qWaiting: '待機中', qProcessing: '処理中', qTranslating: '翻訳中', qCompleted: '完了', qError: 'エラー', qStopped: '停止', qUnsupported: '未対応の形式',
    btnOpen: '開く', btnRemove: '削除',
    progressReady: '準備中...', progressExtracting: '抽出中...', progressTranslating: '翻訳中...', progressPreparing: '抽出の準備中...', progressCleaning: 'メモリを整理中...', progressProcessing: '処理中...', progressComplete: '完了！',
    allDoneNoTr: 'すべて完了！', allDoneWithTr: 'すべて完了（抽出＋翻訳）！ウィンドウを閉じても大丈夫です。',
    fileCompleteRemaining: (n) => `ファイル完了！待機中のファイル${n}件があります。処理開始ボタンを押してください。`,
    processingNext: (n) => `次のファイルを処理中... (残り${n}件)`,
    statusLabel: '状態',
    runBtnCount: (n) => `${n}件のファイルを処理開始`,
    toastOpenFolder: 'フォルダを開く',
    downloadingModel: 'モデルをダウンロード中',
    labelTargetLanguage: '翻訳対象言語',
    targetLangNote: '翻訳を使用する場合のみ適用されます。',
    apiModalTitle: '翻訳 API キー設定',
    labelDeeplKey: 'DeepL API キー（任意）',
    labelOpenaiKey: 'OpenAI API キー（任意）',
    testConnBtn: '接続テスト',
    saveBtn: '保存',
    cancelBtn: 'キャンセル',
    mymemoryInfoHtml: 'MyMemory は API キー不要で無料利用できます。<br>1 日あたり約 5 万文字（IP 単位、変動あり）。<br><br><strong>使用方法：</strong><br>• API キーを入力後「接続テスト」で即座に確認可能<br>• または先にキーを保存してからテストすることも可能<br>• 保存せずに入力したキーでリアルタイムテスト対応',
    openaiLinkText: 'OpenAI API キーを取得',
    openaiHelpSuffix: '（有料・低コスト）',
    deeplPlaceholder: 'DeepL API キーを入力（無料 50万文字/月）',
    deeplHelpHtml: '<strong>無料登録手順:</strong><br>1. <a href="https://www.deepl.com/ja/pro-api" target="_blank">DeepL API ページ</a>にアクセス<br>2. 「無料で開始」をクリック<br>3. メール認証後、API キーをコピー<br>4. 月 50 万文字まで無料',
    openaiPlaceholder: 'OpenAI API キーを入力 (GPT-5-nano)',
    queueEmpty: 'ファイルをドラッグして追加',
    soundLabel: '通知音',
    soundTest: 'テスト',
    settingsBtn: '設定',
    settingsModalTitle: '設定',
    soundSectionTitle: '通知音',
    soundEnabled: '通知音を使用',
    soundVolume: '音量',
    apiSectionTitle: '翻訳 API キー',
  },
  zh: {
    titleText: 'WhisperSubTranslate',
    dropTitle: '拖拽文件到此',
    dropHint1: '将视频文件拖到这里',
    dropHint2: '支持: MP4, AVI, MKV, MOV, WMV',
    queueTitle: '处理队列',
    clearQueueBtn: '清空队列',
    openFolderBtn: '打开输出文件夹',
    labelModel: '模型选择',
    labelLanguage: '语言选择',
    langStatusInfo: '推荐: 每个文件自动检测\n固定: 所有文件使用同一种语言',
    labelDevice: '处理设备',
    labelTranslation: '翻译设置',
    runBtn: '开始提取',
    runBtnProcessing: '处理中...',
    clearQueueWaiting: '删除等待文件',
    clearQueueAll: '清空全部队列',
    apiBtn: 'API 密钥设置',
    selectFileBtn: '选择文件',
    stopBtn: '停止',
    logTitle: '处理日志',
    cannotRemoveProcessing: '无法删除正在处理的文件。',
    removedFromQueue: (name) => `已从队列中删除: ${name}`,
    queueCleared: '队列已清空。',
    pendingFilesRemoved: (n) => `已删除${n}个等待中的文件。`,
    stopRequested: '已请求停止。当前文件完成后停止。',
    userStopped: '用户停止了处理。',
    unsupportedFormat: (name) => `不支持的文件格式: ${name}`,
    processingFile: (idx, total, name) => `[${idx}/${total}] 处理中: ${name}`,
    extractionComplete: (idx, total, name) => `[${idx}/${total}] 提取完成: ${name}`,
    cleaningMemory: '清理内存中...',
    fileProcessed: (name) => `文件处理完成: ${name}`,
    allTasksComplete: (success, error, stopped) => `全部任务完成！ (成功: ${success}个, 失败: ${error}个, 停止: ${stopped}个)`,
    translationProgress: '翻译进行: ',
    translationStarting: '开始翻译中...',
    translationTranslatingProgress: (current, total) => `翻译中... ${current}/${total}`,
    translationTranslating: '翻译中...',
    translationCompleted: '翻译完成！',
    translationFailed: '翻译失败: ',
    modelAvailableGroup: '可用模型',
    modelNeedDownloadGroup: '需要下载（自动）',
    modelStatusText: (count) => `可用模型 ${count} 个 | 缺失模型将自动下载` ,
    deviceStatusHtml: '<strong>推荐 GPU:</strong> 若有 NVIDIA GPU 速度更快<br><strong>CPU:</strong> 无 GPU 或内存不足时更稳定',
    translationEnabledHtml: '<strong>推荐:</strong> MyMemory 免费且稳定\n<strong>约5万字/天</strong>（参考）',
    translationDisabledHtml: '不使用翻译。',
    translationDeeplHtml: '<strong>DeepL:</strong> 每月50万字免费，需API密钥<br><strong>高质量</strong>翻译服务',
    translationChatgptHtml: '<strong>GPT-5-nano:</strong> 需用户API密钥<br><strong>自然</strong>翻译效果',
    langAutoOption: '自动检测（每个文件）',
    deviceAuto: '自动（有 GPU 用 GPU，否则 CPU）',
    deviceCuda: 'GPU (CUDA) - 快速',
    deviceCpu: 'CPU - 稳定',
    trNone: '不翻译',
    trMyMemory: 'MyMemory（免费 约5万/天）',
    trDeepL: 'DeepL（每月50万/需API密钥）',
    trChatGPT: 'GPT-5-nano（需API密钥）',
    qWaiting: '等待中', qProcessing: '处理中', qTranslating: '翻译中', qCompleted: '完成', qError: '错误', qStopped: '已停止', qUnsupported: '不支持的格式',
    btnOpen: '打开', btnRemove: '移除',
    progressReady: '准备中...', progressExtracting: '提取中...', progressTranslating: '翻译中...', progressPreparing: '准备提取...', progressCleaning: '清理内存中...', progressProcessing: '处理中...', progressComplete: '完成！',
    allDoneNoTr: '全部完成！', allDoneWithTr: '全部完成（提取+翻译）！可以关闭窗口。',
    fileCompleteRemaining: (n) => `文件完成！队列中还有 ${n} 个文件。请点击开始按钮。`,
    processingNext: (n) => `正在处理下一个文件... (剩余${n}个)`,
    statusLabel: '状态',
    runBtnCount: (n) => `开始处理 ${n} 个文件`,
    toastOpenFolder: '打开文件夹',
    downloadingModel: '正在下载模型',
    labelTargetLanguage: '目标语言',
    targetLangNote: '仅在启用翻译时生效。',
    apiModalTitle: '翻译 API 密钥设置',
    labelDeeplKey: 'DeepL API 密钥（可选）',
    labelOpenaiKey: 'OpenAI API 密钥（可选）',
    testConnBtn: '测试连接',
    saveBtn: '保存',
    cancelBtn: '取消',
    mymemoryInfoHtml: 'MyMemory 可无需 API 密钥免费使用。<br>每日配额约 5 万字符（按 IP，可能变化）。<br><br><strong>使用说明：</strong><br>• 输入 API 密钥后可通过"测试连接"立即验证<br>• 或者先保存密钥再进行测试<br>• 支持不保存直接用输入的密钥实时测试',
    openaiLinkText: '获取 OpenAI API 密钥',
    openaiHelpSuffix: '（付费，成本低）',
    deeplPlaceholder: '输入 DeepL API 密钥（每月免费 50万字符）',
    deeplHelpHtml: '<strong>免费获取方式：</strong><br>1. 访问 <a href="https://www.deepl.com/zh/pro-api" target="_blank">DeepL API 页面</a><br>2. 点击"免费开始"<br>3. 邮箱验证后复制密钥<br>4. 每月 50 万字符免费',
    openaiPlaceholder: '输入 OpenAI API 密钥 (GPT-5-nano)',
    queueEmpty: '拖拽文件添加',
    soundLabel: '提示音',
    soundTest: '测试',
    settingsBtn: '设置',
    settingsModalTitle: '设置',
    soundSectionTitle: '提示音',
    soundEnabled: '启用提示音',
    soundVolume: '音量',
    apiSectionTitle: '翻译 API 密钥',
  },
};

// 모델 이름 현지화
const MODEL_I18N = {
  ko: {
    tiny: 'tiny (39MB) - 가장 빠름, 낮은 정확도',
    base: 'base (74MB) - 빠름, 기본 정확도',
    small: 'small (244MB) - 빠른 처리',
    medium: 'medium (769MB) - 균형잡힌 성능',
    large: 'large (1550MB) - 느림, 높은 정확도',
    'large-v2': 'large-v2 (1550MB) - 개선된 정확도',
    'large-v3': 'large-v3 (1550MB) - 최신 버전',
  },
  en: {
    tiny: 'tiny (39MB) - Fastest, lower accuracy',
    base: 'base (74MB) - Fast, basic accuracy',
    small: 'small (244MB) - Fast processing',
    medium: 'medium (769MB) - Balanced',
    large: 'large (1550MB) - Slow, high accuracy',
    'large-v2': 'large-v2 (1550MB) - Improved accuracy',
    'large-v3': 'large-v3 (1550MB) - Latest version',
  },
  ja: {
    tiny: 'tiny (39MB) - 最速、低精度',
    base: 'base (74MB) - 高速、基本精度',
    small: 'small (244MB) - 高速処理',
    medium: 'medium (769MB) - バランス型',
    large: 'large (1550MB) - 低速、高精度',
    'large-v2': 'large-v2 (1550MB) - 精度向上',
    'large-v3': 'large-v3 (1550MB) - 最新版',
  },
  zh: {
    tiny: 'tiny (39MB) - 最快，精度较低',
    base: 'base (74MB) - 快，基础精度',
    small: 'small (244MB) - 处理快速',
    medium: 'medium (769MB) - 平衡',
    large: 'large (1550MB) - 慢，精度高',
    'large-v2': 'large-v2 (1550MB) - 精度提升',
    'large-v3': 'large-v3 (1550MB) - 最新版本',
  },
};

// 언어 이름 현지화 (대상/소스 공통 표시용)
const LANG_NAMES_I18N = {
  ko: { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', es: '스페인어', fr: '프랑스어', de: '독일어', it: '이탈리아어', pt: '포르투갈어', ru: '러시아어', hu: '헝가리어', ar: '아랍어' },
  en: { ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', hu: 'Hungarian', ar: 'Arabic' },
  ja: { ko: '韓国語', en: '英語', ja: '日本語', zh: '中国語', es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', it: 'イタリア語', pt: 'ポルトガル語', ru: 'ロシア語', hu: 'ハンガリー語', ar: 'アラビア語' },
  zh: { ko: '韩语', en: '英语', ja: '日语', zh: '中文', es: '西班牙语', fr: '法语', de: '德语', it: '意大利语', pt: '葡萄牙语', ru: '俄语', hu: '匈牙利语', ar: '阿拉伯语' },
};

// 장치/번역 메서드 옵션 현지화
const DEVICE_OPTIONS_I18N = (lang) => ({
  auto: I18N[lang].deviceAuto,
  cuda: I18N[lang].deviceCuda,
  cpu: I18N[lang].deviceCpu,
});
const TR_METHOD_I18N = (lang) => ({
  none: I18N[lang].trNone,
  mymemory: I18N[lang].trMyMemory,
  deepl: I18N[lang].trDeepL,
  chatgpt: I18N[lang].trChatGPT,
});

function rebuildLanguageSelectOptions(lang) {
  const d = I18N[lang];
  const sel = document.getElementById('languageSelect');
  if (!sel) return;
  const originalValue = sel.value;
  const codes = ['auto','ko','en','ja','zh','es','fr','de','it','pt','ru','hu','ar'];
  sel.innerHTML = '';
  codes.forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    if (code === 'auto') opt.textContent = d.langAutoOption; else opt.textContent = LANG_NAMES_I18N[lang][code] || code;
    sel.appendChild(opt);
  });
  if (codes.includes(originalValue)) sel.value = originalValue;
}

function rebuildDeviceSelectOptions(lang) {
  const sel = document.getElementById('deviceSelect');
  if (!sel) return;
  const original = sel.value;
  const map = DEVICE_OPTIONS_I18N(lang);
  ['auto','cuda','cpu'].forEach(v => {
    const o = sel.querySelector(`option[value="${v}"]`);
    if (o) o.textContent = map[v];
  });
  sel.value = original;
  const deviceStatus = document.getElementById('deviceStatus');
  if (deviceStatus) deviceStatus.innerHTML = I18N[lang].deviceStatusHtml;
}

function rebuildTranslationSelectOptions(lang) {
  const sel = document.getElementById('translationSelect');
  if (!sel) return;
  const original = sel.value;
  const map = TR_METHOD_I18N(lang);
  ['none','mymemory','deepl','chatgpt'].forEach(v => {
    const o = sel.querySelector(`option[value="${v}"]`);
    if (o) o.textContent = map[v];
  });
  sel.value = original;
  const translationStatus = document.getElementById('translationStatus');
  if (translationStatus) {
    if (original === 'none') translationStatus.innerHTML = I18N[lang].translationDisabledHtml; 
    else translationStatus.innerHTML = I18N[lang].translationEnabledHtml;
  }
}

function getModelDisplayName(lang, id) {
  const m = MODEL_I18N[lang] || MODEL_I18N.ko;
  return m[id] || id;
}

function rebuildTargetLanguageNames(lang) {
  const sel = document.getElementById('targetLanguageSelect');
  if (!sel) return;
  const map = LANG_NAMES_I18N[lang] || LANG_NAMES_I18N.ko;
  Array.from(sel.options).forEach(o => {
    if (o.value && map[o.value]) {
      // 예: 한국어 (ko)
      o.textContent = `${map[o.value]} (${o.value})`;
    }
  });
}

function updateProgressInitial(lang) {
  const t = document.getElementById('progressText');
  if (t && (!t.textContent || t.textContent.trim() === '' || t.textContent.includes('준비') || t.textContent.includes('Ready'))) {
    t.textContent = I18N[lang].progressReady;
  }
}

// applyI18n 확장: 동적 요소도 갱신
function applyI18n(lang) {
  currentUiLang = lang || 'ko';
  const d = I18N[currentUiLang] || I18N.ko;
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('titleText', d.titleText);
  setText('dropTitle', d.dropTitle);
  setText('dropHint1', d.dropHint1);
  setText('dropHint2', d.dropHint2);
  setText('queueTitle', d.queueTitle);
  setText('clearQueueBtn', d.clearQueueBtn);
  setText('openFolderBtn', d.openFolderBtn);
  setText('labelModel', d.labelModel);
  setText('labelLanguage', d.labelLanguage);
  const langInfo = document.getElementById('langStatusInfo'); if (langInfo) langInfo.innerText = d.langStatusInfo;
  setText('labelDevice', d.labelDevice);
  setText('labelTranslation', d.labelTranslation);
  setText('runBtn', d.runBtn);
  setText('settingsBtnText', d.settingsBtn);
  setText('selectFileBtn', d.selectFileBtn);
  setText('stopBtn', d.stopBtn);
  setText('logTitle', d.logTitle);
  // 새로 추가된 i18n 요소
  setText('labelTargetLanguage', d.labelTargetLanguage);
  const tnote = document.getElementById('targetLangNote'); if (tnote) tnote.textContent = d.targetLangNote;

  // 설정 모달 i18n
  setText('settingsModalTitle', d.settingsModalTitle);
  const soundSection = document.getElementById('soundSectionTitle');
  if (soundSection) soundSection.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> ${d.soundSectionTitle}`;
  setText('soundEnabledLabel', d.soundEnabled);
  setText('soundVolumeLabelModal', d.soundVolume);
  setText('soundTestLabelModal', d.soundTest);
  const apiSection = document.getElementById('apiSectionTitle');
  if (apiSection) apiSection.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> ${d.apiSectionTitle}`;
  setText('labelDeeplKey', d.labelDeeplKey);
  setText('labelOpenaiKey', d.labelOpenaiKey);
  const oLink = document.getElementById('openaiLink'); if (oLink) oLink.textContent = d.openaiLinkText;
  const oSuf = document.getElementById('openaiHelpSuffix'); if (oSuf) oSuf.textContent = d.openaiHelpSuffix;
  setText('testApiKeysBtn', d.testConnBtn);
  setText('saveSettingsBtn', d.saveBtn);
  // placeholders & help
  const deeplInput = document.getElementById('deeplApiKey'); if (deeplInput) deeplInput.placeholder = d.deeplPlaceholder;
  const deeplHelp = document.getElementById('deeplHelp'); if (deeplHelp) deeplHelp.innerHTML = d.deeplHelpHtml;
  const openaiInput = document.getElementById('openaiApiKey'); if (openaiInput) openaiInput.placeholder = d.openaiPlaceholder;

  // 동적 셀렉트/상태 갱신
  rebuildLanguageSelectOptions(currentUiLang);
  rebuildDeviceSelectOptions(currentUiLang);
  rebuildTranslationSelectOptions(currentUiLang);
  rebuildTargetLanguageNames(currentUiLang);
  updateProgressInitial(currentUiLang);

  updateModelSelect();
  updateQueueDisplay(); // 언어 변경 시 큐 표시도 즉시 업데이트
}

// updateModelSelect를 현지화 지원하도록 보강
function updateModelSelect() {
  const modelSelect = document.getElementById('modelSelect');
  const modelStatus = document.getElementById('modelStatus');
  
  modelSelect.innerHTML = '';
  
  const ids = ['tiny','base','small','medium','large','large-v2','large-v3'];
  const models = ids.map(id => ({ id, name: getModelDisplayName(currentUiLang, id) }));
  
  const availableGroup = document.createElement('optgroup');
  availableGroup.label = I18N[currentUiLang].modelAvailableGroup;
  
  const needDownloadGroup = document.createElement('optgroup');
  needDownloadGroup.label = I18N[currentUiLang].modelNeedDownloadGroup;
  
  let hasAvailable = false;
  let hasNeedDownload = false;
  
  models.forEach(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    
    if (availableModels[model.id]) {
      availableGroup.appendChild(option);
      hasAvailable = true;
      if (model.id === 'medium') option.selected = true; // 기본 선택
    } else {
      needDownloadGroup.appendChild(option);
      hasNeedDownload = true;
    }
  });
  
  if (hasAvailable) modelSelect.appendChild(availableGroup);
  if (hasNeedDownload) modelSelect.appendChild(needDownloadGroup);
  
  // Update status message (localized) (상태 메시지 업데이트, 현지화)
  const availableCount = Object.keys(availableModels).length;
  if (modelStatus) modelStatus.innerHTML = I18N[currentUiLang].modelStatusText(availableCount);

  // 모델 요구사항 표시 초기화 및 이벤트 리스너
  updateModelRequirements(modelSelect.value);
  modelSelect.addEventListener('change', (e) => updateModelRequirements(e.target.value));
}

// 모델별 시스템 요구사항 표시
function updateModelRequirements(modelId) {
  const requirementsEl = document.getElementById('modelRequirements');
  if (!requirementsEl) return;

  const requirements = {
    'tiny': { vram: '~1GB', ram: '~2GB', speed: '★★★★★' },
    'base': { vram: '~1GB', ram: '~2GB', speed: '★★★★☆' },
    'small': { vram: '~2GB', ram: '~4GB', speed: '★★★☆☆' },
    'medium': { vram: '~3GB', ram: '~6GB', speed: '★★☆☆☆' },
    'large': { vram: '~4GB', ram: '~8GB', speed: '★☆☆☆☆' },
    'large-v2': { vram: '~4GB', ram: '~8GB', speed: '★☆☆☆☆' },
    'large-v3': { vram: '~4GB', ram: '~8GB', speed: '★☆☆☆☆' }
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
    zh: `GPU: ${req.vram} VRAM / CPU: ${req.ram} RAM / 速度: ${req.speed}`
  };

  requirementsEl.textContent = texts[currentUiLang] || texts.en;
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
  const queueContainer = document.getElementById('queueContainer');
  const queueList = document.getElementById('queueList');
  const runBtn = document.getElementById('runBtn');
  const pauseBtn = document.getElementById('pauseBtn');
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
    if (pauseBtn) pauseBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    // 빈 상태 메시지 표시
    queueList.innerHTML = `<div class="queue-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>${d.queueEmpty || '파일을 드래그하여 추가하세요'}</span>
    </div>`;
    return;
  }
  
  if (isProcessing) {
    runBtn.textContent = d.qProcessing;  
    runBtn.disabled = true;
    runBtn.className = 'btn-secondary';
    stopBtn.style.display = 'inline-block';
    clearQueueBtn.textContent = d.clearQueueBtn.replace('전체 ', '').replace('대기 ', '');
  } else {
    // 대기 중인 파일만 카운트 (완료되지 않은 파일들)
    const pendingCount = fileQueue.filter(f => f.status !== 'completed' && f.status !== 'error' && f.status !== 'stopped').length;
    runBtn.textContent = typeof d.runBtnCount === 'function' ? d.runBtnCount(pendingCount) : d.runBtn;
    runBtn.disabled = pendingCount === 0;
    runBtn.className = pendingCount > 0 ? 'btn-success' : 'btn-secondary';
    stopBtn.style.display = 'none';
    clearQueueBtn.textContent = d.clearQueueBtn;
  }
  
  queueList.innerHTML = fileQueue.map((file, index) => {
    const fileName = file.path.split('\\').pop() || file.path.split('/').pop();
    const isValid = isVideoFile(file.path);
    
    let statusText = d.qWaiting;
    let itemClass = 'queue-item';
    
    if (file.status === 'completed') {
      statusText = d.qCompleted;
      itemClass = 'queue-item completed';
    } else if (file.status === 'processing') {
      statusText = d.qProcessing;
      itemClass = 'queue-item processing';
    } else if (file.status === 'stopped') {
      statusText = d.qStopped;
      itemClass = 'queue-item error';
    } else if (file.status === 'error') {
      statusText = d.qError;
      itemClass = 'queue-item error';
    } else if (!isValid) {
      statusText = d.qUnsupported;
      itemClass = 'queue-item error';
    }
    
    const maxPathLength = 80;
    const displayPath = file.path.length > maxPathLength ? 
      file.path.substring(0, maxPathLength) + '...' : 
      file.path;
    
    const btnOpen = d.btnOpen;
    const btnRemove = d.btnRemove;
    const processingBadge = `<span style="color: #ffc107; font-size: 12px; font-weight: 600;">${d.qProcessing}</span>`;
    
    return `
      <div class="${itemClass}">
        <div class="file-info">
          <div class="file-name">${fileName}</div>
          <div class="file-path" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${file.path}">${displayPath}</div>
          <div class="file-status">상태: ${statusText} ${file.progress ? `(${file.progress}%)` : ''}</div>
        </div>
        <div>
          ${file.status === 'completed' ? 
            `<button onclick="openFileLocation('${file.path.replace(/\\/g, '\\\\')}')" class="btn-success btn-sm">${btnOpen}</button>` : 
            file.status === 'processing' ?
            processingBadge :
            (file.status === 'error' || file.status === 'stopped') ?
            `<button onclick="removeFromQueue(${index})" class="btn-danger btn-sm">${btnRemove}</button>` :
            `<button onclick="removeFromQueue(${index})" class="btn-danger btn-sm">${btnRemove}</button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

// 진행 단계 텍스트도 현지화 사용
function startIndeterminate(maxCap, labelKey) {
  stopIndeterminate();
  const d = I18N[currentUiLang];
  const label = labelKey === 'extract' ? d.progressExtracting : d.progressTranslating;
  currentPhase = label;
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
  etaStartTime = null;
  etaLastUpdate = null;
  updateProgress(0, targetText);
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
  const output = document.getElementById('output');
  if (output) { output.textContent += text; output.scrollTop = output.scrollHeight; }
}

// addOutput도 현지화 적용
function addOutput(text) {
  appendOutputRaw(localizeLog(text));
}

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
    window.electronAPI.onTranslationProgress((data) => {
      const methodNow = document.getElementById('translationSelect')?.value;
      if (!methodNow || methodNow === 'none') return; // 번역 비활성 시 무시

      // completed 단계는 항상 처리해야 함 (자동 처리 로직 실행을 위해)
      if (!translationSessionActive && data?.stage !== 'completed') return; // 완료 이후 추가 이벤트 무시

      // 메시지를 I18N으로 생성
      let msg = '';
      if (data?.stage === 'starting') {
        msg = I18N[currentUiLang].translationStarting;
      } else if (data?.stage === 'translating') {
        if (data?.current && data?.total) {
          msg = I18N[currentUiLang].translationTranslatingProgress(data.current, data.total);
        } else {
          msg = I18N[currentUiLang].translationTranslating;
        }
      } else if (data?.stage === 'completed') {
        msg = I18N[currentUiLang].translationCompleted;
      } else if (data?.stage === 'error') {
        msg = I18N[currentUiLang].translationFailed + (data?.errorMessage || '');
      }

      if (msg) {
        addOutput(`${I18N[currentUiLang].translationProgress}${msg}\n`);
      }
      // 진행률 갱신 - 번역 진행률(0-100)을 전체 진행률(50-100)로 변환
      if (typeof data?.progress === 'number') {
        // 번역은 전체 작업의 50-100% 구간 (추출이 0-50%)
        const translationPct = Math.max(0, Math.min(100, data.progress));
        const overallPct = 50 + (translationPct / 100) * 50; // 50-100 범위로 매핑
        setProgressTarget(Math.max(lastProgress, overallPct), I18N[currentUiLang].progressTranslating);
      }
      if (data?.stage === 'completed' || data?.stage === 'error') {
        const isErrorStage = data?.stage === 'error';
        // 번역 완료: 100%로 설정 후 세션 종료
        stopIndeterminate();
        translationSessionActive = false;
        const stageProgressTarget = isErrorStage ? 95 : 100;
        setProgressTarget(Math.max(lastProgress, stageProgressTarget), data?.message || I18N[currentUiLang].progressTranslating);

        // 현재 처리 중인 파일을 completed로 마킹
        if (currentProcessingIndex >= 0 && currentProcessingIndex < fileQueue.length) {
          fileQueue[currentProcessingIndex].status = isErrorStage ? 'error' : 'completed';
          fileQueue[currentProcessingIndex].progress = isErrorStage ? 0 : 100;
          console.log(`[onTranslationProgress] 파일 상태 ${isErrorStage ? 'error' : 'completed'}로 변경, index:`, currentProcessingIndex);
        }

        // 단일 파일 처리 완료 후 잠시 대기 (메모리 정리 시간 확보)
        setTimeout(async () => {
          try {
            console.log('[onTranslationProgress] completed setTimeout executing, isProcessing:', isProcessing);
            updateQueueDisplay();

            // 대기 중인 파일이 더 있는지 확인
            const remainingFiles = fileQueue.filter(f =>
              f.status !== 'completed' &&
              f.status !== 'error' &&
              f.status !== 'stopped' &&
              f.status !== 'translating'
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

              const completedCount = fileQueue.filter(f => f.status === 'completed').length;
              const errorCount = fileQueue.filter(f => f.status === 'error').length;
              const stoppedCount = fileQueue.filter(f => f.status === 'stopped').length;

              // UX: 짧은 지연 후 100%로 마무리
              setTimeout(() => {
                setProgressTarget(100, I18N[currentUiLang].allDoneWithTr);
                showToast(I18N[currentUiLang].allDoneWithTr, { label: I18N[currentUiLang].toastOpenFolder, onClick: openOutputFolder });
                try {
                  playCompletionSound();
                } catch (error) {
                  console.log('[Audio] Failed to play completion sound:', error.message);
                }
                addOutput(`\n${I18N[currentUiLang].allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
              }, 400);
            }
          } catch (error) {
            console.error('[onTranslationProgress] autoProcessNext 에러:', error);
            addOutput(`자동 처리 중 오류: ${error.message}\n`);
          }
        }, 2000);
      }
    });
  }
  // progress-update는 더 이상 main.js에서 보내지 않음 (의사 진행률만 사용)
  // 호환성을 위해 핸들러는 유지하되, 실제로 호출되지 않음
  const origOnProgress = window.electronAPI.onProgressUpdate;
  if (typeof origOnProgress === 'function') {
    window.electronAPI.onProgressUpdate((data) => {
      // 사용하지 않음 - 의사 진행률(startIndeterminate)만 사용
    });
  }
}



// UI 언어 드롭다운 연동
function initUiLanguageDropdown() {
  const sel = document.getElementById('uiLanguageSelect');
  if (!sel) return;
  const apply = (lang) => { applyI18n(lang); };
  apply(sel.value || 'ko');
  sel.addEventListener('change', () => apply(sel.value));
}

// 번역 설정 초기화 (번역 안함일 때 대상 언어 숨김)
function initTranslationSelect() {
  const translationSelect = document.getElementById('translationSelect');
  const targetLanguageGroup = document.getElementById('targetLanguageGroup');
  const translationStatus = document.getElementById('translationStatus');
  if (!translationSelect || !targetLanguageGroup) return;
  const update = () => {
    const method = translationSelect.value;
    if (method === 'none') {
      targetLanguageGroup.style.display = 'none';
      if (translationStatus) translationStatus.innerHTML = I18N[currentUiLang].translationDisabledHtml;
    } else {
      targetLanguageGroup.style.display = '';
      if (translationStatus) {
        // 선택한 번역 방법에 따라 다른 메시지 표시
        if (method === 'mymemory') {
          translationStatus.innerHTML = I18N[currentUiLang].translationEnabledHtml;
        } else if (method === 'deepl') {
          translationStatus.innerHTML = I18N[currentUiLang].translationDeeplHtml;
        } else if (method === 'chatgpt') {
          translationStatus.innerHTML = I18N[currentUiLang].translationChatgptHtml;
        } else {
          translationStatus.innerHTML = I18N[currentUiLang].translationEnabledHtml;
        }
      }
    }
  };
  translationSelect.addEventListener('change', update);
  update();
}

// 전역 초기화
function initApp() {
  try {
    initUiLanguageDropdown();
  } catch (error) {
    console.error('[Init] Failed to initialize UI language dropdown:', error.message);
  }
  try {
    checkModelStatus();
  } catch (error) {
    console.error('[Init] Failed to check model status:', error.message);
  }
  try {
    updateQueueDisplay();
  } catch (error) {
    console.error('[Init] Failed to update queue display:', error.message);
  }
  try {
    initTranslationSelect();
  } catch (error) {
    console.error('[Init] Failed to initialize translation select:', error.message);
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
  // 드래그 하이라이트 초기화
  try {
    initDragHighlight();
  } catch (error) {
    console.error('[Init] Failed to initialize drag highlight:', error.message);
  }
}

// ===== Settings Modal 초기화 =====
function initSettingsModal() {
  const settingsBtn = document.getElementById('settingsBtn');
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

  // 설정 모달 열기
  settingsBtn.addEventListener('click', () => {
    showSettingsModal();
  });

  // 설정 모달 닫기
  closeSettingsBtn.addEventListener('click', () => {
    hideSettingsModal();
  });

  // 모달 외부 클릭시 닫기
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      hideSettingsModal();
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
    await saveApiKeys();
    // 설정 저장 완료 후 모달 닫기 (약간의 지연)
    setTimeout(() => {
      hideSettingsModal();
    }, 1500);
  });

  function updateVolumeRowState() {
    if (soundMuted) {
      soundVolumeRow.classList.add('disabled');
    } else {
      soundVolumeRow.classList.remove('disabled');
    }
  }
}

function showSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.add('active');
    // 모달이 열릴 때마다 현재 설정값 반영
    const soundEnabledCheckbox = document.getElementById('soundEnabledCheckbox');
    const soundVolumeSlider = document.getElementById('soundVolumeSliderModal');
    const soundVolumeValue = document.getElementById('soundVolumeValueModal');
    const soundVolumeRow = document.getElementById('soundVolumeRow');

    if (soundEnabledCheckbox) soundEnabledCheckbox.checked = !soundMuted;
    if (soundVolumeSlider) soundVolumeSlider.value = Math.round(soundVolume * 100);
    if (soundVolumeValue) soundVolumeValue.textContent = `${Math.round(soundVolume * 100)}%`;
    if (soundVolumeRow) {
      if (soundMuted) {
        soundVolumeRow.classList.add('disabled');
      } else {
        soundVolumeRow.classList.remove('disabled');
      }
    }
  }
  // API 키 로드
  try {
    window.electronAPI.loadApiKeys().then(res => {
      if (res && res.success && res.keys) {
        const { deepl, openai } = res.keys;
        const deeplInput = document.getElementById('deeplApiKey');
        const openaiInput = document.getElementById('openaiApiKey');
        if (deeplInput) deeplInput.value = deepl || '';
        if (openaiInput) openaiInput.value = openai || '';
      }
    }).catch(() => {});
  } catch (_) {}
}

function hideSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.remove('active');
    // 상태 메시지 초기화
    const status = document.getElementById('apiKeyStatus');
    if (status) status.style.display = 'none';
  }
}

// initApp은 첫 번째 DOMContentLoaded에서 호출됨

async function playCompletionSound() {
  // 음소거 상태면 재생 안 함
  if (soundMuted || soundVolume <= 0) return;

  try {
    // 우선 WAV 파일 재생 시도 (앱 루트에 존재하는 경우)
    // Electron에서는 file:// 프로토콜 또는 절대 경로가 필요할 수 있음
    const audio = new Audio('./nya.wav');
    audio.volume = soundVolume;

    // 로드 완료 대기 후 재생
    await new Promise((resolve, reject) => {
      audio.oncanplaythrough = resolve;
      audio.onerror = reject;
      audio.load();
    });

    await audio.play();
    console.log('[Audio] nya.wav played successfully');
    return;
  } catch (error) {
    console.warn('[Audio] WAV file failed:', error.message);
    // 폴백: WebAudio로 간단한 3음 비프
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const sequence = [
      { freq: 880, dur: 0.12 },
      { freq: 1320, dur: 0.12 },
      { freq: 1760, dur: 0.18 }
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
  } catch (_) { /* ignore */ }
}

// ===== 드래그 영역 시각적 피드백 개선 =====
function initDragHighlight() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;

  let dragCounter = 0;

  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dropZone.classList.remove('drag-active');
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-active');
  });
}

// ===== API 키 검증 및 저장 =====
async function saveApiKeys() {
  const status = document.getElementById('apiKeyStatus');
  const deeplInput = document.getElementById('deeplApiKey');
  const openaiInput = document.getElementById('openaiApiKey');
  const keys = {
    deepl: deeplInput ? (deeplInput.value || '').trim() : '',
    openai: openaiInput ? (openaiInput.value || '').trim() : ''
  };

  const successMsg = {
    ko: '설정이 저장되었습니다.',
    en: 'Settings saved.',
    ja: '設定が保存されました。',
    zh: '设置已保存。'
  };
  const failMsg = {
    ko: '저장 실패',
    en: 'Save failed',
    ja: '保存に失敗しました',
    zh: '保存失败'
  };
  const errorMsg = {
    ko: '오류',
    en: 'Error',
    ja: 'エラー',
    zh: '错误'
  };

  try {
    const res = await window.electronAPI.saveApiKeys(keys);
    if (status) {
      if (res && res.success) {
        status.className = 'api-status success';
        status.textContent = successMsg[currentUiLang] || successMsg.ko;
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
  updateTranslationEngineOptions();
}

// ===== 번역 엔진 옵션 상태 업데이트 (API 키 없으면 비활성화) =====
async function updateTranslationEngineOptions() {
  const translationSelect = document.getElementById('translationSelect');
  if (!translationSelect) return;

  try {
    const res = await window.electronAPI.loadApiKeys();
    const keys = res?.success ? res.keys : {};
    const hasDeepL = !!(keys?.deepl?.trim());
    const hasOpenAI = !!(keys?.openai?.trim());

    // 옵션들 순회하며 API 키 필요한 엔진 비활성화
    Array.from(translationSelect.options).forEach(option => {
      if (option.value === 'deepl') {
        option.disabled = !hasDeepL;
        if (!hasDeepL && option.selected) {
          translationSelect.value = 'none';
          translationSelect.dispatchEvent(new Event('change'));
        }
      } else if (option.value === 'chatgpt') {
        option.disabled = !hasOpenAI;
        if (!hasOpenAI && option.selected) {
          translationSelect.value = 'none';
          translationSelect.dispatchEvent(new Event('change'));
        }
      }
    });
  } catch (error) {
    console.error('[updateTranslationEngineOptions] Error:', error);
  }
}

async function testApiKeys() {
  const status = document.getElementById('apiKeyStatus');

  // Checking message (확인 중 메시지)
  const checkingMsg = {
    ko: '잠시만요, 키 확인하고 있어요...',
    en: 'Hold on, checking your keys...',
    ja: 'ちょっと待って、キーを確認中...',
    zh: '稍等，正在验证密钥...'
  };

  if (status) {
    status.style.display = 'block';
    status.style.background = '#fff3cd';
    status.style.border = '1px solid #ffeeba';
    status.style.color = '#856404';
    status.textContent = checkingMsg[currentUiLang] || checkingMsg.ko;
  }

  try {
    // 현재 입력된 키들 수집
    const tempKeys = {};
    const deeplKey = document.getElementById('deeplApiKey')?.value?.trim();
    const openaiKey = document.getElementById('openaiApiKey')?.value?.trim();

    if (deeplKey) tempKeys.deepl = deeplKey;
    if (openaiKey) tempKeys.openai = openaiKey;

    console.log('[Frontend] Collected temp keys:', {
      hasDeepL: !!deeplKey,
      hasOpenAI: !!openaiKey,
      keysToTest: Object.keys(tempKeys)
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
          zh: '没有可测试的密钥，先输入一个吧！'
        };
        status.textContent = noKeyMessage[currentUiLang] || noKeyMessage.ko;
      }
      return;
    }

    const res = await window.electronAPI.validateApiKeys(tempKeys);
    if (!res || !res.success) throw new Error(res?.error || 'Validation failed');
    const { results } = res;
    const deeplOk = results?.deepl === true;
    const openaiOk = results?.openai === true;

    // Success/Failure messages (성공/실패 메시지)
    const successMsg = {
      ko: 'OK',
      en: 'OK',
      ja: 'OK',
      zh: 'OK'
    };

    const failMsg = {
      ko: '실패',
      en: 'Failed',
      ja: '失敗',
      zh: '失败'
    };

    // 입력된 키가 있는 서비스만 표시
    const messages = [];
    let successCount = 0;
    let totalCount = 0;

    // DeepL 키가 입력되어 있으면 결과 표시
    const deeplInput = document.getElementById('deeplApiKey')?.value?.trim();
    if (deeplInput) {
      totalCount++;
      if (deeplOk) successCount++;
      const deeplMsg = deeplOk
        ? `✓ DeepL ${successMsg[currentUiLang]}`
        : `✗ DeepL ${failMsg[currentUiLang]}`;
      messages.push(deeplMsg);
    }

    // OpenAI 키가 입력되어 있으면 결과 표시
    const openaiInput = document.getElementById('openaiApiKey')?.value?.trim();
    if (openaiInput) {
      totalCount++;
      if (openaiOk) successCount++;
      const openaiMsg = openaiOk
        ? `✓ GPT-5-nano ${successMsg[currentUiLang]}`
        : `✗ GPT-5-nano ${failMsg[currentUiLang]}`;
      messages.push(openaiMsg);
    }

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
      status.innerHTML = messages.join('<br>');
    } else if (status) {
      const pleaseEnterMsg = {
        ko: '키 먼저 입력!',
        en: 'Enter a key first!',
        ja: 'キーを入力して！',
        zh: '先输入密钥！'
      };
      status.style.display = 'block';
      status.style.background = '#fff3cd';
      status.style.border = '1px solid #ffeeba';
      status.style.color = '#856404';
      status.textContent = pleaseEnterMsg[currentUiLang] || pleaseEnterMsg.ko;
    }
  } catch (e) {
    if (status) {
      const errorMsg = {
        ko: '앗, 문제 발생',
        en: 'Oops, something went wrong',
        ja: 'あれ、問題が発生',
        zh: '哎呀，出问题了'
      };
      status.style.display = 'block';
      status.style.background = '#f8d7da';
      status.style.border = '1px solid #f5c6cb';
      status.style.color = '#721c24';
      status.textContent = `${errorMsg[currentUiLang]} - ${e.message || e}`;
    }
  }
}
