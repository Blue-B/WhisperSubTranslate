/* eslint-disable no-unused-vars -- classic renderer globals are shared across feature scripts */
// Provider settings UI: tabs, model combos, provider cards, temporary key tests, and save helpers.

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

function initProviderSettings() {
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

  document.querySelectorAll('.provider-tab').forEach((tab) => {
    tab.addEventListener('click', () => showProviderPanel(tab.dataset.panel));
  });
  document.querySelectorAll('.model-refresh').forEach((btn) => {
    btn.addEventListener('click', () => refreshModelList(btn));
  });
  document.querySelectorAll('.provider-panel input[list]').forEach(initCombo);

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
}

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
