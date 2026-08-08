'use strict';

const fs = require('fs');
const { pipeline } = require('stream/promises');

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

async function writeDownloadStream(readable, destPath, onWriter) {
  const writer = fs.createWriteStream(destPath);
  onWriter?.(writer);
  try {
    await pipeline(readable, writer);
  } catch (error) {
    try {
      fs.rmSync(destPath, { force: true });
    } catch (cleanupError) {
      throw new Error(`${error.message}; partial cleanup failed: ${cleanupError.message}`, { cause: error });
    }
    throw error;
  }
}

module.exports = { isCompleteWavFile, writeDownloadStream };
