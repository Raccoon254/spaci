// Spaci icon custom element: renders currentColor two-tone icons, brand logos,
// and the animated 6-segment "spaci-ring" mark. Ported verbatim from the Spaci
// v2 design's spaci-ring.js. Keyframes are injected into the shadow DOM so the
// ring animations resolve inside the closed icon tree.
(function () {
  if (customElements.get('spaci-icon')) return;
  var KF = '@keyframes sp-spin{to{transform:rotate(360deg)}}'
    + '@keyframes sp-counter{to{transform:rotate(-360deg)}}'
    + '@keyframes sp-breathe{0%,100%{transform:scale(.94)}50%{transform:scale(1.04)}}'
    + '@keyframes sp-chase{0%{opacity:.16}10%{opacity:1}30%{opacity:.16}100%{opacity:.16}}'
    + '@keyframes sp-wave{0%{transform:scale(1);opacity:.4}25%{transform:scale(1.5);opacity:1}50%{transform:scale(1);opacity:.4}100%{transform:scale(1);opacity:.4}}'
    + '@keyframes sp-assemble{0%{opacity:0;transform:translateY(-16px) scale(.5)}28%{opacity:1;transform:translateY(0) scale(1)}82%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-16px) scale(.5)}}'
    + '@keyframes sp-explode{0%{transform:translateY(0) scale(1);opacity:1}42%{transform:translateY(-18px) scale(.35);opacity:0}58%{transform:translateY(-18px) scale(.35);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}'
    + '@keyframes sp-spiral{0%{opacity:0;transform:scale(0) rotate(-120deg)}40%{opacity:1;transform:scale(1) rotate(0)}82%{opacity:1;transform:scale(1) rotate(0)}100%{opacity:0;transform:scale(0) rotate(120deg)}}'
    + '@keyframes sp-twirl{to{transform:rotate(360deg)}}'
    + '@keyframes sp-heartbeat{0%,42%,100%{transform:scale(1)}14%{transform:scale(1.16)}28%{transform:scale(1.04)}}'
    + '@keyframes sp-elastic{0%{transform:scale(0);opacity:0}30%{transform:scale(1.18);opacity:1}44%{transform:scale(.94)}56%{transform:scale(1.02)}66%{transform:scale(1)}86%{transform:scale(1);opacity:1}100%{transform:scale(0);opacity:0}}'
    + '@keyframes sp-swing{0%,100%{transform:rotate(-13deg)}50%{transform:rotate(13deg)}}'
    + '@keyframes sp-bloom{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}'
    + '@keyframes sp-shimmerseg{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}';
  customElements.define('spaci-icon', class extends HTMLElement {
    static get observedAttributes() { return ['name', 'kind', 'anim']; }
    connectedCallback() { if (!this._root) { this._root = this.attachShadow({ mode: 'open' }); } this._r(); }
    attributeChangedCallback() { this._r(); }
    _r() {
      if (!this._root) return;
      var name = this.getAttribute('name') || 'box';
      if (name === 'spaci-ring') {
        var anim = this.getAttribute('anim') || '';
        var svgA = '', segA = function () { return ''; };
        if (anim === 'orbit') { svgA = 'animation:sp-spin 9s linear infinite'; segA = function () { return 'animation:sp-counter 4.5s linear infinite'; }; }
        else if (anim === 'spin') { svgA = 'animation:sp-spin 1.15s linear infinite'; segA = function (i) { return 'opacity:' + (0.28 + i * 0.13); }; }
        else if (anim === 'breathe') { svgA = 'animation:sp-breathe 3.4s ease-in-out infinite'; }
        else if (anim === 'chase') { segA = function (i) { return 'animation:sp-chase 1.9s ' + (i * 0.31).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'assemble') { segA = function (i) { return 'animation:sp-assemble 3s ' + (i * 0.11).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'clearing') { segA = function (i) { return 'animation:sp-explode 2.7s ' + (i * 0.05).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'wave') { segA = function (i) { return 'animation:sp-wave 1.7s ' + (i * 0.2).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'spiral') { svgA = 'animation:sp-spin 7s linear infinite'; segA = function (i) { return 'animation:sp-spiral 3.4s ' + (i * 0.12).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'aperture') { segA = function () { return 'animation:sp-twirl 3.2s linear infinite'; }; }
        else if (anim === 'heartbeat') { svgA = 'animation:sp-heartbeat 1.7s ease-in-out infinite'; }
        else if (anim === 'elastic') { segA = function (i) { return 'animation:sp-elastic 3.1s ' + (i * 0.1).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'swing') { svgA = 'animation:sp-swing 2.5s ease-in-out infinite'; }
        else if (anim === 'cascade') { segA = function (i) { return 'animation:sp-bloom 2.3s ' + (i * 0.16).toFixed(2) + 's ease-in-out infinite'; }; }
        else if (anim === 'shimmer') { segA = function (i) { return 'animation:sp-shimmerseg 2.3s ' + (i * 0.18).toFixed(2) + 's ease-in-out infinite'; }; }
        var s = '';
        for (var k = 0; k < 6; k++) {
          s += '<g transform="rotate(' + (k * 60) + ' 50 50)"><ellipse cx="50" cy="22" rx="12" ry="5.5" fill="currentColor" style="transform-box:fill-box;transform-origin:center;' + segA(k) + '"></ellipse></g>';
        }
        this._root.innerHTML = '<style>' + KF + '</style><svg viewBox="15 15 70 70" style="width:100%;height:100%;display:block;overflow:visible;transform-origin:center;' + svgA + '">' + s + '</svg>';
        return;
      }
      var kind = this.getAttribute('kind') || 'icon';
      // Brand/language logos stay inline (small set, loaded from spaci-logo.js).
      if (kind === 'logo') {
        var lmap = window.SPACI_LOGOS || {};
        var ld = lmap[name];
        var lbody = ld ? (ld.p || '').replace(/opacity="(?:0?\.[0-5]\d*)"/g, 'opacity="0.72"') : '';
        this._root.innerHTML = ld ? '<svg viewBox="' + ld.v + '" fill="none" style="width:100%;height:100%;display:block">' + lbody + '</svg>' : '';
        return;
      }
      // Two-tone UI icons load their SVG file from src/renderer/icons/<name>.svg
      // (via the icon:get IPC handler). Each name is fetched once and cached, so
      // the first paint of a name is async (placeholder, then swap) and every
      // later paint is synchronous with no flash.
      var cached = ICON_CACHE.get(name);
      if (cached !== undefined) { this._root.innerHTML = wrap(cached); return; }
      // Not loaded yet: render an empty placeholder, then resolve and swap in.
      this._root.innerHTML = '';
      var self = this;
      var want = name;
      loadIcon(name).then(function (svg) {
        if (!self._root) return;
        // Skip the swap if the attribute changed to a different name meanwhile.
        if ((self.getAttribute('name') || 'box') !== want) return;
        self._root.innerHTML = wrap(svg);
      });
    }
  });

  // name -> { v: viewBox, p: inner svg html } | null, populated on first load.
  var ICON_CACHE = new Map();
  var ICON_PENDING = new Map();

  // Wraps a parsed icon into the themed two-tone <svg>, matching the previous
  // inline behavior (secondary paths nudged to opacity 0.72 for the two-tone).
  function wrap(d) {
    if (!d) return '';
    var body = (d.p || '').replace(/opacity="(?:0?\.[0-5]\d*)"/g, 'opacity="0.72"');
    return '<svg viewBox="' + d.v + '" fill="none" style="width:100%;height:100%;display:block">' + body + '</svg>';
  }

  // Pulls the SVG file once per name (de-duping concurrent requests), parses out
  // the viewBox + inner markup, and stores the result (or null) in the cache.
  function loadIcon(name) {
    if (ICON_PENDING.has(name)) return ICON_PENDING.get(name);
    var p = Promise.resolve()
      .then(function () {
        return (window.api && window.api.iconSvg) ? window.api.iconSvg(name) : null;
      })
      .then(function (text) {
        // Missing file: fall back to the generic 'box' glyph rather than render
        // a blank hole (covers any icon name without its own SVG file).
        if (!text && name !== 'box') {
          return loadIcon('box').then(function (boxParsed) {
            ICON_CACHE.set(name, boxParsed);
            ICON_PENDING.delete(name);
            return boxParsed;
          });
        }
        var parsed = parseSvg(text);
        ICON_CACHE.set(name, parsed);
        ICON_PENDING.delete(name);
        return parsed;
      })
      .catch(function () {
        ICON_CACHE.set(name, null);
        ICON_PENDING.delete(name);
        return null;
      });
    ICON_PENDING.set(name, p);
    return p;
  }

  // Extracts { v: viewBox, p: inner html } from a standalone <svg> file string.
  function parseSvg(text) {
    if (!text) return null;
    var vb = text.match(/viewBox="([^"]+)"/);
    var inner = text.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    return { v: vb ? vb[1] : '0 0 24 24', p: inner };
  }
})();
