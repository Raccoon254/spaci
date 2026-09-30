'use strict';
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
 * Split jobs into { allowed, refused }.
 * options.index: from buildTargetIndex. options.toolStatus: async () => { ok, running }.
 *
 * AI tool data is refused while its tool runs, because deleting a live session
 * or SQLite database corrupts it. If running-tool detection itself fails, risky
 * (non-safe) AI targets are refused as well: this fails closed, never open.
 */
async function enforceTargetRules(jobs, options = {}) {
  const index = options.index || new Map();
  const toolStatus = options.toolStatus || (async () => ({ ok: false, running: [] }));
  const allowed = [];
  const refused = [];
  let tools = null;

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.path !== 'string' || job.path.length === 0) continue;
    const t = index.get(job.path);
    if (!t) { allowed.push(job); continue; }

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
  return { allowed, refused };
}

module.exports = { AI_TOOL_NAMES, buildTargetIndex, enforceTargetRules };
