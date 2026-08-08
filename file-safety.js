'use strict';

const fs = require('fs');

function backupStaleWav(wavPath) {
  const backupPath = `${wavPath}.stale.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.renameSync(wavPath, backupPath);
    return backupPath;
  }

  const previousPath = `${backupPath}.previous-${process.pid}-${Date.now()}`;
  fs.renameSync(backupPath, previousPath);
  try {
    fs.renameSync(wavPath, backupPath);
  } catch (error) {
    try {
      fs.renameSync(previousPath, backupPath);
    } catch (restoreError) {
      throw new Error(
        `${error.message}; previous backup preserved at ${previousPath}; restore failed: ${restoreError.message}`
      );
    }
    throw error;
  }
  try {
    fs.unlinkSync(previousPath);
  } catch (error) {
    console.warn(`[WAV] Previous backup cleanup failed, preserved at ${previousPath}: ${error.message}`);
  }
  return backupPath;
}

module.exports = { backupStaleWav };
