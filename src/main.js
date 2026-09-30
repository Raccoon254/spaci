'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerMonitor, Notification } = require('electron');
const path = require('path');

// ---------- crash log (first, before anything else can fail) ----------
// Uncaught exceptions, unhandled rejections, renderer and child process crashes
// and startup failures go to <logs>/main.log, rotated at 1 MB. Settings links to
// it (app:log-path), so a user can send it with a bug report.
const { createCrashLog, describeError } = require('./crash-log');
function logFilePath() {
  try { if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(); } catch (_) { /* keep the default */ }
  try { return path.join(app.getPath('logs'), 'main.log'); } catch (_) { /* not available this early */ }
  try { return path.join(app.getPath('userData'), 'logs', 'main.log'); } catch (_) { return null; }
}
const crashLog = createCrashLog({ file: logFilePath() });
let crashDialogShown = false;
/** Tell the user once per session; the log has every occurrence. */
function showCrashDialog(title, err) {
  if (crashDialogShown || !dialog || typeof dialog.showErrorBox !== 'function') return;
  crashDialogShown = true;
  try {
    dialog.showErrorBox(title, `${(err && err.message) || String(err)}\n\nDetails were saved to ${crashLog.file || 'the Spaci log'}.`);
  } catch (_) { /* no dialog before ready on some platforms */ }
}
process.on('uncaughtException', (err) => {
  crashLog.error('uncaughtException', err);
  console.error('[main] uncaught exception:', err);
  showCrashDialog('Spaci hit an unexpected error', err);
});
process.on('unhandledRejection', (reason) => {
  crashLog.error('unhandledRejection', reason);
  console.error('[main] unhandled rejection:', reason);
});
app.on('render-process-gone', (_e, wc, details) => {
  const d = details || {};
  let url = '';
  try { url = wc && typeof wc.getURL === 'function' ? path.basename(wc.getURL()) : ''; } catch (_) { /* destroyed */ }
  crashLog.error(`render-process-gone ${url}: reason=${d.reason} exitCode=${d.exitCode}`);
});
app.on('child-process-gone', (_e, details) => {
  const d = details || {};
  // A worker the client killed on purpose (idle, quit) exits 'clean-exit' or 'killed'.
  crashLog[d.reason === 'clean-exit' ? 'info' : 'error'](`child-process-gone type=${d.type} name=${d.name || d.serviceName || ''} reason=${d.reason} exitCode=${d.exitCode}`);
});

const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const crypto = require('crypto');

// Scanning itself (scanner, languages, diskbreakdown, largefiles, aitools and
// Docker's spawning calls) runs in the scan worker (src/scan-worker.js), never
// here: spawning from Electron's main process blocks the UI. system.js and
// docker.js are loaded only for their static tables and pure helpers.
const system = require('./system');
const docker = require('./docker');
const cleaner = require('./cleaner');
const { trashFiles } = require('./trash-files');
const cleanGuard = require('./clean-guard');
const telemetry = require('./telemetry');
const { createWorkerClient, workerEntryPath, utilityTransport } = require('./worker-client');
const { initUpdater, getUpdateController } = require('./updater');
const { createCacheStore, writeFileAtomic } = require('./scan-cache');
const { createScanCoordinator, singleFlight, keyedSingleFlight } = require('./scan-coordinator');
const { createScheduler, backgroundGate, clampIntervalHours, HOUR } = require('./scheduler');
const { createScanService, enrichRecord } = require('./background');
const { startupRole, focusPlan } = require('./instance');
const { sanitizeTechId, sanitizeFlavor } = require('./tech-ids');
const { sanitizeBrandId, sanitizeTheme, hasDark: brandHasDark } = require('./brand-ids');
const { createNoticesService } = require('./notices');
const { createMediaCache } = require('./notice-media');
const historyLog = require('./history-log');
const restoreHints = require('./restore-hints');
const cleanPlan = require('./clean-plan');
const ipcGuards = require('./ipc-guards');
const dockerVolumes = require('./docker-volumes');
const recommendations = require('./recommendations');
const reclaimable = require('./reclaimable');
const { fmt } = recommendations;
const trayPolicy = require('./tray-policy');
const installLocation = require('./install-location');

const isDev = process.argv.includes('--dev');

// ---------- single instance ----------
// One Spaci per user-data dir: a second launch (login item plus a manual open,
// a dock click while the tray app runs) must not start a second scheduler that
// races this one on cache.json and history.json. The lock is per user-data dir,
// so --user-data-dir=<other> still runs an isolated copy. A secondary instance
// quits before any window, tray or timer exists (see the whenReady guard).
const isPrimary = startupRole(app.requestSingleInstanceLock()) === 'primary';
if (!isPrimary) app.quit();
// Windows groups the taskbar button and routes notifications by this id; it
// must match build.appId or toasts are attributed to electron.exe.
if (process.platform === 'win32') { try { app.setAppUserModelId('ke.co.kentom.spaci'); } catch (_) { /* older Electron */ } }
let win;
let tray = null;
let isQuitting = false;
const aborts = {}; // per-type scan AbortControllers, so scans run independently

// ---------- preferences ----------
const PREFS_PATH = path.join(app.getPath('userData'), 'preferences.json');
const DEFAULT_PREFS = {
  onboarded: false,
  theme: 'dark',
  scanRoots: [os.homedir()],
  confirmBeforeClean: true,
  staleDays: 60,
  backgroundScans: true,
  scanIntervalHours: 6,
  autoCheckUpdates: true,
  // In-app notices (src/notices.js). lastSeenVersion has no default on purpose:
  // its absence on an onboarded install means an upgrade from before 2.3.
  notices: true,
  dismissedNotices: [],
  seenNoticeIds: [],
};
// Written only by the notices service, never through prefs:set, so a renderer
// that saves a stale copy of its prefs cannot resurrect a dismissed notice.
// moveToApplicationsAnswer is main's own too: the renderer cannot re-arm the prompt.
const NOTICE_OWNED_PREFS = ['dismissedNotices', 'seenNoticeIds', 'notifiedNoticeIds', 'lastSeenVersion', installLocation.PREF];
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) {
  // Atomic: a crash mid-write must not truncate the file, or the next load
  // falls back to defaults and the next save wipes the user's settings.
  try { writeFileAtomic(PREFS_PATH, JSON.stringify(p, null, 2)); }
  catch (e) { console.error('savePrefs', e); }
}
/** Merge a few keys into the latest prefs on disk (read, merge, atomic write). */
function patchPrefs(patch) { savePrefs({ ...loadPrefs(), ...patch }); }

// ---------- anonymous usage ping ----------
// Once a day: a random install ID, the version and the OS. Nothing else. The
// user can switch it off in Settings (prefs.telemetry === false).
function sendUsagePing() {
  // Dev runs are not users; never count them.
  if (!app.isPackaged) return;
  telemetry.maybePing({
    prefs: loadPrefs(),
    // Merge only telemetry's own keys into the latest prefs, so a setting the
    // user changes while the request is in flight is never overwritten. This
    // write throws on failure, which stops the ping: an install ID that was
    // not saved would otherwise count as a new user every day.
    savePrefs: (p) => {
      const next = { ...loadPrefs(), installId: p.installId, lastPingDate: p.lastPingDate };
      writeFileAtomic(PREFS_PATH, JSON.stringify(next, null, 2));
    },
    version: app.getVersion(),
  }).catch(() => { /* never let analytics touch the app */ });
}

// ---------- scan cache + background scanning ----------
// The cache is read through scan-cache.normalizeCache, so a truncated or
// old-format cache.json starts fresh instead of crashing, and every write is
// atomic (temp file, then rename). `cache` is the store's live object.
const CACHE_PATH = path.join(app.getPath('userData'), 'cache.json');
const cacheStore = createCacheStore({ file: CACHE_PATH });
if (cacheStore.loadStatus === 'corrupt') console.warn('[cache] cache.json was unreadable; it will be rebuilt by the next scan');
const cache = cacheStore.get();
function writeCache() { return cacheStore.write(); }
// A cache written by an older version carries that version's safety flags (the
// Trash was once safe:true, so it would be preselected until the next scan).
// The current catalog always wins for safe, reversible and the wording.
function applyCurrentTargetFlags(list) {
  const byId = new Map(system.TARGETS.map((t) => [t.id, t]));
  for (const t of Array.isArray(list) ? list : []) {
    const cur = t && byId.get(t.id);
    if (!cur) continue;
    t.safe = cur.safe;
    t.reversible = cur.reversible;
    t.description = cur.description;
    if (cur.restoreHint) t.restoreHint = cur.restoreHint; else delete t.restoreHint;
  }
}
applyCurrentTargetFlags(cache.system);
// Language analysis cache snapshot (see tech-cache.js). Kept out of cache.json,
// which is sent to the renderer whole; the worker validates every entry.
const TECH_CACHE_PATH = path.join(app.getPath('userData'), 'tech-cache.json');
let techSnapshot = null;
function readTechSnapshot() {
  if (techSnapshot === null) {
    try { const v = JSON.parse(fs.readFileSync(TECH_CACHE_PATH, 'utf8')); techSnapshot = Array.isArray(v) ? v : []; }
    catch { techSnapshot = []; }
  }
  return techSnapshot;
}
function saveTechSnapshot(list) {
  techSnapshot = list;
  if (isQuitting) return; // nothing is written once quitting
  try { writeFileAtomic(TECH_CACHE_PATH, JSON.stringify(list)); }
  catch (e) { console.warn('[tech-cache] not saved:', e && e.message); }
}
const scanCoordinator = createScanCoordinator();
let scanService = null; // created below, once refreshDocker/refreshBreakdown exist
let bgScheduler = null; // started in app.whenReady (powerMonitor needs a ready app)

// ---------- cleanup history (logs of cleaned projects/caches) ----------
// Entry shapes live in history-log.js. A clean writes a 'started' entry before
// deleting and replaces it by id when done; entries left 'started' by a crash
// become 'interrupted' on the next launch.
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
function readHistory() {
  try { const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); return Array.isArray(h) ? h : []; }
  catch { return []; }
}
function putHistory(entry) {
  try { writeFileAtomic(HISTORY_PATH, JSON.stringify(historyLog.upsertEntry(readHistory(), entry))); }
  catch (e) { console.error('putHistory', e && e.message); }
}
function recoverInterruptedHistory() {
  try {
    const { history, changed } = historyLog.markInterrupted(readHistory());
    if (changed) writeFileAtomic(HISTORY_PATH, JSON.stringify(history));
  } catch (e) { console.error('recoverInterruptedHistory', e && e.message); }
}
function newHistoryId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/** Settings > Desktop notifications. Every Notification main shows goes through this. */
function notificationsAllowed() {
  return loadPrefs().notify !== false && Notification.isSupported();
}

// ---------- scan worker ----------
// Every disk walk and every git/du/docker/pgrep spawn of a scan runs in one
// utilityProcess (src/scan-worker.js). The main process only orchestrates:
// scheduler, coordinator, cache, IPC, windows, tray. The worker starts on the
// first request, stops after a few idle minutes, is restarted after a crash
// (requests in flight fail with a clear error), and is killed, never awaited,
// on quit. Cancelling a scan aborts the op's AbortController in the worker.
// Read at load time, like the other electron imports (the wiring test stubs it).
const electronUtility = require('electron').utilityProcess;
const MIN = 60 * 1000;
const WORKER_TIMEOUTS = {
  ping: 10 * 1000,
  scanProjects: 45 * MIN, // the scheduler's own watchdog gives up after an hour
  scanSystem: 20 * MIN,
  scanLargeFiles: 45 * MIN,
  diskBreakdown: 10 * MIN,
  topChildren: 2 * MIN,
  enrichProject: 2 * MIN,
  dockerSummary: 3 * MIN,
  dockerVolumes: 3 * MIN,
  docker: 10 * MIN, // prune and Docker Desktop restart can be slow
  revalidateArtifact: MIN,
  aiToolStatus: 15 * 1000,
};
function spawnScanWorker() {
  if (!electronUtility || typeof electronUtility.fork !== 'function') throw new Error('Scanning is unavailable: this Electron build has no utilityProcess.');
  if (typeof app.isReady === 'function' && !app.isReady()) throw new Error('Scanning starts once Spaci is ready.');
  return utilityTransport(electronUtility, workerEntryPath(app.getAppPath()));
}
const scanWorker = createWorkerClient({ spawn: spawnScanWorker, timeouts: WORKER_TIMEOUTS, idleMs: 5 * MIN });
/** Run a scan operation in the worker. */
function work(op, args = [], opts = {}) { return scanWorker.request(op, args, opts); }
/**
 * Call an allowlisted docker.js export by name in the worker (the list is
 * DOCKER_ALLOWLIST in scan-worker-ops.js). Pass { onProgress } to receive the
 * function's options.onProgress events.
 */
function dockerCall(name, args = [], opts = {}) { return work('docker', [name, args], opts); }

// ---------- disk usage breakdown (by category) ----------
// Single flight: every cache:updated makes the renderer ask for the breakdown
// again, and each refresh walks the whole home folder. Concurrent callers share
// one walk, and a reader only triggers a new walk when the last one is stale.
const BREAKDOWN_FRESH_MS = 10 * 60 * 1000;
const refreshBreakdown = singleFlight(async () => {
  const started = Date.now();
  try {
    const b = await work('diskBreakdown', [os.homedir()]);
    cache.diskBreakdown = { ...b, at: Date.now(), meta: { ...(b.meta || {}), durationMs: Date.now() - started } };
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('disk:breakdown-updated', cache.diskBreakdown);
    return cache.diskBreakdown;
  } catch (e) {
    console.error('[breakdown] failed:', e && e.message);
    return cache.diskBreakdown || null;
  }
});
function breakdownIsFresh() {
  return Boolean(cache.diskBreakdown && Date.now() - (cache.diskBreakdown.at || 0) < BREAKDOWN_FRESH_MS);
}
// ---------- docker ----------
/**
 * One daemon round trip per scan: the totals for the Docker card, plus the
 * per-project attribution folded into the freshly scanned projects. Keeping the
 * heavy lists out of `cache` matters, they are written to disk on every scan.
 */
async function refreshDocker(projects, options = {}) {
  cache.docker = await computeDocker(projects, options);
  return cache.docker;
}
/** The Docker summary for a scan, without touching the cache (scans commit it). */
async function computeDocker(projects, options = {}) {
  try {
    // The worker gets only { path, docker } per project and answers with the
    // summary plus the docker record of each project it attributed storage to.
    const list = projects || [];
    const stubs = list.map((p) => ({ path: p.path, docker: p.docker || null }));
    const { summary, attached } = await work('dockerSummary', [stubs, options]);
    for (const a of attached || []) if (list[a.index]) list[a.index].docker = a.docker;
    // The Docker headline without volumes and containers (issue #13).
    if (summary && summary.ok && !summary.cleanable) summary.cleanable = reclaimable.dockerFigures(summary.categories);
    return summary;
  } catch (e) {
    return { ok: false, reason: 'error', error: e && e.message, at: Date.now() };
  }
}

/** Projects worth keeping: real artifacts on disk, or storage held in Docker. */
function keepProject(p) {
  return Boolean(p.items.length || (p.docker && p.docker.usage));
}

function updateTrayTitle() {
  if (!tray) return;
  // Safe project items and safe system targets only: what a clean would remove.
  const reclaim = reclaimable.grandTotal({ projects: cache.projects || [], system: cache.system || [] });
  tray.setToolTip(reclaim > 0 ? `Spaci · ${fmt(reclaim)} reclaimable` : 'Spaci');
}

scanService = createScanService({
  coordinator: scanCoordinator,
  store: cacheStore,
  // Project scans also attach `languages` and `primary` to every project (in
  // the worker), so the project list shows language strips for every row.
  // The worker's language cache dies with the worker (it stops when idle), so
  // main keeps a snapshot in tech-cache.json and seeds each scan with it.
  scanProjects: async (root, onProgress, signal) => {
    const res = await work('scanProjects', [root, { languages: true, techSeed: readTechSnapshot() }], { onProgress, signal });
    if (res && Array.isArray(res.techCache)) {
      saveTechSnapshot(res.techCache);
      delete res.techCache;
    }
    return res;
  },
  scanSystem: (onProgress, signal) => work('scanSystem', [], { onProgress, signal }),
  computeDocker: (projects) => computeDocker(projects),
  enrichProject: (dir, signal) => work('enrichProject', [dir], { signal }),
  refreshBreakdown: () => refreshBreakdown(),
  keepProject,
  getRoot: () => (loadPrefs().scanRoots || [])[0] || os.homedir(),
  emit: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
  onCommitted: () => updateTrayTitle(),
});

/** Inputs for the "is now a good time for a heavy scan" decision. */
function scanConditions() {
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (_) { return d; } };
  return {
    onBattery: safe(() => (typeof powerMonitor.isOnBatteryPower === 'function' ? powerMonitor.isOnBatteryPower() : powerMonitor.onBatteryPower), false),
    thermalState: safe(() => (typeof powerMonitor.getCurrentThermalState === 'function' ? powerMonitor.getCurrentThermalState() : 'unknown'), 'unknown'),
    loadRatio: safe(() => os.loadavg()[0] / Math.max(1, os.cpus().length), 0),
    busy: scanCoordinator.busy(),
  };
}

/** A manual scan of both kinds counts as a completed run for the scheduler. */
function scheduleState() {
  const s = cache.schedule || {};
  const k = cache.kindScannedAt || {};
  // A timestamp from the future (clock corrected by NTP) says nothing about
  // when we last scanned; counting it would stall or loop the scheduler.
  const t = Date.now();
  const seen = (v) => (typeof v === 'number' && v > 0 && v <= t ? v : 0);
  const manual = Math.min(seen(k.projects), seen(k.system));
  return { ...s, lastCompletedAt: Math.max(s.lastCompletedAt || 0, manual) };
}

function createBackgroundScheduler() {
  return createScheduler({
    name: 'bg-scan',
    task: () => scanService.backgroundRun(),
    getConfig: () => ({ intervalMs: clampIntervalHours(loadPrefs().scanIntervalHours) * HOUR }),
    gate: (force) => {
      const prefs = loadPrefs();
      return backgroundGate({ enabled: Boolean(prefs.backgroundScans), onboarded: Boolean(prefs.onboarded), force, ...scanConditions() });
    },
    getState: scheduleState,
    // A background pass normally takes minutes; give up after an hour, abort it
    // and make sure its late result is never written.
    options: { runTimeoutMs: 60 * 60 * 1000 },
    onTimeout: () => scanService.expireBackground(),
    saveState: (st) => {
      cache.schedule = { ...(cache.schedule || {}), lastCompletedAt: st.lastCompletedAt || 0, lastAttemptAt: st.lastAttemptAt || 0, failures: st.failures || 0 };
      writeCache();
    },
  });
}

// ---------- notices and What's new ----------
// Policy, validation and scheduling live in notices.js, notice-model.js and
// notice-media.js (tested without Electron). This is only the wiring.
let noticesService = null; // created in app.whenReady
const NOTICES_PATH = path.join(app.getPath('userData'), 'notices.json');
const liveNotifications = new Set(); // keeps click handlers alive until the notification goes away

/** Show the main window on one notice. Waits for the page if the window is new. */
function openNoticeInWindow(id) {
  showWin();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const send = () => { try { if (!wc.isDestroyed()) wc.send('notices:updated', { reason: 'open', id }); } catch (_) { /* window gone */ } };
  if (typeof wc.isLoading === 'function' && wc.isLoading()) wc.once('did-finish-load', send);
  else send();
}

function notifyNotice(notice) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: notice.title, body: notice.summary || '' });
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => { release(); if (noticesService && noticesService.has(notice.id)) openNoticeInWindow(notice.id); else showWin(); });
  n.on('close', release);
  n.show();
}

// Read at load time, like the other electron imports (the wiring test stubs it).
const electronNet = require('electron').net;
function createNotices() {
  const net = electronNet;
  // Chromium's network stack (system proxy, certificate store) when available.
  const fetchImpl = net && typeof net.fetch === 'function' ? (url, init) => net.fetch(url, init) : globalThis.fetch;
  return createNoticesService({
    fetchImpl,
    version: app.getVersion(),
    platform: telemetry.mapPlatform(process.platform),
    getPrefs: loadPrefs,
    patchPrefs,
    store: {
      load: () => JSON.parse(fs.readFileSync(NOTICES_PATH, 'utf8')),
      save: (data) => writeFileAtomic(NOTICES_PATH, JSON.stringify(data)),
    },
    media: createMediaCache({ dir: path.join(app.getPath('userData'), 'notice-media') }),
    notify: notifyNotice,
    emit: (payload) => { if (win && !win.isDestroyed()) win.webContents.send('notices:updated', payload); },
    // Bundled with the app (package.json build.files): the offline What's new.
    readChangelog: () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8')),
  });
}

// ---------- window ----------
/** No new windows and no navigation away from Spaci's own page (ipc-guards.guardNavigation). */
function hardenWindow(w) {
  ipcGuards.guardNavigation(w && w.webContents, {
    openExternal: (url) => shell.openExternal(url),
    log: (msg) => crashLog.warn(msg),
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 920, minHeight: 620,
    backgroundColor: '#202020',
    // Linux has no bundle icon to fall back on when no .desktop entry matches.
    ...(process.platform === 'linux' ? { icon: path.join(__dirname, '..', 'assets', 'branding', 'icon.png') } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(win);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, _lvl, message, line, src) => {
    console.log('[renderer]', message, src ? '(' + src.split('/').pop() + ':' + line + ')' : '');
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', err && err.message));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  // Closing the window hides it, so the app keeps running in the menu bar or
  // tray. Without a usable tray (some Linux desktops) closing quits instead,
  // or the app would be running with no way back to it.
  win.on('close', (e) => {
    const action = trayPolicy.closeAction({ platform: process.platform, hasTray: trayUsable, isQuitting });
    if (action === 'hide') { e.preventDefault(); win.hide(); }
    else if (action === 'quit') { isQuitting = true; app.quit(); }
  });
}

function showWin() { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } }

/** A second launch was attempted: bring this instance's main window forward. */
function focusExisting() {
  const plan = focusPlan({
    exists: Boolean(win),
    destroyed: Boolean(win && win.isDestroyed()),
    minimized: Boolean(win && !win.isDestroyed() && win.isMinimized && win.isMinimized()),
  });
  for (const step of plan) {
    if (step === 'create') createWindow();
    else if (step === 'restore') win.restore();
    else if (step === 'show') win.show();
    else if (step === 'focus' && win && !win.isDestroyed()) win.focus();
  }
  if (process.platform === 'darwin') { try { app.focus({ steal: true }); } catch (_) { /* older macOS */ } }
}
if (isPrimary) {
  app.on('second-instance', () => { app.whenReady().then(focusExisting); });
}

// ---------- menu bar widget (tray popover) ----------
let trayWin = null;
const TRAY_W = 372;
const TRAY_H = 512;

function createTrayWindow() {
  trayWin = new BrowserWindow({
    width: TRAY_W,
    height: TRAY_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(trayWin);
  trayWin.loadFile(path.join(__dirname, 'renderer', 'tray.html'));
  trayWin.on('blur', () => { if (trayWin && !trayWin.isDestroyed()) trayWin.hide(); });
  // Hide instead of closing, except when quitting: a prevented close cancels
  // app.quit(), which would block both "Quit Spaci" and restart-to-update.
  trayWin.on('close', (e) => { if (!isQuitting) { e.preventDefault(); trayWin.hide(); } });
}

function toggleTrayPopover(_e, clickBounds) {
  if (!trayWin || trayWin.isDestroyed()) createTrayWindow();
  if (trayWin.isVisible()) { trayWin.hide(); return; }
  // Next to the tray icon, kept on screen. getBounds() is all zeros on Linux
  // and sometimes on Windows, so fall back to the pointer, then to the
  // taskbar's corner (tray-policy.popoverPosition).
  try {
    const screen = require('electron').screen;
    let tb = clickBounds && clickBounds.width ? clickBounds : null;
    if (!tb) { try { tb = tray.getBounds(); } catch (_) { tb = null; } }
    let cursor = null;
    try { cursor = screen.getCursorScreenPoint(); } catch (_) { cursor = null; }
    const hasBounds = tb && tb.width > 0 && tb.height > 0;
    const probe = hasBounds ? { x: Math.round(tb.x), y: Math.round(tb.y) } : cursor;
    const display = probe ? screen.getDisplayNearestPoint(probe) : screen.getPrimaryDisplay();
    const pos = trayPolicy.popoverPosition({ platform: process.platform, trayBounds: tb, cursor, display, width: TRAY_W, height: TRAY_H });
    trayWin.setPosition(pos.x, pos.y, false);
  } catch (e) { crashLog.warn(`tray popover position: ${e && e.message}`); }
  trayWin.show();
  trayWin.focus();
}

let updateReadyVersion = null;
const TRAY_ACTIONS = {
  open: () => showWin(),
  scan: () => { showWin(); if (win && !win.isDestroyed()) win.webContents.send('tray:scan'); },
  update: () => { const u = getUpdateController(); if (u) u.install(); },
  quit: () => { isQuitting = true; app.quit(); },
};
function buildTrayMenu() {
  return Menu.buildFromTemplate(trayPolicy.trayMenuItems({ updateReadyVersion }).map((it) => (
    it.type === 'separator' ? { type: 'separator' } : { label: it.label, click: TRAY_ACTIONS[it.id] }
  )));
}
/** Linux shows only the context menu, so it is set up front and rebuilt when an update is ready or withdrawn. */
function refreshTrayMenu() {
  if (!tray || !trayPolicy.usesContextMenuOnly(process.platform)) return;
  try { tray.setContextMenu(buildTrayMenu()); } catch (e) { crashLog.warn(`tray menu: ${e && e.message}`); }
}

/** A verified update finished downloading: say so once, outside the Settings screen too. */
function announceUpdate(version) {
  updateReadyVersion = version;
  refreshTrayMenu();
  try {
    if (notificationsAllowed()) {
      const n = new Notification({
        title: `Spaci ${version} is ready`,
        body: 'Restart Spaci to finish updating, or it will update the next time you quit.',
      });
      n.on('click', () => {
        showWin();
        if (win && !win.isDestroyed()) win.webContents.send('nav:go', 'settings');
      });
      n.show();
    }
  } catch (e) { console.warn('[update] notification failed:', e && e.message); }
}

function trayImage() {
  const spec = trayPolicy.trayIconSpec(process.platform);
  let image = nativeImage.createEmpty();
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'branding', spec.file));
    if (img && !img.isEmpty() && spec.size && typeof img.resize === 'function') img = img.resize({ width: spec.size, height: spec.size });
    if (img && !img.isEmpty()) { if (spec.template) img.setTemplateImage(true); image = img; }
    else if (process.platform === 'darwin') image = nativeImage.createFromNamedImage('NSActionTemplate', [0, 0, 0]);
  } catch (_) {
    if (process.platform === 'darwin') { try { image = nativeImage.createFromNamedImage('NSActionTemplate'); } catch (e2) { /* keep empty */ } }
  }
  return image;
}

// False when there is no tray to return to (it failed, or this Linux desktop
// cannot show one); closing the window then quits.
let trayUsable = false;
function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    tray = null;
    crashLog.warn(`no tray: ${e && e.message}`);
    return;
  }
  trayUsable = process.platform !== 'linux' || trayPolicy.linuxTrayLikelyWorks(process.env);
  tray.setToolTip('Spaci');
  if (trayPolicy.usesContextMenuOnly(process.platform)) {
    // AppIndicator trays never send click events: the menu is the whole UI.
    refreshTrayMenu();
    return;
  }
  // Left click opens the popover widget; right click shows the classic menu,
  // rebuilt each time so it can offer a downloaded update.
  tray.on('click', toggleTrayPopover);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  createTrayWindow();
}

/**
 * Startup failed: say so in a dialog (with where the log is) and quit, rather
 * than leaving a process with no window.
 */
function startupFailed(err) {
  crashLog.error('startup failed', err);
  console.error('[main] startup failed:', err);
  showCrashDialog('Spaci could not start', err);
  isQuitting = true;
  try { app.quit(); } catch (_) { /* already quitting */ }
}

app.whenReady().then(() => {
  if (!isPrimary) return; // quitting: no window, tray, timers or updater
  crashLog.info(`Spaci ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron || 'n/a'})`);
  startApp();
}).catch(startupFailed);

/**
 * macOS, first packaged launch outside /Applications: offer to move there
 * (once). True when the move is under way, in which case Electron quits and
 * relaunches the moved copy, so nothing else may start.
 */
function maybeMoveToApplications() {
  let inApplications = true;
  try { inApplications = typeof app.isInApplicationsFolder === 'function' ? app.isInApplicationsFolder() : true; } catch (_) { inApplications = true; }
  const outcome = installLocation.offerMove({
    platform: process.platform,
    isPackaged: app.isPackaged,
    inApplications,
    prefs: loadPrefs(),
    ask: () => dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Move to Applications', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Move Spaci to your Applications folder?',
      detail: 'Spaci is running from outside Applications. Moved there, it can keep itself up to date and it stays put when you eject the disk image or clean up Downloads. Spaci will ask only once.',
    }) === 0,
    move: () => {
      isQuitting = true;
      const moved = app.moveToApplicationsFolder({ conflictHandler: installLocation.conflictChoice });
      if (!moved) isQuitting = false;
      return moved;
    },
    save: patchPrefs,
    log: (msg) => crashLog.warn(msg),
  });
  if (outcome) crashLog.info(`move to Applications: ${outcome}`);
  return outcome === 'moved';
}

function startApp() {
  if (maybeMoveToApplications()) return;
  // Before any clean can run: a 'started' entry left by a crash is not "done".
  recoverInterruptedHistory();
  // Off the startup path; the interval catches an app left open past midnight.
  setTimeout(sendUsagePing, 10000);
  setInterval(sendUsagePing, 6 * 3600 * 1000);
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'branding', 'icon.png'))); } catch (_) { /* */ }
  }
  createWindow();
  createTray();
  updateTrayTitle();
  bgScheduler = createBackgroundScheduler();
  bgScheduler.start();
  noticesService = createNotices();
  noticesService.start();
  const updates = initUpdater(() => win, {
    getPrefs: loadPrefs,
    beforeInstall: () => { isQuitting = true; },
    onReady: announceUpdate,
    // Squirrel failed after "ready": drop the tray item and, if a restart was
    // under way, go back to close-to-tray behaviour.
    onReadyWithdrawn: () => { updateReadyVersion = null; refreshTrayMenu(); },
    onInstallAbandoned: () => { isQuitting = false; },
  });
  // After sleep, screen unlock or plugging in, re-check once (never a burst):
  // the schedulers recompute from the last completed run.
  const wake = () => { if (bgScheduler) bgScheduler.wake(); updates.wake(); if (noticesService) noticesService.wake(); };
  for (const ev of ['resume', 'unlock-screen', 'on-ac']) {
    try { powerMonitor.on(ev, wake); } catch (_) { /* event not supported on this platform */ }
  }
  app.on('activate', () => showWin());
}
// Keep running in the background (menu-bar tray) even with no windows open.
app.on('window-all-closed', () => { /* intentionally no quit */ });
app.on('before-quit', () => {
  isQuitting = true;
  // Stop timers and abort every scan; aborted scans can no longer commit.
  if (bgScheduler) bgScheduler.stop();
  if (noticesService) noticesService.stop();
  const u = getUpdateController();
  if (u) u.stop();
  scanCoordinator.abortAll('quit');
  // Kill the scan worker now instead of waiting for its ops to wind down, so
  // Quit is never held up by a scan. A cancelled quit simply starts a new one.
  Object.values(aborts).forEach((a) => a && a.abort());
  scanWorker.stop('quit');
});
app.on('will-quit', () => {
  // Past this point nothing is written: a scan that settles late is dropped.
  scanService.close();
  scanWorker.close();
});

// ---------- helpers ----------
// Cross-platform disk usage via fs.statfs (macOS/Linux/Windows), with a df fallback.
async function diskUsage(targetPath) {
  const p = targetPath || os.homedir();
  if (fsp.statfs) {
    try {
      const s = await fsp.statfs(p);
      const total = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      const used = total - s.bfree * s.bsize;
      return { total, used, avail, capacity: total ? Math.round((used / total) * 100) + '%' : '0%' };
    } catch (_) { /* fall through */ }
  }
  return await new Promise((resolve) => {
    execFile('df', ['-k', p], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split('\n').pop().split(/\s+/);
      const total = Number(line[1]) * 1024, used = Number(line[2]) * 1024, avail = Number(line[3]) * 1024;
      resolve({ total, used, avail, capacity: line[4] });
    });
  });
}

// Reads a two-tone UI icon SVG from src/renderer/icons/<name>.svg. The name is
// sanitized to letters/digits/dashes so it can never escape the icons folder
// (path traversal), and works the same inside the packaged asar. Returns the
// raw SVG text, or null when the icon does not exist.
const iconCache = new Map();
function getIcon(name) {
  const key = String(name == null ? '' : name).replace(/[^a-z0-9-]/gi, '');
  if (iconCache.has(key)) return iconCache.get(key);
  let svg = null;
  try { svg = fs.readFileSync(path.join(__dirname, 'renderer', 'icons', key + '.svg'), 'utf8'); }
  catch { svg = null; }
  iconCache.set(key, svg);
  return svg;
}

// Catppuccin language/framework icons from src/renderer/icons/tech/<flavor>/<id>.svg.
// The id must be a plain [a-z0-9-] token and the flavor exactly mocha or latte
// (default mocha), so nothing can escape the folder. Returns null when missing.
const techIconCache = new Map();
function getTechIcon(id, flavor) {
  const key = sanitizeTechId(id);
  if (!key) return null;
  const fl = sanitizeFlavor(flavor);
  const ck = fl + '/' + key;
  if (techIconCache.has(ck)) return techIconCache.get(ck);
  let svg = null;
  try { svg = fs.readFileSync(path.join(__dirname, 'renderer', 'icons', 'tech', fl, key + '.svg'), 'utf8'); }
  catch { svg = null; }
  techIconCache.set(ck, svg);
  return svg;
}

// Vendored brand logos from src/renderer/icons/brand. Ids are checked against
// the vendored list; theme 'dark' prefers <id>-dark.svg when one exists.
const brandIconCache = new Map();
function getBrandIcon(id, theme) {
  const key = sanitizeBrandId(id);
  if (!key) return null;
  const th = sanitizeTheme(theme);
  const file = th === 'dark' && brandHasDark.has(key) ? key + '-dark' : key;
  if (brandIconCache.has(file)) return brandIconCache.get(file);
  let svg = null;
  try { svg = fs.readFileSync(path.join(__dirname, 'renderer', 'icons', 'brand', file + '.svg'), 'utf8'); }
  catch { svg = null; }
  brandIconCache.set(file, svg);
  return svg;
}

// ---------- IPC ----------
ipcMain.handle('prefs:get', () => loadPrefs());
ipcMain.handle('prefs:set', (_e, patch) => {
  const current = loadPrefs();
  const clean = { ...(patch && typeof patch === 'object' ? patch : {}) };
  for (const k of NOTICE_OWNED_PREFS) delete clean[k];
  if ('notices' in clean && typeof clean.notices !== 'boolean') delete clean.notices;
  const p = { ...current, ...clean };
  if (Object.prototype.hasOwnProperty.call(clean, 'scanRoots')) {
    p.scanRoots = ipcGuards.acceptScanRoots(clean.scanRoots, {
      home: os.homedir(), current: current.scanRoots, picked: pickedFolders,
    });
  }
  savePrefs(p);
  // Debounced and idempotent: a theme toggle never triggers a scan by itself.
  if (bgScheduler) bgScheduler.reschedule();
  if (noticesService) noticesService.reschedule();
  const u = getUpdateController();
  if (u) u.reschedule();
  return p;
});
ipcMain.handle('app:home', () => os.homedir());
// Settings > Diagnostics: where the main log lives (it may not exist yet).
ipcMain.handle('app:log-path', () => crashLog.file || null);
ipcMain.handle('win:show', (_e, route) => {
  showWin();
  if (route && win && !win.isDestroyed()) win.webContents.send('nav:go', route);
  if (trayWin && !trayWin.isDestroyed()) trayWin.hide();
});
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
ipcMain.handle('disk:usage', (_e, p) => diskUsage(p));
ipcMain.handle('disk:breakdown', async () => {
  if (cache.diskBreakdown) { if (!breakdownIsFresh()) refreshBreakdown(); return cache.diskBreakdown; }
  return await refreshBreakdown();
});
ipcMain.handle('icon:get', (_e, name) => getIcon(name));
ipcMain.handle('techicon:get', (_e, id, flavor) => getTechIcon(id, flavor));
ipcMain.handle('brandicon:get', (_e, id, theme) => getBrandIcon(id, theme));

// Biggest immediate children of a category's directories (Storage drill-down).
// Children of the breakdown's own category folders become openable (open:path),
// since Spaci listed them itself; children of any other folder do not.
let lastTopChildren = new Set();
ipcMain.handle('fs:top-children', async (_e, dirs) => {
  const list = Array.isArray(dirs) ? dirs : [];
  const items = await work('topChildren', [list, 25]).catch((e) => { console.error('[top-children] failed:', e && e.message); return []; });
  const categoryDirs = ipcGuards.knownPathSet(((cache.diskBreakdown && cache.diskBreakdown.categories) || []).flatMap((c) => (c && c.dirs) || []));
  const parents = ipcGuards.knownPathSet(list.filter((d) => categoryDirs.has(d)));
  // Accumulate rather than replace: the renderer keeps each category's list, so
  // going back to an earlier category must not break its Open buttons.
  for (const it of items || []) if (it && parents.has(path.dirname(it.path))) lastTopChildren.add(it.path);
  return items;
});
ipcMain.handle('cache:get', () => cache);
// Explicit request: bypasses the battery/load gate, joins a run in flight.
ipcMain.handle('scan:now', () => { if (bgScheduler) bgScheduler.runNow(); return true; });

// Folders the user chose in the native picker. Only these (or folders inside
// home) may become scan roots, so a renderer cannot widen its own reach.
const pickedFolders = new Set();
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  pickedFolders.add(r.filePaths[0]);
  return r.filePaths[0];
});

// A progress sender that survives the window closing mid-scan.
function progressTo(sender, channel) {
  return (p) => { try { if (!sender.isDestroyed()) sender.send(channel, p); } catch (_) { /* window gone */ } };
}

// Manual scans go through the scan service: at most one per kind, a newer
// manual scan supersedes an older one (whose caller then gets the newer
// result), and a background scan of the same kind is pre-empted.
ipcMain.handle('scan:projects', (e, root) => {
  // Default to the configured scan root (the home folder) so Projects scans
  // automatically without the user having to pick a folder first.
  root = root || (loadPrefs().scanRoots || [])[0] || os.homedir();
  return scanService.manualProjects(root, progressTo(e.sender, 'scan:progress'));
});

ipcMain.handle('scan:system', (e) => scanService.manualSystem(progressTo(e.sender, 'system:progress')));

ipcMain.handle('scan:cancel', (_e, type) => {
  if (type === 'projects' || type === 'system') scanService.cancel(type);
  else if (type) aborts[type]?.abort();
  else { scanService.cancel(); Object.values(aborts).forEach((a) => a && a.abort()); }
  return true;
});

// ---------- docker ----------
// Cheap and cached: the System screen asks on every paint.
ipcMain.handle('docker:status', async (_e, force) => {
  if (!force && cache.docker && Date.now() - cache.docker.at < 60000) return cache.docker;
  const result = await refreshDocker(cache.projects || [], { force: Boolean(force) });
  writeCache();
  return result;
});

ipcMain.handle('docker:kinds', () => Object.values(docker.PRUNE_KINDS)
  .map(({ id, name, safe, reversible, description }) => ({ id, name, safe, reversible: reversible === true, description })));

// Reclaim one allowlisted category. The kind is validated inside docker.prune,
// so an unexpected value from the renderer can never become a docker argument.
ipcMain.handle('docker:prune', async (_e, kind) => {
  const spec = docker.PRUNE_KINDS[kind];
  if (!spec) return { ok: false, error: 'Unknown Docker cleanup: ' + kind, freed: 0 };
  let res;
  try { res = await dockerCall('prune', [kind]); }
  catch (e) { return { ok: false, error: (e && e.message) || 'Docker cleanup failed.', freed: 0 }; }
  if (res.ok) {
    const at = Date.now();
    putHistory(historyLog.dockerEntry({
      id: newHistoryId(), at, finishedAt: at, spec, freed: res.freed,
      restoreHint: restoreHints.dockerRestoreHint(kind),
    }));
    await dockerChanged();
  }
  return res;
});

// ---------- docker volumes (review, one at a time) and Desktop restart ----------
// Rules in docker-volumes.js. The listing is cached for 60 s like docker:status;
// it is also the allowlist: only a volume it showed may be removed.
let volumesCache = null; // last volumesView
const VOLUMES_FRESH_MS = 60000;
const listVolumes = singleFlight(async (force) => {
  try {
    const raw = await work('dockerVolumes', [{ force: Boolean(force) }]);
    volumesCache = dockerVolumes.volumesView(raw);
  } catch (e) {
    volumesCache = { ok: false, state: null, volumes: [], groups: [], error: (e && e.message) || 'Could not list Docker volumes.', at: Date.now() };
  }
  return volumesCache;
});
/** Docker changed underneath us: the next reads go to the daemon. */
async function dockerChanged() {
  volumesCache = null;
  await refreshDocker(cache.projects || [], { force: true });
  writeCache();
  updateTrayTitle();
  if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
}

// api.dockerVolumes(force?) -> { ok, state, volumes: [{ name, size, project|null,
// inUse, containers, createdAt|null, anonymous }], groups: [{ project|null, label,
// volumes: [names], size, unusedSize, inUse }], at, error? }
ipcMain.handle('docker:volumes', async (_e, force) => {
  if (!force && volumesCache && Date.now() - volumesCache.at < VOLUMES_FRESH_MS) return volumesCache;
  return listVolumes(Boolean(force));
});

// api.dockerRemoveVolume(name, { confirmed: true }) -> { ok, freed, name, error?, message? }
// error codes: needs-confirmation, invalid-name, unknown-volume, in-use, failed.
ipcMain.handle('docker:remove-volume', async (_e, name, opts) => {
  const refuse = (error, message) => ({ ok: false, freed: 0, name: typeof name === 'string' ? name : null, error, message: message || dockerVolumes.REFUSAL_TEXT[error] || error });
  // Confirmation is checked before anything else, the listing included.
  if (!opts || typeof opts !== 'object' || opts.confirmed !== true) return refuse('needs-confirmation');
  if (!dockerVolumes.isVolumeName(name)) return refuse('invalid-name');
  const listing = volumesCache && volumesCache.ok ? volumesCache : await listVolumes(false);
  const decision = dockerVolumes.removalDecision(name, opts, listing);
  if (!decision.ok) return refuse(decision.error);
  let res;
  try { res = await dockerCall('removeVolume', [name, { confirm: name }]); }
  catch (e) { return refuse('failed', (e && e.message) || 'Docker could not remove the volume.'); }
  if (!res || !res.ok) {
    volumesCache = null; // what the user saw is out of date
    return refuse(res && res.inUse ? 'in-use' : 'failed', (res && res.error) || 'Docker could not remove the volume.');
  }
  const at = Date.now();
  const freed = decision.volume.size;
  putHistory(historyLog.dockerVolumeEntry({ id: newHistoryId(), at, finishedAt: at, name, project: decision.volume.project, bytes: freed }));
  await dockerChanged();
  return { ok: true, freed, name };
});

// api.dockerRestart() -> { ok, state, error?, message? }. Only when the engine
// does not answer (state 'engine-down', shown as unresponsive). Progress goes
// to 'docker:restart-progress' while Docker Desktop quits and starts again.
const restartDocker = singleFlight(async (sender) => {
  let st;
  try { st = await dockerCall('status', [{ force: true }]); }
  catch (e) { return { ok: false, state: null, error: 'failed', message: (e && e.message) || 'Could not check Docker.' }; }
  const state = (st && st.state) || null;
  if (!dockerVolumes.canRestart(state)) {
    return { ok: false, state, error: 'not-unresponsive', message: 'Docker is not stuck, so Spaci does not restart it (a restart would stop your containers).' };
  }
  let res;
  try { res = await dockerCall('restartDesktop', [{}], { onProgress: sender ? progressTo(sender, 'docker:restart-progress') : undefined }); }
  catch (e) { return { ok: false, state, error: 'failed', message: (e && e.message) || 'Docker Desktop could not be restarted.' }; }
  crashLog.info(`docker restart: ok=${Boolean(res && res.ok)} reason=${(res && res.reason) || ''}`);
  await dockerChanged();
  if (res && res.ok) return { ok: true, state: res.state || 'running', message: res.message };
  return { ok: false, state: (res && res.state) || state, error: (res && res.reason) || 'failed', message: (res && res.message) || 'Docker Desktop could not be restarted.' };
});
ipcMain.handle('docker:restart', (e) => restartDocker(e && e.sender));

const refreshEnrich = keyedSingleFlight(async (p) => {
  try {
    // Size, git, languages, frameworks, primary and analysis, all computed in the worker.
    const r = await work('enrichProject', [p]);
    cache.enrich = cache.enrich || {};
    cache.enrich[p] = enrichRecord(r, Date.now());
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('enrich:updated', { path: p, ...cache.enrich[p] });
    return cache.enrich[p];
  } catch {
    return (cache.enrich && cache.enrich[p]) || { totalSize: 0, git: null };
  }
});
// Returns cached size/git/languages instantly (refreshing in the background); pass force to recompute now.
ipcMain.handle('project:enrich', async (_e, p, force) => {
  if (!force && cache.enrich && cache.enrich[p]) { refreshEnrich(p); return cache.enrich[p]; }
  return await refreshEnrich(p);
});

// Every known system target, keyed by each of its paths. The clean handler
// re-applies the target's own rules (mode, protect, running-tool guard) from
// here, so safety never depends on the renderer passing the right fields.
const TARGET_INDEX = cleanGuard.buildTargetIndex(system.TARGETS);
let lastLargeFiles = new Set();

/** Names in a folder, for restore hints. Missing or unreadable reads as empty. */
async function listNames(dir, memo) {
  if (!memo.has(dir)) memo.set(dir, fsp.readdir(dir).catch(() => []));
  return memo.get(dir);
}

/** History item fields that are known before anything is deleted. */
async function describeJob(jobPath, plan, memo) {
  const d = { path: jobPath, kind: plan.kind, reversible: plan.reversible };
  if (plan.project) d.project = plan.project;
  if (plan.kind === 'artifact') {
    const near = await listNames(path.dirname(jobPath), memo);
    const root = plan.project ? await listNames(plan.project, memo) : [];
    d.restoreHint = restoreHints.artifactRestoreHint(jobPath, near, root);
  } else if (plan.kind === 'cache' || plan.kind === 'trash') {
    const hint = restoreHints.systemRestoreHint(plan.target);
    if (hint) d.restoreHint = hint;
  } else if (plan.kind === 'file') {
    d.restoreHint = restoreHints.TRASH_HINT;
  }
  return d;
}

// api.clean(jobs, meta), meta = { scope, label, confirmed }. Returns
// { ok, totalFreed, errors: [{ path, error, code? }], refused: [{ path, reason,
// target? }], trashed: [paths], historyId }. meta.reversible is ignored.
ipcMain.handle('clean', async (e, jobs, meta) => {
  const ac = new AbortController();
  const send = progressTo(e.sender, 'clean:progress');
  const m = meta && typeof meta === 'object' ? meta : {};
  const scope = typeof m.scope === 'string' && m.scope ? m.scope : 'projects';
  const label = typeof m.label === 'string' ? m.label : '';
  // One job per path: a duplicate would be cleaned twice and counted twice.
  const seen = new Set();
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || typeof j.path !== 'string' || !j.path) return false;
    const k = cleanGuard.keyOf(j.path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let historyId = null;
  let started = null;
  try {
    // Only paths Spaci itself produced may be deleted: system targets, project
    // artifacts from the last scan, and files from the last large-file scan.
    const projectPaths = new Set();
    for (const p of cache.projects || []) for (const it of p.items || []) projectPaths.add(it.path);
    const known = new Set([...TARGET_INDEX.keys(), ...projectPaths, ...lastLargeFiles]);
    const planCtx = cleanPlan.buildPlanContext({ targetIndex: TARGET_INDEX, projects: cache.projects || [], largeFiles: lastLargeFiles });

    // Irreversible, unsafe or large-file jobs need the user's explicit yes.
    const gate = cleanPlan.gateJobs(list, planCtx, m.confirmed === true);
    const guarded = await cleanGuard.enforceTargetRules(gate.pass, {
      index: TARGET_INDEX,
      // Both checks spawn processes (pgrep, git), so they run in the worker.
      toolStatus: () => work('aiToolStatus').catch(() => ({ ok: false, running: [] })),
      known,
      projectPaths,
      revalidate: (p) => work('revalidateArtifact', [p]),
    });
    const refused = [...gate.refused, ...guarded.refused];
    const allowed = guarded.allowed;
    if (!allowed.length) return { ok: true, totalFreed: 0, errors: [], refused, trashed: [], historyId: null };

    // Large files go to the system Trash; everything else is deleted.
    const plans = new Map(allowed.map((j) => [j, cleanPlan.classifyJob(j.path, planCtx)]));
    const toTrash = allowed.filter((j) => plans.get(j).kind === 'file');
    const toDelete = allowed.filter((j) => plans.get(j).kind !== 'file');

    const memo = new Map();
    const described = new Map();
    for (const j of allowed) described.set(j.path, await describeJob(j.path, plans.get(j), memo));
    const refusedItems = refused.map((r) => {
      const c = cleanPlan.classifyJob(r.path, planCtx);
      return { path: r.path, kind: c.kind, reversible: c.reversible, project: c.project, reason: r.reason, bytes: 0 };
    });

    // Logged before anything is touched, so a crash mid-clean leaves a trace.
    historyId = newHistoryId();
    started = { id: historyId, at: Date.now(), scope, label, requested: list.length };
    putHistory(historyLog.startedEntry({ ...started, refused: refusedItems, pending: [...toDelete, ...toTrash].map((j) => described.get(j.path)) }));

    const total = allowed.length;
    const del = toDelete.length
      ? await cleaner.clean(toDelete, (p) => send({ ...p, total }), ac.signal)
      : { totalFreed: 0, errors: [], results: [] };
    let running = del.totalFreed;
    let done = toDelete.length;
    const tr = toTrash.length
      ? await trashFiles(toTrash.map((j) => j.path), {
        trashItem: (p) => shell.trashItem(p),
        signal: ac.signal,
        onProgress: (p) => {
          send({ ...p, done, total });
          if (!p.error) running += p.freed || 0;
          done++;
          send({ phase: 'item-done', path: p.path, freed: p.freed || 0, totalFreed: running, done, total });
        },
      })
      : { totalFreed: 0, errors: [], results: [] };

    const items = [...refusedItems.map((r) => ({ ...r, outcome: 'refused' }))];
    const ran = new Set();
    for (const r of del.results || []) {
      ran.add(r.path);
      items.push({ ...described.get(r.path), outcome: r.ok ? 'removed' : 'failed', bytes: r.freed, reason: r.ok ? undefined : r.error, code: r.code });
    }
    for (const r of tr.results || []) {
      ran.add(r.path);
      items.push({ ...described.get(r.path), outcome: r.ok ? 'trashed' : 'failed', bytes: r.freed, reason: r.ok ? undefined : r.error, code: r.code });
    }
    // Anything that never ran (the clean was stopped) is a failure, not a success.
    for (const j of allowed) {
      if (!ran.has(j.path)) items.push({ ...described.get(j.path), outcome: 'failed', bytes: 0, reason: 'Not cleaned: the clean was stopped first.' });
    }
    putHistory(historyLog.finishedEntry({ ...started, finishedAt: Date.now(), status: 'done', items }));

    const errors = [...del.errors, ...tr.errors].map((er) => ({ ...er }));
    const trashed = (tr.results || []).filter((r) => r.ok).map((r) => r.path);
    // Trashed files are not freed space yet: they come back only when the Trash
    // is emptied, so they are reported apart from totalFreed.
    return { ok: true, totalFreed: del.totalFreed, trashedBytes: tr.totalFreed, errors, refused, trashed, historyId };
  } catch (err) {
    // The clean broke part way: record it as interrupted, never as done.
    if (started) {
      try {
        const cur = readHistory().find((h) => h && h.id === historyId);
        if (cur && cur.status === 'started') putHistory(historyLog.interruptEntry(cur, Date.now()));
      } catch (_) { /* the next launch marks it interrupted */ }
    }
    return { ok: false, error: err.message, historyId };
  }
});

// Savings are what each action really removes (recommendations.js, issue #13).
ipcMain.handle('recommendations', (_e, payload) => {
  const { projects, sysTargets } = payload && typeof payload === 'object' ? payload : {};
  return recommendations.buildRecommendations(projects || [], sysTargets || [], loadPrefs(), cache.docker, {
    reclaimSuggestions: docker.reclaimSuggestions, pruneKinds: docker.PRUNE_KINDS,
  });
});

/**
 * Paths the renderer may open or reveal: only what Spaci itself found or was
 * configured with. Anything else could launch an arbitrary file.
 */
function openablePaths() {
  const out = [];
  for (const p of cache.projects || []) {
    if (p && p.path) out.push(p.path);
    for (const it of (p && p.items) || []) if (it && it.path) out.push(it.path);
  }
  out.push(...TARGET_INDEX.keys(), ...lastLargeFiles, ...lastTopChildren);
  for (const t of cache.system || []) out.push(...((t && t.existingPaths) || []));
  const roots = loadPrefs().scanRoots;
  if (Array.isArray(roots)) out.push(...roots);
  if (crashLog.file) out.push(crashLog.file); // Settings > Diagnostics can reveal the log
  return ipcGuards.knownPathSet(out);
}

ipcMain.handle('open:reveal', (_e, p) => {
  if (!openablePaths().has(p)) return 'Not allowed';
  shell.showItemInFolder(p);
  return '';
});
ipcMain.handle('open:path', (_e, p) => {
  if (!openablePaths().has(p)) return 'Not allowed';
  return shell.openPath(p);
});
// Only web and mail links leave the app; javascript:, file: and the rest do not.
ipcMain.handle('open:external', async (_e, url) => {
  if (!ipcGuards.isSafeExternalUrl(url)) return false;
  try { await shell.openExternal(url.trim()); return true; } catch { return false; }
});

ipcMain.handle('scan:largefiles', async (e, root, minBytes) => {
  const prefs = loadPrefs();
  const roots = [...(Array.isArray(prefs.scanRoots) ? prefs.scanRoots : []), ...pickedFolders];
  const where = ipcGuards.resolveLargeFilesRoot(root, { home: os.homedir(), scanRoots: roots });
  if (!where.ok) return { ok: false, error: where.error };
  aborts.largefiles?.abort(); aborts.largefiles = new AbortController();
  const onProgress = progressTo(e.sender, 'largefiles:progress');
  try {
    const res = await work('scanLargeFiles', [where.root, ipcGuards.clampMinBytes(minBytes)], { onProgress, signal: aborts.largefiles.signal });
    // Remember what was found: only these files may be deleted from that screen.
    lastLargeFiles = new Set((res.files || []).map((f) => f.path));
    return { ok: true, ...res };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('history:clear', () => { try { writeFileAtomic(HISTORY_PATH, '[]'); } catch (e) { console.error('history:clear', e && e.message); } return []; });

// ---------- notices and What's new (IPC) ----------
// Every handler validates its input (ids and versions are bounded strings,
// checked in notices.js) and answers sensibly before the service exists.
ipcMain.handle('notices:list', () => (noticesService ? noticesService.list() : []));
ipcMain.handle('notices:dismiss', (_e, id) => (noticesService ? noticesService.dismiss(id) : false));
ipcMain.handle('notices:open', (_e, id) => (noticesService ? noticesService.open(id) : null));
ipcMain.handle('whatsnew:get', () => (noticesService ? noticesService.whatsNew() : null));
ipcMain.handle('whatsnew:seen', (_e, version) => (noticesService ? noticesService.whatsNewSeen(version) : false));
