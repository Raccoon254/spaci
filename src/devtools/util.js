'use strict';
/**
 * Shared helpers for the AI model and developer tool detectors.
 *
 * Rules every detector follows:
 *   - one process per tool, never one per file; files are read with fs calls;
 *   - every process and HTTP call has a timeout and never rejects;
 *   - walks are bounded by a deadline and an entry budget;
 *   - when something cannot be checked, the answer is "unknown", and unknown
 *     blocks deletion (fail closed).
 *
 * Pure apart from fs, child_process and http, all of which are injectable.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const http = require('http');

const MB = 1024 * 1024;

/**
 * Run one command. Resolves to { ok, code, stdout, stderr, missing, timedOut }
 * and never rejects. `missing` is true when the executable does not exist.
 */
function run(cmd, args = [], options = {}) {
  const exec = options.exec || execFile;
  const timeout = options.timeout || 10000;
  return new Promise((resolve) => {
    try {
      exec(cmd, args, {
        timeout,
        maxBuffer: options.maxBuffer || 32 * MB,
        windowsHide: true,
        env: options.env,
        cwd: options.cwd,
        encoding: 'utf8',
      }, (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errText = String(stderr || '');
        if (!err) return resolve({ ok: true, code: 0, stdout: out, stderr: errText, missing: false, timedOut: false });
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : null,
          stdout: out,
          stderr: errText || String(err.message || ''),
          missing: err.code === 'ENOENT',
          timedOut: Boolean(err.killed) || err.signal === 'SIGTERM',
        });
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: String((e && e.message) || e), missing: e && e.code === 'ENOENT', timedOut: false });
    }
  });
}

/**
 * One HTTP JSON request to a local server. Resolves to
 * { ok, status, json, error } and never rejects. Only http: URLs on
 * loopback hosts are allowed, so nothing here ever leaves the machine.
 */
function httpJson(method, url, body, options = {}) {
  const timeout = options.timeout || 1500;
  const request = options.request || http.request;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, json: null, error: 'bad-url' }); }
    if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) return resolve({ ok: false, status: 0, json: null, error: 'not-local' });
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = request({
        method,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 16 * MB) { req.destroy(); finish({ ok: false, status: res.statusCode, json: null, error: 'too-large' }); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text, error: null });
        });
        res.on('error', (e) => finish({ ok: false, status: res.statusCode || 0, json: null, error: e.code || 'error' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, json: null, error: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, status: 0, json: null, error: (e && e.code) || 'error' }));
      if (payload) req.write(payload);
      req.end();
    } catch (e) {
      finish({ ok: false, status: 0, json: null, error: (e && e.code) || 'error' });
    }
  });
}

function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  let next = 0;
  const out = new Array(list.length);
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
  return out;
}

/** Resolve to fallback if the promise takes longer than ms. */
function withTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(typeof fallback === 'function' ? fallback() : fallback), ms); }),
  ]);
}

async function lstatSafe(p) { try { return await fsp.lstat(p); } catch { return null; } }
async function statSafe(p) { try { return await fsp.stat(p); } catch { return null; } }
async function exists(p) { return Boolean(p) && (await lstatSafe(p)) !== null; }
async function isDir(p) { const s = await statSafe(p); return Boolean(s && s.isDirectory()); }

async function readText(p, max = 4 * MB) {
  try {
    const s = await fsp.stat(p);
    if (!s.isFile() || s.size > max) return null;
    return await fsp.readFile(p, 'utf8');
  } catch { return null; }
}

async function readJson(p, max = 4 * MB) {
  const t = await readText(p, max);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** Directory entries (Dirent), or [] when missing or unreadable. */
async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Allocated bytes, the same figure du and the cleaner use. */
function allocated(stat) {
  if (!stat) return 0;
  return typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size || 0;
}

/**
 * Bytes under `root`, by an lstat walk (never a process per file). Symlinks
 * are not followed. Stops at the deadline or entry budget and says so with
 * `partial`. Hard-linked files are counted once.
 */
async function dirSize(root, options = {}) {
  const deadline = options.deadline || Date.now() + 20000;
  const maxEntries = options.maxEntries || 400000;
  const seen = new Set();
  let bytes = 0;
  let entries = 0;
  let partial = false;
  const top = await lstatSafe(root);
  if (!top) return { bytes: 0, partial: false, missing: true };
  if (!top.isDirectory()) return { bytes: allocated(top), partial: false, missing: false };
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline || entries > maxEntries) { partial = true; break; }
    const dir = stack.pop();
    const list = await listDir(dir);
    entries += list.length;
    const stats = await pool(list, 32, async (d) => {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) return null;
      if (d.isDirectory()) { stack.push(full); return null; }
      return lstatSafe(full);
    });
    for (const s of stats) {
      if (!s || !s.isFile()) continue;
      if (s.nlink > 1) {
        const k = s.dev + ':' + s.ino;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      bytes += allocated(s);
    }
  }
  return { bytes, partial, missing: false };
}

/** POSIX or Windows path module for a path, by its shape. */
function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').includes('\\') ? path.win32 : path.posix;
}

/** child is strictly inside parent (never equal). */
function isInside(parent, child) {
  if (!parent || !child) return false;
  const api = pathApiFor(parent);
  const rel = api.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !api.isAbsolute(rel);
}

function realOr(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/**
 * A path Spaci may delete for a store: strictly inside the store root, both
 * by string and by real path, so a symlink inside the store can never point
 * the delete somewhere else. The path itself may be a symlink (it is then
 * removed, not followed).
 */
function safeInside(root, p) {
  if (!isInside(root, p)) return false;
  const realRoot = realOr(root);
  const realParent = realOr(path.dirname(p));
  if (!realRoot || !realParent) return false;
  return realParent === realRoot || isInside(realRoot, realParent);
}

/** Absolute value of an env var, or null (relative values are ignored). */
function absEnv(env, name) {
  const v = env && env[name];
  if (typeof v !== 'string' || !v.trim()) return null;
  return /^([A-Za-z]:[\\/]|[\\/])/.test(v) ? v : null;
}

/** Strip ANSI colour codes. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** Compare dotted versions numerically: 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/);
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] === undefined ? '' : pa[i];
    const y = pb[i] === undefined ? '' : pb[i];
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) { if (nx !== ny) return nx > ny ? 1 : -1; continue; }
    if (x === y) continue;
    if (x === '') return -1;
    if (y === '') return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = {
  MB, run, httpJson, isLoopbackHost, pool, withTimeout, lstatSafe, statSafe, exists, isDir,
  readText, readJson, listDir, allocated, dirSize, pathApiFor, isInside, safeInside, absEnv,
  stripAnsi, compareVersions,
};
