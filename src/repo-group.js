'use strict';
/**
 * One record per git repository.
 *
 * The scanner's walk finds every folder with a project marker. Inside a
 * monorepo without a root marker that is each package, and every linked
 * worktree repeats the set, so one repository used to show up dozens of times.
 * consolidate() folds those raw records into one record per repository:
 *   - packages (marker folders inside one checkout) become `repo.packages`;
 *   - linked worktrees become `repo.worktrees`, grouped under their main
 *     repository even when it lies outside the scan root, and a worktree made
 *     from another worktree resolves to the real main;
 *   - submodules and nested repositories stay records of their own;
 *   - every artifact item keeps its own path, so cleaning, tiers and the guard
 *     work exactly as before. Items are tagged with the checkout and package
 *     they belong to, and no item is counted twice.
 *
 * A folder only joins the checkout above it when git tracks something inside
 * it, so a dotfiles repository at ~ that ignores everything does not swallow
 * every project under the home folder.
 */
const path = require('path');
const wtx = require('./worktrees');
const { projectFigures } = require('./reclaimable');
const { summarizeRepo, dropWorktrees } = require('./repo-summary');

const GIT_ARGV_BYTES = process.platform === 'win32' ? 24 * 1024 : 96 * 1024;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const toPosix = (p) => String(p || '').split(path.sep).join('/');
const fold = (s) => (process.platform === 'linux' ? s : s.toLowerCase());

/** Which of `rels` (repo-relative folders) hold at least one file git tracks. */
async function trackedFolders(top, rels, signal) {
  const specs = rels.map((r) => `:(literal)${r.normalize('NFC')}`);
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const s of specs) {
    const len = Buffer.byteLength(s) + 1;
    if (chunk.length && bytes + len > GIT_ARGV_BYTES) { chunks.push(chunk); chunk = []; bytes = 0; }
    chunk.push(s);
    bytes += len;
  }
  if (chunk.length) chunks.push(chunk);
  const want = new Map(rels.map((r) => [fold(r.normalize('NFC')), r]));
  const hit = new Set();
  for (const c of chunks) {
    const res = await wtx.runGit(top, ['ls-files', '-z', '--full-name', '--', ...c], { signal });
    if (res.err) return null;
    for (const f of res.stdout.split('\0')) {
      if (!f) continue;
      let p = fold(f.normalize('NFC'));
      for (;;) {
        const k = p.lastIndexOf('/');
        if (k < 0) break;
        p = p.slice(0, k);
        if (want.has(p)) hit.add(want.get(p));
      }
    }
  }
  return hit;
}

function mergeTypes(members) {
  const byId = new Map();
  for (const m of members) {
    for (const t of Array.isArray(m.types) ? m.types : []) {
      if (!t || !t.id) continue;
      const cur = byId.get(t.id);
      if (!cur || (t.score || 0) > (cur.score || 0)) byId.set(t.id, t);
    }
  }
  return [...byId.values()].sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.name).localeCompare(String(b.name)));
}

/** The package (longest matching folder) an item belongs to, as a repo-relative path. */
function packageOf(relItem, pkgRels) {
  let best = '';
  for (const r of pkgRels) {
    if (r && (relItem === r || relItem.startsWith(r + '/')) && r.length > best.length) best = r;
  }
  return best;
}

const bytes = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Build one repository record. Pure apart from its inputs.
 * @param {object} g  { mainRoot, checkouts: [{ root, kind, members: [raw project] }] }
 * @param {object|null} desc  describeRepo() result, or null when the repo has no linked worktrees
 * @param {object} ctx  { rootKey, seenKeys: Set<pathKey>, mainSize: number|null }
 */
function buildRecord(g, desc, ctx = {}) {
  const mainKey = wtx.pathKey(g.mainRoot);
  const checkouts = g.checkouts.slice().sort((a, b) => (wtx.pathKey(a.root) === mainKey ? -1 : wtx.pathKey(b.root) === mainKey ? 1 : 0));
  const mainCo = checkouts.find((c) => wtx.pathKey(c.root) === mainKey) || null;
  // Packages are listed from the main checkout, or, when it was not scanned,
  // from the checkout with the most of them.
  const refCo = mainCo && mainCo.members.length ? mainCo
    : checkouts.slice().sort((a, b) => b.members.length - a.members.length)[0] || null;

  const allMembers = checkouts.flatMap((c) => c.members);
  const rootMember = mainCo ? mainCo.members.find((m) => wtx.pathKey(m.path) === mainKey) : null;
  const base = rootMember || allMembers[0] || null;

  // Packages of the reference checkout: member folders below its root, plus
  // marker folders the artifact walk saw inside a member.
  const pkgMap = new Map();
  if (refCo) {
    const refKey = wtx.pathKey(refCo.root);
    const add = (absPath, types) => {
      const k = wtx.pathKey(absPath);
      if (k === refKey || pkgMap.has(k)) return;
      const rel = toPosix(path.relative(refCo.root, absPath));
      if (!rel || rel.startsWith('..')) return;
      const t = (Array.isArray(types) && types[0]) || null;
      pkgMap.set(k, { name: path.basename(absPath), rel, path: absPath, type: t ? { id: t.id, name: t.name, icon: t.icon } : null, cleanableSize: 0, unverifiedSize: 0, items: 0 });
    };
    for (const m of refCo.members) {
      add(m.path, m.types);
      for (const sp of Array.isArray(m.subPackages) ? m.subPackages : []) add(sp.path, sp.types);
    }
  }
  const packages = [...pkgMap.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  const pkgRels = packages.map((p) => p.rel);

  // Items, tagged and de-duplicated.
  const seenItems = new Set();
  const items = [];
  const linkedKeys = new Set();
  for (const c of checkouts) {
    const isMain = wtx.pathKey(c.root) === mainKey;
    if (!isMain) linkedKeys.add(wtx.pathKey(c.root));
    for (const m of c.members) {
      for (const it of Array.isArray(m.items) ? m.items : []) {
        if (!it || typeof it.path !== 'string') continue;
        const k = wtx.pathKey(it.path);
        if (seenItems.has(k)) continue;
        seenItems.add(k);
        const rel = toPosix(path.relative(c.root, it.path));
        const tagged = { ...it, checkout: c.root, pkg: packageOf(rel, pkgRels) };
        if (!isMain) tagged.worktree = true;
        items.push(tagged);
      }
    }
  }
  items.sort((a, b) => (b.size || 0) - (a.size || 0));
  const figures = projectFigures(items);
  // Package figures count the reference checkout only.
  if (refCo) {
    const refKey = wtx.pathKey(refCo.root);
    for (const it of items) {
      if (!it.pkg || wtx.pathKey(it.checkout) !== refKey) continue;
      const p = packages.find((x) => x.rel === it.pkg);
      if (!p) continue;
      p.items++;
      if (it.safe === true) p.cleanableSize += bytes(it.size);
      else p.unverifiedSize += bytes(it.size);
    }
  }

  // Worktrees: git's list is the truth; folders git no longer lists are orphans.
  const worktrees = [];
  const listed = new Set();
  for (const w of (desc && Array.isArray(desc.worktrees)) ? desc.worktrees : []) {
    const k = wtx.pathKey(w.path);
    listed.add(k);
    worktrees.push({ ...w });
  }
  for (const c of checkouts) {
    const k = wtx.pathKey(c.root);
    if (k === mainKey || c.kind !== 'worktree' || listed.has(k)) continue;
    const wt = {
      path: c.root, head: null, branch: null, detached: false, locked: false, lockReason: '', prunable: false,
      exists: true, orphan: !desc || !desc.error, changes: 0, untracked: 0, ignoredOther: [], upstream: null, ahead: null, behind: null,
      pushed: false, merged: null, lastCommit: null, lastActivity: null, size: null,
      error: desc && desc.error ? 'Spaci could not list this repository\'s worktrees.' : null,
      creator: wtx.likelyCreator(c.root, null),
    };
    worktrees.push(wt);
  }
  const seenKeys = ctx.seenKeys instanceof Set ? ctx.seenKeys : new Set();
  const rootKey = ctx.rootKey || null;
  for (const w of worktrees) {
    const k = wtx.pathKey(w.path);
    w.nested = wtx.isInsideKey(mainKey, k);
    w.inScan = rootKey ? (k === rootKey || wtx.isInsideKey(rootKey, k)) : true;
    // Anything else with its own .git inside this worktree: removing it would
    // take that repository or worktree with it.
    if (!w.nestedCheckout) {
      for (const s of seenKeys) { if (wtx.isInsideKey(k, s)) { w.nestedCheckout = true; break; } }
      if (!w.nestedCheckout) for (const o of worktrees) { if (o !== w && wtx.isInsideKey(k, wtx.pathKey(o.path))) { w.nestedCheckout = true; break; } }
    }
    // Build output inside it, which "Clean all developer files" already covers.
    let safeBytes = 0;
    let otherBytes = 0;
    for (const it of items) {
      if (wtx.pathKey(it.checkout) !== k) continue;
      if (it.safe === true) safeBytes += bytes(it.size); else otherBytes += bytes(it.size);
    }
    w.artifactBytes = safeBytes;
    w.unverifiedBytes = otherBytes;
    w.eligibility = wtx.removalEligibility(w);
  }
  worktrees.sort((a, b) => (b.size || 0) - (a.size || 0) || String(a.path).localeCompare(String(b.path)));
  // Items name their worktree by the same path string the worktree list uses,
  // so later updates can match them without resolving real paths again.
  const wtByKey = new Map(worktrees.map((w) => [wtx.pathKey(w.path), w.path]));
  for (const it of items) { const p = wtByKey.get(wtx.pathKey(it.checkout)); if (p) it.checkout = p; }
  const mainSize = typeof ctx.mainSize === 'number' && ctx.mainSize >= 0 ? ctx.mainSize : null;

  const types = mergeTypes(allMembers);
  const type = (rootMember && rootMember.type) || types[0] || (base && base.type) || { id: 'git', name: 'Git', icon: 'branch' };
  const best = allMembers.slice().sort((a, b) => (b.cleanableSize || 0) - (a.cleanableSize || 0));
  const withDocker = allMembers.filter((m) => m.docker);
  const isBare = Boolean(desc && desc.main && desc.main.bare) || /\.git$/i.test(g.mainRoot);

  const record = {
    name: path.basename(g.mainRoot).replace(isBare ? /\.git$/i : /$^/, '') || path.basename(g.mainRoot),
    path: g.mainRoot,
    type: { id: type.id, name: type.name, icon: type.icon },
    types,
    items,
    cleanableSize: figures.cleanableSize,
    unverifiedSize: figures.unverifiedSize,
    totalSize: 0,
    mtime: Math.max(0, ...allMembers.map((m) => m.mtime || 0)),
    git: null,
    isGit: true,
    iconPath: (base && base.iconPath) || (best.find((m) => m.iconPath) || {}).iconPath || null,
    primary: (rootMember && rootMember.primary) || (best.find((m) => m.primary) || {}).primary || null,
    docker: (rootMember && rootMember.docker) || (withDocker[0] && withDocker[0].docker) || null,
    repo: {
      main: g.mainRoot,
      mainExists: Boolean(mainCo) || Boolean(ctx.mainExists),
      mainInScan: rootKey ? (mainKey === rootKey || wtx.isInsideKey(rootKey, mainKey)) : true,
      bare: isBare,
      defaultBranch: (desc && desc.defaultBranch) || null,
      listError: (desc && desc.error) || null,
      packages,
      worktrees,
      // du of the main folder; it already counts worktrees nested inside it.
      mainDu: mainSize,
    },
  };
  summarizeRepo(record);
  const dockerDirs = withDocker.map((m) => m.path).filter((p) => p !== record.path);
  if (dockerDirs.length) record.dockerDirs = dockerDirs;
  if (allMembers.length && allMembers.every((m) => m.dockerOnly) && !worktrees.length) record.dockerOnly = true;
  return record;
}

/**
 * Fold raw scan records into one record per repository.
 * @param {object[]} raw  buildProject / dockerShellProject records
 * @param {object} ctx  { root, signal, dirSize, checkouts: string[] (folders with a .git entry seen by the walk) }
 * @returns {Promise<{ projects: object[], stats: object }>}
 */
async function consolidate(raw, ctx = {}) {
  const signal = ctx.signal;
  const memo = new Map();
  const list = Array.isArray(raw) ? raw : [];

  // 1. The checkout holding each record.
  const placed = await mapPool(list, 16, async (p) => ({ p, co: await wtx.findCheckout(p.path, memo).catch(() => null) }));

  // 2. A folder below a checkout's root joins it only if git tracks something in it.
  const below = new Map();
  for (const m of placed) {
    if (!m.co) continue;
    if (wtx.pathKey(m.co.root) === wtx.pathKey(m.p.path)) continue;
    const k = wtx.pathKey(m.co.root);
    if (!below.has(k)) below.set(k, { co: m.co, list: [] });
    below.get(k).list.push(m);
  }
  await mapPool([...below.values()], 6, async ({ co, list: ms }) => {
    const rels = ms.map((m) => toPosix(path.relative(co.root, m.p.path)));
    const tracked = await trackedFolders(co.root, rels, signal);
    ms.forEach((m, i) => { if (!tracked || !tracked.has(rels[i])) m.co = null; });
  });

  // 3. Group by repository (a worktree joins its main).
  const groups = new Map();
  const standalone = [];
  const groupFor = (co) => {
    const mainRoot = co.kind === 'worktree' ? co.mainRoot : co.root;
    const key = wtx.pathKey(mainRoot);
    if (!groups.has(key)) groups.set(key, { key, mainRoot, commonDir: co.commonDir, anyRoot: co.root, checkouts: new Map() });
    const g = groups.get(key);
    const ck = wtx.pathKey(co.root);
    if (!g.checkouts.has(ck)) g.checkouts.set(ck, { root: co.root, kind: co.kind, members: [] });
    if (co.kind !== 'worktree') g.anyRoot = co.root;
    return g.checkouts.get(ck);
  };
  for (const m of placed) {
    if (!m.co) { standalone.push(m.p); continue; }
    groupFor(m.co).members.push(m.p);
  }

  // Checkouts the walk saw without a project in them still anchor a group
  // when their repository has linked worktrees (a main repo with no marker).
  const seenKeys = new Set();
  for (const dir of Array.isArray(ctx.checkouts) ? ctx.checkouts : []) {
    const co = await wtx.readGitEntry(dir).catch(() => null);
    if (!co) continue;
    seenKeys.add(wtx.pathKey(co.root));
    const mainRoot = co.kind === 'worktree' ? co.mainRoot : co.root;
    if (groups.has(wtx.pathKey(mainRoot))) { groupFor(co); continue; }
    if ((co.kind === 'main' || co.kind === 'worktree') && await wtx.hasLinkedWorktrees(co.commonDir)) groupFor(co);
  }

  // 4. Describe repositories that have linked worktrees, and size their main.
  const glist = [...groups.values()];
  const withLinked = await mapPool(glist, 8, (g) => wtx.hasLinkedWorktrees(g.commonDir));
  const rootKey = ctx.root ? wtx.pathKey(ctx.root) : null;
  const descs = new Array(glist.length).fill(null);
  const mainSizes = new Array(glist.length).fill(null);
  const mainExists = new Array(glist.length).fill(false);
  await mapPool(glist.map((g, i) => i).filter((i) => withLinked[i]), 4, async (i) => {
    if (signal && signal.aborted) return;
    const g = glist[i];
    const main = await wtx.readGitEntry(g.mainRoot).catch(() => null);
    mainExists[i] = Boolean(main);
    const cwd = main ? g.mainRoot : g.anyRoot;
    descs[i] = await wtx.describeRepo(cwd, { signal, dirSize: ctx.dirSize, measure: ctx.measure });
    // The main folder's own size is the expensive part (a whole repository),
    // so a scan leaves it to enrichment unless asked (tests, reports).
    if (main && ctx.measureMain === true && typeof ctx.dirSize === 'function' && ctx.measure !== false) {
      try { mainSizes[i] = await ctx.dirSize(g.mainRoot, signal); } catch { mainSizes[i] = null; }
    }
  });

  // 5. Records.
  const projects = [];
  let worktreeCount = 0;
  glist.forEach((g, i) => {
    const rec = buildRecord({ mainRoot: g.mainRoot, checkouts: [...g.checkouts.values()] }, descs[i], {
      rootKey, seenKeys, mainSize: mainSizes[i], mainExists: mainExists[i],
    });
    worktreeCount += rec.repo.worktrees.length;
    projects.push(rec);
  });
  projects.push(...standalone);
  return {
    projects,
    stats: { raw: list.length, repos: glist.length, standalone: standalone.length, worktrees: worktreeCount },
  };
}

module.exports = { consolidate, buildRecord, summarizeRepo, dropWorktrees, trackedFolders, packageOf, mergeTypes };
