'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // prefs
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  home: () => ipcRenderer.invoke('app:home'),
  logPath: () => ipcRenderer.invoke('app:log-path'),

  // disk + icons
  diskUsage: (p) => ipcRenderer.invoke('disk:usage', p),
  diskBreakdown: () => ipcRenderer.invoke('disk:breakdown'),
  topChildren: (dirs) => ipcRenderer.invoke('fs:top-children', dirs),
  icon: (name) => ipcRenderer.invoke('icon:get', name),
  iconSvg: (name) => ipcRenderer.invoke('icon:get', name),
  techIcon: (id, flavor) => ipcRenderer.invoke('techicon:get', id, flavor),
  brandIcon: (id, theme) => ipcRenderer.invoke('brandicon:get', id, theme),
  cacheGet: () => ipcRenderer.invoke('cache:get'),
  scanNow: () => ipcRenderer.invoke('scan:now'),
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

  // docker
  dockerStatus: (force) => ipcRenderer.invoke('docker:status', force),
  dockerKinds: () => ipcRenderer.invoke('docker:kinds'),
  dockerPrune: (kind, opts) => ipcRenderer.invoke('docker:prune', kind, opts),
  dockerVolumes: (force) => ipcRenderer.invoke('docker:volumes', force),
  dockerRemoveVolume: (name, opts) => ipcRenderer.invoke('docker:remove-volume', name, opts),
  dockerRestart: () => ipcRenderer.invoke('docker:restart'),
  onDockerRestartProgress: (cb) => sub('docker:restart-progress', cb),

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

  // notices and What's new (main validates every argument)
  noticesList: () => ipcRenderer.invoke('notices:list'),
  noticesDismiss: (id) => ipcRenderer.invoke('notices:dismiss', id),
  noticesOpen: (id) => ipcRenderer.invoke('notices:open', id),
  whatsNewGet: () => ipcRenderer.invoke('whatsnew:get'),
  whatsNewSeen: (version) => ipcRenderer.invoke('whatsnew:seen', version),
  onNoticesUpdated: (cb) => sub('notices:updated', cb),

  // events
  onScanProgress: (cb) => sub('scan:progress', cb),
  onSystemProgress: (cb) => sub('system:progress', cb),
  onCleanProgress: (cb) => sub('clean:progress', cb),
  onTrayScan: (cb) => sub('tray:scan', cb),
  onCacheUpdated: (cb) => sub('cache:updated', cb),
  onEnrichUpdated: (cb) => sub('enrich:updated', cb),
  onBgScan: (cb) => sub('bg:scan', cb),
  onBreakdownUpdated: (cb) => sub('disk:breakdown-updated', cb),

  // ---- clean tiers and auto-clean ----
  cleanTiers: (payload) => ipcRenderer.invoke('tiers:get', payload),
  autoCleanGet: () => ipcRenderer.invoke('autoclean:get'),
  autoCleanSet: (patch) => ipcRenderer.invoke('autoclean:set', patch),
  autoCleanApprove: (previewId) => ipcRenderer.invoke('autoclean:approve', previewId),
  autoCleanUndo: (runId) => ipcRenderer.invoke('autoclean:undo', runId),
  autoCleanPreview: () => ipcRenderer.invoke('autoclean:preview'),
  onAutoCleanUpdated: (cb) => sub('autoclean:updated', cb),
  // ---- end clean tiers and auto-clean ----
});

function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
