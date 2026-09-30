'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tiers = require('../src/clean-tiers');
const { buildSystemTargets } = require('../src/storage-classifier');
const { CLEAN_RULES } = require('../src/scanner');
const { PRUNE_KINDS } = require('../src/docker');

const { TIERS, tierOfProjectItem, tierOfTarget, tierOfDockerKind, classifyScan, planTierA } = tiers;

const item = (name, o = {}) => ({ name, path: '/p/app/' + name, size: 100, safe: true, reversible: true, ...o });

test('verified build output is A; unverified is never A', () => {
  for (const n of ['node_modules', '.next', 'target', 'build', 'dist', '__pycache__', '.gradle', 'Pods', '.turbo']) {
    assert.equal(tierOfProjectItem(item(n)).tier, 'A', n);
    assert.equal(tierOfProjectItem(item(n, { safe: false })).tier, 'B', n + ' unverified');
    assert.equal(tierOfProjectItem(item(n, { safe: undefined })).tier, 'B', n + ' missing flag');
  }
});

test('virtualenvs, unknown names and irreversible project items are not A', () => {
  assert.equal(tierOfProjectItem(item('.venv', { safe: false })).tier, 'B');
  assert.equal(tierOfProjectItem(item('venv', { safe: true })).tier, 'B', 'not in the allowlist even if marked safe');
  assert.equal(tierOfProjectItem(item('mystery')).tier, 'B');
  assert.equal(tierOfProjectItem(item('node_modules', { reversible: false })).tier, 'C');
  assert.equal(tierOfProjectItem(null).tier, 'B');
});

test('every scanner rule has a deliberate tier', () => {
  for (const r of CLEAN_RULES) {
    const t = tierOfProjectItem(item(r.match, { safe: r.safe })).tier;
    if (r.safe) assert.equal(t, 'A', r.match + ' is a safe rule but not tier A');
    else assert.equal(t, 'B', r.match);
  }
});

test('every system target on every platform maps to a tier, and A is exactly the dev cache allowlist', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\a', TEMP: 'D:\\tmp' };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const home = platform === 'win32' ? 'C:\\Users\\a' : '/home/a';
    const list = buildSystemTargets({ platform, home, env: platform === 'win32' ? env : {} });
    assert.ok(list.length > 10);
    for (const t of list) {
      const r = tierOfTarget(t);
      assert.ok(['A', 'B', 'C'].includes(r.tier), t.id);
      assert.ok(r.reason, t.id);
      if (r.tier === 'A') {
        assert.ok(tiers.A_TARGETS[t.id], `${t.id} is A but not allowlisted`);
        assert.equal(t.safe, true);
        assert.notEqual(t.reversible, false);
        assert.equal(t.tool, undefined, 'AI tool data is never A');
      }
      if (t.reversible === false) assert.equal(r.tier, 'C', t.id);
    }
    const byId = Object.fromEntries(list.map((t) => [t.id, tierOfTarget(t).tier]));
    assert.equal(byId.npm, 'A');
    assert.equal(byId.go, 'A');
    assert.equal(byId.huggingface, 'B');
    if (platform !== 'win32') assert.equal(byId.trash, 'C');
    if (platform === 'darwin') {
      assert.equal(byId['xcode-derived'], 'A');
      assert.equal(byId['xcode-archives'], 'C');
      assert.equal(byId['simulator-caches'], 'B');
      assert.equal(byId['xcode-devicesupport'], 'B');
      assert.equal(byId['user-caches'], 'B');
      assert.equal(byId['cli-cache'], 'B');
      assert.equal(byId['user-logs'], 'C');
      assert.equal(byId['saved-state'], 'C');
      assert.equal(byId['claude-cache'], 'B');
      assert.equal(byId['claude-transcripts'], 'C');
    }
  }
});

test('browser caches are B; an unknown safe target is B', () => {
  assert.equal(tierOfTarget({ id: 'chrome-cache', category: 'Browsers', safe: true, reversible: true }).tier, 'B');
  assert.equal(tierOfTarget({ id: 'something-new', safe: true, reversible: true }).tier, 'B');
  assert.equal(tierOfTarget({ id: 'npm', safe: false, reversible: true }).tier, 'B', 'allowlisted id but unsafe flag');
});

test('Docker is never A: images and cache B, containers and volumes C', () => {
  for (const k of Object.keys(PRUNE_KINDS)) assert.notEqual(tierOfDockerKind(k).tier, 'A', k);
  assert.equal(tierOfDockerKind('build-cache').tier, 'B');
  assert.equal(tierOfDockerKind('unused-images').tier, 'B');
  assert.equal(tierOfDockerKind('stopped-containers').tier, 'C');
  assert.equal(tierOfDockerKind('volume').tier, 'C');
  assert.equal(tierOfDockerKind('what').tier, 'C');
  assert.equal(tiers.tierOfLargeFile().tier, 'C');
});

test('classifyScan trusts main, not the renderer', () => {
  const shown = {
    projects: [{ path: '/p/app', items: [item('node_modules'), item('dist', { safe: true })] }],
    sysTargets: [{ id: 'npm', safe: true, reversible: true }, { id: 'trash', safe: true, reversible: true }, { id: 'fake', safe: true }],
  };
  const trusted = {
    targetsById: new Map([['npm', { id: 'npm', safe: true, reversible: true }], ['trash', { id: 'trash', safe: false, reversible: false }]]),
    // dist was unverified in main's scan; the renderer claims it is safe.
    itemsByPath: new Map([['/p/app/node_modules', item('node_modules')], ['/p/app/dist', item('dist', { safe: false })]]),
  };
  const r = classifyScan(shown, trusted);
  assert.equal(r.items['/p/app/node_modules'].tier, 'A');
  assert.equal(r.items['/p/app/dist'].tier, 'B');
  assert.equal(r.system.npm.tier, 'A');
  assert.equal(r.system.trash.tier, 'C', 'renderer cannot make the Trash safe');
  assert.equal(r.system.fake.tier, 'B', 'unknown target');
  // An item main never saw is not A.
  const r2 = classifyScan({ projects: [{ path: '/x', items: [item('node_modules', { path: '/x/node_modules' })] }] }, { itemsByPath: new Map() });
  assert.equal(r2.items['/x/node_modules'].tier, 'B');
  assert.equal(r.docker['unused-images'].tier, 'B');
});

test('planTierA selects every A item across projects and caches, grouped by kind', () => {
  const shown = {
    projects: [
      { path: '/p/a', items: [item('node_modules', { path: '/p/a/node_modules', size: 500 }), item('.next', { path: '/p/a/.next', size: 50 }), item('venv', { path: '/p/a/venv', safe: false, size: 900 })] },
      { path: '/p/b', items: [item('target', { path: '/p/b/target', size: 300 }), item('dist', { path: '/p/b/dist', safe: false, size: 70 })] },
    ],
    sysTargets: [
      { id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 1000, existingPaths: ['/h/.npm/_cacache'] },
      { id: 'cargo', name: 'Cargo registry', safe: true, reversible: true, size: 200, existingPaths: ['/h/.cargo/registry/cache', '/h/.cargo/registry/src'] },
      { id: 'user-caches', name: 'Other app caches', safe: true, reversible: true, size: 4000, existingPaths: ['/h/Library/Caches'] },
      { id: 'trash', name: 'Trash', safe: false, reversible: false, size: 9000, existingPaths: ['/h/.Trash'] },
    ],
  };
  const plan = planTierA(shown);
  const paths = plan.jobs.map((j) => j.path).sort();
  assert.deepEqual(paths, ['/h/.cargo/registry/cache', '/h/.cargo/registry/src', '/h/.npm/_cacache', '/p/a/.next', '/p/a/node_modules', '/p/b/target']);
  assert.equal(plan.count, 5, 'cargo counts once although it has two paths');
  assert.equal(plan.bytes, 500 + 50 + 300 + 1000 + 200);
  assert.equal(plan.projects, 2);
  const cacheJobs = plan.jobs.filter((j) => j.kind === 'cache');
  assert.ok(cacheJobs.every((j) => j.mode === 'contents'), 'caches keep their folder');
  const artifactJobs = plan.jobs.filter((j) => j.kind === 'artifact');
  assert.ok(artifactJobs.every((j) => !j.mode), 'artifacts are removed whole');
  assert.equal(plan.jobs.reduce((s, j) => s + j.size, 0), plan.bytes, 'sizes are not double counted');
  const g = Object.fromEntries(plan.groups.map((x) => [x.key, x]));
  assert.equal(g['Package caches'].count, 2);
  assert.equal(g.node_modules.bytes, 500);
  assert.ok(g.node_modules.hint.includes('npm ci'));
  assert.equal(plan.groups[0].key, 'Package caches', 'largest group first');
});

test('planTierA skips empty things', () => {
  const plan = planTierA({
    projects: [{ path: '/p/a', items: [item('node_modules', { path: '/p/a/node_modules', size: 0 })] }],
    sysTargets: [{ id: 'npm', safe: true, reversible: true, size: 0, existingPaths: ['/h/.npm/_cacache'] }],
  });
  assert.equal(plan.count, 0);
});

test('planTierA of an empty scan is empty', () => {
  const plan = planTierA({});
  assert.deepEqual(plan, { jobs: [], groups: [], count: 0, bytes: 0, projects: 0 });
  assert.equal(TIERS.A, 'A');
  assert.deepEqual(Object.keys(tiers.BADGES), ['A', 'B', 'C']);
});

test('the Maven repository is B: never in Clean all, never auto-cleaned', () => {
  // `mvn install` puts local builds in ~/.m2/repository that nothing re-downloads.
  const maven = { id: 'maven', name: 'Maven repository', safe: true, reversible: true, size: 5e9, existingPaths: ['/h/.m2/repository'] };
  const r = tierOfTarget(maven);
  assert.equal(r.tier, 'B');
  assert.match(r.reason, /mvn install/);
  assert.equal(tiers.A_TARGETS.maven, undefined);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const t = buildSystemTargets({ platform, home: platform === 'win32' ? 'C:\\Users\\a' : '/home/a', env: {} }).find((x) => x.id === 'maven');
    if (t) assert.equal(tierOfTarget(t).tier, 'B', platform);
  }
  const plan = planTierA({ sysTargets: [maven, { id: 'npm', name: 'npm cache', safe: true, reversible: true, size: 10, existingPaths: ['/h/.npm/_cacache'] }] });
  assert.deepEqual(plan.jobs.map((j) => j.path), ['/h/.npm/_cacache']);
  const ac = require('../src/auto-clean');
  const sel = ac.selectCandidates({ system: [maven], settings: { enabled: true }, now: Date.now(), procs: { ok: true, list: [] }, aiTools: { ok: true, running: [] } });
  assert.deepEqual(sel.candidates, []);
  assert.equal(ac.TARGET_FAMILY.maven, undefined);
  // The Clean all confirmation says so.
  const dash = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'screens', 'dashboard.js'), 'utf8');
  assert.match(dash, /the Maven repository, AI tool history/);
});
