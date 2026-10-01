'use strict';
// Worktree removal must never lose work. Each test rebuilds one of the safety
// critic's reproductions (wtA..wtF, wt-critic/run.js and run2.js) on a real
// repository in a temp folder and checks that Spaci now refuses it, plus the
// helpers behind each refusal.
//
//   wtA  edits hidden from git status (skip-worktree, assume-unchanged)
//   wtB  a commit only in the worktree's own HEAD reflog
//   wtC  control: unmerged, upstream deleted
//   wtD  its .git replaced by a repository of its own
//   wtE  ignored data in .wrangler, .venv, .cache, .idea, .vercel, .netlify
//   wtF  folder away (as on an unplugged disk) with a detached commit, pruned

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scanner = require('../src/scanner'); // hands its safe artifact names to worktrees
const wtx = require('../src/worktrees');
const repoGroup = require('../src/repo-group');

const LATER = () => Date.now() + 2 * wtx.FRESH_MS;
wtx.setClock(LATER);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Spaci Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Spaci Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) {
  return execFileSync('git', [
    '-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args,
  ], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(base, rel, body = 'x') {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}
const ROOTS = [];
test.after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true }); });
function tmp(prefix) {
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  ROOTS.push(r);
  return r;
}
// No process runs in a temp worktree: removal checks see a clean snapshot.
const quiet = async () => ({ ok: true, list: [] });
const opts = { dirSize: scanner.dirSize, snapshot: quiet };

/** The critic's layout: main (cloned from origin.git) and one worktree per scenario. */
function critic() {
  const S = tmp('spaci-wtcritic-');
  const seed = path.join(S, 'seed');
  write(seed, '.gitignore', '.env.local\nnode_modules/\n.wrangler/\n.venv/\n.cache/\n.idea/\n.vercel/\n.netlify/\n');
  write(seed, 'config.yml', 'a: 1\n');
  write(seed, 'notes.md', 'notes\n');
  git(seed, 'init', '-q'); git(seed, 'add', '.gitignore', 'config.yml', 'notes.md'); git(seed, 'commit', '-qm', 'init');
  const origin = path.join(S, 'origin.git');
  git(S, 'clone', '-q', '--bare', seed, origin);
  const main = path.join(S, 'main');
  git(S, 'clone', '-q', origin, main);
  const wt = (n) => path.join(S, n);
  for (const n of ['A', 'B', 'C', 'D', 'E']) git(main, 'worktree', 'add', '-q', '-b', 'feat' + n, wt('wt' + n));
  return { S, main, origin, wt };
}
const C = critic();
const reasonsOf = (r) => (r.reasons || []).join(' ');

// ---------------------------------------------------------------------------
// Finding 1: wtA, edits hidden from status
// ---------------------------------------------------------------------------

test('wtA: skip-worktree and assume-unchanged edits block removal and survive it', async () => {
  const w = C.wt('wtA');
  git(w, 'update-index', '--skip-worktree', 'config.yml');
  write(w, 'config.yml', 'a: 2  # local secret tweak\n');
  git(w, 'update-index', '--assume-unchanged', 'notes.md');
  write(w, 'notes.md', 'my notes\n');
  assert.equal(git(w, 'status', '--porcelain'), '', 'git status sees nothing');

  const v = await wtx.reverify(C.main, w, opts);
  assert.equal(v.ok, false);
  assert.equal(v.wt.hiddenFiles, 2);
  assert.match(reasonsOf(v), /2 files hidden from git status \(skip-worktree or assume-unchanged\)/);
  const r = await wtx.removeWorktree(C.main, w, opts);
  assert.equal(r.refused, true);
  assert.equal(fs.readFileSync(path.join(w, 'config.yml'), 'utf8'), 'a: 2  # local secret tweak\n');
});

test('hiddenFromStatus: a sparse-checkout entry missing on disk holds nothing', async () => {
  const repo = tmp('spaci-sparse-');
  write(repo, 'keep.txt', 'k'); write(repo, 'far/away.txt', 'f');
  git(repo, 'init', '-q'); git(repo, 'add', 'keep.txt', 'far/away.txt'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'update-index', '--skip-worktree', 'far/away.txt');
  fs.rmSync(path.join(repo, 'far'), { recursive: true });
  assert.deepEqual(await wtx.hiddenFromStatus(repo), { count: 0 });
  write(repo, 'far/away.txt', 'back with edits');
  assert.deepEqual(await wtx.hiddenFromStatus(repo), { count: 1 });
});

// ---------------------------------------------------------------------------
// Finding 2: wtB, a commit only in the worktree's reflog
// ---------------------------------------------------------------------------

test('wtB: a commit reachable only from the worktree HEAD reflog blocks removal', async () => {
  const w = C.wt('wtB');
  git(w, 'checkout', '-q', '--detach');
  write(w, 'experiment.txt', 'tried something');
  git(w, 'add', 'experiment.txt'); git(w, 'commit', '-qm', 'experiment');
  const lost = git(w, 'rev-parse', 'HEAD').trim();
  git(w, 'checkout', '-q', 'featB');
  assert.equal(git(w, 'status', '--porcelain'), '');

  const v = await wtx.reverify(C.main, w, opts);
  assert.equal(v.ok, false);
  assert.equal(v.wt.reflogOnly, 1);
  assert.match(reasonsOf(v), /commits only in this worktree's history/);
  const r = await wtx.removeWorktree(C.main, w, opts);
  assert.equal(r.refused, true);
  assert.ok(fs.existsSync(w));
  assert.equal(git(C.main, 'cat-file', '-t', lost).trim(), 'commit');
});

test('reflogOnlyCommits: no reflog, gone objects and a long reflog', async () => {
  const repo = tmp('spaci-reflog-');
  write(repo, 'a', '1');
  git(repo, 'init', '-q'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'one');
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  const gitDir = path.join(repo, '.git');
  const empty = tmp('spaci-noreflog-');
  assert.deepEqual(await wtx.reflogOnlyCommits(empty, { refsCwd: repo }), { count: 0 }, 'no logs/HEAD');
  // A reflog naming an object gc already took, and thousands of lines.
  const zero = '0'.repeat(40);
  const gone = 'f'.repeat(40);
  const lines = [`${zero} ${gone} T <t@e> 1700000000 +0000\tcommit: gone`];
  for (let i = 0; i < 5000; i++) lines.push(`${head} ${head} T <t@e> ${1700000001 + i} +0000\treset: moving to HEAD`);
  fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), lines.join('\n') + '\n');
  const t0 = Date.now();
  assert.deepEqual(await wtx.reflogOnlyCommits(gitDir, { refsCwd: repo }), { count: 0 });
  assert.ok(Date.now() - t0 < 15000, 'a long reflog stays fast');
  // A commit on no ref, but another worktree's HEAD keeps it.
  write(repo, 'b', '2'); git(repo, 'add', 'b'); git(repo, 'commit', '-qm', 'two');
  const two = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'reset', '-q', '--hard', head);
  assert.deepEqual(await wtx.reflogOnlyCommits(gitDir, { refsCwd: repo }), { count: 1 });
  assert.deepEqual(await wtx.reflogOnlyCommits(gitDir, { refsCwd: repo, keepHeads: [two] }), { count: 0 });
  // git failing (not a repository) is an error, never "nothing to lose".
  const r = await wtx.reflogOnlyCommits(gitDir, { refsCwd: empty });
  assert.ok(r.error);
});

// ---------------------------------------------------------------------------
// wtC: control, unmerged with its upstream deleted
// ---------------------------------------------------------------------------

test('wtC: unmerged work whose upstream branch was deleted is refused', async () => {
  const w = C.wt('wtC');
  write(w, 'c', 'c'); git(w, 'add', 'c'); git(w, 'commit', '-qm', 'c');
  git(w, 'push', '-q', '-u', 'origin', 'featC');
  git(C.main, 'push', '-q', 'origin', '--delete', 'featC');
  git(C.main, 'fetch', '-q', '--prune');
  const v = await wtx.reverify(C.main, w, opts);
  assert.equal(v.ok, false);
  assert.match(reasonsOf(v), /not merged and not pushed/);
});

// ---------------------------------------------------------------------------
// Finding 5: wtD, a .git that is not this worktree's link
// ---------------------------------------------------------------------------

test('wtD: a worktree whose .git became a repository of its own is never removable', async () => {
  const w = C.wt('wtD');
  fs.rmSync(path.join(w, '.git'));
  git(w, 'init', '-q'); git(w, 'add', 'config.yml'); git(w, 'commit', '-qm', 'separate history');
  const v = await wtx.reverify(C.main, w, opts);
  assert.equal(v.ok, false);
  assert.equal(v.wt.linkMismatch, true);
  assert.match(reasonsOf(v), /not a worktree link/);
  const r = await wtx.removeWorktree(C.main, w, opts);
  assert.equal(r.refused, true);
  assert.ok(fs.existsSync(path.join(w, '.git', 'HEAD')));

  // And left out of what a Recommendation would free.
  const desc = await wtx.describeRepo(C.main, { snapshot: quiet });
  const rec = repoGroup.buildRecord({ mainRoot: C.main, checkouts: [] }, desc, {});
  const d = rec.repo.worktrees.find((x) => wtx.exactKey(x.path) === wtx.exactKey(w));
  assert.equal(d.eligibility.ok, false);
  assert.ok(!rec.repo.worktrees.some((x) => x.eligibility.ok && wtx.exactKey(x.path) === wtx.exactKey(w)));
});

test('linkProblem: a .git file pointing at another worktree\'s record is not this worktree', async () => {
  const S = tmp('spaci-wtlink-');
  const main = path.join(S, 'main');
  write(main, 'f', '1');
  git(main, 'init', '-q'); git(main, 'add', 'f'); git(main, 'commit', '-qm', 'i');
  git(main, 'worktree', 'add', '-q', '-b', 'x', path.join(S, 'x'));
  git(main, 'worktree', 'add', '-q', '-b', 'y', path.join(S, 'y'));
  const admins = await wtx.adminRecords(await wtx.commonDirOf(main));
  const ax = wtx.pickByPath(admins, path.join(S, 'x'));
  const ay = wtx.pickByPath(admins, path.join(S, 'y'));
  fs.writeFileSync(path.join(S, 'y', '.git'), 'gitdir: ' + ax.dir + '\n');
  const entry = await wtx.readGitEntry(path.join(S, 'y'));
  assert.match(wtx.linkProblem(entry, ay), /points at/);
  assert.equal(wtx.linkProblem(await wtx.readGitEntry(path.join(S, 'x')), ax), null);
  const v = await wtx.reverify(main, path.join(S, 'y'), opts);
  assert.equal(v.ok, false);
  assert.match(reasonsOf(v), /not at this worktree's record/);
});

// ---------------------------------------------------------------------------
// Finding 4: wtE, ignored data that is not build output
// ---------------------------------------------------------------------------

test('wtE: .wrangler, .venv, .cache, .idea, .vercel and .netlify block removal; build output is listed', async () => {
  const w = C.wt('wtE');
  write(w, '.wrangler/state/v3/d1/db.sqlite', 'local database');
  write(w, '.venv/lib/site.py', 'venv');
  write(w, '.cache/tool/state.json', '{}');
  write(w, '.idea/runConfigurations/app.xml', '<x/>');
  write(w, '.vercel/project.json', '{}');
  write(w, '.netlify/state.json', '{}');
  write(w, 'node_modules/x/index.js', 'x'.repeat(2048));
  const v = await wtx.reverify(C.main, w, opts);
  assert.equal(v.ok, false);
  assert.deepEqual(v.wt.ignoredOther.slice().sort(), ['.cache', '.idea', '.netlify', '.venv', '.vercel', '.wrangler']);
  assert.deepEqual(v.wt.buildOutput, ['node_modules']);
  const r = await wtx.removeWorktree(C.main, w, opts);
  assert.equal(r.refused, true);
  assert.ok(fs.existsSync(path.join(w, '.wrangler/state/v3/d1/db.sqlite')));
});

test('userIgnored: only safe artifact rules are build output', () => {
  assert.deepEqual(wtx.userIgnored(['venv/', '.venv/', 'node_modules/', 'api/__pycache__/', '.wrangler/', '.DS_Store']), ['venv', '.venv', '.wrangler']);
  for (const n of ['.wrangler', '.cache', '.idea', '.vercel', '.netlify']) assert.equal(wtx.HARMLESS_IGNORED.has(n), false, n);
  assert.deepEqual(wtx.buildOutput(['node_modules/', '.env', 'a.log']), ['node_modules', 'a.log']);
});

// ---------------------------------------------------------------------------
// Finding 3: wtF, prune per entry, with every check
// ---------------------------------------------------------------------------

test('wtF: a worktree away with a detached commit keeps its record; a really deleted one is cleared alone', async () => {
  const w = C.wt('wtF');
  git(C.main, 'worktree', 'add', '-q', '--detach', w);
  write(w, 'f', 'only here'); git(w, 'add', 'f'); git(w, 'commit', '-qm', 'f');
  const f = git(w, 'rev-parse', 'HEAD').trim();
  const gone = C.wt('wtGone');
  git(C.main, 'worktree', 'add', '-q', '-b', 'featGone', gone);
  // wtF's folder is away (as on an unplugged disk); wtGone was deleted.
  const away = path.join(C.S, 'wtF-away');
  fs.renameSync(w, away);
  fs.rmSync(gone, { recursive: true, force: true });

  const r = await wtx.pruneWorktrees(C.main, [w, gone]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pruned, [gone]);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].reason, /on no branch or tag/);
  fs.renameSync(away, w);
  const listed = wtx.parseWorktreeList(git(C.main, 'worktree', 'list', '--porcelain'));
  assert.ok(listed.some((e) => wtx.exactKey(e.path) === wtx.exactKey(w)), 'git still knows wtF');
  assert.equal(git(w, 'rev-parse', 'HEAD').trim(), f);
  assert.equal(git(w, 'status', '--porcelain'), '', 'and it works again');
  assert.ok(!listed.some((e) => wtx.exactKey(e.path) === wtx.exactKey(gone)));
});

test('prune refuses a reflog-only commit, a missing parent and an unconfirmed path', async () => {
  const S = tmp('spaci-wtprune-');
  const main = path.join(S, 'main');
  write(main, 'f', '1');
  git(main, 'init', '-q'); git(main, 'add', 'f'); git(main, 'commit', '-qm', 'i');
  // Reflog-only: work committed on a detached HEAD, then back to the branch.
  const a = path.join(S, 'holder', 'a');
  git(main, 'worktree', 'add', '-q', '-b', 'a', a);
  git(a, 'checkout', '-q', '--detach'); write(a, 'g', '2'); git(a, 'add', 'g'); git(a, 'commit', '-qm', 'g'); git(a, 'checkout', '-q', 'a');
  fs.rmSync(a, { recursive: true, force: true });
  // Parent gone too: may be a disk or share that is away.
  const b = path.join(S, 'share', 'b');
  git(main, 'worktree', 'add', '-q', '-b', 'b', b);
  fs.rmSync(path.join(S, 'share'), { recursive: true, force: true });
  const r = await wtx.pruneWorktrees(main, [a, b]);
  assert.deepEqual(r.pruned, []);
  assert.match(r.refused[0].reason, /commits only in this worktree's history/);
  assert.match(r.refused[1].reason, /not there either/);
  assert.equal(wtx.parseWorktreeList(git(main, 'worktree', 'list', '--porcelain')).length, 3, 'both records kept');
});

test('missingProblem: unreadable, away disks and drives are not gone', async () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const dir = (dev = 1) => ({ isDirectory: () => true, dev });
  const io = (over) => ({ lstat: async () => { throw err('ENOENT'); }, stat: async () => dir(), ...over });
  assert.equal(await wtx.missingProblem('/home/u/wt/x', io()), null, 'really gone');
  assert.match(await wtx.missingProblem('/home/u/wt/x', io({ lstat: async () => { throw err('EACCES'); } })), /Unreadable is not gone/);
  assert.match(await wtx.missingProblem('/home/u/wt/x', io({ lstat: async () => { throw err('EPERM'); } })), /EPERM/);
  assert.match(await wtx.missingProblem('/home/u/wt/x', io({ lstat: async () => ({}) })), /folder is there/);
  assert.match(await wtx.missingProblem('/home/u/wt/x', io({ stat: async () => { throw err('ENOENT'); } })), /not there either/);
  // An empty mount point: the parent is on the same device as /Volumes.
  assert.match(await wtx.missingProblem('/Volumes/Ext/wt', io({ stat: async () => dir(7) })), /not mounted/);
  assert.equal(await wtx.missingProblem('/Volumes/Ext/wt', io({ stat: async (p) => dir(p === '/Volumes' ? 7 : 9) })), null);
  for (const p of ['/media/u/usb/wt', '/mnt/data/wt', '/run/media/u/usb/wt']) {
    assert.match(await wtx.missingProblem(p, io({ stat: async () => dir(3) })), /not mounted/, p);
  }
  assert.match(await wtx.missingProblem('E:\\work\\wt', io({ stat: async (p) => { if (p === 'E:\\') throw err('ENOENT'); return dir(); } })), /Drive E: is not connected/);
});

// ---------------------------------------------------------------------------
// Finding 6: exact path first, case-folded only as a fallback
// ---------------------------------------------------------------------------

test('pickByPath: an exact path wins over a case-folded one, and an ambiguous fold matches nothing', () => {
  const base = tmp('spaci-case-');
  const entries = [{ path: path.join(base, 'Feat') }, { path: path.join(base, 'feat') }];
  assert.equal(wtx.pickByPath(entries, path.join(base, 'feat')), entries[1]);
  assert.equal(wtx.pickByPath(entries, path.join(base, 'Feat')), entries[0]);
  assert.equal(wtx.pickByPath(entries, path.join(base, 'FEAT')), null, 'two folded matches: none');
  const one = [{ path: path.join(base, 'Only') }];
  const folded = wtx.pickByPath(one, path.join(base, 'ONLY'));
  if (process.platform === 'linux') assert.equal(folded, null);
  else assert.equal(folded, one[0]);
});

// ---------------------------------------------------------------------------
// Finding 7: fresh, busy, and the order of checks
// ---------------------------------------------------------------------------

function freshRepo() {
  const S = tmp('spaci-wtfresh-');
  const main = path.join(S, 'main');
  write(main, 'f', '1');
  git(main, 'init', '-q'); git(main, 'add', 'f'); git(main, 'commit', '-qm', 'i');
  const w = path.join(S, 'agent-1');
  git(main, 'worktree', 'add', '-q', '-b', 'agent-1', w);
  return { S, main, w };
}

test('a worktree active within the hour is not offered', async () => {
  const { main, w } = freshRepo();
  wtx.setClock(null);
  try {
    const v = await wtx.reverify(main, w, opts);
    assert.equal(v.ok, false);
    assert.match(reasonsOf(v), /less than an hour ago/);
  } finally { wtx.setClock(LATER); }
  assert.equal((await wtx.reverify(main, w, opts)).ok, true, 'two hours on it is');
});

test('a brand-new agent branch at main counts as fresh even when its files look old', async () => {
  const { main, w } = freshRepo();
  // Old timestamps everywhere a scan looks for activity; the reflog still
  // says the worktree was created just now.
  const old = new Date(Date.now() - 5 * wtx.FRESH_MS);
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); fs.utimesSync(p, old, old); } fs.utimesSync(d, old, old); };
  walk(w);
  walk(path.join(main, '.git', 'worktrees'));
  wtx.setClock(null);
  try {
    const v = await wtx.reverify(main, w, opts);
    assert.equal(v.wt.merged, true, 'HEAD equals main');
    assert.equal(v.ok, false);
    assert.match(reasonsOf(v), /Created less than an hour ago/);
  } finally { wtx.setClock(LATER); }
});

test('a worktree a tool runs in, or whose tools cannot be checked, is not removed', async () => {
  const { main, w } = freshRepo();
  const inside = async () => ({ ok: true, list: [{ pid: 4242, names: ['claude'], cwd: path.join(w, 'src'), args: 'claude' }] });
  const r = await wtx.removeWorktree(main, w, { ...opts, snapshot: inside });
  assert.equal(r.refused, true);
  assert.match(reasonsOf(r), /claude is running in it/);
  const mention = async () => ({ ok: true, list: [{ pid: 7, names: ['node'], cwd: '/elsewhere', args: 'node server.js --root ' + w }] });
  assert.match(reasonsOf(await wtx.removeWorktree(main, w, { ...opts, snapshot: mention })), /node is working on files in it/);
  const failed = async () => ({ ok: false, list: [] });
  assert.match(reasonsOf(await wtx.removeWorktree(main, w, { ...opts, snapshot: failed })), /could not check which tools are running/);
  assert.ok(fs.existsSync(w));
  // Scan time: the same snapshot keeps it from being offered.
  const desc = await wtx.describeRepo(main, { procs: await inside() });
  assert.match(desc.worktrees[0].eligibility.reasons.join(' '), /claude is running in it/);
  // Nothing running there: removed.
  const ok = await wtx.removeWorktree(main, w, opts);
  assert.equal(ok.ok, true, reasonsOf(ok));
});

test('removal decides from checks taken after the slow work, right before git runs', async () => {
  const { main, w } = freshRepo();
  // A file appears while the size walk runs: the status check that follows it sees it.
  const slowSize = async (d, s) => { write(w, 'late.txt', 'written during the size walk'); return scanner.dirSize(d, s); };
  const r = await wtx.removeWorktree(main, w, { ...opts, dirSize: slowSize });
  assert.equal(r.refused, true);
  assert.match(reasonsOf(r), /1 untracked file/);
  assert.ok(fs.existsSync(path.join(w, 'late.txt')));
});

// ---------------------------------------------------------------------------
// Merged but ahead of upstream: removable, the branch keeps the commit
// ---------------------------------------------------------------------------

test('merged but ahead of its upstream stays removable and the branch keeps the unpushed commit', async () => {
  const S = tmp('spaci-wtahead-');
  const seed = path.join(S, 'seed');
  write(seed, 'f', '1');
  git(seed, 'init', '-q'); git(seed, 'add', 'f'); git(seed, 'commit', '-qm', 'i');
  git(S, 'clone', '-q', '--bare', seed, path.join(S, 'o.git'));
  const main = path.join(S, 'main');
  git(S, 'clone', '-q', path.join(S, 'o.git'), main);
  const w = path.join(S, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', w);
  git(w, 'push', '-q', '-u', 'origin', 'feat');
  write(w, 'g', '2'); git(w, 'add', 'g'); git(w, 'commit', '-qm', 'g');
  git(main, 'merge', '-q', '--ff-only', 'feat');
  const v = await wtx.reverify(main, w, opts);
  assert.deepEqual([v.ok, v.wt.merged, v.wt.ahead, v.wt.upstream], [true, true, 1, 'origin/feat']);
  const r = await wtx.removeWorktree(main, w, opts);
  assert.equal(r.ok, true);
  assert.equal(git(main, 'rev-parse', 'feat').trim(), git(main, 'rev-parse', 'main').trim(), 'the branch is kept with its commit');
});
