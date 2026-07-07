/**
 * Pose Geeko — static articulation hook.
 *
 * There is NO animation. Every moving part of the Geeko (pupil, eyelid, head,
 * legs, tail) is posed by a single baked SVG ATTRIBUTE computed here:
 *   • pupil  → transform="translate(dx dy)"      (eye look)
 *   • eyelid → stroke-width="w"                   (blink; 0 = open)
 *   • head / legs / tail / body → transform="rotate(deg cx cy)"
 *
 * Baking as attributes (never CSS) is deliberate: the same value renders
 * identically down every export path — verbatim in SVG, read by the PDF DOM
 * walker, and rasterised for CMYK-TIFF / JPG. The rotate pivots below are the
 * artwork's own user-space joints, measured with getBBox on each pose.
 *
 * Each pose is a different illustration with its own coordinate system, so the
 * config is keyed by pose value. Sliders that don't apply to a pose are hidden
 * by `showIf` in the manifest and simply produce empty attributes here.
 */

// ── per-pose articulation config ────────────────────────────────────────────
// pupil.rest:  the pupil's resting centre in the pose's user space (getBBox)
// pupil.eye:   [cx, cy, R] the eyeball centre + the radius the pupil centre is
//              CLAMPED within, so the pupil never escapes the eye. Rests sit
//              up-left of centre, so there's naturally more room to look right/down.
// pupil.flipX: pose art is internally mirrored (scale(-1)) — flip look direction
// eyelidMax:   stroke-width that fully shuts the eye at blink 100
// *.pivot:     rotate centre in the group's own user space (from getBBox)
// *.mirror:    group sits under a scale(-1); negate so +slider reads the same way
// Per-pose slider ranges (headRange / blinkRange, and each articulated group's
// own `range`) are the source of truth for CLURL correctness — the engine does
// NOT clamp initial URL/CLI values to a slider's min/max, so the hook must. They
// mirror the manifest's min/max + rangeWhen, which only drive the web slider UI;
// keep the two in sync. `noBlink` disables blink for a pose whose eyelid can't
// animate cleanly (dangling) — the manifest also hides the slider there.
var POSES = {
  curious: {                                    // gc-* — climbing; eye, blink, head, leaves+branch
    pupil: { rest: [184, 123], eye: [200, 137, 31], flipX: false },
    eyelidMax: 40,
    head:    { pivot: [335, 215] },   // headTilt rotates the head (snout + eye)
    // "Leaves & branch" slider — tilts the WHOLE curious illustration (branch + leaves + geeko)
    // as one group about its bbox centre, so it reads as tipping the whole scene. Applied to the
    // content <g> in the template; pivot = the group's measured centre.
    foliage: { pivot: [539, 301], range: [-40, 40] },
  },
  dangling: {                                   // dg-* — full body: eye, head, 2 legs (blink disabled)
    pupil: { rest: [901.9, 2282.6], eye: [956.7, 2295.8, 76], flipX: true },
    eyelidMax: 150,
    noBlink: true,
    headRange: [-14, 9],
    head:     { pivot: [1033, 1955], mirror: true },
    legBack:  { pivot: [1210, 1517], mirror: true, range: [-45, 45] },
    legFront: { pivot: [1226, 1722], mirror: true, range: [-30, 80] },
  },
  sitting: {                                    // gp-* — tail + head + eye
    pupil: { rest: [339, 69], eye: [352, 80, 24], flipX: false },
    eyelidMax: 26,
    head: { pivot: [227, 198] },
    tail: { pivot: [300, 235], range: [-22, 10] },
  },
  laying: {                                     // gl-* — head + eye
    pupil: { rest: [800, 154], eye: [816, 175, 33], flipX: false },
    eyelidMax: 42,
    headRange: [-14, 18],
    blinkRange: [0, 300],
    head: { pivot: [671, 313] },
  },
};

// Scene backgrounds (mirror the CSS themes) — remembered for beforeExport.
// `transparent` keeps SVG/PDF alpha; the alpha-less JPG / CMYK-TIFF path falls
// back to white so those exports get a clean sheet rather than black margins.
var THEME_BG = { transparent: '#ffffff', dark: '#0c322c', light: '#f0f7f4', pine: '#165c3c' };
var _bg = THEME_BG.transparent;

function inputsFrom(model) { var o = {}; model.forEach(function (i) { o[i.id] = i.value; }); return o; }
function num(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function clampRange(v, r) { return r ? clamp(v, r[0], r[1]) : v; }
function round(x) { return Math.round(x * 100) / 100; }
function rot(deg, piv) { return deg ? 'rotate(' + round(deg) + ' ' + piv[0] + ' ' + piv[1] + ')' : ''; }

function compute(model) {
  var v = inputsFrom(model);
  var pose = v.pose || 'curious';
  var cfg = POSES[pose] || POSES.curious;
  _bg = THEME_BG[v.bg] || THEME_BG.dark;

  var out = { pupilT: '', eyelidW: 0, headT: '', foliageT: '', legFrontT: '', legBackT: '', tailT: '' };

  // Eyes — pupil translate. The slider (-100..200) scales by the eyeball's clamp
  // radius, then the pupil centre is CLAMPED inside the eyeball so it can never
  // escape on any pose or slider combo. Rests sit up-left of centre, so there's
  // more travel to look right / down. flipX mirrors a scale(-1) pose.
  var p = cfg.pupil, R = p.eye[2];
  var dx = (clamp(num(v.eyeX, 0), -100, 200) / 100) * R * (p.flipX ? -1 : 1);
  var dy = (clamp(num(v.eyeY, 0), -100, 200) / 100) * R;
  var px = p.rest[0] + dx, py = p.rest[1] + dy;                 // desired pupil centre
  var ox = px - p.eye[0], oy = py - p.eye[1], ed = Math.sqrt(ox * ox + oy * oy);
  if (ed > R) { px = p.eye[0] + ox / ed * R; py = p.eye[1] + oy / ed * R; }  // clamp to eyeball
  dx = round(px - p.rest[0]); dy = round(py - p.rest[1]);
  if (dx || dy) out.pupilT = 'translate(' + dx + ' ' + dy + ')';

  // Each articulated slider below is clamped to its per-pose range and the
  // clamped value is echoed back under its own input id (snap-back), so a value
  // carried over from another pose — or an out-of-range URL/CLI param — is pulled
  // into range instead of driving the art past its safe limit.

  // Blink — eyelid stroke-width (0 open → shut). 100 units == one eyelidMax;
  // laying's wider range lets the eye over-close. Disabled on poses with no
  // working eyelid (dangling).
  if (!cfg.noBlink) {
    var br = cfg.blinkRange || [0, 100];
    var bl = clamp(num(v.blink, 0), br[0], br[1]);
    out.blink = bl;
    out.eyelidW = round((bl / 100) * cfg.eyelidMax);
  }

  // Head tilt — rotates the head group on every pose.
  var hr = cfg.headRange || [-30, 30];
  var ht = clamp(num(v.headTilt, 0), hr[0], hr[1]);
  out.headTilt = ht;
  if (cfg.head) out.headT = rot(ht * (cfg.head.mirror ? -1 : 1), cfg.head.pivot);

  // Leaves & branch (curious only) — tilts the whole illustration group about its centre.
  if (cfg.foliage) {
    var fo = clampRange(num(v.foliage, 0), cfg.foliage.range);
    out.foliage = fo;
    out.foliageT = rot(fo, cfg.foliage.pivot);
  }

  // Legs (dangling only — hidden elsewhere by showIf)
  if (cfg.legFront) {
    var lf = clampRange(num(v.legFront, 0), cfg.legFront.range);
    out.legFront = lf;
    out.legFrontT = rot(lf * (cfg.legFront.mirror ? -1 : 1), cfg.legFront.pivot);
  }
  if (cfg.legBack) {
    var lb = clampRange(num(v.legBack, 0), cfg.legBack.range);
    out.legBack = lb;
    out.legBackT = rot(lb * (cfg.legBack.mirror ? -1 : 1), cfg.legBack.pivot);
  }

  // Tail (sitting only)
  if (cfg.tail) {
    var tl = clampRange(num(v.tail, 0), cfg.tail.range);
    out.tail = tl;
    out.tailT = rot(tl, cfg.tail.pivot);
  }

  return out;
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }

function beforeExport(ctx) {
  // JPG & CMYK-TIFF have no alpha: fill any letterboxing with the scene colour so
  // there are no transparent/black margins. SVG & PDF carry the scene's own rect.
  if (ctx.format === 'jpg' || ctx.format === 'jpeg' || ctx.format === 'cmyk-tiff') {
    ctx.opts.background = _bg;
  }
}
