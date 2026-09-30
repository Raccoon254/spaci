'use strict';
// Regression tests for the auto-clean safety review (Spaci 2.3). One section
// per finding; each drives the real code on temp folders, never on real user
// files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ac = require('../src/auto-clean');
const historyLog = require('../src/history-log');
const cleaner = require('../src/cleaner');

const DAY = 86400000;
const GB = 1024 ** 3;
const NOW = Date.UTC(2026, 9, 1, 3, 0, 0);
const APPROVED = { enabled: true, approved: { at: NOW, rules: ac.rulesFingerprint({ enabled: true }), previewId: 'prev-000001' } };

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-acs-'))); }
function write(p, data = 'x') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
function age(p, ms) { const t = new Date(ms); fs.utimesSync(p, t, t); }
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const quiet = { ok: true, list: [] };
/**
 * Make `dir` impossible to rename, the way real caches get stuck, until the
 * returned function is called. POSIX: a read-only directory (like a root-owned
 * ~/.npm/_cacache/content-v2), whose own '..' entry cannot change. Windows
 * ignores directory modes for rename; there a folder holding an open file
 * cannot move (npm or an antivirus scanner holding a cache file open).
 */
function pin(dir) {
  if (process.platform === 'win32') {
    const fd = fs.openSync(path.join(dir, 'f'), 'r');
    return () => fs.closeSync(fd);
  }
  fs.chmodSync(dir, 0o555);
  return () => fs.chmodSync(dir, 0o755);
}
const noAi = { ok: true, running: [] };

/** A run over one npm cache (and optionally one project), on temp folders. */
function harness({ children = ['a', 'b'], project = false } = {}) {
  const root = tmp();
  const cache = path.join(root, 'home', '.npm', '_cacache');
  for (const c of children) write(path.join(cache, c, 'f'), c);
  const proj = path.join(root, 'code', 'old');
  const nm = path.join(proj, 'node_modules');
  if (project) { write(path.join(nm, 'dep', 'index.js'), 'dep'); write(path.join(proj, 'package.json'), '{}'); }
  const staging = ac.createStaging({ root: path.join(root, 'userData', '.cache', 'auto-clean-staging'), now: () => NOW, removeTree: (p) => cleaner.deletePath(p), log: { warn() {}, error() {} } });
  const h = { root, cache, proj, nm, staging, settings: { ...APPROVED }, history: [], notes: [], ids: 0 };
  h.scan = {
    projects: project ? [{ path: proj, items: [{ name: 'node_modules', path: nm, size: GB, safe: true, reversible: true }] }] : [],
    system: [{ id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 2 * GB, existingPaths: [cache] }],
  };
  h.deps = {
    getSettings: () => h.settings,
    saveSettings: (s) => { h.settings = s; },
    getScan: () => h.scan,
    gatherEvidence: async (projects) => {
      const evidence = new Map(projects.map((p) => [p.path, { lastActivity: NOW - 90 * DAY, keep: false, compose: false }]));
      const itemEvidence = new Map();
      for (const p of projects) for (const it of p.items) itemEvidence.set(it.path, await ac.itemEvidence(it.path));
      return { evidence, itemEvidence };
    },
    snapshot: async () => quiet,
    aiToolStatus: async () => noAi,
    dockerStatus: async () => ({ ok: true, running: 0 }),
    cloudCheck: async () => new Map(),
    guard: async (jobs) => ({ allowed: jobs, refused: [] }),
    staging,
    historyLog,
    putHistory: (e) => { h.history = historyLog.upsertEntry(h.history, e); },
    notify: (title, body) => h.notes.push({ title, body }),
    listChildren: async (dir) => (await fs.promises.readdir(dir)).sort(),
    now: () => NOW,
    newId: () => 'id-' + String(++h.ids).padStart(6, '0'),
  };
  h.entry = (id) => h.history.find((x) => x.id === id);
  return h;
}

// ---------------------------------------------------------------------------
// 1. partial staging of a cache's children
// ---------------------------------------------------------------------------

test('finding 1: a cache whose later child cannot move is rolled back, logged as failed, and nothing is purged', { skip: isRoot && 'root can rename anything' }, async () => {
  const h = harness();
  // b cannot be renamed (see pin).
  const unpin = pin(path.join(h.cache, 'b'));
  try {
    const r = await ac.runAutoClean(h.deps);
    assert.equal(r.status, 'partial');
    assert.equal(r.count, 0);
    assert.deepEqual(fs.readdirSync(h.cache).sort(), ['a', 'b'], 'a was put back');
    assert.equal(fs.readFileSync(path.join(h.cache, 'a', 'f'), 'utf8'), 'a');
    const man = h.staging.readManifest(r.runId);
    assert.ok(!man.entries.some((e) => e.state === 'moved'), 'nothing left staged, so the purge deletes nothing');
    assert.equal(man.entries.find((e) => e.src.endsWith(path.sep + 'a')).state, 'restored');
    const e = h.entry(r.runId);
    assert.equal(e.items[0].outcome, 'failed');
    assert.equal(e.trashedBytes, 0);
    assert.match(h.notes[0].body, /stopped before moving anything/);
    // Even past 24 hours the purge finds nothing to free.
    const done = await h.staging.purge({ force: true });
    assert.equal(done[0].bytes, 0);
    assert.deepEqual(fs.readdirSync(h.cache).sort(), ['a', 'b']);
  } finally {
    unpin();
  }
});

test('finding 1: when the roll back itself fails, what stayed staged is logged as trashed and partial so Undo shows', { skip: isRoot && 'root can rename anything' }, async () => {
  const h = harness();
  const unpin = pin(path.join(h.cache, 'b'));
  // npm writes a new "a" right after the old one moved: it cannot go back.
  const stage = h.staging.stage;
  h.staging.stage = (m, src, info) => {
    const r = stage(m, src, info);
    if (r.ok && path.basename(src) === 'a') write(path.join(src, 'new'), 'new');
    return r;
  };
  try {
    const r = await ac.runAutoClean(h.deps);
    assert.equal(r.status, 'partial');
    assert.equal(r.count, 1, 'the manifest holds one item');
    const e = h.entry(r.runId);
    const it = e.items.find((x) => x.path === h.cache);
    assert.equal(it.outcome, 'trashed');
    assert.equal(it.partial, true);
    assert.match(it.reason, /Partly moved/);
    assert.equal(it.bytes, 0, 'the size of the part is unknown, so none is claimed');
    assert.equal(h.staging.status(r.runId).canUndo, true);
    assert.equal(h.staging.status(r.runId).heldBytes, 0);
    assert.match(h.notes[0].body, /Moved 1 item aside/);
    assert.match(h.notes[0].body, /Undo it from History/);
    assert.doesNotMatch(h.notes[0].body, /stopped before moving anything/);
  } finally {
    unpin();
  }
});

test('finding 1: unstage journals the roll back so a crash is recoverable', () => {
  const root = tmp();
  const src = path.join(root, 'c', 'x');
  write(path.join(src, 'f'));
  const st = ac.createStaging({ root: path.join(root, 'stg'), now: () => NOW, removeTree: async () => {}, log: {} });
  const m = st.beginRun('run-unstage');
  const r = st.stage(m, src, { bytes: 5 });
  const back = st.unstage(m, [r.entry]);
  assert.equal(back.restored.length, 1);
  assert.ok(fs.existsSync(path.join(src, 'f')));
  assert.equal(st.readManifest('run-unstage').entries[0].state, 'restored');
});

// ---------------------------------------------------------------------------
// 2. cloud-synced folders
// ---------------------------------------------------------------------------

test('finding 2: cloud folder names, OneDrive env roots and Box are cloud', () => {
  const cloud = [
    '/Users/u/Dropbox (Personal)/app', '/Users/u/Dropbox (Team)/app', '/Users/u/Dropbox/app',
    '/Users/u/OneDrive - Contoso/app', 'C:\\Users\\u\\OneDrive - Contoso\\app', 'C:\\Users\\u\\OneDrive\\app',
    '/Users/u/Google Drive/My Drive/app', 'G:\\My Drive\\app', '/Users/u/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/app',
    '/Users/u/Library/CloudStorage/Box-Box/app', '/Users/u/Box/app', '/Users/u/Box Sync/app', 'C:\\Users\\u\\Box\\app',
    '/Users/u/Library/Mobile Documents/com~apple~CloudDocs/app',
  ];
  for (const p of cloud) assert.match(String(ac.cloudOrExternal(p, { cloudRoots: [] })), /cloud-synced/, p);
  for (const p of ['/Users/u/code/app', '/Users/u/code/box/app', 'D:\\code\\app', '/data/code/app']) assert.equal(ac.cloudOrExternal(p, { cloudRoots: [] }), null, p);
  // Windows names the OneDrive root in the environment, whatever the folder is called.
  const roots = ac.envCloudRoots({ OneDrive: 'C:\\Users\\u\\Contoso Files', OneDriveCommercial: 'D:\\Work Sync', OneDriveConsumer: '' });
  assert.deepEqual(roots, ['C:\\Users\\u\\Contoso Files', 'D:\\Work Sync']);
  assert.match(String(ac.cloudOrExternal('C:\\Users\\u\\Contoso Files\\code\\app', { cloudRoots: roots })), /cloud-synced/);
  assert.match(String(ac.cloudOrExternal('d:\\work sync\\app', { cloudRoots: roots })), /cloud-synced/, 'drive letters and case do not matter');
  assert.equal(ac.cloudOrExternal('C:\\Users\\u\\code\\app', { cloudRoots: roots }), null);
});

test('finding 2: selection skips a project whose ancestor is cloud, by name or by the fs check', () => {
  const mk = (p) => ({ path: p, items: [{ name: 'node_modules', path: p + '/node_modules', safe: true, reversible: true, size: 5 * GB }] });
  const projects = ['/Users/u/Documents/app', '/Users/u/Dropbox (Personal)/app', '/Users/u/code/app'].map(mk);
  const evidence = new Map(projects.map((p) => [p.path, { lastActivity: NOW - 90 * DAY }]));
  const itemEvidence = new Map(projects.map((p) => [p.items[0].path, { nearFiles: [] }]));
  const cloudOf = (p) => (p.startsWith('/Users/u/Documents') ? 'It is in a cloud-synced folder.' : null);
  const r = ac.selectCandidates({ projects, settings: { enabled: true }, now: NOW, evidence, itemEvidence, procs: quiet, aiTools: noAi, cloudOf, cloudRoots: [] });
  assert.deepEqual(r.candidates.map((c) => c.path), ['/Users/u/code/app/node_modules']);
});

test('finding 2: a folder symlinked into iCloud Drive or CloudStorage is cloud (fixtures)', async () => {
  const root = tmp();
  const home = path.join(root, 'home');
  const icloudDocs = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents');
  const gdrive = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me', 'My Drive');
  fs.mkdirSync(path.join(icloudDocs, 'app'), { recursive: true });
  fs.mkdirSync(gdrive, { recursive: true });
  fs.symlinkSync(icloudDocs, path.join(home, 'Documents'));
  fs.symlinkSync(gdrive, path.join(home, 'GD'));
  fs.mkdirSync(path.join(home, 'code', 'app'), { recursive: true });
  const noXattr = (cmd, args, opts, cb) => cb(new Error('no such xattr'));
  const opts = { platform: 'linux', exec: noXattr, cloudRoots: [] };
  assert.match(String(await ac.cloudReason(path.join(home, 'Documents', 'app'), opts)), /cloud-synced/);
  assert.match(String(await ac.cloudReason(path.join(home, 'Documents', 'app', 'not-yet', 'deeper'), opts)), /cloud-synced/, 'nearest existing ancestor');
  assert.match(String(await ac.cloudReason(path.join(home, 'GD', 'proj'), opts)), /cloud-synced/);
  assert.equal(await ac.cloudReason(path.join(home, 'code', 'app'), opts), null);
  const map = await ac.cloudReasons([path.join(home, 'Documents', 'app'), path.join(home, 'code', 'app')], opts);
  assert.deepEqual([...map.keys()], [path.join(home, 'Documents', 'app')]);
});

test('finding 2: the File Provider xattr on any ancestor marks a folder cloud (injected exec)', async () => {
  const root = tmp();
  const docs = path.join(root, 'Documents');
  fs.mkdirSync(path.join(docs, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'code', 'app'), { recursive: true });
  const asked = [];
  const exec = (cmd, args, opts, cb) => { asked.push(args[2]); cb(args[0] === '-p' && args[1] === 'com.apple.file-provider-domain-id' && args[2] === docs ? null : new Error('No such xattr')); };
  const cache = new Map();
  assert.match(String(await ac.cloudReason(path.join(docs, 'app'), { platform: 'darwin', exec, cache, cloudRoots: [] })), /cloud-synced/);
  assert.equal(await ac.cloudReason(path.join(root, 'code', 'app'), { platform: 'darwin', exec, cache, cloudRoots: [] }), null);
  assert.equal(asked.filter((d) => d === root).length, 1, 'each folder is asked once per run');
});

const hasXattr = (() => {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('xattr', ['-h'], { stdio: 'ignore' }); return true; } catch (e) { return e.status != null; }
})();

test('finding 2: a real xattr on an ancestor is detected through the xattr tool', { skip: !hasXattr && 'needs macOS xattr' }, async () => {
  const root = tmp();
  const docs = path.join(root, 'Documents');
  fs.mkdirSync(path.join(docs, 'work', 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'code', 'app'), { recursive: true });
  // macOS refuses to let a user process set com.apple.file-provider-domain-id
  // (only a File Provider can), so the real tool is driven with a stand-in name.
  let realAttr = true;
  try { execFileSync('xattr', ['-w', 'com.apple.file-provider-domain-id', 'test', docs], { stdio: 'ignore' }); } catch { realAttr = false; }
  const attr = realAttr ? 'com.apple.file-provider-domain-id' : 'ke.co.kentom.spaci.test-provider';
  if (!realAttr) execFileSync('xattr', ['-w', attr, 'com.apple.CloudDocs.iCloudDriveFileProvider/test', docs]);
  assert.match(String(await ac.cloudReason(path.join(docs, 'work', 'app'), { cloudRoots: [], platform: 'darwin', attr })), /cloud-synced/);
  assert.equal(await ac.cloudReason(path.join(root, 'code', 'app'), { cloudRoots: [], platform: 'darwin', attr }), null);
  // And the real attribute name finds nothing on a plain temp folder.
  assert.equal(await ac.cloudReason(path.join(root, 'code', 'app'), { cloudRoots: [], platform: 'darwin' }), null);
});

test('finding 2: an unattended run leaves a cloud project alone, and a failed cloud check fails closed', async () => {
  const h = harness({ children: [], project: true });
  h.scan.system = [];
  h.deps.cloudCheck = async () => new Map([[h.proj, 'It is in a cloud-synced folder.']]);
  let r = await ac.runAutoClean(h.deps);
  assert.equal(r.count, 0);
  assert.ok(fs.existsSync(h.nm));
  h.deps.cloudCheck = async () => { throw new Error('boom'); };
  r = await ac.runAutoClean(h.deps);
  assert.equal(r.count, 0);
  assert.ok(fs.existsSync(h.nm));
  h.deps.cloudCheck = async () => new Map();
  r = await ac.runAutoClean(h.deps);
  assert.equal(r.count, 1, 'control: the same project moves when it is not cloud');
});

// ---------------------------------------------------------------------------
// 3. stale and busy
// ---------------------------------------------------------------------------

function oldTree(dir, old) {
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.lstatSync(f).isDirectory()) walk(f); age(f, old); } };
  walk(dir);
  age(dir, old);
}

test('finding 3: git worktrees, the reflog and refs count as activity, both ways between a repo and its worktrees', async () => {
  const root = tmp();
  const old = NOW - 400 * DAY;
  const main = path.join(root, 'main');
  const wt = path.join(root, 'feature');
  write(path.join(main, 'a.js'));
  for (const f of ['HEAD', 'index', 'logs/HEAD', 'refs/heads/main', 'worktrees/feature/HEAD', 'worktrees/feature/index', 'worktrees/feature/commondir', 'worktrees/feature/gitdir']) write(path.join(main, '.git', f), f.endsWith('commondir') ? '../..\n' : 'x');
  write(path.join(wt, 'b.js'));
  write(path.join(wt, '.git'), 'gitdir: ' + path.join(main, '.git', 'worktrees', 'feature') + '\n');
  oldTree(root, old);
  const evOf = (d) => ac.projectEvidence(d, { now: NOW, staleMs: 30 * DAY });
  assert.ok((await evOf(main)).lastActivity <= old + 1000, 'baseline: stale');
  assert.ok((await evOf(wt)).lastActivity <= old + 1000, 'baseline: stale');
  // A commit in the worktree touches its own HEAD and index in the main repo's .git/worktrees.
  age(path.join(main, '.git', 'worktrees', 'feature', 'index'), NOW - DAY);
  assert.ok(NOW - (await evOf(main)).lastActivity < 30 * DAY, 'the main repo sees its worktree');
  assert.ok(NOW - (await evOf(wt)).lastActivity < 30 * DAY, 'the worktree sees its own git dir');
  age(path.join(main, '.git', 'worktrees', 'feature', 'index'), old);
  // A commit or checkout in the main repo: reflog and refs.
  age(path.join(main, '.git', 'logs', 'HEAD'), NOW - DAY);
  assert.ok(NOW - (await evOf(wt)).lastActivity < 30 * DAY, 'the worktree sees the main repo');
  age(path.join(main, '.git', 'logs', 'HEAD'), old);
  age(path.join(main, '.git', 'refs', 'heads', 'main'), NOW - DAY);
  assert.ok(NOW - (await evOf(main)).lastActivity < 30 * DAY, 'refs count');
});

test('finding 3: a dev process whose command line names a path in the project keeps it, whatever its cwd', () => {
  const proc = (args, names = ['node', 'server']) => ({ ok: true, list: [{ pid: 1, names, cwd: '/', args }] });
  assert.match(String(ac.projectBusy(proc('/usr/local/bin/node /Users/u/code/app/server.js'), '/Users/u/code/app')), /working on files/);
  assert.ok(ac.projectBusy(proc('node --watch=/users/u/code/APP/src'), '/Users/u/code/app'), 'case differs');
  assert.ok(ac.projectBusy(proc('"C:\\Program Files\\nodejs\\node.exe" C:\\code\\app\\server.js'), 'C:\\code\\app'));
  assert.ok(ac.projectBusy(proc('node /Users/u/My Code/app'), '/Users/u/My Code/app'), 'spaces in the project path');
  assert.equal(ac.projectBusy(proc('node /Users/u/code/apple/server.js'), '/Users/u/code/app'), null, 'a sibling with a longer name');
  assert.equal(ac.projectBusy(proc('node /x/Users/u/code/app/s.js'), '/Users/u/code/app'), null, 'a different path that contains it');
  assert.equal(ac.projectBusy(proc('Safari /Users/u/code/app', ['Safari']), '/Users/u/code/app'), null, 'only developer tools count');
  // The critic's reproduction: node launched by launchd with cwd / on a project script.
  const r = ac.selectCandidates({
    projects: [{ path: '/Users/u/code/app', items: [{ name: 'node_modules', path: '/Users/u/code/app/node_modules', safe: true, size: 5 * GB }] }],
    settings: {}, now: NOW, evidence: new Map([['/Users/u/code/app', { lastActivity: NOW - 90 * DAY }]]),
    itemEvidence: new Map([['/Users/u/code/app/node_modules', { nearFiles: [] }]]),
    procs: proc('/usr/local/bin/node /Users/u/code/app/server.js'), aiTools: noAi, cloudRoots: [],
  });
  assert.equal(r.candidates.length, 0);
});

test('finding 3: executable names keep their spaces; editor helpers are developer tools', () => {
  assert.deepEqual(ac.namesFrom('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /x/tsserver.js --serverMode semantic'),
  ['Code Helper (Plugin)', 'tsserver']);
  assert.deepEqual(ac.namesOf('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /x/tsserver.js'), ['Code Helper (Plugin)', 'tsserver']);
  assert.deepEqual(ac.namesFrom('/Users/u/My Tools/node', '/Users/u/My Tools/node /Users/u/My Tools/npm-cli.js i'), ['node', 'npm']);
  assert.deepEqual(ac.namesFrom('node', 'node server.js'), ['node', 'server'], 'Linux comm is a bare name');
  assert.ok(ac.DEV_PROCESS_NAMES.has('Code Helper (Plugin)'));
  const list = ac.parsePs('  5 501 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)\n', 501,
    '  5 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /code/app/node_modules/typescript/lib/tsserver.js\n');
  assert.deepEqual(list[0].names, ['Code Helper (Plugin)', 'tsserver']);
  assert.ok(ac.projectBusy({ ok: true, list: [{ ...list[0], cwd: '/' }] }, '/code/app'));
});

test('finding 3: a project with a Compose file is skipped while Docker runs containers, or when Docker cannot say', async () => {
  const root = tmp();
  const proj = path.join(root, 'svc');
  write(path.join(proj, 'package.json'));
  write(path.join(proj, 'compose.override.yaml'));
  assert.equal((await ac.projectEvidence(proj, { now: NOW, staleMs: 30 * DAY })).compose, true);
  write(path.join(root, 'plain', 'package.json'));
  assert.equal((await ac.projectEvidence(path.join(root, 'plain'), { now: NOW, staleMs: 30 * DAY })).compose, false);
  for (const n of ['docker-compose.yml', 'docker-compose.dev.yaml', 'compose.yml']) {
    const d = path.join(root, n.replace(/\W/g, '_'));
    write(path.join(d, n));
    assert.equal((await ac.projectEvidence(d, { now: NOW, staleMs: 30 * DAY })).compose, true, n);
  }
  const sel = (docker) => ac.selectCandidates({
    projects: [{ path: '/c/svc', items: [{ name: 'node_modules', path: '/c/svc/node_modules', safe: true, size: GB }] }],
    settings: {}, now: NOW, evidence: new Map([['/c/svc', { lastActivity: NOW - 90 * DAY, compose: true }]]),
    itemEvidence: new Map([['/c/svc/node_modules', { nearFiles: [] }]]), procs: quiet, aiTools: noAi, docker, cloudRoots: [],
  });
  assert.match(sel({ ok: true, running: 2 }).skipped[0].reason, /containers are running/);
  assert.match(sel({ ok: false, running: 0 }).skipped[0].reason, /could not check/);
  assert.match(sel(undefined).skipped[0].reason, /could not check/, 'no answer fails closed');
  assert.equal(sel({ ok: true, running: 0 }).candidates.length, 1);
});

// ---------------------------------------------------------------------------
// 5. other disks
// ---------------------------------------------------------------------------

test('finding 5: selection leaves items on another disk, and says so in the preview', () => {
  const projects = [{ path: '/ext/app', items: [{ name: 'node_modules', path: '/ext/app/node_modules', safe: true, size: 5 * GB }] }];
  const system = [{ id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 2 * GB, existingPaths: ['/h/.npm/_cacache'] }];
  const r = ac.selectCandidates({
    projects, system, settings: {}, now: NOW, evidence: new Map([['/ext/app', { lastActivity: NOW - 90 * DAY }]]),
    itemEvidence: new Map([['/ext/app/node_modules', { nearFiles: [] }]]), procs: quiet, aiTools: noAi, cloudRoots: [],
    sameDisk: (p) => !p.startsWith('/ext'),
  });
  assert.deepEqual(r.candidates.map((c) => c.path), ['/h/.npm/_cacache']);
  const s = r.skipped.find((x) => x.path === '/ext/app/node_modules');
  assert.match(s.reason, /another disk/);
  assert.equal(s.quiet, undefined, 'listed in the preview');
});

test('finding 5: EXDEV at move time skips that item and the run goes on', async () => {
  const h = harness({ project: true });
  // The cache's rename crosses devices (a mount appeared); node_modules still moves.
  const realRename = fs.renameSync;
  const fakeFs = Object.assign(Object.create(fs), {
    renameSync: (a, b) => { if (a.startsWith(h.cache)) { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; } return realRename(a, b); },
  });
  h.staging = ac.createStaging({ root: h.staging.root, fs: fakeFs, now: () => NOW, removeTree: async () => {}, log: { warn() {}, error() {} } });
  h.deps.staging = h.staging;
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.status, 'ok', 'not a run stop');
  assert.equal(r.stopped, null);
  assert.equal(fs.existsSync(h.nm), false, 'node_modules moved');
  assert.deepEqual(fs.readdirSync(h.cache).sort(), ['a', 'b'], 'cache children left');
  const e = h.entry(r.runId);
  assert.equal(e.items.find((x) => x.path === h.cache).outcome, 'refused');
  // A whole artifact on another disk at move time is refused the same way.
  const h2 = harness({ project: true, children: [] });
  h2.scan.system = [];
  const fakeFs2 = Object.assign(Object.create(fs), { renameSync: (a, b) => { if (a !== h2.nm) return fs.renameSync(a, b); const e2 = new Error('EXDEV'); e2.code = 'EXDEV'; throw e2; } });
  h2.deps.staging = ac.createStaging({ root: h2.staging.root, fs: fakeFs2, now: () => NOW, removeTree: async () => {}, log: { warn() {}, error() {} } });
  const r2 = await ac.runAutoClean(h2.deps);
  assert.equal(r2.stopped, null);
  const it = h2.entry(r2.runId).items[0];
  assert.equal(it.outcome, 'refused');
  assert.match(it.reason, /another disk/);
});

// ---------------------------------------------------------------------------
// 6. protected names and excluded paths inside a child
// ---------------------------------------------------------------------------

test('finding 6: a child holding a protected name or an excluded path at any depth is left in place', async () => {
  const h = harness({ children: ['plain', 'deep', 'kept'] });
  write(path.join(h.cache, 'deep', 'x', 'y', 'Memory', 'notes.md'), 'mine');
  write(path.join(h.cache, 'kept', 'z', 'keepme'), 'mine');
  h.settings = { ...APPROVED, excludes: [path.join(h.cache, 'kept', 'z')] };
  h.settings.approved = { ...APPROVED.approved, rules: ac.rulesFingerprint(h.settings) };
  h.deps.guard = async (jobs) => ({ allowed: jobs.map((j) => ({ ...j, protect: ['memory'] })), refused: [] });
  // The exclude covers a folder inside the cache, not the cache: selection still picks the cache.
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.count, 1);
  assert.deepEqual(fs.readdirSync(h.cache).sort(), ['deep', 'kept']);
  assert.equal(fs.readFileSync(path.join(h.cache, 'deep', 'x', 'y', 'Memory', 'notes.md'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(h.cache, 'kept', 'z', 'keepme'), 'utf8'), 'mine');
  const it = h.entry(r.runId).items[0];
  assert.equal(it.outcome, 'trashed');
  assert.match(it.reason, /2 protected or excluded entries were left in place/);
  // An artifact with an excluded path inside is refused whole.
  const h2 = harness({ project: true, children: [] });
  h2.scan.system = [];
  h2.deps.guard = async (jobs) => ({ allowed: jobs.map((j) => ({ ...j, excludePaths: [path.join(h2.nm, 'dep')] })), refused: [] });
  const r2 = await ac.runAutoClean(h2.deps);
  assert.equal(r2.count, 0);
  assert.ok(fs.existsSync(path.join(h2.nm, 'dep', 'index.js')));
  assert.equal(h2.entry(r2.runId).items[0].outcome, 'refused');
  // A walk past its budget fails closed.
  assert.equal(await ac.holdsProtected(h.cache, { protect: new Set(['nothing']), excludes: [], budget: 1 }), true);
});

// ---------------------------------------------------------------------------
// 7. fresh process checks right before each move
// ---------------------------------------------------------------------------

test('finding 7: processes are checked again right before each move', async () => {
  const h = harness({ project: true });
  let calls = 0;
  // Quiet at selection; by the time the run reaches each item, npm and a dev server started.
  h.deps.snapshot = async () => (++calls === 1 ? quiet : { ok: true, list: [{ pid: 9, names: ['node', 'npm'], cwd: h.proj, args: 'node npm-cli.js i' }] });
  const r = await ac.runAutoClean(h.deps);
  assert.ok(calls >= 3, 'one snapshot per item after selection');
  assert.equal(r.count, 0);
  assert.equal(r.stopped, null, 'a busy item is skipped, not a run stop');
  assert.ok(fs.existsSync(h.nm));
  assert.deepEqual(fs.readdirSync(h.cache).sort(), ['a', 'b']);
  const e = h.entry(r.runId);
  assert.match(e.items.find((x) => x.path === h.cache).reason, /package manager started running/);
  assert.match(e.items.find((x) => x.path === h.nm).reason, /running in this project/);
  // A snapshot that fails right before a move skips that item.
  const h2 = harness();
  let n2 = 0;
  h2.deps.snapshot = async () => (++n2 === 1 ? quiet : { ok: false, list: [] });
  const r2 = await ac.runAutoClean(h2.deps);
  assert.equal(r2.count, 0);
  assert.deepEqual(fs.readdirSync(h2.cache).sort(), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 8. empty previews
// ---------------------------------------------------------------------------

test('finding 8: an empty dry run is not offered for approval, and cannot be approved', async () => {
  const h = harness({ children: [] });
  h.scan.system = [];
  h.settings = { enabled: true, pendingPreview: 'old-preview' };
  const r = await ac.runAutoClean(h.deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.count, 0);
  assert.equal(h.settings.pendingPreview, null, 'nothing pending');
  assert.equal(h.history.length, 0, 'no approvable entry');
  assert.equal(h.notes.length, 0);
  // Main's approve handler uses approvalCheck.
  const rules = ac.rulesFingerprint({ enabled: true });
  const s = { enabled: true, pendingPreview: 'p1' };
  const entry = (count) => ({ id: 'p1', autoClean: { dryRun: true, rules, previewCount: count } });
  assert.equal(ac.approvalCheck(s, entry(0), 'p1').ok, false);
  assert.equal(ac.approvalCheck(s, entry(0), 'p1').clearPending, true);
  assert.equal(ac.approvalCheck(s, entry(undefined), 'p1').ok, false);
  assert.equal(ac.approvalCheck(s, entry(3), 'p2').ok, false, 'only the pending one');
  assert.equal(ac.approvalCheck(s, { id: 'p1', autoClean: { rules, previewCount: 3 } }, 'p1').ok, false, 'only a dry run');
  assert.equal(ac.approvalCheck(s, entry(3), 'p1').ok, true);
  // The first real run needs an approval that came from a preview.
  assert.equal(ac.isApproved({ enabled: true, approved: { at: NOW, rules } }), false);
  const h2 = harness();
  h2.settings = { enabled: true, approved: { at: NOW, rules } };
  const r2 = await ac.runAutoClean(h2.deps);
  assert.equal(r2.dryRun, true, 'without a preview id it is only a preview');
  assert.deepEqual(fs.readdirSync(h2.cache).sort(), ['a', 'b']);
});
