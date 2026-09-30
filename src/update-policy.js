'use strict';
// Update decisions for Spaci, independent of Electron.
//
// electron-updater does the transport (feed, download, Squirrel.Mac/NSIS). This
// module decides what to do with it:
// - when to check: shortly after launch, then every six hours, measured from
//   the last completed check; offline means "try later", failures back off
//   (30 min, 1 h, 2 h ... capped at six hours), never a tight loop;
// - whether an offered update is acceptable: a strictly newer, stable (no
//   "-rc.1" style suffix) version whose every file carries a well-formed
//   sha512. Anything else is refused before a byte is downloaded;
// - what the user sees: background checks are silent unless there is
//   something to act on; a manual check reports errors in plain words; a
//   downloaded update is announced once and installs when the user chooses
//   (or on the next quit).
//
// The updater, clock, prefs and UI hooks are injected so node --test can drive
// the whole flow with a fake updater that emits events.

const { createScheduler, HOUR, MIN } = require('./scheduler');

// ---------- versions ----------
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function isPrerelease(v) {
  const p = typeof v === 'string' ? parseVersion(v) : v;
  return Boolean(p && p.pre.length);
}

/** Semver precedence: -1 when a < b, 0 when equal, 1 when a > b. */
function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error('invalid version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p > +q ? 1 : -1; } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

// ---------- feed validation ----------
/** electron-builder writes sha512 as base64 of the 64-byte digest (88 chars). */
function isValidSha512(s) {
  if (typeof s !== 'string' || s.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/.test(s)) return false;
  return Buffer.from(s, 'base64').length === 64;
}

/**
 * Is the update offered by the feed safe to download?
 * @returns {{ok: true} | {ok: false, reason: 'invalid-version'|'prerelease'|'not-newer'|'no-files'|'missing-checksum'}}
 */
function evaluateUpdate(info, currentVersion) {
  const v = parseVersion(info && info.version);
  const cur = parseVersion(currentVersion);
  if (!v || !cur) return { ok: false, reason: 'invalid-version' };
  // Release candidates are GitHub prereleases and never reach the feed. If one
  // ever does (a mistaken sync), no installed copy may pick it up.
  if (isPrerelease(v)) return { ok: false, reason: 'prerelease' };
  // Same version or older: never reinstall, never downgrade.
  if (compareVersions(v, cur) <= 0) return { ok: false, reason: 'not-newer' };
  let files = Array.isArray(info.files) ? info.files.filter((f) => f && typeof f === 'object') : [];
  if (!files.length && typeof info.path === 'string' && info.path) files = [{ url: info.path, sha512: info.sha512 }];
  if (!files.length) return { ok: false, reason: 'no-files' };
  const ok = files.every((f) => isValidSha512(f.sha512) || (f.url === info.path && isValidSha512(info.sha512)));
  if (!ok) return { ok: false, reason: 'missing-checksum' };
  return { ok: true };
}

// ---------- errors ----------
const OFFLINE = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|socket hang up/i;

function classifyError(err) {
  const text = `${(err && err.code) || ''} ${(err && err.message) || err || ''}`;
  if (/SPACI_TIMEOUT/.test(text)) return 'timeout';
  if (OFFLINE.test(text)) return 'offline';
  if (/sha512 checksum mismatch|ERR_CHECKSUM_MISMATCH|ERR_UPDATER_NO_CHECKSUM|checksum/i.test(text)) return 'checksum';
  if (/code signature|did not pass validation|not signed|codesign/i.test(text)) return 'signature';
  if (/\b404\b|Not Found|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(text)) return 'not-found';
  if (/ERR_UPDATER_INVALID_UPDATE_INFO|ERR_UPDATER_INVALID_VERSION|YAML|Cannot parse|Unexpected token|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(text)) return 'bad-feed';
  return 'unknown';
}

const FRIENDLY = {
  offline: "Couldn't reach the update server. Check your connection; Spaci will try again later.",
  'not-found': 'No update information was found on the server. Spaci will try again later.',
  'bad-feed': 'The update server sent something Spaci could not read. Spaci will try again later.',
  checksum: 'The downloaded update did not match its checksum and was discarded. Spaci will try again later.',
  signature: 'The downloaded update failed signature verification and was not installed.',
  unknown: 'The update check failed. Spaci will try again later.',
  timeout: 'The update server stopped responding. Spaci will try again later.',
  slow: 'The update server is slow to respond. Spaci will keep trying in the background.',
  'download-failed': 'The update could not be downloaded. Spaci will try again later.',
  'feed-refused': 'The update offered by the server is not valid, so it was not downloaded.',
};

// ---------- controller ----------
/**
 * @param {object} o
 * @param {object} o.updater  electron-updater's autoUpdater, or a fake with the same surface
 * @param {string} o.currentVersion
 * @param {boolean} [o.isPackaged]
 * @param {() => boolean} [o.isOnline]
 * @param {() => object} [o.getPrefs]  honours prefs.autoCheckUpdates (default on)
 * @param {(status:object) => void} [o.send]  push status to the renderer
 * @param {(version:string) => void} [o.notifyReady]  tell the user once per downloaded version
 * @param {() => void} [o.beforeInstall]  let the app mark itself as quitting
 */
function createUpdateController({
  updater, currentVersion, isPackaged = true, isOnline = () => true, getPrefs = () => ({}),
  send = () => {}, notifyReady = () => {}, beforeInstall = () => {},
  onReadyWithdrawn = () => {}, onInstallAbandoned = () => {},
  // 'resolve' on macOS: MacUpdater emits update-downloaded before Squirrel.Mac
  // has fetched the zip, and only resolves downloadUpdate() once it has.
  readyOn = 'event',
  log = console, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  defer = (fn) => setImmediate(fn), schedule = {},
  checkTimeoutMs = 30 * MIN, manualWaitMs = 60 * 1000, installTimeoutMs = 2 * MIN,
}) {
  let phase = 'idle'; // idle | checking | downloading | ready
  let status = { state: 'idle' };
  let inflight = null;
  let manualWaiting = false;
  let readyVersion = null;
  let notifiedVersion = null;
  let downloadedInfo = null;
  let checkGen = 0;
  let installRequested = false;
  let installTimer = null;
  let schedState = { lastCompletedAt: 0, lastAttemptAt: 0, failures: 0 };

  const setStatus = (s) => {
    status = { ...s, at: now() };
    try { send(status); } catch (e) { log.warn('[update] could not send status:', e && e.message); }
    return status;
  };
  const safe = (fn, what) => { try { fn(); } catch (e) { log.warn(`[update] ${what} failed:`, e && e.message); } };

  // Configure the real updater. Downloads are started by us, after the offer
  // passes evaluateUpdate. `channel` is left alone on purpose: setting it
  // flips allowDowngrade on in electron-updater.
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
  }

  function markReady(info) {
    const version = (info && info.version) || readyVersion;
    phase = 'ready';
    readyVersion = version;
    setStatus({ state: 'ready', version });
    if (version && notifiedVersion !== version) {
      notifiedVersion = version;
      safe(() => notifyReady(version), 'notify');
    }
  }

  function fail(err, stage) {
    const raw = classifyError(err);
    const kind = stage === 'download' && raw === 'unknown' ? 'download-failed' : raw;
    log.warn(`[update] ${stage} failed (${kind}):`, (err && err.message) || err);
    if (manualWaiting) setStatus({ state: 'error', kind, message: FRIENDLY[kind] || FRIENDLY.unknown });
    else if (['checking', 'available', 'downloading', 'ready'].includes(status.state)) {
      setStatus({ state: 'idle', lastError: kind });
    }
    // Even an offline-looking error backs off: the problem may be DNS or the
    // server, and polling it every few minutes would not help.
    return { status: 'failed', reason: kind };
  }

  /** Readiness turned out to be false (Squirrel failed after the fact): undo it everywhere. */
  function withdrawReady(err, stage) {
    const wasInstalling = installRequested;
    installRequested = false;
    if (installTimer) { clearTimer(installTimer); installTimer = null; }
    phase = 'idle';
    readyVersion = null;
    downloadedInfo = null;
    notifiedVersion = null;
    safe(() => onReadyWithdrawn(), 'onReadyWithdrawn');
    if (wasInstalling) safe(() => onInstallAbandoned(), 'onInstallAbandoned');
    return fail(err, stage);
  }

  if (updater && typeof updater.on === 'function') {
    updater.on('checking-for-update', () => { if (manualWaiting && status.state !== 'checking') setStatus({ state: 'checking' }); });
    updater.on('download-progress', (p) => {
      if (phase !== 'downloading') return;
      setStatus({
        state: 'downloading',
        version: readyVersion,
        percent: Math.round((p && p.percent) || 0),
        bytesPerSecond: p && p.bytesPerSecond,
        transferred: p && p.transferred,
        total: p && p.total,
      });
    });
    updater.on('update-downloaded', (info) => {
      // Only a download we started and approved can become "ready".
      if (phase !== 'downloading') { log.warn('[update] ignoring unexpected update-downloaded'); return; }
      downloadedInfo = info || null;
      if (readyOn === 'event') markReady(info);
    });
    // Errors also reject the promise we await; this catches the ones that only
    // arrive as events (Squirrel.Mac staging and signature checks after the
    // download, which can come after we already said "ready").
    updater.on('error', (err) => {
      if (phase === 'ready') withdrawReady(err, 'install');
      else if (phase === 'downloading' && !inflight) {
        phase = 'idle';
        readyVersion = null;
        fail(err, 'download');
      } else {
        log.warn('[update] updater error event:', (err && err.message) || err);
      }
    });
  }

  const TIMED_OUT = { status: 'failed', reason: 'timeout' };

  async function doCheck(gen) {
    const stale = () => gen !== checkGen;
    // Chromium's online flag can be wrong (some Linux and VPN setups), so it
    // only gates background checks; a manual check just tries.
    if (!manualWaiting && !isOnline()) return { status: 'deferred', reason: 'offline' };
    phase = 'checking';
    downloadedInfo = null;
    if (manualWaiting) setStatus({ state: 'checking' });
    let result;
    try {
      result = await updater.checkForUpdates();
    } catch (e) {
      if (stale()) return TIMED_OUT;
      phase = 'idle';
      return fail(e, 'check');
    }
    if (stale()) return TIMED_OUT;
    const info = result && result.updateInfo;
    if (!result || !result.isUpdateAvailable || !info) {
      phase = 'idle';
      setStatus({ state: 'current', version: currentVersion });
      return { status: 'ok' };
    }
    const verdict = evaluateUpdate(info, currentVersion);
    if (!verdict.ok) {
      phase = 'idle';
      log.warn(`[update] refusing ${info.version}: ${verdict.reason}`);
      if (verdict.reason === 'missing-checksum' || verdict.reason === 'no-files' || verdict.reason === 'invalid-version') {
        if (manualWaiting) setStatus({ state: 'error', kind: 'feed-refused', message: FRIENDLY['feed-refused'] });
        return { status: 'failed', reason: verdict.reason };
      }
      setStatus({ state: 'current', version: currentVersion });
      return { status: 'ok', refused: verdict.reason };
    }
    phase = 'downloading';
    readyVersion = info.version;
    setStatus({ state: 'available', version: info.version });
    try {
      await updater.downloadUpdate();
    } catch (e) {
      if (stale()) return TIMED_OUT;
      if (phase === 'ready') return withdrawReady(e, 'download');
      phase = 'idle';
      readyVersion = null;
      return fail(e, 'download');
    }
    if (stale()) return TIMED_OUT;
    // macOS: resolving means Squirrel.Mac has the zip. Elsewhere the
    // update-downloaded event (already seen, or still to come) decides.
    if (phase === 'downloading' && (readyOn === 'resolve' || downloadedInfo)) markReady(downloadedInfo || info);
    return { status: 'ok' };
  }

  function check({ manual = false } = {}) {
    if (!isPackaged) return Promise.resolve(setStatus({ state: 'dev', version: currentVersion })).then(() => ({ status: 'skipped' }));
    if (manual) manualWaiting = true;
    if (phase === 'ready') {
      if (manual) { manualWaiting = false; setStatus({ state: 'ready', version: readyVersion }); }
      return Promise.resolve({ status: 'ok' });
    }
    if (phase === 'downloading' && !inflight) {
      // A download is still finishing (waiting on its event); do not start another.
      if (manual) manualWaiting = false;
      return Promise.resolve({ status: 'ok' });
    }
    if (inflight) return inflight;
    const gen = ++checkGen;
    const work = (async () => {
      try { return await doCheck(gen); } catch (e) {
        if (gen !== checkGen) return TIMED_OUT;
        phase = 'idle';
        return fail(e, 'check');
      }
    })();
    // Watchdog: a request or download that never settles must not wedge the
    // updater. Its late result is ignored (the generation moved on).
    let timer = null;
    const watchdog = new Promise((res) => { timer = setTimer(() => res(null), checkTimeoutMs); });
    inflight = Promise.race([work, watchdog]).then((r) => {
      clearTimer(timer);
      if (r) return r;
      checkGen++;
      if (phase !== 'ready') { phase = 'idle'; readyVersion = null; }
      return fail(Object.assign(new Error('update check timed out'), { code: 'SPACI_TIMEOUT' }), 'check');
    }).finally(() => { inflight = null; manualWaiting = false; });
    return inflight;
  }

  const autoEnabled = () => {
    const p = getPrefs() || {};
    return p.autoCheckUpdates !== false;
  };

  const scheduler = createScheduler({
    name: 'updater',
    task: () => check({ manual: false }),
    getConfig: () => ({ intervalMs: schedule.intervalMs || 6 * HOUR }),
    gate: () => {
      if (!isPackaged || !autoEnabled() || phase === 'ready') return { run: false, reason: 'disabled' };
      if (!isOnline()) return { run: false, reason: 'offline' };
      return { run: true, reason: 'due' };
    },
    getState: () => schedState,
    saveState: (s) => { schedState = s; },
    log, now, setTimer, clearTimer,
    options: { startupDelayMs: 20 * 1000, retryBaseMs: 30 * MIN, deferMs: 15 * MIN, runTimeoutMs: checkTimeoutMs + 5 * MIN, ...schedule },
  });

  return {
    start() {
      if (!isPackaged) { setStatus({ state: 'dev', version: currentVersion }); return; }
      scheduler.start();
    },
    stop: () => scheduler.stop(),
    reschedule: () => scheduler.reschedule(),
    wake: () => scheduler.wake(),
    /**
     * Manual check from Settings: always allowed, reports errors, and answers
     * within manualWaitMs even if the server hangs (the check carries on).
     */
    async checkNow() {
      const p = check({ manual: true });
      let t = null;
      const cap = new Promise((res) => { t = setTimer(() => res(null), manualWaitMs); });
      const r = await Promise.race([p, cap]);
      clearTimer(t);
      if (!r) {
        if (phase === 'checking') setStatus({ state: 'error', kind: 'slow', message: FRIENDLY.slow });
        return status;
      }
      // A successful manual check resets the periodic clock.
      if (r.status === 'ok') schedState = { ...schedState, lastCompletedAt: now(), lastAttemptAt: now(), failures: 0 };
      return status;
    },
    status: () => status,
    get phase() { return phase; },
    /** Restart into the downloaded update. Only after a verified download. */
    install() {
      if (!isPackaged || phase !== 'ready') return false;
      installRequested = true;
      safe(() => beforeInstall(), 'beforeInstall');
      // If the app is still running after installTimeoutMs, the install did not
      // happen: let the app stop acting as if it were quitting.
      if (installTimer) clearTimer(installTimer);
      installTimer = setTimer(() => {
        installTimer = null;
        if (!installRequested) return;
        installRequested = false;
        log.warn('[update] install did not complete in time');
        safe(() => onInstallAbandoned(), 'onInstallAbandoned');
      }, installTimeoutMs);
      defer(() => {
        try { updater.quitAndInstall(false, true); } catch (e) { withdrawReady(e, 'install'); }
      });
      return true;
    },
    scheduler,
    get schedState() { return schedState; },
  };
}

module.exports = {
  parseVersion, isPrerelease, compareVersions, isValidSha512, evaluateUpdate, classifyError,
  createUpdateController, FRIENDLY,
};
