'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
const localTranslator = require('../local-translator');
const {
  hasWhisperRuntimeLibraries,
  downloadFile,
  updateInstallFailureMarker,
  verifyPinnedDownload,
  verifyWhisperAsset,
  WHISPER_ASSET_MANIFEST,
} = require('./postinstall');
const { applySrtCleanup, isSdhOnlyText, srtFromWhisperJson } = require('../srt-cleanup');
const {
  assertDownloadDiskSpace,
  assertSyncInstallDiskSpace,
  getReusablePartialSize,
  getSyncInstallRequiredBytes,
  SYNC_ENGINE_ARCHIVE_BYTES,
  SYNC_MODEL_BYTES,
  SYNC_ENGINE_EXTRACTED_BYTES,
  SYNC_ENGINE_EXTRACTION_PEAK_BYTES,
} = require('../disk-space');
const { isCompleteWavFile, writeDownloadStream } = require('../file-safety');
const { downloadVerifiedFile } = require('../verified-downloader');

async function runPostinstallRedirectDrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-postinstall-redirect-'));
  const dest = path.join(dir, 'download.bin');
  const originalGet = https.get;
  let redirectResumed = false;
  let errorResumed = false;
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        if (url === 'https://initial.test/file') {
          response.statusCode = 302;
          response.headers = { location: 'https://final.test/file' };
          const originalResume = response.resume.bind(response);
          response.resume = () => {
            redirectResumed = true;
            return originalResume();
          };
          callback(response);
          response.end();
          request.emit('error', new Error('retired redirect request failed'));
        } else if (url === 'https://error.test/file') {
          response.statusCode = 503;
          response.headers = {};
          const originalResume = response.resume.bind(response);
          response.resume = () => {
            errorResumed = true;
            return originalResume();
          };
          callback(response);
          response.end('unavailable');
        } else {
          response.statusCode = 200;
          response.headers = { 'content-length': url === 'https://incomplete.test/file' ? '4' : '3' };
          callback(response);
          response.end('abc');
        }
      });
      return request;
    };
    await downloadFile('https://initial.test/file', dest);
    assert.strictEqual(redirectResumed, true, 'postinstall must drain redirect responses');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'abc');

    fs.writeFileSync(dest, 'existing-user-file');
    await assert.rejects(downloadFile('https://error.test/file', dest), /HTTP 503/);
    assert.strictEqual(errorResumed, true, 'postinstall must drain failed responses');
    assert.strictEqual(
      fs.readFileSync(dest, 'utf8'),
      'existing-user-file',
      'HTTP failure must not delete existing file'
    );

    await assert.rejects(downloadFile('https://incomplete.test/file', dest), /Download incomplete/);
    assert.strictEqual(fs.existsSync(dest), false, 'partial download must be removed after its stream closes');

    const marker = path.join(dir, 'install-failed.txt');
    updateInstallFailureMarker(marker, 'llama', 'llama failed');
    updateInstallFailureMarker(marker, 'whisper', 'whisper failed');
    updateInstallFailureMarker(marker, 'whisper');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(marker, 'utf8'))), ['llama']);
    updateInstallFailureMarker(marker, 'llama');
    assert.strictEqual(fs.existsSync(marker), false, 'marker is removed only after every subsystem recovers');
    console.log('[PostinstallSafety] redirects retire old requests and failure scopes remain independent (ok)');
  } finally {
    https.get = originalGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runPostinstallDigestGuards() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-digest-guard-'));
  const file = path.join(dir, 'asset.zip');
  const content = 'pinned-bytes';
  const validPin = { size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  try {
    for (const [name, pin] of Object.entries(WHISPER_ASSET_MANIFEST)) {
      assert.match(name, /\.zip$/, 'pinned manifest keys must be archive asset names');
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, 'pinned sha256 must be lowercase hex');
      assert.ok(pin.size > 0, 'pinned size must be positive');
    }

    fs.writeFileSync(file, content);
    await verifyPinnedDownload('asset.zip', file, validPin);
    assert.strictEqual(fs.existsSync(file), true, 'bytes matching the pin must survive verification');

    fs.writeFileSync(file, content);
    await assert.rejects(
      verifyPinnedDownload('asset.zip', file, { size: content.length, sha256: 'f'.repeat(64) }),
      /SHA-256 mismatch/
    );
    assert.strictEqual(fs.existsSync(file), false, 'hash-rejected download must delete the partial file');

    fs.writeFileSync(file, content);
    await assert.rejects(
      verifyPinnedDownload('asset.zip', file, { ...validPin, size: content.length + 1 }),
      /size mismatch/
    );
    assert.strictEqual(fs.existsSync(file), false, 'size-rejected download must delete the partial file');

    fs.writeFileSync(file, content);
    await assert.rejects(
      verifyWhisperAsset({ name: 'not-in-manifest.zip', digest: '' }, file),
      /no locally pinned whisper.cpp manifest/,
      'unpinned Windows assets must fail closed'
    );
    assert.strictEqual(fs.existsSync(file), false, 'unpinned rejection must delete the downloaded archive');

    fs.writeFileSync(file, content);
    await assert.rejects(
      verifyWhisperAsset({ name: 'whisper-bin-x64.zip', digest: `sha256:${'0'.repeat(64)}` }, file),
      /does not match the pinned SHA-256/,
      'API digest disagreeing with the local pin must fail closed'
    );
    assert.strictEqual(fs.existsSync(file), false, 'digest mismatch must delete the downloaded archive');
    console.log('[PostinstallDigest] pinned size/sha256 gates reject and delete bad downloads (ok)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runVulkanBundleManifest() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'postinstall.js'), 'utf8');
  assert.match(source, /WHISPER_VULKAN_ARCHIVE/);
  assert.match(source, /VULKAN_ARCHIVE_SHA256/);
  assert.match(source, /hasVulkanRuntimeLibraries/);
  console.log('[VulkanBundle] pinned archive hash and local override seam are wired (ok)');
}

async function runVerifiedDownloader() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-verified-downloader-'));
  const noopDiskCheck = () => {};
  const makeResponse = (status, body, headers = {}) => {
    const data = new PassThrough();
    process.nextTick(() => data.end(body));
    return { status, headers, data };
  };
  const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const runDownload = (options) =>
    downloadVerifiedFile({
      assertDownloadDiskSpace: noopDiskCheck,
      activeDownloads: options.activeDownloads,
      axios: options.axios,
      ...options,
    });

  try {
    const exact = Buffer.from('exact-without-content-length');
    const exactPath = path.join(dir, 'exact.bin');
    await runDownload({
      activeDownloads: new Set(),
      axios: async () => makeResponse(200, exact),
      url: 'https://example.test/exact',
      partialPath: exactPath,
      label: 'exact',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.deepStrictEqual(fs.readFileSync(exactPath), exact, 'missing Content-Length must still verify exact bytes');

    const resumed = Buffer.from('resume-ok');
    const resumedPath = path.join(dir, 'resumed.bin');
    fs.writeFileSync(resumedPath, resumed.subarray(0, 3));
    await runDownload({
      activeDownloads: new Set(),
      axios: async (config) => {
        assert.strictEqual(config.headers.Range, 'bytes=3-', 'resume must send the current offset');
        return makeResponse(206, resumed.subarray(3), {
          'content-range': `bytes 3-${resumed.length - 1}/${resumed.length}`,
        });
      },
      url: 'https://example.test/resume',
      partialPath: resumedPath,
      label: 'resume',
      expectedSize: resumed.length,
      sha256: sha256(resumed),
    });
    assert.deepStrictEqual(fs.readFileSync(resumedPath), resumed, '206 response must append to the partial');

    const restart = Buffer.from('restart-once');
    const restartPath = path.join(dir, 'restart.bin');
    fs.writeFileSync(restartPath, restart.subarray(0, 4));
    let restartRequests = 0;
    await runDownload({
      activeDownloads: new Set(),
      axios: async (config) => {
        restartRequests++;
        if (restartRequests === 1) assert.strictEqual(config.headers.Range, 'bytes=4-');
        else assert.strictEqual(config.headers, undefined, 'full restart must drop Range');
        return makeResponse(200, restart);
      },
      url: 'https://example.test/range-ignored',
      partialPath: restartPath,
      label: 'range-ignored',
      expectedSize: restart.length,
      sha256: sha256(restart),
    });
    assert.strictEqual(restartRequests, 2, 'Range-ignoring endpoint gets one full restart, not an infinite loop');

    const hashPath = path.join(dir, 'hash-fail.bin');
    await assert.rejects(
      runDownload({
        activeDownloads: new Set(),
        axios: async () => makeResponse(200, exact),
        url: 'https://example.test/hash-fail',
        partialPath: hashPath,
        label: 'hash-fail',
        expectedSize: exact.length,
        sha256: '0'.repeat(64),
      }),
      /SHA-256 verification failed/
    );
    assert.strictEqual(fs.existsSync(hashPath), false, 'hash failure must not install the failed file');

    const mirror = Buffer.from('mirror-success');
    const mirrorPath = path.join(dir, 'mirror.bin');
    const mirrorUrls = [];
    await runDownload({
      activeDownloads: new Set(),
      axios: async (config) => {
        mirrorUrls.push(config.url);
        return config.url.includes('hf-mirror.com')
          ? makeResponse(200, mirror)
          : makeResponse(503, Buffer.from('busy'));
      },
      url: 'https://huggingface.co/example/model.bin',
      partialPath: mirrorPath,
      label: 'mirror',
      expectedSize: mirror.length,
      sha256: sha256(mirror),
    });
    // 공식 endpoint에 먼저 재시도 기회를 주고, 그래도 안 되면 미러로 넘어간다.
    assert.ok(mirrorUrls.length >= 2, 'mirror fallback must be attempted');
    assert.ok(
      mirrorUrls.slice(0, -1).every((u) => u.startsWith('https://huggingface.co/')),
      'the official endpoint must be retried before falling back'
    );
    assert.strictEqual(
      mirrorUrls[mirrorUrls.length - 1],
      'https://hf-mirror.com/example/model.bin',
      'the mirror is only used after the official endpoint keeps failing'
    );

    // 이미 다 받아둔 partial이 남은 경우: 재요청 없이 그대로 성공해야 한다.
    // 전에는 Range가 파일 끝을 가리켜 416으로 영영 막혔다.
    const donePath = path.join(dir, 'already-complete.bin');
    fs.writeFileSync(donePath, exact);
    let doneRequests = 0;
    await runDownload({
      activeDownloads: new Set(),
      axios: async () => {
        doneRequests++;
        return makeResponse(200, exact);
      },
      url: 'https://example.test/already-complete',
      partialPath: donePath,
      label: 'already-complete',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.strictEqual(doneRequests, 0, 'a verified complete partial must not be re-downloaded');

    // 크기만 같고 내용이 다른 partial은 버리고 다시 받아야 한다.
    const staleDone = path.join(dir, 'stale-complete.bin');
    fs.writeFileSync(staleDone, Buffer.alloc(exact.length, 0x41));
    await runDownload({
      activeDownloads: new Set(),
      axios: async () => makeResponse(200, exact),
      url: 'https://example.test/stale-complete',
      partialPath: staleDone,
      label: 'stale-complete',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.deepStrictEqual(fs.readFileSync(staleDone), exact, 'a complete but wrong partial must be refetched');

    // 416은 partial을 버리고 처음부터 받으라는 신호다(전에는 즉시 실패).
    const poisoned = path.join(dir, 'poisoned.bin');
    fs.writeFileSync(poisoned, Buffer.from('xx'));
    let poisonCalls = 0;
    await runDownload({
      activeDownloads: new Set(),
      axios: async () => (++poisonCalls === 1 ? makeResponse(416, Buffer.alloc(0)) : makeResponse(200, exact)),
      url: 'https://example.test/poisoned',
      partialPath: poisoned,
      label: 'poisoned',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.deepStrictEqual(fs.readFileSync(poisoned), exact, '416 must reset the partial and restart');

    // 완성된 partial 재사용 중에 취소하면 성공으로 묵지 말아야 한다.
    const cancelDuringHash = path.join(dir, 'cancel-during-hash.bin');
    fs.writeFileSync(cancelDuringHash, exact);
    let hashCancelled = false;
    await assert.rejects(
      runDownload({
        activeDownloads: new Set(),
        axios: async () => makeResponse(200, exact),
        isCancelled: () => {
          // 첫 호출(진입 가드)은 false, 해시 직후 호출부터 true.
          const was = hashCancelled;
          hashCancelled = true;
          return was;
        },
        url: 'https://example.test/cancel-during-hash',
        partialPath: cancelDuringHash,
        label: 'cancel-during-hash',
        expectedSize: exact.length,
        sha256: sha256(exact),
      }),
      /cancelled/
    );

    // 미지 길이 Content-Range(bytes a-b/*)는 정상 응답이다. 하드 실패시키면 안 된다.
    const starRange = path.join(dir, 'star-range.bin');
    fs.writeFileSync(starRange, resumed.subarray(0, 3));
    await runDownload({
      activeDownloads: new Set(),
      axios: async () => makeResponse(206, resumed.subarray(3), { 'content-range': 'bytes 3-8/*' }),
      url: 'https://example.test/star-range',
      partialPath: starRange,
      label: 'star-range',
      expectedSize: resumed.length,
      sha256: sha256(resumed),
    });
    assert.deepStrictEqual(fs.readFileSync(starRange), resumed, 'unknown-length Content-Range must still resume');

    // 전체 길이가 다른 206은 끝까지 받기 전에 멈춰야 한다.
    const revPath = path.join(dir, 'revision.bin');
    fs.writeFileSync(revPath, exact.subarray(0, 4));
    await assert.rejects(
      runDownload({
        activeDownloads: new Set(),
        axios: async () =>
          makeResponse(206, exact.subarray(4), { 'content-range': `bytes 4-${exact.length - 1}/999999` }),
        url: 'https://example.test/revision',
        partialPath: revPath,
        label: 'revision',
        expectedSize: exact.length,
        sha256: sha256(exact),
      }),
      /different total size/
    );

    // expectedSize가 없으면 조용히 진행하지 말고 거부해야 한다.
    await assert.rejects(
      runDownload({
        activeDownloads: new Set(),
        axios: async () => makeResponse(200, exact),
        url: 'https://example.test/no-size',
        partialPath: path.join(dir, 'no-size.bin'),
        label: 'no-size',
      }),
      /expectedSize is required/
    );

    // 중국난 사내망에서 흔한 DNS 차단은 재시도 대상이 아니다. 그래도 미러는 가야 한다.
    const blockedPath = path.join(dir, 'blocked.bin');
    const blockedUrls = [];
    await runDownload({
      activeDownloads: new Set(),
      axios: async (config) => {
        blockedUrls.push(config.url);
        if (config.url.includes('hf-mirror.com')) return makeResponse(200, exact);
        const err = new Error('getaddrinfo ENOTFOUND huggingface.co');
        err.code = 'ENOTFOUND';
        throw err;
      },
      url: 'https://huggingface.co/example/blocked.bin',
      partialPath: blockedPath,
      label: 'blocked',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.deepStrictEqual(
      blockedUrls,
      ['https://huggingface.co/example/blocked.bin', 'https://hf-mirror.com/example/blocked.bin'],
      'a blocked endpoint must switch to the mirror instead of failing outright'
    );

    // 지역 차단 프록시가 403을 돌려줘도 마찬가지다.
    const forbiddenPath = path.join(dir, 'forbidden.bin');
    const forbiddenUrls = [];
    await runDownload({
      activeDownloads: new Set(),
      axios: async (config) => {
        forbiddenUrls.push(config.url);
        return config.url.includes('hf-mirror.com')
          ? makeResponse(200, exact)
          : makeResponse(403, Buffer.from('blocked'));
      },
      url: 'https://huggingface.co/example/forbidden.bin',
      partialPath: forbiddenPath,
      label: 'forbidden',
      expectedSize: exact.length,
      sha256: sha256(exact),
    });
    assert.strictEqual(forbiddenUrls.length, 2, 'HTTP 403 must jump straight to the mirror');

    const cancelPath = path.join(dir, 'cancel.bin');
    const cancelSet = new Set();
    const stalled = new PassThrough();
    const cancelPromise = runDownload({
      activeDownloads: cancelSet,
      axios: async () => {
        process.nextTick(() => stalled.write(Buffer.from('partial')));
        return { status: 200, headers: {}, data: stalled };
      },
      url: 'https://example.test/cancel',
      partialPath: cancelPath,
      label: 'cancel',
      expectedSize: 20,
      sha256: sha256(Buffer.from('never-completes')),
    });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const wait = () => {
        const tracker = [...cancelSet][0];
        if (tracker?.writer && fs.existsSync(cancelPath) && fs.statSync(cancelPath).size >= 7) return resolve();
        if (Date.now() > deadline) return reject(new Error('cancel test did not produce a partial file'));
        setTimeout(wait, 5);
      };
      wait();
    });
    for (const tracker of cancelSet) {
      tracker.cancelled = true;
      tracker.controller?.abort();
      tracker.writer?.destroy();
    }
    await assert.rejects(cancelPromise, /cancelled/);
    assert.strictEqual(fs.readFileSync(cancelPath, 'utf8'), 'partial', 'cancel must preserve the partial');
    assert.strictEqual(cancelSet.size, 0, 'cancelled tracker must be removed only after pipeline settles');
    console.log('[VerifiedDownloader] exact, resume, restart, hash, mirror, and cancellation flows pass (ok)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSyncPreflightOrdering() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const downloader = fs.readFileSync(path.join(__dirname, '..', 'verified-downloader.js'), 'utf8');
  const preflight = source.indexOf('assertSyncInstallDiskSpace(');
  const firstDownload = source.indexOf('await ensureFasterWhisperEngine((pct)');
  assert.ok(
    preflight >= 0 && firstDownload >= 0 && preflight < firstDownload,
    'Sync disk preflight must run before download'
  );
  assert.match(
    source,
    /engineInstalled = !!\(existingExePath && fs\.existsSync\(existingExePath\)\)/,
    'Sync preflight must verify that the resolved engine executable actually exists'
  );
  assert.match(downloader, /fs\.statSync\(partialPath\)/, 'Sync downloads must resume from preserved partial files');
  assert.match(downloader, /Range: `bytes=\$\{offset\}-`/, 'Sync downloads must request HTTP Range when resuming');
  assert.match(
    source,
    /enginePartialBytes = engineArchiveReady/,
    'Sync preflight must count a verified final engine archive'
  );
  assert.match(
    source,
    /getReusablePartialSize\(enginePartialPath/,
    'Sync preflight must count existing engine partial bytes'
  );
  assert.match(
    source,
    /modelPartialBytes = getReusablePartialSize\(/,
    'Sync preflight must count existing model bytes'
  );
  assert.match(
    source,
    /ensureFasterWhisperEngine\(\(pct\) => emit\(pct \* 0\.32\), engineArchiveReady\)/,
    'Sync install must reuse the archive verified before preflight'
  );
  assert.match(source, /Preserving stale sibling WAV/, 'stale sibling WAVs must stay in place');
  assert.doesNotMatch(source, /backupStaleWav/, 'conversion must not create accumulating stale WAV backups');
  console.log('[SyncDiskPreflight] install peak, partial cleanup, and stale WAV preservation are wired (ok)');
}

function runWhisperDeviceRouting() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function resolveDevice(');
  const end = source.indexOf('// Enhanced memory/GPU cleanup', start);
  assert.ok(start >= 0 && end > start, 'resolveDevice source must be present');
  const makeResolver = (cuda, vulkan) =>
    // pi-lens-ignore: ast-grep:no-global-eval-js
    new Function('isCudaAvailable', 'isVulkanAvailable', `${source.slice(start, end)}\nreturn resolveDevice;`)(
      () => cuda,
      () => vulkan
    );

  assert.strictEqual(makeResolver(true, true)('auto', '/app'), 'cuda');
  assert.strictEqual(makeResolver(false, true)('auto', '/app'), 'vulkan');
  assert.strictEqual(makeResolver(false, true)('cuda', '/app'), 'vulkan');
  assert.strictEqual(makeResolver(false, false)('auto', '/app'), 'cpu');
  assert.strictEqual(makeResolver(true, true)('cpu', '/app'), 'cpu');
  assert.strictEqual(makeResolver(true, true)('unknown', '/app'), 'cpu');
  assert.match(source, /useVulkanBuild = chosenDevice === 'vulkan'/, 'Vulkan must select its bundled CLI directory');
  assert.match(
    source,
    /function extractSingleFileOnce\(/,
    'GPU fallback must preserve a single-attempt extraction seam'
  );
  assert.match(source, /candidate === 'cpu' \|\| !isWhisperFallbackEligible/, 'CPU and input failures must not retry');
  assert.match(source, /isSyncEngineModel\(model\)/, 'Sync extraction must remain outside the Vulkan fallback wrapper');
  console.log('[WhisperDevice] CUDA → Vulkan → CPU routing and fallback seams are wired (ok)');
}

function runWhisperFallbackEligibility() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function isWhisperFallbackEligible(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'isWhisperFallbackEligible source must be present');
  const makeEligible = (isUserStopped) =>
    // pi-lens-ignore: ast-grep:no-global-eval-js
    new Function('isUserStopped', `${source.slice(start, end)}\n}\nreturn isWhisperFallbackEligible;`)(isUserStopped);

  assert.strictEqual(
    makeEligible(false)({ message: 'spawn failed' }),
    true,
    'ordinary spawn errors must stay eligible for device fallback'
  );
  assert.strictEqual(makeEligible(false)({ inputError: true }), false, 'input errors must not retry other devices');
  assert.strictEqual(
    makeEligible(false)({ timedOut: true }),
    false,
    'timeouts must not re-run the whole video on every device'
  );
  assert.strictEqual(
    makeEligible(true)({ message: 'spawn failed' }),
    false,
    'user stop must win over fallback eligibility'
  );
  for (const message of [
    'stopped by user',
    'operation cancelled',
    'model not found: ggml-tiny.bin',
    'not enough disk space',
  ]) {
    assert.strictEqual(makeEligible(false)({ message }), false, `fallback must stop on: ${message}`);
  }
  console.log('[WhisperFallback] timeout/input/user-stop/disk guards keep device fallback from looping (ok)');
}

function runPackageNoticesConfig() {
  const root = path.join(__dirname, '..');
  // pi-lens-ignore: unchecked-throwing-call-js
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const shipped = JSON.stringify(pkg.build.extraResources || []);
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(fs.existsSync(path.join(root, notice)), `${notice} must exist at the repo root`);
    assert.ok(shipped.includes(notice), `electron-builder build.extraResources must ship ${notice} into resources/`);
  }
  console.log('[PackageNotices] LICENSE and THIRD_PARTY_NOTICES.md ship into resources/ (ok)');
}

function runReleaseVulkanGate() {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const probe = source.indexOf('$vulkanLog = & "whisper-cpp/vulkan/whisper-cli.exe"');
  const cleanup = source.indexOf('Remove-Item $model -Force', probe);
  assert.ok(probe >= 0 && cleanup > probe, 'Vulkan transcription must run before the tiny model is removed');
  const gate = source.slice(probe, cleanup);
  for (const required of [
    String.raw`whisper_backend_init_gpu:\s+no GPU found`,
    'elseif ($vulkanNoGpu)',
    'if ($vulkanDeviceCount -eq 0)',
    'if ($vulkanTranscribeExit -ne 0)',
    'Test-Path "$vulkanOut.srt"',
    String.raw`whisper_backend_init_gpu:\s+using Vulkan\d+ backend`,
    String.raw`\d+:\d{2}:\d{2},\d{3} --> `,
  ]) {
    assert.ok(gate.includes(required), `Vulkan release gate is missing: ${required}`);
  }
  console.log('[ReleaseVulkanGate] device count, exit, backend, and real SRT gates are wired (ok)');
}

function runRendererSourceLangPayload() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const calls = [...source.matchAll(/window\.electronAPI\.translateSubtitle\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.strictEqual(calls.length, 2, 'renderer must have direct-SRT and post-extraction translation calls');
  for (const [, payload] of calls) {
    assert.match(
      payload,
      /sourceLang:\s*language === 'auto' \? null : language/,
      'each renderer translation payload must forward the selected source language'
    );
  }
  assert.match(
    source,
    /openFileLocation\(file\?\.outputPath \|\| file\?\.path\)/,
    'completed queue items must open the generated output when available'
  );
  console.log('[SourceLangPayload] translation source and completed output paths are wired (ok)');
}

async function runDownloadStreamSafety() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-download-stream-'));
  const dest = path.join(dir, 'partial.bin');
  try {
    const source = new PassThrough();
    let writer;
    const writing = writeDownloadStream(source, dest, (stream) => {
      writer = stream;
    });
    source.write('partial');
    source.destroy(new Error('forced stream failure'));
    await assert.rejects(writing, /forced stream failure/);
    assert.ok(writer.closed || writer.destroyed, 'failed download writer must be closed');
    assert.strictEqual(fs.existsSync(dest), false, 'failed download partial must be removed after close');
    console.log('[DownloadStreamSafety] stream errors close writer before partial cleanup (ok)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runWavHeaderSafety() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-wav-header-'));
  const wav = path.join(dir, 'header.wav');
  const originalRead = fs.readSync;
  let maxReadLength = 0;
  fs.readSync = (fd, buffer, offset, length, position) => {
    maxReadLength = Math.max(maxReadLength, length);
    return originalRead(fd, buffer, offset, length, position);
  };
  try {
    const riff = Buffer.alloc(44);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(riff.length - 8, 4);
    riff.write('WAVE', 8, 'latin1');
    fs.writeFileSync(wav, riff);
    assert.strictEqual(isCompleteWavFile(wav, riff.length), true);
    riff.writeUInt32LE(1, 4);
    fs.writeFileSync(wav, riff);
    assert.strictEqual(isCompleteWavFile(wav, riff.length), false, 'truncated RIFF size must be rejected');

    const rf64 = Buffer.alloc(48);
    rf64.write('RF64', 0, 'latin1');
    rf64.writeUInt32LE(0xffffffff, 4);
    rf64.write('WAVE', 8, 'latin1');
    rf64.write('ds64', 12, 'latin1');
    rf64.writeUInt32LE(28, 16);
    rf64.writeBigUInt64LE(BigInt(rf64.length - 8), 20);
    fs.writeFileSync(wav, rf64);
    assert.strictEqual(isCompleteWavFile(wav, rf64.length), true);
    rf64.write('JUNK', 12, 'latin1');
    fs.writeFileSync(wav, rf64);
    assert.strictEqual(isCompleteWavFile(wav, rf64.length), false, 'RF64 without first ds64 chunk must be rejected');
    assert.ok(maxReadLength <= 64, `WAV validation read too much: ${maxReadLength}`);
    console.log('[WavHeaderSafety] RIFF/RF64 validated with at most 64 header bytes (ok)');
  } finally {
    fs.readSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runDiskSpaceGuard() {
  assert.strictEqual(getSyncInstallRequiredBytes(true, true), 0);
  assert.strictEqual(getSyncInstallRequiredBytes(true, false), SYNC_MODEL_BYTES);
  assert.strictEqual(getSyncInstallRequiredBytes(false, true), SYNC_ENGINE_EXTRACTION_PEAK_BYTES);
  assert.strictEqual(
    getSyncInstallRequiredBytes(false, false),
    SYNC_ENGINE_EXTRACTED_BYTES + SYNC_MODEL_BYTES,
    'fresh Sync install must include the extracted engine and model together'
  );

  const mib = 1024 ** 2;
  const modelRemaining = 64 * mib;
  assert.strictEqual(
    getSyncInstallRequiredBytes(true, false, 0, SYNC_MODEL_BYTES - modelRemaining),
    modelRemaining,
    'an installed engine with a nearly complete model partial needs only the remaining model bytes'
  );
  const engineRemaining = 64 * mib;
  assert.strictEqual(
    getSyncInstallRequiredBytes(false, true, SYNC_ENGINE_ARCHIVE_BYTES - engineRemaining),
    SYNC_ENGINE_EXTRACTED_BYTES + engineRemaining,
    'an engine partial must still reserve its remaining download plus extraction space'
  );
  assert.strictEqual(
    getSyncInstallRequiredBytes(false, true, SYNC_ENGINE_ARCHIVE_BYTES),
    SYNC_ENGINE_EXTRACTED_BYTES,
    'a verified final engine archive must require extraction space without duplicate download space'
  );
  const largerModelRemaining = 512 * mib;
  assert.strictEqual(
    getSyncInstallRequiredBytes(
      false,
      false,
      SYNC_ENGINE_ARCHIVE_BYTES - engineRemaining,
      SYNC_MODEL_BYTES - largerModelRemaining
    ),
    SYNC_ENGINE_EXTRACTED_BYTES + engineRemaining,
    'nearly complete partials must still reserve the larger engine extraction peak'
  );
  const engineProgress = 128 * mib;
  assert.strictEqual(
    getSyncInstallRequiredBytes(false, false, engineProgress, 0),
    SYNC_ENGINE_EXTRACTED_BYTES + SYNC_MODEL_BYTES - engineProgress,
    'fresh model download must keep the final engine+model peak after the engine archive is removed'
  );
  assert.strictEqual(
    getSyncInstallRequiredBytes(true, false, 0, 0),
    SYNC_MODEL_BYTES,
    'an oversized partial discarded by main must not reduce the required bytes'
  );
  assert.strictEqual(
    getSyncInstallRequiredBytes(true, false, 0, Number.NaN),
    SYNC_MODEL_BYTES,
    'invalid partial progress must not reduce the required bytes'
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-disk-space-'));
  const dest = path.join(dir, 'models', 'model.bin');
  try {
    const validPartial = path.join(dir, 'valid.partial');
    fs.writeFileSync(validPartial, '1234');
    assert.strictEqual(getReusablePartialSize(validPartial, 5), 4);
    assert.ok(fs.existsSync(validPartial), 'valid partial must be preserved for resume');

    const oversizedPartial = path.join(dir, 'oversized.partial');
    fs.writeFileSync(oversizedPartial, '123456');
    assert.strictEqual(getReusablePartialSize(oversizedPartial, 5), 0);
    assert.ok(!fs.existsSync(oversizedPartial), 'oversized partial must be removed before disk preflight');

    assert.strictEqual(assertSyncInstallDiskSpace(dest, true, true), 0);
    const { bavail, bsize } = fs.statfsSync(dir);
    const freeBytes = bavail * bsize;
    if (freeBytes > 256 * 1024 * 1024 + 1) {
      assert.doesNotThrow(() => assertDownloadDiskSpace(dest, 1));
      assert.ok(fs.existsSync(path.dirname(dest)), 'first-run model directory is created before statfs');
    }
    assert.throws(() => assertDownloadDiskSpace(dest, freeBytes), /Not enough disk space/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSrtCleanup() {
  // no-op when no options selected
  const base = '1\n00:00:01,000 --> 00:00:02,000\n>> Hello\n';
  assert.strictEqual(applySrtCleanup(base, {}), base);

  // speaker-change markers stripped
  const spk = applySrtCleanup('1\n00:00:01,000 --> 00:00:02,000\n>> Hi there\n', { removeSpeakerTags: true });
  assert.ok(!spk.includes('>>') && spk.includes('Hi there'));

  // SDH (A안): drop tag-only cues, keep mixed lines, renumber
  const sdh = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    '[music playing]',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    "(sighs) I can't believe it",
    '',
    '3',
    '00:00:07,000 --> 00:00:08,000',
    '(applause)',
    '',
    '4',
    '00:00:09,000 --> 00:00:10,000',
    'Real dialogue',
    '',
  ].join('\n');
  const sdhOut = applySrtCleanup(sdh, { removeSDH: true });
  assert.ok(!sdhOut.includes('[music playing]') && !/\(applause\)/.test(sdhOut));
  assert.ok(sdhOut.includes("(sighs) I can't believe it") && sdhOut.includes('Real dialogue'));
  assert.deepStrictEqual(
    sdhOut.split(/\n\s*\n/).map((b) => b.split('\n')[0]),
    ['1', '2']
  );

  // isSdhOnlyText classification
  assert.strictEqual(isSdhOnlyText(['♪♪']), true);
  assert.strictEqual(isSdhOnlyText(['Hello']), false);
  // dialogue sandwiched between two sound tags must NOT be treated as SDH-only
  assert.strictEqual(isSdhOnlyText(['(grunting) Help me! (groans)']), false);
  assert.strictEqual(isSdhOnlyText(['[noise] Real line [end]']), false);
  assert.strictEqual(isSdhOnlyText(['(applause)']), true);
  // and such a mixed cue survives a full cleanup pass
  const mixed = '1\n00:00:01,000 --> 00:00:02,000\n(grunting) Help me! (groans)\n';
  assert.ok(applySrtCleanup(mixed, { removeSDH: true }).includes('Help me!'));

  // non-SRT input is never destroyed
  const garbage = 'just text\nno cues';
  assert.strictEqual(applySrtCleanup(garbage, { removeSDH: true }), garbage);
}

function runSrtFromWhisperJson() {
  // 실측 재현: VAD로 "ありがとうございます"(10자) 세그먼트가 59.85s->87.26s(27.4초)로 늘어났다.
  // (참고: -ojf 토큰 offsets는 VAD 압축 타임라인이라 원본 복원 불가 → 세그먼트 from/to만 쓴다.)
  // 시작은 그대로, 길이는 텍스트 분량(10자*350=3500ms)로 캅되어야 한다.
  const json = JSON.stringify({
    transcription: [
      { offsets: { from: 41370, to: 43360 }, text: ' どうだいいところだろ' },
      { offsets: { from: 59850, to: 87260 }, text: ' ありがとうございます' },
      { offsets: { from: 87260, to: 88250 }, text: ' どうですか' },
    ],
  });
  const srt = srtFromWhisperJson(json, { perCharMs: 350, minDisplayMs: 1200, maxDisplayMs: 7000 });
  assert.ok(srt && srt.includes('ありがとうございます'), 'SRT 생성됨');
  const blocks = srt.trim().split(/\n\s*\n/);
  // 1번: 일반 대사는 원본 길이 그대로 (41.37->43.36)
  assert.ok(/00:00:41,370 --> 00:00:43,360/.test(blocks[0]), '일반 대사는 원본 시각 유지: ' + blocks[0]);
  // 2번: 늘어진 것은 시작 그대로(59.85), 끝은 텍스트 비례 칅(59.85+3.5=63.35), 87s로 늘어면 안됨
  assert.ok(/00:00:59,850 --> 00:01:03,350/.test(blocks[1]), '늘어진 큐는 텍스트 분량으로 칅: ' + blocks[1]);
  assert.ok(!/--> 00:01:27,260/.test(blocks[1]), '늘어진 큐의 끝이 87.26s로 떨어지면 안 됨: ' + blocks[1]);
  // 3번: 다음 대사는 제 위치(87.26)에 뜨
  assert.ok(/00:01:27,260 --> /.test(srt), '다음 대사는 실제 발화 시각에 뜨');

  // 폴백: 깨진 JSON/빈 입력은 null (호출측이 -osrt로 폴백)
  assert.strictEqual(srtFromWhisperJson('not json'), null);
  assert.strictEqual(srtFromWhisperJson('{"transcription":[]}'), null);
  assert.strictEqual(srtFromWhisperJson(''), null);
}

function runWhisperRuntimeProbe() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-runtime-probe-'));
  try {
    assert.strictEqual(hasWhisperRuntimeLibraries(path.join(runtimeDir, 'missing-cli'), runtimeDir), false);
    assert.strictEqual(hasWhisperRuntimeLibraries(process.execPath, path.dirname(process.execPath)), true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function runModelResumeDiskSpace() {
  const https = require('https');
  const { EventEmitter } = require('events');
  const electronPath = require.resolve('electron');
  const originalElectron = require.cache[electronPath].exports;
  const originalGet = https.get;
  const originalStatfs = fs.statfsSync;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-model-resume-'));
  const controller = new AbortController();
  let rangeHeader = '';

  try {
    require.cache[electronPath].exports = { app: { getPath: () => root } };
    const model = localTranslator.MODELS[localTranslator.DEFAULT_MODEL_ID];
    const tmp = path.join(root, 'hy-mt-models', model.file + '.tmp');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, '');
    fs.truncateSync(tmp, 800 * 1024 * 1024);
    // 전체 모델+예비 공간은 부족하지만, 남은 333MB+예비 공간은 충분한 상태.
    fs.statfsSync = () => ({ bavail: 900, bsize: 1024 * 1024 });
    https.get = (_url, options) => {
      rangeHeader = options?.headers?.Range || '';
      const request = new EventEmitter();
      request.destroy = () => request.emit('error', new Error('socket closed'));
      queueMicrotask(() => controller.abort(new Error('ABORTED: resume probe')));
      return request;
    };

    await assert.rejects(() => localTranslator.downloadModel(null, controller.signal), /ABORTED: resume probe/);
    assert.strictEqual(rangeHeader, 'bytes=838860800-', 'disk guard must allow download resume from the partial size');

    // Range를 무시한 200 응답에서 전체 재다운로드 공간이 부족하면 partial을 지우지 않는다.
    fs.writeFileSync(tmp, '');
    fs.truncateSync(tmp, 800 * 1024 * 1024);
    const controller2 = new AbortController();
    https.get = (_url, options, callback) => {
      rangeHeader = options?.headers?.Range || '';
      const request = new EventEmitter();
      request.destroy = () => request.emit('error', new Error('socket closed'));
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': String(model.sizeBytes) };
      response.resume = () => {};
      response.destroy = () => {};
      queueMicrotask(() => callback(response));
      return request;
    };
    await assert.rejects(() => localTranslator.downloadModel(null, controller2.signal), /Not enough disk space/);
    assert.strictEqual(rangeHeader, 'bytes=838860800-');
    assert.strictEqual(fs.statSync(tmp).size, 800 * 1024 * 1024, 'Range-ignored disk failure must preserve partial');

    fs.writeFileSync(tmp, 'resume-me');
    fs.statfsSync = () => ({ bavail: 4096, bsize: 1024 * 1024 });
    https.get = () => {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => request.emit('error', new Error('network interrupted')));
      return request;
    };
    await assert.rejects(() => localTranslator.downloadModel(null), /network interrupted/);
    assert.strictEqual(fs.readFileSync(tmp, 'utf8'), 'resume-me', 'network failures must preserve resumable data');

    fs.rmSync(tmp, { force: true });
    let firstProgressCalls = 0;
    let redirectRequests = 0;
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new PassThrough();
        if (redirectRequests++ === 0) {
          response.statusCode = 302;
          response.headers = { location: 'https://final.test/model' };
          callback(response);
          response.end();
          request.emit('error', new Error('retired model redirect failed'));
          return;
        }
        response.statusCode = 200;
        response.headers = { 'content-length': '3' };
        callback(response);
        response.end('abc');
      });
      return request;
    };
    await localTranslator.downloadModel(() => firstProgressCalls++);
    assert.ok(firstProgressCalls > 0, 'the first download caller must receive progress');
  } finally {
    https.get = originalGet;
    fs.statfsSync = originalStatfs;
    require.cache[electronPath].exports = originalElectron;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runModelDownloadAbort() {
  const https = require('https');
  const { EventEmitter } = require('events');
  const electronPath = require.resolve('electron');
  const originalElectron = require.cache[electronPath].exports;
  const originalGet = https.get;
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-model-abort-'));
  const controller = new AbortController();
  let requestCount = 0;
  let destroyed = false;

  try {
    require.cache[electronPath].exports = { app: { getPath: () => modelDir } };
    // 구현이 https.get(url, { headers }, callback) 형태로 바뀌어 mock도 옵션 인자를 받는다.
    https.get = (_url, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const request = new EventEmitter();
      request.destroy = () => {
        destroyed = true;
        request.emit('error', new Error('socket closed'));
      };
      requestCount++;
      if (requestCount === 1) {
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 302;
          response.headers = { location: 'https://example.test/model' };
          response.resume = () => {};
          cb(response);
        });
      } else {
        queueMicrotask(() => controller.abort(new Error('ABORTED: test download')));
      }
      return request;
    };

    await assert.rejects(() => localTranslator.downloadModel(null, controller.signal), /ABORTED: test download/);
    assert.strictEqual(requestCount, 2, 'download should follow one redirect before aborting');
    assert.strictEqual(destroyed, true, 'abort should destroy the active request before a response arrives');

    requestCount = 0;
    destroyed = false;
    https.get = (_url, _options, _callback) => {
      const request = new EventEmitter();
      request.destroy = () => {
        destroyed = true;
        request.emit('error', new Error('socket closed'));
      };
      requestCount++;
      return request;
    };

    const owner = new AbortController();
    const ownerDownload = localTranslator.downloadModel(null, owner.signal);
    const waiter = new AbortController();
    waiter.abort(new Error('ABORTED: second waiter'));
    await assert.rejects(() => localTranslator.downloadModel(null, waiter.signal), /ABORTED: second waiter/);
    assert.strictEqual(destroyed, false, 'a waiting caller must not cancel the shared transfer');
    owner.abort(new Error('ABORTED: download owner'));
    await assert.rejects(() => ownerDownload, /ABORTED: download owner/);
    assert.strictEqual(requestCount, 1, 'shared callers must reuse one request');
    assert.strictEqual(destroyed, true, 'the transfer owner must still be able to cancel the request');
  } finally {
    https.get = originalGet;
    require.cache[electronPath].exports = originalElectron;
    fs.rmSync(modelDir, { recursive: true, force: true });
  }
}

async function runLocalTranslationGuards() {
  assert.strictEqual(localTranslator.looksUntranslated('Hola mundo!', 'Hola mundo.', 'en'), true);
  assert.strictEqual(localTranslator.looksUntranslated('Hello world', 'Hola mundo', 'en'), false);
  assert.strictEqual(localTranslator.looksUntranslated('こんにちは', 'こんにちは', 'en'), true);
  assert.strictEqual(localTranslator.isEffectivelySameText('Original: Hola mundo', 'Hola mundo', 1), true);

  // HIGH 1 — 고유명사/숫자 자막은 echo 오탐하지 않는다 (클라우드 폴백 비용 방지).
  assert.strictEqual(localTranslator.looksUntranslated('Episode 7', 'Episode 7', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('John Smith Tokyo', 'John Smith Tokyo', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('123', '123', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('안녕하세요', 'Hello', 'ko'), false);
  // 진짜 echo는 여전히 잡는다.
  assert.strictEqual(localTranslator.looksUntranslated('Hello there', 'Hello there', 'ko'), true);
  assert.strictEqual(localTranslator.isEffectivelySameText('Hi', 'Hi'), false, '2자 이하 스킵 (기존 동작 유지)');

  const waitForAbort = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(() => localTranslator.withTimeout(waitForAbort, 20), /LOCAL_TIMEOUT/);

  const parent = new AbortController();
  const aborted = localTranslator.withTimeout(waitForAbort, 1000, parent.signal);
  parent.abort(new Error('ABORTED: test'));
  await assert.rejects(() => aborted, /ABORTED/);

  const sequential = new EnhancedSubtitleTranslator();
  let active = 0;
  let maxActive = 0;
  sequential.translateAuto = async (text) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return `translated ${text}`;
  };
  await sequential.translateBatch(['one', 'two', 'three'], 'local', 'en');
  assert.strictEqual(maxActive, 1, 'local translations must not queue parallel work behind the model mutex');

  const timeout = new EnhancedSubtitleTranslator();
  timeout.translateAuto = async () => {
    throw new Error('LOCAL_TIMEOUT: test');
  };
  await assert.rejects(() => timeout.translateBatch(['one', 'two'], 'local', 'en'), /LOCAL_TIMEOUT/);

  const passthrough = new EnhancedSubtitleTranslator();
  let calls = 0;
  passthrough.translateAuto = async () => {
    calls++;
    throw new Error('LOCAL_UNTRANSLATED: test');
  };
  await assert.rejects(
    () => passthrough.translateBatch(['one', 'two', 'three', 'four', 'five', 'six'], 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );
  assert.strictEqual(calls, 5, 'repeated local echoes should fail before processing the whole file');

  const makeSrt = (texts) =>
    texts
      .map(
        (text, i) =>
          `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},000\n${text}`
      )
      .join('\n\n');

  const exactEcho = new EnhancedSubtitleTranslator();
  exactEcho.translateBatch = async (texts) => texts;
  await assert.rejects(
    () => exactEcho.translateSRTContent(makeSrt(Array(4).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const normalizedGuard = new EnhancedSubtitleTranslator();
  normalizedGuard.translateBatch = async (texts) => texts.map((text) => `${text}!!!`);
  await assert.rejects(
    () => normalizedGuard.translateSRTContent(makeSrt(Array(4).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const mostlyUntranslated = new EnhancedSubtitleTranslator();
  mostlyUntranslated.translateBatch = async (texts) =>
    texts.map((text, index) => (index === 4 ? 'Translated line' : text));
  await assert.rejects(
    () => mostlyUntranslated.translateSRTContent(makeSrt(Array(5).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const labeledEcho = new EnhancedSubtitleTranslator();
  labeledEcho.translateBatch = async (texts) => texts.map((text) => `Original: ${text}`);
  await assert.rejects(
    () => labeledEcho.translateSRTContent(makeSrt(['Hola mundo']), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const validWithName = new EnhancedSubtitleTranslator();
  validWithName.translateBatch = async () => ['Christopher', 'Hello', 'Good morning', 'Thank you', 'Goodbye'];
  const validOutput = await validWithName.translateSRTContent(
    makeSrt(['Christopher', 'Hola', 'Buenos días', 'Gracias', 'Adiós']),
    'local',
    'en'
  );
  assert.ok(validOutput.includes('Christopher') && validOutput.includes('Goodbye'));

  const onlineProperName = new EnhancedSubtitleTranslator();
  // 고유명사 'Christopher'가 원문 유지로 남아도 나머지 줄이 번역되면
  // PASSTHROUGH가 아니다 (이름 보존은 정상 동작).
  onlineProperName.translateBatch = async (_texts) => ['Christopher', 'Hello', 'Good morning', 'Thank you', 'Goodbye'];
  const onlineProperNameOutput = await onlineProperName.translateSRTContent(
    makeSrt(['Christopher', 'Hola', 'Buenos días', 'Gracias', 'Adiós']),
    'chatgpt',
    'en'
  );
  assert.ok(onlineProperNameOutput.includes('Christopher'));
  assert.ok(onlineProperNameOutput.includes('Hello'));

  const onlinePassthrough = new EnhancedSubtitleTranslator();
  onlinePassthrough.translateBatch = async (texts) => texts;
  await assert.rejects(
    () => onlinePassthrough.translateSRTContent(makeSrt(Array(5).fill('Hola mundo')), 'chatgpt', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );
}

async function runMyMemoryErrorPhrase() {
  // 이슈 #42: MyMemory는 실패해도 HTTP 200 + 에러 문구를 translatedText로 돌려준다.
  // 이 문구가 번역 결과로 반환되어 자막 파일에 기록되지 않아야 한다.
  const MyMemoryTranslator = require('../myMemoryTranslator');
  const axios = require('axios');
  const originalGet = axios.get;
  const mem = new MyMemoryTranslator();
  mem.maxRetries = 2; // 테스트 시간 단축
  axios.get = async () => ({
    data: {
      responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES' },
      responseStatus: 200,
    },
  });
  try {
    await assert.rejects(
      () => mem.translate('こんにちは', 'ja', 'en'),
      /error message instead of a translation|quota exceeded/
    );
    console.log('[MyMemory] error phrase not returned as translation (ok)');
  } finally {
    axios.get = originalGet;
  }
}

async function runRetryOn429Case() {
  // 이슈 #43: deepl-node는 'Too many requests'(소문자 m)를 던진다.
  // 대소문자와 무관하게 429로 인식해 재시도하지 않아야 한다.
  const translator = new EnhancedSubtitleTranslator();
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error('Too many requests, DeepL servers are currently experiencing high load');
  };
  await assert.rejects(() => translator.translateWithRetry(fn, 'x', 5), /Too many requests/);
  assert.strictEqual(calls, 1, 'lowercase "Too many requests" must be treated as permanent (no retry)');
  console.log('[Retry] lowercase 429 message not retried (ok)');
}

async function runThrottleSerialization() {
  // P2-7: throttleRequest가 Promise 체인으로 직렬화되어 동시 진입 호출이
  // 최소 간격을 서로 지킨다. 10개를 동시에 던져도 각 요청 시각 간격이
  // minRequestInterval 미만으로 붙지 않아야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.minRequestInterval = 30;
  const times = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const start = Date.now();
      await translator.throttleRequest();
      return Date.now() - start; // 소요시간이 아니라 완료 시점 간격으로 검증
    })
  );
  // 10개가 순차로 완료되므로 완료 시각이 서로 다르다 (최소 간격 미만으로 몰리지 않음).
  const sorted = [...times].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i] - sorted[i - 1] >= 0 && sorted[i] !== sorted[i - 1],
      `throttle calls must serialize, got ${sorted[i - 1]}->${sorted[i]}`
    );
  }
  console.log('[Throttle] 10 concurrent calls serialized with interval (ok)');
}

function runCacheKeyConsistency() {
  // P2-10: 캐시 키에 sourceLang/contextAware 플래그가 반영되어 서로 다른
  // 소스 언어·컨텍스트 요청끼리 결과가 교차하지 않는다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.enableCache = true;
  const base = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko');
  const withSrc = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', 'en');
  const withCtx = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', null, true);
  // 이 두 문맥은 기존 32비트 hashString에서 실제로 충돌한다. SHA-256 문맥
  // 지문은 길이와 구형 해시가 같은 문맥도 분리해야 한다.
  assert.strictEqual(translator.hashString('before Aa'), translator.hashString('before BB'));
  const withDeepLCtxA = translator.getCacheKey('hello', 'deepl', 'ko', 'en', 'before Aa');
  const withDeepLCtxB = translator.getCacheKey('hello', 'deepl', 'ko', 'en', 'before BB');
  assert.notStrictEqual(base, withSrc, 'sourceLang must be part of cache key');
  assert.notStrictEqual(base, withCtx, 'contextAware flag must be part of cache key');
  assert.notStrictEqual(withDeepLCtxA, withDeepLCtxB, 'DeepL context content must be part of cache key');
  // 동일 입력·동일 소스는 같은 키 (캐시 적중 유지)
  assert.strictEqual(
    translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', 'en'),
    withSrc,
    'same sourceLang must produce same key'
  );
  console.log('[CacheKey] sourceLang/contextAware flags isolated (ok)');
}

async function runDeepLNeighborContext() {
  const texts = ['cue A', 'cue B', 'cue C', 'cue D', 'cue E'];
  const srt = texts
    .map((text, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index + 1},000\n${text}`)
    .join('\n\n');
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    preferredService: 'deepl',
    batchTranslation: true,
    maxConcurrent: 2,
  };
  translator.getOptimalBatchSize = () => 2;
  const received = new Map();
  translator.translateAuto = async (text, method, targetLang, sourceLang, context) => {
    received.set(text, { method, targetLang, sourceLang, context });
    return `번역-${texts.indexOf(text)}`;
  };

  await translator.translateSRTContent(srt, 'deepl', 'KO', null, 'ja');
  assert.deepStrictEqual(
    texts.map((text) => received.get(text)?.context),
    ['cue B\ncue C', 'cue A\ncue C\ncue D', 'cue A\ncue B\ncue D\ncue E', 'cue B\ncue C\ncue E', 'cue C\ncue D'],
    'DeepL must receive the two preceding and two following cues'
  );
  assert.ok([...received.values()].every((item) => item.sourceLang === 'ja'));

  const nonDeepL = new EnhancedSubtitleTranslator();
  nonDeepL.apiKeys.batchTranslation = false;
  const nonDeepLContexts = [];
  nonDeepL.translateAuto = async (_text, _method, _targetLang, _sourceLang, context) => {
    nonDeepLContexts.push(context);
    return '번역';
  };
  await nonDeepL.translateSRTContent(srt, 'mymemory', 'ko', null, 'ja');
  assert.ok(
    nonDeepLContexts.every((context) => context == null),
    'non-DeepL engines must not receive DeepL context'
  );

  const cached = new EnhancedSubtitleTranslator();
  cached.apiKeys.deepl = 'test-key';
  cached.apiKeys.enableCache = true;
  cached.throttleRequest = async () => {};
  const apiContexts = [];
  cached.deeplTranslator = {
    translateText: async (_text, _sourceLang, _targetLang, options) => {
      apiContexts.push(options?.context || null);
      return { text: `translated with ${options?.context}` };
    },
  };
  const first = await cached.translateWithDeepL('same cue', 'KO', 'ja', 'before Aa');
  const firstCached = await cached.translateWithDeepL('same cue', 'KO', 'ja', 'before Aa');
  const second = await cached.translateWithDeepL('same cue', 'KO', 'ja', 'before BB');
  assert.strictEqual(firstCached, first, 'same DeepL context must reuse the cache');
  assert.notStrictEqual(second, first, 'different DeepL context must not reuse a stale translation');
  assert.deepStrictEqual(apiContexts, ['before Aa', 'before BB']);
  console.log('[DeepLContext] neighboring cues forwarded and cache isolated (ok)');
}

async function runSerial429Propagation() {
  // P1-2: 직렬 translateBatch도 429를 삼키지 않고 API_QUOTA_EXCEEDED로 전파한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.batchTranslation = false; // 직렬 경로 강제
  translator.translateAuto = async () => {
    throw new Error('Too many requests');
  };
  await assert.rejects(
    () => translator.translateBatch(['a', 'b', 'c'], 'mymemory', 'ko', null),
    /API_QUOTA_EXCEEDED/,
    'serial path must propagate 429'
  );
  console.log('[Serial429] serial batch propagates API_QUOTA_EXCEEDED (ok)');
}

async function runSerialRetry429Propagation() {
  // F3-1: 직렬 retry 루프 안에서 폴백 서비스가 429를 던지면 재시도를 포기하고
  // API_QUOTA_EXCEEDED로 전파해야 한다 (원문 유지로 삼키지 않는다).
  // 첫 시도는 할당량과 무관한 오류로 실패 → retry 1회차(폴백)에서 429 발생.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.batchTranslation = false; // 직렬 경로 강제
  let calls = 0;
  translator.translateAuto = async (_text, _method) => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET network blip'); // 일시 장애
    throw new Error('Too many requests'); // retry(폴백)에서 429
  };
  await assert.rejects(
    () => translator.translateBatch(['a', 'b', 'c'], 'mymemory', 'ko', null),
    /API_QUOTA_EXCEEDED/,
    'serial retry loop must propagate 429'
  );
  console.log('[SerialRetry429] serial retry loop propagates API_QUOTA_EXCEEDED (ok)');
}

async function runSrtFileNoOutputOn429() {
  // F3-2: translateSRTFile이 429로 실패하면 출력 SRT 파일을 생성하면 안 된다.
  const translator = new EnhancedSubtitleTranslator();
  translator.translateSRTContent = async () => {
    throw new Error('API_QUOTA_EXCEEDED: Too many requests');
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-srt429-'));
  const inputPath = path.join(tmpDir, 'in.srt');
  const outputPath = path.join(tmpDir, 'out_ko.srt');
  fs.writeFileSync(inputPath, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  try {
    await assert.rejects(
      () => translator.translateSRTFile(inputPath, outputPath, 'mymemory', 'ko', null, 'en'),
      /API_QUOTA_EXCEEDED/,
      'translateSRTFile must rethrow 429'
    );
    assert.strictEqual(fs.existsSync(outputPath), false, 'no output file on quota failure');
    console.log('[SrtNoOutput] 429 leaves no partial output file (ok)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runQuotaClassification() {
  // F2: 403은 쿼터가 아니다 (인증/권한 오류 → 다음 서비스로 폴백돼야 한다).
  // translateAuto에서 403을 쿼터로 오판하면 API_QUOTA_EXCEEDED로 하드 스톱되므로,
  // 403은 계속 진행해 최종 폴백(원문 유지)까지 가야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { preferredService: 'deepl' }; // deepl 없음 → 첫 서비스 실패 후 폴백
  translator.translateWithMyMemory = async () => {
    throw new Error('MyMemory returned status 403');
  };
  translator.translateWithDeepL = async () => {
    throw new Error('DeepL status 403');
  };
  // 403은 쿼터가 아니므로 원문 유지로 끝나야 한다 (API_QUOTA_EXCEEDED 아님)
  const result = await translator.translateAuto('hello', 'deepl', 'ko', 'en');
  assert.strictEqual(result, 'hello', '403 must not hard-stop as quota; fall through to passthrough');
  console.log('[QuotaClass] 403 is not treated as quota (ok)');
}

async function runFinalFallbackQuotaPropagation() {
  // F5: 최종 폴백(모든 서비스 실패 후 MyMemory)에서 쿼터 초과는 원문 반환으로
  // 삼키지 않고 그대로 전파해야 한다 (할당량이면 나머지 줄도 전부 실패한다).
  // 루프 내 mymemory 호출(1회)은 일시 장애로 폴백을 계속하게 하고,
  // 최종 폴백 호출(2회)만 쿼터를 던지게 해 경로를 구분한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { preferredService: 'deepl' };
  translator.maxRetries = 1; // 재시도 카운트를 결정적으로 만들기 위해 고정
  translator.translateWithDeepL = async () => {
    throw new Error('DeepL network timeout'); // 일시 장애 → 폴백 계속
  };
  let myMemoryCalls = 0;
  translator.translateWithMyMemory = async () => {
    myMemoryCalls++;
    if (myMemoryCalls === 1) {
      throw new Error('MyMemory network timeout'); // 루프: 일시 장애 → 계속
    }
    throw new Error('MyMemory daily quota exceeded (status 429). Try again tomorrow'); // 최종 폴백: 쿼터
  };
  await assert.rejects(
    () => translator.translateAuto('hello', 'deepl', 'ko', 'en'),
    /daily quota exceeded/,
    'final fallback must propagate quota instead of returning original text'
  );
  assert.strictEqual(myMemoryCalls, 2, 'final fallback path was reached');
  console.log('[FinalFallback] quota in final fallback is propagated (ok)');
}

async function runParallelPathSourceLang() {
  // F1: 병렬(기본) 배치 경로가 _sourceLang을 translateAuto에 전달해야 한다.
  // 직렬 경로와 같은 힌트/캐시 키를 쓰도록 검증한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    preferredService: 'mymemory',
    batchTranslation: true, // 병렬 경로 강제
    maxConcurrent: 2,
  };
  let receivedSourceLang = null;
  translator.translateAuto = async (_text, _method, _targetLang, sourceLang) => {
    receivedSourceLang = sourceLang;
    return 'translated';
  };
  await translator.translateBatch(['a', 'b'], 'mymemory', 'ko', 'ja', null);
  assert.strictEqual(receivedSourceLang, 'ja', 'parallel batch path must forward _sourceLang to translateAuto');
  console.log('[ParallelPath] sourceLang forwarded in parallel batch (ok)');
}

async function runLoopLevelQuotaContinue() {
  // F2: 한 서비스(MyMemory)의 쿼터가 루프를 중단시키면 안 된다 — 뒤에 설정된
  // 서비스(DeepL)를 계속 시도해야 한다. 전 서비스가 실패한 경우에만 쿼터 전파.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    preferredService: 'mymemory',
    deepl: 'test-key', // 뒤에 DeepL이 설정됨
  };
  translator.maxRetries = 1;
  let deepLCalled = false;
  translator.translateWithMyMemory = async () => {
    throw new Error('MyMemory daily quota exceeded (status 429)');
  };
  translator.translateWithDeepL = async () => {
    deepLCalled = true;
    return 'DeepL translation';
  };
  const result = await translator.translateAuto('hello', 'mymemory', 'ko');
  assert.strictEqual(deepLCalled, true, 'DeepL must be attempted after MyMemory quota');
  assert.strictEqual(result, 'DeepL translation', 'successful later service wins over quota');

  // 반대: 전부 쿼터 실패면 전파되어야 한다 (원문 삼킴 금지).
  const translatorAllQuota = new EnhancedSubtitleTranslator();
  translatorAllQuota.apiKeys = {
    preferredService: 'mymemory',
    deepl: 'test-key',
  };
  translatorAllQuota.maxRetries = 1;
  translatorAllQuota.translateWithMyMemory = async () => {
    throw new Error('MyMemory daily quota exceeded (status 429)');
  };
  translatorAllQuota.translateWithDeepL = async () => {
    throw new Error('DeepL too many requests');
  };
  await assert.rejects(
    () => translatorAllQuota.translateAuto('hello', 'mymemory', 'ko'),
    /API_QUOTA_EXCEEDED/,
    'quota must propagate when all services are exhausted'
  );
  console.log('[LoopLevel] quota continues to next service, propagates only when all fail (ok)');
}

async function runDeepLUnsupportedTargetSkip() {
  // fa(페르시아어)는 DeepL 미지원 — mapToDeepLLang이 null을 돌려주고,
  // deepl 분기가 재시도 낭비 없이 다음 서비스로 건너뛰어야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    preferredService: 'deepl',
    deepl: 'test-key',
  };
  translator.maxRetries = 1;
  let deepLCalled = false;
  translator.translateWithDeepL = async () => {
    deepLCalled = true;
    return 'nope';
  };
  translator.translateWithMyMemory = async () => 'mymemory-fallback';
  // deepl이 null 랭귀지로 호출되는지 여부만 검증: translateAuto가 deepl 대신
  // 폴백(mymemory)으로 가는지 확인한다.
  const result = await translator.translateAuto('hello', 'deepl', 'fa');
  assert.strictEqual(deepLCalled, false, 'DeepL must not be called for unsupported target fa');
  assert.strictEqual(result, 'mymemory-fallback', 'fallback service handles fa');
  assert.strictEqual(translator.mapToDeepLLang('fa'), null, 'fa must map to null');
  // DeepL 지원 언어는 여전히 정상 매핑 (회귀 방지)
  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('en'), 'EN-US');
  console.log('[DeepLSkip] fa target skips DeepL without retry waste (ok)');
}

async function runDeepLFxSuffixHint() {
  // #48: Free 키에 ':fx' 접미사가 없으면 deepl-node가 Pro 엔드포인트로 보내
  // 인증 실패가 난다. 에러 분류가 키 자체 문제로만 안내하지 않고 :fx 힌트를 붙인다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { deepl: 'my-free-key-no-fx' };
  const msg = translator.classifyError({ message: 'Authentication failed (auth_key invalid)' }, 'deepl', 'ko');
  assert.ok(msg.includes(':fx'), `expected :fx hint in: ${msg}`);

  // :fx가 이미 붙은 키에는 힌트를 붙이지 않는다.
  translator.apiKeys = { deepl: 'my-free-key:fx' };
  const msg2 = translator.classifyError({ message: 'Authentication failed (auth_key invalid)' }, 'deepl', 'ko');
  assert.ok(!msg2.includes(':fx'), `no hint expected for :fx key, got: ${msg2}`);
  console.log('[DeepLFx] missing :fx suffix gets a hint (ok)');
}

async function runLocalContextPrecheck() {
  // LOCAL_TEXT_TOO_LONG: 컨텍스트 2048을 초과할 만한 긴 입력은 번역 전에 명확한 에러.
  const localTranslator = require('../local-translator');
  const longText = '가'.repeat(4000); // 라틴 4글자/토큰 + CJK 1글자/토큰 → 4000+ 토큰 추정
  await assert.rejects(
    () => localTranslator.translateLocal(longText, 'en', 'cpu', '1.8b'),
    /LOCAL_TEXT_TOO_LONG/,
    'overlong input must fail fast with LOCAL_TEXT_TOO_LONG'
  );
  console.log('[LocalPrecheck] overlong input rejected before model load (ok)');
}

async function runPassthroughProperNounBalance() {
  // F1: 고유명사/약어만 있는 원문(OK·NASA·R2D2)은 echo로 세지 않아
  // 1줄 SRT에서도 PASSTHROUGH 하드 실패가 나지 않아야 한다. 반대로
  // 'Hello' 같은 일반 단어가 echo로 돌아오면 무성 실패로 잡혀야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { preferredService: 'mymemory' };
  const srt = (text) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
  const runCase = async (text) => {
    translator.translateBatch = async (texts) => texts.map((t) => t.trim()); // echo 시뮬레이션
    return translator.translateSRTContent(srt(text), 'mymemory', 'ko');
  };
  // 약어/고유명사 1줄 echo → 성공 (PASSTHROUGH 아님)
  await runCase('OK');
  await runCase('NASA');
  await runCase('R2D2');
  // 일반 단어 1줄 echo → TRANSLATION_PASSTHROUGH
  await assert.rejects(
    () => runCase('Hello'),
    /TRANSLATION_PASSTHROUGH/,
    'single-line echo of a normal word must be flagged'
  );
  console.log('[Passthrough] proper-noun/acronym echo passes, normal word echo fails (ok)');
}

async function runPermanentErrorNoRetry() {
  // F3: MyMemory 영구 오류(입력/설정 오류)는 translateWithRetry에서도
  // 재시도 없이 즉시 전파되어야 한다 (translateAuto 레벨 3회 재호출 방지).
  const translator = new EnhancedSubtitleTranslator();
  translator.maxRetries = 3;
  let calls = 0;
  await assert.rejects(
    () =>
      translator.translateWithRetry(async () => {
        calls++;
        throw new Error('MyMemory returned an error message instead of a translation (permanent, not retried): X');
      }),
    /permanent, not retried/,
    'permanent error must propagate'
  );
  assert.strictEqual(calls, 1, 'permanent error must not be retried');
  console.log('[PermanentError] MyMemory permanent error is not retried (ok)');
}

async function runAbortSafeRetry() {
  // F4: 사용자 중지(ABORTED) 후 직렬 재시도가 유료 API(LLM)를 다시 호출하지 않는다.
  // 시나리오: 첫 시도가 네트워크 오류로 실패하는 사이 사용자가 중지 → 재시도 진입 시
  // abort 상태를 감지해 유료 서비스를 호출하지 않고 원문 유지.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    preferredService: 'mymemory',
    openai: 'sk-test',
    batchTranslation: false,
  };
  let llmCalls = 0;
  let myMemoryCalls = 0;
  translator.translateAuto = async () => {
    // 첫 시도는 네트워크 오류로 실패하고, 그 사이 사용자가 중지했다.
    translator._aborted = true;
    throw new Error('ECONNRESET network blip');
  };
  translator.translateWithMyMemory = async () => {
    myMemoryCalls++;
    throw new Error('ECONNRESET');
  };
  translator.translateWithLLM = async () => {
    llmCalls++;
    return 'should not happen';
  };
  await translator.translateBatch(['hello'], 'mymemory', 'ko', 'en');
  assert.strictEqual(llmCalls, 0, 'aborted retry must not call paid LLM API');
  assert.strictEqual(myMemoryCalls, 0, 'aborted retry must not call any API');

  const duringBackoff = new EnhancedSubtitleTranslator();
  let retryCalls = 0;
  const started = Date.now();
  const retrying = duringBackoff.translateWithRetry(async () => {
    retryCalls++;
    throw new Error('temporary network error');
  }, 'hello');
  setTimeout(() => duringBackoff.abort(), 25);
  await assert.rejects(retrying, /ABORTED/);
  assert.ok(Date.now() - started < 500, 'abort must interrupt retry backoff immediately');
  assert.strictEqual(retryCalls, 1, 'abort during backoff must prevent another API call');
  console.log('[AbortSafe] abort skips paid retries and interrupts active backoff (ok)');
}

async function runCustomPromptFingerprint() {
  // F5: 커스텀 공급자는 custom.prompt가 바뀌면 캐시 키(지문)가 달라져야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = {
    customProviders: [
      { id: 'p1', name: 'P1', model: 'm1', apiKey: 'k', baseUrl: 'https://x.test/v1', prompt: 'prompt-A' },
    ],
  };
  const keyA = translator.resolveProvider('custom:p1').cacheKey;
  translator.apiKeys.customProviders[0].prompt = 'prompt-B';
  const keyB = translator.resolveProvider('custom:p1').cacheKey;
  assert.notStrictEqual(keyA, keyB, 'custom prompt change must invalidate cache key');
  console.log('[CustomFp] custom prompt changes cache fingerprint (ok)');
}

async function runMyMemoryNormalPhrase() {
  // MED-1: 오류 문구로 시작하는 정상 번역 결과를 오탐하지 않는다.
  // startsWith 접두사 검사가 'Please select two distinct languages...'로
  // 시작하는 실제 번역을 영구 오류로 던지던 문제 — 정확 일치로 바뀌어
  // 정상 번역으로 반환되어야 한다.
  const MyMemoryTranslator = require('../myMemoryTranslator');
  const axios = require('axios');
  const originalGet = axios.get;
  const mem = new MyMemoryTranslator();
  mem.maxRetries = 2; // 테스트 시간 단축
  axios.get = async () => ({
    data: {
      responseData: { translatedText: 'Please select two distinct languages from the menu.' },
      responseStatus: 200,
    },
  });
  try {
    const result = await mem.translate('Please select two distinct languages from the menu.', 'en', 'ko');
    assert.strictEqual(result, 'Please select two distinct languages from the menu.');
    console.log('[MyMemory] normal translation containing error phrase is not misdetected (ok)');
  } finally {
    axios.get = originalGet;
  }
}

async function runAbortSurvivesLangLoop() {
  // HIGH-1: translateSRTFile은 매 호출 resetAbort()하므로, 한 번 중지해도
  // 같은 세션의 다음 새 번역 요청은 다시 시작할 수 있다. 언어 간 abort 보호는
  // main.js 루프가 translateSRTFile 호출 전 translator._aborted를 검사해
  // 남은 언어를 건너뛰는 방식으로 유지된다.
  const translator = new EnhancedSubtitleTranslator();
  translator.translateSRTContent = async (content) => content.replace('Hello', '안녕');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-abort-lang-'));
  const inputPath = path.join(tmpDir, 'in.srt');
  const outputPath = path.join(tmpDir, 'out_ko.srt');
  fs.writeFileSync(inputPath, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  try {
    await translator.translateSRTFile(inputPath, outputPath, 'mymemory', 'ko', null, 'en');
    assert.strictEqual(translator._aborted, false, 'fresh session runs normally');
    translator._aborted = true; // 사용자 중지 시뮬레이션
    // 중지 후 새 번역 요청: 플래그가 리셋되어 다시 성공해야 한다 (회귀-1).
    const out2 = path.join(tmpDir, 'out_ja.srt');
    await translator.translateSRTFile(inputPath, out2, 'mymemory', 'ja', null, 'en');
    assert.strictEqual(translator._aborted, false, 'new translation resets the abort flag');
    assert.ok(fs.existsSync(out2), 'translation after stop must produce an output file');
    // 단, 진행 중 abort는 번역 내부 루프에서 여전히 ABORTED로 전파된다.
    translator._aborted = true;
    await assert.rejects(
      () => translator.translateBatch(['Hello'], 'mymemory', 'ja', 'en'),
      /ABORTED/,
      'in-flight abort must still throw ABORTED'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('[AbortLangLoop] stop then new session translation succeeds, in-flight abort throws (ok)');
}

async function runAbortResetOnNewIpcRequest() {
  // MAJOR: translate-subtitle 핸들러는 진입 직후(언어 루프 전) resetAbort()하므로
  // 한 번 중지해도 다음 새 요청이 정상 시작된다. 루프의 _aborted 검사는 언어 간
  // 중지만 감지한다. main.js는 electron 의존으로 node에서 로드할 수 없어,
  // 핸들러 제어 흐름(진입 리셋 → 언어 루프 → ABORTED catch)을 그대로 시뮬레이션한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.translateSRTContent = async (content) => content.replace('Hello', '안녕');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-ipc-abort-'));
  const inputPath = path.join(tmpDir, 'in.srt');
  fs.writeFileSync(inputPath, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');

  const simulateHandler = async (langs, { stopAfterLang } = {}) => {
    const outputPaths = [];
    const failedLangs = [];
    try {
      translator.resetAbort(); // 핸들러 진입 (언어 루프 전)
      for (let li = 0; li < langs.length; li++) {
        const safeTarget = langs[li];
        // 루프의 중지 검사: 진입 시 리셋됐으므로 언어 간 중지만 감지한다.
        if (translator._aborted) throw new Error('ABORTED: Translation stopped by user');
        const outputPath = path.join(tmpDir, `out_${safeTarget}.srt`);
        try {
          const result = await translator.translateSRTFile(inputPath, outputPath, 'mymemory', safeTarget, null, 'en');
          outputPaths.push(result);
          if (stopAfterLang !== undefined && li === stopAfterLang) translator._aborted = true;
        } catch (langErr) {
          if (String(langErr?.message || '').includes('ABORTED')) throw langErr;
          failedLangs.push(safeTarget);
        }
      }
      return { success: true, outputPaths, failedLangs };
    } catch (error) {
      if (error.message && error.message.includes('ABORTED')) {
        // MED: 도중 중지여도 완료된 이전 언어 outputPaths를 응답에 포함한다.
        return {
          success: false,
          error: 'Stopped by user',
          userStopped: true,
          partialOutputPaths: outputPaths,
          outputPaths,
        };
      }
      throw error;
    }
  };

  try {
    // 1) MAJOR: 중지 후 새 translate-subtitle 요청이 루프 경로 포함해 정상 시작된다.
    translator._aborted = true; // 직전 요청이 사용자 중지로 끝난 상태
    const res = await simulateHandler(['ko', 'ja']);
    assert.strictEqual(res.success, true, 'new request after stop must not be blocked');
    assert.strictEqual(res.outputPaths.length, 2, 'all languages must run after entry reset');
    assert.ok(fs.existsSync(path.join(tmpDir, 'out_ko.srt')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'out_ja.srt')));

    // 2) MED: 2번째 언어 도중 중지 → 1번째 언어 SRT가 partialOutputPaths에 포함된다.
    const partial = await simulateHandler(['ko', 'ja'], { stopAfterLang: 0 });
    assert.strictEqual(partial.success, false);
    assert.strictEqual(partial.userStopped, true);
    assert.deepStrictEqual(partial.partialOutputPaths, [path.join(tmpDir, 'out_ko.srt')]);
    assert.deepStrictEqual(partial.outputPaths, [path.join(tmpDir, 'out_ko.srt')]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('[AbortResetOnNewIpcRequest] stop-then-new-request starts, partial langs in abort response (ok)');
}

async function runParallelLastWindowAbort() {
  // 남은-2: 병렬 루프의 마지막 윈도우에서 abort가 감지되면 원문 push 없이
  // ABORTED를 throw해 Promise.all이 상위로 전파해야 한다 (부분 파일 success 방지).
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { preferredService: 'mymemory', batchTranslation: true, maxConcurrent: 2 };
  let calls = 0;
  translator.translateAuto = async (text) => {
    calls++;
    if (calls === 1) translator._aborted = true; // 마지막(유일) 윈도우 도중에 사용자 중지
    return 'ok-' + text;
  };
  await assert.rejects(
    () => translator.translateBatch(['a', 'b', 'c'], 'mymemory', 'ko', 'en'),
    /ABORTED/,
    'parallel last-window abort must propagate ABORTED, not partial results'
  );
  console.log('[ParallelLastWindowAbort] last-window abort propagates ABORTED (ok)');
}

async function runParallelRetryDedupe() {
  // HIGH-2: 병렬 재시도가 translateAuto(전체 폴백 체인)를 재호출하지 않고
  // 폴백 서비스만 직접 호출한다 — translateAuto 호출은 텍스트당 1회여야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys = { preferredService: 'mymemory', batchTranslation: true, maxConcurrent: 2 };
  let autoCalls = 0;
  translator.translateAuto = async () => {
    autoCalls++;
    throw new Error('ECONNRESET blip');
  };
  translator.translateWithMyMemory = async () => 'fallback-ok';
  const results = await translator.translateBatch(['a', 'b'], 'deepl', 'ko', 'en');
  assert.deepStrictEqual(results, ['fallback-ok', 'fallback-ok']);
  assert.strictEqual(autoCalls, 2, 'parallel retry must not re-run the whole translateAuto chain');

  // 폴백 서비스의 쿼터는 전파된다 (원문 유지로 삼키지 않음).
  const quotaT = new EnhancedSubtitleTranslator();
  quotaT.apiKeys = { preferredService: 'mymemory', batchTranslation: true, maxConcurrent: 2 };
  quotaT.translateAuto = async () => {
    throw new Error('ECONNRESET blip');
  };
  quotaT.translateWithMyMemory = async () => {
    throw new Error('MyMemory daily quota exceeded (status 429)');
  };
  await assert.rejects(
    () => quotaT.translateBatch(['a', 'b'], 'deepl', 'ko', 'en'),
    /API_QUOTA_EXCEEDED/,
    'quota from parallel fallback must propagate'
  );
  console.log('[ParallelRetry] parallel retry dedupes chain, propagates quota (ok)');
}

async function runThrottleTiers() {
  // MED-4: 공급자별 스로틀 간격 — Gemini/Claude는 보수적(700ms), OpenAI/DeepL은
  // 200ms, 429 발생 시 간격 배가·성공 시 리셋.
  const translator = new EnhancedSubtitleTranslator();
  assert.strictEqual(translator.getThrottleInterval('mymemory'), 1000);
  assert.strictEqual(translator.getThrottleInterval('openai'), 200);
  assert.strictEqual(translator.getThrottleInterval('deepl'), 200);
  assert.strictEqual(translator.getThrottleInterval('gemini'), 700);
  assert.strictEqual(translator.getThrottleInterval('anthropic'), 700);
  translator._adjustThrottleOnQuota('gemini', true);
  assert.strictEqual(translator.getThrottleInterval('gemini'), 1400, '429 doubles the interval');
  translator._adjustThrottleOnQuota('gemini', true);
  assert.strictEqual(translator.getThrottleInterval('gemini'), 2800);
  translator._adjustThrottleOnQuota('gemini', false);
  assert.strictEqual(translator.getThrottleInterval('gemini'), 700, 'success resets the multiplier');

  // translateWithLLM은 공급자 포맷 티어로 스로틀을 건다.
  const spy = new EnhancedSubtitleTranslator();
  spy.apiKeys = { openai: 'sk-test', openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-5.6-sol' };
  const throttled = [];
  spy.throttleRequest = async (service) => {
    throttled.push(service);
  };
  spy.callLLM = async () => ({ content: 'hi', finishReason: 'stop' });
  await spy.translateWithLLM('hello', 'ko', spy.resolveProvider('chatgpt'));
  assert.deepStrictEqual(throttled, ['openai'], 'LLM throttle must use the provider format tier');
  console.log('[ThrottleTiers] provider-tier intervals + 429 doubling (ok)');
}

async function runQuotaMessagePrecision() {
  // LOW-1/LOW-2: translateWithRetry의 영구 오류 판정이 isQuotaError와 통일되어
  // 소문자 'daily limit'/'rate limit'/'resource_exhausted'는 재시도하지 않고,
  // 'x429x'처럼 429가 아닌 부분일치는 재시도한다.
  const translator = new EnhancedSubtitleTranslator();
  for (const msg of ['MyMemory daily limit exceeded', 'hit rate limit', 'RESOURCE_EXHAUSTED: quota']) {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(msg);
    };
    await assert.rejects(() => translator.translateWithRetry(fn, 'x', 5), new RegExp(msg));
    assert.strictEqual(calls, 1, `"${msg}" must not be retried`);
  }
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error('error code x429x from upstream');
  };
  await assert.rejects(() => translator.translateWithRetry(fn, 'x', 2), /x429x/);
  assert.strictEqual(calls, 2, '"x429x" is not a standalone 429, must be retried');
  console.log('[QuotaPrecision] message-based quota detection unified (ok)');
}

async function runProviderModelFiltering() {
  const axios = require('axios');
  const originalGet = axios.get;
  const translator = new EnhancedSubtitleTranslator();
  try {
    axios.get = async () => ({
      data: {
        models: [
          {
            name: 'models/gemini-3.6-flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/gemini-3.1-pro-preview',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/aqa', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/antigravity-preview-05-2026', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-robotics-er-1.5-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-native-audio', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      },
    });
    const geminiModels = await translator.listModels({
      format: 'gemini',
      label: 'Gemini',
      apiKey: 'test',
      baseUrl: 'https://gemini.test/v1beta',
    });
    assert.deepStrictEqual(geminiModels, ['gemini-3.1-pro-preview', 'gemini-3.6-flash']);

    axios.get = async () => ({ data: { data: [{ id: 'gpt-test' }] } });
    const openaiModels = await translator.listModels({
      format: 'openai',
      label: 'OpenAI',
      apiKey: 'test',
      baseUrl: 'https://openai.test/v1',
    });
    assert.deepStrictEqual(openaiModels, ['gpt-test'], 'non-Gemini model lists must remain unchanged');
    console.log('[ProviderModels] Gemini list keeps general Flash/Pro text models only (ok)');
  } finally {
    axios.get = originalGet;
  }
}

async function run() {
  runRendererSourceLangPayload();
  runWhisperDeviceRouting();
  runVulkanBundleManifest();
  await runVerifiedDownloader();
  runSyncPreflightOrdering();
  await runPostinstallRedirectDrain();
  const translator = new EnhancedSubtitleTranslator();

  // deepl-node 1.27: en/pt는 지역 코드가 아니면 deprecated로 throw(이슈 #41)
  assert.strictEqual(translator.mapToDeepLLang('en'), 'EN-US');
  assert.strictEqual(translator.mapToDeepLLang('pt'), 'PT-BR');
  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('ja'), 'JA');
  assert.strictEqual(translator.mapToDeepLLang('zh'), 'ZH');
  assert.strictEqual(translator.mapToDeepLLang('es'), 'ES');
  assert.strictEqual(translator.mapToDeepLLang('fr'), 'FR');
  assert.strictEqual(translator.mapToDeepLLang('de'), 'DE');
  assert.strictEqual(translator.mapToDeepLLang('it'), 'IT');
  assert.strictEqual(translator.mapToDeepLLang('ru'), 'RU');
  assert.strictEqual(translator.mapToDeepLLang('hu'), 'HU');
  assert.strictEqual(translator.mapToDeepLLang('ar'), 'AR');
  assert.strictEqual(translator.mapToDeepLLang('pl'), 'PL');
  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('tr'), 'TR');
  assert.strictEqual(translator.mapToHumanLang('tr'), 'Turkish (Türkçe)');
  assert.strictEqual(translator.mapToHumanLang('fa'), 'Persian (فارسی)');
  // 순수 장식(기호/공백)만 있는 경우만 skip
  assert.strictEqual(translator.isNonDialogue('♪'), true);
  assert.strictEqual(translator.isNonDialogue('(...)'), true);
  assert.strictEqual(translator.isNonDialogue('---'), true);
  // SDH 명사는 번역 대상 (일본어/한국어/영어 괄호 내 텍스트)
  assert.strictEqual(translator.isNonDialogue('(ラジオの音楽)'), false);
  assert.strictEqual(translator.isNonDialogue('[music]'), false);
  assert.strictEqual(translator.isNonDialogue('Hello world'), false);
  assert.strictEqual(typeof translator.getOpenAIModel(), 'string');
  assert.ok(translator.getOpenAIModel().length > 0);

  const parsed = translator.parseContextAwareJson('```json\n{"translations":["안녕"],"summary":"greeting"}\n```');
  assert.deepStrictEqual(parsed.translations, ['안녕']);
  assert.throws(() => translator.parseContextAwareJson('not json'), /Invalid context-aware translation response/);

  runSrtCleanup();
  runSrtFromWhisperJson();
  await runDownloadStreamSafety();
  runWavHeaderSafety();
  runWhisperRuntimeProbe();
  runDiskSpaceGuard();
  await runModelResumeDiskSpace();
  await runModelDownloadAbort();
  await runLocalTranslationGuards();
  await runMyMemoryErrorPhrase();
  await runMyMemoryNormalPhrase();
  await runProviderModelFiltering();
  await runRetryOn429Case();
  await runThrottleSerialization();
  runCacheKeyConsistency();
  await runDeepLNeighborContext();
  await runSerial429Propagation();
  await runSerialRetry429Propagation();
  await runSrtFileNoOutputOn429();
  await runQuotaClassification();
  await runDeepLFxSuffixHint();
  await runFinalFallbackQuotaPropagation();
  await runParallelPathSourceLang();
  await runLoopLevelQuotaContinue();
  await runDeepLUnsupportedTargetSkip();
  await runLocalContextPrecheck();
  await runPassthroughProperNounBalance();
  await runPermanentErrorNoRetry();
  await runAbortSafeRetry();
  await runCustomPromptFingerprint();
  await runAbortSurvivesLangLoop();
  await runAbortResetOnNewIpcRequest();
  await runParallelLastWindowAbort();
  await runParallelRetryDedupe();
  await runThrottleTiers();
  await runQuotaMessagePrecision();
  runPackageNoticesConfig();
  runReleaseVulkanGate();
  runWhisperFallbackEligibility();
  await runPostinstallDigestGuards();

  console.log('Smoke tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
