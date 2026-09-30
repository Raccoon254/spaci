'use strict';
// Clone-aware size on APFS (macOS), without a native module.
//
// `du` counts every APFS clone in full, so a folder of Chrome code-sign clones
// reads 38 GB while deleting it frees a few MB (os-storage-spec.md 0.2). The
// true numbers come from getattrlist(2) with FSOPT_ATTR_CMN_EXTENDED:
//   ATTR_CMNEXT_PRIVATESIZE  bytes freed at once if the file were deleted
//   ATTR_CMNEXT_CLONEID      shared by files that are clones of each other
//
// Why Perl: the helper must ship with macOS and add no dependency. The
// preferred route, `osascript -l JavaScript` with the ObjC bridge, works
// (ObjC.bindFunction('getattrlist', ...)) but costs about 5 ms per file in
// bridge calls: over 90 s for the 19k files of one clone folder, measured on
// this Mac. /usr/bin/perl ships with every macOS release to date (5.34 on
// macOS 27) and its syscall() calls getattrlist directly: the same folder takes
// about 4 s. If /usr/bin/perl is ever missing, callers fall back to du and
// label the number an upper bound.
//
// The script is passed with -e (the app is packed in an asar, which perl
// cannot read). Paths travel on stdin, one per line, prefixed "S " for seed
// roots (their clone ids are registered, their bytes are not counted: the
// owning app is counted in Applications) and "M " for roots to measure.

const { spawn } = require('child_process');
const fs = require('fs');

const PERL = '/usr/bin/perl';
const SYS_getattrlist = 220; // <sys/syscall.h>

const SCRIPT = String.raw`
use strict; use warnings;
my ($budget) = @ARGV; $budget ||= 60;
my $t0 = time;
# attrlist: bitmapcount 5, reserved, common = ATTR_CMN_RETURNED_ATTRS,
# vol, dir, file = 0, fork(ext) = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID
my $al = pack('S S L L L L L', 5, 0, 0x80000000, 0, 0, 0, 0x8 | 0x100);
my (%clone, %seen);
my @jobs = map { chomp; [substr($_, 0, 1), substr($_, 2)] } grep { /^[SM] ./ } <STDIN>;
my $i = -1;
for my $job (@jobs) {
  my ($kind, $root) = @$job;
  $i++ if $kind eq 'M';
  my ($files, $alloc, $priv, $foot, $denied, $fallback, $partial) = (0, 0, 0, 0, 0, 0, 0);
  my @st0 = lstat($root);
  unless (@st0) { print "R $i missing\n" if $kind eq 'M'; next; }
  my $dev = $st0[0];
  my @stack = ($root);
  while (@stack) {
    if (time - $t0 > $budget) { $partial = 1; last; }
    my $d = pop @stack;
    my $dh;
    unless (opendir($dh, $d)) { $denied++; next; }
    while (defined(my $n = readdir($dh))) {
      next if $n eq '.' || $n eq '..';
      my $p = "$d/$n";
      my @s = lstat($p) or next;
      next if $s[0] != $dev || -l _;
      if (-d _) { push @stack, $p; next; }
      next unless -f _;
      next if $s[3] > 1 && $seen{"$s[0]:$s[1]"}++;
      my $a = $s[12] * 512;
      my ($pv, $cid) = ($a, '');
      my $buf = "\0" x 64;
      if (syscall(${SYS_getattrlist}, $p, $al, $buf, 64, 0x21) == 0) {
        my @u = unpack('L L L L L L L L L L', $buf);
        if ($u[5] & 0x8) { $pv = $u[6] + $u[7] * 4294967296; $cid = "$u[8]:$u[9]" if $u[5] & 0x100; }
        else { $fallback++; }
      } else { $fallback++; }
      if ($kind eq 'S') { $clone{$cid} = 1 if $cid ne '' && $pv < $a; next; }
      $files++; $alloc += $a; $priv += $pv;
      if ($pv >= $a || $cid eq '') { $foot += $a; }
      elsif ($clone{$cid}++) { $foot += $pv; }
      else { $foot += $a; }
    }
    closedir($dh);
  }
  printf("R %d %d %.0f %.0f %.0f %d %d %d\n", $i, $files, $alloc, $priv, $foot, $denied, $fallback, $partial) if $kind eq 'M';
}
`;

/** Parse the helper's "R <index> <files> <alloc> <private> <footprint> <denied> <fallback> <partial>" lines. */
function parseCloneOutput(stdout, roots) {
  const out = roots.map((p) => ({ path: p, missing: true }));
  for (const line of String(stdout || '').split('\n')) {
    const m = /^R (\d+) (missing|(\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+))$/.exec(line.trim());
    if (!m) continue;
    const i = Number(m[1]);
    if (!out[i]) continue;
    if (m[2] === 'missing') continue;
    out[i] = {
      path: roots[i],
      files: Number(m[3]),
      allocated: Number(m[4]),
      private: Number(m[5]),
      footprint: Number(m[6]),
      denied: Number(m[7]),
      fallback: Number(m[8]),
      partial: m[9] === '1',
    };
  }
  return out;
}

function perlAvailable() {
  try { fs.accessSync(PERL, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * Clone-aware sizes of `measure` roots. `seed` roots are walked first so clones
 * of their files count only their private bytes.
 * @returns {Promise<Array<{ path, files, allocated, private, footprint, denied, fallback, partial } | { path, missing: true }> | null>}
 *   null when the helper cannot run (not macOS, no /usr/bin/perl).
 */
function cloneAwareSize({ measure = [], seed = [], budgetSec = 60, spawnFn = spawn, platform = process.platform, hasPerl = perlAvailable } = {}) {
  if (platform !== 'darwin' || !measure.length || !hasPerl()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawnFn(PERL, ['-e', SCRIPT, String(Math.max(1, Math.round(budgetSec)))], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, (budgetSec + 15) * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parseCloneOutput(stdout, measure)); });
    child.stdin.on('error', () => {});
    const lines = [...seed.map((p) => 'S ' + p), ...measure.map((p) => 'M ' + p)].filter((l) => !/[\n\r]/.test(l));
    child.stdin.end(lines.join('\n') + '\n');
  });
}

module.exports = { cloneAwareSize, parseCloneOutput, SCRIPT };
