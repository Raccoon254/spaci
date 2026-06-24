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
    browsers: '#46b58d', xcode: '#6c7ae0',
    system: '#7a8a99', other: '#8b867f'
  };
  const PALETTE = ['#3b6fd0', '#8b6bd9', '#d96a8a', '#2fb8a8', '#e0954f', '#5e93dd', '#7fb5c9', '#7a8a99'];
  const colorFor = (c, i) => COLORS[c.key] || PALETTE[i % PALETTE.length];

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
    }).finally(() => { S._storageLoading = false; if (S.route === 'storage' || S.route === 'storagecat') SP.go(S.route); });
  }

  // ---------- STORAGE ----------
  SP.screens.storage = function (host) {
    const { total, used, free, cats } = disk();
    if (!total && !cats.length) { ensure(); loading(host); return; }

    const hover = S.storageHover;
    const maxCat = cats.reduce((m, c) => Math.max(m, c.bytes), 0) || 1;
    const reclaim = (S.recs || []).reduce((a, r) => a + recBytes(r), 0);

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
            el('div', { style: 'font-weight:600;font-size:14.5px', text: c.label }),
            el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: c.hint || '' })
          ]),
          el('div', { style: 'width:132px;flex:none' }, [
            el('div', { style: 'height:6px;border-radius:99px;background:var(--track);overflow:hidden' }, [el('span', { style: 'display:block;height:100%;border-radius:99px;background:' + color + ';width:' + (c.bytes / maxCat * 100).toFixed(1) + '%' })]),
            el('div', { style: 'font-size:11px;color:var(--text-4);margin-top:5px;text-align:right', text: used ? (c.bytes / used * 100).toFixed(0) + '% of used' : '' })
          ]),
          el('div', { style: 'font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;min-width:70px;text-align:right', text: fmt(c.bytes) }),
          ic('chevron-right', 18, { color: 'var(--text-4)' })
        ]);
      })));

    // reclaimable banner
    if (reclaim) {
      host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:16px;padding:18px 22px;border-radius:16px;background:var(--accent-soft);border:1px solid var(--border);margin-top:18px' }, [
        el('div', { style: 'width:46px;height:46px;border-radius:13px;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;flex:none' }, [ic('sparkles', 24)]),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700;font-size:15px', text: fmt(reclaim) + ' of this is reclaimable' }),
          el('div', { style: 'color:var(--text-2);font-size:13px;margin-top:2px', text: 'Mostly developer build artifacts and caches that regenerate on demand.' })
        ]),
        el('button', { style: 'height:44px;padding:0 20px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer', hov: 'background:var(--accent-hover)', onclick: () => SP.go('recommendations') }, ['Review', ic('arrow-right', 15)])
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
      if (isSystem || !dirs.length) return;
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
        el('button', { style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;margin-bottom:18px', hov: 'background:var(--panel);color:var(--text)', onclick: () => SP.go('storage') }, [ic('arrow-left', 16), 'Storage']),
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
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:' + color }, [ic(isDir ? 'folder' : 'file', 22)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: item.name || (item.path || '').split('/').pop() || '' }),
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

    function render() {
      host.innerHTML = '';
      host.appendChild(header());

      // System remainder: no user folders to drill into, keep the explainer.
      if (isSystem || !dirs.length) {
        host.appendChild(infoCard('Spaci measures this category as a whole. It is the part of your disk macOS reserves and reports as a single block (system files, snapshots, sleep image), so there are no individual folders to drill into here. The reclaimable parts of other categories are surfaced in Recommendations.'));
        return;
      }

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
