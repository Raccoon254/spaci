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

const SRC = path.join(__dirname, '..', 'src');

// main.js starts app-lifetime timers (the usage ping interval). Unref every
// timer in this test process so it can exit when the tests are done.
for (const name of ['setTimeout', 'setInterval']) {
  const real = global[name];
  global[name] = (...args) => { const h = real(...args); if (h && h.unref) h.unref(); return h; };
}

function loadMain(userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-')), { lock = true, shell = {}, scanner = {}, system = {}, docker = {}, notification = null, updater = null } = {}) {
  const counts = { windows: 0, trays: 0, quits: 0, shows: 0, focuses: 0, restores: 0 };
  const windows = [];
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
  const electron = {
    app: Object.assign(appEvents, {
      getPath: () => userData,
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
    dialog: {},
    shell,
    Tray: class extends EventEmitter { constructor() { super(); counts.trays++; } setToolTip(t) { sent.push(['tooltip', t]); } getBounds() { return {}; } },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createEmpty: () => img, createFromPath: () => img, createFromNamedImage: () => img },
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: () => false, getCurrentThermalState: () => 'nominal' }),
    Notification: notification || Object.assign(class {}, { isSupported: () => false }),
    net: { isOnline: () => true },
  };
  const mk = (kind) => (...args) => {
    const d = deferred();
    jobs[kind].push({ signal: args[args.length - 1], finish: d.resolve });
    return d.promise;
  };
  const stubs = {
    electron,
    [path.join(SRC, 'scanner.js')]: {
      scanProjects: mk('projects'),
      attachDockerUsage: async () => ({ inventory: { ok: false, reason: 'stub' } }),
      enrichProject: async () => ({ totalSize: 1, git: null }),
      revalidateArtifact: async () => true,
      // The real cleaner reads this from the scanner module.
      SKIP_DELETE: require('../src/scanner').SKIP_DELETE,
      ...scanner,
    },
    [path.join(SRC, 'system.js')]: { scanSystem: mk('system'), TARGETS: [], ...system },
    [path.join(SRC, 'docker.js')]: { desktopDisk: async () => null, PRUNE_KINDS: {}, reclaimSuggestions: () => [], ...docker },
    ...(updater ? { [path.join(SRC, 'updater.js')]: updater } : {}),
    [path.join(SRC, 'diskbreakdown.js')]: { diskBreakdown: async () => ({ categories: [] }), topChildren: async () => [] },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (parent && parent.filename && parent.filename.startsWith(SRC)) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* not a file */ }
      if (resolved && stubs[resolved]) return stubs[resolved];
    }
    return origLoad.apply(this, arguments);
  };
  const mainPath = path.join(SRC, 'main.js');
  const updaterPath = path.join(SRC, 'updater.js');
  delete require.cache[mainPath];
  delete require.cache[updaterPath];
  try {
    require(mainPath);
  } finally {
    Module._load = origLoad;
  }
  const cleanup = () => {
    delete require.cache[mainPath];
    delete require.cache[updaterPath];
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return { handlers, appEvents, ready, sent, jobs, userData, electron, cleanup, counts, windows };
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
  const m = loadMain(undefined, { shell });
  try {
    await m.handlers['prefs:set']({}, { scanRoots: [dir] });
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
    assert.ok(ok.totalFreed >= 11 * 1024 * 1024);
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
