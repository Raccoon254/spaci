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
    targets.forEach((t) => { if (t.safe) sel.add(t.id); });
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
      S.systemCleaning = true; paint();
      try {
        const res = await api.clean(jobs, {
          scope: 'system',
          label: chosen.length + ' system ' + (chosen.length === 1 ? 'cache' : 'caches'),
          reversible: true
        });
        if (res && res.ok) {
          const cleanedIds = new Set(chosen.map((t) => t.id));
          S.sysTargets = targetsNow().filter((t) => !cleanedIds.has(t.id));
          cleanedIds.forEach((id) => sel.delete(id));
          const freed = res.totalFreed != null ? res.totalFreed : chosen.reduce((a, t) => a + (t.size || 0), 0);
          SP.burst(fmt(freed), 'across ' + chosen.length + ' cache' + (chosen.length === 1 ? '' : 's'));
        } else {
          S.systemError = (res && res.error) || 'Clean failed';
        }
      } catch (err) {
        S.systemError = (err && err.message) || 'Clean failed';
      }
      S.systemCleaning = false; paint();
    }

    function header() {
      const scanning = S.systemLoading || S.bgScanning;
      return el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'System Cleaner' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px', text: 'Developer and system caches. Everything here is regenerable, clearing it is safe and reversible.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
          hov: 'background:var(--accent-hover)',
          onclick: () => { if (!scanning) runScan(); }
        }, [scanning ? ring('elastic', 17) : ic('scanner', 17), scanning ? 'Scanning…' : 'Rescan caches'])
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
      const badgeSafe = t.safe;
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
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(t.icon || 'database', 22)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px' }, [
            el('span', { text: t.name }),
            el('span', {
              class: badgeSafe ? 'sp-badge-safe' : 'sp-badge-warn',
              style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
              text: badgeSafe ? 'Safe' : 'Review'
            })
          ]),
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: t.description || '' })
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(t.size || 0) })
      ]);
    }

    function group(grp) {
      const total = grp.items.reduce((a, t) => a + (t.size || 0), 0);
      return el('div', {}, [
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:24px 0 12px' }, [
          el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: grp.cat }),
          el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600', text: fmt(total) })
        ]),
        el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' }, grp.items.map(row))
      ]);
    }

    function selectAllRow(targets) {
      const sel = selSet();
      const allOn = targets.length > 0 && targets.every((t) => sel.has(t.id));
      return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:26px 0 0' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: targets.length + (targets.length === 1 ? ' cleanable item' : ' cleanable items') }),
        el('button', {
          style: 'height:34px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel);color:var(--text)',
          onclick: () => { if (allOn) sel.clear(); else targets.forEach((t) => sel.add(t.id)); paint(); }
        }, [ic('check-circle', 15), allOn ? 'Clear all' : 'Select all'])
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
      SP.setActionBar({
        count: n + ' cache' + (n > 1 ? 's' : ''),
        size: fmt(bytes),
        action: 'Clean ' + fmt(bytes),
        danger: false,
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
        host.appendChild(selectAllRow(targets));
        groupByCategory(targets).forEach((grp) => host.appendChild(group(grp)));
        syncActionBar(targets);
        return;
      }

      // Nothing cached yet.
      SP.setActionBar(null);
      if (loading) { host.appendChild(scanBlock()); return; }
      if (S.systemError) { host.appendChild(bigState('breathe', 'Could not scan caches', S.systemError, 'Try again', true)); return; }
      host.appendChild(bigState('breathe', 'All clean', 'No reclaimable caches were found on this machine right now.', 'Scan again', false));
    }

    latestRender = render;
    render(); // cache-first immediate paint

    // Revalidate: scan now if nothing is cached, or silently if it is stale.
    // Skip if a background scan is already running (onCacheUpdated will repaint).
    const haveData = targetsNow().length > 0;
    const stale = !S.lastScan || (Date.now() - S.lastScan) > 60000;
    if (!S.bgScanning && !S.systemLoading && (!haveData || stale)) runScan();
  };
})();
