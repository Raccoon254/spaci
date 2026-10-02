'use strict';
// The scan worker's dispatch logic: every operation that walks the disk or
// spawns processes (git, du, docker, pgrep) runs here, in a separate process,
// never on Electron's main thread. Spawning from Electron's large main process
// is synchronous and expensive; a background scan used to freeze the window for
// seconds and hold up Quit.
//
// Protocol (messages are structured-clone safe):
//   main -> worker  { id, op, args, progress? }   run op(...args)
//   main -> worker  { id, abort: true }           abort that op's AbortController
//   worker -> main  { id, progress }              progress event for that op
//   worker -> main  { id, ok: true, result }      op finished
//   worker -> main  { id, ok: false, error }      op failed ({ message, name, code })
//
// Pure: the transport (`send`) and the scan modules are injected, so node
// --test covers the dispatch without Electron. startWorker() attaches it to the
// real parent channel (Electron utilityProcess parentPort, or a
// child_process.fork IPC channel in tests).

const { dockerFigures } = require('./reclaimable');
const { specFor: nativeSpecFor } = require('./native-cleanup-specs');
const { keyOf } = require('./clean-guard');

// Loaded lazily so a test that injects every module never loads the real ones.
const LOADERS = {
  scanner: () => require('./scanner'),
  system: () => require('./system'),
  docker: () => require('./docker'),
  diskbreakdown: () => require('./diskbreakdown'),
  largefiles: () => require('./largefiles'),
  aitools: () => require('./aitools'),
  worktrees: () => require('./worktrees'),
  // ---- ai models and dev tools ----
  devtools: () => require('./devtools'),
  cleaner: () => require('./cleaner'),
  // ---- end ai models and dev tools ----
  native: () => require('./native-cleanup'),
};

/**
 * Docker functions callable by name through the generic 'docker' op, mapped to
 * the index of their options argument (-1: none). When the caller asked for
 * progress, the worker puts `onProgress` into that options object. Anything
 * not listed here is refused.
 */
const DOCKER_ALLOWLIST = Object.freeze({
  status: 0,
  runningContainers: 0,
  inventory: 0,
  prune: 1,
  desktopDisk: -1,
  composeServices: -1,
  resetCache: -1,
  listVolumes: 0,
  removeVolume: 1,
  restartDesktop: 0,
});

// Scan-time language analysis: one `git ls-tree` per repo (a bounded lstat
// walk that skips node_modules and other vendored folders otherwise), reused by
// scanner.analyzeTech's per-process cache while HEAD and manifests are
// unchanged. Bounded per project and for the whole pass, so a machine full of
// non-git folders cannot stretch a scan.
const LANG_CONCURRENCY = 6;
const LANG_BUDGET_MS = 1000;
const LANG_PASS_MS = 60 * 1000;

function serializeError(e) {
  if (e && typeof e === 'object') {
    return { message: String(e.message || e), name: e.name || 'Error', code: e.code || null };
  }
  return { message: String(e), name: 'Error', code: null };
}

function unknownOp(op) {
  const e = new Error('Unknown scan worker operation: ' + op);
  e.code = 'EUNKNOWNOP';
  return e;
}

async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Attach `languages` and `primary` to every scanned project, in place. */
async function attachLanguages(scanner, projects, signal, { now = Date.now, passMs = LANG_PASS_MS } = {}) {
  if (!scanner || typeof scanner.analyzeTech !== 'function' || !Array.isArray(projects)) return 0;
  const deadline = now() + passMs;
  let done = 0;
  await pool(projects, LANG_CONCURRENCY, async (p) => {
    if (!p || typeof p.path !== 'string' || signal?.aborted || now() >= deadline) return;
    let tech = null;
    try { tech = await scanner.analyzeTech(p.path, signal, { budgetMs: LANG_BUDGET_MS }); } catch { tech = null; }
    if (!tech) return;
    if (Array.isArray(tech.languages) && tech.languages.length) p.languages = tech.languages;
    if (tech.primary) p.primary = tech.primary;
    done++;
  });
  return done;
}

/**
 * The Docker card summary for a scan plus per-project attribution. `stubs` are
 * { path, docker } for each scanned project; the reply lists, by index, the
 * docker record each project should carry. Heavy inventory lists never leave
 * the worker.
 */
/** reclaimSuggestions without the heavy fields, and never throwing. */
function safeSuggestions(docker, info) {
  try {
    const list = docker.reclaimSuggestions(info);
    return Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : undefined;
  } catch (_) { return undefined; }
}

async function dockerSummary(mod, stubs, options = {}) {
  const scanner = mod('scanner');
  const docker = mod('docker');
  const list = (Array.isArray(stubs) ? stubs : []).map((s) => ({ path: s && s.path, docker: (s && s.docker) || null }));
  let summary;
  try {
    const { inventory } = await scanner.attachDockerUsage(list, options || {});
    const disk = await docker.desktopDisk();
    summary = inventory && inventory.ok
      ? {
        ok: true,
        approximate: Boolean(inventory.approximate),
        status: inventory.status,
        categories: inventory.categories,
        totals: inventory.totals,
        // What Spaci's prunes can free (no volumes, no containers), and the
        // suggestions sized from per-image detail that never leaves the worker.
        cleanable: dockerFigures(inventory.categories, inventory.images),
        suggestions: typeof docker.reclaimSuggestions === 'function' ? safeSuggestions(docker, { ...inventory, desktopDisk: disk }) : undefined,
        desktopDisk: disk,
        projects: list.filter((p) => p.docker && p.docker.usage).length,
        at: Date.now(),
      }
      // Keep the disk image size and engine state on failure too: when Docker
      // Desktop is up but its engine is down, the disk image is still the
      // biggest thing Spaci can explain to the user.
      : { ok: false, reason: inventory ? inventory.reason : 'unavailable', status: inventory ? inventory.status : null, state: inventory ? inventory.state : null, desktopDisk: disk, at: Date.now() };
  } catch (e) {
    summary = { ok: false, reason: 'error', error: e && e.message, at: Date.now() };
  }
  const attached = [];
  list.forEach((s, index) => { if (s.docker && s.docker.usage) attached.push({ index, docker: s.docker }); });
  return { summary, attached };
}

/**
 * Every Docker volume plus the per-project grouping, in one worker round trip.
 * The status travels with it so main can tell "no volumes" from "no engine".
 */
async function dockerVolumes(mod, options = {}) {
  const docker = mod('docker');
  const status = await docker.status({ force: Boolean(options && options.force) });
  if (!status || !status.running || status.remote) return { status, volumes: [], groups: [] };
  const volumes = await docker.listVolumes({ status });
  const groups = docker.groupVolumesByProject(volumes).map((g) => ({ key: g.key, project: g.project, volumes: g.volumes.map((v) => v.name) }));
  return { status, volumes, groups };
}

/** A cache target from this process's catalog that has a native cleanup spec. */
function nativeTarget(mod, id) {
  const spec = nativeSpecFor(id);
  const target = spec ? (mod('system').TARGETS || []).find((t) => t && t.id === id) : null;
  if (!target) throw unknownOp('nativeClean.' + String(id));
  return target;
}

function buildOps(mod) {
  return {
    ping: async () => ({ pid: process.pid, at: Date.now() }),

    scanProjects: async (ctx, root, opts = {}) => {
      const scanner = mod('scanner');
      // A new worker starts with an empty analysis cache; main hands back the
      // snapshot it kept from the last scan so unchanged projects are not
      // analysed again.
      if (opts && Array.isArray(opts.techSeed) && typeof scanner.importTechCache === 'function') {
        try { scanner.importTechCache(opts.techSeed); } catch (_) { /* a bad seed only costs a re-analysis */ }
      }
      const res = await scanner.scanProjects(root, ctx.progress, ctx.signal);
      if (res && opts && opts.languages !== false && !ctx.signal.aborted) {
        await attachLanguages(scanner, res.projects, ctx.signal);
      }
      if (res && typeof scanner.exportTechCache === 'function') {
        try { res.techCache = scanner.exportTechCache(); } catch (_) { /* optional */ }
      }
      return res;
    },
    dockerSummary: (ctx, stubs, options) => dockerSummary(mod, stubs, options),
    dockerVolumes: (ctx, options) => dockerVolumes(mod, options),
    enrichProject: (ctx, dir) => mod('scanner').enrichProject(dir, ctx.signal),
    revalidateArtifact: (ctx, absPath) => mod('scanner').revalidateArtifact(absPath),

    scanSystem: (ctx) => mod('system').scanSystem(ctx.progress, ctx.signal),

    // Storage breakdown (os-storage): progress snapshots while measuring, when asked for.
    diskBreakdown: (ctx, home) => mod('diskbreakdown').diskBreakdown(home, { onProgress: ctx.progress || undefined, signal: ctx.signal }),
    topChildren: (ctx, dirs, limit, exclude) => mod('diskbreakdown').topChildren(Array.isArray(dirs) ? dirs : [], limit, undefined, Array.isArray(exclude) ? exclude : []),

    scanLargeFiles: (ctx, root, minBytes) => mod('largefiles').scanLargeFiles(root, minBytes, ctx.progress, ctx.signal),

    aiToolStatus: (ctx) => mod('aitools').aiToolStatus(),

    // Git worktrees: removal re-verifies from scratch and never forces.
    worktreeRemove: (ctx, mainPath, wtPath) => {
      const scanner = mod('scanner'); // also hands its artifact names to worktrees
      return mod('worktrees').removeWorktree(String(mainPath), String(wtPath), {
        signal: ctx.signal, dirSize: (d, s) => scanner.dirSize(d, s),
      });
    },
    // Clears git's record of each named missing worktree, one by one.
    worktreePrune: (ctx, mainPath, paths) => mod('worktrees').pruneWorktrees(String(mainPath),
      (Array.isArray(paths) ? paths : []).map(String), { signal: ctx.signal }),
    // ---- ai models and dev tools ----
    // Listing and removal both spawn tools (ollama, simctl, sdkmanager...) and
    // walk model stores, so they run here. `item` is main's cached copy; the
    // removal re-detects it before touching anything.
    devtoolsInventory: (ctx, opts = {}) => mod('devtools').inventory({
      projects: Array.isArray(opts && opts.projects) ? opts.projects : [],
      projectsScanned: Boolean(opts && opts.projectsScanned === true),
    }),
    devtoolsRemove: (ctx, item, opts = {}) => mod('devtools').removeItem(item, {
      projects: Array.isArray(opts && opts.projects) ? opts.projects : [],
      projectsScanned: Boolean(opts && opts.projectsScanned === true),
      deletePath: (p, onProgress) => mod('cleaner').deletePath(p, onProgress, ctx.signal),
    }),
    // ---- end ai models and dev tools ----

    // ---- native cleanup ----
    // A tool's own cleanup command for one cache target. Only the target id
    // crosses over: the command and its arguments come from the spec catalog
    // here, the target from this process's own catalog, and the folder jobs
    // are kept only when they are that target's own paths.
    nativeClean: (ctx, targetId, jobs, opts = {}) => {
      const target = nativeTarget(mod, targetId);
      const own = new Set(target.paths.map(keyOf));
      const folderJobs = (Array.isArray(jobs) ? jobs : [])
        .filter((j) => j && typeof j.path === 'string' && own.has(keyOf(j.path)))
        .map((j) => ({
          path: j.path, mode: 'contents',
          ...(Array.isArray(j.protect) ? { protect: j.protect.filter((x) => typeof x === 'string') } : {}),
          ...(Array.isArray(j.excludePaths) ? { excludePaths: j.excludePaths.filter((x) => typeof x === 'string') } : {}),
        }));
      const mode = opts && opts.mode === 'auto' ? 'auto' : 'manual';
      return mod('native').runNative(target, {
        mode,
        // Auto-clean never deletes a folder for good: it stages instead. So in
        // auto mode the worker gets no folder and no way to delete one.
        ...(mode === 'auto' ? {} : {
          folderJobs,
          deleteFolders: (list, onProgress) => mod('cleaner').clean(list, onProgress, ctx.signal),
        }),
        signal: ctx.signal,
        onProgress: ctx.progress || undefined,
      });
    },
    // Read-only previews for the rows: one process snapshot for all of them.
    nativePreview: async (ctx, ids) => {
      const native = mod('native');
      const wanted = Array.from(new Set((Array.isArray(ids) ? ids : []).filter((id) => nativeSpecFor(id))));
      if (!wanted.length) return [];
      const procs = await require('./devtools/processes').processList();
      const out = [];
      for (const id of wanted) {
        if (ctx.signal.aborted) break;
        let target;
        try { target = nativeTarget(mod, id); } catch { continue; }
        try { out.push(await native.preview(target, { procs, signal: ctx.signal })); }
        catch (e) { out.push({ id, error: (e && e.message) || 'Preview failed.' }); }
      }
      return out;
    },

    // Generic routing for Docker: any allowlisted export, called by name.
    docker: async (ctx, name, args = []) => {
      const docker = mod('docker');
      const at = Object.prototype.hasOwnProperty.call(DOCKER_ALLOWLIST, name) ? DOCKER_ALLOWLIST[name] : undefined;
      if (at === undefined || typeof docker[name] !== 'function') throw unknownOp('docker.' + name);
      const list = Array.isArray(args) ? args.slice() : [];
      if (at >= 0 && ctx.wantsProgress) {
        const o = list[at] && typeof list[at] === 'object' ? list[at] : {};
        list[at] = { ...o, onProgress: ctx.progress };
      }
      return docker[name](...list);
    },
  };
}

/**
 * @param {object} d
 * @param {(msg:object) => void} d.send  post a message to the main process
 * @param {object} [d.modules]  scan modules to use instead of the real ones
 * @param {object} [d.extraOps]  more ops (tests), (ctx, ...args) => result
 */
function createDispatcher({ send, modules = {}, extraOps = {}, log = console } = {}) {
  const loaded = { ...modules };
  const mod = (name) => {
    if (!loaded[name]) loaded[name] = LOADERS[name]();
    return loaded[name];
  };
  const ops = { ...buildOps(mod), ...extraOps };
  const running = new Map();

  const post = (m) => { try { send(m); } catch (e) { log.error && log.error('[worker] send failed:', e && e.message); } };

  async function run(msg) {
    const { id, op } = msg;
    const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
    if (typeof fn !== 'function') { post({ id, ok: false, error: serializeError(unknownOp(op)) }); return; }
    const controller = new AbortController();
    running.set(id, controller);
    const wantsProgress = Boolean(msg.progress);
    const ctx = {
      id,
      signal: controller.signal,
      wantsProgress,
      progress: wantsProgress ? (p) => { if (running.has(id)) post({ id, progress: p }); } : null,
    };
    try {
      const result = await fn(ctx, ...(Array.isArray(msg.args) ? msg.args : []));
      if (running.has(id)) post({ id, ok: true, result });
    } catch (e) {
      if (running.has(id)) post({ id, ok: false, error: serializeError(e) });
    } finally {
      running.delete(id);
    }
  }

  return {
    handle(msg) {
      if (!msg || typeof msg !== 'object' || msg.id == null) return;
      if (msg.abort) { const c = running.get(msg.id); if (c) c.abort(); return; }
      if (typeof msg.op !== 'string') return;
      run(msg);
    },
    /** Abort every op in flight (the process is going away). */
    abortAll() { for (const c of running.values()) c.abort(); },
    running: () => running.size,
    ops: () => Object.keys(ops),
  };
}

/**
 * Attach a dispatcher to this process's parent channel: Electron's
 * utilityProcess parentPort in the app, a child_process.fork IPC channel in
 * tests. The worker exits when its parent goes away.
 */
function startWorker({ modules, extraOps, log = console } = {}) {
  let dispatcher;
  if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
    const port = process.parentPort;
    dispatcher = createDispatcher({ send: (m) => port.postMessage(m), modules, extraOps, log });
    port.on('message', (e) => dispatcher.handle(e && e.data));
  } else if (typeof process.send === 'function') {
    dispatcher = createDispatcher({ send: (m) => { if (process.connected) process.send(m); }, modules, extraOps, log });
    process.on('message', (m) => dispatcher.handle(m));
    process.on('disconnect', () => process.exit(0));
  } else {
    throw new Error('The scan worker must be started by Spaci (no parent channel).');
  }
  return dispatcher;
}

module.exports = { createDispatcher, startWorker, attachLanguages, dockerSummary, dockerVolumes, serializeError, DOCKER_ALLOWLIST, LANG_BUDGET_MS };
