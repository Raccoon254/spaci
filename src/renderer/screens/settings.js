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

  // 46x26 pill toggle. ON adds class "sp-tog-on" (CSS animates the knob).
  function toggle(on, onClick) {
    return el(
      'div',
      {
        onclick: onClick,
        class: on ? 'sp-tog-on' : '',
        style:
          'width:46px;height:26px;border-radius:99px;position:relative;cursor:pointer;flex:none;border:1px solid var(--border);transition:background .2s',
      },
      [
        el('span', {
          class: 'sp-knob',
          style:
            'position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--text-2);transition:transform .2s,background .2s',
        }),
      ]
    );
  }

  function row(label, desc, control, last) {
    const style =
      'display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 0' +
      (last ? '' : ';border-bottom:1px solid var(--border)');
    return el('div', { style }, [
      el('div', {}, [
        el('div', { style: 'font-weight:600;font-size:14.5px', text: label }),
        desc && el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:3px', text: desc }),
      ]),
      control,
    ]);
  }

  // Persist a prefs patch and keep the local copy in sync. Wrapped in try/catch
  // so a failing IPC call never throws into the render path.
  async function patchPrefs(store, patch, rerender) {
    Object.assign(store.prefs, patch);
    if (rerender) SP.go('settings');
    try {
      const next = await api.setPrefs(patch);
      if (next) store.prefs = next;
    } catch (_) {}
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
        el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px;margin-bottom:7px', text: 'Settings' }),
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
  };

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
        'Let Spaci scan periodically while it runs in the background.',
        toggle(!!p.backgroundScans, () => patchPrefs(store, { backgroundScans: !p.backgroundScans }, true))
      )
    );

    // Desktop notifications (notify pref, persisted via setPrefs)
    card.appendChild(
      row(
        'Desktop notifications',
        'Get notified when a scan or clean finishes.',
        toggle(!!p.notify, () => patchPrefs(store, { notify: !p.notify }, true))
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
          S.theme = theme;
          const appRoot = document.getElementById('app');
          if (appRoot) appRoot.classList.toggle('light', light);
          patchPrefs(store, { theme }, false);
          SP.go('settings');
        })
      )
    );

    // Appearance font (segmented chip selector: System / Inter / Mono).
    const fontSeg = el('div', {
      style:
        'display:flex;gap:6px;background:var(--panel-2);padding:4px;border-radius:11px;border:1px solid var(--border)',
    }, ['System', 'Inter', 'Mono'].map((name) => {
      const on = name === activeFont;
      return el('div', {
        class: on ? 'sp-chip-on' : '',
        style: 'padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--text-2)',
        onclick: () => {
          applyFont(name);
          patchPrefs(store, { font: name }, true);
        },
        text: name,
      });
    }));
    card.appendChild(row('Appearance font', 'Typeface used across the app.', fontSeg, true));

    host.appendChild(card);

    // ---------- About Spaci card ----------
    // Faithful to design/spaci-v2-reference.html: animated brand logo, "Spaci."
    // wordmark + version, a one-line tagline, kentom.co.ke attribution, a row of
    // ghost link pills, and the live Updates row (wiring preserved).
    const u = store.update || { state: 'idle' };
    const bits = updateBits(u);

    // Section label, matching the reference's uppercase "About" header.
    host.appendChild(
      el('div', {
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
      text: store.version ? 'Version ' + store.version : 'Version 1.2.0',
    });
    // If the cached version is missing, fetch it async and fill in place.
    if (!store.version) {
      api
        .appVersion()
        .then((v) => {
          store.version = v || '1.2.0';
          versionLine.textContent = 'Version ' + store.version;
        })
        .catch(() => {});
    }

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
    const metaVersion = metaChip('box', 'Version', store.version || '1.2.0');
    if (!store.version) {
      api
        .appVersion()
        .then((v) => {
          store.version = v || '1.2.0';
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
              'Spaci only ever targets regenerable caches and build output, never your source code or files.',
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
