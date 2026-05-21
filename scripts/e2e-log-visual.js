'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { _electron: electron } = require('playwright');

(async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    timeout: 30000,
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', E2E_SMOKE: '1' },
  });
  const w = await app.firstWindow({ timeout: 30000 });
  await w.waitForLoadState('domcontentloaded');
  await w.waitForTimeout(1500);
  await w.evaluate(() => {
    const samples = [
      '대기열에서 제거됨: How to make MBR overwriting in Python.mkv',
      '대기열에서 제거됨: How To Make Your Own Port Forwarding VPN Service.mkv',
      '대기열에서 제거됨: Install your own AI Waifu Assistant.mkv',
      '대기열에서 제거됨: kali linux - how hackers gain access.mkv',
      '[3/24] 처리 중: Build a Simple Reverse Shell With Python.mp4',
      '번역 시작: 한국어 → English (DeepL)',
      '번역 진행: 12/45 · “Hello world, this is a test sentence to see…”',
      '번역 진행: 23/45 · “The quick brown fox jumps over the lazy dog.”',
      '완료: Build a Simple Reverse Shell With Python.mp4',
      '» 스킵: SRT 파일 (번역 설정 없음): test.srt',
      '[4/24] 처리 중: Can you know when someone opened your Email.mkv',
      '처리 중지 요청됨. 현재 파일 완료 후 중지됩니다.',
      '실패: corrupt.mp4 — invalid header',
      '사용자가 처리를 중지했습니다.',
      '완료: Can you know when someone opened your Email.mkv',
      '추가됨: new-file.mp4',
    ];
    for (const s of samples) window.__E2E_HOOK__.addOutput(s + '\n');
  });
  await w.waitForTimeout(500);
  await w.screenshot({ path: path.join(ROOT, 'log-preview.png'), fullPage: true });
  await app.close();
  console.log('saved log-preview.png');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
