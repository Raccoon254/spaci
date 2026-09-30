'use strict';
// One way to run an external command for the storage breakdown: a hard
// timeout, a bounded output buffer, and a result object instead of a throw, so
// a stuck `docker system df` or a missing `snap` can never fail the breakdown.
// Tests replace `run` with a fixture-backed fake (see tests/os-storage-*.test.js).

const { execFile } = require('child_process');

/**
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null, timedOut: boolean, missing: boolean }>}
 */
function run(cmd, args = [], { timeout = 8000, maxBuffer = 16 * 1024 * 1024, env, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, maxBuffer, env: env || process.env, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        const out = { ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : null) : 0, timedOut: Boolean(err && (err.killed || err.signal) && !err.code), missing: Boolean(err && err.code === 'ENOENT') };
        resolve(out);
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String(e && e.message), code: null, timedOut: false, missing: true });
      return;
    }
    if (input != null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

/** Parse JSON without throwing; `null` for anything unparsable. */
function json(text) {
  try { return JSON.parse(String(text || '').replace(/^﻿/, '')); } catch { return null; }
}

module.exports = { run, json };
