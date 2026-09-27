/**
 * local-translator.js
 * Hy-MT2 GGUF local translation engine (1.8B / 7B 듀얼 지원)
 * Runs in Electron main process via dynamic import (ESM)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { assertDownloadDiskSpace } = require('./disk-space');
const { downloadVerifiedFile, sha256File } = require('./verified-downloader');

// 사용자에게 보여줄 진행 로그를 보낼 창. transcription.setMainWindow가 전파한다.
// 문구는 한국어로 보내고 렌더러의 LOG_I18N이 UI 언어로 번역한다.
let uiWindow = null;

function setMainWindow(window) {
  uiWindow = window;
}

function notifyUser(message) {
  try {
    if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('output-update', `${message}\n`);
  } catch (_e) {
    /* 진행 로그는 실패해도 번역을 막지 않는다 */
  }
}

function reportParallelFallback(error, modelId, stage, attemptedWorkers = _sessions.length) {
  const message = isMemoryError(error)
    ? '로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다'
    : '로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다';
  const details = `stage=${stage}, model=${modelId}, backend=${_llama.gpu || 'cpu'}, gpuLayers=${_model.gpuLayers}, workersBefore=${_sessions.length}, attemptedWorkers=${attemptedWorkers}, retryWorkers=1`;
  require('./error-logger').logError('local:parallel-fallback', `${message} (${details})`, error);
  notifyUser(message);
}

// 모델 카탈로그 — 새 모델 추가는 여기에만
const MODELS = {
  '1.8b': {
    id: '1.8b',
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    revision: '1cd5208700acedef4ef93019b6cfc148b8522d45',
    file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    sizeBytes: 1_133_080_448, // Hugging Face LFS metadata
    sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
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
    revision: 'ab8472660ac61fac25f1af43fac2599d52a8a775',
    file: 'HY-MT2-7B-Q6_K.gguf',
    sizeBytes: 6_164_482_720, // Hugging Face LFS metadata (Q6_K)
    sha256: '88ef0aba59952a4cfe4be36cb5baf797dbb370bc60e9dcbd7297036021e52831',
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
const LOCAL_OPERATION_TIMEOUT_MS = 3 * 60 * 1000;
// 7B Q6(6.16GB) 모델 로드는 느린 디스크/첫 실행에서 수 분이 걸릴 수 있어
// 추론(3분)과 분리된 별도 타임아웃을 둔다.
const LOCAL_LOAD_TIMEOUT_MS = 15 * 60 * 1000;

function getModelUrl(modelId) {
  const m = MODELS[modelId];
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
}

// Language name map for prompt — Hy-MT2 officially supports 33+ languages.
// Use FULL language names in the prompt (per Tencent Hy-MT2 model card).
// 'zh-Hant' and 'yue' are not currently exposed by the renderer, but the
// service keeps them because direct internal callers may request them.
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

function normalizeComparableText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

// 고유명사/라벨+숫자 패턴만 있는 원문은 번역 대상으로 보지 않는다.
// ('Episode 7', 'John Smith Tokyo', 'Chapter 2' 등은 번역 후에도 동일하게
// 남는 게 정상이라 echo로 오탐하면 매번 클라우드 폴백이 발생한다.)
function hasProperNounOnlyPattern(srcRaw) {
  const t = String(srcRaw || '').trim();
  if (!t) return false;
  // 라벨 + 숫자: "Episode 7", "Chapter 3", "Part 2", "Season 1: ..."
  if (/^(episode|chapter|part|act|scene|season|vol\.?|no\.?|number|title|track)\b[\s\d:.-]*$/i.test(t)) return true;
  // 대문자 시작 단어만 연속으로 나열된 고유명사: "John Smith Tokyo", "New York"
  const words = t.split(/[\s,-]+/).filter(Boolean);
  return words.length >= 2 && words.every((w) => /^[A-Z][a-zA-Z'’-]*$/.test(w));
}

function isEffectivelySameText(output, source, minLength = 3) {
  const src = normalizeComparableText(source);
  const out = normalizeComparableText(output);
  if (src.length < minLength) return false;
  // 숫자/기호만 있는 원문(예: "123", "!!!")은 번역 대상이 아니므로 echo로 보지 않는다.
  if (!/[\p{L}]/u.test(src)) return false;
  // 고유명사/라벨+숫자만 있는 원문은 번역 후에도 그대로인 게 정상이다.
  if (hasProperNounOnlyPattern(source)) return false;
  if (out === src) return true;

  // "Original: <source>"처럼 짧은 라벨만 붙인 echo도 번역으로 인정하지 않는다.
  const extraLength = out.length - src.length;
  return extraLength > 0 && extraLength <= Math.max(16, Math.ceil(src.length * 0.35)) && out.includes(src);
}

// 번역 실패(echo) 감지: 공백/문장부호만 달라진 원문 반환은 모든 언어에서 잡고,
// CJK 원문→비 CJK 타깃은 문자 비율로 한 번 더 판정한다.
function looksUntranslated(output, source, targetLang) {
  const out = (output || '').trim();
  if (!out) return true;
  const src = (source || '').trim();
  if (isEffectivelySameText(out, src)) return true;
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
let _contexts = [];
let _sessions = [];
// Short jobs avoid calibration; long jobs compare resource-admitted candidates.
const LOCAL_MEMORY_RESERVE = 512 * 1024 ** 2;
const _parallelUnavailableModels = new Set();
let _currentGpuMode = null; // 'auto' | 'cpu'
let _currentModelId = null; // '1.8b' | '7b'
// GPU 시도가 실패한 모델을 기억해 같은 실패를 줄마다 반복하지 않는다.
// 자막은 줄 단위로 번역되고, 모델 로드는 모델당 수십 초가 걸린다.
const _gpuUnusableModels = new Set();
let _downloadPromises = {}; // modelId → Promise
let _loadPromise = null;
let _translateMutex = Promise.resolve();
const _activeAbortControllers = new Set();
const _validatedModelFiles = new Map();
let _onDownloadProgress = null;
// in-flight 다운로드의 진행률 구독자 (동일 모델에 두 번째 호출자가 붙어도
// 체인을 무한 누적하지 않고 Set으로 관리해 완료 시 정리한다 — MED 8).
const _downloadSubscribers = new Map(); // modelId → Set<fn>

async function withTimeout(run, timeoutMs = LOCAL_OPERATION_TIMEOUT_MS, parentSignal = null) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`LOCAL_TIMEOUT: local model operation exceeded ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function abortTranslation() {
  // 여러 호출이 큐에 쌓여 있어도 각자 컨트롤러를 갖고 있으므로 전부 중단한다.
  for (const controller of _activeAbortControllers) {
    if (!controller.signal.aborted) {
      controller.abort(new Error('ABORTED: Translation stopped by user'));
    }
  }
}

async function acquireTranslateLock(signal = null) {
  return await new Promise((resolve, reject) => {
    const prev = _translateMutex;
    let aborted = false;

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      reject(signal?.reason || new Error('ABORTED: Translation stopped by user'));
    };

    // 대기 중 abort가 오면 즉시 reject할 수 있도록 리스너를 락 획득 전에 등록한다.
    // (이전엔 prev.then 안에서 등록해 락 대기 중에는 abort가 통하지 않았다)
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        reject(signal.reason || new Error('ABORTED: Translation stopped by user'));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // 체인: prev가 resolve되면(=이전 보유자가 release) 이번 대기자가 락을 받는다.
    // 이미 abort로 거절된 대기자는 락을 받는 순간 즉시 release해
    // 뒤따르는 대기자들의 체인을 끊지 않는다.
    _translateMutex = new Promise((release) => {
      prev.then(() => {
        if (aborted) {
          release();
          return;
        }
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      });
    });
  });
}

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
    return stat.isFile() && stat.size === m.sizeBytes;
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
      if (!_downloadSubscribers.has(modelId)) _downloadSubscribers.set(modelId, new Set());
      _downloadSubscribers.get(modelId).add(onProgress);
      const cleanup = () => {
        _downloadSubscribers.get(modelId)?.delete(onProgress);
        if (!_downloadSubscribers.get(modelId)?.size) _downloadSubscribers.delete(modelId);
      };
      _downloadPromises[modelId].then(cleanup, cleanup);
    }
    return await waitForDownload(_downloadPromises[modelId], signal);
  }
  if (onProgress) {
    if (!_downloadSubscribers.has(modelId)) _downloadSubscribers.set(modelId, new Set());
    _downloadSubscribers.get(modelId).add(onProgress);
  }
  _downloadPromises[modelId] = _downloadModelImpl(signal, modelId).finally(() => {
    delete _downloadPromises[modelId];
    _downloadSubscribers.delete(modelId);
  });
  // The owner waits for the transfer itself to settle. Returning early on its abort
  // would let an immediate retry attach to the still-cancelling shared promise.
  return await _downloadPromises[modelId];
}

function waitForDownload(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Download cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('Download cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function installVerifiedModelFile(partialPath, destinationPath) {
  const backupPath = `${destinationPath}.previous-${process.pid}-${Date.now()}`;
  const hadDestination = fs.existsSync(destinationPath);
  if (hadDestination) fs.renameSync(destinationPath, backupPath);
  try {
    fs.renameSync(partialPath, destinationPath);
  } catch (error) {
    if (hadDestination) fs.renameSync(backupPath, destinationPath);
    throw error;
  }
  if (hadDestination) {
    try {
      fs.unlinkSync(backupPath);
    } catch (error) {
      console.warn(`[Local] installed model but could not remove replacement backup: ${error.message}`);
    }
  }
}

async function ensureModelIntegrity(modelId) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  const modelPath = getModelPath(modelId);
  const stat = fs.statSync(modelPath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  if (_validatedModelFiles.get(modelPath) === cacheKey) return;
  const digest = await sha256File(modelPath);
  if (digest !== m.sha256) throw new Error(`LOCAL_MODEL_INTEGRITY: SHA-256 verification failed (${modelId})`);
  _validatedModelFiles.set(modelPath, cacheKey);
}

async function _downloadModelImpl(signal, modelId) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  const dir = getModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = getModelPath(modelId);
  const tmp = dest + '.tmp';
  const emitProgress = (percent, downloaded, total) => {
    const progress = { modelId, percent, downloaded, total };
    for (const sub of _downloadSubscribers.get(modelId) || []) {
      try {
        sub(progress);
      } catch (_e) {}
    }
    try {
      _onDownloadProgress?.(progress);
    } catch (_e) {}
  };
  const activeDownloads = new Set();
  const abortDownloads = () => {
    for (const tracker of activeDownloads) {
      tracker.cancelled = true;
      tracker.controller?.abort();
      tracker.writer?.destroy();
    }
  };
  signal?.addEventListener('abort', abortDownloads, { once: true });
  try {
    await downloadVerifiedFile({
      axios,
      assertDownloadDiskSpace,
      url: getModelUrl(modelId),
      partialPath: tmp,
      label: m.displayName,
      expectedSize: m.sizeBytes,
      sha256: m.sha256,
      onProgress: emitProgress,
      activeDownloads,
      isCancelled: () => Boolean(signal?.aborted),
    });
    if (signal?.aborted) throw signal.reason || new Error('Download cancelled');
    installVerifiedModelFile(tmp, dest);
    const stat = fs.statSync(dest);
    _validatedModelFiles.set(dest, `${stat.size}:${stat.mtimeMs}`);
    return dest;
  } finally {
    signal?.removeEventListener('abort', abortDownloads);
  }
}

function deleteModel(modelId = DEFAULT_MODEL_ID) {
  try {
    fs.unlinkSync(getModelPath(modelId));
  } catch {}
}

function prepareBundledCudaRuntime() {
  if (process.platform !== 'win32' || !process.resourcesPath) return;
  const directory = path.join(process.resourcesPath, 'whisper-cpp');
  const dlls = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];
  if (!dlls.every((name) => fs.existsSync(path.join(directory, name)))) return;
  // node-llama-cpp's auto detector searches PATH, not its bundled backend directory.
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!entries.includes(directory)) process.env.PATH = [...entries, directory].join(path.delimiter);
}

/**
 * Load model into memory.
 * @param {string} device - 'auto' (GPU 우선) 또는 'cpu'
 * @param {string} modelId - '1.8b' | '7b'
 */
async function loadModelUnlocked(device = 'auto', modelId = DEFAULT_MODEL_ID, signal = null) {
  // 이 모델로 GPU 시도가 이미 실패했다면 같은 실패를 다시 반복하지 않는다.
  // (자막은 줄 단위로 번역되므로 매 실패가 줄마다 누적된다)
  const desiredMode = device === 'cpu' || _gpuUnusableModels.has(modelId) ? 'cpu' : 'auto';
  if (_model && _currentGpuMode === desiredMode && _currentModelId === modelId) return;
  await ensureModelIntegrity(modelId);
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    // translateLocal이 잡은 mutex 안에서 다시 unloadModel의 mutex를 기다리면 교착된다.
    if (_model || _llama) await disposeModel();
    prepareBundledCudaRuntime();
    const { getLlama } = await import('node-llama-cpp');
    let mode = desiredMode;
    try {
      _llama = await getLlama({ gpu: mode === 'cpu' ? false : 'auto' });
      _model = await _llama.loadModel({ modelPath: getModelPath(modelId), loadSignal: signal });
    } catch (error) {
      // GPU 자동 모드에서 CUDA/VRAM 계열 실패면 같은 모델을 CPU로 1회 재시도한다.
      // (구형 카드/드라이버/VRAM 부족은 GPU 로드만 실패하고 CPU는 동작한다)
      if (mode !== 'auto' || !isGpuRelatedError(error)) {
        // 로드 실패로 파편으로 남은 _llama/_model을 정리한다 (MED 6).
        await disposeModel();
        throw error;
      }
      console.warn(`[Local] GPU 로드 실패 → CPU로 폴백: ${error.message}`);
      notifyUser(`로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다 (${error.message})`);
      await disposeModel();
      _gpuUnusableModels.add(modelId);
      mode = 'cpu';
      _llama = await getLlama({ gpu: false });
      _model = await _llama.loadModel({ modelPath: getModelPath(modelId), loadSignal: signal });
    }
    _currentGpuMode = mode;
    _currentModelId = modelId;
    console.log(`[Local] 모델 로드 완료 (id=${modelId}, device=${mode}, gpuLayers=${_model?.gpuLayers ?? 'n/a'})`);
  })().finally(() => {
    _loadPromise = null;
  });
  return _loadPromise;
}

// GPU 로드 실패와 관련된 오류 메시지 판정 (VRAM 부족/드라이버/CUDA 등).
// CPU 폴백은 이 계열 실패에만 적용해 다른 원인(파일 손상 등)을 숨기지 않는다.
function isGpuRelatedError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return /cuda|cublas|vram|out of memory|out-of-memory|oom|gpu|nvidia|illegal memory|driver/i.test(msg);
}

async function loadModel(device = 'auto', modelId = DEFAULT_MODEL_ID, signal = null) {
  const release = await acquireTranslateLock();
  try {
    return await loadModelUnlocked(device, modelId, signal);
  } finally {
    release();
  }
}

/**
 * Translate text using local HY-MT model.
 * @param {string} text
 * @param {string} targetLang - 2-letter code
 * @param {string} device - 'auto' | 'cpu'
 * @param {string} modelId - '1.8b' | '7b'
 */
async function translateLocal(text, targetLang, device = 'auto', modelId = DEFAULT_MODEL_ID) {
  for await (const result of translateLocalBatch([text], targetLang, device, modelId, 1)) {
    if (result.error) throw result.error;
    return result.translation;
  }
}

function isMemoryError(error) {
  return /out.?of.?memory|\boom\b|insufficient.*memory|not enough.*memory|vram|failed to alloc|memory allocation/i.test(
    String(error?.message || error)
  );
}

// ponytail: bounded windows preserve ordering without a background worker queue.
// Each context owns its KV cache; only the read-only model weights are shared.
async function* translateLocalBatch(texts, targetLang, device = 'auto', modelId = DEFAULT_MODEL_ID, concurrency) {
  if (!texts.length) return;
  const controller = new AbortController();
  const { signal } = controller;
  _activeAbortControllers.add(controller);
  const started = Date.now();
  let release;
  try {
    release = await acquireTranslateLock(signal);
    let ready = false;
    const sampled = new Map();
    for (let index = 0; index < texts.length; ) {
      signal.throwIfAborted();
      if (!texts[index]?.trim()) {
        yield { index: index, translation: texts[index++] };
        continue;
      }
      try {
        checkedPrompt(texts[index].trim(), targetLang);
      } catch (error) {
        yield { index: index++, error };
        continue;
      }
      if (!ready) {
        if (concurrency === undefined) {
          const translations = await selectLocalConcurrency(texts.slice(index), targetLang, device, modelId, signal);
          for (const [offset, translation] of translations) sampled.set(index + offset, translation);
        } else {
          await prepareLocal(device, modelId, signal, Math.min(texts.length - index, concurrency));
        }
        if (texts.length > 1) {
          notifyUser(
            `로컬 번역: 실행 정보 (model=${modelId}, backend=${_llama.gpu || 'cpu'}, gpuLayers=${_model.gpuLayers}, workers=${_sessions.length})`
          );
        }
        ready = true;
      }
      const batch = texts.slice(index, index + _sessions.length);
      const results = await Promise.allSettled(
        batch.map((text, slot) =>
          sampled.has(index + slot)
            ? sampled.get(index + slot)
            : translateWithSession(text, targetLang, _sessions[slot], signal)
        )
      );
      signal.throwIfAborted();
      const fatal = results.find(
        (result) =>
          result.status === 'rejected' && !/LOCAL_UNTRANSLATED|LOCAL_TEXT_TOO_LONG/.test(String(result.reason?.message))
      );
      if (fatal) {
        if (_sessions.length > 1 && isMemoryError(fatal.reason)) {
          _parallelUnavailableModels.add(modelId);
          // All native calls have settled before disposal. Retry on the same GPU,
          // not on CPU, and do not repeat this parallel failure on every subtitle.
          reportParallelFallback(fatal.reason, modelId, 'translation');
          await disposeContexts();
          ready = false;
          continue;
        }
        throw fatal.reason;
      }
      for (const result of results) {
        signal.throwIfAborted();
        yield result.status === 'fulfilled'
          ? { index: index++, translation: result.value }
          : { index: index++, error: result.reason };
      }
    }
    signal.throwIfAborted();
    if (texts.length > 1) {
      notifyUser(
        `로컬 번역: 처리 완료 (segments=${texts.length}, seconds=${((Date.now() - started) / 1000).toFixed(1)})`
      );
    }
  } catch (error) {
    // A cancelled waiter does not own the active job's contexts.
    if (release) await disposeContexts();
    throw error;
  } finally {
    release?.();
    _activeAbortControllers.delete(controller);
  }
}

function checkedPrompt(text, targetLang) {
  // 컨텍스트 사전 체크: Hy-MT2는 contextSize 2048 고정이고 출력에 maxTokens 1024를
  // 쓰므로, 입력이 길면 조용히 잘리는 대신 명확한 에러로 알린다 (모델 로드/다운로드 전에).
  // 대략 토큰 수: 라틴 계열 ~4글자당 1토큰 + CJK 글자당 ~1토큰 (문자 수 상한 추정).
  // 안전하게 입력 예산을 900토큰으로 잡는다 (2048 - 1024 출력 - 마진).
  const precheckPrompt = buildTranslationPrompt(text, targetLang);
  const cjkChars = (precheckPrompt.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const approxTokens = Math.ceil(precheckPrompt.length / 4) + cjkChars;
  if (approxTokens > 900) {
    throw new Error(
      `LOCAL_TEXT_TOO_LONG: 입력 자막이 로컬 모델 컨텍스트(2048)를 초과할 수 있습니다 ` +
        `(추정 ${approxTokens} 토큰). 문장을 짧게 나눠 다시 시도하세요.`
    );
  }

  return precheckPrompt;
}

// Compare identical length-stratified subtitles, not different consecutive windows.
// ponytail: per-job sampling avoids stale device/model/workload caches. It is a
// bounded estimate, not a guarantee of the globally fastest concurrency.
async function selectLocalConcurrency(texts, targetLang, device, modelId, signal) {
  const sampled = new Map();
  const valid = texts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => {
      if (!text?.trim()) return false;
      try {
        checkedPrompt(text.trim(), targetLang);
        return true;
      } catch {
        return false;
      }
    });
  await prepareLocal(device, modelId, signal, 1);
  const sampleCount = Math.min(valid.length, 32, Math.max(8, Math.floor(valid.length / 64)));
  // No point benchmarking when the sample would finish the entire job.
  if (valid.length <= sampleCount) return sampled;
  const limit = await getLocalConcurrencyLimit(sampleCount, modelId);
  if (limit <= 1) return sampled;
  const sorted = [...valid].sort((a, b) => a.text.length - b.text.length);
  const samples = Array.from(
    { length: sampleCount },
    (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / sampleCount)]
  );
  const started = performance.now();
  const measure = async (keep = false) => {
    const start = performance.now();
    for (let i = 0; i < samples.length; i += _sessions.length) {
      const results = await Promise.allSettled(
        samples
          .slice(i, i + _sessions.length)
          .map(({ text }, slot) => translateWithSession(text, targetLang, _sessions[slot], signal))
      );
      signal.throwIfAborted();
      const failure =
        results.find(
          (r) => r.status === 'rejected' && !/LOCAL_UNTRANSLATED|LOCAL_TEXT_TOO_LONG/.test(String(r.reason?.message))
        ) || results.find((r) => r.status === 'rejected');
      if (failure) throw failure.reason;
      if (keep) results.forEach((result, slot) => sampled.set(samples[i + slot].index, result.value));
    }
    return Math.max(0.01, performance.now() - start);
  };
  let best = 1;
  try {
    // Warm first-use kernels before comparing. The warmup cost still counts below.
    await translateWithSession(samples[0].text, targetLang, _sessions[0], signal);
    const baseline = await measure(true);
    const remaining = valid.length - sampled.size;
    let bestTime = baseline;
    let setupPerContext = 0;
    for (let candidate = 2; candidate <= limit; candidate = Math.min(limit, candidate * 2)) {
      // Start optimistically, then fit the scalable fraction to measured speedup.
      // Weak scaling should not trigger another costly probe on a short job.
      const scalable = best === 1 ? 1 : Math.min(1, Math.max(0, (1 - bestTime / baseline) / (1 - 1 / best)));
      const predicted = baseline * (1 - scalable + scalable / candidate);
      const probeCost = predicted + setupPerContext * (candidate - best);
      if (((bestTime - predicted) * remaining) / sampleCount <= probeCost) break;
      const before = performance.now();
      await prepareLocal(device, modelId, signal, candidate);
      if (_sessions.length < candidate) break;
      const measured = await measure();
      const setup = performance.now() - before - measured;
      const gain = bestTime - measured;
      const projectedSaving = (gain * remaining) / sampleCount;
      console.log(
        `[Local] Auto probe workers=${candidate}, sample=${sampleCount}, ms=${measured.toFixed(1)}, setupMs=${setup.toFixed(1)}`
      );
      // Prefer fewer contexts for marginal/noisy gains or unamortized setup.
      if (gain < bestTime * 0.05 || projectedSaving <= setup + measured) break;
      setupPerContext = Math.max(0, setup) / (candidate - best);
      best = candidate;
      bestTime = measured;
      if (candidate === limit) break;
    }
    // Reuse baseline output. Probe costs are already spent: reverting a measured
    // faster choice cannot recover them and would only slow the remaining work.
    const overhead = performance.now() - started - baseline;
    console.log(`[Local] Auto selection workers=${best}, overheadMs=${overhead.toFixed(1)}`);
  } catch (error) {
    signal.throwIfAborted();
    if (isMemoryError(error)) {
      _parallelUnavailableModels.add(modelId);
      reportParallelFallback(error, modelId, 'calibration');
      await disposeContexts(); // All sample calls settled; retire even the failing first context.
      best = 1;
    } else if (/LOCAL_UNTRANSLATED|LOCAL_TEXT_TOO_LONG/.test(String(error?.message))) {
      best = 1; // Leave cue-level errors to the ordered, normal translation path.
    } else {
      throw error;
    }
  }
  await prepareLocal(device, modelId, signal, best);
  return sampled;
}

async function getLocalConcurrencyLimit(requested, modelId) {
  const totalLayers = _model.fileInsights?.totalLayers;
  if (
    !Number.isFinite(requested) ||
    !(requested > 1) ||
    _llama.gpu !== 'cuda' ||
    !(_model.gpuLayers > 0 && _model.gpuLayers >= totalLayers) ||
    _parallelUnavailableModels.has(modelId)
  )
    return 1;
  try {
    const context = _contexts[0];
    const { cpuRam, gpuVram } = _model.fileInsights.estimateContextResourceRequirements({
      contextSize: 2048,
      modelGpuLayers: _model.gpuLayers,
      sequences: 1,
      batchSize: context.batchSize,
      flashAttention: context.flashAttention,
    });
    const { free } = await _llama.getVramState();
    if (!Number.isFinite(gpuVram) || gpuVram <= 0 || !Number.isFinite(cpuRam) || cpuRam < 0 || !Number.isFinite(free))
      return 1;
    const ramSlots =
      cpuRam > 0 ? Math.floor((require('os').freemem() - LOCAL_MEMORY_RESERVE) / cpuRam) : Math.floor(requested);
    // Existing extra contexts already occupy memory. Count them back into the budget.
    const extra = _contexts.length - 1 + Math.min(ramSlots, Math.floor((free - LOCAL_MEMORY_RESERVE) / gpuVram));
    return Math.max(1, Math.min(Math.floor(requested), 1 + extra));
  } catch (error) {
    console.warn(`[Local] Resource estimate unavailable, using one context: ${error.message}`);
    return 1;
  }
}

async function prepareLocal(device, modelId, signal, concurrency) {
  _maybeCleanupLegacy();
  if (!isModelInstalled(modelId)) {
    console.log(`[Local] 모델 미설치 감지 (${modelId}) → 자동 다운로드 시작...`);
    await downloadModel(
      (p) => {
        console.log(
          `[Local] 다운로드 ${p.percent}% (${Math.round(p.downloaded / 1024 / 1024)}MB / ${Math.round(p.total / 1024 / 1024)}MB)`
        );
      },
      signal,
      modelId
    );
  }

  try {
    await withTimeout(
      async (operationSignal) => {
        await loadModelUnlocked(device, modelId, operationSignal);
        if (!_contexts.length) {
          try {
            _contexts.push(await _model.createContext({ contextSize: 2048, createSignal: operationSignal }));
          } catch (error) {
            // VRAM이 빠듯한 카드에서는 7B 모델의 부분 오프로드 로드가 성공하고
            // 컨텍스트 생성에서만 VRAM 부족으로 실패한다. 이 단계가 폴백 밖에 있으면
            // CPU로는 멀쩡히 돌아가는 번역이 그대로 실패한다.
            if (operationSignal.aborted || _currentGpuMode !== 'auto' || !isGpuRelatedError(error)) throw error;
            console.warn(`[Local] GPU 컨텍스트 생성 실패 → CPU로 폴백: ${error.message}`);
            notifyUser(`로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다 (${error.message})`);
            _gpuUnusableModels.add(modelId);
            await disposeModel();
            await loadModelUnlocked('cpu', modelId, operationSignal);
            _contexts.push(await _model.createContext({ contextSize: 2048, createSignal: operationSignal }));
          }
        }
      },
      LOCAL_LOAD_TIMEOUT_MS,
      signal
    );
    const { LlamaChatSession } = await import('node-llama-cpp');
    if (!_sessions.length) {
      _sessions.push(new LlamaChatSession({ contextSequence: _contexts[0].getSequence(), chatWrapper: 'auto' }));
    }
    const limit = await getLocalConcurrencyLimit(concurrency, modelId);
    await disposeContexts(limit);
    while (_contexts.length < limit) {
      signal.throwIfAborted();
      try {
        const context = await withTimeout(
          (operationSignal) => _model.createContext({ contextSize: 2048, createSignal: operationSignal }),
          LOCAL_LOAD_TIMEOUT_MS,
          signal
        );
        _contexts.push(context);
        _sessions.push(new LlamaChatSession({ contextSequence: context.getSequence(), chatWrapper: 'auto' }));
      } catch (error) {
        // Native init can erase the allocation reason into this exact wrapper error.
        if (signal.aborted || (!isMemoryError(error) && error.message !== 'Failed to create context')) throw error;
        console.warn(`[Local] Additional context failed; keeping one context: ${error.message}`);
        _parallelUnavailableModels.add(modelId);
        reportParallelFallback(error, modelId, 'context-creation', limit);
        await disposeContexts(1);
        break;
      }
    }
    console.log(`[Local] contexts=${_contexts.length}, backend=${_llama.gpu || 'cpu'}, gpuLayers=${_model.gpuLayers}`);
  } catch (error) {
    await disposeModel();
    throw error;
  }
}

async function translateWithSession(text, targetLang, session, signal) {
  signal.throwIfAborted();
  if (!text?.trim()) return text;
  text = text.trim();
  const prompt = checkedPrompt(text, targetLang);
  session.resetChatHistory();
  const samplingBase = {
    topK: 20,
    topP: 0.6,
    repeatPenalty: { penalty: 1.05 },
    maxTokens: 1024, // App-side safety cap (not a Tencent recommendation)
  };

  // Each prompt, including echo retries, stays inside its own context.
  let response = (
    await withTimeout(
      (operationSignal) => session.prompt(prompt, { ...samplingBase, temperature: 0, signal: operationSignal }),
      LOCAL_OPERATION_TIMEOUT_MS,
      signal
    )
  ).trim();

  if (looksUntranslated(response, text, targetLang)) {
    console.warn(`[Local] 번역 결과가 원문 그대로임 → 재시도: "${text.substring(0, 40)}"`);
    session.resetChatHistory();
    response = (
      await withTimeout(
        (operationSignal) => session.prompt(prompt, { ...samplingBase, temperature: 0.7, signal: operationSignal }),
        LOCAL_OPERATION_TIMEOUT_MS,
        signal
      )
    ).trim();
  }

  if (looksUntranslated(response, text, targetLang)) {
    // 조용히 원문을 저장하지 않는다 — 상위(translateBatch)가 다른 엔진으로 폴백한다.
    // 세션은 정상이므로 dispose하지 않는다.
    throw new Error(`LOCAL_UNTRANSLATED: model returned untranslated text for "${text.substring(0, 40)}"`);
  }
  return response;
}

async function disposeContexts(keep = 0) {
  _sessions.splice(keep);
  for (const context of _contexts.splice(keep)) {
    try {
      await context.dispose();
    } catch {
      /* Preserve the original operation error during best-effort cleanup. */
    }
  }
}

async function disposeModel() {
  await disposeContexts();
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
  _model = null;
  _llama = null;
  _currentGpuMode = null;
  _currentModelId = null;
}

async function unloadModel() {
  const release = await acquireTranslateLock();
  try {
    // 사용자가 명시적으로 해제했으면 다음 실행에서 GPU를 다시 시도한다.
    _gpuUnusableModels.clear();
    _parallelUnavailableModels.clear();
    await disposeModel();
  } finally {
    release();
  }
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  setMainWindow,
  listModels,
  isModelInstalled,
  getModelPath,
  downloadModel,
  deleteModel,
  loadModel,
  translateLocal,
  translateLocalBatch,
  isEffectivelySameText,
  hasProperNounOnlyPattern,
  looksUntranslated,
  withTimeout,
  abortTranslation,
  unloadModel,
  setDownloadProgressHandler,
  ensureModelIntegrity,
};
