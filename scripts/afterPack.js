/**
 * afterPack.js - electron-builder afterPack hook
 *
 * Stages CUDA 12 runtime prerequisites for node-llama-cpp's Windows backends.
 *
 * node-llama-cpp's CUDA 12 fallback backend (`ggml-cuda.dll`) depends on the
 * CUDA runtime DLLs (cudart64_12 / cublas64_12 / cublasLt64_12). The fallback
 * lives in the `@node-llama-cpp/win-x64-cuda-ext` package, separate from the
 * native addon in `win-x64-cuda`; Windows resolves backend dependencies beside
 * the backend being loaded, so both official backend locations need the
 * runtime files when present.
 *
 * whisper-cpp already ships the same CUDA 12 runtime DLLs (it is copied to
 * resources/whisper-cpp via win.extraResources). This hook copies those three
 * DLLs beside both official backend locations. Placement alone does not prove
 * that node-llama-cpp selected a GPU backend; that requires a runtime check.
 * Idempotent, Windows-only, and never throws (a packaging hiccup must not break
 * the whole build).
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
    const llamaModulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp');
    const candidateDstDirs = [
      path.join(llamaModulesDir, 'win-x64-cuda', 'bins', 'win-x64-cuda'),
      path.join(llamaModulesDir, 'win-x64-cuda-ext', 'bins', 'win-x64-cuda', 'fallback'),
    ];
    const dstDirs = candidateDstDirs.filter((dir) => fs.existsSync(dir));

    if (dstDirs.length === 0) {
      console.log(
        `  [afterPack] node-llama-cpp CUDA bins not found, skipping CUDA runtime copy:\n             ${candidateDstDirs.join('\n             ')}`
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
      if (!fs.existsSync(src)) {
        console.log(`  [afterPack] [WARN] missing CUDA runtime source: ${dll}`);
        continue;
      }
      for (const dstDir of dstDirs) {
        const dst = path.join(dstDir, dll);
        // Skip if an identical-size copy is already in place (idempotent rebuilds).
        if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) {
          continue;
        }
        fs.copyFileSync(src, dst);
        copied++;
      }
    }

    if (copied > 0) {
      console.log(
        `  [afterPack] Copied ${copied} CUDA runtime DLL(s) into ${dstDirs.length} node-llama-cpp CUDA backend location(s); runtime GPU selection is not implied.`
      );
    } else {
      console.log('  [afterPack] CUDA runtime DLLs already present in node-llama-cpp CUDA backend locations.');
    }
  } catch (err) {
    // Never fail the build over this; just make the cause loud.
    console.log(`  [afterPack] [WARN] CUDA runtime copy failed (GPU translation may fall back to CPU): ${err.message}`);
  }
};
