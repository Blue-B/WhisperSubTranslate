'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
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
    '1', '00:00:01,000 --> 00:00:03,000', '[music playing]', '',
    '2', '00:00:04,000 --> 00:00:06,000', "(sighs) I can't believe it", '',
    '3', '00:00:07,000 --> 00:00:08,000', '(applause)', '',
    '4', '00:00:09,000 --> 00:00:10,000', 'Real dialogue', '',
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

function run() {
  const translator = new EnhancedSubtitleTranslator();

  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('hu'), 'HU');
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
  assert.throws(
    () => translator.parseContextAwareJson('not json'),
    /Invalid context-aware translation response/
  );

  runSrtCleanup();
  runSrtFromWhisperJson();
  runWhisperRuntimeProbe();

  console.log('Smoke tests passed.');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
