'use strict';
/**
 * Cross-platform system cleaner: a catalog of safe, reclaimable cache locations.
 * Every target here is regenerable; nothing user-created is listed.
 * Sizes are measured live (du on macOS/Linux, a bounded Node walk on Windows).
 * Cleaning empties contents (keeps the dir).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { buildSystemTargets } = require('./storage-classifier');

/**
 * Each target: { id, name, description, category, icon, safe, reversible, mode,
 *   paths:[absolute paths] }. mode is 'contents' for all (empty the dir, keep it).
 * reversible is true for every target since all listed caches regenerate.
 */
const TARGETS = buildSystemTargets();

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Bounded recursive Node walk that sums file sizes in bytes. Skips symlinks,
 * swallows per-entry errors, and stops early once the time budget is spent so
 * it returns within ~30s. The result may be approximate when capped.
 */
async function walkSize(root, deadline = Date.now() + 30000) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() > deadline) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(full);
          total += stat.size;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  return total;
}

function parseDuBytes(stdout) {
  const first = String(stdout || '').trim().split('\n').find(Boolean) || '';
  const kb = parseInt((first.split(/\s+/)[0] || '0').trim(), 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** Measure a path's size with `du -sk` (fast, kilobytes). Falls back to a walk only when `du` printed no usable total. */
function duSizeUnix(p) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', p], { timeout: 30000 }, (err, stdout) => {
      const bytes = parseDuBytes(stdout);
      if (bytes > 0 || !err) return resolve(bytes);
      resolve(walkSize(p));
    });
  });
}

/** Measure a path's size in bytes. Missing path returns 0. */
async function duSize(p) {
  if (!fs.existsSync(p)) return 0;
  if (process.platform === 'win32') return walkSize(p);
  return duSizeUnix(p);
}

async function targetSize(target) {
  let total = 0;
  for (const p of target.paths) total += await duSize(p);
  return total;
}

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').includes('\\') ? path.win32 : path.posix;
}

function isInside(parent, child) {
  if (!parent || !child || parent === child) return false;
  const pathApi = pathApiFor(parent);
  const rel = pathApi.relative(parent, child);
  return rel && !rel.startsWith('..') && !pathApi.isAbsolute(rel);
}

async function targetSizeWithoutChildren(target, allTargets) {
  const total = await targetSize(target);
  const childPaths = [];
  for (const other of allTargets) {
    if (other.id === target.id) continue;
    for (const parent of target.paths) {
      for (const child of other.paths) {
        if (isInside(parent, child)) childPaths.push(child);
      }
    }
  }

  let childTotal = 0;
  for (const child of Array.from(new Set(childPaths))) childTotal += await duSize(child);
  return Math.max(0, total - childTotal);
}

/** Scan all targets, streaming progress. */
async function scanSystem(onProgress, signal) {
  const results = [];
  for (let i = 0; i < TARGETS.length; i++) {
    if (signal?.aborted) break;
    const t = TARGETS[i];
    onProgress?.({ phase: 'scanning', index: i, total: TARGETS.length, current: t.name });
    const size = t.storyCategory === 'caches'
      ? await targetSizeWithoutChildren(t, TARGETS)
      : await targetSize(t);
    const existing = t.paths.filter((p) => fs.existsSync(p));
    results.push({
      ...t,
      size,
      existingPaths: existing,
      meta: { source: 'system-scan', scannedAt: Date.now(), partial: Boolean(signal?.aborted) },
    });
  }
  onProgress?.({ phase: 'done' });
  return results.filter((r) => r.existingPaths.length > 0);
}

module.exports = { TARGETS, scanSystem, targetSize, duSize, parseDuBytes };
