// <spaci-tech-icon>: language, framework and tool marks from the vendored
// Catppuccin set (src/renderer/icons/tech/<flavor>/<id>.svg, read through
// api.techIcon). The dark theme uses the `mocha` flavor, the light theme
// `latte`, and every live instance swaps flavor when the theme toggles.
//
//   <spaci-tech-icon tech="react" label="React" style="width:16px;height:16px">
//
// Attributes:
//   tech        canonical tech id (see src/tech-ids.js). Unknown or missing
//               ids fall back to the generic `file` mark.
//   label       accessible name. Sets role="img" + aria-label.
//   decorative  present when visible text next to the icon already names it;
//               the icon is then hidden from assistive tech.
//
// Size comes from the host's width/height. The box is fixed before the SVG
// arrives, so a first paint never shifts layout.
//
// Trust: the SVG text comes from our own vendored files, but ids and names
// originate on disk. Ids are validated before they reach IPC and labels are only
// ever set as attributes. The SVG is parsed with DOMParser (never innerHTML),
// scripts and event attributes are stripped as a precaution, and each icon
// lives in its own shadow root so ids inside one file cannot clash with another.
(function () {
  if (customElements.get('spaci-tech-icon')) return;

  var ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var FALLBACK = 'file';
  var CACHE = new Map();   // 'mocha/react' -> parsed <svg> element, or null
  var PENDING = new Map(); // 'mocha/react' -> Promise
  var LIVE = new Set();    // connected instances, re-rendered on theme change
  var SHADOW_CSS = ':host{display:inline-flex;line-height:0;flex:none}svg{display:block;width:100%;height:100%}';

  function currentFlavor() {
    var S = window.SP && window.SP.state;
    var theme = S && S.theme;
    if (!theme) {
      var root = document.getElementById('app') || document.getElementById('tray');
      theme = root && root.classList.contains('light') ? 'light' : 'dark';
    }
    return theme === 'light' ? 'latte' : 'mocha';
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
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return document.importNode(svg, true);
  }

  function fetchSvg(id, flavor) {
    var api = window.api;
    if (!api || typeof api.techIcon !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(function () { return api.techIcon(id, flavor); }).catch(function () { return null; });
  }

  // Resolves to a parsed <svg> (shared template, clone before use) or null.
  // Each flavor/id pair is requested once; a missing id resolves to `file`.
  function load(id, flavor) {
    var key = flavor + '/' + id;
    if (CACHE.has(key)) return Promise.resolve(CACHE.get(key));
    if (PENDING.has(key)) return PENDING.get(key);
    var p = fetchSvg(id, flavor).then(function (text) {
      var parsed = parseSvg(text);
      if (!parsed && id !== FALLBACK) return load(FALLBACK, flavor);
      return parsed;
    }).then(function (svg) {
      CACHE.set(key, svg || null);
      PENDING.delete(key);
      return svg || null;
    });
    PENDING.set(key, p);
    return p;
  }

  customElements.define('spaci-tech-icon', class extends HTMLElement {
    static get observedAttributes() { return ['tech', 'label', 'decorative']; }

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
      if (name !== 'tech') this._a11y();
      else this._render();
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
      var id = cleanId(this.getAttribute('tech')) || FALLBACK;
      var flavor = currentFlavor();
      var key = flavor + '/' + id;
      if (this._key === key) return;
      this._want = key;
      var self = this;
      if (CACHE.has(key)) { this._swap(key, CACHE.get(key)); return; }
      // Keep the previous glyph until the new one lands, so a theme toggle
      // never blinks to empty. A first paint stays empty inside a fixed box.
      load(id, flavor).then(function (svg) {
        if (self._want === key) self._swap(key, svg);
      });
    }

    _swap(key, svg) {
      this._key = key;
      var old = this._root.querySelector('svg');
      if (old) old.remove();
      if (svg) this._root.appendChild(svg.cloneNode(true));
    }
  });

  function refreshAll() { LIVE.forEach(function (n) { n._render(); }); }
  window.addEventListener('sp-themechange', refreshAll);

  // ---- which tech a cleanable thing belongs to --------------------------
  // Package manager of a project, from the enrich step's lockfile evidence
  // (frameworks[] carries npm / yarn / pnpm / bun as tool ids).
  var MANAGERS = ['pnpm', 'yarn', 'bun', 'npm'];
  function managerOf(project, enrich) {
    var list = (enrich && Array.isArray(enrich.frameworks) ? enrich.frameworks : [])
      .concat(project && Array.isArray(project.frameworks) ? project.frameworks : []);
    for (var i = 0; i < MANAGERS.length; i++) {
      for (var j = 0; j < list.length; j++) {
        var f = list[j];
        if (f && typeof f === 'object' && f.id === MANAGERS[i]) return MANAGERS[i];
      }
    }
    return null;
  }
  function stackOf(project, enrich) {
    var ids = [];
    var pr = (enrich && enrich.primary) || (project && project.primary);
    if (pr && typeof pr.id === 'string') ids.push(pr.id);
    if (project && project.type && typeof project.type.id === 'string') ids.push(project.type.id);
    (enrich && Array.isArray(enrich.frameworks) ? enrich.frameworks : []).forEach(function (f) {
      if (f && typeof f.id === 'string') ids.push(f.id);
    });
    (enrich && Array.isArray(enrich.languages) ? enrich.languages : []).forEach(function (l) {
      if (l && typeof l.id === 'string') ids.push(l.id);
    });
    return ids;
  }
  function has(ids, want) { for (var i = 0; i < want.length; i++) if (ids.indexOf(want[i]) >= 0) return want[i]; return null; }

  // Artifact folder name -> tech mark. Folders shared by several ecosystems
  // (target, build, vendor, dist) look at the project's stack to decide.
  // Returns a tech id, or null when nothing fits (the caller keeps its icon).
  // Catppuccin has no CocoaPods mark, so Pods uses the iOS one.
  function forArtifact(item, project, enrich) {
    var name = item && typeof item.name === 'string' ? item.name : '';
    var ids = stackOf(project, enrich);
    switch (name) {
      case 'node_modules': return managerOf(project, enrich) || 'npm';
      case '.next': return 'nextjs';
      case '.nuxt': case '.output': return 'nuxt';
      case '.turbo': return 'turbo';
      case '.svelte-kit': return 'sveltekit';
      case '.angular': return 'angular';
      case '.gradle': return 'gradle';
      case '__pycache__': case '.mypy_cache': case '.ruff_cache': case 'venv': case '.venv': return 'python';
      case '.pytest_cache': return 'pytest';
      case '.dart_tool': return 'dart';
      case 'Pods': return 'ios';
      case 'DerivedData': return 'xcode';
      case '.terraform': return 'terraform';
      case 'obj': return 'dotnet';
      case 'target': return has(ids, ['rust']) || has(ids, ['maven', 'java', 'kotlin', 'scala', 'spring', 'spring-boot']) || 'rust';
      case 'build': return has(ids, ['flutter', 'android', 'gradle']) || (has(ids, ['kotlin', 'java']) ? 'gradle' : null) || has(ids, ['react', 'vite']) || null;
      case 'vendor': return has(ids, ['php', 'laravel', 'symfony']) ? 'php' : has(ids, ['go']) ? 'go' : has(ids, ['ruby', 'rails']) ? 'ruby' : 'php';
      case 'dist': case 'out': return has(ids, ['vite', 'webpack', 'rollup', 'esbuild', 'nextjs', 'typescript', 'javascript', 'node']) || null;
      default: break;
    }
    // Older scans only carry the rule's kind.
    var KIND = { node: 'npm', python: 'python', flutter: 'dart', php: 'php', gradle: 'gradle', java: 'java', svelte: 'sveltekit' };
    var k = item && typeof item.kind === 'string' ? item.kind : '';
    return Object.prototype.hasOwnProperty.call(KIND, k) ? KIND[k] : null;
  }

  // System Cleaner developer caches -> tech mark (ids from storage-classifier).
  var FOR_TARGET = {
    npm: 'npm', yarn: 'yarn', pnpm: 'pnpm', bun: 'bun', deno: 'deno',
    gradle: 'gradle', 'gradle-wrapper': 'gradle', maven: 'maven', nuget: 'dotnet',
    cargo: 'cargo', cocoapods: 'ios', pub: 'flutter', 'dart-server': 'dart',
    pip: 'python', go: 'go',
    'xcode-derived': 'xcode', 'xcode-archives': 'xcode', 'xcode-devicesupport': 'xcode', 'simulator-caches': 'xcode',
  };
  function forTarget(t) {
    var id = t && typeof t.id === 'string' ? t.id : '';
    return Object.prototype.hasOwnProperty.call(FOR_TARGET, id) ? FOR_TARGET[id] : null;
  }

  // Small public surface for screens: warm the cache for a set of ids (so a
  // long list swaps in together) and read the current flavor.
  window.SpaciTechIcon = {
    flavor: currentFlavor,
    cleanId: cleanId,
    managerOf: managerOf,
    forArtifact: forArtifact,
    forTarget: forTarget,
    preload: function (ids) {
      var fl = currentFlavor();
      return Promise.all((ids || []).map(function (id) { return load(cleanId(id) || FALLBACK, fl); }));
    },
  };
})();
