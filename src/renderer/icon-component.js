// The <spaci-icon> custom element, ported from the Spaci v2 design.
//   <spaci-icon name="refresh"></spaci-icon>          named icon (SPACI_ICONS)
//   <spaci-icon name="node" kind="logo"></spaci-icon> brand/language logo (SPACI_LOGOS)
//   <spaci-icon name="spaci-ring" anim="orbit"></spaci-icon>  the Spaci ring mark
// anim variants for the ring: orbit | spin | breathe | chase | assemble | clearing | wave.
// Colour follows currentColor. SPACI_ICONS / SPACI_LOGOS come from spaci-icons.js.
(function () {
  if (customElements.get('spaci-icon')) return;
  customElements.define(
    'spaci-icon',
    class extends HTMLElement {
      static get observedAttributes() {
        return ['name', 'kind', 'anim'];
      }
      connectedCallback() {
        if (!this._root) this._root = this.attachShadow({ mode: 'open' });
        this._r();
      }
      attributeChangedCallback() {
        this._r();
      }
      _r() {
        if (!this._root) return;
        var name = this.getAttribute('name') || 'box';
        if (name === 'spaci-ring') {
          var anim = this.getAttribute('anim') || '';
          var svgA = '';
          var segA = function () {
            return '';
          };
          if (anim === 'orbit') {
            svgA = 'animation:sp-spin 9s linear infinite';
            segA = function () {
              return 'animation:sp-counter 4.5s linear infinite';
            };
          } else if (anim === 'spin') {
            svgA = 'animation:sp-spin 1.15s linear infinite';
            segA = function (i) {
              return 'opacity:' + (0.28 + i * 0.13);
            };
          } else if (anim === 'breathe') {
            svgA = 'animation:sp-breathe 3.4s ease-in-out infinite';
          } else if (anim === 'chase') {
            segA = function (i) {
              return 'animation:sp-chase 1.9s ' + (i * 0.31).toFixed(2) + 's ease-in-out infinite';
            };
          } else if (anim === 'assemble') {
            segA = function (i) {
              return 'animation:sp-assemble 3s ' + (i * 0.11).toFixed(2) + 's ease-in-out infinite';
            };
          } else if (anim === 'clearing') {
            segA = function (i) {
              return 'animation:sp-explode 2.7s ' + (i * 0.05).toFixed(2) + 's ease-in-out infinite';
            };
          } else if (anim === 'wave') {
            segA = function (i) {
              return 'animation:sp-wave 1.7s ' + (i * 0.2).toFixed(2) + 's ease-in-out infinite';
            };
          }
          var s = '';
          for (var k = 0; k < 6; k++) {
            s +=
              '<g transform="rotate(' +
              k * 60 +
              ' 50 50)"><ellipse cx="50" cy="22" rx="12" ry="5.5" fill="currentColor" style="transform-box:fill-box;transform-origin:center;' +
              segA(k) +
              '"></ellipse></g>';
          }
          this._root.innerHTML =
            '<svg viewBox="15 15 70 70" style="width:100%;height:100%;display:block;overflow:visible;transform-origin:center;' +
            svgA +
            '">' +
            s +
            '</svg>';
          return;
        }
        var kind = this.getAttribute('kind') || 'icon';
        var map = kind === 'logo' ? window.SPACI_LOGOS || {} : window.SPACI_ICONS || {};
        var d = map[name] || (window.SPACI_ICONS || {})['box'];
        var body = d ? (d.p || '').replace(/opacity="(?:0?\.[0-5]\d*)"/g, 'opacity="0.72"') : '';
        this._root.innerHTML = d
          ? '<svg viewBox="' + d.v + '" fill="none" style="width:100%;height:100%;display:block">' + body + '</svg>'
          : '';
      }
    }
  );
})();
