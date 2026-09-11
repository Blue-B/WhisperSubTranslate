// ============================================================
// History · Models (Sidebar Views)
// ============================================================
const HISTORY_KEY = 'wst_history_v1';
const HISTORY_LEGACY_KEY = 'wst_history';
const HISTORY_ENABLED_KEY = 'wst_history_enabled';
const HISTORY_MAX = 200;

// 설정 — 히스토리 기록 ON/OFF (기본 ON)
function isHistoryEnabled() {
  try {
    const v = localStorage.getItem(HISTORY_ENABLED_KEY);
    return v === null ? true : v === '1' || v === 'true';
  } catch (_e) {
    return true;
  }
}
function setHistoryEnabled(on) {
  try {
    localStorage.setItem(HISTORY_ENABLED_KEY, on ? '1' : '0');
  } catch (_e) {}
}
window.isHistoryEnabled = isHistoryEnabled;
window.setHistoryEnabled = setHistoryEnabled;

// Local HTML escape (escAttr is scoped inside an IIFE elsewhere)
function _esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 파일 기반 저장소 (userData/history.json) — localStorage 는 file:// origin 차이로 날아갈 수 있으므로
// IPC 로 메인 프로세스에서 파일 읽고/쓰기. 조회는 동기 인터페이스이므로 캠시한다.
let _historyCache = null;
let _historyLoadedOnce = false;

async function ensureHistoryLoaded() {
  if (_historyLoadedOnce) return _historyCache || [];
  _historyLoadedOnce = true;
  let list = [];
  try {
    const res = await window.electronAPI?.historyLoad?.();
    if (res && res.success && Array.isArray(res.list)) list = res.list;
  } catch (_e) {}
  // 이전 빌드의 localStorage 데이터 일회성 마이그레이션
  if (list.length === 0) {
    try {
      const raw = localStorage.getItem(HISTORY_KEY) || localStorage.getItem(HISTORY_LEGACY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          list = arr;
          try {
            await window.electronAPI?.historySave?.(list);
          } catch (_e) {}
          try {
            localStorage.removeItem(HISTORY_KEY);
            localStorage.removeItem(HISTORY_LEGACY_KEY);
          } catch (_e) {}
        }
      }
    } catch (_e) {}
  }
  _historyCache = list;
  return _historyCache;
}
window.ensureHistoryLoaded = ensureHistoryLoaded;

function loadHistory() {
  if (!_historyLoadedOnce) {
    // 최초 조회 시엔 비동기로 로드하고 완료 되면 한번 더 렌더링
    ensureHistoryLoaded().then(() => {
      try {
        if (typeof renderHistory === 'function') renderHistory();
      } catch (_e) {}
    });
    return [];
  }
  return _historyCache || [];
}

async function saveHistoryList(list) {
  const safe = Array.isArray(list) ? list.slice(0, HISTORY_MAX) : [];
  _historyCache = safe;
  _historyLoadedOnce = true;
  try {
    if (window.electronAPI?.historySave) {
      const res = await window.electronAPI.historySave(safe);
      if (res && res.success === false) {
        console.warn('[History] save rejected by main process:', res.error || 'unknown');
      }
    }
  } catch (e) {
    // IPC 실패(예: 앱 종료 직전)는 치명적이지 않다. 메모리 캐시는 유지된다.
    console.warn('[History] save failed:', e?.message || e);
  }
}

// 히스토리 항목 개별 삭제 (ts 기준). 기록 항목만 지우고 원본 파일은 건드리지 않는다.
function deleteHistoryItem(ts) {
  if (ts == null) return;
  const key = String(ts);
  const list = (_historyCache || []).filter((x) => String(x.ts) !== key);
  saveHistoryList(list);
  const q = document.getElementById('historySearch')?.value || '';
  renderHistory(q);
}
window.deleteHistoryItem = deleteHistoryItem;

function saveFileToHistory(file, errorMsg) {
  if (!file || !file.path) return;
  if (file._historySaved) return;
  if (!isHistoryEnabled()) return; // 설정에서 OFF 면 기록 건너뜀
  file._historySaved = true;
  try {
    const list = loadHistory();
    const fileName = file.path.split(/[\\/]/).pop();
    const entry = {
      name: fileName,
      // path = 열기/재생 대상 경로.
      //   - 영상 처리 완료: 원본 영상을 열면 자막이 자동 로드됨
      //   - SRT 단독 번역 완료: 따로 저장한 번역 결과(_ko.srt)를 열어야 함
      path: file.outputPath || file.path,
      sourcePath: file.path, // 원본 경로 (부가 정보)
      status: file.status === 'completed' ? 'success' : 'failed',
      ts: Date.now(),
      error: errorMsg || undefined,
    };
    list.unshift(entry);
    saveHistoryList(list);
  } catch (e) {
    console.warn('[History] save failed:', e?.message);
  }
}
window.saveFileToHistory = saveFileToHistory;

function timeAgo(ts) {
  const lang = typeof currentUiLang !== 'undefined' ? currentUiLang : 'ko';
  const diff = Math.floor((Date.now() - ts) / 1000);
  const units = {
    ko: { just: '방금', m: '분 전', h: '시간 전', d: '일 전', w: '주 전' },
    en: { just: 'just now', m: 'm ago', h: 'h ago', d: 'd ago', w: 'w ago' },
    ja: { just: 'たった今', m: '分前', h: '時間前', d: '日前', w: '週前' },
    zh: { just: '刚才', m: '分钟前', h: '小时前', d: '天前', w: '周前' },
    pl: { just: 'teraz', m: 'm temu', h: 'h temu', d: 'd temu', w: 't temu' },
  };
  const u = units[lang] || units.en;
  if (diff < 60) return u.just;
  if (diff < 3600) return Math.floor(diff / 60) + (lang === 'en' ? u.m : ' ' + u.m);
  if (diff < 86400) return Math.floor(diff / 3600) + (lang === 'en' ? u.h : ' ' + u.h);
  if (diff < 604800) return Math.floor(diff / 86400) + (lang === 'en' ? u.d : ' ' + u.d);
  return Math.floor(diff / 604800) + (lang === 'en' ? u.w : ' ' + u.w);
}

function renderHistory(filter) {
  const list = loadHistory();
  const listEl = document.getElementById('historyList');
  if (!listEl) return;

  // Stats
  const setNum = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  setNum('statTotalFiles', list.length);
  setNum('statSuccess', list.filter((x) => x.status === 'success').length);
  setNum('statFailed', list.filter((x) => x.status === 'failed').length);
  const weekAgo = Date.now() - 7 * 86400000;
  setNum('statThisWeek', list.filter((x) => x.ts >= weekAgo).length);

  const q = (filter || '').trim().toLowerCase();
  const filtered = q
    ? list.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.path || '').toLowerCase().includes(q))
    : list;

  const d = I18N[currentUiLang] || I18N.ko;
  if (!filtered.length) {
    setSafeHtml(
      listEl,
      `<div class="history-empty">
        <div class="history-empty-pixel">
          <img src="../../assets/px-empty-history.png?v=3" alt="" aria-hidden="true"/>
        </div>
        <p class="history-empty-title">${q ? d.histNoResult || 'No results' : d.histEmptyTitle || 'No history yet'}</p>
        <p class="history-empty-hint">${q ? d.histNoResultHint || 'Try another search' : d.histEmptyHint || 'Process a file to see it here'}</p>
      </div>`
    );
    return;
  }

  setSafeHtml(
    listEl,
    filtered
      .map(
        (it) => `
    <div class="history-item">
      <span class="history-item-status ${it.status === 'success' ? 'success' : 'failed'}" title="${it.status}"></span>
      <span class="history-item-name" title="${_esc(it.path || it.name)}">${_esc(it.name || '')}</span>
      <span class="history-item-meta">${timeAgo(it.ts)}</span>
      <span class="history-item-actions">
        <button class="history-item-btn" data-hist-open="${_esc(it.path || '')}">${d.histOpen || 'Open'}</button>
        <button class="history-item-btn" data-hist-folder="${_esc(it.path || '')}">${d.histFolder || 'Folder'}</button>
        <button class="history-item-btn history-item-btn-del" data-hist-del="${_esc(String(it.ts))}" title="${d.histDelete || 'Delete'}">${d.histDelete || 'Delete'}</button>
      </span>
    </div>
  `
      )
      .join('')
  );

  // Bind action buttons:
  //  - data-hist-open  → 파일 자체 실행 (영상=플레이어, .srt=에디터)
  //  - data-hist-folder → 파일 있는 폴더를 열고 파일 선택 상태로 표시
  const openFolderFn = window.electronAPI?.openFileLocation; // showItemInFolder
  const openFileFn = window.electronAPI?.openFolder; // shell.openPath — 파일 경로도 이걸로 열림
  listEl.querySelectorAll('[data-hist-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.getAttribute('data-hist-open');
      if (p && openFileFn) {
        try {
          await openFileFn(p);
        } catch (_e) {}
      }
    });
  });
  listEl.querySelectorAll('[data-hist-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.getAttribute('data-hist-folder');
      if (p && openFolderFn) {
        try {
          await openFolderFn(p);
        } catch (_e) {}
      }
    });
  });
  //  - data-hist-del → 해당 기록 항목만 삭제 (실제 파일은 건드리지 않음)
  listEl.querySelectorAll('[data-hist-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteHistoryItem(btn.getAttribute('data-hist-del')));
  });
}
window.renderHistory = renderHistory;
