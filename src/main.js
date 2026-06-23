'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const scanner = require('./scanner');
const system = require('./system');
const cleaner = require('./cleaner');
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
let cache = readCache() || { projects: [], system: [], scannedAt: 0, root: '' };
if (!cache.enrich) cache.enrich = {}; // path -> { totalSize, git, at }
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
  try {
    const b = await diskbreakdown.diskBreakdown(os.homedir());
    cache.diskBreakdown = { ...b, at: Date.now() };
    writeCache();
    if (win && !win.isDestroyed()) win.webContents.send('disk:breakdown-updated', cache.diskBreakdown);
    return cache.diskBreakdown;
  } catch (_) { return cache.diskBreakdown || null; }
}
function updateTrayTitle() {
  if (!tray) return;
  const reclaim = (cache.projects || []).reduce((s, p) => s + (p.cleanableSize || 0), 0)
    + (cache.system || []).filter((t) => t.safe).reduce((s, t) => s + (t.size || 0), 0);
  tray.setToolTip(reclaim > 0 ? `Spaci · ${fmt(reclaim)} reclaimable` : 'Spaci');
}

async function runBackgroundScan() {
  if (bgRunning) return;
  bgRunning = true;
  if (win && !win.isDestroyed()) win.webContents.send('bg:scan', { active: true });
  try {
    const prefs = loadPrefs();
    const root = (prefs.scanRoots && prefs.scanRoots[0]) || os.homedir();
    const ac = new AbortController();
    const { projects } = await scanner.scanProjects(root, null, ac.signal);
    const targets = await system.scanSystem(null, ac.signal);
    cache = { projects: projects.filter((p) => p.items.length), system: targets, scannedAt: Date.now(), root, enrich: cache.enrich || {} };
    writeCache();
    updateTrayTitle();
    if (win && !win.isDestroyed()) win.webContents.send('cache:updated', cache);
    // pre-enrich the largest projects so their details pages open instantly
    const top = [...cache.projects].sort((a, b) => b.cleanableSize - a.cleanableSize).slice(0, 25);
    for (const pr of top) {
      try { const r = await scanner.enrichProject(pr.path, new AbortController().signal); cache.enrich[pr.path] = { totalSize: r.totalSize, git: r.git, at: Date.now() }; } catch (_) { /* */ }
    }
    writeCache();
    await refreshBreakdown();
  } catch (e) { /* ignore background errors */ }
  finally { bgRunning = false; if (win && !win.isDestroyed()) win.webContents.send('bg:scan', { active: false }); }
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
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  // Closing the window hides it instead of quitting, so the app keeps running in the menu bar.
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
}

function showWin() { if (!win || win.isDestroyed()) createWindow(); else { win.show(); win.focus(); } }

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
  tray.setToolTip('Spaci, running in the background');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Spaci', click: showWin },
    { label: 'Smart Scan', click: () => { showWin(); win && win.webContents.send('tray:scan'); } },
    { type: 'separator' },
    { label: 'Quit Spaci', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWin);
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

const iconCache = new Map();
async function getIcon(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  const file = path.join(__dirname, '..', 'assets', 'icons', `${name}.svg`);
  let svg = '';
  try { svg = await fsp.readFile(file, 'utf8'); } catch { svg = ''; }
  iconCache.set(name, svg);
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

function buildRecommendations(projects, sysTargets, prefs) {
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
  return recs;
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
ipcMain.handle('disk:usage', (_e, p) => diskUsage(p));
ipcMain.handle('disk:breakdown', async () => {
  if (cache.diskBreakdown) { refreshBreakdown(); return cache.diskBreakdown; }
  return await refreshBreakdown();
});
ipcMain.handle('icon:get', (_e, name) => getIcon(name));
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
  aborts.projects?.abort();
  aborts.projects = new AbortController();
  const onProgress = (p) => e.sender.send('scan:progress', p);
  try {
    const res = await scanner.scanProjects(root, onProgress, aborts.projects.signal);
    cache.projects = (res.projects || []).filter((p) => p.items.length); cache.root = root; cache.scannedAt = Date.now(); writeCache(); updateTrayTitle();
    return { ok: true, ...res };
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

ipcMain.handle('clean', async (e, jobs, meta) => {
  const ac = new AbortController();
  const onProgress = (p) => e.sender.send('clean:progress', p);
  try {
    const res = await cleaner.clean(jobs, onProgress, ac.signal);
    appendHistory({ at: Date.now(), scope: (meta && meta.scope) || 'projects', label: (meta && meta.label) || '', count: jobs.length, freed: res.totalFreed, reversible: !(meta && meta.reversible === false), items: jobs.slice(0, 80).map((j) => j.path) });
    return { ok: true, ...res };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('recommendations', (_e, { projects, sysTargets }) => buildRecommendations(projects || [], sysTargets || [], loadPrefs()));

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
