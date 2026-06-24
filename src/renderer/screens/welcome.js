'use strict';
/* Welcome / onboarding screen, Spaci v2. Faithful to
   design/spaci-v2-reference.html (the "WELCOME (full-screen, no sidebar)" block
   around line 771). The design is a multi-step, full-screen flow; here the host
   is the normal content area, so we render a single centered onboarding panel:
   the animated ring mark, the Spaci wordmark, a headline, the value props, and a
   primary "Get started" button. That button persists onboarding completion via
   window.api.setPrefs({ onboarded: true }), routes to the dashboard, and kicks
   off the first scan. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // The value props shown as the onboarding feature list (faithful to the
  // design's onbFeatures rows: icon + title + sub).
  const FEATURES = [
    {
      icon: 'scan',
      title: 'One Smart Scan finds it all',
      sub: 'Project build output, package caches and system junk, surfaced in seconds.'
    },
    {
      icon: 'shield',
      title: 'Safe by design',
      sub: 'Spaci only targets regenerable caches and build output, never your source.'
    },
    {
      icon: 'undo',
      title: 'Reversible cleanups',
      sub: 'Every action is logged in History, and most can be restored in one click.'
    }
  ];

  function featureRow(f) {
    return el('div', {
      style: 'display:flex;align-items:center;gap:14px;padding:16px 18px;background:var(--panel);border:1px solid var(--border);border-radius:14px;text-align:left'
    }, [
      ic(f.icon, 22, { color: 'var(--accent-fg)' }),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-size:14.5px;font-weight:600' }, [f.title]),
        el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:1px' }, [f.sub])
      ])
    ]);
  }

  // Persist onboarding completion, route to the dashboard, then start scanning.
  async function getStarted() {
    try { await api.setPrefs({ onboarded: true }); } catch (_) {}
    SP.go('dashboard');
    try { window.SP_doScan && window.SP_doScan(); } catch (_) {}
  }

  SP.screens.welcome = function (host) {
    // Hero ring mark (animated, accent-colored) per the design's logo.
    const heroRing = ring('assemble', 108, 'var(--accent-fg)');
    heroRing.setAttribute('style', 'width:108px;height:108px;display:block;margin:0 auto 22px;color:var(--accent-fg)');

    // Spaci wordmark with the accent dot.
    const wordmark = el('div', {
      style: 'font-size:17px;font-weight:700;letter-spacing:-.4px;margin-bottom:26px'
    }, [
      el('span', { text: 'Spaci' }),
      el('span', { style: 'color:var(--accent-fg)', text: '.' })
    ]);

    const title = el('div', {
      style: 'font-size:40px;font-weight:700;letter-spacing:-1.4px;line-height:1.08;margin-bottom:14px'
    }, ['Reclaim your disk, safely.']);

    const body = el('div', {
      style: 'font-size:16px;line-height:1.6;color:var(--text-2);margin-bottom:34px;max-width:430px'
    }, ['Spaci finds the gigabytes hiding in caches and build output, then clears them in one click, without ever touching your real work.']);

    const features = el('div', {
      class: 'sp-stagger',
      style: 'display:flex;flex-direction:column;gap:10px;margin-bottom:34px;width:100%'
    }, FEATURES.map(featureRow));

    const cta = el('button', {
      style: 'height:54px;padding:0 32px;border-radius:14px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:16px;display:inline-flex;align-items:center;gap:11px;cursor:pointer;font-family:inherit',
      hov: 'background:var(--accent-hover)',
      onclick: getStarted
    }, ['Start scanning', ic('arrow-right', 18)]);

    const actions = el('div', { style: 'display:flex;gap:12px;align-items:center' }, [cta]);

    // Centered onboarding panel within the host content area.
    const panel = el('div', {
      class: 'sp-fadeup',
      style: 'width:100%;max-width:520px;margin:0 auto;padding:40px 32px;display:flex;flex-direction:column;align-items:center;text-align:center'
    }, [
      heroRing,
      wordmark,
      title,
      body,
      features,
      actions
    ]);

    host.appendChild(el('div', {
      'data-screen-label': 'Welcome',
      style: 'display:flex;justify-content:center;min-height:70vh'
    }, [panel]));
  };
})();
