'use strict';
/**
 * Safe deletion engine. Deletes only the exact paths handed to it, skips known
 * system files, reports bytes freed, and never follows symlinks out of a target.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { SKIP_DELETE, dirSize } = require('./scanner');

/** Delete one path (file or dir). Returns bytes freed. */
async function deletePath(target, onProgress, signal) {
  let stat;
  try { stat = await fsp.lstat(target); } catch { return 0; }

  // Measure before deleting so we can report freed space.
  let freed = 0;
  try { freed = stat.isDirectory() ? await dirSize(target, signal) : stat.size; } catch { /* */ }

  if (stat.isSymbolicLink()) {
    try { await fsp.unlink(target); } catch { /* */ }
    return 0; // don't credit symlink targets
  }

  if (SKIP_DELETE.has(path.basename(target))) return 0;

  try {
    await fsp.rm(target, { recursive: true, force: true });
    onProgress?.({ path: target, freed });
    return freed;
  } catch (e) {
    onProgress?.({ path: target, freed: 0, error: e.message });
    return 0;
  }
}

/** Empty a directory's contents but keep the directory itself. Returns bytes freed. */
async function emptyContents(dir, onProgress, signal) {
  let freed = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    if (signal?.aborted) break;
    if (SKIP_DELETE.has(e.name)) continue;
    freed += await deletePath(path.join(dir, e.name), onProgress, signal);
  }
  return freed;
}

/**
 * Clean a list of jobs.
 * job = { path, mode? }  mode 'contents' empties dir, otherwise removes path.
 */
async function clean(jobs, onProgress, signal) {
  let totalFreed = 0;
  let done = 0;
  const errors = [];
  for (const job of jobs) {
    if (signal?.aborted) break;
    const before = totalFreed;
    if (job.mode === 'contents') {
      totalFreed += await emptyContents(job.path, (p) => onProgress?.({ ...p, done, total: jobs.length }), signal);
    } else {
      totalFreed += await deletePath(job.path, (p) => { if (p.error) errors.push(p); onProgress?.({ ...p, done, total: jobs.length }); }, signal);
    }
    done++;
    onProgress?.({ phase: 'item-done', path: job.path, freed: totalFreed - before, totalFreed, done, total: jobs.length });
  }
  return { totalFreed, errors };
}

module.exports = { clean, deletePath, emptyContents };
