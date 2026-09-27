const fs = require('fs');
const C = require('../../shared/ipc-channels');
const localTranslator = require('../services/local-translator');
const { openPathSafely } = require('./files');

const localDownloadAborts = new Map();
let getMainWindow = () => null;

function registerModelHandlers(ipcMain, transcription, mainWindowProvider) {
  getMainWindow = mainWindowProvider;
  localTranslator.setDownloadProgressHandler((progress) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(C.LOCAL_MODEL_PROGRESS, progress);
  });

  ipcMain.handle(C.CHECK_MODEL_STATUS, () => transcription.checkModelStatus());
  ipcMain.handle(C.DOWNLOAD_MODEL, (_event, modelName) => transcription.downloadModel(modelName));
  ipcMain.handle(C.WHISPER_MODEL_CANCEL, () => {
    transcription.cancelDownloads();
    return { success: true };
  });
  ipcMain.handle(C.DELETE_WHISPER_MODEL, (_event, modelName) => transcription.deleteWhisperModel(modelName));
  ipcMain.handle(C.DOWNLOAD_SYNC_ENGINE, () => transcription.downloadSyncEngine());
  ipcMain.handle(C.DELETE_SYNC_ENGINE, () => transcription.deleteSyncEngine());
  ipcMain.handle(C.OPEN_MODELS_FOLDER, async () => {
    const dir = transcription.getGgmlModelsDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const opened = await openPathSafely(dir);
      return opened ? { success: true, path: dir } : { success: false, error: 'no handler available', path: dir };
    } catch (error) {
      return { success: false, error: error.message, path: dir };
    }
  });

  ipcMain.handle(C.LOCAL_MODEL_LIST, () => localTranslator.listModels());
  ipcMain.handle(C.LOCAL_MODEL_STATUS, (_event, modelId) => {
    const id = modelId || localTranslator.DEFAULT_MODEL_ID;
    const meta = localTranslator.MODELS[id];
    return {
      modelId: id,
      installed: localTranslator.isModelInstalled(id),
      path: localTranslator.getModelPath(id),
      modelFile: meta?.file,
      sizeMB: Math.round((meta?.sizeBytes || 0) / 1024 / 1024),
      requirements: meta?.requirements,
    };
  });
  ipcMain.handle(C.LOCAL_MODEL_DOWNLOAD, async (event, modelId) => {
    const id = modelId || localTranslator.DEFAULT_MODEL_ID;
    if (localTranslator.isModelInstalled(id)) return { success: true, alreadyInstalled: true };
    if (localDownloadAborts.has(id)) return { success: false, error: 'Download already in progress' };
    const controller = new AbortController();
    localDownloadAborts.set(id, controller);
    try {
      await localTranslator.downloadModel(
        // 이미 닫힌 창에는 진행률을 보내지 않는다. 앱 종료 시 취소는 별도 처리한다.
        (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(C.LOCAL_MODEL_PROGRESS, progress);
        },
        controller.signal,
        id
      );
      return { success: true };
    } catch (error) {
      const cancelled = /cancell?ed|aborted/i.test(String(error?.message || '')) || error?.name === 'AbortError';
      return cancelled
        ? { success: false, error: 'cancelled', userStopped: true }
        : { success: false, error: error.message };
    } finally {
      localDownloadAborts.delete(id);
    }
  });
  ipcMain.handle(C.LOCAL_MODEL_CANCEL, (_event, modelId) => {
    const controllers = modelId ? [localDownloadAborts.get(modelId)] : localDownloadAborts.values();
    for (const controller of controllers) controller?.abort(new Error('cancelled'));
    return true;
  });
  ipcMain.handle(C.LOCAL_MODEL_DELETE, async (_event, modelId) => {
    await localTranslator.unloadModel();
    localTranslator.deleteModel(modelId || localTranslator.DEFAULT_MODEL_ID);
    return true;
  });
}

async function cleanupModels() {
  for (const controller of localDownloadAborts.values()) controller.abort();
  await Promise.race([
    localTranslator.unloadModel().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]);
}

module.exports = { cleanupModels, registerModelHandlers };
