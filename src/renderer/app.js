'use strict';
/* ============================================================
   Spaci renderer (design: imported Onboarding.dc.html)
   `api` is a global exposed by preload via contextBridge.
   ============================================================ */

// ---------- DOM helpers ----------
function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) { if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
  return n;
}
const $ = (s) => document.querySelector(s);

// ---------- icons ----------
const ICONS = {};
const ICON_NAMES = ['broom','trash','folder','folder-open','file','document','scan','search','settings','info','github','home','dashboard','hard-drive','refresh','sort','arrow-left','arrow-right','chevron-right','chevron-down','close','check','check-circle','warning','shield','clock','copy','external-link','plus','minus','terminal','apple','box','database','cpu','flash','star','sparkles','download','eye','play','pause','node','java','gradle','python','php','android','react','svelte','html','javascript','rust','go','docker','flutter','image','filter','menu','grid','list','moon','sun','bell','lock','folder-cloud','rocket','heart','log','package','theme','git','branch','calendar','activity','code','edit','chart','document-text','folder-2','browser','chrome','safari','edge','firefox','undo'];
const LOGO_NAMES = ['node','react','python','java','rust','go','php','android','flutter','gradle','maven','svelte','docker','html','javascript','typescript','vuejs','nextjs','angular','npm','yarn','bun','deno','apple','dotnet','terraform'];
const LOGOS = {};
async function preloadIcons() {
  await Promise.all([
    ...ICON_NAMES.map(async (n) => { ICONS[n] = await api.icon(n); }),
    ...LOGO_NAMES.map(async (n) => { LOGOS[n] = await api.logo(n); }),
  ]);
}
function icon(name, cls = '') { const s = el('span', { class: 'icon ' + cls }); s.innerHTML = ICONS[name] || ICONS.box || ''; return s; }
// A clean bare checkmark (no surrounding ring) for the circular select control.
const CHECK_MARK = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5 10 17.5 19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function checkMark(cls = '') { const s = el('span', { class: 'icon ' + cls }); s.innerHTML = CHECK_MARK; return s; }
// The Spaci mark: a 6-segment radial ring (currentColor). `anim` = breathe | spin | chase | ''.
function spaciMark(anim, cls = '') {
  const span = el('span', { class: 'spaci-mark ' + cls });
  let segs = '';
  for (let i = 0; i < 6; i++) segs += `<g transform="rotate(${i * 60} 50 50)"><ellipse class="seg" cx="50" cy="22" rx="12" ry="5.5" fill="currentColor" style="--i:${i}"/></g>`;
  span.innerHTML = `<svg viewBox="0 0 100 100" class="spaci-svg ${anim || ''}">${segs}</svg>`;
  return span;
}
// The branded loading spinner: the Spaci mark, "working" variant. Inherits currentColor.
function loader(size, cls) { const m = spaciMark('working', cls || ''); if (size) { m.style.width = size + 'px'; m.style.height = size + 'px'; } return m; }
// Real brand logo (colored) when available, else the monochrome kentom icon.
function logo(kind, cls = '') { if (LOGOS[kind]) { const s = el('span', { class: 'icon brand-logo ' + cls }); s.innerHTML = LOGOS[kind]; return s; } return icon(iconFor(kind), cls); }

// Normalize a folder name into a readable title.
function prettyName(name) {
  let s = String(name || '').replace(/[._]+/g, ' ').replace(/-+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  if (!s) return String(name || '');
  return s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}
// A project's own icon (favicon / launcher / AppIcon), with a monochrome folder fallback.
function projectImage(p, big) {
  const holder = el('div', { class: 'proj-tile' + (big ? ' proj-tile-lg' : '') }, [icon('folder-2')]);
  if (p && p.iconPath) {
    const badge = el('span', { class: 'proj-badge' });
    holder.appendChild(badge);
    api.projectIcon(p.iconPath).then((url) => { if (url) badge.appendChild(el('img', { src: url, class: 'proj-badge-img', alt: '' })); }).catch(() => {});
  }
  return holder;
}
function iconFor(kind) {
  const map = { node:'node', java:'java', maven:'java', gradle:'gradle', python:'python', php:'php', android:'android', react:'react', svelte:'svelte', apple:'apple', flash:'flash', box:'box', file:'file', html:'html', rust:'rust', go:'go', flutter:'flutter', database:'database', log:'log', trash:'trash', folder:'folder', broom:'broom', clock:'clock', sparkles:'sparkles' };
  return map[kind] && ICONS[map[kind]] ? map[kind] : (ICONS[kind] ? kind : 'folder');
}

// ---------- format ----------
function fmt(b) { if (!b || b < 0) return '0 B'; if (b < 1024) return b + ' B'; const u = ['KB','MB','GB','TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1); return `${b.toFixed(b < 10 ? 1 : b < 100 ? 1 : 0)} ${u[i]}`; }
function ago(ms) { if (!ms) return '-'; const d = Math.floor((Date.now() - ms) / 86400000); if (d < 1) return 'today'; if (d === 1) return 'yesterday'; if (d < 30) return d + 'd ago'; if (d < 365) return Math.floor(d/30) + 'mo ago'; return Math.floor(d/365) + 'y ago'; }

// ---------- state ----------
const state = {
  prefs: null, home: '', disk: null,
  projects: [], system: [], recs: [],
  selItems: new Set(), selSystem: new Set(),
  scan: { projects: false, system: false, largefiles: false }, route: 'dashboard',
  projFilter: '', projSort: 'size', activeProject: null, activeRec: null, activeHist: null, scannedAt: 0,
  largeFiles: [], largeSel: new Set(), largeMin: 100 * 1024 * 1024, history: [],
  ops: [], bgScanning: false, diskBreakdown: null,
};
const CAT_COLORS = { coding: '#3b6fd0', documents: '#2fb8a8', media: '#8b6bd9', downloads: '#e0954f', apps: '#d96a8a', library: '#7a8a99', system: '#7a8a99', other: '#8a857d' };
// Build donut/bar segments from disk usage + category breakdown.
function diskSegments() {
  const d = state.disk; if (!d) return null;
  const total = d.total || 1, used = d.used || 0, bd = state.diskBreakdown;
  const segs = [];
  if (bd && bd.categories && bd.categories.length) {
    const known = ['coding', 'documents', 'media', 'downloads', 'apps'];
    let knownSum = 0;
    for (const c of bd.categories) if (known.includes(c.key)) { const b = Math.max(0, c.bytes); segs.push({ key: c.key, label: `${c.label} · ${fmt(b)}`, value: b, color: CAT_COLORS[c.key] }); knownSum += b; }
    if (knownSum > used && knownSum > 0) { const sc = used / knownSum; segs.forEach((s) => { s.value *= sc; }); knownSum = used; }
    const sysOther = Math.max(0, used - knownSum);
    if (sysOther > 0) segs.push({ key: 'system', label: `System & other · ${fmt(sysOther)}`, value: sysOther, color: CAT_COLORS.system });
  } else {
    segs.push({ key: 'used', label: `Used · ${fmt(used)}`, value: used, color: '#c0563f' });
  }
  segs.push({ key: 'free', label: `Free · ${fmt(Math.max(0, total - used))}`, value: Math.max(0, total - used), color: 'rgba(128,128,128,0.18)' });
  return segs.filter((s) => s.value > 0);
}

// ---------- boot ----------
(async function boot() {
  await preloadIcons();
  state.prefs = await api.getPrefs();
  state.home = await api.home();
  applyTheme(state.prefs.theme || 'dark');
  $('#brandLogo').appendChild(spaciMark('breathe'));
  // Hydrate from cached scan results for an instant UI.
  try {
    const c = await api.cacheGet();
    if (c) { state.projects = c.projects || []; state.system = c.system || []; state.scannedAt = c.scannedAt || 0; if (state.projects.length || state.system.length) await computeRecs(); }
  } catch (_) { /* no cache yet */ }
  renderSidebar(); refreshDisk();
  api.onCleanProgress((p) => updateCleanProgress(p));
  api.onTrayScan(() => { if (state.prefs.onboarded) scanEverything(); });
  api.onCacheUpdated((c) => {
    state.projects = c.projects || []; state.system = c.system || []; state.scannedAt = c.scannedAt || 0;
    computeRecs(); renderSidebar();
    if (['dashboard', 'projects', 'system', 'recommendations'].includes(state.route)) go(state.route);
    toast('refresh', 'Updated in background', 'Latest scan results loaded');
  });
  api.onEnrichUpdated((u) => {
    const p = state.activeProject;
    if (p && p.path === u.path) { p._enrich = { totalSize: u.totalSize, git: u.git }; applyEnrich(p, p._enrich); }
  });
  api.onBgScan((p) => { state.bgScanning = !!(p && p.active); updateActivity(); });
  api.onBreakdownUpdated((b) => { if (b) { state.diskBreakdown = b; renderDiskMini(); if (state.route === 'dashboard') go('dashboard'); } });
  api.diskBreakdown().then((b) => { if (b) { state.diskBreakdown = b; renderDiskMini(); if (state.route === 'dashboard') go('dashboard'); } }).catch(() => {});
  if (!state.prefs.onboarded) showOnboarding(); else go('dashboard');
})();

// ---------- theme ----------
function applyTheme(t) {
  document.body.classList.toggle('theme-light', t === 'light');
  document.body.classList.toggle('theme-dark', t !== 'light');
  state.prefs.theme = t;
}
async function toggleTheme() {
  const next = state.prefs.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  state.prefs = await api.setPrefs({ theme: next });
  renderSidebar();
}

// ---------- disk + sidebar ----------
async function refreshDisk() { state.disk = await api.diskUsage(state.home); renderDiskMini(); if (state.route === 'dashboard') go('dashboard'); }
function diskPct() { const d = state.disk; return d ? Math.round((d.used / d.total) * 100) : 0; }
function renderDiskMini() {
  const d = state.disk, box = $('#diskMini'); box.innerHTML = '';
  if (!d) return;
  const pct = diskPct();
  const segs = diskSegments();
  let barEl;
  if (segs && window.diskBar) {
    barEl = window.diskBar(segs, { width: 204, height: 9, gap: 2, radius: 5, trackColor: 'rgba(128,128,128,0.16)' });
  } else {
    barEl = el('div', { class: 'bar' + (pct > 90 ? ' danger' : '') }, [el('span')]);
    requestAnimationFrame(() => { const s = barEl.querySelector('span'); if (s) s.style.width = pct + '%'; });
  }
  const card = el('div', { class: 'card', style: 'padding:14px;margin:6px 0 10px' }, [
    el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);font-weight:600;margin-bottom:9px' }, [el('span', { text: 'Macintosh HD' }), el('span', { text: fmt(d.avail) + ' free' })]),
    barEl,
    el('div', { style: 'display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3);margin-top:9px' }, [el('span', { text: pct + '% used' }), el('span', { text: fmt(d.total) })]),
  ]);
  box.appendChild(card);
}

const NAV = [
  { id: 'dashboard', label: 'Smart Scan', icon: 'dashboard' },
  { id: 'projects', label: 'Projects', icon: 'folder-2' },
  { id: 'system', label: 'System Cleaner', icon: 'broom' },
  { id: 'largefiles', label: 'Large Files', icon: 'hard-drive' },
  { id: 'recommendations', label: 'Recommendations', icon: 'sparkles' },
];
function renderSidebar() {
  const main = $('#navMain'); main.innerHTML = '';
  for (const it of NAV) main.appendChild(navItem(it));
  const bot = $('#navBottom'); bot.innerHTML = '';
  bot.appendChild(navItem({ id: 'history', label: 'History', icon: 'log' }));
  bot.appendChild(navItem({ id: 'settings', label: 'Settings', icon: 'settings' }));
  const ta = $('#titlebarActions'); ta.innerHTML = '';
  ta.appendChild(el('button', { class: 'btn btn-ghost btn-icon btn-sm theme-toggle', title: 'Toggle light / dark', style: 'border-radius:50%;width:36px;height:36px;padding:0', onclick: toggleTheme }, [icon('theme', 'icon-sm ' + (state.prefs.theme === 'light' ? 'theme-light-ic' : ''))]));
  ta.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: refreshDisk }, [icon('refresh', 'icon-sm'), 'Refresh']));
}
function navItem(it) {
  const active = state.route === it.id || (it.id === 'projects' && state.route === 'project') || (it.id === 'recommendations' && state.route === 'rec') || (it.id === 'settings' && state.route === 'about') || (it.id === 'history' && state.route === 'histdetail');
  const node = el('div', { class: 'nav-item' + (active ? ' active' : ''), onclick: () => go(it.id) }, [icon(it.icon, 'icon-sm'), el('span', { text: it.label })]);
  let count = null, hot = false;
  if (it.id === 'projects' && state.projects.length) count = state.projects.length;
  if (it.id === 'system' && state.system.length) count = state.system.length;
  if (it.id === 'recommendations' && state.recs.length) { count = state.recs.length; hot = true; }
  if (it.id === 'history') { const r = state.ops.filter((o) => o.status === 'running').length; if (r) { count = r; hot = true; } }
  if (count != null) node.appendChild(el('span', { class: 'count' + (hot ? ' hot' : ''), text: String(count) }));
  return node;
}

// ---------- router ----------
function go(route) {
  state.route = route; renderSidebar();
  const v = $('#view'); v.innerHTML = ''; v.scrollTop = 0;
  v.classList.remove('fade-up'); void v.offsetWidth; v.classList.add('fade-up');
  ({ dashboard: viewDashboard, projects: viewProjects, project: viewProjectDetails, system: viewSystem, largefiles: viewLargeFiles, recommendations: viewRecs, rec: viewRecDetail, history: viewHistory, histdetail: viewHistoryDetail, settings: viewSettings, about: viewAbout }[route] || viewDashboard)(v);
}

// ============================================================ DASHBOARD
function viewDashboard(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'Smart Scan' }), el('div', { class: 'page-sub', text: 'One scan across your projects and system caches. Review, then reclaim, safely.' })]),
    state.scannedAt ? el('div', { style: 'text-align:right' }, [el('div', { class: 'page-sub', style: 'margin:0' }, [icon('clock', 'icon-sm'), ' Last scanned']), el('div', { style: 'font-weight:600;font-size:13px;margin-top:2px', text: ago(state.scannedAt) })]) : null,
  ]));

  const pct = diskPct(), d = state.disk;
  const reclaimProj = state.projects.reduce((s, p) => s + p.cleanableSize, 0);
  const reclaimSys = state.system.filter((t) => t.safe).reduce((s, t) => s + t.size, 0);
  const total = reclaimProj + reclaimSys;

  // hero disk donut, segmented by category, with a fallback ring
  const segs = diskSegments();
  let ring;
  if (segs && window.diskDonut) {
    const centerDefault = `<b>${d ? pct + '%' : '-'}</b><span>disk used</span>`;
    ring = window.diskDonut(segs, { size: 184, stroke: 15, trackColor: 'rgba(128,128,128,0.16)', centerHTML: centerDefault, onHover: (seg) => { const c = ring && ring.querySelector('.donut-center'); if (c) c.innerHTML = seg ? `<b>${fmt(seg.value)}</b><span>${(seg.label || '').split(' · ')[0]}</span>` : centerDefault; } });
  } else {
    ring = el('div', { class: 'hero-ring' }, [
      el('div', { class: 'ring-bg', style: `--p:${pct};--rc:${pct > 90 ? 'var(--danger)' : 'var(--accent-fg)'}` }),
      el('div', { class: 'ring-in' }),
      el('div', { class: 'ring-label' }, [el('b', { text: d ? pct + '%' : '-' }), el('span', { text: 'disk used' })]),
    ]);
  }
  const heroBody = el('div', { class: 'hero-body' }, [
    el('h2', { text: total > 0 ? `${fmt(total)} ready to reclaim` : (state.projects.length || state.system.length ? 'All clean here' : 'Run your first scan') }),
    el('p', { text: d ? `${fmt(d.avail)} free of ${fmt(d.total)}. Spaci finds regenerable build artifacts and caches you can safely remove.` : 'Measuring your disk…' }),
    el('div', { style: 'display:flex;gap:12px' }, [
      el('button', { class: 'btn btn-primary btn-lg', onclick: scanEverything, disabled: (state.scan.projects || state.scan.system) ? 'true' : null }, [(state.scan.projects || state.scan.system) ? loader(20) : icon('scan', 'icon-sm'), (state.scan.projects || state.scan.system) ? 'Scanning…' : 'Smart Scan']),
      total > 0 ? el('button', { class: 'btn btn-lg', onclick: () => go('recommendations') }, ['Review', icon('arrow-right', 'icon-sm')]) : null,
    ]),
  ]);
  v.appendChild(el('div', { class: 'card hero' }, [ring, heroBody]));

  if (total > 0) {
    v.appendChild(el('div', { class: 'banner', style: 'margin-top:16px' }, [
      el('div', { class: 'b-ic' }, [icon('sparkles')]),
      el('div', { style: 'flex:1' }, [el('div', { class: 'b-val', html: `Up to <span>${fmt(total)}</span> can be reclaimed` }), el('div', { class: 'page-sub', style: 'margin-top:2px', text: `${fmt(reclaimProj)} in project artifacts · ${fmt(reclaimSys)} in caches` })]),
      el('button', { class: 'btn btn-primary', onclick: () => go('recommendations') }, ['See how', icon('arrow-right', 'icon-sm')]),
    ]));
  }

  v.appendChild(el('div', { class: 'grid grid-2', style: 'margin-top:16px' }, [
    statCard('folder', 'Project artifacts', state.projects.length ? fmt(reclaimProj) : '-', state.projects.length ? `${state.projects.length} projects` : 'Not scanned', () => go('projects')),
    statCard('broom', 'System caches', state.system.length ? fmt(reclaimSys) : '-', state.system.length ? `${state.system.length} locations` : 'Not scanned', () => go('system')),
  ]));

  if (state.recs.length) {
    v.appendChild(el('div', { class: 'section-title', text: 'Top recommendations' }));
    const list = el('div', { class: 'list' });
    state.recs.slice(0, 3).forEach((r) => list.appendChild(recRow(r)));
    v.appendChild(list);
  }
}
function statCard(ic, label, val, sub, onClick) {
  return el('div', { class: 'card stat', onclick: onClick }, [
    el('div', { class: 'stat-top' }, [el('div', { class: 'stat-ic' }, [icon(ic, 'icon-sm')]), label]),
    el('div', { class: 'stat-val', text: val }), el('div', { class: 'stat-sub', text: sub }),
  ]);
}

async function scanEverything() { go('projects'); await scanProjects(); await scanSystem(true); await computeRecs(); toast('check-circle', 'Scan complete', `${state.projects.length} projects · ${state.system.length} caches`); }

// ============================================================ PROJECTS
function viewProjects(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'Projects' }), el('div', { class: 'page-sub', text: 'Regenerable build artifacts: node_modules, target, .next, __pycache__ and more.' })]),
    el('div', { style: 'display:flex;gap:10px' }, [
      el('button', { class: 'btn', onclick: pickAndScan }, [icon('folder-open', 'icon-sm'), 'Choose folder']),
      el('button', { class: 'btn btn-primary', onclick: () => scanProjects() }, [icon('scan', 'icon-sm'), 'Scan']),
    ]),
  ]));
  v.appendChild(el('div', { id: 'projHost' }));
  renderProjects();
}
async function pickAndScan() { const dir = await api.pickFolder(); if (!dir) return; state.prefs = await api.setPrefs({ scanRoots: [dir] }); scanProjects(dir); }

async function scanProjects(root) {
  root = root || state.prefs.scanRoots?.[0] || state.home;
  state.scan.projects = true; state.selItems.clear(); state.activeProject = null;
  renderProjects();
  const unsub = api.onScanProgress((p) => updateScanProgress(p));
  const res = await api.scanProjects(root); unsub();
  state.scan.projects = false;
  state.projects = (res.projects || []).filter((p) => p.items.length);
  renderProjects(); renderSidebar();
}

function renderProjects() {
  const host = $('#projHost'); if (!host) return; host.innerHTML = '';
  if (state.scan.projects) { host.appendChild(scanningBar('Scanning ' + (state.prefs.scanRoots?.[0] || state.home), { scope: 'projects' })); return; }
  if (!state.projects.length) {
    host.appendChild(emptyState('folder', 'No projects scanned yet', 'Pick a folder (your home folder works great) and Spaci finds every project with reclaimable artifacts.', 'Scan ' + (state.prefs.scanRoots?.[0]?.split('/').pop() || 'home'), () => scanProjects()));
    return;
  }
  host.appendChild(el('div', { class: 'toolbar' }, [
    el('label', { class: 'search' }, [icon('search', 'icon-sm'), el('input', { placeholder: 'Filter projects…', value: state.projFilter, oninput: (e) => { state.projFilter = e.target.value; applyProjFilter(); } })]),
    sortChip('size', 'Largest', 'sort'), sortChip('name', 'Name', 'list'), sortChip('date', 'Recent', 'clock'),
  ]));
  host.appendChild(el('div', { class: 'list', id: 'projList' }));
  host.appendChild(el('div', { id: 'projActionBar' }));
  drawList();

  function sortChip(id, label, ic) { return el('div', { class: 'chip' + (state.projSort === id ? ' active' : ''), onclick: () => { state.projSort = id; renderProjects(); } }, [icon(ic, 'icon-sm'), label]); }
  function drawList() {
    const items = state.projects.slice().sort((a, b) => state.projSort === 'name' ? a.name.localeCompare(b.name) : state.projSort === 'date' ? b.mtime - a.mtime : b.cleanableSize - a.cleanableSize);
    const list = $('#projList'); list.innerHTML = '';
    items.forEach((p) => { const row = projectRow(p); row.dataset.search = (p.name + ' ' + p.path).toLowerCase(); list.appendChild(row); });
    applyProjFilter();
    renderProjActionBar();
  }
}
// Filter rows in place (show/hide) so searching never rebuilds or re-animates the list.
function applyProjFilter() {
  const q = (state.projFilter || '').toLowerCase().trim();
  const list = $('#projList'); if (!list) return;
  let shown = 0;
  for (const row of list.children) {
    const match = !q || (row.dataset.search || '').includes(q);
    row.style.display = match ? '' : 'none';
    if (match) shown++;
  }
}
function openProject(p) { state.activeProject = p; go('project'); }
function projectRow(p) {
  const allSel = p.items.every((i) => state.selItems.has(i.path)) && p.items.length;
  const row = el('div', { class: 'row', onclick: () => openProject(p) }, [
    el('div', { class: 'check' + (allSel ? ' on' : ''), title: 'Select all artifacts', onclick: (e) => { e.stopPropagation(); toggleProject(p); } }, [checkMark('icon-sm')]),
    el('div', { class: 'r-icon' }, [projectImage(p)]),
    el('div', { class: 'r-main' }, [
      el('div', { class: 'r-title' }, [el('span', { class: 'r-name', text: prettyName(p.name) }), p.isGit ? icon('github', 'git-mark') : null, icon(iconFor(p.type.icon), 'lang-logo')]),
      el('div', { class: 'r-desc', text: `${p.items.length} item${p.items.length !== 1 ? 's' : ''} · ${ago(p.mtime)} · ${p.path}` }),
    ]),
    el('div', { class: 'r-size big', text: fmt(p.cleanableSize) }),
    el('span', { class: 'icon icon-sm r-chev', html: ICONS['arrow-right'] || '' }),
  ]);
  return row;
}
function toggleProject(p) {
  const all = p.items.every((i) => state.selItems.has(i.path)) && p.items.length;
  p.items.forEach((i) => all ? state.selItems.delete(i.path) : state.selItems.add(i.path));
  renderProjects();
}
function selectedItems() { const out = []; for (const p of state.projects) for (const i of p.items) if (state.selItems.has(i.path)) out.push(i); return out; }
function renderProjActionBar() {
  const bar = $('#projActionBar'); if (!bar) return; bar.innerHTML = '';
  const sel = selectedItems(); if (!sel.length) return;
  const total = sel.reduce((s, i) => s + i.size, 0);
  bar.appendChild(el('div', { class: 'action-wrap' }, [el('div', { class: 'action-bar' }, [
    el('div', { class: 'ab-sum', html: `${sel.length} item(s) · <span>${fmt(total)}</span>` }), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost', onclick: () => { state.selItems.clear(); state.route === 'project' ? go('project') : renderProjects(); } }, ['Clear']),
    el('button', { class: 'btn btn-danger', onclick: () => confirmClean(sel.map((i) => ({ path: i.path })), 'projects') }, [icon('trash', 'icon-sm'), `Clean ${fmt(total)}`]),
  ])]));
}
// ---- full project details page ----
function viewProjectDetails(v) {
  const p = state.activeProject;
  if (!p) { go('projects'); return; }

  v.appendChild(el('div', { style: 'margin-bottom:18px' }, [
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('projects') }, [icon('arrow-left', 'icon-sm'), 'All projects']),
  ]));

  // hero header
  v.appendChild(el('div', { class: 'detail-hero' }, [
    el('div', { class: 'detail-ic' }, [projectImage(p, true)]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { class: 'detail-name' }, [
        el('span', { class: 'd-name', text: prettyName(p.name) }),
        icon(iconFor(p.type.icon), 'lang-logo'),
        el('span', { class: 'badge git', id: 'gitBadge', style: 'display:none' }),
      ]),
      el('div', { class: 'detail-path mono', text: p.path }),
    ]),
    el('div', { style: 'display:flex;gap:10px;flex:none' }, [
      el('button', { class: 'btn btn-sm', onclick: () => api.reveal(p.path) }, [icon('external-link', 'icon-sm'), 'Reveal']),
      el('button', { class: 'btn btn-sm', onclick: () => api.openPath(p.path) }, [icon('folder-open', 'icon-sm'), 'Open']),
    ]),
  ]));

  // stat cards
  v.appendChild(el('div', { class: 'grid grid-4 detail-stats' }, [
    statBig('hard-drive', 'Total size', el('span', { id: 'statTotal' }, [loader(18)])),
    statBig('flash', 'Reclaimable', el('span', { text: fmt(p.cleanableSize) }), true),
    statBig('box', 'Artifacts', el('span', { text: String(p.items.length) })),
    statBig('clock', 'Last modified', el('span', { text: ago(p.mtime) })),
  ]));

  // version control
  v.appendChild(el('div', { class: 'card', style: 'margin-top:16px' }, [
    el('div', { class: 'section-title', style: 'margin:0 0 12px', text: 'Version control' }),
    el('div', { id: 'gitBody', style: 'display:flex;align-items:center;gap:10px;color:var(--text-3);font-size:13.5px' }, [loader(18), 'Checking git status…']),
  ]));

  // cleanable items
  const allSel = p.items.every((i) => state.selItems.has(i.path));
  v.appendChild(el('div', { class: 'page-head', style: 'margin:26px 0 12px;align-items:center' }, [
    el('div', { class: 'section-title', style: 'margin:0', text: `Cleanable items (${p.items.length})` }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { p.items.forEach((i) => allSel ? state.selItems.delete(i.path) : state.selItems.add(i.path)); go('project'); } }, [icon('check-circle', 'icon-sm'), allSel ? 'Deselect all' : 'Select all']),
  ]));
  const list = el('div', { class: 'list' });
  p.items.forEach((it) => list.appendChild(detailItemRow(it)));
  v.appendChild(list);

  v.appendChild(el('div', { id: 'projActionBar' }));
  renderProjActionBar();
  enrichDetails(p);
}

function statBig(ic, label, valEl, hot) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'stat-top' }, [el('div', { class: 'stat-ic' }, [icon(ic, 'icon-sm')]), label]),
    el('div', { class: 'stat-val' + (hot ? ' accent' : '') }, [valEl]),
  ]);
}
function detailItemRow(it) {
  const sel = state.selItems.has(it.path);
  return el('div', { class: 'row' + (sel ? ' selected' : ''), onclick: () => { sel ? state.selItems.delete(it.path) : state.selItems.add(it.path); go('project'); } }, [
    el('div', { class: 'check' + (sel ? ' on' : '') }, [checkMark('icon-sm')]),
    el('div', { class: 'r-icon' }, [icon(iconFor(it.kind))]),
    el('div', { class: 'r-main' }, [
      el('div', { class: 'r-title' }, [it.name, it.safe ? el('span', { class: 'badge safe', text: 'safe' }) : el('span', { class: 'badge warn', text: 'caution' })]),
      el('div', { class: 'r-desc', style: 'white-space:normal', text: it.note }),
    ]),
    el('button', { class: 'btn btn-ghost btn-icon btn-sm', title: 'Reveal', onclick: (e) => { e.stopPropagation(); api.reveal(it.path); } }, [icon('external-link', 'icon-sm')]),
    el('div', { class: 'r-size', text: fmt(it.size) }),
  ]);
}
async function enrichDetails(p) {
  if (p._enrich) applyEnrich(p, p._enrich); // instant from session cache, refresh below
  let r;
  try { r = await api.enrichProject(p.path); } catch { r = { totalSize: 0, git: null }; }
  p._enrich = r;
  applyEnrich(p, r);
}
function applyEnrich(p, r) {
  if (state.activeProject !== p || state.route !== 'project') return;
  const st = $('#statTotal'); if (st) st.textContent = fmt(r.totalSize || 0);
  const body = $('#gitBody'), badge = $('#gitBadge');
  if (!body) return;
  body.innerHTML = '';
  if (r.git) {
    body.style.color = 'var(--text)';
    const clean = r.git.dirty === 0;
    body.appendChild(el('div', { style: 'display:flex;gap:28px;flex-wrap:wrap;width:100%' }, [
      gitKV('branch', 'Branch', r.git.branch),
      gitKV(clean ? 'check-circle' : 'warning', 'Working tree', clean ? 'Clean' : `${r.git.dirty} uncommitted`, clean ? 'var(--success)' : 'var(--danger)'),
      gitKV('arrow-right', 'Remote', r.git.ahead ? `${r.git.ahead} ahead` : 'Up to date'),
    ]));
    if (badge) { badge.style.display = ''; badge.innerHTML = ''; badge.appendChild(icon('branch', 'icon-sm')); badge.appendChild(document.createTextNode(' ' + r.git.branch)); }
  } else {
    body.style.color = 'var(--text-3)';
    body.appendChild(icon('info', 'icon-sm'));
    body.appendChild(document.createTextNode(' Not a git repository.'));
  }
}
function gitKV(ic, k, v, color) {
  return el('div', {}, [
    el('div', { style: 'color:var(--text-3);font-size:12px;display:flex;gap:6px;align-items:center;margin-bottom:5px' }, [icon(ic, 'icon-sm'), k]),
    el('div', { style: 'font-weight:700;font-size:15px;' + (color ? 'color:' + color : '') , text: v }),
  ]);
}

// ============================================================ SYSTEM
function viewSystem(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'System Cleaner' }), el('div', { class: 'page-sub', text: 'Developer and system caches. Everything here is regenerable, clearing it is safe and reversible.' })]),
    el('button', { class: 'btn btn-primary', onclick: () => scanSystem() }, [icon('scan', 'icon-sm'), 'Scan caches']),
  ]));
  v.appendChild(el('div', { id: 'sysHost' }));
  renderSystem();
}
async function scanSystem(silent) {
  state.scan.system = true; state.selSystem.clear();
  if (!silent) renderSystem();
  const unsub = api.onSystemProgress((p) => updateScanProgress(p));
  const res = await api.scanSystem(); unsub();
  state.scan.system = false; state.system = res.targets || [];
  if (!silent) renderSystem(); renderSidebar();
}
function renderSystem() {
  const host = $('#sysHost'); if (!host) return; host.innerHTML = '';
  if (state.scan.system) { host.appendChild(scanningBar('Measuring caches…', { stats: false, scope: 'system' })); return; }
  if (!state.system.length) { host.appendChild(emptyState('broom', 'Scan to measure your caches', 'Spaci checks npm, Gradle, Maven, Cargo, Xcode DerivedData, browser caches, Trash and more.', 'Scan caches', () => scanSystem())); return; }
  const groups = {}; for (const t of state.system) (groups[t.category] = groups[t.category] || []).push(t);
  for (const [cat, items] of Object.entries(groups)) {
    items.sort((a, b) => b.size - a.size);
    host.appendChild(el('div', { class: 'section-title', text: cat }));
    const list = el('div', { class: 'list' });
    items.forEach((t) => list.appendChild(systemRow(t)));
    host.appendChild(list);
  }
  host.appendChild(el('div', { id: 'sysActionBar' }));
  renderSysActionBar();
}
function systemRow(t) {
  const sel = state.selSystem.has(t.id);
  return el('div', { class: 'row' + (sel ? ' selected' : ''), onclick: () => { sel ? state.selSystem.delete(t.id) : state.selSystem.add(t.id); renderSystem(); } }, [
    el('div', { class: 'check' + (sel ? ' on' : '') }, [checkMark('icon-sm')]),
    el('div', { class: 'r-icon' }, [icon(iconFor(t.icon))]),
    el('div', { class: 'r-main' }, [el('div', { class: 'r-title' }, [t.name, t.safe ? el('span', { class: 'badge safe', text: 'safe' }) : el('span', { class: 'badge warn', text: 'review' })]), el('div', { class: 'r-desc', text: t.description })]),
    el('div', { class: 'r-size' + (t.size > 1e9 ? ' big' : ''), text: fmt(t.size) }),
  ]);
}
function renderSysActionBar() {
  const bar = $('#sysActionBar'); if (!bar) return; bar.innerHTML = '';
  const sel = state.system.filter((t) => state.selSystem.has(t.id)); if (!sel.length) return;
  const total = sel.reduce((s, t) => s + t.size, 0);
  bar.appendChild(el('div', { class: 'action-wrap' }, [el('div', { class: 'action-bar' }, [
    el('div', { class: 'ab-sum', html: `${sel.length} cache(s) · <span>${fmt(total)}</span>` }), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost', onclick: () => { state.selSystem.clear(); renderSystem(); } }, ['Clear']),
    el('button', { class: 'btn btn-danger', onclick: () => confirmClean(sel.flatMap((t) => t.existingPaths.map((p) => ({ path: p, mode: t.mode }))), 'system') }, [icon('trash', 'icon-sm'), `Clean ${fmt(total)}`]),
  ])]));
}

// ============================================================ RECOMMENDATIONS
async function computeRecs() { state.recs = await api.recommendations({ projects: state.projects, sysTargets: state.system }); renderSidebar(); }
function viewRecs(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'Recommendations' }), el('div', { class: 'page-sub', text: 'The biggest, safest wins, surfaced automatically.' })]),
    el('button', { class: 'btn', onclick: scanEverything }, [icon('refresh', 'icon-sm'), 'Re-scan']),
  ]));
  if (!state.recs.length) { v.appendChild(emptyState('sparkles', 'Nothing to recommend yet', 'Run a Smart Scan and Spaci surfaces stale projects, oversized caches and quick wins.', 'Smart Scan', scanEverything)); return; }
  const list = el('div', { class: 'list' });
  state.recs.forEach((r) => list.appendChild(recRow(r)));
  v.appendChild(list);
}
function recRow(r) {
  const proj = (r.kind === 'project' && r.action) ? state.projects.find((p) => p.path === r.action.path) : null;
  const title = proj ? `${prettyName(proj.name)} · ${fmt(r.savings || 0)} reclaimable` : r.title;
  return el('div', { class: 'row', onclick: () => runRecOpen(r), style: r.severity === 'high' ? 'border-color:var(--danger-soft)' : '' }, [
    el('div', { class: 'r-icon', style: (!proj && r.severity === 'high') ? 'color:var(--danger)' : '' }, [proj ? projectImage(proj) : icon(iconFor(r.icon))]),
    el('div', { class: 'r-main' }, [el('div', { class: 'r-title', text: title }), el('div', { class: 'r-desc', style: 'white-space:normal', text: r.body })]),
    el('span', { class: 'icon icon-sm r-chev', html: ICONS['arrow-right'] || '' }),
  ]);
}
function runRecOpen(r) {
  if (!r) return;
  if (r.kind === 'project' && r.action && r.action.path) {
    const p = state.projects.find((x) => x.path === r.action.path);
    if (p) { openProject(p); return; }
  }
  state.activeRec = r; go('rec');
}
function viewRecDetail(v) {
  const r = state.activeRec;
  if (!r) { go('recommendations'); return; }
  v.appendChild(el('div', { style: 'margin-bottom:18px' }, [el('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('recommendations') }, [icon('arrow-left', 'icon-sm'), 'Recommendations'])]));
  v.appendChild(el('div', { class: 'detail-hero' }, [
    el('div', { class: 'detail-ic', style: r.severity === 'high' ? 'color:var(--danger)' : '' }, [icon('sparkles')]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { class: 'detail-name' }, [el('span', { class: 'd-name', text: r.title }), r.severity === 'high' ? el('span', { class: 'badge warn', text: 'high impact' }) : el('span', { class: 'badge accent', text: 'suggested' })]),
      el('div', { class: 'detail-path', style: 'white-space:normal', text: r.body }),
    ]),
    el('div', { class: 'r-size big', text: fmt(r.savings || 0) }),
  ]));
  const t = (r.action && r.action.id) ? state.system.find((x) => x.id === r.action.id) : null;
  if (t) {
    v.appendChild(el('div', { class: 'card', style: 'margin-top:8px;display:flex;align-items:center;gap:14px' }, [
      el('div', { class: 'r-icon' }, [icon(iconFor(t.icon))]),
      el('div', { style: 'flex:1' }, [el('div', { style: 'font-weight:700', text: t.name }), el('div', { class: 'page-sub', style: 'margin-top:2px', text: t.description })]),
      el('div', { class: 'r-size big', text: fmt(t.size) }),
    ]));
    v.appendChild(el('div', { class: 'card', style: 'margin-top:16px' }, [
      el('div', { class: 'section-title', style: 'margin:0 0 8px', text: 'Why this is recommended' }),
      el('div', { class: 'page-sub', style: 'margin:0', text: `This cache is ${fmt(t.size)} and fully regenerable, so clearing it is reversible and safe.` }),
    ]));
    v.appendChild(el('div', { style: 'display:flex;gap:12px;margin-top:18px' }, [
      el('button', { class: 'btn btn-danger', onclick: () => confirmClean(t.existingPaths.map((p) => ({ path: p, mode: t.mode })), 'system', { label: t.name }) }, [icon('trash', 'icon-sm'), `Clean ${fmt(t.size)}`]),
      el('button', { class: 'btn', onclick: () => { go('system'); state.selSystem.add(t.id); setTimeout(renderSystem, 60); } }, [icon('broom', 'icon-sm'), 'Open in System Cleaner']),
    ]));
  } else {
    v.appendChild(el('div', { class: 'card', style: 'margin-top:8px' }, [el('div', { class: 'page-sub', style: 'margin:0', text: 'Run a fresh scan to refresh this recommendation.' })]));
  }
}

// ============================================================ LARGE FILES
function viewLargeFiles(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'Large Files' }), el('div', { class: 'page-sub', text: 'Find big files hogging space. Deleting here is permanent and not reversible, so review carefully.' })]),
    el('div', { style: 'display:flex;gap:10px;align-items:center' }, [
      largeMinSelect(),
      el('button', { class: 'btn', onclick: pickLargeRoot }, [icon('folder-open', 'icon-sm'), 'Folder']),
      el('button', { class: 'btn btn-primary', onclick: () => scanLargeFiles() }, [icon('scan', 'icon-sm'), 'Scan']),
    ]),
  ]));
  v.appendChild(el('div', { id: 'lfHost' }));
  renderLargeFiles();
}
function largeMinSelect() {
  const opts = [[100 * 1024 * 1024, '≥ 100 MB'], [500 * 1024 * 1024, '≥ 500 MB'], [1024 * 1024 * 1024, '≥ 1 GB']];
  return el('select', { class: 'mini-select', onchange: (e) => { state.largeMin = Number(e.target.value); } }, opts.map(([val, l]) => el('option', { value: String(val), selected: state.largeMin === val ? 'selected' : null }, [l])));
}
async function pickLargeRoot() { const d = await api.pickFolder(); if (d) scanLargeFiles(d); }
async function scanLargeFiles(root) {
  root = root || state.prefs.scanRoots?.[0] || state.home;
  state.scan.largefiles = true; state.largeSel.clear(); renderLargeFiles();
  const unsub = api.onLargeFilesProgress((p) => updateScanProgress(p));
  const res = await api.scanLargeFiles(root, state.largeMin); unsub();
  state.scan.largefiles = false;
  state.largeFiles = (res && res.files) || [];
  renderLargeFiles();
}
function fileKind(ext) {
  if (['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm'].includes(ext)) return 'play';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg', '.psd'].includes(ext)) return 'image';
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return 'flash';
  if (['.zip', '.tar', '.gz', '.rar', '.7z', '.dmg', '.pkg'].includes(ext)) return 'box';
  if (['.pdf', '.doc', '.docx', '.csv', '.xlsx', '.txt'].includes(ext)) return 'document';
  return 'file';
}
function renderLargeFiles() {
  const host = $('#lfHost'); if (!host) return; host.innerHTML = '';
  if (state.scan.largefiles) { host.appendChild(scanningBar('Scanning for large files…', { scope: 'largefiles' })); return; }
  if (!state.largeFiles.length) { host.appendChild(emptyState('hard-drive', 'No large files found yet', 'Pick a folder and a size threshold above, then scan to surface the biggest files on disk.', 'Scan ' + (state.prefs.scanRoots?.[0]?.split('/').pop() || 'home'), () => scanLargeFiles())); return; }
  const list = el('div', { class: 'list' });
  state.largeFiles.forEach((f) => list.appendChild(largeFileRow(f)));
  host.appendChild(list);
  host.appendChild(el('div', { id: 'lfActionBar' }));
  renderLargeActionBar();
}
function largeFileRow(f) {
  const sel = state.largeSel.has(f.path);
  return el('div', { class: 'row' + (sel ? ' selected' : ''), onclick: () => { sel ? state.largeSel.delete(f.path) : state.largeSel.add(f.path); renderLargeFiles(); } }, [
    el('div', { class: 'check' + (sel ? ' on' : '') }, [checkMark('icon-sm')]),
    el('div', { class: 'r-icon' }, [icon(fileKind(f.ext))]),
    el('div', { class: 'r-main' }, [el('div', { class: 'r-title' }, [el('span', { class: 'r-name', text: f.path.split('/').pop() })]), el('div', { class: 'r-desc', text: f.path })]),
    el('button', { class: 'btn btn-ghost btn-icon btn-sm', title: 'Reveal', onclick: (e) => { e.stopPropagation(); api.reveal(f.path); } }, [icon('external-link', 'icon-sm')]),
    el('div', { class: 'r-size big', text: fmt(f.size) }),
  ]);
}
function renderLargeActionBar() {
  const bar = $('#lfActionBar'); if (!bar) return; bar.innerHTML = '';
  const sel = state.largeFiles.filter((f) => state.largeSel.has(f.path)); if (!sel.length) return;
  const total = sel.reduce((s, f) => s + f.size, 0);
  bar.appendChild(el('div', { class: 'action-wrap' }, [el('div', { class: 'action-bar' }, [
    el('div', { class: 'ab-sum', html: `${sel.length} file(s) · <span>${fmt(total)}</span>` }), el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-ghost', onclick: () => { state.largeSel.clear(); renderLargeFiles(); } }, ['Clear']),
    el('button', { class: 'btn btn-danger', onclick: () => confirmClean(sel.map((f) => ({ path: f.path })), 'largefiles', { reversible: false, label: `${sel.length} large file(s)` }) }, [icon('trash', 'icon-sm'), `Delete ${fmt(total)}`]),
  ])]));
}

// ============================================================ HISTORY
function viewHistory(v) {
  v.appendChild(el('div', { class: 'page-head' }, [
    el('div', {}, [el('div', { class: 'page-title', text: 'History' }), el('div', { class: 'page-sub', text: 'A log of everything Spaci has cleaned and freed.' })]),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => { await api.historyClear(); state.history = []; go('history'); } }, [icon('trash', 'icon-sm'), 'Clear log']),
  ]));
  const host = el('div', { id: 'histHost' }); v.appendChild(host);
  host.appendChild(el('div', { class: 'empty', style: 'padding:48px;display:flex;justify-content:center' }, [loader(32)]));
  api.historyGet().then((h) => { if (state.route !== 'history') return; state.history = h || []; renderHistory(host); });
}
function renderHistory(host) {
  host.innerHTML = '';
  if (state.ops.length) {
    host.appendChild(el('div', { class: 'section-title', style: 'margin-top:0', text: 'Ongoing' }));
    const ol = el('div', { class: 'list' });
    state.ops.forEach((op) => ol.appendChild(opRow(op)));
    host.appendChild(ol);
  }
  if (!state.history.length && !state.ops.length) { host.appendChild(emptyState('log', 'Nothing cleaned yet', 'Once you clean project artifacts, caches, or large files, a log of what was freed shows up here.')); return; }
  if (state.history.length) {
    host.appendChild(el('div', { class: 'section-title', text: state.ops.length ? 'Completed' : 'History' }));
    const list = el('div', { class: 'list' });
    state.history.forEach((h) => list.appendChild(historyRow(h)));
    host.appendChild(list);
  }
}
function opRow(op) {
  const pct = op.total ? Math.round((op.done / op.total) * 100) : 0;
  const title = op.label.charAt(0).toUpperCase() + op.label.slice(1);
  return el('div', { class: 'row', style: 'cursor:default' }, [
    el('div', { class: 'r-icon' }, [op.status === 'running' ? loader(24) : icon(op.status === 'error' ? 'warning' : 'check-circle')]),
    el('div', { class: 'r-main' }, [
      el('div', { class: 'r-title' }, [title, op.status === 'running' ? el('span', { class: 'badge accent', text: 'cleaning' }) : op.status === 'error' ? el('span', { class: 'badge warn', text: 'error' }) : el('span', { class: 'badge safe', text: 'done' })]),
      el('div', { class: 'bar', style: 'margin-top:9px;max-width:340px' }, [el('span', { id: 'opbar-' + op.id, style: 'width:' + pct + '%' })]),
    ]),
    el('div', { class: 'r-size big', id: 'opfreed-' + op.id, text: fmt(op.freed) + ' freed' }),
  ]);
}
function niceDate(ms) { try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function histScopeIcon(h) { return h.scope === 'largefiles' ? 'trash' : h.scope === 'system' ? 'broom' : 'folder'; }
function histScopeName(h) { return h.label || (h.scope === 'system' ? 'System caches' : h.scope === 'largefiles' ? 'Large files' : 'Project artifacts'); }
function historyRow(h) {
  return el('div', { class: 'row', onclick: () => { state.activeHist = h; go('histdetail'); } }, [
    el('div', { class: 'r-icon' }, [icon(histScopeIcon(h))]),
    el('div', { class: 'r-main' }, [
      el('div', { class: 'r-title' }, [histScopeName(h), h.reversible ? el('span', { class: 'badge safe', text: 'reversible' }) : el('span', { class: 'badge warn', text: 'permanent' })]),
      el('div', { class: 'r-desc', text: `${h.count} item(s) · ${niceDate(h.at)}` }),
    ]),
    el('div', { class: 'r-size big', text: fmt(h.freed) }),
    h.reversible ? icon('undo', 'hist-reverse') : icon('lock', 'hist-reverse'),
    el('span', { class: 'icon icon-sm r-chev', html: ICONS['arrow-right'] || '' }),
  ]);
}
function viewHistoryDetail(v) {
  const h = state.activeHist;
  if (!h) { go('history'); return; }
  v.appendChild(el('div', { style: 'margin-bottom:18px' }, [el('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('history') }, [icon('arrow-left', 'icon-sm'), 'History'])]));
  v.appendChild(el('div', { class: 'detail-hero' }, [
    el('div', { class: 'detail-ic' }, [icon(histScopeIcon(h))]),
    el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { class: 'detail-name' }, [el('span', { class: 'd-name', text: histScopeName(h) }), h.reversible ? el('span', { class: 'badge safe', text: 'reversible' }) : el('span', { class: 'badge warn', text: 'permanent' })]),
      el('div', { class: 'detail-path', text: niceDate(h.at) }),
    ]),
    el('div', { class: 'r-size big', text: fmt(h.freed) }),
  ]));
  v.appendChild(el('div', { class: 'grid grid-3 detail-stats', style: 'margin-bottom:16px' }, [
    statBig('hard-drive', 'Space freed', el('span', { text: fmt(h.freed) }), true),
    statBig('box', 'Items', el('span', { text: String(h.count) })),
    statBig('clock', 'When', el('span', { text: niceDate(h.at) })),
  ]));
  const restore = h.reversible
    ? (h.scope === 'system'
      ? 'These caches regenerate automatically the next time the apps run. Nothing to do.'
      : 'These are build artifacts and dependencies, so the action is reversible. Restore them by re-running your install or build (for example npm install, pod install, or your usual build command).')
    : 'This was a permanent deletion of files and cannot be undone.';
  v.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'section-title', style: 'margin:0 0 10px;display:flex;align-items:center;gap:8px' }, [icon(h.reversible ? 'undo' : 'lock', 'icon-sm'), h.reversible ? 'How to restore' : 'Permanent deletion']),
    el('div', { class: 'page-sub', style: 'margin:0', text: restore }),
  ]));
  if (h.items && h.items.length) {
    v.appendChild(el('div', { class: 'section-title', text: `Cleaned (${h.count > h.items.length ? h.items.length + ' of ' + h.count : h.items.length})` }));
    const list = el('div', { class: 'list' });
    h.items.slice(0, 100).forEach((p) => list.appendChild(el('div', { class: 'row', style: 'cursor:default;padding:11px 14px' }, [
      el('div', { class: 'r-icon' }, [icon(h.scope === 'largefiles' ? 'file' : 'folder')]),
      el('div', { class: 'r-main' }, [el('div', { class: 'r-desc mono', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left', text: p })]),
    ])));
    v.appendChild(list);
  }
}

// ============================================================ SETTINGS
function viewSettings(v) {
  v.appendChild(el('div', { class: 'page-head' }, [el('div', {}, [el('div', { class: 'page-title', text: 'Settings' }), el('div', { class: 'page-sub', text: 'Preferences & safety.' })])]));
  const card = el('div', { class: 'card' });
  card.appendChild(settingRow('Scan folder', state.prefs.scanRoots?.[0] || state.home, el('button', { class: 'btn btn-sm', onclick: async () => { const d = await api.pickFolder(); if (d) { state.prefs = await api.setPrefs({ scanRoots: [d] }); go('settings'); } } }, [icon('folder-open', 'icon-sm'), 'Change'])));
  card.appendChild(toggleRow('Confirm before cleaning', 'Always preview what will be deleted.', 'confirmBeforeClean'));
  const themeTog = el('div', { class: 'toggle' + (state.prefs.theme === 'light' ? ' on' : '') });
  themeTog.addEventListener('click', async () => { themeTog.classList.toggle('on'); await toggleTheme(); });
  card.appendChild(settingRow('Light mode', 'Switch between dark and light appearance.', themeTog));
  const staleVal = el('b', { text: state.prefs.staleDays + ' days', style: 'color:var(--accent)' });
  card.appendChild(settingRow('Flag projects stale after', '', el('div', { style: 'display:flex;align-items:center;gap:12px' }, [staleVal, el('input', { type: 'range', min: '14', max: '180', value: state.prefs.staleDays, style: 'accent-color:var(--accent)', oninput: (e) => staleVal.textContent = e.target.value + ' days', onchange: async (e) => { state.prefs = await api.setPrefs({ staleDays: Number(e.target.value) }); } })])));
  card.appendChild(toggleRow('Background scans', 'Rescan periodically in the menu bar, even when the window is closed.', 'backgroundScans'));
  const intSel = el('select', { class: 'mini-select', onchange: async (e) => { state.prefs = await api.setPrefs({ scanIntervalHours: Number(e.target.value) }); } },
    [1, 3, 6, 12, 24].map((hh) => el('option', { value: String(hh), selected: state.prefs.scanIntervalHours === hh ? 'selected' : null }, [hh === 1 ? 'Every hour' : `Every ${hh} hours`])));
  card.appendChild(settingRow('Scan interval', '', intSel));
  v.appendChild(card);
  v.appendChild(el('div', { class: 'section-title', text: 'About' }));
  v.appendChild(el('div', { class: 'card', style: 'display:flex;align-items:center;gap:14px;cursor:pointer', onclick: () => go('about') }, [
    el('div', { class: 'brand-logo', style: 'width:42px;height:42px' }, [spaciMark('spin')]),
    el('div', { style: 'flex:1' }, [el('div', { style: 'font-weight:700;font-size:15px', text: 'Spaci' }), el('div', { class: 'page-sub', style: 'margin-top:2px', text: 'Built by kentom.co.ke' })]),
    el('span', { class: 'icon icon-sm r-chev', html: ICONS['arrow-right'] || '' }),
  ]));
}
// ============================================================ ABOUT
function viewAbout(v) {
  v.appendChild(el('div', { style: 'margin-bottom:14px' }, [el('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('settings') }, [icon('arrow-left', 'icon-sm'), 'Settings'])]));
  v.appendChild(el('div', { style: 'text-align:center;padding:18px 0 8px' }, [
    el('div', { class: 'brand-logo', style: 'width:84px;height:84px;margin:0 auto 18px' }, [spaciMark('breathe')]),
    el('div', { style: 'font-size:32px;font-weight:800;letter-spacing:-1px' }, [el('span', { text: 'Spaci' }), el('b', { style: 'color:var(--accent-fg)', text: '.' })]),
    el('div', { class: 'page-sub', style: 'margin:8px auto 0;max-width:460px', text: 'A developer and Mac cleaner. Reclaim the gigabytes hiding in build artifacts and regenerable caches, safely, with a preview every time.' }),
    (() => { const vEl = el('div', { style: 'margin-top:12px;font-size:12.5px;color:var(--text-3)', text: 'Version 1.2.0' }); api.appVersion().then((ver) => { if (ver) vEl.textContent = 'Version ' + ver; }).catch(() => {}); return vEl; })(),
  ]));
  v.appendChild(updateCard());
  v.appendChild(el('div', { class: 'card', style: 'margin-top:18px;display:flex;align-items:center;gap:14px' }, [
    el('div', { class: 'r-icon' }, [icon('heart')]),
    el('div', { style: 'flex:1' }, [el('div', { style: 'font-weight:700', text: 'Built by kentom.co.ke' }), el('div', { class: 'page-sub', style: 'margin-top:2px', text: 'Steve Tom, Nairobi' })]),
    el('button', { class: 'btn btn-sm', onclick: () => api.openExternal('https://kentom.co.ke') }, [icon('external-link', 'icon-sm'), 'Visit']),
  ]));
  const linkRow = (ic, label, sub, href) => el('div', { class: 'row', onclick: () => api.openExternal(href) }, [
    el('div', { class: 'r-icon' }, [icon(ic)]),
    el('div', { class: 'r-main' }, [el('div', { class: 'r-title', text: label }), el('div', { class: 'r-desc', style: 'direction:ltr', text: sub })]),
    el('span', { class: 'icon icon-sm r-chev', html: ICONS['arrow-right'] || '' }),
  ]);
  v.appendChild(el('div', { class: 'section-title', text: 'Links' }));
  v.appendChild(el('div', { class: 'list' }, [
    linkRow('folder-cloud', 'Spaci website', 'spaci.kentom.co.ke', 'https://spaci.kentom.co.ke'),
    linkRow('github', 'kentom.co.ke', 'Portfolio and more work', 'https://kentom.co.ke'),
  ]));
  v.appendChild(el('div', { style: 'margin-top:18px;display:flex;gap:12px' }, [
    el('button', { class: 'btn', onclick: () => showOnboarding(true) }, [icon('info', 'icon-sm'), 'Replay intro']),
  ]));
  v.appendChild(el('div', { style: 'text-align:center;color:var(--text-4);font-size:12px;margin-top:30px', text: '© kentom.co.ke · MIT licensed' }));
}

// Auto-update card on the About page. Talks to the electron-updater feed via IPC.
function updateCard() {
  const statusEl = el('div', { class: 'page-sub', style: 'margin-top:2px', text: 'You are up to date.' });
  const titleEl = el('div', { style: 'font-weight:700', text: 'Updates' });
  const actions = el('div', { style: 'display:flex;gap:8px;align-items:center' });

  const checkBtn = el('button', { class: 'btn btn-sm', onclick: () => { api.checkUpdate(); render({ state: 'checking' }); } }, [icon('undo', 'icon-sm'), 'Check for updates']);
  const installBtn = el('button', { class: 'btn btn-sm btn-primary', style: 'display:none', onclick: () => api.installUpdate() }, [icon('arrow-right', 'icon-sm'), 'Restart to update']);
  actions.append(checkBtn, installBtn);

  function render(s) {
    s = s || {};
    installBtn.style.display = 'none';
    checkBtn.disabled = false;
    switch (s.state) {
      case 'checking': statusEl.textContent = 'Checking for updates…'; checkBtn.disabled = true; break;
      case 'available': statusEl.textContent = 'Update ' + (s.version || '') + ' found, downloading…'; checkBtn.disabled = true; break;
      case 'downloading': statusEl.textContent = 'Downloading update… ' + (s.percent != null ? s.percent + '%' : ''); checkBtn.disabled = true; break;
      case 'ready': statusEl.textContent = 'Update ' + (s.version || '') + ' ready to install.'; installBtn.style.display = ''; break;
      case 'current': statusEl.textContent = 'You are on the latest version.'; break;
      case 'dev': statusEl.textContent = 'Updates are checked in installed builds only.'; checkBtn.disabled = true; break;
      case 'error': statusEl.textContent = 'Could not check for updates right now.'; break;
      default: statusEl.textContent = 'You are up to date.';
    }
  }

  api.updateStatus().then(render).catch(() => {});
  api.onUpdateStatus(render);

  return el('div', { class: 'card', style: 'margin-top:12px;display:flex;align-items:center;gap:14px' }, [
    el('div', { class: 'r-icon' }, [icon('sparkles')]),
    el('div', { style: 'flex:1' }, [titleEl, statusEl]),
    actions,
  ]);
}

function settingRow(label, desc, control) { return el('div', { class: 'setting-row' }, [el('div', {}, [el('div', { class: 's-label', text: label }), desc ? el('div', { class: 's-desc mono', text: desc }) : null]), control]); }
function toggleRow(label, desc, key) {
  const on = !!state.prefs[key];
  const tog = el('div', { class: 'toggle' + (on ? ' on' : '') });
  tog.addEventListener('click', async () => { const next = !tog.classList.contains('on'); tog.classList.toggle('on', next); state.prefs = await api.setPrefs({ [key]: next }); });
  return settingRow(label, desc, tog);
}

// ---------- shared bits ----------
function scanningBar(label, opts = {}) {
  const kids = [
    el('div', { class: 'pulse-ring' }, [el('span'), el('span'), el('span'), el('div', { class: 'pulse-core' }, [spaciMark('orbit', 'pulse-mark')])]),
    el('div', { class: 'scan-title', text: label }),
  ];
  if (opts.stats !== false) {
    kids.push(el('div', { class: 'scan-stats' }, [
      el('span', {}, [el('b', { id: 'scanFound', text: '0' }), ' found']),
      el('span', { class: 'dot', text: '·' }),
      el('span', {}, [el('b', { id: 'scanDirs', text: '0' }), ' scanned']),
    ]));
  }
  kids.push(el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:22px', onclick: () => api.cancelScan(opts.scope) }, [icon('close', 'icon-sm'), 'Cancel']));
  return el('div', { class: 'scan-state' }, kids);
}
let _scanPathT = 0, _scanPathLast = '';
// Show just the last couple of path segments so the line stays short and stable.
function shortenPath(p) { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length <= 2 ? parts.join('/') : '…/' + parts.slice(-2).join('/'); }
function updateScanProgress(p) {
  const f = $('#scanFound'), d = $('#scanDirs'), pa = $('#scanPath');
  if (f && p.found != null) f.textContent = String(p.found);
  if (d && p.scanned != null) d.textContent = Number(p.scanned).toLocaleString();
  const text = p.currentPath ? shortenPath(p.currentPath) : (p.current || null);
  if (pa && text && text !== _scanPathLast) {
    const now = (window.performance && performance.now()) || Date.now();
    // Update at most ~2x/sec (immediately for the slower system-target scan).
    if (now - _scanPathT > 450 || p.current) {
      _scanPathT = now; _scanPathLast = text;
      pa.textContent = text;
      pa.classList.remove('scan-flash'); void pa.offsetWidth; pa.classList.add('scan-flash');
    }
  }
}
function emptyState(ic, title, body, btn, onClick) { return el('div', { class: 'empty' }, [el('div', { class: 'e-ic' }, [icon(ic)]), el('h3', { text: title }), el('p', { text: body }), btn ? el('button', { class: 'btn btn-primary', onclick: onClick }, [icon('scan', 'icon-sm'), btn]) : null]); }

// ============================================================ CLEAN FLOW
function confirmClean(jobs, scope, opts = {}) {
  if (!jobs.length) return;
  const reversible = opts.reversible !== false;
  if (!state.prefs.confirmBeforeClean) return doClean(jobs, scope, opts);
  const body = el('div', {});
  body.appendChild(el('p', { class: 'page-sub', style: 'margin:0 0 14px', text: reversible
    ? `${jobs.length} location(s) will be removed. Safe and reversible: regenerable artifacts and caches rebuild on next use.`
    : `${jobs.length} item(s) will be permanently deleted. This is NOT reversible and cannot be undone.` }));
  if (!reversible) body.appendChild(el('div', { class: 'warn-banner' }, [icon('warning', 'icon-sm'), 'Permanent deletion, make sure you no longer need these files.']));
  const wrap = el('div', { style: 'max-height:280px;overflow-y:auto;margin-top:12px' });
  jobs.slice(0, 200).forEach((j) => wrap.appendChild(el('div', { class: 'preview-item' }, [el('span', { class: 'pi-path mono', text: j.path }), el('span', { class: 'pi-tag', text: j.mode === 'contents' ? 'empty' : 'delete' })])));
  if (jobs.length > 200) wrap.appendChild(el('div', { class: 'page-sub', text: `…and ${jobs.length - 200} more` }));
  body.appendChild(wrap);
  openModal({ icon: reversible ? 'broom' : 'warning', title: reversible ? 'Confirm cleanup' : 'Permanent delete', body, foot: [el('button', { class: 'btn', onclick: closeModal }, ['Cancel']), el('span', { class: 'spacer' }), el('button', { class: 'btn btn-danger', onclick: () => { closeModal(); doClean(jobs, scope, opts); } }, [icon('trash', 'icon-sm'), reversible ? 'Delete & free space' : 'Delete permanently'])] });
}
// Non-blocking cleanup: tracked as an "operation" shown in the top bar + History.
let _activeOp = null, _opId = 0;
function showTopBar(text) {
  const t = $('#topbar'); if (!t) return;
  if (text) { t.innerHTML = ''; t.appendChild(el('div', { class: 'pill' }, [loader(16), text])); t.classList.add('active'); }
  else t.classList.remove('active');
}
function updateActivity() {
  const running = state.ops.filter((o) => o.status === 'running');
  showTopBar(running.length ? 'Cleaning ' + running[0].label + (running.length > 1 ? ' +' + (running.length - 1) : '') + ' · ' + fmt(running.reduce((s, o) => s + o.freed, 0)) + ' freed' : null);
  showBgOrbit(state.bgScanning);
  renderSidebar();
}
function showBgOrbit(on) {
  const b = $('#bgorbit'); if (!b) return;
  if (on) {
    if (!b.dataset.built) { b.innerHTML = ''; b.appendChild(spaciMark('orbit')); b.appendChild(el('span', { class: 'lbl', text: 'Scanning' })); b.dataset.built = '1'; }
    b.classList.add('active');
  } else b.classList.remove('active');
}
async function doClean(jobs, scope, opts = {}) {
  if (!jobs.length) return;
  const label = opts.label || (scope === 'system' ? 'system caches' : scope === 'largefiles' ? 'large files' : 'project artifacts');
  const op = { id: ++_opId, label, scope, total: jobs.length, done: 0, freed: 0, status: 'running', at: Date.now() };
  state.ops.unshift(op); _activeOp = op; updateActivity();
  if (state.route === 'history') go('history');
  const res = await api.clean(jobs, { scope, reversible: opts.reversible !== false, label });
  if (res.ok) {
    op.status = 'done'; op.done = op.total; op.freed = res.totalFreed;
    toast('check-circle', `Freed ${fmt(res.totalFreed)}`, `${label} cleaned`);
    if (scope === 'system') { state.selSystem.clear(); await scanSystem(true); if (state.route === 'system') renderSystem(); }
    else if (scope === 'largefiles') { const del = new Set(jobs.map((j) => j.path)); state.largeFiles = state.largeFiles.filter((f) => !del.has(f.path)); state.largeSel.clear(); if (state.route === 'largefiles') renderLargeFiles(); }
    else {
      // Optimistic, immediate update: drop the cleaned items from their projects in place.
      const cleaned = new Set(jobs.map((j) => j.path));
      for (const proj of state.projects) {
        const removed = proj.items.filter((i) => cleaned.has(i.path));
        if (!removed.length) continue;
        const removedSize = removed.reduce((s, i) => s + i.size, 0);
        proj.items = proj.items.filter((i) => !cleaned.has(i.path));
        proj.cleanableSize = proj.items.reduce((s, i) => s + i.size, 0);
        if (proj._enrich) proj._enrich = { ...proj._enrich, totalSize: Math.max(0, (proj._enrich.totalSize || 0) - removedSize) };
      }
      state.projects = state.projects.filter((p) => p.items.length);
      state.selItems.clear();
      if (state.route === 'project') { (!state.activeProject || !state.activeProject.items.length) ? go('projects') : go('project'); }
      else if (state.route === 'projects') renderProjects();
    }
    await refreshDisk(); await computeRecs();
    try { state.history = await api.historyGet(); } catch (_) { /* */ }
  } else { op.status = 'error'; toast('warning', 'Finished with errors', res.error || 'Some items could not be removed', true); }
  _activeOp = state.ops.find((o) => o.status === 'running') || null;
  updateActivity();
  if (state.route === 'history') go('history');
  else if (state.route === 'dashboard') go('dashboard');
  setTimeout(() => { state.ops = state.ops.filter((o) => o !== op); updateActivity(); if (state.route === 'history') go('history'); }, 6000);
}
function updateCleanProgress(p) {
  if (!_activeOp) return;
  if (p.done != null) _activeOp.done = p.done;
  if (p.totalFreed != null) _activeOp.freed = p.totalFreed;
  updateActivity();
  const bar = $('#opbar-' + _activeOp.id); if (bar) bar.style.width = (_activeOp.total ? Math.round((_activeOp.done / _activeOp.total) * 100) : 0) + '%';
  const fr = $('#opfreed-' + _activeOp.id); if (fr) fr.textContent = fmt(_activeOp.freed) + ' freed';
}

// ============================================================ MODAL / TOAST
function openModal({ icon: ic, title, body, foot, noClose }) {
  const m = $('#modal'); m.innerHTML = '';
  m.appendChild(el('div', { class: 'modal-card' }, [
    el('div', { class: 'modal-head' }, [el('div', { class: 'm-ic' }, [icon(ic || 'info')]), el('h2', { text: title }), el('div', { class: 'spacer' }), noClose ? null : el('button', { class: 'btn btn-ghost btn-icon btn-sm', onclick: closeModal }, [icon('close', 'icon-sm')])]),
    el('div', { class: 'modal-body' }, [body]),
    foot && foot.length ? el('div', { class: 'modal-foot' }, foot) : null,
  ]));
  m.classList.remove('hidden');
  if (!noClose) m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { const m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; }
function toast(ic, title, sub, err) {
  const t = el('div', { class: 'toast' + (err ? ' err' : '') }, [el('div', { class: 't-ic' }, [icon(ic, 'icon-sm')]), el('div', {}, [el('b', { text: title }), sub ? el('small', { text: sub }) : null])]);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateX(24px)'; setTimeout(() => t.remove(), 320); }, 4400);
}

// ============================================================ ONBOARDING (imported design language)
const onb = { step: 1, scanChoice: 'home', targets: { projects: true, devcaches: true, system: true } };
const ONB_TOTAL = 4;
function showOnboarding(replay) { onb.step = 1; if (replay) onb.replay = true; renderOnb(); }
function closeOnb() { $('#onboarding').innerHTML = ''; }
async function finishOnb(scan) { state.prefs = await api.setPrefs({ onboarded: true }); closeOnb(); go('dashboard'); if (scan) scanEverything(); }

function renderOnb() {
  const root = $('#onboarding'); root.innerHTML = '';
  const s = onb.step;
  const dots = (s > 1) ? el('div', { class: 'onb-dots' }, [
    ...[2,3,4].map((n) => el('i', { class: n <= s ? 'on' : '' })),
    el('span', { class: 'lbl', text: (s - 1) + ' of ' + (ONB_TOTAL - 1) }),
  ]) : null;

  let step;
  if (s === 1) step = onbWelcome();
  else if (s === 2) step = onbScanLocation();
  else if (s === 3) step = onbTargets();
  else step = onbReady();

  const nav = (s > 1 && s < 4) ? el('div', { class: 'onb-nav' }, [
    el('button', { class: 'btn', onclick: () => { onb.step--; renderOnb(); } }, [icon('arrow-left', 'icon-sm'), 'Back']),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn btn-primary', onclick: () => { onb.step++; renderOnb(); } }, ['Continue', icon('arrow-right', 'icon-sm')]),
  ]) : null;

  const inner = el('div', { class: 'onb-inner' }, [
    el('div', { class: 'onb-brand' }, [el('div', { class: 'brand-logo' }, [spaciMark('breathe')]), el('span', { class: 'brand-name', html: 'Spaci<b>.</b>' })]),
    dots, step, nav,
  ]);
  root.appendChild(el('div', { class: 'onb-root' }, [el('div', { class: 'onb-left' }, [inner])]));
}

function onbWelcome() {
  return el('div', { class: 'onb-step fade-up' }, [
    el('h1', { class: 'onb-h1', html: 'Reclaim your<br/>disk. Effortlessly.' }),
    el('p', { class: 'onb-p', text: 'Spaci finds gigabytes of regenerable build artifacts and caches across your machine, and removes them safely, with a preview every time.' }),
    el('div', { style: 'display:flex;align-items:center;gap:16px' }, [
      el('button', { class: 'btn btn-primary btn-lg', onclick: () => { onb.step = 2; renderOnb(); } }, ['Get started', icon('arrow-right', 'icon-sm')]),
      onb.replay ? el('button', { class: 'btn btn-lg btn-ghost', onclick: () => finishOnb(false) }, ['Skip']) : el('span', { style: 'font-size:13.5px;color:var(--text-4)', html: 'Takes about a minute.' }),
    ]),
  ]);
}
function onbScanLocation() {
  const opt = (id, ic, title, sub) => el('button', { class: 'opt' + (onb.scanChoice === id ? ' sel' : ''), onclick: async () => { if (id === 'choose') { const d = await api.pickFolder(); if (d) { state.prefs = await api.setPrefs({ scanRoots: [d] }); onb.scanChoice = 'choose'; onb.chosen = d; } } else { onb.scanChoice = id; state.prefs = await api.setPrefs({ scanRoots: [state.home] }); } renderOnb(); } }, [
    el('div', { class: 'opt-ic' }, [icon(ic)]),
    el('div', { class: 'opt-main' }, [el('div', { class: 'opt-title', text: title }), el('div', { class: 'opt-sub', text: sub })]),
    onb.scanChoice === id ? el('div', { class: 'check on' }, [checkMark('icon-sm')]) : null,
  ]);
  return el('div', { class: 'onb-step slide-in' }, [
    el('h2', { class: 'onb-h2', text: 'Where should we look?' }),
    el('p', { class: 'onb-p', text: 'Spaci scans this folder for projects with reclaimable artifacts. You can change it any time.' }),
    el('div', { class: 'onb-opts' }, [
      opt('home', 'home', 'My home folder', 'Recommended: covers all your projects (' + state.home.split('/').pop() + ').'),
      opt('choose', 'folder-open', onb.chosen ? 'Custom: ' + onb.chosen.split('/').pop() : 'Choose a specific folder…', 'Point Spaci at one workspace or drive.'),
    ]),
  ]);
}
function onbTargets() {
  const tgl = (id, ic, title, sub) => el('button', { class: 'opt' + (onb.targets[id] ? ' sel' : ''), onclick: () => { onb.targets[id] = !onb.targets[id]; renderOnb(); } }, [
    el('div', { class: 'opt-ic' }, [icon(ic)]),
    el('div', { class: 'opt-main' }, [el('div', { class: 'opt-title', text: title }), el('div', { class: 'opt-sub', text: sub })]),
    el('div', { class: 'check' + (onb.targets[id] ? ' on' : '') }, [checkMark('icon-sm')]),
  ]);
  return el('div', { class: 'onb-step slide-in' }, [
    el('h2', { class: 'onb-h2', text: 'What should we clean?' }),
    el('p', { class: 'onb-p', text: 'Pick what Spaci targets. Everything is regenerable, so your source code is never touched.' }),
    el('div', { class: 'onb-opts' }, [
      tgl('projects', 'folder', 'Project build artifacts', 'node_modules, target, .next, dist, __pycache__ and more.'),
      tgl('devcaches', 'flash', 'Developer caches', 'npm, Gradle, Maven, Cargo, CocoaPods, Xcode DerivedData…'),
      tgl('system', 'broom', 'System caches & Trash', 'App caches, logs, saved state and the Trash.'),
    ]),
  ]);
}
function onbReady() {
  const feat = (ic, title, sub) => el('div', { class: 'onb-sum-row' }, [icon(ic), el('div', { style: 'flex:1' }, [el('div', { class: 'v', text: title }), el('div', { class: 'opt-sub', style: 'margin-top:1px', text: sub })])]);
  return el('div', { class: 'onb-step fade-up' }, [
    el('div', { class: 'onb-done-ic' }, [icon('shield', 'icon-lg')]),
    el('h2', { class: 'onb-h2', text: "You're all set." }),
    el('p', { class: 'onb-p', text: 'Spaci is ready. A quick reminder of how it keeps you safe:' }),
    el('div', { class: 'onb-summary' }, [
      feat('eye', 'Preview first', 'See exactly what will be deleted before anything happens.'),
      feat('check-circle', 'Regenerable only', 'Only caches and build output, never your code or files.'),
      feat('clock', 'Stale detection', 'Old, untouched projects are flagged so you clean with confidence.'),
    ]),
    el('button', { class: 'btn btn-primary btn-lg', style: 'align-self:flex-start', onclick: () => finishOnb(true) }, ['Start scanning', icon('arrow-right', 'icon-sm')]),
  ]);
}
