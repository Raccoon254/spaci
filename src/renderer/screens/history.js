'use strict';
/* History screen, Spaci v2. A log of every cleanup operation Spaci has run.
   Faithful to design/spaci-v2-reference.html (data-screen-label="History").
   Data comes from window.api.historyGet(); each entry is the shape written by
   the main process clean handler:
     { at, scope, label, count, freed, reversible, items } */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // Map a cleanup scope to an icon for its row avatar.
  const SCOPE_ICON = {
    projects: 'folder-2',
    project: 'folder-2',
    system: 'broom',
    largefiles: 'chart',
    'large-files': 'chart',
    storage: 'database',
    duplicates: 'copy'
  };
  function scopeIcon(e) {
    return SCOPE_ICON[(e.scope || '').toLowerCase()] || 'box';
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

  // Summary strip: operations, total items, total freed.
  function statsStrip(host, list) {
    const totalFreed = list.reduce((a, e) => a + (Number(e.freed) || 0), 0);
    const totalItems = list.reduce((a, e) => a + (Number(e.count) || 0), 0);
    const stats = [
      { icon: 'clock', label: 'Operations', value: String(list.length), color: 'var(--text)' },
      { icon: 'box', label: 'Items cleaned', value: String(totalItems), color: 'var(--text)' },
      { icon: 'sparkles', label: 'Total freed', value: fmt(totalFreed), color: 'var(--accent-fg)' }
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

  function row(e) {
    const reversible = !!e.reversible;
    const count = Number(e.count) || 0;
    const meta = whenOf(e.at) + '  ·  ' + count + (count === 1 ? ' item' : ' items');

    return el('div', {
      class: 'sp-hov',
      style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-sm);transition:border-color .16s,transform .16s',
      hov: 'border-color:var(--border-2);transform:translateX(2px)'
    }, [
      el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(scopeIcon(e), 22)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px' }, [
          el('span', { text: titleOf(e) }),
          el('span', {
            class: reversible ? 'sp-badge-accent' : 'sp-badge-safe',
            style: 'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700'
          }, reversible ? [ic('undo', 12), 'Reversible'] : [ic('lock', 12), 'Permanent'])
        ]),
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: meta })
      ]),
      el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(e.freed) }),
      ic(reversible ? 'undo' : 'lock', 17, { color: 'var(--text-4)' })
    ]);
  }

  function emptyState(host) {
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:64px 24px;min-height:300px' }, [
        el('spaci-icon', { name: 'spaci-ring', anim: 'breathe', style: 'width:64px;height:64px;color:var(--text-4);display:block' }),
        el('div', {}, [
          el('div', { style: 'font-size:19px;font-weight:700;letter-spacing:-.4px', text: 'Nothing cleaned yet' }),
          el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px;max-width:380px', text: 'Once you reclaim space with Spaci, every cleanup will show up here with what was freed and whether it can be undone.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--accent-hover)',
          onclick: () => SP.go('dashboard')
        }, [ic('scan', 16), 'Run a Smart Scan'])
      ])
    );
  }

  function loadingState(host) {
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:18px;padding:64px 24px;min-height:300px;color:var(--accent-fg)' }, [
        ring('orbit', 56),
        el('div', { style: 'color:var(--text-3);font-size:13.5px', text: 'Loading history…' })
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

  // Render the populated screen (header + stats + completed list).
  function renderList(host, list) {
    header(host, () => clearLog(host));
    statsStrip(host, list);
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: 'Completed' }));
    host.appendChild(el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' }, list.map(row)));
  }

  async function clearLog(host) {
    try {
      await window.api.historyClear();
    } catch (err) {
      console.error('[history] clear failed', err && err.message);
    }
    // Re-render from a clean slate (likely the empty state now).
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
        emptyState(host);
        return;
      }
      // Newest first (entries are already unshifted, but guard anyway).
      list = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      renderList(host, list);
    })();
  };
})();
