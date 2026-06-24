'use strict';
/* Projects list (route `projects`) and Project detail (route `project`),
   Spaci v2. Faithful to design/spaci-v2-reference.html (data-screen-label
   "Projects" and "Project detail"), wired to the real scanner via window.api.

   Cache-first, like system.js: the list paints S.projects (the shared cache
   mirror loaded at boot) instantly, then revalidates with a scan in the
   background (subtle inline strip, no blocking spinner). The scan never
   re-mounts the screen, so the live host is never detached and results always
   paint when the scan finishes. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // Points at the current mount's render so an async scan repaints the live
  // (attached) host, even if it was started by an earlier mount. This is what
  // avoids the detached-host bug: we never call SP.go('projects') (which
  // re-mounts a fresh host) from inside an in-flight scan.
  let latestRender = null;
  function paint() { if (latestRender) latestRender(); }

  // The live scan block updates IN PLACE on each progress tick (no full paint),
  // so typing in the filter while a scan runs never rebuilds the screen / flickers.
  let progRefs = null; // { label, count, bar } DOM nodes of the current scan block
  function projProgressInfo() {
    const pr = S.projectsProgress || {};
    const folders = pr.scanned != null ? pr.scanned : 0;
    const files = pr.files != null ? pr.files : 0;
    const pct = pr.percent != null ? pr.percent : 0;
    const count = folders
      ? folders.toLocaleString() + ' folders · ' + files.toLocaleString() + ' files indexed · ' + pct + '%'
      : 'Indexing your folders…';
    return { count, pct, label: 'Scanning ' + (S.projScanRoot || '~') };
  }
  function liveProgress() {
    if (!progRefs || !progRefs.set) return;
    const info = projProgressInfo();
    progRefs.set({ label: info.label, sub: info.count, percent: info.pct });
  }
  // Home dir for "~/dev"-style scan labels, fetched once (best-effort).
  if (api && api.home && !S._homeDir) { api.home().then((h) => { if (h) S._homeDir = h; }).catch(() => {}); }
  function abbrevRoot(root) {
    if (!root) return '~';
    const home = S._homeDir;
    if (home && root.indexOf(home) === 0) return '~' + (root.slice(home.length) || '');
    return root;
  }

  // ----- type/kind -> brand logo mapping -----
  // Scanner project.type = { id, name, icon }. We pick the closest logo in
  // SPACI_LOGOS for the language mark shown next to the name.
  const TYPE_LOGO = {
    node: 'node', rust: 'rust', go: 'go', flutter: 'flutter',
    android: 'android', gradle: 'gradle', maven: 'maven', java: 'java',
    python: 'python', php: 'php', dotnet: 'dotnet', xcode: 'apple',
  };
  function projectLogo(p) {
    const t = p && p.type ? p.type : {};
    return TYPE_LOGO[t.id] || TYPE_LOGO[t.icon] || t.icon || 'node';
  }

  // Cleanable-item kind -> a content icon for the item tile.
  const KIND_ICON = {
    node: 'node', java: 'java', gradle: 'gradle', box: 'box', react: 'react',
    flash: 'flash', svelte: 'svelte', python: 'python', php: 'php',
    apple: 'apple', file: 'file',
  };
  function itemIcon(it) { return KIND_ICON[it.kind] || 'folder-2'; }

  // ----- helpers -----
  function enrichOf(p) {
    const map = (S.enrich = S.enrich || {});
    return p && map[p.path];
  }
  function selSet() {
    if (!S.projSel || !(S.projSel instanceof Set)) S.projSel = new Set();
    return S.projSel;
  }

  // Single source of truth: the shared cache mirror (loaded at boot from
  // cache.projects, refreshed by foreground rescans here and by background
  // scans via onCacheUpdated/refresh in app.js).
  function projectsNow() { return Array.isArray(S.projects) ? S.projects : []; }

  function sortProjects(list) {
    const by = S.projSort || 'size';
    const out = list.slice();
    if (by === 'name') out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (by === 'recent') out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    else out.sort((a, b) => (b.cleanableSize || 0) - (a.cleanableSize || 0));
    return out;
  }

  // Detach any live progress subscription so re-renders never leak listeners.
  function detach() {
    if (S.projectsUnsub) { try { S.projectsUnsub(); } catch (_) {} S.projectsUnsub = null; }
  }

  // Revalidate the project list with a scan WITHOUT blocking. Keeps the current
  // list visible and shows a lively running strip above it; `root` null => the
  // backend defaults to the home dir. Persists results to S.projects, mirroring
  // the main-process filter (cache.projects = res.projects.filter(p.items.length)).
  //
  // The scanner emits { phase, scanned, found, currentPath }: no total/percent,
  // so this is an INDETERMINATE bar with live counts. Progress lands on
  // S.projectsProgress and repaints via paint() so the strip updates live.
  async function runScan(root) {
    if (S.projectsLoading) return; // a scan is already in flight
    detach();
    S.projectsLoading = true; S.projectsError = null;
    S.projectsProgress = null;
    S.projScanRoot = abbrevRoot(root);
    // Guard against double-subscribe: detach() above already cleared any prior sub.
    // Update the scan block in place; do NOT paint() per tick (that rebuilt the
    // whole screen and flickered the filter input while a scan was running).
    S.projectsUnsub = api.onScanProgress ? api.onScanProgress((p) => {
      if (!p || p.phase === 'done') return;
      S.projectsProgress = p;
      liveProgress();
    }) : null;
    paint();
    try {
      const res = await api.scanProjects(root);
      if (res && res.ok !== false) {
        const projects = (res.projects || []).filter((p) => p.items && p.items.length);
        S.projects = projects;
        S.lastScan = Date.now();
      } else {
        S.projectsError = (res && res.error) || 'Scan failed';
      }
    } catch (err) {
      S.projectsError = (err && err.message) || 'Scan failed';
    } finally {
      detach();
      S.projectsLoading = false;
      S.projectsProgress = null;
      paint();
    }
  }

  // =====================================================================
  //  PROJECTS LIST
  // =====================================================================
  SP.screens.projects = function (host) {
    // The shared cache mirror is the source of truth. Render its rows
    // immediately; a revalidation paints into the live host via paint().
    function render() {
      host.innerHTML = '';
      progRefs = null; // rebuilt by scanBlock() below while scanning
      renderHeader();

      const loading = S.projectsLoading || S.bgScanning;
      // Design: the centered scan block sits above the filter + list while a scan
      // runs (faithful to the reference). The cached list stays visible below it.
      if (loading) host.appendChild(scanBlock());

      renderSearchAndSort();

      const all = projectsNow();
      if (all.length) {
        if (S.projectsError) host.appendChild(errorRow(S.projectsError));
        renderRows(all);
        syncProjectsActionBar();
        return;
      }

      // Nothing cached yet.
      SP.setActionBar(null);
      if (loading) return; // the scan block above already conveys progress
      if (S.projectsError) { host.appendChild(bigState('breathe', 'Could not scan projects', S.projectsError, 'Try again', true)); return; }
      host.appendChild(emptyState());
    }

    function renderHeader() {
      const scanning = S.projectsLoading || S.bgScanning;
      const chooseBtn = el('button', {
        style: 'height:44px;padding:0 18px;border-radius:11px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
        hov: 'background:var(--panel-2)',
        onclick: async () => {
          if (scanning) return;
          try {
            const folder = await api.pickFolder();
            if (folder) runScan(folder);
          } catch (_) { /* ignore */ }
        },
      }, [ic('folder-open', 17), 'Choose folder']);

      const scanBtn = el('button', {
        style: 'height:44px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
        hov: 'background:var(--accent-hover)',
        onclick: () => { if (!scanning) runScan(); },
      }, [scanning ? ring('elastic', 17) : ic('scanner', 17), scanning ? 'Scanning…' : 'Scan']);

      host.appendChild(el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'Projects' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:540px', text: 'Regenerable build artifacts: node_modules, target, .next, __pycache__ and more.' }),
        ]),
        el('div', { style: 'display:flex;gap:10px;flex:none' }, [chooseBtn, scanBtn]),
      ]));
    }

    function renderSearchAndSort() {
      const searchInput = el('input', {
        placeholder: 'Filter projects…',
        value: S.projQuery || '',
        style: 'background:none;border:none;color:var(--text);font-size:14px;width:100%;font-family:inherit',
        oninput: (e) => { S.projQuery = e.target.value; applyFilter(); },
      });
      const searchBox = el('label', {
        style: 'display:flex;align-items:center;gap:9px;padding:0 14px;height:44px;background:var(--panel);border:1px solid var(--border);border-radius:12px;flex:1;color:var(--text-3)',
      }, [ic('search', 17), searchInput]);

      const SORTS = [
        { key: 'size', label: 'Largest', icon: 'chart' },
        { key: 'name', label: 'Name', icon: 'document-text' },
        { key: 'recent', label: 'Recent', icon: 'clock' },
      ];
      const active = S.projSort || 'size';
      const chips = SORTS.map((c) => {
        const on = active === c.key;
        return el('div', {
          class: 'sp-hov' + (on ? ' sp-chip-on' : ''),
          style: 'display:flex;align-items:center;gap:7px;padding:0 15px;height:40px;border-radius:99px;border:1px solid ' + (on ? 'transparent' : 'var(--border)') + ';background:' + (on ? 'var(--accent)' : 'var(--panel)') + ';font-size:13px;font-weight:600;color:' + (on ? 'var(--on-accent)' : 'var(--text-2)') + ';cursor:pointer',
          hov: on ? '' : 'border-color:var(--border-2);color:var(--text)',
          // In-place repaint (paint), NOT SP.go('projects'): avoids a full re-mount.
          onclick: () => { S.projSort = c.key; paint(); },
        }, [ic(c.icon, 15), c.label]);
      });

      host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:18px' }, [searchBox, ...chips]));
    }

    // Live progress text + scan root label. The scanner gives no total/percent,
    // so we show running counts ("N folders scanned · M found") and the folder.
    function progressInfo() {
      const pr = S.projectsProgress || {};
      const scanned = pr.scanned != null ? pr.scanned : 0;
      const found = pr.found != null ? pr.found : 0;
      const count = scanned
        ? scanned.toLocaleString() + ' folders scanned · ' + found.toLocaleString() + ' found'
        : 'Indexing your folders…';
      const root = S.projScanRoot || '~';
      return { count, current: pr.currentPath || '', label: 'Scanning ' + root };
    }

    // "running" badge pill (design: sp-badge-accent).
    function runningBadge() {
      return el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:3px 10px;border-radius:7px;font-size:11px;font-weight:700', text: 'running' });
    }

    // Indeterminate progress bar: a sliding accent fill (no percent available).
    function indetBar(height) {
      const h = height || 8;
      return el('div', { style: 'height:' + h + 'px;border-radius:99px;background:var(--track);overflow:hidden' }, [
        el('div', { style: 'height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent-fg));animation:sp-indet 1.25s ease-in-out infinite' })
      ]);
    }

    // Lively inline running strip above existing rows (never blocks). Animated
    // ring + "running" badge + live folder/found counts + indeterminate bar.
    function scanStrip() {
      const info = progressInfo();
      return el('div', { style: 'display:flex;flex-direction:column;gap:9px;padding:13px 16px;border-radius:13px;background:var(--panel);border:1px solid var(--border);margin-bottom:14px' }, [
        el('div', { style: 'display:flex;align-items:center;gap:11px' }, [
          el('div', { style: 'color:var(--accent-fg);flex:none;display:flex' }, [ring('chase', 22)]),
          el('div', { style: 'font-size:13.5px;font-weight:700;letter-spacing:-.2px;color:var(--text)', text: info.label }),
          runningBadge(),
          el('div', { style: 'flex:1' }),
          el('div', { style: 'font-size:12.5px;font-weight:600;color:var(--text-3);font-variant-numeric:tabular-nums', text: info.count })
        ]),
        indetBar(6)
      ]);
    }

    // Full-screen first-scan running block (design lines ~308-316): big animated
    // ring + title + "running" badge + live counts + indeterminate bar.
    function loadingState() {
      const info = progressInfo();
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:40px 24px 32px;min-height:42vh' }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring('spiral', 56)]),
        el('div', {}, [
          el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;display:flex;align-items:center;gap:10px;justify-content:center' }, [
            el('span', { text: info.label }),
            runningBadge()
          ]),
          el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px;font-variant-numeric:tabular-nums', text: info.count })
        ]),
        el('div', { style: 'width:100%;max-width:420px' }, [indetBar(8)])
      ]);
    }

    // Centered running block, faithful to the design (chase ring + "Scanning
    // <root>" + running badge + "N folders · M files indexed · P%" + a
    // determinate shimmer bar). Stores progRefs so progress updates it in place.
    function scanBlock() {
      const info = projProgressInfo();
      // Shared scan card (spiral ring + running badge + bar), identical across screens.
      progRefs = SP.scanCard({ label: info.label, sub: info.count, percent: info.pct > 0 ? info.pct : null });
      return progRefs.node;
    }

    function errorRow(msg) {
      return el('div', {
        style: 'display:flex;align-items:center;gap:10px;padding:13px 16px;border-radius:12px;background:var(--danger-soft);color:var(--danger-fg);font-size:13px;font-weight:600;margin:0 0 14px'
      }, [ic('warning', 17), msg]);
    }

    function renderRows(all) {
      const listWrap = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' });
      host.appendChild(listWrap);

      // No-match placeholder, toggled by applyFilter without a re-render.
      const noMatch = el('div', {
        style: 'display:none;padding:40px 16px;text-align:center;color:var(--text-3);font-size:14px',
        text: 'No projects match your filter.',
      });

      const sorted = sortProjects(all);
      const rows = sorted.map((p) => buildRow(p));
      rows.forEach((r) => listWrap.appendChild(r.node));
      listWrap.appendChild(noMatch);

      // Filter in place (no flicker): hide/show existing rows by name/path.
      function doFilter() {
        const q = (S.projQuery || '').trim().toLowerCase();
        let visible = 0;
        rows.forEach((r) => {
          const match = !q || r.name.toLowerCase().includes(q) || (r.path || '').toLowerCase().includes(q);
          r.node.style.display = match ? 'flex' : 'none';
          if (match) visible++;
        });
        noMatch.style.display = visible ? 'none' : 'block';
      }
      doFilter();
      // expose so the search input (built before rows exist) can reach it
      render._applyFilter = doFilter;
    }

    // applyFilter lives inside render's closure; this thin wrapper lets the
    // search input reach the latest one for this mount.
    function applyFilter() { if (render._applyFilter) render._applyFilter(); }

    function buildRow(p) {
      const sel = selSet();
      const en = enrichOf(p);
      const logo = projectLogo(p);
      const desc = rowDesc(p);

      // selection check circle
      const check = el('div', {
        class: sel.has(p.path) ? 'sp-check-on' : '',
        style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s',
      }, [ic('tick', 14)]);
      check.addEventListener('click', (e) => {
        e.stopPropagation(); // don't open the detail
        if (sel.has(p.path)) sel.delete(p.path);
        else sel.add(p.path);
        paint(); // repaint the live host (selection + action bar), no re-mount
      });

      const folderTile = el('div', {
        style: 'width:44px;height:44px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2);position:relative',
      }, [ic('folder-2', 24)]);

      const titleLine = el('div', { style: 'font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:9px' }, [
        el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: p.name }),
        ic(logo, 15, { kind: 'logo', color: 'var(--text-3)' }),
        (p.isGit || (en && en.git)) ? ic('github', 15, { color: 'var(--text-3)' }) : null,
      ]);

      const node = el('div', {
        class: 'sp-hov',
        style: 'display:flex;align-items:center;gap:14px;padding:15px 17px;border-radius:15px;background:var(--panel);border:1px solid var(--border);cursor:pointer;box-shadow:var(--shadow-sm)',
        hov: 'border-color:var(--border-2);transform:translateX(2px)',
        onclick: () => openDetail(p),
      }, [
        check,
        folderTile,
        el('div', { style: 'flex:1;min-width:0' }, [
          titleLine,
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: desc }),
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(p.cleanableSize || 0) }),
        ic('chevron-right', 18, { color: 'var(--text-4)' }),
      ]);

      return { node, name: p.name || '', path: p.path || '' };
    }

    // Floating action bar reflects the current project selection.
    function syncProjectsActionBar() {
      const sel = selSet();
      const chosen = projectsNow().filter((p) => sel.has(p.path));
      const n = chosen.length;
      if (!n) { SP.setActionBar(null); return; }
      const bytes = chosen.reduce((s, p) => s + (p.cleanableSize || 0), 0);
      SP.setActionBar({
        count: n + ' project' + (n > 1 ? 's' : ''),
        size: fmt(bytes),
        action: 'Clean ' + fmt(bytes),
        danger: false,
        onClear: () => { selSet().clear(); paint(); },
        onClean: () => cleanSelectedProjects(chosen),
      });
    }

    // Clean every cleanable item across the selected projects. Reuses the same
    // job shape and api.clean call the detail screen builds (safe / reversible,
    // so no confirm modal). Mirrors the detail's post-clean bookkeeping.
    async function cleanSelectedProjects(chosen) {
      if (S.cleaning || !chosen.length) return;
      const jobs = [];
      chosen.forEach((p) => (p.items || []).forEach((it) => jobs.push({ path: it.path, isDir: it.isDir, size: it.size })));
      if (!jobs.length) return;
      S.cleaning = true;
      try {
        const res = await api.clean(jobs, { scope: 'projects', label: chosen.length + ' project' + (chosen.length === 1 ? '' : 's'), reversible: true });
        if (res && res.ok !== false) {
          const freed = res.totalFreed != null ? res.totalFreed : jobs.reduce((s, j) => s + (j.size || 0), 0);
          // Drop cleaned items from each selected project and recompute sizes.
          chosen.forEach((p) => {
            p.items = [];
            p.cleanableSize = 0;
            delete (S.itemSel || {})[p.path];
          });
          selSet().clear();
          SP.burst(fmt(freed), 'across ' + chosen.length + ' project' + (chosen.length === 1 ? '' : 's'));
        }
      } catch (_) { /* ignore */ }
      S.cleaning = false;
      paint();
    }

    function bigState(anim, title, body, btnLabel, primary) {
      return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:42vh;gap:16px;color:var(--text-3)' }, [
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

    function emptyState() {
      return el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:42vh;gap:16px;color:var(--text-3)',
      }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring('breathe', 60)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'No projects found' }),
        el('div', { style: 'font-size:14px;max-width:360px', text: 'Nothing with regenerable build artifacts turned up here. Try Scan again or choose a different folder.' }),
        el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: 'background:var(--accent-hover)',
          onclick: () => runScan(),
        }, [ic('scanner', 16), 'Scan again']),
      ]);
    }

    latestRender = render;
    render(); // cache-first immediate paint

    // Revalidate: scan now if nothing is cached, or silently if it is stale.
    // Skip if a background scan is already running (onCacheUpdated -> refresh
    // will repaint). Do NOT auto-scan on every visit when fresh.
    const haveData = projectsNow().length > 0;
    const stale = !S.lastScan || (Date.now() - S.lastScan) > 60000;
    if (!S.bgScanning && !S.projectsLoading && (!haveData || stale)) runScan();
  };

  function rowDesc(p) {
    const items = p.items || [];
    const names = items.map((i) => i.name).slice(0, 3).join(', ');
    const more = items.length > 3 ? '…' : '';
    const head = items.length
      ? items.length + ' cleanable item' + (items.length === 1 ? '' : 's') + (names ? ' · ' + names + more : '')
      : 'No cleanable items';
    return head + (p.path ? '  ·  ' + p.path : '');
  }

  function openDetail(p) {
    S.currentProject = p;
    // kick off enrichment (git + total size) so the detail shows fresh data
    enrich(p);
    SP.go('project'); // detail navigation still re-mounts via the router
  }

  async function enrich(p) {
    if (!p || !p.path) return;
    try {
      const r = await api.enrichProject(p.path);
      if (r) {
        S.enrich = S.enrich || {};
        S.enrich[p.path] = r;
        if (S.route === 'project' && S.currentProject && S.currentProject.path === p.path) SP.go('project');
      }
    } catch (_) { /* ignore */ }
  }

  // =====================================================================
  //  PROJECT DETAIL
  // =====================================================================
  SP.screens.project = function (host) {
    const p = S.currentProject;
    if (!p) { SP.go('projects'); return; }
    const en = enrichOf(p) || {};
    const git = en.git || p.git || null;
    const items = (p.items || []).slice();
    const sel = (S.itemSel = S.itemSel || {});
    const selKey = p.path;
    const chosen = (sel[selKey] = sel[selKey] || new Set(items.map((i) => i.path))); // default: all selected

    // ----- back button -----
    host.appendChild(el('button', {
      class: 'sp-hov',
      style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
      hov: 'background:var(--panel);color:var(--text)',
      onclick: () => SP.go('projects'),
    }, [ic('arrow-left', 16), 'All projects']));

    // ----- header -----
    const branch = git && git.branch ? git.branch : null;
    const logo = projectLogo(p);
    const titleEls = [
      p.name,
      ic(logo, 19, { kind: 'logo', color: 'var(--text-3)' }),
    ];
    if (branch) {
      titleEls.push(el('span', {
        style: 'display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;font-size:11.5px;font-weight:700;background:var(--accent-soft-2);color:var(--accent-fg)',
      }, [ic('branch', 13), branch]));
    }

    const revealBtn = el('button', {
      style: 'height:40px;padding:0 15px;border-radius:10px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
      hov: 'background:var(--panel-2)',
      onclick: () => { try { api.reveal(p.path); } catch (_) {} },
    }, [ic('external-link', 15), 'Reveal']);
    const openBtn = el('button', {
      style: 'height:40px;padding:0 15px;border-radius:10px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
      hov: 'background:var(--panel-2)',
      onclick: () => { try { api.openPath(p.path); } catch (_) {} },
    }, [ic('folder-open', 15), 'Open']);

    host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:22px' }, [
      el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;color:var(--text-2);flex:none;box-shadow:var(--shadow-sm)' }, [ic('folder-2', 31)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px' }, titleEls),
        el('div', { class: 'mono', style: 'color:var(--text-3);font-size:12.5px;margin-top:5px', text: p.path }),
      ]),
      el('div', { style: 'display:flex;gap:10px;flex:none' }, [revealBtn, openBtn]),
    ]));

    // ----- stat strip -----
    const totalSize = en.totalSize != null ? en.totalSize : (p.totalSize || 0);
    const stats = [
      { icon: 'broom', label: 'Reclaimable', value: fmt(p.cleanableSize || 0), color: 'var(--accent-fg)' },
      { icon: 'hard-drive', label: 'On disk', value: totalSize ? fmt(totalSize) : '…', color: 'var(--text)' },
      { icon: 'folder-2', label: 'Items', value: String(items.length), color: 'var(--text)' },
      { icon: 'clock', label: 'Modified', value: p.mtime ? new Date(p.mtime).toLocaleDateString() : 'n/a', color: 'var(--text)' },
    ];
    host.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 32px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)' },
      stats.map((s) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text-2)' }, [
        ic(s.icon, 16, { color: 'var(--text-3)' }), s.label,
        el('b', { style: 'color:' + s.color + ';font-weight:700;letter-spacing:-.2px', text: s.value }),
      ]))));

    // ----- version control card -----
    const gitFields = [];
    if (git) {
      gitFields.push({ icon: 'branch', k: 'Branch', v: git.branch || 'detached', color: 'var(--text)' });
      gitFields.push({ icon: 'warning', k: 'Uncommitted', v: (git.dirty || 0) + ' file' + (git.dirty === 1 ? '' : 's'), color: git.dirty ? 'var(--danger-fg)' : 'var(--success-fg)' });
      gitFields.push({ icon: 'arrow-right', k: 'Ahead', v: String(git.ahead || 0), color: 'var(--text)' });
    } else {
      gitFields.push({ icon: 'info', k: 'Status', v: p.isGit ? 'Reading git…' : 'Not a git repo', color: 'var(--text-3)' });
    }
    host.appendChild(el('div', { style: 'background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow-sm);margin-top:16px' }, [
      el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600;margin-bottom:14px', text: 'Version control' }),
      el('div', { style: 'display:flex;gap:34px;flex-wrap:wrap' }, gitFields.map((g) => el('div', {}, [
        el('div', { style: 'color:var(--text-3);font-size:12px;display:flex;gap:6px;align-items:center;margin-bottom:5px' }, [ic(g.icon, 15), g.k]),
        el('div', { style: 'font-weight:700;font-size:15px;color:' + g.color, text: g.v }),
      ]))),
    ]));

    // ----- cleanable items header + select all -----
    const selectAllBtn = el('button', {
      class: 'sp-hov',
      style: 'height:34px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
      hov: 'background:var(--panel);color:var(--text)',
    }, []);
    function renderSelectAllLabel() {
      const allOn = items.length && chosen.size === items.length;
      selectAllBtn.innerHTML = '';
      selectAllBtn.appendChild(ic('check-circle', 15));
      selectAllBtn.appendChild(document.createTextNode(allOn ? 'Deselect all' : 'Select all'));
    }
    host.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:26px 0 12px' }, [
      el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: 'Cleanable items (' + items.length + ')' }),
      selectAllBtn,
    ]));

    // ----- item rows -----
    const itemsWrap = el('div', { style: 'display:flex;flex-direction:column;gap:9px' });
    host.appendChild(itemsWrap);

    const itemRows = items.map((it) => buildItemRow(it, chosen, updateAfterToggle));
    if (!items.length) {
      itemsWrap.appendChild(el('div', { style: 'padding:24px 16px;text-align:center;color:var(--text-3);font-size:14px', text: 'No cleanable items in this project.' }));
    } else {
      itemRows.forEach((r) => itemsWrap.appendChild(r.node));
    }

    selectAllBtn.addEventListener('click', () => {
      const allOn = chosen.size === items.length;
      chosen.clear();
      if (!allOn) items.forEach((it) => chosen.add(it.path));
      itemRows.forEach((r) => r.sync());
      updateAfterToggle();
    });

    // The in-page clean footer was removed; the shared floating action bar
    // (driven by syncDetailActionBar below) is the only clean trigger now.
    function selectedItems() { return items.filter((it) => chosen.has(it.path)); }

    function updateAfterToggle() { renderSelectAllLabel(); syncDetailActionBar(); }

    // Floating action bar drives cleaning for this project. It is the only
    // clean trigger. Safe / reversible, so no confirm modal ("safe by design").
    function syncDetailActionBar() {
      const chosenItems = selectedItems();
      const n = chosenItems.length;
      if (!n) { SP.setActionBar(null); return; }
      const freed = chosenItems.reduce((s, i) => s + (i.size || 0), 0);
      SP.setActionBar({
        count: n + ' item' + (n > 1 ? 's' : ''),
        size: fmt(freed),
        action: 'Clean ' + fmt(freed),
        danger: false,
        onClear: () => { chosen.clear(); itemRows.forEach((r) => r.sync()); updateAfterToggle(); },
        onClean: () => doClean(),
      });
    }

    async function doClean() {
      if (S.cleaning) return;
      const chosenItems = selectedItems();
      if (!chosenItems.length) return;
      S.cleaning = true;
      try {
        const jobs = chosenItems.map((it) => ({ path: it.path, isDir: it.isDir, size: it.size }));
        const res = await api.clean(jobs, { scope: 'projects', label: p.name, reversible: true });
        if (res && res.ok !== false) {
          const freed = res.totalFreed != null ? res.totalFreed : chosenItems.reduce((s, i) => s + (i.size || 0), 0);
          // drop cleaned items from the project and recompute
          const cleaned = new Set(chosenItems.map((i) => i.path));
          p.items = (p.items || []).filter((i) => !cleaned.has(i.path));
          p.cleanableSize = (p.items || []).reduce((s, i) => s + (i.size || 0), 0);
          delete (S.itemSel || {})[p.path];
          // refresh the cached list entry too
          if (Array.isArray(S.projects)) {
            const idx = S.projects.findIndex((x) => x.path === p.path);
            if (idx >= 0) S.projects[idx] = p;
          }
          SP.burst(fmt(freed), 'from ' + p.name);
        }
      } catch (_) { /* ignore */ }
      S.cleaning = false;
      if (S.route === 'project') SP.go('project');
    }

    renderSelectAllLabel();
    syncDetailActionBar();
  };

  function buildItemRow(it, chosen, onToggle) {
    const badgeSafe = it.safe;
    const check = el('div', {
      class: chosen.has(it.path) ? 'sp-check-on' : '',
      style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s',
    }, [ic('tick', 14)]);

    const node = el('div', {
      class: chosen.has(it.path) ? 'sp-row-sel' : '',
      style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer',
    }, [
      check,
      el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(itemIcon(it), 22)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px' }, [
          el('span', { text: it.name }),
          el('span', {
            class: badgeSafe ? 'sp-badge-safe' : 'sp-badge-warn',
            style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
            text: badgeSafe ? 'Safe' : 'Caution',
          }),
        ]),
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: it.note || it.path }),
      ]),
      el('div', { style: 'font-weight:700;font-size:14.5px;flex:none', text: fmt(it.size || 0) }),
    ]);

    function sync() {
      check.className = chosen.has(it.path) ? 'sp-check-on' : '';
      node.className = chosen.has(it.path) ? 'sp-row-sel' : '';
    }
    node.addEventListener('click', () => {
      if (chosen.has(it.path)) chosen.delete(it.path);
      else chosen.add(it.path);
      sync();
      if (onToggle) onToggle();
    });

    return { node, sync };
  }
})();
