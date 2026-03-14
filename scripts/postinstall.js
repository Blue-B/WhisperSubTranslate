/**
 * postinstall.js - Auto-download whisper-cpp after npm install
 *
 * Downloads CUDA version (falls back to CPU if GPU not available)
 * Priority: CUDA 12 > CUDA 11 > CPU-only
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Constants
const WHISPER_CPP_DIR = path.join(__dirname, '..', 'whisper-cpp');
const CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const WHISPER_CLI = path.join(WHISPER_CPP_DIR, CLI_NAME);
const CPU_DIR = path.join(WHISPER_CPP_DIR, 'cpu');
const CPU_CLI = path.join(CPU_DIR, CLI_NAME);
const GITHUB_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB limit for API response
const MAX_REDIRECTS = 5;

/**
 * Fetch latest release info from GitHub API
 * @returns {Promise<Object>} Release data
 */
async function getLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'WhisperSubTranslate-Installer' }
    };

    https.get(GITHUB_API, options, (res) => {
      // Validate response status
      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      let size = 0;

      res.on('data', chunk => {
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
    }).on('error', reject);
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
    const file = fs.createWriteStream(destPath);
    let redirectCount = 0;

    const request = (currentUrl) => {
      // Validate URL
      if (!currentUrl.startsWith('https://')) {
        reject(new Error('Invalid URL: must use HTTPS'));
        return;
      }

      if (redirectCount >= MAX_REDIRECTS) {
        reject(new Error('Too many redirects'));
        return;
      }

      https.get(currentUrl, { headers: { 'User-Agent': 'WhisperSubTranslate-Installer' } }, (res) => {
        // Handle redirect
        if (res.statusCode === 302 || res.statusCode === 301) {
          redirectCount++;
          const location = res.headers.location;
          if (!location) {
            reject(new Error('Redirect without location header'));
            return;
          }
          request(location);
          return;
        }

        // Validate response
        if (res.statusCode !== 200) {
          fs.unlink(destPath, () => {});
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

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

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          if (totalSize > 0) {
            console.log('\r  Downloading: 100%');
          } else {
            console.log('\r  Download complete');
          }
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });

      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
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
async function extractZip(archivePath, destDir) {
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    console.log('  Extracting tar.gz...');
    execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    console.log('  Extracting...');
    // Use PowerShell with proper escaping
    const psCommand = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -Command "${psCommand}"`, {
      stdio: 'inherit',
      windowsHide: true
    });
  } else {
    // Linux/Mac: use unzip
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
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
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
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
    execSync(`git clone --depth 1 https://github.com/ggml-org/whisper.cpp "${buildTempDir}"`, {
      stdio: 'inherit',
      timeout: 120000
    });

    const cmakeArgs = withCuda ? '-DGGML_CUDA=ON' : '';
    console.log(`  [Build] Running cmake (${withCuda ? 'CUDA' : 'CPU'} mode)...`);
    execSync(`cmake -B build ${cmakeArgs}`, {
      cwd: buildTempDir,
      stdio: 'inherit',
      timeout: 60000
    });

    console.log('  [Build] Compiling... (this may take a few minutes)');
    const cores = require('os').cpus().length;
    execSync(`cmake --build build --config Release -j${Math.max(1, cores - 1)}`, {
      cwd: buildTempDir,
      stdio: 'inherit',
      timeout: 600000
    });

    // Find the built binary
    const possiblePaths = [
      path.join(buildTempDir, 'build', 'bin', 'whisper-cli'),
      path.join(buildTempDir, 'build', 'bin', 'Release', 'whisper-cli'),
      path.join(buildTempDir, 'build', 'whisper-cli'),
    ];

    let builtBinary = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) { builtBinary = p; break; }
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

    console.log('\n  [Build] whisper.cpp built and installed successfully!\n');
    return true;

  } catch (err) {
    console.log(`  [Build] Build failed: ${err.message}`);
    return false;
  } finally {
    // Cleanup build temp
    try { fs.rmSync(buildTempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
}

/**
 * Main installation function
 */
async function main() {
  console.log('\n[postinstall] Checking whisper-cpp...\n');

  // Skip if already installed
  if (fs.existsSync(WHISPER_CLI)) {
    console.log('  whisper-cpp already installed. Skipping.\n');
    return;
  }

  console.log('  whisper-cpp not found. Downloading...\n');

  try {
    // 1. Fetch latest release info
    console.log('  Fetching latest release info...');
    const release = await getLatestRelease();

    // 2. Find suitable asset based on platform
    let isCudaBuild = false;
    let asset = null;

    if (process.platform === 'win32') {
      // Windows: Priority CUDA 12 > CUDA 11 > CPU
      asset = release.assets.find(a =>
        a.name.includes('cublas') &&
        a.name.includes('12') &&
        a.name.endsWith('.zip') &&
        a.name.includes('x64')
      );

      if (!asset) {
        console.log('  [INFO] CUDA 12 not found, trying CUDA 11...');
        asset = release.assets.find(a =>
          a.name.includes('cublas') &&
          a.name.endsWith('.zip') &&
          a.name.includes('x64')
        );
      }

      if (asset) {
        isCudaBuild = true;
      } else {
        console.log('  [INFO] CUDA version not found, using CPU version...');
        asset = release.assets.find(a =>
          a.name.includes('bin') &&
          a.name.endsWith('.zip') &&
          !a.name.includes('cublas') &&
          a.name.includes('x64')
        );
      }

      if (!asset) {
        throw new Error('No suitable whisper.cpp release found for Windows x64');
      }
    } else if (process.platform === 'darwin') {
      // macOS: look for macOS/Darwin binary
      asset = release.assets.find(a =>
        (a.name.toLowerCase().includes('darwin') || a.name.toLowerCase().includes('macos') || a.name.toLowerCase().includes('apple')) &&
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
      asset = release.assets.find(a =>
        a.name.toLowerCase().includes('linux') &&
        a.name.includes('x64') &&
        (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'))
      );

      // Also try CUDA builds for Linux
      if (!asset) {
        asset = release.assets.find(a =>
          a.name.toLowerCase().includes('linux') &&
          (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'))
        );
      }

      if (!asset) {
        console.log('  [INFO] No pre-built Linux binary found. Attempting to build from source...');
        if (await buildWhisperFromSource(hasCudaToolkit())) return;
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
    const innerDir = extractedItems.find(item => {
      const itemPath = path.join(WHISPER_CPP_DIR, item);
      return fs.statSync(itemPath).isDirectory() &&
             (item.includes('whisper') || item === 'bin');
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
    if (fs.existsSync(WHISPER_CLI)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(WHISPER_CLI, 0o755); } catch (_e) { /* ignore */ }
      }
      console.log('\n  whisper-cpp installed successfully!\n');
    } else {
      console.log('\n  [WARN] Installation may be incomplete. Please check whisper-cpp folder.\n');
      console.log('  Expected file:', WHISPER_CLI);
    }

    // 9. Download CPU fallback build (when main build is CUDA, Windows only)
    if (process.platform === 'win32' && isCudaBuild && !fs.existsSync(CPU_CLI)) {
      const cpuAsset = release.assets.find(a =>
        a.name.includes('bin') &&
        a.name.endsWith('.zip') &&
        !a.name.includes('cublas') &&
        a.name.includes('x64')
      );

      if (cpuAsset && cpuAsset.browser_download_url && cpuAsset.browser_download_url.startsWith('https://')) {
        console.log(`\n  Downloading CPU fallback build: ${cpuAsset.name}...`);
        const cpuZipPath = path.join(__dirname, '..', 'whisper-cpu-temp.zip');
        const cpuTempDir = path.join(__dirname, '..', 'whisper-cpu-temp');

        try {
          await downloadFile(cpuAsset.browser_download_url, cpuZipPath);

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
            fs.copyFileSync(cpuExe, CPU_CLI);
            console.log('  CPU fallback build installed at whisper-cpp/cpu/\n');
          } else {
            console.log(`  [WARN] ${CLI_NAME} not found in CPU build zip\n`);
          }

          // Cleanup
          try { fs.unlinkSync(cpuZipPath); } catch (_e) { /* ignore */ }
          try { fs.rmSync(cpuTempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        } catch (cpuErr) {
          console.log(`  [WARN] CPU fallback download failed: ${cpuErr.message}`);
          console.log('  GPU-only build will be used. If you encounter CUDA errors,');
          console.log('  download whisper-bin-x64.zip manually and extract to whisper-cpp/cpu/\n');
          // Cleanup on error
          try { fs.unlinkSync(cpuZipPath); } catch (_e) { /* ignore */ }
          try { fs.rmSync(cpuTempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        }
      }
    }

  } catch (error) {
    console.error('\n  [ERROR] Failed to download whisper-cpp:', error.message);
    console.log('  Please download manually from: https://github.com/ggml-org/whisper.cpp/releases\n');
    // Exit 0 so npm install doesn't fail
  }
}

main();
