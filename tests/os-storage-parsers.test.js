'use strict';
// Parsers of the storage breakdown (src/os-storage), fed real command output.
// macOS fixtures were captured on a Mac (macOS 27, APFS, no Full Disk Access);
// Linux and Windows fixtures follow the documented output formats of each tool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FX = path.join(__dirname, 'fixtures', 'os-storage');
const fx = (name) => fs.readFileSync(path.join(FX, name), 'utf8');
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const darwin = require('../src/os-storage/darwin');
const linux = require('../src/os-storage/linux');
const win32 = require('../src/os-storage/win32');
const du = require('../src/os-storage/du');
const { parseCloneOutput } = require('../src/os-storage/clonesize');

// ---------- macOS ----------

test('darwin: APFS volumes of the boot container only, labelled, Data excluded', () => {
  const list = JSON.parse(fx('darwin-apfs-list.json'));
  const info = JSON.parse(fx('darwin-info.json'));
  const vols = darwin.parseApfsVolumes(list, info.APFSContainerReference);
  const roles = vols.map((v) => v.role).sort();
  assert.ok(roles.includes('System') && roles.includes('Preboot') && roles.includes('VM'), roles.join(','));
  assert.ok(!roles.includes('Data'));
  for (const v of vols) assert.ok(v.bytes > 0 && typeof v.name === 'string');
  // Sorted biggest first.
  assert.deepEqual(vols.map((v) => v.bytes), vols.map((v) => v.bytes).slice().sort((a, b) => b - a));
});

test('darwin: sysctl vm.swapusage', () => {
  const s = darwin.parseSwapUsage(fx('darwin-swapusage.txt'));
  assert.ok(s.total > 0 && s.used > 0 && s.used <= s.total);
  assert.deepEqual(darwin.parseSwapUsage('vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'), { total: 2048 * MB, used: Math.round(1024.5 * MB) });
  assert.equal(darwin.parseSwapUsage('garbage'), null);
});

test('darwin: tmutil listlocalsnapshots counts snapshots, splits OS-update from Time Machine', () => {
  const s = darwin.parseSnapshots(fx('darwin-tmutil.txt'));
  assert.equal(s.count, 1);
  assert.equal(s.osUpdate, 1);
  const tm = darwin.parseSnapshots('Snapshots for disk /:\ncom.apple.TimeMachine.2026-09-30-101010.local\ncom.apple.TimeMachine.2026-09-30-111010.local\n');
  assert.deepEqual([tm.count, tm.timeMachine, tm.osUpdate], [2, 2, 0]);
  assert.equal(darwin.parseSnapshots('').count, 0);
});

test('darwin: capacity keys give purgeable = important - available', () => {
  const c = darwin.parseCapacity(fx('darwin-capacity.json'));
  assert.equal(c.purgeable, c.important - c.available);
  assert.ok(c.purgeable > 0);
  assert.equal(darwin.parseCapacity('not json'), null);
  assert.equal(darwin.parseCapacity('{"available":10,"important":null}').purgeable, null);
});

test('darwin: simctl runtime list gives size, last use and the disk image path', () => {
  const rts = darwin.parseSimRuntimes(fx('darwin-simctl-runtime.json'));
  assert.equal(rts.length, 1);
  const r = rts[0];
  assert.equal(r.platform, 'iOS');
  assert.equal(r.version, '26.5');
  assert.equal(r.bytes, 8494282293);
  assert.match(r.lastUsedAt, /^2026-/);
  assert.match(r.path, /^\/System\/Library\/AssetsV2\/.*\.dmg$/);
  assert.equal(r.deletable, true);
  assert.deepEqual(darwin.parseSimRuntimes('{}'), []);
  assert.deepEqual(darwin.parseSimRuntimes(''), []);
});

test('darwin: brew cleanup -n freeable bytes', () => {
  assert.equal(darwin.parseBrewCleanup(fx('darwin-brew-cleanup.txt')), Math.round(5.5 * MB));
  assert.equal(darwin.parseBrewCleanup('==> This operation would free approximately 1.2GB of disk space.'), Math.round(1.2 * GB));
  assert.equal(darwin.parseBrewCleanup(''), 0, 'nothing to clean');
});

test('darwin: getconf DARWIN_USER_CACHE_DIR -> the per-user /var/folders base', () => {
  assert.match(darwin.userFoldersBase(fx('darwin-getconf-cache.txt')), /^\/var\/folders\/[^/]+\/[^/]+$/);
  assert.equal(darwin.userFoldersBase('/tmp/evil/C/'), null);
  assert.equal(darwin.userFoldersBase(''), null);
});

test('darwin: code-sign clone folders name the apps they copy', () => {
  assert.deepEqual(darwin.cloneAppNames(['Google Chrome.app', 'Info.plist', 'Google Chrome.app']), ['Google Chrome.app']);
});

// ---------- du (BSD and GNU) ----------

test('du: BSD output and permission errors', () => {
  const root = '/Users/user/Library';
  const r = du.parseDuOutput(fx('du-bsd.txt'), fx('du-bsd-stderr.txt'), root);
  assert.equal(r.total, 65853580 * 1024);
  assert.ok(r.children.some((c) => c.path === '/Users/user/Library/Caches' && c.bytes === 2495408 * 1024));
  assert.ok(r.denied.includes('/Users/user/Library/Application Support/MobileSync'));
  assert.equal(r.denied.length, 12);
});

test('du: GNU output and its error formats', () => {
  const r = du.parseDuOutput(fx('du-gnu.txt'), fx('du-gnu-stderr.txt'), '/var/lib');
  assert.equal(r.total, 1563124 * 1024);
  assert.deepEqual(r.denied, ['/var/lib/polkit-1', '/var/lib/docker', '/var/lib/private/systemd']);
  assert.equal(du.parseDuLine('12\t/a b/c').path, '/a b/c');
  assert.equal(du.parseDuLine('nonsense'), null);
});

test('du: -x always, excludes use -I on macOS and --exclude on Linux', () => {
  assert.deepEqual(du.duArgs('/private/var', { exclude: ['folders'], platform: 'darwin' }), ['-xk', '-d', '1', '-I', 'folders', '/private/var']);
  assert.deepEqual(du.duArgs('/usr', { exclude: ['local'], platform: 'linux' }), ['-xk', '-d', '1', '--exclude=local', '/usr']);
});

test('clone helper output: allocated, private and footprint per measured root', () => {
  const r = parseCloneOutput('R 0 19406 39561084928 806912 1841463296 0 0 0\nR 1 missing\nnoise\n', ['/var/folders/x/X', '/nope']);
  assert.deepEqual(r[0], { path: '/var/folders/x/X', files: 19406, allocated: 39561084928, private: 806912, footprint: 1841463296, denied: 0, fallback: 0, partial: false });
  assert.equal(r[1].missing, true);
});

// ---------- Linux ----------

test('linux: sizes as the tools print them', () => {
  assert.equal(linux.parseSize('1.254GB'), Math.round(1.254 * GB));
  assert.equal(linux.parseSize('12.3kB'), Math.round(12.3 * 1024));
  assert.equal(linux.parseSize('0B'), 0);
  assert.equal(linux.parseSize('1.1 GB'), Math.round(1.1 * GB));
  assert.equal(linux.parseSize('56.0M'), Math.round(56 * MB));
  assert.equal(linux.parseSize(''), null);
});

test('linux: journalctl --disk-usage', () => {
  assert.equal(linux.parseJournalUsage(fx('linux-journalctl.txt')), Math.round(1.2 * GB));
  assert.equal(linux.parseJournalUsage('No journal files were found.'), null);
});

test('linux: docker system df rows with reclaimable', () => {
  const rows = linux.parseDockerDf(fx('linux-docker-df.jsonl'));
  assert.deepEqual(rows.map((r) => r.type), ['Images', 'Containers', 'Local Volumes', 'Build Cache']);
  assert.equal(rows[0].reclaimable, Math.round(1.08 * GB));
  assert.equal(rows[3].reclaimable, Math.round(310 * MB));
  assert.deepEqual(linux.parseDockerDf('Cannot connect to the Docker daemon'), []);
});

test('linux: snap list --all marks disabled revisions', () => {
  const s = linux.parseSnapList(fx('linux-snap-list.txt'));
  assert.equal(s.length, 5);
  assert.deepEqual(s.filter((x) => x.disabled).map((x) => x.name + '_' + x.rev), ['core22_1122', 'firefox_4173']);
  assert.deepEqual(linux.parseSnapList('error: snapd not running'), []);
});

test('linux: flatpak list sizes', () => {
  const f = linux.parseFlatpakList(fx('linux-flatpak.txt'));
  assert.equal(f.length, 3);
  assert.equal(f[0].app, 'org.gnome.Platform');
  assert.equal(f[1].bytes, Math.round(254.3 * MB));
});

test('linux: /proc/swaps keeps swap files, not partitions', () => {
  assert.deepEqual(linux.parseProcSwaps(fx('linux-proc-swaps.txt')), [{ path: '/swap.img', bytes: 4194300 * 1024, used: 524288 * 1024 }]);
});

test('linux: root filesystem type and ext4 reserved blocks', () => {
  assert.equal(linux.rootFsType(fx('linux-proc-mounts.txt')), 'ext4');
  assert.equal(linux.rootFsType(fx('linux-proc-mounts-btrfs.txt')), 'btrfs');
  assert.equal(linux.reservedBytes({ bfree: 1000, bavail: 950, bsize: 4096 }), 50 * 4096);
  assert.equal(linux.reservedBytes(null), 0);
});

// ---------- Windows ----------

test('win32: PowerShell facts (root files, page file, WSL, vhdx allocated size)', () => {
  const f = win32.parseFacts(fx('win-facts.json'));
  assert.equal(f.drive, 'C:');
  assert.equal(f.root['pagefile.sys'], 10200547328);
  assert.equal(f.root['hiberfil.sys'], 6816694272);
  assert.equal(f.pagefiles[0].bytes, 9728 * MB);
  assert.equal(f.sid, 'S-1-5-21-3623811015-3361044348-30300820-1013');
  assert.deepEqual(f.distros.map((d) => d.name), ['Ubuntu-24.04', 'docker-desktop']);
  const dockerDisk = f.vhdx.find((v) => v.kind === 'docker');
  assert.equal(dockerDisk.allocated, 32 * GB);
  assert.equal(dockerDisk.length, 64 * GB);
  assert.ok(f.dirs.includes('Windows.old'));
});

test('win32: single values instead of arrays, a BOM, and junk', () => {
  const f = win32.parseFacts(fx('win-facts-single.json'));
  assert.equal(f.root['pagefile.sys'], 4 * GB);
  assert.deepEqual(f.dirs, ['Windows']);
  assert.equal(f.sid, null);
  assert.deepEqual(f.vhdx, []);
  assert.equal(win32.parseFacts('Get-CimInstance : Access denied'), null);
});
