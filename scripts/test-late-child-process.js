'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const readline = require('readline');

async function runLateChildProcessTests() {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/services/transcription.js'), 'utf8');
  const capture = source.indexOf('const spawnedProcess = currentProcess;');
  const captureEnd = source.indexOf('// Process timeout handling', capture);
  const output = source.indexOf('readline.createInterface({ input: currentProcess.stdout', captureEnd);
  const outputEnd = source.indexOf("currentProcess.on('error'", output);
  const helper = source.indexOf('function sendToRenderer(');
  const helperEnd = source.indexOf('function setMainWindow(', helper);
  assert.ok(capture >= 0 && captureEnd > capture && output > captureEnd && outputEnd > output);
  assert.ok(helper >= 0 && helperEnd > helper);

  // Execute the production PID listeners, output callbacks and async close callback.
  // Native processes and file IO are replaced, not the callback implementations.
  for (const state of ['live', 'missing', 'destroyed-window', 'destroyed-contents', 'send-throws']) {
    for (const [exitCode, existingSrt, timedOut] of [
      [0, false, false],
      [0, true, false],
      [1, true, false],
      [127, true, false],
      [0, true, true],
    ]) {
      const child = Object.assign(new EventEmitter(), {
        pid: 4321,
        stdout: new PassThrough(),
        stderr: new EventEmitter(),
      });
      const sent = [];
      const written = [];
      let result;
      const win =
        state === 'missing'
          ? null
          : {
              isDestroyed: () => state === 'destroyed-window',
              webContents: {
                isDestroyed: () => state === 'destroyed-contents',
                send(channel, payload) {
                  if (state === 'send-throws') throw new Error('Object has been destroyed');
                  sent.push([channel, payload]);
                },
              },
            };
      const context = vm.createContext({
        readline,
        currentProcess: child,
        childProcessIds: new Set(),
        mainWindow: win,
        processTimeout: null,
        clearTimeout() {},
        console: { log() {}, warn() {} },
        process: { platform: 'linux' },
        WHISPER_CLI_NAME: 'whisper-cli',
        path,
        stderrBuffer: '',
        parseWhisperProgress: () => null,
        sendExtractionProgress() {},
        stripProgressLines: (text) => text,
        forceMemoryCleanup: async () => {},
        fs: {
          existsSync: () => existingSrt,
          readFileSync: () => '1\n00:00:01,000 --> 00:00:02,000\nOld dialogue\n',
          writeFileSync: (...args) => written.push(args),
        },
        isCompleteSrt: () => true,
        applyTokenTightTiming() {},
        outputBase: '/fixture',
        srtPath: '/fixture.srt',
        originalSrtPath: '/fixture.srt',
        filePath: '/fixture.wav',
        wavPath: '/fixture.wav',
        wavReused: false,
        chosenDevice: 'cpu',
        usingSafeTemp: false,
        isUserStopped: false,
        modelPath: '/fixture.bin',
        timedOut,
        errLogger: { logError() {} },
        resolve: (value) => {
          result = { success: value };
        },
        reject: (error) => {
          result = { error: error.message, timedOut: error.timedOut };
        },
      });
      vm.runInContext(
        source.slice(helper, helperEnd) + source.slice(capture, captureEnd) + source.slice(output, outputEnd),
        context
      );
      assert.ok(context.childProcessIds.has(child.pid));
      context.currentProcess = null;
      const text = Buffer.from('late 출력\n');
      child.stdout.write(text.subarray(0, 7)); // split inside a UTF-8 character
      assert.strictEqual(sent.length, 0, 'partial subtitle line must not reach localization');
      child.stdout.write(text.subarray(7));
      if (state === 'live') assert.strictEqual(sent[0][1], 'late 출력\n');
      child.stderr.emit('data', Buffer.from('error in native output\n'));
      // EventEmitter does not await async listeners; await each one to catch rejected callbacks.
      for (const listener of child.listeners('close')) await listener(exitCode);
      assert.strictEqual(context.childProcessIds.size, 0, state);
      if (exitCode === 0 && !timedOut) {
        assert.strictEqual(result.success, '/fixture.srt', `${state}: close promise must settle`);
        assert.deepStrictEqual(written, existingSrt ? [] : [['/fixture.srt', '', 'utf8']]);
      } else {
        assert.match(
          result.error,
          timedOut ? /Error code: 0/ : exitCode === 127 ? /failed to execute \(code 127\)/ : /Whisper processing failed/
        );
        if (timedOut) assert.strictEqual(result.timedOut, true);
      }
      assert.strictEqual(sent.length, state === 'live' ? (exitCode === 0 && !existingSrt ? 3 : 2) : 0, state);
      // Reopened window receives new output, never the destroyed old contents.
      context.mainWindow = {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) },
      };
      child.stdout.write('reopened\n');
      assert.deepStrictEqual(sent.at(-1), ['output-update', 'reopened\n']);
      child.stdout.end();
    }
  }
  console.log(
    '[LateChildProcess] production output/close handlers settle with live, absent and destroyed windows (ok)'
  );
}

if (require.main === module)
  runLateChildProcessTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = runLateChildProcessTests;
