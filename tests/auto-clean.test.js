'use strict';
// Auto-clean policy, evidence, process snapshot, staging (move, restore, purge,
// crash recovery) and the whole run. Everything runs on temp folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ac = require('../src/auto-clean');
const historyLog = require('../src/history-log');
const cleaner = require('../src/cleaner');
const scanner = require('../src/scanner');

const DAY = 86400000;
const GB = 1024 ** 3;
const NOW = Date.UTC(2026, 9, 1, 3, 0, 0);

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-ac-'))); }
function write(p, data = 'x') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
function age(p, ms) { const t = new Date(ms); fs.utimesSync(p, t, t); }

// ---------------------------------------------------------------------------
// settings and approval
// ---------------------------------------------------------------------------

test('settings default to off and are clamped', () => {
  const d = ac.sanitizeSettings(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.staleDays, 30);
  assert.equal(d.maxRunBytes, 20 * GB);
  assert.equal(d.approved, null);
  const s = ac.sanitizeSettings({ enabled: 'yes', staleDays: 1, minCacheBytes: -5, maxRunBytes: 1e18, maxItems: 'many', excludes: ['/ok', 'relative', 7, '/ok'], evil: 1 });
  assert.equal(s.enabled, false, 'only true enables');
  assert.equal(s.staleDays, 7);
  assert.equal(s.minCacheBytes, 100 * 1024 ** 2);
  assert.equal(s.maxRunBytes, 2000 * GB);
  assert.equal(s.maxItems, 200);
  assert.deepEqual(s.excludes, ['/ok']);
  assert.equal(s.evil, undefined);
});

test('approval holds only for the rules it was given for', () => {
  const s = ac.sanitizeSettings({ enabled: true });
  assert.equal(ac.isApproved(s), false);
  const approved = { ...s, approved: { at: NOW, rules: ac.rulesFingerprint(s) } };
  assert.equal(ac.isApproved(approved), true);
  assert.equal(ac.isApproved({ ...approved, staleDays: 45 }), false, 'a changed rule needs a new dry run');
  assert.equal(ac.isApproved({ ...approved, enabled: false }), true, 'switching off and on keeps the rules');
});

// ---------------------------------------------------------------------------
// gate: power, idle, busy
// ---------------------------------------------------------------------------

test('gate runs only when enabled, on AC power and idle', () => {
  const on = { enabled: true };
  assert.deepEqual(ac.autoCleanGate({ settings: {} }), { run: false, reason: 'disabled' });
  assert.equal(ac.autoCleanGate({ settings: on, onboarded: false }).reason, 'not-onboarded');
  assert.equal(ac.autoCleanGate({ settings: on, busy: true, onBattery: false, idleSeconds: 9999 }).reason, 'busy');
  assert.equal(ac.autoCleanGate({ settings: on, onBattery: true, idleSeconds: 9999 }).reason, 'on-battery');
  assert.equal(ac.autoCleanGate({ settings: on, onBattery: null, idleSeconds: 9999 }).reason, 'on-battery', 'unknown power is not AC');
  assert.equal(ac.autoCleanGate({ settings: on, onBattery: false, idleSeconds: 30 }).reason, 'not-idle');
  assert.equal(ac.autoCleanGate({ settings: on, onBattery: false, idleSeconds: null }).reason, 'not-idle', 'unknown idle is not idle');
  assert.equal(ac.autoCleanGate({ settings: on, onBattery: false, idleSeconds: 9999, thermalState: 'critical' }).reason, 'thermal');
  assert.deepEqual(ac.autoCleanGate({ settings: on, onBattery: false, idleSeconds: 600 }), { run: true, reason: 'due' });
  assert.equal(ac.autoCleanGate({ settings: { enabled: true, idleMinutes: 30 }, onBattery: false, idleSeconds: 600 }).reason, 'not-idle');
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

const art = (proj, name, size, o = {}) => ({ name, path: proj + '/' + name, size, safe: true, reversible: true, ...o });
const quiet = { ok: true, list: [] };
const noAi = { ok: true, running: [] };

function scenario() {
  const projects = [
    { path: '/code/old', items: [art('/code/old', 'node_modules', 3 * GB), art('/code/old', '.next', GB), art('/code/old', 'dist', 0.5 * GB, { safe: false }), art('/code/old', '.venv', GB, { safe: false })] },
    { path: '/code/recent', items: [art('/code/recent', 'node_modules', 4 * GB)] },
    { path: '/code/ios', items: [art('/code/ios', 'Pods', GB), art('/code/ios', 'DerivedData', GB)] },
  ];
  const system = [
    { id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 5 * GB, existingPaths: ['/h/.npm/_cacache'] },
    { id: 'cargo', name: 'Cargo registry', safe: true, reversible: true, size: 2 * GB, existingPaths: ['/h/.cargo/registry/cache', '/h/.cargo/registry/src'] },
    { id: 'pip', name: 'pip cache', safe: true, reversible: true, size: 0.2 * GB, existingPaths: ['/h/pip'] },
    { id: 'user-caches', name: 'Other app caches', safe: true, reversible: true, size: 9 * GB, existingPaths: ['/h/Library/Caches'] },
    { id: 'trash', name: 'Trash', safe: false, reversible: false, size: 9 * GB, existingPaths: ['/h/.Trash'] },
  ];
  const evidence = new Map([
    ['/code/old', { lastActivity: NOW - 90 * DAY, keep: false }],
    ['/code/recent', { lastActivity: NOW - 2 * DAY, keep: false }],
    ['/code/ios', { lastActivity: NOW - 60 * DAY, keep: false }],
  ]);
  const itemEvidence = new Map();
  for (const p of projects) for (const it of p.items) itemEvidence.set(it.path, { nearFiles: [], keep: false });
  return { projects, system, evidence, itemEvidence };
}
const sel = (over = {}) => {
  const sc = scenario();
  return ac.selectCandidates({ ...sc, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi, ...over });
};
const paths = (r) => r.candidates.map((c) => c.path).sort();

test('only stale projects, only tier A names, only big dev caches', () => {
  const r = sel();
  assert.deepEqual(paths(r), ['/code/old/.next', '/code/old/node_modules', '/h/.cargo/registry/cache', '/h/.cargo/registry/src', '/h/.npm/_cacache'].sort());
  const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.match(why['/code/recent/node_modules'], /Used in the last 30 days/);
  assert.match(why['/code/ios/Pods'], /Podfile\.lock/);
  assert.match(why['/code/ios/DerivedData'], /leaves this kind of folder to you/);
  assert.match(why['/h/pip'], /Smaller than/);
  assert.equal(why['/code/old/dist'], undefined, 'unverified items are not even candidates');
  assert.ok(!r.candidates.some((c) => c.path.includes('Library/Caches') || c.path.includes('.Trash')), 'tier B and C never');
  assert.equal(r.count, 4, 'cargo counts once');
  assert.equal(r.bytes, 3 * GB + GB + 5 * GB + 2 * GB);
});

test('Pods with a Podfile.lock beside it is allowed', () => {
  const sc = scenario();
  sc.itemEvidence.set('/code/ios/Pods', { nearFiles: ['Podfile', 'Podfile.lock'], keep: false });
  const r = ac.selectCandidates({ ...sc, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi });
  assert.ok(paths(r).includes('/code/ios/Pods'));
});

test('staleness honours the setting and missing evidence', () => {
  assert.ok(!paths(sel({ settings: { enabled: true, staleDays: 120 } })).includes('/code/old/node_modules'));
  const sc = scenario();
  sc.evidence.set('/code/old', { lastActivity: null, keep: false });
  const r = ac.selectCandidates({ ...sc, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi });
  assert.ok(!paths(r).includes('/code/old/node_modules'), 'inconclusive walk: skip');
  sc.evidence.delete('/code/old');
  assert.ok(!paths(ac.selectCandidates({ ...sc, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi })).includes('/code/old/node_modules'));
});

test('.spaci-keep, excludes and cloud or external folders are respected', () => {
  const sc = scenario();
  sc.evidence.set('/code/old', { lastActivity: NOW - 90 * DAY, keep: true });
  assert.ok(!paths(ac.selectCandidates({ ...sc, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi })).some((p) => p.startsWith('/code/old')));
  const sc2 = scenario();
  sc2.itemEvidence.set('/code/old/.next', { nearFiles: [], keep: true });
  const r2 = ac.selectCandidates({ ...sc2, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi });
  assert.ok(!paths(r2).includes('/code/old/.next'));
  assert.ok(paths(r2).includes('/code/old/node_modules'));
  assert.ok(!paths(sel({ settings: { enabled: true, excludes: ['/code'] } })).some((p) => p.startsWith('/code')));
  assert.ok(!paths(sel({ settings: { enabled: true, excludes: ['/h/.npm'] } })).includes('/h/.npm/_cacache'));
  const sc3 = scenario();
  sc3.projects[0].path = '/Users/a/Library/Mobile Documents/com~apple~CloudDocs/old';
  sc3.projects[0].items.forEach((it) => { it.path = sc3.projects[0].path + '/' + it.name; });
  sc3.evidence.set(sc3.projects[0].path, { lastActivity: NOW - 90 * DAY, keep: false });
  const r3 = ac.selectCandidates({ ...sc3, settings: { enabled: true }, now: NOW, procs: quiet, aiTools: noAi });
  assert.ok(!paths(r3).some((p) => p.includes('Mobile Documents')));
  assert.ok(r3.skipped.some((s) => /cloud-synced/.test(s.reason)));
});

test('never while the owning tool runs; an inconclusive check skips', () => {
  // Process check failed: nothing at all.
  assert.deepEqual(sel({ procs: { ok: false, list: [] } }).candidates, []);
  // node running with its cwd in the project keeps that project.
  const inProj = sel({ procs: { ok: true, list: [{ pid: 1, names: ['node'], cwd: '/code/old/packages/web' }] } });
  assert.ok(!paths(inProj).some((p) => p.startsWith('/code/old')));
  assert.ok(paths(inProj).includes('/h/.npm/_cacache'), 'plain node does not own the npm cache');
  // A dev process whose cwd is unknown makes every project inconclusive.
  assert.ok(!paths(sel({ procs: { ok: true, list: [{ pid: 1, names: ['cargo'], cwd: null }] } })).some((p) => p.startsWith('/code')));
  // npm (as `node npm-cli.js`) keeps the npm cache; cargo keeps the registry.
  const npm = sel({ procs: { ok: true, list: [{ pid: 2, names: ['node', 'npm'], cwd: '/elsewhere' }] } });
  assert.ok(!paths(npm).includes('/h/.npm/_cacache'));
  assert.ok(paths(npm).includes('/code/old/node_modules'), 'npm elsewhere does not keep this project');
  const cargo = sel({ procs: { ok: true, list: [{ pid: 3, names: ['cargo'], cwd: '/elsewhere' }] } });
  assert.ok(!paths(cargo).some((p) => p.includes('.cargo')));
  // An AI coding tool running keeps every project (reuses aitools' check).
  const ai = sel({ aiTools: { ok: true, running: ['claude'] } });
  assert.ok(!paths(ai).some((p) => p.startsWith('/code')));
  assert.ok(paths(ai).includes('/h/.npm/_cacache'));
});

test('caps: size and item count, biggest first, a cache\'s paths stay together', () => {
  const r = sel({ settings: { enabled: true, maxRunBytes: 6 * GB } });
  // npm (5 GB) fits, node_modules (3 GB) would exceed, cargo 2 GB would too, .next 1 GB fits.
  assert.deepEqual(paths(r), ['/code/old/.next', '/h/.npm/_cacache']);
  assert.ok(r.skipped.some((s) => s.cap && s.path === '/code/old/node_modules'));
  const r2 = sel({ settings: { enabled: true, maxItems: 2 } });
  assert.equal(r2.count, 2);
  assert.deepEqual(paths(r2), ['/code/old/node_modules', '/h/.npm/_cacache']);
  const r3 = sel({ settings: { enabled: true, maxItems: 3 } });
  const cargo = r3.candidates.filter((c) => c.target === 'cargo');
  assert.equal(cargo.length, 2);
  assert.equal(cargo[0].bytes + cargo[1].bytes, 2 * GB);
});

// ---------------------------------------------------------------------------
// evidence from disk
// ---------------------------------------------------------------------------

test('project evidence ignores build output and sees git activity', async () => {
  const root = tmp();
  const proj = path.join(root, 'app');
  write(path.join(proj, 'src', 'index.js'));
  write(path.join(proj, 'package.json'));
  write(path.join(proj, 'node_modules', 'x', 'index.js'));
  write(path.join(proj, '.git', 'HEAD'));
  const old = NOW - 100 * DAY;
  for (const p of ['src/index.js', 'src', 'package.json', '.git/HEAD', '.git', 'node_modules/x/index.js', 'node_modules/x', 'node_modules', '']) age(path.join(proj, p), old);
  // A fresh install inside node_modules does not make the project "used".
  age(path.join(proj, 'node_modules', 'x', 'index.js'), NOW);
  let ev = await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY });
  assert.equal(ev.keep, false);
  assert.ok(ev.lastActivity <= old + 1000, 'stale');
  // A commit touches .git/HEAD.
  age(path.join(proj, '.git', 'HEAD'), NOW - DAY);
  ev = await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY });
  assert.ok(NOW - ev.lastActivity < 30 * DAY);
  age(path.join(proj, '.git', 'HEAD'), old);
  // An edited source file counts.
  age(path.join(proj, 'src', 'index.js'), NOW - 3 * DAY);
  ev = await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY });
  assert.ok(NOW - ev.lastActivity < 30 * DAY);
  age(path.join(proj, 'src', 'index.js'), old);
  // Too big to walk within budget: inconclusive.
  ev = await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY, budget: 1 });
  assert.equal(ev.lastActivity, null);
  // Keep marker.
  write(path.join(proj, '.spaci-keep'));
  ev = await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY });
  assert.equal(ev.keep, true);
  const it = await ac.itemEvidence(path.join(proj, 'node_modules'));
  assert.equal(it.keep, true, 'a keep marker beside the folder counts');
  assert.ok(it.nearFiles.includes('package.json'));
  assert.equal(await ac.itemEvidence(path.join(root, 'nope', 'x')), null);
});

// ---------------------------------------------------------------------------
// process snapshot
// ---------------------------------------------------------------------------

test('process snapshot parses ps and lsof, and fails closed', async () => {
  const fakeExec = (outputs) => (cmd, args, opts, cb) => {
    const o = outputs[cmd];
    if (!o) return cb(new Error('no ' + cmd), '');
    return cb(o.err || null, o.stdout);
  };
  const ps = '  10 501 /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js install\n  11 501 /Applications/Safari.app/Contents/MacOS/Safari\n  12 501 cargo build --release\n  13 501 /opt/homebrew/bin/node server.mjs\n  14 0 /usr/local/bin/node /opt/daemon.js\n';
  const lsof = 'p10\nfcwd\nn/code/a\np12\nfcwd\nn/code/b\np13\nfcwd\nn/code/c\n';
  const snap = await ac.snapshotProcesses({ platform: 'darwin', exec: fakeExec({ ps: { stdout: ps }, lsof: { stdout: lsof } }), selfPid: 1, uid: 501 });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.list.map((p) => [p.pid, p.names, p.cwd]), [
    [10, ['node', 'npm'], '/code/a'],
    [12, ['cargo'], '/code/b'],
    [13, ['node', 'server'], '/code/c'],
  ], 'root\'s node daemon (uid 0) is not ours');
  const failed = await ac.snapshotProcesses({ platform: 'darwin', exec: fakeExec({ ps: { err: new Error('boom'), stdout: '' } }) });
  assert.deepEqual(failed, { ok: false, list: [] });
  const none = await ac.snapshotProcesses({ platform: 'darwin', exec: fakeExec({ ps: { stdout: '  11 501 /Applications/Safari.app/Contents/MacOS/Safari\n' } }), uid: 501 });
  assert.deepEqual(none, { ok: true, list: [] });
  // lsof failing outright leaves cwd unknown, which selection treats as "skip".
  const noLsof = await ac.snapshotProcesses({ platform: 'darwin', exec: fakeExec({ ps: { stdout: ps }, lsof: { err: new Error('x'), stdout: '' } }), uid: 501 });
  assert.ok(noLsof.list.length === 3 && noLsof.list.every((p) => p.cwd === null));
  // lsof answering for some pids only: the rest stay unknown (projects get skipped).
  const partial = await ac.snapshotProcesses({ platform: 'darwin', exec: fakeExec({ ps: { stdout: ps }, lsof: { err: new Error('exit 1'), stdout: 'p10\nn/code/a\n' } }), uid: 501 });
  assert.deepEqual(partial.list.map((p) => p.cwd), ['/code/a', null, null]);
  const lin = await ac.snapshotProcesses({ platform: 'linux', exec: fakeExec({ ps: { stdout: '  20 1000 node x.js\n' } }), fs: { promises: { readlink: async () => '/code/l' } }, uid: 1000 });
  assert.deepEqual(lin.list.map((p) => p.cwd), ['/code/l']);
  const win = await ac.snapshotProcesses({ platform: 'win32', exec: fakeExec({ tasklist: { stdout: '"node.exe","30","Console","1","10 K"\r\n"explorer.exe","31","Console","1","10 K"\r\n' } }) });
  assert.deepEqual(win.list.map((p) => [p.names[0], p.cwd]), [['node', null]]);
});

// ---------------------------------------------------------------------------
// staging: move, restore, purge
// ---------------------------------------------------------------------------

function mkStaging(root, over = {}) {
  let t = over.start || NOW;
  const st = ac.createStaging({
    root, now: () => t, removeTree: (p) => cleaner.deletePath(p), log: { warn() {}, error() {} }, ...over,
  });
  return { st, setNow: (v) => { t = v; }, now: () => t };
}

test('stage moves into the run and restore puts it back', () => {
  const root = tmp();
  const nm = path.join(root, 'proj', 'node_modules');
  write(path.join(nm, 'a', 'index.js'), 'A');
  const { st } = mkStaging(path.join(root, '.cache', 'staging'));
  const m = st.beginRun('run-000001');
  const r = st.stage(m, nm, { bytes: 1234, kind: 'artifact', project: path.join(root, 'proj') });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(nm), false);
  assert.equal(fs.readFileSync(path.join(r.entry.dst, 'a', 'index.js'), 'utf8'), 'A');
  const man = st.readManifest('run-000001');
  assert.equal(man.entries[0].state, 'moved');
  assert.equal(st.status('run-000001').canUndo, true);
  assert.equal(st.status('run-000001').heldBytes, 1234);
  const back = st.restore('run-000001');
  assert.equal(back.ok, true);
  assert.equal(back.restored.length, 1);
  assert.equal(fs.readFileSync(path.join(nm, 'a', 'index.js'), 'utf8'), 'A');
  assert.equal(st.status('run-000001').canUndo, false);
  assert.equal(st.restore('run-000001').restored.length, 0, 'a second undo does nothing');
});

test('stage refuses symlinks, missing paths and other volumes', () => {
  const root = tmp();
  const target = path.join(root, 'real');
  write(path.join(target, 'f'));
  fs.symlinkSync(target, path.join(root, 'link'));
  const { st } = mkStaging(path.join(root, 'staging'));
  const m = st.beginRun('run-000002');
  assert.equal(st.stage(m, path.join(root, 'link')).code, 'ELINK');
  assert.equal(st.stage(m, path.join(root, 'gone')).ok, false);
  // A different device: the fs reports another dev for the item.
  const fakeFs = Object.assign(Object.create(fs), {
    lstatSync: (p, o) => { const s = fs.lstatSync(p, o); return p === target ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { dev: s.dev + 1, isSymbolicLink: () => false }) : s; },
  });
  const { st: st2 } = mkStaging(path.join(root, 'staging'), { fs: fakeFs });
  const m2 = st2.beginRun('run-000003');
  const r = st2.stage(m2, target);
  assert.equal(r.code, 'EXDEV');
  assert.ok(fs.existsSync(path.join(target, 'f')), 'left in place');
});

test('undo keeps a rebuilt folder and never recreates a deleted project', () => {
  const root = tmp();
  const a = path.join(root, 'a', 'node_modules');
  const b = path.join(root, 'b', 'node_modules');
  write(path.join(a, 'old'), 'old');
  write(path.join(b, 'old'), 'old');
  const { st } = mkStaging(path.join(root, 'staging'));
  const m = st.beginRun('run-000004');
  st.stage(m, a, { bytes: 10 });
  st.stage(m, b, { bytes: 20 });
  write(path.join(a, 'new'), 'new'); // user reinstalled
  fs.rmSync(path.join(root, 'b'), { recursive: true }); // user deleted the project
  const r = st.restore('run-000004');
  assert.equal(r.restored.length, 0);
  assert.equal(r.conflicts.length, 2);
  assert.equal(fs.readFileSync(path.join(a, 'new'), 'utf8'), 'new', 'the rebuilt one is not overwritten');
  assert.equal(fs.existsSync(path.join(root, 'b')), false, 'not recreated');
  assert.equal(st.status('run-000004').held, 2, 'conflicts stay staged until purge');
});

test('undo is refused after 24 hours and purge frees everything then', async () => {
  const root = tmp();
  const nm = path.join(root, 'p', 'node_modules');
  write(path.join(nm, 'f'), 'x'.repeat(5000));
  const stagingRoot = path.join(root, 'staging');
  const { st, setNow } = mkStaging(stagingRoot);
  const m = st.beginRun('run-000005');
  st.stage(m, nm, { bytes: 5000 });
  assert.deepEqual(await st.purge(), [], 'nothing expired yet');
  setNow(NOW + ac.STAGING_TTL_MS + 1);
  assert.match(st.restore('run-000005').error, /24 hours/);
  const done = await st.purge();
  assert.equal(done.length, 1);
  assert.equal(done[0].bytes, 5000);
  assert.equal(fs.existsSync(path.join(stagingRoot, 'run-000005')), false);
  assert.equal(fs.existsSync(nm), false);
});

test('a fully restored run is cleaned up without waiting', async () => {
  const root = tmp();
  const nm = path.join(root, 'p', 'node_modules');
  write(path.join(nm, 'f'));
  const { st } = mkStaging(path.join(root, 'staging'));
  const m = st.beginRun('run-000006');
  st.stage(m, nm, { bytes: 1 });
  st.restore('run-000006');
  const done = await st.purge();
  assert.equal(done.length, 1);
  assert.equal(done[0].bytes, 0);
  assert.ok(fs.existsSync(path.join(nm, 'f')), 'the restored item is untouched');
});

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

/** An fs whose Nth manifest rename throws, as if the process died there. */
function crashingFs(crashAt) {
  let renames = 0;
  return Object.assign(Object.create(fs), {
    renameSync(a, b) {
      const isManifest = String(b).endsWith('manifest.json');
      if (isManifest && ++renames === crashAt) { const e = new Error('CRASH'); e.crash = true; throw e; }
      return fs.renameSync(a, b);
    },
  });
}

test('crash after the rename, before the journal says moved: recovered as moved, undo works', () => {
  const root = tmp();
  const nm = path.join(root, 'p', 'node_modules');
  write(path.join(nm, 'f'), 'data');
  const stagingRoot = path.join(root, 'staging');
  // Manifest writes: 1 beginRun, 2 intent 'moving', 3 'moved' <- crash here.
  const { st } = mkStaging(stagingRoot, { fs: crashingFs(3) });
  const m = st.beginRun('run-000007');
  const r = st.stage(m, nm, { bytes: 4 });
  assert.equal(r.ok, true, 'the move itself happened');
  const onDisk = JSON.parse(fs.readFileSync(path.join(stagingRoot, 'run-000007', 'manifest.json'), 'utf8'));
  assert.equal(onDisk.entries[0].state, 'moving', 'journal still says moving');
  // Next launch.
  const { st: again } = mkStaging(stagingRoot);
  again.recover();
  assert.equal(again.readManifest('run-000007').entries[0].state, 'moved');
  assert.equal(again.restore('run-000007').restored.length, 1);
  assert.equal(fs.readFileSync(path.join(nm, 'f'), 'utf8'), 'data');
});

test('crash after the intent, before the rename: recovered as never moved', () => {
  const root = tmp();
  const nm = path.join(root, 'p', 'node_modules');
  write(path.join(nm, 'f'));
  const stagingRoot = path.join(root, 'staging');
  const { st } = mkStaging(stagingRoot);
  const m = st.beginRun('run-000008');
  // Write the intent by hand, exactly as stage() does, then "die".
  m.entries.push({ n: 1, src: nm, dst: path.join(stagingRoot, 'run-000008', 'items', '1', 'node_modules'), bytes: 1, state: 'moving' });
  ac.writeJsonDurable(fs, path.join(stagingRoot, 'run-000008', 'manifest.json'), m);
  const { st: again } = mkStaging(stagingRoot);
  again.recover();
  const e = again.readManifest('run-000008').entries[0];
  assert.equal(e.state, 'skipped');
  assert.ok(fs.existsSync(path.join(nm, 'f')), 'still in place');
  assert.equal(again.status('run-000008').canUndo, false);
});

test('crash in the middle of an undo: recovered, and the undo can be finished', () => {
  const root = tmp();
  const a = path.join(root, 'a', 'node_modules');
  const b = path.join(root, 'b', 'node_modules');
  write(path.join(a, 'f'), 'A');
  write(path.join(b, 'f'), 'B');
  const stagingRoot = path.join(root, 'staging');
  const { st } = mkStaging(stagingRoot);
  const m = st.beginRun('run-000009');
  st.stage(m, a, { bytes: 1 });
  st.stage(m, b, { bytes: 1 });
  // Undo writes: 1 'restoring' run, 2 entry a 'restoring', 3 entry a 'restored' <- crash.
  const { st: crashy } = mkStaging(stagingRoot, { fs: crashingFs(3) });
  assert.throws(() => crashy.restore('run-000009'), /CRASH/);
  assert.equal(fs.readFileSync(path.join(a, 'f'), 'utf8'), 'A', 'a was put back before the crash');
  const { st: again } = mkStaging(stagingRoot);
  again.recover();
  const man = again.readManifest('run-000009');
  assert.equal(man.entries[0].state, 'restored');
  assert.equal(man.entries[1].state, 'moved');
  assert.equal(man.state, 'active', 'b can still be undone');
  const r = again.restore('run-000009');
  assert.equal(r.restored.length, 1);
  assert.equal(fs.readFileSync(path.join(b, 'f'), 'utf8'), 'B');
});

test('crash in the middle of a purge resumes; an unreadable manifest is never purged', async () => {
  const root = tmp();
  const nm = path.join(root, 'p', 'node_modules');
  write(path.join(nm, 'f'));
  const stagingRoot = path.join(root, 'staging');
  const { st, setNow } = mkStaging(stagingRoot);
  const m = st.beginRun('run-000010');
  st.stage(m, nm, { bytes: 1 });
  // Purge dies after marking 'purging' (removeTree throws).
  setNow(NOW + ac.STAGING_TTL_MS + 5);
  const { st: dying } = mkStaging(stagingRoot, { start: NOW + ac.STAGING_TTL_MS + 5, removeTree: async () => { throw new Error('killed'); } });
  assert.deepEqual(await dying.purge(), []);
  assert.equal(st.readManifest('run-000010').state, 'purging');
  // Even an undo attempt now is refused: the run is half gone.
  assert.match(st.restore('run-000010').error, /cannot be undone/);
  assert.equal((await st.purge()).length, 1);
  assert.equal(fs.existsSync(path.join(stagingRoot, 'run-000010')), false);
  // Unknown data under staging is left alone.
  write(path.join(stagingRoot, 'run-000011', 'items', '1', 'x'));
  write(path.join(stagingRoot, 'run-000011', 'manifest.json'), '{not json');
  assert.deepEqual(st.recover(), [{ runId: 'run-000011', state: 'unreadable' }]);
  await st.purge({ force: true });
  assert.ok(fs.existsSync(path.join(stagingRoot, 'run-000011', 'items', '1', 'x')));
});

test('the staging folder is invisible to the project scan', async () => {
  const root = tmp();
  // A staged project's node_modules and a staged cargo crate with a manifest.
  const staged = path.join(root, '.cache', 'auto-clean-staging', 'run-000012', 'items');
  write(path.join(staged, '1', 'node_modules', 'left-pad', 'package.json'), '{}');
  write(path.join(staged, '2', 'serde-1.0', 'Cargo.toml'), '[package]');
  write(path.join(staged, '2', 'serde-1.0', 'target', 'x'));
  write(path.join(root, 'real', 'package.json'), '{}');
  write(path.join(root, 'real', 'node_modules', 'x', 'index.js'));
  const { projects } = await scanner.scanProjects(root, null, new AbortController().signal);
  assert.deepEqual(projects.map((p) => path.basename(p.path)), ['real']);
});

// ---------------------------------------------------------------------------
// the whole run
// ---------------------------------------------------------------------------

function harness() {
  const root = tmp();
  const proj = path.join(root, 'code', 'old');
  const nm = path.join(proj, 'node_modules');
  write(path.join(nm, 'dep', 'index.js'), 'dep');
  write(path.join(proj, 'package.json'), '{}');
  write(path.join(proj, 'package-lock.json'), '{}');
  const cache = path.join(root, 'home', '.npm', '_cacache');
  write(path.join(cache, 'content-v2', 'blob'), 'b');
  write(path.join(cache, 'index-v5', 'idx'), 'i');
  const stagingRoot = path.join(root, 'userData', '.cache', 'auto-clean-staging');
  const staging = ac.createStaging({ root: stagingRoot, now: () => h.now, removeTree: (p) => cleaner.deletePath(p), log: { warn() {}, error() {} } });
  const h = {
    root, proj, nm, cache, staging, now: NOW,
    settings: { enabled: true },
    history: [],
    notes: [],
    ids: 0,
  };
  h.scan = {
    projects: [{ path: proj, items: [{ name: 'node_modules', path: nm, size: 2 * GB, safe: true, reversible: true }] }],
    system: [{ id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 3 * GB, existingPaths: [cache] }],
  };
  h.deps = {
    getSettings: () => h.settings,
    saveSettings: (s) => { h.settings = s; },
    getScan: () => h.scan,
    gatherEvidence: async (projects) => {
      const evidence = new Map(projects.map((p) => [p.path, { lastActivity: NOW - 90 * DAY, keep: false }]));
      const itemEvidence = new Map();
      for (const p of projects) for (const it of p.items) itemEvidence.set(it.path, await ac.itemEvidence(it.path));
      return { evidence, itemEvidence };
    },
    snapshot: async () => ({ ok: true, list: [] }),
    aiToolStatus: async () => ({ ok: true, running: [] }),
    guard: async (jobs) => ({ allowed: jobs, refused: [] }),
    staging,
    historyLog,
    putHistory: (e) => { h.history = historyLog.upsertEntry(h.history, e); },
    notify: (title, body) => h.notes.push({ title, body }),
    listChildren: (dir) => fs.promises.readdir(dir),
    restoreHint: (c) => (c.kind === 'artifact' ? 'npm ci' : null),
    now: () => h.now,
    newId: () => 'id-' + String(++h.ids).padStart(6, '0'),
  };
  return h;
}

test('first run is a dry run: nothing moves, one preview entry, one notification', async () => {
  const h = harness();
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.count, 2);
  assert.ok(fs.existsSync(path.join(h.nm, 'dep', 'index.js')), 'nothing moved');
  assert.ok(fs.existsSync(path.join(h.cache, 'content-v2', 'blob')));
  assert.equal(h.history.length, 1);
  const e = h.history[0];
  assert.equal(e.v, 2);
  assert.equal(e.scope, 'auto-clean');
  assert.equal(e.autoClean.dryRun, true);
  assert.equal(e.autoClean.previewCount, 2);
  assert.equal(e.autoClean.previewBytes, 5 * GB);
  assert.equal(e.freed, 0);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /Nothing was removed/);
  assert.equal(h.settings.pendingPreview, e.id);
});

test('an approved run stages, logs history v2, notifies once, and undo restores', async () => {
  const h = harness();
  h.settings = { enabled: true, approved: { at: NOW, rules: ac.rulesFingerprint({ enabled: true }) } };
  let stagedPaths = null;
  h.deps.onStaged = (p) => { stagedPaths = p; };
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 2);
  assert.equal(r.bytes, 5 * GB);
  assert.equal(fs.existsSync(h.nm), false, 'node_modules moved away');
  assert.ok(fs.existsSync(h.cache), 'the cache folder itself stays');
  assert.deepEqual(fs.readdirSync(h.cache), [], 'its contents moved');
  assert.deepEqual(stagedPaths.sort(), [h.cache, h.nm].sort());
  const e = h.history.find((x) => x.id === r.runId);
  assert.equal(e.status, 'done');
  assert.equal(e.autoClean.runId, r.runId);
  assert.equal(e.autoClean.stagedBytes, 5 * GB);
  assert.equal(e.freed, 0, 'staged space is not freed yet');
  assert.equal(e.trashedBytes, 5 * GB);
  assert.ok(e.items.every((it) => it.outcome === 'trashed' && it.reversible === 'rebuild'));
  assert.match(e.items.find((it) => it.path === h.nm).restoreHint, /Undo from History.*npm ci/);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].body, /Undo it from History/);
  // Staging holds the size once, on the first moved cache child.
  assert.equal(h.staging.status(r.runId).heldBytes, 5 * GB);
  const back = h.staging.restore(r.runId);
  assert.equal(back.restored.length, 3, 'node_modules and both cache children');
  assert.equal(fs.readFileSync(path.join(h.nm, 'dep', 'index.js'), 'utf8'), 'dep');
  assert.equal(fs.readFileSync(path.join(h.cache, 'content-v2', 'blob'), 'utf8'), 'b');
});

test('a run stops at the first failure and when the machine is no longer idle', async () => {
  const h = harness();
  h.settings = { enabled: true, approved: { at: NOW, rules: ac.rulesFingerprint({ enabled: true }) } };
  let calls = 0;
  h.deps.stillOk = () => (++calls > 1 ? 'you started using the computer.' : null);
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.status, 'partial');
  assert.equal(r.count, 1);
  const e = h.history.find((x) => x.id === r.runId);
  const failed = e.items.filter((it) => it.outcome === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /started using the computer/);

  const h2 = harness();
  h2.settings = h.settings;
  // node_modules (the biggest? no: npm cache 3 GB goes first) fails to move.
  h2.deps.listChildren = async () => { const e2 = new Error('denied'); e2.code = 'EACCES'; throw e2; };
  const r2 = await ac.runAutoClean(h2.deps);
  assert.equal(r2.status, 'partial');
  assert.equal(r2.count, 0);
  assert.ok(fs.existsSync(path.join(h2.nm, 'dep', 'index.js')), 'nothing after the failure moved');
  assert.match(h2.notes[0].body, /stopped/);
});

test('the guard is authoritative: refused jobs are logged and never moved', async () => {
  const h = harness();
  h.settings = { enabled: true, approved: { at: NOW, rules: ac.rulesFingerprint({ enabled: true }) } };
  h.deps.guard = async (jobs) => ({ allowed: jobs.filter((j) => j.path !== h.nm), refused: [{ path: h.nm, reason: 'git tracks files inside it.' }] });
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.count, 1);
  assert.ok(fs.existsSync(h.nm));
  const e = h.history.find((x) => x.id === r.runId);
  assert.equal(e.refusedCount, 1);
  assert.equal(e.items.find((it) => it.path === h.nm).reason, 'git tracks files inside it.');
});

test('a disabled auto-clean never runs', async () => {
  const h = harness();
  h.settings = { enabled: false };
  assert.deepEqual(await ac.runAutoClean(h.deps), { status: 'skipped', reason: 'disabled' });
  assert.equal(h.history.length, 0);
});
