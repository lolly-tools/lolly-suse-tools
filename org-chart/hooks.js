/* global onInit, onInput, host */

/**
 * Org Chart — cards on an open canvas, joined by connector lines that route between
 * them and stick to the boxes.
 *
 * Two flat inputs drive the render:
 *   • `boxes`       — one row per card (geometry + a `layout` that arranges its photo/
 *                     icon + text: row = headshot left, icon = icon chip left,
 *                     stacked = photo on top, plain = a bare box like Layout Studio).
 *   • `connectors`  — one row per edge {from, to, style, arrow, dash, color, width}.
 *
 * The direct-manipulation overlay (drag / resize / connect / snap-to-grid / auto-layout)
 * lives in the web shell (shells/web/src/views/free-canvas.js) and only ever writes
 * these two flat arrays back through the normal input path — so the engine, the URL and
 * the CLI never see the editor, and a headless render of the same state is identical.
 *
 * This hook is PURE (no DOM, no async). Handlebars is logic-less, so we precompute:
 *   - per-box inline CSS (boxStyle/textStyle) + media/avatar HTML (mediaHtml),
 *   - ONE artboard-sized inline <svg> of connector paths (connectorSvg),
 * and expose them as `extras` the template applies. Running here (not in the template)
 * means the CLI produces the same output as the browser.
 *
 * The connector <svg> is drawn with EXPORT-SAFE geometry only: rounded elbows as a
 * single <path> (M/L/Q), arrowheads as filled <path> triangles (never <marker>/<polygon>),
 * and dashed/dotted runs as REAL <line> segments (never stroke-dasharray) — because the
 * PDF/EMF vector walkers drop markers, polygons and dasharrays. Colours are attribute
 * values, never CSS classes/gradients, so the whole layer survives PNG + SVG + PDF.
 */

// Artboard coordinate space — MUST match render.width/height in tool.json. The
// connector <svg> uses this as its viewBox so path coords equal card x/y/w/h 1:1.
var CW = 1600, CH = 1000;

function inputsFrom(model) {
  var o = {};
  (model || []).forEach(function (i) { o[i.id] = i.value; });
  return o;
}
function num(v, d) { var x = typeof v === 'number' ? v : parseFloat(v); return isFinite(x) ? x : d; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function f2(v) { return Math.round(v * 100) / 100; }

function safeColor(v, fallback) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s)) return s;
  return fallback;
}
function boolVal(v, dflt) {
  if (v === true || v === false) return v;
  if (v == null || v === '') return dflt;
  var s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return dflt;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── semi-rich text (same tiny markdown subset as Layout Studio) ────────────────────
function inlineMd(s) {
  s = s.replace(/\\\*/g, '\x01').replace(/\\_/g, '\x02');
  s = s.replace(/\{([^|{}]+)\|([^{}]*)\}/g, function (whole, attrs, inner) {
    var styles = [], deco = [], toks = attrs.trim().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      if (/^#[0-9a-fA-F]{3,8}$/.test(tok)) { var c = safeColor(tok, ''); if (!c) return whole; styles.push('color:' + c); }
      else if (/^w[1-9]00$/.test(tok)) { styles.push('font-weight:' + tok.slice(1)); }
      else if (tok === 'mono' || tok === 'suse') { styles.push('font-family:' + fontFamily(tok === 'mono' ? 'SUSE Mono' : 'SUSE')); }
      else if (tok === 'u') { deco.push('underline'); }
      else if (tok === 's') { deco.push('line-through'); }
      else { return whole; }
    }
    if (deco.length) styles.push('text-decoration:' + deco.join(' '));
    return styles.length ? '<span style="' + styles.join(';') + '">' + inner + '</span>' : whole;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s.replace(/\x01/g, '*').replace(/\x02/g, '_');
}
function richText(raw) {
  return esc(raw).split('\n').map(function (ln) {
    var mb = ln.match(/^(\s*)[-*•]\s+(.*)$/);
    if (mb) return mb[1] + '•  ' + inlineMd(mb[2]);
    var mo = ln.match(/^(\s*)(\d{1,3})\.\s+(.*)$/);
    if (mo) return mo[1] + mo[2] + '.  ' + inlineMd(mo[3]);
    return inlineMd(ln);
  }).join('\n');
}
// Plain text of the FIRST line (markdown stripped) — used to derive avatar initials.
function firstLinePlain(text) {
  var first = String(text == null ? '' : text).split('\n')[0] || '';
  return first
    .replace(/\{[^|{}]*\|([^{}]*)\}/g, '$1')   // attribute runs → their inner text
    .replace(/[*_`>#~]/g, '')                    // markdown markers
    .replace(/\s+/g, ' ').trim();
}
function initialsFrom(text) {
  var words = firstLinePlain(text).split(' ').filter(Boolean);
  if (!words.length) return '';
  var a = words[0].charAt(0);
  var b = words.length > 1 ? words[words.length - 1].charAt(0) : '';
  return (a + b).toUpperCase();
}

// ── colour helpers ────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  var s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6,8}$/.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
// Legible ink (dark or white) for text sitting on `bg`. Understands #hex and rgb()/
// rgba(); for any other valid-but-unparseable colour (e.g. a CSS named colour) it
// defaults to dark ink, which reads on the typical light/mid accent chips.
function inkOn(bg) {
  var c = hexToRgb(bg);
  if (!c) {
    var m = String(bg == null ? '' : bg).match(/^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/i);
    if (m) c = { r: +m[1], g: +m[2], b: +m[3] };
  }
  if (!c) return '#0c322c';
  var lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return lum > 0.62 ? '#0c322c' : '#ffffff';
}

function radiusFor(shape, radius) {
  switch (shape) {
    case 'rounded': return Math.max(0, num(radius, 0)) + 'px';
    case 'pill': return '9999px';
    case 'ellipse': return '50%';
    default: return '0';
  }
}
var H_JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' };
var V_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
function weightOf(b) {
  var w = clamp(Math.round(num(b.weight, 600) / 100) * 100, 100, 900);
  if (String(b.font) === 'SUSE Mono' && w > 800) w = 800;
  return String(w);
}
var FONTS = {
  'SUSE Mono': "'SUSE Mono', ui-monospace, SFMono-Regular, monospace",
  'SUSE': "'SUSE', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};
function fontFamily(v) { return FONTS[String(v)] || FONTS.SUSE; }
var FITS = { cover: 1, contain: 1, fill: 1, none: 1, 'scale-down': 1 };
var OBJPOS = {
  center: 1, 'center top': 1, 'center bottom': 1, 'left center': 1, 'right center': 1,
  'left top': 1, 'right top': 1, 'left bottom': 1, 'right bottom': 1,
  top: 1, bottom: 1, left: 1, right: 1,
};
var BLENDS = { multiply: 1, screen: 1, overlay: 1, darken: 1, lighten: 1 };

// Which layout a box uses. Non-card kinds are always 'plain'.
function layoutOf(b) {
  if (String(b.kind || 'card') !== 'card') return 'plain';
  var L = String(b.layout || 'row');
  return (L === 'row' || L === 'icon' || L === 'stacked' || L === 'plain') ? L : 'row';
}

function typeFeatureCss(b) {
  var track = clamp(num(b.tracking, 0), -100, 400);
  var ligOff = !boolVal(b.ligatures, true);
  var altOn = boolVal(b.alternates, false);
  var feat = [];
  if (ligOff) feat.push('"liga" 0', '"clig" 0');
  if (altOn) feat.push('"salt" 1');
  return (track ? 'letter-spacing:' + f2(track) + 'px;' : '') + (feat.length ? 'font-feature-settings:' + feat.join(', ') + ';' : '');
}

// ── box (card) CSS ─────────────────────────────────────────────────────────────────
function boxCss(b, layout) {
  var x = Math.round(num(b.x, 0)), y = Math.round(num(b.y, 0));
  var w = Math.max(1, Math.round(num(b.w, 1))), h = Math.max(1, Math.round(num(b.h, 1)));
  var rot = num(b.rot, 0);
  var op = clamp(num(b.opacity, 100), 0, 100) / 100;
  var fill = safeColor(b.bg, layout === 'plain' ? 'transparent' : '#ffffff');
  var blend = BLENDS[String(b.blend)] === 1 ? String(b.blend) : '';
  var css =
    'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;' +
    (rot ? 'transform:rotate(' + (Math.round(rot * 10) / 10) + 'deg);' : '') +
    (op !== 1 ? 'opacity:' + op + ';' : '') +
    (blend ? 'mix-blend-mode:' + blend + ';' : '') +
    'background:' + fill + ';' +
    'border-radius:' + radiusFor(b.shape, b.radius) + ';';
  if (layout === 'plain') {
    return css +
      'justify-content:' + (H_JUSTIFY[b.align] || 'center') + ';' +
      'align-items:' + (V_ALIGN[b.valign] || 'center') + ';';
  }
  // Card: flex container laying out the avatar beside/above the text.
  var pad = Math.round(clamp(num(b.pad, 16), 0, 400));
  var gap = clamp(Math.round(pad * 0.9), 6, 20);
  if (layout === 'stacked') {
    return css + 'flex-direction:column;align-items:stretch;justify-content:flex-start;gap:' + gap + 'px;padding:' + pad + 'px;';
  }
  return css + 'flex-direction:row;align-items:' + (V_ALIGN[b.valign] || 'center') + ';justify-content:flex-start;gap:' + gap + 'px;padding:' + pad + 'px;';
}

function textCss(b, layout) {
  var size = Math.max(1, Math.round(num(b.fontSize, 30)));
  var align = layout === 'stacked' ? (H_JUSTIFY[b.align] ? b.align : 'center')
    : (layout === 'plain' ? (H_JUSTIFY[b.align] ? b.align : 'center') : (H_JUSTIFY[b.align] ? b.align : 'left'));
  var css =
    'text-align:' + align + ';' +
    'color:' + safeColor(b.fg, '#0c322c') + ';' +
    'font-family:' + fontFamily(b.font) + ';' +
    'font-size:' + size + 'px;' +
    'font-weight:' + weightOf(b) + ';' +
    'line-height:' + clamp(num(b.lineHeight, 1.15), 0.5, 4) + ';' +
    typeFeatureCss(b);
  if (layout === 'plain') {
    var pad = Math.round(clamp(num(b.pad, 8), 0, 400));
    return css + 'padding:' + pad + 'px;';
  }
  // Card: the text is a flex child that takes the space beside/below the avatar.
  return css + 'padding:0;width:auto;flex:1 1 auto;min-width:0;';
}

// ── media / avatar ──────────────────────────────────────────────────────────────────
function imgObjCss(b, fitOverride) {
  var fit = fitOverride || (FITS[String(b.fit)] === 1 ? String(b.fit) : 'contain');
  var pos = String(b.imgpos == null ? '' : b.imgpos).trim();
  return 'object-fit:' + fit + ';' + (OBJPOS[pos] === 1 && pos !== 'center' ? 'object-position:' + pos + ';' : '');
}
// The <img>/<video>/lottie element for a box's image. `cls` + `extraStyle` let it serve
// both the plain absolute-fill case and the card avatar (a sized flex child).
function mediaEl(b, cls, extraStyle, fitOverride) {
  var img = b && b.image;
  var url = img && img.url ? String(img.url) : '';
  if (!url) return '';
  var isLottie = (img && img.type === 'lottie') || /\.json($|\?|#)/i.test(url);
  var isVideo = (img && img.type === 'video') || /\.(mp4|m4v|mov|webm)($|\?|#)/i.test(url);
  var style = imgObjCss(b, fitOverride) + (extraStyle || '');
  if (isLottie) {
    var lfit = (fitOverride || String(b.fit)) === 'cover' ? 'cover' : 'contain';
    return '<div class="' + cls + ' lolly-box-lottie" data-lottie-src="' + esc(url) +
      '" data-lottie-loop="1" data-lottie-autoplay="1" data-lottie-fit="' + lfit + '" style="' + style + '"></div>';
  }
  if (isVideo) {
    var vkey = b && b.id != null ? esc(String(b.id)) : esc(url);
    return '<video class="' + cls + '" src="' + esc(url) + '" data-video-key="' + vkey +
      '" muted loop autoplay playsinline style="' + style + '"></video>';
  }
  return '<img class="' + cls + '" src="' + esc(url) + '" style="' + style + '" alt="" draggable="false">';
}

function avatarHtml(b, layout) {
  var pad = Math.round(clamp(num(b.pad, 16), 0, 400));
  var w = Math.max(1, Math.round(num(b.w, 1))), h = Math.max(1, Math.round(num(b.h, 1)));
  var accent = safeColor(b.accent, '#30ba78');
  var url = b && b.image && b.image.url ? String(b.image.url) : '';
  var hasImg = !!url;

  if (layout === 'stacked') {
    var bandH = clamp(Math.round((h - 2 * pad) * 0.55), 36, Math.max(36, h - 2 * pad - 24));
    var br = Math.round(clamp(num(b.radius, 12), 0, 60) * 0.7);
    var wrap = 'height:' + bandH + 'px;width:100%;border-radius:' + br + 'px;background:' + (hasImg ? 'transparent' : accent) + ';';
    var inner = hasImg ? mediaEl(b, 'oc-avatar-img', 'position:absolute;inset:0;width:100%;height:100%;', 'cover')
      : initialsHtml(b, accent, Math.round(bandH * 0.42));
    return '<div class="oc-avatar" style="' + wrap + '">' + inner + '</div>';
  }

  var side, radius, fit;
  if (layout === 'icon') {
    side = clamp(Math.min(h - 2 * pad, 56), 20, 72);
    radius = Math.round(side * 0.28) + 'px';
    fit = FITS[String(b.fit)] === 1 ? String(b.fit) : 'contain';   // icons: don't crop by default
  } else { // row (headshot)
    side = clamp(h - 2 * pad, 24, Math.min(h, Math.floor(w * 0.5)));
    radius = '50%';
    fit = 'cover';
  }
  var wrap2 = 'width:' + side + 'px;height:' + side + 'px;border-radius:' + radius + ';background:' + (hasImg ? 'transparent' : accent) + ';';
  var inner2 = hasImg ? mediaEl(b, 'oc-avatar-img', 'width:100%;height:100%;', fit)
    : initialsHtml(b, accent, Math.round(side * 0.42));
  return '<div class="oc-avatar" style="' + wrap2 + '">' + inner2 + '</div>';
}
function initialsHtml(b, accent, size) {
  var ini = initialsFrom(b && b.text);
  if (!ini) return '';
  return '<span class="oc-initials" style="color:' + inkOn(accent) + ';font-size:' + size + 'px">' + esc(ini) + '</span>';
}

// The media markup for a box: an absolute-fill image (plain) or a card avatar.
function mediaFor(b, layout) {
  if (layout === 'plain') return mediaEl(b, 'lolly-box-img', '', null);
  return avatarHtml(b, layout);
}

// ── connector routing (export-safe geometry) ────────────────────────────────────────
// Ray-cast from a box centre toward a target; clamp to the rectangle edge.
function borderPoint(a, tx, ty) {
  var dx = tx - a.cx, dy = ty - a.cy;
  if (dx === 0 && dy === 0) return { x: a.cx, y: a.cy };
  var sx = dx !== 0 ? a.hw / Math.abs(dx) : Infinity;
  var sy = dy !== 0 ? a.hh / Math.abs(dy) : Infinity;
  var t = Math.min(sx, sy);
  return { x: a.cx + dx * t, y: a.cy + dy * t };
}
function anchorOf(r) { return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, hw: r.w / 2, hh: r.h / 2 }; }
function nested(a, b) {
  function inside(o, i) {
    return (o.cx - o.hw <= i.cx - i.hw + 0.5) && (i.cx + i.hw <= o.cx + o.hw + 0.5)
      && (o.cy - o.hh <= i.cy - i.hh + 0.5) && (i.cy + i.hh <= o.cy + o.hh + 0.5);
  }
  return inside(a, b) || inside(b, a);
}
// Where the perpendicular cross-over sits along the gap, per elbow style.
function elbowFrac(style) {
  if (style === 'elbow-src') return 0.18;   // bend near the source
  if (style === 'elbow-tgt') return 0.82;   // bend near the target
  return 0.5;                                                        // mid
}
// The ordered waypoints for an edge from rect a → rect b. An orthogonal ("elbow") route
// leaves + meets a box FACE, so it sticks wherever cards move. `style` picks the flavour:
//   straight · elbow (auto V/H) · elbow-v / -h (forced trunk) · elbow-src / -tgt (bend
//   near an end) · curved (smooth S over the auto route).
// Returns { pts:[{x,y}...], tux,tuy (unit dir INTO b, for the arrowhead), curved:bool }.
function waypoints(a, b, style) {
  var ca = anchorOf(a), cb = anchorOf(b);
  if (style === 'straight') {
    var p1 = borderPoint(ca, cb.cx, cb.cy), p2 = borderPoint(cb, ca.cx, ca.cy);
    var len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    return { pts: [p1, p2], tux: (p2.x - p1.x) / len, tuy: (p2.y - p1.y) / len, curved: false };
  }
  // Arc family: a single quadratic bow between the two facing border points. Each variant
  // is [depth × chord, side sign, px cap] — depth sets how far the control point pushes off
  // the chord midpoint, sign which side it bows, cap keeps long connectors sane. The
  // arrowhead follows the curve's END tangent (control point → tip), not the straight chord.
  // (Keep ARC_VARIANTS in sync with free-canvas-math.ts.)
  var ARC_VARIANTS = { arc: [0.22, 1, 70], 'arc-wide': [0.42, 1, 220], 'arc-flip': [0.22, -1, 70], 'arc-flip-wide': [0.42, -1, 220] };
  if (ARC_VARIANTS[style]) {
    var av = ARC_VARIANTS[style];
    var pa = borderPoint(ca, cb.cx, cb.cy), pb = borderPoint(cb, ca.cx, ca.cy);
    var ax = pb.x - pa.x, ay = pb.y - pa.y, al = Math.hypot(ax, ay) || 1;
    var nx = -ay / al, ny = ax / al, bow = Math.min(av[2], al * av[0]) * av[1];
    var cpt = { x: (pa.x + pb.x) / 2 + nx * bow, y: (pa.y + pb.y) / 2 + ny * bow };
    var ex = pb.x - cpt.x, ey = pb.y - cpt.y, el = Math.hypot(ex, ey) || 1;
    return { pts: [pa, pb], tux: ex / el, tuy: ey / el, curved: false, arc: true, cpt: cpt };
  }
  var dx = cb.cx - ca.cx, dy = cb.cy - ca.cy;
  var curved = style.slice(0, 6) === 'curved';   // curved / curved-v / curved-h
  var frac = elbowFrac(style);
  // Trunk orientation: forced by -v / -h (elbow OR curved), else the dominant axis.
  var useV = (style === 'elbow-v' || style === 'curved-v') ? true
    : (style === 'elbow-h' || style === 'curved-h') ? false
      : (Math.abs(dy) >= Math.abs(dx));
  if (useV) {
    var down = dy >= 0;
    var s = { x: ca.cx, y: down ? a.y + a.h : a.y };
    var t = { x: cb.cx, y: down ? b.y : b.y + b.h };
    var cy = s.y + frac * (t.y - s.y);
    return { pts: [s, { x: s.x, y: cy }, { x: t.x, y: cy }, t], tux: 0, tuy: down ? 1 : -1, curved: curved, orient: 'v' };
  }
  var right = dx >= 0;
  var s2 = { x: right ? a.x + a.w : a.x, y: ca.cy };
  var t2 = { x: right ? b.x : b.x + b.w, y: cb.cy };
  var cx = s2.x + frac * (t2.x - s2.x);
  return { pts: [s2, { x: cx, y: s2.y }, { x: cx, y: t2.y }, t2], tux: right ? 1 : -1, tuy: 0, curved: curved, orient: 'h' };
}
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
// A point `d` px from `from` toward `toward`, clamped so it never overshoots the
// far end (a short segment can't reverse the shaft).
function along(from, toward, d) {
  var L = dist(from, toward);
  if (L < 0.0001) return { x: from.x, y: from.y };
  var t = Math.min(d, L) / L;
  return { x: from.x + (toward.x - from.x) * t, y: from.y + (toward.y - from.y) * t };
}
// A polyline with rounded corners as a single M/L/Q path (PDF-safe). 2 points = a line.
function roundedPolyPath(pts, r) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return 'M' + f2(pts[0].x) + ' ' + f2(pts[0].y) + 'L' + f2(pts[1].x) + ' ' + f2(pts[1].y);
  var d = 'M' + f2(pts[0].x) + ' ' + f2(pts[0].y);
  for (var i = 1; i < pts.length - 1; i++) {
    var prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    var rr = Math.min(r, dist(prev, cur) / 2, dist(cur, next) / 2);
    var pin = along(cur, prev, rr), pout = along(cur, next, rr);
    d += 'L' + f2(pin.x) + ' ' + f2(pin.y) + 'Q' + f2(cur.x) + ' ' + f2(cur.y) + ' ' + f2(pout.x) + ' ' + f2(pout.y);
  }
  var last = pts[pts.length - 1];
  return d + 'L' + f2(last.x) + ' ' + f2(last.y);
}
// A smooth cubic S-curve between the route's endpoints. `orient` ('v'/'h') forces the
// bend axis (curved-v / curved-h); absent → auto from the dominant span (plain curved).
function smoothPath(pts, orient) {
  if (pts.length === 2) return 'M' + f2(pts[0].x) + ' ' + f2(pts[0].y) + 'L' + f2(pts[1].x) + ' ' + f2(pts[1].y);
  var s = pts[0], t = pts[pts.length - 1];
  var vert = orient ? orient === 'v' : (Math.abs(t.y - s.y) >= Math.abs(t.x - s.x));
  // Control points pulled toward the shared mid-line → an S-curve.
  if (vert) {
    var my = (s.y + t.y) / 2;
    return 'M' + f2(s.x) + ' ' + f2(s.y) + 'C' + f2(s.x) + ' ' + f2(my) + ' ' + f2(t.x) + ' ' + f2(my) + ' ' + f2(t.x) + ' ' + f2(t.y);
  }
  var mx = (s.x + t.x) / 2;
  return 'M' + f2(s.x) + ' ' + f2(s.y) + 'C' + f2(mx) + ' ' + f2(s.y) + ' ' + f2(mx) + ' ' + f2(t.y) + ' ' + f2(t.x) + ' ' + f2(t.y);
}
// A single quadratic bow from s to t through control point `cpt` (arc style).
function arcPath(s, t, cpt) {
  return 'M' + f2(s.x) + ' ' + f2(s.y) + 'Q' + f2(cpt.x) + ' ' + f2(cpt.y) + ' ' + f2(t.x) + ' ' + f2(t.y);
}
// Real-segment dash/dot run between two points (NOT stroke-dasharray → PDF-safe).
function dashRun(x1, y1, x2, y2, style, col, width) {
  var len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return '';
  var ux = (x2 - x1) / len, uy = (y2 - y1) / len, out = '', pos = 0;
  var dash = style === 'dotted' ? Math.max(width, 1.4) : 9;
  var gap = style === 'dotted' ? width * 2 + 2 : 6;
  var cap = style === 'dotted' ? ' stroke-linecap="round"' : '';
  while (pos < len) {
    var aa = pos, bb = Math.min(pos + dash, len);
    out += '<line x1="' + f2(x1 + ux * aa) + '" y1="' + f2(y1 + uy * aa) + '" x2="' + f2(x1 + ux * bb) +
      '" y2="' + f2(y1 + uy * bb) + '" stroke="' + esc(col) + '" stroke-width="' + f2(width) + '"' + cap + '/>';
    pos += dash + gap;
  }
  return out;
}
// A circle as 4 cubic beziers (never <circle>/<ellipse> — a path is PDF/EMF-portable).
function circlePath(cx, cy, r) {
  var k = 0.5523 * r;
  return 'M' + f2(cx + r) + ' ' + f2(cy) +
    'C' + f2(cx + r) + ' ' + f2(cy + k) + ' ' + f2(cx + k) + ' ' + f2(cy + r) + ' ' + f2(cx) + ' ' + f2(cy + r) +
    'C' + f2(cx - k) + ' ' + f2(cy + r) + ' ' + f2(cx - r) + ' ' + f2(cy + k) + ' ' + f2(cx - r) + ' ' + f2(cy) +
    'C' + f2(cx - r) + ' ' + f2(cy - k) + ' ' + f2(cx - k) + ' ' + f2(cy - r) + ' ' + f2(cx) + ' ' + f2(cy - r) +
    'C' + f2(cx + k) + ' ' + f2(cy - r) + ' ' + f2(cx + r) + ' ' + f2(cy - k) + ' ' + f2(cx + r) + ' ' + f2(cy) + 'Z';
}
// How far to pull the shaft back so it doesn't poke through the head (per shape).
function headInset(kind, s) {
  if (kind === 'none' || kind === 'open' || kind === 'bar') return 0;
  if (kind === 'diamond') return 2 * s;
  if (kind === 'circle') return 2 * (0.42 * s);
  return s * 0.9; // triangle
}
// An arrowhead at `tip` pointing along unit (ux,uy). Every shape is EXPORT-SAFE:
// filled <path> (triangle/diamond/circle) or plain <line> (open/bar) — never a marker,
// polygon, or a transform on the shape. Coordinates are baked in.
function arrowHead(tip, ux, uy, s, fill, kind) {
  if (kind === 'none') return '';
  var px = -uy, py = ux, hw = s * 0.52, B = { x: tip.x - ux * s, y: tip.y - uy * s };
  if (kind === 'open') {
    // A simple L-shaped chevron: two arms meeting at the tip, each a true 45° off the
    // shaft (equal step back along + out perpendicular → a right angle at the point).
    // Round caps so the ends match the connector line (which is stroke-linecap:round).
    var sw = Math.max(1.6, s * 0.22);
    var a = s * 0.72;
    var e1x = tip.x - ux * a + px * a, e1y = tip.y - uy * a + py * a;
    var e2x = tip.x - ux * a - px * a, e2y = tip.y - uy * a - py * a;
    return '<line x1="' + f2(e1x) + '" y1="' + f2(e1y) + '" x2="' + f2(tip.x) + '" y2="' + f2(tip.y) + '" stroke="' + esc(fill) + '" stroke-width="' + f2(sw) + '" stroke-linecap="round"/>' +
      '<line x1="' + f2(e2x) + '" y1="' + f2(e2y) + '" x2="' + f2(tip.x) + '" y2="' + f2(tip.y) + '" stroke="' + esc(fill) + '" stroke-width="' + f2(sw) + '" stroke-linecap="round"/>';
  }
  if (kind === 'diamond') {
    var M = { x: tip.x - ux * s, y: tip.y - uy * s }, Bk = { x: tip.x - ux * 2 * s, y: tip.y - uy * 2 * s };
    return '<path d="M' + f2(tip.x) + ' ' + f2(tip.y) + 'L' + f2(M.x + px * hw) + ' ' + f2(M.y + py * hw) +
      'L' + f2(Bk.x) + ' ' + f2(Bk.y) + 'L' + f2(M.x - px * hw) + ' ' + f2(M.y - py * hw) + 'Z" fill="' + esc(fill) + '"/>';
  }
  if (kind === 'circle') {
    var r = 0.42 * s, C = { x: tip.x - ux * r, y: tip.y - uy * r };
    return '<path d="' + circlePath(C.x, C.y, r) + '" fill="' + esc(fill) + '"/>';
  }
  if (kind === 'bar') {
    var bw = s * 0.62, sw2 = Math.max(1.6, s * 0.22);
    return '<line x1="' + f2(tip.x + px * bw) + '" y1="' + f2(tip.y + py * bw) + '" x2="' + f2(tip.x - px * bw) + '" y2="' + f2(tip.y - py * bw) + '" stroke="' + esc(fill) + '" stroke-width="' + f2(sw2) + '"/>';
  }
  // triangle (default)
  return '<path d="M' + f2(tip.x) + ' ' + f2(tip.y) + 'L' + f2(B.x + px * hw) + ' ' + f2(B.y + py * hw) +
    'L' + f2(B.x - px * hw) + ' ' + f2(B.y - py * hw) + 'Z" fill="' + esc(fill) + '"/>';
}

function drawConnector(a, b, c) {
  var ca = anchorOf(a), cb = anchorOf(b);
  if (nested(ca, cb)) return '';
  var style = String(c.style || 'elbow');
  var arrow = String(c.arrow || 'end');
  var head = String(c.head || 'open');   // arrowhead SHAPE (triangle/open/circle/diamond/bar)
  var dash = String(c.dash || 'solid');
  var col = safeColor(c.color, '#30ba78');
  var width = clamp(num(c.width, 3.5), 0.5, 20);
  var wp = waypoints(a, b, style);
  var pts = wp.pts.map(function (p) { return { x: p.x, y: p.y }; });
  if (pts.length < 2) return '';
  var n = pts.length;
  var last = pts[n - 1], first = pts[0];
  var headSize = Math.max(9, width * 4);
  // GAP: pull an ARROW end back off the box so the arrowhead sits in clear space, not
  // jammed against the card edge. The arrowhead tip lands `gap` off the border; the shaft
  // ends a further headInset behind it (so filled heads don't poke through). Capture the
  // original neighbour points BEFORE mutating, and cap each pull at the segment length so
  // a near-touching pair of cards can never reverse the shaft.
  var gap = Math.max(8, headSize * 0.8);
  var endTip = { x: last.x, y: last.y };
  var startTip = { x: first.x, y: first.y };
  var lastNbr = pts[n - 2], firstNbr = pts[1];
  if (arrow === 'end' || arrow === 'both') {
    var ge = Math.min(gap, dist(last, lastNbr) * 0.55);
    endTip = along(last, lastNbr, ge);                                   // arrowhead sits `gap` off the box
    pts[n - 1] = along(last, lastNbr, Math.min(ge + headInset(head, headSize), dist(last, lastNbr) * 0.9));
  }
  if (arrow === 'both') {
    var gs = Math.min(gap, dist(first, firstNbr) * 0.55);
    startTip = along(first, firstNbr, gs);
    pts[0] = along(first, firstNbr, Math.min(gs + headInset(head, headSize), dist(first, firstNbr) * 0.9));
  }
  var line = '';
  if (dash === 'dashed' || dash === 'dotted') {
    for (var i = 0; i < pts.length - 1; i++) line += dashRun(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, dash, col, width);
  } else if (wp.arc) {
    line = '<path d="' + arcPath(pts[0], pts[pts.length - 1], wp.cpt) + '" fill="none" stroke="' + esc(col) + '" stroke-width="' + f2(width) + '" stroke-linecap="round"/>';
  } else if (wp.curved) {
    line = '<path d="' + smoothPath(pts, wp.orient) + '" fill="none" stroke="' + esc(col) + '" stroke-width="' + f2(width) + '" stroke-linejoin="round" stroke-linecap="round"/>';
  } else {
    var r = Math.min(16, width * 4 + 6);
    line = '<path d="' + roundedPolyPath(pts, r) + '" fill="none" stroke="' + esc(col) + '" stroke-width="' + f2(width) + '" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  var heads = '';
  if (arrow === 'end' || arrow === 'both') heads += arrowHead(endTip, wp.tux, wp.tuy, headSize, col, head);
  if (arrow === 'both') {
    // Direction OUT of the source = reverse of the first drawn segment.
    var seg = pts.length >= 2 ? pts[1] : last;
    var L = dist(startTip, seg) || 1;
    heads += arrowHead(startTip, (startTip.x - seg.x) / L, (startTip.y - seg.y) / L, headSize, col, head);
  }
  return line + heads;
}

function buildConnectorSvg(connectors, byId) {
  var body = '';
  (connectors || []).forEach(function (c) {
    if (!c) return;
    var a = byId[String(c.from)], b = byId[String(c.to)];
    if (!a || !b || a === b) return;   // orphan / self edge → skip (prunes deleted cards)
    var ra = { x: num(a.x, 0), y: num(a.y, 0), w: Math.max(1, num(a.w, 1)), h: Math.max(1, num(a.h, 1)) };
    var rb = { x: num(b.x, 0), y: num(b.y, 0), w: Math.max(1, num(b.w, 1)), h: Math.max(1, num(b.h, 1)) };
    body += drawConnector(ra, rb, c);
  });
  if (!body) body = '';
  return '<svg class="oc-connectors" width="' + CW + '" height="' + CH + '" viewBox="0 0 ' + CW + ' ' + CH +
    '" preserveAspectRatio="none" aria-hidden="true">' + body + '</svg>';
}

// Optional drop shadow (matches Layout Studio). `shadow` picks WHAT the shadow
// follows → which CSS property: box → box-shadow, text → text-shadow, content →
// filter:drop-shadow. Raster-faithful (PNG/JPG/WebP); flattens in the SVG/PDF vector
// walkers, same as blend modes.
var SHADOW_TARGETS = { box: 1, text: 1, content: 1 };
function shadowCss(b) {
  var tgt = String(b.shadow || 'none');
  if (SHADOW_TARGETS[tgt] !== 1) return { box: '', text: '', filter: '' };
  var col = safeColor(b.shadowColor, '#0c322c33');
  var x = Math.round(clamp(num(b.shadowX, 0), -300, 300));
  var y = Math.round(clamp(num(b.shadowY, 0), -300, 300));
  var bl = Math.round(clamp(num(b.shadowBlur, 10), 0, 300));
  var off = x + 'px ' + y + 'px ' + bl + 'px ';
  if (tgt === 'text') return { box: '', text: 'text-shadow:' + off + col + ';', filter: '' };
  if (tgt === 'box') return { box: 'box-shadow:' + off + col + ';', text: '', filter: '' };
  return { box: '', text: '', filter: 'filter:drop-shadow(' + off + col + ');' };
}

// ── compute ─────────────────────────────────────────────────────────────────────────
function compute(model) {
  var inp = inputsFrom(model);
  var boxes = Array.isArray(inp.boxes) ? inp.boxes : [];
  var connectors = Array.isArray(inp.connectors) ? inp.connectors : [];
  var transparent = inp.transparentBg === true;
  var byId = {};
  boxes.forEach(function (b) { if (b && b.id != null && b.id !== '') byId[String(b.id)] = b; });

  var layouts = boxes.map(function (b) { return layoutOf(b || {}); });
  var shadows = boxes.map(function (b) { return shadowCss(b || {}); });
  var boxStyle = boxes.map(function (b, i) { return boxCss(b || {}, layouts[i]) + shadows[i].box + shadows[i].filter; });
  var textStyle = boxes.map(function (b, i) { return textCss(b || {}, layouts[i]) + shadows[i].text; });
  var textHtml = boxes.map(function (b) { return richText((b && b.text) || ''); });
  var mediaHtml = boxes.map(function (b, i) { return mediaFor(b || {}, layouts[i]); });

  return {
    boxStyle: boxStyle,
    textStyle: textStyle,
    textHtml: textHtml,
    mediaHtml: mediaHtml,
    connectorSvg: buildConnectorSvg(connectors, byId),
    bgStyle: [transparent ? 'transparent' : safeColor(inp.background, '#ffffff')],
  };
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }
