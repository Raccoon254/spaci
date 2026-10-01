'use strict';
/* Local AI models and developer tools (System Cleaner sections and the
   Storage drill-down summary). Data comes from api.devtoolsInventory; every
   delete goes through api.devtoolsRemove with an explicit confirm, one item
   at a time. Main refuses anything blocked, unlisted or unconfirmed, so the
   disabled buttons here are a courtesy, not the safety. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;
  const FRESH_MS = 5 * 60 * 1000;
  const PREVIEW = 5;

  const has = () => typeof api.devtoolsInventory === 'function';
  let repaint = () => {};

  async function load(force) {
    if (!has() || S.devtoolsLoading) return;
    if (S._homeDir == null && typeof api.home === 'function') Promise.resolve(api.home()).then((h) => { S._homeDir = h || ''; repaint(); }).catch(() => {});
    if (!force && S.devtools && Date.now() - (S.devtools.at || 0) < FRESH_MS) return;
    S.devtoolsLoading = true;
    repaint();
    try {
      const res = await api.devtoolsInventory(Boolean(force));
      S.devtools = res && Array.isArray(res.groups) ? res : { at: Date.now(), groups: [], totals: { ai: 0, dev: 0 }, error: 'Spaci could not list them.' };
    } catch (err) {
      S.devtools = { at: Date.now(), groups: [], totals: { ai: 0, dev: 0 }, error: (err && err.message) || 'Spaci could not list them.' };
    } finally {
      S.devtoolsLoading = false;
      repaint();
    }
  }

  function groupMark(g, size) {
    if (g.brand && SP.bic) return SP.bic(g.brand, size, { label: g.title, fallback: g.icon || 'box' });
    if (g.tech && SP.tic) return SP.tic(g.tech, size, { label: g.title });
    return ic(g.icon || 'box', size);
  }

  const BADGE_CLS = { running: 'sp-badge-accent', pinned: 'sp-badge-safe', warn: 'sp-badge-warn', unknown: 'sp-badge-caution', info: 'sp-badge-caution' };
  function badge(b) {
    return el('span', {
      class: BADGE_CLS[b.kind] || 'sp-badge-caution',
      style: 'display:inline-flex;padding:3px 8px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none;white-space:nowrap',
      text: b.text,
    });
  }
  function tierPill(tier) {
    if (SP.tiers && SP.tiers.pill) return SP.tiers.pill(tier);
    const t = tier === 'C' ? ['sp-badge-warn', 'Permanent'] : ['sp-badge-caution', 'Review'];
    return el('span', { class: t[0], style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700;flex:none', text: t[1] });
  }

  function notice(r) {
    return el('div', {
      role: 'status',
      style: `display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-radius:11px;font-size:12.5px;font-weight:600;line-height:1.5;background:${r.ok ? 'var(--success-soft)' : 'var(--danger-soft)'};color:${r.ok ? 'var(--success-fg)' : 'var(--danger-fg)'}`,
    }, [ic(r.ok ? 'check' : 'warning', 16), el('div', { text: r.text })]);
  }

  async function removeItem(g, it) {
    if (S.devtoolsBusy || it.blocked || typeof api.devtoolsRemove !== 'function') return;
    const lines = [];
    lines.push(it.tierReason || '');
    if (it.tier === 'C') lines.push('This cannot be undone. Nothing goes to the Trash.');
    if (it.restoreHint) lines.push('To get it back: ' + it.restoreHint);
    if (g.note) lines.push(g.note);
    const ok = await SP.confirm({
      title: 'Delete ' + it.label + ' (' + fmt(it.size || 0) + ')?',
      body: lines.filter(Boolean).join('\n\n'),
      confirmLabel: 'Delete',
      danger: true,
      icon: 'trash',
    });
    if (!ok) return;
    S.devtoolsBusy = it.id;
    S.devtoolsResult = null;
    repaint();
    try {
      const res = await api.devtoolsRemove(it.id, { confirmed: true });
      if (res && res.ok) {
        SP.reportClean({ ok: true, totalFreed: res.freed || 0, refused: [], errors: [] }, { burstLabel: 'from ' + it.label });
        S.devtoolsResult = { group: g.id, ok: true, text: 'Deleted ' + it.label + (res.freed ? ', freed ' + fmt(res.freed) : '') + '.' + (res.note ? ' ' + res.note : '') };
      } else {
        S.devtoolsResult = { group: g.id, ok: false, text: ((res && (res.message || res.error)) || 'Not deleted') + (/\.$/.test((res && res.message) || '') ? '' : '.') + ' Nothing else was touched.' };
      }
    } catch (err) {
      S.devtoolsResult = { group: g.id, ok: false, text: ((err && err.message) || 'Not deleted') + '. Nothing else was touched.' };
    } finally {
      S.devtoolsBusy = null;
      repaint();
      load(true);
    }
  }

  function detailLine(it) {
    const bits = [];
    // The lock line below already says why a blocked item stays.
    if (it.detail && it.detail !== it.blocked) bits.push(it.detail);
    if (it.totalSize && it.totalSize > it.size) bits.push(fmt(it.totalSize) + ' with shared files');
    if (it.modifiedAt && SP.ago) bits.push('modified ' + SP.ago(it.modifiedAt));
    return bits.join(' · ');
  }

  function itemRow(g, it) {
    const busy = S.devtoolsBusy === it.id;
    const disabled = Boolean(it.blocked) || Boolean(S.devtoolsBusy);
    return el('div', {
      'data-devtools-item': it.id,
      style: 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:11px;background:var(--panel-2);border:1px solid var(--border)',
    }, [
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap' }, [
          el('span', { class: 'mono', title: it.label, style: 'font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace', text: it.label }),
          ...(it.badges || []).map(badge),
        ]),
        detailLine(it) ? el('div', { style: 'color:var(--text-3);font-size:11.5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: detailLine(it), text: detailLine(it) }) : null,
        it.blocked ? el('div', { style: 'color:var(--text-2);font-size:11.5px;margin-top:3px;display:flex;align-items:center;gap:6px' }, [ic('lock', 12), el('span', { text: it.blocked })]) : null,
      ]),
      tierPill(it.tier),
      el('div', { style: 'font-weight:700;font-size:13.5px;min-width:68px;text-align:right;flex:none;font-variant-numeric:tabular-nums', text: fmt(it.size || 0) }),
      el('button', {
        title: it.blocked || 'Delete ' + it.label,
        'aria-label': 'Delete ' + it.label,
        'aria-disabled': disabled ? 'true' : 'false',
        style: 'height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--border-2);background:var(--panel);color:var(--danger-fg);font-weight:650;font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer;font-family:inherit;flex:none'
          + (disabled && !busy ? ';opacity:.4;pointer-events:none' : ''),
        hov: 'border-color:var(--danger);background:var(--danger-soft)',
        onclick: () => removeItem(g, it),
      }, [busy ? ring('elastic', 13) : ic('trash', 13), busy ? 'Deleting…' : 'Delete']),
    ]);
  }

  const SERVER_CLS = { running: 'sp-badge-accent', stopped: 'sp-badge-caution', unknown: 'sp-badge-warn' };

  function groupCard(g) {
    S.devtoolsOpen = S.devtoolsOpen || {};
    const open = !!S.devtoolsOpen[g.id];
    const items = g.items || [];
    const shown = open ? items : items.slice(0, PREVIEW);
    const sub = g.status === 'error'
      ? 'Could not be read'
      : items.length + (items.length === 1 ? ' item' : ' items') + (g.roots && g.roots[0] ? ' · ' + shortPath(g.roots[0]) : '');
    const kids = [
      el('div', { style: 'display:flex;align-items:center;gap:13px' }, [
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [groupMark(g, 24)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:700;font-size:15px;display:flex;align-items:center;gap:9px;flex-wrap:wrap' }, [
            el('span', { text: g.title }),
            g.server && g.server.label ? el('span', { class: SERVER_CLS[g.server.state] || 'sp-badge-caution', style: 'display:inline-flex;padding:3px 9px;border-radius:7px;font-size:10.5px;font-weight:700', text: g.server.label }) : null,
          ]),
          el('div', { class: 'mono', style: 'color:var(--text-3);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: (g.roots || []).join('\n'), text: sub }),
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;flex:none;font-variant-numeric:tabular-nums', text: fmt(g.total || 0) }),
      ]),
    ];
    if (g.status === 'error') kids.push(notice({ ok: false, text: g.note || 'Spaci could not read this store.' }));
    if (S.devtoolsResult && S.devtoolsResult.group === g.id) kids.push(notice(S.devtoolsResult));
    if (shown.length) kids.push(el('div', { style: 'display:flex;flex-direction:column;gap:7px;padding-top:12px;border-top:1px solid var(--border)' }, shown.map((it) => itemRow(g, it))));
    if (items.length > PREVIEW) {
      kids.push(el('button', {
        'aria-expanded': open ? 'true' : 'false',
        style: 'height:34px;padding:0 13px;border-radius:9px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:12.5px;display:flex;align-items:center;gap:7px;cursor:pointer;font-family:inherit;align-self:flex-start',
        hov: 'border-color:var(--accent);color:var(--accent-fg)',
        onclick: () => { S.devtoolsOpen[g.id] = !open; repaint(); },
      }, [open ? 'Show fewer' : 'Show all ' + items.length, ic(open ? 'chevron-up' : 'chevron-down', 14)]));
    }
    if (g.note && g.status !== 'error') kids.push(el('div', { style: 'color:var(--text-3);font-size:11.5px;line-height:1.5', text: g.note }));
    return el('div', {
      'data-devtools-group': g.id,
      style: 'display:flex;flex-direction:column;gap:12px;padding:18px 20px;border-radius:16px;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-sm)',
    }, kids);
  }

  function shortPath(p) {
    const home = S._homeDir || '';
    return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  }

  function sectionHead(title, total, sub, withButton) {
    const checking = S.devtoolsLoading;
    return el('div', { style: 'margin:30px 0 12px' }, [
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: title }),
        el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
          total != null ? el('div', { style: 'font-size:12.5px;color:var(--text-3);font-weight:600;font-variant-numeric:tabular-nums', text: fmt(total) }) : null,
          withButton ? el('button', {
            'aria-label': 'Check AI models and developer tools again',
            style: 'height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:650;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;font-family:inherit' + (checking ? ';opacity:.55;pointer-events:none' : ''),
            hov: 'border-color:var(--accent);color:var(--accent-fg)',
            onclick: () => load(true),
          }, [checking ? ring('elastic', 13) : ic('refresh', 13), checking ? 'Checking…' : 'Check again']) : null,
        ]),
      ]),
      sub ? el('div', { style: 'color:var(--text-3);font-size:12.5px;line-height:1.5;margin-top:6px;max-width:640px', text: sub }) : null,
    ]);
  }

  const DEV_CATEGORIES = [
    ['simulators', 'Simulators'], ['emulators', 'Emulators and SDK'], ['toolchains', 'Toolchains'],
    ['ide', 'IDE leftovers'], ['caches', 'Tool caches'], ['error', 'Could not be read'],
  ];

  /**
   * Both System Cleaner sections, as nodes to append. paint: the screen's
   * repaint, called when data or state changes.
   */
  function sections(paint) {
    repaint = paint || repaint;
    if (!has()) return [];
    if (!S.devtools && !S.devtoolsLoading) { load(false); }
    const d = S.devtools;
    const out = [];
    const ai = d ? d.groups.filter((g) => g.section === 'ai') : [];
    const dev = d ? d.groups.filter((g) => g.section !== 'ai') : [];

    const aiNode = el('section', { 'data-devtools-section': 'ai', 'aria-label': 'Local AI models' }, [
      sectionHead('Local AI models', d ? d.totals.ai : null, 'Models downloaded by Ollama, LM Studio, Hugging Face and other local AI tools. Each one is deleted on its own, never while it is loaded, and comes back with the command shown.', true),
    ]);
    if (!d) {
      aiNode.appendChild(el('div', { style: 'display:flex;align-items:center;gap:10px;color:var(--text-3);font-size:12.5px;padding:6px 2px' }, [ring('elastic', 16), 'Looking for local AI models and developer tools…']));
    } else if (d.error) {
      aiNode.appendChild(notice({ ok: false, text: d.error }));
    } else if (!ai.length) {
      aiNode.appendChild(el('div', { style: 'color:var(--text-3);font-size:12.5px;padding:2px', text: 'No local AI model stores found on this computer.' }));
    } else {
      aiNode.appendChild(el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:12px' }, ai.map(groupCard)));
    }
    out.push(aiNode);

    if (d && !d.error) {
      const devNode = el('section', { 'data-devtools-section': 'dev', 'aria-label': 'Developer tools' }, [
        sectionHead('Developer tools', d.totals.dev, 'Simulators, emulators, toolchain versions and IDE leftovers. Versions a project pins, defaults and anything running are shown but never deleted.', false),
      ]);
      if (!dev.length) {
        devNode.appendChild(el('div', { style: 'color:var(--text-3);font-size:12.5px;padding:2px', text: 'Nothing found beyond the caches listed below.' }));
      } else {
        for (const [cat, label] of DEV_CATEGORIES) {
          const list = dev.filter((g) => g.category === cat);
          if (!list.length) continue;
          devNode.appendChild(el('div', { style: 'font-size:11.5px;color:var(--text-3);font-weight:600;margin:16px 0 9px', text: label }));
          devNode.appendChild(el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:12px' }, list.map(groupCard)));
        }
      }
      out.push(devNode);
    }
    return out;
  }

  /** Storage drill-down summary for the Developer category. */
  function storageSummary(paint) {
    repaint = paint || repaint;
    if (!has()) return null;
    if (!S.devtools && !S.devtoolsLoading) load(false);
    const d = S.devtools;
    const groups = d ? d.groups.filter((g) => g.status !== 'error' && g.total > 0).sort((a, b) => b.total - a.total) : [];
    const rows = groups.map((g) => el('div', {
      'data-devtools-storage': g.id,
      class: 'sp-hov',
      role: 'button',
      tabindex: '0',
      style: 'display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer',
      hov: 'border-color:var(--border-2)',
      onclick: () => SP.go('system'),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); SP.go('system'); } },
    }, [
      el('div', { style: 'width:38px;height:38px;border-radius:10px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [groupMark(g, 21)]),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { style: 'font-weight:600;font-size:14px', text: g.title }),
        el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:2px', text: (g.section === 'ai' ? 'AI models · ' : '') + g.items.length + (g.items.length === 1 ? ' item' : ' items') }),
      ]),
      el('div', { style: 'font-weight:700;font-size:14.5px;font-variant-numeric:tabular-nums', text: fmt(g.total) }),
      ic('chevron-right', 16, { color: 'var(--text-4)' }),
    ]));
    return el('div', { 'data-devtools-section': 'storage', style: 'margin-bottom:24px' }, [
      el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px' }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-3);font-weight:600', text: 'AI models and developer tools' }),
        d ? el('div', { style: 'font-size:12.5px;color:var(--text-3);font-variant-numeric:tabular-nums', text: fmt((d.totals.ai || 0) + (d.totals.dev || 0)) }) : null,
      ]),
      !d ? el('div', { style: 'display:flex;align-items:center;gap:10px;color:var(--text-3);font-size:12.5px' }, [ring('elastic', 16), 'Looking for models, simulators and toolchains…'])
        : rows.length ? el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, rows)
          : el('div', { style: 'color:var(--text-3);font-size:12.5px', text: 'None found.' }),
      rows.length ? el('div', { style: 'color:var(--text-3);font-size:12px;margin-top:8px', text: 'Review and delete them one by one in System Cleaner.' }) : null,
    ]);
  }

  SP.devtools = { load, sections, storageSummary };
})();
