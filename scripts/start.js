/**
 * Cross-platform launcher for Electron.
 *
 * Some AI agents / terminals leak `ELECTRON_RUN_AS_NODE=1` into child
 * processes, which forces the `electron` binary into Node.js CLI mode.
 * This script unsets the variable before spawning Electron, ensuring it
 * always launches as a GUI app on every platform.
 *
 * On Linux it also checks whether `chrome-sandbox` has the setuid bit;
 * if not, it adds `--no-sandbox` so the app doesn't crash with SIGILL.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 1. Unset the leaked variable so Electron starts in GUI mode.
delete process.env.ELECTRON_RUN_AS_NODE;

// 2. Resolve the electron binary via the installed package.
const electron = require('electron');

// 3. Build the CLI arguments.
const forwardedArgs = process.argv.slice(2);
const args = ['--expose-gc', '.', ...forwardedArgs];

// 4. Linux sandbox permission check.
if (process.platform === 'linux') {
  const sandboxPath = path.join(path.dirname(electron), 'chrome-sandbox');
  let needNoSandbox = false;
  try {
    const stats = fs.statSync(sandboxPath);
    // setuid bit = 0o4000
    if ((stats.mode & 0o4000) === 0) {
      needNoSandbox = true;
    }
  } catch {
    needNoSandbox = true;
  }
  if (needNoSandbox) {
    console.warn('[start] chrome-sandbox lacks setuid bit — launching with --no-sandbox (reduced security). To fix: sudo chown root:root <electron>/chrome-sandbox && sudo chmod 4755 <electron>/chrome-sandbox');
    args.unshift('--no-sandbox');
  }
}

// 5. Spawn Electron and forward stdio / exit code.
const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
