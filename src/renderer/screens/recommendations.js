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

  function recSize(r) {
    return Number(r && (r.savings != null ? r.savings : r.bytes != null ? r.bytes : r.size) || 0) || 0;
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
    if (rec.kind === 'project' || act.type === 'open-project') {
      const proj = (S.recsProjects || []).find((p) => p.path === act.path) || null;
      const items = (proj && proj.items) || [];
      const reversible = items.every((i) => i.reversible !== false);
      const safe = items.every((i) => i.safe);
      return {
        kind: 'project',
        rec,
        icon: rec.icon || (proj && proj.type && proj.type.icon) || 'folder-2',
        name: (proj && proj.name) || rec.title || 'Project',
        body: rec.body || '',
        savings: recSize(rec),
        count: items.length,
        safe,
        reversible,
        // remove the whole artifact folder (cleaner: no 'contents' = remove path)
        jobs: items.map((i) => ({ path: i.path })),
        items: items.map((i) => ({ icon: i.isDir ? 'folder-2' : 'file', path: i.path, name: i.name, note: i.note, size: i.size })),
        meta: { scope: 'projects', label: (proj && proj.name) || rec.title || '', reversible },
      };
    }
    // system cache
    const tgt = (S.recsSystem || []).find((t) => t.id === act.id) || null;
    const paths = (tgt && tgt.paths) || [];
    const reversible = tgt ? tgt.reversible !== false : true;
    return {
      kind: 'cache',
      rec,
      icon: rec.icon || (tgt && tgt.icon) || 'broom',
      name: (tgt && tgt.name) || rec.title || 'Cache',
      body: rec.body || (tgt && tgt.description) || '',
      savings: recSize(rec),
      count: paths.length,
      safe: tgt ? !!tgt.safe : true,
      reversible,
      jobs: paths.map((p) => ({ path: p, mode: (tgt && tgt.mode) || 'contents' })),
      items: paths.map((p) => ({ icon: 'folder-2', path: p })),
      meta: { scope: 'system', label: (tgt && tgt.name) || rec.title || '', reversible },
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
    }, [ic('refresh', 16), 'Re-scan']);

    host.appendChild(pageHeader('Recommendations', 'The biggest, safest wins, surfaced automatically.', rescanBtn));

    const body = el('div', {});
    host.appendChild(body);

    function reload(force) {
      body.innerHTML = '';
      if (!S.recsLoaded || force) {
        body.appendChild(centerState([
          el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
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
          el('div', { style: 'width:72px;height:72px;border-radius:20px;background:var(--success-soft);display:grid;place-items:center;color:var(--success-fg)' }, [ic('check', 34)]),
          el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.5px;color:var(--text)', text: 'Nothing to recommend' }),
          el('div', { style: 'font-size:14px;color:var(--text-3);max-width:380px', text: 'You are all clean. Run a scan to look for new build artifacts and developer caches you can safely reclaim.' }),
          el('button', {
            style: 'height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer',
            hov: 'background:var(--accent-hover)',
            onclick: () => { window.SP_doScan ? window.SP_doScan() : reload(true); },
          }, [ic('scan', 16), 'Run a scan']),
        ]));
        return;
      }

      const list = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:11px' },
        recs.map((r) => recRow(r)));
      body.appendChild(list);
    }

    function recRow(r) {
      const high = r.severity === 'high';
      const tagSafe = !high; // high severity = stale/permanent-ish flag; normal = safe to clean
      const borderColor = high ? 'var(--border-2)' : 'var(--border)';
      const iconBg = high ? 'var(--danger-soft)' : 'var(--accent-soft)';
      const color = high ? 'var(--danger-fg)' : 'var(--accent-fg)';

      const tag = el('span', {
        class: tagSafe ? 'sp-badge-safe' : 'sp-badge-warn',
        style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
        text: tagSafe ? 'Safe' : 'Review',
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
        el('div', { style: `width:48px;height:48px;border-radius:13px;background:${iconBg};display:grid;place-items:center;flex:none;color:${color}` }, [ic(r.icon || 'broom', 25)]),
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
    }, [ic('arrow-left', 16), 'Recommendations']);
    host.appendChild(back);

    if (!a) {
      host.appendChild(centerState([
        el('div', { style: 'color:var(--text-3)' }, [ic('broom', 40)]),
        el('div', { style: 'font-size:18px;font-weight:700;color:var(--text)', text: 'No action selected' }),
        el('div', { style: 'font-size:14px;color:var(--text-3)', text: 'Pick a recommendation to see what it will remove.' }),
      ]));
      return;
    }

    const safe = a.safe;
    const reversible = a.reversible;

    // header: icon tile + name + badge + savings
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:22px' }, [
        el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(a.icon, 31)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px' }, [
            el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: a.name }),
            el('span', {
              class: safe ? 'sp-badge-safe' : 'sp-badge-warn',
              style: 'display:inline-flex;padding:4px 10px;border-radius:8px;font-size:11.5px;font-weight:700',
              text: safe ? 'Safe to clean' : 'Review first',
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
        stat(reversible ? 'undo' : 'lock', 'Reversible', reversible ? 'Yes, rebuilds' : 'Permanent', reversible ? 'var(--text)' : 'var(--danger-fg)'),
      ])
    );

    // reversible / safety note
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border);margin-bottom:20px' }, [
        ic(reversible ? 'undo' : 'shield', 22, { color: reversible ? 'var(--accent-fg)' : 'var(--danger-fg)' }),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: reversible ? 'Safe and reversible' : 'Permanent removal' }),
          el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: reversible
            ? 'These are regenerable caches and build output. Your tools rebuild them automatically the next time you build or install.'
            : 'These files will not be regenerated automatically. Make sure you no longer need them before applying.' }),
        ]),
      ])
    );

    // what will be removed
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: a.count ? 'What will be removed' : 'Nothing to remove' }));

    if (a.items.length) {
      host.appendChild(
        el('div', { style: 'display:flex;flex-direction:column;gap:7px;margin-bottom:24px' },
          a.items.slice(0, 80).map((it) => el('div', {
            style: 'display:flex;align-items:center;gap:13px;padding:12px 15px;border-radius:12px;background:var(--panel);border:1px solid var(--border)',
          }, [
            ic(it.icon || 'folder-2', 18, { color: 'var(--text-3)' }),
            el('div', { class: 'mono', style: 'flex:1;min-width:0;color:var(--text-2);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: it.path }),
            it.size != null ? el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;flex:none', text: fmt(it.size) }) : null,
          ])))
      );
    } else {
      host.appendChild(el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-bottom:24px', text: 'The scan no longer lists files for this action. Re-scan to refresh.' }));
    }

    // result banner (after applying)
    if (S.actionResult) {
      const ok = S.actionResult.ok;
      host.appendChild(
        el('div', { style: `display:flex;align-items:center;gap:14px;padding:18px 20px;border-radius:16px;background:${ok ? 'var(--success-soft)' : 'var(--danger-soft)'};border:1px solid var(--border);margin-bottom:20px` }, [
          ic(ok ? 'check' : 'warning', 24, { color: ok ? 'var(--success-fg)' : 'var(--danger-fg)' }),
          el('div', { style: 'flex:1' }, [
            el('div', { style: 'font-weight:700;font-size:14.5px', text: ok ? 'Cleaned ' + fmt(S.actionResult.totalFreed || 0) : 'Could not clean' }),
            el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:2px', text: ok ? 'Space reclaimed. The artifacts will rebuild when you next need them.' : (S.actionResult.error || 'Something went wrong while removing files.') }),
          ]),
        ])
      );
    }

    // apply bar
    const cleaning = S.actionCleaning;
    const applyBtn = el('button', {
      class: safe ? 'sp-ab-accent' : 'sp-ab-danger',
      style: 'height:46px;padding:0 22px;border-radius:12px;border:none;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;flex:none' + ((cleaning || !a.jobs.length || S.actionResult) ? ';opacity:.6;pointer-events:none' : ''),
      onclick: () => apply(),
    }, [
      cleaning ? ic('spaci-ring', 16, { anim: 'spin' }) : ic('trash', 16),
      cleaning ? 'Cleaning…' : S.actionResult ? 'Cleaned' : (safe ? 'Clean ' + fmt(a.savings) : 'Remove ' + fmt(a.savings)),
    ]);

    const cancelBtn = el('button', {
      style: 'height:46px;padding:0 18px;border-radius:12px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);font-weight:600;font-size:13.5px;cursor:pointer',
      hov: 'background:var(--panel-2);color:var(--text)',
      onclick: () => SP.go('recommendations'),
    }, [S.actionResult ? 'Back to list' : 'Cancel']);

    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:13px;margin-top:6px' }, [
        applyBtn,
        cancelBtn,
        el('div', { style: 'flex:1' }),
      ])
    );

    async function apply() {
      if (S.actionCleaning || !a.jobs.length) return;
      S.actionCleaning = true;
      if (S.route === 'action') SP.go('action'); // reflect the cleaning state
      try {
        const res = await api.clean(a.jobs, a.meta);
        S.actionResult = res && res.ok ? { ok: true, totalFreed: res.totalFreed } : { ok: false, error: (res && res.error) || 'Clean failed' };
        // this action is spent; refresh recommendations on next visit
        S.recsLoaded = false;
      } catch (err) {
        S.actionResult = { ok: false, error: (err && err.message) || 'Clean failed' };
      } finally {
        S.actionCleaning = false;
        if (S.route === 'action') SP.go('action');
      }
    }
  };
})();
