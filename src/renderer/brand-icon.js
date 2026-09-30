// <spaci-brand-icon>: vendored brand logos (AI tools, Docker, browsers, IDEs)
// from src/renderer/icons/brand, read through api.brandIcon. The dark theme
// asks for the `-dark` variant when one exists (the main process decides).
//
//   <spaci-brand-icon brand="claude" label="Claude Code" fallback="sparkle"
//                     style="width:16px;height:16px">
//
// Attributes:
//   brand       brand id (see src/brand-ids.js). Unknown ids, or ids whose file
//               cannot be read, show the fallback.
//   fallback    name of a <spaci-icon> glyph shown when the brand is missing
//               (default `box`). Pass an empty value for no fallback.
//   label       accessible name. Sets role="img" + aria-label.
//   decorative  present when visible text beside the icon already names it.
//
// Helper: SP.bic(id, size, { label, decorative, fallback, style }) builds one.
//
// Trust: the SVG is parsed with DOMParser (never innerHTML), script,
// foreignObject, on* attributes and non-fragment hrefs are stripped, and each
// icon lives in its own shadow root so gradient ids cannot clash.
(function () {
  if (customElements.get('spaci-brand-icon')) return;

  var ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var DEFAULT_FALLBACK = 'box';
  var CACHE = new Map();   // 'dark/claude' -> parsed <svg>, or null when missing
  var PENDING = new Map();
  var LIVE = new Set();
  var SHADOW_CSS = ':host{display:inline-flex;line-height:0;flex:none}svg,spaci-icon{display:block;width:100%;height:100%}';

  function currentTheme() {
    var S = window.SP && window.SP.state;
    var theme = S && S.theme;
    if (!theme) {
      // Main window root is #app, the tray widget's is #tray.
      var root = document.getElementById('app') || document.getElementById('tray');
      theme = root && root.classList.contains('light') ? 'light' : 'dark';
    }
    return theme === 'light' ? 'light' : 'dark';
  }

  function cleanId(id) {
    var s = typeof id === 'string' ? id.trim().toLowerCase() : '';
    return ID_RE.test(s) ? s : '';
  }

  function parseSvg(text) {
    if (typeof text !== 'string' || text.indexOf('<svg') < 0) return null;
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch (_) { return null; }
    var svg = doc && doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
    Array.prototype.forEach.call(svg.querySelectorAll('script,foreignObject'), function (n) { n.remove(); });
    [svg].concat(Array.prototype.slice.call(svg.querySelectorAll('*'))).forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        if (/^on/i.test(a.name) || (/href$/i.test(a.name) && !/^#/.test(a.value))) n.removeAttribute(a.name);
      });
    });
    // Some SVGL files (opencode-dark) carry only width/height on the root and
    // nest the real artwork in an inner <svg>. Dropping the size without a
    // viewBox left the icon showing only its top-left corner, a blank square.
    // Keep the drawing box by turning the size into a viewBox first.
    if (!svg.getAttribute('viewBox')) {
      var w = parseFloat(svg.getAttribute('width'));
      var h = parseFloat(svg.getAttribute('height'));
      if (w > 0 && h > 0) svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return document.importNode(svg, true);
  }

  function fetchSvg(id, theme) {
    var api = window.api;
    if (!api || typeof api.brandIcon !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(function () { return api.brandIcon(id, theme); }).catch(function () { return null; });
  }

  // Resolves to a parsed <svg> (shared template, clone before use) or null.
  function load(id, theme) {
    var key = theme + '/' + id;
    if (CACHE.has(key)) return Promise.resolve(CACHE.get(key));
    if (PENDING.has(key)) return PENDING.get(key);
    var p = fetchSvg(id, theme).then(function (text) {
      var svg = parseSvg(text);
      CACHE.set(key, svg);
      PENDING.delete(key);
      return svg;
    });
    PENDING.set(key, p);
    return p;
  }

  customElements.define('spaci-brand-icon', class extends HTMLElement {
    static get observedAttributes() { return ['brand', 'fallback', 'label', 'decorative']; }

    connectedCallback() {
      if (!this._root) {
        this._root = this.attachShadow({ mode: 'open' });
        var style = document.createElement('style');
        style.textContent = SHADOW_CSS;
        this._root.appendChild(style);
      }
      LIVE.add(this);
      this._a11y();
      this._render();
    }

    disconnectedCallback() { LIVE.delete(this); }

    attributeChangedCallback(name) {
      if (!this._root) return;
      if (name === 'brand' || name === 'fallback') { this._key = null; this._render(); }
      else this._a11y();
    }

    _a11y() {
      var label = this.getAttribute('label');
      if (label && !this.hasAttribute('decorative')) {
        this.setAttribute('role', 'img');
        this.setAttribute('aria-label', label);
        this.removeAttribute('aria-hidden');
      } else {
        this.removeAttribute('role');
        this.removeAttribute('aria-label');
        this.setAttribute('aria-hidden', 'true');
      }
    }

    _render() {
      if (!this._root) return;
      var id = cleanId(this.getAttribute('brand'));
      var theme = currentTheme();
      var key = theme + '/' + id;
      if (this._key === key) return;
      this._want = key;
      var self = this;
      if (!id) { this._swap(key, null); return; }
      if (CACHE.has(key)) { this._swap(key, CACHE.get(key)); return; }
      // Keep the previous glyph until the new one lands so a theme toggle
      // never blinks to empty.
      load(id, theme).then(function (svg) {
        if (self._want === key) self._swap(key, svg);
      });
    }

    _swap(key, svg) {
      this._key = key;
      Array.prototype.slice.call(this._root.querySelectorAll('svg,spaci-icon')).forEach(function (n) { n.remove(); });
      if (svg) { this._root.appendChild(svg.cloneNode(true)); return; }
      var fb = this.hasAttribute('fallback') ? this.getAttribute('fallback') : DEFAULT_FALLBACK;
      if (fb && /^[a-z0-9-]{1,48}$/i.test(fb)) {
        var i = document.createElement('spaci-icon');
        i.setAttribute('name', fb);
        this._root.appendChild(i);
      }
    }
  });

  function refreshAll() { LIVE.forEach(function (n) { n._render(); }); }
  window.addEventListener('sp-themechange', refreshAll);

  // SP.bic(id, size, { label, decorative, fallback, style }) -> element.
  function bic(id, size, opt) {
    opt = opt || {};
    var n = document.createElement('spaci-brand-icon');
    n.setAttribute('brand', id || '');
    n.setAttribute('style', 'width:' + size + 'px;height:' + size + 'px' + (opt.style ? ';' + opt.style : ''));
    if (opt.label) n.setAttribute('label', opt.label);
    if (opt.decorative) n.setAttribute('decorative', '');
    if (opt.fallback != null) n.setAttribute('fallback', opt.fallback);
    return n;
  }

  // ---- which brand a scanned thing belongs to --------------------------
  // Mirrors src/brand-ids.js (BRAND_FOR_TOOL, BRAND_FOR_BROWSER). A null
  // answer means there is no vendored logo, so callers keep their own icon.
  var FOR_TOOL = {
    claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'cursor',
    windsurf: 'windsurf', gemini: 'gemini', grok: 'grok', zed: 'zed',
    copilot: 'github-copilot', 'github-copilot': 'github-copilot',
  };
  var FOR_BROWSER = {
    'browser-chrome': 'chrome', 'browser-safari': 'safari', 'browser-firefox': 'firefox',
    'browser-microsoft-edge': 'edge', 'browser-edge': 'edge', 'browser-brave': 'brave',
    'browser-arc': 'arc',
  };
  var FOR_NAME = [
    [/^claude\b/i, 'claude'], [/^codex\b/i, 'codex'], [/^opencode\b/i, 'opencode'],
    [/^cursor\b/i, 'cursor'], [/^windsurf\b/i, 'windsurf'], [/^gemini\b/i, 'gemini'],
    [/^grok\b/i, 'grok'], [/^zed\b/i, 'zed'], [/^github copilot\b|^copilot\b/i, 'github-copilot'],
    [/^docker\b/i, 'docker'], [/^(google )?chrome\b/i, 'chrome'], [/^firefox\b/i, 'firefox'],
    [/^safari\b/i, 'safari'], [/^(microsoft )?edge\b/i, 'edge'], [/^brave\b/i, 'brave'],
    [/^arc\b/i, 'arc'],
  ];
  // Path fragments that identify an owning app. Separators are normalised to
  // '/' first, so one table covers macOS, Linux and Windows paths.
  // App folders only count under a per-user app data root, so a project that
  // happens to be called "cursor" or "arc" never gets a brand mark.
  var APPDIR = '(?:application support|appdata\\/(?:roaming|local)|\\.config|\\.local\\/share|library\\/caches|\\.cache)\\/';
  var FOR_PATH = [
    [/\/\.claude(\/|$)/i, 'claude'],
    [new RegExp(APPDIR + 'claude(?: code)?(\\/|$)', 'i'), 'claude'],
    [/\/\.codex(\/|$)/i, 'codex'],
    [/\/\.opencode(\/|$)/i, 'opencode'],
    [new RegExp(APPDIR + 'opencode(\\/|$)', 'i'), 'opencode'],
    [/\/\.cursor(\/|$)/i, 'cursor'],
    [new RegExp(APPDIR + 'cursor(\\/|$)', 'i'), 'cursor'],
    [/\/\.windsurf(\/|$)|\/\.codeium\/windsurf/i, 'windsurf'],
    [new RegExp(APPDIR + 'windsurf(\\/|$)', 'i'), 'windsurf'],
    [/\/\.gemini(\/|$)/i, 'gemini'],
    [/\/\.grok(\/|$)/i, 'grok'],
    [/dev\.zed\.zed/i, 'zed'],
    [new RegExp(APPDIR + 'zed(\\/|$)', 'i'), 'zed'],
    [/github-copilot|\/\.copilot(\/|$)/i, 'github-copilot'],
    [/com\.docker\.docker|\/\.docker(\/|$)/i, 'docker'],
    [/google\/chrome|google-chrome|com\.google\.chrome/i, 'chrome'],
    [/\/firefox(\/|$)|\/\.mozilla(\/|$)|org\.mozilla\.firefox/i, 'firefox'],
    [/com\.apple\.safari/i, 'safari'],
    [new RegExp(APPDIR + 'safari(\\/|$)', 'i'), 'safari'],
    [/microsoft edge|microsoft\/edge|microsoft-edge|com\.microsoft\.edgemac/i, 'edge'],
    [/bravesoftware|brave-browser/i, 'brave'],
    [/company\.thebrowser\.browser/i, 'arc'],
    [new RegExp(APPDIR + 'arc(\\/|$)', 'i'), 'arc'],
  ];

  function forTool(tool) {
    var k = typeof tool === 'string' ? tool.toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(FOR_TOOL, k) ? FOR_TOOL[k] : null;
  }
  function forName(name) {
    var s = typeof name === 'string' ? name.trim() : '';
    for (var i = 0; i < FOR_NAME.length; i++) if (FOR_NAME[i][0].test(s)) return FOR_NAME[i][1];
    return null;
  }
  function forPath(p) {
    var s = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
    if (!s) return null;
    for (var i = 0; i < FOR_PATH.length; i++) if (FOR_PATH[i][0].test(s)) return FOR_PATH[i][1];
    return null;
  }
  // A System Cleaner target: AI tools carry `tool`, browsers have a
  // `browser-<name>` id, and the name catches anything else we know.
  function forTarget(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.brand && cleanId(t.brand)) return cleanId(t.brand);
    var byTool = forTool(t.tool) || (t.storyCategory === 'aitools' && typeof t.id === 'string' ? forTool(t.id.split('-')[0]) : null);
    if (byTool) return byTool;
    if (typeof t.id === 'string' && Object.prototype.hasOwnProperty.call(FOR_BROWSER, t.id)) return FOR_BROWSER[t.id];
    return forName(t.name);
  }
  // A recommendation: Docker cards are Docker; cache cards resolve through the
  // target they point at (pass the target list from the scan cache).
  function forRec(r, targets) {
    if (!r || typeof r !== 'object') return null;
    if (r.kind === 'docker' || (r.action && r.action.type === 'docker-prune')) return 'docker';
    var id = r.action && r.action.type === 'select-system' ? r.action.id : null;
    if (id && Array.isArray(targets)) {
      for (var i = 0; i < targets.length; i++) if (targets[i] && targets[i].id === id) return forTarget(targets[i]);
    }
    return null;
  }

  window.SpaciBrandIcon = {
    theme: currentTheme,
    cleanId: cleanId,
    bic: bic,
    forTool: forTool,
    forName: forName,
    forPath: forPath,
    forTarget: forTarget,
    forRec: forRec,
    preload: function (ids) {
      var th = currentTheme();
      return Promise.all((ids || []).map(function (id) { var c = cleanId(id); return c ? load(c, th) : null; }));
    },
  };

  // app.js assigns window.SP wholesale after this script runs, so expose bic
  // through an accessor that decorates whatever object gets assigned.
  var held = window.SP;
  if (held && typeof held === 'object') held.bic = bic;
  Object.defineProperty(window, 'SP', {
    configurable: true,
    enumerable: true,
    get: function () { return held; },
    set: function (v) { held = v; if (v && typeof v === 'object' && !v.bic) v.bic = bic; },
  });
})();
