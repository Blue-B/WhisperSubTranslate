'use strict';

const fs = require('fs');

function isCompleteWavFile(wavPath, fileSize) {
  if (fileSize < 44) return false;
  const header = Buffer.alloc(64);
  const fd = fs.openSync(wavPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead < 12 || header.toString('latin1', 8, 12) !== 'WAVE') return false;

  const container = header.toString('latin1', 0, 4);
  if (container === 'RIFF') {
    return header.readUInt32LE(4) === fileSize - 8;
  }
  if (container === 'RF64') {
    return (
      bytesRead >= 48 &&
      header.toString('latin1', 12, 16) === 'ds64' &&
      header.readUInt32LE(16) >= 28 &&
      header.readBigUInt64LE(20) === BigInt(fileSize - 8)
    );
  }
  return false;
}

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

module.exports = { backupStaleWav, isCompleteWavFile };
