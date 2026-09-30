'use strict';
/* Recommendations + Action detail, Spaci v2. Faithful to
   design/spaci-v2-reference.html (data-screen-label="Recommendations" and
   "Action detail"), wired to the real IPC backend (window.api).

   Recommendation shape (from api.recommendations({ projects, sysTargets })):
     { id, kind:'project'|'cache', savings, severity:'high'|'normal',
       icon, title, body, action:{ type:'open-project', path }
                              | { type:'select-system', id } }
   The recs only name what to clean; the concrete paths live in the scan cache
   (cache.projects[].items and cache.system[].paths), so we resolve jobs from
   the cached scan when the user applies an action. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // Informational cards (the Docker disk image explanation) carry action 'none':
  // nothing to clean, nothing to open, and no reclaimable size.
  function isInfo(r) { return !!(r && r.action && r.action.type === 'none'); }

  function recSize(r) {
    return Number(r && (r.savings != null ? r.savings : r.bytes != null ? r.bytes : r.size) || 0) || 0;
  }

  // One three-tier risk scheme for the list and the action page alike:
  // Safe (green), Review (amber), Permanent (red). It reads what the item
  // really is (the target's safe/reversible flags, the project's verified
  // items, the Docker kind), never the size-based severity.
  const TIER = {
    safe: { key: 'safe', cls: 'sp-badge-safe', text: 'Safe', long: 'Safe to clean' },
    review: { key: 'review', cls: 'sp-badge-caution', text: 'Review', long: 'Review first' },
    permanent: { key: 'permanent', cls: 'sp-badge-warn', text: 'Permanent', long: 'Permanent' },
  };
  function targetOf(r) {
    const act = (r && r.action) || {};
    if (act.type !== 'select-system') return null;
    const list = S.recsSystem || S.sysTargets || [];
    return list.find((t) => t.id === act.id) || null;
  }
  function projectOf(r) {
    const act = (r && r.action) || {};
    if (act.type !== 'open-project') return null;
    const list = S.recsProjects || S.projects || [];
    return list.find((p) => p.path === act.path) || null;
  }
  function recRisk(r) {
    if (!r) return TIER.safe;
    const act = r.action || {};
    // Unused images are Review, not Permanent: they download or rebuild again.
    // History still records them as permanent (a local-only build is gone).
    if (act.kind === 'unused-images') return TIER.review;
    if (r.reversible === false || r.permanent === true) return TIER.permanent;
    if (r.kind === 'docker' || act.type === 'docker-prune') {
      // Unused tagged images download again but are not rebuilt for you.
      return (act.kind === 'unused-images' || r.safe === false || r.optIn) ? TIER.review : TIER.safe;
    }
    const t = targetOf(r);
    if (t) {
      if (t.reversible === false) return TIER.permanent;
      if (!t.safe) return TIER.review;
    }
    const p = projectOf(r);
    if (p && (p.items || []).some((i) => i.safe === true && i.reversible === false)) return TIER.permanent;
    if (r.safe === false) return TIER.review;
    return TIER.safe;
  }

  // Mark for a recommendation: the brand of the app it belongs to (Docker, AI
  // tools, browsers), the tech of a project or cache, else its own glyph.
  function recMark(r, size) {
    const B = window.SpaciBrandIcon;
    const T = window.SpaciTechIcon;
    const brand = B && B.forRec ? B.forRec(r, S.recsSystem || S.sysTargets || []) : null;
    if (brand && SP.bic) return SP.bic(brand, size, { label: brand, fallback: r.icon || 'broom' });
    const t = targetOf(r);
    const tech = t && T && T.forTarget ? T.forTarget(t) : null;
    if (tech && SP.tic) return SP.tic(tech, size, { label: t.name || tech });
    const p = projectOf(r);
    const en = p && S.enrich ? S.enrich[p.path] : null;
    const pr = (en && en.primary) || (p && p.primary) || null;
    const pid = pr && T ? T.cleanId(pr.id) : '';
    if (pid && SP.tic) return SP.tic(pid, size, { label: pr.name || pid });
    return ic(r.icon || 'broom', size);
  }

  // ---- load + cache recommendations (and the raw scan they resolve against) ----
  async function loadRecs(force) {
    if (!force && S.recsLoaded) return;
    S.recsLoading = true;
    try {
      let projects = [];
      let sysTargets = [];
      try {
        const c = await api.cacheGet();
        projects = (c && c.projects) || [];
        sysTargets = (c && c.system) || [];
      } catch (_) { /* keep empties */ }
      S.recsProjects = projects;
      S.recsSystem = sysTargets;
      const recs = await api.recommendations({ projects, sysTargets });
      S.recs = Array.isArray(recs) ? recs : [];
      S.recsLoaded = true;
    } catch (_) {
      S.recs = S.recs || [];
    } finally {
      S.recsLoading = false;
    }
  }

  // Resolve a recommendation into clean jobs + metadata, using the cached scan.
  function resolveAction(rec) {
    if (!rec) return null;
    const act = rec.action || {};
    // Informational cards (the Docker disk image explanation) have nothing to run.
    if (act.type === 'none') return null;
    // Docker is reclaimed by the daemon, not by deleting paths, so it carries a
    // prune kind instead of clean jobs. Everything else on this screen is
    // path-based.
    const risk = recRisk(rec);
    if (rec.kind === 'docker' || act.type === 'docker-prune') {
      return {
        risk,
        kind: 'docker',
        dockerKind: act.kind,
        rec,
        icon: rec.icon || 'box',
        name: rec.title || 'Docker',
        body: rec.body || '',
        savings: recSize(rec),
        count: 1,
        safe: risk.key === 'safe',
        reversible: risk.key !== 'permanent',
        // Unused images come back only by downloading or rebuilding them.
        after: act.kind === 'unused-images'
          ? { short: 'Downloads again when needed', title: 'Downloaded or rebuilt when needed', text: 'Docker downloads or rebuilds an image the next time a container or build needs it. Large images can take a while to download again, and an image you built yourself and never pushed has to be built again.' }
          : null,
        jobs: [],
        items: [{ icon: 'box', path: act.kind === 'build-cache' ? 'docker builder prune' : act.kind === 'unused-images' ? 'docker image prune -a' : 'docker image prune' }],
        meta: { scope: 'docker', label: rec.title || 'Docker' },
      };
    }
    if (rec.kind === 'project' || act.type === 'open-project') {
      const proj = (S.recsProjects || []).find((p) => p.path === act.path) || null;
      const items = (proj && proj.items) || [];
      // Unverified items are never cleaned by Spaci, so they are not offered.
      const safeOnly = items.filter((i) => i.safe === true);
      const reversible = safeOnly.every((i) => i.reversible !== false);
      const safe = risk.key === 'safe';
      return {
        risk,
        kind: 'project',
        rec,
        icon: rec.icon || (proj && proj.type && proj.type.icon) || 'folder-2',
        name: (proj && proj.name) || rec.title || 'Project',
        body: rec.body || '',
        savings: recSize(rec),
        count: safeOnly.length,
        safe,
        reversible,
        // remove the whole artifact folder (cleaner: no 'contents' = remove path)
        jobs: safeOnly.map((i) => ({ path: i.path })),
        items: safeOnly.map((i) => ({ icon: i.isDir ? 'folder-2' : 'file', path: i.path, name: i.name, note: i.note, size: i.size })),
        meta: { scope: 'projects', label: (proj && proj.name) || rec.title || '' },
      };
    }
    // system cache
    const tgt = (S.recsSystem || []).find((t) => t.id === act.id) || null;
    const paths = (tgt && tgt.paths) || [];
    const reversible = tgt ? tgt.reversible !== false : true;
    return {
      risk,
      kind: 'cache',
      rec,
      icon: rec.icon || (tgt && tgt.icon) || 'broom',
      name: (tgt && tgt.name) || rec.title || 'Cache',
      body: rec.body || (tgt && tgt.description) || '',
      savings: recSize(rec),
      count: paths.length,
      safe: risk.key === 'safe',
      reversible: reversible && risk.key !== 'permanent',
      jobs: paths.map((p) => ({ path: p, mode: (tgt && tgt.mode) || 'contents' })),
      items: paths.map((p) => ({ icon: 'folder-2', path: p })),
      meta: { scope: 'system', label: (tgt && tgt.name) || rec.title || '' },
    };
  }

  function openAction(rec) {
    S.currentAction = resolveAction(rec);
    S.actionResult = null;
    S.actionCleaning = false;
    SP.go('action');
  }

  // ---- shared header (title + subtitle + right-side button) ----
  function pageHeader(title, subtitle, btn) {
    return el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
      el('div', {}, [
        el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: title }),
        el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:540px', text: subtitle }),
      ]),
      btn || null,
    ]);
  }

  function centerState(kids) {
    return el('div', {
      style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:54vh;gap:18px',
    }, kids);
  }

  // ================= RECOMMENDATIONS =================
  SP.screens.recommendations = function (host) {
    const rescanBtn = el('button', {
      style: 'height:44px;padding:0 18px;border-radius:11px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;flex:none',
      hov: 'background:var(--panel-2)',
      onclick: () => { S.recsLoaded = false; window.SP_doScan ? window.SP_doScan() : reload(true); },
    }, [ic('scanner', 16), 'Scan']);

    host.appendChild(pageHeader('Recommendations', 'The biggest, safest wins, surfaced automatically.', rescanBtn));

    const body = el('div', {});
    host.appendChild(body);

    function reload(force) {
      body.innerHTML = '';
      if (!S.recsLoaded || force) {
        body.appendChild(centerState([
          el('div', { style: 'color:var(--accent-fg)' }, [ring('spiral', 56)]),
          el('div', { style: 'font-size:16px;font-weight:600;color:var(--text-2)', text: 'Finding the safest wins…' }),
        ]));
        loadRecs(force).then(() => { if (S.route === 'recommendations') render(); });
      } else {
        render();
      }
    }

    function render() {
      body.innerHTML = '';
      const recs = S.recs || [];
      if (!recs.length) {
        body.appendChild(centerState([
          el('spaci-icon', { name: 'spaci-ring', anim: 'breathe', style: 'width:64px;height:64px;color:var(--text-4);display:block' }),
          el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.5px;color:var(--text)', text: 'Nothing to recommend' }),
          el('div', { style: 'font-size:14px;color:var(--text-3);max-width:380px', text: 'You are all clean. Run a scan to look for new build artifacts and developer caches you can safely reclaim.' }),
          el('button', {
            style: 'height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer',
            hov: 'background:var(--accent-hover)',
            onclick: () => { window.SP_doScan ? window.SP_doScan() : reload(true); },
          }, [ic('scanner', 16), 'Scan']),
        ]));
        return;
      }

      const tot = SP.reclaimTotals ? SP.reclaimTotals() : null;
      if (tot) body.appendChild(totalsLine(tot));
      const list = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:11px' },
        recs.map((r) => recRow(r)));
      body.appendChild(list);
    }

    // The one headline figure (what these cards reclaim), the grand total of
    // everything cleanable, and unverified bytes kept apart, never summed in.
    function totalsLine(tot) {
      const part = (label, value, color) => el('div', { style: 'display:flex;align-items:baseline;gap:7px;font-size:13.5px;color:var(--text-2)' }, [
        el('span', { text: label }), el('b', { style: 'font-weight:700;color:' + color, text: value }),
      ]);
      return el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px 28px;padding:14px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:18px' }, [
        part('Top recommendations:', fmt(tot.top), 'var(--accent-fg)'),
        part('All cleanable found:', fmt(tot.grand), 'var(--text)'),
        tot.unverified > 0 ? part('Unverified, not counted:', fmt(tot.unverified), 'var(--text-3)') : null,
      ]);
    }

    function infoRow(r) {
      return el('div', {
        style: 'display:flex;align-items:center;gap:16px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border)',
      }, [
        el('div', { style: 'width:48px;height:48px;border-radius:13px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(r.icon || 'info', 25)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15.5px;display:flex;align-items:center;gap:10px' }, [
            el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: r.title || 'Information' }),
            el('span', {
              class: 'sp-badge-accent',
              style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
              text: 'Info',
            }),
          ]),
          el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:4px;line-height:1.55', text: r.body || '' }),
        ]),
      ]);
    }

    function recRow(r) {
      if (isInfo(r)) return infoRow(r);
      const risk = recRisk(r);
      const borderColor = risk.key === 'safe' ? 'var(--border)' : 'var(--border-2)';

      const tag = el('span', {
        class: risk.cls,
        style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
        text: risk.text,
      });

      const cleanBtn = el('button', {
        style: 'height:42px;padding:0 18px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:pointer;flex:none',
        hov: 'background:var(--accent-hover)',
        onclick: (e) => { e.stopPropagation(); openAction(r); },
      }, [ic('trash', 15), 'Clean']);

      return el('div', {
        class: 'sp-hov',
        style: `display:flex;align-items:center;gap:16px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid ${borderColor};cursor:pointer`,
        hov: 'border-color:var(--border-2);transform:translateX(2px)',
        onclick: () => openAction(r),
      }, [
        el('div', { style: 'width:48px;height:48px;border-radius:13px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [recMark(r, 25)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15.5px;display:flex;align-items:center;gap:10px' }, [
            el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: r.title || 'Cleanable' }),
            tag,
          ]),
          el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:4px', text: r.body || '' }),
        ]),
        el('div', { style: 'font-weight:700;font-size:17px;color:var(--accent-fg);flex:none', text: fmt(recSize(r)) }),
        cleanBtn,
      ]);
    }

    reload(false);
  };

  // ================= ACTION DETAIL =================
  SP.screens.action = function (host) {
    const a = S.currentAction;

    const back = el('button', {
      style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:18px',
      hov: 'background:var(--panel);color:var(--text)',
      onclick: () => SP.go('recommendations'),
    }, [ic('chevron-left', 16), 'Recommendations']);
    host.appendChild(back);

    if (!a) {
      host.appendChild(centerState([
        el('spaci-icon', { name: 'spaci-ring', anim: 'breathe', style: 'width:64px;height:64px;color:var(--text-4);display:block' }),
        el('div', { style: 'font-size:18px;font-weight:700;color:var(--text)', text: 'No action selected' }),
        el('div', { style: 'font-size:14px;color:var(--text-3)', text: 'Pick a recommendation to see what it will remove.' }),
      ]));
      return;
    }

    const risk = a.risk || recRisk(a.rec);
    const safe = risk.key === 'safe';
    const reversible = risk.key !== 'permanent';

    // header: icon tile + name + badge + savings
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:22px' }, [
        el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [a.rec ? recMark(a.rec, 31) : ic(a.icon, 31)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px' }, [
            el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: a.name }),
            el('span', {
              class: risk.cls,
              style: 'display:inline-flex;padding:4px 10px;border-radius:8px;font-size:11.5px;font-weight:700',
              text: risk.long,
            }),
          ]),
          el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:5px', text: a.body || 'Regenerable files that rebuild on demand.' }),
        ]),
        el('div', { style: 'font-weight:700;font-size:26px;letter-spacing:-1px;color:var(--accent-fg);flex:none', text: fmt(a.savings) }),
      ])
    );

    // stat strip
    const stat = (icon, label, value, color) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text-2)' }, [
      ic(icon, 16, { color: 'var(--text-3)' }),
      label,
      el('b', { style: `color:${color};font-weight:700`, text: value }),
    ]);
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 32px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:22px' }, [
        stat('hard-drive', 'Reclaimable', fmt(a.savings), 'var(--accent-fg)'),
        stat('box', 'Locations', String(a.count), 'var(--text)'),
        stat(reversible ? 'refresh' : 'lock', 'After cleaning', a.after ? a.after.short : reversible ? 'Rebuilds on next install/build' : 'Permanent', reversible ? 'var(--text)' : 'var(--danger-fg)'),
      ])
    );

    // reversible / safety note
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border);margin-bottom:20px' }, [
        ic(reversible ? 'refresh' : 'shield', 22, { color: reversible ? 'var(--accent-fg)' : 'var(--danger-fg)' }),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: a.after ? a.after.title : reversible ? 'Rebuilds on next install or build' : 'Permanent removal' }),
          el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: a.after ? a.after.text : reversible
            ? 'These are regenerable caches and build output. Your tools rebuild them automatically the next time you build or install.'
            : 'These files will not be regenerated automatically. Make sure you no longer need them before applying.' }),
        ]),
      ])
    );

    // what will be removed
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: a.count ? 'What will be removed' : 'Nothing to remove' }));

    if ((a.items || []).length) {
      const listEl = el('div', { style: 'display:flex;flex-direction:column;gap:7px;margin-bottom:24px' });
      const itemEl = (it) => el('div', {
        style: 'display:flex;align-items:center;gap:13px;padding:12px 15px;border-radius:12px;background:var(--panel);border:1px solid var(--border)',
      }, [
        ic(it.icon || 'folder-2', 18, { color: 'var(--text-3)' }),
        el('div', { class: 'mono', style: 'flex:1;min-width:0;color:var(--text-2);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: it.path }),
        it.size != null ? el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;flex:none', text: fmt(it.size) }) : null,
      ]);
      const all = a.items;
      const LIMIT = 100;
      all.slice(0, LIMIT).forEach((it) => listEl.appendChild(itemEl(it)));
      if (all.length > LIMIT) {
        const btn = el('button', {
          style: 'height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;align-self:flex-start',
          hov: 'background:var(--panel-3)',
          onclick: () => { all.slice(LIMIT).forEach((it) => listEl.insertBefore(itemEl(it), btn)); btn.remove(); },
        }, ['Show all ' + all.length + ' (showing ' + LIMIT + ')']);
        listEl.appendChild(btn);
      }
      host.appendChild(listEl);
    } else {
      host.appendChild(el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-bottom:24px', text: 'The scan no longer lists files for this action. Scan again to refresh.' }));
    }

    // result banner (after applying). A refused or failed clean never reads as
    // success: only state 'done' is green.
    if (S.actionResult) {
      const r = S.actionResult;
      const done = r.state === 'done';
      const partial = r.state === 'partial';
      const title = done ? 'Cleaned ' + fmt(r.totalFreed || 0)
        : partial ? 'Cleaned ' + fmt(r.totalFreed || 0) + ', with some items left'
          : r.state === 'blocked' ? 'Nothing was cleaned'
            : r.state === 'empty' ? 'Nothing was freed' : 'Could not clean';
      const reasons = Array.from(new Set((r.refused || []).map((x) => x.reason).filter(Boolean)));
      const lines = [];
      if (done) lines.push(a.kind === 'docker' ? 'Space reclaimed inside Docker.' : 'Space reclaimed. Build artifacts rebuild on your next install or build.');
      if (r.note) lines.push(r.note);
      else if (r.state === 'empty') lines.push('The selected items were already empty or gone.');
      else if (r.state === 'failed') lines.push((r.error || 'Something went wrong while removing files.') + '.');
      else {
        if (reasons.length) lines.push(reasons.slice(0, 2).join(' '));
        if ((r.refused || []).length > 1) lines.push(r.refused.length + ' items were left alone.');
        if ((r.errors || []).length) lines.push(r.errors.length + ' item' + (r.errors.length === 1 ? '' : 's') + ' could not be removed: ' + SP.plainError(r.errors[0]) + '.');
      }
      host.appendChild(
        el('div', { style: `display:flex;align-items:center;gap:14px;padding:18px 20px;border-radius:16px;background:${done ? 'var(--success-soft)' : partial ? 'var(--warn-soft)' : 'var(--danger-soft)'};border:1px solid var(--border);margin-bottom:20px` }, [
          ic(done ? 'check' : 'warning', 24, { color: done ? 'var(--success-fg)' : partial ? 'var(--warn-fg)' : 'var(--danger-fg)' }),
          el('div', { style: 'flex:1' }, [
            el('div', { style: 'font-weight:700;font-size:14.5px', text: title }),
            ...lines.map((t) => el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:2px;line-height:1.55', text: t })),
          ]),
        ])
      );
    }

    // apply bar. A Docker action has no clean jobs: the daemon does the work.
    const cleaning = S.actionCleaning;
    const applicable = a.kind === 'docker' ? Boolean(a.dockerKind) : a.jobs.length > 0;
    // Only a clean that freed space is spent. "Nothing was freed" must not read as Cleaned.
    const spent = !!S.actionResult && S.actionResult.state === 'done';
    const emptied = !!S.actionResult && S.actionResult.state === 'empty';
    const applyBtn = el('button', {
      class: safe ? 'sp-ab-accent' : 'sp-ab-danger',
      style: 'height:46px;padding:0 22px;border-radius:12px;border:none;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;flex:none' + ((cleaning || !applicable || spent) ? ';opacity:.6;pointer-events:none' : ''),
      onclick: () => apply(),
    }, [
      cleaning ? ic('spaci-ring', 16, { anim: 'elastic' }) : ic('trash', 16),
      cleaning ? 'Cleaning…' : spent ? 'Cleaned' : emptied ? 'Nothing to clean' : S.actionResult ? 'Try again' : (safe ? 'Clean ' + fmt(a.savings) : 'Remove ' + fmt(a.savings)),
    ]);

    const cancelBtn = el('button', {
      style: 'height:46px;padding:0 18px;border-radius:12px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);font-weight:600;font-size:13.5px;cursor:pointer',
      hov: 'background:var(--panel-2);color:var(--text)',
      onclick: () => SP.go('recommendations'),
    }, [spent ? 'Back to list' : 'Cancel']);

    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:13px;margin-top:6px' }, [
        applyBtn,
        cancelBtn,
        el('div', { style: 'flex:1' }),
      ])
    );

    async function apply() {
      if (S.actionCleaning || !applicable) return;
      let confirmed = false;
      {
        const permanentNames = (!reversible && a.kind !== 'docker') ? [a.name] : [];
        const cf = await SP.confirmClean({
          title: a.kind === 'docker' ? 'Run Docker cleanup?' : undefined,
          force: !safe || !reversible,
          count: a.kind === 'docker' ? 1 : a.jobs.length,
          bytes: a.savings != null ? a.savings : undefined,
          permanent: permanentNames,
          note: a.kind === 'docker' ? (a.after ? a.after.text : 'Docker rebuilds this cache the next time you build.') : undefined
        });
        if (!cf.go) return;
        confirmed = cf.confirmed;
      }
      S.actionCleaning = true;
      if (S.route === 'action') SP.go('action'); // reflect the cleaning state
      try {
        const res = a.kind === 'docker'
          ? await api.dockerPrune(a.dockerKind, { confirmed }).then((r) => (r && r.ok ? { ok: true, totalFreed: r.freed, note: r.note || (S.docker && S.docker.diskNote) || null } : r))
          : await api.clean(a.jobs, confirmed ? Object.assign({}, a.meta, { confirmed: true }) : a.meta);
        if (a.kind !== 'docker' && res && res.ok !== false) {
          // Try again resends only what was not removed.
          const sumR = SP.summariseClean(res);
          a.jobs = a.jobs.filter((j) => sumR.blocked(j.path));
        }
        if (res && res.ok !== false) {
          const sum = SP.summariseClean(res, { fallbackFreed: a.savings != null ? a.savings : 0 });
          S.actionResult = { state: sum.state, totalFreed: sum.freed, refused: sum.refused, errors: sum.errors, note: (res && res.note) || null };
          // Celebratory success overlay only when everything was removed.
          if (sum.state === 'done') SP.burst(SP.fmt(sum.freed), (a.meta && a.meta.label) || a.title || 'across cleaned items');
        } else {
          S.actionResult = { state: 'failed', error: (res && res.error) || 'Clean failed' };
        }
        // this action is spent; refresh recommendations on next visit
        S.recsLoaded = false;
      } catch (err) {
        S.actionResult = { state: 'failed', error: (err && err.message) || 'Clean failed' };
      } finally {
        S.actionCleaning = false;
        if (S.route === 'action') SP.go('action');
      }
    }
  };
})();
