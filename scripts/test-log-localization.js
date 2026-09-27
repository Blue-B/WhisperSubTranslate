'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function runLogLocalizationTests() {
  // Execute the complete renderer script, not a copy of its implementation.
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/features/logs.js'), 'utf8');
  const context = vm.createContext({ currentUiLang: 'ko' });
  vm.runInContext(source, context);
  const subtitle = '[00:00:01.000 --> 00:00:03.000]   Starting translation... 오류가 발생했습니다';
  const reasons = '(Translation failed: CUDA error; /videos/번역 시작.mkv)';
  const notices = [
    '로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다',
    '로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다',
    '로컬 번역: 실행 정보',
    '로컬 번역: 처리 완료',
    '로컬 번역: 동시 처리를 사용할 수 없어 개별 처리로 전환합니다',
    '로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다',
    '로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다',
  ];
  const translatedNotices = {
    ko: notices,
    en: [
      'Local translation: using CPU because the GPU is unavailable',
      'Local translation: using CPU because of insufficient GPU memory',
      'Local translation: runtime',
      'Local translation: completed',
      'Local translation: parallel processing unavailable; switching to one at a time',
      'Local translation: insufficient memory; retrying one at a time on the same GPU',
      'Local translation: parallel setup failed; retrying one at a time on the same GPU',
    ],
    ja: [
      'ローカル翻訳: GPUを使用できないためCPUで続行します',
      'ローカル翻訳: GPUメモリが不足しているためCPUで続行します',
      'ローカル翻訳: 実行情報',
      'ローカル翻訳: 処理完了',
      'ローカル翻訳: 同時処理を利用できないため個別処理に切り替えます',
      'ローカル翻訳: メモリ不足のため、同じGPUで1件ずつ再試行します',
      'ローカル翻訳: 並列処理の準備に失敗したため、同じGPUで1件ずつ再試行します',
    ],
    zh: [
      '本地翻译：GPU 不可用，改用 CPU 继续',
      '本地翻译：GPU 内存不足，改用 CPU 继续',
      '本地翻译：运行信息',
      '本地翻译：处理完成',
      '本地翻译：无法并行处理，切换为逐条处理',
      '本地翻译：内存不足，将在同一 GPU 上逐条重试',
      '本地翻译：并行处理准备失败，将在同一 GPU 上逐条重试',
    ],
    pl: [
      'Tłumaczenie lokalne: używam CPU, ponieważ GPU jest niedostępne',
      'Tłumaczenie lokalne: używam CPU z powodu braku pamięci GPU',
      'Tłumaczenie lokalne: informacje o wykonaniu',
      'Tłumaczenie lokalne: ukończono',
      'Tłumaczenie lokalne: przetwarzanie równoległe niedostępne; przełączam na tryb pojedynczy',
      'Tłumaczenie lokalne: za mało pamięci; ponawiam pojedynczo na tym samym GPU',
      'Tłumaczenie lokalne: przygotowanie pracy równoległej nie powiodło się; ponawiam pojedynczo na tym samym GPU',
    ],
  };
  for (const lang of Object.keys(translatedNotices)) {
    context.currentUiLang = lang;
    const localize = (text) => context.localizeLog(text);
    assert.strictEqual(localize(subtitle), subtitle, lang);
    assert.strictEqual(localize(null), null);
    for (const filename of [
      '번역 시작.mkv',
      '오류.srt',
      'Starting translation....mkv',
      'Translation failed: sample.srt',
    ]) {
      const log = `Completed: /videos/${filename}`;
      assert.strictEqual(localize(log), log, `${lang}: preserve filenames`);
    }
    for (const newline of ['\n', '\r\n', '\r']) {
      for (let i = 0; i < notices.length; i++) {
        const input = `${notices[i]} ${reasons}${newline}${subtitle}${newline}${notices[i]} ${reasons}${newline}`;
        const expectedNotice = `${translatedNotices[lang][i]} ${reasons}`;
        const expected = `${expectedNotice}${newline}${subtitle}${newline}${expectedNotice}${newline}`;
        assert.strictEqual(localize(input), expected, `${lang}: mixed chunks and raw error reason`);
        assert.strictEqual(localize(expected), expected, `${lang}: double-localization must be harmless`);
      }
    }
  }
  const output = {
    children: [],
    appendChild(node) {
      node.isConnected = true;
      this.children.push(node);
    },
  };
  context.document = { createElement: () => ({}) };
  context.I18N = {};
  for (const [lang, localized] of Object.entries(translatedNotices)) {
    context.currentUiLang = lang;
    for (const notice of localized) {
      output.children = [];
      vm.runInContext('_lastLog = { cat: null, count: 0, groupEl: null }', context);
      for (let i = 0; i < 3; i++) context._appendLogLine(output, notice);
      assert.strictEqual(
        output.children.filter((node) => node.textContent.includes(notice)).length,
        3,
        `${lang}: keep local runtime/fallback/completion notices visible`
      );
    }
  }
  output.children = [];
  vm.runInContext('_lastLog = { cat: null, count: 0, groupEl: null }', context);
  for (let i = 0; i < 4; i++) context._appendLogLine(output, 'Ordinary diagnostic line');
  assert.strictEqual(output.children.length, 3, 'ordinary repeated categories still collapse');
  assert.ok(output.children.at(-1).className.includes('log-group'));
  const engineMessages = [
    [
      'Standalone Faster-Whisper-XXL r245.4 running on: CUDA',
      'Standalone Faster-Whisper-XXL 実行環境: CUDA',
      'Standalone Faster-Whisper-XXL 运行于: CUDA',
    ],
    [
      'Starting to process: /videos/Starting translation....mkv',
      '処理開始: /videos/Starting translation....mkv',
      '开始处理: /videos/Starting translation....mkv',
    ],
    ['Starting translation...', '翻訳を開始します...', '开始翻译...'],
    ['Translating... 2/3', '翻訳中... 2/3', '翻译中... 2/3'],
    ['Translation completed. Finalizing...', '翻訳が完了しました。最終処理中...', '翻译完成。正在收尾...'],
    [
      'Translation failed: Starting translation...',
      '翻訳に失敗しました: Starting translation...',
      '翻译失败: Starting translation...',
    ],
  ];
  for (const [index, lang] of ['ja', 'zh'].entries()) {
    context.currentUiLang = lang;
    for (const row of engineMessages) {
      assert.strictEqual(context.localizeLog(`${row[0]}\n${subtitle}`), `${row[index + 1]}\n${subtitle}`);
    }
  }
  console.log(
    '[LogLocalization] actual function: mixed chunks, subtitles, filenames, raw reasons and five locales (ok)'
  );
}

if (require.main === module) runLogLocalizationTests();
module.exports = runLogLocalizationTests;
