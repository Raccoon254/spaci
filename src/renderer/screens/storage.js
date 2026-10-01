'use strict';
/* Storage screen + category detail, Spaci v2. Faithful to
   design/spaci-v2-reference.html (data-screen-label="Storage" lines 489-544 and
   "Storage category"), wired to window.api.diskUsage() and diskBreakdown(). */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // Resolved once and reused: the user's home dir, so item paths can be
  // shortened to a leading '~'. Cached as a Promise on shared state.
  function homeDir() {
    if (S._homeDir != null) return Promise.resolve(S._homeDir);
    if (S._homeDirP) return S._homeDirP;
    const fn = (api && (api.appHome || api.home)) || null;
    S._homeDirP = Promise.resolve(fn ? fn() : '').then((h) => {
      S._homeDir = (typeof h === 'string' && h) ? h.replace(/\/+$/, '') : '';
      return S._homeDir;
    }).catch(() => { S._homeDir = ''; return ''; });
    return S._homeDirP;
  }

  // Replace the home-dir prefix with '~'. Falls back gracefully when home
  // is unknown (shows parent dir + basename instead of the absolute path).
  function shortPath(p, home) {
    if (!p) return '';
    if (home && (p === home || p.indexOf(home + '/') === 0)) return '~' + p.slice(home.length);
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '…/' + parts.slice(-2).join('/');
  }

  const COLORS = {
    developer: '#3b6fd0', media: '#8b6bd9', applications: '#d96a8a', documents: '#2fb8a8',
    downloads: '#e0954f', caches: '#e6b85c', appdata: '#5e93dd', mail: '#7fb5c9',
    browsers: '#46b58d', xcode: '#6c7ae0', aitools: '#c77dff',
    system: '#7a8a99', other: '#8b867f'
  };
  const PALETTE = ['#3b6fd0', '#8b6bd9', '#d96a8a', '#2fb8a8', '#e0954f', '#5e93dd', '#7fb5c9', '#7a8a99'];
  // The shell's shared category map (SP.catColor) wins when present, so the
  // dashboard and this screen always colour a category the same way.
  const colorFor = (c, i) => {
    const f = SP.catColor;
    let v = null;
    try { v = typeof f === 'function' ? f(c && c.key, i) : (f && c ? f[c.key] : null); } catch (_) { v = null; }
    return typeof v === 'string' && v ? v : (COLORS[c.key] || PALETTE[i % PALETTE.length]);
  };

  // Logo for a folder that belongs to a known app (Docker, AI tools,
  // browsers), else the given glyph.
  function pathMark(p, glyph, size) {
    const B = window.SpaciBrandIcon;
    const brand = B && B.forPath ? B.forPath(p) : null;
    if (brand && SP.bic) return SP.bic(brand, size, { label: brand, fallback: glyph });
    return ic(glyph, size);
  }

  function recBytes(r) { return Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0; }

  function disk() {
    const d = S.disk || {};
    const bd = S.breakdown || {};
    const total = Number(bd.total || d.total || 0);
    const used = Number(bd.used || d.used || 0);
    const free = Number(bd.free != null ? bd.free : d.free != null ? d.free : d.avail || 0);
    const cats = (Array.isArray(bd.categories) ? bd.categories : []).filter((c) => c && c.bytes > 0);
    return { total, used, free, cats };
  }

  function loading(host, label) {
    host.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:55vh;gap:18px;color:var(--text-3)' }, [
      el('div', { style: 'color:var(--accent-fg)' }, [ring('spiral', 56)]),
      el('div', { style: 'font-size:15px;font-weight:600;color:var(--text-2)', text: label || 'Measuring your disk…' })
    ]));
  }

  function ensure() {
    if (S._storageLoading) return;
    S._storageLoading = true;
    Promise.resolve().then(async () => {
      try { if (!S.disk) S.disk = await window.api.diskUsage(); } catch (_) {}
      try { if (!S.breakdown) S.breakdown = await window.api.diskBreakdown(); } catch (_) {}
    }).finally(() => { S._storageLoading = false; if (S.route === 'storage' || S.route === 'storagecat') SP.go(S.route); measureIfStale(); });
  }

  // ---------- live measurement (os-storage) ----------
  // storageMeasure() streams snapshots while it measures: each folder shows
  // its size from the last run until the fresh one lands, so the screen fills
  // in seconds. A breakdown from before this model (no meta.version 2) or
  // older than ten minutes is measured again when the screen opens.
  const STALE_MS = 10 * 60 * 1000;
  let unsubProgress = null;
  let repaintTimer = null;
  function repaintSoon() {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (S.route === 'storage') SP.go('storage');
      else if (S.route === 'storagecat' && latestCatRender) latestCatRender();
    }, 300);
  }
  function measureNow() {
    if (!api || typeof api.storageMeasure !== 'function' || S.storageMeasuring) return;
    S.storageMeasuring = true;
    if (!unsubProgress && typeof api.onStorageProgress === 'function') {
      unsubProgress = api.onStorageProgress((snap) => {
        if (!S.storageMeasuring || !snap || !Array.isArray(snap.categories)) return;
        S.breakdown = snap;
        refreshActiveCat();
        repaintSoon();
      });
    }
    Promise.resolve(api.storageMeasure()).then((bd) => { if (bd && Array.isArray(bd.categories)) S.breakdown = bd; })
      .catch(() => {})
      .finally(() => { S.storageMeasuring = false; S.catChildren = {}; refreshActiveCat(); repaintSoon(); });
    repaintSoon();
  }
  function measureIfStale() {
    const bd = S.breakdown;
    const version = bd && bd.meta && bd.meta.version;
    const at = bd && (bd.at || (bd.meta && bd.meta.scannedAt));
    if (S._storageTriedAt && Date.now() - S._storageTriedAt < 60000) return; // a failed run does not loop
    if (!bd || version !== 2 || !at || Date.now() - at > STALE_MS) { S._storageTriedAt = Date.now(); measureNow(); }
  }
  // The open category must follow the fresh numbers, not the snapshot it was opened from.
  function refreshActiveCat() {
    if (!S.activeCat || !S.breakdown) return;
    const fresh = (S.breakdown.categories || []).find((x) => x && x.key === S.activeCat.key);
    if (fresh) S.activeCat = fresh;
  }

  // ---------- tiers, confidence, commands ----------
  const TIER = {
    A: { label: 'Regenerable', cls: 'sp-badge-safe', title: 'Tier A: regenerable, safe to clean in bulk' },
    B: { label: 'Review first', cls: 'sp-badge-caution', title: 'Tier B: regenerable, but costly to rebuild; confirm per category' },
    C: { label: 'Your data', cls: 'sp-badge-warn', title: 'Tier C: your data or irreversible; decide item by item' },
    D: { label: 'Managed by the OS', cls: 'sp-badge-accent', title: 'Tier D: managed by the operating system; Spaci explains it and never cleans it' },
  };
  // Same Safe / Review / Permanent pills as every other screen; D (managed by
  // the OS) is the one extra, since nothing else in the app has it.
  function tierChip(t) {
    const m = TIER[t];
    if (!m) return null;
    if (t !== 'D' && SP.tiers && typeof SP.tiers.pill === 'function') {
      const pill = SP.tiers.pill(t);
      pill.title = m.title;
      return pill;
    }
    return el('span', { class: m.cls, title: m.title, style: 'display:inline-flex;align-items:center;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700;white-space:nowrap;flex:none', text: m.label });
  }
  const CONF = {
    partial: 'Partial: ran out of time, bytes so far',
    'upper-bound': 'Upper bound: shared blocks counted in full',
    denied: 'At least: some folders were not readable',
    cached: 'From the last scan, measuring again',
    stale: 'From the last complete scan: this one ran out of time',
    estimate: 'The OS’s own estimate',
    measuring: 'Still measuring',
  };
  function confNote(c, pending) {
    const text = pending ? CONF.cached : CONF[c];
    if (!text) return null;
    return el('span', { style: 'font-size:11px;color:var(--text-4);white-space:nowrap', text: text });
  }
  const OS_NAME = () => {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /mac/i.test(p) ? 'macOS' : /win/i.test(p) ? 'Windows' : 'Linux';
  };
  function commandBox(command, note) {
    if (!command) return note ? el('div', { style: 'color:var(--text-3);font-size:12px;line-height:1.5;margin-top:8px', text: note }) : null;
    const copy = el('button', {
      style: 'height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;flex:none',
      hov: 'border-color:var(--border-2);color:var(--text)',
      title: 'Copy the command',
      onclick: (e) => { e.stopPropagation(); try { navigator.clipboard.writeText(command); if (SP.toast) SP.toast('Command copied', command); } catch (_) {} }
    }, [ic('copy', 13), 'Copy']);
    return el('div', { style: 'margin-top:10px' }, [
      el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-4);font-weight:600;margin-bottom:6px', text: OS_NAME() + '’s own command (Spaci never runs it)' }),
      el('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;background:var(--panel-2);border:1px solid var(--border)' }, [
        el('code', { style: 'flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: command, text: command }),
        copy
      ]),
      note ? el('div', { style: 'color:var(--text-3);font-size:12px;line-height:1.5;margin-top:6px', text: note }) : null
    ]);
  }

  // "What macOS calls System Data". macOS files developer data, caches, app
  // data, swap and snapshots under one System Data figure; diskbreakdown
  // attributes the parts it can see. macOS only (systemData is null elsewhere).
  const SD_COLORS = {
    docker: '#5e93dd', aitools: '#c77dff', devcaches: '#3b6fd0', dotcache: '#e6b85c',
    swap: '#e0954f', appdata: '#46b58d', os: '#7a8a99'
  };
  function systemDataPanel(sd) {
    if (!sd || !Array.isArray(sd.pieces) || !sd.pieces.length) return null;
    const total = sd.estimate || sd.pieces.reduce((a, p) => a + p.bytes, 0);
    const bar = el('div', { style: 'display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--track);margin:18px 0 6px' },
      sd.pieces.map((p) => el('div', { title: p.label, style: 'height:100%;flex:none;border-right:2px solid var(--panel);background:' + (SD_COLORS[p.key] || '#8b867f') + ';width:' + (total ? (p.bytes / total) * 100 : 0) + '%' })));
    const line = (color, label, hint, value, pct, brand) => el('div', { style: 'display:flex;align-items:center;gap:13px;padding:11px 0;border-top:1px solid var(--border)' }, [
      el('span', { style: 'width:11px;height:11px;border-radius:4px;flex:none;background:' + color }),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px' }, [
          brand && SP.bic ? SP.bic(brand, 16, { decorative: true, fallback: '' }) : null,
          el('span', { text: label }),
        ]),
        hint ? el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:1px;line-height:1.45', text: hint }) : null
      ]),
      el('div', { style: 'text-align:right;flex:none' }, [
        el('div', { style: 'font-weight:700;font-size:14px;font-variant-numeric:tabular-nums', text: value }),
        pct ? el('div', { style: 'font-size:11px;color:var(--text-4);margin-top:1px', text: pct }) : null
      ])
    ]);
    const rows = sd.pieces.map((p) => line(SD_COLORS[p.key] || '#8b867f', p.label, p.hint, fmt(p.bytes), total ? (p.bytes / total * 100).toFixed(0) + '%' : '', p.key === 'docker' ? 'docker' : null));
    if (sd.snapshots) {
      const n = sd.snapshots.count;
      rows.push(line('var(--track-bright)', 'Local snapshots', 'APFS does not report their size, so they are counted under macOS and other system files. macOS removes them when it needs the space.', n + (n === 1 ? ' snapshot' : ' snapshots'), ''));
    }
    return el('div', { style: 'padding:20px 22px;border-radius:16px;background:var(--panel);border:1px solid var(--border);margin-top:26px' }, [
      el('div', { style: 'display:flex;align-items:center;gap:14px' }, [
        el('div', { style: 'width:46px;height:46px;border-radius:13px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic('info', 24)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15px', text: 'What macOS calls System Data' }),
          el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:2px;line-height:1.55', text: 'Storage settings shows one large System Data figure. On this Mac it comes to about ' + fmt(total) + ', and this is what it is made of.' })
        ])
      ]),
      bar,
      el('div', { style: 'margin-top:8px' }, rows),
      el('div', { style: 'color:var(--text-3);font-size:11.5px;line-height:1.5;margin-top:10px', text: 'This is an estimate. Apple does not publish exactly what counts as System Data, so the total can differ from the number in Storage settings.' })
    ]);
  }

  function systemHint(c) {
    const r = c.remainder && c.remainder.bytes;
    const live = S.storageMeasuring || c.confidence === 'measuring';
    return 'OS volumes and files, system folders and home folders no category claims' + (r > 0 ? (live ? '. ' + fmt(r) + ' is not measured yet.' : '. ' + fmt(r) + ' is not visible to Spaci, and named inside.') : '.');
  }

  // How much of the used space Spaci can put a name and a folder to, and
  // whether a measurement is running. Absent on breakdowns from before v2.
  function accountingCard(used) {
    const bd = S.breakdown || {};
    if (bd.explained == null || !used) return null;
    const live = S.storageMeasuring || (bd.meta && bd.meta.partial);
    const pct = Math.max(0, Math.min(100, bd.explained / used * 100));
    const pending = bd.meta && bd.meta.pending;
    const at = bd.at || (bd.meta && bd.meta.scannedAt);
    const right = live
      ? el('div', { style: 'display:flex;align-items:center;gap:9px;color:var(--text-2);font-size:12.5px;font-weight:600;flex:none' }, [
        el('span', { style: 'color:var(--accent-fg);display:flex' }, [ring('spiral', 20)]),
        pending > 0 ? 'Measuring, ' + pending + (pending === 1 ? ' folder' : ' folders') + ' to go' : 'Measuring system folders'
      ])
      : el('button', {
        style: 'height:34px;padding:0 13px;border-radius:9px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-2);font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:7px;cursor:pointer;flex:none',
        hov: 'border-color:var(--border-2);color:var(--text)',
        title: at ? 'Last measured ' + (SP.ago ? SP.ago(at) : '') : '',
        onclick: () => { S._storageTriedAt = 0; measureNow(); }
      }, [ic('refresh', 14), 'Measure again']);
    const note = bd.reconcile && bd.reconcile.overcount > 0
      ? el('div', { style: 'color:var(--text-3);font-size:12px;line-height:1.5;margin-top:10px', text: 'Folders add up to ' + fmt(bd.reconcile.overcount) + ' more than the disk uses: blocks shared between files (APFS clones, hard links) are counted once per folder' + (bd.reconcile.upperBound && bd.reconcile.upperBound.length ? ' in ' + bd.reconcile.upperBound.slice(0, 3).join(', ') : '') + '. Nothing is scaled to hide it.' })
      : null;
    return el('div', { style: 'padding:16px 18px;border-radius:14px;background:var(--panel);border:1px solid var(--border);margin:-8px 0 26px' }, [
      el('div', { style: 'display:flex;align-items:center;gap:16px' }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:14px;color:var(--text-2)' }, [
            'Spaci accounts for ',
            el('b', { style: 'color:var(--text);font-weight:700', text: fmt(bd.explained) }),
            ' of the ' + fmt(used) + ' in use ',
            el('span', { style: 'color:var(--text-3)', text: '(' + pct.toFixed(0) + '%)' })
          ]),
          el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden;margin-top:9px' }, [
            el('span', { style: 'display:block;height:100%;border-radius:99px;background:var(--accent);width:' + pct.toFixed(1) + '%;transition:width .4s' })
          ]),
          bd.unexplained > 0 ? el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:7px', text: live ? fmt(bd.unexplained) + ' is not measured yet. Folders fill in as they finish.' : fmt(bd.unexplained) + ' is not visible without administrator rights or Full Disk Access. Open System to see what it is made of.' }) : null
        ]),
        right
      ]),
      note
    ]);
  }

  // ---------- STORAGE ----------
  SP.screens.storage = function (host) {
    const { total, used, free, cats } = disk();
    if (!total && !cats.length) { ensure(); loading(host); return; }
    measureIfStale();

    const hover = S.storageHover;
    const maxCat = cats.reduce((m, c) => Math.max(m, c.bytes), 0) || 1;
    const tot = SP.reclaimTotals ? SP.reclaimTotals() : null;
    const reclaim = tot ? tot.top : (S.recs || []).filter((r) => !(r.action && r.action.type === 'none')).reduce((a, r) => a + recBytes(r), 0);

    host.appendChild(el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'Storage' }));
    host.appendChild(el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px;margin-bottom:30px', text: 'A clear picture of where your ' + fmt(total) + ' has gone. Hover any segment to inspect it.' }));

    // stat strip
    const stats = [
      { icon: 'hard-drive', label: 'Total capacity', value: fmt(total), color: 'var(--text)' },
      { icon: 'chart', label: 'Used', value: fmt(used), color: 'var(--accent-fg)' },
      { icon: 'check-circle', label: 'Available', value: fmt(free), color: 'var(--success-fg)' }
    ];
    host.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 34px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:26px' },
      stats.map((s) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:14px;color:var(--text-2)' }, [
        ic(s.icon, 16, { color: 'var(--text-3)' }), s.label, el('b', { style: 'color:' + s.color + ';font-weight:700;letter-spacing:-.2px', text: s.value })
      ]))));

    const accounting = accountingCard(used);
    if (accounting) host.appendChild(accounting);

    // disk usage header
    host.appendChild(el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px' }, [
      el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600', text: 'Disk usage' }),
      el('div', { style: 'font-size:13px;color:var(--text-3)' }, [
        el('b', { style: 'color:var(--text);font-weight:700', text: hover ? hover.size : fmt(used) }),
        el('span', { text: ' ' + (hover ? hover.label : 'used of ' + fmt(total)) })
      ])
    ]));

    // full-width capacity bar (categories + free)
    const setHover = (label, size) => { S.storageHover = label ? { label, size } : null; SP.go('storage'); };
    const barSegs = cats.map((c, i) => el('div', {
      style: 'height:100%;background:' + colorFor(c, i) + ';width:' + (total ? (c.bytes / total) * 100 : 0) + '%;flex:none;border-right:2px solid var(--bg);transition:filter .15s',
      hov: 'filter:brightness(1.18)',
      onmouseenter: () => setHover(c.label, fmt(c.bytes)),
      onmouseleave: () => setHover(null)
    }));
    barSegs.push(el('div', { style: 'height:100%;background:var(--track-bright);width:' + (total ? (free / total) * 100 : 0) + '%;flex:none' }));
    host.appendChild(el('div', { style: 'display:flex;height:60px;border-radius:14px;overflow:hidden;background:var(--track)' }, barSegs));

    // legend
    const legend = cats.map((c, i) => el('div', { style: 'display:flex;align-items:center;gap:9px' }, [
      el('span', { style: 'width:11px;height:11px;border-radius:4px;background:' + colorFor(c, i) + ';flex:none' }),
      el('span', { style: 'font-size:13px;font-weight:600', text: c.label }),
      el('span', { style: 'font-size:13px;color:var(--text-3);font-variant-numeric:tabular-nums', text: fmt(c.bytes) })
    ]));
    legend.push(el('div', { style: 'display:flex;align-items:center;gap:9px' }, [
      el('span', { style: 'width:11px;height:11px;border-radius:4px;background:var(--track-bright);flex:none' }),
      el('span', { style: 'font-size:13px;font-weight:600', text: 'Free space' }),
      el('span', { style: 'font-size:13px;color:var(--text-3)', text: fmt(free) })
    ]));
    host.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:13px 26px;margin-top:18px' }, legend));

    // what's using space
    host.appendChild(el('div', { style: "font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:36px 0 14px", text: "What's using space" }));
    host.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
      cats.map((c, i) => {
        const color = colorFor(c, i);
        return el('div', {
          class: 'sp-hov',
          style: 'display:flex;align-items:center;gap:15px;padding:15px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer',
          hov: 'border-color:var(--border-2);transform:translateX(2px)',
          onclick: () => { S.activeCat = c; SP.go('storagecat'); }
        }, [
          el('div', { style: 'width:44px;height:44px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic(c.icon || 'folder', 23)]),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
              el('span', { style: 'font-weight:600;font-size:14.5px', text: c.label }),
              tierChip(c.tier),
              confNote(c.confidence, c.pending)
            ]),
            el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: c.key === 'system' && c.remainder ? systemHint(c) : (c.hint || '') })
          ]),
          el('div', { style: 'width:132px;flex:none' }, [
            el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + (c.bytes / maxCat * 100).toFixed(1) + '%' })]),
            el('div', { style: 'font-size:11px;color:var(--text-4);margin-top:5px;text-align:right', text: used ? (c.bytes / used * 100).toFixed(0) + '% of used' : '' })
          ]),
          el('div', { style: 'font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(c.bytes) }),
          ic('chevron-right', 18, { color: 'var(--text-4)' })
        ]);
      })));

    // what macOS calls System Data (macOS only, absent on older cached scans)
    const sdPanel = systemDataPanel(S.breakdown && S.breakdown.systemData);
    if (sdPanel) host.appendChild(sdPanel);

    // reclaimable banner
    if (reclaim) {
      host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:16px;padding:18px 22px;border-radius:16px;background:var(--accent-soft);border:1px solid var(--border);margin-top:18px' }, [
        el('div', { style: 'width:46px;height:46px;border-radius:13px;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;flex:none' }, [ic('sparkles', 24)]),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700;font-size:15px', text: 'Top recommendations: ' + fmt(reclaim) }),
          el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:2px', text: (tot ? 'All cleanable found: ' + fmt(tot.grand) + (tot.unverified > 0 ? '. ' + fmt(tot.unverified) + ' unverified, not counted.' : '.') + ' ' : '') + 'Mostly build artifacts and caches that regenerate on demand.' })
        ]),
        el('button', { style: 'height:44px;padding:0 20px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer', hov: 'background:var(--accent-hover)', onclick: () => SP.go('recommendations') }, ['Review', ic('chevron-right', 15)])
      ]));
    }
  };

  // ---------- STORAGE CATEGORY DETAIL ----------
  // Points at the current mount's render so an async topChildren() fetch
  // repaints the live (attached) host, even if it resolved after a re-mount.
  let latestCatRender = null;

  function capsLabel(text) {
    return el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:8px 0 14px', text: text });
  }

  SP.screens.storagecat = function (host) {
    const c = S.activeCat;
    if (!c) { SP.go('storage'); return; }
    const { total, used, cats } = disk();
    const i = cats.findIndex((x) => x.key === c.key);
    const color = colorFor(c, i < 0 ? 0 : i);
    const dirs = Array.isArray(c.dirs) ? c.dirs.filter(Boolean) : [];
    const isSystem = c.key === 'system';
    S.catChildren = S.catChildren || {};

    // Kick off the largest-items fetch once per category, caching the result.
    function ensureChildren() {
      if (!dirs.length) return;
      if (isSystem && Array.isArray(c.areas)) return; // the breakdown already listed them
      if (S.catChildren[c.key] !== undefined) return; // cached (array or [])
      if (S._catLoading === c.key) return; // already in flight
      if (typeof api.topChildren !== 'function') { S.catChildren[c.key] = []; if (latestCatRender) latestCatRender(); return; }
      S._catLoading = c.key;
      Promise.resolve(api.topChildren(dirs)).then((items) => {
        S.catChildren[c.key] = Array.isArray(items) ? items : [];
      }).catch(() => {
        S.catChildren[c.key] = [];
      }).finally(() => {
        S._catLoading = null;
        // Only repaint if the user is still on this exact category page.
        if (S.route === 'storagecat' && S.activeCat && S.activeCat.key === c.key && latestCatRender) latestCatRender();
      });
    }

    function header() {
      return el('div', {}, [
        el('button', { style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:18px', hov: 'background:var(--panel);color:var(--text)', onclick: () => SP.go('storage') }, [ic('chevron-left', 16), 'Storage']),
        el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:24px' }, [
          el('div', { style: 'width:60px;height:60px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic(c.icon || 'folder', 32)]),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px', text: c.label }),
            el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:4px', text: c.hint || '' })
          ]),
          el('div', { style: 'text-align:right;flex:none' }, [
            el('div', { style: 'font-size:26px;font-weight:700;letter-spacing:-1px;color:' + color, text: fmt(c.bytes) }),
            el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: total ? (c.bytes / total * 100).toFixed(1) + '% of disk' : '' })
          ])
        ]),
        el('div', { style: 'height:14px;border-radius:7px;background:var(--track);overflow:hidden;margin-bottom:8px' }, [
          el('span', { style: 'display:block;height:100%;background:' + color + ';width:' + (used ? (c.bytes / used * 100).toFixed(1) : 0) + '%' })
        ]),
        el('div', { style: 'font-size:12.5px;color:var(--text-3);margin-bottom:24px', text: used ? (c.bytes / used * 100).toFixed(0) + '% of your used space' : '' })
      ]);
    }

    function itemRow(item, maxBytes, home) {
      const isDir = item.isDir !== false;
      const bytes = Number(item.bytes || 0);
      const barPct = maxBytes ? Math.max(2, (bytes / maxBytes) * 100) : 0;
      return el('div', {
        class: 'sp-hov',
        style: 'display:flex;align-items:center;gap:15px;padding:14px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border)',
        hov: 'border-color:var(--border-2)'
      }, [
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [pathMark(item.path, isDir ? 'folder' : 'file', 22)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0' }, [
            el('span', { style: 'font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0', text: item.name || (item.path || '').split(/[\\/]/).pop() || '' }),
            tierChip(item.tier),
            item.partial ? confNote('partial') : null
          ]),
          el('div', { class: 'mono', style: 'color:var(--text-3);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace', text: shortPath(item.path, home) })
        ]),
        el('div', { style: 'width:120px;flex:none' }, [
          el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [
            el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + barPct.toFixed(1) + '%' })
          ])
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(bytes) }),
        el('button', {
          style: 'width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-3);display:grid;place-items:center;flex:none;cursor:pointer',
          hov: 'border-color:var(--border-2);color:var(--text)',
          title: 'Reveal in Finder',
          onclick: () => { try { api.openPath(item.path); } catch (_) {} }
        }, [ic('folder-open', 16)])
      ]);
    }

    function infoCard(text) {
      return el('div', { style: 'display:flex;align-items:center;gap:13px;padding:18px 20px;border-radius:14px;background:var(--panel);border:1px solid var(--border);color:var(--text-2)' }, [
        el('div', { style: 'width:40px;height:40px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-3)' }, [ic('info', 21)]),
        el('div', { style: 'font-size:13.5px;line-height:1.55' }, [text])
      ]);
    }

    // ---------- System, explained (breakdown v2) ----------
    // Four parts that add up to the System figure: what the OS manages (tier D
    // volumes and files), system folders measured outside the home folder,
    // home folders no category claims, and what no account without admin
    // rights (or Full Disk Access) can measure, named part by part.
    const SYS_COLORS = { os: '#7a8a99', areas: '#5e93dd', home: '#e0954f', hidden: 'var(--track-bright)' };
    const sumOf = (list) => (list || []).reduce((a, it) => a + (Number(it && it.bytes) || 0), 0);
    S.storageOpen = S.storageOpen || {};

    function revealBtn(p) {
      if (!p || typeof api.storageReveal !== 'function') return null;
      return el('button', {
        style: 'width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-3);display:grid;place-items:center;flex:none;cursor:pointer',
        hov: 'border-color:var(--border-2);color:var(--text)',
        title: 'Show in ' + (OS_NAME() === 'macOS' ? 'Finder' : OS_NAME() === 'Windows' ? 'Explorer' : 'the file manager'),
        'aria-label': 'Show ' + p,
        onclick: (e) => { e.stopPropagation(); try { api.storageReveal(p); } catch (_) {} }
      }, [ic('folder-open', 14)]);
    }

    function childRow(ch, max, home) {
      const pct = max ? Math.max(2, (Number(ch.bytes || 0) / max) * 100) : 0;
      const sub = [ch.path ? shortPath(ch.path, home) : null, ch.lastUsedAt ? 'last used ' + (SP.ago ? SP.ago(Date.parse(ch.lastUsedAt)) : ch.lastUsedAt) : null, ch.reclaimable ? fmt(ch.reclaimable) + ' reclaimable' : null].filter(Boolean).join('  ·  ');
      return el('div', { style: 'display:flex;flex-direction:column;gap:4px;padding:9px 0;border-top:1px solid var(--border)' }, [
        el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: ch.name || '' }),
            sub ? el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace', text: sub }) : null
          ]),
          ch.bytes != null ? el('div', { style: 'width:90px;flex:none;height:5px;border-radius:99px;background:var(--track);overflow:hidden' }, [el('span', { style: 'display:block;height:100%;background:' + color + ';width:' + pct.toFixed(1) + '%' })]) : null,
          ch.bytes != null ? el('div', { style: 'font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;min-width:62px;text-align:right', text: fmt(ch.bytes) }) : null,
          revealBtn(ch.path)
        ]),
        ch.command ? el('code', { style: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: ch.command, text: ch.command }) : null
      ]);
    }

    function sysRow(it, max, home) {
      const open = !!S.storageOpen[it.key];
      const measured = it.bytes != null;
      const pct = measured && max ? Math.max(2, (it.bytes / max) * 100) : 0;
      const kids = Array.isArray(it.children) ? it.children : [];
      const notes = [];
      if (it.duBytes && it.duBytes > (it.bytes || 0) * 1.05) notes.push('du and Finder report ' + fmt(it.duBytes) + ': shared blocks counted once per copy.');
      if (it.freeableAtLeast != null) notes.push('Deleting it now frees at least ' + fmt(it.freeableAtLeast) + '.');
      if (it.additive === false) notes.push('Shown for reference: already counted in another total.');
      const toggle = () => { S.storageOpen[it.key] = !open; if (latestCatRender) latestCatRender(); };
      const detail = open ? el('div', { style: 'padding:4px 17px 14px 74px' }, [
        it.hint ? el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: it.hint }) : null,
        notes.length ? el('div', { style: 'color:var(--text-3);font-size:12px;line-height:1.5;margin-top:6px', text: notes.join(' ') }) : null,
        it.settings ? el('button', {
          style: 'margin-top:12px;height:36px;padding:0 15px;border-radius:10px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13px;display:inline-flex;align-items:center;gap:8px;cursor:pointer',
          hov: 'background:var(--accent-hover)',
          onclick: (e) => { e.stopPropagation(); try { api.storageOpenFda && api.storageOpenFda(); } catch (_) {} }
        }, [ic('shield', 15), 'Open Full Disk Access settings']) : null,
        kids.length ? el('div', { style: 'margin-top:10px' }, kids.map((ch) => childRow(ch, Math.max(...kids.map((k) => Number(k.bytes) || 0)), home))) : null,
        commandBox(it.command, it.commandNote)
      ]) : null;
      return el('div', { style: 'border-radius:14px;background:var(--panel);border:1px solid ' + (open ? 'var(--border-2)' : 'var(--border)') }, [
        el('div', {
          class: 'sp-hov',
          role: 'button',
          tabindex: '0',
          'aria-expanded': open ? 'true' : 'false',
          style: 'display:flex;align-items:center;gap:15px;padding:13px 17px;cursor:pointer',
          onclick: toggle,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
        }, [
          el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + (it.group === 'remainder' ? 'var(--text-3)' : color) }, [ic(it.icon || 'folder', 21)]),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
              el('span', { style: 'font-weight:600;font-size:14px', text: it.label }),
              tierChip(it.tier),
              confNote(it.confidence)
            ]),
            it.hint && !open ? el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: it.hint }) : null
          ]),
          measured ? el('div', { style: 'width:110px;flex:none;height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + pct.toFixed(1) + '%' })]) : null,
          el('div', { style: 'font-weight:700;font-size:14.5px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right;color:' + (measured ? 'var(--text)' : 'var(--text-3)'), text: measured ? fmt(it.bytes) : (it.count != null ? it.count + (it.count === 1 ? ' item' : ' items') : 'not measurable') }),
          ic(open ? 'chevron-up' : 'chevron-down', 17, { color: 'var(--text-4)' })
        ]),
        detail
      ]);
    }

    function section(title, sub, nodes) {
      if (!nodes.length) return;
      host.appendChild(el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin:26px 0 12px' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600', text: title }),
        sub ? el('div', { style: 'font-size:12.5px;color:var(--text-3);font-variant-numeric:tabular-nums', text: sub }) : null
      ]));
      host.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, nodes));
    }

    function renderSystem() {
      const home = S._homeDir || '';
      const osItems = c.os || [];
      const areas = c.areas || [];
      const unc = c.unclassified || [];
      const rem = c.remainder || { bytes: 0, parts: [] };
      const info = c.info || [];
      const parts = [
        { key: 'os', label: 'Managed by ' + OS_NAME(), bytes: sumOf(osItems) },
        { key: 'areas', label: 'System folders', bytes: sumOf(areas) },
        { key: 'home', label: 'Unclaimed home folders', bytes: c.unclassifiedBytes != null ? c.unclassifiedBytes : sumOf(unc) },
        { key: 'hidden', label: 'Not visible to Spaci', bytes: rem.bytes || 0 },
      ];
      const measuring = S.storageMeasuring || (S.breakdown && S.breakdown.meta && S.breakdown.meta.partial);
      if (measuring) parts[3].label = 'Not measured yet';
      const whole = parts.reduce((a, p) => a + p.bytes, 0) || 1;
      host.appendChild(el('div', { style: 'padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border)' }, [
        el('div', { style: 'font-size:13.5px;color:var(--text-2);line-height:1.55', text: 'System is everything outside the other categories. Spaci splits it into what ' + OS_NAME() + ' manages, the system folders it measured, home folders no category claims, and what it cannot see, named part by part.' }),
        el('div', { style: 'display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--track);margin:14px 0 12px' }, parts.filter((p) => p.bytes > 0).map((p) => el('div', { title: p.label + ': ' + fmt(p.bytes), style: 'height:100%;flex:none;border-right:2px solid var(--panel);background:' + SYS_COLORS[p.key] + ';width:' + (p.bytes / whole * 100) + '%' }))),
        el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 22px' }, parts.map((p) => el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px' }, [
          el('span', { style: 'width:10px;height:10px;border-radius:3px;flex:none;background:' + SYS_COLORS[p.key] }),
          el('span', { style: 'font-weight:600', text: p.label }),
          el('span', { style: 'color:var(--text-3);font-variant-numeric:tabular-nums', text: fmt(p.bytes) })
        ])))
      ]));

      const maxOf = (list) => Math.max(1, ...list.map((x) => Number(x.bytes) || 0));
      section(parts[0].label, fmt(parts[0].bytes), osItems.map((it) => sysRow(it, maxOf(osItems), home)));
      section('System folders', fmt(parts[1].bytes), areas.map((it) => sysRow(it, maxOf(areas), home)));
      if (unc.length) {
        const max = maxOf(unc);
        const more = (c.unclassifiedCount || unc.length) - unc.length;
        section('Home folders no category claims', fmt(parts[2].bytes) + (more > 0 ? ' in ' + c.unclassifiedCount + ' items' : ''), unc.map((u) => el('div', { style: 'display:flex;align-items:center;gap:15px;padding:12px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border)' }, [
          el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [pathMark(u.path, u.isDir === false ? 'file' : 'folder', 21)]),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'display:flex;align-items:center;gap:8px' }, [el('span', { style: 'font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: u.name }), tierChip('C'), confNote(u.confidence)]),
            el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace', text: shortPath(u.path, home) })
          ]),
          el('div', { style: 'width:110px;flex:none;height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + Math.max(2, u.bytes / max * 100).toFixed(1) + '%' })]),
          el('div', { style: 'font-weight:700;font-size:14.5px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(u.bytes) }),
          revealBtn(u.path)
        ])));
      } else if (c.unclassified === null) {
        section('Home folders no category claims', '', [infoCard('Measured after the categories finish.')]);
      }
      const hiddenParts = (rem.parts || []);
      section(measuring ? 'Not measured yet' : 'Not visible to Spaci', fmt(rem.bytes || 0), [
        infoCard(measuring ? 'Spaci is still measuring. What is left here shrinks as folders finish; the parts below are what stays out of reach at the end.' : rem.bytes > 0
          ? fmt(rem.bytes) + ' of used space is in places an app without administrator rights cannot measure. These are the parts it is made of.'
          : 'Everything in System was measured. These places could not be read, so anything in them is counted in the parts above.'),
        ...hiddenParts.map((it) => sysRow(it, 0, home))
      ]);
      section('For reference', '', info.map((it) => sysRow(it, maxOf(info), home)));
      if (c.unmeasured && c.unmeasured.length) {
        host.appendChild(el('div', { style: 'height:14px' }));
        host.appendChild(infoCard('Spaci ran out of time measuring ' + c.unmeasured.map((d) => shortPath(d, home)).join(', ') + '; their categories show the size reached so far. Measure again to finish them.'));
      }
    }

    function render() {
      host.innerHTML = '';
      host.appendChild(header());

      if (isSystem && Array.isArray(c.areas)) { renderSystem(); return; }
      if (!dirs.length) {
        host.appendChild(infoCard('Spaci measures this category as a whole, so there are no individual folders to drill into here. The reclaimable parts of other categories are surfaced in Recommendations.'));
        return;
      }
      // System is what is left after every category Spaci measures: the OS
      // itself, snapshots and swap, plus any folder no category claims. List
      // those folders so the number is explained, not just stated.
      if (isSystem) {
        host.appendChild(infoCard('This is everything Spaci could not put in another category. Part of it is the operating system itself, swap and snapshots, which are not folders you can open. The rest is folders listed below, biggest first. Folders Spaci is not allowed to read (on macOS, grant Full Disk Access in System Settings > Privacy & Security) can be missing or measured short, so the list may not add up to the total.'));
        host.appendChild(el('div', { style: 'height:18px' }));
        const unmeasured = Array.isArray(c.unmeasured) ? c.unmeasured : [];
        if (unmeasured.length) {
          host.appendChild(infoCard('Spaci ran out of time measuring ' + unmeasured.map((d) => shortPath(d, S._homeDir)).join(', ') + ', so their size is counted here for now. Scan again to measure them properly.'));
          host.appendChild(el('div', { style: 'height:18px' }));
        }
        // macOS keeps its own files on separate volumes of the same disk.
        const vols = Array.isArray(c.volumes) ? c.volumes : [];
        if (vols.length) {
          host.appendChild(capsLabel('macOS volumes on this disk'));
          const vmax = Math.max(...vols.map((v) => v.bytes || 0));
          host.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:9px;margin-bottom:24px' }, vols.map((v) => {
            const pct = vmax ? Math.max(2, (v.bytes / vmax) * 100) : 0;
            return el('div', { style: 'display:flex;align-items:center;gap:15px;padding:14px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border)' }, [
              el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic('cpu', 22)]),
              el('div', { style: 'flex:1;min-width:0' }, [
                el('div', { style: 'font-weight:600;font-size:14.5px', text: v.name }),
                el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: 'Managed by macOS, not a folder you can clean' })
              ]),
              el('div', { style: 'width:120px;flex:none' }, [
                el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [
                  el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + pct.toFixed(1) + '%' })
                ])
              ]),
              el('div', { style: 'font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(v.bytes || 0) })
            ]);
          })));
        }
      }

      // ---- ai models and dev tools ----
      // Developer storage the drill-down cannot name by folder alone: models,
      // simulators, emulators and toolchain versions, each with its size.
      if (c.key === 'developer' && SP.devtools) {
        const summary = SP.devtools.storageSummary(() => { if (S.route === 'storagecat' && S.activeCat && S.activeCat.key === c.key && latestCatRender) latestCatRender(); });
        if (summary) host.appendChild(summary);
      }
      // ---- end ai models and dev tools ----
      host.appendChild(capsLabel('Largest items'));
      const items = S.catChildren[c.key];

      // Still measuring: animated logo, not a static icon.
      if (items === undefined) {
        host.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:34vh;gap:16px;color:var(--text-3)' }, [
          el('div', { style: 'color:var(--accent-fg)' }, [ring('spiral', 48)]),
          el('div', { style: 'font-size:14px;font-weight:600;color:var(--text-2)', text: 'Measuring the biggest items…' })
        ]));
        return;
      }

      if (!items.length) {
        host.appendChild(infoCard('Nothing large enough to list here.'));
        return;
      }

      const maxBytes = items.reduce((m, it) => Math.max(m, Number(it.bytes || 0)), 0) || 1;
      const home = S._homeDir || '';
      host.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:9px' }, items.map((it) => itemRow(it, maxBytes, home))));
    }

    latestCatRender = render;
    // Resolve home once so paths render with '~'; repaint when it lands.
    if (S._homeDir == null) homeDir().then(() => { if (S.route === 'storagecat' && S.activeCat && S.activeCat.key === c.key && latestCatRender) latestCatRender(); });
    render();
    ensureChildren();
  };
})();
