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
const LOCAL_OPERATION_TIMEOUT_MS = 3 * 60 * 1000;
// 7B Q6(6.16GB) 모델 로드는 느린 디스크/첫 실행에서 수 분이 걸릴 수 있어
// 추론(3분)과 분리된 별도 타임아웃을 둔다.
const LOCAL_LOAD_TIMEOUT_MS = 15 * 60 * 1000;

function getModelUrl(modelId) {
  const m = MODELS[modelId];
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
}

// Language name map for prompt — Hy-MT2 officially supports 33+ languages.
// Use FULL language names in the prompt (per Tencent Hy-MT2 model card).
// 참고: 'zh-Hant'/'yue'는 main.js TARGET_LANG_RE(소문자 2~8자)로 UI 드롭다운에서
// 도달 불가지만, local-translate IPC는 검증 없이 targetLang을 받으므로
// 직접 호출 경로를 위해 유지한다.
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
let _context = null;
let _session = null;
let _currentGpuMode = null; // 'auto' | 'cpu'
let _currentModelId = null; // '1.8b' | '7b'
let _downloadPromises = {}; // modelId → Promise
let _loadPromise = null;
let _translateMutex = Promise.resolve();
const _activeAbortControllers = new Set();
let _onDownloadProgress = null;
// in-flight 다운로드의 진행률 구독자 (동일 모델에 두 번째 호출자가 붙어도
// 체인을 무한 누적하지 않고 Set으로 관리해 완료 시 정리한다 — MED 8).
const _downloadSubscribers = new Map(); // modelId → Set<fn>

// 모델 다운로드 전 디스크 여유 공간 확인 (MED 4).
function assertDiskSpaceFor(modelId) {
  const m = MODELS[modelId];
  if (!m) return;
  try {
    const dir = getModelsDir();
    if (!fs.existsSync(dir)) return;
    const { bavail, bsize } = fs.statfsSync(dir);
    const freeBytes = bavail * bsize;
    if (freeBytes < m.sizeBytes) {
      throw new Error(
        `Not enough disk space: need ${(m.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB, free ${(
          freeBytes /
          1024 /
          1024 /
          1024
        ).toFixed(2)} GB`
      );
    }
  } catch (error) {
    if (error?.message?.startsWith('Not enough disk space')) throw error;
    // statfsSync 실패(예: 네트워크 드라이브)는 무시하고 다운로드 진행
  }
}

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
  assertDiskSpaceFor(modelId);
  _downloadPromises[modelId] = _downloadModelImpl(signal, modelId).finally(() => {
    delete _downloadPromises[modelId];
    _downloadSubscribers.delete(modelId);
  });
  return await waitForDownload(_downloadPromises[modelId], signal);
}

function waitForDownload(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Download cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('Download cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function _downloadModelImpl(signal, modelId) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`Unknown model id: ${modelId}`);
  const dir = getModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = getModelPath(modelId);
  const tmp = dest + '.tmp';

  // 진행률 구독자 일괄 호출 (첫 호출자 + 추가 대기자).
  const emitProgress = (p) => {
    for (const sub of _downloadSubscribers.get(modelId) || []) {
      try {
        sub(p);
      } catch (_e) {
        /* ignore */
      }
    }
    if (_onDownloadProgress)
      try {
        _onDownloadProgress(p);
      } catch (_e) {
        /* ignore */
      }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const abortError = () => (signal?.reason instanceof Error ? signal.reason : new Error('Download cancelled'));
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        fs.unlinkSync(tmp);
      } catch {}
      reject(error);
    };

    const doRequest = (url, redirects = 0, resumeOffset = 0) => {
      if (settled) return;
      if (signal?.aborted) return fail(abortError());
      if (redirects > 5) return fail(new Error('Too many redirects'));

      let out = null;
      let req = null;
      const detachAbort = () => signal?.removeEventListener('abort', abortRequest);
      const abortRequest = () => {
        req?.destroy();
        out?.destroy();
        fail(abortError());
      };

      const headers = {};
      if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;
      req = https.get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          detachAbort();
          res.resume();
          return doRequest(res.headers.location, redirects + 1, resumeOffset);
        }
        // resume 지원 서버는 206, 미지원/서버가 재시작한 경우 200으로 온다.
        const isPartial = res.statusCode === 206;
        if (res.statusCode !== 200 && !isPartial) {
          detachAbort();
          res.resume();
          return fail(new Error(`HTTP ${res.statusCode}`));
        }
        if (resumeOffset > 0 && !isPartial) {
          // 서버가 Range를 무시했다 → 처음부터 다시 받는다 (기존 tmp 폐기).
          try {
            fs.unlinkSync(tmp);
          } catch {}
          resumeOffset = 0;
        }

        const total = parseInt(res.headers['content-length'] || m.sizeBytes, 10) + (isPartial ? resumeOffset : 0);
        let downloaded = resumeOffset;
        const writeFlags = isPartial || resumeOffset > 0 ? 'a' : 'w';
        out = fs.createWriteStream(tmp, { flags: writeFlags });
        out.on('error', (error) => {
          detachAbort();
          res.destroy();
          fail(error);
        });

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!out.write(chunk)) {
            res.pause();
            out.once('drain', () => res.resume());
          }
          const p = { modelId, percent: Math.round((downloaded / total) * 100), downloaded, total };
          emitProgress(p);
        });

        res.on('end', () => {
          detachAbort();
          out.end(() => {
            if (settled) return;
            try {
              // 잘린 다운로드 방지: content-length가 주어졌고 받은 양이 다르면 실패 (MED 4).
              if (res.headers['content-length'] && downloaded !== total) {
                return fail(new Error(`Download incomplete: got ${downloaded} of ${total} bytes (model ${modelId})`));
              }
              fs.renameSync(tmp, dest);
              settled = true;
              resolve(dest);
            } catch (error) {
              fail(error);
            }
          });
        });

        res.on('error', (error) => {
          detachAbort();
          out.destroy();
          fail(error);
        });
      });

      signal?.addEventListener('abort', abortRequest, { once: true });
      req.on('error', (error) => {
        detachAbort();
        fail(signal?.aborted ? abortError() : error);
      });
    };

    // 이미 받다 만 tmp가 있으면 이어받기 시도 (MED 5).
    let resumeOffset = 0;
    try {
      resumeOffset = fs.statSync(tmp).size;
    } catch {
      resumeOffset = 0;
    }
    doRequest(getModelUrl(modelId), 0, resumeOffset);
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
async function loadModelUnlocked(device = 'auto', modelId = DEFAULT_MODEL_ID, signal = null) {
  const desiredMode = device === 'cpu' ? 'cpu' : 'auto';
  if (_model && _currentGpuMode === desiredMode && _currentModelId === modelId) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    // translateLocal이 잡은 mutex 안에서 다시 unloadModel의 mutex를 기다리면 교착된다.
    if (_model || _llama) await disposeModel();
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
      await disposeModel();
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
  // 락 대기 중에도 사용자 중지가 통하도록 컨트롤러를 먼저 등록한다.
  const controller = new AbortController();
  _activeAbortControllers.add(controller);
  try {
    const release = await acquireTranslateLock(controller.signal);
    try {
      return await _translateLocalImpl(text, targetLang, device, modelId, controller.signal);
    } finally {
      release();
    }
  } finally {
    _activeAbortControllers.delete(controller);
  }
}

async function _translateLocalImpl(text, targetLang, device, modelId, signal) {
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
        if (!_context) {
          _context = await _model.createContext({ contextSize: 2048, createSignal: operationSignal });
        }
      },
      LOCAL_LOAD_TIMEOUT_MS,
      signal
    );
    const { LlamaChatSession } = await import('node-llama-cpp');
    if (!_session) {
      _session = new LlamaChatSession({
        contextSequence: _context.getSequence(),
        chatWrapper: 'auto',
      });
    }
    _session.resetChatHistory();
  } catch (error) {
    await disposeModel();
    throw error;
  }

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
    response = (
      await withTimeout(
        (operationSignal) => _session.prompt(prompt, { ...samplingBase, temperature: 0, signal: operationSignal }),
        LOCAL_OPERATION_TIMEOUT_MS,
        signal
      )
    ).trim();

    // echo 감지 시 공식 권장 샘플링(temp 0.7)으로 1회 재시도
    if (looksUntranslated(response, text, targetLang)) {
      console.warn(`[Local] 번역 결과가 원문 그대로임 → 재시도: "${text.substring(0, 40)}"`);
      _session.resetChatHistory();
      response = (
        await withTimeout(
          (operationSignal) => _session.prompt(prompt, { ...samplingBase, temperature: 0.7, signal: operationSignal }),
          LOCAL_OPERATION_TIMEOUT_MS,
          signal
        )
      ).trim();
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

async function disposeModel() {
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
}

async function unloadModel() {
  const release = await acquireTranslateLock();
  try {
    await disposeModel();
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
  isEffectivelySameText,
  looksUntranslated,
  withTimeout,
  abortTranslation,
  unloadModel,
  setDownloadProgressHandler,
  cleanupLegacyModels,
  // Backwards compat
  MODEL_FILE: MODELS[DEFAULT_MODEL_ID].file,
  MODEL_SIZE_BYTES: MODELS[DEFAULT_MODEL_ID].sizeBytes,
};
