'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTargetIndex } = require('../src/clean-guard');
const plan = require('../src/clean-plan');

const TARGETS = [
  { id: 'npm', safe: true, reversible: true, paths: ['/h/.npm/_cacache'] },
  { id: 'trash', safe: false, reversible: false, paths: ['/h/.Trash'] },
  { id: 'xcode-archives', safe: false, reversible: false, paths: ['/h/Library/Developer/Xcode/Archives'] },
  { id: 'huggingface', safe: false, reversible: true, paths: ['/h/.cache/huggingface'] },
  { id: 'claude-projects', safe: true, reversible: false, tool: 'claude', paths: ['/h/.claude/projects'] },
];
const ctx = plan.buildPlanContext({
  targetIndex: buildTargetIndex(TARGETS),
  projects: [{ path: '/h/app', items: [{ path: '/h/app/node_modules' }] }, { path: '/h/bad', items: null }],
  largeFiles: new Set(['/h/Movies/big.mov']),
});

test('main decides kind and reversibility per job', () => {
  const c = (p) => { const r = plan.classifyJob(p, ctx); return [r.kind, r.reversible, r.needsConfirmation]; };
  assert.deepEqual(c('/h/.npm/_cacache'), ['cache', 'rebuild', false]);
  assert.deepEqual(c('/h/.Trash'), ['trash', 'none', true]);
  assert.deepEqual(c('/h/Library/Developer/Xcode/Archives'), ['cache', 'none', true]);
  assert.deepEqual(c('/h/.cache/huggingface'), ['cache', 'rebuild', true], 'unsafe needs confirmation even if rebuildable');
  assert.deepEqual(c('/h/.claude/projects'), ['cache', 'none', true], 'irreversible needs confirmation even if safe');
  assert.deepEqual(c('/h/app/node_modules'), ['artifact', 'rebuild', false]);
  assert.equal(plan.classifyJob('/h/app/node_modules', ctx).project, '/h/app');
  assert.deepEqual(c('/h/Movies/big.mov'), ['file', 'trash', true]);
  assert.deepEqual(c('/etc/hosts'), ['other', 'none', false]);
});

test('the gate refuses what needs confirmation unless confirmed is exactly true', () => {
  const jobs = [{ path: '/h/.npm/_cacache' }, { path: '/h/.Trash' }, { path: '/h/Movies/big.mov' }, { path: '/h/app/node_modules' }, null, { path: '' }];
  for (const confirmed of [undefined, false, 'true', 1]) {
    const { pass, refused } = plan.gateJobs(jobs, ctx, confirmed);
    assert.deepEqual(pass.map((j) => j.path), ['/h/.npm/_cacache', '/h/app/node_modules']);
    assert.deepEqual(refused, [
      { path: '/h/.Trash', target: 'trash', reason: 'needs-confirmation' },
      { path: '/h/Movies/big.mov', reason: 'needs-confirmation' },
    ]);
  }
  const ok = plan.gateJobs(jobs, ctx, true);
  assert.equal(ok.pass.length, 4);
  assert.deepEqual(ok.refused, []);
});

test('the renderer cannot dodge the gate with a differently spelled path', () => {
  const { refused } = plan.gateJobs([{ path: '/h/.Trash/' }, { path: '/h/./.Trash' }], ctx, false);
  assert.equal(refused.length, 2);
});
