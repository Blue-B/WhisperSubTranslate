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
const WHISPER_CLI = path.join(WHISPER_CPP_DIR, 'whisper-cli.exe');
const CPU_DIR = path.join(WHISPER_CPP_DIR, 'cpu');
const CPU_CLI = path.join(CPU_DIR, 'whisper-cli.exe');
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
 * Extract ZIP file using platform-specific tools
 * @param {string} zipPath - Path to ZIP file
 * @param {string} destDir - Destination directory
 */
async function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    console.log('  Extracting...');
    // Use PowerShell with proper escaping
    const psCommand = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -Command "${psCommand}"`, {
      stdio: 'inherit',
      windowsHide: true
    });
  } else {
    // Linux/Mac: use unzip
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
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

    // 2. Find suitable asset (Priority: CUDA 12 > CUDA 11 > CPU)
    let isCudaBuild = false;
    let asset = release.assets.find(a =>
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

    // Validate asset URL
    if (!asset.browser_download_url || !asset.browser_download_url.startsWith('https://')) {
      throw new Error('Invalid download URL');
    }

    console.log(`  Found: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

    // 3. Download main build
    const zipPath = path.join(__dirname, '..', 'whisper-cpp-temp.zip');
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

    // 8. Verify installation
    if (fs.existsSync(WHISPER_CLI)) {
      console.log('\n  whisper-cpp installed successfully!\n');
    } else {
      console.log('\n  [WARN] Installation may be incomplete. Please check whisper-cpp folder.\n');
      console.log('  Expected file:', WHISPER_CLI);
    }

    // 9. Download CPU fallback build (when main build is CUDA)
    if (isCudaBuild && !fs.existsSync(CPU_CLI)) {
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

          // Find whisper-cli.exe in extracted files (handle subdirectories)
          const findExe = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const fullPath = path.join(dir, item);
              if (item === 'whisper-cli.exe') return fullPath;
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
            console.log('  [WARN] whisper-cli.exe not found in CPU build zip\n');
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
