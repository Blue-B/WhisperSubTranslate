const path = require('path');
const fs = require('fs');
const C = require('../../shared/ipc-channels');
const { applySrtCleanup, wrapCuesForDisplay } = require('../services/srt-cleanup');

function registerTranscriptionHandlers(ipcMain, transcription) {
  ipcMain.handle(C.EXTRACT_SUBTITLES, async (event, payload = {}) => {
    const { filePaths, filePath, model, language, device, cleanup } = payload;
    const filesToProcess = filePaths || (filePath ? [filePath] : []);
    if (!filesToProcess.length) return { success: true, results: [] };

    transcription.configureExtraction(payload);
    transcription.resetStop();
    let successCount = 0;
    let failCount = 0;
    let userStopped = false;
    const successDetails = [];
    const failureDetails = [];
    const usedSrtBases = new Set();

    for (let i = 0; i < filesToProcess.length; i++) {
      const currentFile = filesToProcess[i];
      if (!currentFile) continue;
      if (transcription.isStopped()) {
        userStopped = true;
        break;
      }

      const normalSrt = transcription.srtOutputPathFor(currentFile);
      let srtOutputOverride = null;
      if (usedSrtBases.has(normalSrt)) {
        const srcExt = path.extname(currentFile);
        srtOutputOverride = `${transcription.withoutExt(currentFile)}${srcExt}.srt`;
        event.sender.send(
          C.OUTPUT_UPDATE,
          `[Collision] ${path.basename(normalSrt)} already used by an earlier file — saving as ${path.basename(srtOutputOverride)}\n`
        );
        usedSrtBases.add(srtOutputOverride);
      } else {
        usedSrtBases.add(normalSrt);
      }

      try {
        const srtPath = await transcription.extractSingleFile(currentFile, model, language, device, srtOutputOverride);
        if (cleanup && (cleanup.removeSpeakerTags || cleanup.removeSDH)) {
          try {
            const raw = fs.readFileSync(srtPath, 'utf-8');
            const cleaned = applySrtCleanup(raw, cleanup);
            if (!cleaned.trim() && raw.trim()) {
              event.sender.send(C.OUTPUT_UPDATE, 'Output cleanup skipped (would remove all lines).\n');
            } else if (cleaned !== raw) {
              fs.writeFileSync(srtPath, cleaned, 'utf-8');
              const applied = [cleanup.removeSpeakerTags ? 'speaker tags' : null, cleanup.removeSDH ? 'SDH tags' : null]
                .filter(Boolean)
                .join(', ');
              event.sender.send(C.OUTPUT_UPDATE, `Output cleanup applied (${applied}).\n`);
            }
          } catch (error) {
            console.warn('[Cleanup] SRT cleanup failed:', error.message);
          }
        }
        try {
          const raw = fs.readFileSync(srtPath, 'utf-8');
          const wrapped = wrapCuesForDisplay(raw);
          if (wrapped && wrapped !== raw) fs.writeFileSync(srtPath, wrapped, 'utf-8');
        } catch (error) {
          console.warn('[Wrap] display wrap failed:', error.message);
        }

        successCount++;
        successDetails.push({ source: currentFile, srtPath });
        event.sender.send(
          C.OUTPUT_UPDATE,
          `[${i + 1}/${filesToProcess.length}] Completed: ${path.basename(currentFile)}\n`
        );
        if (i < filesToProcess.length - 1) {
          event.sender.send(C.OUTPUT_UPDATE, `Next file: ${path.basename(filesToProcess[i + 1])}\n`);
          if (device === 'cuda') {
            event.sender.send(C.OUTPUT_UPDATE, 'Cleaning GPU memory and preparing next file... (wait 10s)\n');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (transcription.isStopped()) {
              userStopped = true;
              break;
            }
            event.sender.send(C.OUTPUT_UPDATE, 'Start next file!\n\n');
          }
        }
      } catch (error) {
        const message = error?.message || String(error);
        const stopped = message === 'Stopped by user';
        if (!stopped) failCount++;
        failureDetails.push({ source: currentFile, error: message, userStopped: stopped });
        if (stopped) {
          userStopped = true;
          break;
        }
        if (i < filesToProcess.length - 1 && !transcription.isStopped()) {
          event.sender.send(C.OUTPUT_UPDATE, `Next file: ${path.basename(filesToProcess[i + 1])}\n`);
          if (device === 'cuda') {
            event.sender.send(C.OUTPUT_UPDATE, 'Recovering and preparing next file... (wait 10s)\n');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (transcription.isStopped()) {
              userStopped = true;
              break;
            }
            event.sender.send(C.OUTPUT_UPDATE, 'Start next file!\n\n');
          }
        }
      }
    }

    event.sender.send(C.OUTPUT_UPDATE, `\nExtraction stage finished (success: ${successCount}, failed: ${failCount})`);
    const response = { success: failCount === 0 && !userStopped, results: successDetails };
    if (successDetails.length === 1) response.srtFile = successDetails[0].srtPath;
    if (failureDetails.length) {
      response.failures = failureDetails;
      if (failureDetails.length === 1) response.error = failureDetails[0].error;
    }
    if (userStopped) response.userStopped = true;
    return response;
  });

  ipcMain.handle(C.STOP_CURRENT_PROCESS, async () => {
    transcription.stop();
    return { success: true };
  });
}

module.exports = { registerTranscriptionHandlers };
