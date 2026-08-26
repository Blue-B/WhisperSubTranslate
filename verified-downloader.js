'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const DOWNLOAD_RETRY_LIMIT = 3;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function getDownloadUrls(url) {
  const urls = [url];
  if (url.startsWith('https://huggingface.co/')) {
    urls.push(url.replace('https://huggingface.co/', 'https://hf-mirror.com/'));
  }
  return urls;
}

function isRetryableDownloadError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)) return true;
  const status = Number(error?.response?.status || error?.status || 0);
  return status === 408 || status === 429 || status >= 500;
}

// 이 endpoint 자체가 막혔다는 신호. 같은 주소로 재시도해봐야 소용없으니 바로 미러로 넘어간다.
// 미러를 붙인 이유가 정확히 이 상황(DNS 차단, 사내 TLS 검사, 지역 차단 403/451)이다.
function isEndpointBlockedError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (
    [
      'ENOTFOUND',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPROTO',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ].includes(code)
  ) {
    return true;
  }
  const status = Number(error?.response?.status || error?.status || 0);
  return status === 401 || status === 403 || status === 404 || status === 451;
}

async function downloadVerifiedFile({
  axios,
  assertDownloadDiskSpace,
  url,
  partialPath,
  label,
  expectedSize,
  sha256,
  onProgress,
  activeDownloads,
  isCancelled = () => false,
  retryLimit,
}) {
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
    throw new Error(`${label}: expectedSize is required for verified download`);
  }
  const tracker = { controller: null, writer: null, destPath: partialPath, cancelled: false };
  if (isCancelled()) throw new Error('cancelled');
  activeDownloads.add(tracker);
  const urls = getDownloadUrls(url);
  // 공식 endpoint에도 재시도 기회를 준다. 한 번의 일시 장애로 바로 미러로 넘어가지 않도록
  // endpoint당 DOWNLOAD_RETRY_LIMIT번씩 배분한다.
  const totalAttempts = retryLimit ?? urls.length * DOWNLOAD_RETRY_LIMIT;
  // 총량에서 유도해야 호출자가 retryLimit을 넘겨도 미러가 아예 안 쓰이거나
  // 미러로만 몰리는 일이 없다.
  const perUrl = Math.max(1, Math.ceil(totalAttempts / urls.length));
  let offset = 0;
  try {
    try {
      offset = fs.statSync(partialPath).size;
    } catch (_error) {
      offset = 0;
    }
    if (offset > expectedSize) {
      fs.rmSync(partialPath, { force: true });
      offset = 0;
    } else if (offset === expectedSize) {
      // 이미 다 받아둔 partial이 남아 있다(rename 직전 취소/종료). 그대로 두면 다음
      // 요청이 파일 끝에서 Range를 걸어 416을 받고 영영 복구되지 않는다.
      if (!sha256 || (await sha256File(partialPath)) === sha256) {
        // 해시 계산은 3GB에서 수 초 걸린다. 그 사이에 들어온 취소를 성공으로 묵으면
        // 호출자가 rename 후 추출까지 그대로 진행한다.
        if (tracker.cancelled || isCancelled()) throw new Error('cancelled');
        onProgress?.(100, expectedSize, expectedSize);
        return;
      }
      fs.rmSync(partialPath, { force: true });
      offset = 0;
    }
    assertDownloadDiskSpace(partialPath, expectedSize - offset);

    let lastError = null;
    let rangeRestarted = false;
    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (tracker.cancelled || isCancelled()) throw new Error('cancelled');
      const currentUrl = urls[Math.min(Math.floor(attempt / perUrl), urls.length - 1)];
      const controller = new AbortController();
      tracker.controller = controller;
      try {
        console.log(`[Download] ${label}: ${currentUrl}`);
        const response = await axios({
          url: currentUrl,
          method: 'GET',
          responseType: 'stream',
          signal: controller.signal,
          timeout: 30000,
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
          validateStatus: () => true,
        });
        const status = response.status;
        const isPartial = status === 206;
        if (status === 416) {
          response.data?.destroy?.();
          // 마지막 청크까지 다 받고 FIN 직전에 끊긴 경우, 재시도 요청이 파일 끝을
          // 가리켜 416이 난다. 이미 완성된 3GB를 버리지 않고 검증해서 구제한다.
          if (offset === expectedSize && (!sha256 || (await sha256File(partialPath)) === sha256)) {
            if (tracker.cancelled || isCancelled()) throw new Error('cancelled');
            onProgress?.(100, expectedSize, expectedSize);
            return;
          }
          // partial이 서버 파일과 어긋난다. 붙잡고 있어봐야 계속 416이므로 버리고 처음부터.
          fs.rmSync(partialPath, { force: true });
          offset = 0;
          if (!rangeRestarted) {
            rangeRestarted = true;
            attempt--;
          }
          continue;
        }
        if (status !== 200 && !isPartial) {
          response.data?.destroy?.();
          const error = new Error(`${label}: HTTP ${status}`);
          error.response = response;
          throw error;
        }
        const contentRange = String(response.headers['content-range'] || '');
        if (offset > 0 && isPartial && !contentRange.startsWith(`bytes ${offset}-`)) {
          response.data.destroy();
          throw new Error(`${label}: invalid Content-Range for resume`);
        }
        // 전체 길이가 다르면 다른 revision이다. 3GB를 다 받고 해시로 버리지 말고 지금 멈춘다.
        // 단 RFC 7233이 허용하는 미지 길이 표기(bytes a-b/*)는 비교 대상이 아니다.
        const declaredTotal = contentRange.match(/\/(\d+)\s*$/)?.[1];
        if (isPartial && declaredTotal && declaredTotal !== String(expectedSize)) {
          response.data.destroy();
          throw new Error(`${label}: server reports a different total size (${contentRange})`);
        }
        if (offset > 0 && !isPartial) {
          // The server ignored Range. Stop this body immediately instead of downloading
          // the whole multi-GB file once just to discard it, then restart without Range.
          // 재시작 자체는 항상 하고, 재시도 예산 환불만 한 번으로 제한한다. 그러지 않으면
          // 두 번째 Range 무시에서 파괴된 스트림이 그대로 pipeline으로 넘어간다.
          response.data.destroy();
          fs.rmSync(partialPath, { force: true });
          offset = 0;
          assertDownloadDiskSpace(partialPath, expectedSize);
          if (!rangeRestarted) {
            rangeRestarted = true;
            attempt--;
          }
          continue;
        }

        let received = offset;
        let lastPercent = -1;
        let lastProgressAt = 0;
        response.data.on('data', (chunk) => {
          received += chunk.length;
          if (received > expectedSize) {
            response.data.destroy(new Error(`${label}: response exceeds expected size`));
            return;
          }
          const percent = Math.floor((received / expectedSize) * 100);
          const now = Date.now();
          if (
            percent !== lastPercent &&
            (percent === 100 || percent - lastPercent >= 5 || now - lastProgressAt >= 1000)
          ) {
            lastPercent = percent;
            lastProgressAt = now;
            try {
              onProgress?.(Math.min(100, percent), received, expectedSize);
            } catch (_error) {}
          }
        });
        const writer = fs.createWriteStream(partialPath, { flags: offset > 0 ? 'a' : 'w' });
        tracker.writer = writer;
        try {
          await pipeline(response.data, writer, { signal: controller.signal });
        } finally {
          if (tracker.writer === writer) tracker.writer = null;
        }
        offset = received;
        if (offset !== expectedSize) {
          const incomplete = new Error(`${label}: download incomplete (${offset}/${expectedSize} bytes)`);
          incomplete.code = 'ECONNRESET';
          throw incomplete;
        }
        if (sha256) {
          const digest = await sha256File(partialPath);
          if (tracker.cancelled || isCancelled()) throw new Error('cancelled');
          if (digest !== sha256) {
            fs.rmSync(partialPath, { force: true });
            throw new Error(`${label}: SHA-256 verification failed`);
          }
        }
        onProgress?.(100, expectedSize, expectedSize);
        return;
      } catch (error) {
        lastError = error;
        if (tracker.cancelled || isCancelled()) throw new Error('cancelled');
        // 다음 endpoint가 남았고 현재 endpoint가 막힌 거라면, 재시도 대신 곱바로 건너뛴다.
        const nextEndpointAttempt = (Math.floor(attempt / perUrl) + 1) * perUrl;
        if (isEndpointBlockedError(error) && nextEndpointAttempt < totalAttempts) {
          console.warn(`[Download] ${label} endpoint blocked (${error.message}); switching to fallback source`);
          attempt = nextEndpointAttempt - 1; // 루프 증가분을 감안
          try {
            offset = fs.statSync(partialPath).size;
          } catch (_error) {
            offset = 0;
          }
          continue;
        }
        if (!isRetryableDownloadError(error) || attempt >= totalAttempts - 1) throw error;
        const waitMs = 500 * 2 ** Math.min(attempt, 4);
        console.warn(`[Download] ${label} retry ${attempt + 1}/${totalAttempts} after ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        try {
          offset = fs.statSync(partialPath).size;
        } catch (_error) {
          offset = 0;
        }
      } finally {
        tracker.controller = null;
        tracker.writer = null;
      }
    }
    throw lastError || new Error(`${label}: download failed`);
  } finally {
    activeDownloads.delete(tracker);
  }
}

module.exports = { downloadVerifiedFile, getDownloadUrls, isRetryableDownloadError, sha256File };
