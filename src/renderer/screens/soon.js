'use strict';
/* Tools preview screens, Spaci v2. Faithful to design/spaci-v2-reference.html
   (around lines 701 to 806). Three upcoming-feature showcases each live on
   their own page now (no tab switcher): Scheduled Scans, Duplicate Finder and
   Spaci Guard register as SP.screens.scheduled / .duplicate / .guard. These
   previews are not wired to a backend yet, so every figure below is
   representative demo data kept inside this module. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // A spaci-ring sized exactly as the design specifies. The shared ring()
  // helper hardcodes width/height to one size value, but the design uses
  // distinct pixel boxes per hero, so we build the icon directly here.
  function heroRing(anim, px) {
    return el('spaci-icon', {
      name: 'spaci-ring',
      anim: anim,
      style: 'width:' + px + 'px;height:' + px + 'px;display:block'
    });
  }

  // ---------- tool registry ----------
  // key, and the header copy (title + pitch + right-side action button). Each
  // tool is its own screen now, so there is no tab metadata anymore.
  const TOOLS = [
    {
      key: 'scheduled',
      name: 'Scheduled Scans',
      pitch: 'Let Spaci tidy up on its own. Pick a cadence and it quietly reclaims regenerable space in the background, on your terms.',
      actionIcon: 'play',
      actionLabel: 'Run now',
      toast: ['Scheduled scans', 'This tool is coming soon']
    },
    {
      key: 'duplicate',
      name: 'Duplicate Finder',
      pitch: 'Hunt down byte-for-byte duplicates scattered across your disk and reclaim the space they quietly waste, with a safe preview first.',
      actionIcon: 'check-circle',
      actionLabel: 'Review & clean',
      toast: ['Duplicate Finder', 'This tool is coming soon']
    },
    {
      key: 'guard',
      name: 'Spaci Guard',
      pitch: 'Real-time protection that watches your busiest folders and clears regenerable clutter the moment it appears.',
      actionIcon: 'shield',
      actionLabel: 'Open Guard',
      toast: ['Spaci Guard', 'This tool is coming soon']
    }
  ];

  // ---------- Duplicate Finder demo data ----------
  const DUP_GROUPS = [
    {
      icon: 'image',
      name: 'IMG_4021.HEIC',
      meta: '12 copies',
      paths: '~/Pictures, ~/Desktop, ~/Downloads/old, +9 more',
      size: '38 MB'
    },
    {
      icon: 'folder-2',
      name: 'node_modules',
      meta: '6 sets',
      paths: '~/dev/spaci, ~/dev/spaci-web, ~/dev/archive/spaci-v1, +3 more',
      size: '4.1 GB'
    },
    {
      icon: 'document',
      name: 'presentation-final.key',
      meta: '4 copies',
      paths: '~/Desktop, ~/Documents/decks, ~/Downloads, ~/Documents/old',
      size: '612 MB'
    },
    {
      icon: 'file',
      name: 'render-master.mov',
      meta: '3 copies',
      paths: '~/Movies, ~/Desktop/exports, ~/Downloads/handoff',
      size: '2.7 GB'
    }
  ];

  // ---------- Scheduled Scans demo data ----------
  // Active days light up via sp-wd-on (Mon..Sun): nightly runs every day,
  // the weekly deep scan adds Sunday weight, so all seven are active here.
  const WEEK = [
    { d: 'Mon', on: true },
    { d: 'Tue', on: true },
    { d: 'Wed', on: true },
    { d: 'Thu', on: true },
    { d: 'Fri', on: true },
    { d: 'Sat', on: false },
    { d: 'Sun', on: true }
  ];
  const SCHEDULES = [
    { icon: 'broom', title: 'Nightly cleanup', sub: 'Caches and logs, every day at 2:00 AM', on: true },
    { icon: 'code', title: 'Weekly deep scan', sub: 'Developer projects, Sundays at 3:00 AM', on: true },
    { icon: 'download', title: 'Downloads sweep', sub: 'Old downloads, weekly', on: false }
  ];

  // ---------- Spaci Guard demo data ----------
  const GUARD_STATS = [
    { label: 'Blocked this week', value: '1.2 GB' },
    { label: 'Locations', value: '12' },
    { label: 'Uptime', value: '6 days' }
  ];
  const GUARD_LOCATIONS = [
    '~/Library/Caches',
    '~/dev/*/node_modules',
    '~/.gradle',
    '~/Library/Developer/Xcode/DerivedData',
    '~/.npm/_cacache',
    '~/Library/Containers',
    '~/.cache',
    '/private/var/folders'
  ];
  const GUARD_EVENTS = [
    { icon: 'broom', title: 'Cleared 340 MB from npm cache', when: '4 min ago' },
    { icon: 'code', title: 'Removed DerivedData for 3 stale projects', when: '1 hr ago' },
    { icon: 'trash', title: 'Swept 210 MB of expired temp files', when: '3 hr ago' },
    { icon: 'shield', title: 'Skipped active build folder (in use)', when: '5 hr ago' }
  ];

  // Section heading (uppercase eyebrow) used between blocks.
  function eyebrow(text, mb) {
    return el('div', {
      style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600;margin-bottom:' + (mb || 13) + 'px',
      text: text
    });
  }

  // ============================================================
  //  DUPLICATE FINDER
  // ============================================================
  function dupPreview() {
    const out = [];

    // hero with clearing ring + glow
    out.push(
      el('div', { style: 'display:flex;align-items:center;gap:28px;padding:30px 32px;border-radius:20px;background:var(--panel);border:1px solid var(--border);overflow:hidden;position:relative;margin-bottom:18px' }, [
        el('div', { style: 'position:absolute;top:-40%;left:90px;width:280px;height:280px;background:var(--glow);pointer-events:none' }),
        el('div', { style: 'color:var(--accent-fg);flex:none' }, [heroRing('clearing', 94)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:40px;font-weight:700;letter-spacing:-1.6px;line-height:1' }, [
            '8.2 GB',
            el('span', { style: 'font-size:17px;color:var(--text-3);font-weight:600;letter-spacing:-.2px;margin-left:10px', text: 'recoverable' })
          ]),
          el('div', { style: 'color:var(--text-2);font-size:14px;margin-top:7px', text: '1,284 duplicate files found across 312 groups' })
        ]),
        el('button', {
          style: 'height:48px;padding:0 24px;border-radius:13px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14.5px;display:flex;align-items:center;gap:9px;cursor:pointer;font-family:inherit;flex:none',
          hov: 'background:var(--accent-hover)',
          onclick: () => SP.toast('Duplicate Finder', 'This tool is coming soon')
        }, [ic('check-circle', 17), 'Review & clean'])
      ])
    );

    out.push(eyebrow('Duplicate groups'));

    out.push(
      el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' },
        DUP_GROUPS.map((g) =>
          el('div', {
            style: 'display:flex;align-items:center;gap:16px;padding:15px 17px;border-radius:14px;background:var(--panel);border:1px solid var(--border);transition:border-color .16s,transform .16s',
            hov: 'border-color:var(--border-2);transform:translateX(2px)'
          }, [
            // stacked-card thumbnail: three absolutely-positioned layered divs
            el('div', { style: 'position:relative;width:52px;height:44px;flex:none' }, [
              el('div', { style: 'position:absolute;top:0;left:12px;width:40px;height:40px;border-radius:11px;background:var(--panel-3);opacity:.45' }),
              el('div', { style: 'position:absolute;top:2px;left:6px;width:40px;height:40px;border-radius:11px;background:var(--panel-2);opacity:.8' }),
              el('div', { style: 'position:absolute;top:4px;left:0;width:40px;height:40px;border-radius:11px;background:var(--panel-2);border:1px solid var(--border-2);display:grid;place-items:center;color:var(--text-2)' }, [ic(g.icon, 22)])
            ]),
            el('div', { style: 'flex:1;min-width:0' }, [
              el('div', { style: 'font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:9px;min-width:0' }, [
                el('span', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: g.name }),
                el('span', { style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700;background:var(--accent-soft-2);color:var(--accent-fg);white-space:nowrap;flex:none', text: g.meta })
              ]),
              el('div', { class: 'mono', style: 'color:var(--text-3);font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: g.paths })
            ]),
            el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: g.size }),
            el('button', {
              style: 'height:36px;padding:0 13px;border-radius:9px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;flex:none',
              hov: 'background:var(--panel-3)',
              onclick: () => SP.toast('Duplicate Finder', 'This tool is coming soon')
            }, ['Keep newest'])
          ])
        )
      )
    );

    return out;
  }

  // ============================================================
  //  SCHEDULED SCANS
  // ============================================================
  function schedPreview() {
    const out = [];

    // accent-soft hero with cascade ring + glow
    out.push(
      el('div', { style: 'display:flex;align-items:center;gap:24px;padding:26px 30px;border-radius:20px;background:var(--accent-soft);border:1px solid var(--border);margin-bottom:16px;position:relative;overflow:hidden' }, [
        el('div', { style: 'position:absolute;top:-50%;left:60px;width:260px;height:260px;background:var(--glow);pointer-events:none' }),
        el('div', { style: 'color:var(--accent-fg);flex:none' }, [heroRing('cascade', 84)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:700', text: 'Next scheduled run' }),
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;margin-top:4px', text: 'Nightly cleanup' }),
          el('div', { style: 'color:var(--text-2);font-size:13.5px;margin-top:3px', text: 'Tonight at 2:00 AM' })
        ]),
        el('button', {
          style: 'height:46px;padding:0 22px;border-radius:12px;border:1px solid var(--border-2);background:var(--panel);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none',
          hov: 'background:var(--panel-2)',
          onclick: () => SP.toast('Scheduled scans', 'This tool is coming soon')
        }, [ic('play', 16), 'Run now'])
      ])
    );

    // 7-day week strip
    out.push(
      el('div', { style: 'display:flex;gap:8px;margin-bottom:18px' },
        WEEK.map((d) =>
          el('div', { style: 'flex:1;display:flex;flex-direction:column;align-items:center;gap:9px;padding:13px 0;border-radius:12px;background:var(--panel);border:1px solid var(--border)' }, [
            el('span', { style: 'font-size:12px;font-weight:700;color:var(--text-3)', text: d.d }),
            el('span', { class: d.on ? 'sp-wd-on' : 'sp-wd', style: 'width:7px;height:7px;border-radius:50%' })
          ])
        )
      )
    );

    // schedule rows + dashed add row
    const rows = SCHEDULES.map((s) =>
      el('div', { style: 'display:flex;align-items:center;gap:15px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border)' }, [
        el('div', { style: 'width:46px;height:46px;border-radius:12px;background:var(--accent-soft);display:grid;place-items:center;flex:none;color:var(--accent-fg)' }, [ic(s.icon, 24)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:15px', text: s.title }),
          el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: s.sub })
        ]),
        el('div', { class: s.on ? 'sp-tog-on' : '', style: 'width:46px;height:26px;border-radius:99px;position:relative;flex:none;border:1px solid var(--border);background:var(--panel-3)' }, [
          el('span', { class: 'sp-knob', style: 'position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--text-2);transition:transform .2s,background .2s' })
        ])
      ])
    );

    rows.push(
      el('div', {
        style: 'display:flex;align-items:center;justify-content:center;gap:9px;padding:16px;border-radius:16px;border:1.5px dashed var(--border-2);color:var(--text-3);font-weight:600;font-size:13.5px;cursor:pointer',
        hov: 'border-color:var(--accent-fg);color:var(--text-2)',
        onclick: () => SP.toast('Scheduled scans', 'This tool is coming soon')
      }, [ic('plus', 16), 'Add a schedule'])
    );

    out.push(el('div', { style: 'display:flex;flex-direction:column;gap:11px' }, rows));

    return out;
  }

  // ============================================================
  //  SPACI GUARD
  // ============================================================
  function guardPreview() {
    const out = [];

    // hero: heartbeat ring inside a pinging ring, success radial glow
    out.push(
      el('div', { style: 'display:flex;align-items:center;gap:24px;padding:28px 30px;border-radius:20px;background:var(--panel);border:1px solid var(--border);margin-bottom:16px;position:relative;overflow:hidden' }, [
        el('div', { style: 'position:absolute;inset:0;background:radial-gradient(circle at 86px 50%, var(--success-soft), transparent 58%);pointer-events:none' }),
        el('div', { style: 'position:relative;width:96px;height:96px;flex:none;display:grid;place-items:center;color:var(--success-fg)' }, [
          el('div', { style: 'position:absolute;inset:8px;border-radius:50%;border:2px solid var(--success-fg);animation:sp-ping 2.6s ease-out infinite' }),
          el('spaci-icon', { name: 'spaci-ring', anim: 'heartbeat', style: 'width:78px;height:78px' })
        ]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:26px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px' }, [
            'Protected',
            el('span', { style: 'width:9px;height:9px;border-radius:50%;background:var(--success-fg)' })
          ]),
          el('div', { style: 'color:var(--text-2);font-size:13.5px;margin-top:4px', text: 'Real-time monitoring active across 12 locations' })
        ]),
        el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.7px;color:var(--success-fg)', text: 'Live' }),
          el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: 'real-time' })
        ])
      ])
    );

    // guard stat strip
    out.push(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 34px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:18px' },
        GUARD_STATS.map((s) =>
          el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:14px;color:var(--text-2)' }, [
            ic('shield', 16, { color: 'var(--text-3)' }),
            el('span', { text: s.label }),
            el('b', { style: 'color:var(--text);font-weight:700', text: s.value })
          ])
        )
      )
    );

    // watched locations (mono pills with green dots)
    out.push(eyebrow('Watched locations', 12));
    out.push(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px' },
        GUARD_LOCATIONS.map((loc) =>
          el('div', { class: 'mono', style: 'display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:99px;background:var(--panel);border:1px solid var(--border);font-size:12px;color:var(--text-2)' }, [
            el('span', { style: 'width:6px;height:6px;border-radius:50%;background:var(--success-fg)' }),
            loc
          ])
        )
      )
    );

    // recent activity
    out.push(eyebrow('Recent activity', 12));
    out.push(
      el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' },
        GUARD_EVENTS.map((e) =>
          el('div', { style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border)' }, [
            el('div', { style: 'width:38px;height:38px;border-radius:10px;background:var(--success-soft);display:grid;place-items:center;flex:none;color:var(--success-fg)' }, [ic(e.icon, 20)]),
            el('div', { style: 'flex:1;min-width:0;font-size:13.5px;font-weight:500', text: e.title }),
            el('div', { style: 'color:var(--text-3);font-size:12px;flex:none', text: e.when })
          ])
        )
      )
    );

    return out;
  }

  const PREVIEWS = { duplicate: dupPreview, scheduled: schedPreview, guard: guardPreview };

  // ============================================================
  //  SCREEN
  // ============================================================
  // Shared renderer for one tool page: its own header (title + pitch + the
  // right-side action button) followed by that tool's preview content. No tab
  // chips, each tool is a standalone screen.
  function renderTool(host, tool) {
    const root = el('div', { class: 'sp-fadeup', 'data-screen-label': tool.name });

    // header: title + pitch on the left, primary action on the right
    root.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:24px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: tool.name }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px', text: tool.pitch })
        ]),
        el('button', {
          style: 'height:46px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;font-family:inherit;flex:none',
          hov: 'background:var(--accent-hover)',
          onclick: () => SP.toast(tool.toast[0], tool.toast[1])
        }, [ic(tool.actionIcon, 17), tool.actionLabel])
      ])
    );

    // tool preview content
    (PREVIEWS[tool.key]() || []).forEach((node) => root.appendChild(node));

    host.appendChild(root);
  }

  // Register one screen per tool: SP.screens.scheduled / .duplicate / .guard.
  TOOLS.forEach((tool) => {
    SP.screens[tool.key] = function (host) { renderTool(host, tool); };
  });
})();
