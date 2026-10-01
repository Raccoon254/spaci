'use strict';
/**
 * The shapes every detector returns, and the tier rules for them.
 *
 * Group: one store or tool (Ollama, iOS simulators, nvm ...):
 *   { id, section: 'ai' | 'dev', category, title, brand?, tech?, icon, roots,
 *     status: 'ok' | 'error', server?: { state, label }, items, total, note? }
 *
 * Item: one thing that can be removed on its own (a model, a runtime, a
 * toolchain version):
 *   { id, group, label, detail, size, totalSize?, badges, state, blocked,
 *     tier, tierReason, restoreHint, paths, removal, partOf? }
 *
 * `blocked` is null or the reason the item cannot be deleted right now (it is
 * loaded, running, pinned by a project, or Spaci could not check). A blocked
 * item never gets a working Delete button, and main refuses it as well.
 *
 * Tiers (src/clean-tiers.js vocabulary):
 *   B Review     downloaded models, simulator runtimes, toolchain versions no
 *                project pins, old IDE versions, tool caches: they come back,
 *                but slowly or by hand.
 *   C Permanent  things that hold your own state (an emulator's or a
 *                simulator's apps and data, a conda environment) or a version
 *                a project pins (shown, never deletable).
 * Nothing here is tier A: each item is deleted on its own, after a confirm.
 */

const TIER_REASON = {
  model: 'A downloaded model. It downloads again, but large models take a long time.',
  runtime: 'Downloads again from Apple or Google when you need it, which is large and slow.',
  toolchain: 'A toolchain version no project pins. Reinstall it with the same tool if you need it again.',
  cache: 'A tool cache. The tool fetches it again the next time it needs it.',
  ide: 'Caches, logs and plugins of an IDE version that is no longer installed. Its settings and scratch files stay.',
  userdata: 'Holds its own apps, files and settings, which nothing can rebuild.',
  pinned: 'A project pins this version. Spaci never deletes it.',
};

function makeGroup(fields) {
  const items = Array.isArray(fields.items) ? fields.items : [];
  return {
    status: 'ok',
    server: null,
    note: null,
    ...fields,
    items,
    // Items that are part of another item (an older revision inside a cached
    // repo) are already counted in it.
    total: items.filter((it) => !it.partOf).reduce((a, it) => a + (Number(it.size) || 0), 0),
    count: items.length,
  };
}

function makeItem(fields) {
  const kind = fields.kind || 'cache';
  const blocked = fields.blocked || null;
  const tier = fields.tier || (kind === 'userdata' ? 'C' : 'B');
  return {
    badges: [],
    state: 'idle',
    restoreHint: null,
    paths: [],
    detail: '',
    ...fields,
    kind,
    blocked,
    tier,
    tierReason: fields.tierReason || TIER_REASON[blocked && fields.pinned ? 'pinned' : kind] || TIER_REASON.cache,
    size: Math.max(0, Math.round(Number(fields.size) || 0)),
  };
}

function errorGroup(base, error) {
  return makeGroup({ ...base, status: 'error', items: [], note: String((error && error.message) || error || 'Could not be read.') });
}

module.exports = { makeGroup, makeItem, errorGroup, TIER_REASON };
