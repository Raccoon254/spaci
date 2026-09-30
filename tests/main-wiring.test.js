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

function loadMain(userData = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-main-')), { lock = true } = {}) {
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
    shell: {},
    Tray: class extends EventEmitter { constructor() { super(); counts.trays++; } setToolTip(t) { sent.push(['tooltip', t]); } getBounds() { return {}; } },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createEmpty: () => img, createFromPath: () => img, createFromNamedImage: () => img },
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: () => false, getCurrentThermalState: () => 'nominal' }),
    Notification: Object.assign(class {}, { isSupported: () => false }),
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
    },
    [path.join(SRC, 'system.js')]: { scanSystem: mk('system'), TARGETS: [] },
    [path.join(SRC, 'docker.js')]: { desktopDisk: async () => null, PRUNE_KINDS: {}, reclaimSuggestions: () => [] },
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
