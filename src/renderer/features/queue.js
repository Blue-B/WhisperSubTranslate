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
      file.retryTranslation = !!(file.failedLangs?.length && file.translationInput);
      file.status = 'pending';
      file.progress = 0;
      updateQueueDisplay();
    }
  }
}

// eslint-disable-next-line no-unused-vars -- processing.js/progress.js batch completion
function retryFailedAutomatically() {
  if (shouldStop || localStorage.getItem('autoRetryFailed') !== 'true') return false;
  let retried = false;
  fileQueue.forEach((file, index) => {
    if (file.status !== 'error' || (file.autoRetryCount || 0) >= AUTO_RETRY_MAX) return;
    file.autoRetryCount = (file.autoRetryCount || 0) + 1;
    retryQueueItem(index);
    retried = true;
  });
  return retried;
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
    const outputPath = firstFile.outputPath || firstFile.path;
    const sep = outputPath.includes('/') ? '/' : '\\';
    const folderPath = outputPath.substring(0, outputPath.lastIndexOf(sep));
    window.electronAPI.openFolder(folderPath);
  }
}

// 처리 계속 함수 (일시정지 재개 시에도 사용) - 전역 함수로 선언
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
        <img src="../../assets/px-empty-queue.png?v=3" alt="" aria-hidden="true"/>
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
          statusText = file.partial ? `${d.qPartial} (${file.failedLangs.join(', ')})` : d.qError;
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
            `<button class="btn-warning btn-sm" style="margin-right:4px;" data-action="retry" data-index="${index}">${escAttr(file.failedLangs?.length ? d.btnRetryFailedLanguages : d.btnRetry || 'Retry')}</button>` +
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
