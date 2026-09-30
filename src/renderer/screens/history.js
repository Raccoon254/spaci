'use strict';
/* History screen, Spaci v2. A log of every cleanup operation Spaci has run.
   Faithful to design/spaci-v2-reference.html (data-screen-label="History" and
   data-screen-label="Action detail").
   Data comes from window.api.historyGet(); each entry is the shape written by
   the main process clean handler (src/main.js). Two shapes are read:
     v2:  { v:2, id, at, status, scope, label, requested, count, failedCount,
            refusedCount, freed, items:[{ path, kind, outcome, bytes, reason,
            reversible, restoreHint }], itemsTruncated }
     old: { at, scope, label, count, freed, reversible:boolean, items:[path] }
   Every field is optional: nothing here assumes a v2 field exists. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // Map a cleanup scope to an icon for its row avatar. The design uses a broom
  // for system caches, a folder for project artifacts, and a trash can for
  // large files.
  const SCOPE_ICON = {
    projects: 'folder',
    project: 'folder',
    system: 'broom',
    largefiles: 'trash',
    'large-files': 'trash',
    storage: 'database',
    duplicates: 'copy',
    developer: 'code',
    'auto-clean': 'clock'
  };
  function scopeIcon(e) {
    return SCOPE_ICON[(e.scope || '').toLowerCase()] || 'box';
  }

  function itemPath(it) { return it && typeof it === 'object' ? it.path : it; }
  function lastSeg(p) { const s = String(p || '').replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || ''; }
  // What an entry belongs to: Docker, or one app when every recorded path is
  // that app's (all of it ~/.claude, say). Mixed or unknown entries keep the
  // scope glyph.
  function brandOfEntry(e) {
    if ((e.scope || '').toLowerCase() === 'docker') return 'docker';
    const B = window.SpaciBrandIcon;
    if (!B || !B.forPath || !Array.isArray(e.items) || !e.items.length) return null;
    let brand;
    for (const it of e.items) {
      const b = B.forPath(itemPath(it));
      if (!b || (brand && b !== brand)) return null;
      brand = b;
    }
    return brand || null;
  }
  function entryMark(e, size) {
    const brand = brandOfEntry(e);
    if (brand && SP.bic) return SP.bic(brand, size, { label: brand, fallback: scopeIcon(e) });
    return ic(scopeIcon(e), size);
  }
  // A cleaned path's mark: the app's logo (browser, AI tool, Docker), the
  // tech of a build folder (node_modules, target...), else folder or file.
  function itemMark(e, it, fallback, size) {
    const p = itemPath(it);
    const B = window.SpaciBrandIcon;
    const brand = B && B.forPath ? B.forPath(p) : null;
    if (brand && SP.bic) return SP.bic(brand, size, { label: brand, fallback });
    const scope = (e.scope || '').toLowerCase();
    const T = window.SpaciTechIcon;
    if ((scope === 'projects' || scope === 'project') && T && T.forArtifact && SP.tic) {
      const tech = T.forArtifact({ name: lastSeg(p) }, null, null);
      if (tech) return SP.tic(tech, size, { label: tech });
    }
    return ic(fallback, size, { color: 'var(--text-3)' });
  }

  // A human title for an entry: prefer its label, fall back to the scope.
  function titleOf(e) {
    if (e.label) return e.label;
    const scope = (e.scope || '').toLowerCase();
    if (scope === 'system') return 'System caches';
    if (scope === 'projects' || scope === 'project') return 'Project artifacts';
    if (scope === 'largefiles' || scope === 'large-files') return 'Large files';
    if (scope === 'storage') return 'Storage cleanup';
    if (scope === 'duplicates') return 'Duplicate files';
    return e.scope ? e.scope.charAt(0).toUpperCase() + e.scope.slice(1) : 'Cleanup';
  }

  // Noun used for an entry's item count, tuned to its scope.
  function itemNoun(e, count) {
    const scope = (e.scope || '').toLowerCase();
    if (scope === 'system') return count === 1 ? 'cache' : 'caches';
    if (scope === 'largefiles' || scope === 'large-files') return count === 1 ? 'file' : 'files';
    return count === 1 ? 'item' : 'items';
  }

  const isV2 = (e) => !!e && e.v === 2;
  // Auto-clean runs (src/auto-clean.js): staged items are 'trashed' in the log
  // (still on disk) until the staging folder is purged 24 hours later.
  const acOf = (e) => (e && e.autoClean && typeof e.autoClean === 'object' ? e.autoClean : null);
  const isPreview = (e) => !!(acOf(e) && acOf(e).dryRun);
  const isAuto = (e) => (e && (e.scope || '') === 'auto-clean') || !!acOf(e);
  function canUndo(e) {
    const a = acOf(e);
    return !!(a && a.runId && !a.dryRun && !a.undoneAt && !a.purgedAt && Number(a.stagedUntil) > Date.now()
      && (e.items || []).some((it) => it && it.outcome === 'trashed'));
  }
  function timeShort(ms) {
    try { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function autoBadge(e) {
    const a = acOf(e);
    if (!a) return null;
    const pill = (cls, text) => el('span', { class: cls, style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text });
    if (a.dryRun) return pill('sp-badge-accent', a.approvedAt ? 'Preview, approved' : 'Preview');
    if (a.undoneAt) return pill('sp-badge-caution', 'Undone');
    if (canUndo(e)) return pill('sp-badge-accent', 'Undo until ' + timeShort(a.stagedUntil));
    return null;
  }
  const num = (x) => Number(x) || 0;
  const REV_TEXT = { rebuild: 'Rebuilds on next install/build', trash: 'In your Trash', none: 'Permanent', mixed: 'Mixed' };
  const REV_ICON = { rebuild: 'refresh', trash: 'trash', none: 'lock', mixed: 'info' };

  // One word for what an entry means for recovery: 'rebuild' | 'trash' |
  // 'none' | 'mixed'. Only items that were actually removed or trashed count.
  function revKind(e) {
    if (isV2(e) && Array.isArray(e.items) && e.items.length) {
      const set = new Set();
      e.items.forEach((it) => {
        if (it && (it.outcome === 'removed' || it.outcome === 'trashed') && it.reversible) set.add(it.reversible);
      });
      if (set.size > 1) return 'mixed';
      if (set.size === 1) return Array.from(set)[0];
    }
    if (typeof e.reversible === 'string' && REV_TEXT[e.reversible]) return e.reversible;
    if (isV2(e)) return 'none';
    return e.reversible ? 'rebuild' : 'none';
  }

  // Outcome counts for a v2 entry. Falls back to e.count when items are absent.
  function counts(e) {
    const items = Array.isArray(e.items) ? e.items : [];
    const c = { removed: 0, trashed: 0, failed: 0, refused: 0 };
    if (items.length && typeof items[0] === 'object') {
      items.forEach((it) => { if (it && c[it.outcome] != null) c[it.outcome] += 1; });
      // Items beyond the stored cap are not in the list: trust entry totals.
      if (e.itemsTruncated || c.failed + c.refused === 0) {
        c.failed = Math.max(c.failed, num(e.failedCount));
        c.refused = Math.max(c.refused, num(e.refusedCount));
      }
      const done = num(e.count);
      if (done > c.removed + c.trashed) c.removed += done - (c.removed + c.trashed);
      return c;
    }
    c.removed = num(e.count);
    c.failed = num(e.failedCount);
    c.refused = num(e.refusedCount);
    return c;
  }

  function statusBadge(e) {
    if (e.status === 'interrupted') return el('span', { class: 'sp-badge-warn', style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text: 'Interrupted' });
    if (e.status === 'started') return el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text: 'In progress' });
    return null;
  }

  // Relative time for recent events, readable date for older ones.
  function whenOf(ms) {
    if (!ms) return 'unknown time';
    const diff = Date.now() - ms;
    const s = Math.floor(diff / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) { const m = Math.floor(s / 60); return m + (m === 1 ? ' minute ago' : ' minutes ago'); }
    if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    if (s < 7 * 86400) { const d = Math.floor(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    try {
      return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
      return new Date(ms).toDateString();
    }
  }

  function header(host, onClear) {
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'History' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px', text: 'A log of everything Spaci has cleaned and freed.' })
        ]),
        el('button', {
          style: 'height:40px;padding:0 15px;border-radius:10px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;flex:none',
          hov: 'background:var(--panel);color:var(--text)',
          onclick: onClear
        }, [ic('trash', 15), 'Clear log'])
      ])
    );
  }

  // Short "last clean" label for the stat strip: Today / Yesterday / a date.
  function lastCleanLabel(ms) {
    if (!ms) return 'Never';
    const now = new Date();
    const then = new Date(ms);
    const day = 86400000;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startToday) return 'Today';
    if (ms >= startToday - day) return 'Yesterday';
    try {
      return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      return then.toDateString();
    }
  }

  // Summary strip (border top + bottom): total freed, clean-up count, last clean.
  function statsStrip(host, list) {
    const totalFreed = list.reduce((a, e) => a + (Number(e.freed) || 0), 0);
    const newest = list.reduce((a, e) => Math.max(a, Number(e.at) || 0), 0);
    const stats = [
      { icon: 'hard-drive', label: 'Total freed', value: fmt(totalFreed), color: 'var(--accent-fg)' },
      { icon: 'log', label: 'Clean-ups', value: String(list.length), color: 'var(--text)' },
      { icon: 'clock', label: 'Last clean', value: lastCleanLabel(newest), color: 'var(--text)' }
    ];
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 32px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:24px' },
        stats.map((s) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text-2)' }, [
          ic(s.icon, 16, { color: 'var(--text-3)' }),
          el('span', { text: s.label }),
          el('b', { style: 'color:' + s.color + ';font-weight:700', text: s.value })
        ])))
    );
  }

  // Small uppercase section label, matching the design's section headers.
  function sectionLabel(text) {
    return el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: text });
  }

  // The big centered live hero. Driven ONLY by a real S.activeClean object
  // ({ label, sub, percent, freed }); never fabricated. Shows an animated
  // spaci-ring, a "cleaning" badge, a subtitle, and a progress bar.
  function ongoingHero(ac) {
    const percent = Math.max(0, Math.min(100, Number(ac.percent) || 0));
    return el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px;padding:46px 24px;min-height:252px;margin-bottom:24px' }, [
      el('div', { style: 'color:var(--accent-fg)' }, [ring('spin', 52)]),
      el('div', {}, [
        el('div', { style: 'font-size:19px;font-weight:700;letter-spacing:-.4px;display:flex;align-items:center;gap:10px;justify-content:center' }, [
          el('span', { text: ac.label || 'Cleaning' }),
          el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:3px 10px;border-radius:7px;font-size:11px;font-weight:700', text: 'cleaning' })
        ]),
        ac.sub ? el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px', text: ac.sub }) : null
      ]),
      el('div', { style: 'width:100%;max-width:440px' }, [
        el('div', { style: 'height:8px;border-radius:99px;background:var(--track);overflow:hidden' }, [
          el('span', { style: 'display:block;height:100%;width:' + percent + '%;border-radius:99px;background:var(--accent);transition:width .3s' })
        ]),
        el('div', { style: 'display:flex;justify-content:space-between;margin-top:10px;font-size:12.5px;color:var(--text-3)' }, [
          el('span', { text: percent + '% complete' }),
          el('span', {}, [el('b', { style: 'color:var(--accent-fg);font-weight:700', text: fmt(ac.freed) }), ' freed so far'])
        ])
      ])
    ]);
  }

  // The ONGOING section is HONEST: it renders only when there is REAL live
  // activity. activeClean (optional global object) -> centered hero;
  // S.bgScanning (background scan running in the main process) -> the SHARED
  // scan card (identical to Projects/System/Large Files). A background scan has
  // no live counts, so it is indeterminate (percent null). History re-renders
  // via app.js refresh() on bg:scan events, so no progress subscription is
  // needed here, we just read S.bgScanning at render time. When idle, the whole
  // section is omitted.
  function ongoingSection(host) {
    const ac = S.activeClean;
    const scanning = !!S.bgScanning;
    if (!ac && !scanning) return;

    host.appendChild(sectionLabel('Ongoing'));
    if (ac) host.appendChild(ongoingHero(ac));
    if (scanning) {
      host.appendChild(
        SP.scanCard({ label: 'Scanning your Mac', sub: 'Indexing in the background', percent: null }).node
      );
    }
  }

  function row(e) {
    const rk = revKind(e);
    const c = counts(e);
    const parts = [];
    if (isV2(e)) {
      if (c.removed) parts.push(c.removed + ' removed');
      if (c.trashed) parts.push(c.trashed + (isAuto(e) ? ' set aside' : ' trashed'));
      if (c.failed) parts.push(c.failed + ' failed');
      if (c.refused) parts.push(c.refused + (isAuto(e) ? ' left or put back' : ' left alone'));
      if (acOf(e) && acOf(e).dryRun) { parts.length = 0; parts.push('would move ' + num(acOf(e).previewCount) + (num(acOf(e).previewCount) === 1 ? ' item' : ' items') + ', nothing moved'); }
      if (!parts.length) parts.push('0 ' + itemNoun(e, 0));
    } else {
      const count = num(e.count);
      parts.push(count + ' ' + itemNoun(e, count));
    }
    const meta = parts.join(', ') + ' · ' + whenOf(e.at);

    return el('div', {
      class: 'sp-hov',
      style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-sm);transition:border-color .16s,transform .16s;cursor:pointer',
      hov: 'border-color:var(--border-2);transform:translateX(2px)',
      onclick: () => { S.currentHistory = e; SP.go('historydetail'); }
    }, [
      el('div', { style: 'width:52px;height:52px;border-radius:14px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [entryMark(e, 24)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
          el('span', { text: titleOf(e) }),
          // A preview removed nothing, so it has no recovery badge.
          isPreview(e) ? null : el('span', {
            class: rk === 'none' ? 'sp-badge-warn' : rk === 'mixed' ? 'sp-badge-caution' : 'sp-badge-safe',
            style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
            text: REV_TEXT[rk]
          }),
          statusBadge(e),
          autoBadge(e)
        ]),
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: meta })
      ]),
      el('div', { style: 'font-weight:700;font-size:15px;flex:none;color:' + (isPreview(e) ? 'var(--text-3)' : 'var(--accent-fg)'), text: rowFigure(e) }),
      isPreview(e) ? ic('eye', 17, { color: 'var(--text-4)' }) : ic(REV_ICON[rk], 17, { color: 'var(--text-4)' }),
      ic('chevron-right', 18, { color: 'var(--text-4)' })
    ]);
  }

  // Freed space, or for an auto-clean still in staging, what it set aside.
  function rowFigure(e) {
    const a = acOf(e);
    if (a && a.dryRun) return fmt(num(a.previewBytes));
    if (isAuto(e) && !num(e.freed) && num(e.trashedBytes)) return fmt(num(e.trashedBytes));
    return fmt(e.freed);
  }

  function emptyState(host) {
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:64px 24px;min-height:320px' }, [
        // Animated brand logo, not a static icon.
        el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
        el('div', {}, [
          el('div', { style: 'font-size:19px;font-weight:700;letter-spacing:-.4px', text: 'Nothing cleaned yet' }),
          el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px;max-width:380px', text: 'Once you reclaim space with Spaci, every cleanup shows up here with what was freed and what happened to each item.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--accent-hover)',
          onclick: () => { SP.go('dashboard'); if (window.SP_doScan) window.SP_doScan(); }
        }, [ic('scanner', 16), 'Scan'])
      ])
    );
  }

  function loadingState(host) {
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px;padding:64px 24px;min-height:300px;color:var(--accent-fg)' }, [
        ring('orbit', 56),
        el('div', { style: 'color:var(--text-3);font-size:13.5px', text: 'Loading history.' })
      ])
    );
  }

  function errorState(host, msg) {
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:13px;padding:18px 20px;border-radius:14px;background:var(--danger-soft);border:1px solid var(--border);color:var(--danger-fg)' }, [
        ic('info', 20),
        el('div', { style: 'font-size:13.5px;font-weight:600', text: msg || 'Could not load history.' })
      ])
    );
  }

  // Render the populated screen (header + stats + ongoing + completed list).
  function renderList(host, list) {
    header(host, () => clearLog(host));
    statsStrip(host, list);
    ongoingSection(host); // only appears when there is real live activity
    host.appendChild(sectionLabel('Completed'));
    host.appendChild(el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' }, list.map(row)));
  }

  async function clearLog(host) {
    let ok = true;
    try {
      ok = await SP.confirm({
        title: 'Clear history log?',
        body: 'This empties the record of past cleanups. It does not touch or restore any files on disk.',
        confirmLabel: 'Clear log',
        danger: true,
        icon: 'trash'
      });
    } catch (_) { ok = true; }
    if (!ok) return;
    try {
      await window.api.historyClear();
    } catch (err) {
      console.error('[history] clear failed', err && err.message);
    }
    if (SP.toast) SP.toast('History cleared', 'The cleanup log is now empty');
    // Re-render from a clean slate (now the empty state).
    host.textContent = '';
    SP.screens.history(host);
  }

  SP.screens.history = function (host) {
    loadingState(host);
    (async () => {
      let list = [];
      try {
        const res = await window.api.historyGet();
        list = Array.isArray(res) ? res : [];
      } catch (err) {
        console.error('[history] get failed', err && err.message);
        host.textContent = '';
        header(host, () => clearLog(host));
        errorState(host, 'Could not load history. ' + ((err && err.message) || ''));
        return;
      }
      host.textContent = '';
      if (!list.length) {
        header(host, () => clearLog(host));
        // Surface live activity (background scan / active clean) even before any
        // history has been recorded; otherwise show the animated empty state.
        ongoingSection(host);
        emptyState(host);
        return;
      }
      // Newest first (entries are unshifted by the backend, but guard anyway).
      list = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      renderList(host, list);
    })();
  };

  // ============================================================
  //  HISTORY DETAIL  (matches data-screen-label="Action detail")
  // ============================================================
  // Absolute date + time for a single cleanup (the row list uses relative
  // times, but the detail page wants the exact moment it happened).
  function whenExact(ms) {
    if (!ms) return 'unknown time';
    try {
      return new Date(ms).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch (_) {
      return new Date(ms).toString();
    }
  }

  // Pick a folder vs file icon for a cleaned path: treat anything with a dotted
  // last segment as a file, otherwise a folder. Large-file cleanups are files.
  function pathIcon(e, p) {
    const scope = (e.scope || '').toLowerCase();
    if (scope === 'largefiles' || scope === 'large-files') return 'file';
    const s = String(p || '');
    if (s.endsWith('/')) return 'folder';
    const last = s.split('/').pop() || '';
    return last.indexOf('.') > 0 ? 'file' : 'folder';
  }

  // Recovery note. Spaci never restores files itself: it only says where they
  // went and how to get them back.
  function restoreCopy(e, rk) {
    const scope = (e.scope || '').toLowerCase();
    const a = acOf(e);
    if (a && !a.dryRun) {
      if (a.purgedAt) return { title: 'Removed', text: 'The 24 hours to undo this run passed, so Spaci removed what it had set aside and the space was freed. Each item below lists how to rebuild it.' };
      return { title: 'Set aside for 24 hours', text: 'Auto-clean moved these into a Spaci folder on the same disk. They come back with Undo until ' + whenExact(a.stagedUntil) + '. After that the space is freed, and each item below lists how to rebuild it.' };
    }
    if (rk === 'none') {
      return {
        title: 'Permanent',
        text: 'Items marked Permanent were removed for good. Spaci cannot bring them back, and there is nothing in the Trash to restore.'
      };
    }
    if (rk === 'trash') {
      return {
        title: 'In your Trash',
        text: 'These files are in your Trash. Restore them from Finder or the Recycle Bin. The space comes back only when you empty the Trash.'
      };
    }
    if (rk === 'mixed') {
      return {
        title: 'Mixed results',
        text: 'Some items are in your Trash, some rebuild on your next install or build, and some are permanent. Each item below says which.'
      };
    }
    if (!isV2(e)) {
      return {
        title: 'Rebuilds on next install/build',
        text: scope === 'system'
          ? 'This entry is from an older version of Spaci, which did not record individual items. Caches regenerate when the apps that own them run.'
          : 'This entry is from an older version of Spaci, which did not record individual items. Build artifacts come back when you re-run your install or build.'
      };
    }
    return {
      title: 'Rebuilds on next install/build',
      text: scope === 'system'
        ? 'Spaci does not restore files. These caches regenerate automatically when the apps that own them run.'
        : 'Spaci does not restore files. Re-run your install or build to bring these back. Each item below lists the command.'
    };
  }

  const PAGE = 100;

  function outcomeBadge(outcome, e, it) {
    if (e && isAuto(e) && it) {
      if (outcome === 'trashed') return el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:2px 8px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none', text: 'Set aside' });
      if (outcome === 'refused' && it.reason === 'Put back by Undo.') return el('span', { class: 'sp-badge-safe', style: 'display:inline-flex;padding:2px 8px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none', text: 'Put back' });
    }
    const map = {
      removed: ['sp-badge-safe', 'Removed'],
      trashed: ['sp-badge-accent', 'Trashed'],
      failed: ['sp-badge-warn', 'Failed'],
      refused: ['sp-badge-warn', 'Left alone']
    };
    const m = map[outcome];
    if (!m) return null;
    return el('span', { class: m[0], style: 'display:inline-flex;padding:2px 8px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none', text: m[1] });
  }

  function itemNote(it, e) {
    if (e && isAuto(e)) {
      if (it.outcome === 'trashed') {
        const a = acOf(e);
        // A partly moved item (auto-clean.js runAutoClean) says what happened.
        const part = it.partial && it.reason ? ' ' + it.reason : '';
        return { text: (a && a.purgedAt ? 'Removed after 24 hours.' : 'Set aside by auto-clean. Undo puts it back.') + part, raw: '' };
      }
      if (it.outcome === 'refused' && it.reason === 'Put back by Undo.') return { text: 'Put back where it was by Undo.', raw: '' };
    }
    if (it.outcome === 'failed') {
      // A known error code gets plain English; otherwise the recorded reason is
      // already written for people (interrupted, trash failed), so show it as is.
      const mapped = SP.plainError ? SP.plainError({ code: it.code, error: it.reason || '' }) : '';
      const text = mapped && mapped !== 'Could not be removed.' ? mapped : (it.reason || 'Could not be removed.');
      return { text, raw: it.reason || '' };
    }
    if (it.outcome === 'refused') {
      return { text: it.reason === 'needs-confirmation' ? 'Needed your confirmation.' : (it.reason || 'Spaci left this alone.'), raw: '' };
    }
    if (it.outcome === 'trashed') return { text: 'In your Trash: restore from Finder/Recycle Bin.', raw: '' };
    return null;
  }

  // One item row. Every value is set as text, never as HTML.
  function itemRow(e, it) {
    const obj = it && typeof it === 'object';
    const path = obj ? it.path : it;
    const children = [
      itemMark(e, it, obj && it.kind === 'file' ? 'file' : obj && it.kind === 'trash' ? 'trash' : pathIcon(e, path), 18),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { class: 'mono', title: String(path || ''), style: 'font-size:12.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: String(path || '') })
      ])
    ];
    if (obj) {
      const box = children[1];
      const note = itemNote(it, e);
      const rk = it.outcome === 'removed' || it.outcome === 'trashed' ? it.reversible : null;
      if (note) box.appendChild(el('div', { title: note.raw, style: 'color:var(--text-3);font-size:12px;margin-top:3px;line-height:1.5', text: note.text }));
      if (rk && REV_TEXT[rk] && it.outcome !== 'trashed') box.appendChild(el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:3px', text: REV_TEXT[rk] }));
      if (it.restoreHint && (it.outcome === 'removed' || (isAuto(e) && it.outcome === 'trashed'))) {
        box.appendChild(el('div', { class: 'mono', style: 'color:var(--text-2);font-size:12px;margin-top:4px;white-space:pre-wrap;word-break:break-word', text: String(it.restoreHint) }));
      }
      children.push(outcomeBadge(it.outcome, e, it));
      if (it.bytes != null) children.push(el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;flex:none', text: fmt(num(it.bytes)) }));
    }
    return el('div', { style: 'display:flex;align-items:center;gap:13px;padding:12px 15px;border-radius:12px;background:var(--panel);border:1px solid var(--border)' }, children);
  }

  async function reopen(id) {
    try {
      const list = await window.api.historyGet();
      const fresh = (Array.isArray(list) ? list : []).find((x) => x && x.id === id);
      if (fresh) S.currentHistory = fresh;
    } catch (_) {}
    if (S.route === 'historydetail') SP.go('historydetail');
  }

  let undoBusy = false;
  async function undoRun(e) {
    const a = acOf(e);
    if (undoBusy || !a || !window.api.autoCleanUndo) return;
    const staged = (e.items || []).filter((it) => it && it.outcome === 'trashed');
    const ok = await SP.confirm({
      title: 'Undo this auto-clean?',
      body: 'Spaci puts ' + staged.length + (staged.length === 1 ? ' item' : ' items') + ' (' + fmt(e.trashedBytes) + ') back where they were.\n\nAnything you rebuilt since stays as it is: Spaci keeps the new copy and removes the old one after 24 hours.',
      confirmLabel: 'Undo',
      icon: 'undo',
    });
    if (!ok) return;
    undoBusy = true;
    SP.go('historydetail');
    let res;
    try { res = await window.api.autoCleanUndo(a.runId); } catch (err) { res = { ok: false, error: (err && err.message) || 'Undo failed' }; }
    undoBusy = false;
    if (res && res.restored != null && (res.ok || res.restored > 0)) {
      const extra = res.conflicts ? ' ' + res.conflicts + ' already rebuilt, kept as they are.' : '';
      SP.toast('Put back ' + res.restored + (res.restored === 1 ? ' item' : ' items'), ('Auto-clean was undone.' + extra).trim());
    } else {
      S.reportCfg = { tone: 'danger', title: 'Could not undo', lead: ((res && res.error) || 'Undo failed') + '.', groups: [], errors: [] };
      SP.go('historydetail');
    }
    await reopen(e.id);
  }

  let approveState = { id: null, pending: null, loading: false };
  function loadApproveState(e) {
    if (!window.api.autoCleanGet || approveState.loading || approveState.id === e.id) return;
    approveState = { id: e.id, pending: null, loading: true };
    window.api.autoCleanGet().then((st) => {
      approveState = { id: e.id, pending: st && st.pendingPreview, enabled: !!(st && st.settings && st.settings.enabled), loading: false };
      if (S.route === 'historydetail' && S.currentHistory && S.currentHistory.id === e.id) SP.go('historydetail');
    }).catch(() => { approveState.loading = false; });
  }
  async function approve(e) {
    let res;
    try { res = await window.api.autoCleanApprove(e.id); } catch (err) { res = { ok: false, error: err && err.message }; }
    if (res && res.ok) SP.toast('Auto-clean approved', 'It runs when your computer is idle on AC power. Each run can be undone for 24 hours.');
    else SP.toast('Not approved', (res && res.error) || 'Try again.');
    approveState = { id: null };
    await reopen(e.id);
  }
  async function turnOff(e) {
    try { await window.api.autoCleanSet({ enabled: false }); } catch (_) {}
    SP.toast('Auto-clean is off', 'Nothing will be moved. Turn it on again in Settings.');
    approveState = { id: null };
    await reopen(e.id);
  }

  function btnStyle(primary) {
    return 'height:40px;padding:0 16px;border-radius:11px;font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;' +
      (primary ? 'border:none;background:var(--accent);color:var(--on-accent)' : 'border:1px solid var(--border-2);background:var(--panel-2);color:var(--text)');
  }

  function autoCleanCard(e) {
    const a = acOf(e);
    if (!a) return null;
    const box = (kids) => el('div', { 'data-autoclean-card': '', style: 'padding:18px 20px;border-radius:16px;background:var(--accent-soft);border:1px solid var(--border);margin-bottom:20px' }, kids);
    if (a.dryRun) {
      loadApproveState(e);
      // An empty preview is never approvable (main refuses it too).
      const pending = approveState.id === e.id && approveState.pending === e.id && num(a.previewCount) > 0;
      const kids = [
        el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: 'Preview only. Nothing was moved.' }),
        el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: num(a.previewCount)
          ? 'With your current rules, auto-clean would set aside ' + fmt(num(a.previewBytes)) + ' from ' + num(a.previewCount) + (num(a.previewCount) === 1 ? ' item' : ' items') + '. Approve to let it run when your computer is idle on AC power. Every run can be undone for 24 hours.'
          : 'Nothing matched your rules, so there is nothing to approve. A new preview runs later.' }),
      ];
      if (a.approvedAt) kids.push(el('div', { style: 'color:var(--success-fg);font-size:13px;font-weight:600;margin-top:10px', text: 'Approved ' + whenExact(a.approvedAt) + '.' }));
      else if (pending) {
        kids.push(el('div', { style: 'display:flex;gap:10px;margin-top:14px' }, [
          el('button', { 'data-approve': '', style: btnStyle(true), hov: 'background:var(--accent-hover)', onclick: () => approve(e) }, [ic('check', 15), 'Approve auto-clean']),
          el('button', { style: btnStyle(false), hov: 'background:var(--panel-3)', onclick: () => turnOff(e) }, ['Turn off auto-clean']),
        ]));
      } else if (approveState.id === e.id && !approveState.loading && num(a.previewCount) > 0) {
        kids.push(el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:10px', text: 'This preview is out of date. A newer one runs with your current rules.' }));
      }
      const list = el('div', { style: 'display:flex;flex-direction:column;gap:7px;margin-top:16px' });
      (Array.isArray(a.preview) ? a.preview : []).slice(0, 100).forEach((pv) => {
        list.appendChild(el('div', { style: 'display:flex;align-items:center;gap:13px;padding:11px 14px;border-radius:12px;background:var(--panel);border:1px solid var(--border)' }, [
          itemMark(e, pv, 'folder', 18),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { class: 'mono', title: pv.path, style: 'font-size:12.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: pv.path }),
            el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: pv.rule || pv.group || '' }),
          ]),
          SP.tiers ? SP.tiers.pill('A') : null,
          el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;flex:none', text: fmt(num(pv.bytes)) }),
        ]));
      });
      kids.push(list);
      return box(kids);
    }
    if (a.undoneAt) {
      return box([
        el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: 'Undone' }),
        el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: 'Undone ' + whenExact(a.undoneAt) + ': ' + num(a.restored) + ' put back' + (num(a.conflicts) ? ', ' + num(a.conflicts) + ' kept as you rebuilt them' : '') + (num(a.undoFailed) ? ', ' + num(a.undoFailed) + ' could not be moved back' : '') + '.' }),
      ]);
    }
    if (canUndo(e)) {
      return box([
        el('div', { style: 'display:flex;align-items:center;gap:16px' }, [
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: 'You can undo this until ' + whenExact(a.stagedUntil) }),
            el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: 'Undo moves everything below back where it was. After that the space is freed for good.' }),
          ]),
          el('button', { 'data-undo': '', style: btnStyle(true) + (undoBusy ? ';opacity:.6;pointer-events:none' : ''), hov: 'background:var(--accent-hover)', onclick: () => undoRun(e) }, [undoBusy ? ring('elastic', 15) : ic('undo', 15), undoBusy ? 'Putting back…' : 'Undo this auto-clean']),
        ]),
      ]);
    }
    return null;
  }

  SP.screens.historydetail = function (host) {
    const e = S.currentHistory;
    if (!e) { SP.go('history'); return; }

    const rk = revKind(e);
    const c = counts(e);
    const count = num(e.count);
    const items = Array.isArray(e.items) ? e.items : [];
    const extra = num(e.itemsTruncated);
    const note = restoreCopy(e, rk);

    // back button -> History
    host.appendChild(
      el('button', {
        style: 'height:36px;padding:0 13px 0 11px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
        hov: 'background:var(--panel);color:var(--text)',
        onclick: () => SP.go('history')
      }, [ic('chevron-left', 16), 'History'])
    );

    // header: scope icon + name + badge + when + freed total
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:22px' }, [
        el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [entryMark(e, 31)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px;flex-wrap:wrap' }, [
            el('span', { text: titleOf(e) }),
            isPreview(e) ? null : el('span', {
              class: rk === 'none' ? 'sp-badge-warn' : rk === 'mixed' ? 'sp-badge-caution' : 'sp-badge-safe',
              style: 'display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;font-size:11.5px;font-weight:700'
            }, [ic(REV_ICON[rk], 13), REV_TEXT[rk]]),
            statusBadge(e),
            autoBadge(e)
          ]),
          el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:5px', text: whenExact(e.at) })
        ]),
        el('div', { style: 'font-weight:700;font-size:26px;letter-spacing:-1px;color:var(--accent-fg);flex:none', text: fmt(e.freed) })
      ])
    );

    // stats strip: space freed / outcome counts / when
    const detailStats = [{ icon: 'hard-drive', label: 'Space freed', value: fmt(e.freed), color: 'var(--accent-fg)' }];
    // Trashed files are not freed until the Trash is emptied; show them apart.
    if (Number(e.trashedBytes) > 0) detailStats.push({ icon: isAuto(e) ? 'clock' : 'trash', label: isAuto(e) ? 'Set aside' : 'In your Trash', value: fmt(e.trashedBytes), color: 'var(--text)' });
    if (isV2(e)) {
      detailStats.push({ icon: 'check', label: 'Removed', value: String(c.removed), color: 'var(--text)' });
      if (c.trashed) detailStats.push({ icon: isAuto(e) ? 'clock' : 'trash', label: isAuto(e) ? 'Set aside' : 'Trashed', value: String(c.trashed), color: 'var(--text)' });
      if (c.failed) detailStats.push({ icon: 'warning', label: 'Failed', value: String(c.failed), color: 'var(--danger-fg)' });
      if (c.refused) detailStats.push({ icon: 'info', label: 'Left alone', value: String(c.refused), color: 'var(--text)' });
    } else {
      detailStats.push({ icon: 'box', label: 'Items', value: String(count), color: 'var(--text)' });
    }
    detailStats.push({ icon: 'clock', label: 'When', value: whenOf(e.at), color: 'var(--text)' });
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 32px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:22px' },
        detailStats.map((st) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text-2)' }, [
          ic(st.icon, 16, { color: 'var(--text-3)' }),
          el('span', { text: st.label }),
          el('b', { style: 'color:' + st.color + ';font-weight:700', text: st.value })
        ])))
    );

    // auto-clean: the dry run to approve, or the run to undo
    const acCard = autoCleanCard(e);
    if (acCard) {
      host.appendChild(acCard);
      if (acOf(e).dryRun) return; // a preview has no items, only its list above
    }

    // interrupted banner
    if (e.status === 'interrupted') {
      host.appendChild(
        el('div', { style: 'display:flex;align-items:flex-start;gap:14px;padding:16px 20px;border-radius:16px;background:var(--warn-soft);border:1px solid var(--border);margin-bottom:16px' }, [
          ic('warning', 22, { color: 'var(--warn-fg)' }),
          el('div', { style: 'flex:1' }, [
            el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: 'Interrupted' }),
            el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: 'Spaci closed before this cleanup finished. Some of the items below may not have been removed, and the freed figure may be incomplete. Run a scan to see what is left.' })
          ])
        ])
      );
    }

    // recovery note card (text only: Spaci does not restore anything)
    const noteLines = [
      el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: note.title }),
      el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: note.text })
    ];
    if (e.restoreHint) {
      noteLines.push(el('div', { class: 'mono', style: 'color:var(--text-2);font-size:12.5px;margin-top:8px;white-space:pre-wrap;word-break:break-word', text: String(e.restoreHint) }));
    }
    host.appendChild(
      el('div', {
        style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:16px;background:' + (rk === 'none' ? 'var(--panel)' : 'var(--accent-soft)') + ';border:1px solid var(--border);margin-bottom:20px'
      }, [
        el('div', { style: 'flex:none;color:var(--accent-fg);margin-top:2px' }, [ic(REV_ICON[rk], 22)]),
        el('div', { style: 'flex:1' }, noteLines)
      ])
    );

    // list of cleaned items / paths, with the true total and a Show all
    const total = items.length + extra;
    const listHost = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:7px' });
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: 'Items' + (total ? ' (' + total + ')' : '') }));

    if (!items.length) {
      host.appendChild(
        el('div', { style: 'padding:18px 20px;border-radius:14px;background:var(--panel);border:1px solid var(--border);color:var(--text-3);font-size:13px', text: 'No individual paths were recorded for this cleanup.' })
      );
      return;
    }
    let shown = 0;
    const more = el('div', {});
    function renderMore(all) {
      const end = all ? items.length : Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) listHost.appendChild(itemRow(e, items[shown]));
      more.textContent = '';
      if (shown < items.length) {
        more.appendChild(el('button', {
          style: 'margin-top:10px;height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel-3)',
          onclick: () => renderMore(true)
        }, ['Show all ' + items.length + ' (showing ' + shown + ')']));
      } else if (extra) {
        more.appendChild(el('div', { style: 'margin-top:10px;color:var(--text-3);font-size:12.5px', text: 'Spaci keeps the first ' + items.length + ' items of this cleanup. ' + extra + ' more were processed but are not listed.' }));
      }
    }
    host.appendChild(listHost);
    host.appendChild(more);
    renderMore(false);
  };
})();
