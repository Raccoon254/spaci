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
      const permanent = isPermanent(t);
      const badgeClass = badgeSafe && !permanent ? 'sp-badge-safe' : 'sp-badge-warn';
      const badgeText = permanent ? 'Permanent' : (badgeSafe ? 'Safe' : 'Review');
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
              class: badgeClass,
              style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
              text: badgeText
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

    async function runPrune(kind, label) {
      if (S.dockerPruning) return;
      const images = kind === 'unused-images';
      const cf = await SP.confirmClean({
        title: 'Run Docker cleanup?', count: 1, force: images,
        note: images
          ? 'Removes every image no container uses. Docker downloads or rebuilds an image the next time something needs it.'
          : label + '. Docker rebuilds this cache the next time you build.'
      });
      if (!cf.go) return;
      S.dockerPruning = kind;
      paint();
      try {
        const res = await api.dockerPrune(kind, { confirmed: cf.confirmed });
        // Same toast, burst and report as every other clean in the app.
        if (res && res.ok) {
          SP.reportClean({ ok: true, totalFreed: res.freed || 0, refused: [], errors: [] }, { burstLabel: 'from ' + label.toLowerCase() });
        } else {
          const why = res && res.error === 'needs-confirmation' ? 'Spaci needs your confirmation for this. Try again and confirm' : ((res && res.error) || 'Docker cleanup failed');
          SP.reportClean({ ok: false, error: why });
        }
      } catch (err) {
        SP.reportClean({ ok: false, error: (err && err.message) || 'Docker cleanup failed' });
      } finally {
        S.dockerPruning = null;
        paint();
        loadDocker(true);
      }
    }

    function dockerStat(label, cat) {
      const free = cat ? cat.reclaimable || 0 : 0;
      return el('div', { style: 'flex:1;min-width:126px' }, [
        el('div', { style: 'font-size:11.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:600', text: label }),
        el('div', { style: 'font-size:16px;font-weight:700;margin-top:4px', text: fmt(cat ? cat.size || 0 : 0) }),
        el('div', {
          style: `font-size:12px;margin-top:2px;color:${free > 0 ? 'var(--accent-fg)' : 'var(--text-3)'}`,
          text: free > 0 ? fmt(free) + ' unused' : 'all in use',
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

    // not-installed | stopped | engine-down | running. Older cached results
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
        'no-permission': 'Docker is running, but Spaci cannot talk to it',
        remote: 'Docker is pointed at a remote host',
        unreadable: 'Docker is running, but Spaci could not read its usage',
        'not-installed': 'Docker is not installed',
      };
      const BADGE = {
        stopped: ['sp-badge-caution', 'Stopped'],
        'engine-down': ['sp-badge-warn', 'Not responding'],
        'no-permission': ['sp-badge-warn', 'No access'],
        remote: ['sp-badge-caution', 'Remote'],
        unreadable: ['sp-badge-caution', 'Unreadable'],
        'not-installed': ['sp-badge-caution', 'Not installed'],
      };
      const known = Object.prototype.hasOwnProperty.call(SUB, state);
      const badge = BADGE[state];

      const title = el('div', { style: 'display:flex;align-items:center;gap:13px' }, [
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:#1d63ed' },
          [ic('docker', 24, { kind: 'logo' })]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15px;display:flex;align-items:center;gap:9px' }, [
            el('span', { text: 'Docker' }),
            !running && badge ? el('span', { class: badge[0], style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text: badge[1] }) : null,
          ]),
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: known ? SUB[state] : 'Docker status unavailable' }),
        ]),
        running ? el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'font-weight:700;font-size:15px', text: fmt(d.totals.size || 0) }),
          el('div', { style: 'font-size:12px;color:var(--accent-fg);font-weight:600', text: fmt(d.totals.reclaimable || 0) + ' reclaimable' }),
        ]) : null,
      ]);

      if (!running) {
        const COPY = {
          stopped: 'Start Docker Desktop and check again to see how much space images, volumes and build cache are holding.',
          'engine-down': 'Restart Docker Desktop, then check again. Nothing inside Docker can be cleaned until its engine responds.',
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
        if (state !== 'not-installed') {
          kids.push(el('div', { style: 'display:flex;gap:9px' }, [
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
      const stats = [
        dockerStat('Images', c.images),
        dockerStat('Build cache', c.buildCache),
        dockerStat('Volumes', c.volumes),
        dockerStat('Containers', c.containers),
      ];
      if (disk) stats.push(diskImageStat(disk));
      const rows = [
        title,
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px 20px;padding-top:14px;border-top:1px solid var(--border)' }, stats),
      ];
      const gapNote = disk ? diskImageNote(disk) : null;
      if (gapNote) rows.push(gapNote);

      const buttons = [];
      if ((c.buildCache.reclaimable || 0) > 0) buttons.push(dockerButton('Reclaim ' + fmt(c.buildCache.reclaimable) + ' build cache', 'build-cache'));
      if ((c.images.reclaimable || 0) > 0) buttons.push(dockerButton('Remove ' + fmt(c.images.reclaimable) + ' of unused images', 'unused-images'));
      if (buttons.length) rows.push(el('div', { style: 'display:flex;flex-wrap:wrap;gap:9px' }, buttons));

      rows.push(el('div', {
        style: 'color:var(--text-3);font-size:11.5px;line-height:1.5',
        text: 'Volumes are never touched: they hold databases and uploads. Build cache rebuilds on your next build; removed images are downloaded or rebuilt when needed.',
      }));
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
      host.appendChild(bigState('breathe', 'All clean', 'No reclaimable caches were found on this machine right now.', 'Scan again', false));
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
