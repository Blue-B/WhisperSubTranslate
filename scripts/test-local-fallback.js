'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

async function runLocalFallbackTests() {
  const filename = path.join(__dirname, '../src/main/services/local-translator.js');
  const original = fs.readFileSync(filename, 'utf8');
  // Substitute only the ESM native dependency boundary, leaving model/fallback logic intact.
  assert.strictEqual(original.split("await import('node-llama-cpp')").length - 1, 2);
  const source = original.replaceAll("await import('node-llama-cpp')", "require('node-llama-cpp')");
  const realRequire = createRequire(filename);
  for (const failure of ['load', 'context', 'generic-context', 'cpu-context']) {
    const loads = [];
    const notices = [];
    const native = {
      async getLlama({ gpu }) {
        const mode = gpu === false ? 'cpu' : 'auto';
        return {
          async dispose() {},
          async loadModel({ modelPath }) {
            const large = modelPath.includes('7B');
            loads.push([mode, large ? '7b' : '1.8b']);
            if (large && mode === 'auto' && failure === 'load') throw new Error('CUDA load failed');
            return {
              gpuLayers: mode === 'cpu' ? 0 : 20,
              async dispose() {},
              async createContext() {
                if (large && mode === 'auto' && failure === 'context') throw new Error('VRAM is too small');
                if (failure === 'generic-context') throw new Error('Invalid context configuration');
                if (failure === 'cpu-context') throw new Error('CPU out of memory');
                return { getSequence: () => ({}), async dispose() {} };
              },
            };
          },
        };
      },
      LlamaChatSession: class {
        resetChatHistory() {}
        async prompt() {
          return '안녕하세요.';
        }
      },
    };
    const context = vm.createContext({
      module: { exports: {} },
      __dirname: path.dirname(filename),
      process,
      console: { log() {}, warn() {} },
      setTimeout,
      clearTimeout,
      AbortController,
      require(name) {
        if (name === 'node-llama-cpp') return native;
        if (name === 'electron') return { app: { getPath: () => '/fixture' } };
        return realRequire(name);
      },
    });
    vm.runInContext(source, context);
    // Disk/model download boundaries: this test neither reads nor downloads large models.
    vm.runInContext(
      'ensureModelIntegrity = async () => {}; isModelInstalled = () => true; _maybeCleanupLegacy = () => {};',
      context
    );
    const api = context.module.exports;
    api.setMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => notices.push(args) } });
    if (failure === 'generic-context' || failure === 'cpu-context') {
      await assert.rejects(api.translateLocal('Hello.', 'ko', failure === 'cpu-context' ? 'cpu' : 'auto', '7b'));
      assert.strictEqual(loads.length, 1, 'non-GPU / explicit CPU errors must not retry');
      assert.strictEqual(notices.length, 0);
    } else {
      assert.strictEqual(await api.translateLocal('Hello.', 'ko', 'auto', '7b'), '안녕하세요.');
      assert.strictEqual(await api.translateLocal('Next sentence.', 'ko', 'auto', '7b'), '안녕하세요.');
      assert.deepStrictEqual(
        loads,
        [
          ['auto', '7b'],
          ['cpu', '7b'],
        ],
        'second cue must reuse CPU'
      );
      assert.strictEqual(notices.length, 1);
      assert.match(notices[0][1], /CPU로 진행합니다/);
      await api.translateLocal('Hello.', 'ko', 'auto', '1.8b');
      assert.deepStrictEqual(loads.at(-1), ['auto', '1.8b'], 'other model must still try GPU');
      await api.unloadModel();
      await api.translateLocal('Hello.', 'ko', 'auto', '7b');
      assert.deepStrictEqual(
        loads.slice(-2),
        [
          ['auto', '7b'],
          ['cpu', '7b'],
        ],
        'explicit unload resets GPU failure memory'
      );
    }
    await api.unloadModel();
  }
  console.log(
    '[LocalFallback] production loader: CPU retry/reuse/reset and non-GPU error propagation with mocked native backend (ok)'
  );
}

if (require.main === module)
  runLocalFallbackTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = runLocalFallbackTests;
