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
function isCudaAvailable() {
  try {
    // Treat presence of NVIDIA SMI as GPU-capable (NVIDIA SMI가 있으면 GPU 가능)
    execSync('nvidia-smi -L', { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
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
    // 인식하지 못하는 값은 보수적으로 cpu
    return 'cpu';
  }
  return req;
}

// Dynamic performance settings based on system specs
function getOptimalWhisperSettings(device) {
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
        const cleanupType = isFileTransition ? '파일 간 메모리 정리' : '일반 메모리 정리';
        console.log(`${cleanupType} 시작...`);

        try {
            // 1. Kill current process
            if (currentProcess && !currentProcess.killed) {
                currentProcess.kill('SIGKILL');
                currentProcess = null;
                console.log('   - 현재 프로세스 강제 종료 완료');
            }

            if (process.platform === 'win32') {
                // 2. Kill all related processes
                try {
                    execSync('taskkill /F /IM faster-whisper-xxl.exe /T', { stdio: 'ignore' });
                    execSync('taskkill /F /IM python.exe /T', { stdio: 'ignore' });
                    console.log('   - 모든 관련 프로세스 정리 완료');
                } catch (e) {
                    console.log('   - 정리할 프로세스 없음');
                }

                // 3. Enhanced GPU cleanup for CUDA
                if (device === 'cuda') {
                    const delay = isFileTransition ? 2000 : 500; // Longer delay for file transitions

                    setTimeout(() => {
                        try {
                            console.log('   - GPU 캐시 강제 비우기...');

                            // Kill all CUDA processes first
                            try {
                                execSync('taskkill /F /IM "nvcc.exe" /T', { stdio: 'ignore' });
                                execSync('taskkill /F /IM "nvidia-smi.exe" /T', { stdio: 'ignore' });
                                console.log('   - CUDA 관련 프로세스 정리 완료');
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
                                    console.log(`   - GPU 리셋 시도 ${i+1}/5 성공`);
                                    break;
                                } catch (e) {
                                    if (i === 4) console.log('   - GPU 리셋 실패, 계속 진행');
                                }
                            }

                            console.log('   - ✅ GPU 메모리 강제 정리 완료');

                        } catch (e) {
                            console.log(`   - GPU 정리 시도 실패: ${e.message}`);
                        }

                        // 4. System memory cleanup
                        try {
                            execSync('powershell -Command "[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers();"', {
                                stdio: 'ignore',
                                timeout: 5000
                            });
                            console.log('   - 시스템 메모리 정리 완료');
                        } catch (e) {
                            console.log('   - 시스템 메모리 정리 건너뛰기');
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
                console.log('   - Node.js 가비지 컬렉션 완료');
            }

        } catch (e) {
            console.error(`❌ 메모리 정리 중 오류: ${e.message}`);
            resolve();
        }
    });
}

// App Initialization
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false,
            devTools: true,
        },
        icon: path.join(__dirname, 'icon.png'),
        autoHideMenuBar: true,
    });
    mainWindow.loadFile('index.html');

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

// Single File Subtitle Extraction (Promise-based)
function extractSingleFile(filePath, model, language, device) {
    return new Promise(async (resolve, reject) => {
        console.log(`[START] Processing: ${path.basename(filePath)}`);
        isUserStopped = false;

        // Force cleanup before each file
        await forceMemoryCleanup(device, true);

        // 실제 사용할 장치 결정
        const chosenDevice = resolveDevice(device);
        if (device === 'auto') {
            const line = `Auto device: using ${chosenDevice.toUpperCase()}`;
            console.log(line);
            mainWindow.webContents.send('output-update', `${line}\n`);
        } else if (device === 'cuda' && chosenDevice !== 'cuda') {
            const line = 'GPU not available, falling back to CPU';
            console.log(line);
            mainWindow.webContents.send('output-update', `${line}\n`);
        }

        const basePath = app.isPackaged ? process.resourcesPath : __dirname;
        const exePath = path.join(basePath, 'faster-whisper-xxl.exe');
        const args = [
            filePath,
            '--model', model,
            '--device', chosenDevice,
            '--output_dir', path.dirname(filePath),
            '--output_format', 'srt',
            ...getOptimalWhisperSettings(chosenDevice),
            '--vad_filter', 'true',
            '--condition_on_previous_text', 'false',
            '--word_timestamps', 'false',
            '--no_speech_threshold', '0.6',
        ];
        if (language && language !== 'auto') {
            args.push('--language', language);
        } else if (language === 'auto') {
            // 언어 자동 감지를 위해 파라미터 생략 (Whisper 기본 동작)
            console.log('[Language Detection] Auto-detect enabled - no language parameter passed');
        } else {
            console.log(`[Language Detection] Fixed language mode: ${language}`);
        }

        console.log(`[EXEC] ${exePath} ${args.join(' ')}`);

        if (chosenDevice === 'cuda') {
            mainWindow.webContents.send('output-update', 'Starting extraction with CUDA device (float16, beam_size=5, batch_size=16)...\n');
            console.log('[GPU Config] High-performance settings: float16, beam_size=5, batch_size=16');
        } else {
            mainWindow.webContents.send('output-update', 'Starting extraction with CPU device (balanced preset)...\n');
        }

        currentProcess = spawn(exePath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: basePath,
            timeout: 1800000 // 30 minutes safety timeout
        });

        // Process timeout handling
        const processTimeout = setTimeout(() => {
            if (currentProcess && !currentProcess.killed) {
                console.log('[TIMEOUT] ' + path.basename(filePath) + ' - exceeded 30 minute limit');
                currentProcess.kill('SIGKILL');
            }
        }, 1800000); // 30 minutes

        currentProcess.stdout.on('data', (data) => {
            mainWindow.webContents.send('output-update', data.toString('utf8'));
        });
        currentProcess.stderr.on('data', (data) => {
            mainWindow.webContents.send('output-update', '[ERROR] ' + data.toString('utf8'));
        });

        currentProcess.on('close', async (code) => {
            clearTimeout(processTimeout); // Clear timeout

            // Enhanced cleanup after each file
            await forceMemoryCleanup(chosenDevice, true);

            if (isUserStopped) {
                return reject(new Error('Stopped by user'));
            }

            // Check if SRT file was actually created (real success indicator)
            const srtPath = filePath.replace(/\.[^/.]+$/, '.srt');
            const srtExists = require('fs').existsSync(srtPath);

            if (code === 0 || srtExists) {
                console.log('[SUCCESS] ' + path.basename(filePath) + ' completed (code: ' + code + ', fileExists: ' + srtExists + ')');
                resolve(srtPath);
            } else {
                let errorMessage = `Error code: ${code}`;
                if (code === 3221226505) {
                    errorMessage = 'GPU 메모리 부족 또는 드라이버 문제';
                } else if (code === null || code === undefined) {
                    errorMessage = '프로세스가 비정상적으로 종료됨 (메모리 부족 가능성)';
                } else if (code === 1) {
                    errorMessage = '❌ Whisper 처리 실패 (파일 포맷 또는 오디오 문제)';
                } else if (code === 127) {
                    errorMessage = '❌ faster-whisper-xxl.exe를 찾을 수 없음';
                }
                console.log(`[ERROR] ${path.basename(filePath)} failed: ${errorMessage}`);
                reject(new Error(errorMessage));
            }
        });

        currentProcess.on('error', async (err) => {
            clearTimeout(processTimeout); // Clear timeout
            await forceMemoryCleanup(chosenDevice, true);

            // ENOENT 에러 = faster-whisper-xxl.exe 파일 없음
            if (err.code === 'ENOENT') {
                const missingFileError = new Error(
                    '❌ faster-whisper-xxl.exe not found!\n\n' +
                    '📥 Please download Faster-Whisper-XXL:\n' +
                    '1. Visit: https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL\n' +
                    '2. Download: Faster-Whisper-XXL_r245.4_windows.7z\n' +
                    '3. Extract to project root (exclude .bat files)\n' +
                    '4. Restart the app\n\n' +
                    '자막 추출 엔진(faster-whisper-xxl.exe)을 찾을 수 없습니다!\n' +
                    '위 링크에서 다운로드 후 프로젝트 루트 폴더에 압축 해제해주세요.'
                );

                // UI에 자세한 안내 전송
                mainWindow.webContents.send('output-update',
                    '\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '❌ FASTER-WHISPER-XXL.EXE NOT FOUND\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '📥 Download Required:\n' +
                    '   https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL\n\n' +
                    '📦 File to download:\n' +
                    '   Faster-Whisper-XXL_r245.4_windows.7z\n\n' +
                    '📂 Installation:\n' +
                    '   1. Extract the .7z file\n' +
                    '   2. Copy all files EXCEPT .bat files\n' +
                    '   3. Paste into project root folder\n' +
                    '   4. Restart this app\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '한국어 안내:\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '자막 추출 엔진(faster-whisper-xxl.exe)이 없습니다.\n' +
                    '위 GitHub 링크에서 파일을 다운로드하여\n' +
                    '프로젝트 폴더에 압축 해제 후 다시 실행해주세요.\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                );

                reject(missingFileError);
            } else {
                reject(err);
            }
        });
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

        const progressText = `[${i + 1}/${filesToProcess.length}] Processing: ${path.basename(currentFile)}`;
        event.sender.send('progress-update', { progress: (i / filesToProcess.length) * 100, text: progressText });

        try {
            const srtPath = await extractSingleFile(currentFile, model, language, device);
            successCount++;
            successDetails.push({ source: currentFile, srtPath });
            event.sender.send('output-update', `✅ [${i + 1}/${filesToProcess.length}] Completed: ${path.basename(currentFile)}\n`);

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
    const extractionSummary = `\n✅ Extraction stage finished (success: ${successCount}, failed: ${failCount})`;
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
    console.error('파일 위치 열기 실패:', error);
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
    console.error('폴더 열기 실패:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-model-status', async () => {
  const modelsPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, '_models');
  const availableModels = {};
  try {
    const modelFolders = fs.readdirSync(modelsPath);
    for (const folder of modelFolders) {
      const folderPath = path.join(modelsPath, folder);
      if (fs.statSync(folderPath).isDirectory()) {
        const requiredFiles = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];
        if (requiredFiles.every(file => fs.existsSync(path.join(folderPath, file)))) {
          availableModels[folder.replace('faster-whisper-', '')] = true;
        }
      }
    }
  } catch (error) {
    console.error('Error checking model status:', error);
  }
  return availableModels;
});

// 모델 자동 다운로드 (Hugging Face: Systran/faster-whisper-*)
ipcMain.handle('download-model', async (event, modelName) => {
  try {
    const repoMap = {
      'tiny': 'faster-whisper-tiny',
      'base': 'faster-whisper-base',
      'small': 'faster-whisper-small',
      'medium': 'faster-whisper-medium',
      'large': 'faster-whisper-large',
      'large-v2': 'faster-whisper-large-v2',
      'large-v3': 'faster-whisper-large-v3',
    };
    const repo = repoMap[modelName];
    if (!repo) {
      throw new Error(`Unknown model: ${modelName}`);
    }

    const targetDir = path.join(app.isPackaged ? process.resourcesPath : __dirname, '_models', `faster-whisper-${modelName}`);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const files = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];
    const baseUrl = `https://huggingface.co/Systran/${repo}/resolve/main`;

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
      } catch (error) {
        console.log('[Download] Failed to send progress update:', error.message);
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

    // 파일 존재하면 스킵
    const missing = files.filter(f => !fs.existsSync(path.join(targetDir, f)));
    if (missing.length === 0) {
      try {
        mainWindow.webContents.send('output-update', `✅ Model already prepared: ${modelName}\n`);
      } catch (error) {
        console.log('[Download] Failed to send model ready message:', error.message);
      }
      return { success: true };
    }

    try {
      mainWindow.webContents.send('output-update', `📥 Starting model download: ${modelName}\n`);
    } catch (error) {
      console.log('[Download] Failed to send download start message:', error.message);
    }
    for (const file of files) {
      const url = `${baseUrl}/${file}`;
      const dest = path.join(targetDir, file);
      // 부분 다운로드 중단되었을 경우 기존 파일 제거 후 다운로드
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch (error) {
        console.log('[Download] Failed to delete partial file:', error.message);
      }
      if (downloadsCancelled) throw new Error('cancelled');
      await downloadFile(url, dest);
    }
    try {
      mainWindow.webContents.send('output-update', `✅ Model download completed: ${modelName}\n`);
    } catch (error) {
      console.log('[Download] Failed to send completion message:', error.message);
    }
    return { success: true };
  } catch (error) {
    console.error('Model download failed:', error);
    if (String(error && error.message).includes('cancelled') || String(error && error.name).includes('AbortError')) {
      try {
        mainWindow.webContents.send('output-update', `Model download cancelled\n`);
      } catch (error) {
        console.log('[Download] Failed to send cancellation message:', error.message);
      }
      return { success: false, error: 'cancelled' };
    }
    try {
      mainWindow.webContents.send('output-update', `❌ Model download failed: ${error.message}\n`);
    } catch (error) {
      console.log('[Download] Failed to send error message:', error.message);
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-current-process', async () => {
  if (currentProcess && !currentProcess.killed) {
    isUserStopped = true;
    currentProcess.kill('SIGKILL');
    console.log('Process stopped by user.');
    try {
      cancelActiveDownloads();
    } catch (error) {
      console.log('[Process] Failed to cancel downloads:', error.message);
    }
    return { success: true };
  }
  // 실행 중인 프로세스가 없어도 다운로드가 있다면 취소
  if (activeDownloads.size > 0) {
    try {
      cancelActiveDownloads();
    } catch (error) {
      console.log('[Process] Failed to cancel active downloads:', error.message);
    }
    return { success: true };
  }
  return { success: false };
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

// App Exit Cleanup
app.on('before-quit', () => forceMemoryCleanup('cuda'));
process.on('exit', () => forceMemoryCleanup('cuda'));
