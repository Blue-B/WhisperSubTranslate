// Queue-based renderer for multi-file processing (memory-leak safe) (대기열 기반 렌더러 - 다중 파일 처리)
console.log('[Renderer] renderer.js v1.3.3 loaded');

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
let _currentPhase = null; // 'extract' | 'translate' | null (reserved)
let translationSessionActive = false; // translation in progress (번역 진행 상태)

// UI 업데이트 디바운스 (UI freeze 방지)
let updateQueueDisplayTimer = null;
let lastQueueUpdateTime = 0;
const MIN_QUEUE_UPDATE_INTERVAL = 200; // 최소 200ms 간격으로 UI 업데이트

// Sound settings (알림음 설정)
let soundVolume = parseFloat(localStorage.getItem('soundVolume') ?? '0.6');
let soundMuted = localStorage.getItem('soundMuted') === 'true';

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ETA state (ETA 계산 상태)
let etaStartTime = null;
let _etaLastUpdate = null; // reserved for future ETA improvements
let _etaTotalWork = 100; // 0~100 스케일 (reserved)

function _formatETA(ms) {
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

// Check if file is SRT subtitle file (SRT 파일 확인)
function isSrtFile(filePath) {
  const ext = filePath.toLowerCase().substr(filePath.lastIndexOf('.'));
  return ext === '.srt';
}

// Check if queue contains only SRT files (큐에 SRT 파일만 있는지 확인)
function hasOnlySrtFiles() {
  if (fileQueue.length === 0) return false;
  return fileQueue.every(file => isSrtFile(file.path));
}

// Check if queue contains any SRT files (큐에 SRT 파일이 있는지 확인)
function hasAnySrtFiles() {
  return fileQueue.some(file => isSrtFile(file.path));
}

// Update UI mode based on queue contents (큐 내용에 따라 UI 모드 전환)
function updateUIMode() {
  const modelCard = document.getElementById('modelSelect')?.closest('.setting-card');
  const languageCard = document.getElementById('languageSelect')?.closest('.setting-card');
  const deviceCard = document.getElementById('deviceSelect')?.closest('.setting-card');
  const translationCard = document.getElementById('translationSelect')?.closest('.setting-card');
  const targetLanguageCard = document.getElementById('targetLanguageGroup');
  const translationSelect = document.getElementById('translationSelect');

  const srtOnlyMode = hasOnlySrtFiles();
  const hasSrt = hasAnySrtFiles();
  const d = I18N[currentUiLang] || I18N.ko;

  if (srtOnlyMode) {
    // SRT 전용 모드: 모델/언어/장치 숨기고, 번역 필수
    if (modelCard) modelCard.style.display = 'none';
    if (languageCard) languageCard.style.display = 'none';
    if (deviceCard) deviceCard.style.display = 'none';
    if (translationCard) {
      translationCard.style.display = '';
      // 번역 안함이 선택되어 있으면 자동으로 첫 번째 번역 옵션 선택
      if (translationSelect && translationSelect.value === 'none') {
        translationSelect.value = 'mymemory';
        // 대상 언어 표시
        if (targetLanguageCard) targetLanguageCard.style.display = '';
      }
    }
    // 드롭존 힌트 변경
    const dropHint1 = document.getElementById('dropHint1');
    if (dropHint1) dropHint1.textContent = d.srtModeHint || 'SRT 번역 모드 - 번역 방법을 선택하세요';
  } else {
    // 일반 모드: 모든 옵션 표시
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
    const warningText = d.mixedFileWarning || '동영상과 SRT 파일이 섞여 있습니다. 각 파일 유형에 맞게 처리됩니다.';

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
    if (translationValue === 'none') {
      const skipWarningText = d.srtWillBeSkipped || 'SRT 파일은 번역 설정이 없어 스킵됩니다. 번역 방법을 선택하세요.';
      mixedWarning.innerHTML = `<span>${warningText}</span><span class="skip-warning">${skipWarningText}</span>`;
    } else {
      mixedWarning.innerHTML = `<span>${warningText}</span>`;
    }
  } else {
    const mixedWarning = document.getElementById('mixedFileWarning');
    if (mixedWarning) mixedWarning.remove();
  }
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

// Update queue UI (대기열 UI 업데이트)
// Note: updateModelSelect is defined in the i18n section below (line ~1543)
function updateQueueDisplay() {
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
    const fullFileName = file.path.split('\\').pop() || file.path.split('/').pop();
    const isValid = isVideoFile(file.path) || isSrtFile(file.path);
    const isSrt = isSrtFile(file.path);

    // 확장자 추출 및 표시 이름 생성
    const ext = fullFileName.lastIndexOf('.') > 0 ? fullFileName.substring(fullFileName.lastIndexOf('.')) : '';
    const nameWithoutExt = fullFileName.substring(0, fullFileName.length - ext.length);
    const maxNameLength = 25;
    let displayName = nameWithoutExt;
    if (nameWithoutExt.length > maxNameLength) {
      displayName = nameWithoutExt.substring(0, maxNameLength) + '...';
    }
    // 확장자 뱃지 (SRT는 보라색, 비디오는 초록색) - 인라인 스타일 적용
    const extBadge = isSrt
      ? `<span style="display:inline-block;padding:2px 8px;margin-left:6px;font-size:11px;font-weight:700;border-radius:4px;color:#fff;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)">${ext.toUpperCase().substring(1)}</span>`
      : `<span style="display:inline-block;padding:2px 8px;margin-left:6px;font-size:11px;font-weight:700;border-radius:4px;color:#fff;background:linear-gradient(135deg,#4ade80 0%,#22c55e 100%)">${ext.toUpperCase().substring(1)}</span>`;

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
      statusText = d.qSkipped || '스킵됨';
      itemClass = 'queue-item skipped';
    } else if (file.status === 'error') {
      statusText = d.qError;
      itemClass = 'queue-item error';
    } else if (!isValid) {
      statusText = d.qUnsupported;
      itemClass = 'queue-item error';
    }

    // SRT 파일 추가 배지 (번역 표시)
    const srtBadge = isSrt ? `<span class="srt-badge">📄 ${d.srtBadge || 'SRT 번역'}</span>` : '';

    // Constrain filename to one line; ellipsis on overflow (파일명 한 줄 표시, 길면 ...)
    const maxPathLength = 80; // max path length (최대 경로 길이)
    const displayPath = file.path.length > maxPathLength ?
      file.path.substring(0, maxPathLength) + '...' :
      file.path;

    // 처리 중이 아닌 경우에만 드래그 가능
    const isDraggable = file.status !== 'processing' && file.status !== 'translating';
    const dragAttr = isDraggable ? `draggable="true" data-index="${index}"` : '';

    return `
      <div class="${itemClass}${isSrt ? ' srt-file' : ''}${isDraggable ? ' draggable' : ''}" ${dragAttr}>
        ${isDraggable ? `<div class="drag-handle" title="${d.dragHandleTooltip || '드래그하여 순서 변경'}">☰</div>` : ''}
        <div class="file-info">
          <div class="file-name"><span class="name-text" title="${fullFileName} (${d.clickToCopy || '클릭하여 복사'})" onclick="copyToClipboard('${fullFileName.replace(/'/g, "\\'")}', 'filename')">${displayName}</span>${extBadge} ${srtBadge}</div>
          <div class="file-path" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${file.path} (${d.clickToCopy || '클릭하여 복사'})" onclick="copyToClipboard('${file.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', 'path')">${displayPath}</div>
          <div class="file-status">${d.statusLabel || '상태'}: ${statusText} ${file.progress ? `(${file.progress}%)` : ''}</div>
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

  // 드래그 앤 드롭 이벤트 설정
  setupQueueDragAndDrop();
}

// 대기열 드래그 앤 드롭 설정
let draggedItem = null;
let draggedIndex = null;

function setupQueueDragAndDrop() {
  const queueList = document.getElementById('queueList');
  if (!queueList) return;

  const items = queueList.querySelectorAll('.queue-item.draggable');
  const dragHandles = queueList.querySelectorAll('.drag-handle');
  console.log('[DragDrop] 드래그 가능한 아이템:', items.length, '드래그 핸들:', dragHandles.length);

  items.forEach(item => {
    // 처음에는 드래그 비활성화 (핸들로만 드래그 가능하게)
    item.setAttribute('draggable', 'false');

    // 드래그 핸들에서만 드래그 시작 허용
    const handle = item.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', (e) => {
        console.log('[DragDrop] 핸들 mousedown - 드래그 활성화');
        item.setAttribute('draggable', 'true');
        e.stopPropagation(); // 이벤트 전파 방지
      });

      // 마우스 업 시 드래그 비활성화 복원
      handle.addEventListener('mouseup', () => {
        // dragend 에서 처리하므로 여기서는 불필요
      });
    }

    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', function(e) {
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
  console.log('[DragDrop] dragstart 이벤트 발생, index:', this.dataset.index);
  draggedItem = this;
  draggedIndex = parseInt(this.dataset.index);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedIndex);
}

function handleDragEnd(_e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.queue-item').forEach(item => {
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
  console.log('[DragDrop] drop 이벤트 발생, target:', this.dataset.index, 'dragged:', draggedIndex);

  const targetIndex = parseInt(this.dataset.index);
  if (targetIndex === draggedIndex || isNaN(targetIndex) || isNaN(draggedIndex)) {
    console.log('[DragDrop] drop 취소 - 같은 위치 또는 유효하지 않은 인덱스');
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
        { name: '동영상 및 자막 파일', extensions: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'srt'] },
        { name: '동영상 파일', extensions: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v'] },
        { name: '자막 파일 (SRT)', extensions: ['srt'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      result.filePaths.forEach(filePath => {
        addToQueue(filePath);
      });

      addOutput(`${I18N[currentUiLang].filesAddedToQueue(result.filePaths.length)}\n`);
    }
  } catch (error) {
    console.error('File select error:', error);
    addOutput(`${I18N[currentUiLang].fileSelectError(error.message)}\n`);
  }
}

// Queue management helpers (대기열 관리)
function addToQueue(filePath) {
  // deduplicate files (중복 파일 체크)
  if (fileQueue.some(file => file.path === filePath)) {
    addOutput(`${I18N[currentUiLang].alreadyInQueue(filePath.split('\\').pop())}\n`);
    return;
  }
  
  fileQueue.push({
    path: filePath,
    status: 'pending',
    progress: 0,
    addedAt: new Date()
  });

  updateQueueDisplay();
  updateUIMode(); // SRT/동영상 모드 전환
}

// Used in HTML onclick handlers
// eslint-disable-next-line no-unused-vars
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
    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
    addOutput(`${I18N[currentUiLang].queueCleared}\n`);
  } else {
    // when busy: remove only pending items (처리 중엔 대기 항목만 삭제)
    const pendingFiles = fileQueue.filter(file => file.status === 'pending');
    fileQueue = fileQueue.filter(file => file.status !== 'pending');

    updateQueueDisplay();
    updateUIMode(); // SRT/동영상 모드 전환
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

// eslint-disable-next-line no-unused-vars
function openFileLocation(filePath) {
  window.electronAPI.openFileLocation(filePath);
}

// 클립보드 복사 함수
// eslint-disable-next-line no-unused-vars
function copyToClipboard(text, type) {
  const d = I18N[currentUiLang] || I18N.ko;
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copyToast');
    toast.textContent = type === 'filename' ? d.fileNameCopied : d.pathCopied;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 1500);
  }).catch(err => {
    console.error('복사 실패:', err);
  });
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
        file.status !== 'skipped' &&
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

    addOutput(`\n${I18N[currentUiLang].allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
    return;
  }

  // 단일 파일 처리
  const i = fileIndex;
  const file = fileToProcess;

    // 현재 시작 시점의 번역 사용 여부를 캡쳐 (중간 변경과 무관하게 처리 일관성 확보)
    const methodAtStart = (document.getElementById('translationSelect')?.value || 'none');

    // SRT 파일 직접 번역 처리
    if (isSrtFile(file.path)) {
      const fileName = file.path.split('\\').pop() || file.path.split('/').pop();

      // SRT 파일은 번역만 수행 - 번역 방법이 선택되지 않으면 스킵
      if (methodAtStart === 'none') {
        file.status = 'skipped';
        updateQueueDisplay();
        const d = I18N[currentUiLang] || I18N.ko;
        addOutput(`⏭️ ${d.srtSkippedNoTranslation || 'SRT 파일 스킵 (번역 설정 없음)'}: ${fileName}\n`);
        // 다음 파일 처리 계속
        setTimeout(() => continueProcessing(), 100);
        return;
      }

      // 중지 요청 확인
      if (shouldStop) {
        addOutput(`${I18N[currentUiLang].userStopped}\n`);
        return;
      }

      console.log('[continueProcessing] SRT 파일 직접 번역 시작, index:', i, 'fileName:', fileName);
      currentProcessingIndex = i;
      file.status = 'translating';
      file.progress = 0;
      updateQueueDisplay();

      // 프로그래스바 초기화
      resetProgress('prepare');
      addOutput(`\n${I18N[currentUiLang].processingFile(i + 1, fileQueue.length, fileName)}\n`);

      const srtDirectMsg = {
        ko: 'SRT 파일 직접 번역 모드',
        en: 'Direct SRT file translation mode',
        ja: 'SRTファイル直接翻訳モード',
        zh: 'SRT文件直接翻译模式'
      };
      addOutput(`${srtDirectMsg[currentUiLang] || srtDirectMsg.ko}\n`);

      try {
        translationSessionActive = true;
        setProgressTarget(10, I18N[currentUiLang].translationStarting || '번역 시작 중...');

        // 번역 방식에 따른 안내 메시지
        let translationInfo = '';
        switch (methodAtStart) {
          case 'mymemory':
            translationInfo = 'MyMemory (무료)';
            break;
          case 'deepl':
            translationInfo = 'DeepL (API 키 확인 중...)';
            break;
          case 'chatgpt':
            translationInfo = 'GPT-5-nano (API 키 확인 중...)';
            break;
          case 'gemini':
            translationInfo = 'Gemini (API 키 확인 중...)';
            break;
          case 'offline':
            translationInfo = 'Offline (오프라인 번역)';
            break;
          default:
            translationInfo = methodAtStart;
        }

        addOutput(`${I18N[currentUiLang].translationStarting2(translationInfo)}\n`);

        const targetLang = (document.getElementById('targetLanguageSelect')?.value || 'ko');

        const translationResult = await window.electronAPI.translateSubtitle({
          filePath: file.path,
          method: methodAtStart,
          targetLang: targetLang
        });

        if (translationResult.success) {
          file.status = 'completed';
          file.progress = 100;
          translationSessionActive = false;
          setProgressTarget(100, I18N[currentUiLang].translationCompleted);
          addOutput(`${I18N[currentUiLang].translationDone(fileName.replace('.srt', ''), targetLang)}\n`);
        } else {
          file.status = 'error';
          file.progress = 0;
          translationSessionActive = false;
          addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(translationResult.error)}\n`);
        }
      } catch (error) {
        console.error('[continueProcessing] SRT translation error:', error);
        translationSessionActive = false;
        file.status = 'error';
        file.progress = 0;
        addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(error.message)}\n`);
      }

      updateQueueDisplay();

      // 다음 파일 처리
      const pendingFiles = fileQueue.filter(f => f.status === 'pending');
      if (pendingFiles.length > 0 && !shouldStop) {
        addOutput(`\n${I18N[currentUiLang].processingNext(pendingFiles.length)}\n`);
        setTimeout(() => continueProcessing(), 500);
      } else {
        // 모든 파일 처리 완료
        isProcessing = false;
        shouldStop = false;
        currentProcessingIndex = -1;
        updateQueueDisplay();

        const completedCount = fileQueue.filter(f => f.status === 'completed').length;
        const errorCount = fileQueue.filter(f => f.status === 'error').length;
        const stoppedCount = fileQueue.filter(f => f.status === 'stopped').length;

        setProgressTarget(100, I18N[currentUiLang].allDoneWithTr || '모두 완료!');
        showToast(I18N[currentUiLang].allDoneWithTr || '모두 완료!', { label: I18N[currentUiLang].toastOpenFolder, onClick: openOutputFolder });
        try {
          playCompletionSound();
        } catch (error) {
          console.log('[Audio] Failed to play completion sound:', error.message);
        }

        addOutput(`\n${I18N[currentUiLang].allTasksComplete(completedCount, errorCount, stoppedCount)}\n`);
      }
      return;
    }

    // 일반 비디오 파일 처리
    if (!isVideoFile(file.path)) {
      file.status = 'error';
      updateQueueDisplay();
      addOutput(`${I18N[currentUiLang].unsupportedFormat(file.path.split('\\').pop())}\n`);
      // 다음 파일 처리 계속
      setTimeout(() => continueProcessing(), 100);
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
        addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorStopped}: ${fileName}\n`);
      } else if (!result.success) {
        file.status = 'error';
        addOutput(`[${i + 1}/${fileQueue.length}] ${I18N[currentUiLang].errorFailed}: ${fileName} - ${getLocalizedError(result.error)}\n`);
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
              case 'gemini':
                translationInfo = 'Gemini (API 키 확인 중...)';
                break;
              case 'offline':
                translationInfo = 'Offline (오프라인 번역)';
                break;
              default:
                translationInfo = translationMethod;
            }

            addOutput(`${I18N[currentUiLang].translationStarting2(translationInfo)}\n`);

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
              addOutput(`${I18N[currentUiLang].translationDone(fileName, targetLang)}\n`);
            } else {
              addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(translationResult.error)}\n`);
            }
          } catch (error) {
            console.error('[continueProcessing] Translation error:', error);
            translationSessionActive = false;
            file.status = 'error';
            file.progress = 0;
            addOutput(`${I18N[currentUiLang].translationFailed}${getLocalizedError(error.message)}\n`);
            setProgressTarget(Math.max(lastProgress, 95), I18N[currentUiLang].translationFailed + getLocalizedError(error.message || ''));
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

  // 비밀번호 표시/숨기기 토글 버튼
  document.querySelectorAll('.toggle-password').forEach(btn => {
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
      btn.title = isPassword ? (d.togglePasswordHide || 'Hide password') : (d.togglePasswordShow || 'Show password');
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
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) return;
    e.preventDefault();
    dropZone.classList.remove('dragover');
  };

  dropZone.ondrop = (e) => {
    // 대기열 아이템 드래그 중이면 무시
    if (draggedItem) {
      console.log('[DragDrop] 파일 드롭존에서 대기열 드래그 무시');
      return;
    }
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
          addOutput(`${I18N[currentUiLang].cannotExtractPath(file.name)}\n`);
        }
      });

      if (addedCount > 0) {
        addOutput(`${I18N[currentUiLang].filesAddedToQueue(addedCount)}\n`);
      }
    } else {
      console.log('No files dropped');
      addOutput(`${I18N[currentUiLang].dropHint1}\n`);
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
    
    const lang = I18N[currentUiLang];
    const langDisplay = language === 'auto' ? lang.langAuto : language;
    const deviceDisplay = device === 'auto' ? lang.deviceAutoLabel : device === 'cuda' ? 'GPU' : 'CPU';

    addOutput(`\n${lang.processingStart(fileQueue.length)}\n`);
    addOutput(`${lang.processingInfo(model, langDisplay, deviceDisplay)}\n\n`);

    // 오프라인 번역 사전 준비
    if (translationMethod === 'offline') {
      addOutput(`${lang.offlineModelChecking}\n`);
      setProgressTarget(Math.max(lastProgress, 1), lang.offlineModelChecking);
      try {
        const warm = await window.electronAPI.warmupOfflineModel();
        if (warm?.success) {
          addOutput(`${lang.offlineModelReady}\n`);
        } else {
          addOutput(`${lang.offlineModelFailed(warm?.error || lang.errorUnknown)}\n`);
        }
      } catch (e) {
        addOutput(`${lang.offlineModelError(e.message)}\n`);
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
// I18N object moved to locales/i18n.js


// 에러 메시지 다국어 변환 헬퍼
function getLocalizedError(errorMessage) {
  if (!errorMessage) return I18N[currentUiLang].errorUnknown;

  const lang = I18N[currentUiLang];

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
  if (errorMessage.includes('whisper-cli.exe not found') || errorMessage.includes('whisper-cli.exe를 찾을 수 없음')) {
    return lang.errorWhisperNotFound;
  }
  if (errorMessage.includes('MyMemory daily quota exceeded')) {
    return lang.myMemoryQuotaExceeded;
  }
  if (errorMessage.includes('SRT file path missing') || errorMessage.includes('SRT 파일 경로')) {
    return lang.errorSrtPathMissing;
  }
  if (errorMessage.includes('empty translation') || errorMessage.includes('번역 결과가 비어')) {
    return lang.errorEmptyTranslation;
  }

  return errorMessage;
}

// 모델 이름 현지화
const MODEL_I18N = {
  ko: {
    tiny: 'tiny (39MB) - 가장 빠름, 낮은 정확도',
    base: 'base (74MB) - 빠름, 기본 정확도',
    small: 'small (244MB) - 빠른 처리',
    medium: 'medium (769MB) - 균형잡힌 성능',
    'large-v3-turbo': 'large-v3-turbo (809MB) - 빠르고 정확함 ⭐추천',
    large: 'large (1550MB) - 느림, 높은 정확도',
    'large-v2': 'large-v2 (1550MB) - 개선된 정확도',
    'large-v3': 'large-v3 (1550MB) - 최신 버전',
  },
  en: {
    tiny: 'tiny (39MB) - Fastest, lower accuracy',
    base: 'base (74MB) - Fast, basic accuracy',
    small: 'small (244MB) - Fast processing',
    medium: 'medium (769MB) - Balanced',
    'large-v3-turbo': 'large-v3-turbo (809MB) - Fast & accurate ⭐Recommended',
    large: 'large (1550MB) - Slow, high accuracy',
    'large-v2': 'large-v2 (1550MB) - Improved accuracy',
    'large-v3': 'large-v3 (1550MB) - Latest version',
  },
  ja: {
    tiny: 'tiny (39MB) - 最速、低精度',
    base: 'base (74MB) - 高速、基本精度',
    small: 'small (244MB) - 高速処理',
    medium: 'medium (769MB) - バランス型',
    'large-v3-turbo': 'large-v3-turbo (809MB) - 高速高精度 ⭐推奨',
    large: 'large (1550MB) - 低速、高精度',
    'large-v2': 'large-v2 (1550MB) - 精度向上',
    'large-v3': 'large-v3 (1550MB) - 最新版',
  },
  zh: {
    tiny: 'tiny (39MB) - 最快，精度较低',
    base: 'base (74MB) - 快，基础精度',
    small: 'small (244MB) - 处理快速',
    medium: 'medium (769MB) - 平衡',
    'large-v3-turbo': 'large-v3-turbo (809MB) - 快速精准 ⭐推荐',
    large: 'large (1550MB) - 慢，精度高',
    'large-v2': 'large-v2 (1550MB) - 精度提升',
    'large-v3': 'large-v3 (1550MB) - 最新版本',
  },
  pl: {
    tiny: 'tiny (39MB) - Najszybszy, niska dokładność',
    base: 'base (74MB) - Szybki, podstawowa dokładność',
    small: 'small (244MB) - Szybkie przetwarzanie',
    medium: 'medium (769MB) - Zrównoważony',
    'large-v3-turbo': 'large-v3-turbo (809MB) - Szybki i dokładny ⭐Zalecany',
    large: 'large (1550MB) - Wolny, wysoka dokładność',
    'large-v2': 'large-v2 (1550MB) - Ulepszona dokładność',
    'large-v3': 'large-v3 (1550MB) - Najnowsza wersja',
  },
};

// 언어 이름 현지화 (대상/소스 공통 표시용)
const LANG_NAMES_I18N = {
  ko: { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', es: '스페인어', fr: '프랑스어', de: '독일어', it: '이탈리아어', pt: '포르투갈어', ru: '러시아어', hu: '헝가리어', ar: '아랍어', pl: '폴란드어', fa: '페르시아어' },
  en: { ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', hu: 'Hungarian', ar: 'Arabic', pl: 'Polish', fa: 'Persian' },
  ja: { ko: '韓国語', en: '英語', ja: '日本語', zh: '中国語', es: 'スペイン語', fr: 'フランス語', de: 'ドイツ語', it: 'イタリア語', pt: 'ポルトガル語', ru: 'ロシア語', hu: 'ハンガリー語', ar: 'アラビア語', pl: 'ポーランド語', fa: 'ペルシア語' },
  zh: { ko: '韩语', en: '英语', ja: '日语', zh: '中文', es: '西班牙语', fr: '法语', de: '德语', it: '意大利语', pt: '葡萄牙语', ru: '俄语', hu: '匈牙利语', ar: '阿拉伯语', pl: '波兰语', fa: '波斯语' },
  pl: { ko: 'Koreański', en: 'Angielski', ja: 'Japoński', zh: 'Chiński', es: 'Hiszpański', fr: 'Francuski', de: 'Niemiecki', it: 'Włoski', pt: 'Portugalski', ru: 'Rosyjski', hu: 'Węgierski', ar: 'Arabski', pl: 'Polski', fa: 'Perski' },
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
  gemini: I18N[lang].trGemini,
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
  ['none','mymemory','deepl','chatgpt','gemini'].forEach(v => {
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
  setText('labelGeminiKey', d.labelGeminiKey);
  setText('testApiKeysBtn', d.testConnBtn);
  setText('saveSettingsBtn', d.saveBtn);
  // placeholders & help
  const deeplInput = document.getElementById('deeplApiKey'); if (deeplInput) deeplInput.placeholder = d.deeplPlaceholder;
  const deeplHelp = document.getElementById('deeplHelp'); if (deeplHelp) deeplHelp.innerHTML = d.deeplHelpHtml;
  const openaiInput = document.getElementById('openaiApiKey'); if (openaiInput) openaiInput.placeholder = d.openaiPlaceholder;
  const openaiHelp = document.getElementById('openaiHelp'); if (openaiHelp) openaiHelp.innerHTML = d.openaiHelpHtml;
  const geminiInput = document.getElementById('geminiApiKey'); if (geminiInput) geminiInput.placeholder = d.geminiPlaceholder;
  const geminiHelp = document.getElementById('geminiHelp'); if (geminiHelp) geminiHelp.innerHTML = d.geminiHelpHtml;
  // 토글 버튼 툴팁
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.title = d.togglePasswordShow || 'Show password';
  });

  // 동적 셀렉트/상태 갱신
  rebuildLanguageSelectOptions(currentUiLang);
  rebuildDeviceSelectOptions(currentUiLang);
  rebuildTranslationSelectOptions(currentUiLang);
  rebuildTargetLanguageNames(currentUiLang);
  updateProgressInitial(currentUiLang);

  updateModelSelect();
  updateQueueDisplay(); // 언어 변경 시 큐 표시도 즉시 업데이트
  updateUIMode(); // 언어 변경 시 혼합 파일 경고도 즉시 업데이트

  // 업데이트 배너 언어도 업데이트 (배너가 표시 중일 때)
  if (typeof updateBannerLanguage === 'function') {
    updateBannerLanguage();
  }
}

// updateModelSelect를 현지화 지원하도록 보강
function updateModelSelect() {
  const modelSelect = document.getElementById('modelSelect');
  const modelStatus = document.getElementById('modelStatus');

  // 현재 선택된 모델 저장 (언어 변경 시 유지)
  const previousValue = modelSelect.value;

  modelSelect.innerHTML = '';

  const ids = ['tiny','base','small','medium','large-v3-turbo','large','large-v2','large-v3'];
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
    } else {
      needDownloadGroup.appendChild(option);
      hasNeedDownload = true;
    }
  });

  if (hasAvailable) modelSelect.appendChild(availableGroup);
  if (hasNeedDownload) modelSelect.appendChild(needDownloadGroup);

  // 이전 선택 복원, 없으면 medium 기본 선택
  if (previousValue && ids.includes(previousValue)) {
    modelSelect.value = previousValue;
  } else if (availableModels['medium']) {
    modelSelect.value = 'medium';
  }
  
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

  // whisper.cpp uses GGML quantization - requires much less VRAM than PyTorch (~10GB)
  // Source: https://github.com/ggerganov/whisper.cpp
  // Tested: large-v3 works on 6GB VRAM GPU
  const requirements = {
    'tiny': { vram: '~1GB', ram: '~2GB', speed: '★★★★★' },
    'base': { vram: '~1GB', ram: '~2GB', speed: '★★★★☆' },
    'small': { vram: '~2GB', ram: '~4GB', speed: '★★★☆☆' },
    'medium': { vram: '~4GB', ram: '~5GB', speed: '★★☆☆☆' },
    'large': { vram: '~5GB', ram: '~8GB', speed: '★☆☆☆☆' },
    'large-v2': { vram: '~5GB', ram: '~8GB', speed: '★☆☆☆☆' },
    'large-v3': { vram: '~5GB', ram: '~8GB', speed: '★☆☆☆☆' },
    'large-v3-turbo': { vram: '~4GB', ram: '~4GB', speed: '★★★☆☆' }
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
      : `<span class="ext-badge video">${ext.toUpperCase().substring(1)}</span>`;

    const isValid = isVideoFile(file.path) || isSrtFile(file.path);

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
    } else if (file.status === 'skipped') {
      statusText = d.qSkipped || '스킵됨';
      itemClass = 'queue-item skipped';
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

    // 처리 중이 아닌 경우에만 드래그 가능
    const isDraggable = file.status !== 'processing' && file.status !== 'translating';
    const dragAttr = isDraggable ? `draggable="true" data-index="${index}"` : '';

    return `
      <div class="${itemClass}${isDraggable ? ' draggable' : ''}" ${dragAttr}>
        ${isDraggable ? `<div class="drag-handle" title="${d.dragHandleTooltip || '드래그하여 순서 변경'}">☰</div>` : ''}
        <div class="file-info">
          <div class="file-name"><span class="name-text" title="${fullFileName} (${d.clickToCopy || '클릭하여 복사'})" onclick="copyToClipboard('${fullFileName.replace(/'/g, "\\'")}', 'filename')">${displayName}</span>${extBadge}</div>
          <div class="file-path" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${file.path} (${d.clickToCopy || '클릭하여 복사'})" onclick="copyToClipboard('${file.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', 'path')">${displayPath}</div>
          <div class="file-status">${d.statusLabel || '상태'}: ${statusText} ${file.progress ? `(${file.progress}%)` : ''}</div>
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

  // 드래그 앤 드롭 이벤트 설정
  setupQueueDragAndDrop();
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
        msg = I18N[currentUiLang].translationFailed + getLocalizedError(data?.errorMessage || '');
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
            console.error('[onTranslationProgress] autoProcessNext error:', error);
            addOutput(`${I18N[currentUiLang].autoProcessError(error.message)}\n`);
          }
        }, 2000);
      }
    });
  }
  // progress-update는 더 이상 main.js에서 보내지 않음 (의사 진행률만 사용)
  // 호환성을 위해 핸들러는 유지하되, 실제로 호출되지 않음
  const origOnProgress = window.electronAPI.onProgressUpdate;
  if (typeof origOnProgress === 'function') {
    window.electronAPI.onProgressUpdate((_data) => {
      // 사용하지 않음 - 의사 진행률(startIndeterminate)만 사용
    });
  }
}



// UI 언어 드롭다운 연동 (설정 저장 포함)
function initUiLanguageDropdown() {
  const sel = document.getElementById('uiLanguageSelect');
  if (!sel) return;

  const apply = (lang) => { applyI18n(lang); };
  const validLangs = ['ko', 'en', 'ja', 'zh', 'pl'];

  // 저장된 언어 설정 불러오기 (config 파일에서)
  window.electronAPI.loadApiKeys().then(res => {
    if (res && res.success && res.keys && res.keys.uiLanguage) {
      const savedLang = res.keys.uiLanguage;
      if (validLangs.includes(savedLang)) {
        sel.value = savedLang;
        apply(savedLang);
      }
    }
  }).catch(() => {
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
  const targetLanguageSelect = document.getElementById('targetLanguageSelect');
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
        } else if (method === 'gemini') {
          translationStatus.innerHTML = I18N[currentUiLang].translationGeminiHtml;
        } else {
          translationStatus.innerHTML = I18N[currentUiLang].translationEnabledHtml;
        }
      }
    }
    // DeepL 선택 시 페르시아어(fa) 비활성화 (DeepL은 페르시아어 미지원)
    if (targetLanguageSelect) {
      const persianOption = targetLanguageSelect.querySelector('option[value="fa"]');
      if (persianOption) {
        persianOption.disabled = (method === 'deepl');
        // 페르시아어가 선택된 상태에서 DeepL로 변경 시 자동으로 영어로 전환
        if (method === 'deepl' && targetLanguageSelect.value === 'fa') {
          targetLanguageSelect.value = 'en';
        }
      }
    }
  };
  translationSelect.addEventListener('change', () => {
    update();
    // 혼합 모드 경고 업데이트 (SRT 스킵 예고)
    if (typeof updateUIMode === 'function') {
      updateUIMode();
    }
  });
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
        const optionExists = Array.from(modelSelect.options).some(opt => opt.value === keys.selectedModel);
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
        // 옵션이 존재하는지 확인 후 설정
        const optionExists = Array.from(translationSelect.options).some(opt => opt.value === keys.selectedTranslation);
        if (optionExists) {
          translationSelect.value = keys.selectedTranslation;
          console.log('[Settings] Restored translation:', keys.selectedTranslation);
        }
      }
    }

    // 번역 대상 언어 선택
    if (keys.selectedTargetLanguage) {
      const targetLanguageSelect = document.getElementById('targetLanguageSelect');
      if (targetLanguageSelect) {
        targetLanguageSelect.value = keys.selectedTargetLanguage;
        console.log('[Settings] Restored target language:', keys.selectedTargetLanguage);
      }
    }
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
    const targetLanguageSelect = document.getElementById('targetLanguageSelect');
    const uiLanguageSelect = document.getElementById('uiLanguageSelect');

    if (modelSelect) keys.selectedModel = modelSelect.value;
    if (languageSelect) keys.selectedLanguage = languageSelect.value;
    if (deviceSelect) keys.selectedDevice = deviceSelect.value;
    if (translationSelect) keys.selectedTranslation = translationSelect.value;
    if (targetLanguageSelect) keys.selectedTargetLanguage = targetLanguageSelect.value;
    if (uiLanguageSelect) keys.uiLanguage = uiLanguageSelect.value;

    await window.electronAPI.saveApiKeys(keys);
    console.log('[Settings] Auto-saved settings');
  } catch (error) {
    console.error('[Settings] Auto-save failed:', error.message);
  }
}

// 설정 변경 이벤트 연결
function initSettingsAutoSave() {
  const selects = [
    'modelSelect',
    'languageSelect',
    'deviceSelect',
    'translationSelect',
    'targetLanguageSelect'
  ];

  selects.forEach(id => {
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
async function initApp() {
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
        const { deepl, openai, gemini } = res.keys;
        const deeplInput = document.getElementById('deeplApiKey');
        const openaiInput = document.getElementById('openaiApiKey');
        const geminiInput = document.getElementById('geminiApiKey');
        if (deeplInput) deeplInput.value = deepl || '';
        if (openaiInput) openaiInput.value = openai || '';
        if (geminiInput) geminiInput.value = gemini || '';
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

      // 로드 완료 대기 후 재생
      await new Promise((resolve, reject) => {
        audio.oncanplaythrough = () => {
          console.log('[Audio] Audio loaded, ready to play');
          resolve();
        };
        audio.onerror = (e) => {
          console.error('[Audio] Audio load error:', e);
          reject(e);
        };
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
async function saveApiKeys() {
  const status = document.getElementById('apiKeyStatus');
  const deeplInput = document.getElementById('deeplApiKey');
  const openaiInput = document.getElementById('openaiApiKey');
  const geminiInput = document.getElementById('geminiApiKey');

  // API 키
  const keys = {
    deepl: deeplInput ? (deeplInput.value || '').trim() : '',
    openai: openaiInput ? (openaiInput.value || '').trim() : '',
    gemini: geminiInput ? (geminiInput.value || '').trim() : ''
  };

  // 앱 설정도 함께 저장
  const modelSelect = document.getElementById('modelSelect');
  const languageSelect = document.getElementById('languageSelect');
  const deviceSelect = document.getElementById('deviceSelect');
  const translationSelect = document.getElementById('translationSelect');
  const targetLanguageSelect = document.getElementById('targetLanguageSelect');
  const uiLanguageSelect = document.getElementById('uiLanguageSelect');

  if (modelSelect) keys.selectedModel = modelSelect.value;
  if (languageSelect) keys.selectedLanguage = languageSelect.value;
  if (deviceSelect) keys.selectedDevice = deviceSelect.value;
  if (translationSelect) keys.selectedTranslation = translationSelect.value;
  if (targetLanguageSelect) keys.selectedTargetLanguage = targetLanguageSelect.value;
  if (uiLanguageSelect) keys.uiLanguage = uiLanguageSelect.value;

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
    const geminiKey = document.getElementById('geminiApiKey')?.value?.trim();

    if (deeplKey) tempKeys.deepl = deeplKey;
    if (openaiKey) tempKeys.openai = openaiKey;
    if (geminiKey) tempKeys.gemini = geminiKey;

    console.log('[Frontend] Collected temp keys:', {
      hasDeepL: !!deeplKey,
      hasOpenAI: !!openaiKey,
      hasGemini: !!geminiKey,
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
    const geminiOk = results?.gemini === true;

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

    // Gemini 키가 입력되어 있으면 결과 표시
    const geminiInput = document.getElementById('geminiApiKey')?.value?.trim();
    if (geminiInput) {
      totalCount++;
      if (geminiOk) successCount++;
      const geminiMsg = geminiOk
        ? `✓ Gemini ${successMsg[currentUiLang]}`
        : `✗ Gemini ${failMsg[currentUiLang]}`;
      messages.push(geminiMsg);
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
