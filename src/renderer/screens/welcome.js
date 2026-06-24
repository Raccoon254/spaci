'use strict';
/* Welcome / onboarding, Spaci v2. Faithful to design/spaci-v2-reference.html
   (the "WELCOME (full-screen, no sidebar)" block). A 3-step flow: intro, choose
   what to clean (toggleable targets), and a safety recap, with step dots and
   Back/Next. The final step persists onboarding completion via
   api.setPrefs({ onboarded: true }), routes to the dashboard, and starts the
   first scan. */
(function () {
  const SP = window.SP;
  const { el, ic, ring } = SP;

  const STEPS = [
    { title: 'A cleaner Mac, the safe way', body: 'Spaci reclaims gigabytes from regenerable caches and build artifacts, never your code or real files.', anim: 'spiral', color: 'var(--accent-fg)', btn: 'Get started' },
    { title: 'What should Spaci clean?', body: 'Pick what Spaci targets. Everything here is regenerable, so it is always safe to remove.', anim: 'aperture', color: 'var(--accent-fg)', btn: 'Continue' },
    { title: "You're all set.", body: 'A quick reminder of how Spaci keeps you safe before your first scan.', anim: 'elastic', color: 'var(--success-fg)', btn: 'Start scanning' }
  ];

  // Step 2: toggleable scan targets (everything regenerable, default on).
  const OPTIONS = [
    { key: 'projects', icon: 'folder-2', title: 'Project build artifacts', sub: 'node_modules, target, dist, .next and friends.' },
    { key: 'devcaches', icon: 'broom', title: 'Developer caches', sub: 'Package managers, build tools and SDK caches.' },
    { key: 'system', icon: 'cpu', title: 'System and app caches', sub: 'Regenerable caches and logs across your Mac.' }
  ];
  const targets = { projects: true, devcaches: true, system: true };

  // Step 3: safety recap value props.
  const FEATURES = [
    { icon: 'scanner', title: 'One Smart Scan finds it all', sub: 'Project build output, package caches and system junk, surfaced in seconds.' },
    { icon: 'shield', title: 'Safe by design', sub: 'Spaci only targets regenerable caches and build output, never your source.' },
    { icon: 'undo-arrow', title: 'Reversible cleanups', sub: 'Every action is logged in History, and most can be restored in one click.' }
  ];

  function optionRow(o, onToggle) {
    const on = targets[o.key];
    return el('div', {
      class: 'sp-hov',
      style: 'display:flex;align-items:center;gap:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:14px;text-align:left;cursor:pointer',
      hov: 'border-color:var(--border-2)',
      onclick: onToggle
    }, [
      ic(o.icon, 22, { color: 'var(--accent-fg)' }),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-size:14.5px;font-weight:600', text: o.title }),
        el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:1px', text: o.sub })
      ]),
      el('div', {
        class: 'sp-check' + (on ? ' sp-check-on' : ''),
        style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s'
      }, [ic('tick', 14)])
    ]);
  }

  function featureRow(f) {
    return el('div', {
      style: 'display:flex;align-items:center;gap:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:14px;text-align:left'
    }, [
      ic(f.icon, 22, { color: 'var(--accent-fg)' }),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-size:14.5px;font-weight:600', text: f.title }),
        el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:1px', text: f.sub })
      ])
    ]);
  }

  // Persist onboarding completion, route to the dashboard, then start scanning.
  async function getStarted() {
    try { await api.setPrefs({ onboarded: true }); } catch (_) {}
    // The scan was already kicked off in the background when onboarding began.
    SP.go('dashboard');
  }

  SP.screens.welcome = function (host) {
    let step = 0;

    // Start indexing in the background the moment onboarding begins, so results
    // are ready by the time the user lands on the dashboard. Fires once.
    if (!SP.state._onbScanStarted) {
      SP.state._onbScanStarted = true;
      try { api.scanNow && api.scanNow(); } catch (_) {}
      try { SP.toast('Background scan started', 'Spaci is indexing your Mac while you get set up.', { side: 'left' }); } catch (_) {}
    }

    function render() {
      host.innerHTML = '';
      const c = STEPS[step];

      const heroRing = ring(c.anim, 108, c.color);
      heroRing.setAttribute('style', 'width:108px;height:108px;display:block;margin:0 auto 22px;color:' + c.color);

      const wordmark = el('div', { style: 'font-size:17px;font-weight:700;letter-spacing:-.4px;margin-bottom:26px' }, [
        el('span', { text: 'Spaci' }),
        el('span', { style: 'color:var(--accent-fg)', text: '.' })
      ]);

      // Step dots + "Step N of 3" label.
      const dots = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:26px' }, [
        ...[0, 1, 2].map((i) => el('i', {
          style: 'width:' + (i === step ? '22px' : '4px') + ';height:4px;border-radius:99px;background:' + (i === step ? 'var(--accent-fg)' : 'var(--border)') + ';transition:all .3s;display:block'
        })),
        el('span', { style: 'font-size:12px;color:var(--text-3);margin-left:8px;font-weight:500', text: 'Step ' + (step + 1) + ' of 3' })
      ]);

      // Per-step content (animates on each step change).
      const content = el('div', { class: 'sp-fadeup', style: 'width:100%;display:flex;flex-direction:column;align-items:center' }, [
        el('div', { style: 'font-size:40px;font-weight:700;letter-spacing:-1.4px;line-height:1.08;margin-bottom:14px', text: c.title }),
        el('div', { style: 'font-size:16px;line-height:1.6;color:var(--text-2);margin-bottom:34px;max-width:430px', text: c.body }),
        step === 1 ? el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-bottom:34px;width:100%' },
          OPTIONS.map((o) => optionRow(o, () => { targets[o.key] = !targets[o.key]; render(); }))) : null,
        step === 2 ? el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-bottom:34px;width:100%' },
          FEATURES.map(featureRow)) : null
      ]);

      const next = el('button', {
        style: 'height:54px;padding:0 32px;border-radius:14px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:16px;display:inline-flex;align-items:center;gap:11px;cursor:pointer;font-family:inherit',
        hov: 'background:var(--accent-hover)',
        onclick: () => { if (step < STEPS.length - 1) { step += 1; render(); } else getStarted(); }
      }, [c.btn, ic('arrow-right', 18)]);

      const actions = el('div', { style: 'display:flex;gap:12px;align-items:center' }, [
        step > 0 ? el('button', {
          style: 'height:54px;padding:0 22px;border-radius:14px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:15px;cursor:pointer;font-family:inherit',
          hov: 'background:var(--panel-3)',
          onclick: () => { step = Math.max(0, step - 1); render(); }
        }, ['Back']) : null,
        next
      ]);

      const panel = el('div', {
        style: 'width:100%;max-width:520px;margin:0 auto;padding:40px 32px;display:flex;flex-direction:column;align-items:center;text-align:center'
      }, [heroRing, wordmark, dots, content, actions]);

      host.appendChild(el('div', {
        'data-screen-label': 'Welcome',
        style: 'display:flex;justify-content:center;min-height:70vh'
      }, [panel]));
    }

    render();
  };
})();
