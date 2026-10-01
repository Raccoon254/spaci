'use strict';
// Repository grouping and worktree cleanup, against real git repositories and
// worktrees created in a temp folder: a monorepo with packages, linked
// worktrees beside it and nested under .claude/worktrees, merged, unmerged,
// pushed, dirty, locked, missing, detached, a worktree made from a worktree, a
// submodule, and a worktree whose main repository is outside the scan root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scanner = require('../src/scanner');
const wtx = require('../src/worktrees');
const repoGroup = require('../src/repo-group');
const cleanTiers = require('../src/clean-tiers');
const cleanPlan = require('../src/clean-plan');
const repoSummary = require('../src/repo-summary');
const restoreHints = require('../src/restore-hints');

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
  // Real path: macOS hands out /var/... which is a link to /private/var/...
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  ROOTS.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseWorktreeList reads porcelain with and without -z', () => {
  const text = [
    'worktree /r/main', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/wt one', 'HEAD bbb', 'detached', 'locked because', '',
    'worktree /r/gone', 'HEAD ccc', 'branch refs/heads/feat/x', 'prunable gitdir file points to non-existent location', '',
  ].join('\n');
  const a = wtx.parseWorktreeList(text);
  assert.equal(a.length, 3);
  assert.deepEqual([a[0].branch, a[1].detached, a[1].locked, a[1].lockReason, a[2].branch, a[2].prunable], ['main', true, true, 'because', 'feat/x', true]);
  assert.equal(a[1].path, '/r/wt one');
  const z = wtx.parseWorktreeList(text.replace(/\n/g, '\0'), true);
  assert.deepEqual(z, a);
});

test('parseStatusV2 counts changes, untracked and ignored, and reads upstream', () => {
  const s = wtx.parseStatusV2([
    '# branch.oid 0123', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/a.js', '2 R. N... 100644 100644 100644 a b R100 new.js', 'old.js',
    '? notes.txt', '! node_modules/', '! .env', '',
  ].join('\0'));
  assert.deepEqual([s.head, s.branch, s.upstream, s.ahead, s.behind, s.changes, s.untracked], ['0123', 'feat', 'origin/feat', 2, 1, 2, 1]);
  assert.deepEqual(s.ignored, ['node_modules/', '.env']);
  const d = wtx.parseStatusV2('# branch.oid 0123\0# branch.head (detached)\0');
  assert.equal(d.detached, true);
  assert.equal(d.ahead, null);
});

test('userIgnored keeps only what is not build output', () => {
  assert.deepEqual(wtx.userIgnored(['node_modules/', 'apps/web/.next/', '.DS_Store', 'a.log', 'next-env.d.ts', 'src/icons.generated.ts', '.env', 'uploads/']), ['.env', 'uploads']);
});

test('likelyCreator is a labelled guess from path and branch', () => {
  assert.equal(wtx.likelyCreator('/r/app/.claude/worktrees/agent-a1b2c3', 'worktree-agent-a1b2c3').id, 'claude');
  assert.equal(wtx.likelyCreator('C:\\r\\app\\.claude\\worktrees\\x', 'x').id, 'claude');
  assert.equal(wtx.likelyCreator('/home/u/.codex/worktrees/abc/app', 'main').id, 'codex');
  assert.equal(wtx.likelyCreator('/r/app-wt', 'codex/fix-login').id, 'codex');
  assert.equal(wtx.likelyCreator('/home/u/.cursor/worktrees/app/x', 'x').id, 'cursor');
  assert.equal(wtx.likelyCreator('/home/u/conductor/workspaces/app/oslo', 'oslo').id, 'conductor');
  assert.equal(wtx.likelyCreator('/r/agent-77', 'x').id, 'agent');
  assert.equal(wtx.likelyCreator('/r/app-worktrees/feature', 'feature/login').id, 'manual');
});

test('removalEligibility: clean, unlocked and merged or pushed only', () => {
  const ok = { exists: true, head: 'a', branch: 'f', changes: 0, untracked: 0, ignoredOther: [], merged: true };
  assert.equal(wtx.removalEligibility(ok).ok, true);
  assert.equal(wtx.removalEligibility({ ...ok, merged: false, pushed: true, upstream: 'origin/f', ahead: 0 }).ok, true);
  const cases = [
    [{ ...ok, isMain: true }, /main checkout/],
    [{ ...ok, exists: false }, /gone/],
    [{ ...ok, changes: 2 }, /2 uncommitted changes/],
    [{ ...ok, untracked: 1 }, /1 untracked file/],
    [{ ...ok, locked: true, lockReason: 'in use' }, /Locked: in use/],
    [{ ...ok, ignoredOther: ['.env'] }, /\.env/],
    [{ ...ok, nestedCheckout: true }, /lives inside it/],
    [{ ...ok, merged: false, pushed: false }, /not merged and not pushed/],
    [{ ...ok, merged: false, upstream: 'origin/f', ahead: 3 }, /3 commits ahead of origin\/f/],
    [{ ...ok, merged: false, detached: true }, /Detached HEAD/],
    [{ ...ok, merged: null }, /not merged/],
    [{ ...ok, error: 'Spaci could not read its git status.' }, /could not read/],
  ];
  for (const [wt, re] of cases) {
    const e = wtx.removalEligibility(wt);
    assert.equal(e.ok, false, JSON.stringify(wt));
    assert.match(e.reasons.join(' '), re);
  }
  assert.equal(wtx.removalEligibility({ ...ok, exists: false }).missing, true);
});

test('restoreHint names the kept branch, or the commit when detached', () => {
  assert.equal(restoreHints.worktreeRestoreHint({ path: '/r/wt', branch: 'feat/x' }), 'git worktree add /r/wt feat/x');
  assert.equal(restoreHints.worktreeRestoreHint({ path: '/r/my wt', branch: 'b' }), 'git worktree add "/r/my wt" b');
  assert.equal(restoreHints.worktreeRestoreHint({ path: '/r/wt', detached: true, head: 'abc' }), 'git worktree add --detach /r/wt abc');
});

test('packageOf picks the longest package folder', () => {
  assert.equal(repoGroup.packageOf('apps/web/node_modules', ['apps', 'apps/web', 'api']), 'apps/web');
  assert.equal(repoGroup.packageOf('node_modules', ['apps/web']), '');
  assert.equal(repoGroup.packageOf('apps/website/dist', ['apps/web']), '');
});

// ---------------------------------------------------------------------------
// A real repository with every kind of worktree
// ---------------------------------------------------------------------------

function buildFixture() {
  const root = tmp('spaci-wt-');
  const outside = tmp('spaci-wt-out-');

  // An origin, so origin/HEAD exists and "pushed" can be tested.
  const seed = path.join(outside, 'seed');
  write(seed, '.gitignore', 'node_modules/\ndist/\n.env\nvendor2/\n.claude/\n');
  write(seed, 'backend/package.json', '{"name":"backend"}');
  write(seed, 'backend/index.js', 'module.exports = 1;\n');
  write(seed, 'frontend/package.json', '{"name":"frontend"}');
  write(seed, 'frontend/src/app.js', 'console.log(1);\n');
  git(seed, 'init', '-q'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'init');
  const origin = path.join(outside, 'origin.git');
  git(outside, 'clone', '-q', '--bare', seed, origin);
  const mono = path.join(root, 'mono');
  git(root, 'clone', '-q', origin, mono);
  write(mono, 'backend/node_modules/left-pad/index.js', 'y'.repeat(8192));

  const W = path.join(root, 'mono-worktrees');
  const wt = (name) => path.join(W, name);
  const add = (...args) => git(mono, 'worktree', 'add', '-q', ...args);

  // Merged: a commit fast-forwarded into main and pushed.
  add('-b', 'feat-merged', wt('merged'));
  write(wt('merged'), 'backend/feature.js', 'merged work\n');
  git(wt('merged'), 'add', '-A'); git(wt('merged'), 'commit', '-qm', 'merged work');
  git(mono, 'merge', '-q', '--ff-only', 'feat-merged');
  git(mono, 'push', '-q', 'origin', 'main');
  write(wt('merged'), 'backend/node_modules/lib/index.js', 'z'.repeat(16384));
  write(wt('merged'), 'frontend/dist/bundle.js', 'b'.repeat(4096));

  // Claude Code style, nested inside the main checkout, no commits of its own.
  const agent = path.join(mono, '.claude', 'worktrees', 'agent-a1b2c3d4');
  add('-b', 'worktree-agent-a1b2c3d4', agent);
  write(agent, 'frontend/node_modules/react/index.js', 'r'.repeat(8192));

  // Unmerged and never pushed.
  add('-b', 'feat-unmerged', wt('unmerged'));
  write(wt('unmerged'), 'backend/wip.js', 'only here\n');
  git(wt('unmerged'), 'add', '-A'); git(wt('unmerged'), 'commit', '-qm', 'wip');

  // Not merged, but pushed to its upstream.
  add('-b', 'feat-pushed', wt('pushed'));
  write(wt('pushed'), 'frontend/pushed.js', 'pushed\n');
  git(wt('pushed'), 'add', '-A'); git(wt('pushed'), 'commit', '-qm', 'pushed');
  git(wt('pushed'), 'push', '-q', '-u', 'origin', 'feat-pushed');

  // Merged but dirty.
  add('-b', 'feat-dirty', wt('dirty'));
  write(wt('dirty'), 'backend/index.js', 'changed\n');

  // Merged but locked.
  add('-b', 'feat-locked', wt('locked'));
  git(mono, 'worktree', 'lock', '--reason', 'agent running', wt('locked'));

  // Its folder deleted by hand.
  add('-b', 'feat-gone', wt('gone'));
  fs.rmSync(wt('gone'), { recursive: true, force: true });

  // Detached at main.
  add('--detach', wt('detached'), 'main');

  // Merged, but holds a .env git ignores.
  add('-b', 'feat-secrets', wt('secrets'));
  write(wt('secrets'), '.env', 'API_KEY=secret\n');

  // Merged, but a cloned repository sits in an ignored folder inside it.
  add('-b', 'feat-nest', wt('nest'));
  const clone = path.join(wt('nest'), 'vendor2', 'lib');
  write(clone, 'README.md', 'clone');
  git(clone, 'init', '-q'); git(clone, 'add', '-A'); git(clone, 'commit', '-qm', 'c');

  // A worktree made from another worktree still belongs to mono.
  git(wt('merged'), 'worktree', 'add', '-q', '-b', 'feat-wtofwt', wt('wt-of-wt'));

  // A submodule is a repository of its own.
  const lib = path.join(outside, 'lib');
  write(lib, 'package.json', '{"name":"lib"}');
  git(lib, 'init', '-q'); git(lib, 'add', '-A'); git(lib, 'commit', '-qm', 'lib');
  git(mono, 'submodule', 'add', '-q', lib, 'libs/sub');
  git(mono, 'commit', '-qm', 'add submodule');

  // A repository outside the scan root whose worktree is inside it.
  const far = path.join(outside, 'far-main');
  write(far, 'package.json', '{"name":"far"}');
  write(far, '.gitignore', 'node_modules/\n');
  git(far, 'init', '-q'); git(far, 'add', '-A'); git(far, 'commit', '-qm', 'far');
  const near = path.join(root, 'far-wt');
  git(far, 'worktree', 'add', '-q', '-b', 'near', near);
  write(near, 'node_modules/x/index.js', 'n'.repeat(4096));

  return { root, outside, mono, W, wt, agent, origin, lib, far, near, sub: path.join(mono, 'libs', 'sub') };
}

const F = buildFixture();
let scanned = null;
async function scanFixture() {
  if (!scanned) scanned = await scanner.scanProjects(F.root, null, new AbortController().signal, { measureMain: true });
  return scanned;
}
const recordAt = (projects, p) => projects.find((x) => wtx.pathKey(x.path) === wtx.pathKey(p));
const wtAt = (rec, p) => rec.repo.worktrees.find((w) => wtx.pathKey(w.path) === wtx.pathKey(p));

test('readGitEntry tells a main checkout, a linked worktree and a submodule apart', async () => {
  const main = await wtx.readGitEntry(F.mono);
  assert.equal(main.kind, 'main');
  const linked = await wtx.readGitEntry(F.wt('merged'));
  assert.equal(linked.kind, 'worktree');
  assert.equal(wtx.pathKey(linked.mainRoot), wtx.pathKey(F.mono));
  const ofWt = await wtx.readGitEntry(F.wt('wt-of-wt'));
  assert.equal(wtx.pathKey(ofWt.mainRoot), wtx.pathKey(F.mono), 'a worktree of a worktree resolves to the real main');
  const sub = await wtx.readGitEntry(F.sub);
  assert.equal(sub.kind, 'submodule');
  assert.equal(await wtx.readGitEntry(path.join(F.mono, 'backend')), null);
  const co = await wtx.findCheckout(path.join(F.wt('merged'), 'backend'));
  assert.equal(wtx.pathKey(co.root), wtx.pathKey(F.wt('merged')));
});

test('one record per repository: packages and worktrees fold into it', async () => {
  const { projects, stats } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  assert.ok(mono, 'the monorepo has one record');
  // Nothing inside a worktree or a package is a record of its own.
  for (const p of projects) {
    const k = wtx.pathKey(p.path);
    assert.ok(!wtx.isInsideKey(wtx.pathKey(F.W), k) && k !== wtx.pathKey(F.W), 'no record inside the worktrees folder: ' + p.path);
    assert.ok(!k.includes(`${path.sep}.claude${path.sep}`.toLowerCase()) && !p.path.includes(`${path.sep}.claude${path.sep}`), 'no record for the nested worktree: ' + p.path);
  }
  assert.equal(projects.filter((p) => wtx.pathKey(p.path) === wtx.pathKey(path.join(F.mono, 'backend'))).length, 0, 'packages are not records');
  assert.deepEqual(mono.repo.packages.map((p) => p.rel).sort(), ['backend', 'frontend']);
  assert.ok(stats.raw > projects.length, 'raw records were folded');
  assert.equal(mono.repo.defaultBranch, 'origin/main');
});

test('every linked worktree is listed, with its properties', async () => {
  const { projects } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  const names = ['merged', 'unmerged', 'pushed', 'dirty', 'locked', 'gone', 'detached', 'secrets', 'nest', 'wt-of-wt'];
  for (const n of names) assert.ok(wtAt(mono, F.wt(n)), 'lists ' + n);
  assert.ok(wtAt(mono, F.agent), 'lists the nested .claude worktree');
  assert.equal(mono.repo.worktrees.length, names.length + 1);

  const merged = wtAt(mono, F.wt('merged'));
  assert.equal(merged.branch, 'feat-merged');
  assert.equal(merged.merged, true);
  assert.equal(merged.changes + merged.untracked, 0);
  assert.ok(merged.size > 16384, 'sized');
  assert.ok(merged.lastCommit > 0 && merged.lastActivity >= merged.lastCommit);
  assert.match(merged.head, /^[0-9a-f]{40,64}$/);
  assert.equal(merged.creator.id, 'manual');

  const pushed = wtAt(mono, F.wt('pushed'));
  assert.deepEqual([pushed.merged, pushed.upstream, pushed.ahead, pushed.pushed], [false, 'origin/feat-pushed', 0, true]);
  const unmerged = wtAt(mono, F.wt('unmerged'));
  assert.deepEqual([unmerged.merged, unmerged.pushed], [false, false]);
  assert.equal(wtAt(mono, F.wt('dirty')).changes, 1);
  const locked = wtAt(mono, F.wt('locked'));
  assert.deepEqual([locked.locked, locked.lockReason], [true, 'agent running']);
  const gone = wtAt(mono, F.wt('gone'));
  assert.deepEqual([gone.exists, gone.prunable], [false, true]);
  assert.equal(mono.repo.missing, 1);
  const det = wtAt(mono, F.wt('detached'));
  assert.deepEqual([det.detached, det.branch, det.merged], [true, null, true]);
  assert.deepEqual(wtAt(mono, F.wt('secrets')).ignoredOther, ['.env']);
  const agent = wtAt(mono, F.agent);
  assert.deepEqual([agent.creator.id, agent.nested, agent.merged], ['claude', true, true]);
});

test('eligibility: only clean, unlocked, merged or pushed worktrees are offered', async () => {
  const { projects } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  const ok = (p) => wtAt(mono, p).eligibility.ok;
  for (const n of ['merged', 'pushed', 'detached', 'wt-of-wt']) assert.equal(ok(F.wt(n)), true, n + ' is removable');
  assert.equal(ok(F.agent), true, 'the nested agent worktree is removable');
  for (const n of ['unmerged', 'dirty', 'locked', 'gone', 'secrets', 'nest']) assert.equal(ok(F.wt(n)), false, n + ' is not');
  assert.match(wtAt(mono, F.wt('nest')).eligibility.reasons.join(' '), /lives inside it/);
  assert.equal(mono.repo.removable.count, 5);
  const sum = mono.repo.worktrees.filter((w) => w.eligibility.ok).reduce((s, w) => s + w.size, 0);
  assert.equal(mono.repo.removable.bytes, sum);
});

test('sizes add up without counting nested worktrees twice', async () => {
  const { projects } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  const r = mono.repo;
  const du = await scanner.dirSize(F.mono);
  const nested = r.worktrees.filter((w) => w.exists && w.nested).reduce((s, w) => s + w.size, 0);
  const external = r.worktrees.filter((w) => w.exists && !w.nested).reduce((s, w) => s + w.size, 0);
  assert.ok(nested > 0 && external > 0);
  // du of the main folder already includes .claude/worktrees.
  const tol = 64 * 1024;
  assert.ok(Math.abs(r.totalBytes - (du + external)) <= tol, `total ${r.totalBytes} vs ${du + external}`);
  assert.ok(Math.abs(r.mainSize - (du - nested)) <= tol);
  assert.equal(r.worktreeBytes, nested + external);
  assert.equal(r.externalWorktreeBytes, external);
});

test('without measureMain the main folder is left to enrichment, and worktree figures still add up', async () => {
  const { projects } = await scanner.scanProjects(F.root, null, new AbortController().signal);
  const r = recordAt(projects, F.mono).repo;
  assert.deepEqual([r.mainDu, r.mainSize, r.totalBytes], [null, null, null]);
  assert.ok(r.worktreeBytes > 0 && r.externalWorktreeBytes > 0 && r.externalWorktreeBytes < r.worktreeBytes);
});

test('artifacts inside worktrees stay tier A, tagged, and are never counted twice', async () => {
  const { projects } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  const nm = path.join(F.wt('merged'), 'backend', 'node_modules');
  const it = mono.items.find((i) => wtx.pathKey(i.path) === wtx.pathKey(nm));
  assert.ok(it, 'node_modules inside the worktree is an item of the repo');
  assert.deepEqual([it.safe, it.worktree, it.pkg, wtx.pathKey(it.checkout)], [true, true, 'backend', wtx.pathKey(F.wt('merged'))]);
  assert.equal(cleanTiers.tierOfProjectItem(it).tier, 'A');
  const plan = cleanTiers.planTierA({ projects });
  assert.ok(plan.jobs.some((j) => j.path === it.path), 'Clean all developer files covers it');
  assert.ok(plan.jobs.every((j) => j.kind === 'artifact' || j.kind === 'cache'), 'Clean all never plans a worktree removal');
  const v = await scanner.revalidateArtifact(it.path);
  assert.deepEqual(v, { ok: true, verified: true }, 'git check-ignore evidence works inside a worktree');

  const all = projects.flatMap((p) => p.items.map((i) => wtx.pathKey(i.path)));
  assert.equal(new Set(all).size, all.length, 'no item appears twice');
  const sum = projects.reduce((s, p) => s + p.cleanableSize, 0);
  const itemSum = projects.reduce((s, p) => s + p.items.filter((i) => i.safe).reduce((a, i) => a + i.size, 0), 0);
  assert.equal(sum, itemSum);
  const w = wtAt(mono, F.wt('merged'));
  assert.ok(w.artifactBytes >= it.size);
});

test('a submodule and a nested clone are repositories of their own', async () => {
  const { projects } = await scanFixture();
  const sub = recordAt(projects, F.sub);
  assert.ok(sub, 'the submodule has its own record');
  assert.equal(sub.repo.worktrees.length, 0);
  const mono = recordAt(projects, F.mono);
  assert.ok(!mono.repo.packages.some((p) => p.rel.startsWith('libs')), 'the submodule is not a package of mono');
});

test('a worktree whose main is outside the scan root is grouped under that main', async () => {
  const { projects } = await scanFixture();
  const far = recordAt(projects, F.far);
  assert.ok(far, 'grouped under the outside main path');
  assert.equal(far.repo.mainInScan, false);
  const near = wtAt(far, F.near);
  assert.ok(near && near.inScan);
  assert.ok(far.items.some((i) => wtx.pathKey(i.checkout) === wtx.pathKey(F.near) && i.name === 'node_modules'));
  assert.equal(recordAt(projects, F.near), undefined);
});

test('a parent repository that tracks nothing in a project does not swallow it', async () => {
  const root = tmp('spaci-dot-');
  write(root, '.gitignore', '*\n');
  git(root, 'init', '-q');
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, 'node_modules/x/index.js', 'x');
  const { projects } = await scanner.scanProjects(root, null, new AbortController().signal);
  assert.ok(recordAt(projects, proj), 'the project keeps its own record');
  assert.equal(recordAt(projects, root), undefined);
});

test('dropWorktrees takes a worktree and its items out and recomputes every figure', async () => {
  const { projects } = await scanFixture();
  const mono = recordAt(projects, F.mono);
  const target = wtAt(mono, F.wt('merged'));
  const nestedOne = wtAt(mono, F.agent);
  const next = repoSummary.dropWorktrees(mono, [target.path, nestedOne.path]);
  assert.equal(next.repo.worktrees.length, mono.repo.worktrees.length - 2);
  assert.ok(!next.items.some((i) => i.checkout === target.path || i.checkout === nestedOne.path));
  assert.ok(mono.items.some((i) => i.checkout === target.path), 'items carry the worktree path as listed');
  assert.equal(next.repo.removable.count, mono.repo.removable.count - 2);
  assert.equal(next.repo.totalBytes, mono.repo.totalBytes - target.size - nestedOne.size);
  assert.equal(next.repo.mainSize, mono.repo.mainSize, 'the main checkout itself did not change');
  assert.ok(next.cleanableSize < mono.cleanableSize);
  assert.equal(mono.repo.worktrees.length, 11, 'the original record is untouched');
});

// ---------------------------------------------------------------------------
// Remove and prune (runs last: it changes the fixture)
// ---------------------------------------------------------------------------

const opts = { dirSize: scanner.dirSize };
const branchExists = (b) => { try { git(F.mono, 'rev-parse', '--verify', '-q', 'refs/heads/' + b); return true; } catch { return false; } };

test('remove refuses anything not clean, merged or pushed, and leaves it untouched', async () => {
  await scanFixture();
  for (const n of ['unmerged', 'dirty', 'locked', 'secrets', 'nest']) {
    const r = await wtx.removeWorktree(F.mono, F.wt(n), opts);
    assert.equal(r.ok, false, n);
    assert.equal(r.refused, true, n);
    assert.ok(r.reasons.length > 0);
    assert.ok(fs.existsSync(F.wt(n)), n + ' is still on disk');
  }
  assert.ok(fs.existsSync(path.join(F.wt('secrets'), '.env')), 'the ignored .env is intact');
  const main = await wtx.removeWorktree(F.mono, F.mono, opts);
  assert.equal(main.ok, false);
  assert.match(main.reasons.join(' '), /main checkout/);
  const unknown = await wtx.removeWorktree(F.mono, path.join(F.root, 'nope'), opts);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reasons.join(' '), /no longer lists/);
});

test('remove re-verifies right before running: a change since the scan blocks it', async () => {
  const { projects } = await scanFixture();
  assert.equal(wtAt(recordAt(projects, F.mono), F.wt('pushed')).eligibility.ok, true, 'eligible at scan time');
  write(F.wt('pushed'), 'new-notes.txt', 'written after the scan');
  const r = await wtx.removeWorktree(F.mono, F.wt('pushed'), opts);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /1 untracked file/);
  assert.ok(fs.existsSync(path.join(F.wt('pushed'), 'new-notes.txt')));
});

test('remove deletes a merged, clean worktree and keeps its branch', async () => {
  await scanFixture();
  const target = F.wt('wt-of-wt');
  const r = await wtx.removeWorktree(F.mono, target, opts);
  assert.equal(r.ok, true, JSON.stringify(r.reasons || r.error));
  assert.equal(fs.existsSync(target), false);
  assert.equal(branchExists('feat-wtofwt'), true, 'the branch is kept');
  assert.equal(restoreHints.worktreeRestoreHint(r), `git worktree add ${target} feat-wtofwt`);
  const listed = wtx.parseWorktreeList(git(F.mono, 'worktree', 'list', '--porcelain'));
  assert.ok(!listed.some((e) => wtx.pathKey(e.path) === wtx.pathKey(target)));
  // Build output inside it went with it, ignored files included.
  const m = await wtx.removeWorktree(F.mono, F.wt('merged'), opts);
  assert.equal(m.ok, true);
  assert.ok(m.bytes > 16384, 'reports the size it freed');
  assert.equal(branchExists('feat-merged'), true);
  const d = await wtx.removeWorktree(F.mono, F.wt('detached'), opts);
  assert.equal(d.ok, true);
  assert.match(restoreHints.worktreeRestoreHint(d), /^git worktree add --detach /);
});

test('prune clears only worktrees whose folder is gone', async () => {
  const before = wtx.parseWorktreeList(git(F.mono, 'worktree', 'list', '--porcelain'));
  assert.ok(before.some((e) => e.prunable));
  const r = await wtx.pruneWorktrees(F.mono);
  assert.equal(r.ok, true);
  assert.ok(r.pruned.length >= 1);
  const after = wtx.parseWorktreeList(git(F.mono, 'worktree', 'list', '--porcelain'));
  assert.ok(!after.some((e) => e.prunable));
  assert.equal(after.length, before.length - 1, 'only the missing one went');
  assert.ok(fs.existsSync(F.wt('locked')) && fs.existsSync(F.wt('dirty')));
  assert.equal(branchExists('feat-gone'), true, 'its branch is kept');
  const again = await wtx.pruneWorktrees(F.mono);
  assert.deepEqual(again, { ok: true, pruned: [] });
});

test('the clean gate treats a worktree as needing confirmation, so auto-clean never removes one', () => {
  const ctx = cleanPlan.buildPlanContext({ worktrees: [{ path: F.wt('pushed'), main: F.mono }] });
  const c = cleanPlan.classifyJob(F.wt('pushed'), ctx);
  assert.equal(c.kind, 'worktree');
  assert.equal(c.needsConfirmation, true);
  const gate = cleanPlan.gateJobs([{ path: F.wt('pushed') }], ctx, false);
  assert.equal(gate.pass.length, 0);
  assert.equal(gate.refused[0].reason, 'needs-confirmation');
});
