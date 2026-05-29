/**
 * afterPack.js - electron-builder afterPack hook
 *
 * Root-cause fix for GPU translation silently falling back to CPU.
 *
 * node-llama-cpp's CUDA backend (`ggml-cuda.dll`) depends on the CUDA runtime
 * DLLs (cudart64_12 / cublas64_12 / cublasLt64_12). Those normally live in the
 * `@node-llama-cpp/win-x64-cuda-ext` package, whose DLLs are fetched by its OWN
 * postinstall script. Our `scripts/postinstall.js` installs the cross-platform
 * binaries with `--ignore-scripts`, so that download never runs and the
 * `win-x64-cuda-ext/bins` folder ends up EMPTY. Result: at runtime Windows
 * cannot resolve ggml-cuda.dll's imports, node-llama-cpp silently falls back to
 * the CPU backend, and local (Hy-MT2) translation crawls on CPU even when the
 * user selected GPU/CUDA.
 *
 * whisper-cpp already ships the exact same CUDA 12 runtime DLLs (it is copied to
 * resources/whisper-cpp via win.extraResources). This hook copies those three
 * DLLs next to ggml-cuda.dll so the CUDA backend loads. Idempotent, Windows-only,
 * and never throws (a packaging hiccup must not break the whole build).
 */

const fs = require('fs');
const path = require('path');

const CUDA_RUNTIME_DLLS = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];

module.exports = async function afterPack(context) {
  try {
    // Windows x64 is the only target that bundles the node-llama-cpp CUDA backend.
    if (context.electronPlatformName !== 'win32') return;

    const appOutDir = context.appOutDir;
    const resourcesDir = path.join(appOutDir, 'resources');

    const srcDir = path.join(resourcesDir, 'whisper-cpp');
    const dstDir = path.join(
      resourcesDir,
      'app.asar.unpacked',
      'node_modules',
      '@node-llama-cpp',
      'win-x64-cuda',
      'bins',
      'win-x64-cuda'
    );

    if (!fs.existsSync(dstDir)) {
      console.log(
        `  [afterPack] node-llama-cpp CUDA bins not found, skipping CUDA runtime copy:\n             ${dstDir}`
      );
      return;
    }
    if (!fs.existsSync(srcDir)) {
      console.log(
        `  [afterPack] whisper-cpp resources not found, cannot source CUDA runtime DLLs:\n             ${srcDir}`
      );
      return;
    }

    let copied = 0;
    for (const dll of CUDA_RUNTIME_DLLS) {
      const src = path.join(srcDir, dll);
      const dst = path.join(dstDir, dll);
      if (!fs.existsSync(src)) {
        console.log(`  [afterPack] [WARN] missing CUDA runtime source: ${dll}`);
        continue;
      }
      // Skip if an identical-size copy is already in place (idempotent rebuilds).
      if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) {
        continue;
      }
      fs.copyFileSync(src, dst);
      copied++;
    }

    if (copied > 0) {
      console.log(
        `  [afterPack] Copied ${copied} CUDA runtime DLL(s) into node-llama-cpp CUDA backend → GPU translation enabled.`
      );
    } else {
      console.log('  [afterPack] CUDA runtime DLLs already present in node-llama-cpp CUDA backend.');
    }
  } catch (err) {
    // Never fail the build over this; just make the cause loud.
    console.log(`  [afterPack] [WARN] CUDA runtime copy failed (GPU translation may fall back to CPU): ${err.message}`);
  }
};
