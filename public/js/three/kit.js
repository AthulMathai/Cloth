// GarmentKit: one garment (type + colour + size) and one design, turned into
// fabric textures and materials that any number of 3D views share (the
// studio viewer and the camera try-on). Prints are drawn with the same
// layer renderer as the production files, so the 3D preview shows exactly
// what will be printed, clipped to the same print areas.
import * as THREE from 'three';
import { buildGarmentGeometry, buildSleeve, SPECS } from './garment-model.js';
import { fabricMaterial, tintFabric, stitchPattern, luminance } from './fabric.js';
import { drawLayer, areaGeometry, loadImage } from '../lib/designs.js';

// 2D garment drawings (components/garment.js) put the high point of the
// shoulder and the shoulder seam here; used to convert print-area
// positions to inches on the 3D garment.
const HPS_2D = { tee: 22, longsleeve: 22, crewneck: 24, hoodie: 40, tank: 22 };
const SHOULDER_2D = { tee: [262, 46], longsleeve: [258, 42], crewneck: [258, 44], hoodie: [258, 48], tank: [222, 22] };

// Ink look per print method: opacity and surface roughness (0..255).
const METHOD_LOOK = {
  dtg: { alpha: 0.95, rough: 226 }, dtf: { alpha: 1, rough: 150 }, screen: { alpha: 1, rough: 185 },
  embroidery: { alpha: 1, rough: 160, thread: true }, vinyl: { alpha: 1, rough: 90 },
};

/** Where a print area sits on the 3D garment, in inches on a part. */
export function placementOnPart(type, placement) {
  const t = SPECS[type] ? type : 'tee';
  const g = areaGeometry(t, placement);
  if (/sleeve/.test(placement.code)) {
    const left = placement.code.startsWith('left');
    const sh = SHOULDER_2D[t] || SHOULDER_2D.tee, shx = left ? sh[0] : 300 - sh[0];
    return { part: left ? 'sleeve_l' : 'sleeve_r', cx: 0, cy: Math.hypot(g.cx - shx, g.cy - sh[1]) / 10,
             w: +placement.max_w_in, h: +placement.max_h_in, rot: 0 };
  }
  return { part: placement.view === 'back' ? 'back' : 'front', cx: (g.cx - 150) / 10, cy: (g.cy - (HPS_2D[t] ?? 22)) / 10,
           w: +placement.max_w_in, h: +placement.max_h_in, rot: g.rot || 0 };
}

export class GarmentKit {
  constructor({ ppi = 40 } = {}) {
    this.ppi = ppi;
    this.geoCache = new Map();
    this.listeners = new Set();
    this.state = { type: null, color: '#141414', size: 'M', layers: [], placements: [], art: {}, methods: {}, selected: null, active: null, guides: false };
    this.images = new Map();
    this.surfaces = {};
    this.mats = {};
    this.geo = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }

  geometry(type) {
    if (!this.geoCache.has(type)) this.geoCache.set(type, buildGarmentGeometry(type));
    return this.geoCache.get(type);
  }
  get spec() { return this.geo.spec; }

  setGarment({ type, color, size }) {
    const s = this.state, typeChanged = type && type !== s.type;
    const colorChanged = color && color !== s.color, sizeChanged = size && size !== s.size;
    if (type) s.type = type; if (color) s.color = color; if (size) s.size = size;
    if (typeChanged) { this.geo = this.geometry(s.type); this.buildSurfaces(); }
    if (typeChanged || colorChanged) this.tint();
    if (typeChanged || colorChanged) this.redraw();
    if (typeChanged || sizeChanged || colorChanged) this.drawLabel();
    if (typeChanged) this.emit('type');
  }

  /** design: { layers, placements, art, methods, selected, active, guides } */
  setDesign(d) {
    Object.assign(this.state, d);
    this.redraw();
  }

  // ---------------------------------------------------------------
  buildSurfaces() {
    for (const s of Object.values(this.surfaces)) { s.tex.dispose(); s.roughTex.dispose(); }
    for (const m of Object.values(this.mats)) m.dispose?.();
    this.surfaces = {}; this.mats = {};
    const g = this.geo, fabric = g.spec.fabric;
    const parts = { front: g.panelFrame, back: g.panelFrame };
    if (g.sleeveFrame) { parts.sleeve_l = g.sleeveFrame; parts.sleeve_r = g.sleeveFrame; }
    for (const [part, frame] of Object.entries(parts)) {
      const ppi = part.startsWith('sleeve') ? Math.round(this.ppi * 0.8) : this.ppi;
      const canvas = document.createElement('canvas'), rough = document.createElement('canvas');
      canvas.width = rough.width = Math.round(frame.W * ppi); canvas.height = rough.height = Math.round(frame.H * ppi);
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const roughTex = new THREE.CanvasTexture(rough); roughTex.colorSpace = THREE.NoColorSpace;
      this.surfaces[part] = { part, frame, ppi, canvas, ctx: canvas.getContext('2d'), rough, rctx: rough.getContext('2d'), tex, roughTex };
      this.mats[part] = fabricMaterial({ map: tex, roughnessMap: roughTex, normalKind: fabric, repeat: [frame.W, frame.H],
                                         normalScale: fabric === 'fleece' ? 0.4 : 0.55 });
    }
    this.mats.plain = fabricMaterial({ normalKind: fabric, repeat: [6, 1], normalScale: 0.45 });
    this.mats.hood = fabricMaterial({ normalKind: fabric, repeat: [14, 10], normalScale: 0.45 });
    this.mats.rib = fabricMaterial({ normalKind: 'rib', repeat: [1, 1], normalScale: 0.9 });
    this.mats.rib.roughness = 0.95;
    this.mats.trim = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, metalness: 0.85, roughness: 0.32 });
    const lc = document.createElement('canvas'); lc.width = 256; lc.height = 144;
    this.labelCanvas = lc;
    const lt = new THREE.CanvasTexture(lc); lt.colorSpace = THREE.SRGBColorSpace;
    this.mats.label = new THREE.MeshStandardMaterial({ map: lt, roughness: 0.8, side: THREE.FrontSide });
  }

  tint() {
    const c = this.state.color;
    for (const k of ['front', 'back', 'sleeve_l', 'sleeve_r']) if (this.mats[k]) tintFabric(this.mats[k], c);
    for (const k of ['plain', 'hood', 'rib']) tintFabric(this.mats[k], c, { useColor: true });
    // ribbing reads slightly darker (denser knit)
    this.mats.rib.color.multiplyScalar(0.9);
  }

  drawLabel() {
    const c = this.labelCanvas, g = c.getContext('2d');
    g.fillStyle = '#f2efe8'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(0,0,0,.12)'; g.lineWidth = 4; g.strokeRect(6, 6, c.width - 12, c.height - 12);
    g.fillStyle = '#1a1a1a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = "800 64px 'Inter', system-ui, sans-serif";
    g.fillText(this.state.size || 'M', c.width / 2, c.height / 2 + 4);
    this.mats.label.map.needsUpdate = true;
  }

  // ---------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------
  areas() {
    const t = this.state.type;
    return this.state.placements.map(p => ({ code: p.code, ...placementOnPart(t, p) }));
  }

  imageFor(l) {
    const key = l.asset_id || l.local, a = this.state.art[key];
    if (!a) return null;
    if (a.img) return a.img;
    if (!this.images.has(a.url)) {
      this.images.set(a.url, null);
      loadImage(a.url).then(img => { a.img = img; this.images.set(a.url, img); this.redraw(); }).catch(() => {});
    }
    return this.images.get(a.url);
  }

  toPx(s, x, y) {
    return [(x + s.frame.W / 2) * s.ppi, y * s.ppi];
  }

  redraw(only) {
    if (!this.geo) return;
    for (const s of Object.values(this.surfaces)) if (!only || only.includes(s.part)) this.drawSurface(s);
    this.emit('redraw');
  }

  drawSurface(s) {
    const { ctx, rctx, canvas } = s, st = this.state, spec = this.spec;
    const dark = luminance(st.color) < 0.35;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = st.color; ctx.fillRect(0, 0, canvas.width, canvas.height);
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    rctx.fillStyle = 'rgb(248,248,248)'; rctx.fillRect(0, 0, canvas.width, canvas.height);
    this.drawStitches(s, dark);

    for (const a of this.areas().filter(a => a.part === s.part)) {
      const layers = st.layers.filter(l => l.placement === a.code);
      if (!layers.length) continue;
      const look = METHOD_LOOK[st.methods?.[a.code] || 'dtg'] || METHOD_LOOK.dtg;
      const w = Math.max(1, Math.round(a.w * s.ppi)), h = Math.max(1, Math.round(a.h * s.ppi));
      const tmp = scratch('a', w, h), t = tmp.getContext('2d');
      t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'source-over'; t.globalAlpha = 1;
      t.clearRect(0, 0, w, h);
      for (const l of layers) drawLayer(t, l, this.imageFor(l), s.ppi);
      if (look.thread) {
        t.globalCompositeOperation = 'source-atop';
        t.fillStyle = stitchPattern(t); t.fillRect(0, 0, w, h);
        t.globalCompositeOperation = 'source-over';
      }
      const [cx, cy] = this.toPx(s, a.cx, a.cy);
      const place = (c) => { c.save(); c.translate(cx, cy); c.rotate(a.rot * Math.PI / 180); c.translate(-w / 2, -h / 2); };
      place(ctx); ctx.globalAlpha = look.alpha; ctx.drawImage(tmp, 0, 0); ctx.restore(); ctx.globalAlpha = 1;
      // roughness: the inked area gets the method's finish
      const m = scratch('m', w, h), mc = m.getContext('2d');
      mc.globalCompositeOperation = 'source-over'; mc.clearRect(0, 0, w, h); mc.drawImage(tmp, 0, 0);
      mc.globalCompositeOperation = 'source-in'; mc.fillStyle = `rgb(${look.rough},${look.rough},${look.rough})`; mc.fillRect(0, 0, w, h);
      place(rctx); rctx.drawImage(m, 0, 0); rctx.restore();
    }
    if (st.guides) this.drawGuides(s, dark);
    s.tex.needsUpdate = true; s.roughTex.needsUpdate = true;
    void spec;
  }

  drawStitches(s, dark) {
    const { ctx, ppi } = s, spec = this.spec, L = spec.L;
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.2)';
    ctx.lineWidth = Math.max(1, 0.035 * ppi);
    ctx.setLineDash([0.13 * ppi, 0.07 * ppi]);
    const line = (x0, d0, x1, d1) => { const a = this.toPx(s, x0, d0), b = this.toPx(s, x1, d1); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
    const W = s.frame.W;
    if (s.part === 'front' || s.part === 'back') {
      if (spec.hemStitch) for (const o of [0, 0.22]) line(-W / 2, L - spec.hemStitch - o, W / 2, L - spec.hemStitch - o);
      if (s.part === 'front' && spec.pocket) {
        const yb = spec.hemRib + 0.35, yt = spec.hemRib + 6.9, yo = yb + 0.32 * (yt - yb), d = (y) => L - y;
        for (const sx of [-1, 1]) {
          line(sx * 4.75, d(yt - 0.22), sx * 6.5, d(yo + 0.05));        // hand opening hem
          line(sx * 6.45, d(yo), sx * 6.45, d(yb + 0.2));
        }
        line(-4.8, d(yt - 0.22), 4.8, d(yt - 0.22));
        line(-6.5, d(yb + 0.22), 6.5, d(yb + 0.22));
      }
    } else if (spec.sleeve?.hemStitch) {
      const dd = spec.sleeve.len - spec.sleeve.hemStitch;
      for (const o of [0, 0.22]) line(-W / 2, dd - o, W / 2, dd - o);
    }
    ctx.restore();
  }

  drawGuides(s, dark) {
    const { ctx, ppi } = s, st = this.state;
    const sel = st.layers.find(l => l.id === st.selected);
    const focus = sel?.placement || st.active;
    const a = this.areas().find(x => x.code === focus && x.part === s.part);
    if (!a) return;
    const [cx, cy] = this.toPx(s, a.cx, a.cy), w = a.w * ppi, h = a.h * ppi;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a.rot * Math.PI / 180);
    ctx.lineWidth = Math.max(1.5, 0.05 * ppi);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.4)';
    ctx.setLineDash([0.3 * ppi, 0.2 * ppi]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    if (sel && sel.placement === a.code) {
      ctx.translate(-w / 2, -h / 2);
      ctx.translate(sel.x_in * ppi, sel.y_in * ppi); ctx.rotate((sel.rotation || 0) * Math.PI / 180);
      ctx.setLineDash([]);
      ctx.strokeStyle = '#3d8bff'; ctx.lineWidth = Math.max(2, 0.06 * ppi);
      ctx.strokeRect(-sel.w_in * ppi / 2, -sel.h_in * ppi / 2, sel.w_in * ppi, sel.h_in * ppi);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------
  // Hit testing (drag artwork on the 3D garment)
  // ---------------------------------------------------------------
  uvToInches(part, uv) {
    const s = this.surfaces[part];
    return { x: uv.x * s.frame.W - s.frame.W / 2, y: (1 - uv.y) * s.frame.H };
  }
  areaLocal(area, p) {
    const r = -area.rot * Math.PI / 180, dx = p.x - area.cx, dy = p.y - area.cy;
    return { x: dx * Math.cos(r) - dy * Math.sin(r) + area.w / 2, y: dx * Math.sin(r) + dy * Math.cos(r) + area.h / 2 };
  }
  /** -> { layer, area, local } for the topmost layer under a point, or null */
  hitLayer(part, uv) {
    const p = this.uvToInches(part, uv), st = this.state;
    for (const a of this.areas().filter(a => a.part === part)) {
      const q = this.areaLocal(a, p);
      if (q.x < -0.3 || q.y < -0.3 || q.x > a.w + 0.3 || q.y > a.h + 0.3) continue;
      const layers = st.layers.filter(l => l.placement === a.code);
      const hits = layers.filter(l => {
        const r = -(l.rotation || 0) * Math.PI / 180, dx = q.x - l.x_in, dy = q.y - l.y_in;
        const ux = dx * Math.cos(r) - dy * Math.sin(r), uy = dx * Math.sin(r) + dy * Math.cos(r);
        return Math.abs(ux) <= l.w_in / 2 + 0.2 && Math.abs(uy) <= l.h_in / 2 + 0.2;
      });
      const layer = hits.find(l => l.id === st.selected) || hits[hits.length - 1];
      if (layer) return { layer, area: a, local: q };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------
  instance({ shadows = true } = {}) {
    const geo = this.geo, mats = this.mats, group = new THREE.Group(), picks = [];
    const add = (g, m, part = null) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = shadows; mesh.receiveShadow = shadows;
      if (part) { mesh.userData.part = part; picks.push(mesh); }
      group.add(mesh);
      return mesh;
    };
    add(geo.front, mats.front, 'front');
    add(geo.back, mats.back, 'back');
    if (geo.pocket) add(geo.pocket.geometry, mats.front, 'front');
    const roles = { hoodDown: [], cords: [], tips: [], torso: [] };
    for (const g of geo.plain) {
      const m = add(g, g.userData.hood ? mats.hood : mats.plain);
      if (g.userData.hood) m.userData.role = 'hoodDown';
      if (g.userData.role === 'hoodDown') roles.hoodDown.push(m);
      if (g.userData.role === 'cord') roles.cords.push(m);
    }
    for (const g of geo.rib) roles.torso.push(add(g, mats.rib));
    for (const g of geo.trim) { const m = add(g, mats.trim); if (g.userData.role === 'tip') roles.tips.push(m); }
    // hood pulled up: hinged at the back of the neck so it can be pulled over
    let hoodPivot = null, hoodMesh = null, hood = 0;
    if (geo.hoodUp) {
      hoodPivot = new THREE.Group();
      hoodPivot.position.copy(geo.hoodUp.userData.pivot);
      hoodMesh = new THREE.Mesh(geo.hoodUp, mats.hood);
      hoodMesh.castShadow = shadows; hoodMesh.receiveShadow = shadows;
      hoodMesh.position.copy(geo.hoodUp.userData.pivot).negate();
      hoodPivot.add(hoodMesh); group.add(hoodPivot);
      hoodPivot.visible = false;
    }
    const label = add(geo.label, mats.label); label.castShadow = false;
    const sleeves = {};
    if (geo.sleeves) {
      for (const [k, sx] of [['l', 1], ['r', -1]]) {
        const sl = geo.sleeves[k];
        sleeves[k] = { sx, main: add(sl.main, mats[`sleeve_${k}`], `sleeve_${k}`), cuff: sl.cuff ? add(sl.cuff, mats.rib) : null, custom: false };
      }
    }
    const kit = this;
    return {
      group, picks, geo, roles, sleeves, hoodMesh,
      get hood() { return hood; },
      /** 0 = hood down on the back, 1 = pulled up over the head (in between animates). */
      setHood(p) {
        hood = Math.min(1, Math.max(0, p));
        if (!hoodPivot) return;
        const e = hood * hood * (3 - 2 * hood);
        for (const m of roles.hoodDown) m.visible = hood < 0.45;
        hoodPivot.visible = hood > 0.2;
        hoodPivot.rotation.x = -(1 - e) * 2.2;            // swings up from lying on the back
        hoodPivot.scale.set(1, 0.55 + 0.45 * e, 0.6 + 0.4 * e);
      },
      /** Pose a sleeve along an arm path {shoulder, elbow, wrist}; null restores the default. */
      setArm(side, arm) {
        const s = sleeves[side];
        if (!s) return;
        const fresh = arm ? buildSleeve(geo.spec, arm, s.sx, geo.sleeveFrame, { fit: true }) : geo.sleeves[side];
        if (s.custom) { s.main.geometry.dispose(); s.cuff?.geometry.dispose(); }
        s.main.geometry = fresh.main;
        if (s.cuff) { if (fresh.cuff) s.cuff.geometry = fresh.cuff; s.cuff.visible = !!fresh.cuff; }
        s.custom = !!arm;
      },
      dispose() {
        for (const s of Object.values(sleeves)) if (s.custom) { s.main.geometry.dispose(); s.cuff?.geometry.dispose(); }
        group.removeFromParent();
      },
      kit,
    };
  }
}

const scratchCanvases = {};
function scratch(key, w, h) {
  const c = scratchCanvases[key] ||= document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
