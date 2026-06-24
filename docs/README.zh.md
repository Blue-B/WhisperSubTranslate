# WhisperSubTranslate

[English](../README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | 中文 | [Polski](./README.pl.md)

在本地把视频变成多语言字幕。放入视频，用 whisper.cpp 生成 SRT，再用内置的 Hy-MT2 模型离线翻译，或使用免费/付费的在线引擎。

> 本应用从视频音频生成新字幕(语音转文字)。不提取内嵌字幕轨道，也不读取画面文字(非 OCR)。

## 预览

<p align="center">
  <img src="../assets/hero/hero.png" alt="WhisperSubTranslate 主界面" width="100%">
</p>

## 主要功能

- 语音识别 100% 在本地运行。视频不离开你的电脑，无需账号，无需上传。
- 用内置 Hy-MT2 模型离线翻译，或用自己的密钥使用在线引擎(MyMemory、DeepL、OpenAI、Gemini)。
- 模型自动下载。无需安装 Python，无需手动配置。
- 提供同步修复模型(large-v2 同步、同步轻量),用于普通模型字幕错位的视频。
- 任务队列、实时进度、仅本地的任务历史。

## 快速开始

### 用户

从 [Releases](https://github.com/Blue-B/WhisperSubTranslate/releases) 下载最新便携版，解压后运行 `WhisperSubTranslate.exe`。字幕提取在本机完全离线运行。翻译为可选。

### 开发者

```bash
npm install
npm start
```

- Node.js 20.19 以上或 22.12 以上 (Electron 42 构建工具链)
- whisper.cpp 在 `npm install` 时自动下载 (Windows 为 CUDA 版本，约700MB)
- FFmpeg 通过 npm 自带；所选 GGML 模型在首次使用时下载

### Linux

```bash
sudo apt install cmake build-essential git ffmpeg   # Ubuntu/Debian
npm install   # whisper.cpp 从源码构建
npm start
```

如需 CUDA 加速，请在 `npm install` 前安装 NVIDIA CUDA Toolkit。whisper.cpp 的手动构建步骤见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

### Windows 构建

```bash
npm run build-win   # 产物输出到 dist2/
```

## 翻译引擎

用内置的 Tencent Hy-MT2 模型完全离线翻译，或用自己的 API 密钥使用免费/付费在线引擎。

| 引擎 | 离线 | API 密钥 | 费用 | 备注 |
| --- | :---: | :---: | --- | --- |
| Hy-MT2 1.8B (本地，默认) | 是 | 不需要 | 免费 | 约1.13GB，显存 2GB / 内存 4GB，端侧 |
| Hy-MT2 7B (本地) | 是 | 不需要 | 免费 | 约6.16GB，显存 8GB / 内存 12GB，更大模型 |
| MyMemory | 否 | 不需要 | 免费 | 每 IP 每天约5万字符 |
| DeepL | 否 | 需要 | 每月50万字符免费 | 输出稳定 |
| OpenAI GPT-5.4 mini | 否 | 需要 | 付费 | 上下文感知 |
| OpenAI GPT-5.4 nano | 否 | 需要 | 付费 | 更便宜档位 |
| Gemini 3 Flash | 否 | 需要 | 免费 / 低成本 | 推荐的低成本路线 ([获取密钥](https://aistudio.google.com/app/apikey)) |

只有本地 Hy-MT2 引擎无需 API 密钥、无需网络、无每次费用，台词不会离开你的电脑。

### 翻译质量 (离线引擎)

WhisperSubTranslate 内置 Tencent Hy-MT2 模型(默认 1.8B，可选 7B)。在 Tencent 官方评测中，Hy-MT2 系列与主流商用翻译 API 具备竞争力，并在部分基准上取得领先结果。

![Tencent Hy-MT2 官方基准，WhisperSubTranslate 内置模型](../assets/hy-mt2-benchmark.zh.png)

来源: Tencent 官方基准: [Hy-MT2 仓库](https://github.com/Tencent-Hunyuan/Hy-MT2), [技术报告](https://arxiv.org/pdf/2605.22064), [HuggingFace 模型](https://huggingface.co/tencent/Hy-MT2-1.8B)。上图重绘自 Tencent 官方 Figure 1，内置模型(1.8B/7B)数值已与论文表格核对。这些数据是在标准机器翻译基准(WildMTBench, WMT25, FLORES-200 等)上对模型本身的测量，并非对 WhisperSubTranslate 应用本身的重新基准测试。

对于长视频(1小时以上),MyMemory 的每日限制可能导致变慢。这时请改用 Gemini、DeepL 或已配置的 GPT 模型。

## 语音识别模型

模型按需下载到 `_models/`。有 CUDA 时用 GPU，否则用 CPU。请选择适合你 GPU 的大小。

| 模型 | 大小 | 显存 | 速度 | 备注 |
| --- | --- | --- | --- | --- |
| tiny | 约75MB | 约1GB | 最快 | 基础 |
| base | 约142MB | 约1GB | 快 | 良好 |
| small | 约466MB | 约1GB | 中等 | 更好 |
| medium | 约1.5GB | 约2GB | 中等 | 优秀 |
| large-v3 | 约3GB | 约4GB | 慢 | 转写最佳 |
| large-v3-turbo (默认) | 约809MB | 约2GB | 快 | 综合最均衡 |
| large-v2 同步 | 约4.4GB | 约4.5GB | 慢 | 独立引擎，修复字幕同步 |
| large-v2 同步轻量 | 共用 | 约3GB | 慢 | 与同步同一文件，int8，低显存 |

同步与同步轻量使用独立的 Faster-Whisper 引擎(首次自动下载一次，约4.4GB),并共用同一模型文件，所以下载一次即可两者通用。仅在普通模型字幕错位时使用。它们在非英语视频(日语、韩语、中文)上最准确，英语通常用 large-v3-turbo 即可。

whisper.cpp 模型的显存为 GGML 优化基准，远低于 PyTorch Whisper(large 约10GB)。同步模型数值基于 Faster-Whisper 基准。

## 语言支持

- 界面: 韩语、英语、日语、中文、波兰语
- 翻译目标(14种): ko, en, ja, zh, es, fr, de, it, pt, ru, hu, ar, pl, fa
- 语音识别: whisper.cpp 支持100多种语言

## 数据存储

所有数据仅本地保存在用户文件夹，不会上传。

| 数据 | 位置 |
| --- | --- |
| 设置与 API 密钥 | `%APPDATA%\whispersubtranslate\translation-config-safe.json` |
| 任务历史 | `%APPDATA%\whispersubtranslate\history.json` (最多200条) |
| 错误日志 | `%APPDATA%\whispersubtranslate\logs\errors.log` |
| 模型 | `_models/` (应用文件夹) |

API 密钥用操作系统的安全存储保存在本地，配置文件不会提交到 Git 也不会打包。任务历史为可选(在设置中开关),最多保留200条。

## 贡献

欢迎 Pull Request。分支命名、提交规范、手动测试清单、whisper.cpp 手动构建见 [CONTRIBUTING.md](../CONTRIBUTING.md)。添加语言请参阅 [翻译指南](./TRANSLATION.md)。

可在 [Weblate](https://hosted.weblate.org/engage/whispersubtranslate/) 参与翻译。可翻译字符串位于 [`locales/*.json`](../locales/)。

## 贡献者

感谢所有让 WhisperSubTranslate 变得更好的人。

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/matbgn"><img src="https://github.com/matbgn.png?size=80" width="80" alt="matbgn" title="matbgn" /></a>

## 支持

如果本项目为你节省了时间，直接支持有助于修复 bug、提升模型可靠性和增加新的翻译选项。

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## 致谢

- whisper.cpp: Georgi Gerganov [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Hy-MT2: Tencent [Tencent-Hunyuan/Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## 许可证

GPL-3.0。外部 API 与服务(DeepL、OpenAI、Gemini 等)需遵守各自条款。
