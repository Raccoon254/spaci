'use strict';
/* Storage screen + Storage category detail, Spaci v2.
   Faithful to design/spaci-v2-reference.html (data-screen-label="Storage" and
   data-screen-label="Storage category"), wired to window.api.diskUsage() and
   window.api.diskBreakdown(). The backend returns category summaries only (no
   per-file detail), so the detail view shows the category summary plus a note. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  const COLORS = ['#5e93dd', '#4fcb93', '#e8a14f', '#c77dff', '#e8836f', '#7fb5c9', '#8b867f'];

  // Per-category presentation (icon + one-line description). Falls back to a
  // generic folder icon for any unexpected key.
  const META = {
    developer: { icon: 'code', desc: 'Code, build caches and SDKs.' },
    applications: { icon: 'grid', desc: 'Installed applications.' },
    appdata: { icon: 'database', desc: 'Per-app data and containers.' },
    caches: { icon: 'broom', desc: 'Regenerable cache and log files.' },
    media: { icon: 'image', desc: 'Photos, video and music.' },
    documents: { icon: 'document-text', desc: 'Files on your Desktop and in Documents.' },
    downloads: { icon: 'download', desc: 'Everything saved from the web.' },
    mail: { icon: 'bell', desc: 'Mail and Messages storage.' },
    system: { icon: 'cpu', desc: 'macOS and other system files.' },
    other: { icon: 'folder', desc: 'Everything else on this disk.' }
  };
  // Prefer the icon/hint the backend now sends with each category, falling
  // back to the static map for any older key.
  function metaFor(c) {
    const key = c && c.key;
    const base = META[key] || { icon: 'folder', desc: 'Files on this disk.' };
    if (c && (c.icon || c.hint)) return { icon: c.icon || base.icon, desc: c.hint || base.desc };
    return base;
  }

  // ---------- data loading ----------
  // S.disk is { total, used, avail, capacity }; S.breakdown is
  // { total, used, free, categories }. Both are preloaded at boot, but we
  // refetch defensively if either is missing, showing a loading ring meanwhile.

  function ensureData() {
    if (S.storageLoading) return false;
    if (S.disk && S.breakdown) return true;
    S.storageLoading = true;
    Promise.resolve()
      .then(async () => {
        try { if (!S.disk) S.disk = await window.api.diskUsage(); } catch (_) {}
        try { if (!S.breakdown) S.breakdown = await window.api.diskBreakdown(); } catch (_) {}
      })
      .finally(() => {
        S.storageLoading = false;
        // Re-render whichever storage route the user is still on.
        if (S.route === 'storage' || S.route === 'storagecat') SP.go(S.route);
      });
    return false;
  }

  function loadingState(host, label) {
    host.appendChild(
      el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:55vh;gap:18px;color:var(--text-3)'
      }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
        el('div', { style: 'font-size:15px;font-weight:600;color:var(--text-2)', text: label || 'Measuring your disk…' })
      ])
    );
  }

  function errorState(host, label, onBack) {
    host.appendChild(
      el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:50vh;gap:14px;color:var(--text-3)'
      }, [
        el('div', { style: 'color:var(--text-4)' }, [ic('alert-triangle', 46)]),
        el('div', { style: 'font-size:18px;font-weight:700;color:var(--text)', text: 'Storage data unavailable' }),
        el('div', { style: 'font-size:14px;max-width:360px', text: label || 'We could not read your disk usage. Try again in a moment.' }),
        onBack && el('button', {
          style: 'margin-top:6px;height:40px;padding:0 18px;border-radius:11px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:14px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel-2)',
          onclick: onBack
        }, ['Back'])
      ])
    );
  }

  // ---------- STORAGE SCREEN ----------
  SP.screens.storage = function (host) {
    if (!ensureData()) { loadingState(host); return; }

    const bd = S.breakdown;
    const disk = S.disk || {};
    // Prefer breakdown totals (richer); fall back to diskUsage. diskUsage
    // exposes `avail`, diskBreakdown exposes `free`.
    const total = Number((bd && bd.total) || disk.total || 0);
    const used = Number((bd && bd.used) || disk.used || 0);
    const free = Number((bd && bd.free != null ? bd.free : disk.avail) || 0);
    const cats = (bd && Array.isArray(bd.categories) ? bd.categories : []).filter((c) => c && c.bytes > 0);

    if (!total && !cats.length) { errorState(host); return; }

    const pctUsed = total ? Math.round((used / total) * 100) : 0;
    // Largest category drives the proportional bars in the browsable list.
    const maxCat = cats.reduce((m, c) => Math.max(m, c.bytes), 0) || 1;

    // header
    host.appendChild(el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'Storage' }));
    host.appendChild(el('div', {
      style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px;margin-bottom:30px',
      text: 'A clear picture of where your ' + fmt(total) + ' has gone. Hover any segment to inspect it.'
    }));

    // stat strip
    const stats = [
      { icon: 'hard-drive', label: 'Total', value: fmt(total), color: 'var(--text)' },
      { icon: 'chart', label: 'Used', value: fmt(used), color: 'var(--accent-fg)' },
      { icon: 'check-circle', label: 'Free', value: fmt(free), color: '#4fcb93' }
    ];
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 34px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:26px' },
        stats.map((s) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:14px;color:var(--text-2)' }, [
          ic(s.icon, 16, { color: 'var(--text-3)' }),
          el('span', { text: s.label }),
          el('b', { style: 'color:' + s.color + ';font-weight:700;letter-spacing:-.2px', text: s.value })
        ]))
      )
    );

    // capacity bar heading
    host.appendChild(
      el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600', text: 'Disk usage' }),
        el('div', { style: 'font-size:13px;color:var(--text-3)' }, [
          el('b', { style: 'color:var(--text);font-weight:700', text: pctUsed + '% used' }),
          el('span', { text: ' of ' + fmt(total) })
        ])
      ])
    );

    // full-width segmented capacity bar
    host.appendChild(
      el('div', { style: 'display:flex;height:60px;border-radius:14px;overflow:hidden;background:var(--track)' },
        cats.map((c, i) => {
          const barPct = total ? (c.bytes / total) * 100 : 0;
          return el('div', {
            style: 'height:100%;background:' + COLORS[i % COLORS.length] + ';width:' + barPct + '%;flex:none;border-right:2px solid var(--bg);transition:filter .15s;cursor:pointer',
            hov: 'filter:brightness(1.18)',
            title: c.label + '  ' + fmt(c.bytes),
            onclick: () => openCat(c, i)
          });
        })
      )
    );

    // legend
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:13px 26px;margin-top:18px' },
        cats.map((c, i) => el('div', { style: 'display:flex;align-items:center;gap:9px' }, [
          el('span', { style: 'width:11px;height:11px;border-radius:4px;background:' + COLORS[i % COLORS.length] + ';flex:none' }),
          el('span', { style: 'font-size:13px;font-weight:600', text: c.label }),
          el('span', { style: 'font-size:13px;color:var(--text-3);font-variant-numeric:tabular-nums', text: fmt(c.bytes) })
        ]))
      )
    );

    // browsable categories
    host.appendChild(el('div', {
      style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:36px 0 14px',
      text: "What's using space"
    }));
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
        cats.map((c, i) => {
          const m = metaFor(c);
          const color = COLORS[i % COLORS.length];
          const pctOfDisk = total ? Math.round((c.bytes / total) * 100) : 0;
          const barPct = (c.bytes / maxCat) * 100;
          return el('div', {
            style: 'display:flex;align-items:center;gap:15px;padding:15px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer;transition:border-color .16s,transform .16s',
            hov: 'border-color:var(--border-2);transform:translateX(2px)',
            onclick: () => openCat(c, i)
          }, [
            el('div', { style: 'width:44px;height:44px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic(m.icon, 23)]),
            el('div', { style: 'flex:1;min-width:0' }, [
              el('div', { style: 'font-weight:600;font-size:14.5px', text: c.label }),
              el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: m.desc })
            ]),
            el('div', { style: 'width:132px;flex:none' }, [
              el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [
                el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + barPct + '%' })
              ]),
              el('div', { style: 'font-size:11px;color:var(--text-4);margin-top:5px;text-align:right', text: pctOfDisk + '% of disk' })
            ]),
            el('div', { style: 'font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(c.bytes) }),
            ic('chevron-right', 18, { color: 'var(--text-4)' })
          ]);
        })
      )
    );
  };

  // Store the selected category (with its color index) on state, then route.
  function openCat(cat, index) {
    S.currentCat = { key: cat.key, label: cat.label, bytes: cat.bytes, colorIndex: index };
    SP.go('storagecat');
  }

  // ---------- STORAGE CATEGORY DETAIL ----------
  SP.screens.storagecat = function (host) {
    // The backend reports each category as a single bytes total with no
    // per-file detail, so there is nothing selectable to delete here. Keep the
    // floating action bar hidden (no selection state exists for this route).
    SP.setActionBar(null);

    // back button (always available, even on loading/error states)
    const backBtn = el('button', {
      style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
      hov: 'background:var(--panel);color:var(--text)',
      onclick: () => SP.go('storage')
    }, [ic('arrow-left', 16), 'Storage']);
    host.appendChild(backBtn);

    if (!ensureData()) { loadingState(host, 'Loading category…'); return; }

    const sel = S.currentCat;
    if (!sel) { errorState(host, 'No category selected.', () => SP.go('storage')); return; }

    const bd = S.breakdown || {};
    const total = Number(bd.total || (S.disk && S.disk.total) || 0);
    // Re-resolve the live category from the breakdown (bytes may have refreshed
    // since selection); fall back to the snapshot stored on state.
    const cats = Array.isArray(bd.categories) ? bd.categories : [];
    const idx = cats.findIndex((c) => c.key === sel.key);
    const live = idx >= 0 ? cats[idx] : null;
    const bytes = live ? live.bytes : sel.bytes;
    const colorIndex = idx >= 0 ? idx : (sel.colorIndex || 0);
    const color = COLORS[colorIndex % COLORS.length];
    const m = metaFor(sel);
    const pctOfDisk = total ? Math.round((bytes / total) * 100) : 0;

    // category header
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:24px' }, [
        el('div', { style: 'width:60px;height:60px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic(m.icon, 32)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px', text: sel.label }),
          el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:4px', text: m.desc })
        ]),
        el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'font-size:26px;font-weight:700;letter-spacing:-1px;color:' + color, text: fmt(bytes) }),
          el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: pctOfDisk + '% of disk' })
        ])
      ])
    );

    // share-of-disk bar (a representation we can build from available data)
    host.appendChild(el('div', {
      style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:8px 0 14px',
      text: 'Share of disk'
    }));
    host.appendChild(
      el('div', { style: 'padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border);margin-bottom:18px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-3);margin-bottom:10px' }, [
          el('span', { text: sel.label }),
          el('span', { text: fmt(bytes) + ' of ' + fmt(total) })
        ]),
        el('div', { style: 'height:12px;border-radius:99px;background:var(--track);overflow:hidden' }, [
          el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + (total ? (bytes / total) * 100 : 0) + '%' })
        ])
      ])
    );

    // Per-file detail is not provided by the backend (the breakdown reports a
    // single bytes total per category), so we surface the summary plus a note.
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:16px;background:var(--panel-2);border:1px solid var(--border)' }, [
        el('div', { style: 'width:38px;height:38px;border-radius:10px;background:var(--panel);display:grid;place-items:center;flex:none;color:var(--text-3)' }, [ic('info', 20)]),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:600;font-size:14px', text: 'Summary only' }),
          el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:3px;line-height:1.5', text: 'Spaci measures this category as a whole and does not yet itemise individual files here. Run a Smart Scan to surface reclaimable files inside it.' })
        ])
      ])
    );
  };
})();
