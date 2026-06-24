'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // prefs
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  home: () => ipcRenderer.invoke('app:home'),

  // disk + icons
  diskUsage: (p) => ipcRenderer.invoke('disk:usage', p),
  diskBreakdown: () => ipcRenderer.invoke('disk:breakdown'),
  icon: (name) => ipcRenderer.invoke('icon:get', name),
  logo: (name) => ipcRenderer.invoke('logo:get', name),
  cacheGet: () => ipcRenderer.invoke('cache:get'),
  scanNow: () => ipcRenderer.invoke('scan:now'),
  projectIcon: (p) => ipcRenderer.invoke('project:icon', p),
  scanLargeFiles: (root, minBytes) => ipcRenderer.invoke('scan:largefiles', root, minBytes),
  historyGet: () => ipcRenderer.invoke('history:get'),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  onLargeFilesProgress: (cb) => sub('largefiles:progress', cb),

  // dialogs / shell
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  reveal: (p) => ipcRenderer.invoke('open:reveal', p),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // scanning
  scanProjects: (root) => ipcRenderer.invoke('scan:projects', root),
  scanSystem: () => ipcRenderer.invoke('scan:system'),
  cancelScan: (type) => ipcRenderer.invoke('scan:cancel', type),
  enrichProject: (p) => ipcRenderer.invoke('project:enrich', p),
  recommendations: (payload) => ipcRenderer.invoke('recommendations', payload),

  // cleaning
  clean: (jobs, meta) => ipcRenderer.invoke('clean', jobs, meta),

  // menu bar widget
  openMain: (route) => ipcRenderer.invoke('win:show', route),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onNavGo: (cb) => sub('nav:go', cb),

  // auto-update
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => sub('update:status', cb),

  // events
  onScanProgress: (cb) => sub('scan:progress', cb),
  onSystemProgress: (cb) => sub('system:progress', cb),
  onCleanProgress: (cb) => sub('clean:progress', cb),
  onTrayScan: (cb) => sub('tray:scan', cb),
  onCacheUpdated: (cb) => sub('cache:updated', cb),
  onEnrichUpdated: (cb) => sub('enrich:updated', cb),
  onBgScan: (cb) => sub('bg:scan', cb),
  onBreakdownUpdated: (cb) => sub('disk:breakdown-updated', cb),
});

function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
