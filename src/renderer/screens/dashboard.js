'use strict';
/* Smart Scan dashboard, Spaci v2. Faithful to design/spaci-v2-reference.html,
   wired to real disk usage, storage breakdown and recommendations. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const COLORS = ['#5e93dd', '#4fcb93', '#e8a14f', '#c77dff', '#e8836f', '#7fb5c9', '#8b867f'];

  function polar(cx, cy, r, a) {
    const rad = ((a - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  function arc(cx, cy, r, a0, a1) {
    const s = polar(cx, cy, r, a0);
    const e = polar(cx, cy, r, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }
  function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function recSize(r) {
    return Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0;
  }

  SP.screens.dashboard = function (host) {
    const d = S.disk || { total: 0, used: 0, free: 0 };
    const cats = (S.breakdown && S.breakdown.categories) || [];
    const recs = S.recs || [];
    const totalReclaim = recs.reduce((a, r) => a + recSize(r), 0);

    // header
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:26px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px;line-height:1.05', text: 'Smart Scan' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:520px', text: 'One scan across your projects and system caches. Review, then reclaim, safely.' })
        ]),
        el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'color:var(--text-3);font-size:12px;display:flex;align-items:center;gap:6px;justify-content:flex-end' }, [ic('clock', 14), 'Last scanned']),
          el('div', { style: 'font-weight:600;font-size:13px;margin-top:3px', text: S.lastScan ? new Date(S.lastScan).toLocaleString() : 'Never' })
        ])
      ])
    );

    // donut, restored to the design's 228x228 size
    const svg = svgEl('svg', { viewBox: '0 0 228 228', style: 'position:absolute;inset:0;width:228px;height:228px;overflow:visible;transform-origin:center;animation:sp-donutin .75s cubic-bezier(.22,.61,.36,1)' });
    svg.appendChild(svgEl('circle', { cx: 114, cy: 114, r: 103, fill: 'none', stroke: 'var(--track)', 'stroke-width': 16 }));
    // Normalise: arcs fill only the used fraction of the ring, split by each
    // category's share of the breakdown (so they can never exceed 360 degrees).
    const sumCats = cats.reduce((a, c) => a + (Number(c.bytes) || 0), 0) || 1;
    const usedAngle = Math.min(1, d.total ? d.used / d.total : 0) * 360;

    // Center metric: reclaimable total split into a big number + colored unit.
    const reclaimStr = fmt(totalReclaim);
    const reclaimSpace = reclaimStr.lastIndexOf(' ');
    const defaultNum = totalReclaim ? reclaimStr.slice(0, reclaimSpace) : '0';
    const defaultUnit = totalReclaim ? reclaimStr.slice(reclaimSpace + 1) : 'B';
    const defaultSub = totalReclaim
      ? (recs.length ? 'across ' + recs.length + ' rec' + (recs.length === 1 ? '' : 's') : 'reclaimable')
      : "you're all clear";

    const centerNum = el('span', { text: defaultNum });
    const centerUnit = el('span', { style: 'font-size:17px;font-weight:600;letter-spacing:-.3px;color:var(--accent-fg);margin-left:3px', text: defaultUnit });
    const centerSub = el('div', { style: 'font-size:12px;color:var(--text-3);font-weight:600;letter-spacing:.3px;margin-top:2px', text: defaultSub });
    const center = el('div', { style: 'position:relative;text-align:center;z-index:1;pointer-events:none' }, [
      el('div', { style: 'font-size:46px;font-weight:700;letter-spacing:-2.2px;line-height:1' }, [centerNum, centerUnit]),
      centerSub
    ]);

    function setCenter(num, unit, sub) {
      centerNum.textContent = num;
      centerUnit.textContent = unit;
      centerSub.textContent = sub;
    }
    function resetCenter() { setCenter(defaultNum, defaultUnit, defaultSub); }

    // Interactive category arcs: hover grows the stroke and shows that category
    // in the center; leaving restores the default reclaimable figure.
    let angle = 0;
    cats.forEach((c, i) => {
      const span = ((Number(c.bytes) || 0) / sumCats) * usedAngle;
      if (span < 0.6) { angle += span; return; }
      const gap = Math.min(2, span / 3);
      const path = svgEl('path', { d: arc(114, 114, 103, angle + gap / 2, angle + span - gap / 2), stroke: COLORS[i % COLORS.length], 'stroke-width': 16, 'stroke-linecap': 'round', fill: 'none', style: 'cursor:pointer;transition:stroke-width .15s' });
      const catStr = fmt(c.bytes);
      const sp = catStr.lastIndexOf(' ');
      path.addEventListener('mouseenter', () => {
        path.setAttribute('stroke-width', 19);
        setCenter(catStr.slice(0, sp), catStr.slice(sp + 1), c.label || 'category');
      });
      path.addEventListener('mouseleave', () => {
        path.setAttribute('stroke-width', 16);
        resetCenter();
      });
      svg.appendChild(path);
      angle += span;
    });

    // Two soft glow elements behind the donut so the hero reads luminous.
    const glowBig = el('div', { style: 'position:absolute;top:-40%;right:-6%;width:420px;height:420px;background:radial-gradient(circle,var(--accent-soft) 0%,transparent 70%);opacity:.7;pointer-events:none;z-index:0' });
    const glowDonut = el('div', { style: 'position:absolute;width:250px;height:250px;border-radius:50%;background:radial-gradient(circle,var(--accent-soft) 0%,transparent 70%);opacity:.6;pointer-events:none;z-index:0' });

    const donutWrap = el('div', { style: 'position:relative;width:228px;height:228px;flex:none;display:grid;place-items:center' }, [glowDonut, center]);
    donutWrap.insertBefore(svg, center);
    if (S.scanning) {
      donutWrap.appendChild(el('div', { style: 'position:absolute;inset:6px;border-radius:50%;border:2px solid var(--accent-fg);animation:sp-pulsering 2.4s cubic-bezier(.22,.61,.36,1) infinite' }));
      donutWrap.appendChild(el('div', { style: 'position:absolute;inset:6px;border-radius:50%;border:2px solid var(--accent-fg);animation:sp-pulsering 2.4s cubic-bezier(.22,.61,.36,1) infinite 1.2s' }));
    }

    const scanBtn = el('button', {
      style: 'height:54px;padding:0 30px;border-radius:14px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:16px;display:flex;align-items:center;gap:11px;cursor:pointer;box-shadow:var(--shadow-md);transition:transform .12s',
      hov: 'background:var(--accent-hover)',
      onclick: () => window.SP_doScan && window.SP_doScan()
    }, [S.scanning ? ic('spaci-ring', 19, { anim: 'elastic' }) : ic('scanner', 19), S.scanning ? 'Scanning…' : 'Smart Scan']);
    scanBtn.addEventListener('mousedown', () => { scanBtn.style.transform = 'scale(.97)'; });
    scanBtn.addEventListener('mouseup', () => { scanBtn.style.transform = ''; });
    scanBtn.addEventListener('mouseleave', () => { scanBtn.style.transform = ''; });

    const reviewBtn = el('button', {
      style: 'height:54px;padding:0 26px;border-radius:14px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:15px;display:flex;align-items:center;gap:9px;cursor:pointer',
      hov: 'background:var(--panel-3)',
      onclick: () => SP.go('recommendations')
    }, ['Review', ic('arrow-right', 16)]);

    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:46px;padding:38px 44px;background:var(--panel);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow-md);position:relative;overflow:hidden' }, [
        glowBig,
        donutWrap,
        el('div', { style: 'flex:1;position:relative;z-index:1' }, [
          el('div', { style: 'font-size:27px;font-weight:700;letter-spacing:-.9px;margin-bottom:9px', text: totalReclaim ? 'Reclaim ' + fmt(totalReclaim) + ' of space' : 'Run a scan to find space' }),
          el('div', { style: 'color:var(--text-2);font-size:15px;line-height:1.6;margin-bottom:24px;max-width:460px', text: 'Spaci looks across your projects and system caches for regenerable files you can safely clear.' }),
          el('div', { style: 'display:flex;gap:13px' }, [scanBtn, reviewBtn])
        ])
      ])
    );

    // reclaim banner, always shown (at-rest variant when nothing reclaimable yet)
    const bannerHead = totalReclaim
      ? el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.5px' }, [el('span', { text: 'Up to ' }), el('span', { style: 'color:var(--accent-fg)', text: fmt(totalReclaim) }), el('span', { text: ' can be reclaimed' })])
      : el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.5px', text: 'No reclaimable space found yet' });
    const bannerSub = totalReclaim
      ? 'Across ' + recs.length + ' recommendation' + (recs.length === 1 ? '' : 's') + ' from your projects and system.'
      : 'Run a scan to find regenerable files you can safely clear.';
    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:18px;padding:20px 24px;border-radius:18px;background:var(--accent-soft);border:1px solid var(--border);margin-top:16px' }, [
        el('div', { style: 'width:50px;height:50px;border-radius:14px;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;flex:none;box-shadow:var(--shadow-sm)' }, [ic('sparkles', 25)]),
        el('div', { style: 'flex:1' }, [
          bannerHead,
          el('div', { style: 'color:var(--text-2);font-size:13.5px;margin-top:2px', text: bannerSub })
        ]),
        el('button', { style: 'height:46px;padding:0 22px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer', hov: 'background:var(--accent-hover)', onclick: () => (totalReclaim ? SP.go('recommendations') : window.SP_doScan && window.SP_doScan()) }, [totalReclaim ? 'See how' : 'Scan now', ic('arrow-right', 15)])
      ])
    );

    // storage breakdown card
    const bar = el('div', { style: 'height:16px;border-radius:6px;overflow:hidden;display:flex;gap:3px;background:var(--track)' },
      cats.map((c, i) => el('span', { style: `height:100%;border-radius:3px;background:${COLORS[i % COLORS.length]};flex-basis:${(Number(c.bytes) || 0) / sumCats * (usedAngle / 3.6)}%;flex-grow:0;flex-shrink:0;transform-origin:left;animation:sp-segment .6s cubic-bezier(.22,.61,.36,1) backwards`, title: c.label })));
    const legend = el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px 22px;margin-top:18px' },
      cats.map((c, i) => el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        el('span', { style: `width:9px;height:9px;border-radius:3px;background:${COLORS[i % COLORS.length]};flex:none` }),
        el('span', { style: 'font-size:12.5px;color:var(--text-2);font-weight:600', text: c.label }),
        el('span', { style: 'font-size:12.5px;color:var(--text-3)', text: fmt(c.bytes) })
      ])));
    host.appendChild(
      el('div', { style: 'margin-top:16px' }, [
        el('div', { class: 'sp-hov', style: 'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:22px;box-shadow:var(--shadow-sm);cursor:pointer', hov: 'border-color:var(--border-2)', onclick: () => SP.go('storage') }, [
          el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px' }, [
            el('div', { style: 'font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px' }, ['Storage breakdown', ic('arrow-right', 15, { color: 'var(--text-4)' })]),
            el('div', { style: 'font-size:13px;color:var(--text-3)', text: fmt(d.used) + ' of ' + fmt(d.total) })
          ]),
          bar,
          legend
        ])
      ])
    );

    // top recommendations
    if (recs.length) {
      host.appendChild(el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600;margin:30px 0 14px', text: 'Top recommendations' }));
      host.appendChild(
        el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
          recs.slice(0, 3).map((r) => el('div', {
            class: 'sp-hov',
            style: 'display:flex;align-items:center;gap:14px;padding:15px 17px;border-radius:15px;background:var(--panel);border:1px solid var(--border);cursor:pointer',
            hov: 'border-color:var(--border-2);transform:translateX(2px)',
            onclick: () => SP.go('recommendations')
          }, [
            el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--accent-soft);display:grid;place-items:center;flex:none;color:var(--accent-fg)' }, [ic(r.icon || 'broom-2', 23)]),
            el('div', { style: 'flex:1;min-width:0' }, [
              el('div', { style: 'font-weight:600;font-size:14.5px', text: r.title || r.label || 'Cleanable' }),
              el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:2px', text: r.body || r.note || r.path || '' })
            ]),
            el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(recSize(r)) }),
            ic('chevron-right', 18, { color: 'var(--text-4)' })
          ]))
        )
      );
    }
  };
})();
