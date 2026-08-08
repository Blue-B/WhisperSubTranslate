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
    ok(`Locale '${lang}': applied, hint="${localized.dropHint.slice(0, 30)}..."`);
  }

  // -------------------------------------------------------------------------
  // 6. Settings unsaved-change guard
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
  // 7. Empty queue
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
  // 8. Stress: rapid translation toggle (regression for the re-entrancy bug)
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
