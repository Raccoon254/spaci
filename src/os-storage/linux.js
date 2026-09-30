'use strict';
// Linux (Ubuntu/Debian, Fedora, Arch): used space outside the home folder and
// the parts no user can read. os-storage-spec.md section 4. No root needed;
// anything root-only becomes a named part of the remainder with the
// distribution's own command, which Spaci shows and never runs.

const path = require('path');
const { item } = require('./tiers');
const { json } = require('./exec');

// ---------- parsers (pure, fixture tested) ----------

const UNITS = { B: 1, K: 1024, KB: 1024, KIB: 1024, M: 1024 ** 2, MB: 1024 ** 2, MIB: 1024 ** 2, G: 1024 ** 3, GB: 1024 ** 3, GIB: 1024 ** 3, T: 1024 ** 4, TB: 1024 ** 4, TIB: 1024 ** 4 };
/** "1.5GB", "56.0M", "12.3 kB", "0B" -> bytes (null when unparsable). */
function parseSize(text) {
  const m = /([\d.]+)\s*([KMGT]?i?B?)\b/i.exec(String(text || '').trim());
  if (!m) return null;
  const u = (m[2] || 'B').toUpperCase();
  const mult = UNITS[u] || UNITS[u.replace(/B$/, '')] || 1;
  return Math.round(Number(m[1]) * mult);
}

/** `journalctl --disk-usage`: "Archived and active journals take up 56.0M in the file system." */
function parseJournalUsage(text) {
  const m = /take up ([\d.]+\s*[KMGT]?i?B?) /i.exec(String(text || ''));
  return m ? parseSize(m[1]) : null;
}

/** `docker system df --format '{{json .}}'`: one JSON object per line (Images, Containers, Local Volumes, Build Cache). */
function parseDockerDf(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const v = json(line.trim());
    if (!v || !v.Type) continue;
    const reclaim = /^([\d.]+\s*[KMGT]?i?B)/i.exec(String(v.Reclaimable || ''));
    rows.push({ type: String(v.Type), count: Number(v.TotalCount) || 0, bytes: parseSize(v.Size) || 0, reclaimable: reclaim ? parseSize(reclaim[1]) : 0 });
  }
  return rows;
}

/** `snap list --all`: disabled rows are old revisions snapd keeps (refresh.retain). */
function parseSnapList(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length || !/^Name\s+Version\s+Rev/.test(lines[0])) return [];
  return lines.slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    return { name: c[0], version: c[1], rev: c[2], disabled: /\bdisabled\b/.test(c.slice(5).join(' ')) };
  }).filter((s) => s.name && s.rev);
}

/** `flatpak list --columns=application,size`: "org.gnome.Platform\t1.2 GB". */
function parseFlatpakList(text) {
  return String(text || '').split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 2 && c[0].trim())
    .map((c) => ({ app: c[0].trim(), bytes: parseSize(c[1]) || 0 }));
}

/** /proc/swaps -> swap files (partitions are not on this filesystem). */
function parseProcSwaps(text) {
  return String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4 && c[1] === 'file')
    .map((c) => ({ path: c[0].replace(/\\040/g, ' '), bytes: Number(c[2]) * 1024, used: Number(c[3]) * 1024 }));
}

/** /proc/mounts -> the filesystem type of `/`. */
function rootFsType(text) {
  for (const l of String(text || '').split('\n')) {
    const c = l.split(/\s+/);
    if (c[1] === '/') return c[2];
  }
  return null;
}

/** statfs: ext4 keeps bfree - bavail for root (5% by default). Not in `used`. */
function reservedBytes(s) {
  if (!s) return 0;
  return Math.max(0, (Number(s.bfree) - Number(s.bavail)) * Number(s.bsize)) || 0;
}

// ---------- collection ----------

const PKG_CACHES = [
  { key: 'apt-cache', dir: '/var/cache/apt/archives', label: 'apt package downloads', command: 'sudo apt-get clean', note: 'Removes downloaded .deb files. apt-get autoclean keeps the ones still installable.' },
  { key: 'dnf-cache', dir: '/var/cache/dnf', label: 'dnf package cache', command: 'sudo dnf clean all', note: 'Removes cached packages and metadata.' },
  { key: 'dnf5-cache', dir: '/var/cache/libdnf5', label: 'dnf5 package cache', command: 'sudo dnf clean all', note: 'Removes cached packages and metadata.' },
  { key: 'pacman-cache', dir: '/var/cache/pacman/pkg', label: 'pacman package cache', command: 'paccache -rk1', note: 'Keeps the latest version of each package (pacman-contrib). paccache -ruk0 also drops uninstalled ones.' },
];

async function collect(ctx) {
  const { home, run, measure, fs: fsp, statfs, categoryDirs = [] } = ctx;
  const items = [];
  const facts = { platform: 'linux' };
  const push = (it) => { if (it) { items.push(it); if (ctx.onItem) { try { ctx.onItem(it); } catch (_) {} } } return it; };
  const read = (p) => fsp.readFile(p, 'utf8').catch(() => '');

  // 1. Cheap facts.
  const [mounts, swaps, journal, st] = await Promise.all([
    read('/proc/mounts'),
    read('/proc/swaps'),
    run('journalctl', ['--disk-usage'], { timeout: 8000 }),
    statfs ? statfs('/').catch(() => null) : null,
  ]);
  const fsType = rootFsType(mounts);
  facts.fsType = fsType;
  facts.reserved = fsType && /^ext[234]$/.test(fsType) ? reservedBytes(st) : 0;
  if (ctx.onFacts) { try { ctx.onFacts(); } catch (_) {} }

  for (const s of parseProcSwaps(swaps)) {
    push(item({ key: 'swapfile:' + s.path, label: 'Swap file', bytes: s.bytes, tier: 'D', group: 'os', paths: [s.path], icon: 'cpu', hint: s.path + ', memory the kernel pages out to disk. ' + Math.round(s.used / 1024 ** 2) + ' MB in use now.', command: 'swapon --show', commandNote: 'Resizing or removing a swap file needs root.' }));
  }
  if (facts.reserved > 0) {
    push(item({ key: 'ext4-reserved', label: 'Reserved for root (ext4)', bytes: facts.reserved, tier: 'D', group: 'info', additive: false, icon: 'lock', hint: 'Blocks ext4 keeps free for the root user (5% by default). They are not part of used space, but you cannot use them either.', command: 'sudo tune2fs -l $(findmnt -no SOURCE /) | grep -i "reserved block"', commandNote: 'Shows the reserve. tune2fs -m changes it (root).' }));
  }

  // 2. OS software and logs.
  const [usr, boot, varLog, varCache, varLib, usrLocal] = await Promise.all([
    measure('/usr', { timeoutMs: 180000, exclude: ['local'] }),
    measure('/boot', { timeoutMs: 60000 }),
    measure('/var/log', { timeoutMs: 60000 }),
    measure('/var/cache', { timeoutMs: 120000 }),
    measure('/var/lib', { timeoutMs: 180000 }),
    measure('/usr/local', { timeoutMs: 60000 }),
  ]);
  if (usr) push(item({ key: 'usr', label: 'Installed system software (/usr)', bytes: usr.bytes, tier: 'D', group: 'area', paths: ['/usr'], confidence: usr.confidence, icon: 'cpu', hint: 'Programs and libraries installed by your package manager.', command: 'sudo apt autoremove --purge', commandNote: 'Debian and Ubuntu. Fedora: sudo dnf autoremove. Arch: sudo pacman -Rns $(pacman -Qdtq).', children: topList(usr.children) }));
  if (boot && boot.bytes > 0) push(item({ key: 'boot', label: 'Kernels and boot files', bytes: boot.bytes, tier: 'D', group: 'area', paths: ['/boot'], confidence: boot.confidence, icon: 'cpu', hint: 'Installed kernels and initramfs images. Old kernels are removed by the package manager.', command: 'sudo apt autoremove --purge', commandNote: 'Fedora keeps installonly_limit kernels (dnf.conf).' }));
  const journalBytes = journal.ok ? parseJournalUsage(journal.stdout) : null;
  if (varLog) {
    const jDir = varLog.children.find((c) => path.basename(c.path) === 'journal');
    const jBytes = journalBytes != null ? journalBytes : (jDir ? jDir.bytes : 0);
    if (jBytes > 0) push(item({ key: 'journald', label: 'systemd journal', bytes: jBytes, tier: 'D', group: 'area', paths: ['/var/log/journal'], confidence: journalBytes != null ? 'exact' : varLog.confidence, icon: 'log', hint: 'System logs kept by journald. SystemMaxUse= in journald.conf caps them.', command: 'sudo journalctl --vacuum-size=500M', commandNote: 'Or --vacuum-time=2weeks.' }));
    const rest = Math.max(0, varLog.bytes - (jDir ? jDir.bytes : 0));
    if (rest > 0) push(item({ key: 'var-log', label: 'Text logs (/var/log)', bytes: rest, tier: 'D', group: 'area', paths: ['/var/log'], confidence: varLog.confidence, icon: 'log', hint: 'Log files rotated by logrotate.', command: 'sudo logrotate -f /etc/logrotate.conf', children: topList(varLog.children.filter((c) => c !== jDir)) }));
  } else if (journalBytes) {
    push(item({ key: 'journald', label: 'systemd journal', bytes: journalBytes, tier: 'D', group: 'area', paths: ['/var/log/journal'], icon: 'log', hint: 'System logs kept by journald.', command: 'sudo journalctl --vacuum-size=500M' }));
  }

  // 3. Package caches (inside /var/cache).
  let cacheCarved = 0;
  if (varCache) {
    for (const pc of PKG_CACHES) {
      const hit = await measure(pc.dir, { timeoutMs: 60000 });
      if (!hit || !(hit.bytes > 0)) continue;
      cacheCarved += hit.bytes;
      push(item({ key: pc.key, label: pc.label, bytes: hit.bytes, tier: 'D', group: 'area', paths: [pc.dir], confidence: hit.confidence, icon: 'download', hint: 'Packages the package manager downloaded. It fetches them again when needed.', command: pc.command, commandNote: pc.note }));
    }
    const rest = Math.max(0, varCache.bytes - cacheCarved);
    if (rest > 0) push(item({ key: 'var-cache', label: 'Other system caches (/var/cache)', bytes: rest, tier: 'D', group: 'area', paths: ['/var/cache'], confidence: varCache.confidence, icon: 'broom', hint: 'Caches system services keep (fonts, man pages, package metadata).', commandNote: 'Managed by the services that write them.', children: topList(varCache.children) }));
  }

  // 4. Snaps: the .snap files are the real cost (the /snap mounts are squashfs views of them).
  const snapList = await run('snap', ['list', '--all'], { timeout: 10000 });
  const snaps = snapList.ok ? parseSnapList(snapList.stdout) : [];
  if (snaps.length) {
    let active = 0; let disabled = 0; const disabledRows = [];
    for (const s of snaps) {
      const f = `/var/lib/snapd/snaps/${s.name}_${s.rev}.snap`;
      let bytes = 0;
      try { const stt = await fsp.lstat(f); bytes = stt.blocks ? stt.blocks * 512 : stt.size; } catch (_) { continue; }
      if (s.disabled) { disabled += bytes; disabledRows.push({ name: s.name + ' revision ' + s.rev, path: f, bytes, command: `sudo snap remove ${s.name} --revision=${s.rev}` }); } else active += bytes;
    }
    if (active > 0) push(item({ key: 'snaps', label: 'Snap packages', bytes: active, tier: 'C', group: 'area', paths: ['/var/lib/snapd/snaps'], icon: 'box', hint: snaps.filter((s) => !s.disabled).length + ' installed snaps. Remove one with snap remove <name>.' }));
    if (disabled > 0) push(item({ key: 'snap-revisions', label: 'Old snap revisions', bytes: disabled, tier: 'D', group: 'area', paths: ['/var/lib/snapd/snaps'], icon: 'box', children: disabledRows, hint: disabledRows.length + ' disabled revisions snapd keeps so it can roll back.', command: 'sudo snap set system refresh.retain=2', commandNote: 'Keeps 2 revisions from the next refresh on. Remove one now with the command on each row.' }));
  }

  // 5. Flatpak (counted in Applications) and Docker.
  const flat = await run('flatpak', ['list', '--columns=application,size'], { timeout: 15000 });
  const flats = flat.ok ? parseFlatpakList(flat.stdout) : [];
  if (flats.length) {
    push(item({ key: 'flatpak', label: 'Flatpak apps and runtimes', bytes: flats.reduce((a, f) => a + f.bytes, 0), tier: 'B', group: 'info', additive: false, icon: 'box', paths: ['/var/lib/flatpak', path.join(home, '.local', 'share', 'flatpak')], children: flats.sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((f) => ({ name: f.app, bytes: f.bytes })), hint: 'Already counted under Applications and App Data. Runtimes no app uses any more can go.', command: 'flatpak uninstall --unused' }));
  }
  const ddf = await run('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 15000 });
  const drows = ddf.ok ? parseDockerDf(ddf.stdout) : [];
  const dockerBytes = drows.reduce((a, r) => a + r.bytes, 0);
  if (dockerBytes > 0) {
    push(item({ key: 'docker', label: 'Docker (/var/lib/docker)', bytes: dockerBytes, tier: 'B', group: 'area', paths: ['/var/lib/docker'], icon: 'box', freeableAtLeast: drows.reduce((a, r) => a + r.reclaimable, 0), children: drows.map((r) => ({ name: r.type + ' (' + r.count + ')', bytes: r.bytes, reclaimable: r.reclaimable })), hint: 'Images, containers, volumes and build cache, as docker system df reports them.', command: 'docker system prune', commandNote: 'Add --volumes only if no volume holds data you need. docker builder prune clears the build cache.' }));
  }

  // 6. /var/lib: mostly root-only. What du could read, minus Docker and snaps counted above.
  if (varLib) {
    const known = (dockerBytes > 0 ? dockerBytes : 0);
    // Snaps are listed above; /var/lib/flatpak is counted in Applications.
    const skip = (c) => c.path === '/var/lib/snapd' || categoryDirs.includes(c.path);
    const rest = Math.max(0, varLib.bytes - varLib.children.filter(skip).reduce((a, c) => a + c.bytes, 0));
    if (rest > 0) push(item({ key: 'var-lib', label: 'System service data (/var/lib)', bytes: rest, tier: 'D', group: 'area', paths: ['/var/lib'], confidence: varLib.confidence, icon: 'database', hint: 'Databases and state of system services.' + (varLib.denied ? ' ' + varLib.denied + ' folders need root to measure.' : '') + (known ? ' Docker is listed separately.' : ''), commandNote: 'Owned by system services; remove a service with the package manager to free its data.', children: topList(varLib.children) }));
  }
  if (usrLocal && usrLocal.bytes > 0 && !categoryDirs.includes('/usr/local')) push(item({ key: 'usr-local', label: 'Locally installed software (/usr/local)', bytes: usrLocal.bytes, tier: 'C', group: 'area', paths: ['/usr/local'], confidence: usrLocal.confidence, icon: 'code', hint: 'Software installed outside the package manager.', children: topList(usrLocal.children) }));

  // 7. Named remainder.
  if (fsType === 'btrfs') push(item({ key: 'btrfs-snapshots', label: 'btrfs snapshots and shared extents', bytes: null, tier: 'D', group: 'remainder', icon: 'clock', hint: 'On btrfs, snapshots (Timeshift, Snapper) and reflinked files share blocks; their exclusive size needs root.', command: 'sudo btrfs subvolume list /', commandNote: 'sudo btrfs filesystem du -s <path> shows shared and exclusive sizes.' }));
  const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
  if (await exists('/timeshift') || await exists('/run/timeshift')) push(item({ key: 'timeshift', label: 'Timeshift snapshots', bytes: null, tier: 'D', group: 'remainder', icon: 'clock', hint: 'System snapshots Timeshift keeps. Only root can measure them.', command: 'sudo timeshift --list', commandNote: 'sudo timeshift --delete --snapshot \'<name>\' removes one.' }));
  if (await exists('/.snapshots')) push(item({ key: 'snapper', label: 'Snapper snapshots', bytes: null, tier: 'D', group: 'remainder', icon: 'clock', hint: 'Snapshots managed by Snapper.', command: 'sudo snapper list' }));
  const others = await otherHomes(fsp, home);
  if (others.length) push(item({ key: 'other-users', label: 'Other user accounts', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', count: others.length, hint: 'Home folders of ' + others.join(', ') + '. Other users\' files are not readable.', commandNote: 'Each user can check their own usage; root can run sudo du -sh /home/*.' }));
  push(item({ key: 'root-only', label: 'Root-only system folders', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', hint: 'Folders only root can read (/root, parts of /var/lib, /var/spool, container storage) and filesystem metadata.', commandNote: 'sudo du -xh -d 1 / | sort -h shows them (root).' }));

  return { items, facts };
}

async function otherHomes(fsp, home) {
  try {
    const parent = path.dirname(home);
    if (parent !== '/home') return [];
    const names = await fsp.readdir(parent);
    return names.filter((n) => n !== path.basename(home) && !n.startsWith('.') && n !== 'lost+found');
  } catch { return []; }
}

function topList(children, limit = 12) {
  return (children || []).filter((c) => c && c.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, limit)
    .map((c) => ({ name: path.basename(c.path), path: c.path, bytes: c.bytes }));
}

module.exports = { collect, parseSize, parseJournalUsage, parseDockerDf, parseSnapList, parseFlatpakList, parseProcSwaps, rootFsType, reservedBytes };
