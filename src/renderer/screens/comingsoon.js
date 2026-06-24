'use strict';
/* Coming Soon screen, Spaci v2. Faithful to design/spaci-v2-reference.html
   (data-screen-label="Coming Soon", around line 666). A centered roadmap state
   that previews features still in the works (Duplicate Finder, App Uninstaller,
   and more), each with a "Notify me" affordance, plus a back-to-dashboard
   button. No backend data: this is a static teaser. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;

  // The features on the roadmap. Icons resolve against the spaci-icon registry.
  const SOON_CARDS = [
    {
      icon: 'copy',
      title: 'Duplicate Finder',
      body: 'Hunt down byte-for-byte duplicate files across your disk and reclaim the space they quietly waste, with a safe preview before anything is removed.'
    },
    {
      icon: 'trash',
      title: 'App Uninstaller',
      body: 'Remove apps completely, including the caches, preferences and support files they leave scattered behind long after you drag them to the Trash.'
    },
    {
      icon: 'shield',
      title: 'Privacy Sweep',
      body: 'Clear browser histories, cookies and other traces in one pass, so a quick cleanup also tidies up what you leave behind online.'
    },
    {
      icon: 'database',
      title: 'Scheduled Cleanups',
      body: 'Let Spaci keep things tidy on its own. Pick a cadence and it will quietly reclaim regenerable space in the background, on your terms.'
    }
  ];

  function notifyButton(label) {
    const base = 'height:40px;padding:0 16px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit';
    return el('button', {
      style: base,
      hov: 'background:var(--panel-3)',
      onclick: () => { try { SP.toast && SP.toast('We will let you know when ' + label + ' lands.'); } catch (_) {} }
    }, [ic('bell', 15), 'Notify me']);
  }

  function soonCard(s) {
    return el('div', {
      style: 'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:24px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden'
    }, [
      // soft corner glow, matching the design's decorative blob
      el('div', { style: 'position:absolute;top:-30%;right:-10%;width:200px;height:200px;background:var(--glow);pointer-events:none' }),
      el('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:14px' }, [
        el('div', { style: 'width:48px;height:48px;border-radius:13px;background:var(--accent-soft);display:grid;place-items:center;color:var(--accent-fg);flex:none' }, [ic(s.icon, 26)]),
        el('div', { style: 'font-size:17px;font-weight:700;letter-spacing:-.3px' }, [s.title])
      ]),
      el('div', { style: 'color:var(--text-2);font-size:13.5px;line-height:1.6;margin-bottom:18px' }, [s.body]),
      notifyButton(s.title)
    ]);
  }

  SP.screens.comingsoon = function (host) {
    // Back to dashboard, matching the back-button pattern used elsewhere.
    const back = el('button', {
      style: 'height:36px;padding:0 13px;border-radius:9px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;margin-bottom:18px',
      hov: 'background:var(--panel);color:var(--text)',
      onclick: () => SP.go('dashboard')
    }, [ic('arrow-left', 16), 'Dashboard']);

    // "On the roadmap" badge.
    const badge = el('div', {
      style: 'display:inline-flex;align-items:center;gap:7px;padding:5px 12px;border-radius:99px;background:var(--accent-soft-2);color:var(--accent-fg);font-size:12px;font-weight:700;margin-bottom:16px'
    }, [ic('sparkles', 14), 'On the roadmap']);

    const heading = el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px' }, ['Coming soon to Spaci']);
    const sub = el('div', {
      style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px;margin-bottom:28px'
    }, ["A preview of what we're building next. Turn on notifications and we'll let you know the moment each one lands."]);

    const grid = el('div', {
      style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:16px'
    }, SOON_CARDS.map(soonCard));

    host.appendChild(el('div', { class: 'sp-fadeup', 'data-screen-label': 'Coming Soon' }, [
      back,
      badge,
      heading,
      sub,
      grid
    ]));
  };
})();
