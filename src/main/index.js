const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const SOURCE_ROOT = path.resolve(__dirname, '../..');
let mainWindow = null;
let cleaningUp = false;
let quitRequested = false;

try {
  app.setName('WhisperSubTranslate');
  app.setAppUserModelId('com.whispersubtranslate.app');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
} catch (error) {
  console.warn('[App] Failed to apply desktop identity:', error.message);
}

function resolvePortableUserData() {
  if (process.env.WHISPER_PORTABLE_DATA) return process.env.WHISPER_PORTABLE_DATA;
  const executableDirectory = app.isPackaged ? path.dirname(process.execPath) : SOURCE_ROOT;
  const marker = path.join(executableDirectory, 'portable-data');
  return fs.existsSync(marker) ? marker : null;
}

try {
  const portableDirectory = resolvePortableUserData();
  if (portableDirectory) {
    fs.mkdirSync(portableDirectory, { recursive: true });
    app.setPath('userData', portableDirectory);
  }
} catch (error) {
  console.warn('[Portable] Failed to redirect userData:', error.message);
}

// Portable userData must be selected before loading services: translator and model
// modules resolve their persistent paths during initialization.
const transcription = require('./services/transcription');
const errLogger = require('./services/error-logger');
const { createWindow } = require('./window');
const { registerTranscriptionHandlers } = require('./ipc/transcription');
const { registerTranslationHandlers } = require('./ipc/translation');
const { registerModelHandlers, cleanupModels } = require('./ipc/models');
const { registerFileHandlers } = require('./ipc/files');
const { registerHistoryHandlers } = require('./ipc/history');
const { checkForUpdates, registerSettingsHandlers } = require('./ipc/settings');

errLogger.setElectronApp(app);
registerTranscriptionHandlers(ipcMain, transcription);
registerTranslationHandlers(ipcMain, transcription.translator);
registerModelHandlers(ipcMain, transcription, () => mainWindow);
registerFileHandlers(ipcMain, () => mainWindow);
registerHistoryHandlers(ipcMain, app);
registerSettingsHandlers(ipcMain, app, transcription);

process.on('uncaughtException', (error) => {
  errLogger.logError('main:uncaughtException', error?.message || String(error), error);
  console.error('[uncaughtException]', error);
});
process.on('unhandledRejection', (reason) => {
  errLogger.logError('main:unhandledRejection', reason?.message || String(reason), reason);
  console.error('[unhandledRejection]', reason);
});

function openMainWindow() {
  mainWindow = createWindow(app, transcription, checkForUpdates);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!app.isPackaged) {
    app.commandLine.appendSwitch('js-flags', '--expose-gc');
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();
    } catch (error) {
      console.log('[Cache] Failed to clear cache:', error.message);
    }
  }
  // 로컬 번역(CUDA)이 처음 초기화되기 전에 저장된 GPU 지정을 적용한다.
  try {
    transcription.applyGpuSelection(transcription.translator.loadApiKeys()?.selectedDevice);
  } catch (error) {
    console.warn('[GPU] Failed to apply saved GPU selection:', error.message);
  }
  openMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
});
app.on('child-process-gone', (_event, details) => {
  if (details?.reason && details.reason !== 'clean-exit') {
    console.error('[child-process-gone]', JSON.stringify(details));
    errLogger.logError('main:child-process-gone', `${details.type}:${details.reason}`, details);
  }
});
app.on('before-quit', (event) => {
  if (quitRequested) return;
  event.preventDefault();
  if (cleaningUp) return;
  cleaningUp = true;
  transcription.stop();
  Promise.allSettled([cleanupModels(), transcription.forceMemoryCleanup('cuda', true)]).finally(() => {
    cleaningUp = false;
    quitRequested = true;
    app.quit();
  });
});

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
