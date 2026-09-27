'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const axios = require('axios');
const C = require('../src/shared/ipc-channels');
const { writeFileAtomic } = require('../src/main/services/file-safety');
const { registerTranscriptionHandlers } = require('../src/main/ipc/transcription');
const { registerTranslationHandlers } = require('../src/main/ipc/translation');
const Translator = require('../src/main/services/translator');
const logger = require('../src/main/services/error-logger');

async function runNumericSubtitleTests(translator, dir) {
  const cues = [
    ['I have\n2\napples', '사과가 2개 있습니다'],
    ['3\npeople are waiting', '3명이 기다립니다'],
    ['My room is\n204', '제 방은 204호입니다'],
    ['1\n2\n3\nReady', '1 2 3 준비됐습니다'],
    ['Hello there', '안녕하세요'],
    ['42', '42'],
    ['7\n8', '7\n8'],
  ];
  const timestamp = '00:00:01,000 --> 00:00:02,000';
  const makeSrt = (translated, separator = '\n\n') =>
    cues.map((cue, index) => `${index + 1}\n${timestamp}\n${cue[translated ? 1 : 0]}`).join(separator);
  for (const contextAware of [false, true]) {
    translator.supportsContextAware = () => contextAware;
    const translate = async (texts) => {
      assert.deepStrictEqual(
        texts,
        cues.slice(0, 5).map(([text]) => text.replace(/\n/g, ' ')),
        'numbers inside dialogue must reach the translator with their surrounding words'
      );
      return cues.slice(0, 5).map(([, text]) => text);
    };
    translator.translateBatch = translate;
    translator.translateContextAwareBatch = translate;
    for (const separator of ['\n\n', '\n']) {
      for (const newline of ['\n', '\r\n']) {
        const input = makeSrt(false, separator).replace(/\n/g, newline);
        const output = await translator.translateSRTContent(input, 'local', 'ko');
        assert.strictEqual(output.replace(/\r\n/g, '\n'), makeSrt(true, separator));
      }
    }
  }
  // Exercise the real file/formatting path as well as the shared parser.
  const input = path.join(dir, 'numeric.srt');
  const output = path.join(dir, 'numeric_ko.srt');
  fs.writeFileSync(input, makeSrt(false));
  await translator.translateSRTFile(input, output, 'local', 'ko');
  assert.strictEqual(fs.readFileSync(input, 'utf8'), makeSrt(false));
  assert.strictEqual(fs.readFileSync(output, 'utf8').trim(), makeSrt(true).replace('7\n8', '7 8'));
  translator.supportsContextAware = () => false;
  console.log('[NumericSRT] dialogue numbers, numeric-only cues, indices, LF/CRLF and saved output (ok)');
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-release-safety-'));
  const subtitle = '1\n00:00:01,000 --> 00:00:02,000\nHello there\n';
  const input = path.join(dir, 'movie.srt');
  const output = path.join(dir, 'movie_ko.srt');
  const handlers = new Map();
  const ipc = { handle: (name, handler) => handlers.set(name, handler) };
  const messages = [];
  const event = { sender: { isDestroyed: () => false, send: (...args) => messages.push(args) } };
  const translator = new Translator();
  translator.logError = () => {}; // Synthetic failures must not write real user logs.
  try {
    fs.writeFileSync(input, subtitle);
    fs.writeFileSync(output, 'previous');
    assert.strictEqual(writeFileAtomic(output, 'ignored', 'skip'), null);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'previous');
    const renamed = writeFileAtomic(output, 'new', 'rename');
    assert.strictEqual(renamed, path.join(dir, 'movie_ko (1).srt'));
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'previous');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (path.basename(file).startsWith('.wst-')) {
        originalWrite(file, 'partial data');
        throw new Error('ENOSPC after partial write');
      }
      return originalWrite(file, ...args);
    };
    try {
      assert.throws(() => writeFileAtomic(output, 'replacement'), /ENOSPC/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'previous');
    writeFileAtomic(output, 'replacement');
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'replacement');

    let extractionCalls = 0;
    let extractionFailure = false;
    let stopped = false;
    registerTranscriptionHandlers(ipc, {
      configureExtraction() {},
      resetStop() {
        stopped = false;
      },
      isStopped: () => stopped,
      async extractSingleFile(_file, _model, _language, _device, staging) {
        extractionCalls++;
        assert.ok(!fs.existsSync(staging), 'every invocation needs fresh output');
        if (extractionFailure) throw new Error('Whisper processing failed: Error code: 1');
        fs.writeFileSync(staging, subtitle.replace('Hello there', `Take ${extractionCalls}`));
        return staging;
      },
    });
    const extract = handlers.get(C.EXTRACT_SUBTITLES);
    const first = await extract(event, { filePath: path.join(dir, 'movie.mp4') });
    const second = await extract(event, { filePath: path.join(dir, 'movie.mkv') });
    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    assert.notStrictEqual(first.srtFile, second.srtFile, 'separate queue invocations must not collide');
    assert.strictEqual(fs.readFileSync(input, 'utf8'), subtitle, 'existing SRT preserved by default');
    extractionFailure = true;
    const failed = await extract(event, {
      filePath: path.join(dir, 'movie.mp4'),
      outputOptions: { policy: 'overwrite' },
    });
    assert.strictEqual(failed.success, false);
    assert.strictEqual(fs.readFileSync(input, 'utf8'), subtitle);
    const callsBeforeSkip = extractionCalls;
    const skipped = await extract(event, { filePath: path.join(dir, 'movie.mp4'), outputOptions: { policy: 'skip' } });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(extractionCalls, callsBeforeSkip);

    await runNumericSubtitleTests(translator, dir);
    translator.supportsContextAware = () => false;
    for (const invalid of ['', '  ', null, undefined]) {
      translator.translateBatch = async () => [invalid];
      await assert.rejects(translator.translateSRTFile(input, output), /EMPTY_TRANSLATION/);
      assert.strictEqual(fs.readFileSync(output, 'utf8'), 'replacement');
    }
    translator.translateBatch = async () => {
      translator.abort();
      return ['안녕하세요'];
    };
    await assert.rejects(translator.translateSRTFile(input, output), /ABORTED/);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'replacement', 'late reply after stop cannot save');

    const originalPost = axios.post;
    try {
      translator.resetAbort();
      let signal;
      axios.post = async (_url, _body, options) => {
        signal = options.signal;
        translator.abort();
        return { data: { choices: [{ message: { content: 'late result' } }] } };
      };
      await assert.rejects(
        translator.callLLM(
          { format: 'openai', label: 'test', baseUrl: 'https://example.invalid', apiKey: 'synthetic', model: 'test' },
          { user: 'test' }
        ),
        /ABORTED/
      );
      assert.strictEqual(signal.aborted, true, 'HTTP request uses the cancellation signal');
    } finally {
      axios.post = originalPost;
    }

    translator.translateBatch = async (_texts, _method, language) => {
      if (language === 'ja') throw new Error('synthetic language failure');
      return ['안녕하세요'];
    };
    registerTranslationHandlers(ipc, translator);
    const translate = handlers.get(C.TRANSLATE_SUBTITLE);
    const partial = await translate(event, {
      filePath: input,
      method: 'mymemory',
      targetLangs: ['ko', 'ja'],
      sessionId: 11,
    });
    assert.strictEqual(partial.partial, true);
    assert.deepStrictEqual(partial.failedLangs, ['ja']);
    assert.ok(partial.outputs.ko);
    const completedEvent = messages.at(-1)[1];
    assert.deepStrictEqual(completedEvent.failedLangs, partial.failedLangs);
    assert.strictEqual(completedEvent.sessionId, 11);
    const koStat = fs.statSync(partial.outputs.ko);
    translator.translateBatch = async () => ['こんにちは'];
    const retried = await translate(event, { filePath: input, method: 'mymemory', targetLangs: partial.failedLangs });
    assert.strictEqual(retried.success, true);
    assert.strictEqual(fs.statSync(partial.outputs.ko).mtimeMs, koStat.mtimeMs);

    // Stop and immediately queue a new invocation: old response must settle before resetAbort.
    let release, started;
    const hasStarted = new Promise((resolve) => {
      started = resolve;
    });
    translator.translateBatch = () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const oldJob = translate(event, { filePath: input, targetLang: 'ko', outputOptions: { policy: 'overwrite' } });
    await hasStarted;
    translator.abort();
    const newJob = translate(event, { filePath: input, targetLang: 'ja' });
    translator.translateBatch = async () => ['こんにちは'];
    release(['late reply']);
    assert.strictEqual((await oldJob).userStopped, true);
    assert.strictEqual((await newJob).success, true);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'replacement');

    const renderer = vm.createContext({
      console,
      Date: { now: () => 123 },
      window: {},
      fileQueue: [],
      isProcessing: false,
      shouldStop: false,
      localStorage: { getItem: (key) => (key === 'autoRetryFailed' ? 'true' : null) },
      AUTO_RETRY_MAX: 2,
      updateQueueDisplay() {},
    });
    for (const file of ['queue', 'processing', 'history']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/renderer/features/${file}.js`), 'utf8'), renderer);
    }
    vm.runInContext('updateQueueDisplay = () => {};', renderer);
    await renderer.ensureHistoryLoaded();
    const item = { path: '/movie.mp4', translationInput: input, translationOptions: { method: 'local' } };
    renderer.fileQueue.push(item);
    renderer.applyTranslationResult(item, partial);
    assert.strictEqual(item.status, 'error');
    assert.strictEqual(renderer.loadHistory()[0].status, 'partial');
    assert.strictEqual(renderer.retryFailedAutomatically(), true);
    assert.strictEqual(item.retryTranslation, true);
    renderer.applyTranslationResult(item, retried);
    assert.strictEqual(item.status, 'completed');
    assert.strictEqual(item.partial, false);
    assert.strictEqual(renderer.loadHistory().length, 1);
    assert.strictEqual(renderer.loadHistory()[0].status, 'success');
    assert.deepStrictEqual(Object.keys(item.outputs).sort(), ['ja', 'ko']);
    renderer.saveFileToHistory({ path: '/second.mp4', status: 'completed' });
    assert.strictEqual(renderer.loadHistory().length, 2, 'same-millisecond completions must not overwrite history');

    logger.setElectronApp({ getPath: () => dir });
    logger.logError('translation', 'SRT file translation failed', new Error('ENOSPC private/path secret subtitle'));
    assert.deepStrictEqual(logger.getDiagnosticSummary(), { lastFailure: 'disk-space' });
    assert.strictEqual(
      fs.readdirSync(dir).some((name) => name.startsWith('.wst-')),
      false
    );
    console.log(
      '[ReleaseSafety] atomic output/config, collision, empty result, stop/restart, partial retry/history and private diagnostics (ok)'
    );
  } finally {
    logger.setElectronApp(
      process.env.WHISPER_PORTABLE_DATA ? { getPath: () => process.env.WHISPER_PORTABLE_DATA } : null
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (require.main === module)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = run;
