'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024;
const GIB = 1024 ** 3;
// Upstream sizes verified for the pinned Sync engine/model URLs. Per-response checks still
// validate the actual Content-Length so an upstream replacement cannot bypass the guard.
const SYNC_ENGINE_ARCHIVE_BYTES = 1_424_256_246;
const SYNC_MODEL_BYTES = 3_086_912_962;
const SYNC_SHARED_INSTALL_BYTES = Math.ceil(4.4 * GIB);
const SYNC_ENGINE_EXTRACTED_BYTES = SYNC_ENGINE_ARCHIVE_BYTES * 3;
const SYNC_ENGINE_EXTRACTION_PEAK_BYTES = SYNC_ENGINE_ARCHIVE_BYTES + SYNC_ENGINE_EXTRACTED_BYTES;

function getSyncInstallRequiredBytes(engineInstalled, modelInstalled) {
  if (engineInstalled && modelInstalled) return 0;
  if (!engineInstalled && !modelInstalled) {
    return Math.max(
      SYNC_ENGINE_EXTRACTION_PEAK_BYTES,
      SYNC_SHARED_INSTALL_BYTES,
      SYNC_ENGINE_EXTRACTED_BYTES + SYNC_MODEL_BYTES
    );
  }
  return engineInstalled ? SYNC_MODEL_BYTES : SYNC_ENGINE_EXTRACTION_PEAK_BYTES;
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

function assertSyncInstallDiskSpace(destPath, engineInstalled, modelInstalled) {
  const requiredBytes = getSyncInstallRequiredBytes(engineInstalled, modelInstalled);
  if (requiredBytes > 0) assertDownloadDiskSpace(destPath, requiredBytes);
  return requiredBytes;
}

module.exports = {
  assertDownloadDiskSpace,
  assertSyncInstallDiskSpace,
  getSyncInstallRequiredBytes,
  SYNC_ENGINE_ARCHIVE_BYTES,
  SYNC_MODEL_BYTES,
  SYNC_SHARED_INSTALL_BYTES,
  SYNC_ENGINE_EXTRACTED_BYTES,
  SYNC_ENGINE_EXTRACTION_PEAK_BYTES,
};
