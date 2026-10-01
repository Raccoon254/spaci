'use strict';
/**
 * Ollama models: detection, unique sizes, and safe removal.
 *
 * Store layout (docs/faq.md "Where are models stored?", server/manifest.go):
 *   <models>/manifests/<host>/<namespace>/<model>/<tag>   JSON manifest
 *   <models>/blobs/sha256-<hex>                           content blobs
 * <models> is OLLAMA_MODELS, else ~/.ollama/models (Linux service installs use
 * /usr/share/ollama/.ollama/models). A manifest names its blobs in
 * config.digest and layers[].digest as "sha256:<hex>"; on disk the colon is a
 * dash. Blobs are shared: two tags of one model, or a model and one built
 * FROM it, point at the same weights, so a model's "unique size" is the bytes
 * of the blobs no other manifest references. That is what deleting it frees.
 *
 * Removal, in order of preference:
 *   1. The server is up and serves this very manifest: DELETE /api/delete
 *      { model } (Ollama's own delete, which removes the manifest and prunes
 *      blobs nothing references). "This very manifest" means the sha256 of
 *      the manifest file equals the digest /api/tags reports for that name:
 *      the API deletes by name from the store the server uses, which is not
 *      necessarily the store the user picked (OLLAMA_MODELS for the server
 *      and a stale ~/.ollama/models, say). A copy the server does not serve
 *      is refused while it runs.
 *   2. No Ollama process at all: the same thing on disk, the way Ollama does
 *      it: remove the manifest, then delete only blobs that no remaining
 *      manifest references.
 *   3. An Ollama process runs but its API does not answer here: refuse. Spaci
 *      cannot tell what is loaded, so it does not touch the store.
 * A model that /api/ps lists as loaded is never deleted. An API delete that
 * should have freed bytes but freed none is reported as not done.
 */

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');
const { httpJson, listDir, lstatSafe, allocated, pool, absEnv, isInside } = require('./util');
const { runningState } = require('./processes');
const { makeGroup, makeItem } = require('./model');

const DEFAULT_REGISTRY = 'registry.ollama.ai';
const DEFAULT_NAMESPACE = 'library';
const DIGEST_RE = /^sha256[:-]([0-9a-f]{64})$/;
// The server process: `ollama serve`, the model runner it starts, or the
// desktop app's bundled server. The bare menu bar app alone does not count.
const OLLAMA_PROC_RE = /(^|[\\/])ollama(\.exe)?["']?\s+(serve|runner)\b|ollama_llama_server|(^|[\\/])ollama app(\.exe)?/i;

/** Every directory that may hold an Ollama store, most specific first. */
function storeDirs(ctx) {
  const { env = {}, home, platform } = ctx;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const custom = absEnv(env, 'OLLAMA_MODELS');
  if (custom) out.push(custom);
  out.push(api.join(platform === 'win32' ? (env.USERPROFILE || home) : home, '.ollama', 'models'));
  if (platform === 'linux') out.push('/usr/share/ollama/.ollama/models');
  return Array.from(new Set(out));
}

/** Base URL of the local server from OLLAMA_HOST (default 127.0.0.1:11434). */
function hostUrl(env = {}) {
  let raw = String(env.OLLAMA_HOST || '').trim();
  let scheme = 'http';
  const sm = /^(https?):\/\//i.exec(raw);
  if (sm) { scheme = sm[1].toLowerCase(); raw = raw.slice(sm[0].length); }
  raw = raw.replace(/\/.*$/, '');
  let host = raw;
  let port = '11434';
  const v6 = /^\[([^\]]*)\](?::(\d+))?$/.exec(raw);
  if (v6) { host = v6[1]; if (v6[2]) port = v6[2]; }
  else if (/^[^:]*:\d+$/.test(raw)) { [host, port] = raw.split(':'); }
  // A server listening on every interface is reached on loopback.
  if (!host || host === '0.0.0.0' || host === '::' || host === '*') host = '127.0.0.1';
  if (scheme !== 'http') return null; // Spaci only talks plain HTTP to loopback
  const h = host.includes(':') ? '[' + host + ']' : host;
  return 'http://' + h + ':' + port;
}

function blobFile(dir, digest) {
  const m = DIGEST_RE.exec(String(digest || ''));
  return m ? path.join(dir, 'blobs', 'sha256-' + m[1]) : null;
}

function normDigest(digest) {
  const m = DIGEST_RE.exec(String(digest || ''));
  return m ? 'sha256:' + m[1] : null;
}

/** The digests a manifest references, or null when it is not a manifest. */
function manifestDigests(json) {
  if (!json || typeof json !== 'object') return null;
  const list = [];
  if (json.config && json.config.digest) list.push(json.config.digest);
  for (const l of Array.isArray(json.layers) ? json.layers : []) if (l && l.digest) list.push(l.digest);
  const digests = list.map(normDigest);
  if (!digests.length || digests.some((d) => !d)) return null;
  return Array.from(new Set(digests));
}

/** The name `ollama list` prints for a manifest path. */
function displayName({ host, namespace, model, tag }) {
  if (host === DEFAULT_REGISTRY && namespace === DEFAULT_NAMESPACE) return `${model}:${tag}`;
  if (host === DEFAULT_REGISTRY) return `${namespace}/${model}:${tag}`;
  return `${host}/${namespace}/${model}:${tag}`;
}

/** Same name with ":latest" dropped where Ollama would accept it either way. */
function sameModel(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/^registry\.ollama\.ai\/(library\/)?/, '');
  const full = (s) => (/:[^/]+$/.test(n(s)) ? n(s) : n(s) + ':latest');
  return full(a) === full(b);
}

const MAX_MANIFEST = 1024 * 1024;
async function readManifestFile(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_MANIFEST) return null;
    return await fsp.readFile(file);
  } catch { return null; }
}

async function realOrSelf(p) { try { return await fsp.realpath(p); } catch { return p; } }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** A digest as bare lowercase hex ("sha256:abc" and "abc" are the same). */
function bareDigest(d) {
  const m = /^(?:sha256[:-])?([0-9a-f]{64})$/i.exec(String(d || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * The /api/tags entry that is this exact manifest: same name, and its digest
 * (the sha256 of the manifest file, as Ollama computes it) equals the file's.
 * Null when the server lists the name from another store, or not at all.
 */
function servedTag(tags, manifest) {
  if (!Array.isArray(tags) || !manifest || !manifest.sha) return null;
  return tags.find((t) => t && sameModel(t.name || t.model, manifest.name) && bareDigest(t.digest) === manifest.sha) || null;
}

const NOT_SERVED = 'A copy in a store the running Ollama does not use. Ollama would delete its own copy instead, so Spaci leaves this alone. Quit Ollama, then delete it here.';

/**
 * Every manifest under a store: [{ host, namespace, model, tag, file, name,
 * digests, mtimeMs }]. Manifests are exactly four levels deep.
 */
async function readManifests(dir) {
  const root = path.join(dir, 'manifests');
  const out = [];
  for (const h of await listDir(root)) {
    if (!h.isDirectory()) continue;
    for (const ns of await listDir(path.join(root, h.name))) {
      if (!ns.isDirectory()) continue;
      for (const m of await listDir(path.join(root, h.name, ns.name))) {
        if (!m.isDirectory()) continue;
        const tags = await listDir(path.join(root, h.name, ns.name, m.name));
        await pool(tags.filter((t) => t.isFile()), 8, async (t) => {
          const file = path.join(root, h.name, ns.name, m.name, t.name);
          const raw = await readManifestFile(file);
          if (!raw) return;
          let json = null;
          try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
          const digests = manifestDigests(json);
          if (!digests) return;
          const st = await lstatSafe(file);
          const rec = { host: h.name, namespace: ns.name, model: m.name, tag: t.name, file, digests, sha: sha256(raw), mtimeMs: st ? st.mtimeMs : 0 };
          rec.name = displayName(rec);
          out.push(rec);
        });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** How many manifests reference each digest. */
function refCounts(manifests) {
  const counts = new Map();
  for (const m of manifests) for (const d of m.digests) counts.set(d, (counts.get(d) || 0) + 1);
  return counts;
}

/**
 * Size of each manifest: total (all its blobs), unique (blobs only it
 * references, what deleting it frees) and shared.
 */
function computeSizes(manifests, blobSizes) {
  const counts = refCounts(manifests);
  return manifests.map((m) => {
    let total = 0;
    let unique = 0;
    for (const d of m.digests) {
      const b = blobSizes.get(d) || 0;
      total += b;
      if (counts.get(d) === 1) unique += b;
    }
    return { name: m.name, total, unique, shared: total - unique };
  });
}

/**
 * Blobs that may be deleted after removing `target` from `manifests`: those
 * it references that no other manifest does. A digest any remaining manifest
 * references is never in the list.
 */
function blobsToCollect(manifests, target) {
  const remaining = manifests.filter((m) => m.file !== target.file);
  const still = new Set();
  for (const m of remaining) for (const d of m.digests) still.add(d);
  return target.digests.filter((d) => !still.has(d));
}

async function blobSizesFor(dir, manifests) {
  const all = new Set();
  for (const m of manifests) for (const d of m.digests) all.add(d);
  const sizes = new Map();
  await pool([...all], 16, async (d) => {
    const st = await lstatSafe(blobFile(dir, d));
    sizes.set(d, st && st.isFile() ? allocated(st) : 0);
  });
  return sizes;
}

/**
 * The server's view: { state: 'running' | 'stopped' | 'unknown', tags, ps }.
 * 'unknown' means an Ollama process runs but its API did not answer here.
 */
async function serverState(ctx) {
  const base = hostUrl(ctx.env || {});
  const get = ctx.httpJson || httpJson;
  const proc = runningState(ctx.procs, OLLAMA_PROC_RE);
  if (base) {
    const tags = await get('GET', base + '/api/tags', null, { timeout: 2000 });
    if (tags.ok && tags.json && Array.isArray(tags.json.models)) {
      const ps = await get('GET', base + '/api/ps', null, { timeout: 2000 });
      if (ps.ok && ps.json && Array.isArray(ps.json.models)) return { state: 'running', base, tags: tags.json.models, ps: ps.json.models };
      return { state: 'unknown', base, tags: tags.json.models, ps: null, reason: 'Ollama answered, but would not say which models are loaded.' };
    }
  }
  if (proc === 'no') return { state: 'stopped', base, tags: null, ps: null };
  return {
    state: 'unknown', base, tags: null, ps: null,
    reason: proc === 'yes' ? 'Ollama is running, but its API did not answer at ' + (base || 'OLLAMA_HOST') + '.' : 'Spaci could not check whether Ollama is running.',
  };
}

function fmtDetail(details) {
  if (!details) return '';
  return [details.parameter_size, details.quantization_level, details.family].filter(Boolean).join(' · ');
}

async function inventory(ctx) {
  const server = await serverState(ctx);
  const groups = [];
  const dirs = storeDirs(ctx);
  let firstDir = null;
  const items = [];
  const seenReal = new Set();
  for (const dir of dirs) {
    const st = await lstatSafe(path.join(dir, 'manifests'));
    if (!st || !st.isDirectory()) continue;
    // The same store reached twice (OLLAMA_MODELS symlinked to the default)
    // is listed once.
    let real = dir;
    try { real = await fsp.realpath(dir); } catch { real = dir; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    if (!firstDir) firstDir = dir;
    const manifests = await readManifests(dir);
    const sizes = await blobSizesFor(dir, manifests);
    const computed = computeSizes(manifests, sizes);
    for (let i = 0; i < manifests.length; i++) {
      const m = manifests[i];
      const sz = computed[i];
      const tag = servedTag(server.tags, m);
      const notServed = server.state === 'running' && !tag;
      const loaded = !notServed && server.ps ? server.ps.find((p) => sameModel(p.name || p.model, m.name)) : null;
      const details = tag && tag.details;
      let blocked = null;
      let state = 'idle';
      const badges = [];
      if (loaded) {
        state = 'running';
        blocked = 'Loaded in Ollama right now. Unload it first (ollama stop ' + m.name + '), then delete.';
        badges.push({ text: 'Loaded', kind: 'running' });
      } else if (server.state === 'unknown') {
        blocked = server.reason || 'Spaci could not check whether this model is loaded.';
        badges.push({ text: 'Not checked', kind: 'unknown' });
      } else if (notServed) {
        blocked = NOT_SERVED;
        badges.push({ text: 'Other store', kind: 'info' });
      }
      if (sz.shared > 0) badges.push({ text: 'Shares ' + Math.round((sz.shared / Math.max(1, sz.total)) * 100) + '% with other models', kind: 'info' });
      items.push(makeItem({
        id: 'ollama:' + dir + ':' + m.name,
        group: 'ollama',
        kind: 'model',
        label: m.name,
        name: m.model,
        version: m.tag,
        detail: fmtDetail(details) || (m.host === DEFAULT_REGISTRY ? '' : m.host),
        params: details ? details.parameter_size || null : null,
        quant: details ? details.quantization_level || null : null,
        family: details ? details.family || null : null,
        format: details ? details.format || null : null,
        size: sz.unique,
        totalSize: sz.total,
        sharedSize: sz.shared,
        modifiedAt: tag && tag.modified_at ? Date.parse(tag.modified_at) || m.mtimeMs : m.mtimeMs,
        lastUsedAt: loaded ? Date.now() : null,
        vram: loaded && Number(loaded.size_vram) ? Number(loaded.size_vram) : null,
        state,
        blocked,
        badges,
        restoreHint: 'ollama pull ' + m.name,
        paths: [m.file],
        removal: { type: 'ollama', store: dir, name: m.name, file: m.file },
      }));
    }
  }
  if (!firstDir && server.state !== 'running') return groups;
  const label = { running: 'Server running', stopped: 'Server stopped', unknown: 'Server not answering' }[server.state];
  groups.push(makeGroup({
    id: 'ollama',
    section: 'ai',
    category: 'models',
    title: 'Ollama',
    brand: 'ollama',
    icon: 'ai-cube',
    roots: firstDir ? [firstDir] : [],
    server: { state: server.state, label },
    items: items.sort((a, b) => b.size - a.size),
    note: 'Sizes are what deleting each model frees. Weights shared with another model stay until the last model using them is removed.',
  }));
  return groups;
}

/**
 * Remove one model. Re-checks the server and the store right now; refuses a
 * loaded model or an unknown server state. Returns { ok, freed, error, code }.
 */
async function remove(item, ctx) {
  const r = item && item.removal;
  if (!r || r.type !== 'ollama' || typeof r.name !== 'string' || typeof r.store !== 'string') return { ok: false, freed: 0, code: 'invalid', error: 'Not an Ollama model.' };
  const server = await serverState(ctx);
  const manifests = await readManifests(r.store);
  const target = manifests.find((m) => m.file === r.file && m.name === r.name);
  if (!target) return { ok: false, freed: 0, code: 'gone', error: 'This model is no longer in the Ollama store. Check again.' };
  if (server.ps && server.ps.some((p) => sameModel(p.name || p.model, r.name))) {
    return { ok: false, freed: 0, code: 'running', error: r.name + ' is loaded in Ollama. Unload it (ollama stop ' + r.name + '), then delete.' };
  }
  const sizes = await blobSizesFor(r.store, manifests);
  const collect = blobsToCollect(manifests, target);
  const expected = collect.reduce((a, d) => a + (sizes.get(d) || 0), 0);

  if (server.state === 'running') {
    // The API deletes by name from the server's own store. Use it only when
    // that store holds exactly this manifest.
    if (!servedTag(server.tags, target)) return { ok: false, freed: 0, code: 'not-served', error: NOT_SERVED };
    const del = ctx.httpJson || httpJson;
    let res = await del('DELETE', server.base + '/api/delete', { model: r.name }, { timeout: 30000 });
    // Older servers take { name } instead of { model }.
    if (!res.ok && res.status === 400) res = await del('DELETE', server.base + '/api/delete', { name: r.name }, { timeout: 30000 });
    if (!res.ok) return { ok: false, freed: 0, code: 'failed', error: 'Ollama did not delete ' + r.name + ' (HTTP ' + (res.status || res.error) + ').' };
    // Ollama prunes the blobs itself; count only what is really gone.
    let freed = 0;
    for (const d of collect) if (!(await lstatSafe(blobFile(r.store, d)))) freed += sizes.get(d) || 0;
    if (await lstatSafe(target.file)) return { ok: false, freed, code: 'partial', error: 'Ollama answered, but ' + r.name + ' is still in this store.', expected };
    if (expected > 0 && freed === 0) return { ok: false, freed: 0, code: 'partial', error: 'Ollama removed ' + r.name + ' from its list, but none of its files were freed here.', expected };
    return { ok: true, freed, via: 'api', expected };
  }
  if (server.state !== 'stopped') {
    return { ok: false, freed: 0, code: 'unknown-state', error: server.reason || 'Spaci could not check whether Ollama is using this model, so it left it alone.' };
  }
  let others = [];
  try { others = storeDirs(ctx); } catch { others = []; }
  return removeOnDisk(r.store, target, manifests, sizes, others);
}

/**
 * The on-disk delete, used only when no Ollama process runs: unlink the
 * manifest, then each blob nothing else references (recomputed from a fresh
 * read of every manifest), then empty manifest folders.
 */
async function removeOnDisk(store, target, manifests, sizes, allStores = []) {
  const manifestsRoot = path.join(store, 'manifests');
  if (!isInside(manifestsRoot, target.file)) return { ok: false, freed: 0, code: 'invalid', error: 'Manifest outside the store.' };
  try { await fsp.unlink(target.file); } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, freed: 0, code: e.code || 'failed', error: 'Could not remove the manifest: ' + e.message };
  }
  // Re-read after the unlink, so a manifest that appeared meanwhile still
  // protects its blobs. Another store whose blobs folder is really this one
  // (a symlink) counts as well: its manifests name the same files.
  const still = new Set();
  const realBlobs = await realOrSelf(path.join(store, 'blobs'));
  for (const dir of Array.from(new Set([store, ...allStores]))) {
    if (dir !== store && (await realOrSelf(path.join(dir, 'blobs'))) !== realBlobs) continue;
    for (const m of await readManifests(dir)) for (const d of m.digests) still.add(d);
  }
  let freed = 0;
  const errors = [];
  for (const d of target.digests) {
    if (still.has(d)) continue;
    const file = blobFile(store, d);
    if (!file || !isInside(path.join(store, 'blobs'), file)) continue;
    const st = await lstatSafe(file);
    if (!st || !st.isFile()) continue;
    try { await fsp.unlink(file); freed += allocated(st); } catch (e) { if (e.code !== 'ENOENT') errors.push(e.message); }
  }
  // Drop now-empty tag/model/namespace folders, never the manifests root.
  let dir = path.dirname(target.file);
  while (isInside(manifestsRoot, dir)) {
    try { await fsp.rmdir(dir); } catch { break; }
    dir = path.dirname(dir);
  }
  if (errors.length) return { ok: false, freed, code: 'partial', error: 'Some files could not be removed: ' + errors[0] };
  return { ok: true, freed, via: 'disk', expected: target.digests.filter((d) => !still.has(d)).reduce((a, d) => a + (sizes.get(d) || 0), 0) };
}

module.exports = {
  storeDirs, hostUrl, blobFile, manifestDigests, displayName, sameModel, readManifests, refCounts,
  computeSizes, blobsToCollect, serverState, inventory, remove, removeOnDisk, servedTag, bareDigest, OLLAMA_PROC_RE,
};
