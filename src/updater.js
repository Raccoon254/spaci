// Auto-update for Spaci, backed by electron-updater and the generic feed served
// at https://spaci.kentom.co.ke/updates (see package.json build.publish).
//
// On a packaged build the updater checks the feed shortly after launch and every
// six hours, downloads any newer release in the background, and installs it on
// quit (or immediately when the user clicks "Restart to update"). In dev it does
// nothing real, it just reports a "dev" status so the UI can say so.
//
// Note for macOS: silent auto-install requires the app to be code-signed and
// notarized. The check and download work without signing, but quitAndInstall on
// an unsigned mac build will be blocked by Gatekeeper.

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let getWin = () => null;
let lastStatus = { state: 'idle' };

function send(payload) {
  lastStatus = { ...payload, at: Date.now() };
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send('update:status', lastStatus);
}

function wireEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    send({ state: 'available', version: info && info.version })
  );
  autoUpdater.on('update-not-available', (info) =>
    send({ state: 'current', version: (info && info.version) || app.getVersion() })
  );
  autoUpdater.on('error', (err) =>
    send({ state: 'error', message: String((err && err.message) || err) })
  );
  autoUpdater.on('download-progress', (p) =>
    send({
      state: 'downloading',
      percent: Math.round(p.percent || 0),
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    })
  );
  autoUpdater.on('update-downloaded', (info) =>
    send({ state: 'ready', version: info && info.version })
  );
}

async function check() {
  try {
    return await autoUpdater.checkForUpdates();
  } catch (e) {
    send({ state: 'error', message: String((e && e.message) || e) });
    return null;
  }
}

function initUpdater(winGetter) {
  getWin = winGetter || getWin;

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:status', () => lastStatus);
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      send({ state: 'dev', version: app.getVersion() });
      return lastStatus;
    }
    await check();
    return lastStatus;
  });
  ipcMain.handle('update:install', () => {
    if (!app.isPackaged) return false;
    // Give the download a moment to settle, then relaunch into the new version.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });

  if (!app.isPackaged) {
    send({ state: 'dev', version: app.getVersion() });
    return;
  }

  wireEvents();
  setTimeout(() => check(), 8000);
  setInterval(() => check(), 6 * 60 * 60 * 1000);
}

module.exports = { initUpdater };
