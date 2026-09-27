'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const axios = require('axios');
const Translator = require('../src/main/services/translator');
const { registerTranscriptionHandlers } = require('../src/main/ipc/transcription');
const C = require('../src/shared/ipc-channels');

async function testModels() {
  const translator = new Translator();
  const originalPost = axios.post;
  let request;
  try {
    axios.post = async (url, body) => {
      request = { url, body };
      return {
        data: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: '안녕하세요' },
          ],
          choices: [{ message: { content: '안녕하세요' }, finish_reason: 'stop' }],
          candidates: [
            {
              content: { parts: [{ thought: true, text: 'not a subtitle' }, { text: '안녕' }, { text: '하세요' }] },
              finishReason: 'STOP',
            },
          ],
        },
      };
    };
    for (const [format, baseUrl, model] of [
      ['openai', 'https://api.openai.com/v1', 'gpt-6-sol'],
      ['openai', 'https://api.openai.com/v1', 'gpt-6-luna'],
      ['openai', 'https://api.openai.com/v1', 'gpt-6-astra'],
      ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3.8-flash'],
      ['anthropic', 'https://api.anthropic.com/v1', 'claude-opus-5-5'],
      ['anthropic', 'https://api.anthropic.com/v1', 'claude-fable-5-1'],
    ]) {
      const response = await translator.callLLM(
        { format, baseUrl, model, apiKey: 'synthetic', label: 'fixture' },
        { system: 'Translate.', user: 'Hello.', maxTokens: 100, temperature: 0.7, timeout: 1000 }
      );
      assert.strictEqual(response.content, '안녕하세요');
      assert.ok(!('temperature' in request.body));
      if (format === 'openai') {
        assert.strictEqual(request.body.reasoning_effort, model === 'gpt-6-astra' ? 'low' : 'none');
        assert.strictEqual(request.body.max_completion_tokens, model === 'gpt-6-astra' ? 4096 : 100);
        assert.ok(request.url.endsWith('/chat/completions'));
      } else if (format === 'gemini') {
        assert.ok(request.url.endsWith('/models/gemini-3.8-flash:generateContent'));
        assert.deepStrictEqual(request.body.generationConfig, {
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: 'low' },
        });
      } else {
        assert.ok(request.url.endsWith('/messages'));
        assert.strictEqual(request.body.max_tokens, 4096);
        assert.strictEqual(request.body.output_config.effort, 'low');
      }
    }
    // Do not apply official OpenAI request settings to a compatible custom endpoint.
    await translator.callLLM(
      { format: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'gpt-6-sol', apiKey: 'synthetic' },
      { user: 'Hello.', maxTokens: 100, temperature: 0.7 }
    );
    assert.strictEqual(request.body.max_tokens, 100);
    assert.strictEqual(request.body.temperature, 0.7);
    assert.ok(!('reasoning_effort' in request.body));
    translator.apiKeys = {
      openaiModel: 'saved-custom-model',
      geminiModel: 'saved-gemini',
      claudeModel: 'saved-claude',
    };
    assert.strictEqual(translator.resolveProvider('chatgpt').model, 'saved-custom-model');
    assert.strictEqual(translator.resolveProvider('gemini').model, 'saved-gemini');
    assert.strictEqual(translator.resolveProvider('claude').model, 'saved-claude');
    for (const [provider, first] of [
      ['openai', 'gpt-6-sol'],
      ['gemini', 'gemini-3.8-flash'],
      ['claude', 'claude-opus-5-5'],
    ]) {
      assert.strictEqual(Translator.PROVIDER_MODEL_PRESETS[provider][0], first);
    }
  } finally {
    axios.post = originalPost;
  }
}

async function testCleanup() {
  // Execute the actual argument builders without starting/downloading an ASR model.
  const source = fs.readFileSync(path.join(__dirname, '../src/main/services/transcription.js'), 'utf8');
  const context = vm.createContext({
    os,
    path,
    console: { log() {} },
    fs: { existsSync: () => true },
    app: { isPackaged: false },
    SOURCE_ROOT: '/fixture',
    VAD_MODEL_NAME: 'silero.bin',
    FASTER_WHISPER_MODEL: 'large-v2',
    getFasterWhisperModelsDir: () => '/fixture/models',
  });
  const functions = ['configureExtraction', 'getWhisperCppSettings', 'getWhisperVadArgs', 'buildFasterWhisperArgs'];
  vm.runInContext(
    'let reduceRepetition = true; let naturalSegmentation = true;\n' +
      functions
        .map((name) => {
          const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
          assert.ok(match, `missing function ${name}`);
          return match[0];
        })
        .join('\n'),
    context
  );
  for (const enabled of [true, false]) {
    context.configureExtraction({ reduceRepetition: enabled });
    for (const device of ['cpu', 'cuda', 'vulkan']) {
      const args = context.getWhisperCppSettings(device);
      assert.strictEqual(args.includes('-mc'), enabled);
      if (enabled) assert.strictEqual(args[args.indexOf('-mc') + 1], '0');
      assert.strictEqual(context.getWhisperVadArgs().includes('--vad'), enabled);
    }
    for (const gpu of [false, true]) {
      const args = context.buildFasterWhisperArgs('fixture.wav', '/out', 'en', gpu);
      assert.strictEqual(args[args.indexOf('--vad_filter') + 1], enabled ? 'True' : 'False');
    }
  }
  context.configureExtraction({});
  assert.ok(context.getWhisperCppSettings('cpu').includes('-mc'), 'repetition control defaults on');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-cleanup-test-'));
  const input = path.join(dir, 'original.wav');
  fs.writeFileSync(input, 'synthetic media: extraction is stubbed');
  const original = fs.readFileSync(input);
  const texts = ['>> Hello there', '[music]', '(sighs) Please stay', '2\npeople are waiting', '>> [applause]', '♪♪'];
  let raw = texts.map((text, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\n${text}`).join('\n\n') + '\n';
  const handlers = new Map();
  const notices = [];
  let configured;
  registerTranscriptionHandlers(
    { handle: (name, handler) => handlers.set(name, handler) },
    {
      configureExtraction(payload) {
        configured = payload;
      },
      resetStop() {},
      isStopped: () => false,
      async extractSingleFile(_file, _model, _language, _device, staging) {
        fs.writeFileSync(staging, raw);
        return staging;
      },
    }
  );
  const event = { sender: { isDestroyed: () => false, send: (_channel, text) => notices.push(text) } };
  try {
    for (const reduceRepetition of [false, true])
      for (const removeSpeakerTags of [false, true])
        for (const removeSDH of [false, true]) {
          const result = await handlers.get(C.EXTRACT_SUBTITLES)(event, {
            filePath: input,
            reduceRepetition,
            cleanup: { removeSpeakerTags, removeSDH },
            outputOptions: { directory: dir, policy: 'rename' },
          });
          assert.strictEqual(result.success, true);
          assert.strictEqual(configured.reduceRepetition, reduceRepetition);
          const saved = fs.readFileSync(result.srtFile, 'utf8').trim().split('\n\n');
          const expected = texts.filter(
            (text) => !removeSDH || !['[music]', '♪♪', ...(removeSpeakerTags ? ['>> [applause]'] : [])].includes(text)
          );
          assert.strictEqual(saved.length, expected.length);
          saved.forEach((block, i) => {
            const lines = block.split('\n');
            const expectedText = (removeSpeakerTags ? expected[i].replace(/^>> /, '') : expected[i]).replace('\n', ' ');
            assert.strictEqual(lines[0], String(i + 1));
            assert.strictEqual(lines.slice(2).join(' '), expectedText);
            const originalIndex = texts.indexOf(expected[i]);
            assert.strictEqual(lines[1], `00:00:0${originalIndex},000 --> 00:00:0${originalIndex + 1},000`);
          });
          assert.deepStrictEqual(fs.readFileSync(input), original);
        }
    raw = '1\n00:00:00,000 --> 00:00:01,000\n[music]\n';
    const allSound = await handlers.get(C.EXTRACT_SUBTITLES)(event, { filePath: input, cleanup: { removeSDH: true } });
    assert.ok(fs.readFileSync(allSound.srtFile, 'utf8').includes('[music]'), 'never silently save an empty file');
    assert.ok(notices.some((text) => text.includes('would remove all lines')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // Only this test's mkdtemp fixture.
  }
}

async function testErrorLogLocation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-log-location-'));
  const sourceRoot = path.join(__dirname, '../src/main');
  const calls = [];
  let openError = '';
  let revealThrows = false;
  const loggerModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(sourceRoot, 'services/error-logger.js'), 'utf8'), {
    require,
    module: loggerModule,
    __dirname: path.join(sourceRoot, 'services'),
  });
  const logger = loggerModule.exports;
  logger.setElectronApp({ getPath: () => path.join(dir, 'profile with spaces') });
  const settingsFile = path.join(sourceRoot, 'ipc/settings.js');
  const requireSettings = require('module').createRequire(settingsFile);
  const settingsModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(settingsFile, 'utf8'), {
    module: settingsModule,
    __dirname: path.dirname(settingsFile),
    process,
    console,
    require(id) {
      if (id === '../services/error-logger') return logger;
      if (id === 'electron')
        return {
          shell: {
            showItemInFolder(file) {
              if (revealThrows) throw new Error('Synthetic reveal failure');
              calls.push(['reveal', file]);
            },
            async openPath(folder) {
              calls.push(['open', folder]);
              return openError;
            },
          },
        };
      return requireSettings(id);
    },
  });
  const handlers = new Map();
  settingsModule.exports.registerSettingsHandlers(
    { handle: (name, fn) => handlers.set(name, fn) },
    {},
    { translator: {} }
  );
  const open = handlers.get('open-error-log-location');
  try {
    const missing = await open({}, '/untrusted/client/path');
    assert.strictEqual(missing.success, true);
    assert.strictEqual(missing.exists, false);
    const logPath = logger.getLogPath();
    assert.deepStrictEqual(calls, [['open', path.dirname(logPath)]]);
    assert.ok(!fs.existsSync(logPath), 'opening the folder must not create a fake log');
    openError = 'Synthetic shell failure';
    assert.strictEqual((await open()).success, false);
    openError = '';
    fs.writeFileSync(logPath, 'Synthetic private path and message; never returned to renderer.');
    const original = fs.readFileSync(logPath);
    const existing = await open({}, '/untrusted/client/path');
    assert.strictEqual(existing.success, true);
    assert.strictEqual(existing.exists, true);
    assert.deepStrictEqual(Object.keys(existing).sort(), ['exists', 'success']);
    assert.deepStrictEqual(calls.at(-1), ['reveal', logPath]);
    assert.deepStrictEqual(fs.readFileSync(logPath), original);
    revealThrows = true;
    assert.strictEqual((await open()).success, false);
    assert.strictEqual(logger.getDiagnosticSummary().lastFailure, 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // Only this test's mkdtemp fixture.
  }
}

async function testAutosaveOwnership() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/features/settings.js'), 'utf8');
  const start = source.indexOf('async function autoSaveSettings()');
  assert.ok(start >= 0);
  let config = { localProcessingMode: 'sequential', openaiModel: 'older-custom-model' };
  let finishLoad;
  let saved;
  const selected = {
    modelSelect: 'large-v3-turbo',
    languageSelect: 'en',
    deviceSelect: 'auto',
    translationSelect: 'local',
    uiLanguageSelect: 'ko',
  };
  const autoSave = vm.runInNewContext(`(${source.slice(start, source.indexOf('\n}', start) + 2)})`, {
    console: { log() {}, error() {} },
    document: { getElementById: (id) => (id in selected ? { value: selected[id] } : null) },
    window: {
      electronAPI: {
        loadApiKeys: () => {
          const snapshot = { ...config };
          return new Promise((resolve) => {
            finishLoad = () => resolve({ success: true, keys: snapshot });
          });
        },
        saveApiKeys: async (patch) => {
          saved = { ...patch };
          config = { ...config, ...patch };
          return { success: true };
        },
      },
    },
  });
  const pending = autoSave();
  config.localProcessingMode = 'auto';
  config.openaiModel = 'newer-custom-model';
  finishLoad?.();
  await pending;
  assert.strictEqual(config.localProcessingMode, 'auto', 'an older UI autosave must not overwrite a newer mode');
  assert.strictEqual(config.openaiModel, 'newer-custom-model', 'unrelated provider settings must be preserved');
  assert.deepStrictEqual(saved, {
    selectedModel: 'large-v3-turbo',
    selectedLanguage: 'en',
    selectedDevice: 'auto',
    selectedTranslation: 'local',
    uiLanguage: 'ko',
  });
}

async function run() {
  await testAutosaveOwnership();
  await testModels();
  await testCleanup();
  await testErrorLogLocation();
  console.log(
    '[SettingsRuntime] provider requests, saved selections, cleanup/atomic outputs and private error-log location (ok; no paid API/ASR call)'
  );
}
if (require.main === module)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = run;
