'use strict';
// Sizes from the previous breakdown, kept between runs in the worker.
//
// A rescan shows each folder's last size at once (confidence 'cached', with
// its age) and swaps in the fresh number as each du finishes, so the Storage
// screen fills in seconds instead of minutes. A folder whose walk times out
// keeps the bytes it reached; the cached figure is shown next to it, never
// silently used instead. The file lives in Spaci's userData folder; main sets
// SPACI_STORAGE_CACHE so the worker knows where (see main.js, storage block).

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function createSizeCache({ file = process.env.SPACI_STORAGE_CACHE || null, now = Date.now, fsApi = fs } = {}) {
  let data = null;
  function load() {
    if (data) return data;
    data = { v: VERSION, volume: null, entries: {} };
    if (!file) return data;
    try {
      const v = JSON.parse(fsApi.readFileSync(file, 'utf8'));
      if (v && v.v === VERSION && v.entries && typeof v.entries === 'object') data = v;
    } catch (_) { /* first run or unreadable: start empty */ }
    return data;
  }
  return {
    /** Forget everything when the disk changed (a different volume or total size). */
    checkVolume(id) {
      const d = load();
      if (d.volume && id && d.volume !== id) d.entries = {};
      d.volume = id || d.volume;
    },
    get(p) {
      const e = load().entries[p];
      if (!e || typeof e.bytes !== 'number') return null;
      if (now() - (e.at || 0) > MAX_AGE_MS) return null;
      return e;
    },
    set(p, bytes, confidence) {
      if (typeof bytes !== 'number' || !(bytes >= 0)) return;
      // A partial or denied walk is a lower bound; do not let it replace a complete one.
      const prev = load().entries[p];
      if (prev && prev.confidence === 'exact' && confidence !== 'exact' && bytes < prev.bytes) return;
      load().entries[p] = { bytes, confidence: confidence || 'exact', at: now() };
    },
    save() {
      if (!file) return false;
      try {
        fsApi.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        fsApi.writeFileSync(tmp, JSON.stringify(load()));
        fsApi.renameSync(tmp, file);
        return true;
      } catch (_) { return false; }
    },
    file,
  };
}

module.exports = { createSizeCache };
