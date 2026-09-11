/* eslint-disable no-unused-vars -- feature scripts call these bootstrap helpers */
// Queue-based renderer for multi-file processing (memory-leak safe) (대기열 기반 렌더러 - 다중 파일 처리)
console.log('[Renderer] renderer modules v1.5.1 loaded');

async function initApp() {
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
    await checkModelStatus();
  } catch (error) {
    console.error('[Init] Failed to check model status:', error.message);
  }
  try {
    initTranslationSelect();
  } catch (error) {
    console.error('[Init] Failed to initialize translation select:', error.message);
  }
  try {
    await loadSavedSettings();
    console.log('[Init] Settings loaded successfully');
  } catch (error) {
    console.error('[Init] Failed to load saved settings:', error.message);
  }
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
  try {
    updateTranslationEngineOptions();
  } catch (error) {
    console.error('[Init] Failed to update translation engine options:', error.message);
  }
  try {
    await checkGpuCompatibility();
  } catch (error) {
    console.error('[Init] Failed to check GPU compatibility:', error.message);
  }
  try {
    initDragHighlight();
  } catch (error) {
    console.error('[Init] Failed to initialize drag highlight:', error.message);
  }
  try {
    initUpdateListener();
  } catch (error) {
    console.error('[Init] Failed to initialize update listener:', error.message);
  }
  try {
    initVersionBadge();
  } catch (error) {
    console.error('[Init] Failed to initialize version badge:', error.message);
  }
}

function initNavigation() {
  const setView = (view) => {
    const container = document.querySelector('.main-container');
    if (!container) return;
    if (view === 'workspace') container.removeAttribute('data-view');
    else {
      container.setAttribute('data-view', view);
      if (view === 'history') renderHistory();
      if (view === 'models') renderModels();
    }
    document.querySelectorAll('.rail-btn[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view);
    });
  };
  window.setView = setView;

  document.querySelectorAll('.rail-btn[data-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
  document.addEventListener('keydown', (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.getElementById('settingsModal')?.classList.contains('active')) return;
    if (event.key === '1') setView('workspace');
    else if (event.key === '2') setView('history');
    else if (event.key === '3') setView('models');
    else if (event.key === ',') showSettingsModal();
  });
}

function initDragHighlight() {
  const dropZone = document.getElementById('dropZone');
  if (!dropZone) return;
  let dragCounter = 0;
  dropZone.addEventListener('dragenter', (event) => {
    if (draggedItem) return;
    event.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-active');
  });
  dropZone.addEventListener('dragleave', (event) => {
    if (draggedItem) return;
    event.preventDefault();
    dragCounter--;
    if (dragCounter === 0) dropZone.classList.remove('drag-active');
  });
  dropZone.addEventListener('dragover', (event) => {
    if (draggedItem) return;
    event.preventDefault();
  });
  dropZone.addEventListener('drop', (event) => {
    if (draggedItem) return;
    event.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-active');
  });
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
  updateQueueDisplay();

  // 전역 초기화 함수 호출
  initApp();
});

// Update Check (업데이트 체크) - main process에서 푸시 방식
// =============================================

// 현재 표시 중인 업데이트 정보 저장 (언어 변경 시 배너 텍스트 업데이트용)
let currentUpdateInfo = null;

function initUpdateListener() {
  // main process에서 'update-available' 이벤트를 받아 배너 표시
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

  // main process의 update event에서 설정한 window.currentUpdateInfo 또는 renderer의 currentUpdateInfo 사용
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
