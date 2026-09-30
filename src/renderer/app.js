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
function toast(a, sub, opts) {
  opts = opts || {};
  const title = typeof a === 'string' ? a : (a && a.title) || '';
  const subt = typeof a === 'string' ? sub : (a && a.sub) || '';
  const host = document.getElementById('app');
  if (!host) return;
  const left = opts.side === 'left';
  const stackId = left ? 'sp-toasts-left' : 'sp-toasts';
  let stack = document.getElementById(stackId);
  if (!stack) {
    stack = el('div', { id: stackId, style: 'position:absolute;bottom:40px;' + (left ? 'left:40px' : 'right:40px') + ';display:flex;flex-direction:column;gap:10px;z-index:90' });
    host.appendChild(stack);
  }
  const t = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:14px;background:var(--panel-2);border:1px solid var(--border-2);box-shadow:var(--shadow-lg);min-width:280px;animation:' + (left ? 'sp-toast-l' : 'sp-toast') + ' .3s cubic-bezier(.22,.61,.36,1)' }, [
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
    const cleaning = S.cleaning;
    h.appendChild(el('div', { style: 'position:absolute;left:248px;right:0;bottom:24px;display:flex;justify-content:center;pointer-events:none;z-index:40' }, [
      el('div', { style: 'display:flex;align-items:center;gap:16px;padding:14px 18px;border-radius:16px;background:var(--panel-2);border:1px solid var(--border-2);min-width:440px;pointer-events:auto;animation:sp-rise .3s cubic-bezier(.22,.61,.36,1)' }, [
        el('div', { style: 'font-weight:700;font-size:14.5px' }, [el('span', { text: ab.count + ' · ' }), el('span', { style: 'color:var(--accent-fg)', text: ab.size })]),
        el('div', { style: 'flex:1' }),
        el('button', { style: 'height:40px;padding:0 16px;border-radius:11px;border:none;background:transparent;color:var(--text-2);font-weight:600;font-size:13.5px;cursor:pointer' + (cleaning ? ';opacity:.45;pointer-events:none' : ''), hov: 'background:var(--panel-3);color:var(--text)', onclick: () => { if (!S.cleaning && ab.onClear) ab.onClear(); } }, ['Clear']),
        el('button', { class: ab.danger ? 'sp-ab-danger' : 'sp-ab-accent', style: 'height:40px;padding:0 18px;border-radius:11px;border:none;color:#fff;font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:' + (cleaning ? 'default;pointer-events:none' : 'pointer'), onclick: () => runClean(ab) }, cleaning ? [ring('elastic', 15), 'Cleaning…'] : [ic('trash', 15), ab.action])
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
        el('div', { style: 'color:var(--text-2);font-size:13.5px;line-height:1.6;margin-bottom:22px;white-space:pre-line', text: cm.body }),
        el('div', { style: 'display:flex;gap:10px;justify-content:flex-end' }, [
          el('button', { style: 'height:42px;padding:0 18px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:14px;cursor:pointer', hov: 'background:var(--panel-3)', onclick: () => close(false) }, ['Cancel']),
          el('button', { class: cm.danger ? 'sp-ab-danger' : 'sp-ab-accent', style: 'height:42px;padding:0 20px;border-radius:11px;border:none;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer', onclick: () => close(true) }, [ic(cm.icon || (cm.danger ? 'trash' : 'broom'), 15), cm.confirmLabel || 'Confirm'])
        ])
      ])
    ]));
  }
  const rp = S.reportCfg;
  if (rp) {
    const close = () => { S.reportCfg = null; renderOverlays(); };
    const tone = rp.tone === 'accent' ? 'sp-cm-accent' : 'sp-cm-danger';
    const section = (label, rows) => rows.length ? el('div', { style: 'margin-bottom:14px' }, [
      el('div', { style: 'font-size:13px;color:var(--text-2);font-weight:600;line-height:1.5;margin-bottom:8px', text: label }),
      el('div', { style: 'display:flex;flex-direction:column;gap:7px' }, rows)
    ]) : null;
    const line = (name, path, note, raw) => el('div', { title: raw || '', style: 'padding:10px 12px;border-radius:10px;background:var(--panel-2);border:1px solid var(--border);min-width:0' }, [
      name ? el('div', { style: 'font-weight:600;font-size:13px', text: name }) : null,
      path ? el('div', { class: 'mono', style: 'color:var(--text-3);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: path }) : null,
      note ? el('div', { style: 'color:var(--text-2);font-size:12.5px;margin-top:3px;line-height:1.5', text: note }) : null
    ]);
    const shown = (list) => list.slice(0, 6);
    const more = (list) => list.length > 6 ? el('div', { style: 'color:var(--text-3);font-size:12px;padding:2px 2px 0', text: 'and ' + (list.length - 6) + ' more' }) : null;
    const blocks = [];
    (rp.groups || []).forEach((g) => {
      const rows = shown(g.items).map((it) => line(it.name, it.path, null));
      const extra = more(g.items);
      if (extra) rows.push(extra);
      blocks.push(section(g.reason, rows));
    });
    if ((rp.errors || []).length) {
      const rows = shown(rp.errors).map((er) => line(null, er.path, er.message, er.raw));
      const extra = more(rp.errors);
      if (extra) rows.push(extra);
      blocks.push(section('Could not be removed', rows));
    }
    h.appendChild(el('div', { style: 'position:absolute;inset:0;z-index:80;background:rgba(0,0,0,.5);display:grid;place-items:center;animation:sp-fadein .2s', onclick: close }, [
      el('div', { style: 'width:480px;max-width:90%;max-height:86%;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border-2);border-radius:18px;padding:26px;animation:sp-pop .26s cubic-bezier(.22,.61,.36,1)', onclick: (e) => e.stopPropagation() }, [
        el('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:12px' }, [
          el('div', { class: tone, style: 'width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:none' }, [ic(rp.icon || 'warning', 23)]),
          el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.3px', text: rp.title })
        ]),
        el('div', { style: 'color:var(--text-2);font-size:13.5px;line-height:1.6;margin-bottom:16px', text: rp.lead }),
        el('div', { class: 'sp-scroll', style: 'overflow-y:auto;min-height:0;margin-bottom:8px' }, blocks),
        el('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, [
          el('button', { class: 'sp-ab-accent', style: 'height:42px;padding:0 22px;border-radius:11px;border:none;color:#fff;font-weight:700;font-size:14px;cursor:pointer', onclick: close }, ['Done'])
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
// Run the action bar's clean. The screen's onClean handler shows any confirm
// dialog FIRST and only then calls SP.setCleaning(true), so the button never
// flips to "Cleaning" while the user is still deciding. Double clicks are
// ignored while a clean or a confirm dialog is already open.
let cleanBusy = false;
function setCleaning(on) { S.cleaning = !!on; renderOverlays(); }
function runClean(ab) {
  if (S.cleaning || cleanBusy || S.confirmCfg) return;
  cleanBusy = true;
  Promise.resolve(ab && ab.onClean ? ab.onClean() : null)
    .catch(() => {})
    .then(() => { cleanBusy = false; S.cleaning = false; renderOverlays(); });
}
function confirmDialog(opts) { return new Promise((resolve) => { S.confirmCfg = Object.assign({ resolve }, opts || {}); renderOverlays(); }); }
// Shared pre-clean confirmation. spec:
//   count, bytes        what will run (title: "Delete 3 items (4.5 GB)?")
//   permanent: [names]  items that cannot be recovered (listed by name)
//   trash: [{name,size}] files that go to the system Trash (listed with sizes)
//   force: true         always ask (irreversible or large-file work), even when
//                       the confirmBeforeClean preference is off
//   note                optional extra line for ordinary rebuildable work
// Resolves { go, confirmed }. go: carry on with the clean. confirmed: the user
// accepted a dialog, which is the only case that may send meta.confirmed.
async function confirmClean(spec) {
  spec = spec || {};
  const permanent = spec.permanent || [];
  const trash = spec.trash || [];
  let ask = !!spec.force || permanent.length > 0 || trash.length > 0;
  if (!ask) {
    let pref = true;
    try { const p = await window.api.getPrefs(); if (p && p.confirmBeforeClean === false) pref = false; } catch (_) {}
    ask = pref;
  }
  if (!ask) return { go: true, confirmed: false };
  const n = spec.count != null ? spec.count : (permanent.length + trash.length);
  const only = trash.length > 0 && !permanent.length && trash.length === n;
  const total = spec.bytes != null ? ' (' + fmt(spec.bytes) + ')' : '';
  const plural = n === 1 ? '' : 's';
  const title = spec.title || (only ? 'Move ' + n + ' file' + plural + total + ' to the Trash?' : 'Delete ' + n + ' item' + plural + total + '?');
  const lines = [];
  if (trash.length) {
    lines.push('These go to your Trash. Space comes back only when you empty it.');
    trash.slice(0, 6).forEach((f) => lines.push(f.name + (f.size != null ? ' (' + fmt(f.size) + ')' : '')));
    if (trash.length > 6) lines.push('and ' + (trash.length - 6) + ' more.');
  }
  if (permanent.length) {
    lines.push((trash.length ? '\n' : '') + 'Permanent, cannot be undone: ' + permanent.slice(0, 6).join(', ') + (permanent.length > 6 ? ' and ' + (permanent.length - 6) + ' more' : '') + '.');
  }
  if (spec.note) lines.push((lines.length ? '\n' : '') + spec.note);
  else if (!trash.length && !permanent.length) lines.push('Caches and build output. They rebuild on your next install or build.');
  const ok = await confirmDialog({
    title, body: lines.join('\n'),
    confirmLabel: only ? 'Move to Trash' : 'Delete',
    danger: permanent.length > 0 || only,
    icon: 'trash'
  });
  return { go: !!ok, confirmed: !!ok };
}
// Plain-English text for a failed item. Raw text stays available on hover.
function plainError(er) {
  const code = er && er.code;
  const raw = (er && (er.error || er.message)) || '';
  const m = raw.match(/\b(EACCES|EPERM|EBUSY|ENOENT|ENOTEMPTY)\b/);
  const c = code || (m && m[1]) || '';
  if (c === 'EACCES' || c === 'EPERM') return 'Spaci does not have permission. On macOS, grant Full Disk Access in System Settings > Privacy & Security.';
  if (c === 'EBUSY') return 'In use by another app. Quit it and try again.';
  if (c === 'ENOENT') return 'Already gone.';
  if (c === 'ENOTEMPTY') return 'Something is still using this folder. Try again.';
  return 'Could not be removed.';
}
function burst(size, label) {
  S.burstCfg = { size, label };
  renderOverlays();
  // Also drop a persistent toast so the confirmation lingers after the
  // full-screen celebration fades (the user wants both).
  toast(size + ' reclaimed', label || 'Cleanup complete');
  setTimeout(() => { S.burstCfg = null; renderOverlays(); }, 2300);
}

// ---------- clean results ----------
// Every screen that calls api.clean passes the response through here. The clean
// IPC can succeed while removing nothing: items may be refused (an AI tool is
// running) or fail part way. This turns that into one summary and, unless the
// caller shows its own banner, into a dialog, so a refused clean never looks
// like a successful "freed 0 B".
//   state: 'done' (everything removed), 'partial' (some freed, some not),
//          'blocked' (nothing freed, items refused or failed), 'empty'
//          (nothing to remove), 'failed' (the clean call itself failed)
function summariseClean(res, opts) {
  opts = opts || {};
  const ok = !!res && res.ok !== false;
  const refused = ok && Array.isArray(res.refused) ? res.refused.filter(Boolean) : [];
  const errors = ok && Array.isArray(res.errors) ? res.errors.filter(Boolean) : [];
  const freed = ok ? (res.totalFreed != null ? Number(res.totalFreed) || 0 : (opts.fallbackFreed || 0)) : 0;
  const issues = refused.length + errors.length;
  let state = 'done';
  if (!ok) state = 'failed';
  else if (issues && freed > 0) state = 'partial';
  else if (issues) state = 'blocked';
  else if (freed <= 0) state = 'empty';
  const refusedPaths = new Set(refused.map((r) => r.path));
  const refusedTargets = new Set(refused.map((r) => r.target).filter(Boolean));
  const errorPaths = errors.map((e) => e.path).filter(Boolean);
  const sep = /^[a-zA-Z]:[\\/]/.test(errorPaths[0] || '') ? '\\' : '/';
  return {
    ok, state, freed, refused, errors, issues, refusedTargets,
    error: !ok ? ((res && res.error) || 'Clean failed') : null,
    // True when this path was refused or reported a failure at or below it.
    blocked: (p) => refusedPaths.has(p) || errorPaths.some((ep) => ep === p || ep.indexOf(p + sep) === 0)
  };
}
function shortHome(p) {
  const home = S._homeDir;
  if (p && home && (p === home || p.indexOf(home + '/') === 0)) return '~' + p.slice(home.length);
  return p || '';
}
function reportClean(res, opts) {
  opts = opts || {};
  const sum = summariseClean(res, opts);
  const noun = (n) => n + ' item' + (n === 1 ? '' : 's');
  if (sum.state === 'done') {
    burst(fmt(sum.freed), opts.burstLabel);
    return sum;
  }
  if (sum.state === 'failed') {
    S.reportCfg = { tone: 'danger', title: 'Could not clean', lead: sum.error + '. Nothing was removed.', groups: [], errors: [] };
  } else if (sum.state === 'empty') {
    S.reportCfg = { tone: 'accent', icon: 'info', title: 'Nothing was freed', lead: 'The selected items were already empty or gone.', groups: [], errors: [] };
  } else {
    const names = opts.names || (() => '');
    const byReason = new Map();
    sum.refused.forEach((r) => {
      const reason = r.reason === 'needs-confirmation' ? 'Spaci needs your confirmation for this. Try again and confirm.' : (r.reason || 'Spaci left this alone.');
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push({ name: names(r.target) || '', path: shortHome(r.path) });
    });
    const lead = [];
    if (sum.refused.length) lead.push(noun(sum.refused.length) + (sum.refused.length === 1 ? ' was' : ' were') + ' left alone.');
    if (sum.errors.length) lead.push(noun(sum.errors.length) + ' could not be removed.');
    S.reportCfg = {
      tone: sum.state === 'partial' ? 'accent' : 'danger',
      title: sum.state === 'partial' ? 'Freed ' + fmt(sum.freed) + ', with some items left' : 'Nothing was cleaned',
      lead: lead.join(' ') + (sum.state === 'partial' ? '' : ' No space was freed.'),
      groups: Array.from(byReason, ([reason, items]) => ({ reason, items })),
      errors: sum.errors.map((e) => ({ path: shortHome(e.path), message: plainError(e), raw: e.error || '' }))
    };
  }
  renderOverlays();
  return sum;
}

// ---------- live scan progress banner ----------
const SCAN_LABELS = { projects: 'Scanning projects', system: 'Measuring caches', largefiles: 'Scanning for large files' };
function beginScan(type, root) {
  S.scan = { active: true, type, scanned: 0, found: 0, root: root || '', label: type === 'projects' ? ('Scanning ' + (root || 'your home folder')) : SCAN_LABELS[type] || 'Scanning' };
  renderRoute(false);
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

// Shared scanning card used by every screen (Projects, System Cleaner, Large
// Files, History) so the scan state looks identical everywhere. Design: a
// 'spiral' ring + "<label>" + a "running" badge + a sub line + a progress bar.
// Returns { node, set } so a screen can update it IN PLACE on each progress
// tick (no full re-render, so typing/filtering while scanning never flickers).
// opts.percent: number 0..100 for a determinate shimmer bar; null/undefined
// for an indeterminate slider.
function scanCard(opts) {
  opts = opts || {};
  const labelEl = el('span', { text: opts.label || 'Scanning' });
  const subEl = el('div', { style: 'color:var(--text-3);font-size:13.5px;margin-top:7px;font-variant-numeric:tabular-nums', text: opts.sub || '' });
  const determinate = opts.percent != null && opts.percent > 0;
  const bar = determinate
    ? el('span', { style: 'display:block;height:100%;width:' + opts.percent + '%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent-fg),var(--accent));background-size:200% 100%;animation:sp-barflow 1.6s linear infinite;transition:width .35s ease-out' })
    : el('span', { style: 'display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent-fg));animation:sp-indet 1.25s ease-in-out infinite' });
  const node = el('div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:40px 24px 32px;margin-bottom:8px' }, [
    el('div', { style: 'color:var(--accent-fg)' }, [ring('spiral', 48)]),
    el('div', {}, [
      el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;display:flex;align-items:center;gap:10px;justify-content:center' }, [
        labelEl,
        el('span', { class: 'sp-badge-accent', style: 'display:inline-flex;padding:3px 10px;border-radius:7px;font-size:11px;font-weight:700', text: 'running' })
      ]),
      subEl
    ]),
    el('div', { style: 'width:100%;max-width:420px' }, [
      el('div', { style: 'height:8px;border-radius:99px;background:var(--track);overflow:hidden' }, [bar])
    ])
  ]);
  function set(u) {
    u = u || {};
    if (u.label != null) labelEl.textContent = u.label;
    if (u.sub != null) subEl.textContent = u.sub;
    if (u.percent != null && determinate) bar.style.width = u.percent + '%';
  }
  return { node, set };
}

// ---------- app state ----------
const S = {
  route: 'dashboard',
  theme: 'dark',
  scanning: false,
  bgScanning: false, // a background (re)scan is running in the main process
  cleaning: false, // a clean is in flight (action bar shows a loader)
  disk: null,
  breakdown: null,
  recs: [],
  lastScan: 0
};

const NAV_TOP = [
  { key: 'dashboard', label: 'Smart Scan', icon: 'dashboard' },
  { key: 'projects', label: 'Projects', icon: 'folder-2', count: () => (S.projects || []).length },
  { key: 'system', label: 'System Cleaner', icon: 'broom', count: () => (S.sysTargets || []).length },
  { key: 'largefiles', label: 'Large Files', icon: 'weight' },
  { key: 'storage', label: 'Storage', icon: 'chart' },
  { key: 'recommendations', label: 'Recommendations', icon: 'sparkles', hot: true, count: () => (S.recs || []).filter((r) => !(r.action && r.action.type === 'none')).length }
];
const NAV_SOON = [
  { label: 'Scheduled Scans', icon: 'calendar', route: 'scheduled', preview: true },
  { label: 'Duplicate Finder', icon: 'copy', route: 'duplicate', preview: true },
  { label: 'Spaci Guard', icon: 'shield', route: 'guard', preview: true }
];
const NAV_BOTTOM = [
  { key: 'history', label: 'History', icon: 'log' },
  { key: 'settings', label: 'Settings', icon: 'settings' }
];

SP_REGISTRY();
function SP_REGISTRY() {
  window.SP = { screens: {}, go, state: S, el, ic, ring, fmt, toast, setActionBar, confirm: confirmDialog, burst, setCleaning, confirmClean, plainError, beginScan, endScan, scanBanner, scanActive, scanCard, summariseClean, reportClean };
}

// ---------- shell (built once, then reused; only content swaps on nav) ----------
const root = document.getElementById('app');
let contentHost = null;
let shellMode = null;       // 'welcome' | 'main'
let navRows = [];           // [{ item, row, countEl }]
let diskMiniHost = null;    // refreshed in place on breakdown updates
let themeBtn = null;
let pendingAnim = false;    // force an entrance animation on the next content render

function ensureShell() {
  const want = S.route === 'welcome' ? 'welcome' : 'main';
  if (want === shellMode) return;
  [...root.children].forEach((c) => { if (!c.classList.contains('sp-grain')) c.remove(); });
  if (want === 'welcome') buildWelcome(); else buildMain();
  shellMode = want;
}

function buildWelcome() {
  // Welcome is full-screen (no sidebar / titlebar chrome) and animates once.
  contentHost = null; navRows = []; diskMiniHost = null;
  const host = el('main', { class: 'sp-scroll sp-anim', style: 'flex:1;overflow-y:auto;position:relative;background:var(--bg);-webkit-app-region:drag' });
  const page = el('div', { class: 'sp-fadeup', style: 'min-height:100%;display:flex;align-items:center;justify-content:center;padding:48px;-webkit-app-region:no-drag' });
  host.appendChild(page);
  root.appendChild(host);
  try { ((window.SP.screens && window.SP.screens.welcome) || screenPlaceholder)(page); } catch (e) {}
}

function buildMain() {
  themeBtn = el('button', {
    style: 'width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:grid;place-items:center;cursor:pointer',
    hov: 'background:var(--panel-2);color:var(--text)',
    onclick: toggleTheme
  }, [ic(S.theme === 'light' ? 'moon' : 'sun', 16)]);

  const titlebar = el('div', {
    style:
      'height:54px;flex:none;display:flex;align-items:center;gap:14px;padding:0 18px 0 86px;background:var(--bg);border-bottom:1px solid var(--border);position:relative;z-index:30;-webkit-app-region:drag'
  }, [
    el('div', { style: 'flex:1;text-align:center;font-size:13px;font-weight:600;color:var(--text-3);letter-spacing:.2px' }, ['Spaci · Smart Cleaner']),
    el('div', { style: 'display:flex;gap:8px;align-items:center;-webkit-app-region:no-drag' }, [
      themeBtn,
      el('button', {
        style: 'height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;font-size:13px',
        hov: 'background:var(--panel-2);color:var(--text)',
        onclick: doScan
      }, [ic('refresh', 15), 'Refresh'])
    ])
  ]);

  const sidebar = buildSidebar();
  contentHost = el('main', { class: 'sp-scroll', style: 'flex:1;overflow-y:auto;position:relative;background:var(--bg)' });
  const body = el('div', { style: 'flex:1;display:flex;min-height:0;position:relative' }, [sidebar, contentHost]);

  root.appendChild(titlebar);
  root.appendChild(body);

  // One-time entrance for the freshly built sidebar, then drop the gate so future
  // in-place updates never replay it.
  sidebar.classList.add('sp-anim');
  setTimeout(() => sidebar.classList.remove('sp-anim'), 800);
  pendingAnim = true;
}

function isActive(item) {
  if (item.key) return S.route === item.key;
  if (item.route) return S.route === item.route;
  return false;
}

function syncCount(item, countEl) {
  const n = typeof item.count === 'function' ? item.count() : item.count || 0;
  if (n) { countEl.textContent = String(n); countEl.style.display = 'inline-flex'; }
  else { countEl.textContent = ''; countEl.style.display = 'none'; }
}

function navItem(item) {
  const countEl = el('span', {
    class: item.hot ? 'sp-count-hot' : 'sp-count',
    style: 'font-size:11.5px;font-weight:700;min-width:22px;height:20px;padding:0 7px;border-radius:99px;display:none;align-items:center;justify-content:center'
  });
  const row = el('div', {
    class: isActive(item) ? 'sp-nav-on sp-hov' : 'sp-hov',
    style: 'display:flex;align-items:center;gap:13px;padding:10px 12px;border-radius:11px;cursor:pointer;font-weight:500;font-size:14px;color:var(--text-2);user-select:none',
    onclick: () => { if (item.key) go(item.key); else { if (item.soon) S.activeSoon = item.soon; go(item.route); } }
  }, [ic(item.icon, 19), el('span', { style: 'flex:1' }, [item.label]),
    item.preview ? el('span', { class: 'sp-badge-accent', style: 'font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.3px', text: 'Soon' }) : null,
    countEl]);
  // Hover background, but never on the active row (its bg comes from .sp-nav-on).
  row.addEventListener('mouseenter', () => { if (!row.classList.contains('sp-nav-on')) row.style.background = 'var(--panel)'; });
  row.addEventListener('mouseleave', () => { if (!row.classList.contains('sp-nav-on')) row.style.background = ''; });
  navRows.push({ item, row, countEl });
  syncCount(item, countEl);
  return row;
}

function buildSidebar() {
  navRows = [];
  const top = el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:3px' }, NAV_TOP.map(navItem));
  const soon = el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, NAV_SOON.map(navItem));
  const bottom = el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, NAV_BOTTOM.map(navItem));

  diskMiniHost = el('div', {});
  diskMiniHost.appendChild(diskMini());

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
    diskMiniHost,
    bottom
  ]);
}

// Update active highlight + count badges in place, no DOM rebuild (so the
// sidebar never re-animates and the brand logo never restarts).
function syncSidebar() {
  navRows.forEach(({ item, row, countEl }) => {
    row.classList.toggle('sp-nav-on', isActive(item));
    syncCount(item, countEl);
  });
}

function refreshDiskMini() {
  if (!diskMiniHost) return;
  diskMiniHost.innerHTML = '';
  diskMiniHost.appendChild(diskMini());
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

function renderRoute(animate) {
  if (!contentHost) return;
  // The .sp-anim gate decides whether the content's entrance animations play.
  contentHost.classList.toggle('sp-anim', !!animate);
  const keepScroll = animate ? 0 : contentHost.scrollTop;
  contentHost.innerHTML = '';
  S.actionBar = null; // each screen sets its own selection bar
  const page = el('div', { class: 'sp-fadeup', style: 'padding:34px 40px 120px' });
  contentHost.appendChild(page);
  const screen = (window.SP.screens && window.SP.screens[S.route]) || screenPlaceholder;
  try { screen(page); } catch (e) { page.appendChild(el('div', { style: 'color:var(--danger-fg)', text: 'Failed to render: ' + e.message })); }
  if (!animate && keepScroll) contentHost.scrollTop = keepScroll;
  // Drop the gate once the entrance has played, so a screen's own in-place
  // re-render (selecting a row, sorting) never replays the stagger.
  if (animate) setTimeout(() => { if (contentHost) contentHost.classList.remove('sp-anim'); }, 620);
  renderOverlays();
}

// Navigate, or (when the route is unchanged) do a flicker-free in-place update:
// same-route calls from screens (selection, sorting, hover) must NOT re-animate.
function go(route) {
  const prev = S.route;
  S.route = route;
  ensureShell();
  if (shellMode === 'welcome') return;
  syncSidebar();
  const animate = pendingAnim || prev !== route;
  pendingAnim = false;
  renderRoute(animate);
}

// Re-pull derived UI after the underlying data changed, with no entrance animation.
function refresh() {
  if (shellMode !== 'main') return;
  syncSidebar();
  refreshDiskMini();
  renderRoute(false);
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
  applyTheme(); // theme is driven by a class on root + CSS vars, so no rebuild needed
  if (themeBtn) { themeBtn.innerHTML = ''; themeBtn.appendChild(ic(S.theme === 'light' ? 'moon' : 'sun', 16)); }
  try { await api.setPrefs({ theme: S.theme }); } catch (_) {}
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
  if (shellMode === 'main') renderRoute(false);
  try { await Promise.allSettled([api.scanProjects && api.scanProjects(), api.scanSystem && api.scanSystem()]); } catch (_) {}
  S.lastScan = Date.now();
  await loadData();
  S.scanning = false;
  refresh();
}

// ---------- boot ----------
async function boot() {
  try {
    const prefs = await api.getPrefs();
    if (prefs && prefs.theme) S.theme = prefs.theme;
    if (prefs && !prefs.onboarded) S.route = 'welcome';
  } catch (_) {}
  applyTheme();
  go(S.route);
  await loadData();
  refresh();

  if (api.onBreakdownUpdated) api.onBreakdownUpdated((bd) => { S.breakdown = bd; refreshDiskMini(); if (S.route === 'dashboard' || S.route === 'storage') renderRoute(false); });
  // Background scan finished in the main process and rewrote the cache: pull the
  // fresh results and repaint whatever screen is showing (cache-first revalidate).
  if (api.onCacheUpdated) api.onCacheUpdated(() => loadData().then(refresh));
  // Background scan started/stopped: reflect it as a subtle state, no blocking.
  if (api.onBgScan) api.onBgScan((p) => { S.bgScanning = !!(p && p.active); refresh(); });
  if (api.onTrayScan) api.onTrayScan(() => { go('dashboard'); doScan(); });
  if (api.onNavGo) api.onNavGo((route) => { if (route) go(route); });
  if (api.onScanProgress) api.onScanProgress((p) => liveScan('projects', p));
  if (api.onSystemProgress) api.onSystemProgress((p) => liveScan('system', p));
  if (api.onLargeFilesProgress) api.onLargeFilesProgress((p) => liveScan('largefiles', p));
}


// boot after all body scripts (including screen modules) have registered.
document.addEventListener('DOMContentLoaded', boot);
