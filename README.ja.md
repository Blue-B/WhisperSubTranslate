# WhisperSubTranslate

[English](./README.md) | [한국어](./README.ko.md) | 日本語 | [中文](./README.zh.md) | [Polski](./README.pl.md)

動画の音声を文字起こし（SRT）し、希望の言語に翻訳する Windows デスクトップアプリ。抽出は whisper.cpp で高速かつ安定して処理され、翻訳は MyMemory（無料）/DeepL/GPT-5-nano（OpenAI）/Geminiを選択できます。

> 重要: 本アプリは whisper.cpp で動画の音声から新規に SRT 字幕を生成します。既存の埋め込み字幕トラックや画面上の文字（OCR）を抽出するツールではありません。

## プレビュー

![メイン UI](docs/preview_ja.png)

## なぜ WhisperSubTranslate なのか

字幕抽出は100%ローカル処理。動画はPCの外へ出ません。アカウントもクレジットカードも不要。精度の高いSRTをオフラインで作成し、翻訳にはインターネット接続が必要（無料MyMemory もしくは自分の DeepL/OpenAI キー）。

### 価値の要点

| 課題 | 得られる価値 |
| --- | --- |
| プライバシーと制御 | 100%ローカルSTT、クラウドアップロードなし |
| ゼロサインアップ | アカウント/カード/個人情報 不要 |
| 利用制限なし | アプリ側の日/月制限なし |
| 外国語動画の理解 | 抽出+翻訳 SRT を一度に生成 |
| セットアップの手間 | モデル自動DL、Python不要 |
| フィードバック | キュー、滑らかな進捗、ETA |

> 注意：オンライン翻訳エンジン利用時は提供者側クォータ（例：MyMemory）が適用される場合があります。アプリ自体は上限を設けません。

## はじめに

### 一般ユーザー: ポータブル版で実行

- Releases から最新のポータブルアーカイブをダウンロード：`WhisperSubTranslate-v1.3.2-win-x64.zip`
- 展開後のフォルダで `WhisperSubTranslate.exe` を実行

すぐに使えます。抽出はPCで完全オフラインで実行されます。翻訳はオプション（無料MyMemoryがデフォルト、DeepL/OpenAIは自分のAPIキーが必要）。

### 開発者: ソースから実行

```bash
npm install
npm start
```
- **whisper-cpp**は`npm install`時に自動ダウンロードされます（~700MB CUDA版）
- **FFmpeg**はnpmパッケージで自動的に含まれます
- 初回は、選択したGGMLモデルが無ければ `_models/` に自動ダウンロードします

> 自動ダウンロード失敗時は、[whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases)から手動でダウンロードし、`whisper-cpp/`フォルダに展開してください。

### Windows 用ビルド
```bash
npm run build-win
```
成果物は `dist2/` に出力されます。

## 技術スタック

[![Electron](https://img.shields.io/badge/Electron-2C2E3B?style=for-the-badge&logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/) [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![DeepL](https://img.shields.io/badge/DeepL_API-0F2B46?style=for-the-badge&logo=deepl&logoColor=white)](https://www.deepl.com/ja/pro-api) [![OpenAI](https://img.shields.io/badge/OpenAI_API-412991?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)

| 項目 | 詳細 |
| --- | --- |
| ランタイム | Electron, Node.js, JavaScript |
| パッケージング | electron-builder |
| ネットワーク | axios |
| 音声→テキスト | whisper.cpp (GGMLモデル) |
| 翻訳（任意） | DeepL API, OpenAI（GPT-5-nano）, Gemini, MyMemory |

## 翻訳エンジン

| エンジン | コスト | API キー | 制限 / 備考 |
| --- | --- | --- | --- |
| MyMemory | 無料 | 不要 | 1 IP あたり約 5万/日 |
| DeepL | 月 50万無料 | 必要 | 有料プランあり |
| GPT-5-nano（OpenAI） | 有料 | 必要 | 入力 $0.05 / 出力 $0.40 per 1M トークン |
| Gemini 3 Flash | 無料/有料 | 必要 | 無料: 1日250字幕/20-30分、有料: 無制限 ([APIキー取得](https://aistudio.google.com/app/apikey)) |

APIキーと設定は、ユーザーPCの `app.getPath('userData')` パスに基本的なエンコーディングを適用して保存されます。ファイルエクスプローラーで誤って開いても平文で表示されないように保護され、Gitや配布ファイルには一切含まれません。

### データ保存場所

| データ | 場所 |
| --- | --- |
| 設定 & API キー | `%APPDATA%\whispersubtranslate\translation-config-encrypted.json` |
| エラーログ | `%APPDATA%\whispersubtranslate\logs\translation-errors.log` |
| モデル | `_models/`（アプリフォルダ内） |

## 言語サポート

### UI 言語
韓国語、英語、日本語、中国語、ポーランド語（5言語）

### 翻訳対象言語（14言語）
韓国語 (ko)、英語 (en)、日本語 (ja)、中国語 (zh)、スペイン語 (es)、フランス語 (fr)、ドイツ語 (de)、イタリア語 (it)、ポルトガル語 (pt)、ロシア語 (ru)、ハンガリー語 (hu)、アラビア語 (ar)、ポーランド語 (pl)、**ペルシア語 (fa)**

### 音声認識言語
whisper.cppは100以上の言語をサポートしています（英語、スペイン語、フランス語、ドイツ語、イタリア語、ポルトガル語、ロシア語、中国語、日本語、韓国語、アラビア語、ヒンディー語、トルコ語など主要な世界言語を含む）。

## モデルとパフォーマンス

モデルは `_models/` に保存され、必要に応じて自動ダウンロードされます。大きいモデルほど遅いですが、より正確になる可能性があります。CUDA対応時はGPU、そうでなければCPUで動作します。

| モデル | サイズ | VRAM | 速度 | 品質 |
| --- | --- | --- | --- | --- |
| tiny | ~75MB | ~1GB | 最速 | 基本 |
| base | ~142MB | ~1GB | 速い | 良好 |
| small | ~466MB | ~2GB | 中程度 | より良い |
| medium | ~1.5GB | ~4GB | 遅い | 素晴らしい |
| large-v3 | ~3GB | ~5GB | 最も遅い | 最高 |
| large-v3-turbo ⭐ | ~809MB | ~4GB | 速い | 優秀 |

> 注：VRAM要件は[whisper.cpp](https://github.com/ggerganov/whisper.cpp)のGGML最適化基準であり、PyTorch Whisper（large約10GB）よりも大幅に低いです。テスト済み：6GB VRAM GPUでlarge-v3動作確認。

## ブランチ（シンプル Trunk）

Trunk-based development：単一の `main` を幹として保ち、短命ブランチで作業して PR で素早くマージします。

| ブランチ | 目的 | ルール |
| --- | --- | --- |
| main | 常にリリース可能 | `v1.0.0` などタグ付け |
| feature/* | 小さく集中した作業 | `main` から分岐し、PR で `main` にマージ |

## コントリビュート

> **新しい言語を追加しますか？** [翻訳ガイド](TRANSLATION.md)をご覧ください。

### 1) ブランチ/命名

あらゆる変更（機能／修正／文書）は 1 種類に統一します。

| パターン | 用途 |
| --- | --- |
| `feature/<scope>-<desc>` | すべての変更 |

推奨する <scope> 例：i18n, ui, translation, whisper, model, download, queue, progress, ipc, main, renderer, updater, config, build, logging, perf, docs, readme

例：
```text
feature/i18n-api-modal
feature/ui-progress-smoothing
feature/translation-deepl-test
feature/main-disable-devtools
```

### 2) コミット規約（Conventional Commits）
`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `build:` を使用します。

```text
feat: add DeepL connection test
fix: localize target language note
```

### 3) コード方針（I18N）

| トピック | ガイドライン |
| --- | --- |
| I18N | UI/ログ文字列をコードに直書きせず、I18N テーブルのキー参照で使用 |
| UX | 進捗/ETA/キューの一貫性維持、リグレッション防止 |
| スコープ | 小さな変更単位、明確な関数名 |
| 多言語 UI | UI 追加時は ko/en/ja/zh/pl を同時更新 |

### 4) 手動テスト・チェックリスト

| シナリオ | 確認事項 |
| --- | --- |
| 抽出のみ | 開始/停止、進捗/ETA の挙動 |
| 抽出+翻訳 | E2E 結果と最終 SRT 名称 |
| モデルダウンロード | 未所持時の自動 DL、途中キャンセル/停止 |
| I18N 切替 | 対象言語ラベル/モーダル文言が即時更新 |
| 翻訳エンジン | MyMemory（無キー）、DeepL/OpenAI（キー有り） |
| ビルド | `npm run build-win` 完了 |

### 5) PR チェックリスト

| 項目 | 期待 |
| --- | --- |
| 説明 | 変更内容を明確に記載 |
| UI 影響 | 視覚的変更のスクリーンショット |
| テスト | 再現/検証手順 |
| アセット | 大容量バイナリ禁止、スクショは `docs/` |

## 支援

このプロジェクトが時間短縮やより良い字幕作成に役立つなら、支援は開発スピードを直接高めます。
- 使途：バグ修正、モデルDLの安定化、UI磨き、翻訳オプション拡充、Windowsビルド/テスト
- 透明性：データ販売なし。支援金は開発時間、リリース用インフラ、翻訳APIテスト費用にのみ使用します。
- 一度の支援でも README/リリースノートのスポンサー欄にお名前を掲載（非公開希望可）。
- 月額支援（$3/mo, GitHub Sponsors自動課金）は "Sponsor Request" イシューの優先トリアージ（ベストエフォート）を追加特典として付与。

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/One‑time_$3-Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h)

## 謝辞

- whisper.cppはGeorgi Gerganovによって開発されました： [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- FFmpeg: [ffmpeg.org](https://ffmpeg.org/)

## ライセンス

GPL-3.0。外部サービス（DeepL, OpenAI など）の規約に従ってください。
