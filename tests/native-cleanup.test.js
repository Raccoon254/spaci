'use strict';
// Native cleanup runtime with every process stubbed: no real tool ever runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const nc = require('../src/native-cleanup');
const specs = require('../src/native-cleanup-specs');

const PLAT = process.platform === 'win32' ? 'win32' : 'linux';
const BIN_DIR = PLAT === 'win32' ? 'C:\\fake\\bin' : '/fake/bin';
const binPath = (name) => path[PLAT === 'win32' ? 'win32' : 'posix'].join(BIN_DIR, name + (PLAT === 'win32' ? '.exe' : ''));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-native-')); }

/** A spawn stub. script(args, child) -> { out, err, code, hang, error, before } */
function fakeSpawn(script) {
  const calls = [];
  const children = new Map();
  let pid = 4000;
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.pid = ++pid;
    child.signals = [];
    children.set(child.pid, child);
    child.kill = (sig) => {
      child.signals.push(sig);
      if (child.exitCode === null && !child.closing) {
        child.closing = true;
        setImmediate(() => { child.exitCode = 143; child.emit('close', null, sig || 'SIGTERM'); });
      }
      return true;
    };
    const s = script(args, child) || {};
    setImmediate(async () => {
      if (s.error) { child.emit('error', s.error); return; }
      for (const l of s.out || []) child.stdout.emit('data', Buffer.from(l + '\n'));
      for (const l of s.err || []) child.stderr.emit('data', Buffer.from(l + '\n'));
      if (s.hang) return;
      if (s.before) await s.before();
      if (child.closing) return;
      child.exitCode = s.code == null ? 0 : s.code;
      child.emit('close', child.exitCode, null);
    });
    return child;
  };
  spawn.calls = calls;
  // taskkill on Windows goes through exec: route it to the stub child.
  spawn.exec = (cmd, args, opts, cb) => {
    if (cmd === 'taskkill') { const c = children.get(Number(args[1])); if (c) c.kill('SIGKILL'); }
    if (cb) cb(null, '', '');
  };
  return spawn;
}

const NO_PROCS = async () => ({ ok: true, list: [] });

function opts(over = {}) {
  const home = over.home || tmp();
  const spawn = over.spawn || fakeSpawn(() => ({}));
  return {
    platform: PLAT,
    home,
    env: { PATH: BIN_DIR },
    isExecutable: async (p) => (over.bins || ['pnpm', 'uv', 'go', 'gradle', 'pip3', 'yarn', 'pod', 'brew']).some((n) => p === binPath(n)),
    spawn,
    exec: spawn.exec,
    snapshot: NO_PROCS,
    lockHolders: async () => [],
    measure: over.measure || (() => 0),
    ...over,
  };
}

function target(id, paths) { return { id, name: id, paths }; }

// Before/after sizes in order.
function sizes(...list) { let i = 0; return async () => list[Math.min(i++, list.length - 1)]; }

// ---- specs ----------------------------------------------------------------

test('no spec ever passes a flag that bypasses a lock, and every argument is a plain constant', () => {
  for (const [id, s] of Object.entries(specs.SPECS)) {
    for (const a of [s.run, s.autoRun, s.locate, s.previewArgs, s.versionArgs].filter(Boolean)) {
      for (const arg of a) {
        assert.ok(!specs.FORBIDDEN_ARGS.has(arg.split('=')[0]), `${id} passes ${arg}`);
        assert.match(arg, specs.SAFE_ARG, `${id}: ${arg}`);
      }
    }
  }
  assert.throws(() => specs.validateArgs(['cache', 'clean', '--force']), /never passes --force/);
  assert.throws(() => specs.validateArgs(['store', 'prune; rm -rf ~']), /Unsafe argument/);
  assert.throws(() => specs.validateArgs(['$(touch x)']), /Unsafe argument/);
  assert.throws(() => specs.validateArgs(['a&&b']), /Unsafe argument/);
});

test('the catalog names the agreed command for each tool', () => {
  const cmd = (id, mode) => specs.commandLine(specs.specFor(id), mode);
  assert.equal(cmd('pnpm'), 'pnpm store prune');
  assert.equal(cmd('uv-cache'), 'uv cache clean');
  assert.equal(cmd('uv-cache', 'auto'), 'uv cache prune');
  assert.equal(cmd('go'), 'go clean -cache');
  assert.equal(cmd('go-modcache'), 'go clean -modcache');
  assert.equal(cmd('go-modcache', 'auto'), null);
  assert.equal(cmd('gradle'), 'gradle --stop');
  assert.equal(cmd('pip'), 'pip cache purge');
  assert.equal(cmd('yarn'), 'yarn cache clean');
  assert.equal(cmd('cocoapods'), 'pod cache clean --all');
  assert.equal(cmd('homebrew-cache'), 'brew cleanup --prune=all');
  assert.equal(cmd('homebrew-cache', 'auto'), null);
  assert.equal(specs.specFor('npm').via, 'folder');
  assert.equal(specs.specFor('cargo').via, 'folder');
  assert.equal(specs.specFor('maven'), null);
  assert.equal(specs.specFor('__proto__'), null);
});

// ---- finding the CLI --------------------------------------------------------

test('resolveBin searches PATH, then the folders a GUI launch leaves out', async () => {
  const seen = [];
  const found = await nc.resolveBin(['uv'], { platform: 'darwin', home: '/Users/e', env: { PATH: '/usr/bin:/bin' }, isExecutable: async (p) => { seen.push(p); return p === '/Users/e/.local/bin/uv'; } });
  assert.equal(found, '/Users/e/.local/bin/uv');
  assert.ok(seen.indexOf('/usr/bin/uv') < seen.indexOf('/Users/e/.local/bin/uv'));
  assert.equal(await nc.resolveBin(['uv'], { platform: 'darwin', home: '/Users/e', env: { PATH: '' }, isExecutable: async () => false }), null);
});

test('resolveBin skips the macOS pip3 stub in /usr/bin and finds .cmd shims on Windows', async () => {
  const mac = await nc.resolveBin(['pip3'], { platform: 'darwin', home: '/Users/e', env: { PATH: '/usr/bin' }, isExecutable: async (p) => p === '/usr/bin/pip3' });
  assert.equal(mac, null);
  const win = await nc.resolveBin(['pnpm'], { platform: 'win32', home: 'C:\\Users\\e', env: { PATH: 'C:\\npm', LOCALAPPDATA: 'C:\\L' }, isExecutable: async (p) => p === 'C:\\npm\\pnpm.cmd' });
  assert.equal(win, 'C:\\npm\\pnpm.cmd');
});

// ---- busy detection ---------------------------------------------------------

test('commandOf reads the command behind node, python and bash hosts', () => {
  assert.deepEqual(nc.commandOf('node /opt/homebrew/bin/pnpm install --frozen-lockfile'), { name: 'pnpm', sub: 'install' });
  assert.deepEqual(nc.commandOf('/Users/e/.local/bin/uv run server.py'), { name: 'uv', sub: 'run' });
  assert.deepEqual(nc.commandOf('/usr/bin/python3 -m pip install x'), { name: 'pip', sub: 'install' });
  assert.deepEqual(nc.commandOf('/bin/bash /opt/homebrew/Library/Homebrew/brew.sh upgrade'), { name: 'brew', sub: 'upgrade' });
  assert.deepEqual(nc.commandOf('C:\\Program Files\\Go\\bin\\go.exe build ./...'), { name: 'go', sub: 'build' });
});

test('busy: cache users count, script runners and paths that only mention the tool do not', () => {
  const procs = (args) => ({ ok: true, list: args.map((a, i) => ({ pid: 10 + i, args: a })) });
  const busy = (id, list) => nc.checkBusy(specs.specFor(id), procs(list), 1).busy;
  assert.equal(busy('pnpm', ['node /usr/local/bin/pnpm install']), true);
  assert.equal(busy('pnpm', ['node /usr/local/bin/pnpm']), true, 'bare pnpm installs');
  assert.equal(busy('pnpm', ['node /usr/local/bin/pnpm dev', 'node /usr/local/bin/pnpm run build']), false);
  assert.equal(busy('pnpm', ['du -sk /Users/e/Library/pnpm/store']), false);
  assert.equal(busy('uv-cache', ['/Users/e/.local/bin/uv run app.py']), true, 'uv run holds the cache lock');
  assert.equal(busy('uv-cache', ['/Users/e/.local/bin/uvx ruff check']), true);
  assert.equal(busy('uv-cache', ['/Users/e/.local/bin/ruff check']), false);
  assert.equal(busy('go', ['/usr/local/go/bin/go test ./...']), true);
  assert.equal(busy('go', ['/Users/e/go/bin/gopls serve']), false, 'the language server never blocks');
  assert.equal(busy('go', ['go run ./cmd/server']), false, 'a long-running go run has finished compiling');
  assert.equal(busy('gradle', ['/usr/bin/java -cp x org.gradle.wrapper.GradleWrapperMain build']), true);
  assert.equal(busy('gradle', ['/usr/bin/java -cp x org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10']), false, 'an idle daemon is stopped, not a build');
  assert.equal(busy('pip', ['/usr/bin/python3.12 -m pip install requests']), true);
  assert.equal(busy('homebrew-cache', ['/bin/bash /opt/homebrew/Library/Homebrew/brew.sh install x']), true);
  // Spaci's own pid never counts.
  assert.equal(nc.checkBusy(specs.specFor('uv-cache'), { ok: true, list: [{ pid: 7, args: 'uv cache dir' }] }, 7).busy, false);
});

test('busy: an unreadable process list fails closed', () => {
  const r = nc.checkBusy(specs.specFor('uv-cache'), { ok: false, list: [] }, 1);
  assert.equal(r.busy, true);
  assert.match(r.reason, /could not check whether uv is running/);
});

// ---- run ----------------------------------------------------------------------

test('success: pnpm store prune runs and freed is measured before and after, not the tool claim', async () => {
  const store = tmp();
  const spawn = fakeSpawn((args) => {
    if (args.join(' ') === 'store path') return { out: [store] };
    if (args.join(' ') === 'store prune') return { out: ['Removed all cached metadata files', 'Removed 9999 files (99 GB)'] };
    return { code: 9 };
  });
  const lines = [];
  const o = opts({ spawn, measure: sizes(5000, 1200), onProgress: (p) => lines.push(p) });
  const r = await nc.runNative(target('pnpm', [store]), o);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'done');
  assert.equal(r.via, 'native');
  assert.equal(r.command, 'pnpm store prune');
  assert.equal(r.exitCode, 0);
  assert.equal(r.before, 5000);
  assert.equal(r.after, 1200);
  assert.equal(r.freed, 3800);
  const run = spawn.calls.find((c) => c.args.join(' ') === 'store prune');
  assert.ok(run, 'the prune ran');
  assert.deepEqual(run.opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(lines.some((p) => p.phase === 'native' && /Removed 9999/.test(p.line) && p.target === 'pnpm'));
  assert.ok(lines.some((p) => p.phase === 'native-start' && p.command === 'pnpm store prune'));
});

test('missing CLI: the folder is emptied instead, after the busy check', async () => {
  const dir = tmp();
  const deleted = [];
  const o = opts({ bins: [], measure: sizes(800, 0), folderJobs: [{ path: dir, mode: 'contents' }],
    deleteFolders: async (jobs) => { deleted.push(...jobs.map((j) => j.path)); return { totalFreed: 800, results: jobs.map((j) => ({ path: j.path, ok: true })) }; } });
  const r = await nc.runNative(target('uv-cache', [dir]), o);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'folder');
  assert.equal(r.command, null);
  assert.equal(r.freed, 800);
  assert.match(r.message, /uv was not found, so Spaci emptied the folder instead/);
  assert.deepEqual(deleted, [dir]);
  assert.equal(o.spawn.calls.length, 0);
});

test('busy process: uv is refused at once with the agreed message, nothing runs', async () => {
  const o = opts({ snapshot: async () => ({ ok: true, list: [{ pid: 55, args: '/Users/e/.local/bin/uv sync' }] }) });
  const r = await nc.runNative(target('uv-cache', [tmp()]), o);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'busy');
  assert.equal(r.message, 'uv is busy (another uv process is running). Try again when it finishes.');
  assert.equal(o.spawn.calls.length, 0);
});

test('busy lock: another process holding the cache lock file refuses too', async () => {
  const cache = tmp();
  const spawn = fakeSpawn((args) => (args.join(' ') === 'cache dir' ? { out: [cache] } : {}));
  let asked = null;
  const o = opts({ spawn, lockHolders: async (files) => { asked = files; return [321]; } });
  const r = await nc.runNative(target('uv-cache', [cache]), o);
  assert.equal(r.code, 'busy');
  assert.match(r.message, /uv is busy \(another process holds its cache lock\)/);
  assert.ok(asked.some((f) => f.endsWith('.lock')));
  assert.ok(!spawn.calls.some((c) => c.args.join(' ') === 'cache clean'));
});

test('lock wait: uv saying it waits for another uv is stopped at once and reported busy', async () => {
  const spawn = fakeSpawn((args) => {
    if (args.join(' ') === 'cache clean') return { err: ['Cache is currently in-use, waiting for other uv processes to finish (use `--force` to override)'], hang: true };
    return { code: 1 };
  });
  const t0 = Date.now();
  const r = await nc.runNative(target('uv-cache', [tmp()]), opts({ spawn, measure: sizes(10, 10) }));
  assert.equal(r.code, 'busy');
  assert.equal(r.message, 'uv is busy (another uv process is running). Try again when it finishes.');
  assert.ok(Date.now() - t0 < 5000, 'never waits for the lock');
  const child = spawn.calls.find((c) => c.args.join(' ') === 'cache clean');
  assert.ok(!child.args.includes('--force'));
});

test('timeout: a command that never finishes is stopped and reported', async () => {
  const spawn = fakeSpawn((args) => (args[0] === 'clean' ? { hang: true } : { code: 1 }));
  const r = await nc.runNative(target('go', [tmp()]), opts({ spawn, timeoutMs: 50, measure: sizes(100, 40) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'timeout');
  assert.match(r.message, /go clean -cache did not finish in 1 minute, so Spaci stopped it/);
  assert.equal(r.freed, 60, 'whatever it removed before the stop is measured');
});

test('non-zero exit: failure with the status and the last line', async () => {
  const spawn = fakeSpawn((args) => (args.join(' ') === 'cache purge' ? { err: ['ERROR: pip cache commands can not function since cache is disabled.'], code: 1 } : { code: 1 }));
  const r = await nc.runNative(target('pip', [tmp()]), opts({ spawn }));
  assert.equal(r.code, 'failed');
  assert.equal(r.exitCode, 1);
  assert.equal(r.command, 'pip3 cache purge');
  assert.match(r.message, /exited with status 1: ERROR: pip cache commands/);
});

test('cancel: aborting stops the command', async () => {
  const ac = new AbortController();
  const spawn = fakeSpawn((args) => (args.join(' ') === 'store prune' ? { hang: true } : { code: 1 }));
  const p = nc.runNative(target('pnpm', [tmp()]), opts({ spawn, signal: ac.signal }));
  setTimeout(() => ac.abort(), 30);
  const r = await p;
  assert.equal(r.code, 'cancelled');
  const child = spawn.calls.find((c) => c.args.join(' ') === 'store prune');
  assert.ok(child);
});

test('spawn failure with ENOENT falls back to the folder', async () => {
  const dir = tmp();
  const spawn = fakeSpawn((args) => (args[0] === 'cache' && args[1] === 'clean' && args[2] === '--all' ? { error: Object.assign(new Error('spawn pod ENOENT'), { code: 'ENOENT' }) } : { code: 1 }));
  const r = await nc.runNative(target('cocoapods', [dir]), opts({ spawn, folderJobs: [{ path: dir, mode: 'contents' }], deleteFolders: async (jobs) => ({ results: jobs.map((j) => ({ path: j.path, ok: true })) }) }));
  assert.equal(r.ok, true);
  assert.equal(r.via, 'folder');
  assert.match(r.message, /CocoaPods could not be started/);
});

test('gradle: daemons are stopped first; a daemon of another version still running refuses', async () => {
  const dir = tmp();
  let snaps = 0;
  const daemon = { pid: 77, args: '/usr/bin/java -cp g org.gradle.launcher.daemon.bootstrap.GradleDaemon 7.6' };
  const spawn = fakeSpawn((args) => {
    if (args[0] === '--stop') return { out: ['Stopping Daemon(s)', '1 Daemon stopped'] };
    if (args[0] === '--status') return { out: ['   PID STATUS   INFO', ' 77 IDLE     7.6', '', 'Only Daemons for the current Gradle version are displayed.'] };
    return { code: 1 };
  });
  let folder = false;
  const base = { spawn, folderJobs: [{ path: dir, mode: 'contents' }], deleteFolders: async (jobs) => { folder = true; return { results: jobs.map((j) => ({ path: j.path, ok: true })) }; } };
  const stuck = await nc.runNative(target('gradle', [dir]), opts({ ...base, snapshot: async () => { snaps++; return { ok: true, list: [daemon] }; } }));
  assert.equal(stuck.code, 'busy');
  assert.match(stuck.message, /Gradle daemon from another Gradle version/);
  assert.equal(folder, false);
  assert.equal(snaps, 3, 'at the start, right before gradle --stop, right before the folder');
  const ok = await nc.runNative(target('gradle', [dir]), opts({ ...base, measure: sizes(300, 0) }));
  assert.equal(ok.ok, true);
  assert.equal(ok.via, 'stop-then-folder');
  assert.equal(ok.command, 'gradle --stop');
  assert.equal(folder, true);
  assert.equal(ok.freed, 300);
});

test('gradle without its CLI: a running daemon refuses, none means the folder goes', async () => {
  const dir = tmp();
  const daemon = { pid: 77, args: 'java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10' };
  const del = async (jobs) => ({ results: jobs.map((j) => ({ path: j.path, ok: true })) });
  const r = await nc.runNative(target('gradle', [dir]), opts({ bins: [], snapshot: async () => ({ ok: true, list: [daemon] }), folderJobs: [{ path: dir }], deleteFolders: del }));
  assert.equal(r.code, 'busy');
  const r2 = await nc.runNative(target('gradle', [dir]), opts({ bins: [], folderJobs: [{ path: dir }], deleteFolders: del }));
  assert.equal(r2.ok, true);
  assert.equal(r2.via, 'folder');
});

test('auto mode: gentler commands, and none for what auto-clean leaves to the user', async () => {
  const spawn = fakeSpawn((args) => (args.join(' ') === 'cache dir' ? { code: 1 } : {}));
  const r = await nc.runNative(target('uv-cache', [tmp()]), opts({ spawn, mode: 'auto' }));
  assert.equal(r.command, 'uv cache prune');
  assert.ok(!spawn.calls.some((c) => c.args.join(' ') === 'cache clean'));
  for (const id of ['go-modcache', 'homebrew-cache', 'gradle']) {
    const n = await nc.runNative(target(id, [tmp()]), opts({ mode: 'auto' }));
    assert.equal(n.code, 'not-auto', id);
  }
});

test('yarn 2 and later: the global folder is emptied, the command never runs', async () => {
  const dir = tmp();
  const spawn = fakeSpawn((args) => (args[0] === '--version' ? { out: ['4.5.1'] } : {}));
  const r = await nc.runNative(target('yarn', [dir]), opts({ spawn, folderJobs: [{ path: dir }], deleteFolders: async (jobs) => ({ results: jobs.map((j) => ({ path: j.path, ok: true })) }) }));
  assert.equal(r.via, 'folder');
  assert.match(r.message, /Yarn 2 and later/);
  assert.ok(!spawn.calls.some((c) => c.args[0] === 'cache' && c.args[1] === 'clean'));
});

test('a folder that could not be emptied is a failure', async () => {
  const dir = tmp();
  const r = await nc.runNative(target('cargo', [dir]), opts({ folderJobs: [{ path: dir }], deleteFolders: async () => ({ results: [{ path: dir, ok: false, error: 'EACCES: permission denied' }] }) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'failed');
  assert.match(r.message, /EACCES/);
});

test('an unknown target id never runs anything', async () => {
  const o = opts();
  for (const id of ['maven', 'rm -rf', '', undefined, 'constructor']) {
    const r = await nc.runNative({ id, paths: ['/'] }, o);
    assert.equal(r.code, 'invalid');
  }
  assert.equal(o.spawn.calls.length, 0);
});

test('runCommand refuses unsafe arguments before spawning', async () => {
  const spawn = fakeSpawn(() => ({}));
  assert.throws(() => nc.runCommand('/fake/bin/uv', ['cache', 'clean', '--force'], { spawn, platform: PLAT }), /never passes/);
  assert.equal(spawn.calls.length, 0);
});

// ---- preview and measuring -----------------------------------------------------

test('parseBrewDryRun reads the dry-run total and counts the items', () => {
  const out = 'Warning: Skipping x\nWould remove: /a (1KB)\nWould remove: /b (2MB)\n==> This operation would free approximately 130.3MB of disk space.\n';
  const r = nc.parseBrewDryRun(out);
  assert.equal(r.items, 2);
  assert.equal(r.bytes, Math.round(130.3 * 1024 * 1024));
  assert.deepEqual(nc.parseBrewDryRun(''), { bytes: 0, items: 0, autoremove: false });
  assert.equal(r.autoremove, false);
});

test('preview: brew runs only its dry run and shows its estimate', async () => {
  const spawn = fakeSpawn((args) => {
    if (args[0] === '--cache') return { out: ['/Users/e/Library/Caches/Homebrew'] };
    if (args.includes('--dry-run')) return { out: ['Would remove: /x (5MB)', '==> This operation would free approximately 1.5GB of disk space.'] };
    return { code: 1 };
  });
  const p = await nc.preview(target('homebrew-cache', [tmp()]), opts({ spawn, procs: { ok: true, list: [] } }));
  assert.equal(p.command, 'brew cleanup --prune=all');
  assert.equal(p.label, 'Runs `brew cleanup --prune=all`');
  assert.equal(p.estimateKind, 'dry-run');
  assert.equal(p.estimate, Math.round(1.5 * 1024 ** 3));
  assert.ok(!spawn.calls.some((c) => c.args.join(' ') === 'cleanup --prune=all'), 'never the real cleanup');
});

test('preview: a missing CLI or a busy tool is said on the row', async () => {
  const p = await nc.preview(target('pnpm', [tmp()]), opts({ bins: [], procs: { ok: true, list: [] }, measure: async () => 42 }));
  assert.equal(p.available, false);
  assert.equal(p.via, 'folder');
  assert.equal(p.estimate, 42);
  assert.match(p.note, /pnpm was not found/);
  const b = await nc.preview(target('uv-cache', [tmp()]), opts({ procs: { ok: true, list: [{ pid: 9, args: 'uv run x' }] } }));
  assert.equal(b.busy, 'uv is busy (another uv process is running). Try again when it finishes.');
});

test('pnpmUnreferenced counts only files no project links to', async (t) => {
  const store = tmp();
  const files = path.join(store, 'files', 'ab');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'lonely'), Buffer.alloc(64 * 1024, 1));
  fs.writeFileSync(path.join(files, 'used'), Buffer.alloc(64 * 1024, 2));
  const project = tmp();
  try { fs.linkSync(path.join(files, 'used'), path.join(project, 'used')); } catch { t.skip('no hard links here'); return; }
  const r = await nc.pnpmUnreferenced(store);
  assert.equal(r.count, 1);
  assert.ok(r.bytes >= 64 * 1024 && r.bytes < 128 * 1024, String(r.bytes));
  assert.equal(r.partial, false);
});

test('measure counts a hard-linked file once and nested folders once', { skip: process.platform === 'win32' }, async () => {
  const a = tmp();
  fs.writeFileSync(path.join(a, 'f'), Buffer.alloc(256 * 1024, 3));
  fs.linkSync(path.join(a, 'f'), path.join(a, 'g'));
  fs.mkdirSync(path.join(a, 'sub'));
  const one = await nc.measure([a]);
  const twice = await nc.measure([a, path.join(a, 'sub'), a]);
  assert.ok(one >= 256 * 1024 && one < 400 * 1024, String(one));
  assert.equal(twice, one);
  assert.equal(await nc.measure([path.join(a, 'missing')]), 0);
});

test('pickLocated accepts only an absolute cache folder, never root or home', () => {
  const ctx = { platform: 'linux', home: '/home/e' };
  assert.equal(nc.pickLocated('warning\n/home/e/.cache/uv\n', ctx), '/home/e/.cache/uv');
  assert.equal(nc.pickLocated('/\n', ctx), null);
  assert.equal(nc.pickLocated('/home/e\n', ctx), null);
  assert.equal(nc.pickLocated('relative/dir', ctx), null);
  assert.equal(nc.pickLocated('', ctx), null);
});

test('the child gets the CLI folder on PATH and colour turned off', () => {
  const env = nc.childEnv(specs.specFor('homebrew-cache'), '/opt/homebrew/bin/brew', { platform: 'darwin', home: '/Users/e', env: { PATH: '/usr/bin' } });
  assert.equal(env.PATH.split(':')[0], '/opt/homebrew/bin');
  assert.equal(env.HOMEBREW_NO_AUTO_UPDATE, '1');
  assert.equal(env.NO_COLOR, '1');
});

// ---- safety critic findings (2.3.2) -------------------------------------------

const del = (log) => async (jobs) => { if (log) log.push(...jobs.map((j) => j.path)); return { results: jobs.map((j) => ({ path: j.path, ok: true })) }; };

test('finding 1: HOMEBREW_NO_AUTOREMOVE=1 reaches spawn for the dry run and for the run', async () => {
  const spawn = fakeSpawn((args) => {
    if (args[0] === '--cache') return { out: ['/Users/e/Library/Caches/Homebrew'] };
    if (args.includes('--dry-run')) return { out: ['==> This operation would free approximately 1MB of disk space.'] };
    return {};
  });
  await nc.preview(target('homebrew-cache', [tmp()]), opts({ spawn, procs: { ok: true, list: [] } }));
  const r = await nc.runNative(target('homebrew-cache', [tmp()]), opts({ spawn }));
  assert.equal(r.code, 'done', JSON.stringify(r));
  const dry = spawn.calls.filter((c) => c.args.includes('--dry-run'));
  const run = spawn.calls.filter((c) => c.args.join(' ') === 'cleanup --prune=all');
  assert.equal(dry.length, 2, 'the preview dry run and the dry run checked right before the run');
  assert.equal(run.length, 1);
  for (const c of [...dry, ...run]) {
    assert.equal(c.opts.env.HOMEBREW_NO_AUTOREMOVE, '1', c.args.join(' '));
    assert.equal(c.opts.env.HOMEBREW_NO_AUTO_UPDATE, '1');
    assert.equal(c.opts.env.HOMEBREW_NO_INSTALL_CLEANUP, '1');
  }
});

test('finding 1: a dry run that would autoremove refuses the run, and the preview says so', async () => {
  const plan = ['Would remove: /x (5MB)', '==> Would autoremove 2 unneeded formulae:', 'libfoo', 'libbar', '==> This operation would free approximately 1.5GB of disk space.'];
  assert.equal(nc.parseBrewDryRun(plan.join('\n')).autoremove, true);
  assert.equal(nc.parseBrewDryRun('==> Autoremoving 1 unneeded formula:\nx').autoremove, true);
  const spawn = fakeSpawn((args) => (args.includes('--dry-run') ? { out: plan } : args[0] === '--cache' ? { out: ['/Users/e/Library/Caches/Homebrew'] } : {}));
  const r = await nc.runNative(target('homebrew-cache', [tmp()]), opts({ spawn }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsafe');
  assert.match(r.message, /uninstall formulae \(autoremove\)/);
  assert.ok(!spawn.calls.some((c) => c.args.join(' ') === 'cleanup --prune=all'), 'the cleanup never ran');
  const p = await nc.preview(target('homebrew-cache', [tmp()]), opts({ spawn, procs: { ok: true, list: [] } }));
  assert.equal(p.blocked, nc.BREW_AUTOREMOVE_MESSAGE);
});

test('finding 2: auto mode never falls back to a permanent folder delete (critic repro)', async () => {
  for (const id of ['yarn', 'pip', 'go', 'pnpm', 'uv-cache']) {
    const deleted = [];
    const r = await nc.runNative(target(id, ['/tmp/x-' + id]), {
      mode: 'auto', env: { PATH: '/nonexistent' }, home: '/nonexistent-home', platform: 'darwin',
      isExecutable: async () => false, snapshot: async () => ({ ok: true, list: [{ pid: 9, args: 'zsh' }] }),
      measure: async () => 100, lockHolders: async () => [],
      folderJobs: [{ path: '/tmp/x-' + id, mode: 'contents' }], deleteFolders: del(deleted),
    });
    assert.equal(r.code, 'missing', id);
    assert.equal(r.ok, false, id);
    assert.deepEqual(deleted, [], id + ': nothing deleted');
  }
  // Yarn 2+ and a CLI that cannot start: also no folder delete in auto mode.
  const deleted = [];
  const berry = fakeSpawn((args) => (args[0] === '--version' ? { out: ['4.5.1'] } : {}));
  const y = await nc.runNative(target('yarn', [tmp()]), opts({ spawn: berry, mode: 'auto', folderJobs: [{ path: '/x' }], deleteFolders: del(deleted) }));
  assert.equal(y.code, 'not-auto');
  const enoent = fakeSpawn((args) => (args.join(' ') === 'store prune' ? { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } : { code: 1 }));
  const e = await nc.runNative(target('pnpm', [tmp()]), opts({ spawn: enoent, mode: 'auto', folderJobs: [{ path: '/x' }], deleteFolders: del(deleted) }));
  assert.equal(e.code, 'missing');
  // Folder-only and stop-then-folder targets are never run in auto mode.
  for (const id of ['npm', 'cargo', 'gradle']) {
    const n = await nc.runNative(target(id, [tmp()]), opts({ mode: 'auto', folderJobs: [{ path: '/x' }], deleteFolders: del(deleted) }));
    assert.equal(n.code, 'not-auto', id);
  }
  assert.deepEqual(deleted, []);
});

test('finding 2: version managers are searched (nvm, fnm, volta, asdf, mise, pyenv, pipx), never a project folder', async () => {
  const home = '/Users/e';
  const listDir = (d) => (d === '/Users/e/.nvm/versions/node' ? ['v18.19.0', 'v20.11.1', 'v9.0.0', 'notes.txt'] : []);
  const dirs = nc.extraBinDirs({ platform: 'darwin', home, env: { PNPM_HOME: home, PIPX_BIN_DIR: '/Users/e/.pipx-bin', MISE_DATA_DIR: '/' }, listDir });
  const nvm = dirs.filter((d) => d.includes('.nvm'));
  assert.deepEqual(nvm, ['/Users/e/.nvm/versions/node/v20.11.1/bin', '/Users/e/.nvm/versions/node/v18.19.0/bin', '/Users/e/.nvm/versions/node/v9.0.0/bin']);
  for (const d of ['/Users/e/Library/Application Support/fnm/aliases/default/bin', '/Users/e/.volta/bin', '/Users/e/.asdf/shims',
    '/Users/e/.local/share/mise/shims', '/Users/e/.pyenv/shims', '/Users/e/.local/bin', '/Users/e/.pipx-bin']) {
    assert.ok(dirs.includes(d), d);
  }
  assert.ok(!dirs.includes(home), 'PNPM_HOME set to the home folder is ignored');
  assert.ok(!dirs.includes('/shims'), 'MISE_DATA_DIR=/ is ignored');
  assert.ok(dirs.every((d) => !/node_modules|\/projects\//.test(d)));
  // PATH entries that would resolve against a project folder are dropped.
  const search = nc.searchDirs({ platform: 'darwin', home, env: { PATH: '.:node_modules/.bin:/usr/bin' }, listDir });
  assert.ok(!search.includes('.') && !search.includes('node_modules/.bin'));
  const found = await nc.resolveBin(['pnpm'], { platform: 'darwin', home, env: { PATH: '/usr/bin:/bin' }, listDir, isExecutable: async (p) => p === '/Users/e/.nvm/versions/node/v20.11.1/bin/pnpm' });
  assert.equal(found, '/Users/e/.nvm/versions/node/v20.11.1/bin/pnpm');
  const win = nc.extraBinDirs({ platform: 'win32', home: 'C:\\Users\\e', env: { LOCALAPPDATA: 'C:\\Users\\e\\AppData\\Local', APPDATA: 'C:\\Users\\e\\AppData\\Roaming', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' } });
  for (const d of ['C:\\nvm4w\\nodejs', 'C:\\Users\\e\\AppData\\Roaming\\fnm\\aliases\\default', 'C:\\Users\\e\\AppData\\Local\\Volta\\bin', 'C:\\Users\\e\\AppData\\Local\\mise\\shims', 'C:\\Users\\e\\.pyenv\\pyenv-win\\shims']) {
    assert.ok(win.includes(d), d);
  }
});

test('finding 3: every spec says whether it is atomic; go -modcache, uv, yarn and pod are not', () => {
  for (const [id, s] of Object.entries(specs.SPECS)) {
    assert.equal(typeof s.atomic, 'boolean', id);
    if (s.autoRun) assert.equal(typeof s.atomicAuto, 'boolean', id);
  }
  for (const id of ['go-modcache', 'uv-cache', 'yarn', 'cocoapods']) assert.equal(specs.isAtomic(specs.specFor(id)), false, id);
  assert.equal(specs.isAtomic(specs.specFor('uv-cache'), 'auto'), false);
  for (const id of ['pnpm', 'go', 'pip', 'gradle', 'homebrew-cache']) assert.equal(specs.isAtomic(specs.specFor(id)), true, id);
});

test('finding 3: go clean -modcache is never killed on timeout: it reports and waits', async () => {
  const lines = [];
  let child;
  const spawn = fakeSpawn((args, c) => {
    if (args.join(' ') === 'clean -modcache') { child = c; return { before: () => new Promise((r) => setTimeout(r, 120)) }; }
    return { code: 1 };
  });
  const r = await nc.runNative(target('go-modcache', [tmp()]), opts({ spawn, timeoutMs: 10, reportAfterMs: 20, measure: sizes(100, 0), onProgress: (p) => lines.push(p) }));
  assert.equal(r.code, 'done', JSON.stringify(r));
  assert.deepEqual(child.signals, [], 'never signalled');
  assert.ok(lines.some((p) => p.phase === 'native-start' && p.atomic === false));
  assert.ok(lines.some((p) => /Still running after .* Spaci waits/.test(p.line || '')));
});

test('finding 3: cancelling does not stop go clean -modcache', async () => {
  const ac = new AbortController();
  let child;
  const spawn = fakeSpawn((args, c) => {
    if (args.join(' ') === 'clean -modcache') { child = c; return { before: () => new Promise((r) => setTimeout(r, 80)) }; }
    return { code: 1 };
  });
  const p = nc.runNative(target('go-modcache', [tmp()]), opts({ spawn, signal: ac.signal, measure: sizes(100, 0) }));
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.code, 'done');
  assert.deepEqual(child.signals, []);
});

test('finding 3: a non-atomic run killed from outside is reported incomplete', async () => {
  const spawn = fakeSpawn((args, c) => {
    if (args.join(' ') === 'clean -modcache') {
      setTimeout(() => { c.exitCode = null; c.emit('close', null, 'SIGKILL'); }, 20);
      return { hang: true };
    }
    return { code: 1 };
  });
  const r = await nc.runNative(target('go-modcache', [tmp()]), opts({ spawn, measure: sizes(100, 60) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'incomplete');
  assert.match(r.message, /^Incomplete: run the clean again before building\. go clean -modcache was stopped \(SIGKILL\)\.$/);
  assert.equal(r.freed, 40);
  const failed = fakeSpawn((args) => (args.join(' ') === 'cache clean' ? { err: ['error: failed to remove file'], code: 2 } : { code: 1 }));
  const u = await nc.runNative(target('uv-cache', [tmp()]), opts({ spawn: failed }));
  assert.equal(u.code, 'incomplete');
  assert.match(u.message, /^Incomplete: run the clean again before building\./);
});

test('finding 4: Windows command lines with quotes, spaces and npm cmd-shim scripts are read right (critic repro)', () => {
  const shim = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" install';
  assert.deepEqual(nc.commandOf(shim), { name: 'pnpm', sub: 'install' });
  assert.deepEqual(nc.commandOf('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs install'), { name: 'pnpm', sub: 'install' });
  assert.deepEqual(nc.commandOf('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" ci'), { name: 'npm', sub: 'ci' });
  assert.deepEqual(nc.commandOf('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Bob Smith\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.js" add x'), { name: 'pnpm', sub: 'add' });
  assert.deepEqual(nc.commandOf('node C:\\Users\\Bob Smith\\AppData\\Roaming\\npm\\node_modules\\yarn\\bin\\yarn.js install'), { name: 'yarn', sub: 'install' });
  assert.deepEqual(nc.commandOf('node /Users/Bob Smith/.nvm/versions/node/v20.1.0/lib/node_modules/pnpm/bin/pnpm.cjs add react'), { name: 'pnpm', sub: 'add' });
  assert.deepEqual(nc.commandOf('/Users/Bob Smith/.local/bin/uv cache clean'), { name: 'uv', sub: 'cache' });
  assert.deepEqual(nc.commandOf('node --max-old-space-size 4096 /opt/homebrew/bin/pnpm install'), { name: 'pnpm', sub: 'install' });
  assert.deepEqual(nc.commandOf('node /Users/b/proj/.yarn/releases/yarn-4.5.0.cjs install'), { name: 'yarn', sub: 'install' });
  // Unchanged: paths after the command are arguments, not part of it.
  assert.deepEqual(nc.commandOf('/usr/bin/go build ./x.sh'), { name: 'go', sub: 'build' });
  assert.deepEqual(nc.commandOf('/usr/local/bin/node /usr/local/bin/npm run dev'), { name: 'npm', sub: 'run' });
  const procs = (a) => ({ ok: true, list: [{ pid: 5, args: a }] });
  assert.equal(nc.checkBusy(specs.SPECS.pnpm, procs(shim), 1).busy, true);
  assert.equal(nc.checkBusy(specs.SPECS.npm, procs('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" install'), 1).busy, true);
  assert.equal(nc.checkBusy(specs.SPECS.yarn, procs('node /Users/b/proj/.yarn/releases/yarn-4.5.0.cjs install'), 1).busy, true);
});

const GRADLE_IDLE = ['   PID STATUS   INFO', ' 82033 IDLE     8.5', ' 81852 STOPPED  (by user or operating system)', '', 'Only Daemons for the current Gradle version are displayed. See https://docs.gradle.org/8.5/userguide/gradle_daemon.html#sec:status'];
const GRADLE_BUSY = ['   PID STATUS   INFO', ' 82033 IDLE     8.5', ' 82190 BUSY     8.5', '', 'Only Daemons for the current Gradle version are displayed.'];

test('finding 5: parseGradleStatus reads idle, busy, none and unreadable output', () => {
  assert.deepEqual(nc.parseGradleStatus(GRADLE_IDLE.join('\n')), { ok: true, daemons: [{ pid: 82033, status: 'IDLE' }, { pid: 81852, status: 'STOPPED' }], busy: [] });
  assert.deepEqual(nc.parseGradleStatus(GRADLE_BUSY.join('\n')).busy, [82190]);
  assert.deepEqual(nc.parseGradleStatus('   PID STATUS   INFO\n 1 CANCELED 8.5\n').busy, [1]);
  assert.deepEqual(nc.parseGradleStatus('No Gradle daemons are running.\n'), { ok: true, daemons: [], busy: [] });
  assert.equal(nc.parseGradleStatus('').ok, false);
  assert.equal(nc.parseGradleStatus('FAILURE: Build failed with an exception.').ok, false);
});

test('finding 5: gradle --stop never runs while a daemon is BUSY, or when its status cannot be read', async () => {
  const dir = tmp();
  for (const [status, why] of [[{ out: GRADLE_BUSY }, /running a build/], [{ code: 1, err: ['boom'] }, /could not read gradle --status/], [{ out: ['garbage'] }, /could not read gradle --status/]]) {
    const deleted = [];
    const spawn = fakeSpawn((args) => (args[0] === '--status' ? status : {}));
    const r = await nc.runNative(target('gradle', [dir]), opts({ spawn, folderJobs: [{ path: dir }], deleteFolders: del(deleted) }));
    assert.equal(r.code, 'busy');
    assert.match(r.message, why);
    assert.ok(!spawn.calls.some((c) => c.args[0] === '--stop'), 'gradle --stop never ran');
    assert.deepEqual(deleted, []);
  }
  const spawn = fakeSpawn((args) => (args[0] === '--status' ? { out: GRADLE_IDLE } : {}));
  const ok = await nc.runNative(target('gradle', [dir]), opts({ spawn, folderJobs: [{ path: dir }], deleteFolders: del([]) }));
  assert.equal(ok.code, 'done');
  const order = spawn.calls.map((c) => c.args[0]);
  assert.ok(order.indexOf('--status') < order.indexOf('--stop'));
});

test('finding 6: a tool that starts while Spaci measures is caught right before its command', async () => {
  let n = 0;
  const snapshot = async () => (++n === 1 ? { ok: true, list: [] } : { ok: true, list: [{ pid: 8, args: '/opt/homebrew/bin/pnpm install' }] });
  const spawn = fakeSpawn((args) => (args.join(' ') === 'store path' ? { out: [tmp()] } : {}));
  const r = await nc.runNative(target('pnpm', [tmp()]), opts({ spawn, snapshot }));
  assert.equal(r.code, 'busy');
  assert.match(r.message, /pnpm is busy/);
  assert.ok(!spawn.calls.some((c) => c.args.join(' ') === 'store prune'));
  // A lock taken while measuring counts too.
  let l = 0;
  const cache = tmp();
  const uvSpawn = fakeSpawn((args) => (args.join(' ') === 'cache dir' ? { out: [cache] } : {}));
  const u = await nc.runNative(target('uv-cache', [cache]), opts({ spawn: uvSpawn, lockHolders: async () => (++l === 1 ? [] : [999]) }));
  assert.equal(u.code, 'busy');
  assert.match(u.message, /holds its cache lock/);
  assert.ok(!uvSpawn.calls.some((c) => c.args.join(' ') === 'cache clean'));
});

test('finding 6: and again right before a folder is emptied', async () => {
  const dir = tmp();
  const deleted = [];
  let n = 0;
  const snapshot = async () => (++n === 1 ? { ok: true, list: [] } : { ok: true, list: [{ pid: 8, args: 'npm install' }, { pid: 9, args: '/Users/e/.local/bin/uv sync' }] });
  const r = await nc.runNative(target('npm', [dir]), opts({ snapshot, folderJobs: [{ path: dir }], deleteFolders: del(deleted) }));
  assert.equal(r.code, 'busy');
  assert.deepEqual(deleted, []);
  // Missing CLI fallback: the same.
  n = 0;
  const u = await nc.runNative(target('uv-cache', [dir]), opts({ bins: [], snapshot, folderJobs: [{ path: dir }], deleteFolders: del(deleted) }));
  assert.equal(u.code, 'busy');
  assert.deepEqual(deleted, []);
  assert.equal(n, 2);
});

test('finding 7: a located or target folder that is root, home, an ancestor of home or /Users is never used', async () => {
  const mac = { platform: 'darwin', home: '/Users/e' };
  for (const bad of ['/', '/Users', '/Users/e', '/users/E/', '/Users/e/..']) assert.equal(nc.pickLocated(bad + '\n', mac), null, bad);
  assert.equal(nc.pickLocated('/Users/e/Library/Caches/go-build\n', mac), '/Users/e/Library/Caches/go-build');
  const win = { platform: 'win32', home: 'C:\\Users\\e' };
  for (const bad of ['C:\\', 'D:\\', 'C:\\Users', 'c:\\users\\E']) assert.equal(nc.pickLocated(bad, win), null, bad);
  // Target paths: a GOCACHE pointing at home would have the folder step empty home.
  const home = tmp();
  const deleted = [];
  const r = await nc.runNative(target('npm', [home]), opts({ home, folderJobs: [{ path: home, mode: 'contents' }], deleteFolders: del(deleted) }));
  assert.equal(r.ok, false);
  assert.match(r.message, /will not empty .*: it is your home folder/);
  assert.deepEqual(deleted, []);
  assert.deepEqual(nc.safePaths(['/', '/Users', '/Users/e', '/Users/e/.npm'], mac), ['/Users/e/.npm']);
});
