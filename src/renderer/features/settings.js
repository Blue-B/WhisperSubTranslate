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
  const tnote = document.getElementById('targetLangNote');
  if (tnote) {
    const method = document.getElementById('translationSelect')?.value;
    tnote.textContent = tnote.dataset.methodOverride ? d.engineSupportNote?.[method] || '' : d.targetLangNote;
  }

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
  const localProcessingSelect = document.getElementById('localProcessingSelect');
  localProcessingSelect?.addEventListener('change', () => {
    window.electronAPI.saveApiKeys({ localProcessingMode: localProcessingSelect.value }).catch((error) => {
      console.error('[Settings] Failed to save local processing mode:', error.message);
    });
  });
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

    const localProcessingSelect = document.getElementById('localProcessingSelect');
    if (localProcessingSelect) {
      localProcessingSelect.value = keys.localProcessingMode === 'auto' ? 'auto' : 'sequential';
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
    // Main merges this patch with the latest config; a stale full snapshot can overwrite newer changes.
    const keys = {};

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
    // Local controls share a row; align each menu with its own field.
    const card = wrapper.closest('.local-setting, .setting-card');
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
  const clickArea = wrapper.closest('.local-setting, #localModelGroup, .setting-card');
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
          const area = w.closest('.local-setting, #localModelGroup, .setting-card');
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
      const card = e.target.closest('.local-setting, .setting-card, #localModelGroup');
      if (!card) return;
      // Help disclosure and form controls handle their own interaction.
      if (e.target.closest('input, textarea, button, a, details, .custom-select-trigger, .custom-select-dropdown'))
        return;
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
// pi-lens-ignore: no-unused-vars
function syncCustomSelects() {
  document.querySelectorAll('.setting-card .setting-select[data-customized]').forEach((sel) => {
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// ===== Settings Modal 초기화 =====
// pi-lens-ignore: no-unused-vars
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

  initNavigation();

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

  initProviderSettings();
  document.getElementById('chooseOutputDirectory').addEventListener('click', async () => {
    const result = await window.electronAPI.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths?.[0]) {
      localStorage.setItem('outputDirectory', result.filePaths[0]);
      document.getElementById('outputDirectory').value = result.filePaths[0];
    }
  });
  document.getElementById('resetOutputDirectory').addEventListener('click', () => {
    localStorage.removeItem('outputDirectory');
    document.getElementById('outputDirectory').value = '';
  });
  document.getElementById('outputPolicy').addEventListener('change', (event) => {
    localStorage.setItem('outputPolicy', event.target.value);
  });
  document.getElementById('copyDiagnostics').addEventListener('click', async () => {
    const d = I18N[currentUiLang];
    try {
      const diagnostics = await window.electronAPI.getDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      showToast(d.diagnosticsCopied);
    } catch (_error) {
      showToast(d.diagnosticsFailed);
    }
  });

  document.getElementById('openErrorLogLocation').addEventListener('click', async () => {
    const d = I18N[currentUiLang];
    try {
      const result = await window.electronAPI.openErrorLogLocation();
      if (!result?.success) showToast(d.errorLogOpenFailed);
      else if (!result.exists) showToast(d.errorLogMissing);
    } catch (_error) {
      showToast(d.errorLogOpenFailed);
    }
  });

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

function getOutputOptions() {
  return {
    directory: localStorage.getItem('outputDirectory') || '',
    policy: localStorage.getItem('outputPolicy') || 'rename',
  };
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
    const outputOptions = getOutputOptions();
    document.getElementById('outputDirectory').value = outputOptions.directory;
    document.getElementById('outputPolicy').value = outputOptions.policy;
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
