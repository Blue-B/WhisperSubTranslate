/**
 * postinstall.js - Auto-download whisper-cpp after npm install
 *
 * Downloads CUDA version (falls back to CPU if GPU not available)
 * Priority: CUDA 12 > CUDA 11 > CPU-only
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync, execSync, spawnSync } = require('child_process');

// Constants
const WHISPER_CPP_DIR = path.join(__dirname, '..', 'whisper-cpp');
const CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const WHISPER_CLI = path.join(WHISPER_CPP_DIR, CLI_NAME);
const CPU_DIR = path.join(WHISPER_CPP_DIR, 'cpu');
const CPU_CLI = path.join(CPU_DIR, CLI_NAME);
// whisper.cpp는 버전을 고정해 받는다. releases/latest를 따라가면 업스트림이
// 새 빌드를 낼 때마다 검증하지 않은 엔진이 그대로 실려 나가고(v2.4.4가
// 1.9.1 -> 1.9.2로 조용히 갈아끼운 사례), 같은 소스를 빌드해도 결과가
// 달라져 문제 추적이 불가능해진다. 올릴 때는 이 태그를 바꾸고 릴리스
// 워크플로우의 실제 자막 추출 검증을 통과시킨 뒤에 올린다.
const WHISPER_CPP_VERSION = 'v1.9.1';
const GITHUB_API = `https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${WHISPER_CPP_VERSION}`;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit for API response
const MAX_REDIRECTS = 5;
const VULKAN_ARCHIVE_URL =
  'https://github.com/Blue-B/WhisperSubTranslate/releases/download/whisper-vulkan-v1.9.1/whisper-vulkan-v1.9.1-win-x64.zip';
const VULKAN_ARCHIVE_SHA256 = '9524205a8f74c69a327c2a4316d1cae2857c507b344a563bf55f0e45c7093f20';
const VULKAN_ARCHIVE_NAME = 'whisper-vulkan-v1.9.1-win-x64.zip';

// Silero VAD model (ggml) — lets whisper process only speech segments, which
// removes the repeated/hallucinated lines whisper emits on silent/music parts
// (the #1 quality complaint). ~0.9 MB. Optional: extraction still works without it.
const VAD_MODEL_NAME = 'ggml-silero-v5.1.2.bin';
const VAD_MODEL_PATH = path.join(WHISPER_CPP_DIR, VAD_MODEL_NAME);
// HF main 브랜치 대신 고정 revision을 받는다(main.js GGML_MODEL_REVISION과 같은 이유).
// 크기와 SHA-256도 함께 고정해 네트워크 절단·변조를 걸러낸다(verifyPinnedDownload).
const VAD_MODEL_REVISION = '9ffd54a1e1ee413ddf265af9913beaf518d1639b';
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/${VAD_MODEL_REVISION}/${VAD_MODEL_NAME}`;
const VAD_MODEL_SIZE = 885098;
const VAD_MODEL_SHA256 = '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf';

// whisper.cpp v1.9.1 Windows 아카이브는 자산 이름별로 크기와 SHA-256을 로컬 고정한다.
// GitHub API 응답의 asset.digest는 응답 자체가 변조되면 함께 믿게 되므로,
// API digest ↔ 로컬 고정값 ↔ 받은 바이트를 3중으로 대조한다(verifyWhisperAsset).
// 값 출처: https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/v1.9.1
const WHISPER_ASSET_MANIFEST = Object.freeze({
  'whisper-cublas-12.4.0-bin-x64.zip': Object.freeze({
    size: 677887125,
    sha256: '106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b',
  }),
  'whisper-cublas-11.8.0-bin-x64.zip': Object.freeze({
    size: 278557654,
    sha256: 'aecdce0e4d4bb758a7c72a31f3f9f19a7b6d861405fd2da743cd86398633c963',
  }),
  'whisper-bin-x64.zip': Object.freeze({
    size: 7982101,
    sha256: '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
  }),
});

// 스트리밍 해시. cublas 12.4 아카이브(~677MB)도 통째로 readFileSync하지 않는다.
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Compare a downloaded file against a locally pinned {size, sha256} entry and
 * delete the file on any mismatch so rejected bytes are never left behind to
 * look like an installed payload.
 */
async function verifyPinnedDownload(label, filePath, expected) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}: downloaded file is missing`);
  }
  const size = fs.statSync(filePath).size;
  if (size !== expected.size) {
    try {
      fs.unlinkSync(filePath);
    } catch (_e) {
      /* ignore */
    }
    throw new Error(`${label}: size mismatch (expected ${expected.size}, got ${size})`);
  }
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expected.sha256) {
    try {
      fs.unlinkSync(filePath);
    } catch (_e) {
      /* ignore */
    }
    throw new Error(`${label}: SHA-256 mismatch (expected ${expected.sha256}, got ${actualSha256})`);
  }
}

/**
 * Windows whisper.cpp archives are pinned by asset name in WHISPER_ASSET_MANIFEST.
 * The API-reported asset.digest must agree with the local pin before the bytes
 * are even looked at; then the bytes themselves must match size + SHA-256.
 */
async function verifyWhisperAsset(asset, filePath) {
  // 조기 실패(manifest 누락·API digest 불일치)에도 이미 받은 아카이브를 지운다.
  const discard = () => {
    try {
      fs.unlinkSync(filePath);
    } catch (_e) {
      /* ignore */
    }
  };
  const expected = WHISPER_ASSET_MANIFEST[asset.name];
  if (!expected) {
    discard();
    throw new Error(`${asset.name}: no locally pinned whisper.cpp manifest entry for this asset`);
  }
  if ((asset.digest || '') !== `sha256:${expected.sha256}`) {
    discard();
    throw new Error(`${asset.name}: GitHub API digest (${asset.digest || 'none'}) does not match the pinned SHA-256`);
  }
  await verifyPinnedDownload(asset.name, filePath, expected);
}

function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    }
  }
  return null;
}

function hasVulkanRuntimeLibraries() {
  const dir = path.join(WHISPER_CPP_DIR, 'vulkan');
  return hasWhisperRuntimeLibraries(path.join(dir, CLI_NAME), dir) && fs.existsSync(path.join(dir, 'ggml-vulkan.dll'));
}

function hasWhisperRuntimeLibraries(cliPath = WHISPER_CLI, runtimeDir = WHISPER_CPP_DIR) {
  if (!fs.existsSync(cliPath)) return false;

  const env = { ...process.env };
  if (process.platform !== 'win32') {
    const libraryPath = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[libraryPath] = [runtimeDir, env[libraryPath]].filter(Boolean).join(path.delimiter);
  }

  const result = spawnSync(cliPath, ['--help'], {
    cwd: runtimeDir,
    env,
    stdio: 'ignore',
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0;
}

/**
 * Fetch latest release info from GitHub API
 * @returns {Promise<Object>} Release data
 */
async function fetchPinnedWhisperRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'WhisperSubTranslate-Installer' },
    };
    // CI(릴리스 워크플로)에서 GITHUB_TOKEN이 주어지면 API rate limit을 높인다.
    if (process.env.GITHUB_TOKEN) {
      options.headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    https
      .get(GITHUB_API, options, (res) => {
        // Validate response status
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        let data = '';
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_SIZE) {
            res.destroy();
            reject(new Error('Response too large'));
            return;
          }
          data += chunk;
        });

        res.on('end', () => {
          if (data.length === 0) {
            reject(new Error('Empty response from GitHub API'));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (!parsed.assets || !Array.isArray(parsed.assets)) {
              reject(new Error('Invalid release data: missing assets'));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error('Invalid JSON response: ' + e.message));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Download file with redirect handling and progress display
 * @param {string} url - Download URL
 * @param {string} destPath - Destination file path
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    let file = null;
    let redirectCount = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (!file) {
        reject(error);
        return;
      }
      const removePartial = () => fs.rm(destPath, { force: true }, () => reject(error));
      if (file.closed) {
        removePartial();
      } else {
        file.once('close', removePartial);
        file.destroy();
      }
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const request = (currentUrl) => {
      // Validate URL
      if (!currentUrl.startsWith('https://')) {
        fail(new Error('Invalid URL: must use HTTPS'));
        return;
      }

      if (redirectCount >= MAX_REDIRECTS) {
        fail(new Error('Too many redirects'));
        return;
      }

      let redirected = false;
      const req = https.get(currentUrl, { headers: { 'User-Agent': 'WhisperSubTranslate-Installer' } }, (res) => {
        // Handle redirect
        if (res.statusCode === 302 || res.statusCode === 301) {
          redirected = true;
          redirectCount++;
          const location = res.headers.location;
          // Redirect 응답 body를 소비하지 않으면 Windows Node의 socket이 열린 채
          // 남아 postinstall/npm ci가 끝난 뒤에도 프로세스가 종료되지 않는다.
          res.on('error', () => {});
          res.resume();
          if (!location) {
            fail(new Error('Redirect without location header'));
            return;
          }
          request(location);
          return;
        }

        // Validate response before opening/truncating the destination file.
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        file = fs.createWriteStream(destPath);
        const totalSize = parseInt(res.headers['content-length'], 10) || 0;
        let downloadedSize = 0;
        let lastPercent = 0;

        res.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) {
            const percent = Math.floor((downloadedSize / totalSize) * 100);
            if (percent >= lastPercent + 10) {
              process.stdout.write(`\r  Downloading: ${percent}%`);
              lastPercent = percent;
            }
          }
        });
        res.on('error', fail);
        file.on('error', fail);
        file.on('close', () => {
          if (settled) return;
          if (!file.writableFinished) {
            fail(new Error('Download stream closed before completion'));
            return;
          }
          // content-length가 알려진 경우 받은 크기와 다르면 손상 파일로
          // 취급해 삭제 + 실패시킨다 (MED-7).
          if (totalSize > 0 && downloadedSize !== totalSize) {
            fail(new Error(`Download incomplete (${downloadedSize}/${totalSize} bytes)`));
            return;
          }
          if (totalSize > 0) {
            console.log('\r  Downloading: 100%');
          } else {
            console.log('\r  Download complete');
          }
          succeed();
        });
        res.pipe(file);
      });
      req.on('error', (error) => {
        if (!redirected) fail(error);
      });
    };

    request(url);
  });
}

/**
 * Extract archive file (ZIP or tar.gz) using platform-specific tools
 * @param {string} archivePath - Path to archive file
 * @param {string} destDir - Destination directory
 */
async function ensureVulkanBundle() {
  if (process.platform !== 'win32') return true;
  if (!process.env.WHISPER_VULKAN_ARCHIVE && hasVulkanRuntimeLibraries()) {
    clearInstallFailure('vulkan');
    return true;
  }

  const root = path.join(__dirname, '..');
  const archivePath = path.join(root, `whisper-vulkan-temp-${process.pid}.zip`);
  const extractDir = path.join(root, `whisper-vulkan-extract-${process.pid}`);
  const stagingDir = path.join(root, `whisper-vulkan-staging-${process.pid}`);
  const vulkanDir = path.join(WHISPER_CPP_DIR, 'vulkan');
  const backupDir = `${vulkanDir}.previous`;
  let hadBackup = false;
  let installedNewBundle = false;
  try {
    const override = process.env.WHISPER_VULKAN_ARCHIVE;
    if (override) {
      const filePath = override.startsWith('file://') ? decodeURIComponent(new URL(override).pathname) : override;
      const localPath = filePath.startsWith('/') && /^[A-Za-z]:/.test(filePath.slice(1)) ? filePath.slice(1) : filePath;
      if (!path.isAbsolute(localPath) || !fs.existsSync(localPath)) {
        throw new Error(`Vulkan archive override does not exist: ${localPath}`);
      }
      fs.copyFileSync(localPath, archivePath);
      console.log(`  [vulkan] Using local archive override: ${localPath}`);
    } else {
      console.log(`  [vulkan] Downloading ${VULKAN_ARCHIVE_NAME}...`);
      await downloadFile(VULKAN_ARCHIVE_URL, archivePath);
    }
    // 23MB 아카이브도 스트리밍 해시(await sha256File)로 검증한다.
    if ((await sha256File(archivePath)) !== VULKAN_ARCHIVE_SHA256) {
      throw new Error('Vulkan archive SHA-256 verification failed');
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    await extractZip(archivePath, extractDir);

    const cli = findFileRecursive(extractDir, CLI_NAME);
    const vulkanDll = findFileRecursive(extractDir, 'ggml-vulkan.dll');
    if (!cli || !vulkanDll) throw new Error('Vulkan archive is missing whisper-cli.exe or ggml-vulkan.dll');
    const sourceDir = path.dirname(cli);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(stagingDir, entry.name));
    }
    if (!fs.existsSync(path.join(stagingDir, CLI_NAME)) || !fs.existsSync(path.join(stagingDir, 'ggml-vulkan.dll'))) {
      throw new Error('Vulkan staging directory is incomplete');
    }

    fs.rmSync(backupDir, { recursive: true, force: true });
    if (fs.existsSync(vulkanDir)) {
      fs.renameSync(vulkanDir, backupDir);
      hadBackup = true;
    }
    fs.renameSync(stagingDir, vulkanDir);
    installedNewBundle = true;
    if (!hasVulkanRuntimeLibraries()) throw new Error('Vulkan runtime probe failed after installation');
    fs.rmSync(backupDir, { recursive: true, force: true });
    hadBackup = false;
    clearInstallFailure('vulkan');
    console.log('  [vulkan] Vulkan whisper.cpp bundle installed.');
    return true;
  } catch (error) {
    if (installedNewBundle) fs.rmSync(vulkanDir, { recursive: true, force: true });
    if (hadBackup && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, vulkanDir);
      } catch (restoreError) {
        console.warn(`  [WARN] Failed to restore previous Vulkan bundle: ${restoreError.message}`);
      }
    }
    markInstallFailure('vulkan', error.message);
    console.log(`  [WARN] Vulkan bundle unavailable: ${error.message}`);
    return false;
  } finally {
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function extractZip(archivePath, destDir) {
  try {
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      console.log('  Extracting tar.gz...');
      execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    } else if (process.platform === 'win32') {
      console.log('  Extracting...');
      const psCommand = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execFileSync('powershell', ['-NoProfile', '-Command', psCommand], {
        stdio: 'inherit',
        windowsHide: true,
      });
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    }
  } catch (error) {
    throw new Error(`Failed to extract ${path.basename(archivePath)}: ${error.message}`, { cause: error });
  }
}

/**
 * Move files from subdirectory to parent directory
 * @param {string} sourceDir - Source directory
 * @param {string} destDir - Destination directory
 */
function moveFilesUp(sourceDir, destDir) {
  const files = fs.readdirSync(sourceDir);
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(destDir, file);
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    }
  }
  // Remove empty directory
  try {
    fs.rmdirSync(sourceDir);
  } catch (_e) {
    // Directory not empty or other error, ignore
  }
}

/**
 * Check if CUDA toolkit (nvcc) is available
 */
function hasCudaToolkit() {
  try {
    execSync('nvcc --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a command exists on the system
 */
function hasCommand(cmd) {
  return (
    spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
      timeout: 3000,
    }).status === 0
  );
}

/**
 * Build whisper.cpp from source (Linux/macOS)
 * @param {boolean} withCuda - Whether to enable CUDA support
 * @returns {Promise<boolean>} true if build succeeded
 */
async function buildWhisperFromSource(withCuda) {
  if (!hasCommand('cmake')) {
    console.log('  [WARN] cmake not found. Cannot auto-build whisper.cpp.');
    console.log('  Install cmake: sudo apt install cmake build-essential (Ubuntu/Debian)');
    return false;
  }
  if (!hasCommand('git')) {
    console.log('  [WARN] git not found. Cannot auto-build whisper.cpp.');
    return false;
  }

  const buildTempDir = path.join(__dirname, '..', 'whisper-build-temp');

  try {
    // Clean up any leftover build directory from previous failed attempts
    if (fs.existsSync(buildTempDir)) {
      fs.rmSync(buildTempDir, { recursive: true, force: true });
    }

    console.log('\n  [Build] Cloning whisper.cpp from GitHub...');
    // 기본 브랜치 HEAD를 빌드하면 검증 없이 엔진이 조용히 바뀐다. 고정 태그는
    // 파일 상단 WHISPER_CPP_VERSION 하나로 관리한다.
    execSync(
      `git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp "${buildTempDir}"`,
      {
        stdio: 'inherit',
        timeout: 120000,
      }
    );

    let cmakeArgs = withCuda ? '-DGGML_CUDA=ON' : '';

    // Set RPATH so the binary can find CUDA shared libraries at runtime
    // without relying on LD_LIBRARY_PATH (fixes Electron launch issues)
    if (withCuda) {
      const rpathCandidates = ['/usr/local/cuda/lib64', '/usr/lib/wsl/lib'];
      try {
        const localDirs = fs.readdirSync('/usr/local');
        for (const dir of localDirs) {
          if (dir.startsWith('cuda-')) {
            rpathCandidates.push(`/usr/local/${dir}/lib64`);
          }
        }
      } catch (_e) {
        /* ignore */
      }
      const existingRpaths = rpathCandidates.filter((p) => fs.existsSync(p));
      if (existingRpaths.length > 0) {
        const rpathStr = existingRpaths.join(':');
        cmakeArgs += ` -DCMAKE_BUILD_RPATH="${rpathStr}" -DCMAKE_INSTALL_RPATH="${rpathStr}" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON`;
        console.log(`  [Build] RPATH set to: ${rpathStr}`);
      }
    }

    console.log(`  [Build] Running cmake (${withCuda ? 'CUDA' : 'CPU'} mode)...`);
    execSync(`cmake -B build ${cmakeArgs}`, {
      cwd: buildTempDir,
      stdio: 'inherit',
      timeout: 60000,
    });

    console.log('  [Build] Compiling... (this may take a few minutes)');
    const cores = require('os').cpus().length;
    execSync(`cmake --build build --config Release -j${Math.max(1, cores - 1)}`, {
      cwd: buildTempDir,
      stdio: 'inherit',
      timeout: 600000,
    });

    // Find the built binary
    const possiblePaths = [
      path.join(buildTempDir, 'build', 'bin', 'whisper-cli'),
      path.join(buildTempDir, 'build', 'bin', 'Release', 'whisper-cli'),
      path.join(buildTempDir, 'build', 'whisper-cli'),
    ];

    let builtBinary = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        builtBinary = p;
        break;
      }
    }

    if (!builtBinary) {
      console.log('  [WARN] Build completed but whisper-cli binary not found in expected locations.');
      return false;
    }

    // Copy to whisper-cpp directory
    if (!fs.existsSync(WHISPER_CPP_DIR)) {
      fs.mkdirSync(WHISPER_CPP_DIR, { recursive: true });
    }
    fs.copyFileSync(builtBinary, WHISPER_CLI);
    fs.chmodSync(WHISPER_CLI, 0o755);

    // Copy shared libraries (.so) needed at runtime (Linux/macOS)
    if (process.platform !== 'win32') {
      const buildDir = path.join(buildTempDir, 'build');
      const soDirs = [
        path.join(buildDir, 'bin'),
        path.join(buildDir, 'src'), // libwhisper.so
        path.join(buildDir, 'ggml', 'src'), // libggml*.so
        path.join(buildDir, 'ggml', 'src', 'ggml-cuda'), // libggml-cuda.so
      ];
      let soCount = 0;
      for (const dir of soDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const isSharedLib =
            file.endsWith('.so') || file.includes('.so.') || file.endsWith('.dylib') || file.includes('.dylib.');
          if (!isSharedLib) continue;
          const src = path.join(dir, file);
          const dest = path.join(WHISPER_CPP_DIR, file);
          try {
            const stat = fs.lstatSync(src);
            if (stat.isSymbolicLink()) {
              const linkTarget = fs.readlinkSync(src);
              try {
                fs.unlinkSync(dest);
              } catch (_e) {
                /* ignore */
              }
              fs.symlinkSync(linkTarget, dest);
            } else {
              fs.copyFileSync(src, dest);
            }
            soCount++;
          } catch (_e) {
            /* ignore individual file errors */
          }
        }
      }
      if (soCount > 0) {
        console.log(`  Copied ${soCount} shared libraries to whisper-cpp/`);
      }
    }

    if (!hasWhisperRuntimeLibraries()) {
      console.log('  [WARN] Build completed, but whisper-cli could not load its runtime libraries.');
      return false;
    }

    console.log('\n  [Build] whisper.cpp built and installed successfully!\n');
    return true;
  } catch (err) {
    console.log(`  [Build] Build failed: ${err.message}`);
    return false;
  } finally {
    // Cleanup build temp
    try {
      fs.rmSync(buildTempDir, { recursive: true, force: true });
    } catch (_e) {
      /* ignore */
    }
  }
}

/**
 * Ensure cross-platform node-llama-cpp binaries are installed.
 * npm only installs optionalDependencies matching the current platform/arch,
 * so we manually fetch the other platforms' binaries via npm.
 */
function ensureLlamaBinaries() {
  const required = [
    '@node-llama-cpp/win-x64',
    '@node-llama-cpp/win-x64-cuda',
    '@node-llama-cpp/win-x64-cuda-ext',
    '@node-llama-cpp/win-x64-vulkan',
    '@node-llama-cpp/win-arm64',
    '@node-llama-cpp/linux-x64',
    '@node-llama-cpp/linux-x64-cuda',
    '@node-llama-cpp/linux-x64-cuda-ext',
    '@node-llama-cpp/linux-x64-vulkan',
    '@node-llama-cpp/linux-arm64',
    '@node-llama-cpp/linux-armv7l',
    '@node-llama-cpp/mac-arm64-metal',
    '@node-llama-cpp/mac-x64',
  ];
  const root = path.join(__dirname, '..');
  const missing = required.filter((pkg) => {
    return !fs.existsSync(path.join(root, 'node_modules', pkg, 'package.json'));
  });
  if (missing.length === 0) {
    console.log('  [llama] All cross-platform binaries already installed.');
    return [];
  }
  // Read version from main node-llama-cpp
  let version = '3.18.1';
  try {
    const main = require(path.join(root, 'node_modules', 'node-llama-cpp', 'package.json'));
    version = main.version || version;
  } catch (_e) {
    /* ignore */
  }
  console.log(`\n  [llama] Installing ${missing.length} cross-platform binary package(s)...`);
  // npm honors os/cpu fields in package.json and skips non-matching optionalDependencies
  // even with --force. Pass --os= and --cpu= per package so mac-arm64-metal/mac-x64/etc.
  // actually get unpacked when installing from a non-matching host (e.g. Windows).
  function flagsFor(pkg) {
    let os = 'linux';
    if (pkg.includes('win-')) os = 'win32';
    else if (pkg.includes('mac-')) os = 'darwin';
    let cpu = 'x64';
    if (pkg.includes('armv7l')) cpu = 'arm';
    else if (pkg.includes('arm64')) cpu = 'arm64';
    return `--os=${os} --cpu=${cpu}`;
  }
  // npm install은 같은 node_modules와 lockfile을 수정하므로 순차 실행한다.
  // 실패한 패키지만 마지막에 한 번 재시도해 일시적인 레지스트리 오류를 흡수한다.
  function installOne(pkg) {
    const cmd = `npm install --no-save --force --ignore-scripts ${flagsFor(pkg)} ${pkg}@${version}`;
    execFileSync(cmd, { stdio: 'inherit', cwd: root, timeout: 300000, shell: true });
  }
  const failed = [];
  for (const pkg of missing) {
    try {
      installOne(pkg);
    } catch (err) {
      failed.push(pkg);
      console.log(`  [llama] Failed to install ${pkg}: ${err.message}`);
    }
  }
  const stillFailed = [];
  for (const pkg of failed) {
    try {
      installOne(pkg);
    } catch (err) {
      stillFailed.push(pkg);
      console.log(`  [llama] Retry failed for ${pkg}: ${err.message}`);
    }
  }
  return stillFailed;
}

/**
 * Main installation function
 */
async function main() {
  // Ensure node-llama-cpp binaries for all platforms
  let llamaFailures = [];
  try {
    llamaFailures = (await ensureLlamaBinaries()) || [];
  } catch (e) {
    console.log('  [llama] Skipped:', e.message);
    llamaFailures = ['<unknown>'];
  }
  if (llamaFailures.length > 0) {
    markInstallFailure('llama', `cross-platform binaries failed: ${llamaFailures.join(', ')}`);
  } else {
    clearInstallFailure('llama');
    console.log('  [llama] Cross-platform binaries installed.\n');
  }

  console.log('\n[postinstall] Checking whisper-cpp...\n');

  // Skip if already installed
  if (hasWhisperRuntimeLibraries()) {
    console.log('  whisper-cpp already installed. Skipping.\n');
    clearInstallFailure('whisper');
    // VAD 모델과 Vulkan 번들은 이전 실패로 누락됐을 수 있으니 조기 반환 전에도 확인한다.
    await downloadVadModel();
    await ensureVulkanBundle();
    return;
  }

  if (fs.existsSync(WHISPER_CLI)) {
    console.log('  whisper-cpp install is incomplete. Reinstalling missing runtime libraries...\n');
  }

  console.log('  whisper-cpp not found. Downloading...\n');

  try {
    // 1. Fetch the pinned release info
    console.log(`  Fetching whisper.cpp ${WHISPER_CPP_VERSION} release info...`);
    const release = await fetchPinnedWhisperRelease();
    if (release.tag_name !== WHISPER_CPP_VERSION) {
      throw new Error(`Expected whisper.cpp ${WHISPER_CPP_VERSION} but the API returned ${release.tag_name}`);
    }

    // 2. Find suitable asset based on platform
    let isCudaBuild = false;
    let asset = null;

    if (process.platform === 'win32') {
      // Windows: Priority CUDA 12 > CUDA 11 > CPU
      asset = release.assets.find(
        (a) => a.name.includes('cublas') && a.name.includes('12') && a.name.endsWith('.zip') && a.name.includes('x64')
      );

      if (!asset) {
        console.log('  [INFO] CUDA 12 not found, trying CUDA 11...');
        asset = release.assets.find(
          (a) => a.name.includes('cublas') && a.name.endsWith('.zip') && a.name.includes('x64')
        );
      }

      if (asset) {
        isCudaBuild = true;
      } else {
        console.log('  [INFO] CUDA version not found, using CPU version...');
        asset = release.assets.find(
          (a) =>
            a.name.includes('bin') && a.name.endsWith('.zip') && !a.name.includes('cublas') && a.name.includes('x64')
        );
      }

      if (!asset) {
        throw new Error('No suitable whisper.cpp release found for Windows x64');
      }
    } else if (process.platform === 'darwin') {
      // macOS: look for macOS/Darwin binary
      asset = release.assets.find(
        (a) =>
          (a.name.toLowerCase().includes('darwin') ||
            a.name.toLowerCase().includes('macos') ||
            a.name.toLowerCase().includes('apple')) &&
          a.name.endsWith('.zip')
      );

      if (!asset) {
        console.log('  [INFO] No pre-built macOS binary found. Attempting to build from source...');
        if (await buildWhisperFromSource(false)) return;
        console.log('  [ERROR] Auto-build failed. Please build manually:');
        console.log('    git clone https://github.com/ggml-org/whisper.cpp');
        console.log('    cd whisper.cpp && cmake -B build && cmake --build build --config Release');
        console.log(`    cp build/bin/whisper-cli ${WHISPER_CPP_DIR}/`);
        return;
      }
    } else {
      // Linux: look for Linux binary
      asset = release.assets.find(
        (a) =>
          a.name.toLowerCase().includes('linux') &&
          a.name.includes('x64') &&
          (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'))
      );

      // Also try CUDA builds for Linux
      if (!asset) {
        asset = release.assets.find(
          (a) => a.name.toLowerCase().includes('linux') && (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'))
        );
      }

      if (!asset) {
        console.log('  [INFO] No pre-built Linux binary found. Attempting to build from source...');
        const withCuda = hasCudaToolkit();
        if (await buildWhisperFromSource(withCuda)) return;
        if (withCuda) {
          console.log('  [INFO] CUDA build failed; trying CPU-only build...');
          if (await buildWhisperFromSource(false)) return;
        }
        console.log('  [ERROR] Auto-build failed. Please build manually:');
        console.log('    git clone https://github.com/ggml-org/whisper.cpp');
        console.log('    cd whisper.cpp && cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release');
        console.log(`    cp build/bin/whisper-cli ${WHISPER_CPP_DIR}/`);
        console.log('  Or for CPU-only:');
        console.log('    cmake -B build && cmake --build build --config Release');
        return;
      }
    }

    // Validate asset URL
    if (!asset.browser_download_url || !asset.browser_download_url.startsWith('https://')) {
      throw new Error('Invalid download URL');
    }

    console.log(`  Found: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

    // 3. Download main build
    const archiveExt = asset.name.endsWith('.tar.gz') ? '.tar.gz' : '.zip';
    const zipPath = path.join(__dirname, '..', 'whisper-cpp-temp' + archiveExt);
    console.log('  Downloading from GitHub...');
    await downloadFile(asset.browser_download_url, zipPath);

    // 실행 파일이 될 Windows 아카이브만 로컬 핀으로 3중 검증한다. 다른 플랫폼
    // 자산은 아직 핀이 없어 기존 HTTPS+content-length 검사에 맡긴다.
    if (process.platform === 'win32') {
      await verifyWhisperAsset(asset, zipPath);
    }

    // 4. Create destination directory
    if (!fs.existsSync(WHISPER_CPP_DIR)) {
      fs.mkdirSync(WHISPER_CPP_DIR, { recursive: true });
    }

    // 5. Extract
    await extractZip(zipPath, WHISPER_CPP_DIR);

    // 6. Handle various ZIP structures
    // Some releases have files in Release/ subfolder
    const releaseDir = path.join(WHISPER_CPP_DIR, 'Release');
    if (fs.existsSync(releaseDir) && fs.statSync(releaseDir).isDirectory()) {
      console.log('  Moving files from Release folder...');
      moveFilesUp(releaseDir, WHISPER_CPP_DIR);
    }

    // Some releases have files in whisper-* or bin/ subfolder
    const extractedItems = fs.readdirSync(WHISPER_CPP_DIR);
    const innerDir = extractedItems.find((item) => {
      const itemPath = path.join(WHISPER_CPP_DIR, item);
      return fs.statSync(itemPath).isDirectory() && (item.includes('whisper') || item === 'bin');
    });

    if (innerDir) {
      const innerPath = path.join(WHISPER_CPP_DIR, innerDir);
      moveFilesUp(innerPath, WHISPER_CPP_DIR);
    }

    // 7. Cleanup temp file
    try {
      fs.unlinkSync(zipPath);
    } catch (e) {
      console.log('  [WARN] Could not delete temp file:', e.message);
    }

    // 8. Verify installation and set executable permission
    if (fs.existsSync(WHISPER_CLI) && process.platform !== 'win32') {
      try {
        fs.chmodSync(WHISPER_CLI, 0o755);
      } catch (_e) {
        /* ignore */
      }
    }

    if (hasWhisperRuntimeLibraries()) {
      console.log('\n  whisper-cpp installed successfully!\n');
    } else {
      console.log('\n  [WARN] Installation is incomplete or whisper-cli cannot load its runtime libraries.\n');
      console.log('  Expected executable:', WHISPER_CLI);
    }

    // 9. Download CPU fallback build (when main build is CUDA, Windows only)
    if (process.platform === 'win32' && isCudaBuild && !fs.existsSync(CPU_CLI)) {
      const cpuAsset = release.assets.find(
        (a) => a.name.includes('bin') && a.name.endsWith('.zip') && !a.name.includes('cublas') && a.name.includes('x64')
      );

      if (cpuAsset && cpuAsset.browser_download_url && cpuAsset.browser_download_url.startsWith('https://')) {
        console.log(`\n  Downloading CPU fallback build: ${cpuAsset.name}...`);
        const cpuZipPath = path.join(__dirname, '..', 'whisper-cpu-temp.zip');
        const cpuTempDir = path.join(__dirname, '..', 'whisper-cpu-temp');

        try {
          await downloadFile(cpuAsset.browser_download_url, cpuZipPath);
          await verifyWhisperAsset(cpuAsset, cpuZipPath);

          if (!fs.existsSync(cpuTempDir)) {
            fs.mkdirSync(cpuTempDir, { recursive: true });
          }
          await extractZip(cpuZipPath, cpuTempDir);

          // Find whisper-cli binary in extracted files (handle subdirectories)
          const findExe = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const fullPath = path.join(dir, item);
              if (item === CLI_NAME) return fullPath;
              if (fs.statSync(fullPath).isDirectory()) {
                const found = findExe(fullPath);
                if (found) return found;
              }
            }
            return null;
          };

          const cpuExe = findExe(cpuTempDir);
          if (cpuExe) {
            if (!fs.existsSync(CPU_DIR)) {
              fs.mkdirSync(CPU_DIR, { recursive: true });
            }
            // Copy whisper-cli.exe AND every runtime DLL sitting next to it.
            // Without the dependent DLLs (whisper.dll, ggml*.dll, ...), Windows
            // fails to load the binary and Node spawn() surfaces it as ENOENT,
            // which historically looked like "whisper-cli not found" to users
            // (see issue #26).
            const cpuSrcDir = path.dirname(cpuExe);
            const runtimePattern = /\.(dll|so|so\.\d+|dylib)$/i;
            let copiedDll = 0;
            for (const entry of fs.readdirSync(cpuSrcDir)) {
              const src = path.join(cpuSrcDir, entry);
              try {
                if (!fs.statSync(src).isFile()) continue;
              } catch (_e) {
                continue;
              }
              // Always carry the CLI binary; otherwise only ship runtime libs.
              if (entry !== CLI_NAME && !runtimePattern.test(entry)) continue;
              const dest = path.join(CPU_DIR, entry);
              try {
                fs.copyFileSync(src, dest);
                if (entry !== CLI_NAME) copiedDll++;
              } catch (copyErr) {
                console.log(`  [WARN] Failed to copy ${entry}: ${copyErr.message}`);
              }
            }
            if (process.platform !== 'win32') {
              try {
                fs.chmodSync(CPU_CLI, 0o755);
              } catch (_e) {
                /* ignore */
              }
            }
            console.log(`  CPU fallback build installed at whisper-cpp/cpu/ (cli + ${copiedDll} runtime libs)\n`);
          } else {
            console.log(`  [WARN] ${CLI_NAME} not found in CPU build zip\n`);
          }

          // Cleanup
          try {
            fs.unlinkSync(cpuZipPath);
          } catch (_e) {
            /* ignore */
          }
          try {
            fs.rmSync(cpuTempDir, { recursive: true, force: true });
          } catch (_e) {
            /* ignore */
          }
        } catch (cpuErr) {
          console.log(`  [WARN] CPU fallback download failed: ${cpuErr.message}`);
          console.log('  GPU-only build will be used. If you encounter CUDA errors,');
          console.log('  download whisper-bin-x64.zip manually and extract to whisper-cpp/cpu/\n');
          // Cleanup on error
          try {
            fs.unlinkSync(cpuZipPath);
          } catch (_e) {
            /* ignore */
          }
          try {
            fs.rmSync(cpuTempDir, { recursive: true, force: true });
          } catch (_e) {
            /* ignore */
          }
        }
      }
    }
  } catch (error) {
    console.error('\n  [ERROR] Failed to download whisper-cpp:', error.message);
    console.log('  Please download manually from: https://github.com/ggml-org/whisper.cpp/releases\n');
    // npm install 자체는 실패시키지 않되, 설치 실패를 CI/사용자가 감지할 수 있게
    // 마커 파일을 남긴다 (이전엔 조용히 exit 0였다).
    markInstallFailure('whisper', `download/install failed: ${error.message}`);
  }

  // whisper-cpp 설치가 불완전하면 실패 마커 (런타임에서 경고 표시 가능).
  // 성공 경로에서는 이전 실패 마커를 제거한다 (LOW-5).
  if (hasWhisperRuntimeLibraries()) {
    clearInstallFailure('whisper');
  } else {
    markInstallFailure('whisper', 'runtime libraries are missing or broken');
  }

  // Silero VAD model (separate from the whisper-cli release). Optional — a
  // failure here must NOT break the install; extraction degrades gracefully.
  await downloadVadModel();
  await ensureVulkanBundle();
}

// llama와 whisper 상태를 독립 저장해 한쪽 성공이 다른 쪽 실패를 지우지 않게 한다.
function updateInstallFailureMarker(markerPath, scope, reason) {
  let issues = {};
  try {
    issues = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_e) {}
  if (reason) issues[scope] = { at: new Date().toISOString(), reason };
  else delete issues[scope];
  if (Object.keys(issues).length === 0) {
    fs.rmSync(markerPath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify(issues, null, 2)}\n`);
  }
  return issues;
}

function markInstallFailure(scope, reason) {
  try {
    updateInstallFailureMarker(path.join(WHISPER_CPP_DIR, 'install-failed.txt'), scope, reason);
    console.log(`  [WARN] install-failed.txt updated: ${scope}: ${reason}`);
  } catch (_e) {
    /* ignore */
  }
}

function clearInstallFailure(scope) {
  try {
    updateInstallFailureMarker(path.join(WHISPER_CPP_DIR, 'install-failed.txt'), scope);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * Download the Silero VAD ggml model into whisper-cpp/ if missing.
 * Graceful: any failure just logs a warning (VAD is then skipped at runtime).
 */
async function downloadVadModel() {
  try {
    const pinned = { size: VAD_MODEL_SIZE, sha256: VAD_MODEL_SHA256 };
    // 기존 파일도 고정값으로 검증한다. 유효하면 종료하고, 손상·변조면
    // verifyPinnedDownload가 이미 지웠으므로 같은 호출에서 바로 재다운로드한다.
    if (fs.existsSync(VAD_MODEL_PATH)) {
      try {
        await verifyPinnedDownload(VAD_MODEL_NAME, VAD_MODEL_PATH, pinned);
        return; // already present and valid
      } catch (_e) {
        console.log(`  [INFO] Existing ${VAD_MODEL_NAME} failed its pinned size/sha256 check; re-downloading...`);
      }
    }
    if (!fs.existsSync(WHISPER_CPP_DIR)) {
      fs.mkdirSync(WHISPER_CPP_DIR, { recursive: true });
    }
    console.log(`\n  Downloading Silero VAD model (${VAD_MODEL_NAME}, ~0.9 MB)...`);
    await downloadFile(VAD_MODEL_URL, VAD_MODEL_PATH);
    // 고정 크기·해시와 대조. 불일치면 파일이 지워지고 아래 catch에서 우아히
    // 건너뛴다(VAD 부재는 런타임에서 정상 처리된다).
    await verifyPinnedDownload(VAD_MODEL_NAME, VAD_MODEL_PATH, pinned);
    console.log('  VAD model installed (speech-only processing enabled).\n');
  } catch (err) {
    console.log(`  [WARN] Could not download VAD model: ${err.message}`);
    console.log('  Subtitle extraction still works; repetition suppression will be reduced.\n');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.log('  [postinstall] step skipped:', e.message);
  });
}

module.exports = {
  hasWhisperRuntimeLibraries,
  hasVulkanRuntimeLibraries,
  ensureVulkanBundle,
  downloadFile,
  sha256File,
  verifyPinnedDownload,
  verifyWhisperAsset,
  WHISPER_ASSET_MANIFEST,
  updateInstallFailureMarker,
};
