'use strict';
const fs = require('fs');
const path = require('path');
/**
 * The last line of defence before anything is deleted.
 *
 * Clean jobs arrive from the renderer as { path, mode }. The renderer is not
 * trusted to carry safety rules, so every job whose path belongs to a known
 * system target is rebuilt here from that target's own definition: its mode,
 * its `protect` list, and the running-tool guard for AI tool data.
 *
 * Pure and injectable, so it is unit tested without Electron.
 */

const AI_TOOL_NAMES = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', cursor: 'Cursor',
  windsurf: 'Windsurf', gemini: 'Gemini CLI', grok: 'Grok', t3: 't3',
  continue: 'Continue', copilot: 'GitHub Copilot', zed: 'Zed',
};

/** Map every path of every target to that target. */
function buildTargetIndex(targets) {
  const index = new Map();
  for (const t of targets || []) for (const p of t.paths || []) index.set(p, t);
  return index;
}

/**
 * A path's identity for lookups. If a job's path differs from its target's
 * path only in separators, a trailing slash, Unicode form or letter case, an
 * exact string lookup would miss and the job would silently lose its protect
 * list and exclusions. Resolve, Unicode-normalise, and case-fold where the
 * filesystem ignores case (macOS, Windows); over-matching is the safe side.
 */
function keyOf(p) {
  const key = pathApiFor(p).resolve(String(p)).normalize('NFC');
  return process.platform === 'linux' ? key : key.toLowerCase();
}

function keyedMap(index) {
  const m = new Map();
  for (const [p, t] of index) m.set(keyOf(p), t);
  return m;
}

function keyedSet(set) {
  const s = new Set();
  for (const p of set) if (typeof p === 'string' && p) s.add(keyOf(p));
  return s;
}

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').includes('\\') ? path.win32 : path.posix;
}

function isInside(parent, child) {
  if (!parent || !child || parent === child) return false;
  const api = pathApiFor(parent);
  const rel = api.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !api.isAbsolute(rel);
}

// Every other target nested inside `jobPath`. Cleaning a broad target such as
// ~/Library/Caches or ~/.cache must leave these alone: each is listed, sized and
// governed separately (a custom HF_HOME model store, Claude's CLI cache while
// Claude runs, an opt-in item). This also keeps the clean honest, because a
// parent's displayed size already excludes its nested targets.
function defaultRealpath(p) {
  return fs.realpathSync.native(p);
}

function realOr(p, realpath) {
  try { return realpath(p); } catch { return p; }
}

// Symlinked homes break string comparison: on Fedora Silverblue /home is a
// link to /var/home, so HF_HOME=/home/bob/.cache/hf lives inside
// /var/home/bob/.cache without looking like it. Nested targets are matched by
// real path too, then expressed in the job's own path so the cleaner, which
// walks the job path, recognises them.
function nestedTargetPaths(jobPath, index, realpath = defaultRealpath) {
  const out = [];
  let realJob = null;
  for (const p of index.keys()) {
    if (isInside(jobPath, p)) { out.push(p); continue; }
    if (realJob === null) realJob = realOr(jobPath, realpath);
    const realP = realOr(p, realpath);
    if (isInside(realJob, realP)) {
      const api = pathApiFor(jobPath);
      out.push(api.join(jobPath, pathApiFor(realJob).relative(realJob, realP)));
    }
  }
  return out;
}

/**
 * Split jobs into { allowed, refused }.
 * options.index: from buildTargetIndex. options.toolStatus: async () => { ok, running }.
 *
 * AI tool data is refused while its tool runs, because deleting a live session
 * or SQLite database corrupts it. If running-tool detection itself fails, risky
 * (non-safe) AI targets are refused as well: this fails closed, never open.
 */
async function enforceTargetRules(jobs, options = {}) {
  const index = options.index || new Map();
  const byKey = keyedMap(index);
  const toolStatus = options.toolStatus || (async () => ({ ok: false, running: [] }));
  // options.known: when given, a Set of every path Spaci itself produced (scan
  // results). Anything else is refused: the renderer can never name an
  // arbitrary path for deletion.
  const known = options.known instanceof Set ? keyedSet(options.known) : null;
  // options.projectPaths + options.revalidate: project artifacts come from a
  // cached scan that may be days old, so each is re-checked right now before
  // it is deleted. A folder that has since become tracked or un-ignored stays.
  const projectPaths = options.projectPaths instanceof Set ? keyedSet(options.projectPaths) : new Set();
  const revalidate = typeof options.revalidate === 'function' ? options.revalidate : null;
  const allowed = [];
  const refused = [];
  let tools = null;

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.path !== 'string' || job.path.length === 0) continue;
    const key = keyOf(job.path);
    const t = byKey.get(key);
    if (!t) {
      if (known && !known.has(key)) {
        refused.push({ path: job.path, reason: 'Spaci did not find this in a scan, so it left it alone. Scan again and retry.' });
        continue;
      }
      if (revalidate && projectPaths.has(key)) {
        let verdict;
        try { verdict = await revalidate(job.path); } catch { verdict = null; }
        if (!verdict || verdict.ok !== true) {
          refused.push({ path: job.path, reason: (verdict && verdict.reason) || 'Spaci could not confirm this is still build output, so it left it alone.' });
          continue;
        }
      }
      allowed.push(job);
      continue;
    }

    if (t.tool) {
      if (!tools) {
        try { tools = await toolStatus(); } catch { tools = { ok: false, running: [] }; }
        if (!tools || !Array.isArray(tools.running)) tools = { ok: false, running: [] };
      }
      const name = AI_TOOL_NAMES[t.tool] || t.tool;
      if (tools.running.includes(t.tool)) {
        refused.push({ path: job.path, target: t.id, reason: `${name} is running. Quit it completely, then clean again.` });
        continue;
      }
      if (!tools.ok && !t.safe) {
        refused.push({ path: job.path, target: t.id, reason: `Spaci could not confirm ${name} is closed, so it left this alone.` });
        continue;
      }
    }

    const enforced = {
      ...job,
      // 'files' targets delete the listed files themselves; every other target
      // empties its folder and keeps the folder.
      mode: t.mode === 'files' ? 'path' : 'contents',
    };
    // Protection only ever grows: the target's list plus anything the caller
    // added. A caller can never remove a target's protection.
    const protect = Array.from(new Set([...(t.protect || []), ...(Array.isArray(job.protect) ? job.protect : [])]));
    if (protect.length) enforced.protect = protect;
    else delete enforced.protect;
    allowed.push(enforced);
  }

  // Nested targets are excluded from every job, target or not, and a caller's
  // own exclusions are kept.
  for (const job of allowed) {
    const nested = nestedTargetPaths(job.path, index, options.realpath);
    const own = Array.isArray(job.excludePaths) ? job.excludePaths : [];
    const excludePaths = Array.from(new Set([...nested, ...own]));
    if (excludePaths.length) job.excludePaths = excludePaths;
  }

  // AI tool data goes first, so it is deleted as soon as possible after the
  // running-tool check, keeping the window for a tool to start in between short.
  const isAi = (j) => Number(Boolean((byKey.get(keyOf(j.path)) || {}).tool));
  allowed.sort((a, b) => isAi(b) - isAi(a));

  return { allowed, refused };
}

module.exports = { AI_TOOL_NAMES, buildTargetIndex, enforceTargetRules, nestedTargetPaths };
