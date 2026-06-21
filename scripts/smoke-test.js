'use strict';

const assert = require('assert');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
const { applySrtCleanup, isSdhOnlyText, splitLongCues } = require('../srt-cleanup');

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

function runSplitLongCues() {
  // 짧은 말이 길게 늘어진 큐(노래/끄는 발화)는 시간이 길어도 글자 단위로 토막내면 안 된다.
  // 회귀: "감사합니다"(26초)가 "감사/합니/다."로 깨지던 버그.
  const heldKo = '1\n00:00:59,620 --> 00:01:26,220\n감사합니다.\n';
  const heldOut = splitLongCues(heldKo, { maxDurationSec: 6 });
  assert.ok(heldOut.includes('감사합니다.'), '짧은 늘어진 CJK 큐는 한 덩어리로 유지돼야 함');
  assert.ok(!/\n감사\n/.test(heldOut) && !/\n합니\n/.test(heldOut), '단어 중간을 토막내면 안 됨');

  // 라틴 짧은 말도 동일 — 단어 경계로도 쪼개면 안 됨
  const heldEn = splitLongCues('1\n00:00:00,000 --> 00:00:20,000\nThank you so much.\n', { maxDurationSec: 6 });
  assert.ok(heldEn.includes('Thank you so much.'), '짧은 라틴 큐는 유지돼야 함');

  // 진짜 긴 문장(글자 충분 + 오래 머묾)은 여전히 여러 큐로 분할돼야 함
  const longKo =
    '1\n00:00:00,000 --> 00:00:14,000\n' +
    '오늘 아침에 일어나서 창밖을 보니 눈이 정말 많이 쌓여 있었고 길에는 사람들이 우산을 쓰고 천천히 걸어가고 있었다 정말 아름다운 풍경이었다\n';
  const longOut = splitLongCues(longKo, { maxDurationSec: 6 });
  const cueCount = longOut.split(/\n\s*\n/).filter((b) => b.includes('-->')).length;
  assert.ok(cueCount >= 2, '긴 문장은 분할돼야 함');
}

function run() {
  const translator = new EnhancedSubtitleTranslator();

  assert.strictEqual(translator.mapToDeepLLang('ko'), 'KO');
  assert.strictEqual(translator.mapToDeepLLang('hu'), 'HU');
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

  runSrtCleanup();
  runSplitLongCues();

  console.log('Smoke tests passed.');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
