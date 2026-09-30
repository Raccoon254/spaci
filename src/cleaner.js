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
const { SKIP_DELETE } = require('./scanner');

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

/** Bytes a file occupies on disk (what du reports), falling back to size. */
function allocated(stat) {
  return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
}

/** Make a directory readable, listable and writable by its owner. Best effort. */
async function makeWritable(p, stat) {
  const want = stat.isDirectory() ? 0o700 : 0o600;
  if ((stat.mode & want) === want) return;
  try { await fsp.chmod(p, (stat.mode & 0o7777) | want); } catch { /* the next call reports it */ }
}

function fail(ctx, p, err) {
  ctx.failures.push({ path: p, error: (err && err.message) || String(err) });
}

/**
 * Remove one entry (file, symlink or directory tree) into ctx.
 * Resolves 'gone', 'kept' (deliberately left: protected or system file) or
 * 'failed' (still on disk because something could not be removed).
 */
async function removeEntry(p, ctx, parentStat) {
  if (ctx.signal?.aborted) return 'kept';
  const name = path.basename(p);
  if (SKIP_DELETE.has(name) || isProtected(ctx, name)) return 'kept';

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

function newCtx(signal, protect) {
  return { signal, protect: protectSet(protect), freed: 0, failures: [] };
}

/** Summarise failures as one message that names the first offender. */
function failureMessage(failures) {
  const first = failures[0];
  const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : '';
  return `${first.error}${more}`;
}

/**
 * Delete one path (file or dir). Returns bytes freed.
 * `options.protect` is a list of basenames that must never be deleted.
 * A partial failure is reported through onProgress with an `error`, never as
 * success.
 */
async function deletePath(target, onProgress, signal, options = {}) {
  try { await fsp.lstat(target); } catch { return 0; }

  const ctx = newCtx(signal, options.protect);
  let parentStat = null;
  try { parentStat = await fsp.lstat(path.dirname(target)); } catch { /* */ }
  const result = await removeEntry(target, ctx, parentStat);

  if (result === 'failed' || ctx.failures.length) {
    onProgress?.({
      path: target, freed: ctx.freed, error: failureMessage(ctx.failures),
      failedPaths: ctx.failures.map((f) => f.path),
    });
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
    onProgress?.({ path: dir, freed: 0, error: e.message });
    return 0;
  }
  const parentStat = await fsp.lstat(dir).catch(() => dirStat);
  let freed = 0;
  for (const name of entries) {
    if (signal?.aborted) break;
    const ctx = newCtx(signal, options.protect);
    const child = path.join(dir, name);
    const result = await removeEntry(child, ctx, parentStat);
    freed += ctx.freed;
    if (result === 'failed' || ctx.failures.length) {
      onProgress?.({
        path: child, freed: ctx.freed, error: failureMessage(ctx.failures),
        failedPaths: ctx.failures.map((f) => f.path),
      });
    } else if (result === 'gone') {
      onProgress?.({ path: child, freed: ctx.freed });
    }
  }
  return freed;
}

/**
 * Clean a list of jobs.
 * job = { path, mode?, protect? }  mode 'contents' empties dir, otherwise removes
 * path. `protect` is an array of basenames that survive at any depth.
 */
async function clean(jobs, onProgress, signal) {
  let totalFreed = 0;
  let done = 0;
  const errors = [];
  for (const job of jobs) {
    if (signal?.aborted) break;
    const before = totalFreed;
    const report = (p) => { if (p.error) errors.push(p); onProgress?.({ ...p, done, total: jobs.length }); };
    const options = { protect: job.protect };
    if (job.mode === 'contents') {
      totalFreed += await emptyContents(job.path, report, signal, options);
    } else {
      totalFreed += await deletePath(job.path, report, signal, options);
    }
    done++;
    onProgress?.({ phase: 'item-done', path: job.path, freed: totalFreed - before, totalFreed, done, total: jobs.length });
  }
  return { totalFreed, errors };
}

module.exports = { clean, deletePath, emptyContents };
