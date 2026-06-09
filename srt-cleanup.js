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

module.exports = { applySrtCleanup, isSdhOnlyText };
