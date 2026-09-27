const path = require('path');
const fs = require('fs');
const axios = require('axios');
const C = require('../../shared/ipc-channels');
const EnhancedSubtitleTranslator = require('../services/translator');
const { isAllowedExternalUrl } = require('./files');

const CURRENT_VERSION = require('../../../package.json').version;
const GITHUB_REPO = 'blue-b/WhisperSubTranslate';
const ALLOWED_AUDIO_FILES = new Set(['nya.wav']);
const AUDIO_DIR = 'assets';
const SOURCE_ROOT = path.resolve(__dirname, '../../..');

function compareVersions(first, second) {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    const response = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { timeout: 10000 });
    const latestVersion = response.data.tag_name.replace(/^v/, '');
    let releaseUrl = response.data.html_url;
    try {
      const parsed = new URL(releaseUrl);
      parsed.search = '';
      parsed.hash = '';
      releaseUrl = parsed.href;
    } catch (_error) {}
    if (!isAllowedExternalUrl(releaseUrl)) return { hasUpdate: false, error: 'Invalid release URL' };
    return {
      hasUpdate: compareVersions(latestVersion, CURRENT_VERSION) > 0,
      currentVersion: CURRENT_VERSION,
      latestVersion,
      releaseUrl,
      releaseName: response.data.name || `v${latestVersion}`,
    };
  } catch (error) {
    return { hasUpdate: false, error: error.message };
  }
}

function registerSettingsHandlers(ipcMain, app, transcription) {
  const translator = transcription.translator;
  ipcMain.handle(C.GET_DIAGNOSTICS, () => {
    const gpu = transcription.getGpuStatus();
    return {
      version: CURRENT_VERSION,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      whisper: 'v1.9.1',
      cudaAvailable: !!(gpu.available && gpu.cudaCompatible),
      vulkanAvailable: !!gpu.vulkanAvailable,
      ...require('../services/error-logger').getDiagnosticSummary(),
    };
  });
  ipcMain.handle(C.OPEN_ERROR_LOG_LOCATION, async () => {
    try {
      const { shell } = require('electron');
      const logPath = require('../services/error-logger').getLogPath();
      const exists = fs.existsSync(logPath);
      if (exists) shell.showItemInFolder(logPath);
      else if (await shell.openPath(path.dirname(logPath))) return { success: false };
      return { success: true, exists };
    } catch (_error) {
      return { success: false };
    }
  });
  ipcMain.handle(C.SAVE_API_KEYS, (_event, keys) => {
    try {
      const result = translator.saveApiKeys(keys);
      return { success: !!result, insecure: !!result?.insecure };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle(C.LOAD_API_KEYS, () => {
    try {
      return { success: true, keys: translator.loadApiKeys() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle(C.GET_PROVIDER_DEFAULTS, () => ({
    success: true,
    defaults: {
      prompts: {
        translationPrompt: EnhancedSubtitleTranslator.DEFAULT_SYSTEM_PROMPT,
        contextPrompt: EnhancedSubtitleTranslator.DEFAULT_CONTEXT_SYSTEM_PROMPT,
      },
      providers: EnhancedSubtitleTranslator.PROVIDER_DEFAULTS,
      modelPresets: EnhancedSubtitleTranslator.PROVIDER_MODEL_PRESETS,
      formats: EnhancedSubtitleTranslator.PROVIDER_FORMATS,
    },
  }));
  ipcMain.handle(C.LIST_PROVIDER_MODELS, async (_event, { method, tempKeys } = {}) => {
    try {
      const source = new EnhancedSubtitleTranslator();
      source.apiKeys = { ...source.apiKeys, ...(tempKeys || {}) };
      return { success: true, models: await source.listModels(source.resolveProvider(method)) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  ipcMain.handle(C.VALIDATE_API_KEYS, async (_event, tempKeys) => {
    try {
      if (tempKeys && Object.keys(tempKeys).length) {
        const temporary = new EnhancedSubtitleTranslator();
        temporary.apiKeys = { ...temporary.apiKeys, ...tempKeys };
        return { success: true, results: await temporary.validateApiKeys() };
      }
      return { success: true, results: await translator.validateApiKeys() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(C.GET_CURRENT_VERSION, () => CURRENT_VERSION);
  ipcMain.handle(C.GET_GPU_INFO, () => transcription.getGpuStatus());
  ipcMain.handle(C.GET_AUDIO_DATA, (_event, filename) => {
    try {
      if (typeof filename !== 'string' || path.basename(filename) !== filename || !ALLOWED_AUDIO_FILES.has(filename)) {
        return null;
      }
      // 패키지에서는 extraResources가 assets/nya.wav를 resources/nya.wav로 복사하므로 경로가 다르다.
      const base = app.isPackaged ? process.resourcesPath : path.join(SOURCE_ROOT, AUDIO_DIR);
      const file = path.join(base, filename);
      if (!fs.existsSync(file)) return null;
      return `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`;
    } catch (error) {
      console.error('[Audio] Failed to read audio file:', error.message);
      return null;
    }
  });
}

module.exports = { checkForUpdates, registerSettingsHandlers };
