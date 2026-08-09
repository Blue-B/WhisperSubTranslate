#!/usr/bin/env node
/**
 * virustotal-check.js - Look up (and if needed upload) binaries on VirusTotal
 * and fail when Microsoft/Defender flags any of them.
 *
 * Usage:
 *   VIRUSTOTAL_API_KEY=... node scripts/virustotal-check.js <file> [file...]
 *
 * Behavior:
 *   - No VIRUSTOTAL_API_KEY: prints SKIP and exits 0 (the check is optional).
 *   - Known hash: uses the existing report.
 *   - Unknown hash and file <= 32 MB: uploads it and polls until analyzed.
 *   - Unknown hash and file > 32 MB: reported as UNSCANNED (warning only).
 *   - Exit 1 only when Microsoft detects a file — that is the engine our
 *     Windows user base runs by default. Other engines' hits are warnings
 *     (MaxSecure-style noise would otherwise block every release).
 *
 * Free-tier rate limit is 4 requests/min, so polls are spaced 30s apart.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const API_KEY = process.env.VIRUSTOTAL_API_KEY;
const UPLOAD_LIMIT = 32 * 1024 * 1024;
const POLL_INTERVAL_MS = 30 * 1000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function api(pathname) {
  return request({
    hostname: 'www.virustotal.com',
    path: pathname,
    method: 'GET',
    headers: { 'x-apikey': API_KEY },
  });
}

async function uploadFile(filePath) {
  const boundary = '----vtcheck' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fs.readFileSync(filePath), tail]);
  const res = await request(
    {
      hostname: 'www.virustotal.com',
      path: '/api/v3/files',
      method: 'POST',
      headers: {
        'x-apikey': API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    },
    body
  );
  if (res.status !== 200) throw new Error(`upload failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).data.id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForAnalysis(analysisId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await api(`/api/v3/analyses/${analysisId}`);
    if (res.status === 200 && JSON.parse(res.body).data.attributes.status === 'completed') return true;
  }
  return false;
}

function summarize(report) {
  const attrs = report.data.attributes;
  const stats = attrs.last_analysis_stats || {};
  const detections = Object.entries(attrs.last_analysis_results || {})
    .filter(([, r]) => r.category === 'malicious' || r.category === 'suspicious')
    .map(([engine, r]) => `${engine}:${r.result}`);
  return { malicious: (stats.malicious || 0) + (stats.suspicious || 0), detections };
}

async function checkFile(filePath) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const name = path.basename(filePath);
  let res = await api(`/api/v3/files/${sha256}`);

  if (res.status === 404) {
    const size = fs.statSync(filePath).size;
    if (size > UPLOAD_LIMIT) {
      console.log(`[VT] ${name}: UNSCANNED (unknown hash, ${(size / 1e6).toFixed(0)} MB exceeds upload limit)`);
      return { name, unscanned: true };
    }
    console.log(`[VT] ${name}: unknown hash, uploading (${(size / 1e6).toFixed(1)} MB)...`);
    const analysisId = await uploadFile(filePath);
    if (!(await waitForAnalysis(analysisId))) {
      console.log(`[VT] ${name}: analysis did not complete within ${POLL_TIMEOUT_MS / 60000} min`);
      return { name, unscanned: true };
    }
    res = await api(`/api/v3/files/${sha256}`);
  }
  if (res.status !== 200) throw new Error(`${name}: VT lookup failed (HTTP ${res.status})`);

  const { malicious, detections } = summarize(JSON.parse(res.body));
  const flaggedByMicrosoft = detections.some((d) => d.toLowerCase().startsWith('microsoft:'));
  console.log(
    `[VT] ${name}: ${malicious} detection(s)` +
      (detections.length ? ` — ${detections.join(', ')}` : '') +
      ` https://www.virustotal.com/gui/file/${sha256}`
  );
  return { name, malicious, flaggedByMicrosoft };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node scripts/virustotal-check.js <file> [file...]');
    process.exit(2);
  }
  if (!API_KEY) {
    console.log('[VT] SKIP: VIRUSTOTAL_API_KEY is not set (add it as a repo secret to enable this check).');
    return;
  }
  let fail = false;
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    const r = await checkFile(f);
    if (r.flaggedByMicrosoft) {
      console.error(`[VT] FAIL: Microsoft flags ${r.name} — Defender users would hit this as a false positive.`);
      fail = true;
    } else if (r.malicious > 0) {
      console.log(`[VT] WARN: ${r.name} has non-Microsoft detections (likely heuristic noise, review before release).`);
    }
    await sleep(15 * 1000); // free tier: 4 requests/min
  }
  if (fail) process.exit(1);
  console.log('[VT] done: no Microsoft detections.');
}

main().catch((err) => {
  console.error(`[VT] ERROR: ${err.message}`);
  process.exit(1);
});
