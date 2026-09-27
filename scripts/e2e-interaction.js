'use strict';

/**
 * E2E interaction test — drives real user scenarios via renderer globals.
 *
 * Covers:
 *   1. Video file in queue → normal mode (model/language cards visible)
 *   2. SRT-only mode → model/language hidden, translation card visible
 *   3. Mixed (video + SRT) → mixedFileWarning rendered
 *   4. Translation method select cycled (none/mymemory/deepl/chatgpt/gemini/local)
 *      — exercises the change listener that the re-entrancy guard protects
 *   5. UI language switch across all 5 locales (ko/en/ja/zh/pl)
 *   6. Empty queue → empty state with mascot
 *
 * Does NOT invoke whisper-cli or hit network. Purely renderer state + DOM.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let playwright;
try {
  playwright = require('playwright');
} catch (_) {
  console.log('[e2e-interaction] playwright not installed — skipping.');
  process.exit(0);
}

const { _electron: electron } = playwright;

const ok = (m) => console.log('  ✓', m);
const fail = (m) => {
  throw new Error(m);
};

async function run() {
  const consoleErrors = [];
  const pageErrors = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-e2e-interaction-'));

  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    timeout: 30000,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      E2E_SMOKE: '1',
      WHISPER_PORTABLE_DATA: userData,
    },
  });
  const w = await app.firstWindow({ timeout: 30000 });
  w.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  w.on('pageerror', (e) => pageErrors.push(String((e && e.stack) || e)));
  await w.waitForLoadState('domcontentloaded');
  await w.waitForTimeout(1500); // let renderer init
  const hookReady = await w.evaluate(() => !!window.__E2E_HOOK__);
  if (!hookReady) throw new Error('__E2E_HOOK__ not installed (preload E2E_SMOKE flag failed?)');

  // -------------------------------------------------------------------------
  // 1. Normal mode (1 video)
  // -------------------------------------------------------------------------
  await w.evaluate(() => {
    window.__E2E_HOOK__.setFileQueue([{ path: 'C:/fake/movie.mp4', name: 'movie.mp4', size: 1000, type: 'video' }]);
    window.__E2E_HOOK__.updateUIMode();
    window.__E2E_HOOK__.updateQueueDisplayImmediate();
  });
  let state = await w.evaluate(() => ({
    modelHidden: document.getElementById('modelSelect')?.closest('.setting-card')?.style.display === 'none',
    languageHidden: document.getElementById('languageSelect')?.closest('.setting-card')?.style.display === 'none',
    deviceHidden: document.getElementById('deviceSelect')?.closest('.setting-card')?.style.display === 'none',
    mixed: !!document.getElementById('mixedFileWarning'),
  }));
  if (state.modelHidden) fail('Normal mode: model card should be visible');
  if (state.languageHidden) fail('Normal mode: language card should be visible');
  if (state.deviceHidden) fail('Normal mode: device card should be visible');
  if (state.mixed) fail('Normal mode: should NOT have mixed warning');
  ok('Normal mode (video only): model/lang/device visible, no mixed warning');

  // -------------------------------------------------------------------------
  // 2. SRT-only mode
  // -------------------------------------------------------------------------
  await w.evaluate(() => {
    window.__E2E_HOOK__.setFileQueue([{ path: 'C:/fake/sub.srt', name: 'sub.srt', size: 100, type: 'srt' }]);
    document.getElementById('translationSelect').value = 'mymemory';
    window.__E2E_HOOK__.updateUIMode();
  });
  state = await w.evaluate(() => ({
    modelHidden: document.getElementById('modelSelect')?.closest('.setting-card')?.style.display === 'none',
    languageHidden: document.getElementById('languageSelect')?.closest('.setting-card')?.style.display === 'none',
    translationHidden: document.getElementById('translationSelect')?.closest('.setting-card')?.style.display === 'none',
    dropHint: document.getElementById('dropHint1')?.textContent,
  }));
  if (!state.modelHidden) fail('SRT mode: model card should be hidden');
  if (!state.languageHidden) fail('SRT mode: language card should be hidden');
  if (state.translationHidden) fail('SRT mode: translation card should be visible');
  if (!state.dropHint || state.dropHint.length < 3) fail('SRT mode: dropHint1 empty');
  ok('SRT-only mode: model/lang hidden, translation visible, hint changed');

  // -------------------------------------------------------------------------
  // 3. Mixed mode (video + SRT)
  // -------------------------------------------------------------------------
  await w.evaluate(() => {
    window.__E2E_HOOK__.setFileQueue([
      { path: 'C:/fake/movie.mp4', name: 'movie.mp4', size: 1000, type: 'video' },
      { path: 'C:/fake/sub.srt', name: 'sub.srt', size: 100, type: 'srt' },
    ]);
    window.__E2E_HOOK__.updateUIMode();
  });
  state = await w.evaluate(() => ({
    mixed: !!document.getElementById('mixedFileWarning'),
    modelHidden: document.getElementById('modelSelect')?.closest('.setting-card')?.style.display === 'none',
  }));
  if (!state.mixed) fail('Mixed mode: mixedFileWarning element should exist');
  if (state.modelHidden) fail('Mixed mode: model card should still be visible (has video)');
  ok('Mixed mode: warning rendered, model/lang still visible');

  // -------------------------------------------------------------------------
  // 4. Translation method cycle — the re-entrancy guard area
  // -------------------------------------------------------------------------
  const methods = ['none', 'mymemory', 'deepl', 'chatgpt', 'gemini', 'local'];
  for (const m of methods) {
    const before = pageErrors.length;
    await w.evaluate((method) => {
      const sel = document.getElementById('translationSelect');
      const has = Array.from(sel.options).some((o) => o.value === method);
      if (!has) throw new Error('translationSelect missing option: ' + method);
      sel.value = method;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      window.__E2E_HOOK__.updateUIMode();
    }, m);
    await w.waitForTimeout(150);
    if (pageErrors.length > before)
      fail(`Translation method '${m}' produced page error: ${pageErrors[pageErrors.length - 1]}`);
    ok(`Translation method '${m}': no recursion, no error`);
  }

  // -------------------------------------------------------------------------
  // 5. UI locale switch (5 langs)
  // -------------------------------------------------------------------------
  for (const lang of ['ko', 'en', 'ja', 'zh', 'pl']) {
    const before = pageErrors.length;
    const localized = await w.evaluate((L) => {
      window.__E2E_HOOK__.setUiLang(L);
      return {
        dropHint: document.getElementById('dropHint1')?.textContent || '',
        diskError: getLocalizedError('Not enough disk space: need 2.00 GB, free 1.00 GB'),
        // main 프로세스가 보내는 세 가지 whisper 실행 실패 메시지 원본.
        whisperMissing: getLocalizedError('whisper-cli.exe is missing from C:\\app\\resources\\whisper-cpp.'),
        whisperBlocked: getLocalizedError(
          'whisper-cli.exe could not be launched even though the file exists at ' +
            'C:\\app\\resources\\whisper-cpp\\whisper-cli.exe. A dependent library ' +
            '(whisper.dll or ggml*.dll) in the same folder is missing or blocked.'
        ),
        whisper127: getLocalizedError(
          'whisper-cli.exe started but stopped with exit code 127. A dependent library ' +
            'in the whisper-cpp folder is missing or blocked (antivirus quarantine is the usual cause).'
        ),
      };
    }, lang);
    if (pageErrors.length > before) fail(`Locale '${lang}' produced page error`);
    if (!localized.dropHint) fail(`Locale '${lang}': dropHint1 empty`);
    if (
      localized.diskError.includes('{') ||
      !localized.diskError.includes('2.00') ||
      !localized.diskError.includes('1.00')
    ) {
      fail(`Locale '${lang}': disk-space error was not localized: ${localized.diskError}`);
    }
    // 백신 격리(파일 없음)와 실행 차단(파일 있음)은 복구 방법이 달라
    // 같은 문구로 뭉개지면 안 된다. 경로 같은 원문이 그대로 노출되지도 않아야 한다.
    for (const [key, text] of Object.entries({
      whisperMissing: localized.whisperMissing,
      whisperBlocked: localized.whisperBlocked,
      whisper127: localized.whisper127,
    })) {
      if (!text) fail(`Locale '${lang}': ${key} produced an empty message`);
      if (text.includes('C:\\app') || text.includes('whisper-cpp folder')) {
        fail(`Locale '${lang}': ${key} was not localized: ${text}`);
      }
    }
    if (localized.whisperMissing === localized.whisperBlocked) {
      fail(`Locale '${lang}': missing and blocked whisper errors collapsed into one message`);
    }
    if (localized.whisper127 !== localized.whisperBlocked) {
      fail(`Locale '${lang}': exit code 127 was not classified as a blocked launch`);
    }
    ok(`Locale '${lang}': applied, hint="${localized.dropHint.slice(0, 30)}..."`);
  }

  // -------------------------------------------------------------------------
  // 6. Navigation and provider controls
  // -------------------------------------------------------------------------
  await w.locator('.rail-btn[data-view="history"]').click();
  if (!(await w.locator('.main-container').getAttribute('data-view')).includes('history')) {
    fail('History rail button did not switch the visible view');
  }
  await w.keyboard.press('1');
  if ((await w.locator('.main-container').getAttribute('data-view')) !== null) {
    fail('Workspace keyboard shortcut did not restore the workspace view');
  }
  await w.locator('#railSettingsBtn').click();
  while ((await w.locator('#settingsModal').getAttribute('aria-busy')) === 'true') await w.waitForTimeout(20);
  await w.locator('.provider-tab[data-panel="gemini"]').click();
  const providerControls = await w.evaluate(() => ({
    modalOpen: document.getElementById('settingsModal').classList.contains('active'),
    geminiVisible: !document.querySelector('.provider-panel[data-panel="gemini"]').hidden,
    deeplHidden: document.querySelector('.provider-panel[data-panel="deepl"]').hidden,
  }));
  if (!providerControls.modalOpen || !providerControls.geminiVisible || !providerControls.deeplHidden) {
    fail(`Provider tab control failed: ${JSON.stringify(providerControls)}`);
  }
  await w.evaluate(() => hideSettingsModal());
  ok('Navigation rail/keyboard and provider tab controls switch visible views');

  // -------------------------------------------------------------------------
  // 7. Settings unsaved-change guard
  // -------------------------------------------------------------------------
  const settingsGuard = await w.evaluate(async () => {
    showSettingsModal();
    while (document.getElementById('settingsModal')?.getAttribute('aria-busy') === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const prompt = document.getElementById('translationPrompt');
    prompt.value = 'UNSAVED_E2E_VALUE';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const originalConfirm = window.confirm;
    let confirmCalls = 0;
    window.confirm = () => {
      confirmCalls++;
      return false;
    };
    const refused = requestHideSettingsModal();
    const stayedOpen = document.getElementById('settingsModal').classList.contains('active');
    window.confirm = () => true;
    const discarded = requestHideSettingsModal();
    const closed = !document.getElementById('settingsModal').classList.contains('active');
    window.confirm = originalConfirm;
    return { refused, stayedOpen, discarded, closed, confirmCalls };
  });
  if (settingsGuard.refused || !settingsGuard.stayedOpen || !settingsGuard.discarded || !settingsGuard.closed) {
    fail(`Settings guard failed: ${JSON.stringify(settingsGuard)}`);
  }
  if (settingsGuard.confirmCalls !== 1) fail('Settings guard did not prompt exactly once before refusing close');
  ok('Settings: unsaved provider input blocks close until discard is confirmed');

  const saveRace = await w.evaluate(async () => {
    showSettingsModal();
    while (document.getElementById('settingsModal')?.getAttribute('aria-busy') === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const prompt = document.getElementById('translationPrompt');
    prompt.value = 'VALUE_AT_SAVE';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('saveSettingsBtn').click();
    prompt.value = 'EDIT_DURING_SAVE';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const active = document.getElementById('settingsModal').classList.contains('active');
    const value = prompt.value;
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    requestHideSettingsModal();
    window.confirm = originalConfirm;
    return { active, value };
  });
  if (!saveRace.active || saveRace.value !== 'EDIT_DURING_SAVE') {
    fail(`Settings save race lost new input: ${JSON.stringify(saveRace)}`);
  }
  ok('Settings: edits made during save remain dirty and keep the modal open');

  const settingsLoadRecovery = await w.evaluate(async () => {
    let attempts = 0;
    const failOnce = () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('E2E_SETTINGS_LOAD_FAILURE')) : window.electronAPI.loadApiKeys();
    };
    showSettingsModal(failOnce);
    while (!document.querySelector('#apiKeyStatus button')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const prompt = document.getElementById('translationPrompt');
    const lockedAfterFailure = prompt.disabled;
    document.querySelector('#apiKeyStatus button').click();
    while (document.getElementById('settingsModal')?.getAttribute('aria-busy') === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const unlockedAfterRetry = !prompt.disabled;
    const retryCleared = document.getElementById('apiKeyStatus').style.display === 'none';
    hideSettingsModal();
    return { attempts, lockedAfterFailure, unlockedAfterRetry, retryCleared };
  });
  const expectedLoadError = consoleErrors.findIndex((message) => message.includes('E2E_SETTINGS_LOAD_FAILURE'));
  if (expectedLoadError !== -1) consoleErrors.splice(expectedLoadError, 1);
  if (
    settingsLoadRecovery.attempts !== 2 ||
    !settingsLoadRecovery.lockedAfterFailure ||
    !settingsLoadRecovery.unlockedAfterRetry ||
    !settingsLoadRecovery.retryCleared
  ) {
    fail(`Settings load recovery failed: ${JSON.stringify(settingsLoadRecovery)}`);
  }
  ok('Settings: failed load stays locked and Retry restores editable values');

  const queueHeader = await w.evaluate(() => {
    const panel = document.getElementById('queueContainer');
    const title = document.getElementById('queueTitle');
    const actions = document.querySelector('.queue-actions');
    return {
      defaultWidth: panel.getBoundingClientRect().width,
      titleWidth: title.getBoundingClientRect().width,
      titleScrollWidth: title.scrollWidth,
      actionsBelowTitle: actions.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
    };
  });
  if (Math.abs(queueHeader.defaultWidth - 360) > 1) {
    fail(`Queue panel default width is not 360px: ${JSON.stringify(queueHeader)}`);
  }
  if (queueHeader.titleWidth + 1 < queueHeader.titleScrollWidth || !queueHeader.actionsBelowTitle) {
    fail(`Queue header is clipped at the 360px default: ${JSON.stringify(queueHeader)}`);
  }
  ok('Queue panel: default width is 360px');
  ok('Queue header: title stays visible with actions wrapped below at the default width');

  const comboSetup = await w.evaluate(async () => {
    showSettingsModal();
    while (document.getElementById('settingsModal')?.getAttribute('aria-busy') === 'true') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    showProviderPanel('gemini');
    const input = document.getElementById('geminiModel');
    input.scrollIntoView({ block: 'center' });
    const menu = input.parentElement.querySelector('.combo-menu');
    menu.replaceChildren();
    for (let index = 0; index < 100; index++) {
      addComboOption(menu, `gemini-test-${String(index).padStart(3, '0')}`, input);
    }
    positionComboMenu(menu);
    const body = document.querySelector('.modal-body');
    return {
      modalScrollTop: body.scrollTop,
      bodyLocked: body.classList.contains('combo-open') && getComputedStyle(body).overflowY === 'hidden',
    };
  });
  if (!comboSetup.bodyLocked) fail('Model combo did not lock the settings modal body');
  const combo = w.locator('.provider-panel[data-panel="gemini"] .combo-menu');
  const comboBox = await combo.boundingBox();
  if (!comboBox) fail('Model combo menu did not open');
  await w.mouse.move(comboBox.x + comboBox.width / 2, comboBox.y + comboBox.height / 2);
  await w.mouse.wheel(0, 240);
  const comboWheel = await w.evaluate(() => ({
    modalScrollTop: document.querySelector('.modal-body').scrollTop,
    menuScrollTop: document.querySelector('.provider-panel[data-panel="gemini"] .combo-menu').scrollTop,
  }));
  if (comboWheel.modalScrollTop !== comboSetup.modalScrollTop || comboWheel.menuScrollTop === 0) {
    fail(`Model combo wheel isolation failed: ${JSON.stringify({ comboSetup, comboWheel })}`);
  }
  await w.evaluate(() => {
    document.querySelector('.provider-panel[data-panel="gemini"] .combo-menu').scrollTop = 0;
  });
  await w.mouse.move(comboBox.x + comboBox.width - 3, comboBox.y + 14);
  await w.mouse.down();
  await w.mouse.move(comboBox.x + comboBox.width - 3, comboBox.y + Math.min(comboBox.height - 15, 160), {
    steps: 8,
  });
  await w.mouse.up();
  const comboDrag = await w.evaluate(() => {
    const body = document.querySelector('.modal-body');
    const menu = document.querySelector('.provider-panel[data-panel="gemini"] .combo-menu');
    const during = { modalScrollTop: body.scrollTop, menuScrollTop: menu.scrollTop };
    closeAllCombos();
    const unlocked = !body.classList.contains('combo-open') && getComputedStyle(body).overflowY === 'auto';
    hideSettingsModal();
    return { ...during, unlocked };
  });
  if (comboDrag.modalScrollTop !== comboSetup.modalScrollTop || comboDrag.menuScrollTop === 0 || !comboDrag.unlocked) {
    fail(`Model combo drag isolation failed: ${JSON.stringify({ comboSetup, comboDrag })}`);
  }
  ok('Settings model combo: wheel and scrollbar drag stay isolated, modal scrolling restores on close');

  // -------------------------------------------------------------------------
  // 8. Empty queue
  // -------------------------------------------------------------------------
  await w.evaluate(() => {
    window.__E2E_HOOK__.setFileQueue([]);
    window.__E2E_HOOK__.updateUIMode();
    window.__E2E_HOOK__.updateQueueDisplayImmediate();
  });
  const emptyState = await w.evaluate(() => {
    const el = document.querySelector('.queue-empty');
    return { hasEmpty: !!el, hasImg: !!document.querySelector('.queue-empty img, .queue-empty svg') };
  });
  if (!emptyState.hasEmpty) fail('Empty queue: .queue-empty element missing');
  ok(`Empty queue: empty state rendered (hasImg=${emptyState.hasImg})`);

  // Regression: idle 상태에서 대기열 삭제를 눌러도 진행 패널('자막 추출 준비 중...')이 나타나면 안 된다.
  const idleClear = await w.evaluate(() => {
    document.getElementById('clearQueueBtn').click();
    const container = document.getElementById('progressContainer');
    return {
      display: getComputedStyle(container).display,
      title: document.getElementById('progressTitle').textContent,
    };
  });
  if (idleClear.display !== 'none') {
    fail(`Idle clear-queue leaked the progress panel: ${JSON.stringify(idleClear)}`);
  }
  ok('Idle clear-queue: progress panel stays hidden');

  // -------------------------------------------------------------------------
  // 9. Stress: rapid translation toggle (regression for the re-entrancy bug)
  // -------------------------------------------------------------------------
  const stressBefore = pageErrors.length;
  await w.evaluate(() => {
    const sel = document.getElementById('translationSelect');
    const methods = ['none', 'mymemory', 'deepl', 'chatgpt', 'gemini', 'local'];
    for (let i = 0; i < 50; i++) {
      sel.value = methods[i % methods.length];
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await w.waitForTimeout(300);
  if (pageErrors.length > stressBefore)
    fail(`Stress: ${pageErrors.length - stressBefore} page errors from 50 rapid toggles`);
  ok('Stress: 50 rapid translation-method toggles, no recursion/error');

  // Match the client area of the supported minimum Windows window (1000x760).
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setContentSize(982, 713);
  });
  for (const lang of ['ko', 'en', 'ja', 'zh', 'pl']) {
    for (const method of ['none', 'local']) {
      await w.evaluate(
        ({ lang, method }) => {
          document.getElementById('modelSelect').value = 'large-v3-turbo';
          window.__E2E_HOOK__.setUiLang(lang === 'ko' ? 'en' : 'ko');
          const select = document.getElementById('translationSelect');
          select.value = method;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          const uiLanguage = document.getElementById('uiLanguageSelect');
          uiLanguage.value = lang;
          uiLanguage.dispatchEvent(new Event('change', { bubbles: true }));
          if (method === 'local') {
            const note = document.getElementById('targetLangNote').textContent;
            if (note !== I18N[lang].engineSupportNote.local) throw new Error(`Stale engine guidance in ${lang}`);
          }
        },
        { lang, method }
      );
      await w.waitForTimeout(100);
      const clipped = await w.evaluate(() => {
        const zone = document.querySelector('.dropzone').getBoundingClientRect();
        const clippedCards = [...document.querySelectorAll('.setting-card')].filter(
          (card) => card.getClientRects().length && card.scrollHeight > card.clientHeight + 1
        );
        if (clippedCards.length) throw new Error('Minimum window clips setting card descriptions');
        const cards = [...document.querySelectorAll('.settings-grid > .setting-card')];
        for (let i = 2; i < cards.length; i++) {
          if (!cards[i].getClientRects().length) continue;
          const previous = cards[i - 2].getBoundingClientRect();
          if (previous.bottom > cards[i].getBoundingClientRect().top + 1) {
            throw new Error('Minimum window overlaps settings rows');
          }
        }
        return ['.drop-title', '.drop-hint', '#selectFileBtn', '.drop-formats-row'].filter((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return rect.top < zone.top || rect.bottom > zone.bottom;
        });
      });
      if (clipped.length) fail(`Minimum window clips ${lang}/${method}: ${clipped.join(', ')}`);
    }
  }
  ok('Minimum Windows client area: drop instructions, file button and formats fit all five locales');

  // Real main → preload → renderer → DOM path, including mixed output chunks.
  for (const [lang, status] of [
    ['ja', '翻訳を開始します...'],
    ['zh', '开始翻译...'],
  ]) {
    await w.selectOption('#uiLanguageSelect', lang);
    const subtitle = '[00:00:01.000 --> 00:00:03.000]   Starting translation... 오류가 발생했습니다';
    const filename = 'Completed: /videos/Starting translation....mkv';
    await app.evaluate(({ BrowserWindow }, text) => {
      BrowserWindow.getAllWindows()[0].webContents.send('output-update', text);
    }, `Starting translation...\n${subtitle}\n${filename}\n`);
    await w.waitForFunction(
      ({ status, subtitle, filename }) => {
        const text = document.getElementById('output').textContent;
        return text.includes(status) && text.includes(subtitle) && text.includes(filename);
      },
      { status, subtitle, filename }
    );
  }
  ok('Real IPC log display: mixed status/subtitle chunks and English filename preserved in ja/zh');

  // Model-list replies are stubbed at IPC, not the renderer: exercise the real
  // button, provider handler, localization and toast without any API request.
  const modelCounts = [0, 1, 2, 5, 12, 22];
  await app.evaluate(({ ipcMain }, counts) => {
    ipcMain.removeHandler('list-provider-models');
    let next = 0;
    ipcMain.handle('list-provider-models', () => {
      const count = counts[next++ % counts.length];
      return { success: true, models: Array.from({ length: count }, (_, i) => `test-model-${i}`) };
    });
  }, modelCounts);
  for (const lang of ['ko', 'en', 'ja', 'zh', 'pl']) {
    const strings = require(path.join(ROOT, 'locales', `${lang}.json`));
    if (!strings.reduceRepetitionDesc.includes('large-v3')) fail(`Missing quiet-speech guidance: ${lang}`);
    if (!strings.dropHint1.includes('SRT')) fail(`Missing SRT input guidance: ${lang}`);
    await w.selectOption('#uiLanguageSelect', lang);
    await w.locator('#railSettingsBtn').click();
    await w.waitForFunction(() => document.getElementById('settingsModal').getAttribute('aria-busy') !== 'true');
    const hint = w.locator('#reduceRepetitionDesc');
    await hint.scrollIntoViewIfNeeded();
    if ((await hint.textContent()).trim() !== strings.reduceRepetitionDesc) fail(`Stale settings help: ${lang}`);
    const clipped = await hint.evaluate(
      (element) => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1
    );
    if (clipped) fail(`Clipped quiet-speech guidance: ${lang}`);
    if (process.env.E2E_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
      await w.screenshot({ path: path.join(process.env.E2E_SCREENSHOT_DIR, `settings-${lang}.png`) });
    }
    await w.locator('.provider-tab[data-panel="openai"]').click();
    const refresh = w.locator('button[data-target="openaiModel"]');
    for (const count of modelCounts) {
      await w.evaluate(() => document.querySelectorAll('.toast-notification').forEach((toast) => toast.remove()));
      await refresh.click();
      const expected = strings.modelsLoadedMessage.replace('{count}', String(count));
      await w.waitForFunction(
        (text) => [...document.querySelectorAll('.toast-notification')].some((el) => el.textContent === text),
        expected
      );
      await w.waitForFunction(() => !document.querySelector('button[data-target="openaiModel"]').disabled);
    }
    await w.evaluate(() => hideSettingsModal());
    ok(`Locale '${lang}': full help visible; model counts 0/1/2/5/12/22 rendered via real button and IPC`);
  }

  // Output controls and diagnostics: real buttons/IPC, isolated file-picker response.
  await w.selectOption('#uiLanguageSelect', 'en');
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, userData);
  await w.locator('#railSettingsBtn').click();
  await w.waitForFunction(() => document.getElementById('settingsModal').getAttribute('aria-busy') !== 'true');
  await w.locator('#chooseOutputDirectory').click();
  await w.waitForFunction((dir) => document.getElementById('outputDirectory').value === dir, userData);
  await w.selectOption('#outputPolicy', 'skip');
  await w.evaluate(() => {
    window.__diagnosticText = '';
    navigator.clipboard.writeText = async (text) => {
      window.__diagnosticText = text;
    };
  });
  await w.locator('#copyDiagnostics').click();
  await w.waitForFunction(() => !!window.__diagnosticText);
  // Malformed diagnostic JSON must fail this test; run().catch reports the error.
  // pi-lens-ignore: unchecked-throwing-call-js
  const diagnosticKeys = await w.evaluate(() => Object.keys(JSON.parse(window.__diagnosticText)).sort());
  const expectedKeys = [
    'version',
    'platform',
    'arch',
    'electron',
    'whisper',
    'cudaAvailable',
    'vulkanAvailable',
    'lastFailure',
  ].sort();
  if (JSON.stringify(diagnosticKeys) !== JSON.stringify(expectedKeys)) fail('Diagnostic payload leaked extra fields');
  await w.evaluate(() => hideSettingsModal());
  await w.locator('#railSettingsBtn').click();
  await w.waitForFunction(() => document.getElementById('settingsModal').getAttribute('aria-busy') !== 'true');
  if ((await w.inputValue('#outputPolicy')) !== 'skip') fail('Output policy did not persist');
  await w.locator('#resetOutputDirectory').click();
  await w.waitForFunction(() => document.getElementById('outputDirectory').value === '');
  await w.selectOption('#outputPolicy', 'rename');
  await w.evaluate(() => hideSettingsModal());
  ok('Output folder/policy persist; reset and private diagnostic copy buttons work');

  // Real translator + handler + UI. Only the network translation response is simulated.
  const retryInput = path.join(userData, 'retry.srt');
  fs.writeFileSync(retryInput, '1\n00:00:01,000 --> 00:00:02,000\nHello there\n');
  await app.evaluate(({ app }, root) => {
    const translator = process.mainModule.require(root + '/src/main/services/transcription').translator;
    translator.supportsContextAware = () => false;
    app.__translationCalls = [];
    let failJapanese = true;
    translator.translateBatch = async (_texts, _method, lang) => {
      app.__translationCalls.push(lang);
      if (lang === 'ja' && failJapanese) {
        failJapanese = false;
        throw new Error('synthetic retry failure');
      }
      return [lang === 'ko' ? '안녕하세요' : 'こんにちは'];
    };
  }, ROOT);
  await w.evaluate((input) => {
    localStorage.setItem('autoRetryFailed', 'false');
    document.getElementById('translationSelect').value = 'mymemory';
    document.getElementById('translationSelect').dispatchEvent(new Event('change', { bubbles: true }));
    for (const checkbox of document.querySelectorAll('#targetLanguageList input')) {
      checkbox.checked = ['ko', 'ja'].includes(checkbox.value);
    }
    clearQueue();
    addToQueue(input);
    updateQueueDisplayImmediate();
  }, retryInput);
  await w.locator('#runBtn').click();
  await w.waitForFunction(() => !isProcessing && fileQueue[0]?.partial === true);
  if (!(await w.locator('#queueList').textContent()).includes('Partial')) fail('Partial result missing from queue');
  await w.locator('#queueList button[data-action="retry"]').click();
  await w.locator('#runBtn').click();
  await w.waitForFunction(() => !isProcessing && fileQueue[0]?.status === 'completed');
  const calls = await app.evaluate(({ app }) => app.__translationCalls);
  if (JSON.stringify(calls) !== JSON.stringify(['ko', 'ja', 'ja'])) fail(`Wrong retry languages: ${calls}`);
  const historyResult = await w.evaluate(() => loadHistory().filter((item) => item.name === 'retry.srt'));
  if (historyResult.length !== 1 || historyResult[0].status !== 'success') fail('Retry history not updated');
  if (fs.existsSync(path.join(userData, 'retry_ko (1).srt'))) fail('Successful language was translated again');
  ok('Partial queue result → Retry button → only failed language runs; one successful history entry');

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });

  console.log(`\n[e2e-interaction] consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`);
  if (consoleErrors.length) console.error('console errors:', consoleErrors);
  if (pageErrors.length) console.error('page errors:', pageErrors);
  if (consoleErrors.length || pageErrors.length) process.exit(1);
  console.log('[e2e-interaction] ALL PASSED ✓');
}

run().catch((err) => {
  console.error('[e2e-interaction] FAILED:', (err && err.stack) || err);
  process.exit(1);
});
