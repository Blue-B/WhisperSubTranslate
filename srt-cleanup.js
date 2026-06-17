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

// A cue counts as SDH-only when, after removing every complete (...) / [...] group
// and music notes from both ends, NOTHING but separators remains. This keeps mixed
// lines like "(grunting) Help me! (groans)" (real dialogue survives) while dropping
// pure sound-description cues like "[music playing]", "(applause)", "♪♪".
function isSdhOnlyText(textLines) {
  let s = textLines.join(' ').trim();
  if (!s) return false;

  // Pure music notes: ♪ ♫ ♬ ♩
  if (/^[♪♫♬♩\s]+$/.test(s)) return true;

  // Iteratively peel complete bracketed/parenthesized groups + note runs off both
  // ends. [^()] / [^\[\]] keep the match to a SINGLE balanced group so that text
  // sandwiched between two sound tags is never swallowed.
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^\s*\([^()]*\)\s*/, '') // leading (...)
      .replace(/\s*\([^()]*\)\s*$/, '') // trailing (...)
      .replace(/^\s*\[[^[\]]*\]\s*/, '') // leading [...]
      .replace(/\s*\[[^[\]]*\]\s*$/, '') // trailing [...]
      .replace(/^[♪♫♬♩\s]+/, '') // leading notes
      .replace(/[♪♫♬♩\s]+$/, '') // trailing notes
      .trim();
  } while (s !== prev);

  return s === '';
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
  let sawAnyCue = false;

  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;

    const lines = rawBlock.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue; // not a recognizable cue block

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

  const rebuilt = outCues
    .map((c, i) => `${i + 1}\n${c.timeLine}\n${c.textLines.join('\n')}`)
    .join('\n\n');

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

module.exports = { applySrtCleanup, isSdhOnlyText, wrapCuesForDisplay, wrapTextToLines };
