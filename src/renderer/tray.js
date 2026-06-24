'use strict';
/* Spaci menu bar widget. A complete, glanceable, lightly gamified panel:
   brand + disk + Guard, a reclaimable hero with a live classification bar,
   Fast + Deep scan, the storage classification breakdown, an all-time
   reclaimed achievement, and quick actions. Uses the preload `api`. */

const CAT_COLORS = {
  appdata: '#6f9be0', applications: '#d96a8a', downloads: '#e0954f', media: '#8b6bd9',
  developer: '#3b6fd0', caches: '#e6b85c', documents: '#2fb8a8', mail: '#7fb5c9',
  system: '#7a8a99', other: '#8b867f'
};
const PALETTE = ['#6f9be0', '#d96a8a', '#e0954f', '#8b6bd9', '#3b6fd0', '#e6b85c', '#2fb8a8', '#7a8a99'];
const colorFor = (c, i) => CAT_COLORS[c.key] || PALETTE[i % PALETTE.length];

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    if (k === 'style') n.setAttribute('style', v);
    else if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (k === 'hov') { const base = attrs.style || ''; n.addEventListener('mouseenter', () => n.setAttribute('style', base + ';' + v)); n.addEventListener('mouseleave', () => n.setAttribute('style', base)); }
    else n.setAttribute(k, v);
  }
  (children || []).forEach((c) => { if (c == null || c === false) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function ic(name, size, opt) { opt = opt || {}; let s = `width:${size}px;height:${size}px`; if (opt.color) s += `;color:${opt.color}`; const a = { name, style: s }; if (opt.anim) a.anim = opt.anim; return el('spaci-icon', a); }
const ringEl = (anim, size) => el('spaci-icon', { name: 'spaci-ring', anim, style: `width:${size}px;height:${size}px;display:block` });
function fmt(b) { b = Number(b) || 0; if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1) + ' GB'; if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + ' MB'; if (b >= 1024) return Math.round(b / 1024) + ' KB'; return b + ' B'; }
function normDisk(d) { if (!d) return null; const total = Number(d.total) || 0; const free = Number(d.free != null ? d.free : d.avail != null ? d.avail : 0) || 0; const used = Number(d.used != null ? d.used : total - free) || 0; return { total, free, used }; }
function recBytes(r) { return Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0; }

const state = { disk: null, breakdown: null, recs: [], history: [], scanning: false, mode: '' };

function statTile(icon, label, value, accent) {
  return el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:5px' }, [
    el('div', { style: 'display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:11px;font-weight:600' }, [ic(icon, 14, { color: 'var(--accent-fg)' }), label]),
    el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.4px;color:' + (accent || 'var(--text-2)'), text: value })
  ]);
}
function actionRow(icon, label, hint, onclick) {
  return el('div', { style: 'display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:10px;cursor:pointer', hov: 'background:var(--panel)', onclick }, [
    ic(icon, 17, { color: 'var(--text-2)' }), el('span', { style: 'flex:1;font-size:13.5px;font-weight:500', text: label }), el('span', { style: 'color:var(--text-4);font-size:11.5px', text: hint || '' })
  ]);
}

function render() {
  const root = document.getElementById('tray');
  root.innerHTML = '';
  const d = state.disk || { total: 0, used: 0, free: 0 };
  const cats = ((state.breakdown && state.breakdown.categories) || []).filter((c) => c.bytes > 0);
  const sumCats = cats.reduce((a, c) => a + (Number(c.bytes) || 0), 0) || 1;
  const reclaim = (state.recs || []).reduce((a, r) => a + recBytes(r), 0);
  const lifetime = (state.history || []).reduce((a, h) => a + (Number(h.freed) || 0), 0);
  const cacheCat = cats.find((c) => c.key === 'caches');
  const projRecs = (state.recs || []).filter((r) => (r.kind || '') === 'project').length;
  const sc = state.scanning;

  const segs = cats.slice(0, 6).map((c, i) => el('span', { title: c.label, style: `height:100%;border-radius:2px;background:${colorFor(c, i)};flex-basis:${((Number(c.bytes) || 0) / sumCats) * 100}%;flex-grow:0;flex-shrink:0;transform-origin:left;animation:sp-segment .5s cubic-bezier(.22,.61,.36,1) backwards` }));

  const panel = el('div', { style: 'border-radius:18px;border:1px solid var(--border-2);background:linear-gradient(180deg,rgba(1,75,170,.20),transparent 200px),var(--panel-2);overflow:hidden;height:100%;display:flex;flex-direction:column;box-shadow:0 26px 60px rgba(0,0,0,.42)' }, [
    // header
    el('div', { style: 'display:flex;align-items:center;gap:12px;padding:16px 18px 13px' }, [
      el('div', { style: 'color:var(--accent-fg)' }, [ringEl(sc ? 'spin' : 'shimmer', 34)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.3px' }, [el('span', { text: 'Spaci' }), el('span', { style: 'color:var(--accent-fg)', text: '.' })]),
        el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:1px', text: 'Macintosh HD · ' + fmt(d.free) + ' free' })
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:7px;background:var(--success-soft);color:var(--success-fg);font-size:10.5px;font-weight:700' }, [el('span', { style: 'width:6px;height:6px;border-radius:50%;background:var(--success-fg)' }), 'Guard on'])
    ]),

    // reclaimable hero
    el('div', { style: 'padding:7px 18px 16px' }, [
      el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:700', text: sc ? (state.mode === 'deep' ? 'Deep scan running' : 'Fast scan running') : 'Reclaimable now' }),
      el('div', { style: 'display:flex;align-items:flex-end;gap:10px;margin-top:6px' }, [
        el('div', { style: 'font-size:30px;font-weight:700;letter-spacing:-1.4px;line-height:1;color:' + (reclaim ? 'var(--text)' : 'var(--text-3)'), text: sc ? '…' : (reclaim ? fmt(reclaim) : '0 B') }),
        el('div', { style: 'color:var(--text-3);font-size:11.5px;padding-bottom:3px', text: reclaim ? 'across caches and build artifacts' : 'run a scan to find space' })
      ]),
      el('div', { style: 'height:8px;border-radius:99px;background:var(--track);margin-top:13px;overflow:hidden;display:flex;gap:2px' }, sc ? [el('div', { style: 'height:100%;width:36%;border-radius:99px;background:var(--accent);animation:sp-indet 1.2s ease-in-out infinite' })] : segs),
      // scan buttons: Fast + Deep
      el('div', { style: 'display:flex;gap:9px;margin-top:14px' }, [
        el('button', { style: 'flex:1;height:44px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel);color:var(--text);font-weight:700;font-size:13.5px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;font-family:inherit', hov: 'background:var(--panel-3)', onclick: () => doScan('fast') }, [ic('flash', 16, { color: 'var(--accent-fg)' }), 'Fast scan']),
        el('button', { style: 'flex:1.3;height:44px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:13.5px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;font-family:inherit', hov: 'background:var(--accent-hover)', onclick: () => doScan('deep') }, [sc ? ringEl('spin', 16) : ic('scan', 16), 'Deep scan'])
      ])
    ]),

    // classification breakdown
    el('div', { style: 'padding:0 18px 14px' }, [
      el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:700;margin-bottom:10px', text: 'Storage classification' }),
      el('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        cats.slice(0, 5).map((c, i) => el('div', { style: 'display:flex;align-items:center;gap:9px' }, [
          el('span', { style: 'width:9px;height:9px;border-radius:3px;flex:none;background:' + colorFor(c, i) }),
          el('span', { style: 'flex:1;font-size:12.5px;font-weight:600;color:var(--text-2)', text: c.label }),
          el('span', { style: 'font-size:12.5px;color:var(--text-3);font-variant-numeric:tabular-nums', text: fmt(c.bytes) })
        ])))
    ]),

    // quick stats + gamified lifetime
    el('div', { style: 'display:flex;padding:13px 18px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);gap:8px' }, [
      statTile('broom', 'Caches', cacheCat ? fmt(cacheCat.bytes) : '0 B'),
      statTile('folder-2', 'Projects', String(projRecs)),
      statTile('sparkles', 'Reclaimed', lifetime ? fmt(lifetime) : '0 B', 'var(--success-fg)')
    ]),

    el('div', { style: 'flex:1' }),

    // actions
    el('div', { style: 'border-top:1px solid var(--border);padding:7px 8px 9px' }, [
      actionRow('scan', 'Open Smart Scan', '⌘S', () => openMain('dashboard')),
      actionRow('dashboard', 'Open Spaci', '⌘O', () => openMain()),
      actionRow('settings', 'Settings', '', () => openMain('settings')),
      actionRow('close', 'Quit Spaci', '⌘Q', quitApp)
    ])
  ]);
  root.appendChild(panel);
}

async function openMain(route) { try { await window.api.openMain(typeof route === 'string' ? route : null); } catch (_) {} }
async function quitApp() { try { await window.api.quitApp(); } catch (_) {} }
async function doScan(mode) {
  if (state.scanning) return;
  state.scanning = true; state.mode = mode; render();
  try {
    if (mode === 'deep') await Promise.allSettled([window.api.scanProjects && window.api.scanProjects(), window.api.scanSystem && window.api.scanSystem()]);
    else await (window.api.scanSystem && window.api.scanSystem());
  } catch (_) {}
  await load();
  state.scanning = false; render();
}
async function load() {
  try { state.disk = normDisk(await window.api.diskUsage()); } catch (_) {}
  try { state.breakdown = await window.api.diskBreakdown(); } catch (_) {}
  try { const c = (await window.api.cacheGet()) || {}; state.recs = (await window.api.recommendations({ projects: c.projects || [], sysTargets: c.system || [] })) || []; } catch (_) {}
  try { state.history = (await window.api.historyGet()) || []; } catch (_) {}
}
async function applyTheme() { try { const p = await window.api.getPrefs(); document.getElementById('tray').classList.toggle('light', p && p.theme === 'light'); } catch (_) {} }
async function boot() {
  await applyTheme();
  render();
  await load();
  render();
  if (window.api.onBreakdownUpdated) window.api.onBreakdownUpdated((bd) => { state.breakdown = bd; render(); });
}
document.addEventListener('DOMContentLoaded', boot);
