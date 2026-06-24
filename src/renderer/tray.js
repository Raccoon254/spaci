'use strict';
/* Spaci menu bar widget (the tray popover). A compact v2 panel: brand, live
   disk meter, reclaimable summary with a one-click Smart Scan, and quick
   actions. Uses the same preload `api` as the main window. */

const CAT_COLORS = ['#5e93dd', '#4fcb93', '#e8a14f', '#c77dff', '#e8836f', '#7fb5c9', '#8b867f'];

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
    else if (k === 'hov') {
      const base = attrs.style || '';
      n.addEventListener('mouseenter', () => n.setAttribute('style', base + ';' + v));
      n.addEventListener('mouseleave', () => n.setAttribute('style', base));
    } else n.setAttribute(k, v);
  }
  (children || []).forEach((c) => { if (c == null || c === false) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function ic(name, size, opt) {
  opt = opt || {};
  let s = `width:${size}px;height:${size}px`;
  if (opt.color) s += `;color:${opt.color}`;
  const a = { name, style: s };
  if (opt.anim) a.anim = opt.anim;
  return el('spaci-icon', a);
}
function fmt(b) {
  b = Number(b) || 0;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function normDisk(d) {
  if (!d) return null;
  const total = Number(d.total) || 0;
  const free = Number(d.free != null ? d.free : d.avail != null ? d.avail : 0) || 0;
  const used = Number(d.used != null ? d.used : total - free) || 0;
  return { total, free, used };
}

const state = { disk: null, breakdown: null, recs: [], scanning: false };

function render() {
  const root = document.getElementById('tray');
  root.innerHTML = '';
  const d = state.disk || { total: 0, used: 0, free: 0 };
  const cats = (state.breakdown && state.breakdown.categories) || [];
  const sumCats = cats.reduce((a, c) => a + (Number(c.bytes) || 0), 0) || 1;
  const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
  const reclaim = (state.recs || []).reduce((a, r) => a + (Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0), 0);

  const panel = el('div', { style: 'background:var(--bg);border:1px solid var(--border-2);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.32);height:100%;display:flex;flex-direction:column' }, [
    // header
    el('div', { style: 'display:flex;align-items:center;gap:10px;padding:15px 16px;border-bottom:1px solid var(--border)' }, [
      el('div', { style: 'color:var(--accent-fg)' }, [icRing(state.scanning ? 'spin' : 'breathe', 22)]),
      el('div', { style: 'flex:1;font-size:15px;font-weight:700;letter-spacing:-.4px' }, [el('span', { text: 'Spaci' }), el('span', { style: 'color:var(--accent-fg)', text: '.' })]),
      iconBtn('arrow-right', 'Open Spaci', openMain)
    ]),

    // disk meter
    el('div', { style: 'padding:16px 16px 6px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-2);font-weight:600;margin-bottom:10px' }, [el('span', { text: 'Macintosh HD' }), el('span', { text: fmt(d.free) + ' free' })]),
      el('div', { style: 'height:10px;border-radius:99px;background:var(--track);overflow:hidden;display:flex;gap:2px' },
        cats.map((c, i) => el('span', { style: `height:100%;border-radius:2px;background:${CAT_COLORS[i % CAT_COLORS.length]};flex-basis:${((Number(c.bytes) || 0) / sumCats) * pct}%;flex-grow:0;flex-shrink:0` }))),
      el('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-top:8px' }, [el('span', { text: pct + '% used' }), el('span', { text: fmt(d.total) })])
    ]),

    // reclaimable
    el('div', { style: 'margin:10px 16px;padding:14px 16px;border-radius:13px;background:var(--accent-soft);border:1px solid var(--border)' }, [
      el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px' }, [reclaim ? el('span', {}, [el('span', { style: 'color:var(--accent-fg)', text: fmt(reclaim) }), el('span', { text: ' to reclaim' })]) : el('span', { text: 'Ready to scan' })]),
      el('div', { style: 'color:var(--text-2);font-size:12px;margin-top:2px', text: reclaim ? 'From caches and build artifacts.' : 'Find regenerable files you can clear.' }),
      el('button', {
        style: 'margin-top:12px;width:100%;height:42px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font-family:inherit',
        hov: 'background:var(--accent-hover)',
        onclick: smartScan
      }, [state.scanning ? icRing('spin', 17) : ic('scan', 17), state.scanning ? 'Scanning…' : 'Smart Scan'])
    ]),

    el('div', { style: 'flex:1' }),

    // footer actions
    el('div', { style: 'display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border)' }, [
      footBtn('grid', 'Open Spaci', openMain),
      footBtn('settings', 'Settings', () => openMain('settings')),
      footBtn('close', 'Quit', quitApp)
    ])
  ]);
  root.appendChild(panel);
}

function icRing(anim, size) {
  const e = el('spaci-icon', { name: 'spaci-ring', anim, style: `width:${size}px;height:${size}px` });
  return e;
}
function iconBtn(icon, title, onclick) {
  return el('button', { title, style: 'width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:grid;place-items:center;cursor:pointer', hov: 'background:var(--panel-2);color:var(--text)', onclick }, [ic(icon, 15)]);
}
function footBtn(icon, label, onclick) {
  return el('button', { style: 'flex:1;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;font-weight:600;font-size:12.5px;font-family:inherit', hov: 'background:var(--panel-2);color:var(--text)', onclick }, [ic(icon, 14), label]);
}

async function openMain(route) {
  try { await window.api.openMain(typeof route === 'string' ? route : null); } catch (_) {}
}
async function quitApp() { try { await window.api.quitApp(); } catch (_) {}}
async function smartScan() {
  if (state.scanning) return;
  state.scanning = true; render();
  try { await Promise.allSettled([window.api.scanProjects && window.api.scanProjects(), window.api.scanSystem && window.api.scanSystem()]); } catch (_) {}
  await load();
  state.scanning = false; render();
}

async function load() {
  try { state.disk = normDisk(await window.api.diskUsage()); } catch (_) {}
  try { state.breakdown = await window.api.diskBreakdown(); } catch (_) {}
  try { state.recs = (await window.api.recommendations()) || []; } catch (_) {}
}

async function applyTheme() {
  try {
    const p = await window.api.getPrefs();
    document.getElementById('tray').classList.toggle('light', p && p.theme === 'light');
  } catch (_) {}
}

async function boot() {
  await applyTheme();
  render();
  await load();
  render();
  if (window.api.onBreakdownUpdated) window.api.onBreakdownUpdated((bd) => { state.breakdown = bd; render(); });
}
document.addEventListener('DOMContentLoaded', boot);
