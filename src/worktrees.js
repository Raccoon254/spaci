'use strict';
/**
 * Git repositories and their linked worktrees.
 *
 * AI coding tools (Claude Code, Codex, Cursor, Conductor) create a git worktree
 * per task and rarely remove it, so one repository can sit on disk dozens of
 * times. This module answers, for any folder:
 *   - which checkout holds it and which repository that checkout belongs to,
 *     read from the `.git` entry alone (no process spawned): a `.git` directory
 *     is a main checkout, a `.git` file pointing at `.../worktrees/<id>` is a
 *     linked worktree whose `commondir` names the main repository, any other
 *     `.git` file is a submodule or a separate-git-dir checkout (its own repo);
 *   - for each linked worktree git lists (`git worktree list --porcelain` is
 *     the source of truth, the filesystem is cross-checked): branch, HEAD,
 *     uncommitted and untracked counts, merged into the default branch, ahead
 *     and behind its upstream, last commit, last activity, locked, missing,
 *     size, and the tool that likely created it;
 *   - whether Spaci may offer to remove it (removalEligibility), and the
 *     removal itself, which re-verifies everything first and runs
 *     `git worktree remove` without --force, so git refuses anything dirty.
 *
 * Every git call has a timeout and never throws. Paths from git are compared
 * by real path, Unicode NFC and, on macOS and Windows, case-folded.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const GIT_TIMEOUT = 15000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const INSPECT_CONCURRENCY = 6;

/** Git must answer about the folder we ask about, not a repo named by the environment. */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  // Read-only: never let a status call rewrite the index of a worktree.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Run git, never throwing. Resolves { err, code, stdout, stderr }. */
function runGit(cwd, args, { signal, timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', cwd, ...args],
        { timeout, signal, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => resolve({
          err,
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          killed: Boolean(err && err.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        }));
    } catch (err) {
      resolve({ err, code: -1, killed: false, stdout: '', stderr: '' });
    }
  });
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const realCache = new Map();

/** Real path when it exists, else the resolved path. Memoised for one process. */
function realOr(p) {
  const abs = path.resolve(String(p));
  if (realCache.has(abs)) return realCache.get(abs);
  let r = abs;
  try { r = fs.realpathSync.native(abs); } catch {
    // A missing worktree: resolve its nearest existing parent instead, so
    // /tmp/x and /private/tmp/x still meet on macOS.
    try { r = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { r = abs; }
  }
  if (realCache.size > 20000) realCache.clear();
  realCache.set(abs, r);
  return r;
}

/** A path's identity for comparisons: real, NFC, case-folded where the disk ignores case. */
function pathKey(p) {
  const k = realOr(p).normalize('NFC');
  return CASE_INSENSITIVE ? k.toLowerCase() : k;
}

/** Is `child` strictly inside `parent` (both already keys or plain paths)? */
function isInsideKey(parentKey, childKey) {
  if (!parentKey || !childKey || parentKey === childKey) return false;
  const rel = path.relative(parentKey, childKey);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Reading a checkout's .git entry (no process spawned)
// ---------------------------------------------------------------------------

function parseGitFile(text) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

async function readSmall(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return null; }
}

/** `[core] worktree = <path>` from a git config (a submodule's working tree). */
function coreWorktree(configText) {
  let inCore = false;
  for (const raw of String(configText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inCore = /^\[core\]$/i.test(line); continue; }
    if (!inCore) continue;
    const m = /^worktree\s*=\s*(.+)$/i.exec(line);
    if (m) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/**
 * What the `.git` entry in `dir` says, or null when there is none.
 *   { kind: 'main', root, gitDir, commonDir, mainRoot }
 *   { kind: 'worktree', root, gitDir, commonDir, mainRoot, worktreeId, bare }
 *   { kind: 'submodule' | 'gitfile', root, gitDir, commonDir, mainRoot: root }
 * A submodule (gitdir under `.git/modules/`) and a separate-git-dir checkout
 * are repositories of their own, so their mainRoot is themselves.
 */
async function readGitEntry(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try { st = await fsp.lstat(dotgit); } catch { return null; }
  if (st.isDirectory()) return { kind: 'main', root: dir, gitDir: dotgit, commonDir: dotgit, mainRoot: dir };
  if (!st.isFile()) return null;
  const target = parseGitFile(await readSmall(dotgit));
  if (!target) return null;
  const gitDir = path.resolve(dir, target);
  const common = await readSmall(path.join(gitDir, 'commondir'));
  if (common && common.trim()) {
    const commonDir = path.resolve(gitDir, common.trim());
    let mainRoot;
    let bare = false;
    if (path.basename(commonDir).toLowerCase() === '.git') {
      mainRoot = path.dirname(commonDir);
    } else {
      // A worktree of a submodule (its common dir is .git/modules/<name>,
      // whose config names the working tree), or of a bare repository.
      const wt = coreWorktree(await readSmall(path.join(commonDir, 'config')));
      if (wt) mainRoot = path.resolve(commonDir, wt);
      else { mainRoot = commonDir; bare = true; }
    }
    return { kind: 'worktree', root: dir, gitDir, commonDir, mainRoot, worktreeId: path.basename(gitDir), bare };
  }
  const isModule = /[\\/]modules[\\/]/.test(gitDir);
  return { kind: isModule ? 'submodule' : 'gitfile', root: dir, gitDir, commonDir: gitDir, mainRoot: dir };
}

/**
 * The checkout that holds `dir`: the nearest folder, `dir` itself or above it,
 * with a `.git` entry. Memoised through `memo` (a Map) for a whole scan.
 */
function findCheckout(dir, memo = new Map()) {
  const abs = path.resolve(dir);
  if (memo.has(abs)) return memo.get(abs);
  const p = (async () => {
    const own = await readGitEntry(abs);
    if (own) return own;
    const parent = path.dirname(abs);
    if (parent === abs) return null;
    return findCheckout(parent, memo);
  })();
  memo.set(abs, p);
  return p;
}

/** Linked worktrees git has recorded for this common dir (cheap, no spawn). */
async function hasLinkedWorktrees(commonDir) {
  try { return (await fsp.readdir(path.join(commonDir, 'worktrees'))).length > 0; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/**
 * `git worktree list --porcelain [-z]` into entries:
 * { path, head, branch, detached, bare, locked, lockReason, prunable, prunableReason }.
 */
function parseWorktreeList(text, nul = false) {
  const out = [];
  let cur = null;
  const lines = String(text || '').split(nul ? '\0' : /\r?\n/);
  for (const line of lines) {
    if (!line) { if (cur) { out.push(cur); cur = null; } continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: '', prunable: false, prunableReason: '' };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val || null;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') { cur.locked = true; cur.lockReason = val; }
    else if (key === 'prunable') { cur.prunable = true; cur.prunableReason = val; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * `git status --porcelain=v2 --branch -z [--ignored=matching]` into
 * { head, branch, detached, upstream, ahead, behind, changes, untracked, ignored[] }.
 * ahead and behind are null when there is no upstream or it is gone.
 */
function parseStatusV2(text) {
  const r = { head: null, branch: null, detached: false, upstream: null, ahead: null, behind: null, changes: 0, untracked: 0, ignored: [] };
  const fields = String(text || '').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith('# branch.oid ')) { const v = f.slice(13); r.head = v === '(initial)' ? null : v; }
    else if (f.startsWith('# branch.head ')) { const v = f.slice(14); if (v === '(detached)') r.detached = true; else r.branch = v; }
    else if (f.startsWith('# branch.upstream ')) r.upstream = f.slice(18);
    else if (f.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/.exec(f.slice(12));
      if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); }
    } else if (f[0] === '1' || f[0] === 'u') r.changes++;
    else if (f[0] === '2') { r.changes++; i++; } // the original path follows in its own field
    else if (f[0] === '?') r.untracked++;
    else if (f[0] === '!') r.ignored.push(f.slice(2));
  }
  return r;
}

// ---------------------------------------------------------------------------
// Ignored files that `git worktree remove` would delete
// ---------------------------------------------------------------------------

// Regenerable ignored output besides the scanner's artifact folders. Anything
// else that git ignores (.env files, local settings, data) is the user's, and
// `git worktree remove` deletes ignored files without asking.
const HARMLESS_IGNORED = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.eslintcache', '.stylelintcache', '.cache', '.pnpm-store',
  '.vite', '.swc', '.expo', '.vercel', '.netlify', '.wrangler', '.sass-cache', '.nyc_output',
  '.npm', '.yarn-cache', '.idea', 'test-results', 'playwright-report', 'blob-report',
  'storybook-static', '.docusaurus', '.pytest_cache', '.hypothesis', '.tox', '.nox',
]);
// Logs, compiler caches, and files tools generate by name (next-env.d.ts,
// expo-env.d.ts, icons.generated.ts).
const HARMLESS_IGNORED_RE = /(\.(log|tsbuildinfo|pyc|pyo)$)|(-env\.d\.ts$)|(\.generated\.[a-z0-9]+$)/i;

let artifactNames = null;
function artifactNameSet() {
  if (!artifactNames) {
    // Lazy: scanner requires this module, so its rules are read on first use.
    try { artifactNames = new Set(require('./scanner').CLEAN_RULES.map((r) => r.match)); } catch { artifactNames = new Set(['node_modules']); }
  }
  return artifactNames;
}

/** Ignored paths (from status) that are not known build output. */
function userIgnored(paths) {
  const names = artifactNameSet();
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = String(raw || '').replace(/[\\/]+$/, '');
    if (!p) continue;
    const parts = p.split(/[\\/]/);
    const base = parts[parts.length - 1];
    if (parts.some((s) => names.has(s))) continue;
    if (HARMLESS_IGNORED.has(base) || HARMLESS_IGNORED_RE.test(base)) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who likely created a worktree (a heuristic, shown as "likely")
// ---------------------------------------------------------------------------

const CREATORS = Object.freeze({
  claude: Object.freeze({ id: 'claude', label: 'Claude Code', brand: 'claude' }),
  codex: Object.freeze({ id: 'codex', label: 'Codex', brand: 'codex' }),
  cursor: Object.freeze({ id: 'cursor', label: 'Cursor', brand: 'cursor' }),
  conductor: Object.freeze({ id: 'conductor', label: 'Conductor', brand: null }),
  agent: Object.freeze({ id: 'agent', label: 'An AI agent', brand: null }),
  manual: Object.freeze({ id: 'manual', label: 'Manual', brand: null }),
});

function likelyCreator(wtPath, branch) {
  const s = '/' + String(wtPath || '').replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
  const b = String(branch || '').toLowerCase();
  const base = s.split('/').filter(Boolean).pop() || '';
  if (s.includes('/.claude/worktrees/') || b.startsWith('claude/')) return CREATORS.claude;
  if (s.includes('/.codex/') || b.startsWith('codex/')) return CREATORS.codex;
  if (s.includes('/.cursor/') || b.startsWith('cursor/')) return CREATORS.cursor;
  if (s.includes('/conductor/workspaces/') || s.includes('/.conductor/') || b.startsWith('conductor/')) return CREATORS.conductor;
  if (/^agent[-_]/.test(base) || /(^|[/_-])agent-[0-9a-f]{6,}/.test(b)) return CREATORS.agent;
  return CREATORS.manual;
}

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * May Spaci offer to remove this worktree? Only when it is clean (no changes,
 * no untracked files, no ignored files that are not build output), not
 * locked, nothing else lives inside it, and its work is safe elsewhere: the
 * branch is merged into the default branch, or fully pushed to its upstream.
 * Returns { ok, missing?, reasons: [string] } with the blocking reasons.
 */
function removalEligibility(wt) {
  if (!wt || typeof wt !== 'object') return { ok: false, reasons: ['Spaci knows nothing about it.'] };
  if (wt.isMain) return { ok: false, reasons: ['This is the main checkout.'] };
  if (!wt.exists) return { ok: false, missing: true, reasons: ['The folder is gone. Prune clears the leftover record.'] };
  const reasons = [];
  if (wt.orphan) reasons.push('Git no longer lists it. Run git worktree repair in the main repository.');
  if (wt.error) reasons.push(wt.error);
  if (wt.locked) reasons.push('Locked' + (wt.lockReason ? ': ' + wt.lockReason : '') + '.');
  if (wt.changes > 0) reasons.push(plural(wt.changes, 'uncommitted change', 'uncommitted changes') + '.');
  if (wt.untracked > 0) reasons.push(plural(wt.untracked, 'untracked file', 'untracked files') + '.');
  if (Array.isArray(wt.ignoredOther) && wt.ignoredOther.length) {
    const shown = wt.ignoredOther.slice(0, 3).join(', ') + (wt.ignoredOther.length > 3 ? ' and ' + (wt.ignoredOther.length - 3) + ' more' : '');
    reasons.push('Holds ignored files that are not build output (' + shown + '). Removing would delete them.');
  }
  if (wt.nestedCheckout) reasons.push('Another git repository or worktree lives inside it.');
  if (!wt.error && !(wt.merged === true || wt.pushed === true)) {
    if (!wt.head) reasons.push('Spaci could not read its commit.');
    else if (wt.detached) reasons.push('Detached HEAD with commits not in the default branch.');
    else if (wt.upstream && wt.ahead > 0) reasons.push(`Branch is ${plural(wt.ahead, 'commit', 'commits')} ahead of ${wt.upstream} and not merged.`);
    else reasons.push('Branch is not merged and not pushed.');
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

/** Default branch refs to test merges against: origin/HEAD's target, else main or master. */
async function defaultRefs(cwd, signal) {
  const refs = [];
  const sym = await runGit(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { signal, timeout: 5000 });
  const verify = async (ref) => !(await runGit(cwd, ['rev-parse', '--verify', '-q', ref + '^{commit}'], { signal, timeout: 5000 })).err;
  const origin = !sym.err ? sym.stdout.trim() : '';
  if (origin) {
    refs.push(origin);
    const local = origin.replace(/^[^/]+\//, '');
    if (local && await verify('refs/heads/' + local)) refs.push(local);
  } else {
    for (const name of ['main', 'master']) {
      if (await verify('refs/heads/' + name)) { refs.push(name); break; }
    }
    if (!refs.length) {
      for (const name of ['origin/main', 'origin/master']) {
        if (await verify('refs/remotes/' + name)) { refs.push(name); break; }
      }
    }
  }
  return refs;
}

/** Is commit `head` contained in any of `refs`? true, false, or null (unknown). */
async function isMergedInto(cwd, head, refs, signal) {
  if (!head || !refs.length) return null;
  let unknown = false;
  for (const ref of refs) {
    const r = await runGit(cwd, ['merge-base', '--is-ancestor', head, ref], { signal, timeout: 10000 });
    if (!r.err) return true;
    if (r.code !== 1) unknown = true;
  }
  return unknown ? null : false;
}

async function listWorktrees(cwd, signal) {
  let r = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'], { signal });
  let nul = true;
  if (r.err && !r.killed && /unknown switch|usage/i.test(r.stderr)) {
    r = await runGit(cwd, ['worktree', 'list', '--porcelain'], { signal });
    nul = false;
  }
  if (r.err) return { error: r.killed ? 'git took too long to list worktrees' : 'git could not list worktrees' };
  return { entries: parseWorktreeList(r.stdout, nul) };
}

const mtimeOf = (p) => fsp.stat(p).then((s) => s.mtimeMs, () => 0);

/** Last time anything visibly changed: the folder, its top-level entries, the index and HEAD. */
async function lastActivity(dir, gitDir) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { /* unreadable */ }
  const skip = artifactNameSet();
  const probes = [dir, ...names.filter((n) => !skip.has(n) && n !== '.git').slice(0, 200).map((n) => path.join(dir, n))];
  if (gitDir) probes.push(path.join(gitDir, 'index'), path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD'));
  const times = await Promise.all(probes.map(mtimeOf));
  return Math.max(0, ...times) || null;
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Everything about one listed worktree. `ctx`: { refs, signal, dirSize?,
 * measure? }. Never throws; a git failure is recorded in `error`.
 */
async function inspectWorktree(entry, ctx = {}) {
  const signal = ctx.signal;
  const wt = {
    path: path.resolve(entry.path),
    head: entry.head || null,
    branch: entry.branch || null,
    detached: Boolean(entry.detached),
    locked: Boolean(entry.locked),
    lockReason: entry.lockReason || '',
    prunable: Boolean(entry.prunable),
    exists: false,
    changes: 0,
    untracked: 0,
    ignoredOther: [],
    upstream: null,
    ahead: null,
    behind: null,
    pushed: false,
    merged: null,
    lastCommit: null,
    lastActivity: null,
    size: null,
    error: null,
    creator: likelyCreator(entry.path, entry.branch),
  };
  const entryGit = await readGitEntry(wt.path);
  wt.exists = Boolean(entryGit) && await isDir(wt.path);
  if (!wt.exists) { wt.eligibility = removalEligibility(wt); return wt; }

  const [st, log, act] = await Promise.all([
    runGit(wt.path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignored=matching'], { signal }),
    runGit(wt.path, ['log', '-1', '--format=%ct', 'HEAD'], { signal, timeout: 5000 }),
    lastActivity(wt.path, entryGit && entryGit.gitDir),
  ]);
  wt.lastActivity = act;
  if (st.err) {
    wt.error = st.killed ? 'git took too long to read its status.' : 'Spaci could not read its git status.';
  } else {
    const s = parseStatusV2(st.stdout);
    wt.head = s.head || wt.head;
    if (s.branch) wt.branch = s.branch;
    wt.detached = s.detached;
    wt.changes = s.changes;
    wt.untracked = s.untracked;
    wt.ignoredOther = userIgnored(s.ignored);
    wt.upstream = s.upstream;
    wt.ahead = s.ahead;
    wt.behind = s.behind;
    wt.pushed = Boolean(s.upstream) && s.ahead === 0;
  }
  const ct = Number(log.stdout.trim());
  if (!log.err && Number.isFinite(ct) && ct > 0) wt.lastCommit = ct * 1000;
  if (wt.lastCommit && (!wt.lastActivity || wt.lastActivity < wt.lastCommit)) wt.lastActivity = wt.lastCommit;
  if (!wt.error) wt.merged = await isMergedInto(wt.path, wt.head, ctx.refs || [], signal);
  if (ctx.measure !== false && typeof ctx.dirSize === 'function') {
    try { wt.size = await ctx.dirSize(wt.path, signal); } catch { wt.size = null; }
  }
  wt.creator = likelyCreator(wt.path, wt.branch);
  wt.eligibility = removalEligibility(wt);
  return wt;
}

async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * The repository behind `cwd` (any of its checkouts): main entry, default
 * branch, and every linked worktree inspected. `opts`: { signal, dirSize,
 * measure, concurrency }.
 */
async function describeRepo(cwd, opts = {}) {
  const listed = await listWorktrees(cwd, opts.signal);
  if (listed.error) return { error: listed.error, main: null, worktrees: [], defaultBranch: null };
  const [mainEntry, ...linked] = listed.entries;
  const refs = await defaultRefs(cwd, opts.signal);
  const worktrees = new Array(linked.length);
  await pool(linked, opts.concurrency || INSPECT_CONCURRENCY, async (e, i) => {
    if (opts.signal && opts.signal.aborted) { worktrees[i] = null; return; }
    worktrees[i] = await inspectWorktree(e, { refs, signal: opts.signal, dirSize: opts.dirSize, measure: opts.measure });
  });
  return {
    main: mainEntry ? { path: path.resolve(mainEntry.path), bare: Boolean(mainEntry.bare), branch: mainEntry.branch, head: mainEntry.head } : null,
    defaultBranch: refs[0] || null,
    refs,
    worktrees: worktrees.filter(Boolean),
  };
}

/** Restore line for History: the branch is kept, so this brings the files back. */
function restoreHint(wt) {
  const q = (s) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);
  if (wt && wt.branch && !wt.detached) return `git worktree add ${q(wt.path)} ${q(wt.branch)}`;
  if (wt && wt.head) return `git worktree add --detach ${q(wt.path)} ${wt.head}`;
  return 'Recreate it with git worktree add.';
}

/** JS fallback: any `.git` entry below `dir`, other than its own top-level one. */
async function walkForNestedGit(dir, signal) {
  const queue = [dir];
  let unreadable = false;
  while (queue.length) {
    if (signal && signal.aborted) return 'unknown';
    const cur = queue.shift();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch { unreadable = true; continue; }
    for (const e of ents) {
      if (e.name === '.git') { if (cur !== dir) return 'found'; continue; }
      if (e.isDirectory() && !e.isSymbolicLink()) queue.push(path.join(cur, e.name));
    }
  }
  return unreadable ? 'unknown' : 'none';
}

/**
 * Is there another repository or worktree anywhere inside the worktree at
 * `dir` (below its own `.git`)? 'found', 'none' or 'unknown'. `git worktree
 * remove` deletes ignored folders, and a clone inside one can hold unpushed work.
 */
function nestedGitInside(dir, { signal } = {}) {
  if (process.platform === 'win32') return walkForNestedGit(dir, signal);
  return new Promise((resolve) => {
    execFile('find', [dir, '-mindepth', '2', '-name', '.git', '-print', '-quit'],
      { timeout: 120000, signal, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (String(stdout || '').trim()) return resolve('found');
        if (err && err.code === 'ENOENT') return walkForNestedGit(dir, signal).then(resolve);
        resolve(err ? 'unknown' : 'none');
      });
  });
}

/**
 * Re-verify one worktree right before removal, from scratch: git must still
 * list it under `mainPath`, and it must still pass removalEligibility. Also
 * looks for any repository or worktree inside it (a full search, which the
 * scan skips). Returns { ok, wt, reasons }.
 */
async function reverify(mainPath, wtPath, opts = {}) {
  const listed = await listWorktrees(mainPath, opts.signal);
  if (listed.error) return { ok: false, reasons: [listed.error + '.'] };
  const want = pathKey(wtPath);
  const [mainEntry, ...linked] = listed.entries;
  if (mainEntry && pathKey(mainEntry.path) === want) return { ok: false, reasons: ['This is the main checkout.'] };
  const entry = linked.find((e) => pathKey(e.path) === want);
  if (!entry) return { ok: false, reasons: ['Git no longer lists this worktree under ' + mainPath + '.'] };
  const refs = await defaultRefs(mainPath, opts.signal);
  const wt = await inspectWorktree(entry, { refs, signal: opts.signal, dirSize: opts.dirSize, measure: opts.measure });
  if (wt.exists) {
    const nested = await nestedGitInside(wt.path, opts);
    if (nested === 'found') wt.nestedCheckout = true;
    else if (nested === 'unknown') wt.error = wt.error || 'Spaci could not look inside all of it.';
    wt.eligibility = removalEligibility(wt);
  }
  return { ok: wt.eligibility.ok, wt, reasons: wt.eligibility.reasons };
}

/**
 * Remove one worktree: re-verify, then `git worktree remove <path>` from the
 * main checkout, never with --force (git itself refuses a dirty or locked
 * worktree). The branch is kept. Returns { ok, path, branch, head, bytes,
 * reasons?, error? }.
 */
async function removeWorktree(mainPath, wtPath, opts = {}) {
  const v = await reverify(mainPath, wtPath, opts);
  if (!v.ok) return { ok: false, refused: true, path: wtPath, reasons: v.reasons, wt: v.wt || null };
  const wt = v.wt;
  const r = await runGit(mainPath, ['worktree', 'remove', wt.path], { signal: opts.signal, timeout: 120000 });
  if (r.err) {
    const msg = (r.stderr || '').trim().split('\n').pop() || (r.killed ? 'git took too long' : 'git could not remove it');
    return { ok: false, path: wtPath, error: msg.replace(/^fatal:\s*/, ''), wt };
  }
  const gone = !(await isDir(wt.path));
  return { ok: gone, path: wtPath, branch: wt.branch, head: wt.head, detached: wt.detached, bytes: wt.size || 0, wt, error: gone ? undefined : 'The folder is still there after git removed the worktree.' };
}

/**
 * `git worktree prune` for one repository: metadata of worktrees whose folder
 * is gone. Reports what it pruned (from --verbose). Locked entries are kept by
 * git itself.
 */
async function pruneWorktrees(cwd, opts = {}) {
  const dry = await runGit(cwd, ['worktree', 'prune', '--dry-run', '--verbose'], { signal: opts.signal });
  if (dry.err) return { ok: false, error: 'git could not check for missing worktrees', pruned: [] };
  const lines = (s) => `${s.stdout}\n${s.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const planned = lines(dry);
  if (!planned.length) return { ok: true, pruned: [] };
  const r = await runGit(cwd, ['worktree', 'prune', '--verbose'], { signal: opts.signal });
  if (r.err) return { ok: false, error: 'git could not prune', pruned: [] };
  return { ok: true, pruned: lines(r) };
}

module.exports = {
  CREATORS, HARMLESS_IGNORED,
  parseGitFile, parseWorktreeList, parseStatusV2, coreWorktree, userIgnored,
  likelyCreator, removalEligibility, restoreHint,
  readGitEntry, findCheckout, hasLinkedWorktrees, defaultRefs, isMergedInto, listWorktrees,
  inspectWorktree, describeRepo, reverify, removeWorktree, pruneWorktrees, nestedGitInside,
  pathKey, realOr, isInsideKey, runGit,
};
