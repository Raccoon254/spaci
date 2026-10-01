'use strict';
/**
 * Hugging Face hub cache: one item per cached repo, plus one per older
 * revision when a repo holds more than one.
 *
 * Layout (huggingface_hub "Manage the cache"):
 *   <hub>/models--<org>--<name>/{blobs/<hash>, snapshots/<rev>/<files>, refs/<branch>}
 *   (datasets--..., spaces--... the same)
 * Snapshot files are symlinks into ../../blobs, so revisions share blobs.
 * <hub> is HF_HUB_CACHE, else HUGGINGFACE_HUB_CACHE, else <HF_HOME>/hub, where
 * HF_HOME defaults to $XDG_CACHE_HOME/huggingface or ~/.cache/huggingface.
 *
 * Deleting a revision follows huggingface_hub's DeleteCacheStrategy: remove
 * the snapshot folder and any ref pointing at it, then only the blobs no
 * remaining snapshot links to. Deleting a whole repo removes its folder.
 * MLX models (mlx-community/...) live here too and are labelled as such.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { listDir, lstatSafe, readText, allocated, pool, absEnv, isInside, dirSize } = require('./util');
const { makeGroup, makeItem } = require('./model');

const REPO_RE = /^(models|datasets|spaces)--(.+)$/;

function hubDir(ctx) {
  const { env = {}, home, platform } = ctx;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const direct = absEnv(env, 'HF_HUB_CACHE') || absEnv(env, 'HUGGINGFACE_HUB_CACHE');
  if (direct) return direct;
  const hfHome = absEnv(env, 'HF_HOME') || api.join(absEnv(env, 'XDG_CACHE_HOME') || api.join(platform === 'win32' ? (env.USERPROFILE || home) : home, '.cache'), 'huggingface');
  return api.join(hfHome, 'hub');
}

/** 'models--meta-llama--Llama-3.2-1B' -> { type: 'model', id: 'meta-llama/Llama-3.2-1B' } */
function parseRepoFolder(name) {
  const m = REPO_RE.exec(name);
  if (!m) return null;
  return { type: m[1].replace(/s$/, ''), id: m[2].split('--').join('/') };
}

/**
 * One repo: { dir, type, repoId, revisions: [{ rev, dir, refs, blobs:Set,
 * files, mtimeMs }], blobSizes: Map, size }.
 */
async function scanRepo(dir, folder) {
  const parsed = parseRepoFolder(folder);
  if (!parsed) return null;
  // Blobs keyed by their path relative to blobs/ (Xet stores nest them as
  // blobs/<prefix>/<hash> next to <hash>.refs manifests).
  const blobsDir = path.join(dir, 'blobs');
  const blobSizes = new Map();
  let xet = false;
  const walkBlobs = async (d, rel) => {
    for (const b of await listDir(d)) {
      const r = rel ? rel + '/' + b.name : b.name;
      if (b.isDirectory()) { xet = true; await walkBlobs(path.join(d, b.name), r); continue; }
      if (!b.isFile()) continue;
      if (b.name.endsWith('.refs')) xet = true;
      const st = await lstatSafe(path.join(d, b.name));
      if (st) blobSizes.set(r, allocated(st));
    }
  };
  await walkBlobs(blobsDir, '');
  const refs = new Map(); // rev -> [ref names]
  const refsRoot = path.join(dir, 'refs');
  const walkRefs = async (d, prefix) => {
    for (const e of await listDir(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walkRefs(full, prefix + e.name + '/'); continue; }
      const rev = String((await readText(full, 4096)) || '').trim();
      if (!/^[0-9a-f]{40}$/.test(rev)) continue;
      if (!refs.has(rev)) refs.set(rev, []);
      refs.get(rev).push(prefix + e.name);
    }
  };
  await walkRefs(refsRoot, '');
  const revisions = [];
  let looseBytes = 0; // real files in snapshots (no symlinks, e.g. Windows without Developer Mode)
  for (const s of await listDir(path.join(dir, 'snapshots'))) {
    if (!s.isDirectory()) continue;
    const snapDir = path.join(dir, 'snapshots', s.name);
    const blobs = new Set();
    let files = 0;
    let mtimeMs = 0;
    const stack = [snapDir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of await listDir(d)) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        files++;
        const st = await lstatSafe(full);
        if (st && st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        if (e.isSymbolicLink()) {
          let target = null;
          try { target = await fsp.readlink(full); } catch { target = null; }
          const resolved = target ? path.resolve(path.dirname(full), target) : null;
          if (resolved && isInside(blobsDir, resolved)) blobs.add(path.relative(blobsDir, resolved).split(path.sep).join('/'));
        } else if (st && st.isFile()) {
          looseBytes += allocated(st);
        }
      }
    }
    revisions.push({ rev: s.name, dir: snapDir, refs: refs.get(s.name) || [], blobs, files, mtimeMs });
  }
  revisions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const size = [...blobSizes.values()].reduce((a, b) => a + b, 0) + looseBytes;
  return { dir, folder, type: parsed.type, repoId: parsed.id, revisions, blobSizes, size, xet };
}

/** Bytes freed by deleting one revision: blobs only it links to. */
function revisionUniqueSize(repo, rev) {
  const others = new Set();
  for (const r of repo.revisions) if (r.rev !== rev.rev) for (const b of r.blobs) others.add(b);
  let bytes = 0;
  for (const b of rev.blobs) if (!others.has(b)) bytes += repo.blobSizes.get(b) || 0;
  return bytes;
}

/** Blob names to delete with a revision (never one another snapshot uses). */
function revisionBlobsToDelete(repo, rev) {
  const others = new Set();
  for (const r of repo.revisions) if (r.rev !== rev.rev) for (const b of r.blobs) others.add(b);
  return [...rev.blobs].filter((b) => !others.has(b));
}

function restoreFor(repo, rev) {
  const typeFlag = repo.type === 'model' ? '' : ' --repo-type ' + repo.type;
  return 'hf download ' + repo.repoId + typeFlag + (rev ? ' --revision ' + rev : '');
}

async function inventory(ctx) {
  const hub = hubDir(ctx);
  const st = await lstatSafe(hub);
  if (!st || !st.isDirectory()) return [];
  const folders = (await listDir(hub)).filter((d) => d.isDirectory() && REPO_RE.test(d.name)).map((d) => d.name);
  const repos = (await pool(folders, 4, (f) => scanRepo(path.join(hub, f), f))).filter(Boolean);
  const items = [];
  for (const repo of repos) {
    const mlx = /^mlx-community\//i.test(repo.repoId);
    const head = repo.revisions[0];
    items.push(makeItem({
      id: 'hf:' + repo.dir,
      group: 'huggingface',
      kind: 'model',
      label: repo.repoId,
      name: repo.repoId,
      detail: [repo.type === 'model' ? (mlx ? 'MLX model' : 'Model') : repo.type === 'dataset' ? 'Dataset' : 'Space',
        repo.revisions.length + (repo.revisions.length === 1 ? ' revision' : ' revisions'),
        head && head.refs.length ? head.refs.join(', ') : null].filter(Boolean).join(' · '),
      size: repo.size,
      modifiedAt: head ? head.mtimeMs : null,
      badges: mlx ? [{ text: 'MLX', kind: 'info' }] : [],
      restoreHint: restoreFor(repo, null),
      paths: [repo.dir],
      removal: { type: 'paths', root: hub, paths: [repo.dir] },
    }));
    // Xet-backed repos share chunks through .refs manifests Spaci does not
    // parse, so only the whole repo is offered there.
    if (repo.revisions.length > 1 && !repo.xet) {
      for (const rev of repo.revisions) {
        // Revisions a branch points at are what the libraries load; older,
        // detached ones are the usual leftovers.
        if (rev.refs.length) continue;
        items.push(makeItem({
          id: 'hf-rev:' + repo.dir + ':' + rev.rev,
          group: 'huggingface',
          kind: 'cache',
          label: repo.repoId + ' @ ' + rev.rev.slice(0, 8),
          name: repo.repoId,
          version: rev.rev,
          partOf: 'hf:' + repo.dir,
          detail: 'Older revision no branch points at',
          size: revisionUniqueSize(repo, rev),
          modifiedAt: rev.mtimeMs,
          restoreHint: restoreFor(repo, rev.rev),
          paths: [rev.dir],
          removal: { type: 'hf-revision', root: hub, repoDir: repo.dir, rev: rev.rev },
        }));
      }
    }
  }
  return [makeGroup({
    id: 'huggingface',
    section: 'ai',
    category: 'models',
    title: 'Hugging Face cache',
    brand: 'hugging-face',
    icon: 'ai-cube',
    roots: [hub],
    items: items.sort((a, b) => b.size - a.size),
    note: 'Models and datasets downloaded by transformers, diffusers, MLX and the hf CLI. Older revisions free only the files no newer revision uses.',
  })];
}

/** Delete one detached revision the way huggingface_hub does. */
async function removeRevision(item) {
  const r = item && item.removal;
  if (!r || r.type !== 'hf-revision' || !/^[0-9a-f]{40}$/.test(String(r.rev))) return { ok: false, freed: 0, code: 'invalid', error: 'Not a cache revision.' };
  if (!isInside(r.root, r.repoDir)) return { ok: false, freed: 0, code: 'invalid', error: 'Outside the cache.' };
  const repo = await scanRepo(r.repoDir, path.basename(r.repoDir));
  const rev = repo && repo.revisions.find((x) => x.rev === r.rev);
  if (!rev) return { ok: false, freed: 0, code: 'gone', error: 'This revision is no longer in the cache.' };
  if (rev.refs.length) return { ok: false, freed: 0, code: 'in-use', error: 'A branch now points at this revision, so Spaci left it alone.' };
  if (repo.xet) return { ok: false, freed: 0, code: 'unsupported', error: 'This repo uses Xet storage. Remove the whole repo, or use hf cache rm.' };
  const blobs = revisionBlobsToDelete(repo, rev);
  let freed = 0;
  try { await fsp.rm(rev.dir, { recursive: true, force: true }); } catch (e) { return { ok: false, freed: 0, code: e.code || 'failed', error: e.message }; }
  const blobsDir = path.join(r.repoDir, 'blobs');
  for (const b of blobs) {
    const file = path.join(blobsDir, ...b.split('/'));
    if (!isInside(blobsDir, file)) continue;
    const st = await lstatSafe(file);
    if (!st || !st.isFile()) continue;
    try { await fsp.unlink(file); freed += allocated(st); } catch { /* left for the next run */ }
  }
  return { ok: true, freed };
}

module.exports = { hubDir, parseRepoFolder, scanRepo, revisionUniqueSize, revisionBlobsToDelete, inventory, removeRevision, dirSize };
