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
  // One shared category colour map when the shell provides it (SP.catColor),
  // else the local palette by position.
  function catColor(c, i) {
    const f = SP.catColor;
    let v = null;
    try { v = typeof f === 'function' ? f(c && c.key, i) : (f && c ? f[c.key] : null); } catch (_) { v = null; }
    return typeof v === 'string' && v ? v : COLORS[i % COLORS.length];
  }

  // Honest reclaim figures, shared by Dashboard, Recommendations and Storage.
  //   top         what the top recommendations reclaim (the one headline label)
  //   grand       every cleanable byte found: verified project artifacts, all
  //               System Cleaner targets, Docker images and build cache (never
  //               volumes or containers)
  //   unverified  project folders Spaci could not verify as build output; it
  //               never cleans them, so they are reported apart and not summed
  function itemsSplit(p) {
    const items = Array.isArray(p && p.items) ? p.items : null;
    if (!items) return { ok: Number(p && p.cleanableSize) || 0, unverified: Number(p && p.unverifiedSize) || 0 };
    let ok = 0; let unverified = 0;
    items.forEach((i) => { const b = Number(i && i.size) || 0; if (i && i.safe === true) ok += b; else unverified += b; });
    if (p && typeof p.unverifiedSize === 'number') unverified = p.unverifiedSize;
    return { ok, unverified };
  }
  function reclaimTotals() {
    const recs = (S.recs || []).filter((r) => !(r.action && r.action.type === 'none'));
    const top = recs.reduce((a, r) => a + recSize(r), 0);
    let projects = 0; let unverified = 0;
    (S.projects || []).forEach((p) => { const x = itemsSplit(p); projects += x.ok; unverified += x.unverified; });
    const system = (S.sysTargets || []).reduce((a, t) => a + (Number(t && t.size) || 0), 0);
    const d = S.docker;
    const dc = d && d.ok && d.categories ? d.categories : null;
    const docker = dc ? ['images', 'buildCache'].reduce((a, k) => a + (Number(dc[k] && dc[k].reclaimable) || 0), 0) : 0;
    // The grand total can never read lower than the headline it contains.
    const grand = Math.max(top, projects + system + docker);
    return { top, grand, unverified, count: recs.length, parts: { projects, system, docker } };
  }
  SP.reclaimTotals = reclaimTotals;

  // "Sep 30, 2026, 14:05": the date and minutes, no seconds.
  function scannedAt(ms) {
    try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return new Date(ms).toLocaleString(); }
  }

  // Brand logo for Docker, AI tools and browsers; tech mark for developer
  // caches and projects; the card's own glyph otherwise.
  function recMark(r, size) {
    const B = window.SpaciBrandIcon;
    const T = window.SpaciTechIcon;
    const targets = S.sysTargets || [];
    const brand = B && B.forRec ? B.forRec(r, targets) : null;
    if (brand && SP.bic) return SP.bic(brand, size, { label: brand, fallback: r.icon || 'broom-2' });
    const act = r.action || {};
    const t = act.type === 'select-system' ? targets.find((x) => x.id === act.id) : null;
    const tech = t && T && T.forTarget ? T.forTarget(t) : null;
    if (tech && SP.tic) return SP.tic(tech, size, { label: t.name || tech });
    const p = act.type === 'open-project' ? (S.projects || []).find((x) => x.path === act.path) : null;
    const en = p && S.enrich ? S.enrich[p.path] : null;
    const pr = (en && en.primary) || (p && p.primary) || null;
    const pid = pr && T ? T.cleanId(pr.id) : '';
    if (pid && SP.tic) return SP.tic(pid, size, { label: pr.name || pid });
    return ic(r.icon || 'broom-2', size);
  }

  // ---------- clean tiers (shared by every screen) ----------
  // Main classifies everything the screens show into A (Safe), B (Review) and
  // C (Permanent), trusting its own scan over the renderer's copy
  // (src/clean-tiers.js). The answer is cached per scan and fetched again when
  // the lists change. Until it arrives, the old flag-based guess is shown.
  const FALLBACK_BADGES = {
    A: { cls: 'sp-badge-safe', text: 'Safe' },
    B: { cls: 'sp-badge-caution', text: 'Review' },
    C: { cls: 'sp-badge-warn', text: 'Permanent' },
  };
  const TIER_SCREENS = new Set(['dashboard', 'projects', 'project', 'system', 'recommendations']);
  const tierState = { data: null, sig: '', loading: null };
  function tierSig() {
    const ps = S.projects || [];
    const ts = S.sysTargets || [];
    let items = 0;
    let bytes = 0;
    ps.forEach((p) => { (p.items || []).forEach((it) => { items++; bytes += Number(it.size) || 0; }); });
    ts.forEach((t) => { bytes += Number(t.size) || 0; });
    return [S.lastScan || 0, ps.length, ts.length, items, bytes].join('|');
  }
  function loadTiers(force) {
    if (!window.api || typeof window.api.cleanTiers !== 'function') return Promise.resolve(null);
    const sig = tierSig();
    if (!force && tierState.data && tierState.sig === sig) return Promise.resolve(tierState.data);
    if (tierState.loading && tierState.loadingSig === sig) return tierState.loading;
    tierState.loadingSig = sig;
    tierState.loading = window.api.cleanTiers({ projects: S.projects || [], sysTargets: S.sysTargets || [] })
      .then((d) => {
        const changed = !tierState.data || tierState.sig !== sig;
        tierState.data = d || null;
        tierState.sig = sig;
        tierState.loading = null;
        // Repaint the screen that asked, once, now that the real tiers are in.
        if (changed && TIER_SCREENS.has(S.route) && !S.cleaning && !S.confirmCfg) SP.go(S.route);
        return tierState.data;
      })
      .catch(() => { tierState.loading = null; return null; });
    return tierState.loading;
  }
  function fallbackTarget(t) {
    if (!t) return 'B';
    if (t.reversible === false || (t.storyCategory === 'aitools' && !t.safe)) return 'C';
    return t.safe ? 'A' : 'B';
  }
  function fallbackItem(it) {
    if (!it) return 'B';
    if (it.reversible === false) return 'C';
    return it.safe === true ? 'A' : 'B';
  }
  SP.tiers = {
    ensure: () => { loadTiers(false); },
    // True once main's answer for the current lists is in. Until then the
    // badges show a guess; anything that selects or cleans awaits load().
    ready: () => !!(tierState.data && tierState.sig === tierSig()),
    load: loadTiers,
    invalidate: () => { tierState.sig = ''; },
    plan: () => (tierState.data && tierState.sig === tierSig() ? tierState.data.planA : null),
    target: (t) => {
      const d = tierState.data && tierState.data.tiers && tierState.data.tiers.system[t && t.id];
      return d ? d.tier : fallbackTarget(t);
    },
    targetReason: (t) => {
      const d = tierState.data && tierState.data.tiers && tierState.data.tiers.system[t && t.id];
      return d ? d.reason : '';
    },
    item: (it) => {
      const d = tierState.data && tierState.data.tiers && tierState.data.tiers.items[it && it.path];
      return d ? d.tier : fallbackItem(it);
    },
    docker: (kind) => {
      const d = tierState.data && tierState.data.tiers && tierState.data.tiers.docker[kind];
      return d ? d.tier : (kind === 'stopped-containers' || kind === 'volume' ? 'C' : 'B');
    },
    badge: (tier) => ((tierState.data && tierState.data.badges && tierState.data.badges[tier]) || FALLBACK_BADGES[tier] || FALLBACK_BADGES.B),
    // A small pill for a tier, the same shape everywhere.
    pill: (tier, extraStyle) => {
      const b = SP.tiers.badge(tier);
      return el('span', { class: b.cls, style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none' + (extraStyle ? ';' + extraStyle : ''), text: b.text });
    },
  };

  // ---------- Clean all developer files (tier A, one confirm) ----------
  // Every tier A thing across all projects and developer caches, confirmed once
  // with a summary, then cleaned through api.clean like any other clean: main's
  // guard, its revalidation of project folders and its confirmation gate decide
  // what really goes.
  let cleanAllBusy = false;
  function planBody(plan) {
    const lines = [];
    lines.push('Build output and package caches: ' + plan.count + (plan.count === 1 ? ' item' : ' items')
      + (plan.projects ? ' across ' + plan.projects + (plan.projects === 1 ? ' project' : ' projects') : '') + '.');
    lines.push('');
    plan.groups.slice(0, 6).forEach((g) => {
      lines.push(g.label + ', ' + g.count + ' (' + fmt(g.bytes) + '). Back with: ' + g.hint + '.');
    });
    if (plan.groups.length > 6) lines.push('and ' + (plan.groups.length - 6) + ' more kinds, ' + fmt(plan.groups.slice(6).reduce((a, g) => a + g.bytes, 0)) + '.');
    lines.push('');
    lines.push('Everything rebuilds on the next install or build. App caches, AI tool history, the Trash and anything unverified are not included.');
    return lines.join('\n');
  }
  SP.cleanAllDev = async function cleanAllDev() {
    if (cleanAllBusy || S.cleaning) return;
    cleanAllBusy = true;
    try {
      const data = await loadTiers(true);
      const plan = data && data.planA;
      if (!plan || !plan.count || !plan.jobs.length) {
        SP.toast('Nothing to clean', 'No developer build output or package caches were found. Scan to look again.');
        return;
      }
      const ok = await SP.confirm({
        title: 'Clean all developer files (' + fmt(plan.bytes) + ')?',
        body: planBody(plan),
        confirmLabel: 'Clean ' + fmt(plan.bytes),
        icon: 'broom',
      });
      if (!ok) return;
      S.cleaning = true;
      S.cleanAllRunning = true;
      if (TIER_SCREENS.has(S.route)) SP.go(S.route);
      const jobs = plan.jobs.map((j) => (j.mode ? { path: j.path, mode: j.mode } : { path: j.path, isDir: j.isDir, size: j.size }));
      const nameOf = (id) => { const t = (S.sysTargets || []).find((x) => x.id === id); return t ? t.name : ''; };
      let res;
      try {
        res = await window.api.clean(jobs, { scope: 'developer', label: 'All developer files', confirmed: true });
      } catch (err) {
        res = { ok: false, error: (err && err.message) || 'Clean failed' };
      }
      S.cleaning = false;
      S.cleanAllRunning = false;
      const sum = SP.reportClean(res, { fallbackFreed: plan.bytes, names: nameOf, burstLabel: 'across ' + plan.count + (plan.count === 1 ? ' item' : ' items') });
      if (sum.ok) {
        // Drop what went; anything refused or failed stays listed.
        const gone = new Set(plan.jobs.filter((j) => !sum.blocked(j.path)).map((j) => j.path));
        (S.projects || []).forEach((p) => {
          const before = (p.items || []).length;
          p.items = (p.items || []).filter((it) => !gone.has(it.path));
          if (p.items.length !== before) p.cleanableSize = p.items.filter((i) => i.safe === true).reduce((s, i) => s + (i.size || 0), 0);
        });
        const doneTargets = new Set(plan.jobs.filter((j) => j.target).filter((j) => gone.has(j.path)).map((j) => j.target));
        const blockedTargets = new Set(plan.jobs.filter((j) => j.target && !gone.has(j.path)).map((j) => j.target));
        S.sysTargets = (S.sysTargets || []).filter((t) => !(doneTargets.has(t.id) && !blockedTargets.has(t.id) && !sum.refusedTargets.has(t.id)));
        SP.tiers.invalidate();
      }
      if (TIER_SCREENS.has(S.route)) SP.go(S.route);
    } finally {
      cleanAllBusy = false;
      S.cleaning = false;
      S.cleanAllRunning = false;
    }
  };

  // The button, the same on Dashboard and Projects. Shows the tier A total once known.
  SP.cleanAllButton = function cleanAllButton(opts) {
    opts = opts || {};
    SP.tiers.ensure();
    const plan = SP.tiers.plan();
    const busy = !!S.cleanAllRunning;
    const none = plan && !plan.count;
    const label = busy ? 'Cleaning…' : 'Clean all developer files' + (plan && plan.count ? ' (' + fmt(plan.bytes) + ')' : '');
    return el('button', {
      'data-clean-all': '',
      title: none ? 'Nothing to clean right now' : 'Every Safe item: build output and package caches. You confirm once.',
      style: 'height:' + (opts.height || 44) + 'px;padding:0 18px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;flex:none'
        + (busy || none ? ';opacity:.55;pointer-events:none' : ''),
      hov: 'border-color:var(--accent);color:var(--accent-fg)',
      onclick: () => SP.cleanAllDev(),
    }, [busy ? ring('elastic', 16) : ic('broom', 16), label]);
  };

  SP.screens.dashboard = function (host) {
    SP.tiers.ensure();
    const d = S.disk || { total: 0, used: 0, free: 0 };
    const cats = (S.breakdown && S.breakdown.categories) || [];
    // Informational recommendations (action 'none') are not something to clean.
    const recs = (S.recs || []).filter((r) => !(r.action && r.action.type === 'none'));
    const tot = reclaimTotals();
    const totalReclaim = tot.top;

    // header
    host.appendChild(
      el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:26px' }, [
        el('div', {}, [
          el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px;line-height:1.05', text: 'Smart Scan' }),
          el('div', { style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:520px', text: 'One scan across your projects and system caches. Review, then reclaim, safely.' })
        ]),
        el('div', { style: 'text-align:right;flex:none' }, [
          el('div', { style: 'color:var(--text-3);font-size:12px;display:flex;align-items:center;gap:6px;justify-content:flex-end' }, [ic('clock', 14), 'Last scanned']),
          el('div', { style: 'font-weight:600;font-size:13px;margin-top:3px', text: S.lastScan ? scannedAt(S.lastScan) : 'Never' })
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
    const defaultSub = totalReclaim ? 'top recommendations' : "you're all clear";

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
      const path = svgEl('path', { d: arc(114, 114, 103, angle + gap / 2, angle + span - gap / 2), stroke: catColor(c, i), 'stroke-width': 16, 'stroke-linecap': 'round', fill: 'none', style: 'cursor:pointer;transition:stroke-width .15s' });
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
    }, [S.scanning ? ic('spaci-ring', 19, { anim: 'elastic' }) : ic('scanner', 19), S.scanning ? 'Scanning…' : 'Scan']);
    scanBtn.addEventListener('mousedown', () => { scanBtn.style.transform = 'scale(.97)'; });
    scanBtn.addEventListener('mouseup', () => { scanBtn.style.transform = ''; });
    scanBtn.addEventListener('mouseleave', () => { scanBtn.style.transform = ''; });

    const reviewBtn = el('button', {
      style: 'height:54px;padding:0 26px;border-radius:14px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:15px;display:flex;align-items:center;gap:9px;cursor:pointer',
      hov: 'background:var(--panel-3)',
      onclick: () => SP.go('recommendations')
    }, ['Review', ic('chevron-right', 16)]);

    host.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:46px;padding:38px 44px;background:var(--panel);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow-md);position:relative;overflow:hidden' }, [
        glowBig,
        donutWrap,
        el('div', { style: 'flex:1;position:relative;z-index:1' }, [
          el('div', { style: 'font-size:27px;font-weight:700;letter-spacing:-.9px;margin-bottom:9px' }, totalReclaim
            ? [el('span', { text: 'Top recommendations: ' }), el('span', { style: 'color:var(--accent-fg)', text: fmt(totalReclaim) })]
            : [el('span', { text: 'Scan to find space' })]),
          totalReclaim ? el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 18px;color:var(--text-2);font-size:14px;line-height:1.6;margin-bottom:6px' }, [
            el('span', {}, [el('span', { text: 'All cleanable found: ' }), el('b', { style: 'color:var(--text);font-weight:700', text: fmt(tot.grand) })]),
            tot.unverified > 0 ? el('span', { style: 'color:var(--text-3)', text: fmt(tot.unverified) + ' unverified, not counted' }) : null,
          ]) : null,
          el('div', { style: 'color:var(--text-3);font-size:13.5px;line-height:1.6;margin-bottom:22px;max-width:460px', text: 'Across your projects, system caches and Docker. Nothing is removed until you review it.' }),
          el('div', { style: 'display:flex;gap:13px' }, [scanBtn, reviewBtn])
        ])
      ])
    );

    // Developer files: every tier A item, cleaned in one go.
    const planA = SP.tiers.plan();
    if (planA && planA.count > 0) {
      const top = planA.groups.slice(0, 3).map((g) => g.label).join(', ');
      host.appendChild(
        el('div', { style: 'margin-top:16px;display:flex;align-items:center;gap:18px;padding:20px 22px;background:var(--panel);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow-sm)' }, [
          el('div', { style: 'width:44px;height:44px;border-radius:12px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--accent-fg)' }, [ic('code', 22)]),
          el('div', { style: 'flex:1;min-width:0' }, [
            el('div', { style: 'font-size:15px;font-weight:700;display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
              el('span', { text: 'Developer files' }),
              SP.tiers.pill('A'),
              el('span', { style: 'color:var(--accent-fg)', text: fmt(planA.bytes) }),
            ]),
            el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:3px;line-height:1.5', text: planA.count + (planA.count === 1 ? ' item' : ' items') + ' of build output and package caches (' + top + '). Everything rebuilds on the next install or build.' }),
          ]),
          SP.cleanAllButton({ height: 42 }),
        ])
      );
    }

    // storage breakdown card
    const bar = el('div', { style: 'height:16px;border-radius:6px;overflow:hidden;display:flex;gap:3px;background:var(--track)' },
      cats.map((c, i) => el('span', { style: `height:100%;border-radius:3px;background:${catColor(c, i)};flex-basis:${(Number(c.bytes) || 0) / sumCats * (usedAngle / 3.6)}%;flex-grow:0;flex-shrink:0;transform-origin:left;animation:sp-segment .6s cubic-bezier(.22,.61,.36,1) backwards`, title: c.label })));
    const legend = el('div', { style: 'display:flex;flex-wrap:wrap;gap:14px 22px;margin-top:18px' },
      cats.map((c, i) => el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        el('span', { style: `width:9px;height:9px;border-radius:3px;background:${catColor(c, i)};flex:none` }),
        el('span', { style: 'font-size:12.5px;color:var(--text-2);font-weight:600', text: c.label }),
        el('span', { style: 'font-size:12.5px;color:var(--text-3)', text: fmt(c.bytes) })
      ])));
    host.appendChild(
      el('div', { style: 'margin-top:16px' }, [
        el('div', { class: 'sp-hov', style: 'background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:22px;box-shadow:var(--shadow-sm);cursor:pointer', hov: 'border-color:var(--border-2)', onclick: () => SP.go('storage') }, [
          el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px' }, [
            el('div', { style: 'font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px' }, ['Storage breakdown', ic('chevron-right', 15, { color: 'var(--text-4)' })]),
            el('div', { style: 'font-size:13px;color:var(--text-3)', text: fmt(d.used) + ' of ' + fmt(d.total) })
          ]),
          bar,
          legend
        ])
      ])
    );

    // top recommendations
    if (recs.length) {
      host.appendChild(el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin:30px 0 14px' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600', text: 'Top recommendations' }),
        recs.length > 3 ? el('button', { style: 'border:none;background:transparent;color:var(--accent-fg);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px', onclick: () => SP.go('recommendations') }, ['See all ' + recs.length, ic('chevron-right', 13)]) : null,
      ]));
      host.appendChild(
        el('div', { style: 'display:flex;flex-direction:column;gap:9px' },
          recs.slice(0, 3).map((r) => el('div', {
            class: 'sp-hov',
            style: 'display:flex;align-items:center;gap:14px;padding:15px 17px;border-radius:15px;background:var(--panel);border:1px solid var(--border);cursor:pointer',
            hov: 'border-color:var(--border-2);transform:translateX(2px)',
            onclick: () => SP.go('recommendations')
          }, [
            el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [recMark(r, 23)]),
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
