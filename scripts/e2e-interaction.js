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

  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    timeout: 30000,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', E2E_SMOKE: '1' },
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
    const dropHint = await w.evaluate((L) => {
      window.__E2E_HOOK__.setUiLang(L);
      return document.getElementById('dropHint1')?.textContent || '';
    }, lang);
    if (pageErrors.length > before) fail(`Locale '${lang}' produced page error`);
    if (!dropHint) fail(`Locale '${lang}': dropHint1 empty`);
    ok(`Locale '${lang}': applied, hint="${dropHint.slice(0, 30)}..."`);
  }

  // -------------------------------------------------------------------------
  // 6. Empty queue
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

  // -------------------------------------------------------------------------
  // 7. Stress: rapid translation toggle (regression for the re-entrancy bug)
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
