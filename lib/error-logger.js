// 통합 에러 로거: %APPDATA%/whispersubtranslate/logs/errors.log
// translator-enhanced.js + main.js (whisper, ffmpeg, IPC) 모두 여기로 통합
// 2MB 초과 시 최근 1000줄만 유지하는 self-trim.
const fs = require('fs');
const path = require('path');

let _electronApp = null;
function setElectronApp(app) {
  _electronApp = app;
}

function getLogPath() {
  try {
    if (_electronApp && _electronApp.getPath) {
      const base = _electronApp.getPath('userData');
      const logsDir = path.join(base, 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      return path.join(logsDir, 'errors.log');
    }
  } catch (_e) {}
  return path.join(__dirname, '..', 'errors.log');
}

const LOG_MAX_SIZE = 2 * 1024 * 1024;
const LOG_KEEP_LINES = 1000;

function cleanupIfLarge(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size <= LOG_MAX_SIZE) return;
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    if (lines.length > LOG_KEEP_LINES) {
      const kept = lines.slice(-LOG_KEEP_LINES);
      const header = `[Log Cleanup] Trimmed from ${lines.length} lines to ${LOG_KEEP_LINES} lines at ${new Date().toISOString()}\n---\n`;
      fs.writeFileSync(logPath, header + kept.join('\n'), 'utf8');
    }
  } catch (_e) {}
}

function logError(scope, message, err) {
  try {
    const logPath = getLogPath();
    cleanupIfLarge(logPath);
    const ts = new Date().toISOString();
    let body = `[${ts}] [${scope}] ${message}`;
    if (err) {
      if (err.stack) body += `\n${err.stack}`;
      else body += `\n${String(err)}`;
    }
    body += '\n---\n';
    fs.appendFileSync(logPath, body, 'utf8');
  } catch (_e) {
    /* logger must never throw */
  }
}

function logInfo(scope, message) {
  try {
    const logPath = getLogPath();
    cleanupIfLarge(logPath);
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] [${scope}] ${message}\n`, 'utf8');
  } catch (_e) {}
}

module.exports = { setElectronApp, getLogPath, logError, logInfo };
