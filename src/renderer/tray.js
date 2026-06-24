'use strict';
/* Spaci menu bar widget (the tray popover). Matches the Spaci v2 design's
   redesigned menu-bar panel: brand + disk free + Guard, a reclaimable block
   with a segmented bar and a one-click clean, quick stats, and quick actions.
   Uses the same preload `api` as the main window. */

const CAT_COLORS = ['#3b6fd0', '#8b6bd9', '#2fb8a8', '#e0954f', '#d96a8a', '#7a8a99'];

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
function recBytes(r) { return Number(r.bytes != null ? r.bytes : r.savings != null ? r.savings : r.size || 0) || 0; }

const state = { disk: null, breakdown: null, recs: [], scanning: false };

function quickStat(icon, label, value) {
  return el('div', { style: 'flex:1;display:flex;flex-direction:column;gap:5px' }, [
    el('div', { style: 'display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:11px;font-weight:600' }, [ic(icon, 14, { color: 'var(--accent-fg)' }), label]),
    el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.4px;color:var(--text-2)', text: value })
  ]);
}
function actionRow(icon, label, hint, onclick) {
  return el('div', { style: 'display:flex;align-items:center;gap:12px;padding:10px 11px;border-radius:10px;cursor:pointer', hov: 'background:var(--panel)', onclick }, [
    ic(icon, 17, { color: 'var(--text-2)' }),
    el('span', { style: 'flex:1;font-size:13.5px;font-weight:500', text: label }),
    el('span', { style: 'color:var(--text-4);font-size:11.5px', text: hint || '' })
  ]);
}

function render() {
  const root = document.getElementById('tray');
  root.innerHTML = '';
  const d = state.disk || { total: 0, used: 0, free: 0 };
  const cats = (state.breakdown && state.breakdown.categories) || [];
  const sumCats = cats.reduce((a, c) => a + (Number(c.bytes) || 0), 0) || 1;
  const reclaim = (state.recs || []).reduce((a, r) => a + recBytes(r), 0);
  const cacheCat = cats.find((c) => /cache/i.test(c.key || '') || /cache/i.test(c.label || ''));
  const projRecs = (state.recs || []).filter((r) => (r.kind || '') === 'project').length || (state.recs || []).length;

  const segs = cats.slice(0, 5).map((c, i) => el('span', { style: `height:100%;border-radius:2px;background:${CAT_COLORS[i % CAT_COLORS.length]};flex-basis:${((Number(c.bytes) || 0) / sumCats) * 100}%;flex-grow:0;flex-shrink:0;transform-origin:left;animation:sp-segment .55s cubic-bezier(.22,.61,.36,1) backwards` }));

  const panel = el('div', { style: 'border-radius:18px;border:1px solid var(--border-2);background:linear-gradient(180deg,rgba(1,75,170,.22),transparent 220px),var(--panel-2);overflow:hidden;height:100%;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.4)' }, [
    // header
    el('div', { style: 'display:flex;align-items:center;gap:12px;padding:16px 18px 14px' }, [
      el('div', { style: 'color:var(--accent-fg)' }, [el('spaci-icon', { name: 'spaci-ring', anim: state.scanning ? 'spin' : 'shimmer', style: 'width:34px;height:34px;display:block' })]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-size:15px;font-weight:700;letter-spacing:-.3px' }, [el('span', { text: 'Spaci' }), el('span', { style: 'color:var(--accent-fg)', text: '.' })]),
        el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:1px', text: 'Macintosh HD · ' + fmt(d.free) + ' free' })
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:7px;background:var(--success-soft);color:var(--success-fg);font-size:10.5px;font-weight:700' }, [el('span', { style: 'width:6px;height:6px;border-radius:50%;background:var(--success-fg)' }), 'Guard on'])
    ]),
    // reclaim block
    el('div', { style: 'padding:8px 18px 18px' }, [
      el('div', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);font-weight:700', text: 'Reclaimable now' }),
      el('div', { style: 'display:flex;align-items:flex-end;gap:10px;margin-top:6px' }, [
        el('div', { style: 'font-size:27px;font-weight:700;letter-spacing:-1px;line-height:1', text: reclaim ? fmt(reclaim) : 'Scan' }),
        el('div', { style: 'color:var(--text-3);font-size:11.5px;padding-bottom:3px', text: 'ready across caches and builds' })
      ]),
      el('div', { style: 'height:7px;border-radius:99px;background:var(--track);margin-top:13px;overflow:hidden;display:flex;gap:2px' }, segs),
      el('button', { style: 'margin-top:14px;width:100%;height:42px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font-family:inherit', hov: 'background:var(--accent-hover)', onclick: smartScan }, [state.scanning ? el('spaci-icon', { name: 'spaci-ring', anim: 'spin', style: 'width:16px;height:16px' }) : ic('flash', 16), state.scanning ? 'Scanning…' : (reclaim ? 'Clean ' + fmt(reclaim) : 'Smart Scan')])
    ]),
    // quick stats
    el('div', { style: 'display:flex;padding:13px 18px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)' }, [
      quickStat('broom', 'Caches', cacheCat ? fmt(cacheCat.bytes) : '0 B'),
      quickStat('folder-2', 'Projects', String(projRecs))
    ]),
    el('div', { style: 'flex:1' }),
    // actions
    el('div', { style: 'border-top:1px solid var(--border);padding:7px 8px' }, [
      actionRow('scan', 'Run Smart Scan', '⌘S', smartScan),
      actionRow('dashboard', 'Open Spaci', '⌘O', () => openMain()),
      actionRow('close', 'Quit Spaci', '', quitApp)
    ])
  ]);
  root.appendChild(panel);
}

async function openMain(route) { try { await window.api.openMain(typeof route === 'string' ? route : null); } catch (_) {} }
async function quitApp() { try { await window.api.quitApp(); } catch (_) {} }
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
  try { const p = await window.api.getPrefs(); document.getElementById('tray').classList.toggle('light', p && p.theme === 'light'); } catch (_) {}
}
async function boot() {
  await applyTheme();
  render();
  await load();
  render();
  if (window.api.onBreakdownUpdated) window.api.onBreakdownUpdated((bd) => { state.breakdown = bd; render(); });
}
document.addEventListener('DOMContentLoaded', boot);
