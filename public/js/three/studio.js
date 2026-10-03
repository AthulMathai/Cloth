// 3D studio: the garment on an invisible mannequin under soft studio light.
// Orbit with mouse/touch, snap to front/back/sleeves, and drag artwork
// directly on the garment. Renders only when something changes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

/** Shared light rig + environment for any scene that shows garments. */
export function lightScene(scene, renderer, { shadows = true } = {}) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xfff6ec, 2.3);
  key.position.set(-18, 58, 34);
  if (shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 140 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.04; key.shadow.radius = 4;
  }
  const rim = new THREE.DirectionalLight(0xf4f6ff, 0.95); rim.position.set(30, 26, -42);
  const fill = new THREE.HemisphereLight(0xffffff, 0x2a2622, 0.5);
  scene.add(key, key.target, rim, fill);
  return { key, rim, fill, env };
}

const VIEWS = {
  front: { az: 0, pol: 1.47 }, back: { az: Math.PI, pol: 1.47 },
  sleeve_l: { az: 0.95, pol: 1.5 }, sleeve_r: { az: -0.95, pol: 1.5 },
  three: { az: 0.55, pol: 1.38 },
};

export function createStudio(host, kit, { onPick, onMove, onDragEnd } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'dz-3d-canvas';
  renderer.domElement.setAttribute('aria-label', '3D preview of your garment. Drag to turn it.');
  renderer.domElement.setAttribute('role', 'img');
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const rig = lightScene(scene, renderer);
  const camera = new THREE.PerspectiveCamera(26, 1, 1, 600);

  // soft shadow under the garment
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(36, 16), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = -1.58;
  scene.add(blob);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enablePan = false; controls.rotateSpeed = 0.8;
  controls.minPolarAngle = 0.55; controls.maxPolarAngle = 2.05;
  renderer.domElement.addEventListener('wheel', () => { userZoomed = true; }, { passive: true });

  let inst = null, fit = 70, needs = true, raf = 0, tween = null, alive = true, visible = true, userZoomed = false;

  function mount() {
    inst?.dispose();
    inst = kit.instance();
    scene.add(inst.group);
    const h = kit.geo.height;
    controls.target.set(0, h * 0.5 - 0.8, 0);
    frame();
    needs = true;
  }
  function frame() {
    const w = host.clientWidth || 600, h = host.clientHeight || 600;
    const aspect = w / h, vt = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const halfH = kit.geo.height * 0.56 + 2, halfW = 19;
    fit = Math.max(halfH / vt, halfW / (vt * aspect)) + 8;
    controls.minDistance = fit * 0.42; controls.maxDistance = fit * 1.6;
    if (!camera.userData.placed) { camera.userData.placed = true; apply(new THREE.Spherical(fit, VIEWS.three.pol, VIEWS.three.az)); }
    else if (!userZoomed && !tween) { const s = spherical(); s.radius = fit; apply(s); }
  }
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (kit.geo) frame();
    needs = true;
  }

  function spherical() {
    const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    return s;
  }
  function setView(name, { instant = false } = {}) {
    const v = VIEWS[name] || VIEWS.front;
    const from = spherical(), to = new THREE.Spherical(userZoomed ? from.radius : fit, v.pol, v.az);
    if (!camera.userData.placed || !from.radius) from.copy(to);
    // turn the short way round
    let d = to.theta - from.theta;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    to.theta = from.theta + d;
    if (instant || reduced) { apply(to); return; }
    tween = { from, to, t0: performance.now(), dur: 700 };
    needs = true;
  }
  function apply(s) {
    camera.position.setFromSpherical(s).add(controls.target);
    camera.lookAt(controls.target);
    needs = true;
  }
  function zoom(f) {
    userZoomed = true;
    const s = spherical();
    s.radius = THREE.MathUtils.clamp(s.radius * f, controls.minDistance, controls.maxDistance);
    tween = { from: spherical(), to: s, t0: performance.now(), dur: reduced ? 1 : 260 };
    needs = true;
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!visible) return;
    if (tween) {
      const t = Math.min(1, (performance.now() - tween.t0) / tween.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const s = new THREE.Spherical(
        THREE.MathUtils.lerp(tween.from.radius, tween.to.radius, e),
        THREE.MathUtils.lerp(tween.from.phi, tween.to.phi, e),
        THREE.MathUtils.lerp(tween.from.theta, tween.to.theta, e));
      apply(s);
      if (t >= 1) tween = null;
    }
    const moved = controls.update();
    if (moved || needs) { renderer.render(scene, camera); needs = false; }
  }

  // --- drag artwork on the garment -----------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let drag = null, hoverT = 0;
  function cast(e, meshes) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(meshes, false)[0] || null;
  }
  function onDown(e) {
    if (!inst || (e.pointerType === 'mouse' && e.button !== 0) || !e.isPrimary) return;
    const hit = cast(e, inst.picks);
    if (!hit || !hit.uv) return;
    const part = hit.object.userData.part, info = kit.hitLayer(part, hit.uv);
    if (!info) return;
    e.stopPropagation(); e.preventDefault();
    drag = { id: info.layer.id, part, area: info.area, start: info.local, x0: info.layer.x_in, y0: info.layer.y_in, moved: false };
    controls.enabled = false;
    host.setPointerCapture(e.pointerId);
    host.classList.add('is-grabbing');
    onPick?.(info.layer.id);
  }
  function onMoveEvt(e) {
    if (drag) {
      const hit = cast(e, inst.picks.filter(m => m.userData.part === drag.part));
      if (!hit?.uv) return;
      const q = kit.areaLocal(drag.area, kit.uvToInches(drag.part, hit.uv));
      const x = drag.x0 + (q.x - drag.start.x), y = drag.y0 + (q.y - drag.start.y);
      drag.moved = true;
      onMove?.(drag.id, Math.min(drag.area.w, Math.max(0, x)), Math.min(drag.area.h, Math.max(0, y)));
      return;
    }
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const now = performance.now();
    if (now - hoverT < 60) return;
    hoverT = now;
    const hit = inst && cast(e, inst.picks);
    host.classList.toggle('is-over-art', !!(hit?.uv && kit.hitLayer(hit.object.userData.part, hit.uv)));
  }
  function onUp() {
    if (!drag) return;
    const d = drag; drag = null;
    controls.enabled = true;
    host.classList.remove('is-grabbing');
    onDragEnd?.(d.id, d.moved);
  }
  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMoveEvt);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);

  const offKit = kit.on((what) => { if (what === 'type') mount(); else needs = true; });
  const ro = new ResizeObserver(resize); ro.observe(host);
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; needs = true; }); io.observe(host);
  resize();
  mount();
  loop();

  return {
    renderer, scene, camera, rig,
    setView, zoom,
    get instance() { return inst; },
    invalidate() { needs = true; },
    /** Opaque product shot of one view, used as the saved mockup. */
    async mockup(view = 'front', { width = 900, height = 990, background = '#efe9dd' } = {}) {
      const prev = { size: renderer.getSize(new THREE.Vector2()), pr: renderer.getPixelRatio(), pos: camera.position.clone(), aspect: camera.aspect, bg: scene.background, guides: kit.state.guides };
      if (prev.guides) kit.setDesign({ guides: false });
      renderer.setPixelRatio(1); renderer.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix();
      const vt = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const radius = Math.max((kit.geo.height * 0.6 + 1.5) / vt, 17 / (vt * camera.aspect)) + 8;
      const v = VIEWS[view] || VIEWS.front;
      camera.position.setFromSpherical(new THREE.Spherical(radius, v.pol, v.az)).add(controls.target);
      camera.lookAt(controls.target);
      scene.background = new THREE.Color(background);
      renderer.render(scene, camera);
      const blob = await new Promise(r => renderer.domElement.toBlob(r, 'image/png'));
      scene.background = prev.bg;
      renderer.setPixelRatio(prev.pr); renderer.setSize(prev.size.x, prev.size.y, false);
      renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
      camera.aspect = prev.aspect; camera.updateProjectionMatrix();
      camera.position.copy(prev.pos); camera.lookAt(controls.target);
      if (prev.guides) kit.setDesign({ guides: true });
      needs = true;
      return blob;
    },
    dispose() {
      alive = false; cancelAnimationFrame(raf); offKit(); ro.disconnect(); io.disconnect();
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMoveEvt);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      inst?.dispose(); controls.dispose(); rig.env.dispose(); renderer.dispose();
      renderer.domElement.remove();
      void alive;
    },
  };
}

function blobTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 64, 4, 128, 64, 124);
  gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(0.5, 'rgba(0,0,0,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.setTransform(1, 0, 0, 0.5, 0, 32); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
