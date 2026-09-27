'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configModulePath = path.join(root, 'src/main/services/translation-config.js');
const loggerModulePath = path.join(root, 'src/main/services/error-logger.js');
const translatorPath = path.join(root, 'src/main/services/translator.js');

function loadConfigModule(userData, safeStorage) {
  const electronPath = require.resolve('electron');
  require.cache[electronPath].exports = {
    app: { getPath: (name) => (name === 'userData' ? userData : userData) },
    safeStorage,
  };
  delete require.cache[require.resolve(configModulePath)];
  return require(configModulePath);
}

async function run() {
  const electronPath = require.resolve('electron');
  const originalElectron = require('electron');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-translation-config-'));
  const defaults = () => ({ preserved: 'default', enableCache: true, nested: { original: true } });
  const hydrate = (config) => ({ ...defaults(), ...config });
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`safe:${text}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('safe:')) throw new Error('invalid fake ciphertext');
      return text.slice(5);
    },
  };

  try {
    const safeDir = path.join(dir, 'safe');
    fs.mkdirSync(safeDir);
    let config = loadConfigModule(safeDir, fakeSafeStorage);
    let saved = config.saveConfig({ apiKey: 'fake-key', extra: 'kept' }, hydrate, defaults);
    assert.strictEqual(saved.result, true);
    assert.deepStrictEqual(saved.config, {
      preserved: 'default',
      enableCache: true,
      nested: { original: true },
      apiKey: 'fake-key',
      extra: 'kept',
    });
    const safeFile = path.join(safeDir, 'translation-config-safe.json');
    assert.ok(fs.existsSync(safeFile));
    assert.ok(!fs.readFileSync(safeFile, 'utf8').includes('fake-key'), 'safeStorage file must contain base64 bytes');

    saved = config.saveConfig({ enableCache: false, selectedLanguage: 'ja' }, hydrate, defaults);
    assert.strictEqual(saved.result, true);
    assert.strictEqual(saved.config.apiKey, 'fake-key', 'partial saves must preserve existing fields');
    assert.strictEqual(saved.config.extra, 'kept', 'unknown fields must survive merge and hydration');
    assert.strictEqual(saved.config.enableCache, false);
    assert.strictEqual(config.loadConfig(hydrate, defaults).selectedLanguage, 'ja');

    const legacyDir = path.join(dir, 'legacy');
    fs.mkdirSync(legacyDir);
    config = loadConfigModule(legacyDir, { isEncryptionAvailable: () => false });
    saved = config.saveConfig({ apiKey: 'legacy-fake', custom: 42 }, hydrate, defaults);
    assert.deepStrictEqual(saved.result, { success: true, insecure: true });
    const legacyFile = path.join(legacyDir, 'translation-config-encrypted.json');
    assert.ok(fs.existsSync(legacyFile));
    assert.strictEqual(config.loadConfig(hydrate, defaults).custom, 42, 'legacy AES fallback must round-trip');

    const fixtureDir = path.join(dir, 'legacy-fixture');
    fs.mkdirSync(fixtureDir);
    fs.writeFileSync(
      path.join(fixtureDir, 'translation-config-encrypted.json'),
      JSON.stringify({
        data:
          '07070707070707070707070707070707:' +
          '98488b755ce98ac1266078e57ce2ceec724b6233e94c8d1e7502247e33b2f6277f5892a5134dc0040112c8e2002191ae',
      })
    );
    config = loadConfigModule(fixtureDir, { isEncryptionAvailable: () => false });
    assert.strictEqual(config.loadConfig(hydrate, defaults).apiKey, 'fixture-fake', 'legacy byte fixture must decrypt');

    config = loadConfigModule(legacyDir, fakeSafeStorage);
    assert.strictEqual(config.loadConfig(hydrate, defaults).apiKey, 'legacy-fake');
    assert.ok(fs.existsSync(path.join(legacyDir, 'translation-config-safe.json')));
    assert.ok(!fs.existsSync(legacyFile), 'legacy AES file is deleted only after safeStorage migration succeeds');

    const plainDir = path.join(dir, 'plain');
    fs.mkdirSync(plainDir);
    const plainFile = path.join(plainDir, 'translation-config.json');
    fs.writeFileSync(plainFile, JSON.stringify({ apiKey: 'plain-fake', plainExtra: true }));
    config = loadConfigModule(plainDir, { isEncryptionAvailable: () => false });
    assert.strictEqual(config.loadConfig(hydrate, defaults).plainExtra, true);
    assert.ok(!fs.existsSync(plainFile), 'plaintext is deleted after successful legacy encryption');
    assert.ok(fs.existsSync(path.join(plainDir, 'translation-config-encrypted.json')));

    const priorText = fs.readFileSync(safeFile, 'utf8');
    config = loadConfigModule(safeDir, fakeSafeStorage);
    for (const operation of ['writeFileSync', 'renameSync']) {
      const original = fs[operation];
      fs[operation] = (file, ...args) => {
        if (path.dirname(file) === safeDir) throw new Error(`simulated ${operation} failure`);
        return original(file, ...args);
      };
      try {
        saved = config.saveConfig({ apiKey: 'replacement' }, hydrate, defaults);
        assert.strictEqual(saved.result, false);
      } finally {
        fs[operation] = original;
      }
      assert.deepStrictEqual(fs.readdirSync(safeDir), ['translation-config-safe.json'], 'no staging file leak');
    }
    assert.strictEqual(fs.readFileSync(safeFile, 'utf8'), priorText, 'failed save must not destroy prior config');
    assert.strictEqual(config.loadConfig(hydrate, defaults).apiKey, 'fake-key');

    const loggerDir = path.join(dir, 'logger');
    fs.mkdirSync(loggerDir);
    const logger = require(loggerModulePath);
    logger.setElectronApp({ getPath: () => loggerDir });
    const logPath = logger.getLogPath();
    const oversized = Array.from({ length: 1500 }, (_, index) => `${index}:${'x'.repeat(1500)}`).join('\n');
    fs.writeFileSync(logPath, oversized);
    assert.strictEqual(logger.logError('translation', 'trim probe', new Error('fake failure')), undefined);
    const trimmed = fs.readFileSync(logPath, 'utf8');
    assert.match(trimmed, /^\[Log Cleanup\] Trimmed from 1500 lines to 1000 lines/);
    assert.ok(!trimmed.includes('\n0:'), 'trim must discard oldest lines');
    assert.match(trimmed, /\[translation\] trim probe/);
    const originalAppend = fs.appendFileSync;
    fs.appendFileSync = () => {
      throw new Error('simulated logger failure');
    };
    try {
      assert.doesNotThrow(() => logger.logError('translation', 'never throw', new Error('fake failure')));
    } finally {
      fs.appendFileSync = originalAppend;
    }

    const translatorSource = fs.readFileSync(translatorPath, 'utf8');
    assert.match(translatorSource, /errLogger\.logError\('translation'/);
    assert.doesNotMatch(translatorSource, /function cleanupLogFile|function getLogPath/);

    // Preserve saveApiKeys' false-on-failure contract if DeepL initialization rejects a stored value.
    const originalTranslatorModule = require.cache[translatorPath];
    const originalConfigModule = require.cache[configModulePath];
    const originalSave = originalConfigModule.exports.saveConfig;
    try {
      originalConfigModule.exports.saveConfig = () => ({ result: true, config: { deepl: 123 } });
      delete require.cache[translatorPath];
      const TestTranslator = require(translatorPath);
      assert.strictEqual(TestTranslator.prototype.saveApiKeys.call({}, {}), false);
    } finally {
      originalConfigModule.exports.saveConfig = originalSave;
      if (originalTranslatorModule) require.cache[translatorPath] = originalTranslatorModule;
      else delete require.cache[translatorPath];
    }

    console.log(
      '[TranslationConfig] safeStorage, legacy/plain migration, merge, failed-save, and logger trim pass (ok)'
    );
  } finally {
    require(loggerModulePath).setElectronApp(
      process.env.WHISPER_PORTABLE_DATA ? { getPath: () => process.env.WHISPER_PORTABLE_DATA } : null
    );
    require.cache[electronPath].exports = originalElectron;
    delete require.cache[require.resolve(configModulePath)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = run;
