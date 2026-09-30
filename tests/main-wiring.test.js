'use strict';
// Loads src/main.js against a stub `electron` module (the real binary cannot
// run under node --test) and stub scanners, then drives the IPC handlers and
// app lifecycle the way Electron would. Checks the wiring, not the policies
// (those have their own tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { deferred, flush } = require('./fake-clock');
const { createDispatcher } = require('../src/scan-worker-ops');

const SRC = path.join(__dirname, '..', 'src');

// main.js starts app-lifetime timers (the usage ping interval). Unref every
// timer in this test process so it can exit when the tests are done.
for (const name of ['setTimeout', 'setInterval']) {
  const real = global[name];
  global[name] = (...args) => { const h = real(...args); if (h && h.unref) h.unref(); return h; };
}

function loadMain(userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-')), { lock = true, shell = {}, dialog = {}, scanner = {}, system = {}, docker = {}, notification = null, updater = null, largefiles = null } = {}) {
  const counts = { windows: 0, trays: 0, quits: 0, shows: 0, focuses: 0, restores: 0 };
  const windows = [];
  const trays = [];
  const handlers = {};
  const appEvents = new EventEmitter();
  const ready = deferred();
  const sent = [];
  const jobs = { projects: [], system: [] };

  class FakeWin extends EventEmitter {
    constructor() {
      super();
      counts.windows++;
      windows.push(this);
      this.minimized = false;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (ch, p) => sent.push([ch, p]),
        openDevTools() {},
        isDestroyed: () => false,
        setWindowOpenHandler(fn) { this.openHandler = fn; },
      });
    }
    loadFile() {}
    isDestroyed() { return false; }
    isVisible() { return false; }
    show() { counts.shows++; } hide() {} focus() { counts.focuses++; } setPosition() {}
    isMinimized() { return this.minimized; }
    restore() { counts.restores++; this.minimized = false; }
  }
  const img = { isEmpty: () => true, setTemplateImage() {} };
  const appPath = path.join(__dirname, '..');
  const electron = {
    app: Object.assign(appEvents, {
      getPath: () => userData,
      getAppPath: () => appPath,
      isPackaged: false,
      getVersion: () => '2.1.0',
      whenReady: () => ready.promise,
      quit: () => { counts.quits++; },
      focus: () => {},
      requestSingleInstanceLock: () => lock,
      dock: null,
    }),
    BrowserWindow: FakeWin,
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    dialog,
    shell,
    Tray: class extends EventEmitter {
      constructor() { super(); counts.trays++; trays.push(this); this.menus = []; }
      setToolTip(t) { sent.push(['tooltip', t]); } getBounds() { return {}; }
      setContextMenu(m) { this.menus.push(m); }
    },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createEmpty: () => img, createFromPath: () => img, createFromNamedImage: () => img },
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: () => false, getCurrentThermalState: () => 'nominal' }),
    Notification: notification || Object.assign(class {}, { isSupported: () => false }),
    // Notices use net.fetch; tests replace it. Never the real network.
    net: { isOnline: () => true, fetch: async () => { throw new Error('offline (test)'); } },
  };
  const mk = (kind) => (...args) => {
    const d = deferred();
    jobs[kind].push({ args, signal: args[args.length - 1], finish: d.resolve });
    return d.promise;
  };
  // What the scan worker runs. The worker is faked in process (below) with the
  // real dispatcher from scan-worker-ops.js, so messages take the same path as
  // in the app, structured-cloned and asynchronous.
  const calls = { main: [], worker: [] };
  const workerModules = {
    scanner: {
      scanProjects: mk('projects'),
      attachDockerUsage: async () => ({ inventory: { ok: false, reason: 'stub' } }),
      enrichProject: async (dir) => {
        calls.worker.push(['enrichProject', dir]);
        return {
          totalSize: 1, git: null,
          languages: [{ id: 'typescript', name: 'TypeScript', bytes: 10, percent: 100 }],
          frameworks: [{ id: 'react', name: 'React' }],
          primary: { id: 'react', name: 'React' },
          analysis: { fileCount: 1, source: 'git', truncated: false },
        };
      },
      analyzeTech: async (dir) => {
        calls.worker.push(['analyzeTech', dir]);
        return { languages: [{ id: 'go', name: 'Go', bytes: 1, percent: 100 }], primary: { id: 'go', name: 'Go' } };
      },
      revalidateArtifact: async (p) => { calls.worker.push(['revalidateArtifact', p]); return { ok: false, reason: 'Stub refused.' }; },
      ...scanner,
    },
    system: { scanSystem: mk('system') },
    docker: { desktopDisk: async () => null, ...docker },
    diskbreakdown: { diskBreakdown: async () => ({ categories: [] }), topChildren: async () => [{ path: '/x', bytes: 1 }] },
    largefiles: largefiles || { scanLargeFiles: async (root, min, onProgress) => { onProgress && onProgress({ phase: 'done' }); return { files: [], scanned: 0 }; } },
    aitools: { aiToolStatus: async () => ({ ok: true, running: [] }) },
  };
  const forks = [];
  electron.utilityProcess = {
    fork(modulePath, args, opts) {
      const child = new EventEmitter();
      let dead = false;
      const d = createDispatcher({
        modules: workerModules,
        send: (m) => { const c = structuredClone(m); setImmediate(() => { if (!dead) child.emit('message', c); }); },
      });
      child.postMessage = (m) => { if (dead) return; const c = structuredClone(m); setImmediate(() => { if (!dead) d.handle(c); }); };
      // A killed process takes its ops with it.
      child.kill = () => { if (dead) return false; dead = true; child.killed = true; d.abortAll(); setImmediate(() => child.emit('exit', null)); return true; };
      child.crash = (code = 1) => { dead = true; d.abortAll(); child.emit('exit', code); };
      forks.push({ modulePath, opts, child });
      return child;
    },
  };
  // Main must never reach the scan modules itself: those calls spawn processes
  // on Electron's main thread. Only static tables and pure helpers are allowed.
  const poison = (name) => (...args) => { calls.main.push([name, args]); throw new Error(`main.js called ${name} directly`); };
  const stubs = {
    electron,
    [path.join(SRC, 'scanner.js')]: {
      scanProjects: poison('scanner.scanProjects'), attachDockerUsage: poison('scanner.attachDockerUsage'),
      enrichProject: poison('scanner.enrichProject'), revalidateArtifact: poison('scanner.revalidateArtifact'),
    },
    [path.join(SRC, 'system.js')]: { scanSystem: poison('system.scanSystem'), TARGETS: [], ...system },
    [path.join(SRC, 'docker.js')]: {
      desktopDisk: poison('docker.desktopDisk'), prune: poison('docker.prune'), inventory: poison('docker.inventory'),
      status: poison('docker.status'), PRUNE_KINDS: {}, reclaimSuggestions: () => [], ...docker,
    },
    [path.join(SRC, 'diskbreakdown.js')]: { diskBreakdown: poison('diskbreakdown.diskBreakdown'), topChildren: poison('diskbreakdown.topChildren') },
    [path.join(SRC, 'largefiles.js')]: { scanLargeFiles: poison('largefiles.scanLargeFiles') },
    [path.join(SRC, 'aitools.js')]: { aiToolStatus: poison('aitools.aiToolStatus') },
    ...(updater ? { [path.join(SRC, 'updater.js')]: updater } : {}),
  };
  const required = [];
  // Every src module any src module asked for while main.js loaded, direct or
  // transitive (a stubbed module still counts: something asked for it).
  const requiredAnywhere = new Set();

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (parent && parent.filename && parent.filename.startsWith(SRC)) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* not a file */ }
      if (parent.filename === path.join(SRC, 'main.js')) required.push(resolved || request);
      if (resolved) requiredAnywhere.add(resolved);
      if (resolved && stubs[resolved]) return stubs[resolved];
    }
    return origLoad.apply(this, arguments);
  };
  const mainPath = path.join(SRC, 'main.js');
  const updaterPath = path.join(SRC, 'updater.js');
  delete require.cache[mainPath];
  delete require.cache[updaterPath];
  // main.js installs process-wide crash handlers. Keep them off this test
  // process (they would pile up across loads) and hand them to the tests.
  const PROC_EVENTS = ['uncaughtException', 'unhandledRejection'];
  const beforeListeners = Object.fromEntries(PROC_EVENTS.map((ev) => [ev, process.listeners(ev)]));
  const processHandlers = {};
  try {
    require(mainPath);
  } finally {
    Module._load = origLoad;
    for (const ev of PROC_EVENTS) {
      for (const fn of process.listeners(ev)) {
        if (beforeListeners[ev].includes(fn)) continue;
        process.removeListener(ev, fn);
        processHandlers[ev] = fn;
      }
    }
  }
  const cleanup = () => {
    delete require.cache[mainPath];
    delete require.cache[updaterPath];
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return { handlers, appEvents, ready, sent, jobs, userData, electron, cleanup, counts, windows, forks, calls, required, requiredAnywhere, appPath, processHandlers, trays };
}

test('startup survives a truncated cache.json and serves an empty, well-formed cache', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-corrupt-'));
  fs.writeFileSync(path.join(userData, 'cache.json'), '{"projects":[{"pa');
  const m2 = loadMain(userData);
  try {
    const c = await m2.handlers['cache:get']();
    assert.deepEqual(c.projects, []);
    assert.deepEqual(c.system, []);
    assert.equal(c.version, 2);
  } finally { m2.cleanup(); }
});

test('manual scans are wired through the coordinator and written atomically', async () => {
  const m = loadMain();
  try {
    const sender = { send: (ch, p) => m.sent.push([ch, p]), isDestroyed: () => false };
    const first = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    const second = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    assert.equal(m.jobs.projects[0].signal.aborted, true, 'older manual scan aborted');
    m.jobs.projects[1].finish({ projects: [{ path: '/home/u/new', items: [{ path: '/home/u/new/node_modules', size: 5 }], cleanableSize: 5 }] });
    m.jobs.projects[0].finish({ projects: [{ path: '/home/u/old', items: [{ path: '/home/u/old/node_modules', size: 9 }], cleanableSize: 9 }] });
    const [r1, r2] = await Promise.all([first, second]);
    assert.deepEqual(r2.projects.map((p) => p.path), ['/home/u/new']);
    assert.deepEqual(r1.projects.map((p) => p.path), ['/home/u/new']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(m.userData, 'cache.json'), 'utf8'));
    assert.deepEqual(onDisk.projects.map((p) => p.path), ['/home/u/new']);
    assert.deepEqual(fs.readdirSync(m.userData).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
    // A window that closed mid-scan does not break progress reporting.
    const gone = { send: () => { throw new Error('Object has been destroyed'); }, isDestroyed: () => true };
    const p3 = m.handlers['scan:system']({ sender: gone });
    await flush();
    m.jobs.system[0].finish([{ id: 'npm', size: 1, safe: true }]);
    assert.equal((await p3).ok, true);
  } finally { m.cleanup(); }
});

test('prefs:set with junk does not throw; quit aborts scans and nothing is written after will-quit', async () => {
  const m = loadMain();
  try {
    m.ready.resolve();
    await flush();
    const p = await m.handlers['prefs:set']({}, null);
    assert.equal(p.autoCheckUpdates, true, 'new default pref present');
    await m.handlers['prefs:set']({}, { scanIntervalHours: 'abc' });

    const sender = { send() {}, isDestroyed: () => false };
    const scan = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    const cacheFile = path.join(m.userData, 'cache.json');
    const before = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
    m.appEvents.emit('before-quit');
    assert.equal(m.jobs.projects[0].signal.aborted, true, 'scan aborted on quit');
    m.appEvents.emit('will-quit');
    m.jobs.projects[0].finish({ projects: [{ path: '/late', items: [{ path: '/late/x', size: 1 }] }] });
    await scan;
    const after = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
    assert.equal(after, before, 'cache written after quit');
  } finally { m.cleanup(); }
});

test('the updater IPC answers in dev builds without touching the network', async () => {
  const m = loadMain();
  try {
    m.ready.resolve();
    await flush();
    assert.equal((await m.handlers['update:check']()).state, 'dev');
    assert.equal(await m.handlers['update:install'](), false);
    assert.equal(await m.handlers['app:version'](), '2.1.0');
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('a second instance on the same user-data dir quits before any window, tray or timer', async () => {
  const m = loadMain(undefined, { lock: false });
  try {
    assert.equal(m.counts.quits, 1, 'quit requested immediately');
    m.ready.resolve();
    await flush();
    assert.equal(m.counts.windows, 0);
    assert.equal(m.counts.trays, 0);
    assert.equal(m.appEvents.listenerCount('second-instance'), 0);
    m.appEvents.emit('before-quit');
    m.appEvents.emit('will-quit');
    assert.deepEqual(fs.readdirSync(m.userData), [], 'the secondary wrote nothing');
  } finally { m.cleanup(); }
});

test('the primary instance brings its window forward on a second launch', async () => {
  const m = loadMain();
  try {
    m.ready.resolve();
    await flush();
    assert.equal(m.counts.quits, 0);
    const main = m.windows[0];
    main.minimized = true;
    m.appEvents.emit('second-instance', {}, ['Spaci']);
    await flush();
    assert.equal(m.counts.restores, 1);
    assert.ok(m.counts.shows >= 1 && m.counts.focuses >= 1);
    // Closed to tray: the window object was destroyed, so a new one is created.
    main.isDestroyed = () => true;
    const before = m.counts.windows;
    m.appEvents.emit('second-instance', {}, ['Spaci']);
    await flush();
    assert.equal(m.counts.windows, before + 1);
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('preferences.json and history.json are written atomically (temp file, then rename)', async () => {
  const m = loadMain();
  const renames = [];
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return realRename(a, b); };
  try {
    await m.handlers['prefs:set']({}, { theme: 'light' });
    await m.handlers['history:clear']();
    assert.ok(renames.some(([a, b]) => b === 'preferences.json' && a.endsWith('.tmp')), 'prefs renamed into place');
    assert.ok(renames.some(([a, b]) => b === 'history.json' && a.endsWith('.tmp')), 'history renamed into place');
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.userData, 'preferences.json'), 'utf8')).theme, 'light');
    assert.deepEqual(fs.readdirSync(m.userData).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.renameSync = realRename;
    m.cleanup();
  }
});

// ---------- notices and What's new ----------

const NOTICE_CHANNELS = ['notices:list', 'notices:dismiss', 'notices:open', 'whatsnew:get', 'whatsnew:seen'];

function seededUserData(prefs, stored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-notices-'));
  if (prefs) fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify(prefs));
  if (stored) fs.writeFileSync(path.join(dir, 'notices.json'), JSON.stringify(stored));
  return dir;
}
const aNotice = (over = {}) => ({
  id: 'n-1', kind: 'announcement', severity: 'info', title: 'Hello', summary: 'Hi.',
  body: [{ t: 'p', c: [{ t: 'text', v: 'Body' }] }], media: [], cta: { label: 'Read', url: 'https://spaci.kentom.co.ke/blog' },
  version: null, audience: {}, startsAt: '2026-01-01T00:00:00Z', endsAt: null, dismissible: true,
  publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});

test('notices IPC: exactly the contract channels, bridged in preload, safe before the app is ready', async () => {
  const m = loadMain();
  try {
    for (const ch of NOTICE_CHANNELS) assert.equal(typeof m.handlers[ch], 'function', ch);
    const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
    const bridged = [...preload.matchAll(/invoke\('((?:notices|whatsnew):[a-z]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(bridged, [...NOTICE_CHANNELS].sort());
    assert.match(preload, /sub\('notices:updated'/);
    assert.deepEqual(await m.handlers['notices:list'](), []);
    assert.equal(await m.handlers['notices:dismiss']({}, 'n-1'), false);
    assert.equal(await m.handlers['whatsnew:get'](), null);
  } finally { m.cleanup(); }
});

test('notices: stored list served, dismissals persisted atomically, junk refused, prefs:set cannot overwrite notice state', async () => {
  const userData = seededUserData({ onboarded: true, lastSeenVersion: '2.0.0' }, { notices: [aNotice(), aNotice({ id: 'evil', cta: { label: 'x', url: 'javascript:alert(1)' } })] });
  const m = loadMain(userData);
  const renames = [];
  const realRename = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return realRename(a, b); };
  try {
    m.ready.resolve();
    await flush();
    const list = await m.handlers['notices:list']();
    assert.deepEqual(list.map((n) => n.id), ['n-1'], 'the tampered notice is dropped on load');
    assert.equal(list[0].seen, false);
    for (const bad of [null, 7, '', 'x'.repeat(200), { id: 'n-1' }]) assert.equal(await m.handlers['notices:dismiss']({}, bad), false);
    assert.equal(await m.handlers['notices:dismiss']({}, 'n-1'), true);
    const prefsFile = path.join(m.userData, 'preferences.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).dismissedNotices, ['n-1']);
    assert.ok(renames.some(([a, b]) => b === 'preferences.json' && a.endsWith('.tmp')));
    assert.deepEqual(await m.handlers['notices:list'](), []);
    assert.ok(m.sent.some(([ch, p]) => ch === 'notices:updated' && p.reason === 'dismissed'));

    const p = await m.handlers['prefs:set']({}, { dismissedNotices: [], lastSeenVersion: '9.9.9', seenNoticeIds: ['x'], notices: 'no', theme: 'light' });
    assert.deepEqual(p.dismissedNotices, ['n-1']);
    assert.equal(p.lastSeenVersion, '2.0.0');
    assert.equal(p.notices, true);
    assert.equal(p.theme, 'light');
    await m.handlers['prefs:set']({}, { notices: false });
    assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).notices, false);

    // What's new after an upgrade (2.0.0 -> 2.1.0), from the site via net.fetch.
    const urls = [];
    m.electron.net.fetch = async (url) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify({ version: '2.1.0', highlight: 'Hi', body: [{ t: 'script' }, { t: 'hr' }], media: [], links: [] }) };
    };
    const w = await m.handlers['whatsnew:get']();
    assert.deepEqual(urls, ['https://spaci.kentom.co.ke/api/releases/2.1.0/notes']);
    assert.deepEqual(w, { version: '2.1.0', highlight: 'Hi', body: [{ t: 'hr' }], media: [], links: [] });
    assert.equal(await m.handlers['whatsnew:seen']({}, '../../x'), false);
    assert.equal(await m.handlers['whatsnew:seen']({}, '2.1.0'), true);
    assert.equal(JSON.parse(fs.readFileSync(prefsFile, 'utf8')).lastSeenVersion, '2.1.0');
    assert.equal(await m.handlers['whatsnew:get'](), null);
    assert.deepEqual(fs.readdirSync(m.userData).filter((f) => f.endsWith('.tmp')), []);
    m.appEvents.emit('before-quit');
  } finally {
    fs.renameSync = realRename;
    m.cleanup();
  }
});

test('a fresh install records its version at launch and never shows What\'s new', async () => {
  const m = loadMain();
  try {
    let fetched = 0;
    m.electron.net.fetch = async () => { fetched++; throw new Error('offline'); };
    m.ready.resolve();
    await flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(m.userData, 'preferences.json'), 'utf8')).lastSeenVersion, '2.1.0');
    assert.equal(await m.handlers['whatsnew:get'](), null);
    assert.equal(fetched, 0);
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

// ---------- scan worker ----------

const SCAN_MODULES = ['scanner.js', 'languages.js', 'diskbreakdown.js', 'largefiles.js', 'aitools.js'].map((f) => path.join(SRC, f));
// Modules whose only job is walking disks or spawning git: nothing the main
// process loads may reach them, directly or through another module. (aitools.js
// is reachable through system.js for its target tables, and docker.js is loaded
// for PRUNE_KINDS; both are covered by the poisoned-call checks instead.)
const WALK_MODULES = ['scanner.js', 'languages.js', 'diskbreakdown.js', 'largefiles.js', 'scan-worker-ops.js'].map((f) => path.join(SRC, f));

/** Static require graph of src: every './x' require reachable from `entry`. */
function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let dep = path.resolve(path.dirname(f), m[1]);
      if (!dep.endsWith('.js')) dep += '.js';
      if (fs.existsSync(dep)) stack.push(dep);
    }
  }
  return seen;
}

test('worker isolation, transitively: no module main.js can reach requires a disk-walking scan module', () => {
  const graph = reachable(path.join(SRC, 'main.js'));
  for (const f of WALK_MODULES) {
    assert.ok(!graph.has(f), `main.js reaches ${path.basename(f)} through its requires`);
  }
  // The cleaner in particular: it gets SKIP_DELETE from constants.js.
  assert.ok(graph.has(path.join(SRC, 'cleaner.js')));
  assert.ok(graph.has(path.join(SRC, 'constants.js')));
  // And the worker still reaches every scan module.
  const worker = reachable(path.join(SRC, 'scan-worker.js'));
  for (const f of SCAN_MODULES) assert.ok(worker.has(f), `the worker reaches ${path.basename(f)}`);
});

test('scan work runs in the worker: one utilityProcess from the app path, main never touches the scan modules', async () => {
  const m = loadMain();
  try {
    assert.equal(m.forks.length, 0, 'no worker before the first scan');
    for (const f of SCAN_MODULES) assert.ok(!m.required.includes(f), `main.js does not require ${path.basename(f)}`);
    for (const f of WALK_MODULES) assert.ok(!m.requiredAnywhere.has(f), `nothing main.js loads requires ${path.basename(f)}`);
    const sender = { send: (ch, p) => m.sent.push([ch, p]), isDestroyed: () => false };
    const scan = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    assert.equal(m.forks.length, 1);
    assert.equal(m.forks[0].modulePath, path.join(m.appPath, 'src', 'scan-worker.js'));
    assert.ok(fs.existsSync(m.forks[0].modulePath));
    // Progress from the worker reaches the renderer's existing channel.
    m.jobs.projects[0].args[1]({ phase: 'scanning', percent: 7 });
    await flush();
    assert.ok(m.sent.some(([ch, p]) => ch === 'scan:progress' && p.percent === 7));
    m.jobs.projects[0].finish({ projects: [{ path: '/home/u/a', items: [{ path: '/home/u/a/node_modules', size: 3 }], cleanableSize: 3 }] });
    const res = await scan;
    assert.equal(res.ok, true);
    // Every scanned project carries a language strip, computed in the worker.
    assert.deepEqual(res.projects[0].languages.map((l) => l.id), ['go']);
    assert.equal(res.projects[0].primary.id, 'go');
    const c = await m.handlers['cache:get']();
    assert.deepEqual(c.projects[0].languages.map((l) => l.id), ['go']);
    assert.ok(m.calls.worker.some(([op, dir]) => op === 'analyzeTech' && dir === '/home/u/a'));

    // System scan, breakdown, drill-down, large files, Docker, clean revalidation.
    const sys = m.handlers['scan:system']({ sender });
    await flush();
    m.jobs.system[0].finish([{ id: 'npm', size: 1, safe: true }]);
    assert.equal((await sys).ok, true);
    assert.deepEqual((await m.handlers['disk:breakdown']()).categories, []);
    assert.deepEqual(await m.handlers['fs:top-children']({}, ['/x']), [{ path: '/x', bytes: 1 }]);
    const lf = await m.handlers['scan:largefiles']({ sender }, os.homedir(), 1);
    assert.equal(lf.ok, true);
    assert.ok(m.sent.some(([ch]) => ch === 'largefiles:progress'));
    assert.equal((await m.handlers['docker:status']({}, true)).ok, false);
    const cleaned = await m.handlers['clean']({ sender }, [{ path: '/home/u/a/node_modules' }], { scope: 'projects' });
    assert.equal(cleaned.ok, true);
    assert.deepEqual(cleaned.refused.map((r) => r.reason), ['Stub refused.'], 'revalidated in the worker, fails closed');
    assert.ok(m.calls.worker.some(([op]) => op === 'revalidateArtifact'));

    assert.deepEqual(m.calls.main, [], 'main.js never called a scan function directly');
    assert.equal(m.forks.length, 1, 'one worker served everything');
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('project:enrich stores and returns languages, frameworks, primary and analysis; enrich:updated carries them', async () => {
  const m = loadMain();
  try {
    m.ready.resolve(); // a window to push to
    await flush();
    const r = await m.handlers['project:enrich']({}, '/home/u/a', true);
    assert.equal(r.totalSize, 1);
    assert.deepEqual(r.languages.map((l) => l.id), ['typescript']);
    assert.deepEqual(r.frameworks.map((f) => f.id), ['react']);
    assert.equal(r.primary.id, 'react');
    assert.equal(r.analysis.source, 'git');
    const pushed = m.sent.find(([ch]) => ch === 'enrich:updated');
    assert.ok(pushed);
    assert.equal(pushed[1].path, '/home/u/a');
    assert.deepEqual(pushed[1].languages, r.languages);
    assert.deepEqual(pushed[1].primary, r.primary);
    assert.deepEqual(pushed[1].frameworks, r.frameworks);
    const c = await m.handlers['cache:get']();
    assert.deepEqual(c.enrich['/home/u/a'].languages, r.languages);
    // Cached answer is served at once, with the same fields.
    const again = await m.handlers['project:enrich']({}, '/home/u/a');
    assert.deepEqual(again.primary, r.primary);
    assert.deepEqual(m.calls.main, []);
    const onDisk = JSON.parse(fs.readFileSync(path.join(m.userData, 'cache.json'), 'utf8'));
    assert.equal(onDisk.enrich['/home/u/a'].analysis.source, 'git');
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('a worker crash mid-scan fails that scan cleanly and the next scan gets a new worker', async () => {
  const m = loadMain();
  try {
    const sender = { send() {}, isDestroyed: () => false };
    const first = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    m.forks[0].child.crash(11);
    const r1 = await first;
    assert.equal(r1.ok, false);
    assert.match(r1.error, /stopped unexpectedly/);
    const second = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    assert.equal(m.forks.length, 2, 'respawned');
    m.jobs.projects[1].finish({ projects: [{ path: '/home/u/b', items: [{ path: '/home/u/b/target', size: 1 }], cleanableSize: 1 }] });
    assert.equal((await second).ok, true);
    // Enrichment degrades to the cached answer rather than throwing.
    m.forks[1].child.crash(1);
    assert.deepEqual(await m.handlers['project:enrich']({}, '/nowhere', true).then((x) => typeof x), 'object');
  } finally { m.cleanup(); }
});

test('Quit kills the worker at once, with a scan in flight, and nothing starts it again after will-quit', async () => {
  const m = loadMain();
  try {
    m.ready.resolve();
    await flush();
    const sender = { send() {}, isDestroyed: () => false };
    const scan = m.handlers['scan:projects']({ sender }, '/home/u');
    const sys = m.handlers['scan:system']({ sender });
    await flush();
    const child = m.forks[0].child;
    const t0 = Date.now();
    m.appEvents.emit('before-quit');
    assert.equal(child.killed, true, 'killed synchronously in before-quit');
    m.appEvents.emit('will-quit');
    const [r1, r2] = await Promise.all([scan, sys]);
    assert.ok(Date.now() - t0 < 500, 'quit never waits on the worker');
    assert.equal(r1.ok, false);
    assert.equal(r1.cancelled, true);
    assert.equal(r2.cancelled, true);
    assert.equal((await m.handlers['project:enrich']({}, '/p', true)).totalSize, 0);
    assert.equal(m.forks.length, 1, 'no worker started after quit');
  } finally { m.cleanup(); }
});

// ---------- 2.2.1 hotfix: clean IPC, history v2, IPC hardening ----------

function tmpTree(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

async function scanInto(m, projects) {
  const sender = { send() {}, isDestroyed: () => false };
  const scan = m.handlers['scan:projects']({ sender }, '/unused');
  await flush();
  m.jobs.projects[m.jobs.projects.length - 1].finish({ projects });
  await scan;
}

const cleanEvent = { sender: { send() {}, isDestroyed: () => false } };
const readHistoryFile = (m) => JSON.parse(fs.readFileSync(path.join(m.userData, 'history.json'), 'utf8'));

test('clean: main decides reversibility, gates irreversible targets, and logs a v2 entry with real counts', async () => {
  const dir = tmpTree('spaci-clean-');
  const proj = path.join(dir, 'app');
  const nm = path.join(proj, 'node_modules');
  fs.mkdirSync(path.join(nm, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'left-pad', 'index.js'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  fs.writeFileSync(path.join(proj, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(proj, 'pnpm-lock.yaml'), '');
  const trashDir = path.join(dir, 'Trash');
  fs.mkdirSync(trashDir);
  fs.writeFileSync(path.join(trashDir, 'old.txt'), 'keep me');
  const TRASH = { id: 'trash', name: 'Trash', safe: false, reversible: false, mode: 'contents', paths: [trashDir] };
  const m = loadMain(undefined, {
    scanner: { revalidateArtifact: async () => ({ ok: true }) },
    system: { TARGETS: [TRASH] },
  });
  try {
    await scanInto(m, [{ path: proj, items: [{ path: nm, size: 5000 }], cleanableSize: 5000 }]);
    const res = await m.handlers.clean(cleanEvent, [{ path: nm }, { path: trashDir }, { path: '/etc/hosts' }, { path: nm }],
      { scope: 'projects', label: 'app', reversible: true });
    assert.equal(res.ok, true, res.error);
    assert.equal(fs.existsSync(nm), false, 'artifact removed');
    assert.equal(fs.existsSync(path.join(trashDir, 'old.txt')), true, 'irreversible target untouched without confirmation');
    assert.deepEqual(res.trashed, []);
    assert.deepEqual(res.errors, []);
    const byPath = Object.fromEntries(res.refused.map((r) => [r.path, r.reason]));
    assert.equal(byPath[trashDir], 'needs-confirmation');
    assert.match(byPath['/etc/hosts'], /did not find this in a scan/);
    assert.ok(res.totalFreed > 0);

    const [entry] = readHistoryFile(m);
    assert.equal(entry.v, 2);
    assert.equal(entry.id, res.historyId);
    assert.equal(entry.status, 'done');
    assert.equal(entry.requested, 3, 'duplicate job counted once');
    assert.equal(entry.count, 1);
    assert.equal(entry.refusedCount, 2);
    assert.equal(entry.failedCount, 0);
    assert.equal(entry.freed, res.totalFreed);
    assert.ok(entry.finishedAt >= entry.at);
    const it = entry.items.find((i) => i.path === nm);
    assert.deepEqual(
      { outcome: it.outcome, kind: it.kind, reversible: it.reversible, project: it.project, restoreHint: it.restoreHint },
      { outcome: 'removed', kind: 'artifact', reversible: 'rebuild', project: proj, restoreHint: 'pnpm install' },
    );
    const tr = entry.items.find((i) => i.path === trashDir);
    assert.equal(tr.outcome, 'refused');
    assert.equal(tr.reversible, 'none');
    assert.equal(tr.restoreHint, undefined);

    // Confirmed: the irreversible target is emptied and logged as permanent.
    const res2 = await m.handlers.clean(cleanEvent, [{ path: trashDir }], { scope: 'system', confirmed: true, reversible: true });
    assert.deepEqual(res2.refused, []);
    assert.deepEqual(fs.readdirSync(trashDir), []);
    const [e2] = readHistoryFile(m);
    assert.equal(e2.items[0].kind, 'trash');
    assert.equal(e2.items[0].reversible, 'none');
    assert.equal(e2.items[0].restoreHint, undefined);
  } finally { m.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clean: a job that fails counts as failed with its error code, never as removed', async () => {
  const dir = tmpTree('spaci-cleanfail-');
  const proj = path.join(dir, 'app');
  const nm = path.join(proj, 'node_modules');
  fs.mkdirSync(proj, { recursive: true });
  const m = loadMain(undefined, { scanner: { revalidateArtifact: async () => ({ ok: true }) } });
  try {
    await scanInto(m, [{ path: proj, items: [{ path: nm, size: 1 }], cleanableSize: 1 }]);
    // node_modules vanished since the scan: nothing was removed by Spaci.
    const res = await m.handlers.clean(cleanEvent, [{ path: nm }], { scope: 'projects' });
    assert.equal(res.ok, true);
    const [entry] = readHistoryFile(m);
    assert.equal(entry.count, 0);
    assert.equal(entry.failedCount, 1);
    assert.equal(entry.items[0].outcome, 'failed');
    assert.equal(entry.items[0].code, 'ENOENT');
    assert.equal(entry.items[0].restoreHint, 'npm install', 'no lockfile falls back to npm install');
  } finally { m.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('large files: need confirmation, go to the Trash, and a failed trashItem never deletes', async () => {
  const dir = tmpTree('spaci-large-');
  const big = path.join(dir, 'movie.mov');
  // Real bytes, not a sparse file: freed is the allocated size.
  fs.writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 1));
  let trashFails = true;
  const trashed = [];
  const shell = {
    trashItem: async (p) => { if (trashFails) throw Object.assign(new Error('Trash unavailable'), { code: 'EPERM' }); trashed.push(p); fs.renameSync(p, p + '.trashed'); },
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }) };
  const m = loadMain(undefined, { shell, dialog, largefiles: require('../src/largefiles') });
  try {
    // A folder outside home is only accepted after the user picks it.
    await m.handlers['prefs:set']({}, { scanRoots: [dir] });
    assert.deepEqual(m.handlers['prefs:get']().scanRoots, [], 'an unpicked folder outside home is refused');
    assert.equal(await m.handlers['dialog:pick-folder'](), dir);
    await m.handlers['prefs:set']({}, { scanRoots: [dir] });
    assert.deepEqual(m.handlers['prefs:get']().scanRoots, [dir]);
    const sender = { send() {}, isDestroyed: () => false };
    const scan = await m.handlers['scan:largefiles']({ sender }, dir, 1);
    assert.equal(scan.ok, true);
    assert.deepEqual(scan.files.map((f) => f.path), [big], 'minBytes 1 is clamped, but an 11 MB file still counts');

    const unconfirmed = await m.handlers.clean(cleanEvent, [{ path: big }], { scope: 'largefiles' });
    assert.equal(unconfirmed.refused[0].reason, 'needs-confirmation');
    assert.equal(unconfirmed.historyId, null);
    assert.equal(fs.existsSync(big), true);

    const failed = await m.handlers.clean(cleanEvent, [{ path: big }], { scope: 'largefiles', confirmed: true });
    assert.equal(fs.existsSync(big), true, 'trashItem failed: the file stays, no hard delete');
    assert.deepEqual(failed.trashed, []);
    assert.equal(failed.totalFreed, 0);
    assert.deepEqual(failed.errors.map((e) => [e.path, e.code]), [[big, 'EPERM']]);
    let [entry] = readHistoryFile(m);
    assert.equal(entry.count, 0);
    assert.equal(entry.items[0].outcome, 'failed');

    trashFails = false;
    const ok = await m.handlers.clean(cleanEvent, [{ path: big }], { scope: 'largefiles', confirmed: true });
    assert.deepEqual(ok.trashed, [big]);
    assert.deepEqual(trashed, [big]);
    assert.equal(ok.totalFreed, 0, 'trashed files are not freed space until the Trash is emptied');
    assert.ok(ok.trashedBytes >= 11 * 1024 * 1024);
    [entry] = readHistoryFile(m);
    assert.equal(entry.count, 1);
    assert.deepEqual([entry.items[0].outcome, entry.items[0].kind, entry.items[0].reversible], ['trashed', 'file', 'trash']);
    assert.match(entry.items[0].restoreHint, /Trash/);
  } finally { m.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scan:largefiles refuses a root outside home and the scan roots', async () => {
  const m = loadMain();
  try {
    const sender = { send() {}, isDestroyed: () => false };
    const r = await m.handlers['scan:largefiles']({ sender }, '/', 100);
    assert.equal(r.ok, false);
    assert.match(r.error, /home folder/);
  } finally { m.cleanup(); }
});

test('a clean left "started" by a crash is marked interrupted on the next launch', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-hist-'));
  fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify([
    { v: 2, id: 'a', at: 1, status: 'started', scope: 'projects', label: '', requested: 1, count: 0, failedCount: 0, refusedCount: 0, freed: 0, items: [],
      pending: [{ path: '/p/node_modules', kind: 'artifact', reversible: 'rebuild' }] },
    { at: 0, scope: 'projects', label: 'old', count: 3, freed: 9, reversible: true, items: ['/x'] },
  ]));
  const m = loadMain(userData);
  try {
    m.ready.resolve();
    await flush();
    const h = await m.handlers['history:get']();
    assert.equal(h[0].status, 'interrupted');
    assert.equal(h[0].failedCount, 1);
    assert.equal(h[0].items[0].path, '/p/node_modules');
    assert.equal(h[0].pending, undefined);
    assert.deepEqual(h[1], { at: 0, scope: 'projects', label: 'old', count: 3, freed: 9, reversible: true, items: ['/x'] }, 'v1 entry untouched');
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('docker prune history is a v2 entry with main-decided reversibility and hint', async () => {
  const PRUNE_KINDS = {
    'build-cache': { id: 'build-cache', name: 'Build cache', safe: true },
    'stopped-containers': { id: 'stopped-containers', name: 'Stopped containers', safe: false },
  };
  const m = loadMain(undefined, { docker: { PRUNE_KINDS, prune: async () => ({ ok: true, freed: 42 }) } });
  try {
    await m.handlers['docker:prune']({}, 'build-cache');
    await m.handlers['docker:prune']({}, 'stopped-containers');
    const [stopped, build] = readHistoryFile(m);
    assert.deepEqual(
      [build.v, build.scope, build.reversible, build.restoreHint, build.count, build.freed, build.items.length],
      [2, 'docker', 'rebuild', 'Docker rebuilds this cache the next time you build.', 1, 42, 0],
    );
    assert.equal(stopped.reversible, 'none');
    assert.equal(stopped.restoreHint, undefined);
    assert.ok(build.id && stopped.id && build.id !== stopped.id);
  } finally { m.cleanup(); }
});

test('IPC hardening: no file-read handlers, external links and paths are allowlisted', async () => {
  const opened = [];
  const shell = {
    openExternal: async (u) => { opened.push(['ext', u]); },
    openPath: async (p) => { opened.push(['open', p]); return ''; },
    showItemInFolder: (p) => { opened.push(['reveal', p]); },
  };
  const m = loadMain(undefined, { shell });
  try {
    assert.equal(m.handlers['logo:get'], undefined);
    assert.equal(m.handlers['project:icon'], undefined);

    assert.equal(await m.handlers['open:external']({}, 'javascript:alert(1)'), false);
    assert.equal(await m.handlers['open:external']({}, 'file:///etc/passwd'), false);
    assert.equal(await m.handlers['open:external']({}, 'http://example.com'), false);
    assert.equal(await m.handlers['open:external']({}, 'https://spaci.kentom.co.ke'), true);
    assert.equal(await m.handlers['open:external']({}, 'mailto:hi@kentom.co.ke'), true);

    await scanInto(m, [{ path: '/home/u/app', items: [{ path: '/home/u/app/node_modules', size: 1 }], cleanableSize: 1 }]);
    assert.equal(await m.handlers['open:path']({}, '/Applications/Calculator.app'), 'Not allowed');
    assert.equal(await m.handlers['open:reveal']({}, '/etc/passwd'), 'Not allowed');
    assert.equal(await m.handlers['open:path']({}, '/home/u/app'), '');
    await m.handlers['open:reveal']({}, '/home/u/app/node_modules');
    assert.deepEqual(opened, [
      ['ext', 'https://spaci.kentom.co.ke'], ['ext', 'mailto:hi@kentom.co.ke'],
      ['open', '/home/u/app'], ['reveal', '/home/u/app/node_modules'],
    ]);
  } finally { m.cleanup(); }
});

test('update notifications honour the notify pref', async () => {
  const shown = [];
  class FakeNotification extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; }
    show() { shown.push(this.opts.title); }
  }
  FakeNotification.isSupported = () => true;
  let onReady = null;
  const updater = {
    initUpdater: (_w, opts) => { onReady = opts.onReady; return { wake() {} }; },
    getUpdateController: () => null,
  };
  const m = loadMain(undefined, { notification: FakeNotification, updater });
  try {
    m.ready.resolve();
    await flush();
    assert.equal(typeof onReady, 'function');
    await m.handlers['prefs:set']({}, { notify: false });
    onReady('9.9.9');
    assert.deepEqual(shown, [], 'notify off: nothing shown');
    await m.handlers['prefs:set']({}, { notify: true });
    onReady('9.9.9');
    assert.deepEqual(shown, ['Spaci 9.9.9 is ready']);
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('a cache from an older version gets the current safety flags (the Trash is not preselected)', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-flags-'));
  fs.writeFileSync(path.join(userData, 'cache.json'), JSON.stringify({
    version: 2, projects: [],
    system: [{ id: 'trash', name: 'Trash', safe: true, reversible: true, description: 'Files in the Trash.', paths: ['/h/.Trash'], existingPaths: ['/h/.Trash'], size: 5 }],
  }));
  const TRASH = { id: 'trash', name: 'Trash', safe: false, reversible: false, description: 'Emptying it deletes them permanently.', paths: ['/h/.Trash'] };
  const m = loadMain(userData, { system: { TARGETS: [TRASH] } });
  try {
    const c = await m.handlers['cache:get']();
    assert.equal(c.system[0].safe, false);
    assert.equal(c.system[0].reversible, false);
    assert.match(c.system[0].description, /permanently/);
  } finally { m.cleanup(); }
});

test('the language cache survives worker restarts: main seeds each scan from tech-cache.json and never sends it to the renderer', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-tech-'));
  const prior = [['/home/u/a', { head: null, rootMtime: 1, manifests: [], result: { languages: [], frameworks: [] } }]];
  fs.writeFileSync(path.join(userData, 'tech-cache.json'), JSON.stringify(prior));
  const seeds = [];
  const m = loadMain(userData, {
    scanner: {
      importTechCache: (snap) => { seeds.push(snap); return snap.length; },
      exportTechCache: () => [...prior, ['/home/u/b', prior[0][1]]],
    },
  });
  try {
    const sender = { send() {}, isDestroyed: () => false };
    const scan = m.handlers['scan:projects']({ sender }, '/home/u');
    await flush();
    m.jobs.projects[0].finish({ projects: [{ path: '/home/u/a', items: [{ path: '/home/u/a/node_modules', size: 1, safe: true }] }] });
    const res = await scan;
    assert.deepEqual(seeds, [prior], 'seeded with the snapshot on disk');
    assert.equal(res.techCache, undefined, 'the snapshot is not part of the scan result');
    assert.equal((await m.handlers['cache:get']()).techCache, undefined, 'nor of the cache sent to the renderer');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'tech-cache.json'), 'utf8'));
    assert.deepEqual(saved.map(([k]) => k), ['/home/u/a', '/home/u/b']);
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

test('crash log: startup failures show a dialog and quit; crashes and rejections are written to main.log', async () => {
  const boxes = [];
  const dialog = { showErrorBox: (title, body) => boxes.push([title, body]) };
  const updater = { initUpdater: () => { throw new Error('updater exploded'); }, getUpdateController: () => null };
  const m = loadMain(undefined, { dialog, updater });
  try {
    const logFile = await m.handlers['app:log-path']();
    assert.equal(logFile, path.join(m.userData, 'main.log'));
    m.ready.resolve();
    await flush();
    await flush();
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0][0], 'Spaci could not start');
    assert.match(boxes[0][1], /updater exploded/);
    assert.ok(boxes[0][1].includes(logFile), 'the dialog says where the log is');
    assert.equal(m.counts.quits, 1, 'no silent process left behind');

    m.processHandlers.uncaughtException(new Error('late bug'));
    m.processHandlers.unhandledRejection('rejected value');
    m.appEvents.emit('render-process-gone', {}, { getURL: () => 'file:///app/index.html' }, { reason: 'crashed', exitCode: 11 });
    m.appEvents.emit('child-process-gone', {}, { type: 'Utility', name: 'Spaci scan worker', reason: 'oom', exitCode: 9 });
    const text = fs.readFileSync(logFile, 'utf8');
    assert.match(text, /\[info\] Spaci 2\.1\.0 started/);
    assert.match(text, /\[error\] startup failed: Error: updater exploded/);
    assert.match(text, /\[error\] uncaughtException: Error: late bug/);
    assert.match(text, /\[error\] unhandledRejection: rejected value/);
    assert.match(text, /\[error\] render-process-gone index\.html: reason=crashed exitCode=11/);
    assert.match(text, /\[error\] child-process-gone type=Utility name=Spaci scan worker reason=oom exitCode=9/);
    assert.equal(boxes.length, 1, 'one dialog per session, the log has the rest');
    // Settings can reveal the log file.
    const opened = [];
    m.electron.shell.showItemInFolder = (p) => opened.push(p);
    assert.equal(await m.handlers['open:reveal']({}, logFile), '');
    assert.deepEqual(opened, [logFile]);
  } finally { m.cleanup(); }
});

test('every window denies window.open (https goes to the browser) and blocks navigation', async () => {
  const opened = [];
  const m = loadMain(undefined, { shell: { openExternal: async (u) => { opened.push(u); } } });
  try {
    m.ready.resolve();
    await flush();
    assert.ok(m.windows.length >= 2, 'main window and tray popover');
    for (const w of m.windows) {
      const wc = w.webContents;
      assert.equal(typeof wc.openHandler, 'function');
      assert.deepEqual(wc.openHandler({ url: 'https://spaci.kentom.co.ke/docs' }), { action: 'deny' });
      assert.deepEqual(wc.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
      assert.deepEqual(wc.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
      let prevented = 0;
      wc.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'https://evil.example');
      wc.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'file:///tmp/x.html');
      assert.equal(prevented, 2);
    }
    await flush();
    assert.deepEqual(opened, m.windows.map(() => 'https://spaci.kentom.co.ke/docs'));
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});

/** Run `fn` with process.platform (and env keys) pretending to be another OS. */
async function asPlatform(platform, env, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); } finally {
    Object.defineProperty(process, 'platform', desc);
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('linux tray: a context menu (Open, Scan now, Quit) rebuilt when an update is ready; no tray on stock GNOME means close quits', async () => {
  let onReady = null;
  let onWithdrawn = null;
  const updater = {
    initUpdater: (_w, opts) => { onReady = opts.onReady; onWithdrawn = opts.onReadyWithdrawn; return { wake() {} }; },
    getUpdateController: () => null,
  };
  await asPlatform('linux', { XDG_CURRENT_DESKTOP: 'KDE', SPACI_TRAY: '' }, async () => {
    const m = loadMain(undefined, { updater });
    try {
      m.ready.resolve();
      await flush();
      const tray = m.trays[0];
      const labels = (menu) => menu.filter((i) => i.label).map((i) => i.label);
      assert.deepEqual(labels(tray.menus[0]), ['Open Spaci', 'Scan now', 'Quit Spaci']);
      assert.equal(tray.listenerCount('click'), 0, 'AppIndicator trays get the menu, not a popover');
      assert.equal(m.windows.length, 1, 'no popover window on Linux');
      onReady('2.3.0');
      assert.deepEqual(labels(tray.menus[1]), ['Open Spaci', 'Scan now', 'Restart to Update (2.3.0)', 'Quit Spaci']);
      onWithdrawn();
      assert.deepEqual(labels(tray.menus[2]), ['Open Spaci', 'Scan now', 'Quit Spaci']);
      // Scan now opens the window and starts a scan there.
      tray.menus[2].find((i) => i.label === 'Scan now').click();
      assert.ok(m.sent.some(([ch]) => ch === 'tray:scan'));
      // A working tray: closing hides.
      let prevented = false;
      m.windows[0].emit('close', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      assert.equal(m.counts.quits, 0);
      m.appEvents.emit('before-quit');
    } finally { m.cleanup(); }
  });
  await asPlatform('linux', { XDG_CURRENT_DESKTOP: 'GNOME', SPACI_TRAY: '' }, async () => {
    const m = loadMain(undefined, { updater });
    try {
      m.ready.resolve();
      await flush();
      let prevented = false;
      m.windows[0].emit('close', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, false, 'the window really closes');
      assert.equal(m.counts.quits, 1, 'and Spaci quits instead of hiding with no way back');
    } finally { m.cleanup(); }
  });
});

test('macOS: a packaged first launch outside Applications offers the move once and remembers the answer', async () => {
  await asPlatform('darwin', {}, async () => {
    const asked = [];
    const moves = [];
    const dialog = { showMessageBoxSync: (opts) => { asked.push(opts.message); return 1; } };
    const m = loadMain(undefined, { dialog });
    try {
      Object.assign(m.electron.app, { isPackaged: true, isInApplicationsFolder: () => false, moveToApplicationsFolder: () => { moves.push(1); return true; } });
      m.ready.resolve();
      await flush();
      assert.deepEqual(asked, ['Move Spaci to your Applications folder?']);
      assert.deepEqual(moves, [], 'Not Now: nothing moved');
      assert.equal(m.counts.windows >= 1, true, 'and Spaci starts normally');
      const prefs = await m.handlers['prefs:get']();
      assert.equal(prefs.moveToApplicationsAnswer, 'declined');
      // The renderer cannot re-arm the prompt.
      await m.handlers['prefs:set']({}, { moveToApplicationsAnswer: null });
      assert.equal((await m.handlers['prefs:get']()).moveToApplicationsAnswer, 'declined');
      m.appEvents.emit('before-quit');
    } finally { m.cleanup(); }

    // Choosing Move: nothing else starts, Electron relaunches the moved copy.
    const m2 = loadMain(undefined, { dialog: { showMessageBoxSync: () => 0 } });
    try {
      Object.assign(m2.electron.app, { isPackaged: true, isInApplicationsFolder: () => false, moveToApplicationsFolder: (o) => { moves.push(o.conflictHandler('existsAndRunning')); return true; } });
      m2.ready.resolve();
      await flush();
      assert.deepEqual(moves, [false], 'moved, never killing a running copy');
      assert.equal(m2.counts.windows, 0, 'no window, tray or timers before the relaunch');
      assert.equal(m2.counts.trays, 0);
    } finally { m2.cleanup(); }
  });
});

test('docker volumes IPC: cached listing, confirmation and allowlist gates, one removal with a v2 history entry; restart only when unresponsive', async () => {
  const workerCalls = [];
  let state = 'running';
  let listed = [
    { name: 'shop_db', sizeBytes: 5000, project: 'shop', inUse: true, containers: ['shop-db-1'], createdAt: null, anonymous: false },
    { name: 'shop_uploads', sizeBytes: 3000, project: 'shop', inUse: false, containers: [], createdAt: '2026-01-01T00:00:00Z', anonymous: false },
  ];
  const docker = {
    status: async (o) => { workerCalls.push(['status', o]); return { state, running: state === 'running', remote: false }; },
    listVolumes: async () => { workerCalls.push(['listVolumes']); return listed; },
    groupVolumesByProject: require('../src/docker').groupVolumesByProject,
    removeVolume: async (name, o) => { workerCalls.push(['removeVolume', name, o]); return { ok: true, name, removed: true }; },
    restartDesktop: async (o) => { workerCalls.push(['restartDesktop']); if (o && o.onProgress) o.onProgress({ phase: 'quitting' }); return { ok: true, state: 'running', message: 'Docker Desktop restarted and the engine is answering.' }; },
  };
  const m = loadMain(undefined, { docker });
  try {
    m.ready.resolve();
    await flush();
    const v = await m.handlers['docker:volumes']({});
    assert.equal(v.ok, true);
    assert.deepEqual(v.volumes.map((x) => [x.name, x.size, x.inUse]), [['shop_db', 5000, true], ['shop_uploads', 3000, false]]);
    assert.deepEqual(v.groups, [{ project: 'shop', label: 'shop', volumes: ['shop_db', 'shop_uploads'], size: 8000, unusedSize: 3000, inUse: 1 }]);
    const lists = () => workerCalls.filter(([op]) => op === 'listVolumes').length;
    await m.handlers['docker:volumes']({});
    assert.equal(lists(), 1, 'cached for 60 s');
    await m.handlers['docker:volumes']({}, true);
    assert.equal(lists(), 2, 'force refreshes');

    const rm = (name, opts) => m.handlers['docker:remove-volume']({}, name, opts);
    assert.deepEqual(await rm('shop_uploads'), { ok: false, freed: 0, name: 'shop_uploads', error: 'needs-confirmation', message: 'Removing a volume needs your confirmation first.' });
    assert.equal((await rm('shop_uploads', { confirmed: 1 })).error, 'needs-confirmation');
    assert.equal((await rm('--all', { confirmed: true })).error, 'invalid-name');
    assert.equal((await rm('someone_else', { confirmed: true })).error, 'unknown-volume');
    assert.equal((await rm('shop_db', { confirmed: true })).error, 'in-use');
    assert.equal(workerCalls.filter(([op]) => op === 'removeVolume').length, 0, 'no refusal reached docker');

    const ok = await rm('shop_uploads', { confirmed: true });
    assert.deepEqual(ok, { ok: true, freed: 3000, name: 'shop_uploads' });
    assert.deepEqual(workerCalls.find(([op]) => op === 'removeVolume'), ['removeVolume', 'shop_uploads', { confirm: 'shop_uploads' }]);
    const [entry] = readHistoryFile(m);
    assert.deepEqual([entry.v, entry.scope, entry.reversible, entry.freed, entry.items[0].path], [2, 'docker', 'none', 3000, 'docker volume shop_uploads']);
    assert.ok(m.sent.some(([ch]) => ch === 'cache:updated'));
    // The listing was dropped: the next read goes back to Docker.
    listed = listed.filter((x) => x.name !== 'shop_uploads');
    assert.deepEqual((await m.handlers['docker:volumes']({})).volumes.map((x) => x.name), ['shop_db']);

    // Restart: refused while Docker runs, allowed when its engine does not answer.
    const sender = { send: (ch, p) => m.sent.push([ch, p]), isDestroyed: () => false };
    const refused = await m.handlers['docker:restart']({ sender });
    assert.deepEqual([refused.ok, refused.state, refused.error], [false, 'running', 'not-unresponsive']);
    assert.equal(workerCalls.filter(([op]) => op === 'restartDesktop').length, 0);
    state = 'engine-down';
    const restarted = await m.handlers['docker:restart']({ sender });
    assert.deepEqual([restarted.ok, restarted.state], [true, 'running']);
    assert.ok(m.sent.some(([ch, p]) => ch === 'docker:restart-progress' && p.phase === 'quitting'));
    const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    for (const ch of ['docker:volumes', 'docker:remove-volume', 'docker:restart', 'docker:restart-progress', 'app:log-path']) assert.ok(pre.includes(`'${ch}'`), ch);
    m.appEvents.emit('before-quit');
  } finally { m.cleanup(); }
});
