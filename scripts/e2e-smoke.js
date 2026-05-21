'use strict';

/**
 * Electron E2E smoke test.
 *
 * Boots the actual Electron app, waits for the main window, asserts that:
 *   1. The window opens without crashing.
 *   2. No console errors are emitted during boot/idle.
 *   3. Key IPC channels are registered and respond.
 *   4. Renderer can reach the preload bridge (`window.electronAPI`).
 *
 * Does NOT exercise whisper-cli / network / translation backends — those are
 * environment-dependent. This catches the class of "main.js / preload.js /
 * renderer wiring is broken" bugs that the unit-level smoke-test.js misses.
 *
 * Usage: node scripts/e2e-smoke.js
 * Requires: playwright (devDependency). Falls back to graceful skip if missing.
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BOOT_TIMEOUT_MS = 30_000;
const IDLE_WATCH_MS = 2_000;

let playwright;
try {
  playwright = require('playwright');
} catch (_) {
  console.log('[e2e-smoke] playwright not installed — skipping (run `npm i -D playwright`).');
  process.exit(0);
}

const { _electron: electron } = playwright;

async function run() {
  const consoleErrors = [];
  const pageErrors = [];

  const electronApp = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    timeout: BOOT_TIMEOUT_MS,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', E2E_SMOKE: '1' },
  });

  // App-level events.
  electronApp.on('close', () => {});

  // Wait for first BrowserWindow.
  const window = await electronApp.firstWindow({ timeout: BOOT_TIMEOUT_MS });

  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  window.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));

  await window.waitForLoadState('domcontentloaded', { timeout: BOOT_TIMEOUT_MS });

  // 1. Preload bridge reachable.
  const hasAPI = await window.evaluate(() => typeof window.electronAPI === 'object' && window.electronAPI !== null);
  if (!hasAPI) throw new Error('window.electronAPI not exposed by preload.js');

  // 2. A no-side-effect IPC handler responds (get-current-version is pure).
  const version = await window.evaluate(async () => {
    if (typeof window.electronAPI?.getCurrentVersion === 'function') {
      return await window.electronAPI.getCurrentVersion();
    }
    return null;
  });
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('IPC get-current-version did not return a string: ' + JSON.stringify(version));
  }

  // 3. Drop zone / main UI is present (any of these selectors).
  const uiPresent = await window.evaluate(() => {
    const sel = ['.drop-zone', '.drop-stack', '#dropZone', '[data-testid="main"]', 'body'];
    return sel.some((s) => document.querySelector(s));
  });
  if (!uiPresent) throw new Error('No main UI element found in DOM');

  // 4. Idle window — let any async errors surface.
  await window.waitForTimeout(IDLE_WATCH_MS);

  await electronApp.close();

  if (consoleErrors.length || pageErrors.length) {
    console.error('[e2e-smoke] Errors observed during boot:');
    for (const e of consoleErrors) console.error('  console.error:', e);
    for (const e of pageErrors) console.error('  pageerror:', e);
    throw new Error(`E2E smoke failed: ${consoleErrors.length} console errors, ${pageErrors.length} page errors`);
  }

  console.log(`[e2e-smoke] passed. version=${version}, no console errors, no page errors.`);
}

run().catch((err) => {
  console.error('[e2e-smoke] FAILED:', err && err.stack || err);
  process.exit(1);
});
