// Auto-update for Spaci, backed by electron-updater and the generic feed served
// at https://spaci.kentom.co.ke/updates (see package.json build.publish).
//
// This file is only the Electron wiring. Every decision (when to check, what
// to accept from the feed, what to tell the user, when to retry) lives in
// update-policy.js, which is tested without Electron.
//
// On a packaged build: first check about 20 seconds after launch, then every
// six hours from the last completed check (re-evaluated after sleep). An
// update is downloaded only if it is a newer stable version with sha512
// checksums; the user is told when it is ready and chooses when to restart
// (otherwise it installs on the next quit). The "Check for updates
// automatically" setting (prefs.autoCheckUpdates) turns the periodic check
// off; the manual button keeps working. In dev it reports a "dev" status.
//
// Note for macOS: Squirrel.Mac also refuses to install a bundle whose code
// signature does not match the running app, so an unsigned or foreign build
// can never be installed even if it reached the feed.

const { app, ipcMain, net } = require('electron');
const { createUpdateController } = require('./update-policy');

let controller = null;

// electron-builder writes resources/package-type ("deb") into deb builds only.
function isDebInstall() {
  if (process.platform !== 'linux' || !process.resourcesPath) return false;
  try { return require('fs').readFileSync(require('path').join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'deb'; } catch { return false; }
}

/**
 * @param {() => Electron.BrowserWindow|null} winGetter
 * @param {object} [opts]
 * @param {() => object} [opts.getPrefs]
 * @param {() => void} [opts.beforeInstall]  mark the app as quitting so windows close
 * @param {(version:string) => void} [opts.onReady]  tell the user (notification, tray)
 */
function initUpdater(winGetter, opts = {}) {
  const getWin = winGetter || (() => null);
  let updater = null;
  if (app.isPackaged) {
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (e) {
      console.error('[update] electron-updater failed to load:', e);
    }
  }

  controller = createUpdateController({
    updater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged && Boolean(updater),
    isOnline: () => {
      try { return typeof net.isOnline === 'function' ? net.isOnline() : true; } catch (_) { return true; }
    },
    getPrefs: opts.getPrefs || (() => ({})),
    send: (status) => {
      const w = getWin();
      if (w && !w.isDestroyed()) w.webContents.send('update:status', status);
    },
    notifyReady: opts.onReady || (() => {}),
    beforeInstall: opts.beforeInstall || (() => {}),
    onReadyWithdrawn: opts.onReadyWithdrawn || (() => {}),
    onInstallAbandoned: opts.onInstallAbandoned || (() => {}),
    // MacUpdater emits update-downloaded before Squirrel.Mac has the zip; only
    // the resolved download means the update can really be installed.
    readyOn: process.platform === 'darwin' ? 'resolve' : 'event',
    installOnQuit: !isDebInstall(),
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:status', () => controller.status());
  ipcMain.handle('update:check', () => controller.checkNow());
  ipcMain.handle('update:install', () => controller.install());

  controller.start();
  return controller;
}

function getUpdateController() { return controller; }

module.exports = { initUpdater, getUpdateController };
