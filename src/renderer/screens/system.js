'use strict';
/* System Cleaner screen, Spaci v2. Faithful to design/spaci-v2-reference.html.
   Developer & system caches grouped by category, with per-item selection and a
   safe clean action. Cache-first: it renders the last cached results instantly,
   then revalidates with a scan in the background (no blocking spinner). The
   scan never re-mounts the screen, so the live host is never detached and the
   results always paint when measuring finishes. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // Points at the current mount's render so an async scan repaints the live
  // (attached) host, even if it was started by an earlier mount.
  let latestRender = null;
  function paint() { if (latestRender) latestRender(); }

  // The live scan card updates IN PLACE on each progress tick (no full paint),
  // so toggling selection while a scan runs never rebuilds the screen / flickers.
  let progRefs = null; // { node, set } of the current shared scan card

  // Derive the live progress fields. System emits { index, total, current }: it
  // always has a total, so this is DETERMINATE (percent = index/total). Used to
  // build the shared scan card and to update it in place on each tick.
  function sysProgressInfo() {
    const pr = S.systemProgress || {};
    const total = pr.total != null ? pr.total : 0;
    const index = pr.index != null ? pr.index : 0;
    const sized = Math.min(index, total);
    const percent = total ? Math.max(0, Math.min(100, Math.round((sized / total) * 100))) : null;
    const sub = total
      ? sized.toLocaleString() + ' of ' + total.toLocaleString() + ' locations sized · ' + percent + '%'
      : 'Starting…';
    return { sub, percent, label: 'Measuring caches' };
  }
  function liveProgress() {
    if (!progRefs || !progRefs.set) return;
    const info = sysProgressInfo();
    progRefs.set({ sub: info.sub, percent: info.percent });
  }

  function selSet() {
    if (!S.systemSel || !(S.systemSel instanceof Set)) S.systemSel = new Set();
    return S.systemSel;
  }
  function preselect(targets) {
    const sel = selSet();
    sel.clear();
    targets.forEach((t) => { if (t.safe && !isPermanent(t)) sel.add(t.id); });
  }
  // Irreversible data (AI tool session history, SQLite databases). Never
  // preselected, never swept up by Select all, and confirmed before deleting.
  function isPermanent(t) {
    return t.reversible === false || (t.storyCategory === 'aitools' && !t.safe);
  }
  const isAiTools = (cat) => cat === 'AI tools';

  // One three-tier risk scheme, shared in spirit with Recommendations, the
  // action page and project items: Safe (green), Review (amber), Permanent
  // (red). Permanent wins over Review.
  function riskOf(t) {
    if (isPermanent(t)) return { cls: 'sp-badge-warn', text: 'Permanent' };
    if (!t.safe) return { cls: 'sp-badge-caution', text: 'Review' };
    return { cls: 'sp-badge-safe', text: 'Safe' };
  }

  // Row mark: the app's own logo when we know it (AI tools, browsers), then a
  // Catppuccin tech mark for developer caches, then the target's glyph.
  function targetMark(t, size) {
    const B = window.SpaciBrandIcon;
    const brand = B && B.forTarget(t);
    if (brand && SP.bic) return SP.bic(brand, size, { label: t.name, fallback: t.icon || 'database' });
    const T = window.SpaciTechIcon;
    const tech = T && T.forTarget(t);
    if (tech && SP.tic) return SP.tic(tech, size, { label: t.name });
    return ic(t.icon || 'database', size);
  }
  function groupByCategory(targets) {
    const order = [];
    const map = new Map();
    targets.forEach((t) => {
      if (!map.has(t.category)) { map.set(t.category, []); order.push(t.category); }
      map.get(t.category).push(t);
    });
    return order.map((cat) => ({ cat, items: map.get(cat) }));
  }
  // Single source of truth: the shared cache mirror (loaded at boot, refreshed
  // by foreground rescans here and by background scans via onCacheUpdated).
  function targetsNow() { return Array.isArray(S.sysTargets) ? S.sysTargets : []; }

  SP.screens.system = function (host) {
    // Detach any live progress subscription so re-renders never leak listeners.
    function detach() {
      if (S.systemUnsub) { try { S.systemUnsub(); } catch (_) {} S.systemUnsub = null; }
    }

    // Revalidate caches: foreground (manual button) or silent (mount, when stale).
    // System scan streams { phase, index, total, current }: it has a total, so we
    // render a DETERMINATE "X of Y · NN%" block. Progress lands on S.systemProgress
    // and repaints via paint() so the running strip updates live.
    async function runScan() {
      if (S.systemLoading) return; // a scan is already in flight
      detach();
      S.systemLoading = true; S.systemError = null;
      S.systemProgress = null;
      // Guard against double-subscribe: detach() above already cleared any prior sub.
      // Update the scan card in place; do NOT paint() per tick (that rebuilt the
      // whole screen and flickered while a scan was running).
      S.systemUnsub = api.onSystemProgress ? api.onSystemProgress((p) => {
        if (!p || p.phase === 'done') return;
        S.systemProgress = p;
        liveProgress();
      }) : null;
      paint();
      try {
        const res = await api.scanSystem();
        if (res && res.ok) {
          const targets = (res.targets || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
          const hadSelection = selSet().size > 0;
          S.sysTargets = targets;
          S.lastScan = Date.now();
          if (!hadSelection) preselect(targets);
        } else {
          S.systemError = (res && res.error) || 'Scan failed';
        }
      } catch (err) {
        S.systemError = (err && err.message) || 'Scan failed';
      } finally {
        detach();
        S.systemLoading = false;
        S.systemProgress = null;
        paint();
      }
    }

    async function cleanSelected() {
      const targets = targetsNow();
      const sel = selSet();
      const chosen = targets.filter((t) => sel.has(t.id));
      if (!chosen.length || S.systemCleaning) return;
      const jobs = [];
      chosen.forEach((t) => {
        const paths = (t.existingPaths && t.existingPaths.length) ? t.existingPaths : t.paths;
        (paths || []).forEach((p) => jobs.push({ path: p, mode: t.mode || 'contents' }));
      });
      if (!jobs.length) return;
      const permanent = chosen.filter(isPermanent);
      const risky = chosen.filter((t) => !t.safe || isPermanent(t));
      const review = risky.filter((t) => !isPermanent(t));
      // Each Review target says in its own words what deleting it means.
      const note = review.length
        ? review.slice(0, 4).map((t) => t.name + ': ' + (t.description || 'Review before deleting.')).join('\n')
          + (review.length > 4 ? '\nand ' + (review.length - 4) + ' more.' : '')
        : undefined;
      const cf = await SP.confirmClean({
        force: risky.length > 0,
        count: chosen.length,
        bytes: chosen.reduce((a, t) => a + (t.size || 0), 0),
        permanent: permanent.map((t) => t.name),
        note
      });
      if (!cf.go) return;
      const nameOf = (id) => { const t = targets.find((x) => x.id === id); return t ? t.name : ''; };
      const noun = permanent.length ? 'item' : 'cache';
      S.systemCleaning = true; paint();
      SP.setCleaning(true);
      let needsRescan = false;
      try {
        const meta = {
          scope: 'system',
          label: chosen.length + ' system ' + (chosen.length === 1 ? noun : noun + 's')
        };
        if (cf.confirmed) meta.confirmed = true;
        const res = await api.clean(jobs, meta);
        const sum = SP.reportClean(res, {
          fallbackFreed: chosen.reduce((a, t) => a + (t.size || 0), 0),
          names: nameOf,
          burstLabel: 'across ' + chosen.length + ' ' + noun + (chosen.length === 1 ? '' : 's')
        });
        if (sum.ok) {
          // Only targets that were actually cleaned leave the list. Anything
          // refused or failed stays, still selected, so it can be retried.
          const cleaned = chosen.filter((t) => !sum.refusedTargets.has(t.id) && !(t.paths || []).some((p) => sum.blocked(p)));
          const cleanedIds = new Set(cleaned.map((t) => t.id));
          S.sysTargets = targetsNow().filter((t) => !cleanedIds.has(t.id));
          cleanedIds.forEach((id) => sel.delete(id));
          needsRescan = sum.issues > 0;
        }
      } catch (err) {
        SP.reportClean({ ok: false, error: (err && err.message) || 'Clean failed' });
      }
      S.systemCleaning = false; paint();
      if (needsRescan) runScan(); // refresh sizes of anything partly cleaned
    }

    function header() {
      const scanning = S.systemLoading || S.bgScanning;
      return el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'System Cleaner' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px', text: 'Developer, AI tool and system data. Caches rebuild on their own. Items marked Permanent are never selected for you and cannot be recovered.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
          hov: 'background:var(--accent-hover)',
          onclick: () => { if (!scanning) runScan(); }
        }, [scanning ? ring('elastic', 17) : ic('scanner', 17), scanning ? 'Scanning…' : 'Scan'])
      ]);
    }

    // Centered running block, built from the SHARED scan card (spiral ring +
    // "Measuring caches" + running badge + determinate bar), identical across
    // screens. Stores progRefs so progress updates it in place (no full paint).
    function scanBlock() {
      const info = sysProgressInfo();
      progRefs = SP.scanCard({ label: info.label, sub: info.sub, percent: info.percent });
      return progRefs.node;
    }

    function row(t) {
      const sel = selSet();
      const on = sel.has(t.id);
      const permanent = isPermanent(t);
      const risk = riskOf(t);
      return el('div', {
        class: 'sp-hov',
        style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer;box-shadow:var(--shadow-sm)',
        hov: 'border-color:var(--border-2)',
        onclick: () => { if (on) sel.delete(t.id); else sel.add(t.id); paint(); }
      }, [
        el('div', {
          class: 'sp-check' + (on ? ' sp-check-on' : ''),
          style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s'
        }, [ic('tick', 14)]),
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [targetMark(t, 22)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px' }, [
            el('span', { text: t.name }),
            el('span', {
              class: risk.cls,
              style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
              text: risk.text
            })
          ]),
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px;line-height:1.5', text: t.description || '' }),
          permanent ? el('div', { style: 'color:var(--danger-fg);font-size:12px;font-weight:600;margin-top:4px;display:flex;align-items:center;gap:6px' }, [
            ic('lock', 13), 'Permanent loss of history. This cannot be undone.'
          ]) : null
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(t.size || 0) })
      ]);
    }

    // ---- Docker ----------------------------------------------------------
    // Engine storage lives inside a VM image, so no amount of filesystem
    // scanning can see it. It gets its own card because it is also reclaimed
    // differently: `docker` prunes it, Spaci never deletes those paths itself.
    async function loadDocker(force) {
      if (S.dockerLoading || !api.dockerStatus) return;
      S.dockerLoading = true;
      if (force) paint(); // show the checking state
      try { S.docker = await api.dockerStatus(force); }
      catch (_) { S.docker = null; }
      finally { S.dockerLoading = false; paint(); }
    }

    const PRUNE_NOUN = { 'build-cache': 'the build cache', 'dangling-images': 'untagged images' };
    async function runPrune(kind, label) {
      if (S.dockerPruning) return;
      const cf = await SP.confirmClean({ title: 'Run Docker cleanup?', count: 1, note: label + '. Docker rebuilds this cache the next time you build.' });
      if (!cf.go) return;
      S.dockerPruning = kind;
      S.dockerResult = null;
      paint();
      try {
        const res = await api.dockerPrune(kind);
        // Freed space may not reach the host disk right away (Docker.raw,
        // WSL2 VHDX): the note from main says so, after every prune.
        const note = (res && res.note) || (S.docker && S.docker.diskNote) || null;
        S.dockerResult = res && res.ok
          ? { ok: true, text: `Reclaimed ${fmt(res.freed || 0)} from ${PRUNE_NOUN[kind] || 'Docker'}.`, note }
          : { ok: false, text: (res && res.error) || 'Docker cleanup failed.' };
      } catch (err) {
        S.dockerResult = { ok: false, text: (err && err.message) || 'Docker cleanup failed.' };
      } finally {
        S.dockerPruning = null;
        paint();
        loadDocker(true);
      }
    }

    // ---- Docker volumes: reviewed and removed one at a time -------------
    // Volumes hold databases and uploads, so there is no bulk action and no
    // preselection. Each Remove names the volume and says it is permanent;
    // main refuses anything unconfirmed or still mounted by a container.
    const hasVolumesApi = () => typeof api.dockerVolumes === 'function';
    function volSize(v) { return Number(v && (v.size != null ? v.size : v.sizeBytes)) || 0; }
    function normaliseVolumes(res) {
      const list = Array.isArray(res && res.volumes) ? res.volumes.filter((v) => v && typeof v.name === 'string') : [];
      const byName = new Map(list.map((v) => [v.name, v]));
      let groups = Array.isArray(res && res.groups) ? res.groups : null;
      const out = [];
      const seen = new Set();
      if (groups) {
        groups.forEach((g) => {
          if (!g) return;
          const vols = (Array.isArray(g.volumes) ? g.volumes : [])
            .map((x) => (typeof x === 'string' ? byName.get(x) : x))
            .filter((v) => v && typeof v.name === 'string' && !seen.has(v.name));
          vols.forEach((v) => seen.add(v.name));
          if (!vols.length) return;
          out.push({ project: typeof g.project === 'string' && g.project ? g.project : null, volumes: vols });
        });
      }
      // Volumes no group mentioned (or no groups at all): group by project here.
      const rest = new Map();
      list.forEach((v) => {
        if (seen.has(v.name)) return;
        const key = typeof v.project === 'string' && v.project ? v.project : '';
        if (!rest.has(key)) rest.set(key, []);
        rest.get(key).push(v);
      });
      rest.forEach((vols, key) => out.push({ project: key || null, volumes: vols }));
      out.forEach((g) => {
        g.volumes.sort((a, b) => volSize(b) - volSize(a));
        g.size = g.volumes.reduce((a, v) => a + volSize(v), 0);
      });
      // Named projects first by size, the loose volumes last.
      out.sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1) || b.size - a.size);
      return out;
    }
    async function loadVolumes() {
      if (!hasVolumesApi() || S.dockerVolLoading) return;
      S.dockerVolLoading = true;
      S.dockerVolError = null;
      paint();
      try {
        const res = await api.dockerVolumes();
        if (res && res.ok !== false) S.dockerVols = { at: Date.now(), groups: normaliseVolumes(res) };
        else S.dockerVolError = (res && res.error) || 'Spaci could not list Docker volumes.';
      } catch (err) {
        S.dockerVolError = (err && err.message) || 'Spaci could not list Docker volumes.';
      } finally {
        S.dockerVolLoading = false;
        paint();
      }
    }
    async function removeVolume(v) {
      if (S.dockerVolBusy || v.inUse || typeof api.dockerRemoveVolume !== 'function') return;
      const ok = await SP.confirm({
        title: 'Remove volume ' + v.name + '?',
        body: 'This deletes the Docker volume "' + v.name + '" (' + fmt(volSize(v)) + ') and everything stored in it, such as database files and uploads.\n\nThis cannot be undone. Nothing goes to the Trash.',
        confirmLabel: 'Remove volume',
        danger: true,
        icon: 'trash',
      });
      if (!ok) return;
      S.dockerVolBusy = v.name;
      S.dockerVolResult = null;
      paint();
      try {
        const res = await api.dockerRemoveVolume(v.name, { confirmed: true });
        if (res && res.ok) {
          S.dockerVolResult = { ok: true, text: 'Removed volume ' + v.name + (res.freed ? ', freed ' + fmt(res.freed) : '') + '.', note: (S.docker && S.docker.diskNote) || null };
          if (S.dockerVols) {
            S.dockerVols.groups.forEach((g) => { g.volumes = g.volumes.filter((x) => x.name !== v.name); g.size = g.volumes.reduce((a, x) => a + volSize(x), 0); });
            S.dockerVols.groups = S.dockerVols.groups.filter((g) => g.volumes.length);
          }
        } else {
          const err = res && res.error;
          S.dockerVolResult = { ok: false, text: err === 'needs-confirmation' ? 'Spaci needs your confirmation to remove a volume. Nothing was removed.' : ((err || 'Docker did not remove the volume') + '. Nothing was removed.') };
        }
      } catch (err) {
        S.dockerVolResult = { ok: false, text: ((err && err.message) || 'Docker did not remove the volume') + '. Nothing was removed.' };
      } finally {
        S.dockerVolBusy = null;
        paint();
        loadDocker(true);
      }
    }

    // Restart Docker Desktop: only offered when its engine stopped answering.
    async function restartDocker() {
      if (S.dockerRestarting || typeof api.dockerRestart !== 'function') return;
      const ok = await SP.confirm({
        title: 'Restart Docker Desktop?',
        body: 'Spaci quits Docker Desktop and opens it again, then waits for its engine to answer. Containers that were running stop, and start again only if they are set to restart.',
        confirmLabel: 'Restart Docker',
        icon: 'refresh',
      });
      if (!ok) return;
      S.dockerRestarting = true;
      S.dockerRestartResult = null;
      paint();
      try {
        const res = await api.dockerRestart();
        S.dockerRestartResult = res && res.ok
          ? { ok: true, text: 'Docker Desktop restarted and its engine is answering.' }
          : { ok: false, text: (res && (res.message || res.error)) || 'Docker Desktop did not come back. Open it yourself and check again.' };
      } catch (err) {
        S.dockerRestartResult = { ok: false, text: (err && err.message) || 'Docker Desktop did not come back.' };
      } finally {
        S.dockerRestarting = false;
        S.dockerVols = null;
        paint();
        loadDocker(true);
      }
    }

    function notice(r) {
      return el('div', {
        style: `display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-radius:11px;font-size:12.5px;font-weight:600;line-height:1.5;background:${r.ok ? 'var(--success-soft)' : 'var(--danger-soft)'};color:${r.ok ? 'var(--success-fg)' : 'var(--danger-fg)'}`,
      }, [ic(r.ok ? 'check' : 'warning', 16), el('div', {}, [
        el('div', { text: r.text }),
        r.note ? el('div', { style: 'font-weight:500;color:var(--text-2);margin-top:3px', text: r.note }) : null,
      ])]);
    }

    function volumeRow(v) {
      const busy = S.dockerVolBusy === v.name;
      const users = Array.isArray(v.containers) ? v.containers.filter((c) => typeof c === 'string') : [];
      const sub = v.inUse
        ? 'In use by ' + (users.length ? users.slice(0, 3).join(', ') + (users.length > 3 ? ' and ' + (users.length - 3) + ' more' : '') : 'a container')
        : 'Not used by any container';
      return el('div', { style: 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:11px;background:var(--panel-2);border:1px solid var(--border)' }, [
        ic('database', 17, { color: 'var(--text-3)' }),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { class: 'mono', title: v.name, style: 'font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: v.name }),
          el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: sub }),
        ]),
        el('span', {
          class: v.inUse ? 'sp-badge-accent' : 'sp-badge-caution',
          style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none',
          text: v.inUse ? 'In use' : 'Unused',
        }),
        el('div', { style: 'font-weight:700;font-size:13.5px;min-width:64px;text-align:right;flex:none;font-variant-numeric:tabular-nums', text: fmt(volSize(v)) }),
        el('button', {
          title: v.inUse ? 'A container uses this volume. Remove the container first.' : 'Remove this volume permanently',
          'aria-label': 'Remove volume ' + v.name,
          style: 'height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--border-2);background:var(--panel);color:var(--danger-fg);font-weight:650;font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer;font-family:inherit;flex:none'
            + ((v.inUse || S.dockerVolBusy) ? ';opacity:.45;pointer-events:none' : ''),
          hov: 'border-color:var(--danger);background:var(--danger-soft)',
          onclick: () => removeVolume(v),
        }, [busy ? ring('elastic', 13) : ic('trash', 13), busy ? 'Removing…' : 'Remove']),
      ]);
    }

    function volumesSection() {
      if (!hasVolumesApi()) return null;
      const open = !!S.dockerVolOpen;
      const vc = (S.docker && S.docker.categories && S.docker.categories.volumes) || null;
      const toggle = el('button', {
        'aria-expanded': open ? 'true' : 'false',
        style: 'height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;align-self:flex-start',
        hov: 'border-color:var(--accent);color:var(--accent-fg)',
        onclick: () => {
          S.dockerVolOpen = !open;
          if (S.dockerVolOpen && !S.dockerVols) loadVolumes(); else paint();
        },
      }, [ic('database', 15), (open ? 'Hide volumes' : 'Review volumes') + (vc && vc.count ? ' (' + vc.count + ')' : ''), ic(open ? 'chevron-up' : 'chevron-down', 14)]);
      const kids = [toggle];
      if (open) {
        kids.push(el('div', { style: 'color:var(--text-3);font-size:12px;line-height:1.5', text: 'Volumes hold databases and uploads. Removing one deletes its data for good, so Spaci never removes them in bulk or selects them for you.' }));
        if (S.dockerVolResult) kids.push(notice(S.dockerVolResult));
        if (S.dockerVolLoading && !S.dockerVols) {
          kids.push(el('div', { style: 'display:flex;align-items:center;gap:10px;color:var(--text-3);font-size:12.5px' }, [ring('elastic', 16), 'Reading volumes…']));
        } else if (S.dockerVolError) {
          kids.push(notice({ ok: false, text: S.dockerVolError }));
        } else if (S.dockerVols && !S.dockerVols.groups.length) {
          kids.push(el('div', { style: 'color:var(--text-3);font-size:12.5px', text: 'No volumes found.' }));
        } else if (S.dockerVols) {
          S.dockerVols.groups.forEach((g) => {
            const unused = g.volumes.filter((v) => !v.inUse).length;
            kids.push(el('div', { style: 'display:flex;flex-direction:column;gap:7px' }, [
              el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:4px' }, [
                el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: g.project ? 'Project ' + g.project : 'Not part of a Compose project' }),
                el('div', { style: 'font-size:12px;color:var(--text-3);font-weight:600;flex:none', text: g.volumes.length + (g.volumes.length === 1 ? ' volume' : ' volumes') + (unused ? ', ' + unused + ' unused' : '') + ' · ' + fmt(g.size) }),
              ]),
              ...g.volumes.map(volumeRow),
            ]));
          });
        }
      }
      return el('div', { style: 'display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:1px solid var(--border)' }, kids);
    }

    function dockerStat(label, cat, sub) {
      const free = cat ? cat.reclaimable || 0 : 0;
      return el('div', { style: 'flex:1;min-width:126px' }, [
        el('div', { style: 'font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:600', text: label }),
        el('div', { style: 'font-size:16px;font-weight:700;margin-top:4px', text: fmt(cat ? cat.size || 0 : 0) }),
        el('div', {
          style: `font-size:12px;margin-top:2px;color:${!sub && free > 0 ? 'var(--accent-fg)' : 'var(--text-3)'}`,
          text: sub || (free > 0 ? fmt(free) + ' unused' : 'all in use'),
        }),
      ]);
    }

    function dockerButton(label, kind) {
      const busy = S.dockerPruning === kind;
      return el('button', {
        style: 'height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit'
          + (busy ? ';opacity:.55;pointer-events:none' : ''),
        hov: 'border-color:var(--accent);color:var(--accent-fg)',
        onclick: () => runPrune(kind, label),
      }, [busy ? ring('elastic', 15) : ic('broom', 15), busy ? 'Reclaiming…' : label]);
    }

    // not-installed | stopped | engine-down | unresponsive | running. Older cached results
    // carry no `state`, so derive it from what they do have.
    function dockerState(d) {
      const st = d.status || {};
      const given = st.state || d.state;
      if (given === 'running' && !d.ok) return 'unreadable'; // engine answers, inventory does not
      if (!given && !d.ok && !d.status && d.reason === 'error') return 'unavailable';
      return given || d.state || (d.ok ? 'running' : (st.installed ? 'stopped' : 'not-installed'));
    }

    // The VM disk image is a sparse file: Finder shows the size it reserves, but
    // only `allocatedBytes` is on disk. Say so only when the gap is large.
    function diskImageStat(disk) {
      const real = disk.allocatedBytes != null ? disk.allocatedBytes : (disk.bytes || 0);
      return el('div', { style: 'flex:1;min-width:126px' }, [
        el('div', { style: 'font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:600', text: 'Disk image' }),
        el('div', { style: 'font-size:16px;font-weight:700;margin-top:4px', text: fmt(real) }),
        el('div', { style: 'font-size:12px;margin-top:2px;color:var(--text-3)', text: 'used on disk' }),
      ]);
    }
    function diskImageNote(disk) {
      const real = disk.allocatedBytes != null ? disk.allocatedBytes : (disk.bytes || 0);
      const apparent = disk.apparentBytes || 0;
      if (!(apparent >= real * 1.5 && apparent - real >= 5 * 1024 ** 3)) return null;
      return el('div', {
        style: 'color:var(--text-3);font-size:11.5px;line-height:1.5',
        text: 'Finder shows ' + fmt(apparent) + ' for the Docker disk image because it reserves room it has not used. Only the ' + fmt(real) + ' it really occupies counts.',
      });
    }

    function dockerCard() {
      const d = S.docker;
      if (!d) return null;
      const disk = d.desktopDisk || null;
      // Refresh failed outright and we know nothing about Docker: neutral card,
      // unless nothing points to Docker being installed at all.
      // A remote Docker context is never managed here, whatever its state.
      const remote = Boolean((d.status && d.status.remote) || d.remote);
      const state = remote ? 'remote' : dockerState(d);
      // No Docker and nothing left behind: nothing to say.
      if (state === 'not-installed' && !disk) return null;

      const shell = (children) => el('div', {
        style: 'display:flex;flex-direction:column;gap:14px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border);margin:26px 0 0;box-shadow:var(--shadow-sm)',
      }, children);

      const running = state === 'running' && d.ok;
      const SUB = {
        running: 'Images, volumes and build cache' + (d.projects ? ` · ${d.projects} scanned project${d.projects === 1 ? '' : 's'} using Docker` : ''),
        stopped: 'Docker Desktop is not running',
        'engine-down': 'Docker Desktop is open, but its engine is not responding',
        unresponsive: 'Docker Desktop is open, but it stopped responding',
        'no-permission': 'Docker is running, but Spaci cannot talk to it',
        remote: 'Docker is pointed at a remote host',
        unreadable: 'Docker is running, but Spaci could not read its usage',
        'not-installed': 'Docker is not installed',
      };
      const BADGE = {
        stopped: ['sp-badge-caution', 'Stopped'],
        'engine-down': ['sp-badge-warn', 'Not responding'],
        unresponsive: ['sp-badge-warn', 'Not responding'],
        'no-permission': ['sp-badge-warn', 'No access'],
        remote: ['sp-badge-caution', 'Remote'],
        unreadable: ['sp-badge-caution', 'Unreadable'],
        'not-installed': ['sp-badge-caution', 'Not installed'],
      };
      const known = Object.prototype.hasOwnProperty.call(SUB, state);
      const badge = BADGE[state];

      // The header total covers what Docker can clean: images and build cache.
      // Volumes (data) and containers are reviewed separately, never summed in.
      const cats = d.categories || {};
      const cleanable = ['images', 'buildCache'].map((k) => cats[k] || {});
      const headSize = cleanable.reduce((a, c) => a + (c.size || 0), 0);
      const headFree = cleanable.reduce((a, c) => a + (c.reclaimable || 0), 0);
      const title = el('div', { style: 'display:flex;align-items:center;gap:13px' }, [
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' },
          [SP.bic ? SP.bic('docker', 26, { label: 'Docker', fallback: 'box' }) : ic('box', 24)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15px;display:flex;align-items:center;gap:9px' }, [
            el('span', { text: 'Docker' }),
            !running && badge ? el('span', { class: badge[0], style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text: badge[1] }) : null,
          ]),
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: known ? SUB[state] : 'Docker status unavailable' }),
        ]),
        running ? el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'font-weight:700;font-size:15px', text: fmt(headSize) }),
          el('div', { style: 'font-size:12px;color:var(--accent-fg);font-weight:600', text: fmt(headFree) + ' reclaimable' }),
          el('div', { style: 'font-size:11px;color:var(--text-3);margin-top:1px', text: 'images and build cache' }),
        ]) : null,
      ]);

      if (!running) {
        const COPY = {
          stopped: 'Start Docker Desktop and check again to see how much space images, volumes and build cache are holding.',
          'engine-down': 'Restart Docker Desktop, then check again. Nothing inside Docker can be cleaned until its engine responds.',
          unresponsive: 'Docker Desktop is running but not answering. Restart it, then check again. Nothing inside Docker can be cleaned until it responds.',
          'no-permission': 'Spaci does not have permission to use Docker. Add your user to the docker group or use rootless Docker, then check again.',
          unreadable: 'Docker may still be starting or busy. Check again in a moment.',
          remote: 'Spaci only manages Docker on this Mac, so it shows no cleanup for a remote host.',
          'not-installed': 'Its disk image is still on this Mac and still using space. Spaci does not delete it.',
        };
        const kids = [
          title,
          el('div', { style: 'color:var(--text-3);font-size:12.5px;line-height:1.5', text: known ? COPY[state] : 'Spaci could not tell whether Docker is running. Check again in a moment.' }),
        ];
        if (disk) {
          kids.push(el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px 20px;padding-top:14px;border-top:1px solid var(--border)' }, [diskImageStat(disk)]));
          const note = diskImageNote(disk);
          if (note) kids.push(note);
        }
        if (S.dockerRestartResult) kids.push(notice(S.dockerRestartResult));
        if (state !== 'not-installed') {
          const canRestart = (state === 'unresponsive' || state === 'engine-down') && typeof api.dockerRestart === 'function';
          kids.push(el('div', { style: 'display:flex;gap:9px' }, [
            canRestart ? el('button', {
              style: 'height:38px;padding:0 16px;border-radius:10px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (S.dockerRestarting ? ';opacity:.6;pointer-events:none' : ''),
              hov: 'background:var(--accent-hover)',
              onclick: () => restartDocker(),
            }, [S.dockerRestarting ? ring('elastic', 15) : ic('refresh', 15), S.dockerRestarting ? 'Restarting Docker…' : 'Restart Docker']) : null,
            el('button', {
              style: 'height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (S.dockerLoading ? ';opacity:.55;pointer-events:none' : ''),
              hov: 'border-color:var(--accent);color:var(--accent-fg)',
              onclick: () => loadDocker(true),
            }, [S.dockerLoading ? ring('elastic', 15) : ic('refresh', 15), S.dockerLoading ? 'Checking…' : 'Check again']),
          ]));
        }
        return shell(kids);
      }

      const c = d.categories;
      const vol = c.volumes || {};
      const unusedVols = Math.max(0, (vol.count || 0) - (vol.active || 0));
      const stats = [
        dockerStat('Images', c.images),
        dockerStat('Build cache', c.buildCache),
        dockerStat('Volumes', c.volumes, unusedVols ? unusedVols + ' not in use, review below' : 'all in use'),
        dockerStat('Containers', c.containers, (c.containers && c.containers.count ? c.containers.count : 0) + ' total, not cleaned here'),
      ];
      if (disk) stats.push(diskImageStat(disk));
      const rows = [
        title,
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px 20px;padding-top:14px;border-top:1px solid var(--border)' }, stats),
      ];
      const gapNote = disk ? diskImageNote(disk) : null;
      if (gapNote) rows.push(gapNote);

      if (S.dockerResult) rows.push(notice(S.dockerResult));

      const buttons = [];
      if ((c.buildCache.reclaimable || 0) > 0) buttons.push(dockerButton('Reclaim ' + fmt(c.buildCache.reclaimable) + ' build cache', 'build-cache'));
      if ((c.images.reclaimable || 0) > 0) buttons.push(dockerButton('Remove unused images', 'dangling-images'));
      if (buttons.length) rows.push(el('div', { style: 'display:flex;flex-wrap:wrap;gap:9px' }, buttons));

      rows.push(el('div', {
        style: 'color:var(--text-3);font-size:11.5px;line-height:1.5',
        text: 'Build cache and untagged image layers rebuild on your next build. Volumes are never cleaned in bulk: review them one at a time below.',
      }));
      const vs = volumesSection();
      if (vs) rows.push(vs);
      return shell(rows);
    }

    function group(grp) {
      const total = grp.items.reduce((a, t) => a + (t.size || 0), 0);
      return el('div', {}, [
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:24px 0 12px' }, [
          el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: grp.cat }),
          el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600', text: fmt(total) })
        ]),
        isAiTools(grp.cat) ? el('div', { style: 'color:var(--text-3);font-size:12.5px;line-height:1.5;margin:-4px 0 12px;max-width:620px', text: 'Quit a tool completely before cleaning its data. Spaci leaves a tool alone while it is running. History, databases and undo snapshots are permanent and start unselected.' }) : null,
        el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' }, grp.items.map(row))
      ]);
    }

    function selectAllRow(targets) {
      const sel = selSet();
      // Select all only takes the safe ones. Permanent items are opt-in one by one.
      const pickable = targets.filter((t) => t.safe && !isPermanent(t));
      const hasOptIn = pickable.length < targets.length;
      const allOn = pickable.length > 0 && pickable.every((t) => sel.has(t.id));
      return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:26px 0 0' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: targets.length + (targets.length === 1 ? ' cleanable item' : ' cleanable items') }),
        el('button', {
          style: 'height:34px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel);color:var(--text)',
          onclick: () => { if (allOn) sel.clear(); else pickable.forEach((t) => sel.add(t.id)); paint(); }
        }, [ic('check-circle', 15), allOn ? 'Clear all' : (hasOptIn ? 'Select all safe' : 'Select all')])
      ]);
    }

    // Centered placeholder (animated logo, not a static icon).
    function bigState(anim, title, body, btnLabel, primary) {
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:16px;color:var(--text-3)' }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring(anim, 60)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: title }),
        el('div', { style: 'font-size:13.5px;max-width:380px', text: body }),
        btnLabel ? el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:' + (primary ? 'none;background:var(--accent);color:var(--on-accent)' : '1px solid var(--border-2);background:var(--panel-2);color:var(--text)') + ';font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: primary ? 'background:var(--accent-hover)' : 'background:var(--panel-3)',
          onclick: () => runScan()
        }, [ic('scanner', 16), btnLabel]) : null
      ]);
    }

    function syncActionBar(targets) {
      const sel = selSet();
      const chosen = targets.filter((t) => sel.has(t.id));
      const n = chosen.length;
      if (!n) { SP.setActionBar(null); return; }
      const bytes = chosen.reduce((a, t) => a + (t.size || 0), 0);
      const permanent = chosen.some(isPermanent);
      const risky = chosen.some((t) => !t.safe);
      const noun = permanent ? 'item' : 'cache';
      SP.setActionBar({
        count: n + ' ' + noun + (n > 1 ? 's' : ''),
        size: fmt(bytes),
        action: (risky || permanent ? 'Delete ' : 'Clean ') + fmt(bytes),
        danger: risky || permanent,
        onClear: () => { selSet().clear(); paint(); },
        onClean: () => cleanSelected(),
      });
    }

    function render() {
      host.innerHTML = '';
      progRefs = null; // rebuilt by scanBlock() below while scanning
      host.appendChild(header());
      const targets = targetsNow();
      const loading = S.systemLoading || S.bgScanning;

      // Cache-first: if results exist, always show them. A revalidation in
      // progress shows the shared scan card above the list (centered), not a
      // blocking spinner.
      if (targets.length) {
        if (loading) host.appendChild(scanBlock());
        if (S.systemError) host.appendChild(el('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:13px 16px;border-radius:12px;background:var(--danger-soft);color:var(--danger-fg);font-size:13px;font-weight:600;margin:0 0 4px'
        }, [ic('warning', 17), S.systemError]));
        const docker = dockerCard();
        if (docker) host.appendChild(docker);
        host.appendChild(selectAllRow(targets));
        groupByCategory(targets).forEach((grp) => host.appendChild(group(grp)));
        syncActionBar(targets);
        return;
      }

      // Nothing cached yet.
      SP.setActionBar(null);
      if (loading) { host.appendChild(scanBlock()); return; }
      if (S.systemError) { host.appendChild(bigState('breathe', 'Could not scan caches', S.systemError, 'Try again', true)); return; }
      host.appendChild(bigState('breathe', 'All clean', 'No reclaimable caches were found on this machine right now.', 'Scan', false));
    }

    latestRender = render;
    render(); // cache-first immediate paint

    // Revalidate: scan now if nothing is cached, or silently if it is stale.
    // Skip if a background scan is already running (onCacheUpdated will repaint).
    const haveData = targetsNow().length > 0;
    const stale = !S.lastScan || (Date.now() - S.lastScan) > 60000;
    if (!S.bgScanning && !S.systemLoading && (!haveData || stale)) runScan();

    // Docker answers in about a second, independently of the cache scan.
    if (!S.docker || Date.now() - (S.docker.at || 0) > 60000) loadDocker();
  };
})();
