'use strict';

/**
 * Multi-model E2E — runs nya.wav through every installed model.
 * Verifies each model produces a valid SRT.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

let playwright;
try {
  playwright = require('playwright');
} catch (_) {
  console.log('[e2e-allmodels] playwright not installed — skipping.');
  process.exit(0);
}

const { _electron: electron } = playwright;

const ok = (m) => console.log('  ✓', m);

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
  await w.waitForTimeout(1500);

  const modelStatus = await w.evaluate(async () => await window.electronAPI.checkModelStatus());
  const installed = Object.keys(modelStatus || {}).filter((k) => modelStatus[k] === true || modelStatus[k]?.installed);
  ok(`installed models: ${installed.join(', ')}`);
  if (installed.length === 0) {
    console.log('no models installed, skip');
    await app.close();
    return;
  }

  const nya = path.join(ROOT, 'nya.wav');
  const results = [];

  for (const model of installed) {
    const t0 = Date.now();
    let res, err;
    try {
      res = await w.evaluate(
        async ({ file, model }) => {
          return await window.electronAPI.extractSubtitles({
            filePath: file,
            filePaths: [file],
            model,
            language: 'auto',
            device: 'cpu',
          });
        },
        { file: nya, model }
      );
    } catch (e) {
      err = e.message;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const srtPath = res?.srtFile || res?.results?.[0]?.srtPath;
    let srtText = null,
      valid = false;
    if (srtPath && fs.existsSync(srtPath)) {
      srtText = fs.readFileSync(srtPath, 'utf-8');
      valid = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(srtText);
    }
    const row = {
      model,
      success: !!(res && res.success && valid),
      elapsed_s: elapsed,
      srt_bytes: srtText ? srtText.length : 0,
      preview: srtText ? srtText.replace(/\n/g, ' | ').slice(0, 120) : null,
      error: err || res?.error || null,
    };
    results.push(row);
    console.log(
      `  ${row.success ? '✓' : '✗'} ${model}: ${elapsed}s, ${row.srt_bytes}B, preview="${row.preview || ''}"`
    );
  }

  await app.close();

  console.log('\n=== SUMMARY ===');
  console.table(results);
  console.log(`consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`);
  if (consoleErrors.length) console.error(consoleErrors);
  if (pageErrors.length) {
    console.error(pageErrors);
    process.exit(1);
  }
  const allOk = results.every((r) => r.success);
  console.log(allOk ? '[e2e-allmodels] ALL PASSED ✓' : '[e2e-allmodels] SOME FAILED ✗');
  process.exit(allOk ? 0 : 1);
}

run().catch((err) => {
  console.error('[e2e-allmodels] FAILED:', (err && err.stack) || err);
  process.exit(1);
});
