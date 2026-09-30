'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const scanner = require('./scanner');
const system = require('./system');
const docker = require('./docker');
const cleaner = require('./cleaner');
const aitools = require('./aitools');
const cleanGuard = require('./clean-guard');
const largefiles = require('./largefiles');
const diskbreakdown = require('./diskbreakdown');
const { initUpdater } = require('./updater');

const isDev = process.argv.includes('--dev');
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
};
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p) {
  try { fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true }); fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2)); }
  catch (e) { console.error('savePrefs', e); }
}

// ---------- scan cache + background scanning ----------
const CACHE_PATH = path.join(app.getPath('userData'), 'cache.json');
let cache = readCache() || { projects: [], system: [], scannedAt: 0, root: '', meta: {} };
if (!cache.enrich) cache.enrich = {}; // path -> { totalSize, git, at }
if (!cache.meta) cache.meta = {};
let bgTimer = null;
let bgRunning = false;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return null; }
}
function writeCache() {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch (e) { /* ignore */ }
}

// ---------- cleanup history (logs of cleaned projects/caches) ----------
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
function readHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; } }
function appendHistory(entry) {
  try { const h = readHistory(); h.unshift(entry); fs.writeFileSync(HISTORY_PATH, JSON.stringify(h.slice(0, 200))); } catch (e) { /* ignore */ }
}

// ---------- disk usage breakdown (by category) ----------
async function refreshBreakdown() {
  const started = Date.now();
  try {
    const b = await diskbreakdown.diskBreakdown(os.homedir());
    cache.diskBreakdown = { ...b, at: Date.now(), meta: { ...(b.meta || {}), durationMs: Date.now() - started } };
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('disk:breakdown-updated', cache.diskBreakdown);
    return cache.diskBreakdown;
  } catch (_) { return cache.diskBreakdown || null; }
}
// ---------- docker ----------
/**
 * One daemon round trip per scan: the totals for the Docker card, plus the
 * per-project attribution folded into the freshly scanned projects. Keeping the
 * heavy lists out of `cache` matters, they are written to disk on every scan.
 */
async function refreshDocker(projects, options = {}) {
  try {
    const { inventory } = await scanner.attachDockerUsage(projects || [], options);
    const disk = await docker.desktopDisk();
    cache.docker = inventory && inventory.ok
      ? {
        ok: true,
        approximate: Boolean(inventory.approximate),
        status: inventory.status,
        categories: inventory.categories,
        totals: inventory.totals,
        desktopDisk: disk,
        projects: (projects || []).filter((p) => p.docker && p.docker.usage).length,
        at: Date.now(),
      }
      // Keep the disk image size and engine state on failure too: when Docker
      // Desktop is up but its engine is down, the disk image is still the
      // biggest thing Spaci can explain to the user.
      : { ok: false, reason: inventory ? inventory.reason : 'unavailable', status: inventory ? inventory.status : null, state: inventory ? inventory.state : null, desktopDisk: disk, at: Date.now() };
    return cache.docker;
  } catch (e) {
    cache.docker = { ok: false, reason: 'error', error: e && e.message, at: Date.now() };
    return cache.docker;
  }
}

/** Projects worth keeping: real artifacts on disk, or storage held in Docker. */
function keepProject(p) {
  return Boolean(p.items.length || (p.docker && p.docker.usage));
}

function updateTrayTitle() {
  if (!tray) return;
  const reclaim = (cache.projects || []).reduce((s, p) => s + (p.cleanableSize || 0), 0)
    + (cache.system || []).filter((t) => t.safe).reduce((s, t) => s + (t.size || 0), 0);
  tray.setToolTip(reclaim > 0 ? `Spaci · ${fmt(reclaim)} reclaimable` : 'Spaci');
}

async function runBackgroundScan() {
  if (bgRunning) return;
  const started = Date.now();
  bgRunning = true;
  if (win && !win.isDestroyed()) win.webContents.send('bg:scan', { active: true });
  const errors = [];
  const phaseMeta = {};
  try {
    const prefs = loadPrefs();
    const root = (prefs.scanRoots && prefs.scanRoots[0]) || os.homedir();
    const ac = new AbortController();
    try {
      const phaseStart = Date.now();
      const { projects } = await scanner.scanProjects(root, null, ac.signal);
      const dockerStart = Date.now();
      await refreshDocker(projects);
      phaseMeta.docker = { source: 'background-scan', durationMs: Date.now() - dockerStart, partial: false };
      phaseMeta.projects = { source: 'background-scan', durationMs: Date.now() - phaseStart, partial: ac.signal.aborted };
      cache.projects = projects.filter(keepProject);
      cache.root = root;
      cache.scannedAt = Date.now();
      cache.meta = { source: 'background-scan', startedAt: started, partial: false, errors, phases: phaseMeta };
      writeCache();
      if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
    } catch (e) {
      errors.push({ phase: 'projects', message: e && e.message ? e.message : String(e) });
    }

    try {
      const phaseStart = Date.now();
      const targets = await system.scanSystem(null, ac.signal);
      phaseMeta.system = { source: 'background-scan', durationMs: Date.now() - phaseStart, partial: ac.signal.aborted };
      cache.system = targets;
      cache.scannedAt = Date.now();
      cache.root = root;
      cache.meta = { source: 'background-scan', startedAt: started, partial: false, errors, phases: phaseMeta };
      writeCache();
      updateTrayTitle();
      if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
    } catch (e) {
      errors.push({ phase: 'system', message: e && e.message ? e.message : String(e) });
    }

    // pre-enrich the largest projects so their details pages open instantly
    const top = [...cache.projects].sort((a, b) => b.cleanableSize - a.cleanableSize).slice(0, 25);
    const enrichStart = Date.now();
    for (const pr of top) {
      try { const r = await scanner.enrichProject(pr.path, new AbortController().signal); cache.enrich[pr.path] = { totalSize: r.totalSize, git: r.git, at: Date.now() }; } catch (_) { /* */ }
    }
    phaseMeta.enrich = { source: 'background-scan', durationMs: Date.now() - enrichStart, partial: false };
    writeCache();
    try {
      const b = await refreshBreakdown();
      phaseMeta.breakdown = { source: 'background-scan', durationMs: b && b.meta ? b.meta.durationMs : 0, partial: false };
    } catch (e) {
      errors.push({ phase: 'breakdown', message: e && e.message ? e.message : String(e) });
    }
  } catch (e) {
    errors.push({ phase: 'background', message: e && e.message ? e.message : String(e) });
  }
  finally {
    cache.meta = { source: 'background-scan', startedAt: started, durationMs: Date.now() - started, partial: errors.length > 0, errors, phases: phaseMeta };
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
    bgRunning = false; if (win && !win.isDestroyed()) win.webContents.send('bg:scan', { active: false });
  }
}

function scheduleBackground() {
  if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
  const prefs = loadPrefs();
  if (!prefs.backgroundScans) return;
  const hrs = Math.max(1, prefs.scanIntervalHours || 6);
  bgTimer = setInterval(runBackgroundScan, hrs * 3600 * 1000);
  // If the cache is missing or older than the interval, refresh it soon after launch.
  const stale = !cache.scannedAt || (Date.now() - cache.scannedAt) > hrs * 3600 * 1000;
  if (prefs.onboarded && stale) setTimeout(runBackgroundScan, 8000);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 920, minHeight: 620,
    backgroundColor: '#202020',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, _lvl, message, line, src) => {
    console.log('[renderer]', message, src ? '(' + src.split('/').pop() + ':' + line + ')' : '');
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', err && err.message));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  // Closing the window hides it instead of quitting, so the app keeps running in the menu bar.
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
}

function showWin() { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } }

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
  trayWin.loadFile(path.join(__dirname, 'renderer', 'tray.html'));
  trayWin.on('blur', () => { if (trayWin && !trayWin.isDestroyed()) trayWin.hide(); });
  trayWin.on('close', (e) => { e.preventDefault(); trayWin.hide(); });
}

function toggleTrayPopover() {
  if (!trayWin || trayWin.isDestroyed()) createTrayWindow();
  if (trayWin.isVisible()) { trayWin.hide(); return; }
  // Position the popover under the tray icon, kept on screen.
  try {
    const tb = tray.getBounds();
    const screen = require('electron').screen;
    const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
    let x = Math.round(tb.x + tb.width / 2 - TRAY_W / 2);
    x = Math.max(area.x + 6, Math.min(x, area.x + area.width - TRAY_W - 6));
    const y = process.platform === 'darwin' ? Math.round(tb.y + tb.height + 2) : Math.round(area.y + 6);
    trayWin.setPosition(x, y, false);
  } catch (_) {}
  trayWin.show();
  trayWin.focus();
}

function createTray() {
  let image = nativeImage.createEmpty();
  try {
    const trayPng = path.join(__dirname, '..', 'assets', 'branding', 'trayTemplate.png');
    const img = nativeImage.createFromPath(trayPng);
    if (img && !img.isEmpty()) { img.setTemplateImage(true); image = img; }
    else { image = nativeImage.createFromNamedImage('NSActionTemplate', [0, 0, 0]); }
  } catch (_) {
    try { image = nativeImage.createFromNamedImage('NSActionTemplate'); } catch (e2) { /* keep empty */ }
  }
  tray = new Tray(image);
  tray.setToolTip('Spaci');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Spaci', click: showWin },
    { label: 'Smart Scan', click: () => { showWin(); win && win.webContents.send('tray:scan'); } },
    { type: 'separator' },
    { label: 'Quit Spaci', click: () => { isQuitting = true; app.quit(); } },
  ]);
  // Left click opens the popover widget; right click shows the classic menu.
  tray.on('click', toggleTrayPopover);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
  createTrayWindow();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'branding', 'icon.png'))); } catch (_) { /* */ }
  }
  createWindow();
  createTray();
  updateTrayTitle();
  scheduleBackground();
  initUpdater(() => win);
  app.on('activate', () => showWin());
});
// Keep running in the background (menu-bar tray) even with no windows open.
app.on('window-all-closed', () => { /* intentionally no quit */ });
app.on('before-quit', () => { isQuitting = true; });

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

const logoCache = new Map();
async function getLogo(name) {
  if (logoCache.has(name)) return logoCache.get(name);
  const file = path.join(__dirname, '..', 'assets', 'logos', `${name}.svg`);
  let svg = '';
  try { svg = await fsp.readFile(file, 'utf8'); } catch { svg = ''; }
  logoCache.set(name, svg);
  return svg;
}

/**
 * Turn Docker's reclaim policy (which lives in docker.js, next to the prune
 * allowlist) into recommendation cards.
 */
function dockerRecommendations(info) {
  const COPY = {
    'build-cache': (s) => `${s.unused} of ${s.total} cached build layers are not in use. Docker rebuilds them the next time you build.`,
    'dangling-images': (s) => `${s.unused} of ${s.total} images have no container using them. Cleaning removes only the untagged layers left behind by rebuilds.`,
    'desktop-disk': (s) => [s.message, s.sizeNote, s.guidance].filter(Boolean).join(' '),
  };
  const TITLE = {
    'build-cache': 'Docker build cache',
    'dangling-images': 'Unused Docker images',
    'desktop-disk': 'Docker disk image',
  };
  // Unknown kinds are dropped rather than crashing the recommendations list.
  return docker.reclaimSuggestions(info).filter((s) => COPY[s.kind]).map((s) => {
    const informational = s.kind === 'desktop-disk';
    return {
      id: 'docker:' + s.kind,
      kind: 'docker',
      savings: s.savings,
      severity: s.severity,
      icon: 'box',
      title: `${TITLE[s.kind]} · ${fmt(informational ? s.bytes : s.savings)}`,
      body: COPY[s.kind](s),
      // The disk image is explained, not cleaned: pruning needs a running engine.
      action: informational ? { type: 'none' } : { type: 'docker-prune', kind: s.kind },
    };
  });
}

function buildRecommendations(projects, sysTargets, prefs, dockerInfo) {
  const recs = [];
  const now = Date.now();
  const staleMs = (prefs.staleDays || 60) * 86400000;

  // Big reclaimable projects
  const sorted = [...projects].filter((p) => p.cleanableSize > 0).sort((a, b) => b.cleanableSize - a.cleanableSize);
  for (const p of sorted.slice(0, 5)) {
    const stale = now - p.mtime > staleMs;
    recs.push({
      id: 'proj:' + p.path,
      kind: 'project',
      savings: p.cleanableSize,
      severity: stale ? 'high' : 'normal',
      icon: stale ? 'clock' : 'broom',
      title: `${p.name} · ${fmt(p.cleanableSize)} reclaimable`,
      body: stale
        ? `Not modified in ${Math.round((now - p.mtime) / 86400000)} days. Its build artifacts are likely safe to remove.`
        : `${p.items.length} artifact folder(s) (${p.items.map((i) => i.name).slice(0, 3).join(', ')}…).`,
      action: { type: 'open-project', path: p.path },
    });
  }
  // Big system caches
  const bigSys = [...sysTargets].filter((t) => t.safe && t.size > 500 * 1024 * 1024).sort((a, b) => b.size - a.size);
  for (const t of bigSys.slice(0, 4)) {
    recs.push({
      id: 'sys:' + t.id,
      kind: 'cache',
      savings: t.size,
      severity: t.size > 3 * 1024 ** 3 ? 'high' : 'normal',
      icon: t.icon, title: `${t.name} · ${fmt(t.size)}`,
      body: t.description, action: { type: 'select-system', id: t.id },
    });
  }
  // Docker is invisible to a filesystem scan, so it is easily the biggest thing
  // a dev machine is unaware of. Rank it with everything else by size.
  recs.push(...dockerRecommendations(dockerInfo));
  return recs.sort((a, b) => (b.savings || 0) - (a.savings || 0));
}
function fmt(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

// ---------- IPC ----------
ipcMain.handle('prefs:get', () => loadPrefs());
ipcMain.handle('prefs:set', (_e, patch) => { const p = { ...loadPrefs(), ...patch }; savePrefs(p); scheduleBackground(); return p; });
ipcMain.handle('app:home', () => os.homedir());
ipcMain.handle('win:show', (_e, route) => {
  showWin();
  if (route && win && !win.isDestroyed()) win.webContents.send('nav:go', route);
  if (trayWin && !trayWin.isDestroyed()) trayWin.hide();
});
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
ipcMain.handle('disk:usage', (_e, p) => diskUsage(p));
ipcMain.handle('disk:breakdown', async () => {
  if (cache.diskBreakdown) { refreshBreakdown(); return cache.diskBreakdown; }
  return await refreshBreakdown();
});
ipcMain.handle('icon:get', (_e, name) => getIcon(name));

// Biggest immediate children of a category's directories (Storage drill-down).
ipcMain.handle('fs:top-children', (_e, dirs) => diskbreakdown.topChildren(Array.isArray(dirs) ? dirs : [], 25));
ipcMain.handle('logo:get', (_e, name) => getLogo(name));
ipcMain.handle('cache:get', () => cache);
ipcMain.handle('scan:now', () => { runBackgroundScan(); return true; });
ipcMain.handle('project:icon', async (_e, p) => {
  try {
    if (!p) return null;
    const st = await fsp.stat(p);
    if (!st.isFile() || st.size > 3 * 1024 * 1024) return null;
    const buf = await fsp.readFile(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan:projects', async (e, root) => {
  // Default to the configured scan root (the home folder) so Projects scans
  // automatically without the user having to pick a folder first.
  root = root || (loadPrefs().scanRoots || [])[0] || os.homedir();
  aborts.projects?.abort();
  aborts.projects = new AbortController();
  const onProgress = (p) => e.sender.send('scan:progress', p);
  try {
    const res = await scanner.scanProjects(root, onProgress, aborts.projects.signal);
    // One daemon call after the walk. The renderer keeps its running strip up
    // until this resolves, so no extra progress event is emitted here.
    await refreshDocker(res.projects || []);
    cache.projects = (res.projects || []).filter(keepProject); cache.root = root; cache.scannedAt = Date.now(); writeCache(); updateTrayTitle();
    return { ok: true, ...res, projects: cache.projects, docker: cache.docker };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('scan:system', async (e) => {
  aborts.system?.abort();
  aborts.system = new AbortController();
  const onProgress = (p) => e.sender.send('system:progress', p);
  try {
    const targets = await system.scanSystem(onProgress, aborts.system.signal);
    cache.system = targets; cache.scannedAt = Date.now(); writeCache(); updateTrayTitle();
    return { ok: true, targets };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('scan:cancel', (_e, type) => { if (type) aborts[type]?.abort(); else Object.values(aborts).forEach((a) => a && a.abort()); return true; });

// ---------- docker ----------
// Cheap and cached: the System screen asks on every paint.
ipcMain.handle('docker:status', async (_e, force) => {
  if (!force && cache.docker && Date.now() - cache.docker.at < 60000) return cache.docker;
  const result = await refreshDocker(cache.projects || [], { force: Boolean(force) });
  writeCache();
  return result;
});

ipcMain.handle('docker:kinds', () => Object.values(docker.PRUNE_KINDS)
  .map(({ id, name, safe, description }) => ({ id, name, safe, description })));

// Reclaim one allowlisted category. The kind is validated inside docker.prune,
// so an unexpected value from the renderer can never become a docker argument.
ipcMain.handle('docker:prune', async (_e, kind) => {
  const spec = docker.PRUNE_KINDS[kind];
  if (!spec) return { ok: false, error: 'Unknown Docker cleanup: ' + kind, freed: 0 };
  const res = await docker.prune(kind);
  if (res.ok) {
    appendHistory({
      at: Date.now(), scope: 'docker', label: spec.name, count: 1,
      freed: res.freed, reversible: spec.safe, items: [],
    });
    await refreshDocker(cache.projects || [], { force: true });
    writeCache();
    updateTrayTitle();
    if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
  }
  return res;
});

async function refreshEnrich(p) {
  try {
    const r = await scanner.enrichProject(p, new AbortController().signal);
    cache.enrich = cache.enrich || {};
    cache.enrich[p] = { totalSize: r.totalSize, git: r.git, at: Date.now() };
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('enrich:updated', { path: p, ...cache.enrich[p] });
    return cache.enrich[p];
  } catch {
    return (cache.enrich && cache.enrich[p]) || { totalSize: 0, git: null };
  }
}
// Returns cached git/size instantly (refreshing in the background); pass force to recompute now.
ipcMain.handle('project:enrich', async (_e, p, force) => {
  if (!force && cache.enrich && cache.enrich[p]) { refreshEnrich(p); return cache.enrich[p]; }
  return await refreshEnrich(p);
});

// Every known system target, keyed by each of its paths. The clean handler
// re-applies the target's own rules (mode, protect, running-tool guard) from
// here, so safety never depends on the renderer passing the right fields.
const TARGET_INDEX = cleanGuard.buildTargetIndex(system.TARGETS);

ipcMain.handle('clean', async (e, jobs, meta) => {
  const ac = new AbortController();
  const onProgress = (p) => e.sender.send('clean:progress', p);
  try {
    const { allowed, refused } = await cleanGuard.enforceTargetRules(jobs, {
      index: TARGET_INDEX,
      toolStatus: () => aitools.aiToolStatus(),
    });
    const res = allowed.length
      ? await cleaner.clean(allowed, onProgress, ac.signal)
      : { totalFreed: 0, errors: [] };
    if (allowed.length) {
      appendHistory({ at: Date.now(), scope: (meta && meta.scope) || 'projects', label: (meta && meta.label) || '', count: allowed.length, freed: res.totalFreed, reversible: !(meta && meta.reversible === false), items: allowed.slice(0, 80).map((j) => j.path) });
    }
    return { ok: true, ...res, refused };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('recommendations', (_e, { projects, sysTargets }) => buildRecommendations(projects || [], sysTargets || [], loadPrefs(), cache.docker));

ipcMain.handle('open:reveal', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
ipcMain.handle('open:external', (_e, url) => shell.openExternal(url));

ipcMain.handle('scan:largefiles', async (e, root, minBytes) => {
  aborts.largefiles?.abort(); aborts.largefiles = new AbortController();
  const onProgress = (p) => e.sender.send('largefiles:progress', p);
  try {
    const res = await largefiles.scanLargeFiles(root || os.homedir(), minBytes, onProgress, aborts.largefiles.signal);
    return { ok: true, ...res };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('history:get', () => readHistory());
ipcMain.handle('history:clear', () => { try { fs.writeFileSync(HISTORY_PATH, '[]'); } catch (e) { /* */ } return []; });
