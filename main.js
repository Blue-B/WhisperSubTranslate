const { app, BrowserWindow, ipcMain, dialog } = require('electron');
// 앱 이름 고정 (우클릭 메뉴와 작업표시줄 레이블이 'Electron' 대신 이 이름으로)
try {
  app.setName('WhisperSubTranslate');
} catch (_) {}
try {
  app.setAppUserModelId('com.whispersubtranslate.app');
} catch (_) {}
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.log('[Auto-Updater] electron-updater not available:', error.message);
}
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const axios = require('axios');
const EnhancedSubtitleTranslator = require('./translator-enhanced');
const { applySrtCleanup, wrapCuesForDisplay } = require('./srt-cleanup');
const errLogger = require('./lib/error-logger');
const { Menu } = require('electron');
try {
  errLogger.setElectronApp(app);
} catch (_) {}

// Capture unhandled errors so they end up in errors.log for user support
process.on('uncaughtException', (err) => {
  try {
    errLogger.logError('main:uncaughtException', err?.message || String(err), err);
  } catch (_) {}
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  try {
    errLogger.logError('main:unhandledRejection', reason?.message || String(reason), reason);
  } catch (_) {}
  console.error('[unhandledRejection]', reason);
});

// ffmpeg-static: npm 패키지에서 자동으로 플랫폼별 ffmpeg 바이너리 제공
let ffmpegStaticPath = null;
try {
  ffmpegStaticPath = require('ffmpeg-static');
  if (ffmpegStaticPath && ffmpegStaticPath.includes('app.asar')) {
    ffmpegStaticPath = ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
  }
  console.log('[FFmpeg] Using ffmpeg-static:', ffmpegStaticPath);
} catch (_error) {
  console.log('[FFmpeg] ffmpeg-static not available, will use system PATH or local binary');
}

// ffprobe-static: npm 패키지에서 자동으로 플랫폼별 ffprobe 바이너리 제공
let ffprobeStaticPath = null;
try {
  ffprobeStaticPath = require('ffprobe-static').path;
  if (ffprobeStaticPath && ffprobeStaticPath.includes('app.asar')) {
    ffprobeStaticPath = ffprobeStaticPath.replace('app.asar', 'app.asar.unpacked');
  }
  console.log('[FFprobe] Using ffprobe-static:', ffprobeStaticPath);
} catch (_error) {
  console.log('[FFprobe] ffprobe-static not available, will use system PATH or local binary');
}

// Allow autoplay of audio (오디오 자동재생 허용)
try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
} catch (error) {
  console.log('[Audio] Failed to set autoplay policy:', error.message);
}

// Global variables
let mainWindow;
let currentProcess = null;
let isUserStopped = false;
let translator = new EnhancedSubtitleTranslator();

// ===== Download cancellation state (모델 다운로드 취소 관리) =====
let activeDownloads = new Set(); // { controller, writer, destPath }
let downloadsCancelled = false;

function cancelActiveDownloads() {
  const hadActive = activeDownloads.size > 0;
  downloadsCancelled = true;
  for (const d of activeDownloads) {
    try {
      d.controller?.abort();
    } catch (error) {
      console.log('[Download] Controller abort failed:', error.message);
    }
    try {
      d.writer?.destroy?.();
    } catch (error) {
      console.log('[Download] Writer destroy failed:', error.message);
    }
  }
  activeDownloads.clear();
  // Only surface the cancellation message when there was actually an active download.
  if (hadActive) {
    try {
      mainWindow?.webContents?.send('output-update', 'Model download cancelled\n');
    } catch (error) {
      console.log('[Download] Failed to send cancellation message:', error.message);
    }
  }
}

// ===== Device auto-selection helper (장치 자동 선택 헬퍼) =====
// Platform-specific whisper-cli binary name
const WHISPER_CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
// Silero VAD ggml model (provisioned by postinstall.js into whisper-cpp/).
// VAD lets whisper process only speech segments → removes the repeated/hallucinated
// lines it otherwise emits on silent/music parts (the JAV/music repetition problem).
const VAD_MODEL_NAME = 'ggml-silero-v5.1.2.bin';

// CUDA 12 requires compute capability >= 5.0 (Maxwell+)
const CUDA12_MIN_COMPUTE = 5.0;
let _gpuInfoCache = null;
let _gpuWarningShown = false;
// 반복/환각 억제(-mc 0) 적용 여부. extract-subtitles IPC에서 매 추출 전 설정됨.
// 기본 true: 반복 도배(JAV/음악/무음 구간) 피해가 큰 쪽을 기본값으로. 일반 연속발화 일관성이
// 더 중요한 사용자는 설정에서 끕 수 있다.
let reduceRepetition = true;
// 자연 문장 단위 전사 — 항상 ON (UI 토글 없음). ON이면 whisper에 -ml/-sow(강제 50자
// 분할)를 주지 않아 절·문장 단위 세그먼트가 나온다 → 코드스위칭 영어 단어 보존 +
// 번역기가 완결 문장을 받아 번역 품질이 크게 오름. 화면 줄길이는 출력 후 wrap으로 처리.
// 렌더러는 더 이상 이 값을 보내지 않으므로 기본값(true)이 유지된다. 아래 IPC 할당은
// 코드 레벨 escape hatch(외부 호출자가 false를 보내면 구판 동작)로만 남겨둔다.
let naturalSegmentation = true;

function getGpuInfo() {
  if (_gpuInfoCache !== null) return _gpuInfoCache;
  try {
    const raw = execSync('nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) {
      _gpuInfoCache = { available: false };
      return _gpuInfoCache;
    }
    const firstLine = raw.split('\n')[0];
    const parts = firstLine.split(',').map((s) => s.trim());
    const gpuName = parts[0] || 'Unknown GPU';
    const computeCap = parseFloat(parts[1]) || 0;
    _gpuInfoCache = {
      available: true,
      name: gpuName,
      computeCap,
      cudaCompatible: computeCap >= CUDA12_MIN_COMPUTE,
    };
    console.log(
      `[GPU Info] ${gpuName}, Compute Capability: ${computeCap}, CUDA 12 compatible: ${computeCap >= CUDA12_MIN_COMPUTE}`
    );
  } catch {
    try {
      // 상세 쿼리 실패 시 nvidia-smi -L로 GPU 존재만 확인
      // compute_cap을 알 수 없으므로 안전하게 CPU 사용 (구형 GPU에서 CUDA 12 크래시 방지)
      execSync('nvidia-smi -L', { stdio: 'ignore', timeout: 2000 });
      _gpuInfoCache = { available: true, name: 'Unknown NVIDIA GPU', computeCap: 0, cudaCompatible: false };
    } catch {
      _gpuInfoCache = { available: false };
    }
  }
  return _gpuInfoCache;
}

function isCudaAvailable() {
  const info = getGpuInfo();
  return info.available && info.cudaCompatible;
}

// ===== CUDA Library Path Helper (Linux LD_LIBRARY_PATH) =====
// On Linux, CUDA-built whisper-cli needs LD_LIBRARY_PATH to find .so files.
// Electron apps launched from desktop may not inherit shell env vars.
let _cudaLibPathCache = null;

function getCudaLibraryPaths() {
  if (_cudaLibPathCache !== null) return _cudaLibPathCache;
  if (process.platform === 'win32') {
    _cudaLibPathCache = [];
    return [];
  }

  const found = [];
  const candidates = [
    '/usr/local/cuda/lib64',
    '/usr/local/cuda/lib',
    '/usr/lib/wsl/lib', // WSL2 CUDA library path
    '/usr/lib/x86_64-linux-gnu',
    '/usr/lib64',
  ];

  // Detect versioned CUDA installations (e.g. /usr/local/cuda-13.2/lib64)
  try {
    const localDirs = fs.readdirSync('/usr/local');
    for (const dir of localDirs) {
      if (dir.startsWith('cuda-')) {
        candidates.push(`/usr/local/${dir}/lib64`);
        candidates.push(`/usr/local/${dir}/lib`);
      }
    }
  } catch (_e) {
    /* ignore */
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) found.push(p);
    } catch (_e) {
      /* ignore */
    }
  }

  _cudaLibPathCache = found;
  if (found.length > 0) {
    console.log('[CUDA Libs] Found library paths:', found.join(', '));
  }
  return found;
}

function getWhisperSpawnEnv(device, whisperDir) {
  // On Windows, no env override needed
  if (process.platform === 'win32') return undefined;

  const cudaPaths = device === 'cuda' ? getCudaLibraryPaths() : [];
  const allPaths = [];

  // Always include whisper-cpp dir itself (for libwhisper.so/dylib, libggml*.so/dylib)
  if (whisperDir) allPaths.push(whisperDir);
  allPaths.push(...cudaPaths);

  // Linux: LD_LIBRARY_PATH, macOS: DYLD_LIBRARY_PATH
  const isMac = process.platform === 'darwin';
  const envVar = isMac ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const existingPath = process.env[envVar] || '';
  allPaths.push(...existingPath.split(':').filter(Boolean));

  // Deduplicate
  const uniquePaths = [...new Set(allPaths)];
  if (uniquePaths.length === 0) return undefined;

  const newPath = uniquePaths.join(':');
  console.log(`[Spawn Env] ${envVar}:`, newPath);
  return { ...process.env, [envVar]: newPath };
}

function resolveDevice(requestedDevice) {
  const req = (requestedDevice || 'auto').toLowerCase();
  if (req === 'auto') {
    return isCudaAvailable() ? 'cuda' : 'cpu';
  }
  if (req === 'cuda' && !isCudaAvailable()) {
    return 'cpu';
  }
  if (req !== 'cuda' && req !== 'cpu') {
    return 'cpu';
  }
  return req;
}

// Dynamic performance settings based on system specs (reserved for future use)
function _getOptimalWhisperSettings(device) {
  const totalMemory = os.totalmem() / (1024 * 1024 * 1024); // GB
  const cpuCores = os.cpus().length;

  console.log(`[System Info] RAM: ${totalMemory.toFixed(1)}GB, CPU Cores: ${cpuCores}`);

  if (device === 'cuda') {
    // GPU settings - balanced for stability and performance
    if (totalMemory >= 16 && cpuCores >= 8) {
      // High-end system - good performance with safety margin
      console.log('[Performance] High-end GPU settings applied');
      return [
        '--compute_type',
        'float16',
        '--beam_size',
        '5',
        '--batch_size',
        '16',
        '--threads',
        '4',
        '--chunk_length',
        '30',
      ];
    } else if (totalMemory >= 8) {
      // Mid-range system - balanced settings
      console.log('[Performance] Mid-range GPU settings applied');
      return [
        '--compute_type',
        'float16',
        '--beam_size',
        '3',
        '--batch_size',
        '8',
        '--threads',
        '2',
        '--chunk_length',
        '25',
      ];
    } else {
      // Low-end system with GPU - conservative but faster than CPU
      console.log('[Performance] Low-end GPU settings applied');
      return [
        '--compute_type',
        'int8',
        '--beam_size',
        '1',
        '--batch_size',
        '4',
        '--threads',
        '1',
        '--chunk_length',
        '20',
      ];
    }
  } else {
    // CPU settings - optimized for different CPU configurations
    if (totalMemory >= 16 && cpuCores >= 8) {
      // High-end CPU system
      console.log('[Performance] High-end CPU settings applied');
      return [
        '--compute_type',
        'int8',
        '--beam_size',
        '3',
        '--batch_size',
        '8',
        '--threads',
        Math.min(cpuCores - 2, 6).toString(),
        '--chunk_length',
        '25',
      ];
    } else if (totalMemory >= 8 && cpuCores >= 4) {
      // Mid-range CPU system
      console.log('[Performance] Mid-range CPU settings applied');
      return [
        '--compute_type',
        'int8',
        '--beam_size',
        '2',
        '--batch_size',
        '4',
        '--threads',
        Math.min(cpuCores - 1, 4).toString(),
        '--chunk_length',
        '20',
      ];
    } else {
      // Low-end CPU system
      console.log('[Performance] Low-end CPU settings applied');
      return [
        '--compute_type',
        'int8',
        '--beam_size',
        '1',
        '--batch_size',
        '2',
        '--threads',
        '1',
        '--chunk_length',
        '15',
      ];
    }
  }
}

// Enhanced memory/GPU cleanup across files (파일 간 메모리/GPU 정리)
function forceMemoryCleanup(device, isFileTransition = false) {
  return new Promise((resolve) => {
    const cleanupType = isFileTransition ? 'Inter-file memory cleanup' : 'General memory cleanup';
    console.log(`${cleanupType} starting...`);

    try {
      // 1. Kill current process
      if (currentProcess && !currentProcess.killed) {
        currentProcess.kill('SIGKILL');
        currentProcess = null;
        console.log('   - Current process killed');
      }

      if (process.platform === 'win32') {
        // 2. Kill all related processes
        try {
          execSync(`taskkill /F /IM ${WHISPER_CLI_NAME} /T`, { stdio: 'ignore' });
          execSync('taskkill /F /IM ffmpeg.exe /T', { stdio: 'ignore' });
          console.log('   - All related processes cleaned up');
        } catch (_e) {
          console.log('   - No processes to clean up');
        }

        // 3. Enhanced GPU cleanup for CUDA
        if (device === 'cuda') {
          const delay = isFileTransition ? 2000 : 500; // Longer delay for file transitions

          setTimeout(() => {
            try {
              console.log('   - Flushing GPU cache...');

              // Kill all CUDA processes first
              try {
                execSync('taskkill /F /IM "nvcc.exe" /T', { stdio: 'ignore' });
                execSync('taskkill /F /IM "nvidia-smi.exe" /T', { stdio: 'ignore' });
                console.log('   - CUDA processes cleaned up');
              } catch (e) {
                console.log('[GPU] CUDA process cleanup failed:', e.message);
              }

              // Multiple GPU reset attempts with different methods
              for (let i = 0; i < 5; i++) {
                try {
                  if (i < 3) {
                    execSync('nvidia-smi --gpu-reset', { stdio: 'ignore', timeout: 15000 });
                  } else {
                    execSync('nvidia-smi -r', { stdio: 'ignore', timeout: 10000 });
                  }
                  console.log(`   - GPU reset attempt ${i + 1}/5 succeeded`);
                  break;
                } catch (_e) {
                  if (i === 4) console.log('   - GPU reset failed, continuing');
                }
              }

              console.log('   - GPU memory cleanup completed');
            } catch (e) {
              console.log(`   - GPU cleanup attempt failed: ${e.message}`);
            }

            // 4. System memory cleanup
            try {
              execSync('powershell -Command "[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers();"', {
                stdio: 'ignore',
                timeout: 5000,
              });
              console.log('   - System memory cleanup completed');
            } catch (_e) {
              console.log('   - System memory cleanup skipped');
            }

            resolve();
          }, delay);
        } else {
          resolve();
        }
      } else {
        resolve();
      }

      // 5. Node.js garbage collection
      if (global.gc) {
        for (let i = 0; i < 5; i++) {
          global.gc();
        }
        console.log('   - Node.js garbage collection completed');
      }
    } catch (e) {
      console.error(`[ERROR] Memory cleanup error: ${e.message}`);
      resolve();
    }
  });
}

// ===== Update Checker (업데이트 알림) =====
const GITHUB_REPO = 'blue-b/WhisperSubTranslate';
const CURRENT_VERSION = require('./package.json').version;

async function checkForUpdates() {
  console.log('[Update Check] Starting... Current version:', CURRENT_VERSION);
  try {
    const response = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { timeout: 10000 });

    const latestVersion = response.data.tag_name.replace(/^v/, '');
    const releaseUrl = response.data.html_url;
    const releaseName = response.data.name || `v${latestVersion}`;

    // 버전 비교 (semver 간단 비교)
    const isNewer = compareVersions(latestVersion, CURRENT_VERSION) > 0;

    console.log(`[Update Check] Latest: ${latestVersion}, Current: ${CURRENT_VERSION}, HasUpdate: ${isNewer}`);

    return {
      hasUpdate: isNewer,
      currentVersion: CURRENT_VERSION,
      latestVersion,
      releaseUrl,
      releaseName,
    };
  } catch (error) {
    console.log('[Update Check] Failed:', error.message);
    return { hasUpdate: false, error: error.message };
  }
}

// 간단한 semver 비교 (1.3.3 vs 1.3.4)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

// App Initialization
// 렌더러 크래시 자동복구 백오프용 타임스탬프 기록 (무한 reload 루프 방지)
let rendererReloadTimes = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, // 더 넓게 (900→1280) - 2열 레이아웃에 적합
    height: 900, // 메인 드롭존/설정 영역이 답답하지 않도록 기본 세로 공간 확보
    minWidth: 1000, // 최소 너비 제한 (UI 깨짐 방지)
    minHeight: 760, // 파일 선택 CTA가 너무 아래로 밀리지 않도록 최소 높이 상향
    title: 'WhisperSubTranslate', // 윈도우 타이틀
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false, // 준비 완료 전 깜빡임 방지
  });

  // 창이 준비되면 표시 (깜빡임 방지)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  // Content-Security-Policy header for the renderer
  try {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api-free.deepl.com https://api.deepl.com https://api.mymemory.translated.net https://api.github.com https://huggingface.co",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      responseHeaders['Content-Security-Policy'] = [csp];
      callback({ responseHeaders });
    });
  } catch (cspError) {
    console.log('[Security] Failed to register CSP header:', cspError.message);
  }

  const { shell: windowShell } = require('electron');

  // Block window.open and external navigation to anything outside an allow list
  const ALLOWED_EXTERNAL_HOSTS = new Set([
    'github.com',
    'api.github.com',
    'huggingface.co',
    'platform.openai.com',
    'openai.com',
    'ai.google.dev',
    'aistudio.google.com',
    'deepl.com',
    'www.deepl.com',
  ]);
  const isAllowedExternalUrl = (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') return false;
      return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (_err) {
      return false;
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      windowShell.openExternal(url);
    } else {
      console.warn('[Security] Blocked window.open for non-allowlisted URL:', url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) {
        windowShell.openExternal(url);
      } else {
        console.warn('[Security] Blocked navigation to:', url);
      }
    }
  });

  mainWindow.loadFile('index.html');

  // DOM이 완전히 로드된 후 업데이트 체크 (main → renderer 직접 실행)
  mainWindow.webContents.on('did-finish-load', async () => {
    console.log('[Update] Page loaded, checking for updates...');
    // renderer.js 초기화 대기
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const result = await checkForUpdates();
      if (result && result.hasUpdate) {
        console.log('[Update] New version found:', result.latestVersion);
        // Push update info via IPC instead of injecting JS into the renderer
        try {
          mainWindow.webContents.send('update-available', {
            hasUpdate: true,
            latestVersion: result.latestVersion,
            releaseUrl: result.releaseUrl,
            releaseName: result.releaseName,
          });
        } catch (sendErr) {
          console.error('[Update] Failed to send update info:', sendErr.message);
        }
      } else {
        console.log('[Update] No update available');
      }
    } catch (error) {
      console.error('[Update] Auto-check failed:', error.message);
    }
  });

  // 개발 모드에서 캐시 비활성화 (파일 변경 즉시 반영)
  mainWindow.webContents.session.clearCache();

  // F12 개발자 도구 (배포 버전: 비활성화)
  // 개발 시에만 아래 코드 주석 해제
  // mainWindow.webContents.on('before-input-event', (event, input) => {
  //     if (input.key === 'F12') {
  //         mainWindow.webContents.toggleDevTools();
  //     }
  // });

  // Translator에 mainWindow 설정 (UI 업데이트용)
  translator.setMainWindow(mainWindow);

  // 기본 메뉴 제거 (File/Edit/View/Window/Help 등)
  try {
    Menu.setApplicationMenu(null);
  } catch (error) {
    console.log('[Menu] Failed to remove application menu:', error.message);
  }
  try {
    mainWindow.setMenuBarVisibility(false);
  } catch (error) {
    console.log('[Menu] Failed to hide menu bar:', error.message);
  }

  // 개발자 도구 오픈 비활성화 (F12/단축키)
  // 필요 시 개발 빌드에서만 활성화하도록 별도 환경변수로 제어 가능

  // 웹콘텐츠 기본 우클릭 메뉴 차단 (Inspect / Reload 등이 드러나지 않게)
  try {
    mainWindow.webContents.on('context-menu', (e) => {
      e.preventDefault();
    });
  } catch (_) {}

  // 렌더러가 죽으면(예: 추출 직후 후처리 중 미처리 예외) 창이 조용히 닫히는 대신
  // 원인을 errors.log에 남기고 렌더러를 자동 복구한다. (정상 종료/사용자 닫기는 제외)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    console.error('[render-process-gone]', JSON.stringify(details));
    try {
      errLogger.logError('main:render-process-gone', reason, details);
    } catch (_) {}
    // clean-exit(정상 종료) 는 복구 대상 아님
    if (reason === 'clean-exit' || reason === 'killed') return;

    // 고아 whisper-cli 자식 프로세스가 남아 돌지 않도록 정리
    try {
      if (currentProcess && !currentProcess.killed) currentProcess.kill('SIGKILL');
    } catch (_) {}

    // 결정론적 크래시(불량 preload/렌더러 init 예외 등)에서 reload→크래시 무한루프 방지:
    // 최근 30초 내 reload가 3회 이상이면 자동 복구를 멈추고 안내 다이얼로그를 띄운다.
    const now = Date.now();
    rendererReloadTimes = rendererReloadTimes.filter((t) => now - t < 30000);
    rendererReloadTimes.push(now);
    if (rendererReloadTimes.length > 3) {
      try {
        dialog.showErrorBox(
          'WhisperSubTranslate',
          'The app window crashed repeatedly and auto-recovery was stopped.\n' +
            `Reason: ${reason}\n\n` +
            'Please restart the app. Details were written to errors.log.'
        );
      } catch (_) {}
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.reload();
      } catch (_) {}
    }
  });

  mainWindow.on('closed', () => {
    forceMemoryCleanup('cuda');
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (app.isPackaged === false) {
    app.commandLine.appendSwitch('js-flags', '--expose-gc');
  }

  // 캐시 완전 삭제 (개발 모드에서만)
  if (!app.isPackaged) {
    try {
      const { session } = require('electron');
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();
      console.log('[Cache] Cleared all cache and storage');
    } catch (e) {
      console.log('[Cache] Failed to clear cache:', e.message);
    }
  }

  createWindow();
  // 자동 업데이트 체크 (배포 환경에서만 적용 가능)
  try {
    if (autoUpdater) {
      autoUpdater.autoDownload = true;
      autoUpdater.checkForUpdatesAndNotify();
    }
  } catch (error) {
    console.log('[Auto-Updater] Update check failed:', error.message);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// GPU/유틸리티 자식 프로세스가 죽으면 로그만 남긴다(앜 수 없이 창이 닫힐 때 진단용).
app.on('child-process-gone', (_event, details) => {
  if (details?.reason && details.reason !== 'clean-exit') {
    console.error('[child-process-gone]', JSON.stringify(details));
    try {
      errLogger.logError('main:child-process-gone', `${details.type}:${details.reason}`, details);
    } catch (_) {}
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ===== Safe Temp Directory (유니코드 경로 문제 해결) =====
// spawn()으로 whisper-cli 호출 시 유니코드 경로가 깨지는 문제 해결
// WAV/SRT를 ASCII 경로에 생성 후 원본 위치로 복사
function getSafeTempDir() {
  // 1순위: 앱 실행 경로 내 temp (대부분 영어 경로)
  const basePath = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const appTemp = path.join(basePath, 'temp');

  // ASCII 문자만 있는지 체크 (유니코드 없으면 안전)
  if (/^[\x00-\x7F]*$/.test(appTemp)) {
    if (!fs.existsSync(appTemp)) {
      fs.mkdirSync(appTemp, { recursive: true });
    }
    return appTemp;
  }

  // 2순위: 플랫폼별 안전한 fallback 경로
  let fallbackTemp;
  if (process.platform === 'win32') {
    fallbackTemp = path.join('C:', 'Users', 'Public', 'WhisperSubTranslate', 'temp');
  } else {
    fallbackTemp = path.join(os.tmpdir(), 'WhisperSubTranslate', 'temp');
  }
  if (!fs.existsSync(fallbackTemp)) {
    fs.mkdirSync(fallbackTemp, { recursive: true });
  }
  return fallbackTemp;
}

// 경로가 ASCII만 포함하는지 체크
function isAsciiPath(filePath) {
  return /^[\x00-\x7F]*$/.test(filePath);
}

// ===== Long Audio Splitting (장시간 오디오 분할 처리) =====
const SEGMENT_DURATION = 30 * 60; // 30분 (초)
const OVERLAP_DURATION = 5; // 5초 오버랩 (경계 자막 누락 방지)

// 영상/오디오 길이 확인 (ffprobe 사용)
function getMediaDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    let ffprobePath = 'ffprobe';

    // ffprobe 경로 설정 (우선순위: ffprobe-static > 로컬 파일 > 시스템 PATH)
    if (ffprobeStaticPath && fs.existsSync(ffprobeStaticPath)) {
      ffprobePath = ffprobeStaticPath;
      console.log('[Media] Using ffprobe-static');
    } else {
      const localFfprobe = path.join(basePath, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      if (fs.existsSync(localFfprobe)) {
        ffprobePath = localFfprobe;
        console.log('[Media] Using local ffprobe');
      } else {
        console.log('[Media] Using system PATH ffprobe');
      }
    }

    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ];

    const proc = spawn(ffprobePath, args, { windowsHide: true });
    let output = '';

    const probeTimeout = setTimeout(() => {
      if (proc && !proc.killed) {
        console.log('[Media] ffprobe timeout, proceeding without split');
        proc.kill('SIGKILL');
      }
    }, 30000);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(probeTimeout);
      if (code === 0) {
        const duration = parseFloat(output.trim());
        if (!isNaN(duration)) {
          console.log(`[Media] Duration: ${duration.toFixed(1)}s (${(duration / 60).toFixed(1)} min)`);
          resolve(duration);
        } else {
          reject(new Error('Failed to parse duration'));
        }
      } else {
        // ffprobe 실패 시 분할 없이 진행
        console.log('[Media] ffprobe failed, proceeding without split');
        resolve(0);
      }
    });

    proc.on('error', () => {
      clearTimeout(probeTimeout);
      console.log('[Media] ffprobe not found, proceeding without split');
      resolve(0);
    });
  });
}

// 오디오를 여러 세그먼트로 분할
async function splitAudioToSegments(wavPath, duration) {
  const segments = [];
  const safeTempDir = getSafeTempDir();

  // 분할이 필요 없으면 원본 반환
  if (duration <= SEGMENT_DURATION + 60) {
    // 31분 이하면 분할 안 함
    return [{ path: wavPath, startTime: 0, isOriginal: true }];
  }

  console.log(`[Split] Splitting ${(duration / 60).toFixed(1)} min audio into segments...`);
  mainWindow.webContents.send('output-update', `Splitting long audio into segments for stable processing...\n`);

  const basePath = app.isPackaged ? process.resourcesPath : __dirname;
  let ffmpegPath = ffmpegStaticPath || 'ffmpeg';
  const localFfmpeg = path.join(basePath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(localFfmpeg)) {
    ffmpegPath = localFfmpeg;
  }

  let currentStart = 0;
  let segmentIndex = 0;

  while (currentStart < duration) {
    const segmentPath = path.join(safeTempDir, `segment_${Date.now()}_${segmentIndex}.wav`);
    const segmentDuration = Math.min(SEGMENT_DURATION + OVERLAP_DURATION, duration - currentStart);

    try {
      await new Promise((res, rej) => {
        const args = [
          '-y',
          '-ss',
          currentStart.toString(),
          '-i',
          wavPath,
          '-t',
          segmentDuration.toString(),
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          segmentPath,
        ];

        const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(segmentPath)) {
            res();
          } else {
            rej(new Error(`Segment ${segmentIndex} creation failed`));
          }
        });

        proc.on('error', rej);
      });

      segments.push({
        path: segmentPath,
        startTime: currentStart,
        isOriginal: false,
      });

      console.log(`[Split] Created segment ${segmentIndex + 1}: ${currentStart}s - ${currentStart + segmentDuration}s`);
      mainWindow.webContents.send(
        'output-update',
        `Created segment ${segmentIndex + 1}/${Math.ceil(duration / SEGMENT_DURATION)}\n`
      );

      segmentIndex++;
      currentStart += SEGMENT_DURATION; // 다음 세그먼트 시작 (오버랩 포함)
    } catch (err) {
      // 분할 실패 시 이미 생성된 세그먼트 정리 후 원본으로 진행
      console.error('[Split] Segment creation failed:', err.message);
      for (const seg of segments) {
        try {
          fs.unlinkSync(seg.path);
        } catch (_e) {
          /* ignore */
        }
      }
      return [{ path: wavPath, startTime: 0, isOriginal: true }];
    }
  }

  console.log(`[Split] Created ${segments.length} segments`);
  return segments;
}

// SRT 타임스탬프 조정 (오프셋 추가)
function adjustSrtTimestamps(srtContent, offsetSeconds) {
  if (offsetSeconds === 0) return srtContent;

  const lines = srtContent.split('\n');
  const result = [];

  // SRT 타임스탬프 형식: 00:00:00,000 --> 00:00:00,000
  const timestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/;

  for (const line of lines) {
    const match = line.match(timestampRegex);
    if (match) {
      const startMs =
        (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000 + parseInt(match[4]);
      const endMs =
        (parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7])) * 1000 + parseInt(match[8]);

      const newStartMs = startMs + offsetSeconds * 1000;
      const newEndMs = endMs + offsetSeconds * 1000;

      const formatTime = (ms) => {
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        const millis = ms % 1000;
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
      };

      result.push(`${formatTime(newStartMs)} --> ${formatTime(newEndMs)}`);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

// 여러 SRT 파일 합치기 (중복 제거 포함)
function mergeSrtFiles(srtContents, startTimes) {
  const allEntries = [];

  for (let i = 0; i < srtContents.length; i++) {
    const content = srtContents[i];
    const offsetSeconds = startTimes[i];
    const adjustedContent = adjustSrtTimestamps(content, offsetSeconds);

    // SRT 엔트리 파싱
    const entries = parseSrtEntries(adjustedContent);
    allEntries.push(...entries);
  }

  // 시작 시간 기준 정렬
  allEntries.sort((a, b) => a.startMs - b.startMs);

  // 중복 제거 (오버랩 구간에서 같은 자막이 양쪽 세그먼트에 중복 인식됨)
  // 시간 + 텍스트 유사도 모두 확인하여 실제 다른 대사는 보존
  const uniqueEntries = [];
  for (const entry of allEntries) {
    const isDuplicate = uniqueEntries.some((existing) => {
      if (Math.abs(existing.startMs - entry.startMs) >= 1500) return false;
      const a = existing.text.trim().toLowerCase();
      const b = entry.text.trim().toLowerCase();
      if (!a || !b) return false;
      if (a === b) return true;
      // 길이 비율이 비슷하고(±30%) 한쪽이 다른쪽을 포함하면 중복
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ratio < 0.7) return false;
      const shorter = a.length < b.length ? a : b;
      const longer = a.length < b.length ? b : a;
      return longer.includes(shorter);
    });
    if (!isDuplicate) {
      uniqueEntries.push(entry);
    }
  }

  // SRT 형식으로 재생성
  let result = '';
  for (let i = 0; i < uniqueEntries.length; i++) {
    const entry = uniqueEntries[i];
    result += `${i + 1}\n`;
    result += `${entry.timestamp}\n`;
    result += `${entry.text}\n\n`;
  }

  return result.trim();
}

// SRT 엔트리 파싱 헬퍼
function parseSrtEntries(srtContent) {
  const entries = [];
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length >= 3) {
      const timestampLine = lines[1];
      const timestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/;
      const match = timestampLine.match(timestampRegex);

      if (match) {
        const startMs =
          (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000 + parseInt(match[4]);
        const text = lines.slice(2).join('\n');

        entries.push({
          startMs,
          timestamp: timestampLine,
          text,
        });
      }
    }
  }

  return entries;
}

// 단일 세그먼트 처리 (분할 처리용)
function processSegment(segmentPath, modelPath, device, language, whisperDir, exePath, onProgress) {
  return new Promise((resolve, reject) => {
    const safeTempDir = getSafeTempDir();
    const tempBaseName = `segment_out_${Date.now()}`;
    const outputBase = path.join(safeTempDir, tempBaseName);
    const srtPath = outputBase + '.srt';

    const args = [
      '-m',
      modelPath,
      '-f',
      segmentPath,
      '-osrt',
      '-of',
      outputBase,
      ...getWhisperCppSettings(device),
      ...getWhisperVadArgs(),
    ];

    if (language && language !== 'auto') {
      args.push('-l', language);
    } else {
      args.push('-l', 'auto');
    }

    console.log(`[Segment] Processing: ${path.basename(segmentPath)}`);

    const spawnEnv = getWhisperSpawnEnv(device, whisperDir);
    const proc = spawn(exePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: whisperDir,
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });
    currentProcess = proc;

    const segTimeout = setTimeout(() => {
      if (proc && !proc.killed) {
        console.log(`[Segment TIMEOUT] ${path.basename(segmentPath)} - exceeded 30 min`);
        proc.kill('SIGKILL');
      }
    }, 1800000);

    proc.stdout.on('data', (data) => {
      mainWindow.webContents.send('output-update', data.toString('utf8'));
    });

    proc.stderr.on('data', (data) => {
      const output = data.toString('utf8');
      const pct = parseWhisperProgress(output);
      if (pct != null && typeof onProgress === 'function') onProgress(pct);
      const cleaned = stripProgressLines(output);
      if (!cleaned.trim()) return; // 진행률 라인만 있던 청크는 로그에 미표시
      if (cleaned.includes('error') || cleaned.includes('Error')) {
        mainWindow.webContents.send('output-update', '[ERROR] ' + cleaned);
      } else {
        mainWindow.webContents.send('output-update', cleaned);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(segTimeout);
      if (isUserStopped) {
        return reject(new Error('Stopped by user'));
      }
      if ((code === 0 || fs.existsSync(srtPath)) && fs.existsSync(srtPath)) {
        try {
          const content = fs.readFileSync(srtPath, 'utf-8');
          // 임시 SRT 파일 삭제
          try {
            fs.unlinkSync(srtPath);
          } catch (_e) {
            /* ignore */
          }
          resolve(content);
        } catch (err) {
          reject(new Error(`Failed to read segment SRT: ${err.message}`));
        }
      } else {
        let segError = `Segment processing failed (code: ${code})`;
        if (code === 127 && process.platform !== 'win32') {
          segError +=
            '. Required shared libraries (.so) not found. ' +
            'Ensure libwhisper.so and libggml*.so are in whisper-cpp/ folder.';
        }
        reject(new Error(segError));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(segTimeout);
      reject(err);
    });
  });
}

// ===== Audio Conversion Helper (오디오 변환 헬퍼) =====
// 유니코드 경로 문제 해결: 안전한 temp 경로에 WAV 생성
function convertToWav(inputPath) {
  return new Promise((resolve, reject) => {
    // 원본 경로가 ASCII인지 확인
    const originalWavPath = inputPath.replace(/\.[^/.]+$/, '.wav');
    let wavPath;
    let usingSafeTemp = false;

    if (isAsciiPath(inputPath)) {
      // ASCII 경로면 원본 위치에 생성
      wavPath = originalWavPath;
    } else {
      // 유니코드 경로면 안전한 temp에 생성
      const safeTempDir = getSafeTempDir();
      wavPath = path.join(safeTempDir, `whisper_${Date.now()}.wav`);
      usingSafeTemp = true;
      console.log(`[Audio] Unicode path detected, using safe temp: ${wavPath}`);
    }

    // WAV 파일이 이미 존재하면 스킵 (원본 위치만 체크)
    if (!usingSafeTemp && fs.existsSync(wavPath)) {
      console.log(`[Audio] WAV already exists: ${path.basename(wavPath)}`);
      resolve({ wavPath, usingSafeTemp, originalWavPath });
      return;
    }

    // 입력 미디어 경로 자체도 비ASCII면 ffmpeg에 바로 넘기지 않고
    // safe temp에 하드링크해서 전달한다 (hardlink 실패 시 copyFile fallback).
    // 한글/일본어/중국어 Windows 계정에서 ffmpeg argv 인코딩 이슈 회피.
    let ffmpegInputPath = inputPath;
    let stagedInputPath = null;
    if (!isAsciiPath(inputPath)) {
      const safeTempDir = getSafeTempDir();
      const ext = path.extname(inputPath) || '.bin';
      const staged = path.join(safeTempDir, `input_${Date.now()}${ext}`);
      let staged_ok = false;
      try {
        fs.linkSync(inputPath, staged); // 동일 볼륨 NTFS면 즉시, 용량 추가 없음
        staged_ok = true;
        console.log(`[Audio] Unicode input hardlinked: ${staged}`);
      } catch (_linkErr) {
        try {
          fs.copyFileSync(inputPath, staged); // 크로스볼륨 fallback
          staged_ok = true;
          console.log(`[Audio] Unicode input copied (cross-volume fallback): ${staged}`);
        } catch (copyErr) {
          console.warn(`[Audio] Unicode input staging failed (${copyErr.message}), passing original path`);
        }
      }
      if (staged_ok) {
        ffmpegInputPath = staged;
        stagedInputPath = staged;
      }
    }

    console.log(`[Audio] Converting to WAV: ${path.basename(inputPath)}`);
    mainWindow.webContents.send('output-update', `Converting audio to WAV format...\n`);

    // ffmpeg 경로 설정 (우선순위: ffmpeg-static > 로컬 파일 > 시스템 PATH)
    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    let ffmpegPath = 'ffmpeg'; // 기본: 시스템 PATH에서 찾기

    // 1. ffmpeg-static npm 패키지 사용 (가장 우선)
    if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
      ffmpegPath = ffmpegStaticPath;
      console.log('[Audio] Using ffmpeg-static');
    }
    // 2. 프로젝트 내 ffmpeg 확인 (배포판용)
    else {
      const localFfmpeg = path.join(basePath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (fs.existsSync(localFfmpeg)) {
        ffmpegPath = localFfmpeg;
        console.log('[Audio] Using local ffmpeg');
      } else {
        console.log('[Audio] Using system PATH ffmpeg');
      }
    }

    // staged 입력 정리 헬퍼 (성공/실패/중지 경로 모두에서 호출)
    const cleanupStagedInput = () => {
      if (stagedInputPath && fs.existsSync(stagedInputPath)) {
        try {
          fs.unlinkSync(stagedInputPath);
        } catch (_e) {
          /* ignore */
        }
      }
    };

    const ffmpegArgs = [
      '-y', // 덮어쓰기
      '-i',
      ffmpegInputPath, // 입력 파일 (ASCII 보장)
      '-ar',
      '16000', // 16kHz (Whisper 요구사항)
      '-ac',
      '1', // 모노
      '-c:a',
      'pcm_s16le', // 16-bit PCM
      wavPath,
    ];

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentProcess = ffmpegProcess;

    let ffmpegStderrTail = '';
    ffmpegProcess.stderr.on('data', (data) => {
      // ffmpeg는 진행 정보를 stderr로 출력
      const output = data.toString();
      // 디버그용 마지막 8KB 유지
      ffmpegStderrTail = (ffmpegStderrTail + output).slice(-8192);
      if (output.includes('time=')) {
        const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          mainWindow.webContents.send('output-update', `Audio conversion: ${timeMatch[1]}\r`);
        }
      }
    });

    ffmpegProcess.on('close', (code) => {
      currentProcess = null;
      // ffmpeg 종료 시점에서는 입력 파일이 더 이상 필요 없으므로
      // 하드링크/채 복사본이 있으면 정리.
      cleanupStagedInput();
      if (isUserStopped) {
        // 임시 WAV 정리
        if (usingSafeTemp && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch (_e) {
            /* ignore */
          }
        }
        return reject(new Error('Stopped by user'));
      }
      if (code === 0 && fs.existsSync(wavPath)) {
        console.log(`[Audio] WAV conversion successful: ${path.basename(wavPath)}`);
        mainWindow.webContents.send('output-update', `Audio conversion completed.\n`);
        resolve({ wavPath, usingSafeTemp, originalWavPath });
      } else {
        const msg = `Audio conversion failed (code: ${code})`;
        try {
          errLogger.logError('ffmpeg', `${msg} input=${path.basename(inputPath)}\nstderr-tail:\n${ffmpegStderrTail}`);
        } catch (_) {}
        reject(new Error(msg));
      }
    });

    ffmpegProcess.on('error', (err) => {
      cleanupStagedInput();
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            '[ERROR] ffmpeg not found!\n' +
              'Please install ffmpeg and add it to your PATH.\n' +
              (process.platform === 'win32'
                ? 'Or place ffmpeg.exe in the project folder.\n\n'
                : 'Install: sudo apt install ffmpeg (Ubuntu/Debian) or brew install ffmpeg (macOS)\n\n') +
              'Download: https://ffmpeg.org/download.html'
          )
        );
      } else {
        reject(err);
      }
    });
  });
}

// ===== GGML Model Path Helper (GGML 모델 경로 헬퍼) =====
// 쓰기 권한 있는 userData/_models로 고정 (Program Files 권한 문제 회피).
// 단, 사용자 계정이 한글/일본어/중국어 등 비ASCII면 userData 경로에도
// 유니코드가 섯여 있어 whisper-cli에 -m으로 전달될 때 경로가 깨진다.
// 이 경우 ASCII 경로 (C:\Users\Public\WhisperSubTranslate\_models)로 폴백한다. (issue #22)
function getGgmlModelsDir() {
  const primary = path.join(app.getPath('userData'), '_models');
  if (process.platform !== 'win32' || isAsciiPath(primary)) {
    return primary;
  }
  const fallback = path.join('C:', 'Users', 'Public', 'WhisperSubTranslate', '_models');
  try {
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  } catch (_e) {
    return primary;
  }
  return fallback;
}

function getGgmlModelPath(model) {
  const modelsDir = getGgmlModelsDir();

  // 모델 이름 매핑 (whisper.cpp GGML 형식)
  const modelMap = {
    tiny: 'ggml-tiny.bin',
    base: 'ggml-base.bin',
    small: 'ggml-small.bin',
    medium: 'ggml-medium.bin',
    large: 'ggml-large.bin',
    'large-v2': 'ggml-large-v2.bin',
    'large-v3': 'ggml-large-v3.bin',
    'large-v3-turbo': 'ggml-large-v3-turbo.bin',
  };

  const modelFile = modelMap[model] || `ggml-${model}.bin`;
  return path.join(modelsDir, modelFile);
}

// ===== whisper.cpp Settings (whisper.cpp 최적 설정) =====
function getWhisperCppSettings(device) {
  const totalMemory = os.totalmem() / (1024 * 1024 * 1024); // GB
  const cpuCores = os.cpus().length;

  console.log(`[System Info] RAM: ${totalMemory.toFixed(1)}GB, CPU Cores: ${cpuCores}`);

  // whisper.cpp 공통 설정: 밀리초 타임스탬프를 위한 핵심 옵션
  const baseSettings = [
    '-bs',
    '5', // beam size
    '-bo',
    '5', // best of
    // -sns: 비음성(non-speech) 토큰 억제. 음악/효과음 구간에서 영어 가사 등을
    //       환각으로 토해내는 현상을 줄임. 컨텍스트 일관성 손해가 없어 상시 적용.
    '-sns',
    // -pp: 실시간 진행률(progress = N%)을 stderr로 출력. 가짜 50% 대신 실제 진행률 표시용.
    '-pp',
  ];

  // ── 세그먼트 분할 정책 ──
  // naturalSegmentation OFF(구판)일 때만 -ml 50 -sow로 50자 단위 강제 분할.
  // (참고: -ml은 세그먼트 최대 길이일 뿐 타임스탬프 정밀도와 무관하다. whisper.cpp는
  //  -ml 유무와 상관없이 ms 타임스탬프를 출력한다. 짧은 강제 분할은 코드스위칭 영어
  //  단어를 깨뜨리고 문장을 토막내 번역 품질을 떨어뜨리므로 기본 OFF.)
  if (!naturalSegmentation) {
    baseSettings.unshift('-ml', '50', '-sow');
  }

  // ── 반복/환각 억제 (토글, 기본 ON) ──
  // -mc 0: 직전 텍스트 컨텍스트를 다음 세그먼트로 끌고 가지 않음. whisper.cpp 기본값
  // (-1=전체 유지)이 무음·음악 구간의 반복 루프 주원인이라 0으로 끊는다.
  // (openai-whisper의 condition_on_previous_text=False 와 동일) 귫c면 whisper 기본(-1) 사용.
  if (reduceRepetition) {
    baseSettings.push('-mc', '0');
  }

  if (device === 'cuda') {
    console.log('[Performance] GPU settings applied');
    return [
      ...baseSettings,
      '-t',
      Math.min(cpuCores, 4).toString(), // 스레드 수
    ];
  } else {
    // CPU 설정
    const threads = Math.max(1, Math.min(cpuCores - 1, 8));
    console.log(`[Performance] CPU settings applied (${threads} threads)`);
    return [
      ...baseSettings,
      '-t',
      threads.toString(),
      '-ng', // no GPU
    ];
  }
}

// whisper -pp stderr 청크에서 진행률(0~100) 추출. 없으면 null.
function parseWhisperProgress(text) {
  const m = /progress\s*=\s*(\d+)\s*%/i.exec(text);
  if (!m) return null;
  return Math.max(0, Math.min(100, parseInt(m[1], 10)));
}

// 추출 전체 진행률(0~100)을 렌더러로 전송. 렌더러가 추출 구간 범위(0..max)로 매핑.
function sendExtractionProgress(percent) {
  try {
    mainWindow?.webContents?.send('progress-update', {
      stage: 'extracting',
      percent: Math.max(0, Math.min(100, Math.round(percent))),
    });
  } catch (_e) {
    /* ignore */
  }
}

// stderr 청크에서 진행률 라인(whisper_print_progress_callback)을 제거 → 로그 스팸 방지.
function stripProgressLines(text) {
  return text.replace(/.*whisper_print_progress_callback:.*\r?\n?/g, '');
}

// ===== VAD (Voice Activity Detection) =====
// reduceRepetition 토글이 켜져 있고 silero 모델이 존재하면, 말소리 구간만 처리하도록
// --vad 인자를 돌려준다. 이것이 무음/음악 구간의 반복·환각을 원천 차단하는 핵심이다.
// 모델이 없으면(설치 전/다운로드 실패) 빈 배열 → 추출은 그대로 동작(우아한 degrade).
// -vt 0.3: 임계값(낮을수록 더 많은 소리를 음성으로 인정). 실측상 0.3이 진짜 대사는
//          보존하면서 환각 구간은 제거하는 균형점. -vsd 200: 200ms 이상 무음에서 분할.
//          -vp 100: 분할 경계에 100ms 패딩(단어 끝 잘림 방지).
function getWhisperVadArgs() {
  if (!reduceRepetition) return [];
  const basePath = app.isPackaged ? process.resourcesPath : __dirname;
  const vadModel = path.join(basePath, 'whisper-cpp', VAD_MODEL_NAME);
  if (!fs.existsSync(vadModel)) {
    console.log('[VAD] silero model not found, skipping VAD:', vadModel);
    return [];
  }
  console.log('[VAD] enabled (speech-only processing):', vadModel);
  return ['--vad', '--vad-model', vadModel, '-vt', '0.3', '-vsd', '200', '-vp', '100'];
}

// Single File Subtitle Extraction (Promise-based) - whisper.cpp 버전
function extractSingleFile(filePath, model, language, device) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[START] Processing: ${path.basename(filePath)}`);
      isUserStopped = false;

      // Force cleanup before each file
      await forceMemoryCleanup(device, true);

      // 실제 사용할 장치 결정
      const chosenDevice = resolveDevice(device);
      const gpuInfo = getGpuInfo();

      if (device === 'auto') {
        const line = `Auto device: using ${chosenDevice.toUpperCase()}`;
        console.log(line);
        mainWindow.webContents.send('output-update', `${line}\n`);
      } else if (device === 'cuda' && chosenDevice !== 'cuda') {
        const line = 'GPU not available, falling back to CPU';
        console.log(line);
        mainWindow.webContents.send('output-update', `${line}\n`);
      }

      // GPU가 있지만 CUDA 12 미지원인 경우 안내 (배치에서 1회만)
      if (gpuInfo.available && !gpuInfo.cudaCompatible && !_gpuWarningShown) {
        _gpuWarningShown = true;
        const warn = `[GPU] ${gpuInfo.name} (Compute ${gpuInfo.computeCap}) - CUDA 12 requires Compute 5.0+. Auto CPU mode.`;
        console.log(warn);
        mainWindow.webContents.send('output-update', warn + '\n');
      }

      const basePath = app.isPackaged ? process.resourcesPath : __dirname;

      // whisper.cpp 실행 파일 경로
      const whisperDir = path.join(basePath, 'whisper-cpp');
      const cpuDir = path.join(whisperDir, 'cpu');
      const cpuExePath = path.join(cpuDir, WHISPER_CLI_NAME);
      // CPU 모드일 때 CPU 전용 바이너리 우선 사용 (CUDA DLL 의존성 없음).
      // 단, whisper-cli.exe만 있고 의존 DLL(whisper.dll, ggml*.dll)이 빠진
      // 깨진 설치(issue #26)에서는 spawn이 ENOENT로 실패하므로, Windows에서는
      // 의존 DLL 존재 여부도 확인해 폴백 처리한다.
      let cpuBuildUsable = chosenDevice !== 'cuda' && fs.existsSync(cpuExePath);
      if (cpuBuildUsable && process.platform === 'win32') {
        const cpuRuntimeProbe = path.join(cpuDir, 'whisper.dll');
        if (!fs.existsSync(cpuRuntimeProbe)) {
          console.warn(
            '[Whisper] cpu/whisper-cli.exe found but cpu/whisper.dll is missing - ' +
              'CPU build is incomplete, falling back to top-level binary.'
          );
          cpuBuildUsable = false;
        }
      }
      const useCpuBuild = cpuBuildUsable;
      const exePath = useCpuBuild ? cpuExePath : path.join(whisperDir, WHISPER_CLI_NAME);
      const exeCwd = useCpuBuild ? cpuDir : whisperDir;
      console.log(
        `[Whisper] Using: ${useCpuBuild ? 'cpu/' + WHISPER_CLI_NAME + ' (CPU build)' : WHISPER_CLI_NAME + ' (CUDA build)'} (${chosenDevice})`
      );

      // WAV 변환 (whisper.cpp는 WAV만 지원)
      let wavPath,
        usingSafeTemp = false;
      try {
        const wavResult = await convertToWav(filePath);
        wavPath = wavResult.wavPath;
        usingSafeTemp = wavResult.usingSafeTemp;
        // originalWavPath available in wavResult if needed
      } catch (convErr) {
        return reject(convErr);
      }

      // WAV 변환 후 사용자 중지 체크
      if (isUserStopped) {
        if (usingSafeTemp && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch (_e) {
            /* ignore */
          }
        }
        return reject(new Error('Stopped by user'));
      }

      // 모델 경로 (분할 처리에서도 필요하므로 먼저 선언)
      const modelPath = getGgmlModelPath(model);
      if (!fs.existsSync(modelPath)) {
        return reject(
          new Error(
            `[ERROR] Model not found: ${model}\n` +
              `Expected path: ${modelPath}\n\n` +
              `Please download the GGML model file.`
          )
        );
      }

      // 영상 길이 확인 및 분할 처리 결정
      let segments = [];
      let useSegmentedProcessing = false;
      try {
        const duration = await getMediaDuration(wavPath);
        if (duration > SEGMENT_DURATION + 60) {
          // 31분 이상이면 분할
          segments = await splitAudioToSegments(wavPath, duration);
          useSegmentedProcessing = segments.length > 1;
          if (useSegmentedProcessing) {
            console.log(`[Split] Will process ${segments.length} segments for ${(duration / 60).toFixed(1)} min audio`);
          }
        }
      } catch (err) {
        console.log('[Split] Duration check failed, proceeding without split:', err.message);
      }

      // 분할 처리가 필요하면 각 세그먼트 처리 후 합치기
      if (useSegmentedProcessing) {
        try {
          const srtContents = [];
          const startTimes = [];

          for (let i = 0; i < segments.length; i++) {
            // 세그먼트 간 사용자 중지 체크
            if (isUserStopped) {
              for (const seg of segments) {
                if (!seg.isOriginal && fs.existsSync(seg.path)) {
                  try {
                    fs.unlinkSync(seg.path);
                  } catch (_e) {
                    /* ignore */
                  }
                }
              }
              return reject(new Error('Stopped by user'));
            }

            const segment = segments[i];
            mainWindow.webContents.send('output-update', `\n=== Processing segment ${i + 1}/${segments.length} ===\n`);

            // 각 세그먼트에 대해 whisper.cpp 실행
            const segmentSrt = await processSegment(
              segment.path,
              modelPath,
              chosenDevice,
              language,
              exeCwd,
              exePath,
              // 세그먼트 N개 중 i번째: 전체 진행률 = (완료 세그먼트 + 현재 세그먼트 진행률)/전체
              (segPct) => sendExtractionProgress(((i + segPct / 100) / segments.length) * 100)
            );
            currentProcess = null;
            srtContents.push(segmentSrt);
            startTimes.push(segment.startTime);

            // 세그먼트 임시 파일 정리
            if (!segment.isOriginal && fs.existsSync(segment.path)) {
              try {
                fs.unlinkSync(segment.path);
              } catch (_e) {
                /* ignore */
              }
            }

            // 메모리 정리
            await forceMemoryCleanup(chosenDevice, true);

            // GPU 모드면 잠시 대기
            if (chosenDevice === 'cuda' && i < segments.length - 1) {
              mainWindow.webContents.send('output-update', `Cleaning memory before next segment...\n`);
              await new Promise((r) => setTimeout(r, 5000));
            }
          }

          // SRT 합치기
          mainWindow.webContents.send('output-update', `\nMerging ${segments.length} subtitle segments...\n`);
          const mergedSrt = mergeSrtFiles(srtContents, startTimes);

          // 최종 SRT 파일 저장
          const originalSrtPath = filePath.replace(/\.[^/.]+$/, '.srt');
          fs.writeFileSync(originalSrtPath, mergedSrt, 'utf-8');
          console.log(`[Split] Merged SRT saved: ${originalSrtPath}`);
          mainWindow.webContents.send('output-update', `Subtitle merge completed!\n`);

          // WAV 임시 파일 정리
          if (wavPath !== filePath && fs.existsSync(wavPath)) {
            try {
              fs.unlinkSync(wavPath);
            } catch (_e) {
              /* ignore */
            }
          }

          return resolve(originalSrtPath);
        } catch (segErr) {
          // 분할 처리 실패 시 원본 방식으로 재시도
          console.error('[Split] Segmented processing failed:', segErr.message);
          mainWindow.webContents.send('output-update', `Segmented processing failed, trying standard method...\n`);
          // 세그먼트 임시 파일 정리
          for (const seg of segments) {
            if (!seg.isOriginal && fs.existsSync(seg.path)) {
              try {
                fs.unlinkSync(seg.path);
              } catch (_e) {
                /* ignore */
              }
            }
          }
          // 아래 일반 처리로 계속 진행
        }
      }

      // SRT 출력 경로
      // 유니코드 경로면 temp에 생성 후 원본 위치로 복사
      const originalSrtPath = filePath.replace(/\.[^/.]+$/, '.srt');
      let srtPath, outputBase;

      if (usingSafeTemp) {
        // Safe temp 경로에 SRT 생성
        const safeTempDir = getSafeTempDir();
        const tempBaseName = `whisper_${Date.now()}`;
        outputBase = path.join(safeTempDir, tempBaseName);
        srtPath = outputBase + '.srt';
        console.log(`[Unicode] SRT will be generated at: ${srtPath}`);
        console.log(`[Unicode] Will copy to: ${originalSrtPath}`);
      } else {
        // 원본 경로가 ASCII면 직접 생성
        srtPath = originalSrtPath;
        outputBase = filePath.replace(/\.[^/.]+$/, ''); // 확장자 제외
      }

      // whisper.cpp 인자 구성
      const args = [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-osrt', // SRT 출력
        '-of',
        outputBase, // 출력 파일 기본 이름 (확장자 제외)
        ...getWhisperCppSettings(chosenDevice),
        ...getWhisperVadArgs(),
      ];

      // 언어 설정 (whisper.cpp는 'auto' 지원!)
      if (language && language !== 'auto') {
        args.push('-l', language);
      } else {
        args.push('-l', 'auto'); // 자동 감지
        console.log('[Language Detection] Auto-detect enabled');
      }

      console.log(`[EXEC] ${exePath} ${args.join(' ')}`);

      // whisper 실행 직전 사용자 중지 체크
      if (isUserStopped) {
        if (usingSafeTemp && wavPath && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch (_e) {
            /* ignore */
          }
        }
        return reject(new Error('Stopped by user'));
      }

      if (chosenDevice === 'cuda') {
        mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (CUDA, flash-attn)...\n');
        console.log('[GPU Config] whisper.cpp with CUDA acceleration');
      } else {
        mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (CPU mode)...\n');
      }

      const mainSpawnEnv = getWhisperSpawnEnv(chosenDevice, exeCwd);
      currentProcess = spawn(exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: exeCwd,
        ...(mainSpawnEnv ? { env: mainSpawnEnv } : {}),
      });

      // Process timeout handling
      const processTimeout = setTimeout(() => {
        if (currentProcess && !currentProcess.killed) {
          console.log('[TIMEOUT] ' + path.basename(filePath) + ' - exceeded 30 minute limit');
          currentProcess.kill('SIGKILL');
        }
      }, 1800000); // 30 minutes

      currentProcess.stdout.on('data', (data) => {
        const output = data.toString('utf8');
        mainWindow.webContents.send('output-update', output);
      });

      currentProcess.stderr.on('data', (data) => {
        const output = data.toString('utf8');
        // 일반 경로는 whisper -pp %가 곧 파일 전체 진행률 → 그대로 전송
        const pct = parseWhisperProgress(output);
        if (pct != null) sendExtractionProgress(pct);
        const cleaned = stripProgressLines(output);
        if (!cleaned.trim()) return; // 진행률 라인만 있던 청크는 로그에 미표시
        // whisper.cpp는 모델 로딩 정보를 stderr로 출력
        if (cleaned.includes('error') || cleaned.includes('Error') || cleaned.includes('failed')) {
          mainWindow.webContents.send('output-update', '[ERROR] ' + cleaned);
        } else {
          // 모델 정보 등 일반 stderr 출력
          mainWindow.webContents.send('output-update', cleaned);
        }
      });

      currentProcess.on('close', async (code) => {
        clearTimeout(processTimeout); // Clear timeout

        // Enhanced cleanup after each file
        await forceMemoryCleanup(chosenDevice, true);

        // WAV 임시 파일 정리 (원본이 WAV가 아닌 경우)
        if (wavPath !== filePath && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
            console.log(`[Cleanup] Removed temporary WAV: ${path.basename(wavPath)}`);
          } catch (e) {
            console.log(`[Cleanup] Failed to remove WAV: ${e.message}`);
          }
        }

        if (isUserStopped) {
          return reject(new Error('Stopped by user'));
        }

        // Check if SRT file was actually created (real success indicator)
        const srtExists = fs.existsSync(srtPath);

        if (code === 0 || srtExists) {
          let finalSrtPath = srtPath;

          // 유니코드 경로면 temp에서 원본 위치로 복사
          if (usingSafeTemp && srtExists) {
            try {
              fs.copyFileSync(srtPath, originalSrtPath);
              console.log(`[Unicode] Copied SRT to original location: ${originalSrtPath}`);

              // temp SRT 파일 정리
              fs.unlinkSync(srtPath);
              console.log(`[Cleanup] Removed temp SRT: ${srtPath}`);

              finalSrtPath = originalSrtPath;
            } catch (copyErr) {
              console.log(`[Unicode] Failed to copy SRT: ${copyErr.message}`);
              // 복사 실패해도 temp에 있는 SRT는 유효
              mainWindow.webContents.send('output-update', `[Warning] SRT created at temp location: ${srtPath}\n`);
            }
          }

          console.log(
            '[SUCCESS] ' + path.basename(filePath) + ' completed (code: ' + code + ', fileExists: ' + srtExists + ')'
          );
          resolve(finalSrtPath);
        } else {
          let errorMessage = `Error code: ${code}`;
          if (code === 3221225785) {
            // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
            const cpuAvailable = fs.existsSync(cpuExePath);
            if (cpuAvailable) {
              errorMessage =
                'DLL entry point not found (0xC0000139). ' +
                'CUDA DLLs are incompatible with your GPU driver. ' +
                'CPU build is available - please change device to CPU in settings.';
            } else {
              errorMessage =
                'DLL entry point not found (0xC0000139). ' +
                'CUDA DLLs are incompatible with your GPU driver. ' +
                'Please download the CPU-only build and place it in the whisper-cpp/cpu/ folder.\n' +
                `Solution: Download whisper-bin-x64.zip from GitHub, extract ${WHISPER_CLI_NAME} to whisper-cpp/cpu/ folder.`;
            }
          } else if (code === 3221225781) {
            // 0xC0000135 STATUS_DLL_NOT_FOUND (Windows-specific)
            errorMessage =
              'Required DLL not found (0xC0000135). ' +
              'Please install Visual C++ Redistributable 2015-2022 or use CPU-only whisper-cli build.\n' +
              'Download: https://aka.ms/vs/17/release/vc_redist.x64.exe';
          } else if (code === 3221226505) {
            errorMessage = 'GPU memory shortage or driver issue';
          } else if (code === null || code === undefined) {
            errorMessage = 'Process terminated abnormally (possible memory shortage)';
          } else if (code === 1) {
            errorMessage = 'Whisper processing failed (file format or audio issue)';
          } else if (code === 127) {
            if (process.platform !== 'win32') {
              errorMessage =
                `${WHISPER_CLI_NAME} failed to execute (code 127). ` +
                'This usually means required shared libraries (.so) were not found.\n' +
                'Check that libwhisper.so and libggml*.so exist in whisper-cpp/ folder.\n' +
                (chosenDevice === 'cuda'
                  ? 'For CUDA: export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH\n' +
                    'Or rebuild without CUDA: cmake -B build && cmake --build build\n'
                  : '') +
                'Then copy all built files (whisper-cli + *.so) to whisper-cpp/ folder.';
            } else {
              errorMessage = `${WHISPER_CLI_NAME} not found`;
            }
          }
          console.log(`[ERROR] ${path.basename(filePath)} failed: ${errorMessage}`);
          try {
            errLogger.logError(
              'whisper',
              `${path.basename(filePath)} exit=${code} device=${chosenDevice} model=${path.basename(modelPath || '')}: ${errorMessage}`,
              new Error(errorMessage)
            );
          } catch (_) {}
          reject(new Error(errorMessage));
        }
      });

      currentProcess.on('error', async (err) => {
        clearTimeout(processTimeout); // Clear timeout
        await forceMemoryCleanup(chosenDevice, true);

        // ENOENT/EACCES 에러 = whisper-cli 파일 없음 또는 실행 권한 없음
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          // On Windows, ENOENT from spawn() can also mean a dependent DLL
          // failed to load (whisper.dll / ggml*.dll missing) — the binary is
          // present but its runtime libs are not. Hint users about this case.
          const isWin = process.platform === 'win32';
          const errDetail =
            err.code === 'EACCES'
              ? `[ERROR] ${WHISPER_CLI_NAME} permission denied! (EACCES)\n` +
                (!isWin ? `Try: chmod +x "${exePath}"\n\n` : '\n')
              : `[ERROR] ${WHISPER_CLI_NAME} could not be launched!\n` +
                (isWin
                  ? `(Either the file is missing, or a dependent DLL such as whisper.dll / ggml*.dll could not be loaded from the same folder.)\n\n`
                  : `\n`);

          const missingFileError = new Error(
            errDetail +
              'Please download whisper.cpp:\n' +
              '1. Visit: https://github.com/ggml-org/whisper.cpp/releases\n' +
              '2. Download the appropriate build for your platform\n' +
              '3. Extract to project folder under "whisper-cpp" directory\n' +
              '4. Restart the app'
          );

          mainWindow.webContents.send(
            'output-update',
            '\n' +
              '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
              `[ERROR] ${WHISPER_CLI_NAME.toUpperCase()} NOT FOUND\n` +
              '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
              'Download Required:\n' +
              '   https://github.com/ggml-org/whisper.cpp/releases\n\n' +
              'Files to download:\n' +
              (process.platform === 'win32'
                ? '   - whisper-cublas-*.zip (CUDA/GPU)\n' + '   - OR whisper-bin-*.zip (CPU only)\n\n'
                : '   - Build from source: cmake -B build && cmake --build build\n' +
                  '   - OR download pre-built binary for your platform\n\n') +
              'Installation:\n' +
              '   1. Extract or build the binary\n' +
              '   2. Place files into whisper-cpp folder\n' +
              (process.platform !== 'win32' ? `   3. chmod +x whisper-cpp/${WHISPER_CLI_NAME}\n` : '') +
              `   ${process.platform !== 'win32' ? '4' : '3'}. Restart this app\n\n` +
              '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
          );

          reject(missingFileError);
        } else {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// IPC Handler for processing one or more files sequentially
ipcMain.handle('extract-subtitles', async (event, payload) => {
  const { filePaths, filePath, model, language, device, cleanup } = payload;
  // 반복 억제 토글을 whisper 설정에 반영 (undefined=구판 호환을 위해 기본 ON)
  reduceRepetition = payload.reduceRepetition !== false;
  // 자연 문장 단위 전사 토글 (undefined=구판 호환 위해 기본 ON, 번역 품질 향상)
  naturalSegmentation = payload.naturalSegmentation !== false;
  // This now correctly handles both a single `filePath` and an array `filePaths`
  const filesToProcess = filePaths || (filePath ? [filePath] : []);

  if (filesToProcess.length === 0) {
    console.log('No valid files to process.');
    return { success: true };
  }

  let successCount = 0;
  let failCount = 0;
  let userStopped = false;
  const successDetails = [];
  const failureDetails = [];

  for (let i = 0; i < filesToProcess.length; i++) {
    const currentFile = filesToProcess[i];
    if (!currentFile) continue;

    try {
      const srtPath = await extractSingleFile(currentFile, model, language, device);

      // 출력 정리(Output cleanup): 화자 표시(>>) / SDH 태그 제거 (옵트인)
      // 번역 단계는 이 .srt 파일을 다시 읽으므로, 여기서 미리 정리하면
      // [music] 같은 태그가 번역되거나 >> 가 남는 것을 방지한다.
      if (cleanup && (cleanup.removeSpeakerTags || cleanup.removeSDH)) {
        try {
          const raw = fs.readFileSync(srtPath, 'utf-8');
          const cleaned = applySrtCleanup(raw, cleanup);
          // 안전장치: 정리 결과가 통째로 비었는데(예: 전부 SDH) 원본엔 내용이 있으면
          // 빈 파일로 덮어쓰지 않고 원본 유지(다음 번역 단계가 빈 SRT를 읽는 것 방지).
          if (cleaned.trim() === '' && raw.trim() !== '') {
            event.sender.send('output-update', `Output cleanup skipped (would remove all lines).\n`);
          } else if (cleaned !== raw) {
            fs.writeFileSync(srtPath, cleaned, 'utf-8');
            const applied = [
              cleanup.removeSpeakerTags ? 'speaker tags' : null,
              cleanup.removeSDH ? 'SDH tags' : null,
            ]
              .filter(Boolean)
              .join(', ');
            event.sender.send('output-update', `Output cleanup applied (${applied}).\n`);
          }
        } catch (cleanErr) {
          console.warn('[Cleanup] SRT cleanup failed:', cleanErr.message);
        }
      }

      // 화면 표시용 줄바꿈: 자연 문장 단위 전사는 긴 줄을 만들 수 있으므로, 큐(타임스탬프)
      // 구조는 그대로 둔 채 텍스트만 가독성 있게 여러 줄로 감싼다. 큐 단위(완결 문장)는
      // 유지되므로 다음 번역 단계가 문장을 그대로 읽어 번역 품질에 영향 없다.
      try {
        const rawForWrap = fs.readFileSync(srtPath, 'utf-8');
        const wrapped = wrapCuesForDisplay(rawForWrap);
        if (wrapped && wrapped !== rawForWrap) fs.writeFileSync(srtPath, wrapped, 'utf-8');
      } catch (wrapErr) {
        console.warn('[Wrap] display wrap failed:', wrapErr.message);
      }

      successCount++;
      successDetails.push({ source: currentFile, srtPath });
      event.sender.send(
        'output-update',
        `[${i + 1}/${filesToProcess.length}] Completed: ${path.basename(currentFile)}\n`
      );

      // Next file preview message
      if (i < filesToProcess.length - 1) {
        const nextFile = filesToProcess[i + 1];
        event.sender.send('output-update', `Next file: ${path.basename(nextFile)}\n`);

        if (device === 'cuda') {
          event.sender.send('output-update', `Cleaning GPU memory and preparing next file... (wait 10s)\n`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          event.sender.send('output-update', `Start next file!\n\n`);
        }
      }
    } catch (error) {
      const message = error?.message || String(error);
      const stopped = message === 'Stopped by user';
      if (!stopped) {
        failCount++;
      }
      failureDetails.push({ source: currentFile, error: message, userStopped: stopped });
      // 실패 메시지는 renderer가 result.error를 보고 한 번만 출력함 (이중 출력 방지)

      if (stopped) {
        userStopped = true;
        break;
      }

      // Next file preview after failure
      if (i < filesToProcess.length - 1) {
        const nextFile = filesToProcess[i + 1];
        event.sender.send('output-update', `Next file: ${path.basename(nextFile)}\n`);

        if (device === 'cuda') {
          event.sender.send('output-update', `Recovering and preparing next file... (wait 10s)\n`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          event.sender.send('output-update', `Start next file!\n\n`);
        }
      }
    }
  }

  // 자막 추출 단계 완료 알림 (번역 옵션 시 추가 완료까지는 별도 핸들러에서 처리)
  const extractionSummary = `\nExtraction stage finished (success: ${successCount}, failed: ${failCount})`;
  event.sender.send('output-update', extractionSummary);

  const response = {
    success: failCount === 0 && !userStopped,
    results: successDetails,
  };
  if (successDetails.length === 1) {
    response.srtFile = successDetails[0].srtPath;
  }
  if (failureDetails.length > 0) {
    response.failures = failureDetails;
    if (failureDetails.length === 1) {
      response.error = failureDetails[0].error;
    }
  }
  if (userStopped) {
    response.userStopped = true;
  }

  return response;
});

// Other handlers
ipcMain.handle('show-open-dialog', async (event, options) => {
  return await dialog.showOpenDialog(mainWindow, options);
});

// 파일 위치 열기
function isSafeLocalPath(candidate) {
  return (
    typeof candidate === 'string' && candidate.length > 0 && candidate.length < 4096 && !candidate.includes('\u0000')
  );
}

function openWithXdg(targetPath) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('xdg-open', [targetPath], { stdio: 'ignore', detached: true });
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
      proc.unref();
    } catch (_err) {
      resolve(false);
    }
  });
}

// 히스토리 포렌식-안전 삭제
// localStorage.removeItem 은 LevelDB log 에 tombstone만 추가하고 실제 데이터는 compaction 전까지 남아있음.
// session.clearStorageData 는 난문한 이름의 leveldb 마커 파일과 디렉토리를 제대로 처리하지 못함.
// 안전한 방식: 세션 storage 초기화 + 0으로 덮어쓰고 파일 삭제.
// 히스토리 파일 저장소 — localStorage 는 file:// origin 차이로 날아갈 수 있으므로
// userData 의 JSON 파일을 단일 소스 오브 트루스로 사용.
function getHistoryFilePath() {
  return path.join(app.getPath('userData'), 'history.json');
}
ipcMain.handle('history-load', async () => {
  try {
    const fp = getHistoryFilePath();
    if (!fs.existsSync(fp)) return { success: true, list: [] };
    const raw = fs.readFileSync(fp, 'utf8');
    const arr = JSON.parse(raw);
    return { success: true, list: Array.isArray(arr) ? arr : [] };
  } catch (e) {
    return { success: false, error: e.message, list: [] };
  }
});
ipcMain.handle('history-save', async (_event, list) => {
  try {
    const fp = getHistoryFilePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = Array.isArray(list) ? list.slice(0, 200) : [];
    // atomic 쓰기
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe), 'utf8');
    fs.renameSync(tmp, fp);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 히스토리 안전 삭제 — 히스토리 키만 지우고 다른 localStorage (API 키, 설정) 은 보존.
// removeItem 은 LevelDB tombstone만 추가되므로, padding 키 1MB 쓰고 지워 compaction 을 유도.
// flushStorageData 로 디스크 반영. main leveldb 디렉토리 파일은 절대 손대지 않음 (API 키 손실 방지).
ipcMain.handle('secure-clear-history', async (event) => {
  try {
    const wc = event.sender;
    // 1) localStorage 내 히스토리 키 (legacy) 제거
    try {
      await wc.executeJavaScript(
        '(function(){try{localStorage.removeItem("wst_history_v1");localStorage.removeItem("wst_history");}catch(_){}' +
          'try{var pad=new Array(65536).join("0");for(var i=0;i<16;i++){localStorage.setItem("__wst_pad_"+i,pad);}for(var j=0;j<16;j++){localStorage.removeItem("__wst_pad_"+j);}}catch(_){}})();'
      );
    } catch (_) {}
    try {
      await wc.session.flushStorageData();
    } catch (_) {}
    // 2) userData/history.json 파일 안전 삭제 (0으로 덮어쓰고 unlink)
    try {
      const fp = getHistoryFilePath();
      if (fs.existsSync(fp)) {
        try {
          const st = fs.statSync(fp);
          fs.writeFileSync(fp, Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024), 0));
        } catch (_) {}
        try {
          fs.unlinkSync(fp);
        } catch (_) {}
      }
    } catch (_) {}
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-location', async (event, filePath) => {
  const { shell } = require('electron');
  if (!isSafeLocalPath(filePath)) {
    return { success: false, error: 'invalid path' };
  }
  try {
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open file location:', error);
    if (process.platform === 'linux') {
      const dirPath = path.dirname(filePath);
      const ok = await openWithXdg(dirPath);
      if (ok) return { success: true };
    }
    return { success: false, error: error.message };
  }
});

// 폴더 열기
ipcMain.handle('open-folder', async (event, folderPath) => {
  const { shell } = require('electron');
  if (!isSafeLocalPath(folderPath)) {
    return { success: false, error: 'invalid path' };
  }
  try {
    const result = await shell.openPath(folderPath);
    if (result && process.platform === 'linux') {
      await openWithXdg(folderPath);
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to open folder:', error);
    if (process.platform === 'linux') {
      const ok = await openWithXdg(folderPath);
      if (ok) return { success: true };
    }
    return { success: false, error: error.message };
  }
});

// 외부 URL을 기본 브라우저에서 열기
const ALLOWED_OPEN_EXTERNAL_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'huggingface.co',
  'platform.openai.com',
  'openai.com',
  'ai.google.dev',
  'aistudio.google.com',
  'deepl.com',
  'www.deepl.com',
]);

function isAllowedOpenExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_OPEN_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_err) {
    return false;
  }
}

ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  if (!isAllowedOpenExternalUrl(url)) {
    console.warn('[Security] Blocked open-external for URL:', url);
    return { success: false, error: 'URL not allowed' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Failed to open external link:', error);
    return { success: false, error: error.message };
  }
});

// Whisper GGML 모델 삭제
ipcMain.handle('delete-whisper-model', async (_event, modelName) => {
  try {
    const modelsPath = getGgmlModelsDir();
    const modelFile = path.join(modelsPath, `ggml-${modelName}.bin`);
    if (fs.existsSync(modelFile)) {
      fs.unlinkSync(modelFile);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('check-model-status', async () => {
  const modelsPath = getGgmlModelsDir();
  const availableModels = {};

  // GGML 모델 이름 목록
  const modelNames = ['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3', 'large-v3-turbo'];

  try {
    if (fs.existsSync(modelsPath)) {
      for (const modelName of modelNames) {
        const modelFile = path.join(modelsPath, `ggml-${modelName}.bin`);
        if (fs.existsSync(modelFile)) {
          availableModels[modelName] = true;
        }
      }
    }
  } catch (error) {
    console.error('Error checking model status:', error);
  }
  return availableModels;
});

// 모델 자동 다운로드 (Hugging Face: ggerganov/whisper.cpp GGML 형식)
ipcMain.handle('download-model', async (event, modelName) => {
  try {
    // GGML 모델 파일 URL 매핑
    const modelUrlMap = {
      tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
      base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
      medium: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
      large: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin',
      'large-v2': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin',
      'large-v3': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
      'large-v3-turbo': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    };
    const modelUrl = modelUrlMap[modelName];
    if (!modelUrl) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const targetDir = getGgmlModelsDir();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const modelFileName = `ggml-${modelName}.bin`;
    const targetPath = path.join(targetDir, modelFileName);
    const partialPath = targetPath + '.partial';

    downloadsCancelled = false;

    const downloadFile = async (url, destPath) => {
      if (downloadsCancelled) throw new Error('cancelled');
      const controller = new AbortController();
      const writer = fs.createWriteStream(destPath);
      const tracker = { controller, writer, destPath };
      activeDownloads.add(tracker);
      const response = await axios({ url, method: 'GET', responseType: 'stream', signal: controller.signal });
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      let lastPct = -1;
      let lastSentAt = 0;
      const emit = (pct) => {
        try {
          mainWindow.webContents.send('output-update', `${path.basename(destPath)} ${pct}%\n`);
          mainWindow.webContents.send('whisper-model-progress', {
            modelName,
            percent: pct,
            received,
            total,
          });
        } catch (_e) {
          console.log('[Download] Failed to send progress update:', _e.message);
        }
      };
      response.data.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          const now = Date.now();
          if (pct !== lastPct && (pct === 100 || pct - lastPct >= 5 || now - lastSentAt >= 1000)) {
            emit(pct);
            lastPct = pct;
            lastSentAt = now;
          }
        }
      });
      response.data.on('end', () => {
        if (total > 0 && lastPct < 100) emit(100);
        activeDownloads.delete(tracker);
      });
      response.data.on('error', () => {
        activeDownloads.delete(tracker);
      });
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    };

    // 파일 존재하면 스킵 (GGML 단일 파일 체크)
    if (fs.existsSync(targetPath)) {
      try {
        mainWindow.webContents.send('output-update', `Model already prepared: ${modelName}\n`);
      } catch (_e) {
        console.log('[Download] Failed to send model ready message:', _e.message);
      }
      return { success: true };
    }

    try {
      mainWindow.webContents.send('output-update', `Starting GGML model download: ${modelName}\n`);
    } catch (_e) {
      console.log('[Download] Failed to send download start message:', _e.message);
    }

    // 이전 부분 파일 정리
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch (_e) {
      console.log('[Download] Failed to delete partial file:', _e.message);
    }

    if (downloadsCancelled) throw new Error('cancelled');
    try {
      await downloadFile(modelUrl, partialPath);
      // 완료되어야만 최종 경로로 rename — 부분 파일이 'installed' 로 보이지 않도록
      fs.renameSync(partialPath, targetPath);
    } catch (err) {
      // 취소/실패 시 부분 파일 제거
      try {
        if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
      } catch (_e) {}
      throw err;
    }

    try {
      mainWindow.webContents.send('output-update', `GGML Model download completed: ${modelName}\n`);
    } catch (_e) {
      console.log('[Download] Failed to send completion message:', _e.message);
    }
    return { success: true };
  } catch (error) {
    console.error('Model download failed:', error);
    if (String(error && error.message).includes('cancelled') || String(error && error.name).includes('AbortError')) {
      try {
        mainWindow.webContents.send('output-update', `Model download cancelled\n`);
      } catch (_e) {
        console.log('[Download] Failed to send cancellation message:', _e.message);
      }
      return { success: false, error: 'cancelled' };
    }
    try {
      mainWindow.webContents.send('output-update', `[ERROR] Model download failed: ${error.message}\n`);
    } catch (_e) {
      console.log('[Download] Failed to send error message:', _e.message);
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-current-process', async () => {
  isUserStopped = true;

  if (currentProcess && !currentProcess.killed) {
    currentProcess.kill('SIGKILL');
    console.log('Process stopped by user.');
  }

  // 번역 중이면 translator에도 중지 시그널 전달
  if (translator && typeof translator.abort === 'function') {
    try {
      translator.abort();
      console.log('Translation aborted by user.');
    } catch (_e) {
      /* ignore */
    }
  }

  try {
    cancelActiveDownloads();
  } catch (_e) {
    /* ignore */
  }

  return { success: true };
});

// ========== 번역 관련 IPC 핸들러 ==========

// API 키 저장
ipcMain.handle('save-api-keys', async (event, keys) => {
  try {
    const result = translator.saveApiKeys(keys);
    return { success: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// API 키 불러오기
ipcMain.handle('load-api-keys', async () => {
  try {
    const keys = translator.loadApiKeys();
    return { success: true, keys };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 오프라인 관련 IPC 제거됨

// API 키 유효성 검사 (임시 키 지원)
ipcMain.handle('validate-api-keys', async (event, tempKeys) => {
  try {
    console.log('[API Key Validation]', {
      hasTempKeys: !!tempKeys,
      tempKeysCount: tempKeys ? Object.keys(tempKeys).length : 0,
      tempKeys: tempKeys ? Object.keys(tempKeys) : [],
    });

    // 임시 키가 제공되면 사용, 아니면 저장된 키 사용
    if (tempKeys && Object.keys(tempKeys).length > 0) {
      console.log('[Using temporary keys for validation]');
      const tempTranslator = new EnhancedSubtitleTranslator();
      tempTranslator.apiKeys = { ...tempTranslator.apiKeys, ...tempKeys };
      const results = await tempTranslator.validateApiKeys();
      return { success: true, results };
    } else {
      console.log('[Using saved keys for validation]');
      const results = await translator.validateApiKeys();
      return { success: true, results };
    }
  } catch (error) {
    console.error('[API Key Validation Error]', error);
    return { success: false, error: error.message };
  }
});

// 자막 번역
ipcMain.handle(
  'translate-subtitle',
  async (event, { filePath, method, targetLang, sourceLang, device, localModelId }) => {
    try {
      const fileName = path.basename(filePath, path.extname(filePath));
      const fileDir = path.dirname(filePath);
      const safeTarget = targetLang && typeof targetLang === 'string' && targetLang.trim() ? targetLang.trim() : 'ko';
      const outputPath = path.join(fileDir, `${fileName}_${safeTarget}.srt`);

      // 파일별 캐시 격리 활성화
      translator.setCurrentFile(filePath);
      // local 번역 device 설정 전달
      translator.localDevice = device === 'cpu' ? 'cpu' : 'auto';
      translator.localModelId = localModelId || '1.8b';

      event.sender.send('translation-progress', { stage: 'starting' });

      const result = await translator.translateSRTFile(
        filePath,
        outputPath,
        method,
        safeTarget,
        // 진행률 콜백: translator-enhanced가 제공하는 정보를 가공하여 렌더러로 중계
        (prog) => {
          try {
            const percent = prog && prog.total ? Math.round((prog.current / prog.total) * 100) : undefined;
            event.sender.send('translation-progress', {
              stage: prog?.stage || 'translating',
              current: prog?.current,
              total: prog?.total,
              progress: percent,
              currentText: prog?.text,
            });
          } catch (_) {
            /* noop */
          }
        },
        sourceLang
      );

      // 번역 직후에는 파일 정리/메모리 정리 등 후처리가 남아있으므로, 최종 완료와 구분하는 메시지와 진행률(99%)을 전송
      event.sender.send('translation-progress', { stage: 'completed', progress: 99, outputPath: result });

      return { success: true, outputPath: result };
    } catch (error) {
      if (error.message && error.message.includes('ABORTED')) {
        event.sender.send('translation-progress', { stage: 'error', errorMessage: 'Stopped by user' });
        return { success: false, error: 'Stopped by user', userStopped: true };
      }
      event.sender.send('translation-progress', { stage: 'error', errorMessage: error.message });
      return { success: false, error: error.message };
    }
  }
);

// 텍스트 직접 번역 (테스트용)
ipcMain.handle('translate-text', async (event, { text, method, targetLang }) => {
  try {
    const result = await translator.translateAuto(text, method, targetLang);
    return { success: true, translatedText: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 앱 경로 반환 (nya.wav 등 리소스 접근용)
ipcMain.handle('get-app-path', async () => {
  return app.isPackaged ? process.resourcesPath : __dirname;
});

// 로그 디렉터리 경로 반환 (%APPDATA%\whispersubtranslate\logs)
ipcMain.handle('get-log-dir', async () => {
  const logsDir = path.join(app.getPath('userData'), 'logs');
  // 디렉터리가 없으면 생성
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
});

// 업데이트 체크 IPC 핸들러 (폴백용 - 주로 did-finish-load에서 자동 체크)
ipcMain.handle('check-for-updates', async () => {
  return await checkForUpdates();
});

ipcMain.handle('get-current-version', async () => {
  return CURRENT_VERSION;
});

ipcMain.handle('get-gpu-info', async () => {
  return getGpuInfo();
});

// nya.wav 파일을 base64로 읽어서 반환 (renderer에서 file:// 보안 문제 회피)
ipcMain.handle('get-audio-data', async (event, filename) => {
  try {
    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    const filePath = path.join(basePath, filename);

    if (!fs.existsSync(filePath)) {
      console.log('[Audio] File not found:', filePath);
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    console.log('[Audio] Loaded audio file:', filePath, '- size:', buffer.length);
    return `data:audio/wav;base64,${base64}`;
  } catch (error) {
    console.error('[Audio] Failed to read audio file:', error.message);
    return null;
  }
});

// ─── Local Hy-MT2 Translation IPC ───────────────────────────────────────────
const localTranslator = require('./local-translator');
let _localDownloadAbort = null;

// 자동 다운로드 진행률을 renderer로 실시간 전송
localTranslator.setDownloadProgressHandler((progress) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('local-model-progress', progress);
    }
  } catch (_e) {
    /* ignore */
  }
});

ipcMain.handle('local-model-list', async () => {
  return localTranslator.listModels();
});

ipcMain.handle('local-model-status', async (_event, modelId) => {
  const id = modelId || localTranslator.DEFAULT_MODEL_ID;
  const meta = localTranslator.MODELS[id];
  return {
    modelId: id,
    installed: localTranslator.isModelInstalled(id),
    path: localTranslator.getModelPath(id),
    modelFile: meta?.file,
    sizeMB: Math.round((meta?.sizeBytes || 0) / 1024 / 1024),
    requirements: meta?.requirements,
  };
});

ipcMain.handle('local-model-download', async (event, modelId) => {
  const id = modelId || localTranslator.DEFAULT_MODEL_ID;
  if (!localTranslator.isModelInstalled(id)) {
    _localDownloadAbort = new AbortController();
    try {
      await localTranslator.downloadModel(
        (progress) => {
          event.sender.send('local-model-progress', progress);
        },
        _localDownloadAbort.signal,
        id
      );
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      _localDownloadAbort = null;
    }
  }
  return { success: true, alreadyInstalled: true };
});

// Whisper GGML 다운로드 취소 (download-model 이 사용하는 activeDownloads / downloadsCancelled 소스)
ipcMain.handle('whisper-model-cancel', async () => {
  try {
    cancelActiveDownloads();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('local-model-cancel', async () => {
  if (_localDownloadAbort) {
    _localDownloadAbort.abort();
    _localDownloadAbort = null;
  }
  return true;
});

ipcMain.handle('local-model-delete', async (_event, modelId) => {
  const id = modelId || localTranslator.DEFAULT_MODEL_ID;
  await localTranslator.unloadModel();
  localTranslator.deleteModel(id);
  return true;
});

ipcMain.handle('local-translate', async (event, { text, targetLang, modelId }) => {
  try {
    const result = await localTranslator.translateLocal(
      text,
      targetLang,
      'auto',
      modelId || localTranslator.DEFAULT_MODEL_ID
    );
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// App Exit Cleanup
let _isCleaningUp = false;
app.on('before-quit', async () => {
  if (_isCleaningUp) return;
  _isCleaningUp = true;
  console.log('[Cleanup] App closing, cleaning up...');
  // 진행 중인 모델 다운로드 중단 + 부분 파일 정리
  try {
    cancelActiveDownloads();
  } catch (_e) {}
  try {
    if (_localDownloadAbort) {
      _localDownloadAbort.abort();
      _localDownloadAbort = null;
    }
  } catch (_e) {}
  await localTranslator.unloadModel().catch(() => {});
  await forceMemoryCleanup('cuda', true);
});

process.on('SIGINT', () => {
  console.log('[Cleanup] SIGINT received');
  app.quit();
});

process.on('SIGTERM', () => {
  console.log('[Cleanup] SIGTERM received');
  app.quit();
});
