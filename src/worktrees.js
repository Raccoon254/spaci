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
 *     Beyond status, removal is refused for files hidden from status
 *     (skip-worktree, assume-unchanged), commits only in the worktree's own
 *     HEAD reflog, a `.git` that is not git's link to this worktree, ignored
 *     data that is not safe build output, a tool running in it, and activity
 *     or creation within the last hour;
 *   - clearing git's records of worktrees whose folder is gone, one named
 *     entry at a time (never a global `git worktree prune`), refusing any
 *     that may only be away (unreadable, absent disk or parent) or whose
 *     commits are on no ref.
 *
 * Every git call has a timeout and never throws. Paths from git are matched
 * by exact real path and Unicode NFC first; case-folding (macOS, Windows) is
 * only a fallback when exactly one path matches.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { worktreeRestoreHint } = require('./restore-hints');

const GIT_TIMEOUT = 15000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const INSPECT_CONCURRENCY = 6;
// A worktree touched or created this recently may have an agent about to
// write to it: it is not offered for removal.
const FRESH_MS = 60 * 60 * 1000;

let clock = () => Date.now();
/** Tests move the clock; nothing else should. */
function setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

/** Git must answer about the folder we ask about, not a repo named by the environment. */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  // Read-only: never let a status call rewrite the index of a worktree.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Run git, never throwing. Resolves { err, code, stdout, stderr }. `input` goes to its stdin. */
function runGit(cwd, args, { signal, timeout = GIT_TIMEOUT, input } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile('git', ['-C', cwd, ...args],
        { timeout, signal, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => resolve({
          err,
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          killed: Boolean(err && err.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        }));
      if (child && child.stdin) {
        child.stdin.on('error', () => { /* git exited before reading it all */ });
        child.stdin.end(input == null ? '' : String(input));
      }
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

/** A path's exact identity: real path and NFC, never case-folded. */
function exactKey(p) {
  return realOr(p).normalize('NFC');
}

/**
 * The one item whose path is `want`. An exact real-path match wins; a
 * case-folded match is a fallback only where the disk usually ignores case,
 * and only when exactly one item matches, so on a case-sensitive volume
 * `Feat` and `feat` are never mixed up. null when none or ambiguous.
 */
function pickByPath(items, want, get = (x) => x.path) {
  const list = Array.isArray(items) ? items : [];
  const ek = exactKey(want);
  const exact = list.filter((x) => exactKey(get(x)) === ek);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (!CASE_INSENSITIVE) return null;
  const fk = pathKey(want);
  const folded = list.filter((x) => pathKey(get(x)) === fk);
  return folded.length === 1 ? folded[0] : null;
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
// Not here on purpose: .wrangler (local D1/KV data), .cache (tools keep state
// in it), .idea (run configs, data sources), .vercel and .netlify (project
// links and local env).
const HARMLESS_IGNORED = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.eslintcache', '.stylelintcache', '.pnpm-store',
  '.vite', '.swc', '.expo', '.sass-cache', '.nyc_output',
  '.npm', '.yarn-cache', 'test-results', 'playwright-report', 'blob-report',
  'storybook-static', '.docusaurus', '.pytest_cache', '.hypothesis', '.tox', '.nox',
]);
// Logs, compiler caches, and files tools generate by name (next-env.d.ts,
// expo-env.d.ts, icons.generated.ts).
const HARMLESS_IGNORED_RE = /(\.(log|tsbuildinfo|pyc|pyo)$)|(-env\.d\.ts$)|(\.generated\.[a-z0-9]+$)/i;

// The scanner's safe artifact folder names (node_modules, dist, .next...),
// never the unsafe ones (.venv, venv). The scanner hands them over when it
// loads, so this module never requires it.
let artifactNames = new Set(['node_modules']);
function setArtifactNames(names) {
  if (names && typeof names[Symbol.iterator] === 'function') artifactNames = new Set(names);
}
function artifactNameSet() { return artifactNames; }

/** Ignored paths (from status) that are known build output: deleted with the worktree. */
function buildOutput(paths) {
  const other = new Set(userIgnored(paths));
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = String(raw || '').replace(/[\\/]+$/, '');
    if (p && !other.has(p)) out.push(p);
  }
  return out;
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
 * no untracked files, no files hidden from status, no ignored files that are
 * not build output), not locked, nothing else lives inside it, no commit
 * lives only in its own history, nothing is running in it, it has been quiet
 * for an hour, and its work is safe elsewhere: the branch is merged into the
 * default branch, or fully pushed to its upstream.
 * Returns { ok, missing?, reasons: [string] } with the blocking reasons.
 */
function removalEligibility(wt) {
  if (!wt || typeof wt !== 'object') return { ok: false, reasons: ['Spaci knows nothing about it.'] };
  if (wt.isMain) return { ok: false, reasons: ['This is the main checkout.'] };
  if (!wt.exists) return { ok: false, missing: true, reasons: ['The folder is gone. Clearing git\'s record of it is a separate step.'] };
  const reasons = [];
  if (wt.orphan) reasons.push('Git no longer lists it. Run git worktree repair in the main repository.');
  if (wt.error) reasons.push(wt.error);
  if (wt.locked) reasons.push('Locked' + (wt.lockReason ? ': ' + wt.lockReason : '') + '.');
  if (wt.changes > 0) reasons.push(plural(wt.changes, 'uncommitted change', 'uncommitted changes') + '.');
  if (wt.untracked > 0) reasons.push(plural(wt.untracked, 'untracked file', 'untracked files') + '.');
  if (wt.hiddenFiles > 0) reasons.push(plural(wt.hiddenFiles, 'file', 'files') + ' hidden from git status (skip-worktree or assume-unchanged).');
  if (Array.isArray(wt.ignoredOther) && wt.ignoredOther.length) {
    const shown = wt.ignoredOther.slice(0, 3).join(', ') + (wt.ignoredOther.length > 3 ? ' and ' + (wt.ignoredOther.length - 3) + ' more' : '');
    reasons.push('Holds ignored files that are not build output (' + shown + '). Removing would delete them.');
  }
  if (wt.nestedCheckout) reasons.push('Another git repository or worktree lives inside it.');
  if (wt.reflogOnly > 0) reasons.push(`Has commits only in this worktree's history (${plural(wt.reflogOnly, 'commit', 'commits')} on no branch, tag or other worktree). Removing it would lose them.`);
  if (wt.busy) reasons.push(wt.busy);
  if (wt.fresh) reasons.push(wt.fresh);
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

/** The repository's common git dir, absolute, or null. */
async function commonDirOf(cwd, signal) {
  const r = await runGit(cwd, ['rev-parse', '--git-common-dir'], { signal, timeout: 5000 });
  const out = r.err ? '' : r.stdout.trim();
  return out ? path.resolve(cwd, out) : null;
}

/**
 * git's own records of linked worktrees: one per `<commonDir>/worktrees/<id>`,
 * with the worktree path its `gitdir` file names, its HEAD and lock.
 */
async function adminRecords(commonDir) {
  if (!commonDir) return [];
  let ids = [];
  try { ids = await fsp.readdir(path.join(commonDir, 'worktrees')); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const dir = path.join(commonDir, 'worktrees', id);
    const gd = await readSmall(path.join(dir, 'gitdir'));
    if (!gd || !gd.trim()) continue;
    const dotgit = path.resolve(dir, gd.trim());
    const head = ((await readSmall(path.join(dir, 'HEAD'))) || '').trim();
    let locked = false;
    try { await fsp.access(path.join(dir, 'locked')); locked = true; } catch { /* not locked */ }
    out.push({ id, dir, path: path.dirname(dotgit), head, locked });
  }
  return out;
}

/**
 * Why the `.git` entry at a worktree's path is not git's link to that
 * worktree, or null when it is. Anything else there (a clone, a submodule, a
 * link to another repository) is not something `git worktree remove` should
 * be pointed at.
 */
function linkProblem(entryGit, admin) {
  if (!entryGit) return 'Its .git entry is missing or unreadable, so Spaci cannot tell what is in it.';
  if (entryGit.kind !== 'worktree') return 'Its .git is not a worktree link (it is a repository or checkout of its own), so removing it could delete another repository.';
  if (!admin) return 'Git has no record for it in this repository.';
  if (exactKey(entryGit.gitDir) !== exactKey(admin.dir)) return 'Its .git points at ' + entryGit.gitDir + ', not at this worktree\'s record (' + admin.dir + ').';
  return null;
}

/**
 * Tracked files git status does not look at: skip-worktree (`S`) or
 * assume-unchanged (a lowercase tag) entries whose file is on disk. Sparse
 * checkout leaves skip-worktree entries off disk; those hold nothing.
 * Resolves { count } or { error }.
 */
async function hiddenFromStatus(dir, signal) {
  const r = await runGit(dir, ['ls-files', '-v', '-z'], { signal, timeout: 30000 });
  if (r.err) return { error: r.killed ? 'git took too long to list its files.' : 'Spaci could not list its tracked files.' };
  const hidden = [];
  for (const rec of r.stdout.split('\0')) {
    if (rec.length < 3 || rec[1] !== ' ') continue;
    const tag = rec[0];
    if (tag === 'S' || /[a-z]/.test(tag)) hidden.push(rec.slice(2));
  }
  let count = 0;
  await pool(hidden, 16, async (rel) => {
    try { await fsp.lstat(path.join(dir, rel)); count++; } catch (err) {
      // Gone from disk is fine; unreadable is not proof of nothing.
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) count++;
    }
  });
  return { count };
}

/** Commits and the first timestamp from a HEAD reflog file. null when there is none. */
async function readHeadReflog(adminDir) {
  let text;
  try { text = await fsp.readFile(path.join(adminDir, 'logs', 'HEAD'), 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { error: true, shas: [], first: null };
  }
  const shas = new Set();
  let first = null;
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]*?> (\d+) [+-]\d{4}/.exec(line);
    if (!m) continue;
    for (const sha of [m[1], m[2]]) if (/[^0]/.test(sha)) shas.add(sha);
    if (first == null) first = Number(m[3]) * 1000;
  }
  return { error: false, shas: [...shas], first };
}

/**
 * How many commits from a worktree's HEAD reflog are reachable from no ref
 * and from no other worktree's HEAD: removing the worktree deletes that
 * reflog, and those commits become garbage. Fed through stdin, so a long
 * reflog is never a long command line. Resolves { count } or { error }.
 * `refsCwd` is the main checkout, so the worktree's own per-worktree refs do
 * not count as keeping anything.
 */
async function reflogOnlyCommits(adminDir, { refsCwd, keepHeads = [], signal, reflog } = {}) {
  const log = reflog !== undefined ? reflog : await readHeadReflog(adminDir);
  if (!log) return { count: 0 };
  if (log.error) return { error: 'Spaci could not read this worktree\'s history.' };
  if (!log.shas.length) return { count: 0 };
  const fail = (r) => ({ error: r.killed ? 'git took too long to check this worktree\'s history.' : 'Spaci could not check this worktree\'s history.' });
  // Only commits that still exist: a reflog can name objects gc already took.
  const chk = await runGit(refsCwd, ['cat-file', '--batch-check=%(objecttype) %(objectname)'], { signal, timeout: 30000, input: log.shas.join('\n') + '\n' });
  if (chk.err) return fail(chk);
  const commits = [];
  for (const line of chk.stdout.split('\n')) { const m = /^commit ([0-9a-f]+)$/.exec(line.trim()); if (m) commits.push(m[1]); }
  if (!commits.length) return { count: 0 };
  const refs = await runGit(refsCwd, ['for-each-ref', '--format=%(objectname)'], { signal, timeout: 30000 });
  if (refs.err) return fail(refs);
  const keep = new Set(refs.stdout.split('\n').map((x) => x.trim()).filter(Boolean));
  for (const h of keepHeads) if (h) keep.add(h);
  const input = commits.join('\n') + '\n' + [...keep].map((x) => '^' + x).join('\n') + '\n';
  const rl = await runGit(refsCwd, ['rev-list', '--count', '--stdin'], { signal, timeout: 60000, input });
  if (rl.err) return fail(rl);
  const n = Number(rl.stdout.trim());
  return Number.isFinite(n) ? { count: n } : { error: 'Spaci could not check this worktree\'s history.' };
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

/** 'dir', 'missing', or the error code that kept Spaci from telling (EACCES...). */
async function dirState(p) {
  try { return (await fsp.stat(p)).isDirectory() ? 'dir' : 'notdir'; } catch (err) {
    const code = err && err.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : (code || 'unknown');
  }
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

let procNames = null;
function worktreeProcNames() {
  if (!procNames) {
    const ac = require('./auto-clean');
    procNames = new Set([...ac.DEV_PROCESS_NAMES, ...ac.AI_CODING_TOOLS]);
  }
  return procNames;
}

/** Developer tools and AI coding CLIs that run, and where. Never rejects. */
async function processSnapshot() {
  try {
    return await require('./auto-clean').snapshotProcesses({ names: worktreeProcNames() });
  } catch {
    return { ok: false, list: [] };
  }
}

/**
 * Why a running process makes this worktree busy, or null. A process counts
 * when its cwd is the worktree or inside it, or its command line names it. A
 * process whose cwd is unknown (Windows) does not count here: there, the
 * folder of a running process cannot be deleted anyway.
 */
function busyIn(procs, wtPath) {
  if (!procs || !Array.isArray(procs.list) || !wtPath) return null;
  const { argsMention, isInsideOrSame } = require('./auto-clean');
  const real = realOr(wtPath);
  for (const p of procs.list) {
    const name = (p && Array.isArray(p.names) && p.names[0]) || 'A process';
    if (argsMention(p.args, wtPath) || (real !== wtPath && argsMention(p.args, real))) return `${name} is working on files in it.`;
    if (p.cwd && (isInsideOrSame(wtPath, p.cwd) || isInsideOrSame(real, realOr(p.cwd)))) return `${name} is running in it.`;
  }
  return null;
}

/** Why a worktree counts as fresh (an agent may be about to use it), or null. */
function freshness(wt, now) {
  if (typeof wt.createdAt === 'number' && wt.createdAt > 0 && now - wt.createdAt < FRESH_MS) return 'Created less than an hour ago; an agent may still be starting work in it.';
  if (typeof wt.lastActivity === 'number' && wt.lastActivity > 0 && now - wt.lastActivity < FRESH_MS) return 'Active less than an hour ago; an agent may still be working in it.';
  return null;
}

/**
 * Everything about one listed worktree. `ctx`: { refs, signal, dirSize?,
 * measure?, admins, refsCwd, heads, procs?, now? }. Slow work (size) runs
 * first and the git checks that decide safety (status, hidden files, reflog)
 * run last, so they describe the worktree as it is right before a removal.
 * Never throws; a git failure is recorded in `error`.
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
    hiddenFiles: 0,
    ignoredOther: [],
    buildOutput: [],
    reflogOnly: 0,
    upstream: null,
    ahead: null,
    behind: null,
    pushed: false,
    merged: null,
    lastCommit: null,
    lastActivity: null,
    createdAt: null,
    size: null,
    error: null,
    creator: likelyCreator(entry.path, entry.branch),
  };
  const state = await dirState(wt.path);
  if (state === 'missing') { wt.eligibility = removalEligibility(wt); return wt; }
  // A folder Spaci cannot read is not gone: it is never offered for pruning.
  wt.exists = true;
  if (state !== 'dir') {
    wt.error = state === 'notdir' ? 'Something other than a folder is at its path.' : 'Spaci could not read its folder (' + state + ').';
    wt.eligibility = removalEligibility(wt);
    return wt;
  }
  const entryGit = await readGitEntry(wt.path);
  const admin = pickByPath(ctx.admins || [], wt.path);
  const problem = Array.isArray(ctx.admins) ? linkProblem(entryGit, admin) : 'Spaci could not read git\'s records for this repository.';
  if (problem) {
    wt.error = problem;
    wt.linkMismatch = true;
    wt.eligibility = removalEligibility(wt);
    return wt;
  }

  // Slow and not decisive: size and activity.
  const [act] = await Promise.all([
    lastActivity(wt.path, entryGit.gitDir),
    (async () => {
      if (ctx.measure !== false && typeof ctx.dirSize === 'function') {
        try { wt.size = await ctx.dirSize(wt.path, signal); } catch { wt.size = null; }
      }
    })(),
  ]);
  wt.lastActivity = act;

  // Decisive, and last.
  const reflog = await readHeadReflog(admin.dir);
  const keepHeads = (Array.isArray(ctx.heads) ? ctx.heads : []).filter((h) => h && h.head && exactKey(h.path) !== exactKey(wt.path)).map((h) => h.head);
  const [st, log, hidden, lost] = await Promise.all([
    runGit(wt.path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignored=matching'], { signal }),
    runGit(wt.path, ['log', '-1', '--format=%ct', 'HEAD'], { signal, timeout: 5000 }),
    hiddenFromStatus(wt.path, signal),
    reflogOnlyCommits(admin.dir, { refsCwd: ctx.refsCwd || wt.path, keepHeads, signal, reflog }),
  ]);
  if (reflog && typeof reflog.first === 'number') wt.createdAt = reflog.first;
  else {
    try { const b = (await fsp.stat(admin.dir)).birthtimeMs; if (b > 0) wt.createdAt = b; } catch { /* unknown */ }
  }
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
    wt.buildOutput = buildOutput(s.ignored);
    wt.upstream = s.upstream;
    wt.ahead = s.ahead;
    wt.behind = s.behind;
    wt.pushed = Boolean(s.upstream) && s.ahead === 0;
  }
  if (hidden.error) wt.error = wt.error || hidden.error;
  else wt.hiddenFiles = hidden.count;
  if (lost.error) wt.error = wt.error || lost.error;
  else wt.reflogOnly = lost.count;
  const ct = Number(log.stdout.trim());
  if (!log.err && Number.isFinite(ct) && ct > 0) wt.lastCommit = ct * 1000;
  if (wt.lastCommit && (!wt.lastActivity || wt.lastActivity < wt.lastCommit)) wt.lastActivity = wt.lastCommit;
  if (!wt.error) wt.merged = await isMergedInto(wt.path, wt.head, ctx.refs || [], signal);
  wt.fresh = freshness(wt, typeof ctx.now === 'number' ? ctx.now : clock());
  wt.busy = ctx.procs ? busyIn(ctx.procs, wt.path) : null;
  wt.creator = likelyCreator(wt.path, wt.branch);
  wt.eligibility = removalEligibility(wt);
  return wt;
}

async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** What every inspection of one repository shares: refs, git's records, HEADs. */
async function repoContext(cwd, entries, opts = {}) {
  const commonDir = await commonDirOf(cwd, opts.signal);
  const mainEntry = entries[0];
  const refsCwd = mainEntry && await isDir(mainEntry.path) ? path.resolve(mainEntry.path) : cwd;
  return {
    refs: await defaultRefs(cwd, opts.signal),
    admins: commonDir ? await adminRecords(commonDir) : null,
    refsCwd,
    heads: entries.map((e) => ({ path: e.path, head: e.head })),
    signal: opts.signal,
    dirSize: opts.dirSize,
    measure: opts.measure,
    procs: opts.procs || null,
    now: opts.now,
  };
}

/**
 * The repository behind `cwd` (any of its checkouts): main entry, default
 * branch, and every linked worktree inspected. `opts`: { signal, dirSize,
 * measure, concurrency, procs (a process snapshot), now }.
 */
async function describeRepo(cwd, opts = {}) {
  const listed = await listWorktrees(cwd, opts.signal);
  if (listed.error) return { error: listed.error, main: null, worktrees: [], defaultBranch: null };
  const [mainEntry, ...linked] = listed.entries;
  const ctx = await repoContext(cwd, listed.entries, opts);
  const worktrees = new Array(linked.length);
  await pool(linked, opts.concurrency || INSPECT_CONCURRENCY, async (e, i) => {
    if (opts.signal && opts.signal.aborted) { worktrees[i] = null; return; }
    worktrees[i] = await inspectWorktree(e, ctx);
  });
  return {
    main: mainEntry ? { path: path.resolve(mainEntry.path), bare: Boolean(mainEntry.bare), branch: mainEntry.branch, head: mainEntry.head } : null,
    defaultBranch: ctx.refs[0] || null,
    refs: ctx.refs,
    worktrees: worktrees.filter(Boolean),
  };
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
 * list it under `mainPath` (matched by exact path first), and it must still
 * pass removalEligibility. The slow full search for anything nested inside
 * runs first, then the process check, and the git checks (status, hidden
 * files, reflog) last, so a removal follows them directly.
 * `opts`: { signal, dirSize, measure, snapshot (() => procs), now }.
 * Returns { ok, wt, reasons }.
 */
async function reverify(mainPath, wtPath, opts = {}) {
  const listed = await listWorktrees(mainPath, opts.signal);
  if (listed.error) return { ok: false, reasons: [listed.error + '.'] };
  const [mainEntry, ...linked] = listed.entries;
  if (mainEntry && exactKey(mainEntry.path) === exactKey(wtPath)) return { ok: false, reasons: ['This is the main checkout.'] };
  const entry = pickByPath(linked, wtPath);
  if (!entry) return { ok: false, reasons: ['Git no longer lists this worktree under ' + mainPath + '.'] };
  let nested = null;
  if (await isDir(entry.path)) nested = await nestedGitInside(path.resolve(entry.path), opts);
  const snap = typeof opts.snapshot === 'function' ? opts.snapshot : processSnapshot;
  let procs;
  try { procs = await snap(); } catch { procs = { ok: false, list: [] }; }
  const ctx = await repoContext(mainPath, listed.entries, { ...opts, procs: procs && procs.ok ? procs : null });
  const wt = await inspectWorktree(entry, ctx);
  if (wt.exists) {
    if (nested === 'found') wt.nestedCheckout = true;
    else if (nested === 'unknown') wt.error = wt.error || 'Spaci could not look inside all of it.';
    if (!procs || !procs.ok) wt.error = wt.error || 'Spaci could not check which tools are running in it.';
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

// ---------------------------------------------------------------------------
// Clearing records of missing worktrees, one at a time
// ---------------------------------------------------------------------------

// Where removable disks and network shares appear. A worktree on one of them
// looks deleted while the disk is away.
const MOUNT_BASES = ['/Volumes', '/media', '/mnt', '/run/media'];

/** The mount base a path sits under (posix form), or null. */
function mountBaseOf(p) {
  const s = String(p || '').replace(/\\/g, '/');
  for (const b of MOUNT_BASES) if (s.startsWith(b + '/')) return b;
  return null;
}

/**
 * Why the folder of a worktree git calls missing may only be away, not gone,
 * or null when it is really gone. `io` (tests) supplies lstat and stat.
 *   - it must not exist (unreadable is not gone);
 *   - on Windows its drive must be there;
 *   - the folder that held it must still be there;
 *   - under /Volumes, /media, /mnt or /run/media, that folder must be on a
 *     mounted disk, not the empty mount point a disk leaves behind.
 */
async function missingProblem(p, io = fsp) {
  const abs = String(p);
  try {
    await io.lstat(abs);
    return 'Its folder is there.';
  } catch (err) {
    const code = err && err.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'Spaci could not read where it was (' + (code || 'error') + '). Unreadable is not gone.';
  }
  const drive = /^([A-Za-z]):[\\/]/.exec(abs);
  if (drive) {
    try { await io.stat(drive[1] + ':\\'); } catch { return 'Drive ' + drive[1].toUpperCase() + ': is not connected.'; }
  }
  const parent = path.dirname(abs);
  let pst;
  try { pst = await io.stat(parent); } catch {
    return 'The folder that held it (' + parent + ') is not there either, so it may be on a disk or share that is away.';
  }
  if (!pst.isDirectory()) return 'The folder that held it (' + parent + ') is not a folder.';
  const base = mountBaseOf(abs);
  if (base) {
    try {
      const bst = await io.stat(base);
      if (bst.dev === pst.dev) return 'It was on a disk under ' + base + ' that is not mounted.';
    } catch { return 'It was on a disk under ' + base + ' that is not mounted.'; }
  }
  return null;
}

/**
 * Is the commit a missing worktree's record points at on some ref? 'yes',
 * 'no', 'none' (no commit recorded, such as a deleted branch), or 'unknown'.
 */
async function headOnRef(mainPath, headText, signal) {
  const t = String(headText || '').trim();
  let sha = null;
  const sym = /^ref:\s*(\S+)$/.exec(t);
  if (sym) {
    const r = await runGit(mainPath, ['rev-parse', '--verify', '-q', sym[1] + '^{commit}'], { signal, timeout: 5000 });
    if (r.err) return r.code === 1 ? 'none' : 'unknown';
    return 'yes'; // the branch is a ref, and it points at the commit
  }
  if (/^[0-9a-f]{40,64}$/.test(t)) sha = t;
  if (!sha) return 'unknown';
  const exists = await runGit(mainPath, ['cat-file', '-e', sha + '^{commit}'], { signal, timeout: 5000 });
  if (exists.err) return exists.code === 1 || exists.code === 128 ? 'none' : 'unknown';
  const r = await runGit(mainPath, ['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)'], { signal, timeout: 30000 });
  if (r.err) return 'unknown';
  return r.stdout.trim() ? 'yes' : 'no';
}

/**
 * Clear git's record of each given missing worktree, one at a time, never
 * with a global `git worktree prune`. Each one is re-checked first: git still
 * lists it, it is not locked, its folder is really gone (missingProblem), its
 * last commit is on a ref, and no commit lives only in its history. Then
 * `git worktree remove <path>`, or, where git will not, its own record folder
 * is deleted. `opts.io` (tests) replaces lstat and stat.
 * Returns { ok, pruned: [path], refused: [{ path, reason }], remaining }.
 */
async function pruneWorktrees(mainPath, paths, opts = {}) {
  const wanted = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p);
  const listed = await listWorktrees(mainPath, opts.signal);
  if (listed.error) return { ok: false, error: listed.error, pruned: [], refused: [] };
  const commonDir = await commonDirOf(mainPath, opts.signal);
  if (!commonDir) return { ok: false, error: 'Spaci could not find this repository\'s git folder.', pruned: [], refused: [] };
  const [mainEntry, ...linked] = listed.entries;
  const heads = listed.entries.map((e) => ({ path: e.path, head: e.head }));
  const refsCwd = mainEntry && await isDir(mainEntry.path) ? path.resolve(mainEntry.path) : mainPath;
  const pruned = [];
  const refused = [];
  for (const p of wanted) {
    if (opts.signal && opts.signal.aborted) break;
    const no = (reason) => refused.push({ path: p, reason });
    const entry = pickByPath(linked, p);
    if (!entry) { no('Git no longer lists it.'); continue; }
    if (entry.locked) { no('Locked' + (entry.lockReason ? ': ' + entry.lockReason : '') + '.'); continue; }
    const gone = await missingProblem(entry.path, opts.io || fsp);
    if (gone) { no(gone); continue; }
    const admin = pickByPath(await adminRecords(commonDir), entry.path);
    if (!admin) { no('Spaci could not find git\'s record for it.'); continue; }
    if (admin.locked) { no('Locked.'); continue; }
    const on = await headOnRef(refsCwd, admin.head, opts.signal);
    if (on === 'no') { no('Its last commit (' + admin.head.slice(0, 7) + ') is on no branch or tag. Clearing the record would lose it.'); continue; }
    if (on === 'unknown') { no('Spaci could not tell whether its last commit is on a branch.'); continue; }
    const keepHeads = heads.filter((h) => h.head && exactKey(h.path) !== exactKey(entry.path)).map((h) => h.head);
    const lost = await reflogOnlyCommits(admin.dir, { refsCwd, keepHeads, signal: opts.signal });
    if (lost.error) { no(lost.error); continue; }
    if (lost.count > 0) { no(`Has commits only in this worktree's history (${plural(lost.count, 'commit', 'commits')}). Clearing the record would lose them.`); continue; }
    const r = await runGit(mainPath, ['worktree', 'remove', entry.path], { signal: opts.signal, timeout: 60000 });
    if (r.err && await isDir(admin.dir) && !(await missingProblem(entry.path, opts.io || fsp))) {
      // Older git will not remove a worktree whose folder is gone: clear its
      // record folder, which is what prune would do for this one entry.
      try { await fsp.rm(admin.dir, { recursive: true, force: true }); } catch { /* checked below */ }
    }
    if (await isDir(admin.dir)) { no('git could not clear its record.'); continue; }
    pruned.push(p);
  }
  // What git still lists afterwards, so the caller can drop exactly what went.
  const after = await listWorktrees(mainPath, opts.signal);
  return { ok: true, pruned, refused, remaining: after.entries ? after.entries.map((e) => path.resolve(e.path)) : null };
}

module.exports = {
  CREATORS, HARMLESS_IGNORED, FRESH_MS,
  parseGitFile, parseWorktreeList, parseStatusV2, coreWorktree, userIgnored, buildOutput,
  likelyCreator, removalEligibility, restoreHint: worktreeRestoreHint,
  readGitEntry, findCheckout, hasLinkedWorktrees, defaultRefs, isMergedInto, listWorktrees,
  commonDirOf, adminRecords, linkProblem, hiddenFromStatus, reflogOnlyCommits, missingProblem, mountBaseOf, headOnRef,
  busyIn, processSnapshot, freshness,
  inspectWorktree, describeRepo, reverify, removeWorktree, pruneWorktrees, nestedGitInside,
  pathKey, exactKey, pickByPath, realOr, isInsideKey, runGit, setArtifactNames, setClock,
};
