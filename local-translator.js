/**
 * local-translator.js
 * Hy-MT2 GGUF local translation engine (1.8B / 7B 듀얼 지원)
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
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    sizeBytes: 1_133_080_448, // ~1.13GB
    displayName: 'Hy-MT2 1.8B Q4',
    requirements: {
      vram: '2GB',
      ram: '4GB',
      diskGB: 1.2,
      speed: '빠름',
    },
  },
  '7b': {
    id: '7b',
    repo: 'tencent/Hy-MT2-7B-GGUF',
    file: 'HY-MT2-7B-Q6_K.gguf',
    sizeBytes: 6_164_482_720, // ~6.16GB (Q6_K — higher quality tier)
    displayName: 'Hy-MT2 7B Q6',
    requirements: {
      vram: '8GB',
      ram: '12GB',
      diskGB: 6.2,
      speed: '느림 (고품질)',
    },
  },
};
const DEFAULT_MODEL_ID = '1.8b';

function getModelUrl(modelId) {
  const m = MODELS[modelId];
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
}

// Language name map for prompt — Hy-MT2 officially supports 33+ languages.
// Use FULL language names in the prompt (per Tencent Hy-MT2 model card).
const LANG_NAMES = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  'zh-Hant': 'Traditional Chinese',
  yue: 'Cantonese',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  pl: 'Polish',
  nl: 'Dutch',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Filipino',
  hi: 'Hindi',
  bn: 'Bengali',
  uk: 'Ukrainian',
  he: 'Hebrew',
  ta: 'Tamil',
  te: 'Telugu',
  cs: 'Czech',
  km: 'Khmer',
  my: 'Burmese',
  fa: 'Persian',
  gu: 'Gujarati',
  ur: 'Urdu',
  mr: 'Marathi',
  bo: 'Tibetan',
  kk: 'Kazakh',
  mn: 'Mongolian',
  ug: 'Uyghur',
};

// 공식 ZH<=>XX 프롬프트용 중국어 표기 (Hy-MT2 model card)
const ZH_TARGET_NAMES = { zh: '中文', 'zh-Hant': '繁體中文', yue: '粤语' };

// Hy-MT2 공식 프롬프트 템플릿(model card 그대로).
// 타깃이 중국어 계열이면 중국어 템플릿, 그 외엔 영어 템플릿.
function buildTranslationPrompt(text, targetLang) {
  const zhName = ZH_TARGET_NAMES[targetLang];
  if (zhName) return `把下面的文本翻译成${zhName}，不要额外解释。\n\n${text}`;
  const targetName = LANG_NAMES[targetLang] || targetLang;
  return `Translate the following segment into ${targetName}, without additional explanation.\n\n${text}`;
}

// 번역 실패(echo) 감지: 비 CJK 타깃인데 출력이 여전히 CJK 위주면 원문 통과로 판정.
// 소스에 CJK가 거의 없으면(기호·숫자·라틴 자막) 판정하지 않는다 — 오탐 방지.
function looksUntranslated(output, source, targetLang) {
  const out = (output || '').trim();
  if (!out) return true;
  const src = (source || '').trim();
  const srcCjk = (src.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  if (srcCjk < 2) return false;
  if (targetLang === 'ja' || targetLang === 'zh' || targetLang === 'zh-Hant' || targetLang === 'yue') {
    return false; // CJK 타깃은 문자 기반 판정 불가
  }
  const compact = out.replace(/\s/g, '');
  if (!compact) return true;
  const kanaHan = (out.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const hangul = (out.match(/[\uac00-\ud7af]/g) || []).length;
  if (targetLang === 'ko') return kanaHan / compact.length > 0.5;
  return (kanaHan + hangul) / compact.length > 0.5;
}

let _llama = null;
let _model = null;
let _context = null;
let _session = null;
let _currentGpuMode = null; // 'auto' | 'cpu'
let _currentModelId = null; // '1.8b' | '7b'
let _downloadPromises = {}; // modelId → Promise
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
  } catch {
    return false;
  }
}

// Legacy model cleanup: remove obsolete *.gguf the app downloaded previously
// (e.g. HY-MT1.5 files orphaned after the Hy-MT2 upgrade). Only touches our own
// model files (hy-mt*/hunyuan*) that are NOT in the current catalog. Runs once.
let _legacyCleanupDone = false;
function cleanupLegacyModels() {
  const keep = new Set(Object.values(MODELS).map((m) => m.file));
  const removed = [];
  let dir;
  let files;
  try {
    dir = getModelsDir();
    files = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const f of files) {
    if (!f.endsWith('.gguf')) continue; // skip .tmp partials & non-models
    if (keep.has(f)) continue; // keep current catalog models
    if (!/^(hy-mt|hunyuan)/i.test(f)) continue; // only our own model files
    try {
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    } catch {
      /* ignore */
    }
  }
  if (removed.length)
    console.log('[Local] \ub808\uac70\uc2dc \ubaa8\ub378 \ud30c\uc77c \uc815\ub9ac:', removed.join(', '));
  return removed;
}
function _maybeCleanupLegacy() {
  if (_legacyCleanupDone) return;
  _legacyCleanupDone = true;
  try {
    cleanupLegacyModels();
  } catch {
    /* ignore */
  }
}

function listModels() {
  _maybeCleanupLegacy();
  return Object.values(MODELS).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    sizeBytes: m.sizeBytes,
    sizeMB: Math.round(m.sizeBytes / 1024 / 1024),
    requirements: m.requirements,
    installed: isModelInstalled(m.id),
  }));
}

function setDownloadProgressHandler(cb) {
  _onDownloadProgress = cb;
}

/**
 * Download model with progress callback.
 */
async function downloadModel(onProgress, signal, modelId = DEFAULT_MODEL_ID) {
  // 동일 모델에 대한 in-flight 다운로드는 공유
  if (_downloadPromises[modelId]) {
    if (onProgress) {
      const prev = _onDownloadProgress;
      _onDownloadProgress = (p) => {
        try {
          onProgress(p);
        } catch (_e) {
          /* ignore */
        }
        if (prev)
          try {
            prev(p);
          } catch (_e) {
            /* ignore */
          }
      };
    }
    return _downloadPromises[modelId];
  }
  _downloadPromises[modelId] = _downloadModelImpl(onProgress, signal, modelId).finally(() => {
    delete _downloadPromises[modelId];
  });
  return _downloadPromises[modelId];
}

async function _downloadModelImpl(onProgress, signal, modelId) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  const dir = getModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = getModelPath(modelId);
  const tmp = dest + '.tmp';

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
          signal.addEventListener(
            'abort',
            () => {
              req.destroy();
              out.destroy();
              try {
                fs.unlinkSync(tmp);
              } catch {}
              reject(new Error('Download cancelled'));
            },
            { once: true }
          );
        }

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!out.write(chunk)) {
            res.pause();
            out.once('drain', () => res.resume());
          }
          const p = { modelId, percent: Math.round((downloaded / total) * 100), downloaded, total };
          if (onProgress) onProgress(p);
          if (_onDownloadProgress)
            try {
              _onDownloadProgress(p);
            } catch (_e) {
              /* ignore */
            }
        });

        res.on('end', () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });

        res.on('error', (e) => {
          out.destroy();
          reject(e);
        });
      });

      req.on('error', (e) => {
        if (e.message !== 'Download cancelled') reject(e);
      });
    };

    doRequest(getModelUrl(modelId));
  });
}

function deleteModel(modelId = DEFAULT_MODEL_ID) {
  try {
    fs.unlinkSync(getModelPath(modelId));
  } catch {}
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
    console.log(
      `[Local] 모델 로드 완료 (id=${modelId}, device=${desiredMode}, gpuLayers=${_model?.gpuLayers ?? 'n/a'})`
    );
  })().finally(() => {
    _loadPromise = null;
  });
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
  const release = await new Promise((resolve) => {
    const prev = _translateMutex;
    _translateMutex = new Promise((r) => prev.then(() => resolve(r)));
  });
  try {
    return await _translateLocalImpl(text, targetLang, device, modelId);
  } finally {
    release();
  }
}

async function _translateLocalImpl(text, targetLang, device, modelId) {
  _maybeCleanupLegacy();
  if (!isModelInstalled(modelId)) {
    console.log(`[Local] 모델 미설치 감지 (${modelId}) → 자동 다운로드 시작...`);
    await downloadModel(
      (p) => {
        console.log(
          `[Local] 다운로드 ${p.percent}% (${Math.round(p.downloaded / 1024 / 1024)}MB / ${Math.round(p.total / 1024 / 1024)}MB)`
        );
      },
      null,
      modelId
    );
  }

  await loadModel(device, modelId);

  if (!_context) {
    _context = await _model.createContext({ contextSize: 2048 });
  }
  const { LlamaChatSession } = await import('node-llama-cpp');
  if (!_session) {
    _session = new LlamaChatSession({
      contextSequence: _context.getSequence(),
      chatWrapper: 'auto',
    });
  }
  _session.resetChatHistory();

  const prompt = buildTranslationPrompt(text, targetLang);
  const samplingBase = {
    topK: 20,
    topP: 0.6,
    repeatPenalty: { penalty: 1.05 },
    maxTokens: 1024, // App-side safety cap (not a Tencent recommendation)
  };

  let response;
  try {
    // 1차: 결정적 샘플링(temp 0) — 자막 번역은 무작위성이 echo(원문 그대로 출력) 사고를 키운다
    response = (await _session.prompt(prompt, { ...samplingBase, temperature: 0 })).trim();

    // echo 감지 시 공식 권장 샘플링(temp 0.7)으로 1회 재시도
    if (looksUntranslated(response, text, targetLang)) {
      console.warn(`[Local] 번역 결과가 원문 그대로임 → 재시도: "${text.substring(0, 40)}"`);
      _session.resetChatHistory();
      response = (await _session.prompt(prompt, { ...samplingBase, temperature: 0.7 })).trim();
    }
  } catch (e) {
    try {
      _session = null;
      _context && (await _context.dispose());
      _context = null;
    } catch (_e) {
      /* ignore */
    }
    throw e;
  }

  if (looksUntranslated(response, text, targetLang)) {
    // 조용히 원문을 저장하지 않는다 — 상위(translateBatch)가 다른 엔진으로 폴백한다.
    // 세션은 정상이므로 dispose하지 않는다.
    throw new Error(`LOCAL_UNTRANSLATED: model returned untranslated text for "${text.substring(0, 40)}"`);
  }
  return response;
}

async function unloadModel() {
  const release = await new Promise((resolve) => {
    const prev = _translateMutex;
    _translateMutex = new Promise((r) => prev.then(() => resolve(r)));
  });
  try {
    try {
      if (_context) await _context.dispose();
    } catch {
      /* ignore */
    }
    try {
      if (_model) await _model.dispose();
    } catch {
      /* ignore */
    }
    try {
      if (_llama) await _llama.dispose();
    } catch {
      /* ignore */
    }
    _session = null;
    _context = null;
    _model = null;
    _llama = null;
    _currentGpuMode = null;
    _currentModelId = null;
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
  buildTranslationPrompt,
  looksUntranslated,
  unloadModel,
  setDownloadProgressHandler,
  cleanupLegacyModels,
  // Backwards compat
  MODEL_FILE: MODELS[DEFAULT_MODEL_ID].file,
  MODEL_SIZE_BYTES: MODELS[DEFAULT_MODEL_ID].sizeBytes,
};
