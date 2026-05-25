#!/usr/bin/env node
/**
 * release-notes.js - Build the GitHub Release body for a given version.
 *
 * Resolution order:
 *   1. release-notes/v<version>.md  (hand-authored, multilingual; used verbatim)
 *   2. CHANGELOG.md "## [<version>]" section  (English fallback, auto-wrapped)
 *
 * Usage:
 *   node scripts/release-notes.js v2.0.1     # or: 2.0.1
 *   RELEASE_VERSION=v2.0.1 node scripts/release-notes.js
 *
 * Writes RELEASE_BODY.md at repo root and prints the resolved source to stderr.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const raw = (process.argv[2] || process.env.RELEASE_VERSION || '').trim();
if (!raw) {
  console.error('Usage: node scripts/release-notes.js <version|vX.Y.Z>');
  process.exit(1);
}

const version = raw.replace(/^v/, ''); // 2.0.1
const vtag = `v${version}`;
const root = path.join(__dirname, '..');
const assetName = `WhisperSubTranslate-${vtag}-win-x64.zip`;

let body;
const notesFile = path.join(root, 'release-notes', `${vtag}.md`);

if (fs.existsSync(notesFile)) {
  body = fs.readFileSync(notesFile, 'utf8').trim();
  console.error(`[release-notes] using hand-authored notes: release-notes/${vtag}.md`);
} else {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    console.error('[release-notes] CHANGELOG.md not found and no release-notes file present.');
    process.exit(2);
  }
  const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');
  // Match e.g. "## [2.0.1] - 2026-05-25" (any dash style after the bracket).
  const startRe = new RegExp('^##\\s*\\[' + version.replace(/\./g, '\\.') + '\\]');
  const start = lines.findIndex((l) => startRe.test(l));
  if (start === -1) {
    console.error(`[release-notes] No CHANGELOG.md section for [${version}].`);
    process.exit(3);
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const section = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();

  body = [
    `## What's changed in ${vtag}`,
    '',
    section,
    '',
    '---',
    '',
    `**Download (Windows portable):** \`${assetName}\` — unzip and run \`WhisperSubTranslate.exe\`.`,
    '',
    `_For richer multilingual notes, add \`release-notes/${vtag}.md\` and it will be used verbatim._`,
  ].join('\n');
  console.error(`[release-notes] built from CHANGELOG.md section [${version}]`);
}

const out = path.join(root, 'RELEASE_BODY.md');
fs.writeFileSync(out, body + '\n', 'utf8');
console.error(`[release-notes] wrote ${out} (${body.length} chars)`);
