'use strict';
// The per-OS collectors and the breakdown's accounting, with every command,
// folder size and file system call faked from fixtures. No real disk is
// walked except in the tests marked "real", which use a temp folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FX = path.join(__dirname, 'fixtures', 'os-storage');
const fx = (name) => fs.readFileSync(path.join(FX, name), 'utf8');
const GB = 1024 ** 3;
const { TIERS } = require('../src/os-storage/tiers');

const ok = (stdout) => ({ ok: true, stdout, stderr: '', code: 0, timedOut: false, missing: false });
const fail = () => ({ ok: false, stdout: '', stderr: 'not found', code: 1, timedOut: false, missing: true });
const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' });
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

function fakeFs({ dirs = {}, denied = [], files = {}, exists = [] } = {}) {
  return {
    async readdir(p, o) {
      if (denied.includes(p)) throw eperm();
      if (!dirs[p]) throw enoent();
      return o && o.withFileTypes ? dirs[p].map((n) => ({ name: n, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false })) : dirs[p];
    },
    async access(p) { if (!exists.includes(p) && !dirs[p] && !(p in files)) throw enoent(); },
    async readFile(p) { if (p in files) return files[p]; throw enoent(); },
    async lstat(p) { if (p in files) return { blocks: 8, size: 4096, isFile: () => true }; throw enoent(); },
    async statfs() { return { bfree: 1000, bavail: 950, bsize: 4096, blocks: 10000 }; },
  };
}
function fakeMeasure(table) {
  const calls = [];
  const fn = async (p, opts) => {
    calls.push([p, opts]);
    const v = table[p];
    if (v == null) return null;
    return { path: p, bytes: v.bytes, confidence: v.confidence || 'exact', children: (v.children || []).map(([n, b]) => ({ path: p + '/' + n, bytes: b })), denied: v.denied || 0, deniedPaths: [] };
  };
  fn.calls = calls;
  return fn;
}

function checkItems(items) {
  for (const it of items) {
    assert.ok(TIERS[it.tier], it.key + ' has a tier');
    assert.ok(['os', 'area', 'remainder', 'info'].includes(it.group), it.key + ' has a group');
    if (it.tier === 'D') assert.ok(it.command || it.commandNote, it.key + ' (tier D) shows the OS command or says why there is none');
    if (it.group === 'remainder') assert.equal(it.bytes, null, it.key + ' is named, not sized');
  }
}

// ---------- macOS ----------

test('darwin collector: volumes, /private/var split, clones, simulator runtimes, Homebrew, named remainder', async () => {
  const darwin = require('../src/os-storage/darwin');
  const home = '/Users/me';
  const base = '/var/folders/qr/abc';
  const run = async (cmd, args) => {
    const a = (args || []).join(' ');
    if (cmd === '/bin/sh' && /info -plist/.test(a)) return ok(fx('darwin-info.json'));
    if (cmd === '/bin/sh' && /apfs list/.test(a)) return ok(fx('darwin-apfs-list.json'));
    if (cmd === 'sysctl') return ok(fx('darwin-swapusage.txt'));
    if (cmd === 'tmutil') return ok(fx('darwin-tmutil.txt'));
    if (cmd === 'osascript') return ok(fx('darwin-capacity.json'));
    if (cmd === 'getconf') return ok(base + '/C/\n');
    if (cmd === 'xcode-select') return ok('/Applications/Xcode.app/Contents/Developer\n');
    if (cmd === 'xcrun') return ok(fx('darwin-simctl-runtime.json'));
    if (/brew$/.test(cmd)) return ok(fx('darwin-brew-cleanup.txt'));
    return fail();
  };
  const measure = fakeMeasure({
    '/private/var': { bytes: 7 * GB, children: [['db', 4 * GB], ['vm', 2 * GB], ['log', 0.2 * GB]] },
    [base + '/C']: { bytes: 1.8 * GB },
    [base + '/T']: { bytes: 1.7 * GB, confidence: 'denied' },
    [base + '/0']: { bytes: 0.05 * GB },
    [base + '/X']: { bytes: 38 * GB },
    '/System/Library/AssetsV2': { bytes: 20 * GB, children: [['com_apple_MobileAsset_iOSSimulatorRuntime', 8.3 * GB], ['com_apple_MobileAsset_Font8', 1 * GB]] },
    '/Library/Developer': { bytes: 4.8 * GB, children: [['CommandLineTools', 1.4 * GB]] },
    '/opt/homebrew': { bytes: 27 * GB },
    '/Library': { bytes: 10 * GB },
    '/Users/Shared': { bytes: 0.5 * GB },
    '/usr/local': { bytes: 0.9 * GB },
    '/opt': { bytes: 0 },
  });
  const cloneCalls = [];
  const cloneSize = async (o) => { cloneCalls.push(o); return [{ path: o.measure[0], files: 19000, allocated: 38 * GB, private: 800000, footprint: 1.8 * GB, denied: 0, fallback: 0, partial: false }]; };
  const fsp = fakeFs({
    dirs: {
      '/Users': ['me', 'Shared', 'guest2', '.localized'],
      [base + '/X']: ['com.google.Chrome.code_sign_clone'],
      [base + '/X/com.google.Chrome.code_sign_clone']: ['code_sign_clone.abc'],
      [base + '/X/com.google.Chrome.code_sign_clone/code_sign_clone.abc']: ['Google Chrome.app'],
    },
    denied: [home + '/Library/Safari', home + '/Library/Mail'],
    exists: ['/opt/homebrew/bin/brew', '/Applications/Google Chrome.app'],
  });
  const streamed = [];
  const { items, facts } = await darwin.collect({ home, run, measure, cloneSize, fs: fsp, onItem: (it) => streamed.push(it.key) });
  checkItems(items);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));

  assert.equal(facts.fullDiskAccess, false);
  assert.ok(by['vol-system'] && by['vol-vm'] && by['vol-preboot'], 'APFS volumes are OS items');
  assert.equal(by['vol-vm'].group, 'os');
  assert.equal(by['var-db'].bytes, 4 * GB);
  assert.equal(by.sleepimage.bytes, 2 * GB);
  assert.equal(by['var-other'].bytes, Math.round(0.8 * GB));
  // du ignored /private/var/folders, the per-user part is measured separately
  assert.deepEqual(measure.calls.find(([p]) => p === '/private/var')[1].exclude, ['folders']);
  assert.equal(by['user-temp-dir'].confidence, 'denied');

  // Clones: the footprint beyond the app bundle, du kept as a reference, freeable at least private.
  assert.equal(by['code-sign-clones'].bytes, Math.round(1.8 * GB));
  assert.equal(by['code-sign-clones'].duBytes, 38 * GB);
  assert.equal(by['code-sign-clones'].freeableAtLeast, 800000);
  assert.deepEqual(cloneCalls[0].seed, ['/Applications/Google Chrome.app']);

  // Simulator runtime: its own item, carved out of AssetsV2 so it counts once.
  assert.equal(by['sim-runtimes'].bytes, 8494282293);
  assert.equal(by['sim-runtimes'].tier, 'B');
  assert.match(by['sim-runtimes'].children[0].command, /^xcrun simctl runtime delete /);
  assert.equal(by['mobile-assets'].bytes, 20 * GB - 8494282293);
  assert.ok(!by['mobile-assets'].children.some((c) => /SimulatorRuntime/.test(c.path)));

  // /Library minus /Library/Developer; Homebrew with freeable from brew cleanup -n.
  assert.equal(by.library.bytes, Math.round(5.2 * GB));
  assert.equal(by.homebrew.freeableAtLeast, Math.round(5.5 * 1024 ** 2));
  assert.match(by.homebrew.command, /^brew cleanup/);
  assert.deepEqual(measure.calls.find(([p]) => p === '/opt')[1].exclude, ['homebrew']);

  // Named remainder: Full Disk Access with a settings link, other users, snapshots.
  assert.equal(by.protected.group, 'remainder');
  assert.equal(by.protected.settings, darwin.FDA_SETTINGS_URL);
  assert.ok(by.protected.children.some((c) => c.name === 'iPhone and iPad backups'));
  assert.equal(by['other-users'].count, 1);
  assert.equal(by.snapshots.count, 1);
  assert.match(by.snapshots.command, /^tmutil /);
  assert.equal(by.purgeable.additive, false);
  assert.ok(by.purgeable.bytes > 0);
  assert.ok(streamed.length === items.length, 'every item is streamed as it is ready');
});

test('darwin collector: no Xcode means no xcrun call (it would prompt to install tools)', async () => {
  const darwin = require('../src/os-storage/darwin');
  const seen = [];
  const run = async (cmd) => { seen.push(cmd); if (cmd === 'xcode-select') return fail(); return fail(); };
  const { items } = await darwin.collect({ home: '/Users/me', run, measure: fakeMeasure({}), cloneSize: null, fs: fakeFs() });
  assert.ok(!seen.includes('xcrun'));
  checkItems(items);
  assert.ok(items.some((i) => i.key === 'snapshots'), 'the remainder is named even when nothing else answers');
});

test('darwin collector: without perl the clone folder is an upper bound, not a guess', async () => {
  const darwin = require('../src/os-storage/darwin');
  const base = '/var/folders/qr/abc';
  const run = async (cmd) => (cmd === 'getconf' ? ok(base + '/C') : fail());
  const fsp = fakeFs({ dirs: { [base + '/X']: ['a.code_sign_clone'] } });
  const { items } = await darwin.collect({ home: '/Users/me', run, measure: fakeMeasure({ [base + '/X']: { bytes: 38 * GB } }), cloneSize: async () => null, fs: fsp });
  const x = items.find((i) => i.key === 'code-sign-clones');
  assert.equal(x.confidence, 'upper-bound');
  assert.equal(x.bytes, 38 * GB);
});

// ---------- Linux ----------

test('linux collector: journald, package caches, snaps, flatpak, docker, swap, ext4 reserve, btrfs', async () => {
  const linux = require('../src/os-storage/linux');
  const run = async (cmd, args) => {
    if (cmd === 'journalctl') return ok(fx('linux-journalctl.txt'));
    if (cmd === 'snap') return ok(fx('linux-snap-list.txt'));
    if (cmd === 'flatpak') return ok(fx('linux-flatpak.txt'));
    if (cmd === 'docker') return ok(fx('linux-docker-df.jsonl'));
    return fail();
  };
  const measure = fakeMeasure({
    '/usr': { bytes: 9 * GB },
    '/boot': { bytes: 0.3 * GB },
    '/var/log': { bytes: 1.5 * GB, children: [['journal', 1.2 * GB], ['syslog', 0.1 * GB]] },
    '/var/cache': { bytes: 2 * GB },
    '/var/cache/apt/archives': { bytes: 1.5 * GB },
    '/var/lib': { bytes: 3 * GB, confidence: 'denied', denied: 4, children: [['snapd', 1 * GB], ['flatpak', 0.5 * GB], ['apt', 0.1 * GB]] },
    '/usr/local': { bytes: 0.2 * GB },
  });
  const files = {
    '/proc/mounts': fx('linux-proc-mounts-btrfs.txt'),
    '/proc/swaps': fx('linux-proc-swaps.txt'),
    '/var/lib/snapd/snaps/core22_1122.snap': '', '/var/lib/snapd/snaps/core22_1380.snap': '', '/var/lib/snapd/snaps/firefox_4173.snap': '', '/var/lib/snapd/snaps/firefox_4259.snap': '', '/var/lib/snapd/snaps/snapd_21465.snap': '',
  };
  const fsp = fakeFs({ files, dirs: { '/home': ['me', 'other'] }, exists: ['/timeshift'] });
  const { items, facts } = await linux.collect({ home: '/home/me', run, measure, fs: fsp, statfs: fsp.statfs, categoryDirs: ['/var/lib/flatpak', '/opt'] });
  checkItems(items);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(facts.fsType, 'btrfs');
  assert.equal(by.journald.bytes, Math.round(1.2 * GB));
  assert.match(by.journald.command, /journalctl --vacuum/);
  assert.equal(by['apt-cache'].bytes, 1.5 * GB);
  assert.equal(by['apt-cache'].command, 'sudo apt-get clean');
  assert.equal(by['var-cache'].bytes, 0.5 * GB);
  assert.equal(by['snap-revisions'].children.length, 2);
  assert.match(by['snap-revisions'].command, /refresh\.retain/);
  assert.equal(by.flatpak.additive, false, 'flatpak is counted in Applications already');
  assert.equal(by.docker.bytes, Math.round(1.254 * GB) + Math.round(12.3 * 1024) + Math.round(52.4 * 1024 ** 2) + Math.round(310 * 1024 ** 2));
  // /var/lib without snapd (listed as snaps) and flatpak (in Applications).
  assert.equal(by['var-lib'].bytes, Math.round(1.5 * GB));
  assert.equal(by['swapfile:/swap.img'].bytes, 4194300 * 1024);
  assert.ok(by['btrfs-snapshots'] && by.timeshift, 'btrfs and Timeshift are named parts of the remainder');
  assert.equal(by['other-users'].count, 1);
  assert.equal(by['ext4-reserved'], undefined, 'no ext4 reserve on btrfs');
});

test('linux collector: ext4 reserve is reported (not part of used)', async () => {
  const linux = require('../src/os-storage/linux');
  const fsp = fakeFs({ files: { '/proc/mounts': fx('linux-proc-mounts.txt'), '/proc/swaps': '' } });
  const { items, facts } = await linux.collect({ home: '/home/me', run: async () => fail(), measure: fakeMeasure({}), fs: fsp, statfs: fsp.statfs });
  checkItems(items);
  assert.equal(facts.reserved, 50 * 4096);
  const r = items.find((i) => i.key === 'ext4-reserved');
  assert.equal(r.additive, false);
  assert.equal(r.bytes, 50 * 4096);
});

// ---------- Windows ----------

test('win32 collector: root system files, Windows.old, Recycle Bin, vhdx, named remainder', async () => {
  const win32 = require('../src/os-storage/win32');
  const run = async (cmd) => (cmd === 'powershell.exe' ? ok(fx('win-facts.json')) : fail());
  const W = 'C:\\Windows';
  const measure = fakeMeasure({
    'C:\\Windows.old': { bytes: 18 * GB, confidence: 'denied' },
    [W + '\\SoftwareDistribution\\Download']: { bytes: 1.1 * GB },
    [W + '\\Installer']: { bytes: 3 * GB },
    'C:\\$Recycle.Bin\\S-1-5-21-3623811015-3361044348-30300820-1013': { bytes: 0.7 * GB },
    [W + '\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization']: { bytes: 0, confidence: 'denied' },
    'C:\\ProgramData': { bytes: 6 * GB },
  });
  const fsp = fakeFs({ dirs: { 'C:\\Users': ['dev', 'Public', 'Default', 'alice', 'desktop.ini'] } });
  const { items } = await win32.collect({ home: 'C:\\Users\\dev', run, measure, fs: fsp, env: { SystemRoot: W, SystemDrive: 'C:' }, categoryDirs: ['C:\\Users\\dev\\AppData\\Local'] });
  checkItems(items);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by.pagefile.bytes, 10200547328);
  assert.equal(by.hiberfil.bytes, 6816694272);
  assert.match(by.hiberfil.command, /^powercfg \/h/);
  assert.equal(by.swapfile.tier, 'D');
  assert.equal(by['windows-old'].bytes, 18 * GB);
  assert.equal(by['windows-old'].confidence, 'denied');
  assert.equal(by['recycle-bin'].tier, 'C');
  assert.match(by['recycle-bin'].command, /^Clear-RecycleBin/);
  // Delivery Optimization is admin-only: a named part of the remainder with its command.
  assert.equal(by['delivery-optimization'].group, 'remainder');
  assert.match(by['delivery-optimization'].command, /Delete-DeliveryOptimizationCache/);
  // WinSxS and restore points: named, with DISM / vssadmin.
  assert.match(by.winsxs.command, /^Dism \/Online \/Cleanup-Image \/AnalyzeComponentStore/);
  assert.match(by['restore-points'].command, /^vssadmin list shadowstorage/);
  assert.equal(by['reserved-storage'].group, 'remainder');
  // vhdx under %LOCALAPPDATA% are already in App Data: shown, not added twice. Allocated size wins.
  const docker = items.find((i) => /^vhdx:.*docker_data/.test(i.key));
  assert.equal(docker.bytes, 32 * GB);
  assert.equal(docker.additive, false);
  assert.match(docker.commandNote, /Optimize-VHD/);
  const wsl = items.find((i) => i.key.startsWith('vhdx:') && /Ubuntu/.test(i.label));
  assert.match(wsl.command, /^wsl --manage Ubuntu-24\.04 --set-sparse true/);
  assert.equal(by['other-users'].count, 1);
});

test('win32 collector: without PowerShell the folders and named parts still come back', async () => {
  const win32 = require('../src/os-storage/win32');
  const { items } = await win32.collect({ home: 'C:\\Users\\dev', run: async () => fail(), measure: fakeMeasure({ 'C:\\ProgramData': { bytes: GB } }), fs: fakeFs(), env: { SystemDrive: 'C:' } });
  checkItems(items);
  assert.ok(items.some((i) => i.key === 'programdata'));
  assert.ok(items.some((i) => i.key === 'winsxs'));
});

// ---------- accounting ----------

const { assemble } = require('../src/diskbreakdown');
const defs = [
  { key: 'developer', label: 'Developer', tier: 'C', dirs: ['/h/projects'], subtractDirs: [] },
  { key: 'caches', label: 'Caches', tier: 'B', dirs: ['/h/Library/Caches'], subtractDirs: ['/h/Library/Caches/pip'] },
];

test('assemble: System = OS items + folders + unclaimed home + a named remainder, adding up to used', () => {
  const sizes = new Map([['/h/projects', { bytes: 100 * GB, confidence: 'exact' }], ['/h/Library/Caches', { bytes: 10 * GB, confidence: 'exact' }], ['/h/Library/Caches/pip', { bytes: 2 * GB, confidence: 'exact' }]]);
  const osItems = [
    { key: 'vol-system', label: 'macOS', tier: 'D', group: 'os', bytes: 14 * GB, additive: true },
    { key: 'homebrew', label: 'Homebrew', tier: 'C', group: 'area', bytes: 20 * GB, additive: true },
    { key: 'purgeable', label: 'Purgeable', tier: 'D', group: 'info', bytes: 6 * GB, additive: false },
    { key: 'protected', label: 'Protected', tier: 'C', group: 'remainder', bytes: null },
  ];
  const unclassified = [{ name: 'misc', path: '/h/misc', bytes: 4 * GB }];
  const r = assemble({ total: 500 * GB, used: 300 * GB, free: 200 * GB, defs, sizes, osItems, unclassified, home: '/h', platform: 'darwin' });
  const by = Object.fromEntries(r.categories.map((c) => [c.key, c]));
  assert.equal(by.caches.bytes, 8 * GB, 'known child caches are subtracted');
  const sys = by.system;
  assert.equal(sys.bytes, 300 * GB - 108 * GB);
  assert.equal(sys.remainder.bytes, sys.bytes - (14 + 20 + 4) * GB);
  assert.equal(r.unexplained, sys.remainder.bytes);
  assert.equal(r.explained + r.unexplained, r.used);
  const sum = r.categories.reduce((a, c) => a + c.bytes, 0);
  assert.equal(sum, r.used, 'categories add up to used exactly');
  assert.deepEqual(sys.remainder.parts.map((p) => p.key), ['protected']);
  assert.deepEqual(sys.info.map((p) => p.key), ['purgeable']);
  assert.equal(r.reconcile, null);
  assert.equal(sys.tier, 'D');
  assert.equal(by.developer.tier, 'C');
});

test('assemble: an overcount is reported, never scaled away', () => {
  const sizes = new Map([['/h/projects', { bytes: 280 * GB, confidence: 'exact' }], ['/h/Library/Caches', { bytes: 10 * GB, confidence: 'exact' }]]);
  const osItems = [{ key: 'code-sign-clones', label: 'Clones', tier: 'B', group: 'area', bytes: 38 * GB, duBytes: 38 * GB, confidence: 'upper-bound', additive: true }];
  const r = assemble({ total: 500 * GB, used: 300 * GB, free: 200 * GB, defs, sizes, osItems, unclassified: [], home: '/h', platform: 'darwin' });
  const by = Object.fromEntries(r.categories.map((c) => [c.key, c]));
  assert.equal(by.developer.bytes, 280 * GB, 'not scaled');
  assert.equal(by.system.bytes, 38 * GB, 'System holds what was measured in it');
  assert.equal(r.reconcile.overcount, 28 * GB);
  assert.deepEqual(r.reconcile.upperBound, ['Clones']);
  assert.equal(r.unexplained, 0);
});

test('assemble: pending folders show their cached size and the category says so', () => {
  const sizes = new Map([['/h/projects', { bytes: 50 * GB, confidence: 'cached', pending: true }]]);
  const r = assemble({ total: 500 * GB, used: 300 * GB, free: 200 * GB, defs, sizes, osItems: [], unclassified: null, home: '/h', platform: 'linux', partial: true, pending: 3 });
  const dev = r.categories.find((c) => c.key === 'developer');
  assert.equal(dev.bytes, 50 * GB);
  assert.equal(dev.pending, true);
  assert.equal(dev.confidence, 'cached');
  assert.equal(r.meta.partial, true);
  assert.equal(r.meta.pending, 3);
  assert.equal(r.meta.version, 2);
});

test('assemble: a timed-out folder keeps its bytes and marks the category partial', () => {
  const sizes = new Map([['/h/projects', { bytes: 3 * GB, confidence: 'partial' }]]);
  const r = assemble({ total: 500 * GB, used: 300 * GB, free: 200 * GB, defs, sizes, osItems: [], unclassified: [], home: '/h', platform: 'linux' });
  const dev = r.categories.find((c) => c.key === 'developer');
  assert.equal(dev.bytes, 3 * GB);
  assert.equal(dev.partial, true);
  assert.deepEqual(r.categories.find((c) => c.key === 'system').unmeasured, ['/h/projects']);
});

// ---------- real helpers on a temp folder ----------

test('real: du streams children and reports a timeout as partial bytes, not zero', { skip: process.platform === 'win32' }, async () => {
  const { duTree } = require('../src/os-storage/du');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-du-'));
  try {
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', 'f'), Buffer.alloc(300000, 1));
    const r = await duTree(root, { timeoutMs: 20000 });
    assert.equal(r.confidence, 'exact');
    assert.ok(r.bytes >= 300000);
    assert.ok(r.children.some((c) => c.path === path.join(root, 'a')));
    // A fake du that prints one child and hangs: killed at the timeout, the child's bytes remain.
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const spawnFn = () => {
      const c = new EventEmitter();
      c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.kill = () => setImmediate(() => c.emit('close', null, 'SIGKILL'));
      setImmediate(() => c.stdout.write('2048\t/x/child\n'));
      return c;
    };
    const p = await duTree('/x', { timeoutMs: 50, spawnFn });
    assert.deepEqual([p.bytes, p.confidence], [2048 * 1024, 'partial']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real: the clone-aware helper counts an APFS clone once', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/perl') }, async () => {
  const { cloneAwareSize } = require('../src/os-storage/clonesize');
  const { execFileSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-clone-'));
  try {
    fs.writeFileSync(path.join(root, 'big'), require('crypto').randomBytes(4 * 1024 * 1024));
    try { execFileSync('cp', ['-c', path.join(root, 'big'), path.join(root, 'clone')]); } catch { return; } // not APFS
    const [r] = await cloneAwareSize({ measure: [root], budgetSec: 20 });
    assert.equal(r.files, 2);
    assert.ok(r.allocated >= 8 * 1024 * 1024, 'du-style counts both copies');
    assert.ok(r.footprint < 5 * 1024 * 1024, 'footprint counts the shared blocks once');
    assert.ok(r.private < 1024 * 1024, 'deleting either file frees almost nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real: the Node walker (Windows path) keeps partial bytes and counts hard links once', async () => {
  const { walkTree } = require('../src/os-storage/walk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-walk-'));
  try {
    fs.mkdirSync(path.join(root, 'd'));
    fs.writeFileSync(path.join(root, 'd', 'f'), Buffer.alloc(100000, 1));
    try { fs.linkSync(path.join(root, 'd', 'f'), path.join(root, 'd', 'g')); } catch (_) { /* no hard links */ }
    const r = await walkTree(root, { timeoutMs: 10000 });
    assert.equal(r.confidence, 'exact');
    assert.ok(r.bytes >= 100000 && r.bytes < 200000, 'the hard link is not counted twice: ' + r.bytes);
    let t = 0;
    const late = await walkTree(root, { timeoutMs: 1, now: () => (t += 5) });
    assert.equal(late.confidence, 'partial');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('size cache: survives a restart, never lets a partial replace a complete size, resets for another disk', () => {
  const { createSizeCache } = require('../src/os-storage/size-cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-sc-'));
  const file = path.join(dir, 'storage-sizes.json');
  try {
    let now = 1000;
    const a = createSizeCache({ file, now: () => now });
    a.checkVolume('darwin:500');
    a.set('/p', 100, 'exact');
    a.set('/p', 10, 'partial');
    assert.ok(a.save());
    const b = createSizeCache({ file, now: () => now });
    b.checkVolume('darwin:500');
    assert.equal(b.get('/p').bytes, 100);
    now += 31 * 24 * 3600 * 1000;
    assert.equal(b.get('/p'), null, 'too old');
    const c = createSizeCache({ file, now: () => 1000 });
    c.checkVolume('darwin:999');
    assert.equal(c.get('/p'), null, 'a different disk starts empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
