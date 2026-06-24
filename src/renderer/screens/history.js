'use strict';
/* History screen, Spaci v2. A log of every cleanup operation Spaci has run.
   Faithful to design/spaci-v2-reference.html (data-screen-label="History" and
   data-screen-label="Action detail").
   Data comes from window.api.historyGet(); each entry is the shape written by
   the main process clean handler (src/main.js):
     { at, scope, label, count, freed, reversible, items } */
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

  // Noun used for an entry's item count, tuned to its scope.
  function itemNoun(e, count) {
    const scope = (e.scope || '').toLowerCase();
    if (scope === 'system') return count === 1 ? 'cache' : 'caches';
    if (scope === 'largefiles' || scope === 'large-files') return count === 1 ? 'file' : 'files';
    return count === 1 ? 'item' : 'items';
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
      { icon: 'box', label: 'Clean-ups', value: String(list.length), color: 'var(--text)' },
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
    const reversible = !!e.reversible;
    const count = Number(e.count) || 0;
    const meta = count + ' ' + itemNoun(e, count) + ' · ' + whenOf(e.at);

    return el('div', {
      class: 'sp-hov',
      style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-sm);transition:border-color .16s,transform .16s;cursor:pointer',
      hov: 'border-color:var(--border-2);transform:translateX(2px)',
      onclick: () => { S.currentHistory = e; SP.go('historydetail'); }
    }, [
      el('div', { style: 'width:52px;height:52px;border-radius:14px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(scopeIcon(e), 24)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:9px' }, [
          el('span', { text: titleOf(e) }),
          el('span', {
            class: reversible ? 'sp-badge-safe' : 'sp-badge-warn',
            style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700',
            text: reversible ? 'reversible' : 'permanent'
          })
        ]),
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: meta })
      ]),
      el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(e.freed) }),
      ic(reversible ? 'undo-arrow' : 'lock', 17, { color: 'var(--text-4)' }),
      ic('chevron-right', 18, { color: 'var(--text-4)' })
    ]);
  }

  function emptyState(host) {
    host.appendChild(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:64px 24px;min-height:320px' }, [
        // Animated brand logo, not a static icon.
        el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
        el('div', {}, [
          el('div', { style: 'font-size:19px;font-weight:700;letter-spacing:-.4px', text: 'Nothing cleaned yet' }),
          el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px;max-width:380px', text: 'Once you reclaim space with Spaci, every cleanup shows up here with what was freed and whether it can be undone.' })
        ]),
        el('button', {
          style: 'height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:9px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--accent-hover)',
          onclick: () => SP.go('dashboard')
        }, [ic('scanner', 16), 'Run a Smart Scan'])
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

  // Restore-note copy depends on whether the cleanup can be undone, and on what
  // kind of data it removed.
  function restoreCopy(e) {
    const scope = (e.scope || '').toLowerCase();
    if (!e.reversible) {
      return {
        title: 'Permanent deletion',
        text: 'This was a permanent deletion of files on disk and cannot be undone. The items below were removed for good, so make sure you no longer need them.'
      };
    }
    if (scope === 'system') {
      return {
        title: 'How to restore',
        text: 'These caches regenerate automatically the next time the apps that own them run. Nothing to do, and nothing is lost.'
      };
    }
    return {
      title: 'How to restore',
      text: 'These are build artifacts and dependencies, so this is fully reversible. Restore them by re-running your install or build (npm install, pod install, cargo build, and so on).'
    };
  }

  SP.screens.historydetail = function (host) {
    const e = S.currentHistory;
    if (!e) { SP.go('history'); return; }

    const reversible = !!e.reversible;
    const count = Number(e.count) || 0;
    const items = Array.isArray(e.items) ? e.items : [];
    const note = restoreCopy(e);

    // back button -> History
    host.appendChild(
      el('button', {
        style: 'height:36px;padding:0 13px 0 11px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
        hov: 'background:var(--panel);color:var(--text)',
        onclick: () => SP.go('history')
      }, [ic('arrow-left', 16), 'History'])
    );

    // header: scope icon + name + badge + when + freed total
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;margin-bottom:22px' }, [
        el('div', { style: 'width:58px;height:58px;border-radius:15px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(scopeIcon(e), 31)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:25px;font-weight:700;letter-spacing:-.7px;display:flex;align-items:center;gap:11px;flex-wrap:wrap' }, [
            el('span', { text: titleOf(e) }),
            el('span', {
              class: reversible ? 'sp-badge-safe' : 'sp-badge-warn',
              style: 'display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;font-size:11.5px;font-weight:700'
            }, reversible ? [ic('undo-arrow', 13), 'Reversible'] : [ic('lock', 13), 'Permanent'])
          ]),
          el('div', { style: 'color:var(--text-3);font-size:13px;margin-top:5px', text: whenExact(e.at) })
        ]),
        el('div', { style: 'font-weight:700;font-size:26px;letter-spacing:-1px;color:var(--accent-fg);flex:none', text: fmt(e.freed) })
      ])
    );

    // stats strip: space freed / items / when
    const detailStats = [
      { icon: 'hard-drive', label: 'Space freed', value: fmt(e.freed), color: 'var(--accent-fg)' },
      { icon: 'box', label: 'Items', value: String(count), color: 'var(--text)' },
      { icon: 'clock', label: 'When', value: whenOf(e.at), color: 'var(--text)' }
    ];
    host.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px 32px;padding:16px 2px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:22px' },
        detailStats.map((s) => el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--text-2)' }, [
          ic(s.icon, 16, { color: 'var(--text-3)' }),
          el('span', { text: s.label }),
          el('b', { style: 'color:' + s.color + ';font-weight:700', text: s.value })
        ])))
    );

    // restore note card, with a Restore affordance when reversible
    const noteChildren = [
      el('div', { style: 'flex:none;color:var(--accent-fg);margin-top:2px' }, [ic(reversible ? 'undo' : 'lock', 22)]),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-weight:700;font-size:14.5px;margin-bottom:4px', text: note.title }),
        el('div', { style: 'color:var(--text-2);font-size:13px;line-height:1.55', text: note.text })
      ])
    ];
    if (reversible) {
      noteChildren.push(
        el('button', {
          style: 'height:42px;padding:0 18px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none;align-self:center',
          hov: 'background:var(--accent-hover)',
          onclick: () => {
            if (SP.toast) SP.toast('Restoring.', 'Re-run install or build to bring these artifacts back');
          }
        }, [ic('undo-arrow', 15), 'Restore'])
      );
    }
    host.appendChild(
      el('div', {
        style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-radius:16px;background:' + (reversible ? 'var(--accent-soft)' : 'var(--panel)') + ';border:1px solid var(--border);margin-bottom:20px'
      }, noteChildren)
    );

    // list of cleaned items / paths
    host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin-bottom:12px', text: 'Cleaned items' + (items.length ? ' (' + items.length + ')' : '') }));

    if (!items.length) {
      host.appendChild(
        el('div', { style: 'padding:18px 20px;border-radius:14px;background:var(--panel);border:1px solid var(--border);color:var(--text-3);font-size:13px', text: 'No individual paths were recorded for this cleanup.' })
      );
    } else {
      host.appendChild(
        el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:7px' },
          items.map((p) =>
            el('div', { style: 'display:flex;align-items:center;gap:13px;padding:12px 15px;border-radius:12px;background:var(--panel);border:1px solid var(--border)' }, [
              ic(pathIcon(e, p), 18, { color: 'var(--text-3)' }),
              el('div', { class: 'mono', style: 'flex:1;min-width:0;font-size:12.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: String(p) })
            ])
          )
        )
      );
    }
  };
})();
