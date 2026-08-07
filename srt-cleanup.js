'use strict';

/**
 * srt-cleanup.js — Post-processing for extracted SRT subtitles.
 *
 * Pure (no Electron / no fs) so it can be unit-tested directly with node.
 * Two opt-in cleanup operations, both off by default:
 *
 *   1. removeSpeakerTags — strip leading speaker-change markers ("&gt;&gt;", "&gt;&gt;&gt;")
 *      that Whisper emits when it thinks the speaker changed.
 *
 *   2. removeSDH (A안 / conservative) — drop a cue ONLY when its entire text is a
 *      sound/hearing-impaired description, e.g. [music playing], (applause), ♪♪.
 *      Mixed lines like "(sighs) I can't believe it" are kept untouched.
 *      Cue numbers are renumbered after any deletion.
 *
 * Both are opt-in because the app intentionally translates real words inside
 * brackets/parentheses (see translator-enhanced.js isNonDialogue). Turning SDH
 * removal on is an explicit "I want sound descriptions gone" choice.
 */

// SDH(청각장애인용 자막) 키워드 화이트리스트. 이 키워드가 완전히 괄호로 감싸인
// "[music playing]", "(applause)" 같은 큐만 SDH로 보고 삭제한다.
// 괄호 안에 실제 대사((와!), (笑) 등)가 있으면 보존한다.
const SDH_KEYWORDS = [
  // 음악/효과음
  'music',
  'song',
  'melody',
  'theme',
  'jingle',
  'applause',
  'clapping',
  'clap',
  'cheering',
  'cheer',
  'laughter',
  'laugh',
  'laughing',
  'chuckles',
  'chuckling',
  'giggling',
  'giggles',
  'sobbing',
  'sob',
  'crying',
  'cries',
  'sigh',
  'sighs',
  'sighing',
  'groan',
  'groans',
  'groaning',
  'grunt',
  'grunts',
  'gasp',
  'gasps',
  'gasping',
  'scream',
  'screaming',
  'screams',
  'yell',
  'yelling',
  'shout',
  'shouting',
  'whisper',
  'whispering',
  'humming',
  'hums',
  'whistling',
  'whistles',
  'cough',
  'coughs',
  'coughing',
  'sneeze',
  'sneezes',
  'sneezing',
  'hiccup',
  'hiccups',
  'yawn',
  'yawns',
  'yawning',
  'sniffle',
  'sniffles',
  // 소리/효과
  'knock',
  'knocking',
  'doorbell',
  'ring',
  'ringing',
  'phone',
  'beep',
  'beeps',
  'beeping',
  'buzzer',
  'buzz',
  'alarm',
  'siren',
  'horn',
  'honk',
  'honking',
  'engine',
  'motor',
  'crash',
  'crashing',
  'boom',
  'explosion',
  'explosions',
  'thunder',
  'rain',
  'wind',
  'whoosh',
  'whooshing',
  'splash',
  'splashing',
  'water',
  'birds',
  'bird',
  'chirping',
  'chirps',
  'barking',
  'barks',
  'meow',
  'meowing',
  'roar',
  'roaring',
  'growl',
  'growling',
  'howl',
  'howling',
  'footsteps',
  'footstep',
  'steps',
  'static',
  'radio',
  'tv',
  'television',
  'crowd',
  'audience',
  'noise',
  'sound',
  'sounds',
  'sfx',
  'phone ringing',
  'doorbell rings',
  'music playing',
  'upbeat music',
  'dramatic music',
  'sad music',
  'soft music',
  'loud music',
  'rock music',
  'jazz music',
  'classical music',
  // 한국어 SDH
  '음악',
  '박수',
  '웃음',
  '환호',
  '노래',
  '효과음',
  '문소리',
  '노크',
  '벨',
  '종소리',
  '기침',
  '한숨',
  '비명',
  '발소리',
  '울음',
  '휘파람',
  '경적',
  '엔진',
  '천둥',
  '빗소리',
  '바람',
  '물소리',
  '새소리',
  '짖음',
  '고양이',
  '라디오',
  '티비',
  '방송',
  '소음',
  '소리',
  // 일본어 SDH
  '音楽',
  '拍手',
  '笑い',
  '泣き',
  'ため息',
  '咳',
  'くしゃみ',
  '悲鳴',
  '足音',
  'ベル',
  'ノック',
  '犬',
  '猫',
  '鳥',
  '雨',
  '風',
  '雷',
  '効果音',
  '音',
  '音楽が流れる',
];
// 유니코드 인식 단어 경계: \b 는 \w(ASCII) 기준이라 CJK 키워드(음악, 音楽 등)에선
// 경계가 성립하지 않아 매치가 불가능하다. 양쪽이 글자/숫자가 아닐 때만 매치한다.
const UNICODE_WORD_BOUNDARY = '(?<![\\p{L}\\p{N}])';
const SDH_KEYWORD_RE = new RegExp(
  `${UNICODE_WORD_BOUNDARY}(${SDH_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`,
  'iu'
);

// A cue counts as SDH-only when EVERY line is fully enclosed in a single bracket/paren
// group (no nested/unclosed brackets, no trailing text) AND the inner content matches
// the SDH keyword whitelist (or is pure notation like ♪♫). Mixed lines like
// "(grunting) Help me! (groans)" contain unclosed brackets + text, so they're kept.
function isSdhOnlyText(textLines) {
  const lines = textLines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;

  // Pure music notes: ♪ ♫ ♬ ♩ — 괄호 안이든 밖이든 기호뿐이면 SDH
  // (기호만 있는 줄은 번역 대상 대사가 아니므로 안전하게 제거한다)
  if (lines.every((l) => /^[♪♫♬♩]+$/.test(l.replace(/[\[\]()\s]/g, '')))) return true;

  // 모든 줄이 "여는 괄호 + 괄호 없는 내용 + 닫는 괄호"의 단일 그룹이어야 한다.
  // (grunting) Help me! (groans) 처럼 괄호 밖 텍스트/중첩 괄호가 있으면 대사로 본다.
  const innerParts = [];
  for (const l of lines) {
    const m = /^[\[\(]([^()\[\]]+)[\]\)]$/.exec(l);
    if (!m) return false;
    innerParts.push(m[1]);
  }

  // 내부 내용 전부가 SDH 키워드 화이트리스트와 매치돼야 SDH.
  // (와!), (笑) 같은 실제 대사 괄호는 키워드에 없으므로 보존된다.
  return innerParts.every((part) => SDH_KEYWORD_RE.test(part));
}

/**
 * @param {string} srtText  raw SRT file content
 * @param {{removeSpeakerTags?: boolean, removeSDH?: boolean}} [opts]
 * @returns {string} cleaned SRT (or the original text when nothing applies)
 */
function applySrtCleanup(srtText, opts = {}) {
  const removeSpeakerTags = !!opts.removeSpeakerTags;
  const removeSDH = !!opts.removeSDH;

  if (typeof srtText !== 'string' || (!removeSpeakerTags && !removeSDH)) {
    return srtText;
  }

  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n[ \t]*\n/);

  const outCues = [];
  const outNonCueBlocks = []; // 헤더/푸터 등 비큐 블록은 원본 그대로 보존
  let sawAnyCue = false;

  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;

    const lines = rawBlock.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) {
      // 큐가 아닌 블록(예: "WEBVTT" 헤더, 파일 푸터)은 삭제하지 않고 보존
      outNonCueBlocks.push(rawBlock);
      continue;
    }
    sawAnyCue = true;
    const timeLine = lines[tsIdx].trim();
    let textLines = lines.slice(tsIdx + 1);

    if (removeSpeakerTags) {
      // strip leading ">>" / ">>>" (optionally after a leading "- ")
      textLines = textLines.map((l) => l.replace(/^(\s*-\s*)?>{2,}\s*/, ''));
    }

    // drop trailing blank lines introduced by stripping
    while (textLines.length && textLines[textLines.length - 1].trim() === '') {
      textLines.pop();
    }

    // a cue with no remaining text (e.g. a lone ">>") is dropped
    if (textLines.every((l) => l.trim() === '')) {
      continue;
    }

    if (removeSDH && isSdhOnlyText(textLines)) {
      continue; // A안: drop the whole SDH-only cue
    }

    outCues.push({ timeLine, textLines });
  }

  // If we couldn't parse a single cue, never destroy the file — return as-is.
  if (!sawAnyCue) return srtText;

  // 비큐 블록(헤더/푸터)은 원본 그대로, 큐는 재번호를 매겨 재조립한다.
  const rebuiltBlocks = [];
  let cueIdx = 0;
  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;
    const lines = rawBlock.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) {
      rebuiltBlocks.push(rawBlock);
      continue;
    }
    const kept = outCues[cueIdx];
    if (!kept) continue;
    cueIdx++;
    rebuiltBlocks.push(`${cueIdx}\n${kept.timeLine}\n${kept.textLines.join('\n')}`);
  }

  const rebuilt = rebuiltBlocks.join('\n\n');

  return rebuilt ? rebuilt + '\n' : '';
}

// ── Display line wrapping ─────────────────────────────────────────────────
// naturalSegmentation 전사는 절·문장 단위의 긴 세그먼트를 만든다(번역 품질↑).
// 단점은 화면에 한 줄이 너무 길게 나오는 것. wrapCuesForDisplay는 큐(번호+
// 타임스탬프) 구조와 텍스트 내용은 그대로 두고, 각 큐의 텍스트만 가독성 있는
// 길이로 여러 줄로 감싼다. 텍스트를 삭제하지 않으며, SRT 파싱 실패 시 원본을
// 그대로 반환한다(파일 파괴 방지). 번역 단계는 큐 단위(완결 문장)를 읽으므로
// 이 줄바꿈이 번역 품질에 영향을 주지 않는다.
function wrapTextToLines(text, maxLen) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];

  const lines = [];
  if (/\s/.test(t)) {
    // 단어 경계 기준 줄바꿈 (라틴/혼합 텍스트)
    let cur = '';
    for (const word of t.split(' ')) {
      if (cur === '') {
        cur = word;
      } else if ((cur + ' ' + word).length <= maxLen) {
        cur += ' ' + word;
      } else {
        lines.push(cur);
        cur = word;
      }
      // maxLen보다 긴 단일 단어(URL 등)는 강제 분할
      while (cur.length > maxLen) {
        lines.push(cur.slice(0, maxLen));
        cur = cur.slice(maxLen);
      }
    }
    if (cur) lines.push(cur);
  } else {
    // 공백 없는 텍스트(CJK 등)는 글자 수로 강제 분할
    for (let k = 0; k < t.length; k += maxLen) lines.push(t.slice(k, k + maxLen));
  }
  return lines;
}

/**
 * @param {string} srtText  raw SRT file content
 * @param {{maxLineLen?: number}} [opts]  maxLineLen 기본 42자(자막 표준)
 * @returns {string} 줄바꿈이 적용된 SRT (파싱 실패 시 원본)
 */
function wrapCuesForDisplay(srtText, opts = {}) {
  const maxLineLen = opts.maxLineLen || 42;
  if (typeof srtText !== 'string' || !srtText.trim()) return srtText;

  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n[ \t]*\n/);

  const out = [];
  let sawAnyCue = false;

  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;
    const lines = rawBlock.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) {
      out.push(rawBlock); // 큐가 아니면 그대로 보존
      continue;
    }
    sawAnyCue = true;
    const head = lines.slice(0, tsIdx + 1); // 번호 + 타임스탬프 줄
    const joined = lines
      .slice(tsIdx + 1)
      .join(' ')
      .trim();
    if (!joined) {
      out.push(head.join('\n'));
      continue;
    }
    out.push(head.concat(wrapTextToLines(joined, maxLineLen)).join('\n'));
  }

  // 단 하나의 큐도 파싱 못 했으면 절대 원본을 망가뜨리지 않는다.
  if (!sawAnyCue) return srtText;
  return out.join('\n\n') + '\n';
}

// ── Long-cue duration splitting ──────────────────────────────────────────
// 긴 문장(자연 문장 단위 전사)은 한 큐가 화면에 오래(8초+) 머문다. maxDurationSec를 넘기는
// 큐는 글자량 비례로 시간을 나눠 여러 큐로 쪼개다(많이 말한 부분 = 더 긴 시간). 완벽한
// 단어 타임스탬프는 아니지만(균일 발화속도 가정), "짧게 말하면 짧게 / 길게 말하면 길게"
// 의 근사값으로 충분하다. 번역 출력(사용자가 보는 _ko.srt)에만 적용 — 원본은 번역기가
// 완결 문장으로 읽어야 하므로 쪼개지 않는다.
function _msToSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const mn = Math.floor(ms / 60000);
  ms -= mn * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(mn)}:${p(s)},${p(ms, 3)}`;
}

// ── Whisper JSON (-ojf) → speech-tight SRT ───────────────────────────────
// 문제: whisper.cpp를 VAD와 함께 돌리면, 무음을 빼고 전사한 뒤 타임라인에 되매핑하는
// 과정에서 무음 경계에 걸친 세그먼트의 끝 시각이 그 빈 구간만큼 늘어난다(예: "ありがとう"
// 59.85s→87.26s = 27초). 그래서 짧은 한 마디가 수십 초 화면에 박혀 있고 싱크가 안 맞는다.
//
// 주의: -ojf JSON의 토큰 offsets는 VAD 압축 타임라인(세그먼트 내부/누적)이라 원본 시각으로
// 복원 불가능하다(실측: 1초짜리 세그먼트 토큰이 15s를 가리킴). 원본 시각으로 믿을 수 있는
// 건 세그먼트 from/to뿐이고, 그건 정확하도(41.37s≈SDH) 늘어난 것만 문제다.
//
// 해결: 세그먼트 시작(정확)은 그대로 쓰고, 길이만 텍스트 분량에 비례한 상한으로 캅한다.
// 일반 대사는 원본 길이 그대로(공식 자막과 일치), 늘어진 것만 자연스러운 읽기 시간으로 줄어들어
// 말할 때만 뜨고 무음엔 사라진다(영화 자막처럼).
function _displayMsForText(text, perCharMs, minMs, maxMs) {
  const n = String(text).replace(/\s/g, '').length;
  return Math.max(minMs, Math.min(maxMs, n * perCharMs));
}

/**
 * whisper.cpp -ojf JSON을 받아, 세그먼트 시각 기반 SRT를 만들되 늘어진 큐는 텍스트 분량에 맞게 캅한다.
 * @param {string} jsonText  whisper -ojf 출력 (outputBase.json)
 * @param {{perCharMs?:number, minDisplayMs?:number, maxDisplayMs?:number}} [opts]
 * @returns {string|null} SRT. 파싱 실패/형식 불일치면 null (호출측이 -osrt로 폴백).
 */
function srtFromWhisperJson(jsonText, opts = {}) {
  const perCharMs = opts.perCharMs != null ? opts.perCharMs : 350; // 글자당 표시 시간(읽혀을 여유)
  const minDisplayMs = opts.minDisplayMs != null ? opts.minDisplayMs : 1200; // 최소 표시
  const maxDisplayMs = opts.maxDisplayMs != null ? opts.maxDisplayMs : 7000; // 최대 표시(이상은 늘어짐으로 판단)
  if (typeof jsonText !== 'string' || !jsonText.trim()) return null;

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (_e) {
    return null;
  }
  const segs = data && Array.isArray(data.transcription) ? data.transcription : null;
  if (!segs || !segs.length) return null;

  const cues = [];
  for (const s of segs) {
    const text = String((s && s.text) || '').trim();
    if (!text) continue;
    const o = (s && s.offsets) || {};
    const start = typeof o.from === 'number' ? o.from : null;
    const segEnd = typeof o.to === 'number' ? o.to : null;
    if (start == null || segEnd == null || segEnd <= start) continue;

    // 세그먼트 길이가 텍스트가 자연스럽게 차지할 시간보다 길면(=늘어진 것) 그만큼만 보여준다.
    const natural = _displayMsForText(text, perCharMs, minDisplayMs, maxDisplayMs);
    let end = Math.min(segEnd, start + natural);
    if (end <= start) end = start + minDisplayMs;
    cues.push({ start, end, text });
  }
  if (!cues.length) return null;

  // 다음 큐 시작을 침범하지 않도록 끝을 당김(겹침 방지)
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 1; // 0 길이 방지
  }

  let idx = 0;
  return (
    cues
      .map((c) => {
        idx++;
        return `${idx}\n${_msToSrtTime(c.start)} --> ${_msToSrtTime(c.end)}\n${c.text}`;
      })
      .join('\n\n') + '\n'
  );
}

module.exports = {
  applySrtCleanup,
  isSdhOnlyText,
  wrapCuesForDisplay,
  srtFromWhisperJson,
};
