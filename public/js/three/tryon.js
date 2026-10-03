// Live try-on: the camera image with the 3D garment fitted to the person.
//
// Body tracking runs entirely in the browser (MediaPipe Pose Landmarker,
// loaded on demand). Shoulders place, scale and turn the garment, hips set
// its length, elbows and wrists bend the sleeves. If tracking can't load
// (offline, blocked, old device) the garment can be lined up by hand.
// Nothing from the camera is uploaded or stored.
import * as THREE from 'three';
import { lightScene } from './studio.js';

// Pinned so a library update can't change behaviour underneath us. Swap to
// self-hosted copies by changing these three URLs.
export const POSE_CONFIG = {
  module: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

const SHOULDER_TO_HIP_IN = 19;        // adult shoulder joint -> hip joint, roughly

let landmarkerPromise = null;
function loadLandmarker() {
  landmarkerPromise ||= (async () => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Body tracking took too long to load.')), 20000));
    const work = (async () => {
      const vision = await import(/* @vite-ignore */ POSE_CONFIG.module);
      const files = await vision.FilesetResolver.forVisionTasks(POSE_CONFIG.wasm);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: POSE_CONFIG.model, delegate }, runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { return await make('GPU'); } catch { return await make('CPU'); }
    })();
    return Promise.race([work, timeout]);
  })().catch((e) => { landmarkerPromise = null; throw e; });
  return landmarkerPromise;
}

/**
 * Pure fitting maths (exported for tests). Landmarks are in image pixels
 * {x, y, z, v} (z: depth, same scale as x, smaller = closer; v: visibility).
 * Returns the garment transform and arm targets, or null.
 */
export function fitPose(lm, garment, { fit = 1.04 } = {}) {
  const ok = (p) => p && (p.v ?? 1) > 0.5;
  const S11 = lm[11], S12 = lm[12];
  if (!ok(S11) || !ok(S12)) return null;
  // the shoulder on the right of the image takes the garment's +x side
  const lIsRight = S11.x > S12.x;
  const idx = lIsRight ? { l: [11, 13, 15], r: [12, 14, 16] } : { l: [12, 14, 16], r: [11, 13, 15] };
  const W = (p) => new THREE.Vector3(p.x, -p.y, -p.z * 0.5);
  const A = W(lm[idx.l[0]]), B = W(lm[idx.r[0]]);
  const v = A.clone().sub(B), flat = Math.hypot(v.x, v.y);
  const roll = Math.atan2(v.y, v.x);
  const yaw = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(v.z / (v.length() || 1), -1, 1)) * 0.75, -0.7, 0.7);
  const width = Math.max(flat, v.length() * 0.9);
  const s = (width / garment.shoulderWidth) * fit;
  const mid = A.clone().add(B).multiplyScalar(0.5);
  let sy = 1;
  if (ok(lm[23]) && ok(lm[24])) {
    const hip = W(lm[23]).add(W(lm[24])).multiplyScalar(0.5);
    const torso = Math.hypot(hip.x - mid.x, hip.y - mid.y);
    sy = THREE.MathUtils.clamp(torso / (s * SHOULDER_TO_HIP_IN), 0.85, 1.2);
  }
  const arms = {};
  for (const side of ['l', 'r']) {
    const [, e, w] = idx[side];
    arms[side] = ok(lm[e]) ? { elbow: W(lm[e]), wrist: ok(lm[w]) ? W(lm[w]) : null } : null;
  }
  return { position: mid, roll, yaw, scale: s, sy, arms };
}

export function openTryOn(kit, { title = 'Try on', colors = [], color = null, onColor, onClose, tracker: injected = null } = {}) {
  const ov = document.createElement('div');
  ov.className = 'tryon';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Try on');
  ov.innerHTML = `
    <div class="tryon-bar">
      <div><strong data-title></strong><span class="tryon-mode" data-mode></span></div>
      <div class="tryon-actions">
        <button class="tryon-btn" data-mirror aria-pressed="true">Mirror</button>
        <button class="tryon-btn" data-photo>Use a photo</button>
        <button class="tryon-btn tryon-btn--main" data-snap disabled>Snapshot</button>
        <button class="tryon-btn tryon-close" data-close aria-label="Close try-on">✕</button>
      </div>
    </div>
    <div class="tryon-stage" data-stage>
      <video playsinline muted autoplay data-video></video>
      <img alt="" data-img hidden>
      <div class="tryon-msg" data-msg role="status">Starting your camera…</div>
    </div>
    <div class="tryon-foot">
      <div class="tryon-colors" role="group" aria-label="Colour">${colors.map(c => `<button class="swatch" style="background:${c.hex}" data-c="${escAttr(c.name)}" aria-label="${escAttr(c.name)}" aria-pressed="${c.name === color}"></button>`).join('')}</div>
      <label class="tryon-fit">Fit <input type="range" min="88" max="125" value="104" data-fit aria-label="Garment fit"></label>
      <p class="tryon-note">Your camera stays on this device. Nothing is recorded or uploaded.</p>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-file>`;
  document.body.append(ov);
  document.documentElement.classList.add('tryon-open');
  const $ = (s) => ov.querySelector(s);
  const prevFocus = document.activeElement;
  $('[data-title]').textContent = title;
  $('[data-close]').focus();

  // ---- three.js ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.domElement.className = 'tryon-gl';
  $('[data-stage]').insertBefore(renderer.domElement, $('[data-msg]'));
  const scene = new THREE.Scene();
  const rig = lightScene(scene, renderer, { shadows: false });
  rig.rim.intensity = 0.6;
  const camera = new THREE.OrthographicCamera(0, 1280, 0, -720, -5000, 5000);
  camera.position.z = 2000;

  const holder = new THREE.Group();
  scene.add(holder);
  let inst = null, garment = null;
  function mount() {
    inst?.dispose();
    inst = kit.instance({ shadows: false });
    for (const m of inst.group.children) if (m.material === kit.mats.label) m.visible = false;
    const geo = kit.geo, spec = geo.spec;
    const sl = geo.arms?.l.shoulder ?? new THREE.Vector3(geo.torso.ring(spec.L - spec.drop).a - 1.2, spec.L - spec.drop - 1.5, 0);
    const sr = geo.arms?.r.shoulder ?? sl.clone().setX(-sl.x);
    const mid = sl.clone().add(sr).multiplyScalar(0.5);
    inst.group.position.copy(mid).negate();
    // the body inside the clothes hides the garment's inside
    const occ = new THREE.MeshBasicMaterial({ colorWrite: false });
    const r = geo.torso.ring(spec.L - 6);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), occ);
    chest.scale.set(r.a * 0.86, 9, r.b * 0.8); chest.position.set(0, spec.L - 7, r.zc);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.5, 12, 24), occ);
    neck.position.set(0, spec.L + 2, r.zc - 0.6);
    for (const o of [chest, neck]) { o.renderOrder = -1; inst.group.add(o); }
    holder.add(inst.group);
    garment = { shoulderWidth: sl.distanceTo(sr), shoulders: { l: sl, r: sr } };
  }
  mount();
  const offKit = kit.on((what) => { if (what === 'type') mount(); });
  const prevGuides = kit.state.guides;
  kit.setDesign({ guides: false });

  // ---- state ----
  const video = $('[data-video]'), img = $('[data-img]');
  let stream = null, source = null, W = 1280, H = 720, mirror = true, fit = 1.04, raf = 0, closed = false;
  let tracker = injected, trackerFailed = false, lastPose = 0, smooth = null, manual = null, lastVideoTime = -1;
  const msg = (t) => { const m = $('[data-msg]'); m.textContent = t || ''; m.hidden = !t; };

  function setSize(w, h) {
    const k = Math.min(1, 1280 / Math.max(w, h));
    W = Math.round(w * k); H = Math.round(h * k);
    renderer.setSize(W, H, false);
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
    video.hidden = el !== video; img.hidden = el !== img;
    mirror = live ? mirror : false;
    $('[data-mirror]').setAttribute('aria-pressed', mirror);
    $('[data-mirror]').disabled = !live;
    video.classList.toggle('is-mirror', mirror && live);
    setSize(el.videoWidth || el.naturalWidth, el.videoHeight || el.naturalHeight);
    $('[data-snap]').disabled = false;
    smooth = null; manual = null; lastVideoTime = -1;
    msg(trackerFailed ? '' : 'Loading body tracking…');
    startTracking();
    if (!raf) loop();
  }
  async function startTracking() {
    if (tracker || trackerFailed) { modeLabel(); return; }
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
  function modeLabel() {
    $('[data-mode]').textContent = tracker ? 'Live body tracking' : manual ? 'Manual fit' : '';
  }
  function enableManual(note) {
    manual ||= { x: W / 2, y: H * 0.3, s: (H * 0.62) / kit.geo.spec.L, roll: 0 };
    if (note) { const n = $('[data-msg]'); n.textContent = note; n.hidden = false; setTimeout(() => { if (n.textContent === note) n.hidden = true; }, 6000); }
    modeLabel();
  }

  // ---- per frame ----
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!source) return;
    let pose = null;
    if (tracker && source === video && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      pose = detect(video, performance.now());
    } else if (tracker && source === img && !smooth) {
      pose = detect(img, performance.now());
    }
    if (pose) { lastPose = performance.now(); place(pose); msg(''); }
    else if (tracker && smooth && performance.now() - lastPose > 1500) msg('Step back so your shoulders and hips are in view.');
    else if (tracker && !smooth && !manual && performance.now() - lastPose > 4000) enableManual('Can\'t find you yet. You can drag the garment into place.');
    if (manual && (!smooth || performance.now() - lastPose > 1500)) placeManual();
    renderer.render(scene, camera);
  }
  function detect(el, ts) {
    let res;
    try { res = tracker.detectForVideo(el, ts); } catch { return null; }
    const raw = res?.landmarks?.[0];
    if (!raw) return null;
    const lm = raw.map(p => ({ x: (mirror ? 1 - p.x : p.x) * W, y: p.y * H, z: p.z * W, v: p.visibility ?? 1 }));
    // smooth: steadier when still, responsive when moving
    if (!smooth) smooth = lm;
    else smooth = smooth.map((o, i) => {
      const n = lm[i], d = Math.hypot(n.x - o.x, n.y - o.y), a = Math.min(0.85, 0.3 + d / 60);
      return { x: o.x + (n.x - o.x) * a, y: o.y + (n.y - o.y) * a, z: o.z + (n.z - o.z) * a * 0.5, v: n.v };
    });
    return fitPose(smooth, garment, { fit });
  }
  function place(p) {
    holder.position.copy(p.position);
    holder.rotation.set(0, p.yaw, p.roll, 'ZYX');
    holder.scale.set(p.scale, p.scale * p.sy, p.scale);
    holder.updateMatrixWorld(true);
    if (inst.geo.sleeves) for (const side of ['l', 'r']) {
      const a = p.arms[side];
      if (!a) { inst.setArm(side, null); continue; }
      const sh = garment.shoulders[side];
      const e = inst.group.worldToLocal(a.elbow.clone());
      const w = a.wrist ? inst.group.worldToLocal(a.wrist.clone()) : e.clone().add(e.clone().sub(sh).multiplyScalar(0.9));
      // keep the elbow from collapsing into the shoulder
      if (e.distanceTo(sh) < 4) { inst.setArm(side, null); continue; }
      inst.setArm(side, { shoulder: sh.clone(), elbow: e, wrist: w });
    }
  }
  function placeManual() {
    holder.position.set(manual.x, -manual.y, 0);
    holder.rotation.set(0, 0, manual.roll, 'ZYX');
    holder.scale.setScalar(manual.s * fit / 1.04);
    if (inst.geo.sleeves) { inst.setArm('l', null); inst.setArm('r', null); }
  }

  // ---- manual drag / pinch / wheel ----
  const pointers = new Map();
  let pinch = null;
  const toImage = (e) => {
    // canvas uses object-fit: cover; map client px -> image px
    const r = renderer.domElement.getBoundingClientRect(), k = Math.max(r.width / W, r.height / H);
    return { x: (e.clientX - r.left - (r.width - W * k) / 2) / k, y: (e.clientY - r.top - (r.height - H * k) / 2) / k };
  };
  $('[data-stage]').addEventListener('pointerdown', (e) => {
    if (!source) return;
    if (!manual) { if (tracker && smooth) return; enableManual(); }
    pointers.set(e.pointerId, toImage(e));
    $('[data-stage]').setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: manual.s }; }
  });
  $('[data-stage]').addEventListener('pointermove', (e) => {
    if (!manual || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId), now = toImage(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      manual.s = Math.max(0.5, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d || 1));
    } else if (pointers.size === 1) { manual.x += now.x - prev.x; manual.y += now.y - prev.y; }
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  $('[data-stage]').addEventListener('pointerup', up);
  $('[data-stage]').addEventListener('pointercancel', up);
  $('[data-stage]').addEventListener('wheel', (e) => {
    if (!manual) return;
    e.preventDefault();
    manual.s = Math.max(0.5, manual.s * (e.deltaY < 0 ? 1.06 : 0.94));
  }, { passive: false });

  // ---- controls ----
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-close]')) close();
    else if (b.matches('[data-mirror]')) { mirror = !mirror; b.setAttribute('aria-pressed', mirror); video.classList.toggle('is-mirror', mirror); smooth = null; }
    else if (b.matches('[data-photo]')) $('[data-file]').click();
    else if (b.matches('[data-snap]')) snapshot();
    else if (b.dataset.c) {
      ov.querySelectorAll('[data-c]').forEach(x => x.setAttribute('aria-pressed', x === b));
      const t = onColor?.(b.dataset.c);
      if (t) $('[data-title]').textContent = t;
      kit.setDesign({ guides: false });
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
    else if (e.key === 'Tab') {                                 // keep focus inside the dialog
      const f = [...ov.querySelectorAll('button:not([disabled]), input:not([hidden])')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  function snapshot() {
    if (!source) return;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (source === video && mirror) { g.translate(W, 0); g.scale(-1, 1); }
    g.drawImage(source, 0, 0, W, H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    renderer.render(scene, camera);
    g.drawImage(renderer.domElement, 0, 0, W, H);
    c.toBlob((blob) => {
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
    offKit(); inst?.dispose(); rig.env.dispose(); renderer.dispose();
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    kit.setDesign({ guides: prevGuides });
    ov.remove();
    document.documentElement.classList.remove('tryon-open');
    prevFocus?.focus?.();
    onClose?.();
  }

  startCamera();
  return { close, get manual() { return !!manual; }, get tracking() { return !!tracker; } };
}

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
