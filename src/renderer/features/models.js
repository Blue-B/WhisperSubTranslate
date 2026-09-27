// ── Local Hy-MT2 Model UI ────────────────────────────────────────────────────
let _localDownloading = false;
let _localModelList = null; // 캐시

function getSelectedLocalModelId() {
  const sel = document.getElementById('localModelSelect');
  return sel?.value || '1.8b';
}

async function rebuildLocalModelSelect() {
  const sel = document.getElementById('localModelSelect');
  if (!sel) return;
  if (!_localModelList && window.electronAPI?.localModelList) {
    try {
      _localModelList = await window.electronAPI.localModelList();
    } catch (_e) {
      _localModelList = [];
    }
  }
  const d = I18N[currentUiLang] || I18N.ko;
  Array.from(sel.options).forEach((opt) => {
    const meta = (_localModelList || []).find((m) => m.id === opt.value);
    if (!meta) return;
    const installed = meta.installed ? ' ✓' : '';
    const sizeGb = (meta.sizeBytes / 1024 / 1024 / 1024).toFixed(1);
    if (opt.value === '1.8b') {
      opt.textContent = (d.localModel18bLabel || 'Hy-MT2 1.8B · Fast') + ` (${sizeGb} GB${installed})`;
    } else if (opt.value === '7b') {
      opt.textContent = (d.localModel7bLabel || 'Hy-MT2 7B · High quality') + ` (${sizeGb} GB${installed})`;
    }
  });
}

function renderLocalModelRequirements(modelId) {
  const el = document.getElementById('localModelRequirements');
  if (!el) return;
  const meta = (_localModelList || []).find((m) => m.id === modelId);
  if (!meta) {
    el.textContent = '';
    return;
  }
  const d = I18N[currentUiLang] || I18N.ko;
  const r = meta.requirements || {};
  const label = d.localReqLabel || 'Recommended';
  const speedKey = r.speed && r.speed.includes('빠') ? 'fast' : r.speed && r.speed.includes('느') ? 'slow' : 'normal';
  const speedMap = {
    ko: { fast: '빠름', slow: '느림 (고품질)', normal: '보통' },
    en: { fast: 'Fast', slow: 'Slow (high quality)', normal: 'Normal' },
    ja: { fast: '高速', slow: '低速（高品質）', normal: '通常' },
    zh: { fast: '快速', slow: '较慢（高品质）', normal: '普通' },
    pl: { fast: 'Szybko', slow: 'Wolno (wysoka jakość)', normal: 'Normalnie' },
  };
  const speed = (speedMap[currentUiLang] || speedMap.en)[speedKey];
  setSafeHtml(
    el,
    `<span style="font-size:10.5px;color:var(--text-muted)">${label}: VRAM ${r.vram} / RAM ${r.ram} · ${speed}</span>`
  );
}

async function updateLocalModelStatus() {
  const statusEl = document.getElementById('translationStatus');
  if (!statusEl) return;

  await rebuildLocalModelSelect();
  const modelId = getSelectedLocalModelId();
  renderLocalModelRequirements(modelId);

  // Local 모델 서브-셀렉트 표시 (translation === 'local'일 때만)
  const grp = document.getElementById('localModelGroup');
  const trSel = document.getElementById('translationSelect');
  if (grp) grp.style.display = trSel?.value === 'local' ? 'block' : 'none';

  // Translation method가 local이 아니면 상태 바를 덮어쓰지 않음 (Gemini/DeepL 등 선택 시 Hy-MT2가 잘못 리턴하는 버그 방지)
  if (trSel?.value !== 'local') return;

  const info = await window.electronAPI.localModelStatus(modelId);
  const d = I18N[currentUiLang] || I18N.ko;
  const sizeText = info.sizeMB ? ` (${(info.sizeMB / 1024).toFixed(1)} GB)` : '';

  if (info.installed) {
    setSafeHtml(
      statusEl,
      `<span style="color:var(--accent)">${d.localModelInstalledHtml || '&#10003; Hy-MT2 model installed'}${sizeText}</span>`
    );
  } else if (_localDownloading) {
    setSafeHtml(
      statusEl,
      `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${d.localModelDownloadingHtml || 'Downloading Hy-MT2 Q4...'} <span id="localDlPercent">0%</span></div>
      <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;width:100%">
        <div id="localDlBar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
      </div>`
    );
  } else {
    setSafeHtml(
      statusEl,
      `<span style="color:var(--text-muted);font-size:11px">${d.localModelMissingHtml || '⚠ Hy-MT2 model not installed — auto-downloads on start'}${sizeText}</span>`
    );
  }
}

// 자동 다운로드 진행률 리스너 (main에서 local-model-progress 이벤트 수신)
if (window.electronAPI?.onLocalModelProgress) {
  window.electronAPI.onLocalModelProgress(({ percent }) => {
    _localDownloading = percent < 100;
    // local 번역이 선택되지 않은 상태에서는 상태 바를 건드리지 않음
    const trSel = document.getElementById('translationSelect');
    if (trSel?.value !== 'local') return;
    const statusEl = document.getElementById('translationStatus');
    if (!statusEl) return;
    let bar = document.getElementById('localDlBar');
    let pct = document.getElementById('localDlPercent');
    if (!bar || !pct) {
      setSafeHtml(
        statusEl,
        `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${I18N[currentUiLang].localModelDownloadingHtml || 'Downloading Hy-MT2 Q4...'} <span id="localDlPercent">${percent}%</span></div>
        <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;width:100%">
          <div id="localDlBar" style="height:100%;width:${percent}%;background:var(--accent);transition:width 0.3s;"></div>
        </div>`
      );
    } else {
      bar.style.width = percent + '%';
      pct.textContent = percent + '%';
    }
    if (percent >= 100) {
      _localDownloading = false;
      setTimeout(updateLocalModelStatus, 500);
    }
  });
}

// ============================================================
// Models view
// ============================================================

// Wire up progress listeners once (idempotent)
let _modelProgressWired = false;
function _wireModelProgress() {
  if (_modelProgressWired) return;
  _modelProgressWired = true;
  // Whisper downloads
  if (window.electronAPI?.onWhisperModelProgress) {
    window.electronAPI.onWhisperModelProgress(({ modelName, percent }) => {
      _updateModelCardProgress(`whisper-${modelName}`, percent);
      // 정밀/라이트는 같은 다운로드를 공유하므로 진행률을 두 카드에 함께 표시한다.
      if (modelName === 'large-v2-sync') _updateModelCardProgress('whisper-large-v2-sync-lite', percent);
    });
  }
  // Hy-MT2 (local translator) downloads. Map filename → card id.
  if (window.electronAPI?.onLocalModelProgress) {
    window.electronAPI.onLocalModelProgress((progress) => {
      if (!progress) return;
      // progress: { modelId, progress, percent, downloadedBytes, totalBytes, ... }
      const pct = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            progress.percent != null
              ? progress.percent
              : progress.progress != null
                ? progress.progress * (progress.progress <= 1 ? 100 : 1)
                : 0
          )
        )
      );
      const id = String(progress.modelId || '').toLowerCase();
      if (id.includes('7')) _updateModelCardProgress('hy-mt-7b', pct);
      else _updateModelCardProgress('hy-mt-1.8b', pct);
    });
  }
}

// 다운로드 진행 중인 모델 ID 집합 — renderModels() 가 참조해서 중복 클릭 방지
const _downloadingModels = new Set();
window._downloadingModels = _downloadingModels;

function isCancelledDownloadResult(result) {
  return result?.success === false && (result.userStopped || /cancel(?:l)?ed/i.test(String(result.error || '')));
}

function _updateModelCardProgress(cardId, percent) {
  const card = document.querySelector(`.model-card[data-card-id="${cardId}"]`);
  if (!card) return;
  let bar = card.querySelector('.model-card-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'model-card-progress';
    setSafeHtml(bar, '<div class="model-card-progress-fill"></div><span class="model-card-progress-text"></span>');
    const actions = card.querySelector('.model-card-actions');
    if (actions) actions.parentNode.insertBefore(bar, actions);
  }
  const fill = bar.querySelector('.model-card-progress-fill');
  const text = bar.querySelector('.model-card-progress-text');
  if (fill) fill.style.width = `${percent}%`;
  if (text) text.textContent = `${percent}%`;
  if (percent >= 100) {
    setTimeout(() => {
      try {
        renderModels();
      } catch (_e) {}
    }, 600);
  }
}

async function renderModels() {
  _wireModelProgress();
  const D = I18N[currentUiLang] || I18N.ko;
  const grid = document.getElementById('modelsGrid');
  if (!grid) return;

  // Models metadata: 2 translation (Hy-MT2) + 6 ASR (Whisper) = 8 total
  const models = [
    {
      id: 'hy-mt-1.8b',
      whisperKey: null,
      name: 'Hy-MT2 · 1.8B',
      desc: 'Fast lightweight local translator.',
      size: '1.13 GB',
      vram: '~2.5 GB',
      speedKey: 'fast',
      category: 'translation',
      tag: 'MT',
    },
    {
      id: 'hy-mt-7b',
      whisperKey: null,
      name: 'Hy-MT2 · 7B',
      desc: 'High-quality local translator.',
      size: '6.16 GB',
      vram: '~8 GB',
      speedKey: 'medium',
      category: 'translation',
      tag: 'MT',
    },
    {
      id: 'whisper-tiny',
      whisperKey: 'tiny',
      name: 'Whisper · Tiny',
      desc: 'Smallest and fastest.',
      size: '~75 MB',
      vram: '~1 GB',
      speedKey: 'extreme',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-base',
      whisperKey: 'base',
      name: 'Whisper · Base',
      desc: 'More accurate than Tiny.',
      size: '~142 MB',
      vram: '~1 GB',
      speedKey: 'veryFast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-small',
      whisperKey: 'small',
      name: 'Whisper · Small',
      desc: 'Fast subtitle extraction.',
      size: '~466 MB',
      vram: '~1 GB',
      speedKey: 'fast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-medium',
      whisperKey: 'medium',
      name: 'Whisper · Medium',
      desc: 'Balanced accuracy and speed.',
      size: '~1.5 GB',
      vram: '~2 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-large-v3-turbo',
      whisperKey: 'large-v3-turbo', // gitleaks:allow - public model identifier
      name: 'Whisper · Large v3 Turbo',
      desc: 'Large accuracy with 8x speed.',
      size: '~1.6 GB',
      vram: '~2 GB',
      speedKey: 'fast',
      category: 'asr',
      tag: 'ASR',
    },
    {
      id: 'whisper-large-v3',
      whisperKey: 'large-v3',
      name: 'Whisper · Large v3',
      desc: 'Most accurate ASR model (F16, slower).',
      size: '~3.1 GB',
      vram: '~4 GB',
      speedKey: 'slow',
      category: 'asr',
      tag: 'ASR',
    },
    {
      // 싱크 엔진: GGML이 아니라 Faster-Whisper-XXL(GPU 자동). whisperKey 대신 syncEngine 마커 사용.
      id: 'whisper-large-v2-sync',
      whisperKey: null,
      syncEngine: true,
      name: 'Whisper · Large v2 Sync',
      desc: 'Best subtitle sync. GPU auto, separate engine.',
      size: '~4.4 GB',
      vram: '~4.5 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
    {
      // 싱크 엔진 라이트(int8): 정밀과 같은 엔진+model.bin을 공유한다. 다운로드/삭제는 정밀 카드와
      // 동일한 download-sync-engine/delete-sync-engine을 쓰고, 설치 판정도 엔진 존재로 함께 처리된다.
      id: 'whisper-large-v2-sync-lite',
      whisperKey: null,
      syncEngine: true,
      name: 'Whisper · Large v2 Sync Lite',
      desc: 'Same file as precise, int8, lower VRAM.',
      sizeKey: 'shared',
      size: '~4.4 GB',
      vram: '~3 GB',
      speedKey: 'medium',
      category: 'asr',
      tag: 'ASR',
    },
  ];

  // Check installed status (best-effort) — always fresh from disk
  let installedSet = new Set();
  try {
    if (window.electronAPI?.localModelStatus) {
      try {
        const r18 = await window.electronAPI.localModelStatus('1.8b');
        if (r18?.installed || r18?.exists) installedSet.add('hy-mt-1.8b');
      } catch (e) {
        console.warn('[renderModels] 1.8b status:', e);
      }
      try {
        const r7 = await window.electronAPI.localModelStatus('7b');
        if (r7?.installed || r7?.exists) installedSet.add('hy-mt-7b');
      } catch (e) {
        console.warn('[renderModels] 7b status:', e);
      }
    }
    // Whisper models — re-fetch fresh status each time AND fall back to
    // the workspace-cached global if IPC returns empty (some edge cases).
    let whisperStatus = {};
    if (window.electronAPI?.checkModelStatus) {
      try {
        whisperStatus = await window.electronAPI.checkModelStatus();
      } catch (e) {
        console.warn('[renderModels] checkModelStatus failed:', e);
      }
      console.log('[renderModels] Whisper status (fresh):', whisperStatus);
      // Keep the global in sync for the workspace dropdown
      try {
        availableModels = whisperStatus || availableModels || {};
      } catch (_e) {}
    }
    // Merge with any pre-populated global (covers startup race)
    const mergedWhisper = Object.assign({}, availableModels || {}, whisperStatus || {});
    for (const m of models) {
      if (m.whisperKey && mergedWhisper[m.whisperKey]) installedSet.add(m.id);
      // 싱크 엔진은 check-model-status가 'large-v2-sync' 키로 설치 여부를 보고한다.
      if (m.syncEngine && mergedWhisper['large-v2-sync']) installedSet.add(m.id);
    }
    console.log('[renderModels] merged whisper:', mergedWhisper, 'installedSet:', Array.from(installedSet));
  } catch (_e) {
    /* ignore */
  }

  // Build card HTML helper
  const cardHtml = (m) => {
    const installed = installedSet.has(m.id);
    const badge = installed
      ? `<span class="model-card-badge installed">● ${D.modelInstalled || 'Installed'}</span>`
      : `<span class="model-card-badge available">${D.modelNotInstalled || 'Not installed'}</span>`;
    const downloading = _downloadingModels.has(m.id);
    const actions = installed
      ? `<button class="model-card-btn ghost" data-model-action="delete" data-model-id="${m.id}">${D.modelDeleteBtn || 'Delete'}</button>
         <button class="model-card-btn" disabled>${D.modelReadyBtn || 'Ready'}</button>`
      : downloading
        ? `<button class="model-card-btn primary" disabled>${D.btnDownloading || 'Downloading…'}</button>
           <button class="model-card-btn ghost" data-model-action="cancel-download" data-model-id="${m.id}">${D.btnCancel || 'Cancel'}</button>`
        : `<button class="model-card-btn primary" data-model-action="download" data-model-id="${m.id}">${D.modelDownloadBtn || 'Download'}</button>`;
    const mascot = m.category === 'translation' ? '../../assets/px-mascot-mt.png' : '../../assets/px-model-asr.png';
    const tagColor = m.category === 'translation' ? 'lavender' : 'pink';
    const catAttr = m.category === 'translation' ? 'mt' : 'asr';
    return `
      <div class="model-card model-card-${m.category}" data-card-id="${m.id}" data-cat="${catAttr}">
        <div class="model-card-media">
          <img class="model-card-mascot" src="${mascot}" alt="" aria-hidden="true"/>
          <span class="model-card-tag model-card-tag-${tagColor}">${_esc(m.category === 'translation' ? D.modelTagTranslation || 'MT' : D.modelTagAsr || 'ASR')}</span>
        </div>
        <div class="model-card-head">
          <div class="model-card-info">
            <h3 class="model-card-name">${_esc((D.modelNames && D.modelNames[m.id]) || m.name)}</h3>
            <p class="model-card-desc">${_esc((D.modelDescriptions && D.modelDescriptions[m.id]) || m.desc)}</p>
          </div>
          ${badge}
        </div>
        <div class="model-card-meta">
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaSize || 'Size'}</span>
            <span class="model-card-meta-value">${m.sizeKey === 'shared' ? D.modelSizeShared || 'Shared' : m.size}</span>
          </div>
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaVram || 'VRAM'}</span>
            <span class="model-card-meta-value">${m.vram}</span>
          </div>
          <div class="model-card-meta-item">
            <span class="model-card-meta-label">${D.modelMetaSpeed || 'Speed'}</span>
            <span class="model-card-meta-value">${(D.modelSpeed && D.modelSpeed[m.speedKey]) || m.speedKey}</span>
          </div>
        </div>
        <div class="model-card-actions">
          ${actions}
        </div>
      </div>`;
  };

  // Group by category: 번역 (translation) and 음성인식 (asr)
  const translationModels = models.filter((m) => m.category === 'translation');
  const asrModels = models.filter((m) => m.category === 'asr');
  const sectionTrTitle = D.modelSectionTranslation || 'Translation Models';
  const sectionAsTitle = D.modelSectionAsr || 'Speech Recognition Models';
  const sectionTrHint = D.modelSectionTranslationHint || 'Text → another language';
  const sectionAsHint = D.modelSectionAsrHint || 'Audio → subtitle text';

  setSafeHtml(
    grid,
    `<section class="model-section">
      <header class="model-section-header">
        <div class="model-section-title-wrap">
          <span class="model-section-dot lavender"></span>
          <h2 class="model-section-title">${sectionTrTitle}</h2>
          <span class="model-section-hint">${sectionTrHint}</span>
        </div>
        <span class="model-section-count">${translationModels.filter((m) => installedSet.has(m.id)).length} / ${translationModels.length}</span>
      </header>
      <div class="model-section-grid">${translationModels.map(cardHtml).join('')}</div>
    </section>
    <section class="model-section">
      <header class="model-section-header">
        <div class="model-section-title-wrap">
          <span class="model-section-dot pink"></span>
          <h2 class="model-section-title">${sectionAsTitle}</h2>
          <span class="model-section-hint">${sectionAsHint}</span>
        </div>
        <span class="model-section-count">${asrModels.filter((m) => installedSet.has(m.id)).length} / ${asrModels.length}</span>
      </header>
      <div class="model-section-grid">${asrModels.map(cardHtml).join('')}</div>
    </section>`
  );

  // Bind download actions
  grid.querySelectorAll('[data-model-action="download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      // 이미 다운로드 중이면 무시
      if (_downloadingModels.has(m.id)) return;
      if (m.category === 'translation') {
        if (window.electronAPI?.localModelDownload) {
          const hyId = m.id === 'hy-mt-7b' ? '7b' : '1.8b';
          const D2 = I18N[currentUiLang] || I18N.ko;
          if (!confirm(`${m.name} (${m.size}) — ${D2.confirmDownloadModel || 'Start download?'}`)) return;
          _downloadingModels.add(m.id);
          // 카드 재렌더 하여 취소 버튼 노출
          try {
            renderModels();
          } catch (_e) {}
          try {
            _updateModelCardProgress(m.id, 0);
            const result = await window.electronAPI.localModelDownload(hyId);
            if (isCancelledDownloadResult(result)) return;
            if (result?.success === false) throw new Error(result.error || 'failed');
          } catch (e) {
            alert(
              `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
            );
          } finally {
            _downloadingModels.delete(m.id);
            renderModels();
          }
        }
      } else if (m.syncEngine && window.electronAPI?.downloadSyncEngine) {
        const D3 = I18N[currentUiLang] || I18N.ko;
        if (!confirm(`${m.name} (${m.size}) — ${D3.confirmDownloadModel || 'Start download?'}`)) return;
        // 정밀/라이트 카드는 같은 엔진을 공유 → 어느 쪽을 눌러도 두 카드 모두 다운로드 상태로 표시.
        const syncCardIds = ['whisper-large-v2-sync', 'whisper-large-v2-sync-lite'];
        syncCardIds.forEach((cid) => _downloadingModels.add(cid));
        try {
          renderModels();
        } catch (_e) {}
        try {
          syncCardIds.forEach((cid) => _updateModelCardProgress(cid, 0));
          const r = await window.electronAPI.downloadSyncEngine();
          if (isCancelledDownloadResult(r)) return;
          if (r?.success === false) throw new Error(r.error || 'failed');
          // 정밀/라이트는 같은 엔진+모델을 공유 → 한 번 받으면 둘 다 사용 가능.
          availableModels['large-v2-sync'] = true;
          availableModels['large-v2-sync-lite'] = true;
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } catch (e) {
          alert(
            `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
          );
        } finally {
          syncCardIds.forEach((cid) => _downloadingModels.delete(cid));
          renderModels();
        }
      } else if (m.whisperKey && window.electronAPI?.downloadModel) {
        const D3 = I18N[currentUiLang] || I18N.ko;
        if (!confirm(`Whisper ${m.whisperKey} (${m.size}) — ${D3.confirmDownloadModel || 'Start download?'}`)) return;
        _downloadingModels.add(m.id);
        // 카드 재렌더 하여 취소 버튼 노출
        try {
          renderModels();
        } catch (_e) {}
        try {
          _updateModelCardProgress(m.id, 0);
          const result = await window.electronAPI.downloadModel(m.whisperKey);
          if (isCancelledDownloadResult(result)) return;
          if (result?.success === false) throw new Error(result.error || 'failed');
          availableModels[m.whisperKey] = true;
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } catch (e) {
          alert(
            `${(I18N[currentUiLang] || I18N.ko).toastDownloadFailed || 'Download failed'}: ${getLocalizedError(e?.message || e)}`
          );
        } finally {
          _downloadingModels.delete(m.id);
          renderModels();
        }
      }
    });
  });

  // Bind cancel-download actions
  grid.querySelectorAll('[data-model-action="cancel-download"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      try {
        btn.disabled = true;
        if (m.category === 'translation' && window.electronAPI?.localModelCancel) {
          await window.electronAPI.localModelCancel(m.id === 'hy-mt-7b' ? '7b' : '1.8b');
        } else if ((m.whisperKey || m.syncEngine) && window.electronAPI?.whisperModelCancel) {
          await window.electronAPI.whisperModelCancel();
        }
      } catch (_e) {}
      // 진행 플래그는 download 핵들러의 finally 에서 해제됨
    });
  });

  // Bind delete actions
  grid.querySelectorAll('[data-model-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model-id');
      const m = models.find((x) => x.id === id);
      if (!m) return;
      const D4 = I18N[currentUiLang] || I18N.ko;
      if (!confirm(`${m.name} — ${D4.confirmDeleteModel || 'Delete this model?'}`)) return;
      try {
        btn.disabled = true;
        btn.textContent = (I18N[currentUiLang] || I18N.ko).btnDeleting || 'Deleting…';
        if (m.category === 'translation' && window.electronAPI?.localModelDelete) {
          await window.electronAPI.localModelDelete(m.id === 'hy-mt-7b' ? '7b' : '1.8b');
        } else if (m.syncEngine && window.electronAPI?.deleteSyncEngine) {
          await window.electronAPI.deleteSyncEngine();
          // 공유 파일 삭제 → 정밀/라이트 둘 다 불가 상태로.
          delete availableModels['large-v2-sync'];
          delete availableModels['large-v2-sync-lite'];
          if (typeof updateModelSelect === 'function') updateModelSelect();
        } else if (m.whisperKey && window.electronAPI?.deleteWhisperModel) {
          await window.electronAPI.deleteWhisperModel(m.whisperKey);
          delete availableModels[m.whisperKey];
          if (typeof updateModelSelect === 'function') updateModelSelect();
        }
        renderModels();
      } catch (e) {
        alert(`${(I18N[currentUiLang] || I18N.ko).toastDeleteFailed || 'Delete failed'}: ${e?.message || e}`);
        renderModels();
      }
    });
  });
}
window.renderModels = renderModels;
