'use strict';
/* Notices UI: the bell and notice center, the in-app banner for important and
   critical notices, and the "What's new in <version>" sheet.

   Content arrives from main (notices:list, notices:open, whatsnew:get) already
   converted to the Block model (scratchpad notices contract). It is rendered
   with createElement and textContent only, never innerHTML. Images are shown
   only as the data: URLs main hands over; anything else is dropped. Links open
   through api.openExternal (main re-checks them), never by navigating. */
(function () {
  const SP = window.SP;
  const { el, ic } = SP;
  const api = window.api;

  const SEVERITY = {
    info: { label: 'Info', badge: 'sp-badge-accent', icon: 'info', rank: 0 },
    update: { label: 'Update', badge: 'sp-badge-accent', icon: 'sparkles', rank: 1 },
    important: { label: 'Important', badge: 'sp-badge-caution', icon: 'warning', rank: 2 },
    critical: { label: 'Critical', badge: 'sp-badge-warn', icon: 'warning', rank: 3 }
  };
  const sev = (n) => SEVERITY[n && n.severity] || SEVERITY.info;

  const N = {
    list: [],
    started: false,
    bell: null,
    badge: null,
    bannerHost: null,
    center: null,        // { close, showList, showDetail } while the center is open
    whatsNewOpen: false
  };

  // ---------- Block model -> DOM ----------
  const MAX_BLOCKS = 200;
  const MAX_DEPTH = 4;
  const MAX_TEXT = 5000;
  const DATA_IMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
  const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
  function safeHref(h) {
    if (typeof h !== 'string') return null;
    let u;
    try { u = new URL(h.trim()); } catch (_) { return null; }
    if (u.protocol === 'https:' && u.hostname) return u.href;
    if (u.protocol === 'mailto:') return u.href;
    return null;
  }
  function openLink(href) {
    const safe = safeHref(href);
    if (!safe) return;
    try { api.openExternal(safe); } catch (_) {}
  }

  function inlines(list, depth) {
    const out = [];
    if (!Array.isArray(list) || depth > MAX_DEPTH) return out;
    list.forEach((x) => {
      if (!x || typeof x !== 'object') return;
      if (x.t === 'text') out.push(document.createTextNode(str(x.v)));
      else if (x.t === 'strong') out.push(el('strong', { style: 'font-weight:700;color:var(--text)' }, inlines(x.c, depth + 1)));
      else if (x.t === 'em') out.push(el('em', {}, inlines(x.c, depth + 1)));
      else if (x.t === 'code') out.push(el('code', { class: 'mono sp-nb-code', text: str(x.v) }));
      else if (x.t === 'link') {
        const href = safeHref(x.href);
        const kids = inlines(x.c, depth + 1);
        if (!href) { out.push(el('span', {}, kids)); return; }
        out.push(el('a', {
          href, title: href, class: 'sp-nb-link',
          onclick: (e) => { e.preventDefault(); openLink(href); }
        }, kids));
      }
    });
    return out;
  }

  function figure(url, alt, caption) {
    if (typeof url !== 'string' || !DATA_IMG.test(url)) return null;
    const img = el('img', { alt: str(alt), style: 'display:block;max-width:100%;height:auto;border-radius:12px;border:1px solid var(--border)' });
    img.src = url;
    return el('figure', { style: 'margin:0 0 14px' }, [
      img,
      caption ? el('figcaption', { style: 'color:var(--text-3);font-size:12.5px;margin-top:6px', text: str(caption) }) : null
    ]);
  }

  // renderBlocks(Block[]) -> DocumentFragment
  function renderBlocks(blocks) {
    const f = document.createDocumentFragment();
    (Array.isArray(blocks) ? blocks.slice(0, MAX_BLOCKS) : []).forEach((b) => {
      if (!b || typeof b !== 'object') return;
      let node = null;
      // Always h3 under the sheet's h2 so headings never skip a level; the class keeps the visual size.
      if (b.t === 'h') node = el('h3', { class: 'sp-nb-h' + (b.level === 2 ? '2' : '3') }, inlines(b.c, 1));
      else if (b.t === 'p') node = el('p', { class: 'sp-nb-p' }, inlines(b.c, 1));
      else if (b.t === 'ul' || b.t === 'ol') {
        node = el(b.t, { class: 'sp-nb-list' }, (Array.isArray(b.items) ? b.items : []).map((it) => el('li', {}, inlines(it, 1))));
      } else if (b.t === 'quote') node = el('blockquote', { class: 'sp-nb-quote' }, inlines(b.c, 1));
      else if (b.t === 'code') node = el('pre', { class: 'sp-nb-pre' }, [el('code', { class: 'mono', text: str(b.text) })]);
      else if (b.t === 'img') node = figure(b.url, b.alt, b.caption);
      else if (b.t === 'hr') node = el('hr', { class: 'sp-nb-hr' });
      if (node) f.appendChild(node);
    });
    return f;
  }

  function mediaGallery(media) {
    const figs = (Array.isArray(media) ? media : []).map((m) => m && figure(m.url, m.alt, m.caption)).filter(Boolean);
    return figs.length ? el('div', { style: 'margin-top:6px' }, figs) : null;
  }

  function dateText(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; }
  }

  // ---------- shared bits ----------
  function modalHost() {
    const app = document.getElementById('app') || document.body;
    let h = document.getElementById('sp-modals');
    if (!h) { h = el('div', { id: 'sp-modals' }); app.appendChild(h); }
    return h;
  }
  const BTN = 'height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit';
  const BTN_PRIMARY = 'height:38px;padding:0 16px;border-radius:10px;border:none;color:var(--on-accent);font-weight:700;font-size:13px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit';
  function button(label, iconName, onClick, opt) {
    opt = opt || {};
    return el('button', {
      class: opt.primary ? 'sp-ab-accent' : null,
      style: opt.primary ? BTN_PRIMARY : BTN,
      hov: opt.primary ? null : 'background:var(--panel-3)',
      'aria-label': opt.label || null,
      'data-autofocus': opt.autofocus ? '' : null,
      onclick: onClick
    }, [iconName ? ic(iconName, 15) : null, label]);
  }
  function closeButton(onClick) {
    return el('button', {
      'aria-label': 'Close',
      style: 'width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-2);display:grid;place-items:center;cursor:pointer;flex:none',
      hov: 'background:var(--panel-3);color:var(--text)',
      onclick: onClick
    }, [ic('close', 15)]);
  }
  function sevBadge(n) {
    const s = sev(n);
    return el('span', { class: s.badge, style: 'display:inline-flex;align-items:center;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.2px', text: s.label });
  }

  // ---------- data ----------
  async function refreshList() {
    let list = [];
    try { list = (api.noticesList && (await api.noticesList())) || []; } catch (_) { list = []; }
    N.list = Array.isArray(list) ? list.filter((n) => n && typeof n.id === 'string') : [];
    syncBell();
    renderBanner();
    if (N.center) N.center.refresh();
  }

  async function dismiss(n) {
    if (!n || !n.dismissible) return;
    try { await api.noticesDismiss(n.id); } catch (_) {}
    await refreshList();
  }

  // ---------- bell ----------
  function unseenCount() { return N.list.filter((n) => !n.seen).length; }
  function syncBell() {
    if (!N.bell) return;
    const n = unseenCount();
    N.badge.textContent = n > 9 ? '9+' : String(n);
    N.badge.style.display = n ? 'grid' : 'none';
    N.bell.setAttribute('aria-label', n ? 'Notices, ' + n + ' new' : 'Notices');
  }
  function bellButton() {
    N.badge = el('span', {
      'aria-hidden': 'true',
      style: 'position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:var(--accent);color:var(--on-accent);font-size:10.5px;font-weight:700;display:none;place-items:center;line-height:1'
    });
    N.bell = el('button', {
      'aria-label': 'Notices',
      'aria-haspopup': 'dialog',
      style: 'position:relative;width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:var(--panel);color:var(--text-2);display:grid;place-items:center;cursor:pointer',
      hov: 'background:var(--panel-2);color:var(--text)',
      onclick: () => openCenter()
    }, [ic('notification', 16), N.badge]);
    syncBell();
    return N.bell;
  }

  // ---------- banner (important and critical only) ----------
  function bannerNotice() {
    return N.list
      .filter((n) => sev(n).rank >= SEVERITY.important.rank)
      .sort((a, b) => sev(b).rank - sev(a).rank)[0] || null;
  }
  function mountBanner(host) { N.bannerHost = host; renderBanner(); }
  function renderBanner() {
    const host = N.bannerHost;
    if (!host || !document.contains(host)) return;
    host.innerHTML = '';
    const n = bannerNotice();
    if (!n) return;
    const critical = n.severity === 'critical';
    host.appendChild(el('div', {
      role: critical ? 'alert' : 'status',
      class: critical ? 'sp-notice-critical' : 'sp-notice-important',
      style: 'display:flex;align-items:center;gap:14px;padding:11px 18px;border-bottom:1px solid var(--border)'
    }, [
      ic(sev(n).icon, 20),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:700;font-size:13.5px;color:var(--text)', text: n.title || '' }),
        n.summary ? el('div', { style: 'color:var(--text-2);font-size:12.5px;margin-top:1px;line-height:1.45', text: n.summary }) : null
      ]),
      button('Details', null, () => openCenter(n.id)),
      n.dismissible ? button('Dismiss', null, () => dismiss(n), { label: 'Dismiss notice: ' + (n.title || '') }) : null
    ]));
  }

  // ---------- notice center ----------
  function openCenter(focusId) {
    if (N.center) { if (focusId) N.center.showDetail(focusId); return; }
    const host = modalHost();
    let release = null;
    const close = () => {
      if (!N.center) return;
      N.center = null;
      frame.backdrop.remove();
      if (release) release();
    };
    const frame = SP.dialogFrame({ width: 540, maxHeight: '86%', z: 82, onClose: close });
    const head = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px' });
    const body = el('div', { class: 'sp-scroll', style: 'overflow-y:auto;min-height:0;margin:0 -6px;padding:0 6px' });
    // Actions for the open notice stay visible below the scrolling body.
    const foot = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    frame.panel.appendChild(head);
    frame.panel.appendChild(body);
    frame.panel.appendChild(foot);
    let view = { kind: 'list' };

    function header(titleText, back) {
      head.innerHTML = '';
      if (back) {
        head.appendChild(el('button', {
          'aria-label': 'Back to all notices',
          style: 'width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-2);display:grid;place-items:center;cursor:pointer;flex:none',
          hov: 'background:var(--panel-3);color:var(--text)',
          onclick: showList
        }, [ic('chevron-left', 15)]));
      }
      head.appendChild(el('h2', { id: frame.titleId, style: 'flex:1;min-width:0;font-size:18px;font-weight:700;letter-spacing:-.3px', text: titleText }));
      head.appendChild(closeButton(close));
    }

    function showList() {
      view = { kind: 'list' };
      header('Notices', false);
      body.innerHTML = '';
      foot.innerHTML = '';
      foot.style.marginTop = '0';
      if (!N.list.length) {
        body.appendChild(el('div', { style: 'display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:34px 0 20px;color:var(--text-2)' }, [
          ic('notification', 30, { color: 'var(--text-3)' }),
          el('div', { style: 'font-weight:600;color:var(--text)', text: 'No notices right now' }),
          el('div', { style: 'font-size:13px', text: 'Release notes and important news from Spaci show up here.' })
        ]));
      } else {
        body.appendChild(el('ul', { 'aria-label': 'Notices', style: 'list-style:none;display:flex;flex-direction:column;gap:10px' }, N.list.map((n) => el('li', {
          style: 'padding:14px 16px;border-radius:14px;background:var(--panel-2);border:1px solid var(--border)'
        }, [
          el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px' }, [
            sevBadge(n),
            !n.seen ? el('span', { style: 'font-size:11.5px;font-weight:700;color:var(--accent-fg)', text: 'New' }) : null,
            el('span', { style: 'flex:1' }),
            el('span', { style: 'font-size:12px;color:var(--text-3)', text: dateText(n.publishedAt) })
          ]),
          el('h3', { style: 'font-size:14.5px;font-weight:700', text: n.title || '' }),
          n.summary ? el('p', { style: 'color:var(--text-2);font-size:13px;line-height:1.5;margin-top:3px', text: n.summary }) : null,
          el('div', { style: 'display:flex;gap:8px;margin-top:11px' }, [
            button('Read', null, () => showDetail(n.id), { label: 'Read: ' + (n.title || 'notice') }),
            n.dismissible ? button('Dismiss', null, () => dismiss(n), { label: 'Dismiss: ' + (n.title || 'notice') }) : null
          ])
        ]))));
      }
    }

    async function showDetail(id) {
      view = { kind: 'detail', id };
      let n = N.list.find((x) => x.id === id) || null;
      try { const opened = await api.noticesOpen(id); if (opened) n = opened; } catch (_) {}
      if (!N.center || view.id !== id) return;
      if (!n) { showList(); return; }
      header(n.title || 'Notice', true);
      body.innerHTML = '';
      const cta = n.cta && safeHref(n.cta.url) && /^https:/.test(n.cta.url) ? n.cta : null;
      body.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' }, [
        sevBadge(n),
        el('span', { style: 'font-size:12px;color:var(--text-3)', text: dateText(n.publishedAt) })
      ]));
      if (n.summary) body.appendChild(el('p', { class: 'sp-nb-p', style: 'color:var(--text)', text: n.summary }));
      body.appendChild(el('div', { class: 'sp-notice-body' }, [renderBlocks(n.body)]));
      const gallery = mediaGallery(n.media);
      if (gallery) body.appendChild(gallery);
      foot.innerHTML = '';
      [
        cta ? button(String(cta.label || 'Learn more').slice(0, 60), 'external-link', () => openLink(cta.url), { primary: true }) : null,
        n.dismissible ? button('Dismiss', null, async () => { await dismiss(n); if (N.center) showList(); }) : null
      ].forEach((b) => { if (b) foot.appendChild(b); });
      foot.style.marginTop = foot.firstChild ? '16px' : '0';
      // The list shows "New" from the seen flag, so pull it fresh.
      refreshList();
      const first = head.querySelector('button');
      if (first) first.focus();
    }

    N.center = {
      close,
      showList,
      showDetail,
      refresh: () => { if (view.kind === 'list') showList(); }
    };
    if (focusId) showDetail(focusId); else showList();
    release = SP.trapModal(frame.panel, { onEscape: close });
    host.appendChild(frame.backdrop);
  }

  // ---------- What's new ----------
  async function maybeShowWhatsNew() {
    if (N.whatsNewOpen || !api.whatsNewGet) return;
    if (SP.state.route === 'welcome') return;
    let notes = null;
    try { notes = await api.whatsNewGet(); } catch (_) { notes = null; }
    if (!notes || typeof notes.version !== 'string') return;
    showWhatsNew(notes);
  }
  function showWhatsNew(notes) {
    N.whatsNewOpen = true;
    const host = modalHost();
    let release = null;
    const close = () => {
      if (!N.whatsNewOpen) return;
      N.whatsNewOpen = false;
      frame.backdrop.remove();
      if (release) release();
      try { api.whatsNewSeen(notes.version); } catch (_) {}
    };
    const frame = SP.dialogFrame({ width: 580, maxHeight: '88%', z: 83, onClose: close });
    const links = (Array.isArray(notes.links) ? notes.links : []).filter((l) => l && safeHref(l.url) && /^https:/.test(l.url)).slice(0, 4);
    const done = button('Got it', null, close, { primary: true, autofocus: true });
    frame.panel.appendChild(el('div', { style: 'display:flex;align-items:center;gap:14px;margin-bottom:12px' }, [
      el('div', { class: 'sp-cm-accent', style: 'width:44px;height:44px;border-radius:12px;display:grid;place-items:center;flex:none' }, [ic('sparkles', 23)]),
      el('h2', { id: frame.titleId, style: 'flex:1;min-width:0;font-size:20px;font-weight:700;letter-spacing:-.4px', text: "What's new in " + notes.version }),
      closeButton(close)
    ]));
    const body = el('div', { class: 'sp-scroll', style: 'overflow-y:auto;min-height:0;margin:0 -6px;padding:0 6px' }, [
      notes.highlight ? el('p', { class: 'sp-nb-p', style: 'font-size:15px;font-weight:600;color:var(--text)', text: str(notes.highlight) }) : null,
      el('div', { class: 'sp-notice-body' }, [renderBlocks(notes.body)]),
      mediaGallery(notes.media)
    ]);
    frame.panel.appendChild(body);
    frame.panel.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:18px' }, [
      ...links.map((l) => button(String(l.label || 'Link').slice(0, 40), 'external-link', () => openLink(l.url))),
      el('span', { style: 'flex:1' }),
      done
    ]));
    release = SP.trapModal(frame.panel, { onEscape: close, initial: done });
    host.appendChild(frame.backdrop);
  }

  // ---------- start ----------
  function start() {
    if (N.started) return;
    N.started = true;
    refreshList();
    if (api.onNoticesUpdated) {
      api.onNoticesUpdated((p) => {
        refreshList().then(() => {
          // A click on a system notification asks the window to open that notice.
          if (p && p.reason === 'open' && typeof p.id === 'string') openCenter(p.id);
        });
      });
    }
    // Let the first screen paint before the sheet appears.
    setTimeout(maybeShowWhatsNew, 700);
  }

  SP.notices = { start, bellButton, mountBanner, openCenter, maybeShowWhatsNew, renderBlocks, refresh: refreshList };
})();
