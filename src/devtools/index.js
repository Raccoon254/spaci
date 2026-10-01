'use strict';
/**
 * Local AI models and developer tool storage: one inventory of every store
 * Spaci knows (src/devtools/*.js) and the removal of one item at a time.
 *
 * inventory(options) -> { at, groups, totals: { ai, dev }, processes: 'ok' | 'unknown', errors }
 *   Detectors run with bounded concurrency, each with its own time limit; one
 *   that fails or times out becomes an error group and never sinks the rest.
 *   One process listing is shared by all of them.
 *
 * removeItem(item, options) -> { ok, freed, error?, code?, via? }
 *   Re-detects the item's group first, so a model loaded or a simulator booted
 *   since the listing is refused, then runs the tool's own delete (or the
 *   documented on-disk equivalent). Never deletes outside the item's store.
 *
 * Runs in the scan worker (it spawns processes and walks folders).
 */

const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pool, withTimeout, run, lstatSafe, safeInside, isInside } = require('./util');
const { processList } = require('./processes');
const { errorGroup } = require('./model');
const ollama = require('./ollama');
const hfcache = require('./hfcache');
const aistores = require('./aistores');
const simulators = require('./simulators');
const android = require('./android');
const toolchains = require('./toolchains');
const ide = require('./ideandcaches');

const DETECTOR_MS = 45000;

/** Detectors in display order. Each returns an array of groups. */
const DETECTORS = [
  { id: 'ollama', title: 'Ollama', section: 'ai', run: ollama.inventory },
  { id: 'lmstudio', title: 'LM Studio', section: 'ai', run: aistores.lmStudio },
  { id: 'huggingface', title: 'Hugging Face cache', section: 'ai', run: hfcache.inventory },
  { id: 'docker-models', title: 'Docker Model Runner', section: 'ai', run: aistores.dockerModelRunner },
  { id: 'gpt4all', title: 'GPT4All', section: 'ai', run: aistores.gpt4all },
  { id: 'jan', title: 'Jan', section: 'ai', run: aistores.jan },
  { id: 'llamacpp', title: 'llama.cpp downloads', section: 'ai', run: aistores.llamaCpp },
  { id: 'whisper', title: 'Whisper models', section: 'ai', run: aistores.whisper },
  { id: 'comfyui', title: 'ComfyUI models', section: 'ai', run: aistores.comfyUi },
  { id: 'a1111', title: 'Stable Diffusion web UI models', section: 'ai', run: aistores.automatic1111 },
  { id: 'simulators', title: 'Xcode simulators', section: 'dev', run: simulators.inventory },
  { id: 'android', title: 'Android emulators and SDK', section: 'dev', run: android.inventory },
  { id: 'toolchains', title: 'Toolchains', section: 'dev', run: toolchains.inventory },
  { id: 'ide', title: 'IDE leftovers and tool caches', section: 'dev', run: ide.inventory },
];

// Which detector owns a group id, so a removal re-detects only that one.
const GROUP_OWNER = {
  ollama: 'ollama', lmstudio: 'lmstudio', huggingface: 'huggingface', 'docker-models': 'docker-models', gpt4all: 'gpt4all', jan: 'jan',
  llamacpp: 'llamacpp', whisper: 'whisper', comfyui: 'comfyui', a1111: 'a1111', simulators: 'simulators', android: 'android',
  nvm: 'toolchains', fnm: 'toolchains', volta: 'toolchains', pyenv: 'toolchains', 'uv-python': 'toolchains', conda: 'toolchains', rustup: 'toolchains',
  jetbrains: 'ide', vscode: 'ide', 'vscode-insiders': 'ide', 'cursor-ext': 'ide', 'windsurf-ext': 'ide', playwright: 'ide', puppeteer: 'ide',
  cypress: 'ide', 'electron-cache': 'ide', terraform: 'ide', 'gradle-dists': 'ide', homebrew: 'ide',
};

function baseContext(options = {}) {
  return {
    platform: options.platform || process.platform,
    home: options.home || os.homedir(),
    env: options.env || process.env,
    projects: Array.isArray(options.projects) ? options.projects.filter((p) => typeof p === 'string') : [],
    exec: options.exec,
    httpJson: options.httpJson,
  };
}

async function runDetectors(detectors, ctx, timeoutMs) {
  const errors = [];
  const results = await pool(detectors, 3, async (d) => {
    const started = Date.now();
    try {
      const groups = await withTimeout(d.run(ctx), timeoutMs, () => Promise.reject(new Error('timed out after ' + Math.round(timeoutMs / 1000) + ' s')));
      return Array.isArray(groups) ? groups : [];
    } catch (e) {
      errors.push({ id: d.id, error: (e && e.message) || String(e), ms: Date.now() - started });
      return [errorGroup({ id: d.id, section: d.section, category: 'error', title: d.title, icon: 'warning', roots: [] }, e)];
    }
  });
  return { groups: results.flat(), errors };
}

async function inventory(options = {}) {
  const ctx = baseContext(options);
  ctx.procs = options.procs || await processList({ platform: ctx.platform, exec: options.exec });
  const only = Array.isArray(options.only) ? new Set(options.only) : null;
  const detectors = DETECTORS.filter((d) => !only || only.has(d.id));
  const { groups, errors } = await runDetectors(detectors, ctx, options.timeoutMs || DETECTOR_MS);
  const order = new Map(DETECTORS.map((d, i) => [d.id, i]));
  groups.sort((a, b) => (a.section === b.section ? 0 : a.section === 'ai' ? -1 : 1)
    || (order.get(GROUP_OWNER[a.id]) || 0) - (order.get(GROUP_OWNER[b.id]) || 0)
    || b.total - a.total);
  const totals = { ai: 0, dev: 0 };
  for (const g of groups) totals[g.section === 'ai' ? 'ai' : 'dev'] += g.total || 0;
  return { at: Date.now(), groups, totals, processes: ctx.procs.ok ? 'ok' : 'unknown', errors };
}

function findItem(inv, id) {
  for (const g of (inv && inv.groups) || []) for (const it of g.items || []) if (it.id === id) return it;
  return null;
}

/** Remove paths that must lie inside one of the item's store roots. */
async function removePaths(removal, deletePath) {
  const roots = Array.isArray(removal.roots) ? removal.roots : [removal.root];
  const paths = Array.isArray(removal.paths) ? removal.paths : [];
  if (!paths.length || !roots.length || roots.some((r) => typeof r !== 'string' || !r)) return { ok: false, freed: 0, code: 'invalid', error: 'Nothing to remove.' };
  for (const p of paths) {
    if (!roots.some((r) => safeInside(r, p))) return { ok: false, freed: 0, code: 'outside', error: 'Spaci refused a path outside the tool\'s own folder: ' + p };
  }
  let freed = 0;
  const errors = [];
  for (const p of paths) {
    const report = [];
    freed += await deletePath(p, (r) => { if (r && r.error) report.push(r.error); });
    errors.push(...report);
  }
  if (errors.length) return { ok: false, freed, code: 'partial', error: errors[0] };
  return { ok: true, freed, via: 'disk' };
}

async function bytesOf(paths) {
  const { dirSize } = require('./util');
  let total = 0;
  for (const p of paths || []) total += (await dirSize(p, { deadline: Date.now() + 15000 })).bytes;
  return total;
}

/** Run the tool's own delete, then make sure what it should remove is gone. */
async function removeByCommand(removal, item, options, deletePath) {
  const before = await bytesOf(removal.expectGone);
  const env = removal.env ? { ...process.env, ...removal.env } : undefined;
  const res = await run(removal.cmd, removal.args || [], { exec: options.exec, timeout: removal.timeout || 60000, env });
  if (res.missing && removal.fallback) return removeAfterCheck(removal.fallback, options, deletePath, 'The tool is not installed, so Spaci removed the files itself.');
  if (!res.ok) {
    const msg = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ');
    return { ok: false, freed: 0, code: res.timedOut ? 'timeout' : 'failed', error: path.basename(removal.cmd) + ' ' + (removal.args || []).slice(0, 2).join(' ') + ' failed' + (msg ? ': ' + msg.slice(0, 300) : '.') };
  }
  const left = [];
  for (const p of removal.expectGone || []) if (await lstatSafe(p)) left.push(p);
  if (left.length) return { ok: false, freed: Math.max(0, before - (await bytesOf(left))), code: 'partial', error: 'The command finished, but ' + left[0] + ' is still there.' };
  return { ok: true, freed: removal.expectGone && removal.expectGone.length ? before : item.size, via: 'command' };
}

async function removeAfterCheck(removal, options, deletePath, note) {
  const r = await removePaths(removal, deletePath);
  if (r.ok && note) r.note = note;
  return r;
}

/**
 * Remove one item. `item` is main's cached copy. Re-detects its group first
 * and refuses when the item is gone, now blocked, or changed type.
 * options.deletePath(path, onProgress) -> bytes freed (cleaner.deletePath).
 */
async function removeItem(item, options = {}) {
  if (!item || typeof item.id !== 'string' || !item.removal) return { ok: false, freed: 0, code: 'invalid', error: 'Unknown item.' };
  const owner = GROUP_OWNER[item.group];
  if (!owner) return { ok: false, freed: 0, code: 'invalid', error: 'Unknown store.' };
  const fresh = await inventory({ ...options, only: [owner] });
  const now = findItem(fresh, item.id);
  if (!now) return { ok: false, freed: 0, code: 'gone', error: 'It is no longer there. Check again.' };
  if (now.blocked) return { ok: false, freed: 0, code: 'blocked', error: now.blocked };
  if (JSON.stringify(now.removal) !== JSON.stringify(item.removal)) return { ok: false, freed: 0, code: 'changed', error: 'It changed since Spaci listed it. Check again.' };
  const deletePath = options.deletePath || require('../cleaner').deletePath;
  const ctx = { ...baseContext(options), procs: options.procs || await processList({ platform: options.platform || process.platform, exec: options.exec }) };
  const r = now.removal;
  switch (r.type) {
    case 'ollama': return ollama.remove(now, ctx);
    case 'hf-revision': return hfcache.removeRevision(now);
    case 'paths': return removePaths(r, deletePath);
    case 'command': return removeByCommand(r, now, options, deletePath);
    default: return { ok: false, freed: 0, code: 'invalid', error: 'Unknown removal.' };
  }
}

/** Every path an item would touch, for main's clean guard. */
function itemPaths(item) {
  const r = item && item.removal;
  if (!r) return [];
  if (r.type === 'paths') return r.paths || [];
  if (r.type === 'command') return [...(r.expectGone || []), ...((r.fallback && r.fallback.paths) || [])];
  if (r.type === 'ollama') return r.file ? [r.file] : [];
  if (r.type === 'hf-revision') return [path.join(r.repoDir, 'snapshots', r.rev)];
  return [];
}

/** Dirs the storage breakdown should count as developer data. */
function storeRoots(inv) {
  const out = [];
  for (const g of (inv && inv.groups) || []) for (const r of g.roots || []) if (r && !out.includes(r)) out.push(r);
  return out;
}

module.exports = { DETECTORS, GROUP_OWNER, inventory, removeItem, findItem, itemPaths, storeRoots, removePaths, isInside, fsp };
