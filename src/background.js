'use strict';
// Scan orchestration shared by the manual scan IPC handlers and the background
// scheduler. Every result goes through the scan coordinator, so:
// - a manual scan pre-empts a background scan of the same kind,
// - a background scan never interrupts anything (it skips a busy lane),
// - an older scan that finishes late never overwrites a newer result,
// - nothing is written once the app is quitting.
//
// Electron-free: scanner, system, Docker, the cache store and the window
// messenger are all injected, so node --test covers the races directly.

const msg = (e) => (e && e.message ? e.message : String(e));

/**
 * @param {object} d
 * @param {ReturnType<import('./scan-coordinator').createScanCoordinator>} d.coordinator
 * @param {ReturnType<import('./scan-cache').createCacheStore>} d.store
 * @param {(root:string, onProgress:Function|null, signal:AbortSignal) => Promise<{projects:object[]}>} d.scanProjects
 * @param {(onProgress:Function|null, signal:AbortSignal) => Promise<object[]>} d.scanSystem
 * @param {(projects:object[]) => Promise<object>} d.computeDocker  Docker summary, attaches usage to projects
 * @param {(dir:string, signal:AbortSignal) => Promise<{totalSize:number,git:any}>} [d.enrichProject]
 * @param {() => Promise<object|null>} [d.refreshBreakdown]
 * @param {() => string} d.getRoot
 * @param {(channel:string, payload:any) => void} [d.emit]
 * @param {() => void} [d.onCommitted]  refresh the tray after a result lands
 */
function createScanService(d) {
  const {
    coordinator, store, scanProjects, scanSystem, computeDocker, getRoot,
    enrichProject = null, refreshBreakdown = null, emit = () => {}, onCommitted = () => {},
    keepProject = (p) => Boolean((p.items && p.items.length) || (p.docker && p.docker.usage)),
    log = console, now = () => Date.now(), enrichTop = 25,
  } = d;

  const notify = () => {
    try { onCommitted(); } catch (e) { log.error('[scan] tray refresh failed:', e); }
    try { emit('cache:updated', { scannedAt: store.get().scannedAt }); } catch (e) { log.error('[scan] emit failed:', e); }
  };

  function applyProjects(root, projects, dockerInfo, source, partial) {
    const c = store.get();
    const t = now();
    c.projects = projects.filter(keepProject);
    if (dockerInfo) c.docker = dockerInfo;
    c.root = root;
    c.scannedAt = t;
    c.kindScannedAt = { ...(c.kindScannedAt || {}), projects: t };
    c.meta = { ...(c.meta || {}), projects: { source, at: t, partial: Boolean(partial) } };
    store.write();
    notify();
  }

  function applySystem(targets, source, partial) {
    const c = store.get();
    const t = now();
    c.system = targets;
    c.scannedAt = t;
    c.kindScannedAt = { ...(c.kindScannedAt || {}), system: t };
    c.meta = { ...(c.meta || {}), system: { source, at: t, partial: Boolean(partial) } };
    store.write();
    notify();
  }

  // When a manual scan is superseded by a newer manual one, its caller gets the
  // newer scan's result (reuse), never its own stale one.
  async function supersededResult(ticket, snapshot) {
    const next = coordinator.current(ticket.kind);
    if (next && next !== ticket && next.promise) {
      try { return await next.promise; } catch (_) { /* fall back to the snapshot */ }
    }
    return snapshot();
  }

  function manualProjects(root, onProgress) {
    const t = coordinator.begin('projects', 'manual');
    if (!t) return Promise.resolve({ ok: false, error: 'Spaci is shutting down.' });
    const run = (async () => {
      try {
        const res = await scanProjects(root, onProgress, t.signal);
        const projects = (res && res.projects) || [];
        let dockerInfo = null;
        if (coordinator.canCommit(t)) dockerInfo = await computeDocker(projects);
        const done = coordinator.commit(t, () => applyProjects(root, projects, dockerInfo, 'manual', t.signal.aborted));
        if (done) {
          const c = store.get();
          return { ok: true, ...res, projects: c.projects, docker: c.docker, partial: t.signal.aborted };
        }
        if (t.reason === 'superseded') {
          return supersededResult(t, () => {
            const c = store.get();
            return { ok: true, projects: c.projects, docker: c.docker, superseded: true };
          });
        }
        return { ok: false, error: 'Scan cancelled.', cancelled: true };
      } catch (e) {
        log.error('[scan] projects scan failed:', e);
        return { ok: false, error: msg(e) };
      } finally {
        coordinator.end(t);
      }
    })();
    return coordinator.track(t, run);
  }

  function manualSystem(onProgress) {
    const t = coordinator.begin('system', 'manual');
    if (!t) return Promise.resolve({ ok: false, error: 'Spaci is shutting down.' });
    const run = (async () => {
      try {
        const targets = (await scanSystem(onProgress, t.signal)) || [];
        if (coordinator.commit(t, () => applySystem(targets, 'manual', t.signal.aborted))) {
          return { ok: true, targets, partial: t.signal.aborted };
        }
        if (t.reason === 'superseded') {
          return supersededResult(t, () => ({ ok: true, targets: store.get().system, superseded: true }));
        }
        return { ok: false, error: 'Scan cancelled.', cancelled: true };
      } catch (e) {
        log.error('[scan] system scan failed:', e);
        return { ok: false, error: msg(e) };
      } finally {
        coordinator.end(t);
      }
    })();
    return coordinator.track(t, run);
  }

  /**
   * One background pass: projects, system, enrichment of the largest projects,
   * disk breakdown. Returns a status the scheduler understands:
   * 'ok' | 'partial' (some phase failed) | 'failed' (every phase failed) |
   * 'busy' (a manual scan holds the lanes) | 'preempted' | 'closed'.
   */
  async function backgroundRun() {
    if (coordinator.closed) return { status: 'closed' };
    const startedAt = now();
    const errors = [];
    const phases = {};
    let ran = 0;
    let preempted = false;
    try { emit('bg:scan', { active: true }); } catch (_) { /* window gone */ }
    try {
      const root = getRoot();

      // ---- projects ----
      const tp = coordinator.begin('projects', 'background');
      if (!tp) {
        phases.projects = { skipped: 'busy' };
      } else {
        const p0 = now();
        try {
          const res = await scanProjects(root, null, tp.signal);
          const projects = (res && res.projects) || [];
          const dockerInfo = coordinator.canCommit(tp) ? await computeDocker(projects) : null;
          if (coordinator.commit(tp, () => applyProjects(root, projects, dockerInfo, 'background', false))) ran++;
          else preempted = true;
          phases.projects = { durationMs: now() - p0, committed: !preempted };
        } catch (e) {
          if (tp.signal.aborted) preempted = true;
          else { errors.push({ phase: 'projects', message: msg(e) }); log.error('[bg] projects phase failed:', e); }
        } finally {
          coordinator.end(tp);
        }
      }
      if (preempted || coordinator.closed) return { status: coordinator.closed ? 'closed' : 'preempted', errors, phases };

      // ---- system ----
      const ts = coordinator.begin('system', 'background');
      if (!ts) {
        phases.system = { skipped: 'busy' };
      } else {
        const s0 = now();
        try {
          const targets = (await scanSystem(null, ts.signal)) || [];
          if (coordinator.commit(ts, () => applySystem(targets, 'background', false))) ran++;
          else preempted = true;
          phases.system = { durationMs: now() - s0, committed: !preempted };
        } catch (e) {
          if (ts.signal.aborted) preempted = true;
          else { errors.push({ phase: 'system', message: msg(e) }); log.error('[bg] system phase failed:', e); }
        } finally {
          coordinator.end(ts);
        }
      }
      if (coordinator.closed) return { status: 'closed', errors, phases };
      if (!tp && !ts) return { status: 'busy', errors, phases };

      // ---- enrich the largest projects so their detail pages open instantly ----
      if (enrichProject) {
        const e0 = now();
        const ac = new AbortController();
        const top = [...store.get().projects].sort((a, b) => (b.cleanableSize || 0) - (a.cleanableSize || 0)).slice(0, enrichTop);
        let done = 0;
        for (const pr of top) {
          if (coordinator.closed) { ac.abort(); break; }
          try {
            const r = await enrichProject(pr.path, ac.signal);
            if (coordinator.closed) break;
            store.get().enrich[pr.path] = { totalSize: r.totalSize, git: r.git, at: now() };
            done++;
          } catch (e) { log.warn && log.warn('[bg] enrich failed for', pr.path, msg(e)); }
        }
        if (done) store.write();
        phases.enrich = { durationMs: now() - e0, count: done };
      }
      if (coordinator.closed) return { status: 'closed', errors, phases };

      // ---- disk breakdown ----
      if (refreshBreakdown) {
        try {
          const b0 = now();
          await refreshBreakdown();
          phases.breakdown = { durationMs: now() - b0 };
          ran++;
        } catch (e) {
          errors.push({ phase: 'breakdown', message: msg(e) });
          log.error('[bg] breakdown phase failed:', e);
        }
      }
    } catch (e) {
      errors.push({ phase: 'background', message: msg(e) });
      log.error('[bg] background scan failed:', e);
    } finally {
      if (!coordinator.closed) {
        const c = store.get();
        c.schedule = { ...(c.schedule || {}), lastRun: { startedAt, durationMs: now() - startedAt, errors, phases } };
        store.write();
        try { emit('bg:scan', { active: false }); } catch (_) { /* window gone */ }
      }
    }
    const status = errors.length === 0 ? 'ok' : ran > 0 ? 'partial' : 'failed';
    return { status, errors, phases };
  }

  return {
    manualProjects,
    manualSystem,
    backgroundRun,
    cancel: (kind) => coordinator.cancel(kind),
    close() { coordinator.close(); store.close(); },
  };
}

module.exports = { createScanService };
