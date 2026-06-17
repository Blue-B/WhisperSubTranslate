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

// ── Long-cue duration splitting ──────────────────────────────────────────
// 긴 문장(자연 문장 단위 전사)은 한 큐가 화면에 오래(8초+) 머문다. maxDurationSec를 넘기는
// 큐는 글자량 비례로 시간을 나눠 여러 큐로 쪼개다(많이 말한 부분 = 더 긴 시간). 완벽한
// 단어 타임스탬프는 아니지만(균일 발화속도 가정), "짧게 말하면 짧게 / 길게 말하면 길게"
// 의 근사값으로 충분하다. 번역 출력(사용자가 보는 _ko.srt)에만 적용 — 원본은 번역기가
// 완결 문장으로 읽어야 하므로 쪼개지 않는다.
function _srtTimeToMs(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
  if (!m) return null;
  return +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + +m[4];
}
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
// 한 큐 텍스트를 n조각으로 나눔 (단어 경계 우선, 글자수 균등)
function _splitTextParts(text, n) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (n <= 1 || !t) return t ? [t] : [];
  const target = t.length / n;
  const parts = [];
  if (/\s/.test(t)) {
    let cur = '';
    for (const w of t.split(' ')) {
      if (cur && cur.length + 1 + w.length > target && parts.length < n - 1) {
        parts.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) parts.push(cur);
  } else {
    const size = Math.ceil(t.length / n);
    for (let i = 0; i < t.length; i += size) parts.push(t.slice(i, i + size));
  }
  return parts.filter(Boolean);
}

/**
 * 긴 큐를 maxDurationSec 이하로 시간 비례 분할 + 각 큐 줄바꿈.
 * @param {string} srtText
 * @param {{maxDurationSec?: number, maxLineLen?: number}} [opts]
 */
function splitLongCues(srtText, opts = {}) {
  const maxDurMs = (opts.maxDurationSec || 6) * 1000;
  const maxLineLen = opts.maxLineLen || 42;
  if (typeof srtText !== 'string' || !srtText.trim()) return srtText;

  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n[ \t]*\n/);
  const cues = [];
  let sawAnyCue = false;

  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;
    const lines = rawBlock.split('\n');
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) {
      cues.push({ raw: rawBlock });
      continue;
    }
    sawAnyCue = true;
    const tm = /(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/.exec(lines[tsIdx]);
    const text = lines
      .slice(tsIdx + 1)
      .join(' ')
      .trim();
    const startMs = tm ? _srtTimeToMs(tm[1]) : null;
    const endMs = tm ? _srtTimeToMs(tm[2]) : null;
    if (startMs == null || endMs == null || !text) {
      cues.push({ rawLine: lines[tsIdx].trim(), text });
      continue;
    }
    const dur = endMs - startMs;
    if (dur <= maxDurMs || text.length < 2) {
      cues.push({ startMs, endMs, text });
      continue;
    }
    // 분할 수: 시간 기준(약간 여유)과 텍스트 길이 기준(큐당 ≈2줄) 중 큰 쪽.
    // 글자량 비례로 시간을 나눠서 텍스트가 많은 큐가 시간을 더 먹어도 상한을 크게 벗어나지 않게.
    const n = Math.max(Math.ceil(dur / (maxDurMs * 0.9)), Math.ceil(text.length / (maxLineLen * 2)));
    const parts = _splitTextParts(text, n);
    const totalChars = parts.reduce((a, p) => a + p.length, 0) || 1;
    let cursor = startMs;
    parts.forEach((p, i) => {
      const e = i === parts.length - 1 ? endMs : cursor + (p.length / totalChars) * dur;
      cues.push({ startMs: cursor, endMs: e, text: p });
      cursor = e;
    });
  }

  if (!sawAnyCue) return srtText;

  let idx = 0;
  const rebuilt = cues
    .map((c) => {
      if (c.raw != null) return c.raw;
      idx++;
      const wrapped = wrapTextToLines(c.text || '', maxLineLen).join('\n');
      const time = c.startMs != null ? `${_msToSrtTime(c.startMs)} --> ${_msToSrtTime(c.endMs)}` : c.rawLine || '';
      return `${idx}\n${time}\n${wrapped}`;
    })
    .join('\n\n');
  return rebuilt + '\n';
}

module.exports = { applySrtCleanup, isSdhOnlyText, wrapCuesForDisplay, wrapTextToLines, splitLongCues };
