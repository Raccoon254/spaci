'use strict';
/* Large Files screen, Spaci v2. Faithful to design/spaci-v2-reference.html
   (data-screen-label="Large Files"), wired to the real large-file scanner via
   window.api.scanLargeFiles(root, minBytes) with streamed progress through
   window.api.onLargeFilesProgress(). The backend returns
   { ok, files: [{ path, size, mtimeMs, ext }], scanned }. Results are cached on
   S.largeFiles so navigating away and back does not rescan. Deleting is not
   offered here (it is permanent); each row instead reveals the file in Finder
   or opens it. */
(function () {
  const SP = window.SP;
  const { el, ic, ring, fmt } = SP;
  const S = SP.state;
  const api = window.api;

  // ---------- threshold presets ----------
  const MB = 1024 * 1024;
  const PRESETS = [
    { label: '100 MB', bytes: 100 * MB },
    { label: '500 MB', bytes: 500 * MB },
    { label: '1 GB', bytes: 1024 * MB }
  ];
  const DEFAULT_MIN = 500 * MB; // matches the reference header ("≥ 500 MB")

  function minBytes() {
    return S.largeMinBytes || (S.largeMinBytes = DEFAULT_MIN);
  }
  function minLabel(b) {
    const hit = PRESETS.find((p) => p.bytes === b);
    return hit ? hit.label : fmt(b);
  }

  // ---------- file-type icon inference ----------
  // Map a lowercased extension (including the dot) to one of the bundled icons.
  const EXT_GROUPS = {
    image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.svg', '.psd', '.raw', '.cr2', '.nef', '.ico'],
    image2: ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.flv', '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'],
    box: ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.dmg', '.iso', '.pkg', '.deb', '.rpm', '.appimage'],
    code: ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.php', '.sh', '.json', '.sql', '.wasm'],
    database: ['.db', '.sqlite', '.sqlite3', '.dump', '.bak', '.mdb', '.realm'],
    document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.numbers', '.pages', '.txt', '.csv', '.md', '.rtf', '.epub']
  };
  function iconForExt(ext) {
    const e = (ext || '').toLowerCase();
    if (!e) return 'file';
    if (EXT_GROUPS.image.includes(e)) return 'image';
    if (EXT_GROUPS.image2.includes(e)) return 'image';
    if (EXT_GROUPS.box.includes(e)) return 'box';
    if (EXT_GROUPS.code.includes(e)) return 'code';
    if (EXT_GROUPS.database.includes(e)) return 'database';
    if (EXT_GROUPS.document.includes(e)) return 'document-text';
    return 'file';
  }

  // ---------- path helpers ----------
  function baseName(p) {
    if (!p) return '';
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  function dirName(p) {
    if (!p) return '';
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : p;
  }

  // Per-path selection set, persisted on shared state across re-renders.
  function selSet() {
    if (!S.selLarge || !(S.selLarge instanceof Set)) S.selLarge = new Set();
    return S.selLarge;
  }

  // ---------- screen ----------
  SP.screens.largefiles = function (host) {
    // progress unsubscribe handle, kept on shared state so a re-render does not
    // leak listeners; we always detach before attaching a new one.
    function detach() {
      if (S.largeUnsub) { try { S.largeUnsub(); } catch (_) {} S.largeUnsub = null; }
    }

    // Kick off a scan. `root` null => backend defaults to the home directory.
    async function runScan(root) {
      detach();
      S.largeRoot = root || S.largeRoot || null;
      S.largeScan = { loading: true, error: null, progress: null, root: S.largeRoot };
      // Streamed progress: { scanned, found, current } then { phase:'done', ... }.
      if (api.onLargeFilesProgress) {
        S.largeUnsub = api.onLargeFilesProgress((p) => {
          const st = S.largeScan;
          if (!st || !st.loading) return;
          if (p && p.phase === 'done') return;
          st.progress = p;
          // Only repaint the live progress line, cheaply, while on this screen.
          if (S.route === 'largefiles') paintProgress();
        });
      }
      render();
      try {
        const res = await api.scanLargeFiles(S.largeRoot, minBytes());
        detach();
        if (res && res.ok) {
          const files = (res.files || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
          S.largeFiles = { files, scanned: res.scanned || 0, root: S.largeRoot, minBytes: minBytes(), at: Date.now() };
          S.largeScan = null;
        } else {
          S.largeScan = { loading: false, error: (res && res.error) || 'Scan failed', progress: null, root: S.largeRoot };
        }
      } catch (err) {
        detach();
        S.largeScan = { loading: false, error: (err && err.message) || 'Scan failed', progress: null, root: S.largeRoot };
      }
      if (S.route === 'largefiles') render();
    }

    // Choose a folder to scan, then scan it.
    async function pickAndScan() {
      try {
        const dir = await api.pickFolder();
        if (dir) runScan(dir);
      } catch (_) { /* dialog cancelled or failed; ignore */ }
    }

    function setThreshold(bytes) {
      if (S.largeMinBytes === bytes) return;
      S.largeMinBytes = bytes;
      render();
    }

    // ---------- header (title + threshold chips + scan) ----------
    function header() {
      const scanning = S.largeScan && S.largeScan.loading;
      const current = minBytes();

      const chips = PRESETS.map((p) => {
        const on = p.bytes === current;
        return el('div', {
          class: 'sp-hov' + (on ? ' sp-chip-on' : ''),
          style: 'display:flex;align-items:center;height:40px;padding:0 14px;border-radius:99px;background:var(--panel);border:1px solid var(--border);font-size:13px;font-weight:600;color:var(--text-2);cursor:pointer' + (scanning ? ';opacity:.6;pointer-events:none' : ''),
          hov: on ? '' : 'border-color:var(--border-2);color:var(--text)',
          onclick: () => { if (!scanning) setThreshold(p.bytes); }
        }, ['≥ ' + p.label]);
      });

      return el('div', {}, [
        el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px' }, [
          el('div', {}, [
            el('div', { style: 'font-size:31px;font-weight:700;letter-spacing:-1.1px', text: 'Large Files' }),
            el('div', {
              style: 'color:var(--text-2);font-size:14.5px;margin-top:7px;max-width:560px',
              text: 'Big files hogging space. Deleting here is permanent and not reversible, review carefully.'
            })
          ]),
          el('div', { style: 'display:flex;gap:10px;align-items:center;flex:none' }, [
            el('button', {
              style: 'height:44px;padding:0 16px;border-radius:11px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (scanning ? ';opacity:.6;pointer-events:none' : ''),
              hov: 'background:var(--panel-2);border-color:var(--border-2)',
              onclick: () => { if (!scanning) pickAndScan(); }
            }, [ic('folder-open', 16), 'Choose folder']),
            el('button', {
              style: 'height:44px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit' + (scanning ? ';opacity:.7;pointer-events:none' : ''),
              hov: 'background:var(--accent-hover)',
              onclick: () => { if (!scanning) runScan(S.largeRoot); }
            }, [scanning ? ring('spin', 17) : ic('scan', 17), scanning ? 'Scanning…' : 'Scan'])
          ])
        ]),
        // threshold chips row + active scan root
        el('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:20px' }, [
          el('span', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600;margin-right:4px', text: 'Minimum size' }),
          ...chips,
          rootChip()
        ])
      ]);
    }

    // Small muted chip describing the folder being scanned.
    function rootChip() {
      const root = (S.largeFiles && S.largeFiles.root) || S.largeRoot;
      if (!root) return null;
      return el('div', {
        style: 'display:flex;align-items:center;gap:7px;height:40px;padding:0 13px;border-radius:99px;background:var(--panel-2);border:1px solid var(--border);font-size:12.5px;font-weight:600;color:var(--text-3);max-width:320px;overflow:hidden',
        title: root
      }, [
        ic('folder-2', 14, { color: 'var(--text-4)' }),
        el('span', { class: 'mono', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left', text: root })
      ]);
    }

    // ---------- permanent-deletion warning banner ----------
    function warnBanner() {
      return el('div', {
        style: 'display:flex;align-items:center;gap:10px;padding:13px 16px;border-radius:12px;background:var(--danger-soft);color:var(--danger-fg);font-size:13px;font-weight:600;margin-bottom:16px'
      }, [ic('warning', 17), 'Files removed here are permanently deleted and cannot be restored.']);
    }

    // ---------- one file row ----------
    function row(f) {
      const name = baseName(f.path);
      const dir = dirName(f.path);
      const sel = selSet();

      // selection check circle: toggles this file in/out of the delete set
      // without triggering the row's reveal action.
      const check = el('div', {
        class: 'sp-check' + (sel.has(f.path) ? ' sp-check-on' : ''),
        style: 'width:24px;height:24px;border-radius:50%;border:1.5px solid var(--border-2);flex:none;display:grid;place-items:center;color:transparent;transition:.14s'
      }, [ic('check', 14)]);
      check.addEventListener('click', (e) => {
        stop(e);
        if (sel.has(f.path)) { sel.delete(f.path); check.className = 'sp-check'; }
        else { sel.add(f.path); check.className = 'sp-check sp-check-on'; }
        syncActionBar();
      });

      return el('div', {
        class: 'sp-hov',
        style: 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:var(--panel);border:1px solid var(--border);cursor:pointer;box-shadow:var(--shadow-sm)',
        hov: 'border-color:var(--border-2)',
        onclick: () => reveal(f.path)
      }, [
        check,
        el('div', { style: 'width:42px;height:42px;border-radius:11px;background:var(--panel-2);display:grid;place-items:center;flex:none;color:var(--text-2)' }, [ic(iconForExt(f.ext), 22)]),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: name }),
          el('div', {
            class: 'mono',
            style: 'color:var(--text-3);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
            title: f.path,
            text: dir
          })
        ]),
        el('div', { style: 'font-weight:700;font-size:15px;color:var(--accent-fg);flex:none', text: fmt(f.size || 0) }),
        // row actions: reveal in Finder + open
        el('div', { style: 'display:flex;align-items:center;gap:6px;flex:none' }, [
          rowAction('eye', 'Reveal in Finder', (e) => { stop(e); reveal(f.path); }),
          rowAction('external-link', 'Open file', (e) => { stop(e); open(f.path); })
        ])
      ]);
    }

    function rowAction(icon, title, onclick) {
      return el('button', {
        title,
        style: 'width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--panel-2);color:var(--text-3);display:grid;place-items:center;cursor:pointer;font-family:inherit',
        hov: 'background:var(--panel-3);color:var(--text);border-color:var(--border-2)',
        onclick
      }, [ic(icon, 16)]);
    }

    function stop(e) { if (e) { e.stopPropagation(); e.preventDefault(); } }

    async function reveal(p) { try { await api.reveal(p); } catch (_) { /* ignore */ } }
    async function open(p) { try { await api.openPath(p); } catch (_) { /* ignore */ } }

    // ---------- live progress (loading) ----------
    // Painted into a stable node id so streamed updates do not rebuild the page.
    function paintProgress() {
      const line = document.getElementById('sp-lf-progress');
      if (!line) return;
      const pr = (S.largeScan && S.largeScan.progress) || {};
      const dirs = pr.scanned != null ? pr.scanned : 0;
      const found = pr.found != null ? pr.found : 0;
      line.textContent = dirs.toLocaleString() + ' folders scanned · ' + found + ' large ' + (found === 1 ? 'file' : 'files') + ' found';
    }

    function loadingState() {
      const cur = (S.largeScan && S.largeScan.progress && S.largeScan.progress.current) || '';
      return el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:18px;color:var(--text-3)'
      }, [
        el('div', { style: 'color:var(--accent-fg)' }, [ring('orbit', 56)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'Hunting for large files…' }),
        el('div', { id: 'sp-lf-progress', style: 'font-size:13.5px;font-weight:600;color:var(--text-2);font-variant-numeric:tabular-nums' }, ['Starting…']),
        cur ? el('div', {
          class: 'mono',
          style: 'font-size:11.5px;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-4)',
          text: cur
        }) : null
      ]);
    }

    function errorState(msg) {
      return el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:46vh;gap:16px;color:var(--text-3)'
      }, [
        el('div', { style: 'width:56px;height:56px;border-radius:16px;background:var(--danger-soft);color:var(--danger-fg);display:grid;place-items:center' }, [ic('warning', 28)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'Could not scan for large files' }),
        el('div', { style: 'font-size:13.5px;max-width:380px', text: msg || 'Something went wrong while scanning.' }),
        el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: 'background:var(--accent-hover)',
          onclick: () => runScan(S.largeRoot)
        }, [ic('scan', 16), 'Try again'])
      ]);
    }

    // No scan run yet: invite the user to start one.
    function startState() {
      return el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:42vh;gap:16px;color:var(--text-3)'
      }, [
        el('div', { style: 'width:56px;height:56px;border-radius:16px;background:var(--panel-2);color:var(--text-3);display:grid;place-items:center' }, [ic('chart', 28)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'Find your biggest files' }),
        el('div', { style: 'font-size:13.5px;max-width:400px', text: 'Scan your home folder for files at or above ' + minLabel(minBytes()) + ', or pick a specific folder to search.' }),
        el('div', { style: 'display:flex;gap:10px;margin-top:6px' }, [
          el('button', {
            style: 'height:44px;padding:0 22px;border-radius:11px;border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit',
            hov: 'background:var(--accent-hover)',
            onclick: () => runScan(null)
          }, [ic('scan', 16), 'Scan home folder']),
          el('button', {
            style: 'height:44px;padding:0 18px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit',
            hov: 'background:var(--panel-3)',
            onclick: () => pickAndScan()
          }, [ic('folder-open', 16), 'Choose folder'])
        ])
      ]);
    }

    // Scan completed but nothing matched the threshold.
    function emptyState() {
      return el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:42vh;gap:16px;color:var(--text-3)'
      }, [
        el('div', { style: 'width:56px;height:56px;border-radius:16px;background:var(--success-soft);color:var(--success-fg);display:grid;place-items:center' }, [ic('check-circle', 28)]),
        el('div', { style: 'font-size:18px;font-weight:700;letter-spacing:-.4px;color:var(--text)', text: 'No large files found' }),
        el('div', { style: 'font-size:13.5px;max-width:400px', text: 'Nothing here is at or above ' + minLabel((S.largeFiles && S.largeFiles.minBytes) || minBytes()) + '. Try a smaller threshold or a different folder.' }),
        el('button', {
          style: 'height:42px;padding:0 20px;border-radius:11px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;margin-top:4px',
          hov: 'background:var(--panel-3)',
          onclick: () => runScan(S.largeRoot)
        }, [ic('scan', 16), 'Scan again'])
      ]);
    }

    // ---------- summary strip above the list ----------
    function summary(data) {
      const totalBytes = data.files.reduce((a, f) => a + (f.size || 0), 0);
      return el('div', {
        style: 'display:flex;flex-wrap:wrap;gap:10px 30px;align-items:center;justify-content:space-between;margin-bottom:14px'
      }, [
        el('div', { style: 'font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-3);font-weight:600', text: data.files.length + (data.files.length === 1 ? ' large file' : ' large files') + ' · ' + fmt(totalBytes) }),
        el('div', { style: 'font-size:12.5px;color:var(--text-4);font-variant-numeric:tabular-nums', text: (data.scanned || 0).toLocaleString() + ' folders scanned' })
      ]);
    }

    // ---------- floating action bar (permanent delete) ----------
    // Only the currently-listed files count toward the selection. Deleting is
    // permanent, so this uses the red danger button and a confirm modal.
    function currentFiles() {
      return (S.largeFiles && Array.isArray(S.largeFiles.files)) ? S.largeFiles.files : [];
    }
    function selectedFiles() {
      const sel = selSet();
      return currentFiles().filter((f) => sel.has(f.path));
    }
    function syncActionBar() {
      const chosen = selectedFiles();
      const n = chosen.length;
      if (!n) { SP.setActionBar(null); return; }
      const bytes = chosen.reduce((a, f) => a + (f.size || 0), 0);
      SP.setActionBar({
        count: n + ' file' + (n > 1 ? 's' : ''),
        size: fmt(bytes),
        action: 'Delete ' + fmt(bytes),
        danger: true,
        onClear: () => { selSet().clear(); SP.go('largefiles'); },
        onClean: () => doDelete(),
      });
    }

    async function doDelete() {
      if (S.largeDeleting) return;
      const chosen = selectedFiles();
      if (!chosen.length) return;
      const ok = await SP.confirm({
        title: 'Delete ' + chosen.length + ' file' + (chosen.length === 1 ? '' : 's') + '?',
        body: 'These files will be permanently deleted and cannot be restored.',
        confirmLabel: 'Delete',
        danger: true,
        icon: 'trash'
      });
      if (!ok) return;
      S.largeDeleting = true;
      try {
        const jobs = chosen.map((f) => ({ path: f.path, size: f.size }));
        const res = await api.clean(jobs, {
          scope: 'largefiles',
          label: chosen.length + ' large file' + (chosen.length === 1 ? '' : 's'),
          reversible: false
        });
        if (res && res.ok !== false) {
          const freed = res.totalFreed != null ? res.totalFreed : chosen.reduce((a, f) => a + (f.size || 0), 0);
          const deleted = new Set(chosen.map((f) => f.path));
          if (S.largeFiles) S.largeFiles.files = (S.largeFiles.files || []).filter((f) => !deleted.has(f.path));
          selSet().clear();
          SP.burst(fmt(freed), 'across ' + chosen.length + ' file' + (chosen.length === 1 ? '' : 's'));
        }
      } catch (_) { /* ignore */ }
      S.largeDeleting = false;
      if (S.route === 'largefiles') SP.go('largefiles');
    }

    // ---------- master render ----------
    function render() {
      host.innerHTML = '';
      host.appendChild(header());

      const scan = S.largeScan;
      if (scan && scan.loading) {
        host.appendChild(loadingState());
        paintProgress();
        SP.setActionBar(null);
        return;
      }
      if (scan && scan.error) { host.appendChild(errorState(scan.error)); SP.setActionBar(null); return; }

      const data = S.largeFiles;
      if (!data) { host.appendChild(startState()); SP.setActionBar(null); return; }

      host.appendChild(warnBanner());

      if (!data.files.length) { host.appendChild(emptyState()); SP.setActionBar(null); return; }

      host.appendChild(summary(data));
      host.appendChild(
        el('div', { class: 'sp-stagger', style: 'display:flex;flex-direction:column;gap:9px' }, data.files.map(row))
      );
      syncActionBar();
    }

    // initial paint. Results are cached on S.largeFiles, so revisiting the
    // screen never rescans on its own; the user must press Scan.
    render();
  };
})();
