/**
 * local-translator.js
 * HY-MT1.5 GGUF local translation engine (1.8B / 7B 듀얼 지원)
 * Runs in Electron main process via dynamic import (ESM)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');

// 모델 카탈로그 — 새 모델 추가는 여기에만
const MODELS = {
  '1.8b': {
    id: '1.8b',
    repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    file: 'HY-MT1.5-1.8B-Q4_K_M.gguf',
    sizeBytes: 1_130_000_000, // ~1.13GB
    displayName: 'HY-MT 1.8B Q4',
    requirements: {
      vram: '2GB',
      ram: '4GB',
      diskGB: 1.2,
      speed: '빠름',
    },
  },
  '7b': {
    id: '7b',
    repo: 'tencent/HY-MT1.5-7B-GGUF',
    file: 'HY-MT1.5-7B-Q4_K_M.gguf',
    sizeBytes: 4_580_000_000, // ~4.58GB
    displayName: 'HY-MT 7B Q4',
    requirements: {
      vram: '6GB',
      ram: '10GB',
      diskGB: 4.6,
      speed: '느림 (고품질)',
    },
  },
};
const DEFAULT_MODEL_ID = '1.8b';

function getModelUrl(modelId) {
  const m = MODELS[modelId];
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
}

// Language name map for prompt
const LANG_NAMES = {
  ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese',
  fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', pl: 'Polish',
  nl: 'Dutch', tr: 'Turkish', vi: 'Vietnamese', th: 'Thai',
  id: 'Indonesian', ms: 'Malay', hi: 'Hindi', bn: 'Bengali',
  uk: 'Ukrainian', he: 'Hebrew', ta: 'Tamil', te: 'Telugu',
};

let _llama = null;
let _model = null;
let _context = null;
let _session = null;
let _currentGpuMode = null;     // 'auto' | 'cpu'
let _currentModelId = null;     // '1.8b' | '7b'
let _downloadPromises = {};     // modelId → Promise
let _loadPromise = null;
let _translateMutex = Promise.resolve();
let _onDownloadProgress = null;

function getModelsDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'hy-mt-models');
}

function getModelPath(modelId = DEFAULT_MODEL_ID) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  return path.join(getModelsDir(), m.file);
}

function isModelInstalled(modelId = DEFAULT_MODEL_ID) {
  const m = MODELS[modelId];
  if (!m) return false;
  try {
    const stat = fs.statSync(getModelPath(modelId));
    return stat.size > m.sizeBytes * 0.95;
  } catch { return false; }
}

function listModels() {
  return Object.values(MODELS).map(m => ({
    id: m.id,
    displayName: m.displayName,
    sizeBytes: m.sizeBytes,
    sizeMB: Math.round(m.sizeBytes / 1024 / 1024),
    requirements: m.requirements,
    installed: isModelInstalled(m.id),
  }));
}

function setDownloadProgressHandler(cb) { _onDownloadProgress = cb; }

/**
 * Download model with progress callback.
 */
async function downloadModel(onProgress, signal, modelId = DEFAULT_MODEL_ID) {
  // 동일 모델에 대한 in-flight 다운로드는 공유
  if (_downloadPromises[modelId]) {
    if (onProgress) {
      const prev = _onDownloadProgress;
      _onDownloadProgress = (p) => {
        try { onProgress(p); } catch (_e) { /* ignore */ }
        if (prev) try { prev(p); } catch (_e) { /* ignore */ }
      };
    }
    return _downloadPromises[modelId];
  }
  _downloadPromises[modelId] = _downloadModelImpl(onProgress, signal, modelId)
    .finally(() => { delete _downloadPromises[modelId]; });
  return _downloadPromises[modelId];
}

async function _downloadModelImpl(onProgress, signal, modelId) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  const dir = getModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = getModelPath(modelId);
  const tmp  = dest + '.tmp';

  return new Promise((resolve, reject) => {
    const doRequest = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));

      const req = https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          return doRequest(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const total = parseInt(res.headers['content-length'] || m.sizeBytes, 10);
        let downloaded = 0;
        const out = fs.createWriteStream(tmp);

        if (signal) {
          signal.addEventListener('abort', () => {
            req.destroy();
            out.destroy();
            try { fs.unlinkSync(tmp); } catch {}
            reject(new Error('Download cancelled'));
          }, { once: true });
        }

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!out.write(chunk)) {
            res.pause();
            out.once('drain', () => res.resume());
          }
          const p = { modelId, percent: Math.round(downloaded / total * 100), downloaded, total };
          if (onProgress) onProgress(p);
          if (_onDownloadProgress) try { _onDownloadProgress(p); } catch (_e) { /* ignore */ }
        });

        res.on('end', () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });

        res.on('error', (e) => { out.destroy(); reject(e); });
      });

      req.on('error', (e) => {
        if (e.message !== 'Download cancelled') reject(e);
      });
    };

    doRequest(getModelUrl(modelId));
  });
}

function deleteModel(modelId = DEFAULT_MODEL_ID) {
  try { fs.unlinkSync(getModelPath(modelId)); } catch {}
}

/**
 * Load model into memory.
 * @param {string} device - 'auto' (GPU 우선) 또는 'cpu'
 * @param {string} modelId - '1.8b' | '7b'
 */
async function loadModel(device = 'auto', modelId = DEFAULT_MODEL_ID) {
  const desiredMode = device === 'cpu' ? 'cpu' : 'auto';
  if (_model && _currentGpuMode === desiredMode && _currentModelId === modelId) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (_model) await unloadModel();
    const { getLlama } = await import('node-llama-cpp');
    _llama = await getLlama({ gpu: desiredMode === 'cpu' ? false : 'auto' });
    _model = await _llama.loadModel({ modelPath: getModelPath(modelId) });
    _currentGpuMode = desiredMode;
    _currentModelId = modelId;
    console.log(`[Local] 모델 로드 완료 (id=${modelId}, device=${desiredMode}, gpuLayers=${_model?.gpuLayers ?? 'n/a'})`);
  })().finally(() => { _loadPromise = null; });
  return _loadPromise;
}

/**
 * Translate text using local HY-MT model.
 * @param {string} text
 * @param {string} targetLang - 2-letter code
 * @param {string} device - 'auto' | 'cpu'
 * @param {string} modelId - '1.8b' | '7b'
 */
async function translateLocal(text, targetLang, device = 'auto', modelId = DEFAULT_MODEL_ID) {
  const release = await new Promise(resolve => {
    const prev = _translateMutex;
    _translateMutex = new Promise(r => prev.then(() => resolve(r)));
  });
  try {
    return await _translateLocalImpl(text, targetLang, device, modelId);
  } finally {
    release();
  }
}

async function _translateLocalImpl(text, targetLang, device, modelId) {
  if (!isModelInstalled(modelId)) {
    console.log(`[Local] 모델 미설치 감지 (${modelId}) → 자동 다운로드 시작...`);
    await downloadModel((p) => {
      console.log(`[Local] 다운로드 ${p.percent}% (${Math.round(p.downloaded/1024/1024)}MB / ${Math.round(p.total/1024/1024)}MB)`);
    }, null, modelId);
  }

  await loadModel(device, modelId);

  if (!_context) {
    _context = await _model.createContext({ contextSize: 2048 });
  }
  const { LlamaChatSession } = await import('node-llama-cpp');
  if (!_session) {
    _session = new LlamaChatSession({ contextSequence: _context.getSequence() });
  }

  const targetName = LANG_NAMES[targetLang] || targetLang;
  const prompt = `Translate the following text to ${targetName}. Output only the translation, no explanation.\n\n${text}`;

  try {
    const response = await _session.prompt(prompt, {
      temperature: 0.3,
      topK: 20,
      topP: 0.6,
      repeatPenalty: { penalty: 1.05 },
    });
    if (_session.sequence && typeof _session.resetChatHistory === 'function') {
      try { _session.resetChatHistory(); } catch (_e) { /* ignore */ }
    }
    return response.trim();
  } catch (e) {
    try { _session = null; _context && await _context.dispose(); _context = null; } catch (_e) { /* ignore */ }
    throw e;
  }
}

async function unloadModel() {
  const release = await new Promise(resolve => {
    const prev = _translateMutex;
    _translateMutex = new Promise(r => prev.then(() => resolve(r)));
  });
  try {
    try { if (_context) await _context.dispose(); } catch { /* ignore */ }
    try { if (_model) await _model.dispose(); } catch { /* ignore */ }
    try { if (_llama) await _llama.dispose(); } catch { /* ignore */ }
    _session = null; _context = null; _model = null; _llama = null;
    _currentGpuMode = null; _currentModelId = null;
  } finally {
    release();
  }
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  listModels,
  isModelInstalled,
  getModelPath,
  getModelsDir,
  downloadModel,
  deleteModel,
  loadModel,
  translateLocal,
  unloadModel,
  setDownloadProgressHandler,
  // Backwards compat
  MODEL_FILE: MODELS[DEFAULT_MODEL_ID].file,
  MODEL_SIZE_BYTES: MODELS[DEFAULT_MODEL_ID].sizeBytes,
};
