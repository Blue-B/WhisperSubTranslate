const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execFile, execSync, execFileSync } = require('child_process');
const os = require('os');
const axios = require('axios');
const EnhancedSubtitleTranslator = require('./translator');
const { applySrtCleanup, wrapCuesForDisplay, srtFromWhisperJson } = require('./srt-cleanup');
const { assertDownloadDiskSpace, assertSyncInstallDiskSpace, getReusablePartialSize } = require('./disk-space');
const { downloadVerifiedFile, sha256File } = require('./verified-downloader');
const { isCompleteWavFile } = require('./file-safety');
const errLogger = require('./error-logger');

const SOURCE_ROOT = path.resolve(__dirname, '../../..');

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

// Runtime state owned by the transcription service
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
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- fixed bundled CLI path
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
function getSafeTempDir() {
  // 1순위: 앱 실행 경로 내 temp (대부분 영어 경로)
  const basePath = app.isPackaged ? path.dirname(process.execPath) : SOURCE_ROOT;
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
    const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
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

  const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
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
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- caller supplies bundled CLI path
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
    const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
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
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', rel) : path.join(SOURCE_ROOT, rel);
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
  const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
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

      const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;

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

  const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
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

function setMainWindow(window) {
  mainWindow = window;
  translator.setMainWindow(window);
}

function configureExtraction(payload = {}) {
  reduceRepetition = payload.reduceRepetition !== false;
  naturalSegmentation = payload.naturalSegmentation !== false;
}

function resetStop() {
  isUserStopped = false;
}

function isStopped() {
  return isUserStopped;
}

function terminateCurrentProcess() {
  if (currentProcess && !currentProcess.killed) currentProcess.kill('SIGKILL');
}

function stop() {
  isUserStopped = true;
  terminateCurrentProcess();
  killTrackedChildProcesses();
  translator.abort?.();
  cancelActiveDownloads();
}

async function checkModelStatus() {
  const modelsPath = getGgmlModelsDir();
  const available = {};
  const modelNames = ['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3', 'large-v3-turbo'];
  try {
    if (fs.existsSync(modelsPath)) {
      for (const modelName of modelNames) {
        const modelFile = path.join(modelsPath, `ggml-${modelName}.bin`);
        try {
          if (fs.existsSync(modelFile) && fs.statSync(modelFile).size > 0) available[modelName] = true;
        } catch (_e) {}
      }
    }
  } catch (error) {
    console.error('Error checking model status:', error);
  }
  try {
    const fwExe = getFasterWhisperExePath();
    const fwModel = path.join(getFasterWhisperModelsDir(), `faster-whisper-${FASTER_WHISPER_MODEL}`, 'model.bin');
    if (fwExe && fs.existsSync(fwModel) && hasExpectedSize(fwModel, SYNC_FILE_MANIFEST['model.bin'])) {
      available[SYNC_ENGINE_MODEL_ID] = true;
      available[SYNC_ENGINE_LITE_MODEL_ID] = true;
    }
  } catch (_e) {}
  return available;
}

async function downloadModel(modelName) {
  try {
    const manifest = GGML_MODEL_MANIFEST[modelName];
    if (!manifest) throw new Error(`Unknown model: ${modelName}`);
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${GGML_MODEL_REVISION}/${manifest.file}`;
    const targetDir = getGgmlModelsDir();
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `ggml-${modelName}.bin`);
    const partialPath = targetPath + '.partial';
    downloadsCancelled = false;
    const emitProgress = (percent, received, total) => {
      mainWindow?.webContents?.send('output-update', `${path.basename(partialPath)} ${percent}%\n`);
      mainWindow?.webContents?.send('whisper-model-progress', { modelName, percent, received, total });
    };
    if (fs.existsSync(targetPath) && hasExpectedSize(targetPath, manifest)) {
      mainWindow?.webContents?.send('output-update', `Model already prepared: ${modelName}\n`);
      return { success: true };
    }
    mainWindow?.webContents?.send('output-update', `Starting GGML model download: ${modelName}\n`);
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
    fs.renameSync(partialPath, targetPath);
    mainWindow?.webContents?.send('output-update', `GGML Model download completed: ${modelName}\n`);
    return { success: true };
  } catch (error) {
    const cancelled =
      /cancell?ed/i.test(String(error?.message || '')) ||
      error?.name === 'CanceledError' ||
      String(error?.name || '').includes('AbortError');
    if (cancelled) return { success: false, error: 'cancelled' };
    mainWindow?.webContents?.send('output-update', `[ERROR] Model download failed: ${error.message}\n`);
    return { success: false, error: error.message };
  }
}

async function downloadSyncEngine() {
  const emit = (percent) =>
    mainWindow?.webContents?.send('whisper-model-progress', {
      modelName: SYNC_ENGINE_MODEL_ID,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
    });
  try {
    await ensureFasterWhisperAssets(emit);
    return { success: true };
  } catch (error) {
    const cancelled =
      /cancell?ed/i.test(String(error?.message || '')) ||
      error?.name === 'CanceledError' ||
      String(error?.name || '').includes('AbortError');
    return cancelled
      ? { success: false, error: 'cancelled', userStopped: true }
      : { success: false, error: String(error?.message || error) };
  }
}

function deleteSyncEngine() {
  try {
    const root = getFasterWhisperRootDir();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    _cachedFwExePath = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
}

function deleteWhisperModel(modelName) {
  try {
    const modelFile = path.join(getGgmlModelsDir(), `ggml-${modelName}.bin`);
    if (!fs.existsSync(modelFile)) return { success: false, error: 'File not found' };
    fs.unlinkSync(modelFile);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
}

function getGpuStatus() {
  const basePath = app.isPackaged ? process.resourcesPath : SOURCE_ROOT;
  return { ...getGpuInfo(), vulkanAvailable: isVulkanAvailable(basePath) };
}

module.exports = {
  cancelDownloads: cancelActiveDownloads,
  checkModelStatus,
  configureExtraction,
  deleteSyncEngine,
  deleteWhisperModel,
  downloadModel,
  downloadSyncEngine,
  extractSingleFile,
  forceMemoryCleanup,
  getGgmlModelsDir,
  getGpuStatus,
  isStopped,
  resetStop,
  setMainWindow,
  srtOutputPathFor,
  stop,
  terminateCurrentProcess,
  translator,
  withoutExt,
};
