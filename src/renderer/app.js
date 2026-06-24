'use strict';
window.addEventListener('error', (e) => console.error('[err]', e.message, (e.filename || '') + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[reject]', e.reason && e.reason.message));
/* Spaci v2 renderer.
   Shell (titlebar + sidebar + content) and the Smart Scan dashboard, wired to
   the existing IPC backend (window.api). Screens register on SP.screens; the
   other screens are placeholders until rebuilt. The design lives in
   design/spaci-v2-reference.html. */

// `api` is the global exposed by preload (contextBridge). Do not redeclare it.

// ---------- tiny DOM helper (supports inline style strings + hover) ----------
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    if (k === 'style') n.setAttribute('style', v);
    else if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'oninput') n.addEventListener('input', v);
    else if (k === 'hov') {
      const base = attrs.style || '';
      n.addEventListener('mouseenter', () => n.setAttribute('style', base + ';' + v));
      n.addEventListener('mouseleave', () => n.setAttribute('style', base));
    } else n.setAttribute(k, v);
  }
  (children || []).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
}
const frag = (kids) => { const f = document.createDocumentFragment(); (kids || []).forEach((k) => k && f.appendChild(k)); return f; };

// <spaci-icon> builders
function ic(name, size, opt) {
  opt = opt || {};
  let s = `width:${size}px;height:${size}px`;
  if (opt.color) s += `;color:${opt.color}`;
  const a = { name, style: s };
  if (opt.kind) a.kind = opt.kind;
  if (opt.anim) a.anim = opt.anim;
  return el('spaci-icon', a);
}
const ring = (anim, size, color) => ic('spaci-ring', size, { anim, color });

// ---------- formatting ----------
function fmt(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

const CAT_COLORS = ['#5e93dd', '#4fcb93', '#e8a14f', '#c77dff', '#e8836f', '#7fb5c9', '#8b867f'];

// Toast notifications (design style: ring + title + sub). toast('Title','sub')
// or toast({ title, sub }).
function toast(a, sub) {
  const title = typeof a === 'string' ? a : (a && a.title) || '';
  const subt = typeof a === 'string' ? sub : (a && a.sub) || '';
  const host = document.getElementById('app');
  if (!host) return;
  let stack = document.getElementById('sp-toasts');
  if (!stack) {
    stack = el('div', { id: 'sp-toasts', style: 'position:absolute;bottom:40px;right:40px;display:flex;flex-direction:column;gap:10px;z-index:90' });
    host.appendChild(stack);
  }
  const t = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:14px;background:var(--panel-2);border:1px solid var(--border-2);min-width:280px;animation:sp-toast .3s cubic-bezier(.22,.61,.36,1)' }, [
    el('spaci-icon', { name: 'spaci-ring', anim: 'assemble', style: 'width:30px;height:30px;color:var(--success-fg);flex:none' }),
    el('div', {}, [el('div', { style: 'font-size:14px;font-weight:600', text: title }), subt ? el('div', { style: 'color:var(--text-3);font-size:12.5px;margin-top:1px', text: subt }) : null])
  ]);
  stack.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 2800);
}

// ---------- overlays: floating action bar, confirm modal, success burst ----------
function overlayHost() {
  let h = document.getElementById('sp-overlays');
  if (!h) { h = el('div', { id: 'sp-overlays' }); (document.getElementById('app') || document.body).appendChild(h); }
  return h;
}
function renderOverlays() {
  const h = overlayHost();
  h.innerHTML = '';
  const ab = S.actionBar;
  if (ab) {
    h.appendChild(el('div', { style: 'position:absolute;left:248px;right:0;bottom:24px;display:flex;justify-content:center;pointer-events:none;z-index:40' }, [
      el('div', { style: 'display:flex;align-items:center;gap:16px;padding:14px 18px;border-radius:16px;background:var(--panel-2);border:1px solid var(--border-2);min-width:440px;pointer-events:auto;animation:sp-rise .3s cubic-bezier(.22,.61,.36,1)' }, [
        el('div', { style: 'font-weight:700;font-size:14.5px' }, [el('span', { text: ab.count + ' · ' }), el('span', { style: 'color:var(--accent-fg)', text: ab.size })]),
        el('div', { style: 'flex:1' }),
        el('button', { style: 'height:40px;padding:0 16px;border-radius:11px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13.5px;cursor:pointer', hov: 'background:var(--panel-3);color:var(--text)', onclick: () => ab.onClear && ab.onClear() }, ['Clear']),
        el('button', { class: ab.danger ? 'sp-ab-danger' : 'sp-ab-accent', style: 'height:40px;padding:0 18px;border-radius:11px;border:none;color:#fff;font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:pointer', onclick: () => ab.onClean && ab.onClean() }, [ic('trash', 15), ab.action])
      ])
    ]));
  }
  const cm = S.confirmCfg;
  if (cm) {
    const close = (val) => { S.confirmCfg = null; renderOverlays(); if (cm.resolve) cm.resolve(val); };
    h.appendChild(el('div', { style: 'position:absolute;inset:0;z-index:80;background:rgba(0,0,0,.5);display:grid;place-items:center;animation:sp-fadein .2s', onclick: () => close(false) }, [
      el('div', { style: 'width:440px;max-width:90%;background:var(--panel);border:1px solid var(--border-2);border-radius:18px;padding:26px;animation:sp-pop .26s cubic-bezier(.22,.61,.36,1)', onclick: (e) => e.stopPropagation() }, [
        el('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:14px' }, [
          el('div', { class: cm.danger ? 'sp-cm-danger' : 'sp-cm-accent', style: 'width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:none' }, [ic(cm.icon || (cm.danger ? 'trash' : 'broom'), 23)]),
          el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.3px', text: cm.title })
        ]),
        el('div', { style: 'color:var(--text-2);font-size:13.5px;line-height:1.6;margin-bottom:22px', text: cm.body }),
        el('div', { style: 'display:flex;gap:10px;justify-content:flex-end' }, [
          el('button', { style: 'height:42px;padding:0 18px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:14px;cursor:pointer', hov: 'background:var(--panel-3)', onclick: () => close(false) }, ['Cancel']),
          el('button', { class: cm.danger ? 'sp-ab-danger' : 'sp-ab-accent', style: 'height:42px;padding:0 20px;border-radius:11px;border:none;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer', onclick: () => close(true) }, [ic(cm.icon || (cm.danger ? 'trash' : 'broom'), 15), cm.confirmLabel || 'Confirm'])
        ])
      ])
    ]));
  }
  const bu = S.burstCfg;
  if (bu) {
    h.appendChild(el('div', { style: 'position:absolute;inset:0;z-index:85;display:grid;place-items:center;background:rgba(10,12,10,.42);backdrop-filter:blur(3px);animation:sp-fadein .2s;pointer-events:none' }, [
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;text-align:center;gap:20px;animation:sp-pop .34s cubic-bezier(.22,.61,.36,1)' }, [
        el('div', { style: 'position:relative;width:128px;height:128px;display:grid;place-items:center;color:var(--success-fg)' }, [
          el('div', { style: 'position:absolute;inset:14px;border-radius:50%;border:2px solid var(--success-fg);animation:sp-ping 1.5s ease-out infinite' }),
          el('spaci-icon', { name: 'spaci-ring', anim: 'elastic', style: 'width:104px;height:104px' })
        ]),
        el('div', {}, [
          el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--success-fg)', text: 'Reclaimed' }),
          el('div', { style: 'font-size:48px;font-weight:700;letter-spacing:-2px;line-height:1.05;margin-top:4px', text: bu.size }),
          el('div', { style: 'color:var(--text-2);font-size:14px;margin-top:6px', text: bu.label || '' })
        ])
      ])
    ]));
  }
}
function setActionBar(cfg) { S.actionBar = cfg || null; renderOverlays(); }
function confirmDialog(opts) { return new Promise((resolve) => { S.confirmCfg = Object.assign({ resolve }, opts || {}); renderOverlays(); }); }
function burst(size, label) { S.burstCfg = { size, label }; renderOverlays(); setTimeout(() => { S.burstCfg = null; renderOverlays(); }, 1800); }

// ---------- live scan progress banner ----------
const SCAN_LABELS = { projects: 'Scanning projects', system: 'Measuring caches', largefiles: 'Scanning for large files' };
function beginScan(type, root) {
  S.scan = { active: true, type, scanned: 0, found: 0, root: root || '', label: type === 'projects' ? ('Scanning ' + (root || 'your home folder')) : SCAN_LABELS[type] || 'Scanning' };
  renderRoute();
}
function endScan() { if (S.scan) S.scan.active = false; }
function scanActive(type) { return S.scan && S.scan.active && S.scan.type === type; }
function renderScanBannerInto(wrap) {
  const sc = S.scan || {};
  wrap.innerHTML = '';
  wrap.appendChild(el('div', { style: 'color:var(--accent-fg);margin-bottom:14px' }, [el('spaci-icon', { name: 'spaci-ring', anim: 'wave', style: 'width:56px;height:56px;display:block' })]));
  wrap.appendChild(el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;display:flex;align-items:center;gap:10px;justify-content:center' }, [
    el('span', { text: sc.label || 'Scanning' }),
    el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:3px 10px;border-radius:7px;font-size:11px;font-weight:700', text: 'running' })
  ]));
  const parts = [];
  if (sc.scanned) parts.push(Number(sc.scanned).toLocaleString() + ' folders scanned');
  if (sc.found) parts.push(sc.found + ' found');
  wrap.appendChild(el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px', text: parts.join(' · ') || 'Working…' }));
  wrap.appendChild(el('div', { style: 'width:min(420px,80%);height:8px;border-radius:99px;background:var(--track);overflow:hidden;margin-top:18px' }, [
    el('div', { style: 'height:100%;width:38%;border-radius:99px;background:var(--accent);animation:sp-indet 1.25s ease-in-out infinite' })
  ]));
}
// scanBanner(type): returns the banner node if a scan of `type` is running, else null.
function scanBanner(type) {
  if (!scanActive(type)) return null;
  const wrap = el('div', { id: 'sp-scanbanner', style: 'display:flex;flex-direction:column;align-items:center;text-align:center;padding:26px 0 30px' });
  renderScanBannerInto(wrap);
  return wrap;
}
function liveScan(type, p) {
  if (!scanActive(type) || !p || p.phase === 'done') return;
  if (p.scanned != null) S.scan.scanned = p.scanned;
  if (p.found != null) S.scan.found = p.found;
  const b = document.getElementById('sp-scanbanner');
  if (b) renderScanBannerInto(b);
}

// ---------- app state ----------
const S = {
  route: 'dashboard',
  theme: 'dark',
  scanning: false,
  disk: null,
  breakdown: null,
  recs: [],
  lastScan: 0
};

const NAV_TOP = [
  { key: 'dashboard', label: 'Smart Scan', icon: 'dashboard' },
  { key: 'projects', label: 'Projects', icon: 'folder-2', count: () => (S.projects || []).length },
  { key: 'system', label: 'System Cleaner', icon: 'broom', count: () => (S.sysTargets || []).length },
  { key: 'largefiles', label: 'Large Files', icon: 'hard-drive' },
  { key: 'storage', label: 'Storage', icon: 'chart' },
  { key: 'recommendations', label: 'Recommendations', icon: 'sparkles', hot: true, count: () => (S.recs || []).length }
];
const NAV_SOON = [
  { label: 'Scheduled Scans', icon: 'calendar', soon: 'scheduled' },
  { label: 'Duplicate Finder', icon: 'copy', soon: 'duplicate' },
  { label: 'Spaci Guard', icon: 'shield', soon: 'guard' }
];
const NAV_BOTTOM = [
  { key: 'history', label: 'History', icon: 'log' },
  { key: 'settings', label: 'Settings', icon: 'settings' }
];

SP_REGISTRY();
function SP_REGISTRY() {
  window.SP = { screens: {}, go, state: S, el, ic, ring, fmt, toast, setActionBar, confirm: confirmDialog, burst, beginScan, endScan, scanBanner, scanActive };
}

// ---------- shell ----------
const root = document.getElementById('app');
let contentHost;

function renderShell() {
  // clear (keep grain)
  [...root.children].forEach((c) => { if (!c.classList.contains('sp-grain')) c.remove(); });

  // Welcome is full-screen (no sidebar / titlebar chrome).
  if (S.route === 'welcome') {
    const host = el('main', { class: 'sp-scroll', style: 'flex:1;overflow-y:auto;position:relative;background:var(--bg);-webkit-app-region:drag' });
    const page = el('div', { class: 'sp-fadeup', style: 'min-height:100%;display:flex;align-items:center;justify-content:center;padding:48px;-webkit-app-region:no-drag' });
    host.appendChild(page);
    root.appendChild(host);
    try { ((window.SP.screens && window.SP.screens.welcome) || screenPlaceholder)(page); } catch (e) {}
    return;
  }

  // titlebar
  const titlebar = el('div', {
    style:
      'height:54px;flex:none;display:flex;align-items:center;gap:14px;padding:0 18px 0 86px;background:var(--bg);border-bottom:1px solid var(--border);position:relative;z-index:30;-webkit-app-region:drag'
  }, [
    el('div', { style: 'flex:1;text-align:center;font-size:13px;font-weight:600;color:var(--text-3);letter-spacing:.2px' }, ['Spaci · Smart Cleaner']),
    el('div', { style: 'display:flex;gap:8px;align-items:center;-webkit-app-region:no-drag' }, [
      el('button', {
        style: 'width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:grid;place-items:center;cursor:pointer',
        hov: 'background:var(--panel-2);color:var(--text)',
        onclick: toggleTheme
      }, [ic(S.theme === 'light' ? 'moon' : 'sun', 16)]),
      el('button', {
        style: 'height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;font-size:13px',
        hov: 'background:var(--panel-2);color:var(--text)',
        onclick: doScan
      }, [ic('refresh', 15), 'Refresh'])
    ])
  ]);

  // body: sidebar + content
  const sidebar = renderSidebar();
  contentHost = el('main', { class: 'sp-scroll', style: 'flex:1;overflow-y:auto;position:relative;background:var(--bg)' });
  const body = el('div', { style: 'flex:1;display:flex;min-height:0;position:relative' }, [sidebar, contentHost]);

  root.appendChild(titlebar);
  root.appendChild(body);
  renderRoute();
}

function navItem(item, active) {
  const n = typeof item.count === 'function' ? item.count() : item.count || 0;
  const kids = [ic(item.icon, 19), el('span', { style: 'flex:1' }, [item.label])];
  if (n) kids.push(el('span', {
    class: item.hot ? 'sp-count-hot' : 'sp-count',
    style: 'font-size:11.5px;font-weight:700;min-width:22px;height:20px;padding:0 7px;border-radius:99px;display:inline-flex;align-items:center;justify-content:center',
    text: String(n)
  }));
  return el('div', {
    class: active ? 'sp-nav-on sp-hov' : 'sp-hov',
    style: 'display:flex;align-items:center;gap:13px;padding:10px 12px;border-radius:11px;cursor:pointer;font-weight:500;font-size:14px;color:var(--text-2);user-select:none',
    hov: active ? '' : 'background:var(--panel)',
    onclick: () => go(item.key)
  }, kids);
}

function renderSidebar() {
  const top = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:3px' },
    NAV_TOP.map((n) => navItem(n, S.route === n.key)));

  const soon = el('div', { style: 'display:flex;flex-direction:column;gap:3px' },
    NAV_SOON.map((n) => {
      const active = n.route ? S.route === n.route : (S.route === 'soon' && (S.activeSoon || 'duplicate') === n.soon);
      return el('div', {
        class: active ? 'sp-nav-on sp-hov' : 'sp-hov',
        style: 'display:flex;align-items:center;gap:13px;padding:10px 12px;border-radius:11px;cursor:pointer;font-weight:500;font-size:14px;color:var(--text-2);user-select:none',
        hov: active ? '' : 'background:var(--panel)',
        onclick: () => { if (n.route) go(n.route); else { S.activeSoon = n.soon; go('soon'); } }
      }, [ic(n.icon, 19), el('span', { style: 'flex:1' }, [n.label])]);
    }));

  const bottom = el('div', { style: 'display:flex;flex-direction:column;gap:3px' },
    NAV_BOTTOM.map((n) => navItem(n, S.route === n.key)));

  return el('aside', {
    style: 'width:248px;flex:none;background:var(--bg);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:18px 14px 16px;position:relative;z-index:20'
  }, [
    el('div', { style: 'display:flex;align-items:center;gap:12px;padding:6px 8px 22px' }, [
      ring('breathe', 30, 'var(--accent-fg)'),
      el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.5px' }, [el('span', { text: 'Spaci' }), el('span', { style: 'color:var(--accent-fg)', text: '.' })])
    ]),
    top,
    el('div', { style: 'flex:1' }),
    el('div', { style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-4);font-weight:700;padding:0 10px;margin:14px 0 8px' }, ['Tools']),
    soon,
    diskMini(),
    bottom
  ]);
}

function diskMini() {
  const d = S.disk;
  const bd = S.breakdown;
  const free = d ? fmt(d.free) : '...';
  const total = d ? fmt(d.total) : '';
  const pct = d && d.total ? Math.round((d.used / d.total) * 100) : 0;
  const cats = bd && bd.categories ? bd.categories : [];
  const sumCats = cats.reduce((a, c) => a + (Number(c.bytes) || 0), 0) || 1;
  const segs = cats.map((c, i) => el('span', {
    style: `height:100%;border-radius:2px;background:${CAT_COLORS[i % CAT_COLORS.length]};flex-basis:${((Number(c.bytes) || 0) / sumCats) * pct}%;flex-grow:0;flex-shrink:0`
  }));
  return el('div', {
    class: 'sp-hov',
    style: 'background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;margin:14px 0 10px;cursor:pointer',
    hov: 'border-color:var(--border-2)',
    onclick: () => go('storage')
  }, [
    el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);font-weight:600;margin-bottom:10px' }, [el('span', { text: 'Macintosh HD' }), el('span', { text: free + ' free' })]),
    el('div', { style: 'height:9px;border-radius:99px;background:var(--track);overflow:hidden;display:flex;gap:2px' }, segs),
    el('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-top:9px' }, [el('span', { text: pct + '% used' }), el('span', { text: total })])
  ]);
}

function renderRoute() {
  if (!contentHost) return;
  contentHost.innerHTML = '';
  S.actionBar = null; // each screen sets its own selection bar
  const page = el('div', { class: 'sp-fadeup', style: 'padding:34px 40px 120px' });
  contentHost.appendChild(page);
  const screen = (window.SP.screens && window.SP.screens[S.route]) || screenPlaceholder;
  try { screen(page); } catch (e) { page.appendChild(el('div', { style: 'color:var(--danger-fg)', text: 'Failed to render: ' + e.message })); }
  renderOverlays();
}

function go(route) {
  S.route = route;
  // refresh sidebar active states + content
  renderShell();
}

// ---------- placeholder for screens not yet rebuilt ----------
function screenPlaceholder(host) {
  const label = ([...NAV_TOP, ...NAV_BOTTOM].find((n) => n.key === S.route) || {}).label || S.route;
  host.appendChild(el('div', {
    style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:60vh;gap:18px;color:var(--text-3)'
  }, [
    el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
    el('div', { style: 'font-size:22px;font-weight:700;letter-spacing:-.6px;color:var(--text)' }, [label]),
    el('div', { style: 'font-size:14px;max-width:360px' }, ['This view is being rebuilt for Spaci v2. The Smart Scan dashboard is ready, the rest land next.'])
  ]));
}

// ---------- theme ----------
function applyTheme() {
  root.classList.toggle('light', S.theme === 'light');
}
async function toggleTheme() {
  S.theme = S.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  try { await api.setPrefs({ theme: S.theme }); } catch (_) {}
  renderShell();
}

// ---------- data + scan ----------
function normalizeDisk(d) {
  if (!d) return null;
  const total = Number(d.total) || 0;
  const free = Number(d.free != null ? d.free : d.avail != null ? d.avail : 0) || 0;
  const used = Number(d.used != null ? d.used : total - free) || 0;
  return { total, free, used };
}
async function loadData() {
  try { S.disk = normalizeDisk(await api.diskUsage()); } catch (_) {}
  try { S.breakdown = await api.diskBreakdown(); } catch (_) {}
  // The cache holds the last scan's projects + system targets; recommendations
  // are derived from them (the IPC requires them, calling it bare throws).
  try {
    const c = (await api.cacheGet()) || {};
    S.projects = c.projects || [];
    S.sysTargets = c.system || [];
    if (c.scannedAt) S.lastScan = c.scannedAt;
  } catch (_) {}
  try {
    S.recs = (await api.recommendations({ projects: S.projects || [], sysTargets: S.sysTargets || [] })) || [];
  } catch (_) { S.recs = S.recs || []; }
}

window.SP_doScan = doScan;
async function doScan() {
  if (S.scanning) return;
  S.scanning = true;
  renderShell();
  try { await Promise.allSettled([api.scanProjects && api.scanProjects(), api.scanSystem && api.scanSystem()]); } catch (_) {}
  S.lastScan = Date.now();
  await loadData();
  S.scanning = false;
  renderShell();
}

// ---------- boot ----------
async function boot() {
  try {
    const prefs = await api.getPrefs();
    if (prefs && prefs.theme) S.theme = prefs.theme;
    if (prefs && !prefs.onboarded) S.route = 'welcome';
  } catch (_) {}
  applyTheme();
  renderShell();
  await loadData();
  renderShell();

  if (api.onBreakdownUpdated) api.onBreakdownUpdated((bd) => { S.breakdown = bd; if (S.route === 'dashboard' || S.route === 'storage') renderShell(); });
  if (api.onCacheUpdated) api.onCacheUpdated(() => loadData().then(() => { if (S.route === 'dashboard') renderRoute(); }));
  if (api.onTrayScan) api.onTrayScan(() => { go('dashboard'); doScan(); });
  if (api.onNavGo) api.onNavGo((route) => { if (route) go(route); });
  if (api.onScanProgress) api.onScanProgress((p) => liveScan('projects', p));
  if (api.onSystemProgress) api.onSystemProgress((p) => liveScan('system', p));
  if (api.onLargeFilesProgress) api.onLargeFilesProgress((p) => liveScan('largefiles', p));
}


// boot after all body scripts (including screen modules) have registered.
document.addEventListener('DOMContentLoaded', boot);
