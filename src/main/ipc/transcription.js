const path = require('path');
const fs = require('fs');
const C = require('../../shared/ipc-channels');
const { applySrtCleanup, wrapCuesForDisplay } = require('../services/srt-cleanup');
const { outputDestination, writeFileAtomic } = require('../services/file-safety');

function registerTranscriptionHandlers(ipcMain, transcription) {
  ipcMain.handle(C.EXTRACT_SUBTITLES, async (event, payload = {}) => {
    const { filePaths, filePath, model, language, device, cleanup, outputOptions } = payload;
    const filesToProcess = filePaths || (filePath ? [filePath] : []);
    if (!filesToProcess.length) return { success: true, results: [] };
    transcription.configureExtraction(payload);
    transcription.resetStop();
    const send = (channel, message) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, message);
    };
    const results = [];
    const failures = [];
    let userStopped = false;
    for (const currentFile of filesToProcess) {
      if (transcription.isStopped()) {
        userStopped = true;
        break;
      }
      let staging;
      try {
        const destination = outputDestination(currentFile, outputOptions);
        if (destination.policy === 'skip' && fs.existsSync(destination.path)) {
          results.push({ source: currentFile, skipped: true });
          continue;
        }
        // Every invocation owns a fresh output directory. Old subtitles can never satisfy this run.
        staging = fs.mkdtempSync(path.join(path.dirname(destination.path), '.wst-extract-'));
        const srtPath = await transcription.extractSingleFile(
          currentFile,
          model,
          language,
          device,
          path.join(staging, 'subtitle.srt')
        );
        const raw = fs.readFileSync(srtPath, 'utf8');
        let content = raw;
        if (cleanup && (cleanup.removeSpeakerTags || cleanup.removeSDH)) {
          const cleaned = applySrtCleanup(raw, cleanup);
          if (!cleaned.trim() && raw.trim())
            send(C.OUTPUT_UPDATE, 'Output cleanup skipped (would remove all lines).\n');
          else content = cleaned;
        }
        content = wrapCuesForDisplay(content) || content;
        if (transcription.isStopped()) throw new Error('Stopped by user');
        const saved = writeFileAtomic(destination.path, content, destination.policy);
        results.push({ source: currentFile, srtPath: saved, skipped: !saved });
        if (saved) send(C.OUTPUT_UPDATE, `Completed: ${path.basename(currentFile)}\n`);
      } catch (error) {
        const message = error?.message || String(error);
        userStopped = message === 'Stopped by user';
        failures.push({ source: currentFile, error: message, userStopped });
        if (userStopped) break;
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    const successCount = results.filter((result) => !result.skipped).length;
    send(C.OUTPUT_UPDATE, `\nExtraction stage finished (success: ${successCount}, failed: ${failures.length})`);
    return {
      success: failures.length === 0 && !userStopped,
      results,
      srtFile: results.length === 1 ? results[0].srtPath : undefined,
      skipped: results.length > 0 && results.every((result) => result.skipped),
      failures,
      error: failures[0]?.error,
      userStopped,
    };
  });
  ipcMain.handle(C.STOP_CURRENT_PROCESS, async () => {
    transcription.stop();
    return { success: true };
  });
}

module.exports = { registerTranscriptionHandlers };
