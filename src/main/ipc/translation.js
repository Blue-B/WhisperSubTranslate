const path = require('path');
const C = require('../../shared/ipc-channels');

const TARGET_LANG_RE = /^[a-z]{2,8}$/i;

function registerTranslationHandlers(ipcMain, translator) {
  ipcMain.handle(
    C.TRANSLATE_SUBTITLE,
    async (event, { filePath, method, targetLang, targetLangs, sourceLang, device, localModelId, sessionId }) => {
      const outputPaths = [];
      const failedLangs = [];
      try {
        translator.resetAbort();
        const fileName = path.basename(filePath, path.extname(filePath));
        const fileDir = path.dirname(filePath);
        let langs = (Array.isArray(targetLangs) && targetLangs.length ? targetLangs : [targetLang])
          .map((lang) => (typeof lang === 'string' ? lang.trim() : ''))
          .filter(Boolean);
        langs = [...new Set(langs.length ? langs : ['ko'])];
        const invalidLangs = langs.filter((lang) => !TARGET_LANG_RE.test(lang));
        if (invalidLangs.length) throw new Error(`Invalid target language code: ${invalidLangs.join(', ')}`);

        translator.setCurrentFile(filePath);
        translator.localDevice = device === 'cpu' ? 'cpu' : 'auto';
        translator.localModelId = localModelId || '1.8b';
        event.sender.send(C.TRANSLATION_PROGRESS, { stage: 'starting', sessionId });

        for (let index = 0; index < langs.length; index++) {
          const lang = langs[index];
          if (translator._aborted) throw new Error('ABORTED: Translation stopped by user');
          const outputPath = path.join(fileDir, `${fileName}_${lang}.srt`);
          try {
            const result = await translator.translateSRTFile(
              filePath,
              outputPath,
              method,
              lang,
              (progress) => {
                const within = progress?.total ? progress.current / progress.total : 0;
                event.sender.send(C.TRANSLATION_PROGRESS, {
                  stage: progress?.stage || 'translating',
                  current: progress?.current,
                  total: progress?.total,
                  progress: Math.round(((index + within) / langs.length) * 100),
                  currentText: progress?.text,
                  lang,
                  langIndex: index + 1,
                  langTotal: langs.length,
                  sessionId,
                });
              },
              sourceLang
            );
            outputPaths.push(result);
          } catch (error) {
            if (String(error?.message || '').includes('ABORTED')) throw error;
            console.error(`[Translate] Language ${lang} failed: ${error.message}`);
            failedLangs.push(lang);
          }
        }

        translator.clearFileCache();
        if (!outputPaths.length) {
          throw new Error(
            failedLangs.length ? `All target languages failed: ${failedLangs.join(', ')}` : 'Translation failed'
          );
        }
        event.sender.send(C.TRANSLATION_PROGRESS, {
          stage: 'completed',
          progress: 99,
          outputPath: outputPaths[0],
          outputPaths,
          failedLangs,
          sessionId,
        });
        return { success: true, outputPath: outputPaths[0], outputPaths, failedLangs };
      } catch (error) {
        try {
          translator.clearFileCache();
        } catch (_error) {}
        if (String(error?.message || '').includes('ABORTED')) {
          event.sender.send(C.TRANSLATION_PROGRESS, {
            stage: 'error',
            errorMessage: 'Stopped by user',
            outputPaths,
            sessionId,
          });
          return {
            success: false,
            error: 'Stopped by user',
            userStopped: true,
            partialOutputPaths: outputPaths,
            outputPaths,
          };
        }
        event.sender.send(C.TRANSLATION_PROGRESS, { stage: 'error', errorMessage: error.message, sessionId });
        return { success: false, error: error.message };
      }
    }
  );
}

module.exports = { registerTranslationHandlers };
