// 번역 상태 문자열은 locales의 <strong>/<br>만 허용해 DOM으로 만든다.
function setStatusMarkup(element, markup) {
  const fragment = document.createDocumentFragment();
  let parent = fragment;
  String(markup || '')
    .split(/(<strong(?:\s[^>]*)?>|<\/strong>|<br\s*\/?>)/gi)
    .filter(Boolean)
    .forEach((part) => {
      if (/^<strong/i.test(part)) {
        const strong = document.createElement('strong');
        if (/color\s*:\s*#e74c3c/i.test(part)) strong.style.color = '#e74c3c';
        fragment.appendChild(strong);
        parent = strong;
      } else if (/^<\/strong/i.test(part)) {
        parent = fragment;
      } else if (/^<br/i.test(part)) {
        fragment.appendChild(document.createElement('br'));
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    });
  element.replaceChildren(fragment);
}

function setSafeHtml(element, markup) {
  const doc = new DOMParser().parseFromString(String(markup || ''), 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,link,meta,style,base').forEach((node) => node.remove());
  doc.body.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith('on') ||
        name === 'srcdoc' ||
        (['href', 'src', 'xlink:href', 'formaction'].includes(name) && /^\s*(?:javascript|vbscript):/i.test(attr.value))
      ) {
        node.removeAttribute(attr.name);
      }
    });
  });
  element.replaceChildren(...Array.from(doc.body.childNodes, (node) => document.importNode(node, true)));
}

// Toast notification (토스트 알림)
function showToast(message, options = {}) {
  // 기존 토스트 제거
  const existingToast = document.querySelector('.toast-notification');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #333;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    animation: slideIn 0.3s ease;
  `;

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (options.label && options.onClick) {
    const btn = document.createElement('button');
    btn.textContent = options.label;
    btn.style.cssText = `
      background: #4CAF50;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    btn.onclick = () => {
      options.onClick();
      toast.remove();
    };
    toast.appendChild(btn);
  }

  document.body.appendChild(toast);

  // 5초 후 자동 제거
  setTimeout(() => toast.remove(), 5000);
}

// Utility: sleep function for delays (지연용 sleep 함수)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Supported video extensions (지원되는 비디오 파일 확장자)
// ---------------------------------------------------------------------------
// Log output: timestamp + icon + category color + consecutive group collapse.
// Classifies each line by message text and renders <div class="log-line">.
// ---------------------------------------------------------------------------
// Order matters: 'stop' must be checked before 'process' (“처리 중지”
// contains the word “처리” which would otherwise match the process rule).
const _LOG_CATS = [
  { id: 'stop', icon: '■', re: /(중지|stopp|stopped by user|停止|中止|中断|zatrzym)/i },
  { id: 'error', icon: '✗', re: /(실패|fail|error|エラー|失败|错误|błąd|nieuda)/i },
  { id: 'skip', icon: '»', re: /(스킵|skip|スキップ|跳过|忽略|pomiń)/i },
  { id: 'success', icon: '✓', re: /(완료|complete|finished|完了|完成|zakończon|^Smoke tests passed)/i },
  {
    id: 'remove',
    icon: '−',
    re: /(대기열에서 제거됨|removed from queue|キューから削除|已从队列中移除|已从队列中删除|Usunięto z kolejki)/i,
  },
  { id: 'translate', icon: '⇄', re: /(번역|translat|翻訳|翻译|tłumacz)/i },
  { id: 'process', icon: '▶', re: /(처리 중|processing|処理中|处理中|przetwarz)/i },
  { id: 'add', icon: '+', re: /(추가됨|added|追加|已添加|已添加到|dodan|already in queue|이미 대기열)/i },
  { id: 'info', icon: '·', re: /.*/ },
];
// whisper 전사 출력 줄 감지: " [00:00:15.320 --> 00:00:19.460]   text" 형태.
const _TRANSCRIPT_LINE_RE = /\[\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->/;
function _classifyLog(line) {
  // 전사 줄은 상태 메시지가 아니라 자막 "내용"이다. 내용에 error/errors/fail 같은
  // 단어가 들어있어도(예: TypeScript errors 강의) 에러 줄로 오분류하면 안 되므로
  // 키워드 매칭을 건너뛰고 info(·)로 처리한다.
  if (_TRANSCRIPT_LINE_RE.test(line)) return _LOG_CATS[_LOG_CATS.length - 1];
  for (const c of _LOG_CATS) if (c.re.test(line)) return c;
  return _LOG_CATS[_LOG_CATS.length - 1];
}
function _ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
let _lastLog = { cat: null, count: 0, groupEl: null };
const _LOG_GROUP_THRESHOLD = 3; // 3개 이상 연속이면 "... 외 N개"

function _appendLogLine(output, line) {
  const cat = _classifyLog(line);
  // Keep local runtime, fallback and completion notices visible rather than folding them into translation logs.
  const sameAsPrev =
    !/^(?:로컬 번역:|Local translation:|ローカル翻訳:|本地翻译：|Tłumaczenie lokalne:)/.test(line) &&
    _lastLog.cat &&
    _lastLog.cat.id === cat.id;

  if (sameAsPrev) {
    _lastLog.count += 1;
    if (_lastLog.count >= _LOG_GROUP_THRESHOLD) {
      // Collapse: keep the first 2 개의 visible 줄 + 1개의 summary 줄.
      // clearOutput()/prune 등으로 groupEl이 DOM에서 제거된 뒤에도 재사용하면
      // 줄이 화면에 붙지 않으므로 연결 상태를 확인하고 재생성한다.
      if (!_lastLog.groupEl || !_lastLog.groupEl.isConnected) {
        const el = document.createElement('div');
        el.className = `log-line log-${cat.id} log-group`;
        output.appendChild(el);
        _lastLog.groupEl = el;
      }
      const extras = _lastLog.count - 2;
      const foldFn = I18N[currentUiLang]?.logGroupMoreItems;
      _lastLog.groupEl.textContent = `${_ts()}  ${cat.icon}  (... ${foldFn ? foldFn(extras) : `외 ${extras}개 항목`})`;
      return;
    }
  } else {
    _lastLog = { cat, count: 1, groupEl: null };
  }

  const el = document.createElement('div');
  el.className = `log-line log-${cat.id}`;
  el.textContent = `${_ts()}  ${cat.icon}  ${line}`;
  el.title = line;
  output.appendChild(el);
}

function addOutput(text) {
  const output = document.getElementById('output');
  if (!output) return;
  // Split incoming text into lines; ignore empty lines (the old code dumped lots of \n).
  const lines = String(text)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of lines) _appendLogLine(output, line);
  // Prune to last 500 lines to keep DOM light during long batches.
  while (output.childNodes.length > 500) output.removeChild(output.firstChild);
  output.scrollTop = output.scrollHeight;
}

// eslint-disable-next-line no-unused-vars -- shared classic-script API used by renderer/index.js E2E hook
function clearOutput() {
  const output = document.getElementById('output');
  if (output) output.textContent = '';
  _lastLog = { cat: null, count: 0, groupEl: null };
  _translatingLineEl = null; // 진행 줄 참조도 초기화 (이전 세션 div는 이미 제거됨)
}

// File selector (multi-select) (파일 선택 함수, 다중 선택 지원)**
// 로그 메시지 간단 현지화 매핑(패턴→치환)
const LOG_I18N = {
  en: [
    { re: /^로컬 번역: 실행 정보/, to: 'Local translation: runtime' },
    { re: /^로컬 번역: 처리 완료/, to: 'Local translation: completed' },
    {
      re: /^로컬 번역: 동시 처리를 사용할 수 없어 개별 처리로 전환합니다/,
      to: 'Local translation: parallel processing unavailable; switching to one at a time',
    },
    {
      re: /^로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'Local translation: insufficient memory; retrying one at a time on the same GPU',
    },
    {
      re: /^로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'Local translation: parallel setup failed; retrying one at a time on the same GPU',
    },
    {
      re: /^로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다/gm,
      to: 'Local translation: using CPU because the GPU is unavailable',
    },
    {
      re: /^로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다/gm,
      to: 'Local translation: using CPU because of insufficient GPU memory',
    },
  ],
  ja: [
    { re: /^로컬 번역: 실행 정보/, to: 'ローカル翻訳: 実行情報' },
    { re: /^로컬 번역: 처리 완료/, to: 'ローカル翻訳: 処理完了' },
    {
      re: /^로컬 번역: 동시 처리를 사용할 수 없어 개별 처리로 전환합니다/,
      to: 'ローカル翻訳: 同時処理を利用できないため個別処理に切り替えます',
    },
    {
      re: /^로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'ローカル翻訳: メモリ不足のため、同じGPUで1件ずつ再試行します',
    },
    {
      re: /^로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'ローカル翻訳: 並列処理の準備に失敗したため、同じGPUで1件ずつ再試行します',
    },
    {
      re: /^Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/,
      to: 'Standalone Faster-Whisper-XXL 実行環境: $1',
    },
    { re: /^Starting to process:\s*/, to: '処理開始: ' },
    { re: /^Starting translation\.\.\.$/, to: '翻訳を開始します...' },
    { re: /^Translating\.\.\. (\d+)\/(\d+)$/, to: '翻訳中... $1/$2' },
    { re: /^Translation completed\. Finalizing\.\.\.$/, to: '翻訳が完了しました。最終処理中...' },
    { re: /^Translation failed: /, to: '翻訳に失敗しました: ' },
    {
      re: /^로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다/gm,
      to: 'ローカル翻訳: GPUを使用できないためCPUで続行します',
    },
    {
      re: /^로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다/gm,
      to: 'ローカル翻訳: GPUメモリが不足しているためCPUで続行します',
    },
  ],
  pl: [
    { re: /^로컬 번역: 실행 정보/, to: 'Tłumaczenie lokalne: informacje o wykonaniu' },
    { re: /^로컬 번역: 처리 완료/, to: 'Tłumaczenie lokalne: ukończono' },
    {
      re: /^로컬 번역: 동시 처리를 사용할 수 없어 개별 처리로 전환합니다/,
      to: 'Tłumaczenie lokalne: przetwarzanie równoległe niedostępne; przełączam na tryb pojedynczy',
    },
    {
      re: /^로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'Tłumaczenie lokalne: za mało pamięci; ponawiam pojedynczo na tym samym GPU',
    },
    {
      re: /^로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: 'Tłumaczenie lokalne: przygotowanie pracy równoległej nie powiodło się; ponawiam pojedynczo na tym samym GPU',
    },
    {
      re: /^로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다/gm,
      to: 'Tłumaczenie lokalne: używam CPU, ponieważ GPU jest niedostępne',
    },
    {
      re: /^로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다/gm,
      to: 'Tłumaczenie lokalne: używam CPU z powodu braku pamięci GPU',
    },
  ],
  zh: [
    { re: /^로컬 번역: 실행 정보/, to: '本地翻译：运行信息' },
    { re: /^로컬 번역: 처리 완료/, to: '本地翻译：处理完成' },
    {
      re: /^로컬 번역: 동시 처리를 사용할 수 없어 개별 처리로 전환합니다/,
      to: '本地翻译：无法并行处理，切换为逐条处理',
    },
    {
      re: /^로컬 번역: 메모리가 부족해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: '本地翻译：内存不足，将在同一 GPU 上逐条重试',
    },
    {
      re: /^로컬 번역: 병렬 실행 준비에 실패해 같은 GPU에서 하나씩 번역으로 다시 시도합니다/,
      to: '本地翻译：并行处理准备失败，将在同一 GPU 上逐条重试',
    },
    {
      re: /^Standalone Faster-Whisper-XXL\s+r[0-9\.]+\s+running on:\s*(\w+)/,
      to: 'Standalone Faster-Whisper-XXL 运行于: $1',
    },
    { re: /^Starting to process:\s*/, to: '开始处理: ' },
    { re: /^Starting translation\.\.\.$/, to: '开始翻译...' },
    { re: /^Translating\.\.\. (\d+)\/(\d+)$/, to: '翻译中... $1/$2' },
    { re: /^Translation completed\. Finalizing\.\.\.$/, to: '翻译完成。正在收尾...' },
    { re: /^Translation failed: /, to: '翻译失败: ' },
    {
      re: /^로컬 번역: GPU를 사용할 수 없어 CPU로 진행합니다/gm,
      to: '本地翻译：GPU 不可用，改用 CPU 继续',
    },
    {
      re: /^로컬 번역: GPU 메모리가 부족해 CPU로 진행합니다/gm,
      to: '本地翻译：GPU 内存不足，改用 CPU 继续',
    },
  ],
};

// === UI 텍스트 I18N ===
// I18N object moved to locales/i18n.js

// 에러 메시지 다국어 변환 헬퍼
// "all translations failed" summary message, chosen by translation method.
// Local translation has no API key, so never show the API key/quota hint here
// (that wrong hint was the source of user confusion).
// eslint-disable-next-line no-unused-vars -- shared classic-script API used by progress.js and processing.js
function getAllFailedMsg() {
  const d = I18N[currentUiLang] || I18N.ko;
  const method = document.getElementById('translationSelect')?.value;
  if (method === 'local') return d.allFailedLocal || d.allFailed || 'All translations failed';
  if (method && method !== 'none') return d.allFailedApi || d.allFailed || 'All translations failed';
  return d.allFailed || 'All tasks failed';
}

// eslint-disable-next-line no-unused-vars -- shared classic-script API used by progress.js, processing.js and models.js
function getLocalizedError(errorMessage) {
  if (!errorMessage) return I18N[currentUiLang].errorUnknown;

  const lang = I18N[currentUiLang];

  // 모델 다운로드 경로들의 공통 디스크 부족 메시지.
  const diskSpace = String(errorMessage).match(/Not enough disk space: need ([\d.]+) GB, free ([\d.]+) GB/i);
  if (diskSpace) {
    return (lang.errorDiskSpace || 'Not enough disk space. Required: {required} GB, free: {free} GB.')
      .replace('{required}', diskSpace[1])
      .replace('{free}', diskSpace[2]);
  }

  // main process에서 오는 영어 에러 메시지 → 현지화
  if (errorMessage.includes('GPU memory shortage') || errorMessage.includes('GPU 메모리 부족')) {
    return lang.errorGpuMemory;
  }
  if (errorMessage.includes('Process terminated abnormally') || errorMessage.includes('프로세스가 비정상적으로')) {
    return lang.errorProcessCrash;
  }
  if (errorMessage.includes('Whisper processing failed') || errorMessage.includes('Whisper 처리 실패')) {
    return lang.errorWhisperFailed;
  }
  // main process는 "파일이 없음"과 "있는데 실행이 막힘"을 구분해서 보낸다.
  // 복구 방법이 서로 다르므로 하나의 문구로 합치지 않는다.
  if (errorMessage.includes('whisper-cli')) {
    if (errorMessage.includes('is missing from')) {
      return lang.errorWhisperMissing;
    }
    if (errorMessage.includes('could not be launched') || errorMessage.includes('code 127')) {
      return lang.errorWhisperBlocked;
    }
  }
  if (errorMessage.includes('CPU build is available') || errorMessage.includes('CPU 빌드가 설치')) {
    return lang.errorDllCpuAvailable || lang.errorDllEntryPointNotFound;
  }
  if (errorMessage.includes('DLL entry point not found') || errorMessage.includes('0xC0000139')) {
    return lang.errorDllEntryPointNotFound;
  }
  if (errorMessage.includes('Required DLL not found') || errorMessage.includes('0xC0000135')) {
    return lang.errorDllNotFound;
  }
  if (errorMessage.includes('MyMemory daily quota exceeded')) {
    return lang.myMemoryQuotaExceeded;
  }
  if (errorMessage.includes('SRT file path missing') || errorMessage.includes('SRT 파일 경로')) {
    return lang.errorSrtPathMissing;
  }
  if (errorMessage.includes('TRANSLATION_PASSTHROUGH') || errorMessage.includes('LOCAL_TIMEOUT')) {
    return lang.errorTranslationPassthrough || lang.errorEmptyTranslation;
  }
  if (errorMessage.includes('empty translation') || errorMessage.includes('번역 결과가 비어')) {
    return lang.errorEmptyTranslation;
  }
  if (
    errorMessage.includes('API_QUOTA_EXCEEDED') ||
    /\b429\b/.test(errorMessage) ||
    errorMessage.includes('quota exceeded') ||
    errorMessage.includes('Too Many Requests')
  ) {
    return lang.errorApiQuotaExceeded;
  }

  return errorMessage;
}

function localizeLog(text) {
  if (!text || currentUiLang === 'ko') return text;
  const rules = LOG_I18N[currentUiLang];
  if (!rules) return text;
  // 청크에 섞인 상태 줄은 번역하되, 전사 내용과 원래 줄바꿈은 보존한다.
  return text
    .split(/(\r\n|\n|\r)/)
    .map((line) => {
      if (_TRANSCRIPT_LINE_RE.test(line)) return line;
      for (const { re, to } of rules) {
        // 상태 접두사 하나만 치환한다. 뒤의 파일명/오류 사유는 다시 번역하지 않는다.
        if (re.test(line)) return line.replace(re, to);
      }
      return line;
    })
    .join('');
}

// RAW 출력 함수(현지화 없이 실제 출력만 수행)
// eslint-disable-next-line no-unused-vars -- shared classic-script API used by progress.js
function appendOutputRaw(text) {
  // Route through the styled addOutput (defined earlier) so every log path
  // gets timestamp + icon + category color + group collapsing.
  addOutput(text);
}

// translating 단계 진행 줄: div 로그와 같은 방식으로 추가하고, 다음 이벤트에서 같은 div만 교체한다.
// (이전 구현은 output.textContent.split('\n')로 전체 로그를 textContent로 바꿔 기존 div 로그를 소멸시킴)
let _translatingLineEl = null;
// eslint-disable-next-line no-unused-vars -- shared classic-script API used by progress.js
function updateTranslatingLine(text) {
  const output = document.getElementById('output');
  if (!output) return;
  const clean = String(text).replace(/\n$/, '');
  if (_translatingLineEl && output.contains(_translatingLineEl)) {
    // 같은 진행 줄 갱신 (타임스탬프 유지)
    _translatingLineEl.textContent = clean;
    _translatingLineEl.title = clean;
  } else {
    // 새 진행 줄 추가
    const el = document.createElement('div');
    el.className = 'log-line log-translating';
    el.textContent = clean;
    el.title = clean;
    output.appendChild(el);
    _translatingLineEl = el;
    // DOM 가벌게 유지 (addOutput과 동일한 프루닝)
    while (output.childNodes.length > 500) output.removeChild(output.firstChild);
  }
  output.scrollTop = output.scrollHeight;
}

// addOutput도 현지화 적용: 원본 addOutput를 백업한 뒤 현지화 래퍼로 교체.
const _addOutputRaw = addOutput;
addOutput = function (text) {
  _addOutputRaw(localizeLog(text));
};
