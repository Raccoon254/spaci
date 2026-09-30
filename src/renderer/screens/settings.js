'use strict';
/* Settings screen, Spaci v2. Faithful to design/spaci-v2-reference.html
   (data-screen-label="Settings"), wired to real prefs (window.api.getPrefs /
   setPrefs), the app version (api.appVersion) and the auto-updater
   (api.updateStatus / checkUpdate / installUpdate / onUpdateStatus). */
(function () {
  const SP = window.SP;
  const { el, ic, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // ---- module-scoped view state (survives re-render of this screen) ----
  // We cache prefs/version/update status on S so a re-render does not flash the
  // loading state, and so live update events can re-render in place.
  function ensureStore() {
    if (!S.settings) S.settings = { loaded: false, prefs: null, version: '', update: null, unsub: null };
    return S.settings;
  }

  // 46x26 pill switch: a real button with role="switch" and aria-checked. ON
  // adds class "sp-tog-on" (CSS moves the knob and paints it white on accent).
  function toggle(on, onClick) {
    return el(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        onclick: onClick,
        class: on ? 'sp-tog-on' : '',
        style:
          'width:46px;height:26px;border-radius:99px;position:relative;cursor:pointer;flex:none;border:1px solid var(--border-2);background:var(--panel-3);transition:background .2s;padding:0',
      },
      [
        el('span', {
          class: 'sp-knob',
          'aria-hidden': 'true',
          style:
            'position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;transition:transform .2s,background .2s',
        }),
      ]
    );
  }

  // A settings row. The control (switch, button group) is named by the row's
  // label and described by its description.
  let rowSeq = 0;
  function row(label, desc, control, last) {
    const id = 'sp-set-' + (++rowSeq);
    const style =
      'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0' +
      (last ? '' : ';border-bottom:1px solid var(--border)');
    if (control && control.getAttribute) {
      control.setAttribute('data-focus-key', label);
      if (!control.hasAttribute('aria-label')) control.setAttribute('aria-labelledby', id + '-l');
      if (desc) control.setAttribute('aria-describedby', id + '-d');
    }
    return el('div', { style }, [
      el('div', {}, [
        el('div', { id: id + '-l', style: 'font-weight:600;font-size:14.5px', text: label }),
        desc && el('div', { id: id + '-d', style: 'color:var(--text-3);font-size:12.5px;margin-top:3px', text: desc }),
      ]),
      control,
    ]);
  }

  // Persist a prefs patch and keep the local copy in sync. Wrapped in try/catch
  // so a failing IPC call never throws into the render path.
  async function patchPrefs(store, patch, rerender) {
    Object.assign(store.prefs, patch);
    if (rerender) rerenderKeepFocus();
    try {
      const next = await api.setPrefs(patch);
      if (next) store.prefs = next;
    } catch (_) {}
  }

  // Re-render this screen and put keyboard focus back on the same control (the
  // render replaces every node, so a switched switch would otherwise drop focus).
  function rerenderKeepFocus() {
    const a = document.activeElement;
    const key = a && a.getAttribute ? a.getAttribute('data-focus-key') : null;
    SP.go('settings');
    if (!key) return;
    const again = [...document.querySelectorAll('[data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === key);
    if (again) { try { again.focus({ preventScroll: true }); } catch (_) {} }
  }

  // ---- appearance font: persisted choice applied to the app root ----
  // System uses the default stack (empty = inherit from styles.css), Inter
  // prefers the Inter family with system fallback, Mono uses a monospace stack.
  const FONT_STACKS = {
    System: "",
    Inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    Mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  };
  function applyFont(name) {
    const key = FONT_STACKS[name] != null ? name : 'System';
    const root = document.getElementById('app') || document.body;
    if (root) root.style.fontFamily = FONT_STACKS[key];
  }

  function btn(label, iconName, onClick, opt) {
    opt = opt || {};
    const base =
      'height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit' +
      (opt.disabled ? ';opacity:.55;pointer-events:none' : '');
    return el(
      'button',
      { style: base, hov: opt.disabled ? null : 'background:var(--panel-3)', onclick: opt.disabled ? null : onClick },
      [iconName && ic(iconName, 15), label]
    );
  }

  // ---- updates row: maps updater status to a human label + action ----
  function updateBits(u) {
    const st = (u && u.state) || 'idle';
    if (st === 'checking') return { label: 'Checking for updates...', tone: 'var(--text-2)', action: 'busy' };
    if (st === 'available') {
      const v = u.version ? ' (' + u.version + ')' : '';
      return { label: 'Update available' + v + ', downloading...', tone: 'var(--accent-fg)', action: 'busy' };
    }
    if (st === 'downloading') {
      const p = typeof u.percent === 'number' ? u.percent : 0;
      const rate = u.bytesPerSecond ? ' at ' + fmt(u.bytesPerSecond) + '/s' : '';
      return { label: 'Downloading update... ' + p + '%' + rate, tone: 'var(--accent-fg)', action: 'busy' };
    }
    if (st === 'ready') {
      const v = u.version ? ' ' + u.version : '';
      return { label: 'Update' + v + ' ready to install.', tone: 'var(--accent-fg)', action: 'install' };
    }
    if (st === 'current') return { label: "You're on the latest version.", tone: 'var(--text-3)', action: 'check' };
    if (st === 'error') return { label: 'Update check failed: ' + (u.message || 'unknown error'), tone: 'var(--danger-fg)', action: 'check' };
    if (st === 'dev') return { label: 'Updates are disabled in development builds.', tone: 'var(--text-3)', action: 'check' };
    return { label: 'Check for the latest version of Spaci.', tone: 'var(--text-3)', action: 'check' };
  }

  SP.screens.settings = function (host) {
    const store = ensureStore();

    // header (always shown)
    host.appendChild(
      frag([
        el('h1', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px;margin-bottom:7px', text: 'Settings' }),
        el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-bottom:24px', text: 'Preferences & safety.' }),
      ])
    );

    if (!store.loaded) {
      host.appendChild(
        el(
          'div',
          {
            style:
              'display:flex;align-items:center;gap:12px;padding:40px 0;color:var(--text-3);font-size:14px',
          },
          [SP.ring('orbit', 22, 'var(--accent-fg)'), 'Loading preferences...']
        )
      );
      // Load once, then re-render. Guard against double-loads on re-entry.
      if (!store.loading) {
        store.loading = true;
        bootSettings(store);
      }
      return;
    }

    renderBody(host, store);
    // Auto-clean state changes behind this screen (a run, an approval in
    // History): refresh it on each visit, at most every few seconds.
    if (api.autoCleanGet && !store.acFetching && Date.now() - (store.acAt || 0) > 3000) {
      store.acFetching = true;
      api.autoCleanGet().then((st) => {
        store.acFetching = false;
        store.acAt = Date.now();
        const changed = JSON.stringify(st) !== JSON.stringify(store.autoClean);
        store.autoClean = st;
        if (changed && S.route === 'settings') rerenderKeepFocus();
      }).catch(() => { store.acFetching = false; });
    }
  };

  // ---------- Auto-clean (opt-in, tier A only) ----------
  // Main owns the settings (auto-clean.json, src/auto-clean.js): approval and
  // the pending preview cannot be set from here. Every change goes through
  // api.autoCleanSet, which clamps it and drops a stale preview.
  const GBb = 1024 ** 3;
  const MBb = 1024 ** 2;
  async function acPatch(store, patch) {
    try {
      const next = await api.autoCleanSet(patch);
      if (next) store.autoClean = next;
    } catch (_) {}
    store.acPreview = null;
    rerenderKeepFocus();
  }
  function seg(label, options, current, onPick) {
    return el('div', {
      role: 'radiogroup', 'aria-label': label,
      style: 'display:flex;gap:6px;background:var(--panel-2);padding:4px;border-radius:11px;border:1px solid var(--border);flex:none',
    }, options.map((o) => {
      const on = o.value === current;
      return el('button', {
        type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
        'data-focus-key': label + ':' + o.label,
        class: on ? 'sp-chip-on' : '',
        style: 'padding:7px 12px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--text-2);white-space:nowrap',
        onclick: () => { if (!on) onPick(o.value); },
        text: o.label,
      });
    }));
  }
  function whenShort(ms) {
    try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return new Date(ms).toString(); }
  }
  async function openHistoryEntry(id) {
    try {
      const list = await api.historyGet();
      const e = (Array.isArray(list) ? list : []).find((x) => x && x.id === id);
      if (e) { S.currentHistory = e; SP.go('historydetail'); return; }
    } catch (_) {}
    SP.go('history');
  }
  function autoCleanSection(store) {
    if (!api.autoCleanGet || !store.autoClean) return null;
    const st = store.autoClean;
    const cfg = st.settings || {};
    const on = !!cfg.enabled;
    const acCard = el('div', {
      'data-autoclean': '',
      style: 'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:6px 22px;box-shadow:var(--shadow-sm)',
    });
    acCard.appendChild(row(
      'Auto-clean developer files',
      'Off unless you turn it on. Moves Safe build output of projects you have not touched in a while, and large package caches, out of the way. Only on AC power while your computer is idle. The first run only shows what it would do.',
      toggle(on, () => acPatch(store, { enabled: !on })),
      !on
    ));
    if (on) {
      acCard.appendChild(row('Projects unused for', 'No file in the project changed and no git activity for this long.',
        seg('Projects unused for', [14, 30, 60, 90].map((d) => ({ value: d, label: d + ' days' })), cfg.staleDays, (v) => acPatch(store, { staleDays: v }))));
      acCard.appendChild(row('Package caches larger than', 'Smaller caches are left alone.',
        seg('Package caches larger than', [{ value: 500 * MBb, label: '500 MB' }, { value: GBb, label: '1 GB' }, { value: 5 * GBb, label: '5 GB' }], cfg.minCacheBytes, (v) => acPatch(store, { minCacheBytes: v }))));
      acCard.appendChild(row('At most per run', 'A run stops at this size. A later run takes the rest.',
        seg('At most per run', [{ value: 5 * GBb, label: '5 GB' }, { value: 20 * GBb, label: '20 GB' }, { value: 50 * GBb, label: '50 GB' }], cfg.maxRunBytes, (v) => acPatch(store, { maxRunBytes: v }))));

      // Status: waiting for approval, approved, or not run yet.
      let status;
      let action = null;
      if (st.pendingPreview) {
        status = { tone: 'var(--warn-fg)', text: 'Waiting for your approval. The preview in History lists what it would move; nothing has been moved.' };
        action = btn('Review preview', 'eye', () => openHistoryEntry(st.pendingPreview));
      } else if (st.approved) {
        status = { tone: 'var(--success-fg)', text: 'Approved. It runs about twice a day when your computer is idle on AC power.' };
      } else {
        status = { tone: 'var(--text-2)', text: 'The next run is a preview. Nothing is moved until you approve it in History.' };
      }
      const lr = st.lastRun;
      const lastLine = lr && lr.at
        ? 'Last run ' + whenShort(lr.at) + ': ' + (lr.dryRun ? 'preview, ' : '') + (lr.count ? (lr.dryRun ? 'would move ' : 'moved ') + fmt(lr.bytes) + ' from ' + lr.count + (lr.count === 1 ? ' item' : ' items') : 'nothing matched') + (lr.stopped ? ' (stopped: ' + lr.stopped + ')' : '') + '.'
        : 'It has not run yet.';
      const previewBtn = btn(store.acPreviewing ? 'Checking…' : 'What would it move now?', 'search', async () => {
        store.acPreviewing = true;
        rerenderKeepFocus();
        try { store.acPreview = await api.autoCleanPreview(); } catch (_) { store.acPreview = { error: true }; }
        store.acPreviewing = false;
        rerenderKeepFocus();
      }, { disabled: !!store.acPreviewing });
      const statusBox = el('div', { style: 'padding:16px 0' }, [
        el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px' }, [
          el('div', { style: 'min-width:0' }, [
            el('div', { style: 'font-weight:600;font-size:13.5px;color:' + status.tone + ';line-height:1.5', text: status.text }),
            el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:4px', text: lastLine }),
          ]),
          el('div', { style: 'display:flex;gap:8px;flex:none' }, [action, previewBtn]),
        ]),
      ]);
      const pv = store.acPreview;
      if (pv && !pv.error) {
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:12px' });
        list.appendChild(el('div', { style: 'font-weight:600;font-size:13px', text: pv.count ? 'Right now it would move ' + fmt(pv.bytes) + ' from ' + pv.count + (pv.count === 1 ? ' item' : ' items') + ':' : 'Right now nothing matches your rules.' }));
        (pv.candidates || []).slice(0, 6).forEach((c) => list.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:baseline;min-width:0' }, [
          el('div', { class: 'mono', title: c.path, style: 'flex:1;min-width:0;font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: c.path }),
          el('div', { style: 'font-size:12px;color:var(--text-3);flex:none', text: fmt(c.bytes) }),
        ])));
        if ((pv.candidates || []).length > 6) list.appendChild(el('div', { style: 'color:var(--text-3);font-size:12px', text: 'and ' + (pv.candidates.length - 6) + ' more.' }));
        if ((pv.skipped || []).length) list.appendChild(el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:4px', text: pv.skipped.length + ' left alone, for example: ' + pv.skipped[0].reason }));
        statusBox.appendChild(list);
      } else if (pv && pv.error) {
        statusBox.appendChild(el('div', { style: 'color:var(--danger-fg);font-size:12.5px;margin-top:10px', text: 'Spaci could not check right now.' }));
      }
      acCard.appendChild(el('div', { style: 'border-bottom:1px solid var(--border)' }, [statusBox]));
      acCard.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:flex-start;padding:16px 0;color:var(--text-3);font-size:12.5px;line-height:1.55' }, [
        ic('shield', 16, { color: 'var(--text-3)' }),
        el('div', { text: 'Only Safe items. Never app caches, AI tool data, Docker, the Trash, or anything Spaci could not verify. A project is skipped while a developer tool runs in it or when it has a .spaci-keep file. Moved items are kept for 24 hours, so you can undo a run from History.' }),
      ]));
    }
    return frag([
      el('h2', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:30px 0 14px', text: 'Auto-clean' }),
      acCard,
    ]);
  }

  // tiny local fragment helper (frag is not exported on SP)
  function frag(kids) {
    const f = document.createDocumentFragment();
    (kids || []).forEach((k) => k && f.appendChild(k));
    return f;
  }

  async function bootSettings(store) {
    let prefs = null;
    let version = '';
    let update = null;
    try { prefs = await api.getPrefs(); } catch (_) {}
    try { version = await api.appVersion(); } catch (_) {}
    try { update = await api.updateStatus(); } catch (_) {}
    try { if (api.autoCleanGet) store.autoClean = await api.autoCleanGet(); } catch (_) {}
    store.prefs = prefs || {};
    store.version = version || '';
    store.update = update || { state: 'idle' };
    store.loaded = true;
    store.loading = false;

    // Subscribe once to live update status so download/ready states reflect
    // without the user clicking again. Re-render only while on this screen.
    if (!store.unsub && api.onUpdateStatus) {
      try {
        store.unsub = api.onUpdateStatus((u) => {
          store.update = u || store.update;
          if (S.route === 'settings') SP.go('settings');
        });
      } catch (_) {}
    }

    if (S.route === 'settings') SP.go('settings');
  }

  function renderBody(host, store) {
    const p = store.prefs || {};
    const isLight = (p.theme || S.theme) === 'light';
    const scanFolder = (p.scanRoots && p.scanRoots[0]) || '~';
    const activeFont = FONT_STACKS[p.font] != null ? p.font : 'System';
    // Reflect the saved font on mount so the app root matches the active chip.
    applyFont(activeFont);

    // ---------- preferences card ----------
    const card = el('div', {
      style:
        'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:6px 22px;box-shadow:var(--shadow-sm)',
    });

    // Scan folder (read-only display, Change opens the folder picker)
    card.appendChild(
      el('div', {
        style:
          'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0;border-bottom:1px solid var(--border)',
      }, [
        el('div', {}, [
          el('div', { style: 'font-weight:600;font-size:14.5px', text: 'Scan folder' }),
          el('div', { class: 'mono', style: 'color:var(--text-3);font-size:12px;margin-top:3px', text: scanFolder }),
        ]),
        btn('Change', 'folder-open', async () => {
          try {
            const dir = await api.pickFolder();
            if (dir) await patchPrefs(store, { scanRoots: [dir] }, true);
          } catch (_) {}
        }),
      ])
    );

    // Confirm before cleaning
    card.appendChild(
      row(
        'Confirm before cleaning',
        'Always preview what will be deleted.',
        toggle(!!p.confirmBeforeClean, () => patchPrefs(store, { confirmBeforeClean: !p.confirmBeforeClean }, true))
      )
    );

    // Background scans
    card.appendChild(
      row(
        'Background scans',
        'Let Spaci scan periodically while it runs in the background. Paused on battery power or when your computer is busy.',
        toggle(!!p.backgroundScans, () => patchPrefs(store, { backgroundScans: !p.backgroundScans }, true))
      )
    );

    // Automatic update checks. Stored as `autoCheckUpdates`: on unless it has
    // been switched off (unset counts as on). The manual button always works.
    card.appendChild(
      row(
        'Check for updates automatically',
        'Spaci checks a few times a day and asks before restarting.',
        toggle(p.autoCheckUpdates !== false, () => patchPrefs(store, { autoCheckUpdates: p.autoCheckUpdates === false }, true))
      )
    );

    // Desktop notifications. Stored as `notify`: on unless switched off (main
    // shows a notification only when notify !== false), so unset counts as on.
    card.appendChild(
      row(
        'Desktop notifications',
        'System notifications when a background scan finds space, and for important Spaci news.',
        toggle(p.notify !== false, () => patchPrefs(store, { notify: p.notify === false }, true))
      )
    );

    // News and release notes. Stored as `notices`: on unless switched off.
    // Off stops fetching notices; critical ones still arrive while automatic
    // update checks are on.
    card.appendChild(
      row(
        'News and release notes',
        "Show What's new after an update and occasional notices from Spaci. Only the app version and platform are sent.",
        toggle(p.notices !== false, () => patchPrefs(store, { notices: p.notices === false }, true))
      )
    );

    // Anonymous usage counts. Stored as the `telemetry` pref: on unless it has
    // been switched off (unset counts as on).
    card.appendChild(
      row(
        'Share anonymous usage counts',
        'Once a day Spaci sends a random install ID, the app version and your operating system. Never file names, paths or sizes.',
        toggle(p.telemetry !== false, () => patchPrefs(store, { telemetry: p.telemetry === false }, true))
      )
    );

    // Light mode (theme toggle: persist + flip root class + S.theme, re-render)
    card.appendChild(
      row(
        'Light mode',
        'Switch between dark and light appearance.',
        toggle(isLight, () => {
          const light = !isLight;
          const theme = light ? 'light' : 'dark';
          if (SP.setTheme) SP.setTheme(theme);
          else {
            S.theme = theme;
            const appRoot = document.getElementById('app');
            if (appRoot) appRoot.classList.toggle('light', light);
          }
          patchPrefs(store, { theme }, false);
          rerenderKeepFocus();
        })
      )
    );

    // Appearance font (segmented chip selector: System / Inter / Mono).
    const fontSeg = el('div', {
      style:
        'display:flex;gap:6px;background:var(--panel-2);padding:4px;border-radius:11px;border:1px solid var(--border)',
      role: 'radiogroup',
    }, ['System', 'Inter', 'Mono'].map((name) => {
      const on = name === activeFont;
      return el('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': on ? 'true' : 'false',
        tabindex: on ? '0' : '-1',
        class: on ? 'sp-chip-on' : '',
        style: 'padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-2)',
        onclick: () => {
          applyFont(name);
          patchPrefs(store, { font: name }, true);
        },
        onkeydown: (e) => {
          const names = ['System', 'Inter', 'Mono'];
          const i = names.indexOf(name);
          let next = null;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = names[(i + 1) % names.length];
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = names[(i + names.length - 1) % names.length];
          if (!next) return;
          e.preventDefault();
          applyFont(next);
          patchPrefs(store, { font: next }, true);
          setTimeout(() => {
            const b = [...document.querySelectorAll('[role="radio"]')].find((x) => x.textContent === next);
            if (b) b.focus();
          }, 0);
        },
        text: name,
      });
    }));
    card.appendChild(row('Appearance font', 'Typeface used across the app.', fontSeg, true));

    host.appendChild(card);

    const acSection = autoCleanSection(store);
    if (acSection) host.appendChild(acSection);

    // ---------- About Spaci card ----------
    // Faithful to design/spaci-v2-reference.html: animated brand logo, "Spaci."
    // wordmark + version, a one-line tagline, kentom.co.ke attribution, a row of
    // ghost link pills, and the live Updates row (wiring preserved).
    const u = store.update || { state: 'idle' };
    const bits = updateBits(u);

    // Section label, matching the reference's uppercase "About" header.
    host.appendChild(
      el('h2', {
        style:
          'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:30px 0 14px',
        text: 'About',
      })
    );

    const aboutCard = el('div', {
      style:
        'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:24px;box-shadow:var(--shadow-sm)',
    });

    // Brand header: animated breathing logo + wordmark + version + tagline.
    const versionLine = el('span', {
      style: 'color:var(--text-3);font-weight:600;font-size:14px',
      text: store.version ? 'Version ' + store.version : '',
    });

    aboutCard.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:16px' }, [
        SP.ring('breathe', 46, 'var(--accent-fg)'),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.3px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
            el('span', {}, ['Spaci', el('span', { style: 'color:var(--accent-fg)', text: '.' })]),
            versionLine,
          ]),
          el('div', {
            style: 'color:var(--text-2);font-size:13px;margin-top:3px;line-height:1.5',
            text: 'Reclaim disk space with confidence.',
          }),
        ]),
      ])
    );

    // Meta chips row: Version, Built by, License (design lines 686-690).
    function metaChip(iconName, label, value) {
      return el('div', { style: 'display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text-2)' }, [
        ic(iconName, 15, { color: 'var(--text-3)' }),
        el('span', {}, [label + ' ', el('b', { style: 'font-weight:700;color:var(--text)', text: value })]),
      ]);
    }
    // No hardcoded fallback: the real version from main, or "unknown" when
    // main could not answer (it is fetched once in bootSettings and retried
    // here if that failed).
    const metaVersion = metaChip('box', 'Version', store.version || 'unknown');
    if (!store.version && !store.versionRetry) {
      store.versionRetry = true;
      Promise.resolve()
        .then(() => api.appVersion())
        .then((v) => {
          if (!v) return;
          store.version = String(v);
          versionLine.textContent = 'Version ' + store.version;
          const b = metaVersion.querySelector('b');
          if (b) b.textContent = store.version;
        })
        .catch(() => {});
    }
    aboutCard.appendChild(
      el('div', {
        style:
          'display:flex;flex-wrap:wrap;align-items:center;gap:10px 30px;padding:18px 0 4px;margin-top:18px;border-top:1px solid var(--border)',
      }, [
        metaVersion,
        metaChip('heart', 'Built by', 'kentom.co.ke'),
        metaChip('shield', 'License', 'MIT'),
      ])
    );

    // Link pills (ghost style with hover), opened in the system browser.
    function linkBtn(label, iconName, url) {
      const base =
        'height:40px;padding:0 16px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit';
      return el('button', {
        style: base,
        hov: 'background:var(--panel-3)',
        onclick: () => { try { api.openExternal(url); } catch (_) {} },
      }, [ic(iconName, 15), label]);
    }

    aboutCard.appendChild(
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;margin-top:16px' }, [
        linkBtn('GitHub', 'github', 'https://github.com/Raccoon254/spaci'),
        linkBtn('Website', 'external-link', 'https://spaci.kentom.co.ke'),
        linkBtn('Donate', 'heart', 'https://www.kentom.co.ke/donate'),
        linkBtn('Partners', 'sparkles', 'https://www.kentom.co.ke/partners'),
      ])
    );

    // ---------- Updates row (wiring preserved) ----------
    let action;
    if (bits.action === 'install') {
      action = btn('Restart to update', 'refresh', async () => {
        try { await api.installUpdate(); } catch (_) {}
      });
    } else if (bits.action === 'busy') {
      action = el('div', { style: 'display:flex;align-items:center;gap:9px;color:var(--accent-fg)' }, [SP.ring('orbit', 18)]);
    } else {
      action = btn('Check for updates', 'refresh', async () => {
        store.update = { state: 'checking' };
        SP.go('settings');
        try {
          const next = await api.checkUpdate();
          if (next) store.update = next;
        } catch (_) {
          store.update = { state: 'error', message: 'Could not reach the update server.' };
        }
        if (S.route === 'settings') SP.go('settings');
      });
    }

    aboutCard.appendChild(
      el('div', {
        style:
          'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0 0;margin-top:18px;border-top:1px solid var(--border)',
      }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14.5px', text: 'Updates' }),
          el('div', { style: 'font-size:12.5px;margin-top:3px;color:' + bits.tone, text: bits.label }),
        ]),
        action,
      ])
    );

    host.appendChild(aboutCard);

    // ---------- Diagnostics: where the log file lives ----------
    host.appendChild(
      el('h2', {
        style:
          'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:30px 0 14px',
        text: 'Diagnostics',
      })
    );
    const diag = el('div', {
      style: 'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:6px 22px;box-shadow:var(--shadow-sm)',
    });
    const hasLog = typeof api.logPath === 'function';
    const logText = el('div', {
      class: 'mono',
      style: 'color:var(--text-3);font-size:12px;margin-top:3px;overflow-wrap:anywhere',
      text: !hasLog ? 'Not available in this build.' : store.logPath || 'Looking up the log file...',
    });
    if (hasLog && !store.logPath && !store.logLoading) {
      store.logLoading = true;
      Promise.resolve()
        .then(() => api.logPath())
        .then((lp) => {
          store.logPath = typeof lp === 'string' && lp ? lp : '';
          logText.textContent = store.logPath || 'Not available in this build.';
          if (S.route === 'settings' && store.logPath) SP.go('settings');
        })
        .catch(() => { logText.textContent = 'Not available in this build.'; });
    }
    const logActions = store.logPath
      ? el('div', { style: 'display:flex;gap:8px;flex:none' }, [
          btn('Copy path', 'copy', async () => {
            try { await navigator.clipboard.writeText(store.logPath); SP.toast('Log path copied', store.logPath); }
            catch (_) { SP.toast('Could not copy', 'Select the path and copy it instead.'); }
          }),
          btn('Show in folder', 'folder-open', async () => {
            let r = 'Not allowed';
            try { r = await api.reveal(store.logPath); } catch (_) {}
            if (r) SP.toast('Could not open the folder', 'Copy the path and open it from your file manager.');
          }),
        ])
      : null;
    diag.appendChild(
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0' }, [
        el('div', { style: 'min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14.5px', text: 'Log file' }),
          el('div', { style: 'color:var(--text-2);font-size:12.5px;margin-top:3px', text: 'Errors and crashes are written here. Attach it when you report a problem.' }),
          logText,
        ]),
        logActions,
      ])
    );
    host.appendChild(diag);

    // ---------- safe-by-design banner ----------
    host.appendChild(
      el('div', {
        style:
          'display:flex;align-items:center;gap:14px;padding:18px 20px;border-radius:16px;background:var(--accent-soft);border:1px solid var(--border);margin-top:18px',
      }, [
        ic('shield', 26, { color: 'var(--accent-fg)' }),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:600;font-size:14px', text: 'Safe by design' }),
          el('div', {
            style: 'color:var(--text-2);font-size:12.5px;margin-top:2px',
            text:
              'Spaci never touches your source code. Build output and caches it has verified rebuild on their own; anything permanent, and files you pick in Large Files, are only removed after you confirm, and large files go to the Trash.',
          }),
        ]),
        el('button', {
          style:
            'height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel);color:var(--text);font-weight:600;font-size:13px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel-2)',
          onclick: () => {
            patchPrefs(store, { onboarded: false }, false);
            SP.go('welcome');
          },
          text: 'Replay welcome',
        }),
      ])
    );
  };
})();
