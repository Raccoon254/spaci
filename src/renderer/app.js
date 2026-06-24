'use strict';
/* Spaci v2 renderer.
   Shell (titlebar + sidebar + content) and the Smart Scan dashboard, wired to
   the existing IPC backend (window.api). Screens register on SP.screens; the
   other screens are placeholders until rebuilt. The design lives in
   design/spaci-v2-reference.html. */

const api = window.api;

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
  { key: 'dashboard', label: 'Smart Scan', icon: 'scan' },
  { key: 'projects', label: 'Projects', icon: 'folder-2' },
  { key: 'system', label: 'System Cleaner', icon: 'broom' },
  { key: 'largefiles', label: 'Large Files', icon: 'chart' },
  { key: 'storage', label: 'Storage', icon: 'database' }
];
const NAV_SOON = [
  { key: 'duplicates', label: 'Duplicate Finder', icon: 'copy' },
  { key: 'uninstaller', label: 'App Uninstaller', icon: 'trash' }
];
const NAV_BOTTOM = [
  { key: 'history', label: 'History', icon: 'clock' },
  { key: 'settings', label: 'Settings', icon: 'settings' }
];

SP_REGISTRY();
function SP_REGISTRY() {
  window.SP = { screens: {}, go, state: S, el, ic, ring, fmt };
}

// ---------- shell ----------
const root = document.getElementById('app');
let contentHost;

function renderShell() {
  // clear (keep grain)
  [...root.children].forEach((c) => { if (!c.classList.contains('sp-grain')) c.remove(); });

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
  return el('div', {
    class: active ? 'sp-nav-on sp-hov' : 'sp-hov',
    style: 'display:flex;align-items:center;gap:13px;padding:10px 12px;border-radius:11px;cursor:pointer;font-weight:500;font-size:14px;color:var(--text-2);user-select:none',
    hov: active ? '' : 'background:var(--panel)',
    onclick: () => go(item.key)
  }, [ic(item.icon, 19), el('span', { style: 'flex:1' }, [item.label])]);
}

function renderSidebar() {
  const top = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:3px' },
    NAV_TOP.map((n) => navItem(n, S.route === n.key)));

  const soon = el('div', { style: 'display:flex;flex-direction:column;gap:3px' },
    NAV_SOON.map((n) => el('div', {
      class: 'sp-hov',
      style: 'display:flex;align-items:center;gap:13px;padding:9px 12px;border-radius:11px;cursor:pointer;font-weight:500;font-size:13.5px;color:var(--text-3);user-select:none',
      hov: 'background:var(--panel);color:var(--text-2)',
      onclick: () => go('comingsoon')
    }, [ic(n.icon, 18, { color: 'var(--text-3)' }), el('span', { style: 'flex:1' }, [n.label]), ic('lock', 13, { color: 'var(--text-4)' })])));

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
    el('div', { style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-4);font-weight:700;padding:0 10px;margin:14px 0 8px' }, ['Coming soon']),
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
  const segs = (bd && bd.categories ? bd.categories : []).map((c, i) => el('span', {
    style: `height:100%;border-radius:2px;background:${CAT_COLORS[i % CAT_COLORS.length]};flex-basis:${d && d.total ? (c.bytes / d.total) * 100 : 0}%;flex-grow:0;flex-shrink:0`
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
  const page = el('div', { class: 'sp-fadeup', style: 'padding:34px 40px 120px' });
  contentHost.appendChild(page);
  const screen = (window.SP.screens && window.SP.screens[S.route]) || screenPlaceholder;
  try { screen(page); } catch (e) { page.appendChild(el('div', { style: 'color:var(--danger-fg)', text: 'Failed to render: ' + e.message })); }
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
async function loadData() {
  try { S.disk = await api.diskUsage(); } catch (_) {}
  try { S.breakdown = await api.diskBreakdown(); } catch (_) {}
  try { S.recs = (await api.recommendations()) || []; } catch (_) { S.recs = []; }
  try { const c = await api.cacheGet(); S.lastScan = (c && c.lastScan) || S.lastScan; } catch (_) {}
}

window.SP_doScan = doScan;
async function doScan() {
  if (S.scanning) return;
  S.scanning = true;
  if (S.route === 'dashboard') renderRoute();
  try { await Promise.allSettled([api.scanProjects && api.scanProjects(), api.scanSystem && api.scanSystem()]); } catch (_) {}
  S.lastScan = Date.now();
  await loadData();
  S.scanning = false;
  renderRoute();
}

// ---------- boot ----------
async function boot() {
  try {
    const prefs = await api.getPrefs();
    if (prefs && prefs.theme) S.theme = prefs.theme;
  } catch (_) {}
  applyTheme();
  renderShell();
  await loadData();
  renderShell();

  if (api.onBreakdownUpdated) api.onBreakdownUpdated((bd) => { S.breakdown = bd; if (S.route === 'dashboard' || S.route === 'storage') renderShell(); });
  if (api.onCacheUpdated) api.onCacheUpdated(() => loadData().then(() => { if (S.route === 'dashboard') renderRoute(); }));
  if (api.onTrayScan) api.onTrayScan(() => { go('dashboard'); doScan(); });
}

// boot after all body scripts (including screen modules) have registered.
document.addEventListener('DOMContentLoaded', boot);
