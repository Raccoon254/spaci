'use strict';
/**
 * Docker volume review and Docker Desktop restart: the main-process rules.
 *
 * Volumes hold databases and uploads and are the one Docker thing that cannot
 * be rebuilt, so removal is deliberately narrow:
 *   - one volume per call, by exact name, never a prune;
 *   - the renderer must pass { confirmed: true } (the user confirmed a dialog
 *     naming the volume), or the call is refused with 'needs-confirmation';
 *   - the volume must be in the last listing Spaci showed (known-name
 *     allowlist) and not in use there; docker.removeVolume then re-checks
 *     users twice right before `docker volume rm`;
 *   - every removal is a history v2 entry, reversible 'none'.
 *
 * Restarting Docker Desktop is offered only when its engine does not answer
 * (docker state 'engine-down', shown as "Not responding"), never while it
 * runs: a restart would stop the user's containers.
 *
 * Pure: no Electron, no child processes. main.js wires it.
 */

const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MAX_NAME = 255;
// The docker state that means "Docker Desktop is up but its engine does not
// answer". The UI calls it unresponsive.
const UNRESPONSIVE_STATES = new Set(['engine-down', 'unresponsive']);

const num = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

function isVolumeName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME && VOLUME_NAME_RE.test(name);
}

/** One volume in the IPC shape. */
function viewVolume(v) {
  return {
    name: v.name,
    size: num(v.sizeBytes != null ? v.sizeBytes : v.size),
    project: strOrNull(v.project),
    inUse: Boolean(v.inUse),
    containers: Array.isArray(v.containers) ? v.containers.filter((c) => typeof c === 'string') : [],
    createdAt: strOrNull(v.createdAt),
    anonymous: Boolean(v.anonymous),
  };
}

/**
 * Worker answer ({ status, volumes, groups } from listVolumes and
 * groupVolumesByProject) to the IPC shape:
 * { ok, state, volumes: [...], groups: [{ project, label, volumes: [names], size, unusedSize, inUse }], error? }
 */
function volumesView(raw, at = Date.now()) {
  const status = raw && raw.status;
  const state = (status && status.state) || null;
  if (!status || !status.running) {
    return { ok: false, state, volumes: [], groups: [], error: state === 'not-installed' ? 'Docker is not installed.' : 'Docker is not running, so its volumes cannot be listed.', at };
  }
  if (status.remote) {
    return { ok: false, state, volumes: [], groups: [], error: `Docker is pointed at a remote host (${status.endpoint || 'unknown'}). Spaci only reviews local volumes.`, at };
  }
  const volumes = (Array.isArray(raw.volumes) ? raw.volumes : []).filter((v) => v && isVolumeName(v.name)).map(viewVolume);
  const byName = new Map(volumes.map((v) => [v.name, v]));
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((g) => {
    const names = (Array.isArray(g.volumes) ? g.volumes : []).map((v) => (v && typeof v === 'object' ? v.name : v)).filter((n) => byName.has(n));
    const members = names.map((n) => byName.get(n));
    return {
      project: strOrNull(g.project),
      // Compose project name, or how Docker made the volume.
      label: strOrNull(g.project) || (g.key === '(anonymous)' ? 'Anonymous volumes' : 'Other volumes'),
      volumes: names,
      size: members.reduce((s, v) => s + v.size, 0),
      unusedSize: members.filter((v) => !v.inUse).reduce((s, v) => s + v.size, 0),
      inUse: members.filter((v) => v.inUse).length,
    };
  }).filter((g) => g.volumes.length);
  return { ok: true, state, volumes, groups, at };
}

/**
 * May this volume be removed? `listing` is the last volumesView the user saw.
 * @returns {{ok:true, volume:object} | {ok:false, error:string}}
 */
function removalDecision(name, opts, listing) {
  if (!isVolumeName(name)) return { ok: false, error: 'invalid-name' };
  if (!opts || typeof opts !== 'object' || opts.confirmed !== true) return { ok: false, error: 'needs-confirmation' };
  const volume = listing && listing.ok && Array.isArray(listing.volumes) ? listing.volumes.find((v) => v.name === name) : null;
  if (!volume) return { ok: false, error: 'unknown-volume' };
  if (volume.inUse) return { ok: false, error: 'in-use' };
  return { ok: true, volume };
}

/** Human wording for a refusal code, for the renderer to show as-is. */
const REFUSAL_TEXT = {
  'invalid-name': 'That is not a Docker volume name.',
  'needs-confirmation': 'Removing a volume needs your confirmation first.',
  'unknown-volume': 'Spaci did not list that volume. Refresh the list and try again.',
  'in-use': 'A container uses this volume. Remove or stop the container first.',
};

/** May Docker Desktop be restarted from this state? */
function canRestart(state) {
  return UNRESPONSIVE_STATES.has(state);
}

module.exports = {
  VOLUME_NAME_RE, isVolumeName, viewVolume, volumesView, removalDecision, REFUSAL_TEXT, canRestart,
};
