'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
const localTranslator = require('../local-translator');
const { hasWhisperRuntimeLibraries } = require('./postinstall');
const { applySrtCleanup, isSdhOnlyText, srtFromWhisperJson } = require('../srt-cleanup');

function runSrtCleanup() {
  // no-op when no options selected
  const base = '1\n00:00:01,000 --> 00:00:02,000\n>> Hello\n';
  assert.strictEqual(applySrtCleanup(base, {}), base);

  // speaker-change markers stripped
  const spk = applySrtCleanup('1\n00:00:01,000 --> 00:00:02,000\n>> Hi there\n', { removeSpeakerTags: true });
  assert.ok(!spk.includes('>>') && spk.includes('Hi there'));

  // SDH (A안): drop tag-only cues, keep mixed lines, renumber
  const sdh = [
    '1',
    '00:00:01,000 --> 00:00:03,000',
    '[music playing]',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    "(sighs) I can't believe it",
    '',
    '3',
    '00:00:07,000 --> 00:00:08,000',
    '(applause)',
    '',
    '4',
    '00:00:09,000 --> 00:00:10,000',
    'Real dialogue',
    '',
  ].join('\n');
  const sdhOut = applySrtCleanup(sdh, { removeSDH: true });
  assert.ok(!sdhOut.includes('[music playing]') && !/\(applause\)/.test(sdhOut));
  assert.ok(sdhOut.includes("(sighs) I can't believe it") && sdhOut.includes('Real dialogue'));
  assert.deepStrictEqual(
    sdhOut.split(/\n\s*\n/).map((b) => b.split('\n')[0]),
    ['1', '2']
  );

  // isSdhOnlyText classification
  assert.strictEqual(isSdhOnlyText(['♪♪']), true);
  assert.strictEqual(isSdhOnlyText(['Hello']), false);
  // dialogue sandwiched between two sound tags must NOT be treated as SDH-only
  assert.strictEqual(isSdhOnlyText(['(grunting) Help me! (groans)']), false);
  assert.strictEqual(isSdhOnlyText(['[noise] Real line [end]']), false);
  assert.strictEqual(isSdhOnlyText(['(applause)']), true);
  // and such a mixed cue survives a full cleanup pass
  const mixed = '1\n00:00:01,000 --> 00:00:02,000\n(grunting) Help me! (groans)\n';
  assert.ok(applySrtCleanup(mixed, { removeSDH: true }).includes('Help me!'));

  // non-SRT input is never destroyed
  const garbage = 'just text\nno cues';
  assert.strictEqual(applySrtCleanup(garbage, { removeSDH: true }), garbage);
}

function runSrtFromWhisperJson() {
  // 실측 재현: VAD로 "ありがとうございます"(10자) 세그먼트가 59.85s->87.26s(27.4초)로 늘어났다.
  // (참고: -ojf 토큰 offsets는 VAD 압축 타임라인이라 원본 복원 불가 → 세그먼트 from/to만 쓴다.)
  // 시작은 그대로, 길이는 텍스트 분량(10자*350=3500ms)로 캅되어야 한다.
  const json = JSON.stringify({
    transcription: [
      { offsets: { from: 41370, to: 43360 }, text: ' どうだいいところだろ' },
      { offsets: { from: 59850, to: 87260 }, text: ' ありがとうございます' },
      { offsets: { from: 87260, to: 88250 }, text: ' どうですか' },
    ],
  });
  const srt = srtFromWhisperJson(json, { perCharMs: 350, minDisplayMs: 1200, maxDisplayMs: 7000 });
  assert.ok(srt && srt.includes('ありがとうございます'), 'SRT 생성됨');
  const blocks = srt.trim().split(/\n\s*\n/);
  // 1번: 일반 대사는 원본 길이 그대로 (41.37->43.36)
  assert.ok(/00:00:41,370 --> 00:00:43,360/.test(blocks[0]), '일반 대사는 원본 시각 유지: ' + blocks[0]);
  // 2번: 늘어진 것은 시작 그대로(59.85), 끝은 텍스트 비례 칅(59.85+3.5=63.35), 87s로 늘어면 안됨
  assert.ok(/00:00:59,850 --> 00:01:03,350/.test(blocks[1]), '늘어진 큐는 텍스트 분량으로 칅: ' + blocks[1]);
  assert.ok(!/--> 00:01:27,260/.test(blocks[1]), '늘어진 큐의 끝이 87.26s로 떨어지면 안 됨: ' + blocks[1]);
  // 3번: 다음 대사는 제 위치(87.26)에 뜨
  assert.ok(/00:01:27,260 --> /.test(srt), '다음 대사는 실제 발화 시각에 뜨');

  // 폴백: 깨진 JSON/빈 입력은 null (호출측이 -osrt로 폴백)
  assert.strictEqual(srtFromWhisperJson('not json'), null);
  assert.strictEqual(srtFromWhisperJson('{"transcription":[]}'), null);
  assert.strictEqual(srtFromWhisperJson(''), null);
}

function runWhisperRuntimeProbe() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-runtime-probe-'));
  try {
    assert.strictEqual(hasWhisperRuntimeLibraries(path.join(runtimeDir, 'missing-cli'), runtimeDir), false);
    assert.strictEqual(hasWhisperRuntimeLibraries(process.execPath, path.dirname(process.execPath)), true);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function runModelDownloadAbort() {
  const https = require('https');
  const { EventEmitter } = require('events');
  const electronPath = require.resolve('electron');
  const originalElectron = require.cache[electronPath].exports;
  const originalGet = https.get;
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-model-abort-'));
  const controller = new AbortController();
  let requestCount = 0;
  let destroyed = false;

  try {
    require.cache[electronPath].exports = { app: { getPath: () => modelDir } };
    // 구현이 https.get(url, { headers }, callback) 형태로 바뀌어 mock도 옵션 인자를 받는다.
    https.get = (_url, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const request = new EventEmitter();
      request.destroy = () => {
        destroyed = true;
        request.emit('error', new Error('socket closed'));
      };
      requestCount++;
      if (requestCount === 1) {
        queueMicrotask(() =>
          cb({ statusCode: 302, headers: { location: 'https://example.test/model' }, resume() {} })
        );
      } else {
        queueMicrotask(() => controller.abort(new Error('ABORTED: test download')));
      }
      return request;
    };

    await assert.rejects(() => localTranslator.downloadModel(null, controller.signal), /ABORTED: test download/);
    assert.strictEqual(requestCount, 2, 'download should follow one redirect before aborting');
    assert.strictEqual(destroyed, true, 'abort should destroy the active request before a response arrives');

    requestCount = 0;
    destroyed = false;
    https.get = (_url, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const request = new EventEmitter();
      request.destroy = () => {
        destroyed = true;
        request.emit('error', new Error('socket closed'));
      };
      requestCount++;
      return request;
    };

    const owner = new AbortController();
    const ownerDownload = localTranslator.downloadModel(null, owner.signal);
    const waiter = new AbortController();
    waiter.abort(new Error('ABORTED: second waiter'));
    await assert.rejects(() => localTranslator.downloadModel(null, waiter.signal), /ABORTED: second waiter/);
    assert.strictEqual(destroyed, false, 'a waiting caller must not cancel the shared transfer');
    owner.abort(new Error('ABORTED: download owner'));
    await assert.rejects(() => ownerDownload, /ABORTED: download owner/);
    assert.strictEqual(requestCount, 1, 'shared callers must reuse one request');
    assert.strictEqual(destroyed, true, 'the transfer owner must still be able to cancel the request');
  } finally {
    https.get = originalGet;
    require.cache[electronPath].exports = originalElectron;
    fs.rmSync(modelDir, { recursive: true, force: true });
  }
}

async function runLocalTranslationGuards() {
  assert.strictEqual(localTranslator.looksUntranslated('Hola mundo!', 'Hola mundo.', 'en'), true);
  assert.strictEqual(localTranslator.looksUntranslated('Hello world', 'Hola mundo', 'en'), false);
  assert.strictEqual(localTranslator.looksUntranslated('こんにちは', 'こんにちは', 'en'), true);
  assert.strictEqual(localTranslator.isEffectivelySameText('Original: Hola mundo', 'Hola mundo', 1), true);

  // HIGH 1 — 고유명사/숫자 자막은 echo 오탐하지 않는다 (클라우드 폴백 비용 방지).
  assert.strictEqual(localTranslator.looksUntranslated('Episode 7', 'Episode 7', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('John Smith Tokyo', 'John Smith Tokyo', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('123', '123', 'ko'), false);
  assert.strictEqual(localTranslator.looksUntranslated('안녕하세요', 'Hello', 'ko'), false);
  // 진짜 echo는 여전히 잡는다.
  assert.strictEqual(localTranslator.looksUntranslated('Hello there', 'Hello there', 'ko'), true);
  assert.strictEqual(localTranslator.isEffectivelySameText('Hi', 'Hi'), false, '2자 이하 스킵 (기존 동작 유지)');

  const waitForAbort = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(() => localTranslator.withTimeout(waitForAbort, 20), /LOCAL_TIMEOUT/);

  const parent = new AbortController();
  const aborted = localTranslator.withTimeout(waitForAbort, 1000, parent.signal);
  parent.abort(new Error('ABORTED: test'));
  await assert.rejects(() => aborted, /ABORTED/);

  const sequential = new EnhancedSubtitleTranslator();
  let active = 0;
  let maxActive = 0;
  sequential.translateAuto = async (text) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return `translated ${text}`;
  };
  await sequential.translateBatch(['one', 'two', 'three'], 'local', 'en');
  assert.strictEqual(maxActive, 1, 'local translations must not queue parallel work behind the model mutex');

  const timeout = new EnhancedSubtitleTranslator();
  timeout.translateAuto = async () => {
    throw new Error('LOCAL_TIMEOUT: test');
  };
  await assert.rejects(() => timeout.translateBatch(['one', 'two'], 'local', 'en'), /LOCAL_TIMEOUT/);

  const passthrough = new EnhancedSubtitleTranslator();
  let calls = 0;
  passthrough.translateAuto = async () => {
    calls++;
    throw new Error('LOCAL_UNTRANSLATED: test');
  };
  await assert.rejects(
    () => passthrough.translateBatch(['one', 'two', 'three', 'four', 'five', 'six'], 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );
  assert.strictEqual(calls, 5, 'repeated local echoes should fail before processing the whole file');

  const makeSrt = (texts) =>
    texts
      .map(
        (text, i) =>
          `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i + 1).padStart(2, '0')},000\n${text}`
      )
      .join('\n\n');

  const exactEcho = new EnhancedSubtitleTranslator();
  exactEcho.translateBatch = async (texts) => texts;
  await assert.rejects(
    () => exactEcho.translateSRTContent(makeSrt(Array(4).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const normalizedGuard = new EnhancedSubtitleTranslator();
  normalizedGuard.translateBatch = async (texts) => texts.map((text) => `${text}!!!`);
  await assert.rejects(
    () => normalizedGuard.translateSRTContent(makeSrt(Array(4).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const mostlyUntranslated = new EnhancedSubtitleTranslator();
  mostlyUntranslated.translateBatch = async (texts) =>
    texts.map((text, index) => (index === 4 ? 'Translated line' : text));
  await assert.rejects(
    () => mostlyUntranslated.translateSRTContent(makeSrt(Array(5).fill('Hola mundo')), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const labeledEcho = new EnhancedSubtitleTranslator();
  labeledEcho.translateBatch = async (texts) => texts.map((text) => `Original: ${text}`);
  await assert.rejects(
    () => labeledEcho.translateSRTContent(makeSrt(['Hola mundo']), 'local', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );

  const validWithName = new EnhancedSubtitleTranslator();
  validWithName.translateBatch = async () => ['Christopher', 'Hello', 'Good morning', 'Thank you', 'Goodbye'];
  const validOutput = await validWithName.translateSRTContent(
    makeSrt(['Christopher', 'Hola', 'Buenos días', 'Gracias', 'Adiós']),
    'local',
    'en'
  );
  assert.ok(validOutput.includes('Christopher') && validOutput.includes('Goodbye'));

  const onlineProperName = new EnhancedSubtitleTranslator();
  onlineProperName.translateBatch = async (texts) => texts;
  const onlineProperNameOutput = await onlineProperName.translateSRTContent(makeSrt(['Christopher']), 'chatgpt', 'en');
  assert.ok(onlineProperNameOutput.includes('Christopher'));

  const onlinePassthrough = new EnhancedSubtitleTranslator();
  onlinePassthrough.translateBatch = async (texts) => texts;
  await assert.rejects(
    () => onlinePassthrough.translateSRTContent(makeSrt(Array(5).fill('Hola mundo')), 'chatgpt', 'en'),
    /TRANSLATION_PASSTHROUGH/
  );
}

async function runMyMemoryErrorPhrase() {
  // 이슈 #42: MyMemory는 실패해도 HTTP 200 + 에러 문구를 translatedText로 돌려준다.
  // 이 문구가 번역 결과로 반환되어 자막 파일에 기록되지 않아야 한다.
  const MyMemoryTranslator = require('../myMemoryTranslator');
  const axios = require('axios');
  const originalGet = axios.get;
  const mem = new MyMemoryTranslator();
  mem.maxRetries = 2; // 테스트 시간 단축
  axios.get = async () => ({
    data: {
      responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES' },
      responseStatus: 200,
    },
  });
  try {
    await assert.rejects(
      () => mem.translate('こんにちは', 'ja', 'en'),
      /error message instead of a translation|quota exceeded/
    );
    console.log('[MyMemory] error phrase not returned as translation (ok)');
  } finally {
    axios.get = originalGet;
  }
}

async function runRetryOn429Case() {
  // 이슈 #43: deepl-node는 'Too many requests'(소문자 m)를 던진다.
  // 대소문자와 무관하게 429로 인식해 재시도하지 않아야 한다.
  const translator = new EnhancedSubtitleTranslator();
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error('Too many requests, DeepL servers are currently experiencing high load');
  };
  await assert.rejects(() => translator.translateWithRetry(fn, 'x', 5), /Too many requests/);
  assert.strictEqual(calls, 1, 'lowercase "Too many requests" must be treated as permanent (no retry)');
  console.log('[Retry] lowercase 429 message not retried (ok)');
}

async function runThrottleSerialization() {
  // P2-7: throttleRequest가 Promise 체인으로 직렬화되어 동시 진입 호출이
  // 최소 간격을 서로 지킨다. 10개를 동시에 던져도 각 요청 시각 간격이
  // minRequestInterval 미만으로 붙지 않아야 한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.minRequestInterval = 30;
  const times = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const start = Date.now();
      await translator.throttleRequest();
      return Date.now() - start; // 소요시간이 아니라 완료 시점 간격으로 검증
    })
  );
  // 10개가 순차로 완료되므로 완료 시각이 서로 다르다 (최소 간격 미만으로 몰리지 않음).
  const sorted = [...times].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i] - sorted[i - 1] >= 0 && sorted[i] !== sorted[i - 1],
      `throttle calls must serialize, got ${sorted[i - 1]}->${sorted[i]}`
    );
  }
  console.log('[Throttle] 10 concurrent calls serialized with interval (ok)');
}

function runCacheKeyConsistency() {
  // P2-10: 캐시 키에 sourceLang/contextAware 플래그가 반영되어 서로 다른
  // 소스 언어·컨텍스트 요청끼리 결과가 교차하지 않는다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.enableCache = true;
  const base = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko');
  const withSrc = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', 'en');
  const withCtx = translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', null, true);
  assert.notStrictEqual(base, withSrc, 'sourceLang must be part of cache key');
  assert.notStrictEqual(base, withCtx, 'contextAware flag must be part of cache key');
  // 동일 입력·동일 소스는 같은 키 (캐시 적중 유지)
  assert.strictEqual(
    translator.getCacheKey('hello', 'chatgpt:gpt-5.6-sol', 'ko', 'en'),
    withSrc,
    'same sourceLang must produce same key'
  );
  console.log('[CacheKey] sourceLang/contextAware flags isolated (ok)');
}

async function runSerial429Propagation() {
  // P1-2: 직렬 translateBatch도 429를 삼키지 않고 API_QUOTA_EXCEEDED로 전파한다.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.batchTranslation = false; // 직렬 경로 강제
  translator.translateAuto = async () => {
    throw new Error('Too many requests');
  };
  await assert.rejects(
    () => translator.translateBatch(['a', 'b', 'c'], 'mymemory', 'ko', null),
    /API_QUOTA_EXCEEDED/,
    'serial path must propagate 429'
  );
  console.log('[Serial429] serial batch propagates API_QUOTA_EXCEEDED (ok)');
}

async function runSerialRetry429Propagation() {
  // F3-1: 직렬 retry 루프 안에서 폴백 서비스가 429를 던지면 재시도를 포기하고
  // API_QUOTA_EXCEEDED로 전파해야 한다 (원문 유지로 삼키지 않는다).
  // 첫 시도는 할당량과 무관한 오류로 실패 → retry 1회차(폴백)에서 429 발생.
  const translator = new EnhancedSubtitleTranslator();
  translator.apiKeys.batchTranslation = false; // 직렬 경로 강제
  let calls = 0;
  translator.translateAuto = async (text, method) => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET network blip'); // 일시 장애
    throw new Error('Too many requests'); // retry(폴백)에서 429
  };
  await assert.rejects(
    () => translator.translateBatch(['a', 'b', 'c'], 'mymemory', 'ko', null),
    /API_QUOTA_EXCEEDED/,
    'serial retry loop must propagate 429'
  );
  console.log('[SerialRetry429] serial retry loop propagates API_QUOTA_EXCEEDED (ok)');
}

async function runSrtFileNoOutputOn429() {
  // F3-2: translateSRTFile이 429로 실패하면 출력 SRT 파일을 생성하면 안 된다.
  const translator = new EnhancedSubtitleTranslator();
  translator.translateSRTContent = async () => {
    throw new Error('API_QUOTA_EXCEEDED: Too many requests');
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-srt429-'));
  const inputPath = path.join(tmpDir, 'in.srt');
  const outputPath = path.join(tmpDir, 'out_ko.srt');
  fs.writeFileSync(inputPath, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  try {
    await assert.rejects(
      () => translator.translateSRTFile(inputPath, outputPath, 'mymemory', 'ko', null, 'en'),
      /API_QUOTA_EXCEEDED/,
      'translateSRTFile must rethrow 429'
    );
    assert.strictEqual(fs.existsSync(outputPath), false, 'no output file on quota failure');
    console.log('[SrtNoOutput] 429 leaves no partial output file (ok)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function run() {
  const translator = new EnhancedSubtitleTranslator();

  // deepl-node 1.27: en/pt는 지역 코드가 아니면 deprecated로 throw(이슈 #41)
  assert.strictEqual(translator.mapToDeepLLang('en'), 'EN-US');
  assert.strictEqual(translator.mapToDeepLLang('pt'), 'PT-BR');
  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('ja'), 'JA');
  assert.strictEqual(translator.mapToDeepLLang('zh'), 'ZH');
  assert.strictEqual(translator.mapToDeepLLang('es'), 'ES');
  assert.strictEqual(translator.mapToDeepLLang('fr'), 'FR');
  assert.strictEqual(translator.mapToDeepLLang('de'), 'DE');
  assert.strictEqual(translator.mapToDeepLLang('it'), 'IT');
  assert.strictEqual(translator.mapToDeepLLang('ru'), 'RU');
  assert.strictEqual(translator.mapToDeepLLang('hu'), 'HU');
  assert.strictEqual(translator.mapToDeepLLang('ar'), 'AR');
  assert.strictEqual(translator.mapToDeepLLang('pl'), 'PL');
  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('tr'), 'TR');
  assert.strictEqual(translator.mapToHumanLang('tr'), 'Turkish (Türkçe)');
  assert.strictEqual(translator.mapToHumanLang('fa'), 'Persian (فارسی)');
  // 순수 장식(기호/공백)만 있는 경우만 skip
  assert.strictEqual(translator.isNonDialogue('♪'), true);
  assert.strictEqual(translator.isNonDialogue('(...)'), true);
  assert.strictEqual(translator.isNonDialogue('---'), true);
  // SDH 명사는 번역 대상 (일본어/한국어/영어 괄호 내 텍스트)
  assert.strictEqual(translator.isNonDialogue('(ラジオの音楽)'), false);
  assert.strictEqual(translator.isNonDialogue('[music]'), false);
  assert.strictEqual(translator.isNonDialogue('Hello world'), false);
  assert.strictEqual(typeof translator.getOpenAIModel(), 'string');
  assert.ok(translator.getOpenAIModel().length > 0);

  const parsed = translator.parseContextAwareJson('```json\n{"translations":["안녕"],"summary":"greeting"}\n```');
  assert.deepStrictEqual(parsed.translations, ['안녕']);
  assert.throws(() => translator.parseContextAwareJson('not json'), /Invalid context-aware translation response/);

  runSrtCleanup();
  runSrtFromWhisperJson();
  runWhisperRuntimeProbe();
  await runModelDownloadAbort();
  await runLocalTranslationGuards();
  await runMyMemoryErrorPhrase();
  await runRetryOn429Case();
  await runThrottleSerialization();
  runCacheKeyConsistency();
  await runSerial429Propagation();
  await runSerialRetry429Propagation();
  await runSrtFileNoOutputOn429();

  console.log('Smoke tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
