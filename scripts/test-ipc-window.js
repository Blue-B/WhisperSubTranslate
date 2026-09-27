'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createRequire } = require('module');
const C = require('../src/shared/ipc-channels');

function loadHandlers(name, mocks = {}) {
  const filename = path.join(__dirname, '../src/main/ipc', name + '.js');
  const realRequire = createRequire(filename);
  const testModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: testModule,
    __dirname: path.dirname(filename),
    AbortController,
    console: { warn() {}, error() {} },
    require: (id) => mocks[id] || realRequire(id),
  });
  return testModule.exports;
}

async function runIpcWindowTests() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-ipc-window-'));
  try {
    for (const closeAt of ['before', 'during', 'never']) {
      let destroyed = closeAt === 'before';
      const messages = [];
      const event = {
        sender: {
          isDestroyed: () => destroyed,
          send: (...args) => {
            assert.ok(!destroyed, 'must not send to destroyed contents');
            messages.push(args);
          },
        },
      };
      const handlers = new Map();
      const ipc = { handle: (name, fn) => handlers.set(name, fn) };
      const closeDuring = () => {
        if (closeAt === 'during') destroyed = true;
      };
      let translated = 0;
      loadHandlers('translation').registerTranslationHandlers(ipc, {
        resetAbort() {},
        setCurrentFile() {},
        clearFileCache() {},
        async translateSRTFile(_input, output, _method, _lang, progress) {
          closeDuring();
          progress({ current: 1, total: 1 });
          translated++;
          return output;
        },
      });
      const translation = handlers.get(C.TRANSLATE_SUBTITLE);
      const good = await translation(event, { filePath: '/test.srt', targetLangs: ['ko', 'ja'] });
      assert.strictEqual(good.success, true);
      assert.strictEqual(translated, 2);
      const bad = await translation(event, { filePath: '/test.srt', targetLang: '../invalid' });
      assert.strictEqual(bad.success, false, 'catch path must return failure, not throw ReferenceError');
      assert.match(bad.error, /Invalid target language/);

      let extracted = 0;
      loadHandlers('transcription').registerTranscriptionHandlers(ipc, {
        configureExtraction() {},
        resetStop() {},
        isStopped: () => false,
        srtOutputPathFor: (file) => file + '.srt',
        async extractSingleFile(_file, _model, _language, _device, output) {
          closeDuring();
          extracted++;
          fs.writeFileSync(output, '');
          return output;
        },
      });
      const extraction = await handlers.get(C.EXTRACT_SUBTITLES)(event, {
        filePaths: ['/one.wav', '/two.wav'],
        device: 'cpu',
        outputOptions: { directory },
      });
      assert.strictEqual(extraction.success, true);
      assert.strictEqual(extracted, 2, 'notification errors must not interrupt this IPC invocation');

      let downloaded = false;
      loadHandlers('models', {
        './files': {},
        '../services/local-translator': {
          DEFAULT_MODEL_ID: '7b',
          setDownloadProgressHandler() {},
          isModelInstalled: () => false,
          async downloadModel(progress) {
            closeDuring();
            progress({ percent: 100 });
            downloaded = true;
          },
        },
      }).registerModelHandlers(ipc, {}, () => null);
      const download = await handlers.get(C.LOCAL_MODEL_DOWNLOAD)(event, '7b');
      assert.strictEqual(download.success, true);
      assert.strictEqual(downloaded, true);
      if (closeAt === 'before') assert.strictEqual(messages.length, 0);
      if (closeAt === 'never') assert.ok(messages.length > 0, 'live windows must still receive progress');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  // Completing one model must not discard another model's cancellation controller.
  const handlers = new Map();
  const active = new Map();
  loadHandlers('models', {
    './files': {},
    '../services/local-translator': {
      setDownloadProgressHandler() {},
      isModelInstalled: () => false,
      downloadModel(_progress, signal, id) {
        return new Promise((resolve, reject) => {
          active.set(id, { resolve, signal });
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
  }).registerModelHandlers({ handle: (name, fn) => handlers.set(name, fn) }, {}, () => null);
  const event = { sender: { isDestroyed: () => false, send() {} } };
  const first = handlers.get(C.LOCAL_MODEL_DOWNLOAD)(event, '1.8b');
  const second = handlers.get(C.LOCAL_MODEL_DOWNLOAD)(event, '7b');
  active.get('1.8b').resolve();
  assert.strictEqual((await first).success, true);
  handlers.get(C.LOCAL_MODEL_CANCEL)(event, '7b');
  assert.strictEqual(active.get('7b').signal.aborted, true);
  assert.strictEqual((await second).userStopped, true);
  console.log(
    '[IpcWindow] live/closed sender, two-file invocation, translation errors and independent download cancellation (ok)'
  );
}

if (require.main === module)
  runIpcWindowTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = runIpcWindowTests;
