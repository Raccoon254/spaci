'use strict';
/* System Cleaner screen, Spaci v2. Faithful to design/spaci-v2-reference.html
   (data-screen-label="System Cleaner"), wired to the real system scanner.
   Lists developer & system caches grouped by category, with per-item selection
   toggles and a safe clean action. Every target here is regenerable. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // Per-id selection set, persisted on shared state across re-renders.
  function selSet() {
    if (!S.systemSel || !(S.systemSel instanceof Set)) S.systemSel = new Set();
    return S.systemSel;
  }

  // Default selection: every safe target preselected after a scan.
  function preselect(targets) {
    const sel = selSet();
    sel.clear();
    targets.forEach((t) => { if (t.safe) sel.add(t.id); });
  }

  // Group scanned targets by their category, preserving first-seen order.
  function groupByCategory(targets) {
    const order = [];
    const map = new Map();
    targets.forEach((t) => {
      if (!map.has(t.category)) { map.set(t.category, []); order.push(t.category); }
      map.get(t.category).push(t);
    });
    return order.map((cat) => ({ cat, items: map.get(cat) }));
  }

  SP.screens.system = function (host) {
    // ---- async scan, cached on S.system; (re)render into the same host ----
    // Uses the shared live scan banner instead of a full-screen spinner, so the
    // header + any existing list stay visible while caches are measured.
    async function ensureScan() {
      if (S.system && Array.isArray(S.system.targets)) return;
      S.system = Object.assign({}, S.system, { loading: true, error: null });
      SP.beginScan('system', 'system caches');
      try {
        const res = await api.scanSystem();
        if (res && res.ok) {
          const targets = (res.targets || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
          S.system = { loading: false, error: null, targets };
          preselect(targets);
        } else {
          S.system = { loading: false, error: (res && res.error) || 'Scan failed', targets: S.system && S.system.targets || null };
        }
      } catch (err) {
        S.system = { loading: false, error: (err && err.message) || 'Scan failed', targets: S.system && S.system.targets || null };
      } finally {
        SP.endScan();
      }
      if (S.route === 'system') render();
    }

    // Force a fresh scan (Scan caches button / retry / empty state). Keeps the
    // current list visible with the live banner above it (no blanking).
    async function rescan() {
      S.system = Object.assign({}, S.system, { loading: true, error: null });
      SP.beginScan('system', 'system caches');
      render();
      try {
        const res = await api.scanSystem();
        if (res && res.ok) {
          const targets = (res.targets || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
          S.system = { loading: false, error: null, targets };
          preselect(targets);
        } else {
          S.system = { loading: false, error: (res && res.error) || 'Scan failed', targets: S.system && S.system.targets || null };
        }
      } catch (err) {
        S.system = { loading: false, error: (err && err.message) || 'Scan failed', targets: S.system && S.system.targets || null };
      } finally {
        SP.endScan();
      }
      if (S.route === 'system') render();
    }

    // ---- clean selected targets ----
    async function cleanSelected() {
      const st = S.system;
      if (!st || !st.targets) return;
      const sel = selSet();
      const chosen = st.targets.filter((t) => sel.has(t.id));
      if (!chosen.length || st.cleaning) return;

      // Each existing path becomes a contents-empty job (keeps the dir).
      const jobs = [];
      chosen.forEach((t) => {
        const paths = (t.existingPaths && t.existingPaths.length) ? t.existingPaths : t.paths;
        (paths || []).forEach((p) => jobs.push({ path: p, mode: t.mode || 'contents' }));
      });
      if (!jobs.length) return;

      st.cleaning = true;
      render();
      try {
        const res = await api.clean(jobs, {
          scope: 'system',
          label: chosen.length + ' system ' + (chosen.length === 1 ? 'cache' : 'caches'),
          reversible: true
        });
        st.cleaning = false;
        if (res && res.ok) {
          // Drop cleaned targets from the cached list and the selection.
          const cleanedIds = new Set(chosen.map((t) => t.id));
          st.targets = st.targets.filter((t) => !cleanedIds.has(t.id));
          cleanedIds.forEach((id) => sel.delete(id));
          st.lastFreed = res.totalFreed || 0;
          const freed = res.totalFreed != null ? res.totalFreed : chosen.reduce((a, t) => a + (t.size || 0), 0);
          SP.burst(fmt(freed), 'across ' + chosen.length + ' cache' + (chosen.length === 1 ? '' : 's'));
        } else {
          st.error = (res && res.error) || 'Clean failed';
        }
      } catch (err) {
        st.cleaning = false;
        st.error = (err && err.message) || 'Clean failed';
      }
      render();
    }

    // ---- header (title + scan button), shared by every state ----
    function header() {
      const scanning = S.system && S.system.loading;
      return el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'System Cleaner' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px', text: 'Developer and system caches. Everything here is regenerable, clearing it is safe and reversible.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
          hov: 'background:var(--accent-hover)',
          onclick: () => { if (!scanning) rescan(); }
        }, [scanning ? ring('spin', 17) : ic('scan', 17), scanning ? 'Scanning…' : 'Scan caches'])
      ]);
    }

    // ---- one selectable target row ----
    function row(t) {
      const sel = selSet();
      const on = sel.has(t.id);
      const badgeSafe = t.safe;
      return el('div', {
        class: 'sp-hov',
        style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer;box-shadow:var(--shadow-sm)',
        hov: 'border-color:var(--border-2)',
        onclick: () => { if (on) sel.delete(t.id); else sel.add(t.id); render(); }
      }, [
        el('div', {
          class: 'sp-check' + (on ? ' sp-check-on' : ''),
          style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s'
        }, [ic('check', 14)]),
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

    // ---- category section (header row + its items) ----
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

    // ---- select-all / clear-all toggle in the section heading area ----
    function selectAllRow(targets) {
      const sel = selSet();
      const allOn = targets.length > 0 && targets.every((t) => sel.has(t.id));
      return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:26px 0 0' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: targets.length + (targets.length === 1 ? ' cleanable item' : ' cleanable items') }),
        el('button', {
          style: 'height:34px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel);color:var(--text)',
          onclick: () => { if (allOn) sel.clear(); else targets.forEach((t) => sel.add(t.id)); render(); }
        }, [ic('check-circle', 15), allOn ? 'Clear all' : 'Select all'])
      ]);
    }

    // ---- loading / error / empty placeholders ----
    function loadingState() {
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:18px;color:var(--text-3)' }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'Measuring caches…' }),
        el('div', { style: 'font-size:14px;max-width:360px', text: 'Spaci is sizing your developer and system caches. This only takes a moment.' })
      ]);
    }

    function errorState(msg) {
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:16px;color:var(--text-3)' }, [
        el('spaci-icon', { name: 'spaci-ring', anim: 'breathe', style: 'width:64px;height:64px;color:var(--text-4);display:block' }),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'Could not scan caches' }),
        el('div', { style: 'font-size:13.5px;max-width:380px', text: msg || 'Something went wrong while scanning.' }),
        el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: 'background:var(--accent-hover)',
          onclick: () => rescan()
        }, [ic('scan', 16), 'Try again'])
      ]);
    }

    function emptyState() {
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:16px;color:var(--text-3)' }, [
        el('spaci-icon', { name: 'spaci-ring', anim: 'breathe', style: 'width:64px;height:64px;color:var(--text-4);display:block' }),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'All clean' }),
        el('div', { style: 'font-size:13.5px;max-width:380px', text: 'No reclaimable caches were found on this machine right now.' }),
        el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: 'background:var(--panel-3)',
          onclick: () => rescan()
        }, [ic('scan', 16), 'Scan again'])
      ]);
    }

    // ---- master render: rebuild the screen body into host ----
    // The header always renders. During a scan the shared live banner goes
    // above the list and the previous results (if any) stay visible below it.
    function render() {
      host.innerHTML = '';
      host.appendChild(header());

      const st = S.system;
      const scanning = SP.scanActive('system');
      const banner = SP.scanBanner('system');
      if (banner) host.appendChild(banner);

      // Error with no prior results: show the error placeholder (unless a scan
      // is currently running, in which case the banner already covers it).
      if (st && st.error && !st.targets && !scanning) { host.appendChild(errorState(st.error)); SP.setActionBar(null); return; }

      const targets = (st && st.targets) || [];
      if (!targets.length) {
        // Nothing to show yet. While scanning, the banner above carries the
        // progress; otherwise fall back to the empty state.
        if (!scanning) { host.appendChild(emptyState()); SP.setActionBar(null); }
        return;
      }

      // non-blocking error notice (e.g. partial clean failure) above the list
      if (st && st.error) {
        host.appendChild(el('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:13px 16px;border-radius:12px;background:var(--danger-soft);color:var(--danger-fg);font-size:13px;font-weight:600;margin-bottom:4px'
        }, [ic('warning', 17), st.error]));
      }

      host.appendChild(selectAllRow(targets));
      groupByCategory(targets).forEach((grp) => host.appendChild(group(grp)));
      syncActionBar(targets);
    }

    // ---- floating action bar reflecting the current cache selection ----
    // System caches are regenerable, so this is treated as safe / reversible:
    // accent button, "Clean", and no confirm modal.
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
        onClear: () => { selSet().clear(); SP.go('system'); },
        onClean: () => cleanSelected(),
      });
    }

    // initial paint, then kick off a scan if we have no cached results
    render();
    if (!S.system || !Array.isArray(S.system.targets)) ensureScan();
  };
})();
