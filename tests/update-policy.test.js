'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const {
  parseVersion, isPrerelease, compareVersions, isValidSha512, evaluateUpdate, classifyError,
  createUpdateController, FRIENDLY,
} = require('../src/update-policy');
const { HOUR, MIN } = require('../src/scheduler');
const { fakeClock, deferred, flush, quietLog } = require('./fake-clock');

const SHA = crypto.createHash('sha512').update('spaci').digest('base64');
const info = (version, over = {}) => ({
  version,
  files: [{ url: `Spaci-${version}-arm64-mac.zip`, sha512: SHA, size: 1 }],
  path: `Spaci-${version}-arm64-mac.zip`,
  sha512: SHA,
  ...over,
});

// ---------- versions ----------
test('parseVersion and isPrerelease', () => {
  assert.deepEqual(parseVersion('2.2.0'), { major: 2, minor: 2, patch: 0, pre: [] });
  assert.deepEqual(parseVersion('v2.2.0-rc.1').pre, ['rc', '1']);
  assert.equal(parseVersion('2.2'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
  assert.equal(isPrerelease('2.2.0-rc.1'), true);
  assert.equal(isPrerelease('2.2.0-beta'), true);
  assert.equal(isPrerelease('2.2.0'), false);
  assert.equal(isPrerelease('2.2.0+build.5'), false);
});

test('compareVersions follows semver precedence', () => {
  const ordered = ['1.9.9', '2.0.0-alpha', '2.0.0-alpha.1', '2.0.0-beta', '2.0.0-rc.1', '2.0.0-rc.2', '2.0.0-rc.10', '2.0.0', '2.0.1', '2.1.0', '10.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(compareVersions('2.1.0', 'v2.1.0'), 0);
  assert.throws(() => compareVersions('x', '1.0.0'));
});

// ---------- feed validation ----------
test('isValidSha512 accepts real digests only', () => {
  assert.equal(isValidSha512(SHA), true);
  for (const bad of ['', null, undefined, 'abc', SHA.slice(0, 80), crypto.createHash('sha512').update('x').digest('hex'), `${SHA.slice(0, 86)}!=`]) {
    assert.equal(isValidSha512(bad), false, String(bad));
  }
});

test('evaluateUpdate accepts a newer stable release with checksums', () => {
  assert.deepEqual(evaluateUpdate(info('2.2.0'), '2.1.0'), { ok: true });
  // An RC install moves on to the stable release.
  assert.deepEqual(evaluateUpdate(info('2.2.0'), '2.2.0-rc.1'), { ok: true });
});

test('evaluateUpdate refuses same version, downgrades and prereleases', () => {
  assert.equal(evaluateUpdate(info('2.1.0'), '2.1.0').reason, 'not-newer');
  assert.equal(evaluateUpdate(info('2.0.9'), '2.1.0').reason, 'not-newer');
  assert.equal(evaluateUpdate(info('2.2.0-rc.1'), '2.1.0').reason, 'prerelease');
  assert.equal(evaluateUpdate(info('2.2.0-rc.2'), '2.2.0-rc.1').reason, 'prerelease');
  assert.equal(evaluateUpdate(info('latest'), '2.1.0').reason, 'invalid-version');
  assert.equal(evaluateUpdate(null, '2.1.0').reason, 'invalid-version');
});

test('evaluateUpdate fails safe on empty or missing sha512', () => {
  assert.equal(evaluateUpdate(info('2.2.0', { files: [{ url: 'a.zip', sha512: '' }], sha512: '' }), '2.1.0').reason, 'missing-checksum');
  assert.equal(evaluateUpdate(info('2.2.0', { files: [{ url: 'a.zip' }], path: undefined, sha512: undefined }), '2.1.0').reason, 'missing-checksum');
  // One good file and one without a checksum: refuse the whole update.
  assert.equal(evaluateUpdate(info('2.2.0', { files: [{ url: 'a.zip', sha512: SHA }, { url: 'b.dmg', sha512: '' }] }), '2.1.0').reason, 'missing-checksum');
  assert.equal(evaluateUpdate({ version: '2.2.0' }, '2.1.0').reason, 'no-files');
  // Legacy single-file shape
  assert.deepEqual(evaluateUpdate({ version: '2.2.0', path: 'a.zip', sha512: SHA }, '2.1.0'), { ok: true });
});

test('classifyError maps transport failures to calm categories', () => {
  const e = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  assert.equal(classifyError(e('getaddrinfo ENOTFOUND spaci.kentom.co.ke', 'ENOTFOUND')), 'offline');
  assert.equal(classifyError(e('net::ERR_INTERNET_DISCONNECTED')), 'offline');
  assert.equal(classifyError(e('net::ERR_NAME_NOT_RESOLVED')), 'offline');
  assert.equal(classifyError(e('HttpError: 404 Not Found "method: GET url: https://spaci.kentom.co.ke/updates/latest-mac.yml"')), 'not-found');
  assert.equal(classifyError(e('Cannot parse update info from latest-mac.yml in the latest release artifacts', 'ERR_UPDATER_INVALID_UPDATE_INFO')), 'bad-feed');
  assert.equal(classifyError(e('YAMLException: end of the stream or a document separator is expected')), 'bad-feed');
  assert.equal(classifyError(e('sha512 checksum mismatch, expected x, got y', 'ERR_CHECKSUM_MISMATCH')), 'checksum');
  assert.equal(classifyError(e('Code signature at URL file:///x did not pass validation')), 'signature');
  assert.equal(classifyError('weird'), 'unknown');
});

// ---------- controller with a fake updater ----------
class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checks = 0;
    this.downloads = 0;
    this.installs = [];
    this.channelSet = false;
    this.nextCheck = null; // () => Promise<result>
    this.nextDownload = null; // () => Promise
  }
  set channel(v) { this.channelSet = true; this.allowDowngrade = true; this._channel = v; }
  get channel() { return this._channel || null; }
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    try {
      const r = await (this.nextCheck ? this.nextCheck() : { isUpdateAvailable: false, updateInfo: info('2.1.0') });
      if (r && r.isUpdateAvailable) this.emit('update-available', r.updateInfo);
      else this.emit('update-not-available', r && r.updateInfo);
      return r;
    } catch (e) {
      this.emit('error', e);
      throw e;
    }
  }
  async downloadUpdate() {
    this.downloads++;
    try {
      await (this.nextDownload ? this.nextDownload() : undefined);
    } catch (e) {
      this.emit('error', e);
      throw e;
    }
    this.emit('download-progress', { percent: 100, bytesPerSecond: 1, transferred: 1, total: 1 });
    this.emit('update-downloaded', this.lastInfo || info('2.2.0'));
    return ['/tmp/x.zip'];
  }
  quitAndInstall(silent, forceRun) { this.installs.push([silent, forceRun]); }
}

const available = (u, i) => { u.lastInfo = i; u.nextCheck = async () => ({ isUpdateAvailable: true, updateInfo: i }); };

function ctl({ prefs = {}, online = true, packaged = true, current = '2.1.0', readyOn } = {}) {
  const clock = fakeClock();
  const updater = new FakeUpdater();
  const statuses = [];
  const ready = [];
  const log = quietLog();
  const env = { online, prefs, beforeInstall: 0, withdrawn: 0, abandoned: 0 };
  const c = createUpdateController({
    updater,
    currentVersion: current,
    isPackaged: packaged,
    isOnline: () => env.online,
    getPrefs: () => env.prefs,
    send: (s) => statuses.push(s),
    notifyReady: (v) => ready.push(v),
    beforeInstall: () => { env.beforeInstall++; },
    onReadyWithdrawn: () => { env.withdrawn++; },
    onInstallAbandoned: () => { env.abandoned++; },
    readyOn,
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    defer: (fn) => fn(),
  });
  return { c, clock, updater, statuses, ready, log, env, states: () => statuses.map((s) => s.state) };
}

test('the updater is configured to never take prereleases or downgrades, and channel is untouched', () => {
  const { updater } = ctl();
  assert.equal(updater.autoDownload, false, 'downloads start only after our checks');
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.channelSet, false, 'setting channel would flip allowDowngrade on');
});

test('startup: first check after a delay, then every six hours; startup never blocks', async () => {
  const { c, clock, updater } = ctl();
  c.start();
  assert.equal(updater.checks, 0);
  await clock.advance(19 * 1000);
  assert.equal(updater.checks, 0);
  await clock.advance(1000);
  assert.equal(updater.checks, 1);
  await clock.advance(6 * HOUR - 1000);
  assert.equal(updater.checks, 1);
  await clock.advance(1000);
  assert.equal(updater.checks, 2);
});

test('a newer valid release downloads, becomes ready, and the user is told once', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0'));
  t.c.start();
  await t.clock.advance(20 * 1000);
  assert.equal(t.updater.downloads, 1);
  assert.equal(t.c.phase, 'ready');
  assert.deepEqual(t.ready, ['2.2.0']);
  assert.deepEqual(t.states(), ['available', 'downloading', 'ready']);
  // No more checks or downloads once ready, and no repeated notification.
  await t.clock.advance(48 * HOUR);
  assert.equal(t.updater.checks, 1);
  assert.equal(t.updater.downloads, 1);
  const s = await t.c.checkNow();
  assert.equal(s.state, 'ready');
  assert.equal(t.updater.checks, 1);
  assert.deepEqual(t.ready, ['2.2.0']);
});

test('the user chooses when to restart: install only after a verified download', async () => {
  const t = ctl();
  assert.equal(t.c.install(), false, 'nothing downloaded yet');
  assert.equal(t.updater.installs.length, 0);
  available(t.updater, info('2.2.0'));
  await t.c.checkNow();
  assert.equal(t.c.install(), true);
  assert.equal(t.env.beforeInstall, 1, 'app marked as quitting before quitAndInstall');
  assert.deepEqual(t.updater.installs, [[false, true]]);
});

test('offline in the background: silent, no error shown, retried later', async () => {
  const t = ctl({ online: false });
  t.c.start();
  await t.clock.advance(2 * HOUR);
  assert.equal(t.updater.checks, 0, 'no request while offline');
  assert.deepEqual(t.statuses, [], 'nothing nags the user');
  t.env.online = true;
  await t.clock.advance(15 * MIN);
  assert.equal(t.updater.checks, 1);
});

test('DNS failure, 404 and malformed feed in the background: no error status, exponential backoff', async () => {
  for (const err of [
    Object.assign(new Error('getaddrinfo ENOTFOUND spaci.kentom.co.ke'), { code: 'ENOTFOUND' }),
    new Error('HttpError: 404 Not Found'),
    Object.assign(new Error('Cannot parse update info'), { code: 'ERR_UPDATER_INVALID_UPDATE_INFO' }),
  ]) {
    const t = ctl();
    t.updater.nextCheck = async () => { throw err; };
    t.c.start();
    await t.clock.advance(20 * 1000);
    assert.equal(t.updater.checks, 1);
    assert.ok(!t.states().includes('error'), `background ${err.message} surfaced as an error`);
    assert.ok(t.log.lines.warn.length > 0, 'logged');
    await t.clock.advance(29 * MIN);
    assert.equal(t.updater.checks, 1, 'no tight loop');
    await t.clock.advance(2 * MIN);
    assert.equal(t.updater.checks, 2, 'first retry after ~30 minutes');
    await t.clock.advance(58 * MIN);
    assert.equal(t.updater.checks, 2);
    await t.clock.advance(2 * MIN);
    assert.equal(t.updater.checks, 3, 'second retry an hour later');
    t.c.stop();
  }
});

test('a manual check reports failures in plain words', async () => {
  const t = ctl();
  t.updater.nextCheck = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }); };
  const s = await t.c.checkNow();
  assert.equal(s.state, 'error');
  assert.equal(s.message, FRIENDLY.offline);

  // Chromium's online flag can be wrong, so a manual check still tries.
  const off = ctl({ online: false });
  const s2 = await off.c.checkNow();
  assert.equal(s2.state, 'current');
  assert.equal(off.updater.checks, 1);
});

test('a manual check with nothing new says so', async () => {
  const t = ctl();
  const s = await t.c.checkNow();
  assert.deepEqual([s.state, s.version], ['current', '2.1.0']);
  assert.deepEqual(t.states(), ['checking', 'current']);
});

test('empty sha512 in the feed: nothing is downloaded, ever', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0', { files: [{ url: 'Spaci-2.2.0-arm64-mac.zip', sha512: '' }], sha512: '' }));
  const s = await t.c.checkNow();
  assert.equal(t.updater.downloads, 0);
  assert.equal(s.state, 'error');
  assert.equal(s.message, FRIENDLY['feed-refused']);
  t.c.start();
  await t.clock.advance(24 * HOUR);
  assert.equal(t.updater.downloads, 0);
  assert.equal(t.c.phase, 'idle');
});

test('a prerelease in the feed is never downloaded', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0-rc.1'));
  const s = await t.c.checkNow();
  assert.equal(t.updater.downloads, 0);
  assert.equal(s.state, 'current');
});

test('same version or a downgrade offered by the feed is never downloaded', async () => {
  for (const v of ['2.1.0', '2.0.0']) {
    const t = ctl();
    available(t.updater, info(v));
    await t.c.checkNow();
    assert.equal(t.updater.downloads, 0, v);
  }
});

test('a failed download is retried later, not in a loop, and never marked ready', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0'));
  let fails = 2;
  t.updater.nextDownload = async () => { if (fails-- > 0) throw new Error('sha512 checksum mismatch'); };
  t.c.start();
  await t.clock.advance(20 * 1000);
  assert.equal(t.updater.downloads, 1);
  assert.equal(t.c.phase, 'idle');
  assert.ok(!t.states().includes('ready'));
  assert.ok(!t.states().includes('error'), 'background failure does not nag');
  assert.equal(t.statuses[t.statuses.length - 1].state, 'idle', 'no spinner stuck on "downloading"');
  await t.clock.advance(25 * MIN);
  assert.equal(t.updater.downloads, 1);
  await t.clock.advance(10 * MIN);
  assert.equal(t.updater.downloads, 2);
  await t.clock.advance(65 * MIN);
  assert.equal(t.updater.downloads, 3);
  assert.equal(t.c.phase, 'ready');
  assert.deepEqual(t.ready, ['2.2.0']);
});

test('an error event after the download promise (Squirrel.Mac signature check) resets to idle', async () => {
  const t = ctl();
  t.updater.lastInfo = info('2.2.0');
  t.updater.nextCheck = async () => ({ isUpdateAvailable: true, updateInfo: info('2.2.0') });
  // Download resolves but the native updater has not emitted update-downloaded yet.
  t.updater.downloadUpdate = async function () { this.downloads++; return []; };
  await t.c.checkNow();
  assert.equal(t.c.phase, 'downloading');
  t.updater.emit('error', new Error('Code signature at URL file:///x did not pass validation'));
  assert.equal(t.c.phase, 'idle');
  assert.equal(t.c.install(), false);
});

test('an update-downloaded we did not approve is ignored', async () => {
  const t = ctl();
  t.updater.emit('update-downloaded', info('9.9.9'));
  assert.equal(t.c.phase, 'idle');
  assert.equal(t.c.install(), false);
  assert.deepEqual(t.ready, []);
});

test('a manual check during a background check shares one request', async () => {
  const t = ctl();
  const d = deferred();
  t.updater.nextCheck = () => d.promise;
  t.c.start();
  await t.clock.advance(20 * 1000);
  const manual = t.c.checkNow();
  await flush();
  assert.equal(t.updater.checks, 1);
  d.resolve({ isUpdateAvailable: false, updateInfo: info('2.1.0') });
  assert.equal((await manual).state, 'current');
  assert.equal(t.updater.checks, 1);
});

test('automatic checks honour the autoCheckUpdates preference; manual checks still work', async () => {
  const t = ctl({ prefs: { autoCheckUpdates: false } });
  t.c.start();
  await t.clock.advance(3 * 24 * HOUR);
  assert.equal(t.updater.checks, 0);
  await t.c.checkNow();
  assert.equal(t.updater.checks, 1);
  t.env.prefs = { autoCheckUpdates: true };
  t.c.reschedule();
  await t.clock.advance(6 * HOUR + MIN);
  assert.equal(t.updater.checks, 2);
});

test('dev builds never check and report a dev status', async () => {
  const t = ctl({ packaged: false });
  t.c.start();
  await t.clock.advance(24 * HOUR);
  assert.equal(t.updater.checks, 0);
  assert.equal((await t.c.checkNow()).state, 'dev');
  assert.equal(t.c.install(), false);
});

test('after sleep, wake() triggers one check, not one per missed interval', async () => {
  const t = ctl();
  t.c.start();
  await t.clock.advance(20 * 1000);
  t.clock.sleep(4 * 24 * HOUR);
  t.c.wake(); t.c.wake();
  await t.clock.advance(2 * MIN);
  assert.equal(t.updater.checks, 2);
});

test('stop() on quit cancels future checks', async () => {
  const t = ctl();
  t.c.start();
  t.c.stop();
  await t.clock.advance(24 * HOUR);
  assert.equal(t.updater.checks, 0);
});

// ---------- regressions from review (scratchpad liveness.js) ----------

/** MacUpdater order: update-downloaded fires, then Squirrel fetches the zip, then the promise settles. */
function macDownload(u, { squirrelError = null } = {}) {
  u.downloadUpdate = async function () {
    this.downloads++;
    this.emit('download-progress', { percent: 100 });
    this.emit('update-downloaded', this.lastInfo);
    await new Promise((r) => setImmediate(r));
    if (squirrelError) { this.emit('error', squirrelError); throw squirrelError; }
    return [];
  };
}

test('macOS: update-downloaded alone is not "ready"; only the resolved download is', async () => {
  const t = ctl({ readyOn: 'resolve' });
  available(t.updater, info('2.2.0'));
  macDownload(t.updater);
  await t.c.checkNow();
  assert.equal(t.c.phase, 'ready');
  assert.deepEqual(t.ready, ['2.2.0']);
  assert.equal(t.states().filter((x) => x === 'ready').length, 1);
});

test('macOS: Squirrel failing after update-downloaded never leaves Spaci stuck on "ready"', async () => {
  const t = ctl({ readyOn: 'resolve' });
  available(t.updater, info('2.2.0'));
  macDownload(t.updater, { squirrelError: new Error('Code signature at URL file:///x did not pass validation') });
  t.c.start();
  await t.clock.advance(20 * 1000);
  assert.equal(t.c.phase, 'idle');
  assert.deepEqual(t.ready, [], 'the user was never told it was ready');
  assert.equal(t.c.install(), false);
  // The scheduler keeps going (backoff), and a manual check reaches the server.
  await t.clock.advance(31 * MIN);
  assert.equal(t.updater.checks, 2);
  const before = t.updater.checks;
  await t.c.checkNow();
  assert.equal(t.updater.checks, before + 1);
});

test('event mode: readiness withdrawn when the download promise rejects after update-downloaded', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0'));
  macDownload(t.updater, { squirrelError: new Error('ENOSPC: no space left on device') });
  await t.c.checkNow();
  assert.equal(t.c.phase, 'idle');
  assert.equal(t.env.withdrawn, 1, 'tray "Restart to Update" cleared');
  assert.notEqual(t.c.status().state, 'ready');
  assert.equal(t.c.install(), false);
});

test('an error after install() was clicked withdraws readiness and ends the quitting state', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0'));
  t.updater.quitAndInstall = function () { this.installs.push('waiting for Squirrel'); };
  await t.c.checkNow();
  assert.equal(t.c.install(), true);
  assert.equal(t.env.beforeInstall, 1);
  t.updater.emit('error', new Error('Code signature did not pass validation'));
  assert.equal(t.c.phase, 'idle');
  assert.equal(t.env.withdrawn, 1);
  assert.equal(t.env.abandoned, 1, 'isQuitting reset so close-to-tray works again');
  await t.clock.advance(10 * MIN);
  assert.equal(t.env.abandoned, 1, 'install timer cleared, not fired again');
});

test('an install that never completes gives the app back after the install timeout', async () => {
  const t = ctl();
  available(t.updater, info('2.2.0'));
  t.updater.quitAndInstall = () => {};
  await t.c.checkNow();
  t.c.install();
  await t.clock.advance(2 * MIN - 1000);
  assert.equal(t.env.abandoned, 0);
  await t.clock.advance(1000);
  assert.equal(t.env.abandoned, 1);
  assert.equal(t.c.phase, 'ready', 'still installable on the next quit');
});

test('a hung check times out; a manual check answers within a minute and never waits on it forever', async () => {
  const t = ctl();
  t.updater.nextCheck = () => new Promise(() => {});
  t.c.start();
  await t.clock.advance(20 * 1000);
  assert.equal(t.updater.checks, 1);
  let answered = null;
  t.c.checkNow().then((s) => { answered = s; });
  await t.clock.advance(60 * 1000);
  assert.ok(answered, 'manual check answered');
  assert.equal(answered.state, 'error');
  assert.equal(answered.kind, 'slow');
  // The watchdog releases the check after 30 minutes, then backoff retries.
  await t.clock.advance(30 * MIN);
  assert.equal(t.c.phase, 'idle');
  t.updater.nextCheck = null;
  await t.clock.advance(31 * MIN);
  assert.equal(t.updater.checks, 2, 'retried after the timeout');
  assert.equal(t.c.status().state, 'current');
});

test('a late result from a timed-out check is ignored', async () => {
  const t = ctl();
  const d = deferred();
  t.updater.nextCheck = () => d.promise;
  const p = t.c.checkNow();
  await t.clock.advance(30 * MIN);
  await p;
  d.resolve({ isUpdateAvailable: true, updateInfo: info('2.2.0') });
  await flush();
  assert.equal(t.updater.downloads, 0, 'stale check did not start a download');
  assert.equal(t.c.phase, 'idle');
});

test('liveness per platform: first check, or after three server errors, ends ready and installable', async () => {
  for (const readyOn of ['resolve', 'event']) {
    for (const failFirst of [0, 3]) {
      const t = ctl({ readyOn, current: '2.2.0' });
      let n = failFirst;
      const i = info('2.2.1');
      t.updater.lastInfo = i;
      t.updater.nextCheck = async () => {
        if (n-- > 0) throw new Error('HttpError: 500 Internal Server Error');
        return { isUpdateAvailable: true, updateInfo: i };
      };
      if (readyOn === 'resolve') macDownload(t.updater);
      t.c.start();
      await t.clock.advance(20 * HOUR);
      assert.equal(t.c.phase, 'ready', `${readyOn} failFirst=${failFirst}`);
      assert.equal(t.updater.checks, failFirst + 1);
      assert.deepEqual(t.ready, ['2.2.1']);
      assert.equal(t.c.install(), true);
      assert.deepEqual(t.updater.installs, [[false, true]]);
    }
  }
});
