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
  // 추출 실시간 진행률(whisper -pp). main process가 stderr의 progress=N%를 파싱해 0~100으로 보냄.
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
