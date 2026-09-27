'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// A failed write never truncates the previous file. Temporary files stay on the same volume.
function writeFileAtomic(destination, data, policy = 'overwrite') {
  if (!['overwrite', 'rename', 'skip'].includes(policy)) throw new Error('Invalid output policy');
  const temporary = path.join(path.dirname(destination), `.wst-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    if (policy === 'overwrite') {
      fs.renameSync(temporary, destination);
      return destination;
    }
    const extension = path.extname(destination);
    const base = destination.slice(0, destination.length - extension.length);
    // COPYFILE_EXCL also protects against another app creating the destination after the check.
    for (let index = 0; ; index++) {
      const candidate = index ? `${base} (${index})${extension}` : destination;
      try {
        fs.copyFileSync(temporary, candidate, fs.constants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (policy === 'skip') return null;
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function outputDestination(input, options = {}, suffix = '') {
  const directory = options.directory || path.dirname(input);
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('Invalid output directory');
  }
  const policy = options.policy || 'rename';
  if (!['rename', 'skip', 'overwrite'].includes(policy)) throw new Error('Invalid output policy');
  const name = path.basename(input, path.extname(input));
  return { path: path.join(directory, `${name}${suffix}.srt`), policy };
}

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

module.exports = { isCompleteWavFile, writeFileAtomic, outputDestination };
