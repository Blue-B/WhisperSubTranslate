'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024;
const GIB = 1024 ** 3;
// Upstream sizes verified for the pinned Sync engine/model URLs. verified-downloader.js never
// trusts Content-Length: it counts received bytes against the pinned size and verifies the pinned
// SHA-256, so an upstream replacement is rejected no matter what the server reports.
const SYNC_ENGINE_ARCHIVE_BYTES = 1_424_256_246;
const SYNC_MODEL_BYTES = 3_086_912_962;
const SYNC_SHARED_INSTALL_BYTES = Math.ceil(4.4 * GIB);
const SYNC_ENGINE_EXTRACTED_BYTES = SYNC_ENGINE_ARCHIVE_BYTES * 3;
const SYNC_ENGINE_EXTRACTION_PEAK_BYTES = SYNC_ENGINE_ARCHIVE_BYTES + SYNC_ENGINE_EXTRACTED_BYTES;

function getReusablePartialSize(filePath, maxBytes) {
  try {
    const size = fs.statSync(filePath).size;
    if (size <= maxBytes) return size;
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return 0;
}

function getSyncInstallRequiredBytes(engineInstalled, modelInstalled, enginePartialBytes = 0, modelPartialBytes = 0) {
  if (engineInstalled && modelInstalled) return 0;

  const engineProgress = Math.min(
    Math.max(Number.isFinite(enginePartialBytes) ? enginePartialBytes : 0, 0),
    SYNC_ENGINE_ARCHIVE_BYTES
  );
  const modelProgress = Math.min(
    Math.max(Number.isFinite(modelPartialBytes) ? modelPartialBytes : 0, 0),
    SYNC_MODEL_BYTES
  );
  const engineRemaining = engineInstalled ? 0 : SYNC_ENGINE_ARCHIVE_BYTES - engineProgress;
  const modelRemaining = modelInstalled ? 0 : SYNC_MODEL_BYTES - modelProgress;

  if (!engineInstalled && !modelInstalled) {
    // The engine archive exists during extraction, then is deleted before the model finishes.
    // Measure both peaks against the partial files that already consume the caller's free space.
    return Math.max(
      engineRemaining + SYNC_ENGINE_EXTRACTED_BYTES,
      Math.max(0, SYNC_SHARED_INSTALL_BYTES - engineProgress - modelProgress),
      Math.max(0, SYNC_ENGINE_EXTRACTED_BYTES + modelRemaining - engineProgress)
    );
  }
  return engineInstalled ? modelRemaining : engineRemaining + SYNC_ENGINE_EXTRACTED_BYTES;
}

function assertDownloadDiskSpace(destPath, downloadBytes, reserveBytes = DEFAULT_RESERVE_BYTES) {
  if (!Number.isFinite(downloadBytes) || downloadBytes <= 0) return;

  try {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });
    const { bavail, bsize } = fs.statfsSync(dir);
    const freeBytes = bavail * bsize;
    const requiredBytes = downloadBytes + reserveBytes;
    if (freeBytes < requiredBytes) {
      throw new Error(
        `Not enough disk space: need ${(requiredBytes / 1024 ** 3).toFixed(2)} GB, free ${(freeBytes / 1024 ** 3).toFixed(2)} GB`
      );
    }
  } catch (error) {
    if (error?.message?.startsWith('Not enough disk space')) throw error;
    // statfs를 지원하지 않는 네트워크 드라이브 등에서는 기존 다운로드 동작을 유지한다.
  }
}

function assertSyncInstallDiskSpace(
  destPath,
  engineInstalled,
  modelInstalled,
  enginePartialBytes = 0,
  modelPartialBytes = 0
) {
  const requiredBytes = getSyncInstallRequiredBytes(
    engineInstalled,
    modelInstalled,
    enginePartialBytes,
    modelPartialBytes
  );
  if (requiredBytes > 0) assertDownloadDiskSpace(destPath, requiredBytes);
  return requiredBytes;
}

module.exports = {
  assertDownloadDiskSpace,
  assertSyncInstallDiskSpace,
  getReusablePartialSize,
  getSyncInstallRequiredBytes,
  SYNC_ENGINE_ARCHIVE_BYTES,
  SYNC_MODEL_BYTES,
  SYNC_SHARED_INSTALL_BYTES,
  SYNC_ENGINE_EXTRACTED_BYTES,
  SYNC_ENGINE_EXTRACTION_PEAK_BYTES,
};
