'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAiToolTargets, runningAiTools, AI_TOOL_IDS } = require('../src/aitools');

function ctxFor(platform, home, env = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const winProfile = env.USERPROFILE || home;
  return {
    platform, home, env, pathApi,
    join: (...p) => pathApi.join(home, ...p),
    winProfile,
    winJoin: (...p) => pathApi.join(winProfile, ...p),
    from: (base, ...p) => (base ? pathApi.join(base, ...p) : null),
  };
}

// Fixture HOME mirroring real layouts. Returns { home, protectedPaths }.
function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-aitools-'));
  const files = [
    // Claude Code: protected
    '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/agents/x.md',
    '.claude/skills/y/SKILL.md', '.claude/hooks/guard.sh', '.claude/commands/c.md', '.claude/plugins/p/plugin.json',
    '.claude/keybindings.json', '.claude/projects/p1/memory/MEMORY.md', '.claude/.claude.json',
    // Claude Code: cleanable
    '.claude/projects/p1/abc.jsonl', '.claude/projects/p1/abc/subagents/a.jsonl', '.claude/file-history/f1/v1',
    '.claude/shell-snapshots/s.sh', '.claude/paste-cache/p.txt', '.claude/telemetry/t.json',
    // Codex
    '.codex/config.toml', '.codex/auth.json', '.codex/AGENTS.md', '.codex/skills/s/SKILL.md', '.codex/plugins/p.json',
    '.codex/sessions/2026/09/rollout.jsonl', '.codex/thread_history_1.sqlite', '.codex/logs_2.sqlite',
    '.codex/generated_images/i.png', '.codex/.tmp/x', '.codex/cache/c',
    // opencode
    '.local/share/opencode/opencode.db', '.local/share/opencode/auth.json', '.local/share/opencode/log/opencode.log',
    '.config/opencode/opencode.jsonc',
    // Gemini, Grok, t3, Continue, Windsurf
    '.gemini/oauth_creds.json', '.gemini/settings.json', '.gemini/tmp/proj/chats/c.json',
    '.grok/auth.json', '.grok/config.toml', '.grok/bin/grok', '.grok/downloads/grok-1.0.4', '.grok/logs/l.log',
    '.grok/sessions/session_search.sqlite',
    '.t3/userdata/settings.json', '.t3/userdata/secrets/k', '.t3/userdata/state.sqlite', '.t3/userdata/attachments/a.png',
    '.t3/userdata/logs/desktop.trace.ndjson',
    '.continue/config.yaml', '.continue/sessions/s.json',
    '.codeium/windsurf/user_settings.pb', '.codeium/windsurf/cascade/c.pb',
    'Library/Application Support/Cursor/User/settings.json', 'Library/Application Support/Cursor/Backups/b',
    'Library/Application Support/Cursor/Cache/c',
    '.config/github-copilot/auth.db', '.config/github-copilot/apps.json', '.config/github-copilot/ws/chat-agent-sessions/s/x',
  ];
  for (const rel of files) {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
  }
  const protectedRel = [
    '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/agents/x.md',
    '.claude/skills/y/SKILL.md', '.claude/hooks/guard.sh', '.claude/commands/c.md', '.claude/plugins/p/plugin.json',
    '.claude/keybindings.json', '.claude/projects/p1/memory/MEMORY.md', '.claude/.claude.json',
    '.codex/config.toml', '.codex/auth.json', '.codex/AGENTS.md', '.codex/skills/s/SKILL.md', '.codex/plugins/p.json',
    '.local/share/opencode/auth.json', '.config/opencode/opencode.jsonc',
    '.gemini/oauth_creds.json', '.gemini/settings.json',
    '.grok/auth.json', '.grok/config.toml', '.grok/bin/grok', '.grok/downloads/grok-1.0.4',
    '.t3/userdata/settings.json', '.t3/userdata/secrets/k', '.t3/userdata/state.sqlite', '.t3/userdata/attachments/a.png',
    '.continue/config.yaml', '.codeium/windsurf/user_settings.pb',
    'Library/Application Support/Cursor/User/settings.json', 'Library/Application Support/Cursor/Backups/b',
    '.config/github-copilot/auth.db', '.config/github-copilot/apps.json',
  ];
  return { home, protectedPaths: protectedRel.map((r) => path.join(home, r)) };
}

const fx = makeFixture();
test.after(() => fs.rmSync(fx.home, { recursive: true, force: true }));

const PLATFORMS = [
  ['darwin', fx.home, {}],
  ['linux', fx.home, {}],
];

function isSelfOrAncestor(target, file) {
  return file === target || file.startsWith(target + path.sep);
}

for (const [platform, home, env] of PLATFORMS) {
  const targets = buildAiToolTargets(ctxFor(platform, home, env));

  test(`${platform}: every target has the required shape`, () => {
    assert.ok(targets.length >= 15);
    const ids = new Set();
    for (const t of targets) {
      assert.ok(t.id && typeof t.id === 'string');
      assert.ok(!ids.has(t.id), 'duplicate id ' + t.id);
      ids.add(t.id);
      assert.ok(t.name);
      assert.equal(t.category, 'AI tools');
      assert.equal(t.storyCategory, 'aitools');
      assert.ok(t.mode === 'contents' || t.mode === 'files', `${t.id} has mode ${t.mode}`);
      // Loose SQLite files sit next to config, so they must be deleted file by
      // file, never by emptying their folder.
      if (t.paths.some((p) => /\.(sqlite|db)(-wal|-shm)?$/.test(p) && !t.protect)) {
        assert.equal(t.mode, 'files', `${t.id} lists database files so it must use files mode`);
      }
      // Irreversible history is never preselected.
      if (!t.reversible) assert.equal(t.safe, false, `${t.id} is irreversible so it must be opt-in`);
      assert.ok(Array.isArray(t.paths) && t.paths.length > 0, t.id + ' paths');
      assert.ok(t.paths.every((p) => typeof p === 'string' && path.isAbsolute(p)));
      assert.ok(t.description);
      assert.equal(typeof t.safe, 'boolean');
      assert.equal(typeof t.reversible, 'boolean');
      // protect is present only when non-empty, the same convention as
      // storage-classifier targets.
      if ('protect' in t) assert.ok(Array.isArray(t.protect) && t.protect.length > 0);
      assert.ok(typeof t.tool === 'string' && t.tool.length > 0, `${t.id} names its tool`);
      assert.ok(!t.description.includes('\u2014'));
    }
  });

  test(`${platform}: no target reaches a protected path unless it protects that basename`, () => {
    for (const t of targets) {
      for (const p of t.paths) {
        for (const file of fx.protectedPaths) {
          if (!isSelfOrAncestor(p, file)) continue;
          // Every path segment below the target is a possible deletion victim.
          const rel = path.relative(p, file);
          const segs = rel === '' ? [path.basename(file)] : rel.split(path.sep);
          const covered = segs.some((s) => t.protect.includes(s));
          assert.ok(covered, `${t.id}: ${p} would delete protected ${file}`);
        }
      }
    }
  });

  test(`${platform}: no path is a credential, config or user-content location`, () => {
    const bad = /(auth|token|credential|secret|oauth|settings|config|keybindings|CLAUDE\.md|AGENTS\.md)/i;
    const badDirs = new Set(['agents', 'skills', 'hooks', 'commands', 'plugins', 'memory', 'memories', 'userdata', 'attachments', 'backups']);
    for (const t of targets) {
      for (const p of t.paths) {
        const base = path.basename(p);
        assert.ok(!bad.test(base), `${t.id}: ${p}`);
        assert.ok(!badDirs.has(base.toLowerCase()), `${t.id}: ${p}`);
      }
    }
  });

  test(`${platform}: claude projects target protects memory`, () => {
    const t = targets.find((x) => x.id === 'claude-transcripts');
    assert.deepEqual(t.paths, [path.join(home, '.claude', 'projects')]);
    assert.ok(t.protect.includes('memory'));
    assert.equal(t.reversible, false);
    assert.match(t.description, /memory/i);
  });

  test(`${platform}: sqlite databases are unsafe, irreversible and say to close the tool`, () => {
    const dbTargets = targets.filter((t) => t.paths.some((p) => /\.(sqlite|db)$/.test(p)));
    const ids = dbTargets.map((t) => t.id).sort();
    assert.deepEqual(ids, ['codex-databases', 'opencode-database']);
    for (const t of dbTargets) {
      assert.equal(t.safe, false, t.id);
      assert.equal(t.reversible, false, t.id);
      assert.match(t.description, /clos|quit/i);
    }
  });

  test(`${platform}: transcript targets are irreversible and say so`, () => {
    for (const id of ['claude-transcripts', 'codex-sessions', 'grok-sessions', 'gemini-tmp', 'continue-sessions', 'copilot-sessions']) {
      const t = targets.find((x) => x.id === id);
      assert.ok(t, id);
      assert.equal(t.reversible, false, id);
      assert.match(t.description, /permanently|no longer|lose|disable/i, id);
    }
  });
}

test('sqlite targets include their wal and shm sidecars', () => {
  const t = buildAiToolTargets(ctxFor('darwin', fx.home)).find((x) => x.id === 'codex-databases');
  for (const s of ['thread_history_1.sqlite', 'thread_history_1.sqlite-wal', 'logs_2.sqlite-shm']) {
    assert.ok(t.paths.includes(path.join(fx.home, '.codex', s)), s);
  }
});

test('windows paths resolve under the profile and APPDATA', () => {
  const env = { USERPROFILE: 'C:\\Users\\dev', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
  const targets = buildAiToolTargets(ctxFor('win32', 'C:\\Users\\dev', env));
  const claude = targets.find((t) => t.id === 'claude-transcripts');
  assert.deepEqual(claude.paths, ['C:\\Users\\dev\\.claude\\projects']);
  const cursor = targets.find((t) => t.id === 'cursor-cache');
  assert.ok(cursor.paths.includes('C:\\Users\\dev\\AppData\\Roaming\\Cursor\\Cache'));
  assert.ok(targets.every((t) => t.paths.every((p) => p.startsWith('C:\\'))));
});

test('windows without APPDATA drops app data targets instead of emitting null paths', () => {
  const targets = buildAiToolTargets(ctxFor('win32', 'C:\\Users\\dev', { USERPROFILE: 'C:\\Users\\dev' }));
  assert.ok(!targets.some((t) => t.id === 'cursor-cache'));
  assert.ok(targets.every((t) => t.paths.every(Boolean)));
});

// ---- runningAiTools -------------------------------------------------------

// Fake execFile: `running` maps "-x name" or "-f pattern" to a match.
function fakePgrep(running) {
  return (file, args, opts, cb) => {
    assert.equal(file, 'pgrep');
    assert.ok(opts.timeout > 0);
    const key = args.join(' ');
    if (running.includes(key)) return cb(null, '4242\n', '');
    cb(Object.assign(new Error('none'), { code: 1 }), '', '');
  };
}

test('runningAiTools returns ids of matching processes', async () => {
  const ids = await runningAiTools({ platform: 'darwin', exec: fakePgrep(['-x claude', '-f Cursor.app/Contents/MacOS']) });
  assert.deepEqual(ids, ['claude', 'cursor']);
});

test('runningAiTools returns empty when nothing runs', async () => {
  assert.deepEqual(await runningAiTools({ platform: 'linux', exec: fakePgrep([]) }), []);
});

test('runningAiTools never throws when exec fails or throws', async () => {
  const failing = (f, a, o, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', '');
  assert.deepEqual(await runningAiTools({ platform: 'darwin', exec: failing }), []);
  const throwing = () => { throw new Error('boom'); };
  assert.deepEqual(await runningAiTools({ platform: 'darwin', exec: throwing }), []);
  const timedOut = (f, a, o, cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '4242', '');
  assert.deepEqual(await runningAiTools({ platform: 'darwin', exec: timedOut }), []);
});

test('runningAiTools only reports known tool ids', async () => {
  const all = await runningAiTools({ platform: 'darwin', exec: (f, a, o, cb) => cb(null, '1\n', '') });
  assert.ok(all.length > 0 && all.every((id) => AI_TOOL_IDS.includes(id)));
});
