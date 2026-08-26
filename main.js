const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { assertDownloadDiskSpace, assertSyncInstallDiskSpace, getReusablePartialSize } = require('./disk-space');
const { downloadVerifiedFile, sha256File } = require('./verified-downloader');
const { isCompleteWavFile } = require('./file-safety');
// 앱 이름 고정 (우클릭 메뉴와 작업표시줄 레이블이 'Electron' 대신 이 이름으로)
try {
  app.setName('WhisperSubTranslate');
} catch (_) {}
try {
  app.setAppUserModelId('com.whispersubtranslate.app');
} catch (_) {}

// ===== Portable data layout (포터블 데이터 레이아웃) =====
// WHISPER_PORTABLE_DATA 환경변수, 또는 실행 파일(또는 소스 루트) 옆의
// portable-data/ 디렉토리가 있으면 모델·캐시·설정(%APPDATA%)을 그 경로로
// 리다이렉트한다. 시스템 SSD가 작거나 USB/외장 드라이브로 실행할 때 유용.
// app ready 이전에 setPath 해야 하므로 모듈 최상단에서 처리한다.
function resolvePortableUserData() {
  if (process.env.WHISPER_PORTABLE_DATA) return process.env.WHISPER_PORTABLE_DATA;
  const exeDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const marker = path.join(exeDir, 'portable-data');
  return fs.existsSync(marker) ? marker : null;
}
try {
  const portableDir = resolvePortableUserData();
  if (portableDir) {
    fs.mkdirSync(portableDir, { recursive: true });
    app.setPath('userData', portableDir);
    console.log('[Portable] userData redirected to:', portableDir);
  }
} catch (e) {
  console.warn('[Portable] Failed to redirect userData:', e.message);
}

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.log('[Auto-Updater] electron-updater not available:', error.message);
}
const { spawn, spawnSync, execFile, execSync, execFileSync } = require('child_process');
const os = require('os');
const axios = require('axios');
const EnhancedSubtitleTranslator = require('./translator-enhanced');
const { applySrtCleanup, wrapCuesForDisplay, srtFromWhisperJson } = require('./srt-cleanup');

// whisper.cpp -ojf JSON(outputBase.json)을 읽어 토큰 끝시각기반 타이트 SRT로 변환해 srtPath에 덮어쓴다.
// VAD 되매핑으로 늘어난 세그먼트 끝을 실제 발화 끝으로 잘라 "말할 때만 자막이 뜨게" 한다.
// JSON이 없거나 파싱 실패하면 아무것도 안 하고 -osrt 결과를 그대로 쓴다(우아한 폴백).
function applyTokenTightTiming(outputBase, srtPath) {
  try {
    const jsonPath = outputBase + '.json';
    if (!fs.existsSync(jsonPath)) return;
    const tight = srtFromWhisperJson(fs.readFileSync(jsonPath, 'utf-8'));
    try {
      fs.unlinkSync(jsonPath);
    } catch (_e) {
      /* ignore */
    }
    if (tight && tight.trim()) fs.writeFileSync(srtPath, tight, 'utf-8');
  } catch (e) {
    console.warn('[Timing] token-tight SRT failed, using -osrt output:', e.message);
  }
}
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
// 앱이 spawn한 자식 프로세스 PID 집합 — 정리 시 이미지명(taskkill /IM) 대신
// 이 PID들만 골라 종료한다. /IM은 같은 이름의 타 앱(OBS 등)까지 죽인다(P1-6).
let childProcessIds = new Set();

// ===== Download cancellation state (모델 다운로드 취소 관리) =====
let activeDownloads = new Set(); // { controller, writer, destPath, cancelled }
let downloadsCancelled = false;

// Hugging Face LFS metadata is pinned so chunked/proxy responses can be checked
// without trusting Content-Length. `large` is the upstream large-v1 filename.
//
// 리비전은 `main`이 아니라 커밋으로 고정한다. `main`은 움직이는 포인터라
// 업스트림이 파일을 한 글자만 고쳐도 아래 SHA-256이 전부 틀려져, 앱을 업데이트하지
// 않은 사용자에게 어느 날 갑자기 다운로드가 전부 실패한다.
const GGML_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const SYNC_MODEL_REVISION = 'f0fe81560cb8b68660e564f55dd99207059c092e';
const GGML_MODEL_MANIFEST = Object.freeze({
  tiny: {
    file: 'ggml-tiny.bin',
    size: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  base: {
    file: 'ggml-base.bin',
    size: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  small: {
    file: 'ggml-small.bin',
    size: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  medium: {
    file: 'ggml-medium.bin',
    size: 1533763059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
  },
  large: {
    file: 'ggml-large-v1.bin',
    size: 3094623691,
    sha256: '7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d',
  },
  'large-v2': {
    file: 'ggml-large-v2.bin',
    size: 3094623691,
    sha256: '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487',
  },
  'large-v3': {
    file: 'ggml-large-v3.bin',
    size: 3095033483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  },
  'large-v3-turbo': {
    file: 'ggml-large-v3-turbo.bin',
    size: 1624555275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  },
});

const SYNC_FILE_MANIFEST = Object.freeze({
  'config.json': { size: 2796, sha256: 'd86b7a7664a12559d644aa210a32ce9a7e03913e794b7ea4fb7182de69e273a7' },
  'tokenizer.json': { size: 2203239, sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab' },
  'vocabulary.txt': { size: 459861, sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913' },
  'model.bin': { size: 3086912962, sha256: 'bf2a9746382e1aa7ffff6b3a0d137ed9edbd9670c3b87e5d35f5e85e70d0333a' },
});

function hasExpectedSize(filePath, manifest) {
  try {
    return fs.statSync(filePath).size === manifest.size;
  } catch (_e) {
    return false;
  }
}

function cancelActiveDownloads() {
  const hadActive = activeDownloads.size > 0;
  downloadsCancelled = true;
  for (const d of activeDownloads) {
    d.cancelled = true;
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
  // Trackers remove themselves after their pipeline settles. Do not clear the Set here:
  // an old tracker must retain cancelled=true even if a new job resets the global flag.
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
let _vulkanAvailableCache = null;
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

function isVulkanAvailable(basePath) {
  if (_vulkanAvailableCache !== null) return _vulkanAvailableCache;
  const vulkanDir = path.join(basePath, 'whisper-cpp', 'vulkan');
  const cliPath = path.join(vulkanDir, WHISPER_CLI_NAME);
  if (!fs.existsSync(cliPath)) return (_vulkanAvailableCache = false);

  try {
    // 포터블 ZIP 첫 실행에서 백신이 미서명 exe를 실시간 스캔하면 probe가 쉽게 느려진다.
    // 한 번의 타임아웃을 "Vulkan 없음"으로 캐시해 버리면 재시작 전까지 GPU 가속이
    // 영영 꺼진다. 그래서 여유를 두고, 확답을 못 받았을 때는 캐시하지 않는다.
    const probe = spawnSync(cliPath, ['--version'], {
      cwd: vulkanDir,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status === null || probe.error) {
      console.warn(`[Vulkan] probe inconclusive (${probe.error?.code || 'timeout'}); will retry later`);
      return false;
    }
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    _vulkanAvailableCache = probe.status === 0 && /ggml_vulkan: Found [1-9]\d* Vulkan devices/.test(output);
  } catch {
    return false;
  }
  return _vulkanAvailableCache;
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

function resolveDevice(requestedDevice, basePath) {
  const req = (requestedDevice || 'auto').toLowerCase();
  if (req === 'cpu') return 'cpu';
  if (req === 'vulkan') return isVulkanAvailable(basePath) ? 'vulkan' : 'cpu';
  if (req !== 'auto' && req !== 'cuda' && req !== 'gpu') return 'cpu';
  if (isCudaAvailable()) return 'cuda';
  return isVulkanAvailable(basePath) ? 'vulkan' : 'cpu';
}

// Enhanced memory/GPU cleanup across files (파일 간 메모리/GPU 정리)
// 앱이 spawn한 자식 프로세스 PID만 골라 종료한다 (이미지명 /IM 킬은 같은 이름의
// 타 앱까지 죽이므로 사용하지 않는다). Windows에서는 taskkill /PID /T 로 자식 트리를
// 함께 종료한다.
function killTrackedChildProcesses() {
  const ids = [...childProcessIds];
  childProcessIds.clear();
  for (const pid of ids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(pid), '/T'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.log(`   - Child process ${pid} killed`);
    } catch (_e) {
      // 이미 종료된 프로세스면 무시
    }
  }
}
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

      // 2. 앱이 spawn한 자식 프로세스(whisper-cli/ffmpeg/faster-whisper)만 PID로 종료.
      //    taskkill /IM 은 같은 이름의 타 앱(OBS 등)까지 죽이므로 쓰지 않는다(P1-6).
      killTrackedChildProcesses();

      // 3. GPU 정리 (Windows + CUDA 한정). GPU 리셋은 동기 5회(최대 65초) 대신
      //    비동기 1회 시도만 한다 — 프로세스 종료만으로 CUDA 컨텍스트는 해제되며,
      //    리셋은 최후 수단으로 실패해도 추출은 계속되어야 한다(P1-6).
      if (process.platform === 'win32' && device === 'cuda') {
        const delay = isFileTransition ? 2000 : 500; // Longer delay for file transitions

        setTimeout(() => {
          console.log('   - Flushing GPU cache...');
          execFile('nvidia-smi', ['--gpu-reset'], { timeout: 15000, windowsHide: true }, (err) => {
            if (err) {
              console.log('   - GPU reset failed (continuing):', err.message);
            } else {
              console.log('   - GPU memory cleanup completed');
            }
            resolve();
          });
        }, delay);
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

    // releaseUrl은 GitHub 릴리스 페이지 형태만 허용 (쿼리/해시 제거 후 검증).
    let releaseUrl = response.data.html_url;
    if (typeof releaseUrl === 'string') {
      try {
        const parsed = new URL(releaseUrl);
        parsed.search = '';
        parsed.hash = '';
        releaseUrl = parsed.href;
      } catch (_err) {
        /* keep raw */
      }
    }
    if (typeof releaseUrl !== 'string' || !isAllowedOpenExternalUrl(releaseUrl)) {
      console.warn('[Update Check] Rejecting invalid release URL:', releaseUrl);
      return { hasUpdate: false, error: 'Invalid release URL' };
    }
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
      // 긴 작업 후 완료 효과음이 자동재생 정책에 막히지 않도록 명시(commandLine 스위치 보강).
      autoplayPolicy: 'no-user-gesture-required',
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
      // renderer는 모든 네트워크 호출을 main IPC로 우회하므로(직접 fetch/axios 없음)
      // connect-src는 'self'로만 충분하다. 서드파티 API 호스트는 추가하지 않는다.
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "worker-src 'none'",
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
  // 앱 자체 index.html 이외의 file:// 네비게이션은 차단한다 (렌더러가 임의 로컬
  // 파일을 열어 파일 내용을 노출하는 경로 방지). https 외부 URL은 allow-list로만.
  const APP_INDEX_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isOwnFile = url.startsWith('file://') && url === APP_INDEX_URL;
    if (!isOwnFile) {
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
    // 정리 중 창이 닫힌 경우: quit 요청은 before-quit의 정리 시퀀스를 타게 하고,
    // 정리 완료 전 종료가 일어나지 않도록 before-quit에서 preventDefault 후
    // 재요청하는 구조를 그대로 따른다 (F2).
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
    try {
      fs.mkdirSync(appTemp, { recursive: true });
      return appTemp;
    } catch (e) {
      console.warn('[Temp] Failed to create app temp dir, falling back:', e.message);
    }
  }

  // 2순위: 플랫폼별 안전한 fallback 경로
  let fallbackTemp;
  if (process.platform === 'win32') {
    fallbackTemp = path.join('C:', 'Users', 'Public', 'WhisperSubTranslate', 'temp');
  } else {
    fallbackTemp = path.join(os.tmpdir(), 'WhisperSubTranslate', 'temp');
  }
  try {
    fs.mkdirSync(fallbackTemp, { recursive: true });
  } catch (e) {
    console.warn('[Temp] Failed to create fallback temp dir, using os.tmpdir:', e.message);
    fallbackTemp = os.tmpdir();
  }
  return fallbackTemp;
}

// 경로가 ASCII만 포함하는지 체크
function isAsciiPath(filePath) {
  return /^[\x00-\x7F]*$/.test(filePath);
}

// ===== 경로 헬퍼 =====
// 확장자가 없는 파일("movie")이 들어와도 원본을 절대 덮어쓰지 않도록
// SRT/WAV 출력 경로는 항상 확장자를 붙여 만든다.
function withoutExt(filePath) {
  const ext = path.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}
function srtOutputPathFor(filePath) {
  return withoutExt(filePath) + '.srt';
}

// ===== 타임아웃 계산 =====
// 기존 30분 고정이 CPU+large 모델처럼 실제로 오래 걸리는 작업을 무조건 죽이던 문제
// 수정. 실제 미디어 길이 × 실시간 계수(GPU 4x, CPU 12x)로 스케일링하고
// 하한 30분 / 상한 6시간으로 클램프한다. 길이를 모르면(0) 하한만 적용.
function extractionTimeoutMs(durationSec, device) {
  const factor = device === 'cpu' ? 12 : 4;
  const scaled = durationSec > 0 ? durationSec * factor * 1000 : 0;
  return Math.min(6 * 60 * 60 * 1000, Math.max(30 * 60 * 1000, scaled));
}

// 부분/손상 SRT를 성공으로 오인하지 않도록: 파싱 가능한 큐 1개 이상 + 끝 개행.
function isCompleteSrt(p) {
  try {
    const c = fs.readFileSync(p, 'utf-8');
    if (!c.trim() || !c.endsWith('\n')) return false;
    return parseSrtEntries(c).length > 0;
  } catch (_) {
    return false;
  }
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
    // stop/quit 시 즉시 종료되도록 추적 자식에 등록 (30초 타임아웃과 별개로 중단 대응).
    if (proc?.pid) childProcessIds.add(proc.pid);
    proc.once('close', () => childProcessIds.delete(proc.pid));
    proc.once('error', () => childProcessIds.delete(proc.pid));
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

        // 분할 ffmpeg도 추적 자식에 포함한다 — quit/stop 시 고아가 temp 세그먼트를
        // 계속 쓰는 것을 막는다(F3).
        if (proc?.pid) childProcessIds.add(proc.pid);
        proc.once('close', () => childProcessIds.delete(proc.pid));
        proc.once('error', () => childProcessIds.delete(proc.pid));

        // 세그먼트 생성 타임아웃: 30분 분할은 보통 수 초~수십 초면 끝난다.
        // 멈춘 ffmpeg가 분할을 영원히 붙들지 않게 300초로 제한한다(F3).
        const splitTimeout = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
          rej(new Error(`Segment ${segmentIndex} split timeout`));
        }, 300000);

        proc.on('close', (code) => {
          clearTimeout(splitTimeout);
          if (code === 0 && fs.existsSync(segmentPath)) {
            res();
          } else {
            rej(new Error(`Segment ${segmentIndex} creation failed`));
          }
        });

        proc.on('error', (err) => {
          clearTimeout(splitTimeout);
          rej(err);
        });
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
      // 분할 실패 시 이미 생성된 세그먼트 + 실패한 세그먼트의 부분 파일까지 정리 후 원본으로 진행
      // (타임아웃 킬로 부분 파일만 남은 segment_*.wav가 temp에 쌓이는 것 방지)
      console.error('[Split] Segment creation failed:', err.message);
      for (const seg of segments) {
        try {
          fs.unlinkSync(seg.path);
        } catch (_e) {
          /* ignore */
        }
      }
      try {
        if (segmentPath && fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath);
      } catch (_e) {
        /* ignore */
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

  // SRT 타임스탬프 형식: 00:00:00,000 --> 00:00:00,000 (시는 1~3자리 허용: 100시간+ 파일 대응)
  const timestampRegex = /(\d{1,3}):(\d{2}):(\d{2}),(\d{3}) --> (\d{1,3}):(\d{2}):(\d{2}),(\d{3})/;

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
// 오버랩 구간에서 같은 발화가 양쪽 세그먼트에 인식될 때, 워딩이 조금 달라도
// (예: 앞 트림 차이, 마침표 유무) 중복으로 판정한다. 근거리 창(1500ms) 안에서
// ① 완전 동일 ② substring 포함(기존) ③ bigram Dice ≥0.9 ④ 편집거리 비율 ≥0.85
// 중 하나면 중복으로 본다. 실제로 다른 대사가 묻히지 않도록 ③④ 임계값은 보수적으로.
function cueTextSimilarity(a, b, allowPartialSubstring = false) {
  if (a === b) return 1;
  const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  // substring 포함: 짧은 쪽(4자 이상)이 긴 쪽의 연속 부분 문자열이면 중복 후보.
  // allowPartialSubstring(잔재 큐 흡수)일 때만 길이 비율 게이트 없이 즉시 중복,
  // 일반 큐는 70% 이상 비율일 때만 인정해 반복 발화("Thanks" vs
  // "Thanks for watching")가 지워지지 않게 한다.
  if (Math.min(na.length, nb.length) >= 4) {
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    if (longer.includes(shorter) && (allowPartialSubstring || ratio >= 0.7)) return 1;
  }
  // bigram Dice 계수
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const dice = (2 * inter) / (ga.size + gb.size || 1);
  if (dice >= 0.9) return dice;
  // Levenshtein 편집거리 비율 (문자열이 짧을수록 유의미, 64자 이하에서만 계산)
  if (na.length <= 64 && nb.length <= 64) {
    const dp = Array.from({ length: na.length + 1 }, (_, i) => [i, ...Array(nb.length).fill(0)]);
    for (let j = 0; j <= nb.length; j++) dp[0][j] = j;
    for (let i = 1; i <= na.length; i++) {
      for (let j = 1; j <= nb.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (na[i - 1] === nb[j - 1] ? 0 : 1));
      }
    }
    const dist = dp[na.length][nb.length];
    const lev = 1 - dist / Math.max(na.length, nb.length);
    if (lev >= 0.85) return lev;
  }
  return 0;
}

function mergeSrtFiles(srtContents, startTimes) {
  const allEntries = [];

  // 세그먼트 경계 시각(ms): 다음 세그먼트 시작 = 이전 세그먼트 끝(오버랩 포함) 근처.
  // 고유사도(≥0.98) 중복의 창 확대는 이 경계 인접 구간에만 적용한다 — 미드-세그먼트의
  // 반복 발화('Okay.'/'Okay' 등 1.5~5초 간격)가 지워지지 않게 하려는 것이다(F1).
  const boundaryMs = startTimes.slice(1).map((t) => t * 1000);
  const nearSegmentBoundary = (ms) => boundaryMs.some((b) => Math.abs(ms - b) <= OVERLAP_DURATION * 1000);

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
    const a = entry.text.trim();
    let duplicate = false;
    for (let j = 0; j < uniqueEntries.length; j++) {
      const existing = uniqueEntries[j];
      const b = existing.text.trim();
      if (!a || !b) continue;
      // 텍스트가 완전히 같거나 유사도가 매우 높은(≥0.98) 중복만 오버랩 창
      // (OVERLAP_DURATION=5초)까지 확대해 흡수한다. 경계에서 같은 자막이
      // 양쪽 세그먼트에 중복 인식되면 1.5초를 넘겨 떨어질 수 있기 때문(P1-4).
      // 단, 창 확대는 세그먼트 경계 인접 구간에만 적용한다. 유사도가 낮은 건
      // (반복 발화 "Thanks" vs "Thanks for watching")은 기존 1500ms 창을 유지해
      // 실제 다른 대사를 보존한다.
      const sim = cueTextSimilarity(a, b);
      const atBoundary = nearSegmentBoundary(existing.startMs) || nearSegmentBoundary(entry.startMs);
      const windowMs = atBoundary && sim >= 0.98 ? OVERLAP_DURATION * 1000 : 1500;
      if (Math.abs(existing.startMs - entry.startMs) >= windowMs) continue;
      // 1ms짜리 초단시간 큐가 오버랩 창 안에 겹치면 중복으로 흡수 (머지 경계 잔재 제거)
      const durMs = entry.endMs ? entry.endMs - entry.startMs : 0;
      const existingDurMs = existing.endMs ? existing.endMs - existing.startMs : 0;
      // 잔재 큐(5ms 이하)는 survivor가 될 수 없다 (MED-5):
      //  - 기존 큐가 잔재면 더 긴 entry로 교체해 잔재를 버린다.
      //  - entry가 잔재면 기존 큐에 흡수되어 버려진다.
      // 일반 큐끼리는 비율 게이트가 있는 유사도(≥0.85)만 적용해 반복 발화가
      // 지워지지 않게 한다.
      if (existingDurMs <= 5) {
        if (cueTextSimilarity(a, b, true) > 0) {
          if (durMs > existingDurMs) uniqueEntries[j] = entry;
          duplicate = true;
          break;
        }
        continue;
      }
      if (durMs <= 5) {
        if (cueTextSimilarity(a, b, true) > 0) {
          duplicate = true;
          break;
        }
        continue;
      }
      if (sim >= 0.85) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
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
      const timestampRegex = /(\d{1,3}):(\d{2}):(\d{2}),(\d{3}) --> (\d{1,3}):(\d{2}):(\d{2}),(\d{3})/;
      const match = timestampLine.match(timestampRegex);

      if (match) {
        const startMs =
          (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000 + parseInt(match[4]);
        const endMs =
          (parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7])) * 1000 + parseInt(match[8]);
        const text = lines.slice(2).join('\n');

        entries.push({
          startMs,
          endMs,
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
      '-ojf', // 토큰별 실제 시각 포함 JSON → 자막 끝을 실발화 끝으로 트림
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
    if (proc?.pid) childProcessIds.add(proc.pid);
    proc.once('close', () => childProcessIds.delete(proc.pid));
    proc.once('error', () => childProcessIds.delete(proc.pid));

    const segTimeout = setTimeout(
      () => {
        if (proc && !proc.killed) {
          const secs = Math.round(extractionTimeoutMs(SEGMENT_DURATION, device) / 1000 / 60);
          console.log(`[Segment TIMEOUT] ${path.basename(segmentPath)} - exceeded ${secs} min`);
          proc.kill('SIGKILL');
        }
      },
      extractionTimeoutMs(SEGMENT_DURATION, device)
    );

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
      // 세그먼트 성공 판정 (F2):
      // - code 0: 정상 종료. SRT가 비어 있어도(무음/음악 전용 구간) 허용한다.
      //   빈 세그먼트를 REJECT하면 분할 전체를 폐기하고 파일 전체를 단일 패스로
      //   재추출해 2배 시간이 든다. 빈 내용은 mergeSrtFiles에서 무해하게 무시된다.
      // - code !== 0: SRT가 존재하고 isCompleteSrt(큐 ≥1 + 끝 개행)일 때만 성공.
      if (code === 0) {
        try {
          let content = '';
          if (fs.existsSync(srtPath)) {
            // 명시 분기 (MED-6): code 0인데 SRT가 존재하고 불완전하면 손상
            // 출력으로 보고 실패 처리한다. 단, 내용이 전혀 없는 SRT(무음/음악
            // 전용 구간)는 경고만 남기고 성공으로 허용한다 — 빈 세그먼트를
            // REJECT하면 분할 전체를 폐기하고 단일 패스 재추출로 2배 시간이
            // 든다 (F2). 빈 내용은 mergeSrtFiles에서 무해하게 무시된다.
            if (!isCompleteSrt(srtPath)) {
              const raw = fs.readFileSync(srtPath, 'utf-8');
              if (raw.trim()) {
                reject(new Error('Segment processing produced an incomplete/truncated SRT (code: 0)'));
                return;
              }
              console.warn(`[Segment] Empty SRT (silent segment), accepting: ${path.basename(segmentPath)}`);
            }
            applyTokenTightTiming(outputBase, srtPath);
            content = fs.readFileSync(srtPath, 'utf-8');
            // 임시 SRT 파일 삭제
            try {
              fs.unlinkSync(srtPath);
            } catch (_e) {
              /* ignore */
            }
          }
          resolve(content);
        } catch (err) {
          reject(new Error(`Failed to read segment SRT: ${err.message}`));
        }
      } else if (fs.existsSync(srtPath) && isCompleteSrt(srtPath)) {
        try {
          applyTokenTightTiming(outputBase, srtPath);
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
      // 임시 SRT 잔재 정리 (프로세스 실행 자체 실패 시)
      try {
        if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
      } catch (_e) {}
      reject(err);
    });
  });
}

// ===== Audio Conversion Helper (오디오 변환 헬퍼) =====
// 유니코드 경로 문제 해결: 안전한 temp 경로에 WAV 생성
function convertToWav(inputPath) {
  return new Promise((resolve, reject) => {
    // 원본 경로가 ASCII인지 확인 (확장자 없는 파일도 원본을 덮어쓰지 않도록)
    const originalWavPath = withoutExt(inputPath) + '.wav';
    // .wav 직접 입력(MED-3): 사용자 제공 WAV는 16kHz/모노 표준이 아닐 수 있어
    // 항상 ffmpeg 정규화한다. 원본과 같은 경로로 출력하면 입력을 덮어쓰므로
    // (재사용 스킵 +) safe temp에 출력한다.
    const isWavInput = /\.wav$/i.test(inputPath);
    let wavPath;
    let usingSafeTemp = false;

    if (isAsciiPath(inputPath) && !isWavInput) {
      // ASCII 경로면 원본 위치에 생성
      wavPath = originalWavPath;
    } else {
      // 유니코드 경로 또는 .wav 직접 입력: 안전한 temp에 생성
      const safeTempDir = getSafeTempDir();
      wavPath = path.join(safeTempDir, `whisper_${Date.now()}.wav`);
      usingSafeTemp = true;
      console.log(
        `[Audio] ${isWavInput ? 'WAV input detected, normalizing to' : 'Unicode path detected, using'} safe temp: ${wavPath}`
      );
    }

    // WAV 파일이 이미 존재하면 완전하고 소스보다 최신인 경우에만 재사용한다.
    // 손상되었거나 오래된 형제 WAV는 사용자 파일일 수 있으므로 이동·삭제하지 않고,
    // 새 변환 결과를 safe temp에 만들어 추출 후 정리한다.
    if (!usingSafeTemp && fs.existsSync(wavPath)) {
      try {
        const wavStat = fs.statSync(wavPath);
        const srcStat = fs.statSync(inputPath);
        // 전체 WAV를 메인 프로세스에 동기 로드하지 않고 고정 64바이트 헤더와
        // stat 크기만 검증한다. 긴 영상의 수백 MB 메모리 급증을 막고, 4GB를
        // 넘는 RF64도 Buffer 최대 크기에 막히지 않고 ds64 크기를 확인한다.
        const wavComplete = isCompleteWavFile(wavPath, wavStat.size);
        if (wavComplete && wavStat.mtimeMs >= srcStat.mtimeMs) {
          console.log(`[Audio] WAV already exists: ${path.basename(wavPath)}`);
          // reused: 기존 형제 WAV를 재사용한 경우. 앱이 만든 게 아니라 사용자가 둔
          // 파일일 수 있으므로 추출 후 정리 단계에서 삭제하지 않는다 (F3).
          resolve({ wavPath, usingSafeTemp, originalWavPath, reused: true });
          return;
        }
        console.log(`[Audio] Preserving stale sibling WAV: ${path.basename(wavPath)}`);
      } catch (statErr) {
        console.log(`[Audio] WAV validation failed, preserving sibling: ${statErr.message}`);
      }
      wavPath = path.join(getSafeTempDir(), `whisper_${Date.now()}.wav`);
      usingSafeTemp = true;
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
    if (ffmpegProcess?.pid) childProcessIds.add(ffmpegProcess.pid);
    ffmpegProcess.once('close', () => childProcessIds.delete(ffmpegProcess.pid));
    ffmpegProcess.once('error', () => childProcessIds.delete(ffmpegProcess.pid));

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
        // 임시 WAV 정리 — safeTemp가 아니어도(원본 옆에 앱이 만든 형제 wav이므로)
        // 잘린 부분 파일이 남으면 mtime 재사용으로 손상 자막을 만들 수 있어 삭제한다.
        if (fs.existsSync(wavPath)) {
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
        resolve({ wavPath, usingSafeTemp, originalWavPath, reused: false });
      } else {
        // 실패/중지/타임아웃 모든 경로에서 잘린 WAV를 삭제한다.
        // 남겨두면 다음 실행에서 mtime이 최신인 부분 WAV를 재사용해
        // 손상 자막이 재생산된다 (P1). isUserStopped도 포함.
        if (fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch (_e) {
            /* ignore */
          }
        }
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

  if (device === 'cuda' || device === 'vulkan') {
    console.log(`[Performance] ${device.toUpperCase()} GPU settings applied`);
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

function parseFasterWhisperProgress(text) {
  const matches = [...text.matchAll(/(?:^|\r|\n)\s*(\d{1,3})%\s*\|/g)];
  if (!matches.length) return null;
  const pct = parseInt(matches[matches.length - 1][1], 10);
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

// stderr 청크에서 진행률 라인(whisper_print_progress_callback)을 제거 → 로그 스팸 방지.
function stripProgressLines(text) {
  return text.replace(/.*whisper_print_progress_callback:.*\r?\n?/g, '');
}

// Faster-Whisper-XXL: 일반 빌드와 달리 cuBLAS/cuDNN을 동봉해서 사용자 GPU로 바로 돈다.
// (일반 88MB 빌드는 CUDA 라이브러리가 없어 CPU 전용이었음.) 압축은 .7z(약 1.42GB).
const FASTER_WHISPER_ZIP_URL =
  'https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z';
// 이 아카이브는 풀려서 그대로 spawn되는 실행 파일이다. 데이터 모델과 달리 업스트림
// tag가 버전 고정이 아니라 같은 URL의 asset이 교체될 수 있으므로 해시를 고정한다.
// 업스트림이 digest를 게시하지 않아 아래 값은 직접 받아 측정했다 (2026-08-24):
//   curl -sL "$FASTER_WHISPER_ZIP_URL" -o xxl.7z && sha256sum xxl.7z && stat -c %s xxl.7z
// asset이 교체되면 검증이 실패하므로 그때는 이 두 상수를 다시 측정해 갱신해야 한다.
const FASTER_WHISPER_ZIP_SIZE = 1424256246;
const FASTER_WHISPER_ZIP_SHA256 = '237dee23939cdabfc96ef859fc5e584b842c3a5557e0d2ca744e1f87c14c5844';
const FASTER_WHISPER_EXE_NAME = 'faster-whisper-xxl.exe';
const FASTER_WHISPER_MODEL = 'large-v2';
// 모델 드롭다운에서 이 id를 고르면 whisper.cpp 대신 Faster-Whisper-XXL 싱크 엔진을 쓴다.
// 정밀(float16)과 라이트(int8)는 같은 model.bin을 공유하고 실행 시 compute_type만 다르다.
// 디스크 다운로드/삭제는 둘이 하나를 공유한다(모델 관리 카드 1개).
const SYNC_ENGINE_MODEL_ID = 'large-v2-sync';
const SYNC_ENGINE_LITE_MODEL_ID = 'large-v2-sync-lite';
let syncAssetsPromise = null;
const syncProgressListeners = new Set();
function isSyncEngineModel(model) {
  return model === SYNC_ENGINE_MODEL_ID || model === SYNC_ENGINE_LITE_MODEL_ID;
}

function getFasterWhisperRootDir() {
  return path.join(app.getPath('userData'), '_faster-whisper');
}

function getFasterWhisperEngineDir() {
  return path.join(getFasterWhisperRootDir(), 'engine');
}

// 추출된 엔진에서 exe를 재귀로 찾는다. 폴더명이 버전마다 바뀔 수 있어(예: 'Faster-Whisper-XXL')
// 하드코딩 대신 탐색한다. 캐시해서 매번 디스크를 훑지 않는다.
let _cachedFwExePath = null;
function findFasterWhisperExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === FASTER_WHISPER_EXE_NAME) return full;
    }
  }
  return null;
}

function getFasterWhisperExePath() {
  if (_cachedFwExePath && fs.existsSync(_cachedFwExePath)) return _cachedFwExePath;
  _cachedFwExePath = findFasterWhisperExe(getFasterWhisperEngineDir());
  // 미발견 시에도 기대 경로를 돌려줘 호출부의 존재검사/에러 메시지가 일관되게 동작.
  return _cachedFwExePath || path.join(getFasterWhisperEngineDir(), 'Faster-Whisper-XXL', FASTER_WHISPER_EXE_NAME);
}

// 번들된 7za.exe 경로 (구버전 Windows의 tar가 BCJ2 7z를 못 풀 때 폴백).
function get7zaExePath() {
  const rel = path.join('node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', rel) : path.join(__dirname, rel);
}

// .7z 추출: Windows 내장 tar.exe(libarchive, BCJ2 지원) 우선, 실패 시 번들 7za.exe 폴백.
async function extract7z(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // 추출 전 존재하던 항목 스냅샷: 실패 시 이 아카이브가 만든 부분 파일만
  // 지우고 기존 파일(다른 아카이브의 동시 추출 산출물 등)은 보존한다 (LOW-4).
  const preexisting = new Set();
  const snapshot = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      preexisting.add(full);
      if (e.isDirectory()) snapshot(full);
    }
  };
  snapshot(destDir);
  try {
    await execFileAsync('tar.exe', ['-xf', archivePath, '-C', destDir], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return;
  } catch (tarErr) {
    console.log('[FasterWhisper] tar.exe 7z extract failed, falling back to 7za.exe:', tarErr.message);
  }
  const sevenZip = get7zaExePath();
  if (!fs.existsSync(sevenZip)) {
    throw new Error(`7z extraction failed: neither tar.exe nor bundled 7za.exe worked (${sevenZip} missing)`);
  }
  try {
    await execFileAsync(sevenZip, ['x', archivePath, `-o${destDir}`, '-y'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    // 추출 실패 시 이 아카이브가 만든 부분 파일만 정리한다. 전체 rmSync는
    // 같은 디렉터리에 동시 추출 중인 다른 아카이브의 산출물까지 지우므로
    // 스냅샷에 없던 항목(이번 추출이 만든 것)만 삭제한다 (LOW-4).
    console.warn(`[FasterWhisper] 7z extraction failed, cleaning partial output: ${err.message}`);
    const cleanupPartial = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (preexisting.has(full)) continue; // 이번 추출 이전부터 있던 항목은 보존
        try {
          if (e.isDirectory()) {
            cleanupPartial(full);
            fs.rmdirSync(full);
          } else {
            fs.unlinkSync(full);
          }
        } catch (_e) {
          /* ignore */
        }
      }
    };
    cleanupPartial(destDir);
    throw err;
  }
}

function getFasterWhisperModelsDir() {
  return path.join(getFasterWhisperRootDir(), 'models');
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      file,
      args,
      { ...options, timeout: options.timeout ?? 10 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
    // quit/forceCleanup 시 고아 프로세스가 되지 않게 PID를 등록/해제한다 (P1).
    if (proc?.pid) childProcessIds.add(proc.pid);
    proc.once('close', () => childProcessIds.delete(proc.pid));
    proc.once('error', () => childProcessIds.delete(proc.pid));
  });
}

async function downloadFileWithProgress(url, destPath, label, onPercent, manifest) {
  const expectedSize = manifest?.size;
  const sha256 = manifest?.sha256;
  return downloadVerifiedFile({
    axios,
    assertDownloadDiskSpace,
    activeDownloads,
    isCancelled: () => downloadsCancelled,
    url,
    partialPath: destPath,
    label,
    expectedSize,
    sha256,
    onProgress: (percent, received, total) => {
      try {
        mainWindow?.webContents?.send('output-update', `${label} ${percent}%\n`);
      } catch (_e) {}
      onPercent?.(percent, received, total);
    },
  });
}

async function hasVerifiedFasterWhisperArchive(archivePath) {
  if (!fs.existsSync(archivePath)) return false;
  let verified = false;
  try {
    verified =
      fs.statSync(archivePath).size === FASTER_WHISPER_ZIP_SIZE &&
      (await sha256File(archivePath)) === FASTER_WHISPER_ZIP_SHA256;
  } catch (_e) {}
  if (!verified) fs.rmSync(archivePath, { force: true });
  return verified;
}

async function ensureFasterWhisperEngine(onPercent, archiveReady = false) {
  if (process.platform !== 'win32') {
    throw new Error('Faster-Whisper sync engine is currently available on Windows only.');
  }
  _cachedFwExePath = null; // 재탐색 강제
  let exePath = getFasterWhisperExePath();
  if (exePath && fs.existsSync(exePath)) return exePath;

  const rootDir = getFasterWhisperRootDir();
  const engineDir = getFasterWhisperEngineDir();
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(engineDir, { recursive: true });

  downloadsCancelled = false;
  const archivePath = path.join(rootDir, 'Faster-Whisper-XXL_windows.7z');
  const partialPath = archivePath + '.partial';
  // 지난번 압축 해제가 실패해 검증된 아카이브가 남아 있으면 다시 받지 않는다.
  // 예전에는 무조건 지워서 디스크가 빠들한 사용자가 시도할 때마다 1.4GB를 재다운로드했다.
  if (!archiveReady) archiveReady = await hasVerifiedFasterWhisperArchive(archivePath);

  if (archiveReady) {
    mainWindow?.webContents?.send('output-update', 'Reusing the verified sync engine archive already downloaded.\n');
  } else {
    mainWindow?.webContents?.send(
      'output-update',
      'Preparing GPU sync engine (Faster-Whisper-XXL, ~1.4GB). This first-time download can take a while...\n'
    );
    await downloadFileWithProgress(FASTER_WHISPER_ZIP_URL, partialPath, 'Sync engine (XXL)', onPercent, {
      size: FASTER_WHISPER_ZIP_SIZE,
      sha256: FASTER_WHISPER_ZIP_SHA256,
    });
    fs.renameSync(partialPath, archivePath);
  }

  mainWindow?.webContents?.send('output-update', 'Extracting GPU sync engine (this can take a minute)...\n');
  // 압축 파일과 추출 결과가 동시에 존재한다. 실제 압축률을 알 수 없으므로
  // 아카이브 크기의 3배를 추출 여유 공간으로 보수적으로 확보한다.
  assertDownloadDiskSpace(path.join(engineDir, '.extracting'), fs.statSync(archivePath).size * 3);
  await extract7z(archivePath, engineDir);
  try {
    fs.unlinkSync(archivePath);
  } catch (_e) {}

  _cachedFwExePath = null;
  exePath = getFasterWhisperExePath();
  if (!exePath || !fs.existsSync(exePath)) {
    throw new Error(`Faster-Whisper-XXL engine extraction failed (exe not found under ${engineDir})`);
  }
  mainWindow?.webContents?.send('output-update', 'GPU sync engine ready.\n');
  return exePath;
}

async function ensureFasterWhisperModel(emit = () => {}) {
  const modelDir = path.join(getFasterWhisperModelsDir(), `faster-whisper-${FASTER_WHISPER_MODEL}`);
  fs.mkdirSync(modelDir, { recursive: true });
  const baseUrl = `https://huggingface.co/Systran/faster-whisper-${FASTER_WHISPER_MODEL}/resolve/${SYNC_MODEL_REVISION}`;
  const smallFiles = ['config.json', 'tokenizer.json', 'vocabulary.txt'];

  for (let i = 0; i < smallFiles.length; i++) {
    const name = smallFiles[i];
    const manifest = SYNC_FILE_MANIFEST[name];
    const dest = path.join(modelDir, name);
    if (!hasExpectedSize(dest, manifest)) {
      const partial = dest + '.partial';
      await downloadFileWithProgress(`${baseUrl}/${name}`, partial, name, null, manifest);
      fs.renameSync(partial, dest);
    }
    emit(35 + i);
  }

  const binDest = path.join(modelDir, 'model.bin');
  if (!hasExpectedSize(binDest, SYNC_FILE_MANIFEST['model.bin'])) {
    const partial = binDest + '.partial';
    await downloadFileWithProgress(
      `${baseUrl}/model.bin`,
      partial,
      'model.bin',
      (pct) => emit(38 + pct * 0.62),
      SYNC_FILE_MANIFEST['model.bin']
    );
    fs.renameSync(partial, binDest);
  }
  emit(100);
  return modelDir;
}

async function ensureFasterWhisperAssets(onProgress) {
  if (typeof onProgress === 'function') syncProgressListeners.add(onProgress);
  const emit = (percent) => {
    for (const listener of syncProgressListeners) {
      try {
        listener(percent);
      } catch (_e) {}
    }
  };

  if (!syncAssetsPromise) {
    downloadsCancelled = false;
    syncAssetsPromise = (async () => {
      // 엔진 다운로드, 압축 해제 피크, model.bin까지 필요한 최대 공간을 첫
      // 네트워크 요청 전에 검사한다. 단계별 Content-Length 검사는 아래에서도 유지한다.
      const existingExePath = getFasterWhisperExePath();
      const engineInstalled = !!(existingExePath && fs.existsSync(existingExePath));
      const rootDir = getFasterWhisperRootDir();
      const modelPath = path.join(getFasterWhisperModelsDir(), `faster-whisper-${FASTER_WHISPER_MODEL}`, 'model.bin');
      const modelManifest = SYNC_FILE_MANIFEST['model.bin'];
      const modelInstalled = hasExpectedSize(modelPath, modelManifest);
      const engineArchivePath = path.join(rootDir, 'Faster-Whisper-XXL_windows.7z');
      const enginePartialPath = `${engineArchivePath}.partial`;
      const engineArchiveReady = !engineInstalled && (await hasVerifiedFasterWhisperArchive(engineArchivePath));
      if (engineInstalled || engineArchiveReady) fs.rmSync(enginePartialPath, { force: true });
      if (engineInstalled) fs.rmSync(engineArchivePath, { force: true });
      const enginePartialBytes = engineArchiveReady
        ? FASTER_WHISPER_ZIP_SIZE
        : getReusablePartialSize(enginePartialPath, FASTER_WHISPER_ZIP_SIZE);
      const modelPartialBytes = getReusablePartialSize(`${modelPath}.partial`, modelManifest.size);
      assertSyncInstallDiskSpace(
        path.join(rootDir, '.installing'),
        engineInstalled,
        modelInstalled,
        enginePartialBytes,
        modelPartialBytes
      );

      const exePath = await ensureFasterWhisperEngine((pct) => emit(pct * 0.32), engineArchiveReady);
      emit(34);
      await ensureFasterWhisperModel(emit);
      _cachedFwExePath = null;
      return exePath;
    })().finally(() => {
      syncAssetsPromise = null;
      syncProgressListeners.clear();
    });
  }

  try {
    return await syncAssetsPromise;
  } finally {
    if (typeof onProgress === 'function') syncProgressListeners.delete(onProgress);
  }
}

function buildFasterWhisperArgs(wavPath, outputDir, language, useGpu, lite = false, computeType = null) {
  const args = [
    wavPath,
    '--model',
    FASTER_WHISPER_MODEL,
    '--task',
    'transcribe',
    '--output_dir',
    outputDir,
    '--model_dir',
    getFasterWhisperModelsDir(),
    '--output_format',
    'srt',
    '--word_timestamps',
    'True',
    '--vad_filter',
    reduceRepetition ? 'True' : 'False',
    '--vad_threshold',
    '0.3',
    '--vad_min_silence_duration_ms',
    '200',
    '--vad_speech_pad_ms',
    '100',
    '--sentence',
    '--standard_asia',
    // GPU(cuda)면 float16, CPU면 int8. XXL은 cuBLAS/cuDNN을 동봉해 GPU에서 바로 동작한다.
    '--device',
    useGpu ? 'cuda' : 'cpu',
    // 라이트는 GPU에서 int8_float16(가중치 int8 + 누적 float16)으로 VRAM을 줄인다(품질 손실 극소).
    // CPU는 정밀/라이트 모두 int8(CTranslate2 CPU 표준)이라 차이가 없다.
    // computeType이 명시되면(구형 GPU float32 재시도) 그 값을 우선 사용한다.
    '--compute_type',
    computeType || (useGpu ? (lite ? 'int8_float16' : 'float16') : 'int8'),
    // CPU 경로일 때만 의미: 이 엔진은 기본 최대 4스레드(--help: "no more than 4")라
    // 멀티코어 PC에서 절반도 못 쓴다. 물리 코어 수만큼 올린다(최대 8, 과구동 방지).
    '--threads',
    String(Math.max(4, Math.min(os.cpus().length, 8))),
    '--print_progress',
    '--beep_off',
  ];
  if (language && language !== 'auto') {
    args.splice(5, 0, '--language', language);
  }
  return args;
}

async function runFasterWhisperExtraction(
  filePath,
  wavPath,
  language,
  device,
  model = SYNC_ENGINE_MODEL_ID,
  srtOutputOverride = null
) {
  const lite = model === SYNC_ENGINE_LITE_MODEL_ID;
  const modeLabel = lite ? 'large-v2 lite' : 'large-v2';
  if (isUserStopped) throw new Error('Stopped by user');
  const exePath = await ensureFasterWhisperAssets();
  const outputDir = path.join(getSafeTempDir(), `fw_out_${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(getFasterWhisperModelsDir(), { recursive: true });

  const outputSrt = path.join(outputDir, `${path.basename(wavPath, path.extname(wavPath))}.srt`);
  const finalSrtPath = srtOutputOverride || srtOutputPathFor(filePath);

  // Sync는 CUDA/CPU 전용이다. CPU 요청은 CPU만 사용하고, CUDA가 없으면
  // 자동/GPU 요청도 CPU로 전환한다. CUDA가 있으면 GPU 실패 시 CPU로 폴백한다.
  // Compute Capability < 7.0(Volta 이하) GPU는 float16을 지원하지 않으므로(이슈 #45),
  // GPU 시도가 실패하면 float32로 한 번 더 시도한 뒤 CPU로 폴백한다.
  const requestedDevice = String(device || 'auto').toLowerCase();
  const gpuCompute = lite ? 'int8_float16' : 'float16';
  const cudaAvailable = isCudaAvailable();
  // GPU 명시는 GPU만, 자동은 GPU 뒤에 CPU까지. CUDA가 아예 없으면 둘 다 CPU로 간다.
  const gpuAttempts = [
    { useGpu: true, computeType: gpuCompute },
    { useGpu: true, computeType: 'float32' }, // CC<7.0 재시도
  ];
  const attempts =
    requestedDevice === 'cpu' || !cudaAvailable
      ? [{ useGpu: false, computeType: 'int8' }]
      : requestedDevice === 'cuda' || requestedDevice === 'gpu'
        ? gpuAttempts
        : [...gpuAttempts, { useGpu: false, computeType: 'int8' }];
  if (requestedDevice !== 'cpu' && !cudaAvailable) {
    mainWindow?.webContents?.send(
      'output-update',
      'Sync engine supports CUDA or CPU only. CUDA is unavailable, so this run will use CPU. Vulkan is not used by Sync.\n'
    );
  }

  const runOnce = (attempt) =>
    new Promise((resolve, reject) => {
      const useGpu = attempt.useGpu;
      const args = buildFasterWhisperArgs(wavPath, outputDir, language, useGpu, lite, attempt.computeType);
      mainWindow?.webContents?.send(
        'output-update',
        `Starting sync repair extraction (${modeLabel}, ${useGpu ? 'GPU ' + attempt.computeType : 'CPU'}). This mode is for subtitles that do not sync with normal models; English is usually faster with large-v3-turbo. First run may download the model (~3GB).\n`
      );
      console.log(`[FasterWhisper] (${useGpu ? 'GPU' : 'CPU'}) ${exePath} ${args.join(' ')}`);
      if (isUserStopped) return reject(new Error('Stopped by user'));

      const proc = spawn(exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.dirname(exePath),
        // PyInstaller exe non-TTY pipe stdout block-buffering -> progress arrives
        // all at once at the end. PYTHONUNBUFFERED forces real-time streaming.
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
      currentProcess = proc;
      if (proc?.pid) childProcessIds.add(proc.pid);
      proc.once('close', () => childProcessIds.delete(proc.pid));
      proc.once('error', () => childProcessIds.delete(proc.pid));

      const timeout = setTimeout(
        () => {
          if (proc && !proc.killed) {
            console.log('[FasterWhisper TIMEOUT] exceeded 3 hours');
            proc.kill('SIGKILL');
          }
        },
        3 * 60 * 60 * 1000
      );

      let lastLoggedPct = -1;
      let lastProgressLogAt = 0;
      const handleOutput = (data) => {
        const output = data.toString('utf8');
        const pct = parseFasterWhisperProgress(output);
        if (pct != null) {
          sendExtractionProgress(pct);
          // Show transcription progress as a human-readable line every 3s so the
          // log does not look frozen during the long single-pass transcription.
          const now = Date.now();
          if (pct !== lastLoggedPct && (pct === 100 || now - lastProgressLogAt >= 3000)) {
            lastLoggedPct = pct;
            lastProgressLogAt = now;
            const where = useGpu ? 'GPU' : 'CPU';
            mainWindow?.webContents?.send(
              'output-update',
              `Transcribing (sync-first ${modeLabel}, ${where})... ${pct}%\n`
            );
          }
        }
        // tqdm progress chunks contain carriage returns and can spam the log. Keep meaningful lines.
        const cleaned = output
          .replace(/\r[^\n]*\|[^\n]*/g, '')
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .trim();
        if (cleaned) mainWindow?.webContents?.send('output-update', cleaned + '\n');
      };

      proc.stdout.on('data', handleOutput);
      proc.stderr.on('data', handleOutput);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (currentProcess === proc) currentProcess = null;
        if (isUserStopped) return reject(new Error('Stopped by user'));
        // 파일이 아예 없는 건 무음이 아니라 실패다. 아래 copyFileSync가 ENOENT로 죽고
        // 남은 재시도(float32, CPU)도 소모되지 않으므로 존재할 때만 빈 출력을 허용한다.
        const outputExists = fs.existsSync(outputSrt);
        const outputEmpty = outputExists && !fs.readFileSync(outputSrt, 'utf8').trim();
        const outputComplete = outputExists && isCompleteSrt(outputSrt);
        if (code === 0 && (outputEmpty || outputComplete)) return resolve();
        if (outputComplete) return resolve();
        reject(new Error(`Faster-Whisper failed (exit ${code})`));
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        if (currentProcess === proc) currentProcess = null;
        reject(err);
      });
    });

  let lastErr = null;
  for (let ai = 0; ai < attempts.length; ai++) {
    const attempt = attempts[ai];
    try {
      await runOnce(attempt);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (isUserStopped) throw e;
      // GPU 실패 → 다음 시도가 남아있으면(float32 또는 CPU) 계속.
      if (ai < attempts.length - 1) {
        const next = attempts[ai + 1];
        const nextLabel = next.useGpu ? `GPU (${next.computeType})` : 'CPU (slower)';
        mainWindow?.webContents?.send(
          'output-update',
          `GPU run failed (${e.message}). Falling back to ${nextLabel}...\n`
        );
        try {
          fs.rmSync(outputSrt, { force: true });
        } catch (_e) {}
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;

  fs.copyFileSync(outputSrt, finalSrtPath);
  try {
    fs.rmSync(outputDir, { recursive: true, force: true });
  } catch (_e) {}
  mainWindow?.webContents?.send('output-update', `Sync-first SRT saved: ${finalSrtPath}\n`);
  return finalSrtPath;
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
  // -vmsd 30: VAD 세그먼트 최대 30초. 기본값이 'unlimited'라 다화자 교대를 한 큐로
  // 통째로 삼키던 문제(이슈 #46) 해결. 30초면 일반 발화는 안 쪼개면서도
  // 길게 이어지는 대화 교대는 분리해준다.
  return ['--vad', '--vad-model', vadModel, '-vt', '0.3', '-vsd', '200', '-vp', '100', '-vmsd', '30'];
}

// Single File Subtitle Extraction (Promise-based) - whisper.cpp 버전
// srtOutputOverride: 배치 basename 충돌 시 강제할 출력 SRT 경로 (null이면 기본 규칙)
function extractSingleFileOnce(filePath, model, language, device, srtOutputOverride = null) {
  return new Promise((resolve, reject) => {
    const start = async () => {
      console.log(`[START] Processing: ${path.basename(filePath)}`);
      // isUserStopped는 배치 루프(extract-subtitles) 시작에서 한 번만 초기화한다.
      // 여기서 매 파일마다 false로 리셋하면 파일 간 10초 대기 창에 stop을 눌러도
      // 다음 파일이 진행되는 문제(P1-3)가 생긴다.

      // Force cleanup before each file
      await forceMemoryCleanup(device, true);

      const basePath = app.isPackaged ? process.resourcesPath : __dirname;

      // 실제 사용할 장치 결정: CUDA 우선, 없으면 동봉 Vulkan, 마지막으로 CPU.
      const chosenDevice = resolveDevice(device, basePath);
      const gpuInfo = getGpuInfo();

      // 사용자에게 보이는 장치 안내는 extractSingleFile 래퍼가 담당한다.
      // 여기에는 이미 해석된 구체 장치만 들어온다.
      console.log(`[Whisper] device=${chosenDevice}`);

      // CUDA와 Vulkan 모두 쓸 수 없을 때만 구형 NVIDIA 경고를 표시한다.
      if (gpuInfo.available && !gpuInfo.cudaCompatible && chosenDevice === 'cpu' && !_gpuWarningShown) {
        _gpuWarningShown = true;
        const warn = `[GPU] ${gpuInfo.name} (Compute ${gpuInfo.computeCap}) - CUDA 12 requires Compute 5.0+. Auto CPU mode.`;
        console.log(warn);
        mainWindow.webContents.send('output-update', warn + '\n');
      }

      // whisper.cpp 실행 파일 경로
      const whisperDir = path.join(basePath, 'whisper-cpp');
      const cpuDir = path.join(whisperDir, 'cpu');
      const vulkanDir = path.join(whisperDir, 'vulkan');
      const cpuExePath = path.join(cpuDir, WHISPER_CLI_NAME);
      // CPU 모드일 때 CPU 전용 바이너리 우선 사용 (CUDA DLL 의존성 없음).
      // 단, whisper-cli.exe만 있고 의존 DLL(whisper.dll, ggml*.dll)이 빠진
      // 깨진 설치(issue #26)에서는 spawn이 ENOENT로 실패하므로, Windows에서는
      // 의존 DLL 존재 여부도 확인해 폴백 처리한다.
      let cpuBuildUsable = chosenDevice === 'cpu' && fs.existsSync(cpuExePath);
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
      const useVulkanBuild = chosenDevice === 'vulkan';
      const exePath = useVulkanBuild
        ? path.join(vulkanDir, WHISPER_CLI_NAME)
        : useCpuBuild
          ? cpuExePath
          : path.join(whisperDir, WHISPER_CLI_NAME);
      const exeCwd = useVulkanBuild ? vulkanDir : useCpuBuild ? cpuDir : whisperDir;
      const buildLabel = useVulkanBuild
        ? `vulkan/${WHISPER_CLI_NAME} (Vulkan build)`
        : useCpuBuild
          ? `cpu/${WHISPER_CLI_NAME} (CPU build)`
          : `${WHISPER_CLI_NAME} (CUDA build)`;
      console.log(`[Whisper] Using: ${buildLabel} (${chosenDevice})`);

      // WAV 변환 (whisper.cpp는 WAV만 지원)
      let wavPath,
        usingSafeTemp = false,
        wavReused = false;
      try {
        const wavResult = await convertToWav(filePath);
        wavPath = wavResult.wavPath;
        usingSafeTemp = wavResult.usingSafeTemp;
        wavReused = !!wavResult.reused;
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

      // 모델 드롭다운에서 'large-v2-sync'(정밀) 또는 'large-v2-sync-lite'(int8)를 고르면
      // whisper.cpp 대신 Faster-Whisper-XXL로 추출한다. 둘은 같은 엔진+model.bin을 공유하고
      // compute_type만 다르다. 장치 선택은 일반 모델과 일관되게 따른다:
      // CPU = CPU만, GPU = GPU만, 자동 = GPU 먼저 시도 후 CPU 폴백.
      if (isSyncEngineModel(model)) {
        try {
          const finalSrtPath = await runFasterWhisperExtraction(
            filePath,
            wavPath,
            language,
            device,
            model,
            srtOutputOverride
          );
          if (wavPath !== filePath && !wavReused && fs.existsSync(wavPath)) {
            try {
              fs.unlinkSync(wavPath);
            } catch (_e) {
              /* ignore */
            }
          }
          return resolve(finalSrtPath);
        } catch (fwErr) {
          if (wavPath !== filePath && !wavReused && fs.existsSync(wavPath)) {
            try {
              fs.unlinkSync(wavPath);
            } catch (_e) {
              /* ignore */
            }
          }
          return reject(fwErr);
        }
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
      let mediaDurationSec = 0; // 단일 파일 경로의 타임아웃 스케일링에도 사용
      try {
        mediaDurationSec = await getMediaDuration(wavPath);
        if (mediaDurationSec > SEGMENT_DURATION + 60) {
          // 31분 이상이면 분할
          segments = await splitAudioToSegments(wavPath, mediaDurationSec);
          useSegmentedProcessing = segments.length > 1;
          if (useSegmentedProcessing) {
            console.log(
              `[Split] Will process ${segments.length} segments for ${(mediaDurationSec / 60).toFixed(1)} min audio`
            );
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

          // 최종 SRT 파일 저장 (확장자 없는 입력도 원본을 덮어쓰지 않게)
          const originalSrtPath = srtOutputOverride || srtOutputPathFor(filePath);
          fs.writeFileSync(originalSrtPath, mergedSrt, 'utf-8');
          console.log(`[Split] Merged SRT saved: ${originalSrtPath}`);
          mainWindow.webContents.send('output-update', `Subtitle merge completed!\n`);

          // WAV 임시 파일 정리 (재사용된 형제 WAV는 삭제하지 않는다 — F3)
          if (wavPath !== filePath && !wavReused && fs.existsSync(wavPath)) {
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

      // SRT 출력 경로 (확장자 없는 입력이면 원본 경로에 .srt 를 붙여 덮어쓰기 방지)
      // 유니코드 경로면 temp에 생성 후 원본 위치로 복사
      const originalSrtPath = srtOutputOverride || srtOutputPathFor(filePath);
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
        // 충돌 오버라이드가 있으면 whisper -of 베이스도 오버라이드 기준으로 맞춘다
        outputBase = srtOutputOverride ? withoutExt(srtOutputOverride) : withoutExt(filePath);
      }

      // whisper.cpp 인자 구성
      const args = [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-osrt', // SRT 출력
        '-ojf', // 토큰별 실제 시각 포함 JSON → 자막 끝을 실발화 끝으로 트림
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
      } else if (chosenDevice === 'vulkan') {
        mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (Vulkan)...\n');
        console.log('[GPU Config] whisper.cpp with Vulkan acceleration');
      } else {
        mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (CPU mode)...\n');
      }

      const mainSpawnEnv = getWhisperSpawnEnv(chosenDevice, exeCwd);
      let stderrBuffer = '';
      currentProcess = spawn(exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: exeCwd,
        ...(mainSpawnEnv ? { env: mainSpawnEnv } : {}),
      });
      if (currentProcess?.pid) childProcessIds.add(currentProcess.pid);
      currentProcess.once('close', () => childProcessIds.delete(currentProcess.pid));
      currentProcess.once('error', () => childProcessIds.delete(currentProcess.pid));

      // Process timeout handling — 실제 미디어 길이 × 실시간 계수로 스케일링
      // (기존 30분 고정은 CPU+large 모델이 걸린 작업을 무조건 죽이던 문제가 있었다)
      const processTimeoutMs = extractionTimeoutMs(mediaDurationSec, chosenDevice);
      let timedOut = false;
      const processTimeout = setTimeout(() => {
        if (currentProcess && !currentProcess.killed) {
          console.log(`[TIMEOUT] ${path.basename(filePath)} - exceeded ${Math.round(processTimeoutMs / 60000)} min`);
          timedOut = true;
          currentProcess.kill('SIGKILL');
        }
      }, processTimeoutMs);

      currentProcess.stdout.on('data', (data) => {
        const output = data.toString('utf8');
        mainWindow.webContents.send('output-update', output);
      });

      currentProcess.stderr.on('data', (data) => {
        const output = data.toString('utf8');
        stderrBuffer = (stderrBuffer + output).slice(-8192);
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

        // SRT 존재 확인 (wav 정리 전에 해야 끝시각 정리에 wav를 쓸 수 있다)
        let srtExists = fs.existsSync(srtPath);

        // 토큰 끝시각 기반 끝 트림(VAD 늘어짐). 텍스트 위치는 안 바꿈. wav 삭제 전.
        if (srtExists) {
          applyTokenTightTiming(outputBase, srtPath);
        }

        // WAV 임시 파일 정리 (원본이 WAV가 아닌 경우). 재사용된 형제 WAV는
        // 앱이 만든 게 아닐 수 있으므로 삭제하지 않는다 (F3).
        if (wavPath !== filePath && !wavReused && fs.existsSync(wavPath)) {
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

        // code 0 + 비어 있지 않은 불완전 SRT는 손상 출력이다. SRT가 없거나
        // 완전히 비어 있는 경우만 무음 정상 종료로 허용한다.
        const srtComplete = srtExists && isCompleteSrt(srtPath);
        const srtEmpty = !srtExists || !fs.readFileSync(srtPath, 'utf8').trim();
        if ((code === 0 && (srtEmpty || srtComplete)) || srtComplete) {
          if (code === 0 && srtEmpty) {
            console.warn(`[WARN] ${path.basename(filePath)} exited 0 with empty SRT (silent video?)`);
            mainWindow.webContents.send(
              'output-update',
              `[Warning] Subtitle file is empty (no speech detected in this video/audio).\n`
            );
            if (!srtExists) {
              // exit 0 성공 계약상 반환 경로에는 실제 빈 SRT 파일이 존재해야 한다
              // (분할 경로와 동일 거동). 없으면 번역 단계가 그 경로로 ENOENT 낸다.
              try {
                fs.writeFileSync(srtPath, '', 'utf8');
                srtExists = true;
              } catch (srtErr) {
                // 빈 SRT조차 못 만들 자리의 경로를 성공으로 돌려보내지 않는다.
                // WAV 정리는 이 핸들러 앞쪽에서 이미 끝난 상태다.
                return reject(new Error(`Could not create empty SRT placeholder: ${srtErr.message}`));
              }
            }
          }
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
          const stderrText = stderrBuffer.toLowerCase();
          const looksLikeDyldMissingLib =
            process.platform === 'darwin' &&
            (stderrText.includes('dyld: library not loaded') ||
              (stderrText.includes('library not loaded:') && stderrText.includes('.dylib')) ||
              (stderrText.includes('image not found') && stderrText.includes('.dylib')));
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
          } else if (looksLikeDyldMissingLib) {
            errorMessage =
              `${WHISPER_CLI_NAME} failed to launch on macOS because a required shared library is missing. ` +
              'Run npm install again to restore whisper-cpp, or rebuild it so libwhisper*.dylib and libggml*.dylib are copied into whisper-cpp/.';
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
              // Windows에서는 spawn이 성공했으므로 바이너리는 실제로 실행됐다.
              // 127을 POSIX의 "command not found"로 번역하면 파일이 멀쩡히 있는
              // 사용자에게 파일을 찾으라는 잘못된 안내가 나간다.
              errorMessage =
                `${WHISPER_CLI_NAME} started but stopped with exit code 127. ` +
                'A dependent library in the whisper-cpp folder is missing or blocked ' +
                '(antivirus quarantine is the usual cause).';
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
          const failure = new Error(errorMessage);
          if (code === 1) failure.inputError = true;
          // 문구를 바꾸면 renderer의 현지화 매핑을 빗나가 영어 원문이 노출된다.
          // 플래그로 실어 장치 폴백 판정에만 쓴다.
          if (timedOut) failure.timedOut = true;
          reject(failure);
        }
      });

      currentProcess.on('error', async (err) => {
        clearTimeout(processTimeout); // Clear timeout
        await forceMemoryCleanup(chosenDevice, true);

        // 임시 WAV/SRT 잔재 정리 (spawn 자체 실패: ENOENT/EACCES 등).
        // 재사용된 형제 WAV는 삭제하지 않는다 (F3).
        if (wavPath !== filePath && !wavReused && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch (_e) {}
        }
        if (usingSafeTemp && fs.existsSync(srtPath)) {
          try {
            fs.unlinkSync(srtPath);
          } catch (_e) {}
        }

        // spawn 실패의 원인은 두 갈래다: 파일이 정말 없는 경우와, 파일은 있는데
        // 실행이 막힌 경우(백신 격리·잠금, 의존 라이브러리 차단). 둘을 모두
        // "not found"로 뭉치면 바이너리를 동봉해 배포한 빌드에서 사용자가
        // 있지도 않은 설치 문제를 찾게 된다.
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          const isWin = process.platform === 'win32';
          const exeExists = fs.existsSync(exePath);

          let reason;
          if (err.code === 'EACCES') {
            reason =
              `${WHISPER_CLI_NAME} could not be launched: access denied at ${exePath}. ` +
              (isWin
                ? 'Another process — usually antivirus — is blocking or holding the file.'
                : `Make it executable with: chmod +x "${exePath}"`);
          } else if (exeExists) {
            reason =
              `${WHISPER_CLI_NAME} could not be launched even though the file exists at ${exePath}. ` +
              (isWin
                ? 'A dependent library (whisper.dll or ggml*.dll) in the same folder is missing or blocked.'
                : 'A dependent shared library (libwhisper / libggml) could not be loaded.');
          } else {
            reason = `${WHISPER_CLI_NAME} is missing from ${exeCwd}.`;
          }

          const recovery = app.isPackaged
            ? [
                'This build ships whisper.cpp, so the files were removed or blocked after installation.',
                'Antivirus quarantine is the usual cause — these binaries are unsigned.',
                '',
                'How to recover:',
                `   - Check your antivirus quarantine / protection history for ${WHISPER_CLI_NAME}`,
                `   - Restore it and exclude this folder from real-time scanning: ${exeCwd}`,
                '   - Or re-extract the release archive over this installation',
                '   - Restart the app',
              ]
            : [
                'Install whisper.cpp into the whisper-cpp folder:',
                '   - Run: npm install   (postinstall downloads a prebuilt binary)',
                '   - Or take a build from https://github.com/ggml-org/whisper.cpp/releases',
                `   - Place ${WHISPER_CLI_NAME} and its runtime libraries into whisper-cpp/`,
                ...(isWin ? [] : [`   - chmod +x whisper-cpp/${WHISPER_CLI_NAME}`]),
                '   - Restart the app',
              ];

          mainWindow.webContents.send(
            'output-update',
            '\n' +
              '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
              `[ERROR] ${WHISPER_CLI_NAME.toUpperCase()} ${exeExists ? 'CANNOT RUN' : 'IS MISSING'}\n` +
              '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
              reason +
              '\n\n' +
              recovery.join('\n') +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
          );

          reject(new Error(reason));
        } else {
          reject(err);
        }
      });
    };
    start().catch(reject);
  });
}

function isWhisperFallbackEligible(error) {
  if (isUserStopped) return false;
  const message = String(error?.message || error).toLowerCase();
  // 타임아웃까지 폴백하면 긴 영상이 장치마다 타임아웃을 다시 돌아 몇 시간이 더 든다.
  return (
    !error?.inputError &&
    !error?.timedOut &&
    !/stopped|cancelled|canceled|model not found|unknown model|download|not enough disk/.test(message)
  );
}

async function extractSingleFile(filePath, model, language, device, srtOutputOverride = null) {
  const requested = String(device || 'auto').toLowerCase();
  if (requested === 'cpu' || isSyncEngineModel(model)) {
    return extractSingleFileOnce(filePath, model, language, device, srtOutputOverride);
  }

  const basePath = app.isPackaged ? process.resourcesPath : __dirname;
  const selected = resolveDevice(device, basePath);
  // 사용할 수 없는 Vulkan은 후보에서 미리 빼둔다. 그래야 폴백 안내 문구가
  // 실제로 다음에 실행될 장치와 일치한다.
  const candidates = (
    selected === 'cuda' ? ['cuda', 'vulkan', 'cpu'] : selected === 'vulkan' ? ['vulkan', 'cpu'] : ['cpu']
  ).filter((candidate) => candidate !== 'vulkan' || isVulkanAvailable(basePath));

  // 장치 안내는 여기서 한 번 보낸다. extractSingleFileOnce에는 이미 해석된 구체
  // 장치가 넘어가므로 그쪽의 auto/cuda 비교 분기는 절대 참이 되지 않는다.
  const first = candidates[0];
  if (requested === 'auto') {
    mainWindow?.webContents?.send('output-update', `Auto device: using ${first.toUpperCase()}\n`);
  } else if (first === 'vulkan') {
    mainWindow?.webContents?.send('output-update', 'CUDA unavailable, using Vulkan GPU\n');
  } else if (first === 'cpu') {
    mainWindow?.webContents?.send('output-update', 'GPU not available, falling back to CPU\n');
  }

  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      return await extractSingleFileOnce(filePath, model, language, candidate, srtOutputOverride);
    } catch (error) {
      lastError = error;
      if (candidate === 'cpu' || !isWhisperFallbackEligible(error)) throw error;
      const next = candidates[index + 1];
      if (!next) throw error;
      const message = `${candidate.toUpperCase()} run failed, falling back to ${next.toUpperCase()}...\n`;
      console.warn(`[Whisper] ${message.trim()} ${error.message}`);
      mainWindow?.webContents?.send('output-update', message);
      await forceMemoryCleanup(candidate, true);
    }
  }
  throw lastError || new Error('Whisper extraction failed');
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
  // 새 배치는 이전 배치의 stop 상태에서 벗어난다. 이후 각 파일 시작부가 아니라
  // 여기서만 리셋해 파일 간 대기 창의 stop을 살아있게 한다(P1-3).
  isUserStopped = false;
  // 배치 내 같은 basename(예: movie.mkv + movie.mp4)이 같은 .srt로 덮어쓰는 충돌 방지.
  // 이미 쓰인 출력 베이스가 있으면 소스 확장자를 붙인 이름(movie.mkv.srt)으로 분리한다.
  const usedSrtBases = new Set();

  for (let i = 0; i < filesToProcess.length; i++) {
    const currentFile = filesToProcess[i];
    if (!currentFile) continue;

    // 이전 파일 처리 중(대기 창 포함) stop이 세워졌으면 남은 파일을 건너뛴다.
    if (isUserStopped) {
      userStopped = true;
      break;
    }

    // 충돌 시 사용할 출력 SRT 경로 결정 (extractSingleFile이 내부에서 이 값을 그대로 쓴다)
    const normalSrt = srtOutputPathFor(currentFile);
    let srtOutputOverride = null;
    if (usedSrtBases.has(normalSrt)) {
      const srcExt = path.extname(currentFile);
      srtOutputOverride = `${withoutExt(currentFile)}${srcExt}.srt`;
      event.sender.send(
        'output-update',
        `[Collision] ${path.basename(normalSrt)} already used by an earlier file — saving as ${path.basename(srtOutputOverride)}\n`
      );
      usedSrtBases.add(srtOutputOverride);
    } else {
      usedSrtBases.add(normalSrt);
    }

    try {
      const srtPath = await extractSingleFile(currentFile, model, language, device, srtOutputOverride);

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
            const applied = [cleanup.removeSpeakerTags ? 'speaker tags' : null, cleanup.removeSDH ? 'SDH tags' : null]
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
          // 대기 중 stop이 세워졌으면 다음 파일을 시작하지 않는다(P1-3).
          if (isUserStopped) {
            userStopped = true;
            break;
          }
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
      if (i < filesToProcess.length - 1 && !isUserStopped) {
        const nextFile = filesToProcess[i + 1];
        event.sender.send('output-update', `Next file: ${path.basename(nextFile)}\n`);

        if (device === 'cuda') {
          event.sender.send('output-update', `Recovering and preparing next file... (wait 10s)\n`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          // 대기 중 stop이 세워졌으면 다음 파일을 시작하지 않는다(P1-3).
          if (isUserStopped) {
            userStopped = true;
            break;
          }
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
ipcMain.handle('show-open-dialog', async (_event, options) => {
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
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // 데스크톱 핸들러가 없는 환경(헤드리스, 최소 설치 WM)에서는 xdg-open이
    // 종료도 오류도 없이 매달릴 수 있다. 그러면 이 Promise가 영영 안 끝나서
    // 호출한 IPC가 "reply was never sent"로 멈췄다. 상한을 둔다.
    const timer = setTimeout(() => done(false), 5000);
    timer.unref?.();
    try {
      const proc = spawn('xdg-open', [targetPath], { stdio: 'ignore', detached: true });
      proc.on('error', () => done(false));
      proc.on('exit', (code) => done(code === 0));
      proc.unref();
    } catch (_err) {
      done(false);
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
        // unlink 실패를 삼키지 않는다: 상위 catch로 전파해 { success: false, error }를 반환
        // (히스토리 파일이 남으면 재시작 시 기록이 부활하므로 정직하게 실패를 알린다)
        fs.unlinkSync(fp);
      }
    } catch (unlinkErr) {
      // 위 내부 catch(_)와 달리 여기는 실제 unlink 실패(EACCES/EBUSY)만 잡아 전파한다.
      return { success: false, error: `Failed to clear history file: ${unlinkErr.message}` };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-location', async (_event, filePath) => {
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

// shell.openPath는 데스크톱 포털이 없는 리눅스에서 resolve되지 않고 매달릴 수 있다.
// 그대로 두면 호출한 IPC가 응답을 못 보내 버튼이 먹힌다(reply was never sent).
// 상한을 두고 리눅스에서는 xdg-open으로 폴백한다.
async function openPathSafely(targetPath) {
  const { shell } = require('electron');
  const TIMED_OUT = Symbol('timeout');
  let timer = null;
  let result;
  try {
    result = await Promise.race([
      shell.openPath(targetPath),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), 3000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // openPath는 성공 시 빈 문자열, 실패 시 오류 문자열을 돌려준다.
  if (result !== TIMED_OUT && !result) return true;
  if (process.platform === 'linux') return openWithXdg(targetPath);
  return false;
}

// 폴더 열기
ipcMain.handle('open-folder', async (_event, folderPath) => {
  if (!isSafeLocalPath(folderPath)) {
    return { success: false, error: 'invalid path' };
  }
  try {
    const opened = await openPathSafely(folderPath);
    return opened ? { success: true } : { success: false, error: 'no handler available' };
  } catch (error) {
    console.error('Failed to open folder:', error);
    return { success: false, error: error.message };
  }
});

// 모델 폴더 열기: 렌더러가 경로를 몰라도 되게 main에서 직접 해석한다.
// getGgmlModelsDir()를 그대로 쓰므로 비ASCII 계정 폴백 경로까지 자동으로 따른다.
ipcMain.handle('open-models-folder', async () => {
  const dir = getGgmlModelsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const opened = await openPathSafely(dir);
    return opened ? { success: true, path: dir } : { success: false, error: 'no handler available', path: dir };
  } catch (error) {
    console.error('Failed to open models folder:', error);
    return { success: false, error: error.message, path: dir };
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
    if (!ALLOWED_OPEN_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    // github.com은 <소유자>/<레포> 하위 경로만 허용한다. 릴리스 노트 링크는
    // /releases/tag/v2.4.5, 엔진 다운로드는 /releases/download/... 형태라
    // 레포 루트 두 세그먼트만 고정하고 그 아래는 허용한다.
    // (경로 세그먼트에 .. 이 섞이면 거부해 상위 탈출 표기를 막는다.)
    const pathname = parsed.pathname.replace(/\/$/, '');
    if (parsed.hostname.toLowerCase() === 'github.com') {
      if (!/^\/[\w.-]+\/[\w.-]+(\/[\w./+-]*)?$/.test(pathname)) return false;
      if (pathname.split('/').includes('..')) return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

ipcMain.handle('open-external', async (_event, url) => {
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

// 싱크 엔진(large-v2-sync) 사전 다운로드: 엔진(7z) + Systran large-v2 모델 파일을 받는다.
// 모델 관리 카드가 쓰는 'whisper-model-progress'(modelName='large-v2-sync')로 진행률을 보낸다.
ipcMain.handle('download-sync-engine', async () => {
  const emit = (percent) => {
    try {
      mainWindow?.webContents?.send('whisper-model-progress', {
        modelName: SYNC_ENGINE_MODEL_ID,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
      });
    } catch (_e) {}
  };
  try {
    // 엔진과 모델 전체를 일반 실행 경로와 같은 단일 in-flight 다운로드로 공유한다.
    await ensureFasterWhisperAssets(emit);
    return { success: true };
  } catch (error) {
    const msg = String(error?.message || error);
    const cancelled =
      /cancell?ed/i.test(msg) || error?.name === 'CanceledError' || String(error?.name || '').includes('AbortError');
    if (cancelled) return { success: false, error: 'cancelled', userStopped: true };
    return { success: false, error: msg };
  }
});

// 싱크 엔진 삭제: 엔진+모델 전체(_faster-whisper) 제거.
ipcMain.handle('delete-sync-engine', async () => {
  try {
    const root = getFasterWhisperRootDir();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    _cachedFwExePath = null;
    return { success: true };
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
        // 비어 있지 않은 파일은 설치된 것으로 인정한다. 사용자가 직접 넣었거나 미러에서
        // 받은 모델도 그대로 쓰게 하기 위함이다(이슈 #72). 잘린 다운로드는 이제 .partial이
        // 검증을 통과해야만 최종 이름이 되므로 여기서 엄격할 필요가 없다.
        try {
          if (fs.existsSync(modelFile) && fs.statSync(modelFile).size > 0) availableModels[modelName] = true;
        } catch (_e) {
          /* ignore */
        }
      }
    }
  } catch (error) {
    console.error('Error checking model status:', error);
  }

  // 싱크 엔진: GGML이 아니라 Faster-Whisper-XXL 엔진+모델이 받아졌는지로 판단.
  // 정밀(large-v2-sync)과 라이트(large-v2-sync-lite)는 같은 파일을 공유하므로 함께 available 처리.
  try {
    const fwExe = getFasterWhisperExePath();
    const fwModel = path.join(getFasterWhisperModelsDir(), `faster-whisper-${FASTER_WHISPER_MODEL}`, 'model.bin');
    if (fwExe && fs.existsSync(fwModel) && hasExpectedSize(fwModel, SYNC_FILE_MANIFEST['model.bin'])) {
      availableModels[SYNC_ENGINE_MODEL_ID] = true;
      availableModels[SYNC_ENGINE_LITE_MODEL_ID] = true;
    }
  } catch (_e) {
    /* ignore */
  }

  return availableModels;
});

// 모델 자동 다운로드 (Hugging Face: ggerganov/whisper.cpp GGML 형식)
ipcMain.handle('download-model', async (_event, modelName) => {
  try {
    // GGML 모델 파일 URL 매핑
    const manifest = GGML_MODEL_MANIFEST[modelName];
    const modelUrlMap = Object.fromEntries(
      Object.entries(GGML_MODEL_MANIFEST).map(([name, entry]) => [
        name,
        `https://huggingface.co/ggerganov/whisper.cpp/resolve/${GGML_MODEL_REVISION}/${entry.file}`,
      ])
    );
    const modelUrl = modelUrlMap[modelName];
    if (!modelUrl || !manifest) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const targetDir = getGgmlModelsDir();
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const modelFileName = `ggml-${modelName}.bin`;
    const targetPath = path.join(targetDir, modelFileName);
    const partialPath = targetPath + '.partial';

    downloadsCancelled = false;

    const emitProgress = (percent, received, total) => {
      try {
        mainWindow?.webContents?.send('output-update', `${path.basename(partialPath)} ${percent}%\n`);
        mainWindow?.webContents?.send('whisper-model-progress', {
          modelName,
          percent,
          received,
          total,
        });
      } catch (_e) {}
    };

    // 파일 존재하면 스킵 — 단 0바이트/손상 잔재(이전 실패)가 있으면 재다운로드
    if (fs.existsSync(targetPath)) {
      const existingOk = hasExpectedSize(targetPath, manifest);
      if (existingOk) {
        try {
          mainWindow.webContents.send('output-update', `Model already prepared: ${modelName}\n`);
        } catch (_e) {
          console.log('[Download] Failed to send model ready message:', _e.message);
        }
        return { success: true };
      }
      // 크기가 다르면 받긴 받되, 기존 파일을 먼저 지우지는 않는다. 다운로드가 실패하면
      // 잘 쓰던 모델까지 잃기 때문이다. 검증을 통과한 새 파일이 아래 rename으로 덮어쓴다.
      try {
        mainWindow?.webContents?.send('output-update', `Model file size differs, re-downloading: ${modelName}\n`);
      } catch (_e) {}
    }

    try {
      mainWindow.webContents.send('output-update', `Starting GGML model download: ${modelName}\n`);
    } catch (_e) {
      console.log('[Download] Failed to send download start message:', _e.message);
    }

    if (downloadsCancelled) throw new Error('cancelled');
    await downloadVerifiedFile({
      axios,
      assertDownloadDiskSpace,
      activeDownloads,
      isCancelled: () => downloadsCancelled,
      url: modelUrl,
      partialPath,
      label: `GGML ${modelName}`,
      expectedSize: manifest.size,
      sha256: manifest.sha256,
      onProgress: emitProgress,
    });
    // 완료되어야만 최종 경로로 rename — 부분 파일이 'installed'로 보이지 않도록
    fs.renameSync(partialPath, targetPath);

    try {
      mainWindow.webContents.send('output-update', `GGML Model download completed: ${modelName}\n`);
    } catch (_e) {
      console.log('[Download] Failed to send completion message:', _e.message);
    }
    return { success: true };
  } catch (error) {
    console.error('Model download failed:', error);
    // axios 취소(CanceledError, message 'canceled')와 수동 throw('cancelled')를 모두 취소로
    // 판정 — 철자 불일치로 취소가 네트워크 실패로 오인되어 배치가 계속되는 것 방지 (MED-4).
    const isCancel =
      String(error && error.message).includes('cancelled') ||
      String(error && error.message).includes('canceled') ||
      (error && error.name === 'CanceledError') ||
      String(error && error.name).includes('AbortError');
    if (isCancel) {
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

  // 파일 전환 중/분할 ffmpeg 실행 중 stop이면 currentProcess뿐 아니라 추적된
  // 자식(분할 ffmpeg 등)도 함께 종료한다 (F5).
  killTrackedChildProcesses();

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
ipcMain.handle('save-api-keys', async (_event, keys) => {
  try {
    const result = translator.saveApiKeys(keys);
    // result가 객체면 { success: true, insecure } 형태 (AES 폴백 저장) —
    // 평탄화해 renderer가 insecure 플래그를 볼 수 있게 한다
    if (result && typeof result === 'object') {
      return { success: true, insecure: !!result.insecure };
    }
    return { success: !!result };
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

// 설정 UI에서 프롬프트를 기본값으로 되돌리거나 공급자 기본 모델명을 보여줄 때 사용
ipcMain.handle('get-provider-defaults', async () => {
  return {
    success: true,
    defaults: {
      prompts: {
        translationPrompt: EnhancedSubtitleTranslator.DEFAULT_SYSTEM_PROMPT,
        contextPrompt: EnhancedSubtitleTranslator.DEFAULT_CONTEXT_SYSTEM_PROMPT,
      },
      providers: EnhancedSubtitleTranslator.PROVIDER_DEFAULTS,
      modelPresets: EnhancedSubtitleTranslator.PROVIDER_MODEL_PRESETS,
      formats: EnhancedSubtitleTranslator.PROVIDER_FORMATS,
    },
  };
});

// 설정 UI의 모델 새로고침 — 저장 전이라도 입력된 키·Base URL로 바로 조회한다.
ipcMain.handle('list-provider-models', async (_event, { method, tempKeys } = {}) => {
  try {
    const source = new EnhancedSubtitleTranslator();
    source.apiKeys = { ...source.apiKeys, ...(tempKeys || {}) };
    const models = await source.listModels(source.resolveProvider(method));
    return { success: true, models };
  } catch (error) {
    console.error('[List Provider Models Error]', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
});

// 오프라인 관련 IPC 제거됨

// API 키 유효성 검사 (임시 키 지원)
ipcMain.handle('validate-api-keys', async (_event, tempKeys) => {
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
// targetLang 검증: 알파벳 2~8자 언어 코드(ko, en, ja, zh-CN 등)만 허용.
const TARGET_LANG_RE = /^[a-z]{2,8}$/i;
ipcMain.handle(
  'translate-subtitle',
  async (event, { filePath, method, targetLang, targetLangs, sourceLang, device, localModelId, sessionId }) => {
    // ABORTED catch에서 지금까지 성공한 언어 경로를 응답에 담기 위해
    // 핸들러 스코프로 끌어올린다 (MED).
    const outputPaths = [];
    const failedLangs = [];
    try {
      // 새 요청 시작을 세션 시작으로 표시: 중지 후에도 새 번역이 정상 시작된다.
      // 이후 중지 감지는 언어 루프의 _aborted 검사가 담당한다 (MAJOR).
      translator.resetAbort();
      const fileName = path.basename(filePath, path.extname(filePath));
      const fileDir = path.dirname(filePath);
      // 다국어 지원: targetLangs 배열 우선, 없으면 단일 targetLang (구판 호환). 중복/빈값 제거.
      let langs = (Array.isArray(targetLangs) && targetLangs.length ? targetLangs : [targetLang])
        .map((l) => (typeof l === 'string' && l.trim() ? l.trim() : ''))
        .filter(Boolean);
      langs = [...new Set(langs)];
      if (!langs.length) langs = ['ko'];
      // 검증: 허용된 언어 코드만 번역 대상으로 삼는다.
      const invalidLangs = langs.filter((l) => !TARGET_LANG_RE.test(l));
      if (invalidLangs.length) {
        throw new Error(`Invalid target language code: ${invalidLangs.join(', ')}`);
      }

      // 파일별 캐시 격리 활성화
      translator.setCurrentFile(filePath);
      // local 번역 device 설정 전달
      translator.localDevice = device === 'cpu' ? 'cpu' : 'auto';
      translator.localModelId = localModelId || '1.8b';

      event.sender.send('translation-progress', { stage: 'starting', sessionId });

      for (let li = 0; li < langs.length; li++) {
        const safeTarget = langs[li];
        // 사용자 중지 시 남은 언어를 시작하지 않는다. 플래그는 요청 진입 시
        // 리셋됐으므로 여기서는 언어 간 중지만 감지한다 (HIGH-1b).
        if (translator._aborted) {
          console.log(`[Translate] Aborted by user, skipping remaining languages: ${langs.slice(li).join(', ')}`);
          throw new Error('ABORTED: Translation stopped by user');
        }
        const outputPath = path.join(fileDir, `${fileName}_${safeTarget}.srt`);
        try {
          const result = await translator.translateSRTFile(
            filePath,
            outputPath,
            method,
            safeTarget,
            // 진행률 콜백: 여러 언어 전체 기준으로 환산 ((현재언어순번 + 언어내진행)/전체언어)
            (prog) => {
              try {
                const within = prog && prog.total ? prog.current / prog.total : 0;
                const overall = Math.round(((li + within) / langs.length) * 100);
                event.sender.send('translation-progress', {
                  stage: prog?.stage || 'translating',
                  current: prog?.current,
                  total: prog?.total,
                  progress: overall,
                  currentText: prog?.text,
                  lang: safeTarget,
                  langIndex: li + 1,
                  langTotal: langs.length,
                  sessionId,
                });
              } catch (_) {
                /* noop */
              }
            },
            sourceLang
          );
          outputPaths.push(result);
        } catch (langErr) {
          // 사용자 중지(ABORTED)는 언어 실패와 다르다: 원본 에러를 그대로 상위로
          // 전파해 'Stopped by user' userStopped 마커가 설정되게 한다 (HIGH-3).
          // 중지 후 남은 언어는 번역하지 않는다. 일반 실패만 기록하고 계속 진행한다.
          if (String(langErr?.message || '').includes('ABORTED')) {
            throw langErr;
          }
          // 한 언어의 실패가 다른 언어까지 중단시키지 않는다: 실패 언어만 기록하고
          // 계속 진행한다. 성공한 언어 SRT는 응답에 포함된다 (P1).
          console.error(`[Translate] Language ${safeTarget} failed: ${langErr.message}`);
          failedLangs.push(safeTarget);
        }
      }

      // 파일 처리 완료: 이 파일의 번역 캐시만 정리 (메모리 해제) — 성공/실패 무관
      try {
        translator.clearFileCache();
      } catch (_e) {
        /* noop */
      }

      if (!outputPaths.length) {
        // 모든 언어가 실패한 경우에만 전체 실패로 처리한다.
        const msg = failedLangs.length
          ? `All target languages failed: ${failedLangs.join(', ')}`
          : 'Translation failed';
        throw new Error(msg);
      }

      // 모든 언어 완료 후 단 한 번만 completed 전송(이벤트 중복 방지)
      event.sender.send('translation-progress', {
        stage: 'completed',
        progress: 99,
        outputPath: outputPaths[0],
        outputPaths,
        failedLangs,
        sessionId,
      });

      return { success: true, outputPath: outputPaths[0], outputPaths, failedLangs };
    } catch (error) {
      if (error.message && error.message.includes('ABORTED')) {
        // MED: 도중 중지여도 완료된 이전 언어 SRT 경로는 응답에 포함한다.
        // renderer가 읽는 기존 outputPaths 필드도 함께 유지한다.
        event.sender.send('translation-progress', {
          stage: 'error',
          errorMessage: 'Stopped by user',
          outputPaths,
          sessionId,
        });
        return {
          success: false,
          error: 'Stopped by user',
          userStopped: true,
          partialOutputPaths: outputPaths,
          outputPaths,
        };
      }
      event.sender.send('translation-progress', { stage: 'error', errorMessage: error.message, sessionId });
      return { success: false, error: error.message };
    }
  }
);

// 텍스트 직접 번역 (테스트용)
ipcMain.handle('translate-text', async (_event, { text, method, targetLang }) => {
  try {
    // translate-subtitle과 동일: 새 요청 시작 시 중지 플래그 리셋 (MAJOR).
    translator.resetAbort();
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
  const basePath = app.isPackaged ? process.resourcesPath : __dirname;
  return { ...getGpuInfo(), vulkanAvailable: isVulkanAvailable(basePath) };
});

// nya.wav 파일을 base64로 읽어서 반환 (renderer에서 file:// 보안 문제 회피)
// 임의 경로 탐색 방지: 허용리스트 + basename 검증으로 resources 내 파일만 노출한다.
const ALLOWED_AUDIO_FILES = new Set(['nya.wav']);
ipcMain.handle('get-audio-data', async (_event, filename) => {
  try {
    // basename과 다른 경로(하위/상위 디렉터리 포함)는 즉시 거부
    if (typeof filename !== 'string' || path.basename(filename) !== filename) {
      console.warn('[Security] Blocked get-audio-data path traversal attempt:', filename);
      return null;
    }
    if (!ALLOWED_AUDIO_FILES.has(filename)) {
      console.warn('[Security] Blocked get-audio-data for non-allowlisted file:', filename);
      return null;
    }

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
      const cancelled = /cancell?ed|aborted/i.test(String(e?.message || '')) || e?.name === 'AbortError';
      if (cancelled) return { success: false, error: 'cancelled', userStopped: true };
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
    _localDownloadAbort.abort(new Error('cancelled'));
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

ipcMain.handle('local-translate', async (_event, { text, targetLang, modelId }) => {
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
let _quitRequested = false; // preventDefault 후 재호출된 quit을 정리 완료와 구분
app.on('before-quit', (event) => {
  // 정리 완료 후 재호출된 quit(또는 두 번째 종료 요청이 이미 정리 시퀀스 안이면)은 통과시킨다.
  if (_quitRequested || _isCleaningUp) {
    // 단, 아직 정리 중(_isCleaningUp && !_quitRequested)인데 창 닫기 경로에서
    // quit이 재도착하면 preventDefault 해서 정리 완료까지 앱이 죽지 않게 한다.
    if (_isCleaningUp && !_quitRequested) {
      event.preventDefault();
      console.log('[Cleanup] Quit requested during cleanup, deferring until cleanup finishes');
    }
    return;
  }
  event.preventDefault();
  _isCleaningUp = true;
  console.log('[Cleanup] App closing, cleaning up...');
  // 진행 중인 모델 다운로드 중단 + 부분 파일 정리
  const cleanup = async () => {
    try {
      cancelActiveDownloads();
    } catch (_e) {}
    try {
      if (_localDownloadAbort) {
        _localDownloadAbort.abort();
        _localDownloadAbort = null;
      }
    } catch (_e) {}
    try {
      if (currentProcess && !currentProcess.killed) currentProcess.kill('SIGKILL');
    } catch (_e) {}
    // 번역 중이면 먼저 중단해 unloadModel의 뮤텍스 대기가 빨리 풀리게 한다.
    // (translateLocal은 acquireTranslateLock에서 abort 시그널을 대기 중에도
    // 즉시 반환하므로 선행 abort 없이는 수 분 블록될 수 있다)
    try {
      if (translator && typeof translator.abort === 'function') translator.abort();
    } catch (_e) {}
    // unloadModel은 15초 안에 끝내고, 초과하면 강제로 진행한다 (종료 보장).
    await Promise.race([
      localTranslator.unloadModel().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    // GPU 리셋은 비동기 1회 시도로 충분하다 — 정리가 실패해도 종료는 보장한다.
    await forceMemoryCleanup('cuda', true).catch(() => {});
    _isCleaningUp = false;
    _quitRequested = true;
    app.quit(); // 정리 완료 후 실제 종료 재요청
  };
  cleanup();
});

process.on('SIGINT', () => {
  console.log('[Cleanup] SIGINT received');
  app.quit();
});

process.on('SIGTERM', () => {
  console.log('[Cleanup] SIGTERM received');
  app.quit();
});
