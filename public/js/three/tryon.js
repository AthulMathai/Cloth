// Live try-on: the camera image with the 3D garment worn by the person.
//
// Every frame:
//  1. Body tracking (MediaPipe Pose Landmarker, on-device) gives 33 body
//     points in the image and in metres, plus a body silhouette mask.
//  2. The garment is placed on the shoulders at true size (pixels-per-inch
//     from your real torso length), turned to face the way you face — all
//     the way round, so you see the back when your back is to the camera —
//     tilted, leant and twisted with your hips, and reshaped to your
//     silhouette. Sleeves are rebuilt along your arms.
//  3. Cloth motion: the hem and hood lag and swing with inertia, drawstrings
//     are simulated as hanging cords, and the hood can be pulled up over the
//     head (hand gesture or button).
//  4. The garment is rendered off-screen and composited onto the camera image
//     with the room's measured light (brightness, colour, direction), soft
//     edges, camera grain, and soft contact shadows on the person. Head and
//     hands hide the garment behind them.
// Nothing from the camera is uploaded or stored.
import * as THREE from 'three';
import { lightScene } from './studio.js';
import { tubeAlong } from './garment-model.js';

const MOBILE = matchMedia('(max-width: 820px), (pointer: coarse)').matches;
// Pinned so a library update can't change behaviour underneath us. Swap to
// self-hosted copies by changing these URLs.
export const POSE_CONFIG = {
  module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model: MOBILE
    ? 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
    : 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

const SHOULDER_TO_HIP_IN = 19;          // shoulder joint -> hip joint on an adult, roughly
const SIZE_GRADE = { XS: 0.92, S: 0.96, M: 1, L: 1.05, XL: 1.1, XXL: 1.16, '2XL': 1.16, '3XL': 1.22, '4XL': 1.28 };
const GRAVITY = 386;                    // in/s²

let landmarkerPromise = null;
function loadLandmarker() {
  landmarkerPromise ||= (async () => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Body tracking took too long to load.')), 25000));
    const work = (async () => {
      const vision = await import(/* @vite-ignore */ POSE_CONFIG.module);
      const files = await vision.FilesetResolver.forVisionTasks(POSE_CONFIG.wasm);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: POSE_CONFIG.model, delegate }, runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        outputSegmentationMasks: true,
      });
      try { return await make('GPU'); } catch { return await make('CPU'); }
    })();
    return Promise.race([work, timeout]);
  })().catch((e) => { landmarkerPromise = null; throw e; });
  return landmarkerPromise;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = THREE.MathUtils.clamp;

/**
 * Pure fitting maths (exported for tests).
 *  lm: 33 image landmarks in pixels {x, y, z, v} (v = visibility)
 *  wl: 33 world landmarks in metres {x, y, z} (hip-centred, y down), or null
 * Returns placement + joints in render space (x right, y up, z toward camera,
 * units = image pixels), or null when the shoulders aren't visible.
 */
export function fitPose(lm, wl, garment, { fit = 1, grade = 1 } = {}) {
  const vis = (i) => (lm[i]?.v ?? 0) > 0.5;
  if (!vis(11) || !vis(12)) return null;
  const P = (i) => lm[i];
  const hasHips = vis(23) && vis(24);
  const mid2 = (a, b) => ({ x: (P(a).x + P(b).x) / 2, y: (P(a).y + P(b).y) / 2 });

  // pixels per metre (both measured in the image plane, so turning sideways doesn't change it)
  let ppm;
  if (wl) {
    const w2 = (a, b) => Math.hypot(wl[a].x - wl[b].x, wl[a].y - wl[b].y);
    if (hasHips) {
      const s = mid2(11, 12), h = mid2(23, 24);
      const ws = { x: (wl[11].x + wl[12].x) / 2, y: (wl[11].y + wl[12].y) / 2 }, wh = { x: (wl[23].x + wl[24].x) / 2, y: (wl[23].y + wl[24].y) / 2 };
      ppm = Math.hypot(s.x - h.x, s.y - h.y) / Math.max(0.2, Math.hypot(ws.x - wh.x, ws.y - wh.y));
    } else ppm = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y) / Math.max(0.1, w2(11, 12));
  } else {
    ppm = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y) / 0.36;
  }

  // which way the body faces: full circle from the shoulder line in 3D
  let yaw = wl ? Math.atan2(wl[11].z - wl[12].z, wl[11].x - wl[12].x)
               : Math.atan2((P(11).z - P(12).z) * 0.5, P(11).x - P(12).x);
  const nose = lm[0]?.v ?? 0, eyes = Math.max(lm[2]?.v ?? 0, lm[5]?.v ?? 0);
  const face = nose > 0.6 && eyes > 0.5;
  let swap = false;                                   // tracker mixed up left/right
  if (face && Math.cos(yaw) < -0.25) { yaw += Math.PI; swap = true; }
  else if (!face && nose < 0.3 && Math.cos(yaw) > 0.35) { yaw += Math.PI; swap = true; }
  yaw = wrapAngle(yaw);

  // tilt of the shoulder line in the image (independent of facing)
  const a = P(11).x > P(12).x ? P(11) : P(12), b = a === P(11) ? P(12) : P(11);
  const roll = Math.atan2(-(a.y - b.y), a.x - b.x);

  const s = ppm * 0.0254 * fit * grade;               // pixels per garment inch
  const m = mid2(11, 12);
  const wz = wl ? (wl[11].z + wl[12].z) / 2 : (P(11).z + P(12).z) / 2;
  const W3 = (i) => new THREE.Vector3(P(i).x, -P(i).y, wl ? -(wl[i].z - wz) * ppm : -(P(i).z - wz) * 0.5);

  let sy = 1, hip = null, hipYaw = yaw;
  if (hasHips) {
    hip = W3(23).add(W3(24)).multiplyScalar(0.5);
    sy = clamp(Math.hypot(hip.x - m.x, hip.y + m.y) / (s * SHOULDER_TO_HIP_IN), 0.85, 1.18);
    if (wl) hipYaw = wrapAngle(Math.atan2(wl[23].z - wl[24].z, wl[23].x - wl[24].x) + (swap ? Math.PI : 0));
  }
  const side = (L) => {
    const [sh, el, wr, ix] = L;
    return { shoulder: W3(sh), elbow: vis(el) ? W3(el) : null, wrist: vis(wr) ? W3(wr) : null, hand: vis(ix) ? W3(ix) : (vis(wr) ? W3(wr) : null),
             wristImg: vis(wr) ? { x: P(wr).x, y: P(wr).y } : null };
  };
  const left = [11, 13, 15, 19], right = [12, 14, 16, 20];
  const joints = { l: side(swap ? right : left), r: side(swap ? left : right) };

  let head = null;
  const ears = vis(7) && vis(8);
  if (ears || vis(0)) {
    const c = ears ? W3(7).add(W3(8)).multiplyScalar(0.5) : W3(0).add(new THREE.Vector3(0, 0, -0.08 * ppm));
    const widthPx = ears ? Math.max(Math.hypot(P(7).x - P(8).x, P(7).y - P(8).y), 0.11 * ppm) : 0.15 * ppm;
    head = { center: c, size: widthPx, img: ears ? { x: (P(7).x + P(8).x) / 2, y: (P(7).y + P(8).y) / 2 } : { x: P(0).x, y: P(0).y } };
  }
  return { position: new THREE.Vector3(m.x, -m.y, 0), yaw, roll, scale: s, sy, hip, twist: clamp(wrapAngle(hipYaw - yaw), -0.6, 0.6),
           joints, head, face, ppm, shoulderY: m.y };
}

// ---------------------------------------------------------------------
// Garment deformation (vertex shader, garment-local inches)
// ---------------------------------------------------------------------
const DEFORM_PARS = `
uniform float uL; uniform float uTop; uniform float uW[7];
uniform vec2 uShear; uniform float uTwist; uniform vec3 uSway; uniform float uOn; uniform float uSwayK;
`;
const DEFORM_MAIN = `
{
  float hy = clamp(transformed.y / uL, 0.0, 1.0);
  float fb = min(hy * 6.0, 5.999); int i0 = int(floor(fb)); float ft = fb - float(i0);
  float ws = mix(uW[i0], uW[i0 + 1], ft);
  float drop = clamp(1.0 - hy / uTop, 0.0, 1.25);
  transformed.x *= mix(1.0, ws, uOn);
  float tw = uTwist * drop * uOn, c = cos(tw), s = sin(tw);
  transformed.xz = vec2(c * transformed.x + s * transformed.z, -s * transformed.x + c * transformed.z);
  transformed.x += uShear.x * drop * uOn;
  transformed.z += uShear.y * drop * uOn;
  transformed += uSway * (drop * drop * uSwayK + max(0.0, hy - uTop) * 0.0);
}
`;

// ---------------------------------------------------------------------
// Composite: camera image + garment, matched to the room
// ---------------------------------------------------------------------
const COMPOSITE_FRAG = `
uniform sampler2D tVideo; uniform sampler2D tCloth; uniform vec2 uRes; uniform float uGain; uniform vec3 uTint;
uniform float uTime; uniform float uGrain; uniform float uShadow; uniform sampler2D tMask; uniform float uHasMask;
varying vec2 vUv;
vec3 neutral(vec3 color) {
  const float sc = 0.76; const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= off;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < sc) return color;
  const float d = 1.0 - sc;
  float np = 1.0 - d * d / (peak + d - sc);
  color *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(color, vec3(np), g);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 7.31) * 43758.5453); }
void main() {
  vec2 px = 1.0 / uRes;
  float a = 0.0; vec3 col = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec4 s = texture2D(tCloth, vUv + vec2(float(i), float(j)) * px * 0.75);
    a += s.a; col += s.rgb * s.a;
  }
  col = a > 0.0 ? col / a : vec3(0.0);
  a /= 9.0;
  // soft contact shadow the garment throws on the person (and around the neck)
  float sh = 0.0;
  for (int k = 0; k < 12; k++) {
    float ang = float(k) * 0.5236;
    sh += texture2D(tCloth, vUv + (vec2(0.0, -4.0) + vec2(cos(ang), sin(ang)) * 7.0) * px).a;
  }
  sh /= 12.0;
  // only where the person is (silhouette from body tracking)
  if (uHasMask > 0.5) sh *= smoothstep(0.3, 0.8, texture2D(tMask, vUv).r);
  vec3 vid = texture2D(tVideo, vUv).rgb;
  vid *= 1.0 - uShadow * sh * (1.0 - a);
  vec3 g = toSRGB(clamp(neutral(col * uGain) * uTint, 0.0, 1.0));
  g += (hash(vUv * uRes) - 0.5) * uGrain;
  gl_FragColor = vec4(mix(vid, g, a), 1.0);
}`;

// ---------------------------------------------------------------------
export function openTryOn(kit, { title = 'Try on', colors = [], color = null, onColor, onClose, tracker: injected = null } = {}) {
  const ov = document.createElement('div');
  ov.className = 'tryon';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Try on');
  const hasHood = !!kit.geo.hoodUp;
  ov.innerHTML = `
    <div class="tryon-bar">
      <div><strong data-title></strong><span class="tryon-mode" data-mode></span></div>
      <div class="tryon-actions">
        ${hasHood ? '<button class="tryon-btn" data-hood aria-pressed="false">Hood up</button>' : ''}
        <button class="tryon-btn" data-mirror aria-pressed="true">Mirror</button>
        <button class="tryon-btn" data-photo>Use a photo</button>
        <button class="tryon-btn tryon-btn--main" data-snap disabled>Snapshot</button>
        <button class="tryon-btn tryon-close" data-close aria-label="Close try-on">✕</button>
      </div>
    </div>
    <div class="tryon-stage" data-stage>
      <video playsinline muted autoplay data-video class="tryon-src"></video>
      <img alt="" data-img class="tryon-src">
      <div class="tryon-msg" data-msg role="status">Starting your camera…</div>
      ${hasHood ? '<p class="tryon-tip" data-tip>Reach behind your neck and pull up to put the hood on.</p>' : ''}
    </div>
    <div class="tryon-foot">
      <div class="tryon-colors" role="group" aria-label="Colour">${colors.map(c => `<button class="swatch" style="background:${c.hex}" data-c="${escAttr(c.name)}" aria-label="${escAttr(c.name)}" aria-pressed="${c.name === color}"></button>`).join('')}</div>
      <label class="tryon-fit">Fit <input type="range" min="90" max="125" value="104" data-fit aria-label="Garment fit"></label>
      <p class="tryon-note">Stand 2–3 m back, facing the camera. Your camera stays on this device; nothing is recorded or uploaded.</p>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-file>`;
  document.body.append(ov);
  document.documentElement.classList.add('tryon-open');
  const $ = (s) => ov.querySelector(s);
  const prevFocus = document.activeElement;
  $('[data-title]').textContent = title;
  $('[data-close]').focus();

  // ---- renderer: garment -> offscreen target, then composite to screen ----
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'tryon-gl';
  $('[data-stage]').insertBefore(renderer.domElement, $('[data-msg]'));
  const scene = new THREE.Scene();
  const rig = lightScene(scene, renderer, { shadows: true });
  rig.key.shadow.mapSize.set(1024, 1024);
  const camera = new THREE.OrthographicCamera(0, 1280, 0, -720, -8000, 8000);
  camera.position.z = 4000;
  let rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 4 });

  let videoTex = new THREE.Texture();
  function setSourceTexture(el, live) {
    videoTex.dispose();
    videoTex = live ? new THREE.VideoTexture(el) : new THREE.Texture(el);
    videoTex.colorSpace = THREE.NoColorSpace;
    videoTex.generateMipmaps = false; videoTex.minFilter = THREE.LinearFilter; videoTex.magFilter = THREE.LinearFilter;
    videoTex.needsUpdate = true;
    comp.uniforms.tVideo.value = videoTex;
  }
  const comp = new THREE.ShaderMaterial({
    uniforms: { tVideo: { value: videoTex }, tCloth: { value: rt.texture }, uRes: { value: new THREE.Vector2(1280, 720) },
                uGain: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 }, uGrain: { value: 0.03 }, uShadow: { value: 0.32 },
                tMask: { value: null }, uHasMask: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
  });
  const compScene = new THREE.Scene();
  compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), comp));
  const compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- garment instance with try-on materials ----
  const deform = {
    uL: { value: kit.geo.spec.L }, uTop: { value: 0.8 }, uW: { value: [1, 1, 1, 1, 1, 1, 1] },
    uShear: { value: new THREE.Vector2() }, uTwist: { value: 0 }, uSway: { value: new THREE.Vector3() },
  };
  const clones = new Map();
  function tryMaterial(orig, on, swayK) {
    const key = `${orig.uuid}:${on}:${swayK}`;
    if (clones.has(key)) return clones.get(key);
    const m = orig.clone();
    m.userData = { inside: orig.userData.inside, orig };
    const prev = orig.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(orig, sh, r);
      Object.assign(sh.uniforms, deform, { uOn: { value: on ? 1 : 0 }, uSwayK: { value: swayK } });
      sh.vertexShader = DEFORM_PARS + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DEFORM_MAIN);
    };
    m.customProgramCacheKey = () => `tryon-${orig.type}-${orig.userData.inside ? 'f' : 's'}`;
    clones.set(key, m);
    return m;
  }
  function syncMaterials() {
    for (const m of clones.values()) {
      const o = m.userData.orig;
      m.color.copy(o.color);
      if (m.sheenColor && o.sheenColor) m.sheenColor.copy(o.sheenColor);
    }
  }

  const holder = new THREE.Group();
  scene.add(holder);
  const occ = new THREE.MeshBasicMaterial({ colorWrite: false });
  const headOcc = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), occ);
  const handOcc = { l: new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), occ), r: new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), occ) };
  const armOcc = { l: new THREE.Mesh(new THREE.CylinderGeometry(1, 0.85, 1, 14), occ), r: new THREE.Mesh(new THREE.CylinderGeometry(1, 0.85, 1, 14), occ) };
  for (const o of [headOcc, handOcc.l, handOcc.r, armOcc.l, armOcc.r]) { o.renderOrder = -2; o.visible = false; scene.add(o); }

  let inst = null, garment = null, cords = [], hoodBase = null, hoodFit = { off: new THREE.Vector3(), k: 1 };
  function mount() {
    inst?.dispose();
    inst = kit.instance({ shadows: true });
    const geo = kit.geo, spec = geo.spec;
    deform.uL.value = spec.L;
    for (const mesh of inst.group.children) {
      if (mesh.material === kit.mats.label) { mesh.visible = false; continue; }
      if (!mesh.isMesh) continue;
      const role = mesh.userData.role || mesh.geometry.userData.role;
      const isSleeve = /sleeve/.test(mesh.userData.part || '') || Object.values(inst.sleeves).some(s => s.cuff === mesh);
      if (role === 'cord' || role === 'tip') continue;
      mesh.material = tryMaterial(mesh.material, !isSleeve, isSleeve ? 0 : 1);
    }
    for (const s of Object.values(inst.sleeves)) { s.main.material = tryMaterial(kit.mats[s.main.userData.part], false, 0); }
    if (inst.hoodMesh) {
      inst.hoodMesh.material = tryMaterial(kit.mats.hood, false, 0.6);
      inst.hoodMesh.geometry = geo.hoodUp.clone();                 // own copy: fitted to the wearer's head
      hoodBase = Float32Array.from(inst.hoodMesh.geometry.attributes.position.array);
    }
    // drawstrings: simulated cords with their own geometry
    cords = inst.roles.cords.map((mesh, i) => {
      const rest = mesh.geometry.userData.points.map(p => p.clone());
      const tip = inst.roles.tips[i];
      if (tip) { tip.geometry = new THREE.CylinderGeometry(0.15, 0.15, 1.1, 14); tip.position.set(0, 0, 0); }
      mesh.geometry = mesh.geometry.clone();
      return { mesh, tip, rest, p: rest.map(v => v.clone()), q: rest.map(v => v.clone()), len: rest.slice(1).map((v, k) => v.distanceTo(rest[k])) };
    });
    // anchor: the shoulder joints (just under the top of the shoulder)
    const ys = spec.L - spec.drop, ring = geo.torso.ring(ys);
    const anchor = new THREE.Vector3(0, ys - 1.6, ring.zc);
    inst.group.position.copy(anchor).negate();
    deform.uTop.value = clamp(anchor.y / spec.L, 0.5, 0.95);
    // the body inside the clothes hides the garment's inside
    const r6 = geo.torso.ring(spec.L - 6);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), occ);
    chest.scale.set(r6.a * 0.86, 9, r6.b * 0.8); chest.position.set(0, spec.L - 7, r6.zc);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.5, 12, 24), occ);
    neck.position.set(0, spec.L + 2, r6.zc - 0.6);
    for (const o of [chest, neck]) { o.renderOrder = -1; inst.group.add(o); }
    holder.add(inst.group);
    const sl = geo.arms?.l.shoulder ?? new THREE.Vector3(ring.a - 1.2, anchor.y, 0);
    const sr = geo.arms?.r.shoulder ?? sl.clone().setX(-sl.x);
    garment = { shoulders: { l: sl, r: sr }, anchor };
    inst.setHood(hood);
  }
  let hood = 0, hoodTarget = 0;
  mount();
  const offKit = kit.on((what) => { if (what === 'type') mount(); else syncMaterials(); });
  const prevGuides = kit.state.guides;
  kit.setDesign({ guides: false });

  // ---- state ----
  const video = $('[data-video]'), img = $('[data-img]');
  let stream = null, source = null, W = 1280, H = 720, mirror = true, fit = 1.04, raf = 0, closed = false;
  let tracker = injected, trackerFailed = false, lastPose = 0, smooth = null, smoothW = null, manual = null, lastVideoTime = -1;
  let pose = null, yawS = null, frameNo = 0, lastT = performance.now();
  const msg = (t) => { const m = $('[data-msg]'); m.textContent = t || ''; m.hidden = !t; };

  function setSize(w, h) {
    const k = Math.min(1, 1280 / Math.max(w, h));
    W = Math.round(w * k); H = Math.round(h * k);
    renderer.setSize(W, H, false);
    rt.setSize(W, H);
    comp.uniforms.uRes.value.set(W, H);
    Object.assign(camera, { left: 0, right: W, top: 0, bottom: -H });
    camera.updateProjectionMatrix();
    $('[data-stage]').style.aspectRatio = `${W} / ${H}`;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { msg('This browser can\'t use the camera here. Try “Use a photo”.'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (closed) { stopStream(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      await new Promise(r => video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true }));
      useSource(video, true);
    } catch (e) {
      msg(e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera in your browser, or use a photo instead.'
        : 'No camera found. Use a photo instead.');
    }
  }
  function useSource(el, live) {
    source = el;
    if (!live) mirror = false;
    $('[data-mirror]').setAttribute('aria-pressed', mirror);
    $('[data-mirror]').disabled = !live;
    renderer.domElement.classList.toggle('is-mirror', mirror);
    setSize(el.videoWidth || el.naturalWidth, el.videoHeight || el.naturalHeight);
    setSourceTexture(el, live);
    $('[data-snap]').disabled = false;
    smooth = null; smoothW = null; manual = null; lastVideoTime = -1; yawS = null; pose = null;
    msg(trackerFailed ? '' : 'Loading body tracking…');
    startTracking();
    if (!raf) { lastT = performance.now(); loop(); }
  }
  async function startTracking() {
    if (tracker || trackerFailed) { modeLabel(); if (tracker) msg('Step back so your shoulders and hips are in view.'); return; }
    try {
      tracker = await loadLandmarker();
      if (closed) return;
      msg('Step back so your shoulders and hips are in view.');
    } catch (e) {
      console.warn('[try-on] body tracking unavailable:', e);
      trackerFailed = true;
      msg('');
      enableManual('Body tracking couldn\'t load here. Drag the garment into place; pinch or scroll to resize.');
    }
    modeLabel();
  }
  function modeLabel() { $('[data-mode]').textContent = tracker ? 'Live body tracking' : manual ? 'Manual fit' : ''; }
  function enableManual(note) {
    manual ||= { x: W / 2, y: H * 0.3, s: (H * 0.62) / kit.geo.spec.L, roll: 0 };
    if (note) { const n = $('[data-msg]'); n.textContent = note; n.hidden = false; setTimeout(() => { if (n.textContent === note) n.hidden = true; }, 6000); }
    modeLabel();
  }

  // ---- tracking ----
  function detect(el, ts) {
    let res;
    try { res = tracker.detectForVideo(el, ts); } catch { return; }
    const raw = res?.landmarks?.[0], rawW = res?.worldLandmarks?.[0] || null;
    const mask = res?.segmentationMasks?.[0] || null;
    try {
      if (!raw) return;
      const lm = raw.map(p => ({ x: p.x * W, y: p.y * H, z: p.z * W, v: p.visibility ?? 1 }));
      // steadier when still, responsive when moving
      if (!smooth) { smooth = lm; smoothW = rawW; }
      else {
        smooth = smooth.map((o, i) => {
          const n = lm[i], d = Math.hypot(n.x - o.x, n.y - o.y), a = Math.min(0.9, 0.35 + d / 50);
          return { x: o.x + (n.x - o.x) * a, y: o.y + (n.y - o.y) * a, z: o.z + (n.z - o.z) * a * 0.6, v: n.v };
        });
        if (rawW && smoothW) smoothW = smoothW.map((o, i) => ({ x: o.x + (rawW[i].x - o.x) * 0.5, y: o.y + (rawW[i].y - o.y) * 0.5, z: o.z + (rawW[i].z - o.z) * 0.45 }));
        else smoothW = rawW;
      }
      const grade = SIZE_GRADE[String(kit.state.size || 'M').toUpperCase()] ?? 1;
      const p = fitPose(smooth, smoothW, garment, { fit, grade });
      if (!p) return;
      // smooth the facing angle the short way round
      yawS = yawS == null ? p.yaw : yawS + wrapAngle(p.yaw - yawS) * 0.35;
      p.yaw = yawS;
      pose = p; lastPose = performance.now();
      if (mask && frameNo % 2 === 0) { fitSilhouette(mask, p); uploadMask(mask); }
    } finally { mask?.close?.(); }
  }

  // low-res copy of the silhouette for the composite (contact shadows on the body only)
  const MW = 320, MH = 180, maskBytes = new Uint8Array(MW * MH);
  const maskTex = new THREE.DataTexture(maskBytes, MW, MH, THREE.RedFormat, THREE.UnsignedByteType);
  maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter; maskTex.flipY = false;
  function uploadMask(mask) {
    let arr;
    try { arr = mask.getAsFloat32Array(); } catch { return; }
    const mw = mask.width, mh = mask.height;
    for (let y = 0; y < MH; y++) {
      const sy = Math.min(mh - 1, Math.floor((1 - (y + 0.5) / MH) * mh));     // texture rows run bottom-up
      for (let x = 0; x < MW; x++) maskBytes[y * MW + x] = arr[sy * mw + Math.floor((x + 0.5) / MW * mw)] * 255;
    }
    maskTex.needsUpdate = true;
    comp.uniforms.tMask.value = maskTex; comp.uniforms.uHasMask.value = 1;
  }

  // reshape the torso to the body silhouette (width per height band)
  function fitSilhouette(mask, p) {
    let arr;
    try { arr = mask.getAsFloat32Array(); } catch { return; }
    const mw = mask.width, mh = mask.height, spec = kit.geo.spec, c = Math.abs(Math.cos(p.yaw));
    if (!arr || c < 0.75) return;
    const dir = { x: Math.cos(p.roll), y: -Math.sin(p.roll) };
    const v = new THREE.Vector3();
    const arms = ['l', 'r'].flatMap(k => [p.joints[k].elbow, p.joints[k].wrist]).filter(Boolean);
    for (let b = 0; b < 6; b++) {
      const y = (b / 6) * spec.L;
      if (y > spec.armpit - 1.5) continue;
      const drop = clamp(1 - (y / spec.L) / deform.uTop.value, 0, 1.25);
      v.set(deform.uShear.value.x * drop, y, kit.geo.torso.ring(y).zc);
      inst.group.localToWorld(v);
      const ix = v.x, iy = -v.y;
      const gHalf = kit.geo.torso.ring(y).a * p.scale * c * deform.uW.value[b];
      const maxR = gHalf * 1.8;
      // arms close to the body at this height would read as body: skip
      if (arms.some(a => Math.abs(-a.y - iy) < p.scale * 3 && Math.abs(a.x - ix) < maxR)) continue;
      const edge = (sgn) => {
        for (let r = gHalf * 0.3; r < maxR; r += 2) {
          const x = Math.round((ix + sgn * dir.x * r) * mw / W), yy = Math.round((iy + sgn * dir.y * r) * mh / H);
          if (x < 0 || yy < 0 || x >= mw || yy >= mh) return null;
          if (arr[yy * mw + x] < 0.5) return r;
        }
        return null;
      };
      const l = edge(-1), rr = edge(1);
      if (l == null || rr == null) continue;
      const body = (l + rr) / 2, g0 = gHalf / deform.uW.value[b];
      const target = clamp((body * 1.07) / g0, 0.9, 1.28);
      deform.uW.value[b] += (target - deform.uW.value[b]) * 0.25;
    }
    // neighbouring bands can't differ much (no steps in the side seams)
    const w = deform.uW.value;
    w[6] = 1;
    for (let pass = 0; pass < 2; pass++) for (let i = 1; i < 6; i++) w[i] = w[i] * 0.5 + (w[i - 1] + w[i + 1]) * 0.25;
  }

  // ---- place garment + cloth motion ----
  const sway = { o: new THREE.Vector3(), v: new THREE.Vector3() };
  const motion = { pos: null, vel: new THREE.Vector3(), acc: new THREE.Vector3() };
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();
  function place(p, dt) {
    holder.position.copy(p.position);
    holder.rotation.set(0, p.yaw, p.roll, 'ZYX');
    holder.scale.set(p.scale, p.scale * p.sy, p.scale);
    holder.updateMatrixWorld(true);
    // lower body follows the hips: lean / shift and twist
    if (p.hip) {
      const hl = inst.group.worldToLocal(p.hip.clone());
      const hipY = garment.anchor.y - SHOULDER_TO_HIP_IN;
      deform.uShear.value.set(clamp(hl.x, -6, 6), clamp(hl.z - garment.anchor.z, -4, 4) * 0.5).multiplyScalar(1 / Math.max(0.5, (garment.anchor.y - hipY) / garment.anchor.y));
      deform.uTwist.value += (p.twist - deform.uTwist.value) * 0.3;
    }
    // sleeves along the arms
    if (inst.geo.sleeves) for (const side of ['l', 'r']) {
      const j = p.joints[side];
      if (!j.elbow) { inst.setArm(side, null); continue; }
      const sh = garment.shoulders[side];
      const e = inst.group.worldToLocal(j.elbow.clone());
      const w = j.wrist ? inst.group.worldToLocal(j.wrist.clone()) : e.clone().add(e.clone().sub(sh).multiplyScalar(0.9));
      if (e.distanceTo(sh) < 4) { inst.setArm(side, null); continue; }
      inst.setArm(side, { shoulder: sh.clone(), elbow: e, wrist: w });
    }
    // occluders: head, hands, (bare) forearms
    if (p.head) {
      headOcc.visible = true;
      headOcc.position.copy(p.head.center).add(new THREE.Vector3(0, 0, -0.02 * p.ppm));
      const r = p.head.size * 0.62;
      headOcc.scale.set(r, r * 1.25, r);
    } else headOcc.visible = false;
    const bare = !inst.geo.sleeves || inst.geo.spec.sleeve.len < 12;
    for (const side of ['l', 'r']) {
      const j = p.joints[side];
      handOcc[side].visible = !!j.hand;
      if (j.hand) { const hand = j.wrist ? j.wrist.clone().lerp(j.hand, 0.6) : j.hand; handOcc[side].position.copy(hand); handOcc[side].scale.setScalar(p.scale * 2.1); }
      armOcc[side].visible = bare && !!(j.elbow && j.wrist);
      if (armOcc[side].visible) {
        const a = j.elbow, b = j.wrist, d = b.clone().sub(a);
        armOcc[side].position.copy(a).addScaledVector(d, 0.5);
        armOcc[side].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        armOcc[side].scale.set(p.scale * 1.35, d.length(), p.scale * 1.35);
      }
    }
    cloth(p, dt);
    hoodFitHead(p);
    gesture(p);
  }

  function cloth(p, dt) {
    dt = clamp(dt, 1 / 120, 1 / 20);
    // garment acceleration (render px/s²) -> local inches
    const pos = p.position.clone();
    if (motion.pos) {
      const vel = pos.clone().sub(motion.pos).divideScalar(dt);
      motion.acc.lerp(vel.clone().sub(motion.vel).divideScalar(dt), 0.35);
      motion.vel.lerp(vel, 0.5);
    }
    motion.pos = pos;
    holder.getWorldQuaternion(tmpQ).invert();
    const aLocal = motion.acc.clone().applyQuaternion(tmpQ).divideScalar(p.scale);
    const gLocal = new THREE.Vector3(0, -GRAVITY, 0).applyQuaternion(tmpQ);
    // hem / hood sway: damped spring driven by the body's acceleration
    const k = 70, damp = 10;
    const f = sway.o.clone().multiplyScalar(-k).addScaledVector(sway.v, -damp).addScaledVector(aLocal, -0.016);
    sway.v.addScaledVector(f, dt); sway.o.addScaledVector(sway.v, dt);
    sway.o.clampLength(0, 1.6);
    deform.uSway.value.set(sway.o.x, sway.o.y * 0.3, sway.o.z);
    // drawstrings: verlet cords pinned at the neck, resting on the chest
    for (const c of cords) {
      const acc = gLocal.clone().sub(aLocal.clone().multiplyScalar(0.8));
      for (let i = 0; i < c.p.length; i++) {
        if (i < 1) { c.p[i].copy(c.rest[i]); c.q[i].copy(c.rest[i]); continue; }
        const v = c.p[i].clone().sub(c.q[i]).multiplyScalar(0.96);
        c.q[i].copy(c.p[i]);
        c.p[i].add(v).addScaledVector(acc, dt * dt);
      }
      for (let it = 0; it < 6; it++) {
        for (let i = 1; i < c.p.length; i++) {
          const a = c.p[i - 1], b = c.p[i], d = b.clone().sub(a), l = d.length() || 1e-6, diff = (l - c.len[i - 1]) / l;
          if (i - 1 === 0) b.addScaledVector(d, -diff);
          else { a.addScaledVector(d, diff * 0.5); b.addScaledVector(d, -diff * 0.5); }
        }
        for (let i = 1; i < c.p.length; i++) if (c.p[i].z < c.rest[i].z - 0.15) c.p[i].z = c.rest[i].z - 0.15;   // lie on the chest
      }
      c.mesh.geometry.dispose();
      c.mesh.geometry = tubeAlong(c.p, 0.12, { seg: 8 });
      if (c.tip) {
        const last = c.p[c.p.length - 1], dir = last.clone().sub(c.p[c.p.length - 2]).normalize();
        c.tip.position.copy(last).addScaledVector(dir, 0.5);
        c.tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      }
    }
    // hood up / down animation
    if (hood !== hoodTarget) {
      hood += Math.sign(hoodTarget - hood) * Math.min(Math.abs(hoodTarget - hood), dt * 2.2);
      inst.setHood(hood);
    }
    void tmpV;
  }

  // fit the raised hood to the wearer's head
  function hoodFitHead(p) {
    if (!inst.hoodMesh || !p.head || hood < 0.2) return;
    const head = inst.group.worldToLocal(p.head.center.clone());
    const C = kit.geo.hoodUp.userData.head;
    const off = head.sub(C).clampLength(0, 4.5), k = clamp((p.head.size / p.scale) / 5.8, 0.85, 1.25);
    if (off.distanceTo(hoodFit.off) < 0.25 && Math.abs(k - hoodFit.k) < 0.02) return;
    hoodFit.off.lerp(off, 0.5); hoodFit.k += (k - hoodFit.k) * 0.5;
    const g = inst.hoodMesh.geometry, P = g.attributes.position, Wt = g.attributes.hoodW;
    for (let i = 0; i < P.count; i++) {
      const w = Wt.getX(i), f = w < 0.15 ? 0 : w > 0.6 ? 1 : ((w - 0.15) / 0.45) ** 2 * (3 - 2 * (w - 0.15) / 0.45);
      const bx = hoodBase[i * 3], by = hoodBase[i * 3 + 1], bz = hoodBase[i * 3 + 2];
      P.setXYZ(i, bx + f * (hoodFit.off.x + (bx - C.x) * (hoodFit.k - 1)), by + f * (hoodFit.off.y + (by - C.y) * (hoodFit.k - 1)), bz + f * (hoodFit.off.z + (bz - C.z) * (hoodFit.k - 1)));
    }
    P.needsUpdate = true;
    g.computeVertexNormals();
  }

  // pull the hood up / off with a hand
  const hist = [];
  let gestureCool = 0;
  function gesture(p) {
    if (!inst.hoodMesh || !p.head) return;
    const now = performance.now(), hx = p.head.img.x, hy = p.head.img.y, hs = p.head.size;
    const top = hy - hs * 1.1, neck = hy + hs * 0.4, near = (x) => Math.abs(x - hx) < hs * 1.9;
    for (const k of ['l', 'r']) { const w = p.joints[k].wristImg; if (w) hist.push({ t: now, x: w.x, y: w.y }); }
    while (hist.length && now - hist[0].t > 1400) hist.shift();
    if (now < gestureCool) return;
    const cur = ['l', 'r'].map(k => p.joints[k].wristImg).filter(Boolean);
    if (hoodTarget === 0) {
      const wasLow = hist.some(h => h.y > hy - hs * 0.2 && h.y < neck + hs * 1.2 && near(h.x));
      if (wasLow && cur.some(w => w.y < top && near(w.x))) setHood(1, true);
    } else {
      const wasHigh = hist.some(h => h.y < top && near(h.x) && now - h.t > 250);
      if (wasHigh && cur.some(w => w.y > p.shoulderY + hs * 0.6)) setHood(0, true);
    }
  }
  function setHood(v, byGesture = false) {
    hoodTarget = v;
    gestureCool = performance.now() + (byGesture ? 1800 : 600);
    hist.length = 0;
    $('[data-hood]')?.setAttribute('aria-pressed', v === 1);
    if ($('[data-hood]')) $('[data-hood]').textContent = v ? 'Hood down' : 'Hood up';
    $('[data-tip]')?.remove();
  }

  // ---- room light: measured from the camera image ----
  const probe = document.createElement('canvas'); probe.width = 32; probe.height = 18;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  let probeT = 0;
  const light = { gain: 1, tint: new THREE.Vector3(1, 1, 1), side: 0 };
  function measureLight() {
    try { pctx.drawImage(source, 0, 0, 32, 18); } catch { return; }
    const d = pctx.getImageData(0, 0, 32, 18).data;
    let r = 0, g = 0, b = 0, left = 0, right = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2], x = (i / 4) % 32;
      r += d[i]; g += d[i + 1]; b += d[i + 2];
      if (x < 16) left += y; else right += y;
    }
    const n = d.length / 4, Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255;
    const avg = (r + g + b) / 3 || 1;
    light.gain += (clamp(0.35 + Y * 1.35, 0.42, 1.3) - light.gain) * 0.3;
    const t = new THREE.Vector3(r / avg, g / avg, b / avg).lerp(new THREE.Vector3(1, 1, 1), 0.65);
    light.tint.lerp(t, 0.3);
    light.side += (clamp((right - left) / Math.max(1, right + left) * 4, -1, 1) - light.side) * 0.3;
  }
  function applyLight() {
    comp.uniforms.uGain.value = light.gain;
    comp.uniforms.uTint.value.copy(light.tint);
    const c = holder.position, s = holder.scale.x || 1;
    rig.key.position.set(c.x + light.side * 1400, c.y + 1500, c.z + 1800);
    rig.key.target.position.copy(c);
    const cam = rig.key.shadow.camera, half = 34 * s;
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 8000 });
    cam.updateProjectionMatrix();
    rig.key.shadow.bias = -0.0006; rig.key.shadow.normalBias = 0.05 * s;
  }

  // ---- frame loop ----
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!source) return;
    const now = performance.now(), dt = (now - lastT) / 1000; lastT = now;
    frameNo++;
    if (tracker) {
      if (source === video && video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; detect(video, now); }
      else if (source === img && frameNo % 8 === 0) detect(img, now);
    }
    if (now - probeT > 250) { probeT = now; measureLight(); }
    const fresh = pose && now - lastPose < 1500;
    if (fresh) { place(pose, dt); msg(''); }
    else if (tracker && pose && now - lastPose > 1500) msg('Step back so your shoulders and hips are in view.');
    else if (tracker && !pose && !manual && now - lastPose > 6000 && frameNo > 120) enableManual('Can\'t find you yet. You can drag the garment into place.');
    if (manual && !fresh) placeManual(dt);
    holder.visible = !!(fresh || manual);
    applyLight();
    comp.uniforms.uTime.value = (now / 1000) % 100;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(compScene, compCam);
  }
  function placeManual(dt) {
    holder.position.set(manual.x, -manual.y, 0);
    holder.rotation.set(0, 0, manual.roll, 'ZYX');
    holder.scale.setScalar(manual.s * fit / 1.04);
    holder.updateMatrixWorld(true);
    headOcc.visible = false;
    for (const k of ['l', 'r']) { handOcc[k].visible = false; armOcc[k].visible = false; }
    if (inst.geo.sleeves) { inst.setArm('l', null); inst.setArm('r', null); }
    deform.uShear.value.set(0, 0); deform.uTwist.value = 0;
    cloth({ position: holder.position, scale: holder.scale.x }, dt);
  }

  // ---- manual drag / pinch / wheel ----
  const pointers = new Map();
  let pinch = null;
  const toImage = (e) => {
    const r = renderer.domElement.getBoundingClientRect(), k = Math.max(r.width / W, r.height / H);
    let x = (e.clientX - r.left - (r.width - W * k) / 2) / k;
    if (mirror) x = W - x;
    return { x, y: (e.clientY - r.top - (r.height - H * k) / 2) / k };
  };
  const stageEl = $('[data-stage]');
  stageEl.addEventListener('pointerdown', (e) => {
    if (!source) return;
    if (!manual) { if (tracker && pose) return; enableManual(); }
    pointers.set(e.pointerId, toImage(e));
    stageEl.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: manual.s }; }
  });
  stageEl.addEventListener('pointermove', (e) => {
    if (!manual || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId), now = toImage(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      manual.s = Math.max(0.5, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d || 1));
    } else if (pointers.size === 1) { manual.x += now.x - prev.x; manual.y += now.y - prev.y; }
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  stageEl.addEventListener('pointerup', up);
  stageEl.addEventListener('pointercancel', up);
  stageEl.addEventListener('wheel', (e) => {
    if (!manual) return;
    e.preventDefault();
    manual.s = Math.max(0.5, manual.s * (e.deltaY < 0 ? 1.06 : 0.94));
  }, { passive: false });

  // ---- controls ----
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-close]')) close();
    else if (b.matches('[data-mirror]')) { mirror = !mirror; b.setAttribute('aria-pressed', mirror); renderer.domElement.classList.toggle('is-mirror', mirror); }
    else if (b.matches('[data-hood]')) setHood(hoodTarget ? 0 : 1);
    else if (b.matches('[data-photo]')) $('[data-file]').click();
    else if (b.matches('[data-snap]')) snapshot();
    else if (b.dataset.c) {
      ov.querySelectorAll('[data-c]').forEach(x => x.setAttribute('aria-pressed', x === b));
      const t = onColor?.(b.dataset.c);
      if (t) $('[data-title]').textContent = t;
      kit.setDesign({ guides: false });
      syncMaterials();
    }
  });
  $('[data-fit]').addEventListener('input', (e) => { fit = Number(e.target.value) / 100; });
  $('[data-file]').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 25 * 1024 * 1024) { msg('Use a PNG, JPG or WebP photo under 25 MB.'); return; }
    stopStream();
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(f);
    await img.decode().catch(() => {});
    useSource(img, false);
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      const f = [...ov.querySelectorAll('button:not([disabled]), input:not([hidden])')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  // snapshot: saved un-mirrored so prints read the right way round
  function snapshot() {
    if (!source) return;
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(compScene, compCam);
    renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'try-on.png';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }
  function stopStream() { stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; }
  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf); stopStream();
    document.removeEventListener('keydown', onKey);
    offKit(); inst?.dispose();
    for (const m of clones.values()) m.dispose();
    for (const c of cords) c.mesh.geometry.dispose();
    rig.env.dispose(); rt.dispose(); comp.dispose(); videoTex.dispose(); maskTex.dispose(); renderer.dispose();
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    kit.setDesign({ guides: prevGuides });
    ov.remove();
    document.documentElement.classList.remove('tryon-open');
    prevFocus?.focus?.();
    onClose?.();
  }

  startCamera();
  return { close, get manual() { return !!manual; }, get tracking() { return !!tracker; }, setHood: (v) => setHood(v ? 1 : 0) };
}

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
