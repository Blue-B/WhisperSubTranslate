'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const MiB = 1024 ** 2;
const translated = (text) => `번역문 ${[...text].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`;

function fixture(options = {}) {
  const filename = path.join(__dirname, '../src/main/services/local-translator.js');
  const source = fs
    .readFileSync(filename, 'utf8')
    .replaceAll("await import('node-llama-cpp')", "require('node-llama-cpp')");
  const realRequire = createRequire(filename);
  const state = {
    active: 0,
    maxActive: 0,
    loads: [],
    contexts: new Set(),
    attempts: 0,
    starts: [],
    unsafeDisposals: 0,
    notices: [],
    fallbacks: [],
    clock: 0,
  };
  const native = {
    async getLlama({ gpu }) {
      const cpu = gpu === false;
      return {
        gpu: cpu ? false : options.backend || 'cuda',
        async dispose() {},
        async getVramState() {
          if (options.queryFailure) throw new Error('VRAM query failed');
          return { free: options.free ?? (options.lowMemory ? 128 * MiB : 2048 * MiB) };
        },
        async loadModel() {
          state.loads.push(cpu ? 'cpu' : 'gpu');
          return {
            gpuLayers: cpu ? 0 : options.partial ? 12 : 33,
            fileInsights: {
              totalLayers: 33,
              estimateContextResourceRequirements() {
                if (options.estimateFailure) throw new Error('Unknown model architecture');
                return { gpuVram: options.contextVram ?? 128 * MiB, cpuRam: 32 * MiB };
              },
            },
            async dispose() {
              if (state.active) state.unsafeDisposals++;
              assert.strictEqual(state.active, 0, 'model must outlive all evaluations');
            },
            async createContext({ sequences = 1, createSignal }) {
              state.attempts++;
              state.clock += options.setupCost || 0;
              assert.strictEqual(sequences, 1, 'never share a native context between concurrent cues');
              if (options.waitForAllocationAbort && state.contexts.size) {
                await new Promise((_resolve, reject) =>
                  createSignal.addEventListener('abort', () => reject(createSignal.reason), { once: true })
                );
              }
              if ((options.allocationFailure || options.allocationError) && state.contexts.size) {
                throw new Error(options.allocationError || 'Insufficient memory for context');
              }
              let assigned = false;
              const context = {
                id: state.attempts,
                batchSize: 512,
                flashAttention: false,
                busy: false,
                getSequence() {
                  assert.strictEqual(assigned, false, 'one sequence per independent context');
                  assigned = true;
                  return context;
                },
                async dispose() {
                  if (state.active) state.unsafeDisposals++;
                  assert.strictEqual(state.active, 0, 'drain every evaluation before disposing contexts');
                  state.contexts.delete(context);
                },
              };
              state.contexts.add(context);
              return context;
            },
          };
        },
      };
    },
    LlamaChatSession: class {
      constructor({ contextSequence }) {
        this.sequence = contextSequence;
      }
      resetChatHistory() {
        assert.strictEqual(this.sequence.busy, false, 'never reset a running prompt');
      }
      async prompt(prompt, { signal }) {
        const context = this.sequence;
        assert.strictEqual(context.busy, false);
        context.busy = true;
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        const text = prompt.slice(prompt.indexOf('\n\n') + 2);
        state.starts.push(text);
        try {
          if (options.waitForAbort) {
            await new Promise((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          } else {
            await new Promise((resolve) => setTimeout(resolve, context.id % 4 === 1 ? 5 : 1));
          }
          if (options.cost) state.clock += options.cost(state.contexts.size) / state.contexts.size;
          if (options.promptFailure && state.contexts.size > 1) throw new Error('CUDA OOM');
          if (options.mixedFailure && state.contexts.size > 1) {
            throw new Error(context.id % 2 ? 'LOCAL_UNTRANSLATED: test' : 'Unexpected native failure');
          }
          if (options.genericFailure) throw new Error('Unexpected native failure');
          return options.echo ? text : translated(text);
        } finally {
          state.active--;
          context.busy = false;
        }
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
    performance: options.cost ? { now: () => state.clock } : performance,
    require(name) {
      if (name === './error-logger')
        return {
          logError(scope, message, error) {
            state.fallbacks.push({ scope, message, error });
            options.logger?.logError(scope, message, error);
          },
        };
      if (name === 'node-llama-cpp') return native;
      if (name === 'electron') return { app: { getPath: () => '/fixture' } };
      if (name === 'os') return { ...realRequire(name), freemem: () => (options.lowRam ? 128 * MiB : 4096 * MiB) };
      return realRequire(name);
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(
    'ensureModelIntegrity = async () => {}; isModelInstalled = () => true; _maybeCleanupLegacy = () => {};',
    context
  );
  const api = context.module.exports;
  api.setMainWindow({
    isDestroyed: () => false,
    webContents: { send: (_channel, notice) => state.notices.push(notice) },
  });
  return { api, state };
}

async function collect(api, texts, device = 'auto', concurrency) {
  const results = [];
  for await (const result of api.translateLocalBatch(texts, 'ko', device, '1.8b', concurrency)) results.push(result);
  return results;
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture did not reach its expected state');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function runLocalBatchTests() {
  const texts = Array.from({ length: 32 }, (_, index) => `sentence number ${index}`);
  for (const [options, expected] of [
    [{}, 2],
    [{ device: 'cpu' }, 1],
    [{ partial: true }, 1],
    [{ backend: 'vulkan' }, 1],
    [{ lowMemory: true }, 1],
    [{ lowRam: true }, 1],
    [{ queryFailure: true }, 1],
    [{ estimateFailure: true }, 1],
    [{ contextVram: NaN }, 1],
    [{ concurrency: 1 }, 1],
    [{ free: 640 * MiB }, 2],
    [{ free: 768 * MiB }, 2],
    [{ concurrency: 4 }, 4],
  ]) {
    const { api, state } = fixture(options);
    const results = await collect(api, texts, options.device, options.concurrency ?? 2);
    assert.deepStrictEqual(
      results.map((r) => r.index),
      texts.map((_, index) => index)
    );
    assert.deepStrictEqual(
      results.map((r) => r.translation),
      texts.map(translated)
    );
    assert.strictEqual(state.maxActive, expected, JSON.stringify(options));
    assert.strictEqual(state.loads.length, 1, 'share one model, not one model per request');
    assert.strictEqual(state.fallbacks.length, 0, 'normal resource admission is not a runtime failure');
    assert.ok(
      state.notices.some((n) => n.includes(`workers=${expected}`)),
      'show actual concurrency'
    );
    assert.ok(
      state.notices.some((n) => n.includes('seconds=')),
      'show elapsed time'
    );
    await api.unloadModel();
    assert.strictEqual(state.contexts.size, 0);
  }
  // Identical policy for short/medium/long jobs: no 32/256-cue cap of two.
  // Virtual timings exercise selection without host scheduler noise.
  for (const count of [31, 50, 255, 512])
    for (const [options, expected] of [
      [{ cost: () => 10 }, 8],
      [{ cost: (workers) => workers * 10 }, 1],
      [{ cost: (workers) => (workers <= 2 ? 10 : workers * 10) }, 2],
      [{ cost: () => 10, free: 768 * MiB }, 3],
      [{ cost: () => 10, device: 'cpu' }, 1],
      [{ cost: () => 10, promptFailure: true }, 1],
      [{ cost: () => 10, allocationFailure: true }, 1],
    ]) {
      const { api, state } = fixture(options);
      const long = Array.from({ length: count }, (_, i) => `Sample ${i} ${'word '.repeat(i % 10)}`);
      const results = await collect(api, long, options.device);
      assert.strictEqual(state.contexts.size, expected, `selected concurrency: ${JSON.stringify(options)}`);
      assert.deepStrictEqual(
        results.map((r) => r.index),
        long.map((_, i) => i)
      );
      assert.deepStrictEqual(
        results.map((r) => r.translation),
        long.map((text) => translated(text.trim()))
      );
      assert.strictEqual(state.unsafeDisposals, 0);
      assert.strictEqual(state.fallbacks.length, options.promptFailure || options.allocationFailure ? 1 : 0);
      if (expected === 8) {
        assert.strictEqual(state.starts.length, count + 1 + 8 * 3, 'reuse baseline results in ordered output');
      }
      await api.unloadModel();
    }
  {
    const { api, state } = fixture({ cost: () => 10 });
    const long = Array(512).fill('A sentence to translate');
    const results = [];
    for await (const r of api.translateLocalBatch(long, 'ko', 'auto', '7b')) results.push(r);
    assert.strictEqual(results.length, 512);
    assert.strictEqual(state.contexts.size, 8, '7B uses the same admission and speed policy');
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ mixedFailure: true });
    await assert.rejects(collect(api, Array(512).fill('Calibration fatal error')), /Unexpected native failure/);
    assert.strictEqual(state.unsafeDisposals, 0);
    assert.strictEqual(state.contexts.size, 0);
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ waitForAbort: true });
    const work = collect(api, Array(512).fill('Calibration cancellation'));
    await until(() => state.active === 1);
    api.abortTranslation();
    await assert.rejects(work, /ABORTED/);
    assert.strictEqual(state.contexts.size, 0);
    assert.strictEqual(state.unsafeDisposals, 0);
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ cost: () => 10 });
    const sparse = ['', ...Array(300).fill('x'.repeat(4000)), ...texts.slice(0, 8)];
    await collect(api, sparse);
    assert.strictEqual(state.maxActive, 1, 'count valid translatable cues, not input array length');
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ cost: (workers) => 5.5 * workers + 4.5, setupCost: 10 });
    await collect(
      api,
      Array.from({ length: 50 }, (_, i) => `Short job ${i}`)
    );
    assert.strictEqual(state.contexts.size, 2);
    assert.strictEqual(state.maxActive, 2, 'weak measured scaling cannot repay a four-context probe');
    assert.strictEqual(state.starts.length, 59, 'only warmup and the two-context probe add work');
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ cost: () => 10 });
    const sparse = ['', 'x'.repeat(4000), ...texts];
    const results = await collect(api, sparse);
    assert.strictEqual(results[0].translation, '');
    assert.match(results[1].error.message, /LOCAL_TEXT_TOO_LONG/);
    assert.deepStrictEqual(
      results.slice(2).map((r) => r.translation),
      texts.map(translated)
    );
    assert.strictEqual(state.contexts.size, 8, 'reused samples retain original indices after invalid cues');
    await api.unloadModel();
  }
  for (const count of [1, 8, 9, 16]) {
    const { api, state } = fixture({ cost: () => 10 });
    await collect(api, texts.slice(0, count));
    assert.strictEqual(state.maxActive, 1, 'skip probes that cannot repay even ideal scaling');
    assert.strictEqual(state.starts.length, count + (count > 8 ? 1 : 0), 'do not translate the baseline twice');
    await api.unloadModel();
  }
  for (const options of [
    { allocationFailure: true },
    { allocationError: 'Failed to create context' },
    { promptFailure: true },
  ]) {
    const { api, state } = fixture(options);
    assert.strictEqual((await collect(api, texts)).length, texts.length);
    assert.deepStrictEqual(state.loads, ['gpu'], 'memory downshift must keep the same GPU model');
    assert.strictEqual(state.contexts.size, 1);
    assert.strictEqual(state.fallbacks.length, 1);
    const report = state.fallbacks[0];
    assert.strictEqual(report.scope, 'local:parallel-fallback');
    assert.ok(report.message.includes(`stage=${options.promptFailure ? 'calibration' : 'context-creation'}`));
    assert.ok(report.message.includes('model=1.8b, backend=cuda, gpuLayers=33'));
    assert.ok(report.message.includes('attemptedWorkers=2, retryWorkers=1'));
    assert.strictEqual(
      report.error.message,
      options.allocationError || (options.promptFailure ? 'CUDA OOM' : 'Insufficient memory for context')
    );
    const reason = options.allocationError ? '병렬 실행 준비에 실패해' : '메모리가 부족해';
    assert.ok(state.notices.some((n) => n.includes(reason) && n.includes('같은 GPU에서 하나씩 번역으로 다시 시도')));
    const attempts = state.attempts;
    await collect(api, texts);
    assert.strictEqual(state.fallbacks.length, 1, 'do not repeat a past error on each next job');
    assert.strictEqual(state.attempts, attempts, 'remember a failed parallel attempt until explicit unload');
    await api.unloadModel();
    await collect(api, texts);
    assert.ok(state.attempts > attempts + 1, 'explicit unload allows a new parallel attempt');
    assert.strictEqual(state.unsafeDisposals, 0);
    await api.unloadModel();
  }
  {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wst-fallback-log-'));
    const loggerPath = path.join(__dirname, '../src/main/services/error-logger.js');
    const loggerModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(loggerPath, 'utf8'), {
      require: createRequire(loggerPath),
      module: loggerModule,
      __dirname: path.dirname(loggerPath),
    });
    const logger = loggerModule.exports;
    logger.setElectronApp({ getPath: () => dir });
    const { api, state } = fixture({ promptFailure: true, logger });
    try {
      const results = await collect(api, texts, 'auto', 2);
      assert.deepStrictEqual(
        results.map((r) => r.translation),
        texts.map(translated)
      );
      assert.strictEqual(state.fallbacks.length, 1);
      const saved = fs.readFileSync(logger.getLogPath(), 'utf8');
      assert.match(saved, /\[local:parallel-fallback\]/);
      assert.match(
        saved,
        /stage=translation, model=1\.8b, backend=cuda, gpuLayers=33, workersBefore=2, attemptedWorkers=2, retryWorkers=1/
      );
      assert.match(saved, /Error: CUDA OOM\n\s+at/);
      assert.ok(saved.includes('같은 GPU에서 하나씩 번역으로 다시 시도합니다'));
      assert.strictEqual(logger.getDiagnosticSummary().lastFailure, 'gpu');
      assert.strictEqual(state.contexts.size, 1);
      assert.strictEqual(state.unsafeDisposals, 0);
    } finally {
      await api.unloadModel();
      fs.rmSync(dir, { recursive: true, force: true }); // Only this test's mkdtemp fixture.
    }
  }
  {
    const { api, state } = fixture({ cost: () => 10 });
    await collect(api, texts);
    await collect(api, texts, 'auto', 1);
    assert.strictEqual(state.contexts.size, 1, 'switching to sequential frees extra contexts');
    await collect(api, texts);
    assert.strictEqual(state.contexts.size, 8, 'switching back restores eligible contexts');
    assert.strictEqual(state.loads.length, 1);
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ waitForAbort: true });
    const first = collect(api, texts, 'auto', 2);
    await until(() => state.active === 2);
    const waiting = collect(api, texts, 'auto', 2);
    const unloading = api.unloadModel();
    const finished = Promise.allSettled([first, waiting, unloading]);
    api.abortTranslation();
    const outcomes = await finished;
    assert.deepStrictEqual(
      outcomes.map((o) => o.status),
      ['rejected', 'rejected', 'fulfilled']
    );
    assert.strictEqual(state.active, 0);
    assert.strictEqual(state.starts.length, 2, 'cancel must not launch the next window or waiting job');
    assert.strictEqual(state.unsafeDisposals, 0);
  }
  {
    const { api, state } = fixture({ waitForAllocationAbort: true });
    const work = collect(api, texts, 'auto', 2);
    await until(() => state.attempts === 2);
    api.abortTranslation();
    await assert.rejects(work, /ABORTED/);
    assert.strictEqual(state.starts.length, 0);
    assert.strictEqual(state.contexts.size, 0);
    assert.strictEqual(state.fallbacks.length, 0, 'cancellation is not a recovered failure');
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ allocationError: 'Unexpected native failure' });
    await assert.rejects(collect(api, texts), /Unexpected native failure/);
    assert.strictEqual(state.attempts, 2, 'unrelated setup errors must still propagate');
    assert.strictEqual(state.fallbacks.length, 0);
    assert.strictEqual(state.contexts.size, 0);
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ genericFailure: true });
    await assert.rejects(collect(api, texts, 'auto', 2), /Unexpected native failure/);
    assert.strictEqual(state.attempts, 2, 'do not hide unrelated failures as a memory downshift');
    assert.strictEqual(state.fallbacks.length, 0);
    assert.strictEqual(state.active, 0);
    assert.strictEqual(state.unsafeDisposals, 0);
    await api.unloadModel();
  }
  {
    const { api, state } = fixture();
    for await (const result of api.translateLocalBatch(texts, 'ko', 'auto', '1.8b', 2)) {
      assert.strictEqual(result.index, 0);
      break;
    }
    assert.strictEqual(state.active, 0);
    assert.strictEqual(state.starts.length, 2, 'bounded window, not background prefetch of the whole file');
    assert.strictEqual(await api.translateLocal('after early return', 'ko'), translated('after early return'));
    await api.unloadModel();
  }
  {
    const { api, state } = fixture();
    await assert.rejects(api.translateLocal('x'.repeat(4000), 'ko'), /LOCAL_TEXT_TOO_LONG/);
    assert.strictEqual(state.loads.length, 0, 'reject oversized input before downloading/loading');
    const results = await collect(api, ['', 'x'.repeat(4000), 'valid sentence']);
    assert.strictEqual(results[0].translation, '');
    assert.match(results[1].error.message, /LOCAL_TEXT_TOO_LONG/);
    assert.strictEqual(results[2].translation, translated('valid sentence'));
    assert.strictEqual(state.maxActive, 1, 'only one remaining valid cue needs a context');
    await api.unloadModel();
  }
  {
    const { api, state } = fixture({ echo: true });
    const results = await collect(api, texts, 'auto', 2);
    assert.ok(results.every((r) => /LOCAL_UNTRANSLATED/.test(r.error?.message)));
    assert.strictEqual(state.starts.length, texts.length * 2, 'one retry per cue in the same independent context');
    await api.unloadModel();
  }
  console.log(
    '[LocalBatch] resource/speed selection, independent contexts, short-job guard, order, fallback, cancellation and lifecycle (ok)'
  );
}

if (require.main === module)
  runLocalBatchTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = runLocalBatchTests;
