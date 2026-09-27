const fs = require('fs');
const C = require('../../shared/ipc-channels');
const { outputDestination } = require('../services/file-safety');
const TARGET_LANG_RE = /^[a-z]{2,8}$/i;

function registerTranslationHandlers(ipcMain, translator) {
  // Finish cancellation before resetting the shared translator for an immediate retry.
  let pending = Promise.resolve();
  ipcMain.handle(C.TRANSLATE_SUBTITLE, (event, payload) => {
    const epoch = translator._abortEpoch || 0;
    const job = pending.then(() => translate(event, payload, epoch));
    pending = job.catch(() => {});
    return job;
  });

  async function translate(
    event,
    {
      filePath,
      method,
      targetLang,
      targetLangs,
      sourceLang,
      device,
      localModelId,
      localProcessingMode,
      sessionId,
      outputOptions,
    },
    epoch
  ) {
    const outputPaths = [];
    const failedLangs = [];
    const skippedLangs = [];
    const outputs = {};
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(C.TRANSLATION_PROGRESS, { ...payload, sessionId });
    };
    try {
      if ((translator._abortEpoch || 0) !== epoch) throw new Error('ABORTED: Translation stopped by user');
      translator.resetAbort();
      let langs = (Array.isArray(targetLangs) && targetLangs.length ? targetLangs : [targetLang])
        .map((lang) => (typeof lang === 'string' ? lang.trim() : ''))
        .filter(Boolean);
      langs = [...new Set(langs.length ? langs : ['ko'])];
      if (langs.some((lang) => !TARGET_LANG_RE.test(lang))) throw new Error('Invalid target language code');
      translator.setCurrentFile(filePath);
      translator.localDevice = device === 'cpu' ? 'cpu' : 'auto';
      translator.localModelId = localModelId || '1.8b';
      translator.localProcessingMode = localProcessingMode === 'auto' ? 'auto' : 'sequential';
      send({ stage: 'starting' });
      for (let index = 0; index < langs.length; index++) {
        const lang = langs[index];
        if (translator._aborted) throw new Error('ABORTED: Translation stopped by user');
        try {
          const destination = outputDestination(filePath, outputOptions, `_${lang}`);
          if (destination.policy === 'skip' && fs.existsSync(destination.path)) {
            skippedLangs.push(lang);
            outputs[lang] = destination.path;
            continue;
          }
          const result = await translator.translateSRTFile(
            filePath,
            destination.path,
            method,
            lang,
            (progress) => {
              const within = progress?.total ? progress.current / progress.total : 0;
              send({
                stage: progress?.stage || 'translating',
                current: progress?.current,
                total: progress?.total,
                progress: Math.round(((index + within) / langs.length) * 100),
                currentText: progress?.text,
                lang,
                langIndex: index + 1,
                langTotal: langs.length,
              });
            },
            sourceLang,
            { policy: destination.policy }
          );
          if (translator._aborted) throw new Error('ABORTED: Translation stopped by user');
          if (result) {
            outputPaths.push(result);
            outputs[lang] = result;
          } else {
            skippedLangs.push(lang);
            outputs[lang] = destination.path;
          }
        } catch (error) {
          if (translator._aborted || String(error?.message || '').includes('ABORTED'))
            throw new Error('ABORTED: Translation stopped by user');
          console.error(`[Translate] Language ${lang} failed: ${error.message}`);
          failedLangs.push(lang);
        }
      }
      translator.clearFileCache();
      if (!outputPaths.length && !skippedLangs.length)
        throw new Error(`All target languages failed: ${failedLangs.join(', ')}`);
      const result = {
        success: true,
        outputPath: outputPaths[0] || Object.values(outputs)[0],
        outputPaths,
        outputs,
        failedLangs,
        skippedLangs,
        partial: failedLangs.length > 0,
        skipped: !outputPaths.length && !failedLangs.length,
      };
      send({ stage: 'completed', progress: 100, ...result });
      return result;
    } catch (error) {
      try {
        translator.clearFileCache();
      } catch (_error) {}
      const userStopped = String(error?.message || '').includes('ABORTED');
      const message = userStopped ? 'Stopped by user' : error.message;
      const result = { success: false, error: message, userStopped, outputPaths, outputs, failedLangs, skippedLangs };
      send({ stage: 'error', errorMessage: message, ...result });
      return result;
    }
  }
}
module.exports = { registerTranslationHandlers };
