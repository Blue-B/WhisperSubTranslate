// Both the terminal event and invoke result use the same state, regardless of arrival order.
function applyTranslationResult(file, result) {
  file.failedLangs = result.failedLangs || [];
  file.partial = file.failedLangs.length > 0 && Object.keys({ ...file.outputs, ...result.outputs }).length > 0;
  file.outputs = { ...file.outputs, ...result.outputs };
  file.outputPaths = [...new Set([...(file.outputPaths || []), ...(result.outputPaths || [])])];
  if (result.outputPath) file.outputPath = result.outputPath;
  file.status = result.userStopped
    ? 'stopped'
    : result.success === false || result.stage === 'error' || file.failedLangs.length
      ? 'error'
      : result.skipped
        ? 'skipped'
        : 'completed';
  file.progress = file.status === 'completed' || file.partial ? 100 : 0;
  saveFileToHistory(file, result.error || result.errorMessage);
}

function translationRequest(file, input, method, language) {
  const options =
    file.retryTranslation && file.translationOptions
      ? { ...file.translationOptions, targetLangs: [...file.failedLangs] }
      : {
          method,
          targetLangs: getSelectedTargetLangs(),
          sourceLang: language === 'auto' ? null : language,
          device: document.getElementById('deviceSelect')?.value || 'auto',
          localModelId: typeof getSelectedLocalModelId === 'function' ? getSelectedLocalModelId() : '1.8b',
          localProcessingMode: document.getElementById('localProcessingSelect')?.value || 'sequential',
          outputOptions: getOutputOptions(),
        };
  file.translationInput = input;
  file.translationOptions = options;
  file.retryTranslation = false;
  return { ...options, filePath: input, sessionId: _processingEpoch };
}

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
    if (retryFailedAutomatically()) return continueProcessing();
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
  const methodAtStart =
    (file.retryTranslation ? file.translationOptions?.method : null) ||
    document.getElementById('translationSelect')?.value ||
    'none';

  // A retry reuses the extracted SRT and only sends the failed target languages.
  if (isSrtFile(file.path) || file.retryTranslation) {
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

      const targetLangs = file.retryTranslation ? file.failedLangs : getSelectedTargetLangs();
      // 시작 로그에 타깃 언어 표시 — 기본값(한국어)을 모르고 돌렸다가 끝나고 알아차리는 일 방지. 다중 선택 시 쉼표로 나열.
      const targetLangNames = targetLangs
        .map((lc) => (I18N[currentUiLang].langNames || I18N.ko.langNames)[lc] || lc)
        .join(', ');
      addOutput(`${I18N[currentUiLang].translationStarting2(`${translationInfo} → ${targetLangNames}`)}\n`);

      const translationResult = await window.electronAPI.translateSubtitle(
        translationRequest(file, file.translationInput || file.path, methodAtStart, language)
      );

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
        applyTranslationResult(file, translationResult);
      } else {
        applyTranslationResult(file, translationResult);
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
    // 추출 시점에 main process가 자동으로 받고 진행률을 로그에 표시하므로 여기서 선다운로드하지 않는다.
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
      outputOptions: getOutputOptions(),
      // 메이저장 안 key면 기본 ON (whisper 반복/환각 억제)
      reduceRepetition: localStorage.getItem('reduceRepetition') !== 'false',
      // 자연 문장 단위 전사는 항상 ON (main process 기본값). 별도 토글 없음.
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

    if (result.skipped) {
      file.status = 'skipped';
      updateQueueDisplay();
      setTimeout(() => continueProcessing(), 100);
      return;
    }
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

          const translationResult = await window.electronAPI.translateSubtitle(
            translationRequest(file, srtPathFromResult, translationMethod, language)
          );
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
            applyTranslationResult(file, translationResult);
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
        file.outputPath = result.srtFile || result.results?.[0]?.srtPath;
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
    if (retryFailedAutomatically()) {
      await continueProcessing();
      return;
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
