'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTargetIndex, enforceTargetRules } = require('../src/clean-guard');
const { buildSystemTargets } = require('../src/storage-classifier');
const { aiToolStatus } = require('../src/aitools');
const cleaner = require('../src/cleaner');

const notRunning = async () => ({ ok: true, running: [] });

function fixtureTargets() {
  return [
    { id: 'claude-transcripts', tool: 'claude', safe: true, mode: 'contents', paths: ['/h/.claude/projects'], protect: ['memory'] },
    { id: 'codex-databases', tool: 'codex', safe: false, mode: 'files', paths: ['/h/.codex/a.sqlite'] },
    { id: 'cursor-cache', tool: 'cursor', safe: true, mode: 'contents', paths: ['/h/Cursor/Cache'] },
    { id: 'npm', safe: true, mode: 'contents', paths: ['/h/.npm/_cacache'] },
  ];
}

test('protect comes from the target even when the renderer omits it', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const { allowed } = await enforceTargetRules([{ path: '/h/.claude/projects', mode: 'contents' }], { index, toolStatus: notRunning });
  assert.deepEqual(allowed[0].protect, ['memory']);
});

test('a caller can add protection but never remove a target\'s protection', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const { allowed } = await enforceTargetRules(
    [{ path: '/h/.claude/projects', mode: 'contents', protect: ['extra'] }],
    { index, toolStatus: notRunning },
  );
  assert.deepEqual(allowed[0].protect.sort(), ['extra', 'memory']);
});

test('the target decides the mode, whatever the renderer sent', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const { allowed } = await enforceTargetRules([
    { path: '/h/.codex/a.sqlite', mode: 'contents' },
    { path: '/h/.npm/_cacache', mode: 'path' },
  ], { index, toolStatus: notRunning });
  assert.equal(allowed.find((j) => j.path === '/h/.codex/a.sqlite').mode, 'path');
  assert.equal(allowed.find((j) => j.path === '/h/.npm/_cacache').mode, 'contents');
});

test('AI tool data is refused while its tool is running', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const { allowed, refused } = await enforceTargetRules([
    { path: '/h/.claude/projects', mode: 'contents' },
    { path: '/h/Cursor/Cache', mode: 'contents' },
    { path: '/h/.npm/_cacache', mode: 'contents' },
  ], { index, toolStatus: async () => ({ ok: true, running: ['claude'] }) });
  assert.deepEqual(refused.map((r) => r.target), ['claude-transcripts']);
  assert.match(refused[0].reason, /Claude Code is running/);
  assert.deepEqual(allowed.map((j) => j.path).sort(), ['/h/.npm/_cacache', '/h/Cursor/Cache']);
});

test('when detection fails, risky AI targets are refused and safe ones proceed (fail closed)', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const { allowed, refused } = await enforceTargetRules([
    { path: '/h/.codex/a.sqlite' },
    { path: '/h/Cursor/Cache' },
  ], { index, toolStatus: async () => ({ ok: false, running: [] }) });
  assert.deepEqual(refused.map((r) => r.target), ['codex-databases']);
  assert.deepEqual(allowed.map((j) => j.path), ['/h/Cursor/Cache']);
});

test('a throwing or malformed tool status is treated as detection failure, not as "nothing running"', async () => {
  const index = buildTargetIndex(fixtureTargets());
  for (const toolStatus of [async () => { throw new Error('boom'); }, async () => null, async () => ({})]) {
    const { refused } = await enforceTargetRules([{ path: '/h/.codex/a.sqlite' }], { index, toolStatus });
    assert.equal(refused.length, 1);
  }
});

test('tool status is checked at most once per clean', async () => {
  const index = buildTargetIndex(fixtureTargets());
  let calls = 0;
  await enforceTargetRules([
    { path: '/h/.claude/projects' }, { path: '/h/.codex/a.sqlite' }, { path: '/h/Cursor/Cache' },
  ], { index, toolStatus: async () => { calls += 1; return { ok: true, running: [] }; } });
  assert.equal(calls, 1);
});

test('jobs outside known targets pass through untouched, junk jobs are dropped', async () => {
  const index = buildTargetIndex(fixtureTargets());
  const job = { path: '/h/projects/app/node_modules', mode: 'path' };
  const { allowed } = await enforceTargetRules([job, null, {}, { path: '' }, { path: 42 }], { index, toolStatus: notRunning });
  assert.deepEqual(allowed, [job]);
});

test('every real AI target names a tool the guard knows, on every platform', () => {
  const env = { USERPROFILE: 'C:\\U', LOCALAPPDATA: 'C:\\U\\L', APPDATA: 'C:\\U\\R', TEMP: 'C:\\T' };
  const sets = [
    buildSystemTargets({ platform: 'darwin', home: '/Users/x', env: {} }),
    buildSystemTargets({ platform: 'linux', home: '/home/x', env: {} }),
    buildSystemTargets({ platform: 'win32', home: env.USERPROFILE, env }),
  ];
  const { AI_TOOL_NAMES } = require('../src/clean-guard');
  for (const targets of sets) {
    const ai = targets.filter((t) => t.storyCategory === 'aitools');
    assert.ok(ai.length > 0);
    for (const t of ai) assert.ok(AI_TOOL_NAMES[t.tool], `${t.id} has unknown tool ${t.tool}`);
  }
});

test('Windows detection reads tasklist and reports running tools', async () => {
  const csv = '"System Idle Process","0","Services","0","8 K"\r\n"Codex.exe","4242","Console","1","90,000 K"\r\n"explorer.exe","99","Console","1","1 K"\r\n';
  const exec = (file, args, opts, cb) => { assert.equal(file, 'tasklist'); cb(null, csv); };
  assert.deepEqual(await aiToolStatus({ platform: 'win32', exec }), { ok: true, running: ['codex'] });
});

test('Windows detection failure is reported as not ok, so the guard fails closed', async () => {
  const exec = (file, args, opts, cb) => cb(Object.assign(new Error('no tasklist'), { code: 'ENOENT' }));
  assert.deepEqual(await aiToolStatus({ platform: 'win32', exec }), { ok: false, running: [] });
});

test('pgrep "no match" (exit 1) is a clean answer, a missing pgrep is a failure', async () => {
  const miss = (file, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }));
  assert.deepEqual(await aiToolStatus({ platform: 'darwin', exec: miss }), { ok: true, running: [] });
  const gone = (file, args, opts, cb) => cb(Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' }));
  assert.equal((await aiToolStatus({ platform: 'darwin', exec: gone })).ok, false);
});

test('end to end: a renderer-shaped job cleans transcripts and keeps memory', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-guard-'));
  try {
    const projects = path.join(home, '.claude', 'projects');
    const write = (rel, body = 'x') => {
      const p = path.join(projects, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    write('p1/session.jsonl');
    write('p1/sub/agent.jsonl');
    write('p1/memory/MEMORY.md', '# keep me');
    write('p2/memory/fact.md', 'keep me too');

    const targets = buildSystemTargets({ platform: 'darwin', home, env: {} });
    const index = buildTargetIndex(targets);
    assert.ok(index.get(projects), 'the real classifier must define a target for ~/.claude/projects');

    // Exactly what screens/system.js sends: no protect field.
    const { allowed, refused } = await enforceTargetRules([{ path: projects, mode: 'contents' }], { index, toolStatus: notRunning });
    assert.equal(refused.length, 0);
    await cleaner.clean(allowed, () => {}, new AbortController().signal);

    assert.ok(!fs.existsSync(path.join(projects, 'p1', 'session.jsonl')));
    assert.ok(!fs.existsSync(path.join(projects, 'p1', 'sub', 'agent.jsonl')));
    assert.equal(fs.readFileSync(path.join(projects, 'p1', 'memory', 'MEMORY.md'), 'utf8'), '# keep me');
    assert.equal(fs.readFileSync(path.join(projects, 'p2', 'memory', 'fact.md'), 'utf8'), 'keep me too');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
