'use strict';

// AI coding tool cleanup targets (Claude Code, Codex, opencode, Cursor,
// Windsurf, Gemini CLI, Grok, t3, Continue, GitHub Copilot, Zed).
//
// SAFETY: every path below is a transcript, log, cache, temp dir, undo
// snapshot or generated artifact. Config, credentials, agents, skills, hooks,
// commands, plugins config, keybindings and memory are never listed. Where a
// target directory also holds something that must survive, the survivor's
// basename is listed in `protect` (the cleaner must never delete a protected
// basename at any depth).

const { execFile } = require('node:child_process');

const CATEGORY = 'AI tools';
const STORY = 'aitools';
const ICON = 'flash';

function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

// Same output shape as storage-classifier.makeTarget, plus `protect`.
function makeTarget(id, name, category, icon, paths, description, options = {}) {
  const reversible = options.reversible !== false;
  const target = {
    id,
    name,
    category,
    icon,
    // Irreversible means opt-in. Session history cannot be regenerated, so it
    // is never preselected or counted in the "reclaimable" total unless a
    // target explicitly says otherwise. Pure caches and logs stay safe.
    safe: options.safe === undefined ? reversible : options.safe !== false,
    reversible,
    // 'contents' empties each path (a folder). 'files' deletes each path
    // itself, for loose files such as SQLite databases that sit next to
    // config which must survive.
    mode: options.mode === 'files' ? 'files' : 'contents',
    paths: uniq(paths),
    description,
    storyCategory: options.storyCategory || category.toLowerCase(),
    // The tool that owns this data. The main process refuses to clean it while
    // that tool is running.
    tool: options.tool,
  };
  const protect = uniq(options.protect || []);
  if (protect.length > 0) target.protect = protect;
  return target;
}

// Target ids are "<tool>-<what>", so the owning tool is the id prefix.
const T = (id, name, paths, description, options = {}) =>
  makeTarget(id, name, CATEGORY, ICON, paths, description, { storyCategory: STORY, tool: id.split('-')[0], ...options });

const SQLITE_NOTE = 'A live SQLite history database: it corrupts if removed while the tool runs, so close the tool first. ';
const TRANSCRIPT_NOTE = 'Deleting them permanently loses resumable session history. ';

// SQLite databases come with -wal and -shm sidecars.
function sqliteSet(file) {
  return [file, file + '-wal', file + '-shm'];
}

// JetBrains product codes the Copilot plugin stores per-IDE session data under.
const COPILOT_IDES = ['ic', 'iu', 'ai', 'ws', 'ps', 'py', 'pc', 'rd', 'go', 'cl', 'rr', 'db'];
const COPILOT_SESSION_DIRS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions', 'bg-agent-sessions'];

function buildAiToolTargets(ctx) {
  const { platform, env = {}, join, winJoin, from } = ctx;
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const t = [];

  // Home-relative dotdirs: same place on every platform (Windows uses the profile).
  const dot = (...parts) => (isWin ? winJoin(...parts) : join(...parts));

  // Per-user app data roots for Electron style apps.
  const appSupport = isMac ? join('Library', 'Application Support')
    : isWin ? env.APPDATA
      : (env.XDG_CONFIG_HOME || join('.config'));
  const app = (name, ...parts) => (isMac ? join('Library', 'Application Support', name, ...parts) : from(appSupport, name, ...parts));
  const xdgData = isWin ? null : (env.XDG_DATA_HOME || join('.local', 'share'));
  const localApp = isWin ? env.LOCALAPPDATA : null;

  // ---- Claude Code (~/.claude) -------------------------------------------
  const claude = (...p) => dot('.claude', ...p);
  t.push(T('claude-transcripts', 'Claude Code session transcripts',
    [claude('projects')],
    'Claude Code conversation transcripts (projects/*/*.jsonl and their subagent and tool-result folders). ' + TRANSCRIPT_NOTE +
    'Per-project memory folders (your persistent memory) are kept, as are saved workflow scripts.',
    { reversible: false, protect: ['memory', 'workflows', 'MEMORY.md', 'CLAUDE.md', 'settings.json', 'settings.local.json'] }));
  t.push(T('claude-file-history', 'Claude Code file history',
    [claude('file-history')],
    'Pre-edit file snapshots Claude Code keeps for undo and rewind. Removing them means past edits can no longer be rewound.',
    { reversible: false }));
  t.push(T('claude-cache', 'Claude Code caches and logs',
    [claude('cache'), claude('shell-snapshots'), claude('paste-cache'), claude('telemetry'), claude('debug'), claude('session-env'),
      isMac ? join('Library', 'Caches', 'claude-cli-nodejs') : isWin ? from(localApp, 'claude-cli-nodejs', 'Cache') : join('.cache', 'claude-cli-nodejs')],
    'Shell snapshots, pasted-text cache, telemetry queue, debug logs and CLI caches. Recreated as needed.'));

  // ---- Codex (~/.codex) --------------------------------------------------
  const codex = (...p) => dot('.codex', ...p);
  t.push(T('codex-sessions', 'Codex session transcripts',
    [codex('sessions'), codex('archived_sessions')],
    'Codex rollout transcripts (sessions/ and archived_sessions/). ' + TRANSCRIPT_NOTE + 'Close Codex first.',
    { reversible: false }));
  t.push(T('codex-generated-images', 'Codex generated images',
    [codex('generated_images')],
    'Images Codex generated during sessions. They are not stored anywhere else, so save any you want first.',
    { reversible: false }));
  t.push(T('codex-cache', 'Codex caches and temp',
    [codex('.tmp'), codex('cache'), codex('shell_snapshots'), codex('log')],
    'Codex temp files, caches, shell snapshots and text logs. Recreated as needed.'));
  t.push(T('codex-databases', 'Codex history and log databases',
    [...sqliteSet(codex('thread_history_1.sqlite')), ...sqliteSet(codex('logs_2.sqlite'))],
    SQLITE_NOTE + 'Codex thread history and logs. ' + TRANSCRIPT_NOTE + 'Quit Codex completely before cleaning.',
    { safe: false, reversible: false, mode: 'files' }));

  // ---- opencode ----------------------------------------------------------
  const oc = (...p) => (isWin ? winJoin('.local', 'share', 'opencode', ...p) : from(xdgData, 'opencode', ...p));
  t.push(T('opencode-cache', 'opencode logs and tool output',
    [oc('log'), oc('tool-output')],
    'opencode application logs and saved tool output. Recreated as needed.'));
  t.push(T('opencode-snapshots', 'opencode snapshots',
    [oc('snapshot')],
    'Git snapshots opencode takes to undo agent edits. Removing them disables undo of past sessions.',
    { reversible: false }));
  t.push(T('opencode-database', 'opencode history database',
    sqliteSet(oc('opencode.db')),
    SQLITE_NOTE + 'This is opencode\'s full session history. ' + TRANSCRIPT_NOTE + 'Quit opencode first.',
    { safe: false, reversible: false, mode: 'files' }));

  // ---- Cursor and Windsurf (Electron apps) -------------------------------
  const electronCache = ['Cache', 'CachedData', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'CachedExtensionVSIXs', 'logs'];
  t.push(T('cursor-cache', 'Cursor caches and logs',
    electronCache.map((d) => app('Cursor', d)),
    'Cursor editor caches, compiled code cache and logs. Rebuilt on next launch. Settings, workspace state and backups are not touched.'));
  t.push(T('windsurf-cache', 'Windsurf caches and logs',
    electronCache.map((d) => app('Windsurf', d)),
    'Windsurf editor caches, compiled code cache and logs. Rebuilt on next launch. Settings and workspace state are not touched.'));
  t.push(T('windsurf-cascade', 'Windsurf Cascade conversations',
    [dot('.codeium', 'windsurf', 'cascade')],
    'Saved Cascade chat conversations. ' + TRANSCRIPT_NOTE + 'Your rules, memories and settings are not touched.',
    { reversible: false }));

  // ---- Gemini CLI (~/.gemini) --------------------------------------------
  t.push(T('gemini-tmp', 'Gemini CLI session logs',
    [dot('.gemini', 'tmp')],
    'Gemini CLI per-project chat logs and checkpoints (tmp/). ' + TRANSCRIPT_NOTE + 'Sign-in and settings are not touched.',
    { reversible: false }));
  t.push(T('gemini-history', 'Gemini CLI checkpoint history',
    [dot('.gemini', 'history')],
    'Shadow git repositories Gemini CLI uses for checkpoint restore. Removing them disables restoring past checkpoints.',
    { reversible: false }));

  // ---- Grok (~/.grok) ----------------------------------------------------
  t.push(T('grok-cache', 'Grok logs and caches',
    [dot('.grok', 'logs'), dot('.grok', 'memtrace'), dot('.grok', 'marketplace-cache')],
    'Grok CLI logs, memory traces and plugin marketplace cache. Recreated as needed. The installed binary, config and sign-in are not touched.'));
  t.push(T('grok-sessions', 'Grok session transcripts',
    [dot('.grok', 'sessions')],
    'Grok conversation transcripts. ' + TRANSCRIPT_NOTE + 'The session search index is kept.',
    { reversible: false, protect: ['session_search.sqlite'] }));

  // ---- t3 (~/.t3) --------------------------------------------------------
  t.push(T('t3-cache', 'T3 logs and caches',
    [dot('.t3', 'userdata', 'logs'), dot('.t3', 'caches')],
    'T3 trace logs and provider caches. Recreated as needed. Settings, secrets, state database and attachments are not touched.'));

  // ---- Continue (~/.continue) --------------------------------------------
  t.push(T('continue-cache', 'Continue index, logs and usage data',
    [dot('.continue', 'index'), dot('.continue', 'logs'), dot('.continue', 'dev_data')],
    'Continue code index, logs and local usage data. The index rebuilds. config.yaml and config.json are not touched.'));
  t.push(T('continue-sessions', 'Continue chat sessions',
    [dot('.continue', 'sessions')],
    'Saved Continue chat sessions. ' + TRANSCRIPT_NOTE, { reversible: false }));

  // ---- GitHub Copilot (JetBrains plugin data) ----------------------------
  const copilotRoot = isWin ? from(localApp, 'github-copilot') : (isMac ? join('.config', 'github-copilot') : from(env.XDG_CONFIG_HOME || join('.config'), 'github-copilot'));
  const copilotSessions = [];
  for (const ide of COPILOT_IDES) for (const d of COPILOT_SESSION_DIRS) copilotSessions.push(from(copilotRoot, ide, d));
  t.push(T('copilot-sessions', 'GitHub Copilot chat sessions',
    copilotSessions,
    'Copilot chat, agent and edit session history stored by the JetBrains plugin. ' + TRANSCRIPT_NOTE + 'Sign-in (auth.db, apps.json) is not touched.',
    { reversible: false }));

  // ---- Zed ---------------------------------------------------------------
  const zedLogs = isMac ? join('Library', 'Logs', 'Zed') : isWin ? from(localApp, 'Zed', 'logs') : from(xdgData, 'zed', 'logs');
  t.push(T('zed-logs', 'Zed logs and hang traces',
    [zedLogs, app(isMac || isWin ? 'Zed' : 'zed', 'hang_traces')],
    'Zed log files and hang traces. Settings and conversation history are not touched.'));

  return t.filter((x) => x.paths.length > 0);
}

// ---- running tool detection ----------------------------------------------

// pgrep argument lists per tool id. Any match means the tool is running.
// Claude Code runs as the `claude` CLI and also inside the Claude desktop app.
const PGREP_CHECKS = {
  claude: [['-x', 'claude'], ['-f', 'Claude.app/Contents/MacOS']],
  codex: [['-x', 'codex'], ['-f', 'Codex.app/Contents/MacOS']],
  opencode: [['-x', 'opencode']],
  cursor: [['-f', 'Cursor.app/Contents/MacOS'], ['-x', 'cursor']],
  windsurf: [['-f', 'Windsurf.app/Contents/MacOS'], ['-x', 'windsurf']],
  gemini: [['-x', 'gemini']],
  grok: [['-x', 'grok']],
  t3: [['-f', 'T3 Code.app/Contents/MacOS'], ['-f', 'T3.app/Contents/MacOS']],
  continue: [],
  copilot: [],
  zed: [['-x', 'zed'], ['-f', 'Zed.app/Contents/MacOS']],
};
const AI_TOOL_IDS = Object.keys(PGREP_CHECKS);

// Windows process image names per tool id, matched case-insensitively against
// `tasklist` output.
const WIN_IMAGES = {
  claude: ['claude.exe', 'Claude.exe'],
  codex: ['codex.exe', 'Codex.exe'],
  opencode: ['opencode.exe'],
  cursor: ['Cursor.exe'],
  windsurf: ['Windsurf.exe'],
  gemini: ['gemini.exe'],
  grok: ['grok.exe'],
  t3: ['T3 Code.exe', 'T3.exe'],
  continue: [],
  copilot: [],
  zed: ['zed.exe', 'Zed.exe'],
};

// Resolves to 'hit', 'miss', or 'error'. pgrep exits 1 when nothing matches,
// which is a clean answer; any other failure means we could not tell.
function pgrep(exec, args, timeout) {
  return new Promise((resolve) => {
    try {
      exec('pgrep', args, { timeout, windowsHide: true }, (err, stdout) => {
        if (!err) return resolve(String(stdout || '').trim().length > 0 ? 'hit' : 'miss');
        resolve(err.code === 1 ? 'miss' : 'error');
      });
    } catch {
      resolve('error');
    }
  });
}

function tasklist(exec, timeout) {
  return new Promise((resolve) => {
    try {
      exec('tasklist', ['/FO', 'CSV', '/NH'], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        // Each line starts with "image.exe", so collect the quoted first fields.
        const images = new Set();
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line.trim());
          if (m) images.add(m[1].toLowerCase());
        }
        resolve(images);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Which AI tools are running. Never rejects.
 * Resolves to { ok, running }: `ok` is false when detection itself failed, so
 * callers can refuse risky deletes instead of assuming nothing is running.
 * options: { exec (execFile-style, injectable), timeout (ms), platform }.
 */
async function aiToolStatus(options = {}) {
  try {
    const exec = options.exec || execFile;
    const timeout = options.timeout || 1500;
    const platform = options.platform || process.platform;
    const running = [];

    if (platform === 'win32') {
      const images = await tasklist(exec, timeout);
      if (!images) return { ok: false, running };
      for (const id of AI_TOOL_IDS) {
        if (WIN_IMAGES[id].some((name) => images.has(name.toLowerCase()))) running.push(id);
      }
      return { ok: true, running };
    }

    let ok = true;
    for (const id of AI_TOOL_IDS) {
      let hit = false;
      for (const args of PGREP_CHECKS[id]) {
        const r = await pgrep(exec, args, timeout);
        if (r === 'error') ok = false;
        if (r === 'hit') { hit = true; break; }
      }
      if (hit) running.push(id);
    }
    return { ok, running };
  } catch {
    return { ok: false, running: [] };
  }
}

/** The ids of AI tools currently running. Never rejects. */
async function runningAiTools(options = {}) {
  return (await aiToolStatus(options)).running;
}

module.exports = { buildAiToolTargets, runningAiTools, aiToolStatus, AI_TOOL_IDS, WIN_IMAGES };
