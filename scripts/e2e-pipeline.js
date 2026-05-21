'use strict';

/**
 * Full pipeline E2E — exercises the REAL whisper-cli + IPC end-to-end.
 *
 * Covers:
 *   1. check-model-status → enumerates installed _models/*.bin
 *   2. extract-subtitles → runs whisper-cli on nya.wav, produces a real .srt
 *   3. Verifies .srt content (non-empty, has timecode line)
 *
 * Does NOT download models or hit external APIs.
 * Skips gracefully if no model is installed.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

let playwright;
try {
  playwright = require('playwright');
} catch (_) {
  console.log('[e2e-pipeline] playwright not installed — skipping.');
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
  await w.waitForTimeout(1500);

  // -------------------------------------------------------------------------
  // 1. check-model-status
  // -------------------------------------------------------------------------
  const modelStatus = await w.evaluate(async () => {
    return await window.electronAPI.checkModelStatus();
  });
  const installed = Object.keys(modelStatus || {}).filter(
    (k) => modelStatus[k]?.installed || modelStatus[k] === true || modelStatus[k]?.exists
  );
  if (!modelStatus || typeof modelStatus !== 'object') fail('check-model-status returned non-object');
  console.log('  · model status:', JSON.stringify(modelStatus).slice(0, 200));
  ok(`check-model-status: ${Object.keys(modelStatus).length} keys, installed=${installed.length}`);

  // Pick the smallest available installed model
  const priority = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3', 'large-v2', 'large'];
  let pickedModel = null;
  for (const m of priority) {
    const entry = modelStatus[m];
    if (entry && (entry.installed || entry === true || entry.exists)) {
      pickedModel = m;
      break;
    }
  }
  if (!pickedModel) {
    // fallback: scan _models dir directly
    const modelsDir = path.join(ROOT, '_models');
    const bins = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir).filter((f) => f.endsWith('.bin')) : [];
    if (bins.length === 0) {
      console.log('[e2e-pipeline] no model installed and no _models/*.bin — skipping extraction.');
      await app.close();
      process.exit(0);
    }
    const fname = bins.sort(
      (a, b) => fs.statSync(path.join(modelsDir, a)).size - fs.statSync(path.join(modelsDir, b)).size
    )[0];
    pickedModel = fname.replace(/^ggml-/, '').replace(/\.bin$/, '');
    console.log('  · picked from _models dir:', pickedModel);
  }
  ok(`picked smallest installed model: ${pickedModel}`);

  // -------------------------------------------------------------------------
  // 2. extract-subtitles on nya.wav
  // -------------------------------------------------------------------------
  const nya = path.join(ROOT, 'nya.wav');
  if (!fs.existsSync(nya)) fail('nya.wav missing — cannot run extraction');
  console.log(`  · running whisper-cli on ${nya} with model=${pickedModel}, device=cpu...`);

  const t0 = Date.now();
  const result = await w.evaluate(
    async ({ file, model }) => {
      return await window.electronAPI.extractSubtitles({
        filePath: file,
        filePaths: [file],
        model,
        language: 'auto',
        device: 'cpu',
      });
    },
    { file: nya, model: pickedModel }
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  · extraction took ${elapsed}s, result=`, JSON.stringify(result).slice(0, 300));
  if (!result || result.success === false) fail(`extract-subtitles failed: ${JSON.stringify(result)}`);
  ok(`extract-subtitles: success=${result.success} (${elapsed}s)`);

  // -------------------------------------------------------------------------
  // 3. Verify SRT
  // -------------------------------------------------------------------------
  const srtPath = result.srtFile || (result.results && result.results[0]?.srtPath);
  if (!srtPath) fail('no srtFile / results[].srtPath in response');
  if (!fs.existsSync(srtPath)) fail(`SRT file not on disk: ${srtPath}`);
  const srtContent = fs.readFileSync(srtPath, 'utf-8');
  if (srtContent.length < 10) fail(`SRT empty: ${srtContent.length} bytes`);
  const hasTimecode = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(srtContent);
  if (!hasTimecode) fail(`SRT missing timecode line:\n${srtContent.slice(0, 300)}`);
  ok(`SRT valid: ${srtPath} (${srtContent.length} bytes, has timecode)`);
  console.log('  · SRT preview:', srtContent.slice(0, 200).replace(/\n/g, ' | '));

  await app.close();

  console.log(`\n[e2e-pipeline] consoleErrors=${consoleErrors.length} pageErrors=${pageErrors.length}`);
  if (consoleErrors.length) console.error('console errors:', consoleErrors);
  if (pageErrors.length) console.error('page errors:', pageErrors);
  if (pageErrors.length) process.exit(1);
  console.log('[e2e-pipeline] ALL PASSED ✓');
}

run().catch((err) => {
  console.error('[e2e-pipeline] FAILED:', (err && err.stack) || err);
  process.exit(1);
});
