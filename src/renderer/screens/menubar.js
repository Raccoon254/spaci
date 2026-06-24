'use strict';
/* Menu-bar Widget showcase, Spaci v2. Faithful to
   design/spaci-v2-reference.html (data-screen-label="Menu-bar Widget").
   A fake macOS desktop stage with the menu bar and the redesigned Spaci
   popover, a Redesign/Today toggle, and a "What changed" grid. Pulls the
   free-space and reclaimable figures from real data when available, else
   falls back to demo values. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // module-local toggle state: 'after' = Redesign (default), 'before' = Today
  let mode = 'after';

  // demo data kept in the module
  const SEGS = [
    { color: '#3b6fd0', pct: 38 },
    { color: '#8b6bd9', pct: 26 },
    { color: '#2fb8a8', pct: 21 },
    { color: '#e0954f', pct: 15 }
  ];
  const CHANGES = [
    { icon: 'flash', title: "Act, don't just open", body: 'The old menu only had links. The redesign puts a one-tap Clean right where you glance, so you reclaim space without opening the app.' },
    { icon: 'chart', title: 'Glanceable status', body: 'Free space, reclaimable total and a segmented breakdown live in the popover. You read your machine at a glance.' },
    { icon: 'shield', title: 'Guard at a glance', body: 'A live Guard pill tells you protection is on, and you can pause it inline, no settings trip required.' }
  ];

  // recommendation size, matching the dashboard's resolver
  function recSize(r) {
    return Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0;
  }

  SP.screens.menubar = function (host) {
    const d = S.disk || {};
    const recs = S.recs || [];
    const diskFree = d.free ? fmt(d.free) : '184 GB';
    const recTotal = recs.reduce((a, r) => a + recSize(r), 0);
    const reclaimTotal = recTotal ? fmt(recTotal) : '12.4 GB';

    // quick-stats: prefer real figures, fall back to demo values
    const cats = (S.breakdown && S.breakdown.categories) || [];
    const cacheCat = cats.find((c) => /cache/i.test(c.label || ''));
    const cacheVal = cacheCat ? fmt(cacheCat.bytes) : '4.8 GB';
    const projVal = recs.length ? String(recs.length) : '23';
    const quick = [
      { icon: 'broom', label: 'Caches', value: cacheVal },
      { icon: 'folder-2', label: 'Projects', value: projVal }
    ];

    const actions = [
      { icon: 'scan', label: 'Run Smart Scan', hint: '⌘S' },
      { icon: 'window', label: 'Open Spaci', hint: '⌘O' },
      { icon: 'shield', label: 'Pause Guard', hint: '' }
    ];

    // ---- header: title, subtitle, Redesign/Today toggle ----
    const chip = (label, val) => el('div', {
      class: mode === val ? 'sp-fchip-on' : '',
      style: 'padding:7px 15px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-2)',
      onclick: () => { mode = val; SP.go('menubar'); }
    }, [label]);

    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'Menu-bar Widget' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px', text: 'A redesign of the menu-bar drop-down. From a bare list of links to a live, glanceable panel you can act on without opening the app.' })
        ]),
        el('div', { style: 'display:flex;gap:6px;background:var(--panel-2);padding:4px;border-radius:11px;border:1px solid var(--border);flex:none' }, [
          chip('Redesign', 'after'),
          chip('Today', 'before')
        ])
      ])
    );

    // ---- macOS desktop stage ----
    const menuBar = el('div', { style: 'position:relative;height:38px;display:flex;align-items:center;gap:20px;padding:0 18px;background:rgba(20,22,30,.55);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.92);font-size:13px;font-weight:600;z-index:5' }, [
      ic('apple', 15),
      el('span', { style: 'font-weight:700', text: 'Finder' }),
      el('span', { style: 'opacity:.8', text: 'File' }),
      el('span', { style: 'opacity:.8', text: 'Edit' }),
      el('span', { style: 'opacity:.8', text: 'View' }),
      el('div', { style: 'flex:1' }),
      el('spaci-icon', { name: 'branch', style: 'width:15px;height:15px;opacity:.8' }),
      el('spaci-icon', { name: 'search', style: 'width:15px;height:15px;opacity:.8' }),
      el('div', { style: 'width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,.16);display:grid;place-items:center;color:#fff;position:relative' }, [
        el('spaci-icon', { name: 'spaci-ring', anim: 'swing', style: 'width:17px;height:17px' })
      ]),
      el('span', { style: 'opacity:.92', text: '100%' }),
      el('span', { style: 'opacity:.92', text: 'Tue 9:41' })
    ]);

    const stageKids = [
      // wallpaper glow
      el('div', { style: 'position:absolute;top:-80px;right:60px;width:380px;height:380px;border-radius:50%;background:radial-gradient(circle,rgba(120,150,220,.4),transparent 70%);pointer-events:none' }),
      el('div', { style: 'position:absolute;bottom:-120px;left:-40px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(1,75,170,.34),transparent 70%);pointer-events:none' }),
      menuBar
    ];

    if (mode === 'after') {
      // ---- redesigned popover ----
      const header = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:16px 18px 14px' }, [
        el('div', { style: 'color:var(--accent-fg)' }, [
          el('spaci-icon', { name: 'spaci-ring', anim: 'shimmer', style: 'width:34px;height:34px;display:block' })
        ]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.3px' }, [
            el('span', { text: 'Spaci' }),
            el('span', { style: 'color:var(--accent-fg)', text: '.' })
          ]),
          el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:1px', text: 'Macintosh HD · ' + diskFree + ' free' })
        ]),
        el('div', { style: 'display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:7px;background:var(--success-soft);color:var(--success-fg);font-size:10.5px;font-weight:700' }, [
          el('span', { style: 'width:6px;height:6px;border-radius:50%;background:var(--success-fg)' }),
          'Guard on'
        ])
      ]);

      const segBar = el('div', { style: 'height:7px;border-radius:99px;background:var(--track);margin-top:13px;overflow:hidden;display:flex;gap:2px' },
        SEGS.map((s) => el('span', { style: 'height:100%;border-radius:2px;background:' + s.color + ';flex-basis:' + s.pct + '%;flex-grow:0;flex-shrink:0;transform-origin:left;animation:sp-segment .55s cubic-bezier(.22,.61,.36,1) backwards' })));

      const reclaimBlock = el('div', { style: 'padding:8px 18px 18px' }, [
        el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:700', text: 'Reclaimable now' }),
        el('div', { style: 'display:flex;align-items:flex-end;gap:10px;margin-top:6px' }, [
          el('div', { style: 'font-size:27px;font-weight:700;letter-spacing:-1px;line-height:1', text: reclaimTotal }),
          el('div', { style: 'color:var(--text-3);font-size:11.5px;padding-bottom:3px', text: 'ready across caches & builds' })
        ]),
        segBar,
        el('button', { style: 'margin-top:14px;width:100%;height:42px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font-family:inherit', hov: 'background:var(--accent-hover)' }, [
          ic('flash', 16),
          'Clean ' + reclaimTotal
        ])
      ]);

      const quickRow = el('div', { style: 'display:flex;padding:13px 18px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)' },
        quick.map((q) => el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:5px' }, [
          el('div', { style: 'display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:11px;font-weight:600' }, [
            ic(q.icon, 14, { color: 'var(--accent-fg)' }),
            q.label
          ]),
          el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.4px;color:var(--text-2)', text: q.value })
        ])));

      const actionsList = el('div', { style: 'border-top:1px solid var(--border);padding:7px 8px' },
        actions.map((a) => el('div', { style: 'display:flex;align-items:center;gap:12px;padding:10px 11px;border-radius:10px;cursor:pointer', hov: 'background:var(--panel)' }, [
          ic(a.icon, 17, { color: 'var(--text-2)' }),
          el('span', { style: 'flex:1;font-size:13.5px;font-weight:500', text: a.label }),
          a.hint ? el('span', { style: 'color:var(--text-4);font-size:11.5px', text: a.hint }) : null
        ])));

      const panel = el('div', { class: 'sp-stagger', style: 'position:relative;border-radius:18px;border:none;border-top:1px solid var(--border-2);border-bottom:1px solid var(--border-2);background:linear-gradient(180deg,rgba(1,75,170,.26),transparent 240px),var(--panel-2);overflow:hidden;box-shadow:0 40px 90px rgba(0,0,0,.5)' }, [
        header,
        reclaimBlock,
        quickRow,
        actionsList
      ]);

      stageKids.push(
        el('div', { style: 'position:absolute;top:50px;right:22px;width:340px;z-index:6;animation:sp-rise .34s cubic-bezier(.22,.61,.36,1)' }, [
          el('div', { style: 'position:absolute;top:-7px;right:42px;width:14px;height:14px;background:linear-gradient(135deg,#28324a,#222a3d);border-left:1px solid var(--border-2);border-top:1px solid var(--border-2);transform:rotate(45deg)' }),
          panel
        ])
      );
    } else {
      // ---- bare "today" dropdown ----
      stageKids.push(
        el('div', { style: 'position:absolute;top:46px;right:34px;width:182px;z-index:6;animation:sp-rise .26s cubic-bezier(.22,.61,.36,1)' }, [
          el('div', { style: 'border-radius:7px;background:rgba(54,54,56,.86);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 70px rgba(0,0,0,.5);padding:5px;color:rgba(255,255,255,.95)' }, [
            el('div', { style: 'padding:6px 12px;border-radius:5px;font-size:14px;font-weight:500', hov: 'background:var(--accent);color:#fff', text: 'Open Spaci' }),
            el('div', { style: 'padding:6px 12px;border-radius:5px;font-size:14px;font-weight:500', hov: 'background:var(--accent);color:#fff', text: 'Smart Scan' }),
            el('div', { style: 'height:1px;background:rgba(255,255,255,.14);margin:5px 8px' }),
            el('div', { style: 'padding:6px 12px;border-radius:5px;font-size:14px;font-weight:500', hov: 'background:var(--accent);color:#fff', text: 'Quit Spaci' })
          ])
        ])
      );
    }

    host.appendChild(
      el('div', { style: 'position:relative;border-radius:20px;overflow:hidden;border:1px solid var(--border);background:linear-gradient(160deg,#3a4763,#222a3d 60%,#1a1f2e);box-shadow:var(--shadow-md);min-height:520px' }, stageKids)
    );

    // ---- What changed ----
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:28px 0 14px', text: 'What changed' }));
    host.appendChild(
      el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:14px' },
        CHANGES.map((c) => el('div', { style: 'background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px' }, [
          el('div', { style: 'width:40px;height:40px;border-radius:11px;background:var(--accent-soft);display:grid;place-items:center;color:var(--accent-fg);margin-bottom:13px' }, [ic(c.icon, 21)]),
          el('div', { style: 'font-weight:700;font-size:14.5px', text: c.title }),
          el('div', { style: 'color:var(--text-2);font-size:12.5px;margin-top:5px;line-height:1.55', text: c.body })
        ])))
    );
  };
})();
