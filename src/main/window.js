const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, Menu, dialog, shell } = require('electron');
const C = require('../shared/ipc-channels');
const { isAllowedExternalUrl } = require('./ipc/files');
const errLogger = require('./services/error-logger');

const SOURCE_ROOT = path.resolve(__dirname, '../..');
const RENDERER_FILE = path.join(SOURCE_ROOT, 'src', 'renderer', 'index.html');
let rendererReloadTimes = [];

function createWindow(app, transcription, checkForUpdates) {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1000,
    minHeight: 760,
    title: 'WhisperSubTranslate',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(SOURCE_ROOT, 'src', 'preload', 'index.js'),
      webSecurity: true,
      devTools: !app.isPackaged,
      autoplayPolicy: 'no-user-gesture-required',
    },
    icon: path.join(SOURCE_ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
  });

  transcription.setMainWindow(window);
  window.once('ready-to-show', () => window.show());
  try {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "worker-src 'none'",
    ].join('; ');
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      });
    });
  } catch (error) {
    console.log('[Security] Failed to register CSP header:', error.message);
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch((error) => console.log('[Security] Failed to open external URL:', error.message));
    } else {
      console.warn('[Security] Blocked window.open for non-allowlisted URL:', url);
    }
    return { action: 'deny' };
  });
  const rendererUrl = pathToFileURL(RENDERER_FILE).href;
  window.webContents.on('will-navigate', (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    else console.warn('[Security] Blocked navigation to:', url);
  });

  window.loadFile(RENDERER_FILE);
  window.webContents.on('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const result = await checkForUpdates();
      if (result?.hasUpdate && !window.isDestroyed()) {
        window.webContents.send(C.UPDATE_AVAILABLE, {
          hasUpdate: true,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          releaseName: result.releaseName,
        });
      }
    } catch (error) {
      console.error('[Update] Auto-check failed:', error.message);
    }
  });
  window.webContents.session.clearCache();

  try {
    Menu.setApplicationMenu(null);
    window.setMenuBarVisibility(false);
  } catch (error) {
    console.log('[Menu] Failed to hide application menu:', error.message);
  }
  window.webContents.on('context-menu', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    console.error('[render-process-gone]', JSON.stringify(details));
    errLogger.logError('main:render-process-gone', reason, details);
    if (reason === 'clean-exit' || reason === 'killed') return;
    transcription.terminateCurrentProcess();
    const now = Date.now();
    rendererReloadTimes = rendererReloadTimes.filter((time) => now - time < 30000);
    rendererReloadTimes.push(now);
    if (rendererReloadTimes.length > 3) {
      try {
        dialog.showErrorBox(
          'WhisperSubTranslate',
          `The app window crashed repeatedly and auto-recovery was stopped.\nReason: ${reason}\n\nPlease restart the app. Details were written to errors.log.`
        );
      } catch (_error) {}
      return;
    }
    if (!window.isDestroyed()) {
      try {
        window.webContents.reload();
      } catch (_error) {}
    }
  });
  window.on('closed', () => transcription.forceMemoryCleanup('cuda'));
  return window;
}

module.exports = { createWindow };
