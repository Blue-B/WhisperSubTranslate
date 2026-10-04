# Demo recording notes

The English README uses `assets/demo/demo-30s.mp4` / `.gif`. The Korean README uses `assets/demo/demo-30s.ko.mp4` / `.gif`.

Both videos show 30 seconds of real Electron application capture at normal speed, including the completed app waiting on screen. There are no added captions, overlays, title cards, result cards, or artificial progress animations. The GIF is reduced to 900px/8fps for README use. The MP4 retains 1280×900 resolution.

## Conditions

- v2.5.1 source at `ff0458a46d8babf26856853aee8592ada18f4b59`, with two local review fixes: persist GPU→CPU fallback diagnostics and classify a zero-failure extraction summary as success. These changes are a separate optional program patch; the README/demo-only patch does not modify application source.
- Linux CPU, no NVIDIA GPU. Speech recognition: whisper.cpp v1.9.1 with `tiny`; local translation: Hy-MT2 1.8B Q4_K_M, English → Korean, one worker.
- Models were downloaded and SHA-256 verified before recording. Download time is not shown.
- Input is a self-created 7.037-second synthetic-speech video: “Hello. Thank you for watching. Today we are learning something new. Have a wonderful day.” No private media or online translation service was used.
- Actual output: two English SRT cues and two Korean translated cues; files and the app's 100% completion state were verified.
- Playwright drives the real application controls. Only the file-picker response is supplied with the test-video path; transcription, translation, progress and output files are not mocked. Capture uses FFmpeg on an isolated virtual display.
- These clips demonstrate the workflow. They are not a general speed, GPU, or translation-quality benchmark. Results depend on the input, model, hardware and settings.

## 한국어

영어 README에는 영어 UI 영상을, 한국어 README에는 한국어 UI 영상을 연결했습니다. 두 영상 모두 실제 앱 화면을 정상 속도로 30초 녹화했으며, 완료 후 대기하는 화면도 그대로 포함합니다. 별도 캡션·오버레이·타이틀·결과 카드·가짜 진행률은 없습니다.

Linux CPU에서 `tiny` 음성 모델과 Hy-MT2 1.8B 번역 모델을 사용했습니다. 모델은 촬영 전에 다운로드하고 SHA-256을 검증했으므로 다운로드 시간은 영상에 포함되지 않습니다. 자체 제작한 7.037초 음성 영상을 실제로 영어 SRT와 한국어 SRT로 변환하고 파일과 100% 완료 상태를 확인했습니다.

녹화에 사용한 검토용 앱에는 GPU→CPU 전환 로그 보완과 실패 0건의 성공 표시 수정 두 가지가 들어 있습니다. 프로그램 수정은 별도 선택 패치에 있으며, 문서/데모 전용 패치는 앱 소스를 바꾸지 않습니다. 영상은 사용 흐름을 보여주는 예시로, GPU 성능이나 일반적인 번역 속도·품질을 보장하는 자료가 아닙니다.
