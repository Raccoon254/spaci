// donut.js — vanilla SVG disk-usage visualizations for the Electron renderer.
// Defines window.diskDonut and window.diskBar. No imports, no framework.
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) {
          el.setAttribute(k, attrs[k]);
        }
      }
    }
    return el;
  }

  // Sum of segment values; fractions are computed against this whole.
  function totalValue(segments) {
    var sum = 0;
    for (var i = 0; i < segments.length; i++) {
      var v = +segments[i].value;
      if (isFinite(v) && v > 0) sum += v;
    }
    return sum;
  }

  // ---- diskDonut -----------------------------------------------------------

  function diskDonut(segments, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : 184;
    var stroke = opts.stroke != null ? opts.stroke : 14;
    var gapDeg = opts.gapDeg != null ? opts.gapDeg : 3;
    var centerHTML = opts.centerHTML != null ? opts.centerHTML : '';
    var onHover = typeof opts.onHover === 'function' ? opts.onHover : null;
    var trackColor = opts.trackColor != null ? opts.trackColor : 'rgba(128,128,128,0.18)';

    segments = segments || [];
    var total = totalValue(segments);

    var cx = size / 2;
    var cy = size / 2;
    var r = size / 2 - stroke / 2 - 1;

    // Point at angle (deg - 90) so 0deg starts at the top, going clockwise.
    function polar(ccx, ccy, rr, deg) {
      var a = (deg - 90) * Math.PI / 180;
      return { x: ccx + rr * Math.cos(a), y: ccy + rr * Math.sin(a) };
    }

    function arcPath(ccx, ccy, rr, a1, a2) {
      var sweep = a2 - a1;
      if (sweep < 0.05) return '';
      if (sweep > 359.99) sweep = 359.99;
      var start = polar(ccx, ccy, rr, a1);
      var end = polar(ccx, ccy, rr, a1 + sweep);
      var largeArc = sweep > 180 ? 1 : 0;
      return 'M ' + start.x + ' ' + start.y +
        ' A ' + rr + ' ' + rr + ' 0 ' + largeArc + ' 1 ' + end.x + ' ' + end.y;
    }

    var wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + size + ' ' + size,
      width: size,
      height: size
    });
    svg.style.display = 'block';

    // Faint full-circle background track.
    svg.appendChild(svgEl('circle', {
      cx: cx,
      cy: cy,
      r: r,
      fill: 'none',
      stroke: trackColor,
      'stroke-width': stroke
    }));

    var arcs = [];
    var cursor = 0; // running angle in degrees

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var frac = total > 0 ? (+seg.value || 0) / total : 0;
      var span = frac * 360 - gapDeg;
      var a1 = cursor + gapDeg / 2;
      var a2 = a1 + (span > 0 ? span : 0);
      cursor += frac * 360;

      var d = arcPath(cx, cy, r, a1, a2);
      if (!d) continue;

      var path = svgEl('path', {
        d: d,
        stroke: seg.color,
        'stroke-width': stroke,
        'stroke-linecap': 'round',
        fill: 'none'
      });
      path.style.cursor = 'pointer';
      svg.appendChild(path);
      arcs.push({ path: path, seg: seg });
    }

    wrap.appendChild(svg);

    var center = document.createElement('div');
    center.className = 'donut-center';
    center.style.position = 'absolute';
    center.style.left = '50%';
    center.style.top = '50%';
    center.style.transform = 'translate(-50%, -50%)';
    center.style.textAlign = 'center';
    center.style.pointerEvents = 'none';
    center.innerHTML = centerHTML;
    wrap.appendChild(center);

    // Animate each arc "drawing" in sequence, then wire hover.
    arcs.forEach(function (entry, i) {
      var path = entry.path;
      var seg = entry.seg;
      var len = path.getTotalLength();
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = len;

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          path.style.transition =
            'stroke-dashoffset .9s cubic-bezier(.22,.61,.36,1) ' + (i * 90) + 'ms, ' +
            'stroke-width .15s ease';
          path.style.strokeDashoffset = 0;
        });
      });

      path.addEventListener('mouseenter', function () {
        path.setAttribute('stroke-width', stroke + 3);
        if (onHover) onHover(seg);
      });
      path.addEventListener('mouseleave', function () {
        path.setAttribute('stroke-width', stroke);
        if (onHover) onHover(null);
      });
    });

    return wrap;
  }

  // ---- diskBar -------------------------------------------------------------

  function diskBar(segments, opts) {
    opts = opts || {};
    var width = opts.width != null ? opts.width : 200;
    var height = opts.height != null ? opts.height : 9;
    var gap = opts.gap != null ? opts.gap : 2;
    var radius = opts.radius != null ? opts.radius : 5;
    var onHover = typeof opts.onHover === 'function' ? opts.onHover : null;
    var trackColor = opts.trackColor != null ? opts.trackColor : 'rgba(128,128,128,0.18)';

    segments = segments || [];
    var total = totalValue(segments);

    var wrap = document.createElement('div');
    wrap.style.width = '100%';

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + height,
      width: '100%',
      height: height,
      preserveAspectRatio: 'none'
    });
    svg.style.display = 'block';

    // Background track behind the segments.
    svg.appendChild(svgEl('rect', {
      x: 0,
      y: 0,
      width: width,
      height: height,
      rx: radius,
      fill: trackColor
    }));

    var n = segments.length;
    var usable = width - gap * (n > 1 ? n - 1 : 0);
    var x = 0;
    var rects = [];

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var frac = total > 0 ? (+seg.value || 0) / total : 0;
      var w = frac * usable;

      var rect = svgEl('rect', {
        x: x,
        y: 0,
        width: 0, // animated to w on mount
        height: height,
        rx: radius,
        fill: seg.color
      });
      rect.style.cursor = 'pointer';
      rect.style.opacity = '0.92';
      svg.appendChild(rect);
      rects.push({ rect: rect, seg: seg, w: w });

      x += w + gap;
    }

    wrap.appendChild(svg);

    // Animate widths in from 0 (x stays fixed), then wire hover.
    rects.forEach(function (entry, i) {
      var rect = entry.rect;
      var seg = entry.seg;

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          rect.style.transition =
            'width .7s cubic-bezier(.22,.61,.36,1) ' + (i * 60) + 'ms, ' +
            'opacity .15s ease';
          rect.setAttribute('width', entry.w);
        });
      });

      rect.addEventListener('mouseenter', function () {
        rect.style.opacity = '1';
        if (onHover) onHover(seg);
      });
      rect.addEventListener('mouseleave', function () {
        rect.style.opacity = '0.92';
        if (onHover) onHover(null);
      });
    });

    return wrap;
  }

  // Guard so re-defining is safe.
  if (!window.diskDonut) window.diskDonut = diskDonut;
  if (!window.diskBar) window.diskBar = diskBar;
})();
