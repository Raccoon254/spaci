'use strict';
// Moves large files to the system Trash. Kept apart from largefiles.js (the
// scan, which runs only in the scan worker) so main.js can use it without
// loading a scan module.
const fsp = require('fs').promises;

/**
 * Move large files to the system Trash, one at a time.
 * trashItem: Electron's shell.trashItem (injected, so this is tested without
 * Electron). Freed bytes are each file's allocated size, although the space
 * only comes back when the Trash is emptied.
 *
 * If trashItem fails the file is reported as failed and left where it is.
 * There is deliberately no fallback to deleting it: the user was told it goes
 * to the Trash, where they can get it back.
 *
 * Returns { totalFreed, errors: [{ path, error, code? }], results: [{ path,
 * freed, ok, missing, error?, code? }] }.
 */
async function trashFiles(paths, { trashItem, lstat = (p) => fsp.lstat(p), onProgress, signal } = {}) {
  const results = [];
  const errors = [];
  let totalFreed = 0;
  const failed = (p, error, code, missing = false) => {
    const r = { path: p, freed: 0, ok: false, missing, error, ...(code ? { code } : {}) };
    results.push(r);
    errors.push({ path: p, error, ...(code ? { code } : {}) });
    onProgress?.({ path: p, freed: 0, error, ...(code ? { code } : {}) });
  };
  for (const p of Array.isArray(paths) ? paths : []) {
    if (signal?.aborted) break;
    if (typeof trashItem !== 'function') { failed(p, 'The system Trash is not available, so Spaci left this file alone.'); continue; }
    let st;
    try { st = await lstat(p); }
    catch (e) {
      if (e && e.code === 'ENOENT') failed(p, 'Already gone', 'ENOENT', true);
      else failed(p, (e && e.message) || String(e), e && e.code);
      continue;
    }
    // Only regular files came out of the large-file scan. Anything else now at
    // this path (a folder, a symlink) is not what the user chose.
    if (!st.isFile() || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())) {
      failed(p, 'This is no longer the file Spaci found, so it left it alone.');
      continue;
    }
    // A hard-linked file frees nothing while another link remains.
    const size = typeof st.nlink === 'number' && st.nlink > 1 ? 0
      : typeof st.blocks === 'number' ? st.blocks * 512 : (st.size || 0);
    try {
      await trashItem(p);
    } catch (e) {
      failed(p, (e && e.message) || 'Could not move this file to the Trash.', e && e.code);
      continue;
    }
    totalFreed += size;
    results.push({ path: p, freed: size, ok: true, missing: false });
    onProgress?.({ path: p, freed: size, trashed: true });
  }
  return { totalFreed, errors, results };
}

module.exports = { trashFiles };
