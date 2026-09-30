'use strict';
/* Welcome / onboarding, Spaci v2. Faithful to design/spaci-v2-reference.html
   (the "WELCOME (full-screen, no sidebar)" block). A 4-step flow: intro, what a
   scan looks at (informational, no toggles), access and privacy (Full Disk
   Access explained, the anonymous usage count with its switch), and a safety
   recap, with step dots and Back/Next.

   Nothing is scanned until the user clicks "Start scanning" on the last step:
   that click persists onboarding completion (api.setPrefs({ onboarded: true })),
   routes to the dashboard and only then starts the first scan. */
(function () {
  const SP = window.SP;
  const { el, ic, ring } = SP;
  const isMac = SP.platform === 'mac';
  const machine = isMac ? 'Mac' : 'computer';

  const STEPS = [
    { title: 'A cleaner ' + machine + ', the safe way', body: 'Spaci finds gigabytes in caches and build artifacts, and removes only what you choose.', anim: 'spiral', color: 'var(--accent-fg)', btn: 'Get started' },
    { title: 'What Spaci looks at', body: 'When you start a scan, Spaci looks in these places and lists what it finds. Nothing is removed until you review it and choose it.', anim: 'aperture', color: 'var(--accent-fg)', btn: 'Continue' },
    { title: 'Access and privacy', body: 'What Spaci can read, and the one thing it sends.', anim: 'breathe', color: 'var(--accent-fg)', btn: 'Continue' },
    { title: "You're all set.", body: 'A quick reminder of how Spaci keeps you safe. Your first scan starts when you click the button below.', anim: 'elastic', color: 'var(--success-fg)', btn: 'Start scanning' }
  ];

  // Step 2: what a scan covers. Informational only: there are no toggles, since
  // no setting backs them.
  const OPTIONS = [
    { key: 'projects', icon: 'folder-2', title: 'Project build artifacts', sub: 'node_modules, target, dist, .next and friends.' },
    { key: 'devcaches', icon: 'broom', title: 'Developer caches', sub: 'Package managers, build tools and SDK caches.' },
    { key: 'system', icon: 'cpu', title: 'System and app caches', sub: 'Caches, logs and app data across your ' + machine + ', with risky items marked.' }
  ];

  // Step 4: safety recap value props.
  const FEATURES = [
    { icon: 'scanner', title: 'One Smart Scan finds it all', sub: 'Project build output, package caches and system junk, surfaced in seconds.' },
    { icon: 'shield', title: 'You stay in control', sub: 'Spaci removes nothing until you review it and choose it. Items that cannot be undone are marked Permanent.' },
    { icon: 'document-text', title: 'Every clean is logged', sub: 'History records what was removed. Build artifacts rebuild on your next install or build.' }
  ];

  const CARD = 'display:flex;align-items:center;gap:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:14px;text-align:left';

  function infoRow(o, extra) {
    return el('li', { style: CARD }, [
      ic(o.icon, 22, { color: 'var(--accent-fg)' }),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { id: o.id ? o.id + '-l' : null, style: 'font-size:14.5px;font-weight:600', text: o.title }),
        el('div', { id: o.id ? o.id + '-d' : null, style: 'color:var(--text-3);font-size:12.5px;margin-top:1px;line-height:1.5', text: o.sub })
      ]),
      extra || null
    ]);
  }

  // Same pill switch as Settings (role="switch", aria-checked).
  function switchEl(on, id, onClick) {
    return el('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      'aria-labelledby': id + '-l',
      'aria-describedby': id + '-d',
      class: on ? 'sp-tog-on' : '',
      style: 'width:46px;height:26px;border-radius:99px;position:relative;cursor:pointer;flex:none;border:1px solid var(--border-2);background:var(--panel-3);transition:background .2s;padding:0',
      onclick: onClick
    }, [el('span', { class: 'sp-knob', 'aria-hidden': 'true', style: 'position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;transition:transform .2s,background .2s' })]);
  }

  // Persist onboarding completion, route to the dashboard, then start the first
  // scan. This is the first point at which Spaci reads the disk.
  async function getStarted() {
    try { await api.setPrefs({ onboarded: true }); } catch (_) {}
    SP.go('dashboard');
    if (typeof window.SP_doScan === 'function') window.SP_doScan();
  }

  SP.screens.welcome = function (host) {
    let step = 0;
    let telemetryOn = true;
    let starting = false;
    // The usage count switch reflects the saved preference (unset counts as on).
    Promise.resolve()
      .then(() => api.getPrefs())
      .then((p) => { if (p && p.telemetry === false) { telemetryOn = false; if (step === 2) render(false); } })
      .catch(() => {});

    function setTelemetry(on) {
      telemetryOn = on;
      try { api.setPrefs({ telemetry: on }); } catch (_) {}
      render(false);
      const sw = host.querySelector('[role="switch"]');
      if (sw) sw.focus();
    }

    function accessStep() {
      const access = isMac
        ? { icon: 'lock', title: 'Full Disk Access is optional', sub: 'macOS keeps some folders private, such as Mail and Safari data. Without Full Disk Access Spaci skips them and tells you. You can grant it later in System Settings > Privacy & Security > Full Disk Access.' }
        : { icon: 'lock', title: 'Only folders you can read', sub: 'Spaci reads the folders it scans with your own account. Anything your account cannot read is skipped, and Spaci tells you.' };
      const local = { icon: 'shield', title: 'Your files stay on this ' + machine, sub: 'Scans run locally. File names, paths and sizes are never sent anywhere.' };
      const usage = { id: 'sp-onb-usage', icon: 'chart', title: 'Anonymous usage count', sub: 'Once a day Spaci sends a random install ID, the app version and your operating system, so we know how many people use it. Switch it off here or later in Settings.' };
      return el('ul', { style: 'list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:34px;width:100%' }, [
        infoRow(access),
        infoRow(local),
        infoRow(usage, switchEl(telemetryOn, usage.id, () => setTelemetry(!telemetryOn)))
      ]);
    }

    function render(moveFocus) {
      host.innerHTML = '';
      const c = STEPS[step];

      const heroRing = ring(c.anim, 108, c.color);
      heroRing.setAttribute('style', 'width:108px;height:108px;display:block;margin:0 auto 22px;color:' + c.color);

      const wordmark = el('div', { style: 'font-size:17px;font-weight:700;letter-spacing:-.4px;margin-bottom:26px' }, [
        el('span', { text: 'Spaci' }),
        el('span', { style: 'color:var(--accent-fg)', text: '.' })
      ]);

      // Step dots + "Step N of 4" label.
      const dots = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:26px' }, [
        ...STEPS.map((_, i) => el('i', {
          'aria-hidden': 'true',
          style: 'width:' + (i === step ? '22px' : '4px') + ';height:4px;border-radius:99px;background:' + (i === step ? 'var(--accent-fg)' : 'var(--border-2)') + ';transition:all .3s;display:block'
        })),
        el('span', { style: 'font-size:12px;color:var(--text-3);margin-left:8px;font-weight:500', text: 'Step ' + (step + 1) + ' of ' + STEPS.length })
      ]);

      const heading = el('h1', { tabindex: '-1', style: 'font-size:40px;font-weight:700;letter-spacing:-1.4px;line-height:1.08;margin-bottom:14px;outline:none', text: c.title });
      const list = (items) => el('ul', { style: 'list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:34px;width:100%' }, items.map((o) => infoRow(o)));

      // Per-step content (animates on each step change).
      const content = el('div', { class: 'sp-fadeup', style: 'width:100%;display:flex;flex-direction:column;align-items:center' }, [
        heading,
        el('p', { style: 'font-size:16px;line-height:1.6;color:var(--text-2);margin-bottom:34px;max-width:430px', text: c.body }),
        step === 1 ? list(OPTIONS) : null,
        step === 2 ? accessStep() : null,
        step === 3 ? list(FEATURES) : null
      ]);

      const last = step === STEPS.length - 1;
      const next = el('button', {
        style: 'height:54px;padding:0 32px;border-radius:14px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:16px;display:inline-flex;align-items:center;gap:11px;cursor:pointer;font-family:inherit' + (starting ? ';opacity:.6;pointer-events:none' : ''),
        hov: 'background:var(--accent-hover)',
        onclick: () => {
          if (!last) { step += 1; render(true); return; }
          if (starting) return;
          starting = true;
          getStarted();
        }
      }, [c.btn, ic('chevron-right', 18)]);

      const actions = el('div', { style: 'display:flex;gap:12px;align-items:center' }, [
        step > 0 ? el('button', {
          style: 'height:54px;padding:0 22px;border-radius:14px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:15px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel-3)',
          onclick: () => { step = Math.max(0, step - 1); render(true); }
        }, ['Back']) : null,
        next
      ]);

      const panel = el('div', {
        style: 'width:100%;max-width:540px;margin:0 auto;padding:40px 32px;display:flex;flex-direction:column;align-items:center;text-align:center'
      }, [heroRing, wordmark, dots, content, actions]);

      host.appendChild(el('div', {
        'data-screen-label': 'Welcome',
        style: 'display:flex;justify-content:center;min-height:70vh'
      }, [panel]));

      // On a step change, move focus to the new heading so a screen reader
      // reads the new step instead of staying on a button that re-rendered.
      if (moveFocus) { try { heading.focus({ preventScroll: true }); } catch (_) {} }
    }

    render(false);
  };
})();
