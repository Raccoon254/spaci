'use strict';
// macOS: the parts of used space that live outside the home folder, and the
// parts no folder walk can see. Sources and verification: os-storage-spec.md
// sections 0 and 2. Nothing here needs admin rights, and nothing here deletes
// or cleans: tier D items only carry the command macOS offers, as text.

const path = require('path');
const { item } = require('./tiers');
const { json } = require('./exec');

const FDA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

// ---------- parsers (pure, fixture tested) ----------

// The boot disk's other APFS volumes (the sealed system, Preboot, Recovery,
// swap, pending updates). They share the container, so statfs counts them in
// `used`, but no folder holds them. Mounted image containers (simulator
// runtimes) are other containers and are never included.
const VOLUME_LABELS = {
  System: 'macOS system files', Preboot: 'Startup files (Preboot)', Recovery: 'Recovery',
  VM: 'Swap (virtual memory)', Update: 'Pending macOS updates',
};
const VOLUME_HINTS = {
  System: 'The sealed, read-only macOS system volume.',
  Preboot: 'Boot policies and cryptexes macOS needs to start up.',
  Recovery: 'The macOS Recovery system.',
  VM: 'Memory macOS has paged out to disk, plus the kernel core file.',
  Update: 'An operating system update that has been downloaded but not installed.',
};
const VOLUME_COMMANDS = {
  System: { commandNote: 'No command changes it: the system volume is sealed and only a macOS reinstall or update rewrites it.' },
  Preboot: { commandNote: 'No command: macOS rewrites Preboot on each update.' },
  Recovery: { commandNote: 'No command: macOS keeps Recovery in step with the installed version.' },
  VM: { command: 'sysctl vm.swapusage', commandNote: 'Shows swap in use. Closing memory-heavy apps or restarting shrinks it.' },
  Update: { command: 'softwareupdate --list', commandNote: 'Install the pending update from System Settings > General > Software Update.' },
};
function parseApfsVolumes(list, containerRef) {
  const out = [];
  for (const c of (list && list.Containers) || []) {
    if (c.ContainerReference !== containerRef) continue;
    for (const v of c.Volumes || []) {
      const role = (v.Roles || [])[0] || '';
      if (role === 'Data' || !VOLUME_LABELS[role]) continue;
      const bytes = Number(v.CapacityInUse) || 0;
      if (bytes > 0) out.push({ role, name: VOLUME_LABELS[role], bytes });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** `sysctl vm.swapusage` -> { total, used } bytes. */
function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const grab = (k) => {
    const m = new RegExp(k + '\\s*=\\s*([\\d.]+)([KMG])').exec(String(text || ''));
    return m ? Math.round(Number(m[1]) * unit[m[2]]) : null;
  };
  const total = grab('total');
  const used = grab('used');
  return total == null ? null : { total, used: used || 0 };
}

/** `tmutil listlocalsnapshots /` -> { count, names } (sizes are not published). */
function parseSnapshots(text) {
  const names = String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^com\.apple\./.test(l));
  return {
    count: names.length,
    names,
    timeMachine: names.filter((n) => /TimeMachine/.test(n)).length,
    osUpdate: names.filter((n) => /os\.update/.test(n)).length,
  };
}

/** The capacity keys from capacityScript(): purgeable = important - available. */
function parseCapacity(text) {
  const v = json(text);
  if (!v || typeof v.available !== 'number') return null;
  const important = typeof v.important === 'number' ? v.important : null;
  return {
    available: v.available,
    important,
    opportunistic: typeof v.opportunistic === 'number' ? v.opportunistic : null,
    purgeable: important != null ? Math.max(0, important - v.available) : null,
  };
}

/** `xcrun simctl runtime list -j` -> runtimes with their disk size and last use. */
function parseSimRuntimes(text) {
  const v = json(text);
  if (!v || typeof v !== 'object') return [];
  return Object.values(v).filter((r) => r && typeof r === 'object').map((r) => ({
    id: String(r.identifier || ''),
    version: String(r.version || ''),
    build: String(r.build || ''),
    platform: /iphone/i.test(r.platformIdentifier || '') ? 'iOS' : /watch/i.test(r.platformIdentifier || '') ? 'watchOS' : /appletv/i.test(r.platformIdentifier || '') ? 'tvOS' : /xr/i.test(r.platformIdentifier || '') ? 'visionOS' : 'Simulator',
    bytes: Number(r.sizeBytes) || 0,
    lastUsedAt: r.lastUsedAt || null,
    deletable: r.deletable !== false,
    state: String(r.state || ''),
    path: String(r.path || ''),
    mountPath: String(r.mountPath || ''),
  })).filter((r) => r.id).sort((a, b) => b.bytes - a.bytes);
}

/** `brew cleanup -n` -> bytes it would free ("free approximately 5.5MB"). */
function parseBrewCleanup(text) {
  const m = /free approximately ([\d.]+)\s*([KMGT]?B)/i.exec(String(text || ''));
  if (!m) return /Would remove/.test(String(text || '')) ? null : 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
  return Math.round(Number(m[1]) * mult);
}

/** `getconf DARWIN_USER_CACHE_DIR` -> the per-user /var/folders base (…/<xx>/<hash>). */
function userFoldersBase(cacheDir) {
  const s = String(cacheDir || '').trim().replace(/\/+$/, '');
  if (!/^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/C$/.test(s)) return null;
  return s.replace(/\/C$/, '');
}

/** App bundles a code-sign clone folder holds (…/X/<id>.code_sign_clone/<clone>/<Name>.app). */
function cloneAppNames(listing) {
  return Array.from(new Set((listing || []).filter((n) => /\.app$/.test(n))));
}

// JXA reads the capacity keys (no admin, no helper binary).
const CAPACITY_SCRIPT = `ObjC.import('Foundation');
function run(argv){const u=$.NSURL.fileURLWithPath(argv[0]||'/');
const k=[$.NSURLVolumeAvailableCapacityKey,$.NSURLVolumeAvailableCapacityForImportantUsageKey,$.NSURLVolumeAvailableCapacityForOpportunisticUsageKey];
const v=u.resourceValuesForKeysError($(k),null);const g=(x)=>{const o=v.objectForKey(x);return o.isNil()?null:Number(o.longLongValue);};
return JSON.stringify({available:g(k[0]),important:g(k[1]),opportunistic:g(k[2])});}`;

// Folders only Full Disk Access opens (spec 0.7).
function protectedPaths(home) {
  const j = (...p) => path.join(home, ...p);
  return [
    { path: j('Library', 'Mail'), label: 'Mail' },
    { path: j('Library', 'Messages'), label: 'Messages attachments' },
    { path: j('Library', 'Safari'), label: 'Safari' },
    { path: j('Library', 'Application Support', 'MobileSync', 'Backup'), label: 'iPhone and iPad backups' },
    { path: j('.Trash'), label: 'Trash' },
    { path: j('Library', 'Metadata', 'CoreSpotlight'), label: 'Spotlight index' },
    { path: j('Library', 'Containers', 'com.apple.mail'), label: 'Mail container' },
  ];
}

// ---------- collection ----------

/**
 * @param {object} ctx
 * @param {string} ctx.home
 * @param {(cmd, args, opts) => Promise<{ok, stdout, stderr}>} ctx.run
 * @param {(p, opts) => Promise<{bytes, confidence, children, denied}>} ctx.measure  du-backed
 * @param {(opts) => Promise<Array|null>} ctx.cloneSize
 * @param {object} ctx.fs  fs.promises-like (lstat, readdir, access)
 * @param {(it) => void} [ctx.onItem]  called as each item is ready (partial results)
 * @returns {Promise<{ items: object[], facts: object }>}
 */
async function collect(ctx) {
  const { home, run, measure, cloneSize, fs: fsp } = ctx;
  const emit = (it) => { if (it && ctx.onItem) { try { ctx.onItem(it); } catch (_) {} } return it; };
  const items = [];
  const facts = { platform: 'darwin' };
  const push = (it) => { if (it) { items.push(it); emit(it); } return it; };

  // 1. Cheap OS-layer calls first, so the donut fills in seconds.
  const plist = async (args) => {
    const r = await run('/bin/sh', ['-c', `diskutil ${args} | plutil -convert json -o - -`], { timeout: 20000 });
    return r.ok ? json(r.stdout) : null;
  };
  const [info, list, swap, snaps, cap, fda] = await Promise.all([
    plist('info -plist /'),
    plist('apfs list -plist'),
    run('sysctl', ['vm.swapusage'], { timeout: 4000 }).then((r) => (r.ok ? parseSwapUsage(r.stdout) : null)),
    run('tmutil', ['listlocalsnapshots', '/'], { timeout: 6000 }).then((r) => (r.ok ? parseSnapshots(r.stdout) : null)),
    run('osascript', ['-l', 'JavaScript', '-e', CAPACITY_SCRIPT, '/'], { timeout: 8000 }).then((r) => (r.ok ? parseCapacity(r.stdout) : null)),
    hasFullDiskAccess(fsp, home),
  ]);
  facts.fullDiskAccess = fda;
  // The cheap calls are done: the breakdown starts its heavy du walks now, so
  // diskutil and friends never wait behind six du processes.
  if (ctx.onFacts) { try { ctx.onFacts(); } catch (_) {} }
  facts.snapshots = snaps;
  facts.purgeable = cap ? cap.purgeable : null;
  facts.swap = swap;

  const volumes = info && list && info.APFSContainerReference ? parseApfsVolumes(list, info.APFSContainerReference) : [];
  facts.volumes = volumes;
  for (const v of volumes) {
    const extra = VOLUME_COMMANDS[v.role] || {};
    let hint = VOLUME_HINTS[v.role];
    if (v.role === 'VM' && swap) hint += ' Swap in use now: ' + Math.round(swap.used / 1024 ** 2) + ' MB of ' + Math.round(swap.total / 1024 ** 2) + ' MB.';
    push(item({ key: 'vol-' + v.role.toLowerCase(), label: v.name, bytes: v.bytes, tier: 'D', group: 'os', hint, icon: 'cpu', ...extra }));
  }

  // 2. /private/var without the per-user folders (du -I folders), split into its parts.
  const base = userFoldersBase((await run('getconf', ['DARWIN_USER_CACHE_DIR'], { timeout: 4000 })).stdout);
  const pv = await measure('/private/var', { exclude: ['folders'], timeoutMs: 120000 });
  if (pv) {
    const child = (name) => pv.children.find((c) => path.basename(c.path) === name);
    const db = child('db');
    const vm = child('vm');
    const log = child('log');
    const rest = Math.max(0, pv.bytes - [db, vm, log].reduce((a, c) => a + (c ? c.bytes : 0), 0));
    if (db) push(item({ key: 'var-db', label: 'Unified logs and system databases', bytes: db.bytes, tier: 'D', group: 'area', paths: [db.path], confidence: pv.confidence, icon: 'log', hint: 'Diagnostics, log UUID tables and system databases under /private/var/db. Managed by macOS (logd rotates the logs itself).', command: 'log erase --all', commandNote: 'Needs an administrator. macOS trims these logs on its own; this is not usually worth doing.', children: topList(db ? pv.children.filter((c) => c === db) : []) }));
    if (vm) push(item({ key: 'sleepimage', label: 'Sleep image', bytes: vm.bytes, tier: 'D', group: 'os', paths: [vm.path], icon: 'moon', hint: 'The copy of memory macOS writes to disk before deep sleep.', command: 'pmset -g | grep hibernatemode', commandNote: 'Shows the hibernation mode. Changing it needs an administrator and affects what happens when the battery runs out.' }));
    if (log) push(item({ key: 'var-log', label: 'System logs', bytes: log.bytes, tier: 'D', group: 'area', paths: [log.path], icon: 'log', hint: 'Log files macOS services write to /private/var/log. Rotated by the system.', commandNote: 'newsyslog rotates these on a schedule; no action is needed.' }));
    if (rest > 0) push(item({ key: 'var-other', label: 'Other system data in /private/var', bytes: rest, tier: 'D', group: 'area', paths: ['/private/var'], confidence: pv.confidence, icon: 'database', hint: 'Installer receipts, network and service state, and other folders macOS keeps in /private/var.', commandNote: 'Managed by macOS services; there is no user command to clear it.', children: topList(pv.children.filter((c) => c !== db && c !== vm && c !== log)) }));
  }

  // 3. Your /var/folders: caches (C), temp (T) and code-sign clones (X).
  if (base) {
    const [c, t, zero] = await Promise.all([
      measure(base + '/C', { timeoutMs: 120000 }),
      measure(base + '/T', { timeoutMs: 120000 }),
      measure(base + '/0', { timeoutMs: 60000 }),
    ]);
    if (c) push(item({ key: 'user-cache-dir', label: 'App caches in the system temp area', bytes: c.bytes, tier: 'B', group: 'area', paths: [c.path], confidence: c.confidence, icon: 'broom', hint: 'Per-user caches macOS keeps outside your home folder (clang module cache, Metal shader and GPU caches). Apps rebuild them; clear only while the owning app is quit.', children: topList(c.children) }));
    if (t) push(item({ key: 'user-temp-dir', label: 'Your temporary files', bytes: t.bytes, tier: 'B', group: 'area', paths: [t.path], confidence: t.confidence, icon: 'trash', hint: 'Your $TMPDIR. Items older than a few days that no app has open are safe to remove; macOS also cleans it on restart.', children: topList(t.children) }));
    if (zero && zero.bytes > 0) push(item({ key: 'user-folders-other', label: 'Other per-user system data', bytes: zero.bytes, tier: 'D', group: 'area', paths: [zero.path], confidence: zero.confidence, icon: 'database', hint: 'Per-user state macOS keeps in /var/folders (the 0 folder).', commandNote: 'Managed by macOS; there is no user command to clear it.' }));
    const xItem = await measureClones(base + '/X', { fsp, measure, cloneSize });
    if (xItem) push(xItem);
  }

  // 4. Mobile assets and simulator runtimes.
  const [assets, runtimes] = await Promise.all([
    measure('/System/Library/AssetsV2', { timeoutMs: 180000 }),
    simRuntimes(run),
  ]);
  const rtBytes = runtimes.reduce((a, r) => a + r.bytes, 0);
  if (runtimes.length) {
    const children = runtimes.map((r) => ({
      name: r.platform + ' ' + r.version + (r.build ? ' (' + r.build + ')' : ''),
      path: r.path,
      bytes: r.bytes,
      lastUsedAt: r.lastUsedAt,
      command: 'xcrun simctl runtime delete ' + r.id,
    }));
    push(item({ key: 'sim-runtimes', label: 'Simulator runtimes', bytes: rtBytes, tier: 'B', group: 'area', icon: 'apple', paths: runtimes.map((r) => r.path).filter(Boolean), children, hint: 'iOS and other simulator system images, stored as disk images. Xcode downloads them again on demand (Xcode > Settings > Components).', command: 'xcrun simctl runtime delete --notUsedSinceDays 30', commandNote: 'Add --dry-run first to see what it would remove.' }));
  }
  if (assets) {
    // The runtime disk images live inside AssetsV2 (or /Library/Developer): count them once.
    const inAssets = runtimes.filter((r) => r.path.startsWith('/System/Library/AssetsV2/')).reduce((a, r) => a + r.bytes, 0);
    const rtFolder = assets.children.find((c) => /iOSSimulatorRuntime/.test(c.path));
    const carve = Math.max(inAssets, rtFolder && inAssets ? Math.min(rtFolder.bytes, inAssets) : 0);
    const bytes = Math.max(0, assets.bytes - carve);
    push(item({ key: 'mobile-assets', label: 'macOS downloadable assets', bytes, tier: 'D', group: 'area', paths: ['/System/Library/AssetsV2'], confidence: assets.confidence, icon: 'download', hint: 'Voices, dictionaries, Apple Intelligence models, fonts and other components macOS downloads and manages (mobileassetd).', commandNote: 'Remove a feature to free its assets: voices in Accessibility > Spoken Content, Apple Intelligence in its settings, dictation languages in Keyboard.', children: topList(assets.children.filter((c) => !(inAssets && /iOSSimulatorRuntime/.test(c.path)))) }));
  }

  // 5. /Library/Developer (Xcode components, simulator caches, Command Line Tools).
  const dev = await measure('/Library/Developer', { timeoutMs: 120000 });
  if (dev) {
    const inDev = runtimes.filter((r) => r.path.startsWith('/Library/Developer/')).reduce((a, r) => a + r.bytes, 0);
    push(item({ key: 'library-developer', label: 'Developer tools for all users', bytes: Math.max(0, dev.bytes - inDev), tier: 'B', group: 'area', paths: ['/Library/Developer'], confidence: dev.confidence, icon: 'code', hint: 'Command Line Tools, simulator caches and device support shared by every account. Simulator caches rebuild when a simulator boots; the Command Line Tools reinstall with xcode-select --install.', children: topList(dev.children) }));
  }

  // 6. Homebrew.
  const brew = await homebrew(run, measure, fsp);
  if (brew) push(brew);

  // 7. The rest of the Data volume outside home: /Library, /Users/Shared, /usr/local, /opt, /cores.
  const brewPrefix = brew && brew.paths ? brew.paths[0] : null;
  const [lib, shared, usrLocal, opt, cores] = await Promise.all([
    measure('/Library', { timeoutMs: 180000 }),
    measure('/Users/Shared', { timeoutMs: 60000 }),
    brewPrefix === '/usr/local' ? null : measure('/usr/local', { timeoutMs: 60000 }),
    measure('/opt', { timeoutMs: 180000, exclude: brewPrefix === '/opt/homebrew' ? ['homebrew'] : [] }),
    measure('/cores', { timeoutMs: 30000 }),
  ]);
  if (lib) {
    const devBytes = dev ? dev.bytes : 0;
    push(item({ key: 'library', label: 'Shared app support and settings (/Library)', bytes: Math.max(0, lib.bytes - devBytes), tier: 'C', group: 'area', paths: ['/Library'], confidence: lib.confidence, icon: 'database', hint: 'System-wide application support, fonts, audio plug-ins and printer drivers. Remove with the vendor\'s uninstaller.', children: topList(lib.children.filter((c) => c.path !== '/Library/Developer')) }));
  }
  if (shared && shared.bytes > 0) push(item({ key: 'users-shared', label: 'Shared folder', bytes: shared.bytes, tier: 'C', group: 'area', paths: ['/Users/Shared'], confidence: shared.confidence, icon: 'folder', hint: 'Files in /Users/Shared, visible to every account on this Mac.', children: topList(shared.children) }));
  if (usrLocal && usrLocal.bytes > 0) push(item({ key: 'usr-local', label: 'Locally installed software (/usr/local)', bytes: usrLocal.bytes, tier: 'C', group: 'area', paths: ['/usr/local'], confidence: usrLocal.confidence, icon: 'code', hint: 'Command-line tools installed outside the App Store.', children: topList(usrLocal.children) }));
  if (opt && opt.bytes > 0) push(item({ key: 'opt', label: 'Other software in /opt', bytes: opt.bytes, tier: 'C', group: 'area', paths: ['/opt'], confidence: opt.confidence, icon: 'code', hint: 'Tools installed into /opt by their own installers.', children: topList(opt.children) }));
  if (cores && cores.bytes > 0) push(item({ key: 'cores', label: 'Crash core dumps', bytes: cores.bytes, tier: 'A', group: 'area', paths: ['/cores'], confidence: cores.confidence, icon: 'warning', hint: 'Memory dumps written when a process crashed. Only needed to debug that crash.' }));

  // 8. What no walk can see: named, with counts, never a bare "System".
  const others = await otherUsers(fsp, home);
  if (!fda) {
    const prot = protectedPaths(home);
    push(item({ key: 'protected', label: 'Protected by macOS', bytes: null, tier: 'C', group: 'remainder', icon: 'lock', count: prot.length, hint: 'Mail, Messages, Safari, iPhone backups, the Trash and the Spotlight index can only be measured with Full Disk Access. Grant it to Spaci to measure them.', children: prot.map((p) => ({ name: p.label, path: p.path })), settings: FDA_SETTINGS_URL }));
  }
  if (others.length) push(item({ key: 'other-users', label: 'Other user accounts', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', count: others.length, hint: 'Home folders of ' + others.length + (others.length === 1 ? ' other account' : ' other accounts') + ' on this Mac (' + others.join(', ') + '). macOS does not let one account read another\'s files.', commandNote: 'Each account can check its own usage; an administrator manages accounts in System Settings > Users & Groups.' }));
  const snapHint = snaps && snaps.count
    ? snaps.count + (snaps.count === 1 ? ' local snapshot' : ' local snapshots') + (snaps.osUpdate ? ' (' + snaps.osUpdate + ' from a macOS update)' : '') + '. APFS does not report snapshot sizes. Blocks a snapshot still holds are not freed when you delete the file.'
    : 'APFS keeps its own metadata and, at times, local snapshots. Their size is not published.';
  push(item({ key: 'snapshots', label: 'Snapshots and APFS metadata', bytes: null, tier: 'D', group: 'remainder', icon: 'clock', count: snaps ? snaps.count : null, confidence: 'count-only', hint: snapHint, command: 'tmutil listlocalsnapshots /', commandNote: 'Lists them. Time Machine snapshots can be thinned with tmutil thinlocalsnapshots / <bytes> 4; macOS removes them itself when it needs the space.' }));
  push(item({ key: 'root-only', label: 'System folders only macOS can read', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', hint: 'Folders owned by the system (Spotlight index, file-system event logs, document versions) that no app without administrator rights can measure.', commandNote: 'Managed by macOS. sudo mdutil -E / rebuilds the Spotlight index if it is damaged (administrator).' }));
  if (cap && cap.purgeable) push(item({ key: 'purgeable', label: 'Purgeable (macOS can free this itself)', bytes: cap.purgeable, tier: 'D', group: 'info', additive: false, confidence: 'estimate', icon: 'refresh', hint: 'Part of the used space macOS treats as available: caches and snapshots it removes automatically when an app needs room. Already counted above.', commandNote: 'macOS frees it on its own when space runs low; nothing to run.' }));

  return { items, facts };
}

async function hasFullDiskAccess(fsp, home) {
  for (const p of [path.join(home, 'Library', 'Safari'), path.join(home, 'Library', 'Mail')]) {
    try { await fsp.readdir(p); return true; } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return false;
    }
  }
  return null; // neither folder exists: unknown
}

async function otherUsers(fsp, home) {
  try {
    const names = await fsp.readdir('/Users');
    const me = path.basename(home);
    return names.filter((n) => n !== me && n !== 'Shared' && n !== 'Guest' && !n.startsWith('.'));
  } catch { return []; }
}

async function simRuntimes(run) {
  // Only when a full Xcode is selected: on a Mac without developer tools,
  // /usr/bin/xcrun would pop the "install command line tools" dialog.
  const sel = await run('xcode-select', ['-p'], { timeout: 4000 });
  const dir = sel.ok ? sel.stdout.trim() : '';
  if (!dir || !/\.app\/Contents\/Developer$/.test(dir)) return [];
  const r = await run('xcrun', ['simctl', 'runtime', 'list', '-j'], { timeout: 15000 });
  return r.ok ? parseSimRuntimes(r.stdout) : [];
}

async function homebrew(run, measure, fsp) {
  let prefix = null;
  let brewBin = null;
  for (const [p, b] of [['/opt/homebrew', '/opt/homebrew/bin/brew'], ['/usr/local', '/usr/local/bin/brew']]) {
    try { await fsp.access(b); prefix = p; brewBin = b; break; } catch (_) { /* next */ }
  }
  if (!prefix) return null;
  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
  const [size, dry] = await Promise.all([
    measure(prefix, { timeoutMs: 240000 }),
    run(brewBin, ['cleanup', '-n'], { timeout: 30000, env }),
  ]);
  if (!size) return null;
  const freeable = dry.ok ? parseBrewCleanup(dry.stdout) : null;
  return item({
    key: 'homebrew', label: 'Homebrew', bytes: size.bytes, tier: 'C', group: 'area', paths: [prefix], confidence: size.confidence, icon: 'box',
    hint: 'Formulae and casks you installed with Homebrew. Old versions and leftovers can go with brew cleanup; the packages themselves only with brew uninstall.' + (freeable != null ? ' brew cleanup would free about ' + Math.round(freeable / 1024 ** 2) + ' MB now.' : ''),
    freeableAtLeast: freeable == null ? undefined : freeable,
    command: 'brew cleanup --prune=all', commandNote: 'Removes old versions and the download cache. Run brew cleanup -n first to preview.',
    children: topList(size.children),
  });
}

/**
 * The code-sign clone folder (/var/folders/…/X). du counts every clone in full
 * (38 GB here) though they share nearly all blocks with the app they copy.
 * The clone-aware helper counts each clone family once, and does not count
 * blocks the app bundle in /Applications already holds.
 */
async function measureClones(dir, { fsp, measure, cloneSize }) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  if (!entries.length) return null;
  // The apps being cloned: …/X/<bundle id>.code_sign_clone/<clone dir>/<Name>.app
  const appNames = new Set();
  for (const e of entries) {
    let clones = [];
    try { clones = await fsp.readdir(path.join(dir, e)); } catch { continue; }
    for (const c of clones.slice(0, 3)) {
      try { for (const n of cloneAppNames(await fsp.readdir(path.join(dir, e, c)))) appNames.add(n); } catch (_) { /* skip */ }
    }
  }
  const seed = [];
  for (const n of appNames) {
    for (const root of ['/Applications', path.join(require('os').homedir(), 'Applications')]) {
      const p = path.join(root, n);
      try { await fsp.access(p); seed.push(p); break; } catch (_) { /* next */ }
    }
  }
  const [cs, du] = await Promise.all([
    cloneSize ? cloneSize({ measure: [dir], seed, budgetSec: 90 }).catch(() => null) : null,
    measure(dir, { timeoutMs: 120000 }),
  ]);
  const r = cs && cs[0] && !cs[0].missing ? cs[0] : null;
  const base = {
    key: 'code-sign-clones', label: 'App code-signing clones', tier: 'B', group: 'area', paths: [dir], icon: 'copy',
    children: du ? topList(du.children) : undefined,
  };
  if (!r) {
    return item({ ...base, bytes: du ? du.bytes : 0, confidence: 'upper-bound', duBytes: du ? du.bytes : undefined, hint: 'Copies of apps (Chrome and apps built on it) that macOS uses to verify their code signature. They share most of their blocks with the app, so deleting them frees far less than this number, which is an upper bound.' });
  }
  return item({
    ...base,
    bytes: r.footprint,
    confidence: r.partial ? 'partial' : 'exact',
    duBytes: r.allocated,
    freeableAtLeast: r.private,
    hint: 'Copies of apps (Chrome and apps built on it) that macOS uses to verify their code signature. Other tools report ' + gb(r.allocated) + ' here, counting every copy in full; they share their blocks, so they really take ' + gb(r.footprint) + ' beyond the apps themselves, and deleting them now frees at least ' + gb(r.private) + '. The app recreates its clone when it next starts, so clean only while it is quit.',
  });
}

function gb(n) { const g = n / 1024 ** 3; if (g < 1) return Math.max(1, Math.round(n / 1024 ** 2)) + ' MB'; return (g >= 10 ? g.toFixed(0) : g.toFixed(1)) + ' GB'; }

/** Top children for a drill-down, compact enough to keep in cache.json. */
function topList(children, limit = 12) {
  return (children || []).filter((c) => c && c.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, limit)
    .map((c) => ({ name: path.basename(c.path), path: c.path, bytes: c.bytes }));
}

module.exports = {
  collect,
  parseApfsVolumes,
  parseSwapUsage,
  parseSnapshots,
  parseCapacity,
  parseSimRuntimes,
  parseBrewCleanup,
  userFoldersBase,
  cloneAppNames,
  protectedPaths,
  topList,
  FDA_SETTINGS_URL,
  CAPACITY_SCRIPT,
};
