'use strict';

const assert = require('assert');
const EnhancedSubtitleTranslator = require('../translator-enhanced');
const { applySrtCleanup, isSdhOnlyText } = require('../srt-cleanup');

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

  console.log('Smoke tests passed.');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
