'use strict';
/**
 * Native cleanups that started a non-atomic command (go clean -modcache, uv
 * cache clean ...) and never finished cleanly. Recorded when the command
 * starts and cleared only when a clean of that target finishes, so a crash, a
 * quit, a kill from outside or a failure all leave the record behind. The row
 * then says "Incomplete: run the clean again before building." and offers to
 * finish once the tool is idle.
 *
 * Storage is injected ({ read() -> object, write(object) }): main keeps it in
 * native-incomplete.json in the app data folder.
 */

const specs = require('./native-cleanup-specs');

function createIncompleteStore({ read, write, now = Date.now } = {}) {
  const load = () => {
    let v;
    try { v = read(); } catch { v = null; }
    const out = {};
    if (v && typeof v === 'object') {
      for (const [id, e] of Object.entries(v)) {
        if (specs.specFor(id) && e && typeof e === 'object' && Number.isFinite(e.at)) {
          out[id] = { at: e.at, command: typeof e.command === 'string' ? e.command.slice(0, 200) : null };
        }
      }
    }
    return out;
  };
  const save = (v) => { try { write(v); } catch { /* best effort: the run itself still reports */ } };
  return {
    /** A non-atomic command for `id` is about to run. */
    start(id, command) {
      if (!specs.specFor(id)) return;
      const v = load();
      v[id] = { at: now(), command: typeof command === 'string' ? command : null };
      save(v);
    },
    /** A clean of `id` finished: whatever was half done is gone now. */
    finish(id) {
      const v = load();
      if (!v[id]) return;
      delete v[id];
      save(v);
    },
    get(id) { return load()[id] || null; },
    list() { return load(); },
  };
}

/** What the row and History say about an unfinished clean. */
function incompleteInfo(entry) {
  if (!entry) return null;
  return { at: entry.at, command: entry.command, message: specs.INCOMPLETE_MESSAGE };
}

module.exports = { createIncompleteStore, incompleteInfo };
