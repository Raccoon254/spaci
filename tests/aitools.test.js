'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAiToolTargets, runningAiTools, aiToolStatus, AI_TOOL_IDS } = require('../src/aitools');

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
    // Target paths use the target platform's separators, not the host's.
    const P = platform === 'win32' ? path.win32 : path.posix;
    assert.deepEqual(t.paths, [P.join(home, '.claude', 'projects')]);
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
    assert.ok(t.paths.includes(path.posix.join(fx.home, '.codex', s)), s);
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

// ---- path overrides -------------------------------------------------------

test('CLAUDE_CONFIG_DIR moves Claude targets and keeps the protect list', () => {
  const env = { CLAUDE_CONFIG_DIR: '/data/claude-cfg' };
  const ts = buildAiToolTargets(ctxFor('linux', '/home/u', env));
  const tr = ts.find((t) => t.id === 'claude-transcripts');
  assert.deepEqual(tr.paths, ['/data/claude-cfg/projects']);
  for (const k of ['memory', 'workflows', 'MEMORY.md', 'CLAUDE.md', 'settings.json']) assert.ok(tr.protect.includes(k), k);
  assert.deepEqual(ts.find((t) => t.id === 'claude-file-history').paths, ['/data/claude-cfg/file-history']);
  assert.ok(ts.find((t) => t.id === 'claude-cache').paths.includes('/data/claude-cfg/shell-snapshots'));
});

test('relative CLAUDE_CONFIG_DIR is ignored', () => {
  const ts = buildAiToolTargets(ctxFor('linux', '/home/u', { CLAUDE_CONFIG_DIR: 'rel/dir' }));
  assert.deepEqual(ts.find((t) => t.id === 'claude-transcripts').paths, ['/home/u/.claude/projects']);
});

test('CODEX_HOME moves Codex targets', () => {
  const ts = buildAiToolTargets(ctxFor('darwin', '/Users/u', { CODEX_HOME: '/opt/codex' }));
  assert.deepEqual(ts.find((t) => t.id === 'codex-sessions').paths, ['/opt/codex/sessions', '/opt/codex/archived_sessions']);
  assert.ok(ts.find((t) => t.id === 'codex-databases').paths.includes('/opt/codex/logs_2.sqlite-wal'));
});

test('Zed hang_traces is under the data dir', () => {
  const lin = buildAiToolTargets(ctxFor('linux', '/home/u', {})).find((t) => t.id === 'zed-logs');
  assert.ok(lin.paths.includes('/home/u/.local/share/zed/hang_traces'));
  const linX = buildAiToolTargets(ctxFor('linux', '/home/u', { XDG_DATA_HOME: '/x/data' })).find((t) => t.id === 'zed-logs');
  assert.ok(linX.paths.includes('/x/data/zed/hang_traces'));
  const env = { USERPROFILE: 'C:\\Users\\d', APPDATA: 'C:\\Users\\d\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\d\\AppData\\Local' };
  const win = buildAiToolTargets(ctxFor('win32', 'C:\\Users\\d', env)).find((t) => t.id === 'zed-logs');
  assert.ok(win.paths.includes('C:\\Users\\d\\AppData\\Local\\Zed\\hang_traces'));
});

test('XDG_CACHE_HOME is honoured on Linux only', () => {
  const lin = buildAiToolTargets(ctxFor('linux', '/home/u', { XDG_CACHE_HOME: '/x/cache' })).find((t) => t.id === 'claude-cache');
  assert.ok(lin.paths.includes('/x/cache/claude-cli-nodejs'));
  const def = buildAiToolTargets(ctxFor('linux', '/home/u', {})).find((t) => t.id === 'claude-cache');
  assert.ok(def.paths.includes('/home/u/.cache/claude-cli-nodejs'));
  const mac = buildAiToolTargets(ctxFor('darwin', '/Users/u', { XDG_CACHE_HOME: '/x/cache' })).find((t) => t.id === 'claude-cache');
  assert.ok(mac.paths.includes('/Users/u/Library/Caches/claude-cli-nodejs'));
});

// ---- detection matrix -----------------------------------------------------

// Fake pgrep over a fixed process table: `-x` compares the process name,
// `-f` runs the pattern as a regex against the full command line.
function procTable(procs) {
  return (file, args, opts, cb) => {
    assert.equal(file, 'pgrep');
    const [flag, pat] = args;
    const re = flag === '-f' ? new RegExp(pat) : null;
    const hit = procs.some((p) => (flag === '-x' ? p.name === pat : re.test(p.cmd)));
    if (hit) return cb(null, '1\n', '');
    cb(Object.assign(new Error('none'), { code: 1 }), '', '');
  };
}
const proc = (cmd) => ({ name: cmd.split(' ')[0].split('/').pop(), cmd });
const runs = async (platform, cmds) => (await aiToolStatus({ platform, exec: procTable(cmds.map(proc)) }));

test('node-hosted CLIs are detected on macOS and Linux', async () => {
  for (const platform of ['darwin', 'linux']) {
    let r = await runs(platform, ['/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume']);
    assert.deepEqual(r, { ok: true, running: ['claude'] });
    r = await runs(platform, ['node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js']);
    assert.deepEqual(r.running, ['gemini']);
    r = await runs(platform, ['/usr/bin/node /home/u/.nvm/versions/node/v22/bin/gemini']);
    assert.deepEqual(r.running, ['gemini']);
  }
});

test('unrelated node processes are not AI tools', async () => {
  const r = await runs('linux', ['node /srv/app/server.js', '/usr/bin/node /home/u/proj/node_modules/.bin/vite', 'bash -lc geminiwatch']);
  assert.deepEqual(r, { ok: true, running: [] });
});

test('macOS host editors mark continue and copilot as running', async () => {
  const cases = [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
    '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
    '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea',
    '/Applications/PyCharm.app/Contents/MacOS/pycharm',
    '/Applications/WebStorm.app/Contents/MacOS/webstorm',
    '/Applications/GoLand.app/Contents/MacOS/goland',
    '/Applications/Rider.app/Contents/MacOS/rider',
    '/Applications/CLion.app/Contents/MacOS/clion',
    '/Applications/PhpStorm.app/Contents/MacOS/phpstorm',
    '/Applications/RubyMine.app/Contents/MacOS/rubymine',
    '/Applications/DataGrip.app/Contents/MacOS/datagrip',
    '/Applications/Android Studio.app/Contents/MacOS/studio',
    '/Users/u/Applications/PyCharm Professional.app/Contents/MacOS/pycharm',
  ];
  for (const c of cases) assert.deepEqual((await runs('darwin', [c])).running, ['continue', 'copilot'], c);
  for (const c of ['/Applications/Safari.app/Contents/MacOS/Safari', '/Applications/Xcode.app/Contents/MacOS/Xcode', '/Applications/Code Runner.app/Contents/MacOS/x']) {
    assert.deepEqual((await runs('darwin', [c])).running, [], c);
  }
});

test('Linux host editors mark continue and copilot as running', async () => {
  const cases = [
    '/usr/share/code/code --type=renderer',
    '/usr/share/code/code',
    '/snap/code/150/usr/share/code/code --no-sandbox',
    '/usr/share/code-insiders/code-insiders',
    '/opt/idea/jbr/bin/java -Didea.paths.selector=IntelliJIdea2025.2 com.intellij.idea.Main',
    '/opt/pycharm/bin/pycharm.sh',
    '/opt/webstorm/bin/webstorm',
    '/home/u/.local/share/JetBrains/Toolbox/apps/goland/bin/goland.sh',
    '/opt/android-studio/bin/studio.sh',
    '/opt/rider/bin/rider.sh',
  ];
  for (const c of cases) assert.deepEqual((await runs('linux', [c])).running, ['continue', 'copilot'], c);
  for (const c of ['/usr/bin/opencode', '/usr/bin/xcode-select', '/usr/lib/code-helper', '/usr/bin/nodejs server.js', '/usr/bin/studio-tools --x', '/usr/bin/vscode-tunnel']) {
    assert.deepEqual((await runs('linux', [c])).running.filter((i) => i === 'continue' || i === 'copilot'), [], c);
  }
});

test('Linux Zed process zed-editor is detected', async () => {
  assert.deepEqual((await runs('linux', ['/usr/libexec/zed-editor --foreground'])).running, ['zed']);
});

// Fake tasklist plus powershell.
function winExec({ images, cmdlines, psError }) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    assert.ok(opts.timeout > 0);
    if (file === 'tasklist') return cb(null, images.map((i) => `"${i}","1","Console","1","10 K"`).join('\r\n'), '');
    assert.equal(file, 'powershell');
    assert.ok(args.includes('-NoProfile'));
    if (psError) return cb(Object.assign(new Error('denied'), { code: 1 }), '', '');
    // Same shape as the real query: one tagged row per node.exe. A null entry
    // is a process whose command line could not be read (elevated).
    cb(null, cmdlines.map((l) => 'SPACI_CMD:' + (l == null ? '' : l)).join('\r\n'), '');
  };
  fn.calls = calls;
  return fn;
}

test('windows: node.exe command lines identify Claude Code and Gemini CLI', async () => {
  const exec = winExec({
    images: ['System', 'node.exe'],
    cmdlines: ['"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\d\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      'node.exe C:\\Users\\d\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js'],
  });
  assert.deepEqual(await aiToolStatus({ platform: 'win32', exec }), { ok: true, running: ['claude', 'gemini'] });
  const ps = exec.calls.find((c) => c.file === 'powershell');
  assert.ok(ps.opts.timeout >= 5000);
});

test('windows: unrelated node.exe is not an AI tool, and no query without node.exe', async () => {
  let r = await aiToolStatus({ platform: 'win32', exec: winExec({ images: ['node.exe'], cmdlines: ['node.exe C:\\app\\server.js'] }) });
  assert.deepEqual(r, { ok: true, running: [] });
  const exec = winExec({ images: ['explorer.exe'], cmdlines: [] });
  r = await aiToolStatus({ platform: 'win32', exec });
  assert.deepEqual(r, { ok: true, running: [] });
  assert.ok(!exec.calls.some((c) => c.file === 'powershell'));
});

test('windows: failed or empty command line query gives ok false', async () => {
  let r = await aiToolStatus({ platform: 'win32', exec: winExec({ images: ['node.exe'], cmdlines: [], psError: true }) });
  assert.equal(r.ok, false);
  r = await aiToolStatus({ platform: 'win32', exec: winExec({ images: ['node.exe'], cmdlines: [] }) });
  assert.equal(r.ok, false);
  const boom = (f, a, o, cb) => { if (f === 'tasklist') return cb(null, '"node.exe","1"\r\n', ''); throw new Error('boom'); };
  assert.equal((await aiToolStatus({ platform: 'win32', exec: boom })).ok, false);
});

test('windows: host editor images mark continue and copilot as running', async () => {
  for (const img of ['Code.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'goland64.exe', 'rider64.exe', 'clion64.exe', 'phpstorm64.exe', 'rubymine64.exe', 'datagrip64.exe', 'studio64.exe']) {
    const r = await aiToolStatus({ platform: 'win32', exec: winExec({ images: [img.toLowerCase()], cmdlines: [] }) });
    assert.deepEqual(r, { ok: true, running: ['continue', 'copilot'] }, img);
  }
});

test('windows: an unreadable node.exe command line (elevated) fails closed', async () => {
  const exec = winExec({ images: ['node.exe', 'explorer.exe'], cmdlines: ['C:\\node\\node.exe C:\\srv\\eslint.js', null] });
  assert.deepEqual(await aiToolStatus({ platform: 'win32', exec }), { ok: false, running: [] });
});

test('windows: npm-installed Codex and opencode are recognised by command line', async () => {
  const exec = winExec({
    images: ['node.exe'],
    cmdlines: [
      'C:\\node\\node.exe C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
      'node C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode',
    ],
  });
  const r = await aiToolStatus({ platform: 'win32', exec });
  assert.equal(r.ok, true);
  assert.deepEqual(r.running.sort(), ['codex', 'opencode']);
});

test('npm shims run through node are detected, bare arguments are not', async () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual((await runs(platform, ['/usr/bin/node /usr/local/bin/claude --resume'])).running, ['claude']);
    assert.deepEqual((await runs(platform, ['node /home/u/.npm-global/bin/codex exec'])).running, ['codex']);
    assert.deepEqual((await runs(platform, ['vim /home/u/bin/gemini-notes', 'less /tmp/claude'])).running, []);
  }
});

test('Linux editor hosts count only as the executable, not as an argument', async () => {
  assert.deepEqual((await runs('linux', ['vim /home/bob/code', 'tmux -c /home/bob/code'])).running, []);
  const r = await runs('linux', ['/usr/share/code/code --unity-launch']);
  assert.deepEqual(r.running.sort(), ['continue', 'copilot']);
});
