'use strict';

const assert = require('assert');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
const localTranslator = require('../local-translator');
const { hasWhisperRuntimeLibraries, downloadFile, updateInstallFailureMarker } = require('./postinstall');
const { applySrtCleanup, isSdhOnlyText, srtFromWhisperJson } = require('../srt-cleanup');
const {
  assertDownloadDiskSpace,
  assertSyncInstallDiskSpace,
  getSyncInstallRequiredBytes,
  SYNC_MODEL_BYTES,
  SYNC_ENGINE_EXTRACTED_BYTES,
  SYNC_ENGINE_EXTRACTION_PEAK_BYTES,
} = require('../disk-space');
const { isCompleteWavFile, writeDownloadStream } = require('../file-safety');

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

function runSyncPreflightOrdering() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
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
  assert.match(
    source,
    /catch \(error\) \{\s+try \{\s+fs\.rmSync\(destPath, \{ force: true \}\)/,
    'failed Sync downloads must remove partial files'
  );
  assert.match(source, /Preserving stale sibling WAV/, 'stale sibling WAVs must stay in place');
  assert.doesNotMatch(source, /backupStaleWav/, 'conversion must not create accumulating stale WAV backups');
  console.log('[SyncDiskPreflight] install peak, partial cleanup, and stale WAV preservation are wired (ok)');
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-disk-space-'));
  const dest = path.join(dir, 'models', 'model.bin');
  try {
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

async function run() {
  runRendererSourceLangPayload();
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

  console.log('Smoke tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
