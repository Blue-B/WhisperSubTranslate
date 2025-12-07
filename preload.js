const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 간소화된 Electron API (파일 경로 안전 처리)
contextBridge.exposeInMainWorld('electronAPI', {
  // 자막 추출 (단일 파일)
  extractSubtitles: (data) => {
    return ipcRenderer.invoke('extract-subtitles', data);
  },
  
  // 파일 선택 다이얼로그
  showOpenDialog: (options) => {
    return ipcRenderer.invoke('show-open-dialog', options);
  },
  
  // 모델 상태 확인
  checkModelStatus: () => {
    return ipcRenderer.invoke('check-model-status');
  },
  
  // 모델 다운로드
  downloadModel: (modelName) => {
    return ipcRenderer.invoke('download-model', modelName);
  },
  
  // 파일 위치 열기
  openFileLocation: (filePath) => {
    return ipcRenderer.invoke('open-file-location', filePath);
  },
  
  // 폴더 열기
  openFolder: (folderPath) => {
    return ipcRenderer.invoke('open-folder', folderPath);
  },
  
  // 현재 처리 중지
  stopCurrentProcess: () => {
    return ipcRenderer.invoke('stop-current-process');
  },
  
  // ========== 번역 관련 API ==========
  
  // API 키 저장
  saveApiKeys: (keys) => {
    return ipcRenderer.invoke('save-api-keys', keys);
  },
  
  // API 키 불러오기
  loadApiKeys: () => {
    return ipcRenderer.invoke('load-api-keys');
  },
  
  // API 키 유효성 검사 (임시 키 지원)
  validateApiKeys: (tempKeys) => {
    return ipcRenderer.invoke('validate-api-keys', tempKeys);
  },
  
  // 자막 번역
  translateSubtitle: (data) => {
    return ipcRenderer.invoke('translate-subtitle', data);
  },

  // 레거시 호환 (복수형 메서드명 지원)
  translateSubtitles: (data) => {
    return ipcRenderer.invoke('translate-subtitle', data);
  },

  // 오프라인 모델 준비
  warmupOfflineModel: () => {
    return ipcRenderer.invoke('warmup-offline-model');
  },
  // 오프라인 모델 디렉터리 경로 조회
  getOfflineModelDir: () => {
    return ipcRenderer.invoke('get-offline-model-dir');
  },
  
  // 텍스트 번역 (테스트용)
  translateText: (data) => {
    return ipcRenderer.invoke('translate-text', data);
  },

  // 외부 링크 열기 (기본 브라우저에서)
  openExternal: (url) => {
    return ipcRenderer.invoke('open-external', url);
  },
  
  
  // 안전한 파일 경로 추출 (개선된 버전)
  getFilePathFromFile: (file) => {
    console.log('getFilePathFromFile called with:', {
      name: file.name,
      path: file.path,
      type: file.type,
      size: file.size
    });
    
    // 방법 1: webUtils 사용 (최신 Electron 권장)
    try {
      if (webUtils && webUtils.getPathForFile) {
        const filePath = webUtils.getPathForFile(file);
        console.log('[OK] webUtils.getPathForFile success:', filePath);
        return filePath;
      }
    } catch (error) {
      console.error('[ERROR] webUtils.getPathForFile failed:', error);
    }
    
    // 방법 2: 직접 file.path 접근 (폴백)
    if (file.path && typeof file.path === 'string' && file.path.trim()) {
      console.log('[OK] Using file.path fallback:', file.path);
      return file.path;
    }
    
    // 방법 3: 실패 시 파일명만이라도 반환
    console.error('[ERROR] Cannot extract file path, using name only:', file.name);
    return file.name; // 최소한 파일명은 반환
  },
  
  // 진행률 업데이트 리스너
  onProgressUpdate: (callback) => {
    ipcRenderer.on('progress-update', (event, data) => callback(data));
  },
  
  // 출력 업데이트 리스너
  onOutputUpdate: (callback) => {
    ipcRenderer.on('output-update', (event, data) => callback(data));
  },
  
  // 번역 진행률 리스너
  onTranslationProgress: (callback) => {
    ipcRenderer.on('translation-progress', (event, data) => callback(data));
  },
  
  // 리스너 정리 (메모리 누수 방지)
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('progress-update');
    ipcRenderer.removeAllListeners('output-update');
    ipcRenderer.removeAllListeners('translation-progress');
  }
});
