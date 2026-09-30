'use strict';
// Per-OS collectors for the parts of used space the category walk does not
// cover: OS volumes and files, system folders, and the named parts nobody
// without admin rights can measure. See os-storage-spec.md.

const collectors = {
  darwin: () => require('./darwin'),
  linux: () => require('./linux'),
  win32: () => require('./win32'),
};

/** Run the collector for `platform`. Never throws: a broken collector gives no items. */
async function collectOsLayer(platform, ctx) {
  const load = collectors[platform];
  if (!load) return { items: [], facts: { platform } };
  try {
    return await load().collect(ctx);
  } catch (e) {
    return { items: [], facts: { platform, error: String(e && e.message) } };
  }
}

module.exports = { collectOsLayer };
