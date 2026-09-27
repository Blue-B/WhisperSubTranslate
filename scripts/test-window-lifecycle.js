'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function runWindowLifecycleTests() {
  class TestWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        session: { webRequest: { onHeadersReceived() {} }, clearCache() {} },
        setWindowOpenHandler() {},
      });
    }
    loadFile() {}
    setMenuBarVisibility() {}
  }

  const filename = path.join(__dirname, '../src/main/window.js');
  const testModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename),
    module: testModule,
    console,
    require(name) {
      if (name === 'electron') return { BrowserWindow: TestWindow, Menu: { setApplicationMenu() {} } };
      if (name === './ipc/files') return { isAllowedExternalUrl: () => false };
      if (name === './services/error-logger') return { logError() {} };
      return require(name === '../shared/ipc-channels' ? '../src/shared/ipc-channels' : name);
    },
  });

  let serviceWindow = null;
  let cleanupCalls = 0;
  const transcription = {
    setMainWindow(window) {
      serviceWindow = window;
    },
    forceMemoryCleanup() {
      assert.strictEqual(serviceWindow, null, 'Clear the destroyed window before cleanup or background progress');
      cleanupCalls++;
    },
  };
  const create = () => testModule.exports.createWindow({ isPackaged: false }, transcription, () => null);
  const first = create();
  assert.strictEqual(serviceWindow, first);
  first.emit('closed');
  assert.strictEqual(serviceWindow, null);
  const reopened = create();
  assert.strictEqual(serviceWindow, reopened, 'Reopening must bind progress to the new window');
  reopened.emit('closed');
  assert.strictEqual(cleanupCalls, 2);
  console.log('[WindowLifecycle] close clears service reference; reopen binds the new window (ok)');
}

if (require.main === module) runWindowLifecycleTests();
module.exports = { runWindowLifecycleTests };
