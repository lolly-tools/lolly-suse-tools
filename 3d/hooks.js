// SPDX-License-Identifier: MPL-2.0
// `3d` tool hooks — pure, DOM-free (sandboxed: no window/document/fetch).
// Fold the input model into one config object and hand it to the template as the
// `_state` extra (underscore prefix keeps annotateTemplate from touching it, so it
// stays valid JSON inside <script type="application/json">). The template's WebGL
// renderer reads it. Mirrors tools/d3/hooks.js.

function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');
}

function num(v, fallback) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function compute(model) {
  var inp = {};
  for (var i = 0; i < model.length; i++) inp[model[i].id] = model[i].value;

  // Model URL: an uploaded file (in-memory blob URL) wins over the bundled sample.
  // A `file` value is a FileRef {__file, url, ...}; tool-local samples live at
  // /tools/3d/assets/<id>.glb (served as a static tool file, no {{asset}} needed).
  var up = inp.modelUpload;
  var modelUrl = (up && typeof up === 'object' && up.url)
    ? up.url
    : '/tools/3d/assets/' + (inp.model || 'sample-1') + '.glb';

  var cam = (inp.camera && typeof inp.camera === 'object') ? inp.camera : {};

  var cfg = {
    modelUrl: modelUrl,
    width: Math.round(num(inp.width, 1280)),
    height: Math.round(num(inp.height, 1280)),
    scene: inp.scene || 'natural',
    envIntensity: num(inp.envIntensity, 1),
    envRotation: num(inp.envRotation, 0),
    background: inp.background || '#0f1115',
    bgColor2: inp.bgColor2 || '#30ba78',
    transparentBg: inp.transparentBg === true,
    exposure: num(inp.exposure, 1),
    shadows: inp.shadows !== false,
    camera: {
      fov: num(cam.fov, 45),
      rotation: num(cam.rotation, 35),
      tilt: num(cam.tilt, 12),
      zoom: num(cam.zoom, 1),
      pan: num(cam.pan, 0),
    },
    cameraMove: inp.cameraMove || 'orbit',
    duration: Math.max(0.5, num(inp.duration, 5)),
    fps: Math.round(num(inp.fps, 30)),
    loop: inp.loop !== false,
    easing: inp.easing || 'ease-in-out',
    keyframes: Array.isArray(inp.cameraKeyframes)
      ? inp.cameraKeyframes.map(function (k) {
          return {
            time: num(k.time, 0),
            fov: num(k.fov, 45),
            rotation: num(k.rotation, 0),
            zoom: num(k.zoom, 1),
            pan: num(k.pan, 0),
            tilt: num(k.tilt, 12),
            easing: k.easing || 'ease-in-out',
          };
        })
      : [],
    playClip: inp.playClip !== false,
    clipIndex: Math.max(0, Math.round(num(inp.clipIndex, 0))),
    applyTint: inp.applyTint === true,
    tint: inp.tint || '#30ba78',
  };

  return { _state: safeJson(cfg) };
}

function onInit(ctx) { return compute(ctx.model); }
function onInput(ctx) { return compute(ctx.model); }
