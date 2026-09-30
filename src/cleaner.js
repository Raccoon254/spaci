'use strict';
/**
 * Safe deletion engine. Deletes only the exact paths handed to it, skips known
 * system files, reports bytes freed, and never follows symlinks out of a target.
 *
 * Trees are removed by hand rather than with fs.rm so that read-only trees (Go's
 * module cache is 0444 files inside 0555 directories) can be unlinked, entries
 * named in a target's `protect` list survive at any depth, and a partial failure
 * is reported instead of being mistaken for success.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
// From constants.js, not scanner.js: the cleaner runs in the main process and
// must not load the scan modules.
const { SKIP_DELETE } = require('./constants');

const RETRY_CODES = new Set(['EACCES', 'EPERM']);

/**
 * `protect` is a list of basenames. Matching is exact on the name but ignores
 * case, because macOS and Windows filesystems do: a folder named "Memory" is the
 * same folder as "memory" there, and over-protecting is the safe direction.
 */
function protectSet(protect) {
  const set = new Set();
  for (const name of Array.isArray(protect) ? protect : []) {
    if (typeof name === 'string' && name) set.add(name.toLowerCase());
  }
  return set;
}

function isProtected(ctx, name) {
  return ctx.protect.size > 0 && ctx.protect.has(name.toLowerCase());
}

/**
 * `excludePaths` are absolute paths that must survive. The main process passes
 * every other target nested inside the one being cleaned, so cleaning "Other
 * app caches" never reaches into a separately listed cache, whatever that
 * folder is called. Keys are Unicode-normalised, and case-folded on macOS and
 * Windows where the filesystem ignores case; over-matching is the safe side.
 */
function excludeKey(p) {
  const key = path.resolve(String(p)).normalize('NFC');
  return process.platform === 'linux' ? key : key.toLowerCase();
}

function excludeSet(excludePaths) {
  const set = new Set();
  for (const p of Array.isArray(excludePaths) ? excludePaths : []) {
    if (typeof p === 'string' && p) set.add(excludeKey(p));
  }
  return set;
}

function isExcluded(ctx, p) {
  return ctx.exclude.size > 0 && ctx.exclude.has(excludeKey(p));
}

/**
 * Bytes a file occupies on disk (what du reports), falling back to size.
 * A file with other hard links (pnpm and uv stores use them) frees nothing when
 * one link goes, so it is not credited: freed bytes may read low, never high.
 */
function allocated(stat) {
  if (typeof stat.nlink === 'number' && stat.nlink > 1) return 0;
  return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
}

/** Make a directory readable, listable and writable by its owner. Best effort. */
async function makeWritable(p, stat) {
  const want = stat.isDirectory() ? 0o700 : 0o600;
  if ((stat.mode & want) === want) return;
  try { await fsp.chmod(p, (stat.mode & 0o7777) | want); } catch { /* the next call reports it */ }
}

function fail(ctx, p, err) {
  ctx.failures.push({ path: p, error: (err && err.message) || String(err), code: (err && err.code) || undefined });
}

/**
 * Remove one entry (file, symlink or directory tree) into ctx.
 * Resolves 'gone', 'kept' (deliberately left: protected or system file) or
 * 'failed' (still on disk because something could not be removed).
 */
async function removeEntry(p, ctx, parentStat) {
  if (ctx.signal?.aborted) return 'kept';
  const name = path.basename(p);
  if (SKIP_DELETE.has(name) || isProtected(ctx, name) || isExcluded(ctx, p)) return 'kept';

  let stat;
  try { stat = await fsp.lstat(p); }
  catch (e) { return e.code === 'ENOENT' ? 'gone' : (fail(ctx, p, e), 'failed'); }

  if (!stat.isDirectory()) {
    // Files and symlinks alike: unlink removes the link itself, never its target.
    const size = stat.isSymbolicLink() ? 0 : allocated(stat);
    try {
      await fsp.unlink(p);
    } catch (e) {
      if (e.code === 'ENOENT') return 'gone';
      if (!RETRY_CODES.has(e.code)) return (fail(ctx, p, e), 'failed');
      // A read-only parent blocks the unlink; a read-only file blocks it on Windows.
      if (parentStat) await makeWritable(path.dirname(p), parentStat);
      if (!stat.isSymbolicLink()) await makeWritable(p, stat);
      try { await fsp.unlink(p); }
      catch (e2) { return e2.code === 'ENOENT' ? 'gone' : (fail(ctx, p, e2), 'failed'); }
    }
    ctx.freed += size;
    return 'gone';
  }

  // A directory: unlock it, empty it, then remove it if nothing was left behind.
  await makeWritable(p, stat);
  let names;
  try { names = await fsp.readdir(p); }
  catch (e) { return e.code === 'ENOENT' ? 'gone' : (fail(ctx, p, e), 'failed'); }

  const fresh = await fsp.lstat(p).catch(() => stat);
  let left = false;
  let failed = false;
  for (const child of names) {
    const r = await removeEntry(path.join(p, child), ctx, fresh);
    if (r === 'kept') left = true;
    else if (r === 'failed') failed = true;
  }
  if (failed) return 'failed';
  // Something protected below: the directory must stay so it keeps its path.
  if (left) return 'kept';

  try {
    await fsp.rmdir(p);
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    if (RETRY_CODES.has(e.code) && parentStat) {
      await makeWritable(path.dirname(p), parentStat);
      try { await fsp.rmdir(p); return 'gone'; } catch (e2) { e = e2; }
    }
    if (e.code === 'ENOENT') return 'gone';
    fail(ctx, p, e);
    return 'failed';
  }
  return 'gone';
}

function newCtx(signal, options = {}) {
  return {
    signal,
    protect: protectSet(options.protect),
    exclude: excludeSet(options.excludePaths),
    freed: 0,
    failures: [],
  };
}

/** Summarise failures as one message that names the first offender. */
function failureMessage(failures) {
  const first = failures[0];
  const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : '';
  return `${first.error}${more}`;
}

/** A failure report for onProgress: message, the first known error code, every failed path. */
function failureReport(p, freed, failures) {
  const report = { path: p, freed, error: failureMessage(failures), failedPaths: failures.map((f) => f.path) };
  const coded = failures.find((f) => f.code);
  if (coded) report.code = coded.code;
  return report;
}

/**
 * Delete one path (file or dir). Returns bytes freed.
 * `options.protect` is a list of basenames that must never be deleted.
 * A partial failure is reported through onProgress with an `error`, never as
 * success.
 */
async function deletePath(target, onProgress, signal, options = {}) {
  try { await fsp.lstat(target); } catch { return 0; }

  const ctx = newCtx(signal, options);
  let parentStat = null;
  try { parentStat = await fsp.lstat(path.dirname(target)); } catch { /* */ }
  const result = await removeEntry(target, ctx, parentStat);

  if (result === 'failed' || ctx.failures.length) {
    onProgress?.(failureReport(target, ctx.freed, ctx.failures));
  } else if (result === 'gone') {
    onProgress?.({ path: target, freed: ctx.freed });
  }
  return ctx.freed;
}

/**
 * Empty a directory's contents but keep the directory itself. Returns bytes
 * freed. A symlinked target is refused rather than followed.
 */
async function emptyContents(dir, onProgress, signal, options = {}) {
  let dirStat;
  try { dirStat = await fsp.lstat(dir); } catch { return 0; }
  if (dirStat.isSymbolicLink()) {
    onProgress?.({ path: dir, freed: 0, error: 'Target is a symbolic link, left alone' });
    return 0;
  }
  if (!dirStat.isDirectory()) return 0;

  await makeWritable(dir, dirStat);
  let entries;
  try { entries = await fsp.readdir(dir); }
  catch (e) {
    onProgress?.({ path: dir, freed: 0, error: e.message, ...(e.code ? { code: e.code } : {}) });
    return 0;
  }
  const parentStat = await fsp.lstat(dir).catch(() => dirStat);
  let freed = 0;
  for (const name of entries) {
    if (signal?.aborted) break;
    const ctx = newCtx(signal, options);
    const child = path.join(dir, name);
    const result = await removeEntry(child, ctx, parentStat);
    freed += ctx.freed;
    if (result === 'failed' || ctx.failures.length) {
      onProgress?.(failureReport(child, ctx.freed, ctx.failures));
    } else if (result === 'gone') {
      onProgress?.({ path: child, freed: ctx.freed });
    }
  }
  return freed;
}

/**
 * Clean a list of jobs.
 * job = { path, mode?, protect?, excludePaths? }  mode 'contents' empties dir,
 * otherwise removes path. `protect` is an array of basenames that survive at any
 * depth; `excludePaths` is an array of absolute paths that survive.
 *
 * `results` has one entry per job that ran, in order: { path, freed, ok,
 * missing, error?, code? }. ok is true only when nothing under the job failed,
 * so the caller can count what was really removed. A job whose path was already
 * gone is ok:false, missing:true, code 'ENOENT': nothing was removed by Spaci.
 */
async function clean(jobs, onProgress, signal) {
  let totalFreed = 0;
  let done = 0;
  const errors = [];
  const results = [];
  for (const job of jobs) {
    if (signal?.aborted) break;
    const before = totalFreed;
    const jobErrors = [];
    const report = (p) => { if (p.error) { errors.push(p); jobErrors.push(p); } onProgress?.({ ...p, done, total: jobs.length }); };
    const options = { protect: job.protect, excludePaths: job.excludePaths };
    let missing = false;
    try { await fsp.lstat(job.path); }
    catch (e) {
      // Already gone, or unreadable (deletePath and emptyContents would then
      // return 0 without a word, which must not read as success).
      if (e.code === 'ENOENT') missing = true;
      else report({ path: job.path, freed: 0, error: e.message, ...(e.code ? { code: e.code } : {}) });
    }
    if (job.mode === 'contents') {
      totalFreed += await emptyContents(job.path, report, signal, options);
    } else {
      totalFreed += await deletePath(job.path, report, signal, options);
    }
    done++;
    const result = { path: job.path, freed: totalFreed - before, ok: !missing && jobErrors.length === 0, missing };
    if (missing) { result.error = 'Already gone'; result.code = 'ENOENT'; }
    else if (jobErrors.length) {
      result.error = jobErrors[0].error;
      const coded = jobErrors.find((p) => p.code);
      if (coded) result.code = coded.code;
    }
    results.push(result);
    onProgress?.({ phase: 'item-done', path: job.path, freed: totalFreed - before, totalFreed, done, total: jobs.length });
  }
  return { totalFreed, errors, results };
}

module.exports = { clean, deletePath, emptyContents };
