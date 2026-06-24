# WhisperSubTranslate

[English](../README.md) | [한국어](./README.ko.md) | 日本語 | [中文](./README.zh.md) | [Polski](./README.pl.md)

動画をローカルで多言語字幕にします。動画を入れると whisper.cpp で SRT を生成し、バンドルされた Hy-MT2 モデルでオフライン翻訳するか、無料/有料のオンラインエンジンで翻訳します。

> このアプリは動画の音声から新しい字幕を作成します(音声認識)。埋め込み字幕トラックの抽出や画面文字の読み取り(OCR)は行いません。

## プレビュー

<p align="center">
  <img src="../assets/hero/hero.png" alt="WhisperSubTranslate メイン画面" width="100%">
</p>

## 主な機能

- 音声認識は 100% ローカルで動作。動画が PC の外に出ず、アカウントもアップロードも不要。
- バンドルの Hy-MT2 モデルでオフライン翻訳、または自分のキーでオンラインエンジン(MyMemory, DeepL, OpenAI, Gemini)を利用。
- モデル自動ダウンロード。Python のインストールや手動設定は不要。
- 通常モデルで同期がずれる動画向けの同期補正モデル(large-v2 同期、同期ライト)を搭載。
- キュー、リアルタイム進捗、ローカル専用の処理履歴。

## はじめに

### ユーザー

[Releases](https://github.com/Blue-B/WhisperSubTranslate/releases) から最新のポータブル版をダウンロードし、展開して `WhisperSubTranslate.exe` を実行します。字幕抽出は PC 上で完全オフラインで動作します。翻訳は任意です。

### 開発者

```bash
npm install
npm start
```

- Node.js 20.19 以上または 22.12 以上 (Electron 42 ビルドツールチェーン)
- whisper.cpp は `npm install` 時に自動ダウンロード (Windows は CUDA ビルド、約700MB)
- FFmpeg は npm で同梱。選択した GGML モデルは初回使用時にダウンロード

### Linux

```bash
sudo apt install cmake build-essential git ffmpeg   # Ubuntu/Debian
npm install   # whisper.cpp をソースからビルド
npm start
```

CUDA 高速化が必要な場合は `npm install` の前に NVIDIA CUDA Toolkit を入れてください。whisper.cpp の手動ビルド手順は [CONTRIBUTING.md](../CONTRIBUTING.md) にあります。

### Windows ビルド

```bash
npm run build-win   # 成果物は dist2/ に出力されます
```

## 翻訳エンジン

バンドルの Tencent Hy-MT2 モデルで完全オフライン翻訳、または自分の API キーで無料/有料オンラインエンジンを使えます。

| エンジン | オフライン | API キー | 費用 | 備考 |
| --- | :---: | :---: | --- | --- |
| Hy-MT2 1.8B (ローカル、既定) | はい | 不要 | 無料 | 約1.13GB、VRAM 2GB / RAM 4GB、オンデバイス |
| Hy-MT2 7B (ローカル) | はい | 不要 | 無料 | 約6.16GB、VRAM 8GB / RAM 12GB、大型モデル |
| MyMemory | いいえ | 不要 | 無料 | IP ごとに 1日 約5万文字 |
| DeepL | いいえ | 必要 | 月50万文字 無料 | 出力が安定 |
| OpenAI GPT-5.4 mini | いいえ | 必要 | 有料 | 文脈認識 |
| OpenAI GPT-5.4 nano | いいえ | 必要 | 有料 | より安価なティア |
| Gemini 3 Flash | いいえ | 必要 | 無料 / 低コスト | 推奨の低コスト経路 ([キー取得](https://aistudio.google.com/app/apikey)) |

ローカルの Hy-MT2 エンジンだけが API キーもネットワークも使用料も不要で、セリフが PC の外に出ません。

### 翻訳品質 (オフラインエンジン)

WhisperSubTranslate は Tencent Hy-MT2 モデル(既定 1.8B、オプション 7B)を同梱しています。Tencent の公式評価では、Hy-MT2 ファミリーは主要な商用翻訳 API と競合し、一部のベンチマークでは上回る結果を示しています。

![Tencent Hy-MT2 公式ベンチマーク、WhisperSubTranslate 同梱モデル](../assets/hy-mt2-benchmark.ja.png)

出典: Tencent の公式ベンチマーク: [Hy-MT2 リポジトリ](https://github.com/Tencent-Hunyuan/Hy-MT2), [技術レポート](https://arxiv.org/pdf/2605.22064), [HuggingFace モデル](https://huggingface.co/tencent/Hy-MT2-1.8B)。上のグラフは Tencent 公式 Figure 1 を再描画したもので、同梱モデル(1.8B/7B)の数値は論文の表と照合しています。これらの数値は標準的な機械翻訳ベンチマーク(WildMTBench, WMT25, FLORES-200 など)でモデル自体を測定した結果であり、WhisperSubTranslate アプリ自体を再測定したものではありません。

長い動画(1時間以上)では MyMemory の1日制限で遅くなることがあります。その場合は Gemini、DeepL、設定済みの GPT モデルを使ってください。

## 音声認識モデル

モデルは必要に応じて `_models/` にダウンロードされます。CUDA があれば GPU、なければ CPU で動作します。GPU に合うサイズを選んでください。

| モデル | サイズ | VRAM | 速度 | 備考 |
| --- | --- | --- | --- | --- |
| tiny | 約75MB | 約1GB | 最速 | 基本 |
| base | 約142MB | 約1GB | 高速 | 良好 |
| small | 約466MB | 約1GB | 中速 | より良い |
| medium | 約1.5GB | 約2GB | 中速 | 優秀 |
| large-v3 | 約3GB | 約4GB | 低速 | 文字起こし最高 |
| large-v3-turbo (既定) | 約809MB | 約2GB | 高速 | 総合的に最も無難 |
| large-v2 同期 | 約4.4GB | 約4.5GB | 低速 | 別エンジン、字幕同期を補正 |
| large-v2 同期ライト | 共用 | 約3GB | 低速 | 同期と同じファイル、int8、低VRAM |

同期と同期ライトは別の Faster-Whisper エンジン(初回に一度自動ダウンロード、約4.4GB)を使い、同じモデルファイルを共有するため、一度ダウンロードすれば両方使えます。通常モデルで同期がずれるときだけ使ってください。非英語の動画(日本語、韓国語、中国語)で最も正確で、英語は通常 large-v3-turbo で十分です。

whisper.cpp モデルの VRAM は GGML 最適化基準で、PyTorch Whisper(large 約10GB)よりはるかに少なめです。同期モデルの数値は Faster-Whisper ベンチマーク基準です。

## 言語サポート

- UI: 韓国語、英語、日本語、中国語、ポーランド語
- 翻訳対象(14言語): ko, en, ja, zh, es, fr, de, it, pt, ru, hu, ar, pl, fa
- 音声認識: whisper.cpp で100言語以上

## データ保存

すべてのデータはユーザーフォルダにローカル保存され、アップロードされません。

| データ | 場所 |
| --- | --- |
| 設定と API キー | `%APPDATA%\whispersubtranslate\translation-config-safe.json` |
| 処理履歴 | `%APPDATA%\whispersubtranslate\history.json` (最大200件) |
| エラーログ | `%APPDATA%\whispersubtranslate\logs\errors.log` |
| モデル | `_models/` (アプリフォルダ) |

API キーは OS のセキュア保存でローカルに保存され、設定ファイルは Git にも配布物にも含まれません。処理履歴は任意で(設定で切替)、最大200件まで保持されます。

## 貢献

Pull Request を歓迎します。ブランチ命名、コミット規約、手動テストチェックリスト、whisper.cpp の手動ビルドは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。言語追加は [翻訳ガイド](./TRANSLATION.md) を参照してください。

[Weblate](https://hosted.weblate.org/engage/whispersubtranslate/) で翻訳に参加できます。翻訳文字列は [`locales/*.json`](../locales/) にあります。

## 貢献者

WhisperSubTranslate をより良くしてくれるすべての方に感謝します。

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/matbgn"><img src="https://github.com/matbgn.png?size=80" width="80" alt="matbgn" title="matbgn" /></a>

## 支援

このプロジェクトが時間の節約になったら、支援はバグ修正やモデルの安定化、新しい翻訳オプションの開発に直接役立ちます。

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## 謝辞

- whisper.cpp: Georgi Gerganov [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Hy-MT2: Tencent [Tencent-Hunyuan/Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## ライセンス

GPL-3.0。外部 API とサービス(DeepL, OpenAI, Gemini など)は各自の規約に従います。
