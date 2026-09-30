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
  const { el, ic, tic, ring, fmt } = SP;
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
    docker: 'docker',
  };

  // A project earns a row when it has artifacts on disk OR storage held inside
  // Docker. Mirrors keepProject() in the main process.
  function hasReclaimable(p) {
    return Boolean((p.items && p.items.length) || (p.docker && p.docker.usage));
  }
  function dockerBytes(p) {
    return (p.docker && p.docker.usage && p.docker.usage.totalBytes) || 0;
  }
  // Scanner project.type id -> the matching Catppuccin tech id, so a project
  // the engine has not analysed yet still gets a mark in the same style.
  const TYPE_TECH = {
    node: 'node', rust: 'rust', go: 'go', flutter: 'flutter', android: 'android',
    gradle: 'gradle', maven: 'maven', python: 'python', php: 'php',
    dotnet: 'dotnet', xcode: 'xcode', docker: 'docker',
  };

  // The project's mark: its primary tech (from the enrich step, else the
  // lightweight one the scan attaches), then the scanner type, then the brand
  // logo, then the generic folder.
  function projectMark(p, size) {
    const pr = primaryOf(p);
    if (pr) return tic(techId(pr.id), size, { label: pr.name || pr.id });
    const t = p && p.type ? p.type : {};
    const tech = TYPE_TECH[t.id];
    if (tech) return tic(tech, size, { label: t.name || tech });
    const logo = TYPE_LOGO[t.id] || TYPE_LOGO[t.icon] || ((window.SPACI_LOGOS || {})[t.icon] ? t.icon : null);
    if (logo) return ic(logo, size, { kind: 'logo', color: 'var(--text-2)' });
    return ic('folder-2', size);
  }

  // ----- tech stack data (Spaci 2.3 enrich contract) -----
  // Everything below reads data that came off disk, so each field is checked
  // before use and older cached results without these fields render cleanly.
  const HEX_RE = /^#[0-9a-f]{3,8}$/i;
  function techId(id) {
    const T = window.SpaciTechIcon;
    return T ? T.cleanId(id) : (typeof id === 'string' ? id : '');
  }
  function langColor(l) {
    if (l.id === 'other') return 'var(--track-bright)';
    return typeof l.color === 'string' && HEX_RE.test(l.color) ? l.color : 'var(--text-4)';
  }
  function primaryOf(p) {
    const en = enrichOf(p);
    const pr = (en && en.primary) || (p && p.primary) || null;
    return pr && typeof pr === 'object' && techId(pr.id) ? pr : null;
  }
  // null = not analysed yet; [] = analysed, no source code found.
  function languagesOf(p) {
    const en = enrichOf(p);
    const raw = en && Array.isArray(en.languages) ? en.languages : (p && Array.isArray(p.languages) ? p.languages : null);
    if (!raw) return null;
    return raw.filter((l) => l && typeof l === 'object' && Number(l.percent) > 0 && (l.id === 'other' || techId(l.id)))
      .map((l) => ({ id: l.id === 'other' ? 'other' : techId(l.id), name: String(l.name || l.id), percent: Number(l.percent), bytes: Number(l.bytes) || 0, color: langColor(l) }));
  }
  // 72.4 -> "72.4%", 8 -> "8%", 0.04 -> "<0.1%"; `whole` rounds for tight spots.
  function pctText(n, whole) {
    if (whole) return n < 1 ? '<1%' : Math.round(n) + '%';
    if (n < 0.1) return '<0.1%';
    return Math.round(n * 10) / 10 + '%';
  }
  function langSummary(langs, whole) {
    return langs.map((l) => l.name + ' ' + pctText(l.percent, whole)).join(', ');
  }
  // A single-line proportional bar. Segments grow by their share, so the 2px
  // gaps never push the total past the track.
  function langBar(langs, height) {
    return el('div', { style: 'display:flex;gap:2px;height:' + height + 'px;border-radius:99px;overflow:hidden;background:var(--track)' },
      langs.map((l) => el('span', {
        title: l.name + ' ' + pctText(l.percent) + (l.bytes ? ' · ' + fmt(l.bytes) : ''),
        style: 'display:block;height:100%;min-width:2px;flex:' + l.percent + ' 1 0;background:' + l.color,
      })));
  }

  // Enrichment runs for the detail view; the list keeps an index of its rows so
  // a result that lands later updates that one row in place.
  const rowIndex = new Map(); // path -> { update }
  if (!S.enrichPending) S.enrichPending = new Set();
  if (!S.enrichAsked) S.enrichAsked = {};
  function onEnriched(path) {
    if (S.route === 'project' && S.currentProject && S.currentProject.path === path) SP.go('project');
    else if (S.route === 'projects') { const r = rowIndex.get(path); if (r) r.update(); }
  }
  // The main process pushes a fresh result after refreshing a cached one.
  if (api && api.onEnrichUpdated) {
    api.onEnrichUpdated((u) => {
      if (!u || typeof u.path !== 'string') return;
      const map = (S.enrich = S.enrich || {});
      const prev = map[u.path];
      if (prev && prev.at && u.at && prev.at === u.at) return;
      const next = Object.assign({}, prev, u);
      delete next.path;
      map[u.path] = next;
      onEnriched(u.path);
    });
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
        const projects = (res.projects || []).filter(hasReclaimable);
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

      const techRow = techFilter(projectsNow());
      host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:' + (techRow ? 12 : 18) + 'px' }, [searchBox, ...chips]));
      if (techRow) host.appendChild(techRow);
    }

    // ----- filter by primary tech -----
    // One pill per primary tech across the list ("Flutter 4"), most common first.
    // Only shown once there are at least two to choose between. Selecting a pill
    // filters in place, the same way the search box does.
    const TECH_LIMIT = 7;
    function techCounts(all) {
      const m = new Map();
      all.forEach((p) => {
        const pr = primaryOf(p);
        if (!pr) return;
        const id = techId(pr.id);
        const e = m.get(id) || { id, name: String(pr.name || id), n: 0 };
        e.n++;
        m.set(id, e);
      });
      return Array.from(m.values()).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    }

    function techFilter(all) {
      const counts = techCounts(all);
      if (S.projTech && !counts.some((c) => c.id === S.projTech)) S.projTech = null;
      if (counts.length < 2) { S.projTech = null; return null; }

      const wrap = el('div', { role: 'group', 'aria-label': 'Filter by technology', style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:18px' });
      const pills = [];
      const pill = (id, name, n) => {
        const on = (S.projTech || null) === id;
        const b = el('button', {
          type: 'button',
          class: 'sp-tchip sp-focus' + (on ? ' sp-tchip-on' : ''),
          'aria-pressed': String(on),
          title: id ? 'Show only ' + name + ' projects' : 'Show every project',
          style: 'height:32px;padding:0 12px 0 ' + (id ? 9 : 12) + 'px;border-radius:99px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;cursor:pointer;flex:none',
          onclick: () => {
            S.projTech = id && S.projTech !== id ? id : null;
            pills.forEach((x) => {
              const sel = (S.projTech || null) === x.id;
              x.node.classList.toggle('sp-tchip-on', sel);
              x.node.setAttribute('aria-pressed', String(sel));
            });
            applyFilter();
          },
        }, [
          id ? tic(id, 16, { decorative: true }) : null,
          el('span', { style: 'max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: name }),
          el('span', { style: 'color:var(--text-3);font-variant-numeric:tabular-nums', text: String(n) }),
        ]);
        pills.push({ id, node: b });
        return b;
      };

      function fill() {
        wrap.textContent = '';
        pills.length = 0;
        wrap.appendChild(pill(null, 'All', all.length));
        // Never fold away a single pill: "1 more" costs as much room as the pill.
        const limit = counts.length <= TECH_LIMIT + 1 ? counts.length : TECH_LIMIT;
        let shown = S.projTechMore ? counts : counts.slice(0, limit);
        // An active filter that sits past the fold stays visible.
        if (S.projTech && !shown.some((c) => c.id === S.projTech)) shown = shown.concat(counts.filter((c) => c.id === S.projTech));
        shown.forEach((c) => wrap.appendChild(pill(c.id, c.name, c.n)));
        const hidden = counts.length - shown.length;
        if (hidden > 0 || (S.projTechMore && counts.length > limit)) {
          wrap.appendChild(el('button', {
            type: 'button',
            class: 'sp-hov sp-focus',
            'aria-expanded': String(!!S.projTechMore),
            style: 'height:32px;padding:0 10px 0 12px;border-radius:99px;border:none;background:transparent;color:var(--text-3);font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;flex:none',
            hov: 'color:var(--text)',
            onclick: () => { S.projTechMore = !S.projTechMore; fill(); },
          }, [S.projTechMore ? 'Fewer' : hidden + ' more', ic(S.projTechMore ? 'chevron-up' : 'chevron-down', 14)]));
        }
      }
      fill();
      return wrap;
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
      rowIndex.clear();
      const rows = sorted.map((p) => buildRow(p));
      rows.forEach((r) => listWrap.appendChild(r.node));
      listWrap.appendChild(noMatch);

      // Filter in place (no flicker): hide/show existing rows by name/path.
      function doFilter() {
        const q = (S.projQuery || '').trim().toLowerCase();
        const tech = S.projTech || null;
        let visible = 0;
        rows.forEach((r) => {
          const pr = tech ? primaryOf(r.p) : null;
          const match = (!q || r.name.toLowerCase().includes(q) || (r.path || '').toLowerCase().includes(q))
            && (!tech || (pr && techId(pr.id) === tech));
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
      }, [projectMark(p, 24)]);

      // Fixed-width language column: reserved even while empty, so a result
      // landing later never shifts the row.
      const langSlot = el('div', { style: 'width:120px;flex:none;margin-right:6px' });
      fillLangStrip(langSlot, languagesOf(p));

      const titleLine = el('div', { style: 'font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:9px' }, [
        el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: p.name }),
        (p.isGit || (en && en.git)) ? ic('github', 15, { color: 'var(--text-3)' }) : null,
        // Docker mark: dimmed when the project merely declares Docker, accented
        // when the engine is actually holding storage for it.
        p.docker ? ic('docker', 15, { kind: 'logo', color: dockerBytes(p) ? 'var(--accent-fg)' : 'var(--text-4)' }) : null,
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
        langSlot,
        el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none;min-width:64px;text-align:right;font-variant-numeric:tabular-nums', text: fmt(p.cleanableSize || 0) }),
        ic('chevron-right', 18, { color: 'var(--text-4)' }),
      ]);

      if (p.path) {
        rowIndex.set(p.path, {
          update() {
            folderTile.replaceChildren(projectMark(p, 24));
            fillLangStrip(langSlot, languagesOf(p));
          },
        });
      }
      return { node, p, name: p.name || '', path: p.path || '' };
    }

    // Floating action bar reflects the current project selection.
    function syncProjectsActionBar() {
      const sel = selSet();
      const chosen = projectsNow().filter((p) => sel.has(p.path));
      const n = chosen.length;
      if (!n) { SP.setActionBar(null); return; }
      // Bulk clean only ever takes items the scan verified as safe. The rest
      // are cleaned one at a time from the project detail view.
      const bytes = chosen.reduce((s, p) => s + safeItems(p).reduce((a, it) => a + (it.size || 0), 0), 0);
      if (!bytes && !chosen.some((p) => safeItems(p).length)) {
        SP.setActionBar({ count: n + ' project' + (n > 1 ? 's' : ''), size: 'nothing safe to bulk clean', action: 'Review ' + (n > 1 ? 'first project' : 'project'), danger: false, onClear: () => { selSet().clear(); paint(); }, onClean: () => openDetail(chosen[0]) });
        return;
      }
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
      if (S.projCleaning || !chosen.length) return;
      const jobs = [];
      chosen.forEach((p) => safeItems(p).forEach((it) => jobs.push({ path: it.path, isDir: it.isDir, size: it.size })));
      if (!jobs.length) return;
      const sent = new Set(jobs.map((j) => j.path));
      S.projCleaning = true;
      try {
        const res = await api.clean(jobs, { scope: 'projects', label: chosen.length + ' project' + (chosen.length === 1 ? '' : 's'), reversible: true });
        const sum = SP.reportClean(res, {
          fallbackFreed: jobs.reduce((s, j) => s + (j.size || 0), 0),
          burstLabel: 'across ' + chosen.length + ' project' + (chosen.length === 1 ? '' : 's')
        });
        if (sum.ok) {
          // Drop cleaned items from each selected project and recompute sizes.
          // Anything refused or reported as failed stays listed and selected.
          chosen.forEach((p) => {
            p.items = (p.items || []).filter((it) => !sent.has(it.path) || sum.blocked(it.path));
            p.cleanableSize = p.items.reduce((s, it) => s + (it.size || 0), 0);
            if (!p.items.length) delete (S.itemSel || {})[p.path];
          });
          chosen.forEach((p) => { if (!p.items.length) selSet().delete(p.path); });
        }
      } catch (err) {
        SP.reportClean({ ok: false, error: (err && err.message) || 'Clean failed' });
      }
      S.projCleaning = false;
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

  // Compact language strip for a list row: a thin proportional bar and the
  // top language underneath. Hover (or a screen reader) gets the top three.
  function fillLangStrip(slot, langs) {
    slot.replaceChildren();
    slot.removeAttribute('title');
    slot.removeAttribute('role');
    slot.removeAttribute('aria-label');
    if (!langs) return;
    if (!langs.length) {
      slot.appendChild(el('div', { style: 'font-size:11.5px;color:var(--text-3);text-align:right', text: 'No source code' }));
      return;
    }
    const top = langs[0];
    const summary = langSummary(langs.filter((l) => l.id !== 'other').slice(0, 3), true);
    slot.setAttribute('title', summary);
    slot.setAttribute('role', 'img');
    slot.setAttribute('aria-label', 'Languages: ' + summary);
    slot.appendChild(langBar(langs, 5));
    slot.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;gap:5px;font-size:11.5px;margin-top:6px;line-height:1.2;white-space:nowrap' }, [
      el('span', { style: 'color:var(--text-2);font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0', text: top.name }),
      el('span', { style: 'color:var(--text-3);font-variant-numeric:tabular-nums;flex:none', text: pctText(top.percent, true) }),
    ]));
  }

  const CAT_ORDER = [
    ['framework', 'Frameworks'], ['library', 'Libraries'], ['runtime', 'Runtime'],
    ['tool', 'Tooling'], ['testing', 'Testing'], ['styling', 'Styling'],
    ['database', 'Databases'], ['mobile', 'Mobile'], ['infra', 'Infrastructure'],
  ];
  const CAT_KEYS = new Set(CAT_ORDER.map((c) => c[0]));
  const capsStyle = 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600';

  // Still waiting on the first analysis of this project (or its refresh).
  function analysing(p) {
    if (S.enrichPending.has(p.path)) return true;
    const asked = S.enrichAsked[p.path];
    return Boolean(asked && Date.now() - asked < 45000);
  }

  /**
   * Tech stack card on the project detail: a proportional language bar with a
   * legend, detected frameworks and tools grouped by category (evidence on
   * hover), and a footnote saying how much was analysed and how.
   */
  function buildTechCard(p) {
    const en = enrichOf(p) || {};
    const langs = languagesOf(p);
    const fws = (Array.isArray(en.frameworks) ? en.frameworks : [])
      .filter((f) => f && typeof f === 'object' && techId(f.id));
    const an = en.analysis && typeof en.analysis === 'object' ? en.analysis : null;
    const loading = !langs && analysing(p);

    const card = el('div', { style: 'background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow-sm);margin-top:16px' }, [
      el('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:16px' }, [
        ic('code', 16, { color: 'var(--text-3)' }),
        el('div', { style: capsStyle, text: 'Tech stack' }),
        el('div', { style: 'flex:1' }),
        loading ? el('div', { style: 'display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:12px;font-weight:600' }, [
          el('span', { style: 'display:flex;color:var(--accent-fg)' }, [ring('chase', 15)]), 'Analysing',
        ]) : null,
      ]),
    ]);

    if (loading) {
      card.setAttribute('aria-busy', 'true');
      // A cached result without languages is refreshed in the background and
      // normally arrives via onEnrichUpdated. If it never does, stop waiting.
      if (!S.enrichPending.has(p.path)) {
        const wait = Math.max(0, 45000 - (Date.now() - (S.enrichAsked[p.path] || 0))) + 50;
        setTimeout(() => { if (S.route === 'project' && S.currentProject === p && !languagesOf(p)) SP.go('project'); }, wait);
      }
      card.appendChild(el('div', { class: 'sp-skel', style: 'height:10px;border-radius:99px' }));
      card.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,236px));gap:12px 36px;margin-top:18px' },
        [92, 70, 108].map((w) => el('div', { style: 'display:flex;align-items:center;gap:9px;height:20px' }, [
          el('span', { class: 'sp-skel', style: 'width:8px;height:8px;border-radius:50%;flex:none' }),
          el('span', { class: 'sp-skel', style: 'width:16px;height:16px;border-radius:5px;flex:none' }),
          el('span', { class: 'sp-skel', style: 'width:' + w + 'px;height:10px;border-radius:6px' }),
        ]))));
      return card;
    }

    if (!langs) {
      card.appendChild(el('div', { style: 'color:var(--text-3);font-size:13px', text: 'Languages have not been analysed for this project yet.' }));
    } else if (!langs.length) {
      card.appendChild(el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
        el('div', { style: 'width:36px;height:36px;border-radius:10px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-3)' }, [ic('code', 18)]),
        el('div', {}, [
          el('div', { style: 'font-weight:600;font-size:14px', text: 'No source code found' }),
          el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:1px', text: 'Spaci looked for programming and markup files here and found none.' }),
        ]),
      ]));
    } else {
      const bar = langBar(langs, 10);
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', 'Languages: ' + langSummary(langs));
      card.appendChild(bar);
      card.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,236px));gap:12px 36px;margin-top:18px' },
        langs.map((l) => el('div', {
          title: l.name + ' ' + pctText(l.percent) + (l.bytes ? ' · ' + fmt(l.bytes) : ''),
          style: 'display:flex;align-items:center;gap:9px;min-width:0;height:20px',
        }, [
          el('span', { style: 'width:8px;height:8px;border-radius:50%;flex:none;background:' + l.color }),
          tic(l.id === 'other' ? 'file' : l.id, 16, { decorative: true, style: l.id === 'other' ? 'opacity:.55' : '' }),
          el('span', { style: 'font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' + (l.id === 'other' ? ';color:var(--text-2)' : ''), text: l.name }),
          el('span', { style: 'font-size:13px;font-weight:600;color:var(--text-2);font-variant-numeric:tabular-nums;flex:none', text: pctText(l.percent) }),
          el('span', { style: 'font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums;flex:none;min-width:48px;text-align:right', text: l.bytes ? fmt(l.bytes) : '' }),
        ]))));
    }

    if (fws.length) {
      const groups = new Map();
      fws.forEach((f) => {
        const cat = CAT_KEYS.has(f.category) ? f.category : 'tool';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(f);
      });
      const gridKids = [];
      CAT_ORDER.forEach(([key, label]) => {
        const list = groups.get(key);
        if (!list) return;
        gridKids.push(el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;line-height:30px', text: label }));
        gridKids.push(el('div', { role: 'list', 'aria-label': label, style: 'display:flex;flex-wrap:wrap;gap:8px;min-width:0' }, list.map((f) => {
          const name = String(f.name || f.id);
          const why = typeof f.evidence === 'string' && f.evidence ? 'Detected from ' + f.evidence : '';
          return el('span', {
            role: 'listitem',
            tabindex: '0',
            class: 'sp-focus',
            title: why || name,
            'aria-description': why || null,
            style: 'display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 11px 0 9px;border-radius:9px;background:var(--panel-2);border:1px solid var(--border);font-size:12.5px;font-weight:600;color:var(--text);max-width:100%;cursor:default',
          }, [
            tic(techId(f.id), 16, { decorative: true }),
            el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0', text: name }),
          ]);
        })));
      });
      card.appendChild(el('div', { style: 'display:grid;grid-template-columns:112px minmax(0,1fr);gap:10px 16px;align-items:start;margin-top:' + (langs && !langs.length ? 18 : 20) + 'px;padding-top:18px;border-top:1px solid var(--border)' }, gridKids));
    }

    if (an && Number(an.fileCount) >= 0 && an.fileCount != null) {
      const n = Number(an.fileCount) || 0;
      const parts = [n.toLocaleString() + ' file' + (n === 1 ? '' : 's') + ' analysed'];
      if (an.source === 'git') parts.push('from git');
      else if (an.source === 'walk') parts.push('from a folder walk');
      if (an.truncated) parts.push('partial result');
      if (an.analyzedAt) parts.push('updated ' + SP.ago(Number(an.analyzedAt)));
      card.appendChild(el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:16px;line-height:1.5', text: parts.join(' · ') }));
    }
    return card;
  }

  function rowDesc(p) {
    const items = p.items || [];
    const names = items.map((i) => i.name).slice(0, 3).join(', ');
    const more = items.length > 3 ? '…' : '';
    const usage = p.docker && p.docker.usage;
    const head = items.length
      ? items.length + ' cleanable item' + (items.length === 1 ? '' : 's') + (names ? ' · ' + names + more : '')
      : usage
        ? `${fmt(usage.totalBytes)} in Docker · ${usage.images} image${usage.images === 1 ? '' : 's'}, ${usage.volumes} volume${usage.volumes === 1 ? '' : 's'}`
        : 'No cleanable items';
    return head + (p.path ? '  ·  ' + p.path : '');
  }

  /**
   * Docker card on the project detail. Two independent facts: what the repo
   * declares (Dockerfile, compose services) and what the engine is actually
   * storing for it (images, volumes, containers), matched by the working
   * directory compose stamps on every container it starts.
   */
  function buildDockerCard(p) {
    const d = p.docker;
    if (!d) return null;
    const usage = d.usage;

    const declares = [];
    if (d.dockerfiles && d.dockerfiles.length) declares.push(d.dockerfiles.join(', '));
    if (d.composeFiles && d.composeFiles.length) declares.push(d.composeFiles.join(', '));
    if (d.hasDevcontainer) declares.push('.devcontainer');

    const fields = [
      { icon: 'file', k: 'Files', v: declares.join(' · ') || 'Dockerfile', color: 'var(--text)' },
    ];
    if (d.services && d.services.length) {
      fields.push({ icon: 'box', k: 'Services', v: d.services.slice(0, 4).join(', ') + (d.services.length > 4 ? '…' : ''), color: 'var(--text)' });
    }
    if (usage) {
      fields.push({ icon: 'hard-drive', k: 'Engine storage', v: fmt(usage.totalBytes || 0), color: 'var(--accent-fg)' });
      fields.push({ icon: 'grid', k: 'Objects', v: `${usage.images} image${usage.images === 1 ? '' : 's'} · ${usage.volumes} volume${usage.volumes === 1 ? '' : 's'} · ${usage.containers} container${usage.containers === 1 ? '' : 's'}`, color: 'var(--text)' });
      if (usage.running) fields.push({ icon: 'play', k: 'Running', v: String(usage.running), color: 'var(--success-fg)' });
    } else {
      fields.push({ icon: 'info', k: 'Engine storage', v: 'Nothing running from this folder', color: 'var(--text-3)' });
    }

    return el('div', { style: 'background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px;box-shadow:var(--shadow-sm);margin-top:16px' }, [
      el('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:14px' }, [
        ic('docker', 16, { kind: 'logo', color: 'var(--text-3)' }),
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: 'Docker' }),
      ]),
      el('div', { style: 'display:flex;gap:34px;flex-wrap:wrap' }, fields.map((g) => el('div', { style: 'min-width:0' }, [
        el('div', { style: 'color:var(--text-3);font-size:12px;display:flex;gap:6px;align-items:center;margin-bottom:5px' }, [ic(g.icon, 15), g.k]),
        el('div', { style: 'font-weight:700;font-size:15px;color:' + g.color + ';overflow:hidden;text-overflow:ellipsis', text: g.v }),
      ]))),
      usage ? el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:13px;line-height:1.5', text: 'Spaci never deletes Docker volumes or running containers. Reclaim images and build cache from the System screen.' }) : null,
    ]);
  }

  function openDetail(p) {
    S.currentProject = p;
    // kick off enrichment (git + total size) so the detail shows fresh data
    enrich(p);
    SP.go('project'); // detail navigation still re-mounts via the router
  }

  async function enrich(p) {
    if (!p || !p.path) return;
    S.enrichPending.add(p.path);
    S.enrichAsked[p.path] = Date.now();
    try {
      const r = await api.enrichProject(p.path);
      if (r) {
        S.enrich = S.enrich || {};
        S.enrich[p.path] = r;
      }
    } catch (_) { /* ignore */ }
    S.enrichPending.delete(p.path);
    onEnriched(p.path);
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
    const chosen = (sel[selKey] = sel[selKey] || new Set(items.filter((i) => i.safe === true).map((i) => i.path))); // default: safe items only

    // ----- back button -----
    host.appendChild(el('button', {
      class: 'sp-hov',
      style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
      hov: 'background:var(--panel);color:var(--text)',
      onclick: () => SP.go('projects'),
    }, [ic('arrow-left', 16), 'All projects']));

    // ----- header -----
    const branch = git && git.branch ? git.branch : null;
    const titleEls = [
      el('span', { title: p.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0', text: p.name }),
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
      el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;color:var(--text-2);flex:none;box-shadow:var(--shadow-sm)' }, [projectMark(p, 30)]),
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

    // ----- tech stack card -----
    host.appendChild(buildTechCard(p));

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

    // ----- docker card -----
    const dockerCard = buildDockerCard(p);
    if (dockerCard) host.appendChild(dockerCard);

    // ----- cleanable items header + select all -----
    const selectAllBtn = el('button', {
      class: 'sp-hov',
      style: 'height:34px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit',
      hov: 'background:var(--panel);color:var(--text)',
    }, []);
    function renderSelectAllLabel() {
      const pick = items.filter((it) => it.safe === true);
      const allOn = pick.length > 0 && pick.every((it) => chosen.has(it.path));
      selectAllBtn.innerHTML = '';
      selectAllBtn.appendChild(ic('check-circle', 15));
      selectAllBtn.appendChild(document.createTextNode(allOn ? 'Deselect all' : (pick.length < items.length ? 'Select all safe' : 'Select all')));
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
      const pick = items.filter((it) => it.safe === true);
      const allOn = pick.length > 0 && pick.every((it) => chosen.has(it.path));
      chosen.clear();
      if (!allOn) pick.forEach((it) => chosen.add(it.path));
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
      if (S.projCleaning) return;
      const chosenItems = selectedItems();
      if (!chosenItems.length) return;
      S.projCleaning = true;
      try {
        const jobs = chosenItems.filter((it) => it.safe === true).map((it) => ({ path: it.path, isDir: it.isDir, size: it.size }));
        const res = await api.clean(jobs, { scope: 'projects', label: p.name, reversible: true });
        const sum = SP.reportClean(res, {
          fallbackFreed: chosenItems.reduce((s, i) => s + (i.size || 0), 0),
          burstLabel: 'from ' + p.name
        });
        if (sum.ok) {
          // drop cleaned items from the project and recompute; refused or
          // failed items stay listed
          const cleaned = new Set(chosenItems.filter((i) => !sum.blocked(i.path)).map((i) => i.path));
          p.items = (p.items || []).filter((i) => !cleaned.has(i.path));
          p.cleanableSize = (p.items || []).reduce((s, i) => s + (i.size || 0), 0);
          delete (S.itemSel || {})[p.path];
          // refresh the cached list entry too
          if (Array.isArray(S.projects)) {
            const idx = S.projects.findIndex((x) => x.path === p.path);
            if (idx >= 0) S.projects[idx] = p;
          }
        }
      } catch (err) {
        SP.reportClean({ ok: false, error: (err && err.message) || 'Clean failed' });
      }
      S.projCleaning = false;
      if (S.route === 'project') SP.go('project');
    }

    renderSelectAllLabel();
    syncDetailActionBar();
  };

  function safeItems(p) { return (p.items || []).filter((it) => it.safe === true); }

  function buildItemRow(it, chosen, onToggle) {
    const badgeSafe = it.safe;
    const locked = it.safe !== true; // unverified: information only, never cleaned by Spaci
    const check = locked ? el('div', { style: 'width:24px;flex:none' }) : el('div', {
      class: chosen.has(it.path) ? 'sp-check-on' : '',
      style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s',
    }, [ic('tick', 14)]);

    const node = el('div', {
      class: chosen.has(it.path) ? 'sp-row-sel' : '',
      style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);' + (locked ? '' : 'cursor:pointer'),
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
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px;line-height:1.5', text: it.note || it.path }),
        locked ? el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:3px', text: 'Spaci will not clean this. Reveal it and delete it yourself if you are sure.' }) : null,
      ]),
      el('div', { style: 'font-weight:700;font-size:14.5px;flex:none', text: fmt(it.size || 0) }),
      locked ? el('button', {
        style: 'width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-3);display:grid;place-items:center;flex:none;cursor:pointer',
        hov: 'border-color:var(--border-2);color:var(--text)',
        title: 'Reveal in file manager',
        onclick: (e) => { e.stopPropagation(); try { api.reveal(it.path); } catch (_) {} },
      }, [ic('folder-open', 16)]) : null,
    ]);

    function sync() {
      check.className = chosen.has(it.path) ? 'sp-check-on' : '';
      node.className = chosen.has(it.path) ? 'sp-row-sel' : '';
    }
    node.addEventListener('click', () => {
      if (locked) return;
      if (chosen.has(it.path)) chosen.delete(it.path);
      else chosen.add(it.path);
      sync();
      if (onToggle) onToggle();
    });

    return { node, sync };
  }
})();
