'use strict';
/**
 * Spaci: large-file scanner.
 * Cross-platform (macOS / Linux / Windows) recursive walk that surfaces the
 * biggest files under a root directory. Uses only Node.js built-ins.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** Directory basenames we never descend into. */
const SKIP = new Set(['.Trash', '$Recycle.Bin', '.git']);

/** Cap on the running buffer before we trim back to keep memory bounded. */
const SOFT_CAP = 800;
const TRIM_TO = 400;

/** Final number of biggest files returned to the caller. */
const RESULT_LIMIT = 300;

/**
 * Scan a root directory for files at or above a size threshold.
 * @param {string} root absolute directory to scan
 * @param {number} minBytes minimum file size to include (default 100 MiB)
 * @param {(p:object)=>void} [onProgress] progress callback
 * @param {AbortSignal} [signal] optional cancellation signal
 * @returns {Promise<{files:object[], scanned:number}>}
 */
async function scanLargeFiles(root, minBytes, onProgress, signal) {
  const threshold = minBytes || 100 * 1024 * 1024;
  const found = [];
  let scanned = 0;
  let lastEmit = 0;

  const emit = (current, force) => {
    const now = Date.now();
    if (force || now - lastEmit > 60) {
      lastEmit = now;
      onProgress?.({ scanned, found: found.length, current });
    }
  };

  const stack = [root];
  while (stack.length) {
    if (signal?.aborted) break;
    const dir = stack.pop();

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // permission denied, gone, etc. — skip this directory.
      continue;
    }

    scanned++;
    emit(dir);

    for (const entry of entries) {
      if (signal?.aborted) break;
      if (entry.isSymbolicLink()) continue;

      const name = entry.name;
      const full = path.join(dir, name);

      if (entry.isDirectory()) {
        if (SKIP.has(name)) continue;
        stack.push(full);
        continue;
      }

      if (!entry.isFile()) continue;

      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }

      if (st.size >= threshold) {
        found.push({
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ext: path.extname(name).toLowerCase(),
        });

        // Bound memory on huge trees: trim back to the biggest TRIM_TO entries.
        if (found.length > SOFT_CAP) {
          found.sort((a, b) => b.size - a.size);
          found.length = TRIM_TO;
        }
      }
    }
  }

  found.sort((a, b) => b.size - a.size);
  const files = found.slice(0, RESULT_LIMIT);

  onProgress?.({ phase: 'done', scanned, found: files.length });
  return { files, scanned };
}

module.exports = { scanLargeFiles };
