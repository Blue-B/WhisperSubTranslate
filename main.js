const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const { Menu } = require('electron');

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
  try {
    mainWindow?.webContents?.send('output-update', 'Model download cancelled\n');
  } catch (error) {
    console.log('[Download] Failed to send cancellation message:', error.message);
  }
}

// ===== Device auto-selection helper (장치 자동 선택 헬퍼) =====
// Platform-specific whisper-cli binary name
const WHISPER_CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

// CUDA 12 requires compute capability >= 5.0 (Maxwell+)
const CUDA12_MIN_COMPUTE = 5.0;
let _gpuInfoCache = null;
let _gpuWarningShown = false;

function getGpuInfo() {
  if (_gpuInfoCache !== null) return _gpuInfoCache;
  try {
    const raw = execSync('nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader', {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!raw) { _gpuInfoCache = { available: false }; return _gpuInfoCache; }
    const firstLine = raw.split('\n')[0];
    const parts = firstLine.split(',').map(s => s.trim());
    const gpuName = parts[0] || 'Unknown GPU';
    const computeCap = parseFloat(parts[1]) || 0;
    _gpuInfoCache = {
      available: true,
      name: gpuName,
      computeCap,
      cudaCompatible: computeCap >= CUDA12_MIN_COMPUTE
    };
    console.log(`[GPU Info] ${gpuName}, Compute Capability: ${computeCap}, CUDA 12 compatible: ${computeCap >= CUDA12_MIN_COMPUTE}`);
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
        '--compute_type', 'float16',
        '--beam_size', '5',
        '--batch_size', '16',
        '--threads', '4',
        '--chunk_length', '30'
      ];
    } else if (totalMemory >= 8) {
      // Mid-range system - balanced settings
      console.log('[Performance] Mid-range GPU settings applied');
      return [
        '--compute_type', 'float16',
        '--beam_size', '3',
        '--batch_size', '8',
        '--threads', '2',
        '--chunk_length', '25'
      ];
    } else {
      // Low-end system with GPU - conservative but faster than CPU
      console.log('[Performance] Low-end GPU settings applied');
      return [
        '--compute_type', 'int8',
        '--beam_size', '1',
        '--batch_size', '4',
        '--threads', '1',
        '--chunk_length', '20'
      ];
    }
  } else {
    // CPU settings - optimized for different CPU configurations
    if (totalMemory >= 16 && cpuCores >= 8) {
      // High-end CPU system
      console.log('[Performance] High-end CPU settings applied');
      return [
        '--compute_type', 'int8',
        '--beam_size', '3',
        '--batch_size', '8',
        '--threads', Math.min(cpuCores - 2, 6).toString(),
        '--chunk_length', '25'
      ];
    } else if (totalMemory >= 8 && cpuCores >= 4) {
      // Mid-range CPU system
      console.log('[Performance] Mid-range CPU settings applied');
      return [
        '--compute_type', 'int8',
        '--beam_size', '2',
        '--batch_size', '4',
        '--threads', Math.min(cpuCores - 1, 4).toString(),
        '--chunk_length', '20'
      ];
    } else {
      // Low-end CPU system
      console.log('[Performance] Low-end CPU settings applied');
      return [
        '--compute_type', 'int8',
        '--beam_size', '1',
        '--batch_size', '2',
        '--threads', '1',
        '--chunk_length', '15'
      ];
    }
  }
}

// Enhanced memory/GPU cleanup across files (파일 간 메모리/GPU 정리)
function forceMemoryCleanup(device, isFileTransition = false) {
    return new Promise(resolve => {
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
                                    console.log(`   - GPU reset attempt ${i+1}/5 succeeded`);
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
                                timeout: 5000
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
        const response = await axios.get(
            `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
            { timeout: 10000 }
        );

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
            releaseName
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
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,           // 더 넓게 (900→1280) - 2열 레이아웃에 적합
        height: 800,           // 더 높게 (700→800)
        minWidth: 1000,        // 최소 너비 제한 (UI 깨짐 방지)
        minHeight: 650,        // 최소 높이 제한
        title: 'WhisperSubTranslate',  // 윈도우 타이틀
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false,
            devTools: false,  // 배포 버전: 개발자 도구 비활성화
        },
        icon: path.join(__dirname, 'icon.png'),
        autoHideMenuBar: true,
        show: false,           // 준비 완료 전 깜빡임 방지
    });

    // 창이 준비되면 표시 (깜빡임 방지)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
    mainWindow.loadFile('index.html');

    // DOM이 완전히 로드된 후 업데이트 체크 (main → renderer 직접 실행)
    mainWindow.webContents.on('did-finish-load', async () => {
        console.log('[Update] Page loaded, checking for updates...');
        // renderer.js 초기화 대기
        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
            const result = await checkForUpdates();
            if (result && result.hasUpdate) {
                console.log('[Update] New version found:', result.latestVersion);
                // executeJavaScript로 직접 배너 표시 + 전역 변수에 업데이트 정보 저장
                mainWindow.webContents.executeJavaScript(`
                    (function() {
                        var banner = document.getElementById('updateBanner');
                        var message = document.getElementById('updateMessage');
                        var downloadBtn = document.getElementById('updateDownloadBtn');
                        var laterBtn = document.getElementById('updateLaterBtn');
                        if (!banner) { console.error('Banner not found'); return; }

                        // 전역 변수에 업데이트 정보 저장 (언어 변경 시 사용)
                        window.currentUpdateInfo = {
                            latestVersion: '${result.latestVersion}',
                            releaseUrl: '${result.releaseUrl}'
                        };

                        var lang = typeof currentUiLang !== 'undefined' ? currentUiLang : 'ko';
                        var msgs = {
                            ko: 'v${result.latestVersion} 업데이트가 있습니다',
                            en: 'v${result.latestVersion} update available',
                            ja: 'v${result.latestVersion} アップデートがあります',
                            zh: 'v${result.latestVersion} 更新可用',
                            pl: 'Dostępna aktualizacja v${result.latestVersion}'
                        };
                        var btns = {
                            ko: ['다운로드', '나중에'], en: ['Download', 'Later'],
                            ja: ['ダウンロード', '後で'], zh: ['下载', '稍后'],
                            pl: ['Pobierz', 'Później']
                        };
                        message.textContent = msgs[lang] || msgs.ko;
                        if (downloadBtn) downloadBtn.textContent = (btns[lang] || btns.ko)[0];
                        if (laterBtn) laterBtn.textContent = (btns[lang] || btns.ko)[1];
                        banner.style.display = 'flex';
                        document.body.classList.add('has-update-banner');
                        if (downloadBtn) downloadBtn.onclick = function() {
                            window.electronAPI.openExternal('${result.releaseUrl}');
                        };
                        if (laterBtn) laterBtn.onclick = function() {
                            banner.style.display = 'none';
                            document.body.classList.remove('has-update-banner');
                        };
                        console.log('[Update] Banner displayed, info saved to window.currentUpdateInfo');
                    })();
                `);
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
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath
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
                    console.log(`[Media] Duration: ${duration.toFixed(1)}s (${(duration/60).toFixed(1)} min)`);
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
        if (duration <= SEGMENT_DURATION + 60) { // 31분 이하면 분할 안 함
            return [{ path: wavPath, startTime: 0, isOriginal: true }];
        }
        
        console.log(`[Split] Splitting ${(duration/60).toFixed(1)} min audio into segments...`);
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
                        '-ss', currentStart.toString(),
                        '-i', wavPath,
                        '-t', segmentDuration.toString(),
                        '-ar', '16000',
                        '-ac', '1',
                        '-c:a', 'pcm_s16le',
                        segmentPath
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
                    isOriginal: false
                });
                
                console.log(`[Split] Created segment ${segmentIndex + 1}: ${currentStart}s - ${currentStart + segmentDuration}s`);
                mainWindow.webContents.send('output-update', `Created segment ${segmentIndex + 1}/${Math.ceil(duration / SEGMENT_DURATION)}\n`);
                
                segmentIndex++;
                currentStart += SEGMENT_DURATION; // 다음 세그먼트 시작 (오버랩 포함)
                
            } catch (err) {
                // 분할 실패 시 이미 생성된 세그먼트 정리 후 원본으로 진행
                console.error('[Split] Segment creation failed:', err.message);
                for (const seg of segments) {
                    try { fs.unlinkSync(seg.path); } catch (_e) { /* ignore */ }
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
            const startMs = (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000 + parseInt(match[4]);
            const endMs = (parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7])) * 1000 + parseInt(match[8]);
            
            const newStartMs = startMs + (offsetSeconds * 1000);
            const newEndMs = endMs + (offsetSeconds * 1000);
            
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
        const isDuplicate = uniqueEntries.some(existing => {
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
                const startMs = (parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3])) * 1000 + parseInt(match[4]);
                const text = lines.slice(2).join('\n');
                
                entries.push({
                    startMs,
                    timestamp: timestampLine,
                    text
                });
            }
        }
    }
    
    return entries;
}

// 단일 세그먼트 처리 (분할 처리용)
function processSegment(segmentPath, modelPath, device, language, whisperDir, exePath) {
    return new Promise((resolve, reject) => {
        const safeTempDir = getSafeTempDir();
        const tempBaseName = `segment_out_${Date.now()}`;
        const outputBase = path.join(safeTempDir, tempBaseName);
        const srtPath = outputBase + '.srt';
        
        const args = [
            '-m', modelPath,
            '-f', segmentPath,
            '-osrt',
            '-of', outputBase,
            ...getWhisperCppSettings(device),
        ];
        
        if (language && language !== 'auto') {
            args.push('-l', language);
        } else {
            args.push('-l', 'auto');
        }
        
        console.log(`[Segment] Processing: ${path.basename(segmentPath)}`);
        
        const proc = spawn(exePath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: whisperDir
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
            if (output.includes('error') || output.includes('Error')) {
                mainWindow.webContents.send('output-update', '[ERROR] ' + output);
            } else {
                mainWindow.webContents.send('output-update', output);
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
                    try { fs.unlinkSync(srtPath); } catch (_e) { /* ignore */ }
                    resolve(content);
                } catch (err) {
                    reject(new Error(`Failed to read segment SRT: ${err.message}`));
                }
            } else {
                reject(new Error(`Segment processing failed (code: ${code})`));
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

        const ffmpegArgs = [
            '-y',              // 덮어쓰기
            '-i', inputPath,   // 입력 파일
            '-ar', '16000',    // 16kHz (Whisper 요구사항)
            '-ac', '1',        // 모노
            '-c:a', 'pcm_s16le', // 16-bit PCM
            wavPath
        ];

        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        currentProcess = ffmpegProcess;

        ffmpegProcess.stderr.on('data', (data) => {
            // ffmpeg는 진행 정보를 stderr로 출력
            const output = data.toString();
            if (output.includes('time=')) {
                // 진행 상황만 표시
                const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                if (timeMatch) {
                    mainWindow.webContents.send('output-update', `Audio conversion: ${timeMatch[1]}\r`);
                }
            }
        });

        ffmpegProcess.on('close', (code) => {
            currentProcess = null;
            if (isUserStopped) {
                // 임시 WAV 정리
                if (usingSafeTemp && fs.existsSync(wavPath)) {
                    try { fs.unlinkSync(wavPath); } catch (_e) { /* ignore */ }
                }
                return reject(new Error('Stopped by user'));
            }
            if (code === 0 && fs.existsSync(wavPath)) {
                console.log(`[Audio] WAV conversion successful: ${path.basename(wavPath)}`);
                mainWindow.webContents.send('output-update', `Audio conversion completed.\n`);
                resolve({ wavPath, usingSafeTemp, originalWavPath });
            } else {
                reject(new Error(`Audio conversion failed (code: ${code})`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            if (err.code === 'ENOENT') {
                reject(new Error(
                    '[ERROR] ffmpeg not found!\n' +
                    'Please install ffmpeg and add it to your PATH.\n' +
                    (process.platform === 'win32'
                        ? 'Or place ffmpeg.exe in the project folder.\n\n'
                        : 'Install: sudo apt install ffmpeg (Ubuntu/Debian) or brew install ffmpeg (macOS)\n\n') +
                    'Download: https://ffmpeg.org/download.html'
                ));
            } else {
                reject(err);
            }
        });
    });
}

// ===== GGML Model Path Helper (GGML 모델 경로 헬퍼) =====
function getGgmlModelPath(model) {
    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    const modelsDir = path.join(basePath, '_models');

    // 모델 이름 매핑 (whisper.cpp GGML 형식)
    const modelMap = {
        'tiny': 'ggml-tiny.bin',
        'base': 'ggml-base.bin',
        'small': 'ggml-small.bin',
        'medium': 'ggml-medium.bin',
        'large': 'ggml-large.bin',
        'large-v2': 'ggml-large-v2.bin',
        'large-v3': 'ggml-large-v3.bin',
        'large-v3-turbo': 'ggml-large-v3-turbo.bin'
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
        '-ml', '50',    // max segment length (밀리초 타임스탬프 핵심!)
        '-sow',         // split on word (단어 단위 분할)
        '-bs', '5',     // beam size
        '-bo', '5'      // best of
    ];

    if (device === 'cuda') {
        console.log('[Performance] GPU settings applied');
        return [
            ...baseSettings,
            '-t', Math.min(cpuCores, 4).toString() // 스레드 수
        ];
    } else {
        // CPU 설정
        const threads = Math.max(1, Math.min(cpuCores - 1, 8));
        console.log(`[Performance] CPU settings applied (${threads} threads)`);
        return [
            ...baseSettings,
            '-t', threads.toString(),
            '-ng'  // no GPU
        ];
    }
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
        // CPU 모드일 때 CPU 전용 바이너리 우선 사용 (CUDA DLL 의존성 없음)
        const useCpuBuild = chosenDevice !== 'cuda' && fs.existsSync(cpuExePath);
        const exePath = useCpuBuild ? cpuExePath : path.join(whisperDir, WHISPER_CLI_NAME);
        const exeCwd = useCpuBuild ? cpuDir : whisperDir;
        console.log(`[Whisper] Using: ${useCpuBuild ? 'cpu/' + WHISPER_CLI_NAME + ' (CPU build)' : WHISPER_CLI_NAME + ' (CUDA build)'} (${chosenDevice})`);

        // WAV 변환 (whisper.cpp는 WAV만 지원)
        let wavPath, usingSafeTemp = false;
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
                try { fs.unlinkSync(wavPath); } catch (_e) { /* ignore */ }
            }
            return reject(new Error('Stopped by user'));
        }

        // 모델 경로 (분할 처리에서도 필요하므로 먼저 선언)
        const modelPath = getGgmlModelPath(model);
        if (!fs.existsSync(modelPath)) {
            return reject(new Error(
                `[ERROR] Model not found: ${model}\n` +
                `Expected path: ${modelPath}\n\n` +
                `Please download the GGML model file.`
            ));
        }

        // 영상 길이 확인 및 분할 처리 결정
        let segments = [];
        let useSegmentedProcessing = false;
        try {
            const duration = await getMediaDuration(wavPath);
            if (duration > SEGMENT_DURATION + 60) { // 31분 이상이면 분할
                segments = await splitAudioToSegments(wavPath, duration);
                useSegmentedProcessing = segments.length > 1;
                if (useSegmentedProcessing) {
                    console.log(`[Split] Will process ${segments.length} segments for ${(duration/60).toFixed(1)} min audio`);
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
                                try { fs.unlinkSync(seg.path); } catch (_e) { /* ignore */ }
                            }
                        }
                        return reject(new Error('Stopped by user'));
                    }

                    const segment = segments[i];
                    mainWindow.webContents.send('output-update', `\n=== Processing segment ${i + 1}/${segments.length} ===\n`);
                    
                    // 각 세그먼트에 대해 whisper.cpp 실행
                    const segmentSrt = await processSegment(segment.path, modelPath, chosenDevice, language, exeCwd, exePath);
                    currentProcess = null;
                    srtContents.push(segmentSrt);
                    startTimes.push(segment.startTime);
                    
                    // 세그먼트 임시 파일 정리
                    if (!segment.isOriginal && fs.existsSync(segment.path)) {
                        try {
                            fs.unlinkSync(segment.path);
                        } catch (_e) { /* ignore */ }
                    }
                    
                    // 메모리 정리
                    await forceMemoryCleanup(chosenDevice, true);
                    
                    // GPU 모드면 잠시 대기
                    if (chosenDevice === 'cuda' && i < segments.length - 1) {
                        mainWindow.webContents.send('output-update', `Cleaning memory before next segment...\n`);
                        await new Promise(r => setTimeout(r, 5000));
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
                    } catch (_e) { /* ignore */ }
                }
                
                return resolve(originalSrtPath);
                
            } catch (segErr) {
                // 분할 처리 실패 시 원본 방식으로 재시도
                console.error('[Split] Segmented processing failed:', segErr.message);
                mainWindow.webContents.send('output-update', `Segmented processing failed, trying standard method...\n`);
                // 세그먼트 임시 파일 정리
                for (const seg of segments) {
                    if (!seg.isOriginal && fs.existsSync(seg.path)) {
                        try { fs.unlinkSync(seg.path); } catch (_e) { /* ignore */ }
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
            '-m', modelPath,
            '-f', wavPath,
            '-osrt',                    // SRT 출력
            '-of', outputBase,          // 출력 파일 기본 이름 (확장자 제외)
            ...getWhisperCppSettings(chosenDevice),
        ];

        // 언어 설정 (whisper.cpp는 'auto' 지원!)
        if (language && language !== 'auto') {
            args.push('-l', language);
        } else {
            args.push('-l', 'auto');  // 자동 감지
            console.log('[Language Detection] Auto-detect enabled');
        }

        console.log(`[EXEC] ${exePath} ${args.join(' ')}`);

        // whisper 실행 직전 사용자 중지 체크
        if (isUserStopped) {
            if (usingSafeTemp && wavPath && fs.existsSync(wavPath)) {
                try { fs.unlinkSync(wavPath); } catch (_e) { /* ignore */ }
            }
            return reject(new Error('Stopped by user'));
        }

        if (chosenDevice === 'cuda') {
            mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (CUDA, flash-attn)...\n');
            console.log('[GPU Config] whisper.cpp with CUDA acceleration');
        } else {
            mainWindow.webContents.send('output-update', 'Starting extraction with whisper.cpp (CPU mode)...\n');
        }

        currentProcess = spawn(exePath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: exeCwd
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
            // whisper.cpp는 모델 로딩 정보를 stderr로 출력
            if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
                mainWindow.webContents.send('output-update', '[ERROR] ' + output);
            } else {
                // 모델 정보 등 일반 stderr 출력
                mainWindow.webContents.send('output-update', output);
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
                        mainWindow.webContents.send('output-update',
                            `[Warning] SRT created at temp location: ${srtPath}\n`);
                    }
                }

                console.log('[SUCCESS] ' + path.basename(filePath) + ' completed (code: ' + code + ', fileExists: ' + srtExists + ')');
                resolve(finalSrtPath);
            } else {
                let errorMessage = `Error code: ${code}`;
                if (code === 3221225785) {
                    // 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND
                    const cpuAvailable = fs.existsSync(cpuExePath);
                    if (cpuAvailable) {
                        errorMessage = 'DLL entry point not found (0xC0000139). ' +
                            'CUDA DLLs are incompatible with your GPU driver. ' +
                            'CPU build is available - please change device to CPU in settings.';
                    } else {
                        errorMessage = 'DLL entry point not found (0xC0000139). ' +
                            'CUDA DLLs are incompatible with your GPU driver. ' +
                            'Please download the CPU-only build and place it in the whisper-cpp/cpu/ folder.\n' +
                            `Solution: Download whisper-bin-x64.zip from GitHub, extract ${WHISPER_CLI_NAME} to whisper-cpp/cpu/ folder.`;
                    }
                } else if (code === 3221225781) {
                    // 0xC0000135 STATUS_DLL_NOT_FOUND (Windows-specific)
                    errorMessage = 'Required DLL not found (0xC0000135). ' +
                        'Please install Visual C++ Redistributable 2015-2022 or use CPU-only whisper-cli build.\n' +
                        'Download: https://aka.ms/vs/17/release/vc_redist.x64.exe';
                } else if (code === 3221226505) {
                    errorMessage = 'GPU memory shortage or driver issue';
                } else if (code === null || code === undefined) {
                    errorMessage = 'Process terminated abnormally (possible memory shortage)';
                } else if (code === 1) {
                    errorMessage = 'Whisper processing failed (file format or audio issue)';
                } else if (code === 127) {
                    errorMessage = `${WHISPER_CLI_NAME} not found`;
                }
                console.log(`[ERROR] ${path.basename(filePath)} failed: ${errorMessage}`);
                reject(new Error(errorMessage));
            }
        });

        currentProcess.on('error', async (err) => {
            clearTimeout(processTimeout); // Clear timeout
            await forceMemoryCleanup(chosenDevice, true);

            // ENOENT/EACCES 에러 = whisper-cli 파일 없음 또는 실행 권한 없음
            if (err.code === 'ENOENT' || err.code === 'EACCES') {
                const errDetail = err.code === 'EACCES'
                    ? `[ERROR] ${WHISPER_CLI_NAME} permission denied! (EACCES)\n` +
                      (process.platform !== 'win32' ? `Try: chmod +x "${exePath}"\n\n` : '\n')
                    : `[ERROR] ${WHISPER_CLI_NAME} not found!\n\n`;

                const missingFileError = new Error(
                    errDetail +
                    'Please download whisper.cpp:\n' +
                    '1. Visit: https://github.com/ggml-org/whisper.cpp/releases\n' +
                    '2. Download the appropriate build for your platform\n' +
                    '3. Extract to project folder under "whisper-cpp" directory\n' +
                    '4. Restart the app'
                );

                mainWindow.webContents.send('output-update',
                    '\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    `[ERROR] ${WHISPER_CLI_NAME.toUpperCase()} NOT FOUND\n` +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Download Required:\n' +
                    '   https://github.com/ggml-org/whisper.cpp/releases\n\n' +
                    'Files to download:\n' +
                    (process.platform === 'win32'
                        ? '   - whisper-cublas-*.zip (CUDA/GPU)\n' +
                          '   - OR whisper-bin-*.zip (CPU only)\n\n'
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
ipcMain.handle('extract-subtitles', async (event, { filePaths, filePath, model, language, device }) => {
    // This now correctly handles both a single `filePath` and an array `filePaths`
    const filesToProcess = filePaths || (filePath ? [filePath] : []);

    if (filesToProcess.length === 0) {
        console.log("No valid files to process.");
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
            successCount++;
            successDetails.push({ source: currentFile, srtPath });
            event.sender.send('output-update', `[${i + 1}/${filesToProcess.length}] Completed: ${path.basename(currentFile)}\n`);

            // Next file preview message
            if (i < filesToProcess.length - 1) {
                const nextFile = filesToProcess[i + 1];
                event.sender.send('output-update', `Next file: ${path.basename(nextFile)}\n`);

                if (device === 'cuda') {
                    event.sender.send('output-update', `Cleaning GPU memory and preparing next file... (wait 10s)\n`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
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
            event.sender.send('output-update', `[${i + 1}/${filesToProcess.length}] Failed: ${path.basename(currentFile)} - ${message}\n`);

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
                    await new Promise(resolve => setTimeout(resolve, 10000));
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
ipcMain.handle('open-file-location', async (event, filePath) => {
  const { shell } = require('electron');
  try {
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open file location:', error);
    return { success: false, error: error.message };
  }
});

// 폴더 열기
ipcMain.handle('open-folder', async (event, folderPath) => {
  const { shell } = require('electron');
  try {
    shell.openPath(folderPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open folder:', error);
    return { success: false, error: error.message };
  }
});

// 외부 URL을 기본 브라우저에서 열기
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Failed to open external link:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-model-status', async () => {
  const modelsPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, '_models');
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
      'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
      'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
      'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
      'large': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin',
      'large-v2': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin',
      'large-v3': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
      'large-v3-turbo': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    };
    const modelUrl = modelUrlMap[modelName];
    if (!modelUrl) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const targetDir = path.join(app.isPackaged ? process.resourcesPath : __dirname, '_models');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const modelFileName = `ggml-${modelName}.bin`;
    const targetPath = path.join(targetDir, modelFileName);

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

    // 부분 다운로드 중단되었을 경우 기존 파일 제거 후 다운로드
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch (_e) {
      console.log('[Download] Failed to delete partial file:', _e.message);
    }

    if (downloadsCancelled) throw new Error('cancelled');
    await downloadFile(modelUrl, targetPath);

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
    } catch (_e) { /* ignore */ }
  }
  
  try {
    cancelActiveDownloads();
  } catch (_e) { /* ignore */ }
  
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
      tempKeys: tempKeys ? Object.keys(tempKeys) : []
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
ipcMain.handle('translate-subtitle', async (event, { filePath, method, targetLang, sourceLang }) => {
  try {
    const fileName = path.basename(filePath, path.extname(filePath));
    const fileDir = path.dirname(filePath);
    const safeTarget = (targetLang && typeof targetLang === 'string' && targetLang.trim()) ? targetLang.trim() : 'ko';
    const outputPath = path.join(fileDir, `${fileName}_${safeTarget}.srt`);

    // 파일별 캐시 격리 활성화
    translator.setCurrentFile(filePath);

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
            currentText: prog?.text
          });
        } catch (_) { /* noop */ }
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
});

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

// App Exit Cleanup
let _isCleaningUp = false;
app.on('before-quit', async () => {
  if (_isCleaningUp) return;
  _isCleaningUp = true;
  console.log('[Cleanup] App closing, cleaning up...');
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
