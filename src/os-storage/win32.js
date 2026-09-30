'use strict';
// Windows 10/11: used space outside the user profile, without admin rights.
// os-storage-spec.md section 3. One PowerShell run reads the facts Node
// cannot: the sizes of C:\pagefile.sys, hiberfil.sys and swapfile.sys come
// from the directory listing (Node's fs.stat throws EBUSY on them), the page
// file from Win32_PageFileUsage, WSL distributions from the registry, and the
// allocated size of virtual disks from GetCompressedFileSizeW. Everything else
// is a bounded folder walk. Tier D items show Windows' own command; Spaci
// never runs it.

const path = require('path').win32;
const { item } = require('./tiers');
const { json } = require('./exec');

const FACTS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$d = $env:SystemDrive + '\'
$o = [ordered]@{}
$o.drive = $env:SystemDrive
$o.root = @(Get-ChildItem -LiteralPath $d -Force -File | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Length = $_.Length } })
$o.dirs = @(Get-ChildItem -LiteralPath $d -Force -Directory | ForEach-Object { $_.Name })
$o.pagefile = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ Name = $_.Name; AllocatedBaseSize = $_.AllocatedBaseSize; CurrentUsage = $_.CurrentUsage } })
$o.sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$o.lxss = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; [pscustomobject]@{ Name = $p.DistributionName; BasePath = $p.BasePath; VhdFileName = $p.VhdFileName } })
Add-Type -Namespace SpaciNative -Name Disk -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);'
$vhd = @()
foreach ($l in $o.lxss) { if ($l.BasePath) { $f = $l.VhdFileName; if (-not $f) { $f = 'ext4.vhdx' }; $vhd += [pscustomobject]@{ Kind = 'wsl'; Name = $l.Name; Path = (Join-Path ($l.BasePath -replace '^\\\\\?\\', '') $f) } } }
foreach ($p in @("$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx", "$env:LOCALAPPDATA\Docker\wsl\data\ext4.vhdx", "$env:LOCALAPPDATA\Docker\wsl\distro\ext4.vhdx")) { $vhd += [pscustomobject]@{ Kind = 'docker'; Name = 'Docker Desktop'; Path = $p } }
$o.vhdx = @(foreach ($v in $vhd) { $i = Get-Item -LiteralPath $v.Path -Force; if ($i) { $hi = [uint32]0; $lo = [SpaciNative.Disk]::GetCompressedFileSizeW($v.Path, [ref]$hi); $alloc = $null; if ($lo -ne [uint32]::MaxValue) { $alloc = [double]$hi * 4294967296 + $lo }; [pscustomobject]@{ Kind = $v.Kind; Name = $v.Name; Path = $v.Path; Length = $i.Length; Allocated = $alloc } } })
$o | ConvertTo-Json -Depth 4 -Compress
`;

// ---------- parsers (pure, fixture tested) ----------

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** The FACTS_SCRIPT JSON -> normalised facts. */
function parseFacts(text) {
  const v = json(text);
  if (!v || typeof v !== 'object') return null;
  const drive = typeof v.drive === 'string' && /^[A-Za-z]:$/.test(v.drive) ? v.drive : 'C:';
  const root = {};
  for (const f of asArray(v.root)) if (f && f.Name) root[String(f.Name).toLowerCase()] = Number(f.Length) || 0;
  const pagefiles = asArray(v.pagefile).filter((p) => p && p.Name).map((p) => ({ path: String(p.Name), bytes: (Number(p.AllocatedBaseSize) || 0) * 1024 * 1024, usedBytes: (Number(p.CurrentUsage) || 0) * 1024 * 1024 }));
  const vhdx = asArray(v.vhdx).filter((x) => x && x.Path).map((x) => ({
    kind: x.Kind === 'docker' ? 'docker' : 'wsl',
    name: String(x.Name || ''),
    path: String(x.Path),
    length: Number(x.Length) || 0,
    allocated: x.Allocated == null ? null : Number(x.Allocated),
  }));
  return {
    drive,
    root,
    dirs: asArray(v.dirs).map(String),
    pagefiles,
    sid: typeof v.sid === 'string' && /^S-1-[\d-]+$/.test(v.sid) ? v.sid : null,
    distros: asArray(v.lxss).filter((l) => l && l.Name).map((l) => ({ name: String(l.Name), basePath: String(l.BasePath || '') })),
    vhdx,
  };
}

// ---------- collection ----------

const ROOT_FILES = [
  { file: 'pagefile.sys', key: 'pagefile', label: 'Page file', hint: 'Virtual memory Windows pages out to disk.', command: 'SystemPropertiesPerformance.exe', note: 'Advanced > Virtual memory > Change. Windows sizes it automatically by default.' },
  { file: 'hiberfil.sys', key: 'hiberfil', label: 'Hibernation file', hint: 'The copy of memory Windows writes for hibernate and Fast Startup.', command: 'powercfg /h /type reduced', note: 'Needs an administrator. powercfg /h off turns hibernation and Fast Startup off completely.' },
  { file: 'swapfile.sys', key: 'swapfile', label: 'Swap file (apps)', hint: 'Used by Windows to suspend Store apps.', command: null, note: 'Managed with the page file.' },
  { file: 'dumpstack.log.tmp', key: 'dumpstack', label: 'Crash dump log', hint: 'Written during boot for crash dumps.', command: null, note: 'Recreated at every boot; Windows manages it.' },
];

async function collect(ctx) {
  const { home, run, measure, fs: fsp, env = process.env, categoryDirs = [] } = ctx;
  const items = [];
  const facts = { platform: 'win32' };
  const push = (it) => { if (it) { items.push(it); if (ctx.onItem) { try { ctx.onItem(it); } catch (_) {} } } return it; };

  const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FACTS_SCRIPT], { timeout: 45000 });
  const f = (ps.ok || ps.stdout) ? parseFacts(ps.stdout) : null;
  facts.powershell = Boolean(f);
  if (ctx.onFacts) { try { ctx.onFacts(); } catch (_) {} }
  const drive = (f && f.drive) || (env.SystemDrive || 'C:');
  const d = (...p) => path.join(drive + '\\', ...p);
  const win = env.SystemRoot || env.windir || d('Windows');

  // 1. System files in the drive root.
  if (f) {
    for (const rf of ROOT_FILES) {
      let bytes = f.root[rf.file];
      if (rf.key === 'pagefile') {
        const pf = f.pagefiles.find((p) => /pagefile\.sys$/i.test(p.path) && p.path.toLowerCase().startsWith(drive.toLowerCase()));
        if (!bytes && pf) bytes = pf.bytes;
      }
      if (!bytes) continue;
      push(item({ key: rf.key, label: rf.label, bytes, tier: 'D', group: 'os', paths: [d(rf.file)], icon: 'cpu', hint: rf.hint, command: rf.command || undefined, commandNote: rf.note || undefined }));
    }
  }

  // 2. Folders Windows manages.
  const inCategory = (p) => categoryDirs.some((c) => c && (p.toLowerCase() === c.toLowerCase() || p.toLowerCase().startsWith(c.toLowerCase().replace(/\\?$/, '\\'))));
  const dirs = f ? new Set(f.dirs.map((x) => x.toLowerCase())) : null;
  const has = (name) => !dirs || dirs.has(name.toLowerCase());
  const walks = [
    has('Windows.old') && { key: 'windows-old', dir: d('Windows.old'), label: 'Previous Windows installation', tier: 'D', icon: 'undo', hint: 'Kept after a Windows upgrade so you can go back. Windows deletes it after 10 days.', command: 'start ms-settings:storagerecommendations', note: 'Settings > System > Storage > Cleanup recommendations > Previous Windows installation(s).' },
    has('$Windows.~BT') && { key: 'windows-bt', dir: d('$Windows.~BT'), label: 'Windows upgrade files', tier: 'D', icon: 'download', hint: 'Setup files from a Windows upgrade.', command: 'start ms-settings:storagesense', note: 'Storage Sense and Cleanup recommendations remove them.' },
    has('$Windows.~WS') && { key: 'windows-ws', dir: d('$Windows.~WS'), label: 'Windows setup files', tier: 'D', icon: 'download', hint: 'Media left by the Windows setup tool.', command: 'start ms-settings:storagesense', note: 'Storage Sense removes them.' },
    { key: 'windows-update', dir: path.join(win, 'SoftwareDistribution', 'Download'), label: 'Windows Update downloads', tier: 'D', icon: 'download', hint: 'Updates Windows downloaded to install.', command: 'cleanmgr /d ' + drive, note: 'Disk Cleanup > Clean up system files > Windows Update Cleanup. Storage Sense also clears it.' },
    { key: 'windows-installer', dir: path.join(win, 'Installer'), label: 'Windows Installer cache', tier: 'D', icon: 'lock', hint: 'Needed to repair and uninstall programs. Never delete it by hand.', command: null, note: 'Uninstall programs from Settings > Apps; that is the only safe way to shrink it.' },
    f && f.sid && has('$Recycle.Bin') && { key: 'recycle-bin', dir: d('$Recycle.Bin', f.sid), label: 'Recycle Bin', tier: 'C', icon: 'trash', hint: 'Files you deleted. Emptying it removes them for good.', command: 'Clear-RecycleBin -DriveLetter ' + drive.replace(':', ''), note: 'PowerShell. Or right-click the Recycle Bin > Empty Recycle Bin.' },
    { key: 'delivery-optimization', dir: path.join(win, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'), label: 'Delivery Optimization cache', tier: 'D', icon: 'download', hint: 'Update pieces Windows shares with other PCs.', command: 'Delete-DeliveryOptimizationCache -Force', note: 'PowerShell as administrator. Storage Sense also clears it.', remainderIfDenied: true },
    has('ProgramData') && { key: 'programdata', dir: d('ProgramData'), label: 'Shared app data (ProgramData)', tier: 'C', icon: 'database', hint: 'Data programs keep for every user: package caches, licences, service state. Remove with the program\'s uninstaller.', command: null, note: null },
  ].filter(Boolean).filter((w) => !inCategory(w.dir));
  const measured = await Promise.all(walks.map((w) => measure(w.dir, { timeoutMs: 90000 }).catch(() => null)));
  walks.forEach((w, i) => {
    const m = measured[i];
    if (!m) return;
    if (m.confidence === 'denied' && !(m.bytes > 0)) {
      if (w.remainderIfDenied) push(item({ key: w.key, label: w.label, bytes: null, tier: w.tier, group: 'remainder', icon: 'lock', hint: w.hint + ' Only an administrator can measure it.', command: w.command || undefined, commandNote: w.note || undefined }));
      return;
    }
    if (!(m.bytes > 0)) return;
    push(item({ key: w.key, label: w.label, bytes: m.bytes, tier: w.tier, group: 'area', paths: [w.dir], confidence: m.confidence, icon: w.icon, hint: w.hint, command: w.command || undefined, commandNote: w.note || undefined, children: topList(m.children) }));
  });

  // 3. Virtual disks: WSL distributions and Docker Desktop. They grow and do not shrink by themselves.
  for (const v of (f && f.vhdx) || []) {
    const bytes = v.allocated != null ? v.allocated : v.length;
    const counted = inCategory(v.path);
    const wsl = v.kind === 'wsl';
    push(item({
      key: 'vhdx:' + v.path, label: wsl ? 'WSL: ' + v.name : 'Docker Desktop disk', bytes, tier: wsl ? 'C' : 'B', group: counted ? 'info' : 'area', additive: !counted, paths: [v.path], icon: wsl ? 'code' : 'box',
      duBytes: v.length,
      hint: (wsl ? 'The Linux distribution\'s virtual disk. It grows as the distribution uses space and does not shrink when files inside are deleted.' : 'Images, containers and volumes live in this virtual disk. Pruning inside Docker frees space in the disk, not on C: until it is compacted.') + (counted ? ' Already counted under App Data.' : '') + (v.length > bytes ? ' Allocated on disk: ' + Math.round(bytes / 1024 ** 3) + ' GB of ' + Math.round(v.length / 1024 ** 3) + ' GB.' : ''),
      command: wsl ? 'wsl --manage ' + v.name + ' --set-sparse true' : 'docker system prune',
      commandNote: wsl ? 'Lets the disk give space back automatically (WSL 2.0+). Or, with Hyper-V: wsl --shutdown, then Optimize-VHD -Path "' + v.path + '" -Mode Full as administrator.' : 'Then wsl --shutdown and compact the disk: Optimize-VHD -Path "' + v.path + '" -Mode Full (Hyper-V, administrator), or diskpart > select vdisk file="' + v.path + '" > compact vdisk.',
    }));
  }

  // 4. Named remainder: what a standard account cannot measure.
  push(item({ key: 'winsxs', label: 'Windows component store (WinSxS)', bytes: null, tier: 'D', group: 'remainder', icon: 'cpu', paths: [path.join(win, 'WinSxS')], hint: 'Components Windows needs to update and repair itself. Explorer overstates it because most files are hard-linked into System32; only DISM reports the real size.', command: 'Dism /Online /Cleanup-Image /AnalyzeComponentStore', commandNote: 'Administrator. Dism /Online /Cleanup-Image /StartComponentCleanup removes superseded components.' }));
  push(item({ key: 'windows-files', label: 'Windows itself', bytes: null, tier: 'D', group: 'remainder', icon: 'cpu', paths: [win], hint: 'The rest of ' + win + ': System32, drivers, fonts and other files of the operating system. Many are hard links, so a folder walk counts them more than once.', commandNote: 'Settings > System > Storage > Cleanup recommendations lists what Windows itself can remove.' }));
  push(item({ key: 'restore-points', label: 'Restore points and shadow copies', bytes: null, tier: 'D', group: 'remainder', icon: 'clock', paths: [d('System Volume Information')], hint: 'System Protection keeps restore points in System Volume Information, which only the system can read.', command: 'vssadmin list shadowstorage', commandNote: 'Administrator. System Properties > System Protection > Configure sets how much space they may use.' }));
  push(item({ key: 'reserved-storage', label: 'Reserved storage', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', hint: 'Space Windows sets aside (about 7 GB) so updates always have room.', command: 'DISM /Online /Get-ReservedStorageState', commandNote: 'Administrator.' }));
  const others = await otherProfiles(fsp, home);
  if (others.length) push(item({ key: 'other-users', label: 'Other user accounts', bytes: null, tier: 'D', group: 'remainder', icon: 'lock', count: others.length, hint: 'Profiles of ' + others.join(', ') + '. Windows does not let one account read another\'s files.', commandNote: 'Each account sees its own usage in Settings > System > Storage; an administrator manages accounts in Settings > Accounts.' }));

  facts.drive = drive;
  return { items, facts };
}

async function otherProfiles(fsp, home) {
  try {
    const parent = path.dirname(home);
    const names = await fsp.readdir(parent);
    const skip = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini', path.basename(home).toLowerCase()]);
    return names.filter((n) => !skip.has(n.toLowerCase()) && !n.startsWith('.'));
  } catch { return []; }
}

function topList(children, limit = 12) {
  return (children || []).filter((c) => c && c.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, limit)
    .map((c) => ({ name: path.basename(c.path), path: c.path, bytes: c.bytes }));
}

module.exports = { collect, parseFacts, FACTS_SCRIPT, ROOT_FILES };
