// Procedural 3D garments, modelled in inches like a pattern maker would:
// front and back panels, set-in sleeves, ribbing, hood, kangaroo pocket.
//
// Every printable part carries UVs measured in inches of fabric:
//   torso panels: x = inches across the panel from the centre line (along the
//                 curved surface), y = inches down from the high point of the
//                 shoulder (HPS) — the same way a print shop measures.
//   sleeves:      x = inches around the sleeve from the print line,
//                 y = inches down the sleeve from the shoulder.
// So a 12-inch-wide print covers exactly 12 inches of fabric, wrinkles and all.
import * as THREE from 'three';

import { SPECS, profile } from './specs.js';
export { SPECS };

// ---------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

function hash(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 0x7fff - 1;
}
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t) => t * t * (3 - 2 * t);
  const tx = f(x - xi), ty = f(y - yi), tz = f(z - zi);
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    v += hash(xi + dx, yi + dy, zi + dz) * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
  }
  return v;
}


// ---------------------------------------------------------------------
// Torso surface
// ---------------------------------------------------------------------
// Unit superellipse x = sin(t)^(2/n), z = k cos(t)^(2/n), t in [0, pi/2]
// (t = 0 is the centre front). Table of arc fraction -> angle.
function arcTable(k, n, steps = 96) {
  const e = 2 / n, ts = [0], ss = [0];
  let px = 0, pz = k, len = 0;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * Math.PI / 2, x = spow(Math.sin(t), e), z = k * spow(Math.cos(t), e);
    len += Math.hypot(x - px, z - pz); px = x; pz = z;
    ts.push(t); ss.push(len);
  }
  return { len, theta(frac) {
    const target = clamp(frac, 0, 1) * len;
    let lo = 0, hi = steps;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ss[mid] < target) lo = mid; else hi = mid; }
    const t = (target - ss[lo]) / Math.max(1e-9, ss[hi] - ss[lo]);
    return lerp(ts[lo], ts[hi], t);
  } };
}

export function createTorso(spec) {
  const F = profile(spec.F), K = profile(spec.k), ZC = profile(spec.zc), n = spec.n, e = 2 / n, L = spec.L;
  // ring dimensions on a fine height grid
  const STEP = 0.05, N = Math.ceil((L + 0.2) / STEP) + 1, ringA = new Float32Array(N), ringB = new Float32Array(N), ringZ = new Float32Array(N);
  const tableCache = new Map();
  const tableAt = (y) => {
    const key = Math.round(y / STEP);
    if (!tableCache.has(key)) tableCache.set(key, arcTable(K(key * STEP), n));
    return tableCache.get(key);
  };
  for (let i = 0; i < N; i++) {
    const y = i * STEP, k = K(y), q = arcTable(k, n, 64).len;
    ringA[i] = F(y) / q; ringB[i] = ringA[i] * k; ringZ[i] = ZC(y);
  }
  const ring = (y) => {
    const f = clamp(y / STEP, 0, N - 1.001), i = Math.floor(f), t = f - i;
    return { a: lerp(ringA[i], ringA[i + 1], t), b: lerp(ringB[i], ringB[i + 1], t), zc: lerp(ringZ[i], ringZ[i + 1], t) };
  };

  const hemRib = spec.hemRib || 0, ya = spec.armpit;
  // Fabric wrinkles: a normal offset in inches. Uses the undeformed point so
  // it's seamless across panels.
  function wrinkle(x, y, z, th) {
    let d = 0.1 * noise3(x / 5.5, y / 5.5, z / 5.5) + 0.045 * noise3(x / 2.1 + 9, y / 2.1, z / 2.1);
    if (!hemRib && y < 3.5) d += 0.12 * Math.sin(th * 7 + 2 * noise3(x / 4, 1, z / 4)) * (1 - y / 3.5);   // hem ripple
    if (hemRib) {                                                                                         // blousing above the waistband
      const b = y - hemRib;
      if (b > -0.4 && b < 5) {
        const w = Math.sin(Math.PI * clamp((b + 0.4) / 5.4, 0, 1));
        d += 0.22 * w + 0.13 * Math.sin(b * 2.7 + 2.2 * noise3(x / 3, 3, z / 3)) * w;
      }
    }
    const side = Math.abs(Math.sin(th));                                                                 // drag lines from the armpit
    if (side > 0.55 && y > ya - 6 && y < ya + 0.5) {
      const m = smooth(0.55, 0.9, side) * smooth(ya - 6, ya - 2, y) * (1 - smooth(ya - 0.5, ya + 0.5, y));
      d += 0.11 * Math.sin((y + Math.abs(Math.cos(th)) * 9) * 1.7) * m;
    }
    return d;
  }
  function base(th, y) {
    const r = ring(y), s = Math.sin(th), c = Math.cos(th);
    const x = r.a * spow(s, e), z = r.zc + r.b * spow(c, e);
    // outward direction (ignoring the vertical slope)
    const dx = r.a * e * Math.pow(Math.abs(s) + 1e-6, e - 1) * c;
    const dz = -r.b * e * Math.pow(Math.abs(c) + 1e-6, e - 1) * s;
    const l = Math.hypot(dx, dz) || 1;
    return { x, y, z, nx: -dz / l, nz: dx / l };
  }
  function point(th, y, offset = 0, out = new THREE.Vector3()) {
    const p = base(th, y), d = wrinkle(p.x, p.y, p.z, th) + offset;
    return out.set(p.x + p.nx * d, p.y, p.z + p.nz * d);
  }
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
  function normal(th, y, out = new THREE.Vector3()) {
    const et = 0.004, ey = 0.02;
    point(th + et, y, 0, _a); point(th - et, y, 0, _b); _a.sub(_b);
    point(th, y + ey, 0, _c); point(th, y - ey, 0, _d); _c.sub(_d);
    out.crossVectors(_a, _c).normalize();
    // keep it pointing outward
    const p = base(th, y);
    if (out.x * p.nx + out.z * p.nz < 0 && Math.abs(out.y) < 0.9) out.negate();
    return out;
  }
  // Panel coordinates -> surface angle. side: 'front' | 'back'; x: inches
  // across the panel (positive = viewer's right looking at that panel).
  function theta(side, x, y) {
    const f = F(y), q = tableAt(y).theta(Math.abs(x) / f);
    if (side === 'front') return Math.sign(x) * q;
    return x >= 0 ? -(Math.PI - q) : Math.PI - q;
  }
  return { spec, L, F, ring, point, normal, theta, base };
}

// ---------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------
// Grid of rows (same column count each row) -> BufferGeometry. Triangle
// winding is made to agree with the given normals so the outside is the
// front face (needed for the plain inside).
function gridGeometry(rows, cols, pos, nrm, uv) {
  const g = new THREE.BufferGeometry();
  const idx = [];
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    for (const [i, j, k] of [[a, b, e], [a, e, d]]) {
      const A = P(i), B = P(j), C = P(k);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const dot = fx * (nrm[i * 3] + nrm[j * 3] + nrm[k * 3]) + fy * (nrm[i * 3 + 1] + nrm[j * 3 + 1] + nrm[k * 3 + 1]) + fz * (nrm[i * 3 + 2] + nrm[j * 3 + 2] + nrm[k * 3 + 2]);
      if (fx * fx + fy * fy + fz * fz < 1e-14) continue;
      idx.push(...(dot >= 0 ? [i, j, k] : [i, k, j]));
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function rowHeights(y0, L, dropF, dropB) {
  const ys = new Set();
  const top = L - 4.5;
  for (let i = 0; i <= 64; i++) ys.add(+(y0 + (top - y0) * i / 64).toFixed(4));
  for (let i = 1; i <= 48; i++) ys.add(+(top + (L - top) * Math.pow(i / 48, 0.8)).toFixed(4));
  ys.add(+(L - dropF).toFixed(4)); ys.add(+(L - dropB).toFixed(4));
  return [...ys].sort((a, b) => a - b);
}

// Neckline cut: half-width (panel inches) of the opening at height y.
function neckCut(spec, torso, side, y) {
  const drop = side === 'front' ? spec.neck.front : spec.neck.back;
  const w = spec.neck.w ?? torso.F(spec.L);
  if (y <= spec.L - drop) return 0;
  return w * Math.sqrt(clamp(1 - ((spec.L - y) / drop) ** 2, 0, 1));
}
function sideEdge(spec, torso, y) {
  const f = torso.F(y);
  if (!spec.strap || y <= spec.armpit) return f;
  const t = clamp((y - spec.armpit) / (spec.L - spec.armpit), 0, 1);
  const fa = torso.F(spec.armpit);
  return Math.min(f, spec.strap + (fa - spec.strap) * Math.pow(1 - t, 2.1));
}

/** Panel UV frame (inches). */
export function panelFrame(spec) {
  const fmax = Math.max(...spec.F.map(k => k[1]));
  return { W: Math.ceil(fmax * 2 + 2), H: Math.ceil(spec.L + 1) };
}

function buildPanel(torso, spec, side) {
  const { W, H } = panelFrame(spec);
  const y0 = spec.hemRib ? spec.hemRib - 0.4 : 0;
  const ys = rowHeights(y0, spec.L, spec.neck.front, spec.neck.back);
  const COLS = 34, parts = [];
  for (const half of [1, -1]) {
    const pos = [], nrm = [], uv = [];
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    let rows = 0;
    for (const y of ys) {
      const x0 = neckCut(spec, torso, side, y), x1 = Math.max(x0, sideEdge(spec, torso, y));
      for (let c = 0; c < COLS; c++) {
        const s = c / (COLS - 1), x = half * lerp(x0, x1, s);
        const th = torso.theta(side, x, y);
        torso.point(th, y, 0, v); torso.normal(th, y, nn);
        pos.push(v.x, v.y, v.z); nrm.push(nn.x, nn.y, nn.z);
        uv.push((x + W / 2) / W, 1 - (spec.L - y) / H);
      }
      rows++;
    }
    parts.push(gridGeometry(rows, COLS, pos, nrm, uv));
  }
  return mergeGeoms(parts);
}

function mergeGeoms(list) {
  const out = new THREE.BufferGeometry();
  const attrs = ['position', 'normal', 'uv'];
  const data = Object.fromEntries(attrs.map(a => [a, []]));
  const idx = []; let off = 0;
  for (const g of list) {
    for (const a of attrs) if (g.attributes[a]) data[a].push(...g.attributes[a].array);
    for (const i of g.index.array) idx.push(i + off);
    off += g.attributes.position.count;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3));
  if (data.uv.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
  out.setIndex(idx);
  return out;
}

// Full ring tube between two heights (waistband rib).
function buildWaistband(torso, spec) {
  const H = spec.hemRib, COLS = 129, ROWS = 14, pos = [], nrm = [], uv = [];
  const k = 0.62, q = arcTable(k, spec.n, 64), e = 2 / spec.n;
  const fTop = torso.F(H) * 0.985;
  for (let r = 0; r < ROWS; r++) {
    const y = (r / (ROWS - 1)) * (H + 0.1);
    const f = fTop * (0.93 + 0.07 * smooth(0, H, y)), a = f / q.len, b = a * k;
    for (let c = 0; c < COLS; c++) {
      const th = -Math.PI + (c / (COLS - 1)) * Math.PI * 2;
      const s = Math.sin(th), co = Math.cos(th);
      const rip = 0.035 * Math.sin(th * 46) + 0.03 * noise3(s * 3, y / 2, co * 3);
      const x = a * spow(s, e), z = b * spow(co, e);
      const l = Math.hypot(x / (a * a), z / (b * b)) || 1;
      const nx = x / (a * a) / l, nz = z / (b * b) / l;
      pos.push(x + nx * rip, y, z + nz * rip); nrm.push(nx, 0, nz);
      uv.push((c / (COLS - 1)) * f * 4, y);         // inches (rib tile = 1 in)
    }
  }
  return gridGeometry(ROWS, COLS, pos, nrm, uv);
}

// Neck rib band (tees, crews): a strip following the neckline on both panels.
function buildNeckBand(torso, spec) {
  const bw = spec.neck.band, w = spec.neck.w ?? torso.F(spec.L);
  const loop = [];
  for (const side of ['front', 'back']) {
    const drop = side === 'front' ? spec.neck.front : spec.neck.back;
    for (let i = 0; i <= 48; i++) {
      const ph = Math.PI - (i / 48) * Math.PI;              // -w .. +w along the U
      if (side === 'back' && (i === 0)) continue;
      const ex = w * Math.cos(ph), ey = spec.L - drop * Math.sin(ph);
      let nx = Math.cos(ph) / w * 0.6, ny = -Math.sin(ph) / drop - 0.45;
      const l = Math.hypot(nx, ny); nx /= l; ny /= l;
      loop.push({ side, ex, ey, ix: ex + nx * bw, iy: ey + ny * bw });
    }
  }
  const ROWS = 4, cols = loop.length, pos = [], nrm = [], uv = [];
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  let along = 0;
  loop.forEach((p, ci) => {
    if (ci) along += Math.hypot(p.ex - loop[ci - 1].ex, p.ey - loop[ci - 1].ey) || 0.05;
  });
  let acc = 0;
  for (let r = 0; r < ROWS; r++) {
    acc = 0;
    for (let c = 0; c < cols; c++) {
      const p = loop[c];
      if (c) acc += Math.hypot(p.ex - loop[c - 1].ex, p.ey - loop[c - 1].ey) || 0.05;
      const t = r / (ROWS - 1);
      const y = lerp(p.ey, p.iy, t);
      const x = clamp(lerp(p.ex, p.ix, t), -torso.F(y) * 0.999, torso.F(y) * 0.999);
      const th = torso.theta(p.side, x, y);
      const lift = [0.13, 0.11, 0.07, 0.03][r];
      torso.normal(th, y, nn);
      torso.point(th, y, 0, v).addScaledVector(nn, lift);
      if (r === 0) v.y += 0.05;
      pos.push(v.x, v.y, v.z); nrm.push(nn.x, nn.y, nn.z);
      uv.push(acc * 1.0, t * bw);
    }
  }
  return gridGeometry(ROWS, cols, pos, nrm, uv);
}

// Tube with a variable (elliptical) cross-section along a polyline of centres.
export function tubeAlong(centres0, radius, { closed = false, seg = 16, flat = 1, normals: normals0 = null } = {}) {
  const centres = closed ? [...centres0, centres0[0]] : centres0;
  const normals = normals0 && closed ? [...normals0, normals0[0]] : normals0;
  const pos = [], nrm = [], uv = [], n = centres.length, m = centres0.length;
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = closed ? centres0[(i - 1 + m) % m] : centres[Math.max(0, i - 1)], b = closed ? centres0[(i + 1) % m] : centres[Math.min(n - 1, i + 1)];
    T.subVectors(b, a).normalize();
    const ref = normals?.[i] || up;
    N.copy(ref).addScaledVector(T, -ref.dot(T)).normalize();
    if (N.lengthSq() < 1e-6) N.set(1, 0, 0);
    B.crossVectors(T, N);
    if (i) acc += centres[i].distanceTo(centres[i - 1]);
    const r = typeof radius === 'function' ? radius(i / (n - 1), closed ? i % m : i) : radius;
    for (let s = 0; s <= seg; s++) {
      const a2 = (s / seg) * Math.PI * 2, cx = Math.cos(a2), sx = Math.sin(a2);
      const nx = N.x * cx + B.x * sx, ny = N.y * cx + B.y * sx, nz = N.z * cx + B.z * sx;
      const rx = N.x * cx * r + B.x * sx * r * flat, ry = N.y * cx * r + B.y * sx * r * flat, rz = N.z * cx * r + B.z * sx * r * flat;
      pos.push(centres[i].x + rx, centres[i].y + ry, centres[i].z + rz);
      nrm.push(nx, ny, nz);
      uv.push(s / seg, acc);
    }
  }
  return gridGeometry(n, seg + 1, pos, nrm, uv);
}

// ---------------------------------------------------------------------
// Sleeves
// ---------------------------------------------------------------------
export function sleeveRoot(torso, spec, sx) {
  const ys = spec.L - spec.drop, r = torso.ring(ys), r0 = spec.sleeve.r[0][1];
  return new THREE.Vector3(sx * (r.a - 0.55), ys - r0 + 0.35, r.zc - 0.15);
}

/** Default (relaxed, ghost-mannequin) arm path for a sleeve. */
export function defaultArm(torso, spec, sx) {
  const s = spec.sleeve, S0 = sleeveRoot(torso, spec, sx);
  const ang = s.angle * Math.PI / 180;
  const dir = new THREE.Vector3(sx * Math.sin(ang), -Math.cos(ang), 0);
  if (s.len < 12) return { shoulder: S0, elbow: S0.clone().addScaledVector(dir, s.len * 0.55), wrist: S0.clone().addScaledVector(dir, s.len + 2) };
  const elbow = S0.clone().addScaledVector(dir, 11.5).add(new THREE.Vector3(0, 0, 0.6));
  const a2 = ang * 0.55;
  const dir2 = new THREE.Vector3(sx * Math.sin(a2), -Math.cos(a2), 0.28).normalize();
  return { shoulder: S0, elbow, wrist: elbow.clone().addScaledVector(dir2, 13) };
}

/**
 * Sleeve tube from an arm path {shoulder, elbow, wrist} (garment space).
 * Returns { main, cuff } geometries. UVs in inches (see top of file);
 * frame = { W, H } texture frame of the sleeve print canvas.
 */
export function buildSleeve(spec, arm, sx, frame, { fit = false } = {}) {
  const s = spec.sleeve, R = profile(s.r), len = s.len;
  // centre line: buried start (inside the torso) -> shoulder -> elbow -> wrist
  const pts = [arm.shoulder.clone().add(new THREE.Vector3(-sx * 2.6, 0.15, 0)), arm.shoulder.clone(), arm.elbow.clone(), arm.wrist.clone()];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  const SAMPLES = 220, sp = curve.getSpacedPoints(SAMPLES);
  const cum = [0];
  for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + sp[i].distanceTo(sp[i - 1]));
  // distance of the shoulder point along the line
  let i0 = 0, best = Infinity;
  sp.forEach((p, i) => { const d = p.distanceTo(arm.shoulder); if (d < best) { best = d; i0 = i; } });
  const d0 = cum[i0], total = cum[cum.length - 1] - d0;
  // posed arms: squeeze/stretch the sleeve so the cuff lands at the wrist
  const k = fit ? clamp(total / len, 0.45, 1.2) : 1;
  const atD = (d) => {
    const target = clamp((d > 0 ? d * k : d) + d0, 0, cum[cum.length - 1]);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m; else hi = m; }
    const t = (target - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    const p = sp[lo].clone().lerp(sp[hi], t), T = sp[hi].clone().sub(sp[lo]).normalize();
    return { p, T };
  };
  // parallel-transported frame, starting with N = outward
  const end = fit ? len : Math.min(len, total);
  const rowsD = [];
  const dStart = -2.6, ROWS = Math.round(56 + len * 1.6);
  for (let i = 0; i < ROWS; i++) rowsD.push(dStart + (end - dStart) * (i / (ROWS - 1)));
  const frames = [];
  let N = null;
  for (const d of rowsD) {
    const { p, T } = atD(d);
    if (!N) {
      const ref = Math.abs(T.x) > 0.92 * Math.abs(sx) ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(sx, 0, 0);
      N = ref.addScaledVector(T, -ref.dot(T)).normalize();
    } else {
      const prevT = frames[frames.length - 1].T;
      const q = new THREE.Quaternion().setFromUnitVectors(prevT, T);
      N = N.clone().applyQuaternion(q);
      N.addScaledVector(T, -N.dot(T)).normalize();
    }
    frames.push({ d, p, T, N, B: new THREE.Vector3().crossVectors(T, N) });
  }
  // print line: outward and 35deg toward the front
  const pl = new THREE.Vector3(sx * Math.cos(0.61), 0, Math.sin(0.61));
  const COLS = 41;
  const rMax = Math.max(...s.r.map(k => k[1])) * 1.06;
  const mk = (from, to, { cuff = false } = {}) => {
    const pos = [], nrm = [], uv = [];
    const sel = frames.filter(f => f.d >= from - 1e-6 && f.d <= to + 1e-6);
    for (const f of sel) {
      // angle of the print line in this frame
      const plp = pl.clone().addScaledVector(f.T, -pl.dot(f.T)).normalize();
      const phi0 = Math.atan2(plp.dot(f.B), plp.dot(f.N));
      // viewer-right direction looking at the print line with "up" = toward shoulder
      const right = new THREE.Vector3().crossVectors(f.T.clone().negate(), plp);
      const dphi = new THREE.Vector3().addScaledVector(f.N, -Math.sin(phi0)).addScaledVector(f.B, Math.cos(phi0));
      const sign = Math.sign(dphi.dot(right)) || 1;
      let r = R(clamp(f.d, 0, len));
      if (f.d < 0) r = R(0) * (1 - 0.12 * (-f.d / 2.6));
      const rN = r * 1.05, rB = r * 0.9;
      for (let c = 0; c < COLS; c++) {
        const off = -Math.PI + (c / (COLS - 1)) * Math.PI * 2;  // seam on the inner side
        const phi = phi0 + off;
        const cx = Math.cos(phi), sy = Math.sin(phi);
        const dir = new THREE.Vector3().addScaledVector(f.N, cx * rN).addScaledVector(f.B, sy * rB);
        const nd = new THREE.Vector3().addScaledVector(f.N, cx / rN).addScaledVector(f.B, sy / rB).normalize();
        let w = 0.05 * noise3(f.p.x / 2.4 + dir.x / 2, f.p.y / 2.4 + dir.y / 2, f.p.z / 2.4 + dir.z / 2);
        if (s.cuff && !cuff) {                                      // fabric stacking above the cuff
          const cz = len - s.cuff;
          w += 0.15 * Math.sin(f.d * 3.1 + off * 0.9) * smooth(cz - 3.2, cz - 0.6, f.d) * (1 - smooth(cz - 0.2, cz + 0.2, f.d));
        }
        if (len > 12 && !cuff) {                                    // elbow folds on the inside of the arm
          const m = smooth(8.5, 11, f.d) * (1 - smooth(12.5, 15, f.d)) * smooth(0.2, 1, -Math.cos(off));
          w += 0.12 * Math.sin(f.d * 2.4 + off * 1.5) * m;
        }
        if (cuff) w = 0.04 * Math.sin(off * 22) + 0.02 * noise3(dir.x, f.d, dir.z);
        const p = f.p.clone().add(dir).addScaledVector(nd, w);
        pos.push(p.x, p.y, p.z); nrm.push(nd.x, nd.y, nd.z);
        const u = sign * off * (rN + rB) / 2;
        if (cuff) uv.push((off + Math.PI) * r * 2.2, f.d);
        else uv.push((u + frame.W / 2) / frame.W, 1 - clamp(f.d, -1, frame.H) / frame.H);
      }
    }
    const g = gridGeometry(sel.length, COLS, pos, nrm, uv);
    g.computeVertexNormals();
    fixSeamNormals(g, sel.length, COLS);
    return g;
  };
  const cuffStart = s.cuff ? len - s.cuff : null;
  const main = mk(dStart, cuffStart != null ? Math.min(end, cuffStart + 0.25) : end);
  let cuff = null;
  if (s.cuff && end > cuffStart) {
    // cuff: separate tube slightly inset, rib knit
    cuff = mk(cuffStart, end, { cuff: true });
  }
  return { main, cuff, rMax };
}

function fixSeamNormals(g, rows, cols) {
  const n = g.attributes.normal;
  for (let r = 0; r < rows; r++) {
    const a = r * cols, b = a + cols - 1;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b), l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
}

export function sleeveFrame(spec) {
  if (!spec.sleeve) return null;
  const rMax = Math.max(...spec.sleeve.r.map(k => k[1])) * 1.06;
  return { W: Math.ceil(Math.PI * 2 * rMax), H: Math.ceil(spec.sleeve.len + 1) };
}

// ---------------------------------------------------------------------
// Hoodie extras
// ---------------------------------------------------------------------
function neckLoop(torso, spec, n = 40) {
  const w = spec.neck.w ?? torso.F(spec.L), pts = [];
  for (const side of ['front', 'back']) {
    const drop = side === 'front' ? spec.neck.front : spec.neck.back;
    for (let i = 0; i < n; i++) {
      const ph = Math.PI - (i / n) * Math.PI;
      const x = w * Math.cos(ph) * 0.999, y = spec.L - drop * Math.sin(ph);
      const th = torso.theta(side, x, Math.min(y, spec.L - 0.02));
      pts.push({ p: torso.point(th, y), n: torso.normal(th, y), side });
    }
  }
  return pts;
}

function buildHood(torso, spec) {
  const loop = neckLoop(torso, spec, 36);
  const zs = loop.map(l => l.p.z), zf = Math.max(...zs), zb = Math.min(...zs);
  const centres = [], normals = [], back = [], radii = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const l of loop) {
    const b = clamp((zf - l.p.z) / (zf - zb), 0, 1), r = lerp(0.6, 1.0, b);
    back.push(b); radii.push(r);
    // the hood's opening edge: hugs the neck at the front, falls back and
    // down onto the hood behind the neck
    centres.push(l.p.clone().addScaledVector(l.n, r * 0.85 + 0.9 * b * b).addScaledVector(up, r * 0.3 - 1.7 * b * b * b));
    normals.push(l.n.clone());
  }
  const roll = tubeAlong(centres, (t, i) => radii[i], { closed: true, seg: 22, flat: 0.8, normals });
  // fabric between the neckline and the rolled edge
  const pos = [], nrm = [], ROWS = 4, n = loop.length;
  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1);
    for (let i = 0; i <= n; i++) {
      const k = i % n, l = loop[k], c = centres[k], b = back[k];
      const inner = c.clone().addScaledVector(l.n, -radii[k] * 0.55).addScaledVector(up, radii[k] * 0.2);
      const p = l.p.clone().lerp(inner, t).addScaledVector(l.n, Math.sin(Math.PI * t) * (0.25 + 0.5 * b)).addScaledVector(up, Math.sin(Math.PI * t) * 0.6 * b);
      pos.push(p.x, p.y, p.z); nrm.push(l.n.x, l.n.y, l.n.z);
    }
  }
  const skirt = gridGeometry(ROWS, n + 1, pos, nrm, null);
  skirt.computeVertexNormals();
  const bag = buildHoodCrown(torso, spec);
  // drawstrings
  const strings = [];
  const front = loop.filter(l => l.side === 'front');
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, y = spec.L - spec.neck.front - 0.55 - t * 7.2;
      const x = sx * (1.15 + 0.5 * t + 0.25 * Math.sin(t * 3));
      const th = torso.theta('front', x, y);
      pts.push(torso.point(th, y, 0.3 + (1 - t) * 0.25));
    }
    const g = tubeAlong(pts, 0.12, { seg: 10 });
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const tip = new THREE.CylinderGeometry(0.15, 0.15, 1.1, 14);
    const dir = last.clone().sub(prev).normalize();
    tip.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    tip.translate(...last.clone().addScaledVector(dir, 0.5).toArray());
    g.userData = { role: 'cord', points: pts.map(p => p.clone()) };
    tip.userData = { role: 'tip' };
    strings.push({ cord: g, tip });
    void front;
  }
  for (const g of [roll, skirt, bag]) g.userData.role = 'hoodDown';
  const hoodUp = buildHoodUp(torso, spec, loop);
  return { roll, skirt, bag, strings, up: hoodUp };
}

// Hood pulled up, shaped around an (invisible) head. Its bottom row is the
// neckline itself, so it stays sewn on. Attribute hoodW (0 at the neck, 1 at
// the crown) lets the try-on fit it to the wearer's head.
export const HOOD_HEAD = { y: 4.7, z: -0.9, width: 6 };
function buildHoodUp(torso, spec, loop0) {
  const C = new THREE.Vector3(0, spec.L + HOOD_HEAD.y, HOOD_HEAD.z), rx = 4.55, ry = 6.5, rz = 5.3;
  // start at the centre front so the face opening is the seam of the grid
  const k0 = loop0.findIndex(l => l.side === 'front' && l.p.x >= 0);
  const loop = [...loop0.slice(k0), ...loop0.slice(0, k0)];
  const ROWS = 30, n = loop.length, pos = [], nrm = [], w = [];
  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1);
    const amax = lerp(Math.PI, 0.6 * Math.PI, smooth(0.2, 0.5, t));     // crossover covers the throat
    const e = lerp(-0.62, Math.PI / 2 - 0.05, t);
    for (let i = 0; i <= n; i++) {
      const l = loop[i % n];
      // the extra last column closes the crossover at the throat and lies on
      // the same edge as its neighbour higher up (no skin across the face)
      const ang = i === n ? -Math.abs(Math.atan2(l.p.x, -(l.p.z - C.z))) : Math.atan2(l.p.x, -(l.p.z - C.z));
      const a = clamp(ang, -amax, amax);
      const open = Math.abs(ang) > amax ? 1 : 0;                         // columns gathered on the face opening
      const sx = Math.sin(a), cz = Math.cos(a), ce = Math.cos(e);
      const S = new THREE.Vector3(C.x + rx * ce * sx * (1 + 0.04 * open), C.y + ry * Math.sin(e), C.z - rz * ce * cz + 0.25 * open);
      const fold = 0.12 * noise3(S.x / 2.5, S.y / 2.5, S.z / 2.5) + 0.1 * Math.sin(t * 9 + a * 2) * t;
      const out = S.clone().sub(C).normalize();
      S.addScaledVector(out, fold);
      const p = l.p.clone().lerp(S, smooth(0, 0.3, t));
      pos.push(p.x, p.y, p.z); nrm.push(out.x, out.y, out.z); w.push(t);
    }
  }
  const g = gridGeometry(ROWS, n + 1, pos, nrm, null);
  g.computeVertexNormals();
  g.setAttribute('hoodW', new THREE.Float32BufferAttribute(w, 1));
  g.userData = { role: 'hoodUp', head: C.clone(), pivot: new THREE.Vector3(0, spec.L - spec.neck.back, loop.reduce((m, l) => Math.min(m, l.p.z), 0)) };
  return g;
}

// Hood lying down on the upper back: a rounded panel that hugs the back
// (built in back-panel coordinates), thick in the middle and thin at the
// edges, with a centre seam and a few folds.
function buildHoodCrown(torso, spec) {
  const top = spec.L - spec.neck.back - 0.6, tip = spec.L - 7.4;
  const ROWS = 34, COLS = 46, pos = [], nrm = [];
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1), y = lerp(top, tip, t);
    const hw = 5.6 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.4)), 0.55) + 0.05;
    for (let c = 0; c < COLS; c++) {
      const s = c / (COLS - 1) * 2 - 1, x = s * hw;
      const th = torso.theta('back', clamp(x, -torso.F(y) * 0.98, torso.F(y) * 0.98), y);
      const body = Math.sqrt(Math.max(0, 1 - s * s));
      let d = 1.25 * Math.pow(body, 0.7) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.08)));
      d += 0.12 * noise3(x / 2, y / 2, 5) * body;
      d -= 0.22 * Math.exp(-((x / 0.35) ** 2)) * body;                 // centre seam
      d += 0.1 * Math.sin(x * 1.3 + t * 4) * body * t;                 // soft folds toward the tip
      torso.normal(th, y, nn);
      torso.point(th, y, 0.05 + d, v);
      pos.push(v.x, v.y, v.z); nrm.push(nn.x, nn.y, nn.z);
    }
  }
  const g = gridGeometry(ROWS, COLS, pos, nrm, null);
  g.computeVertexNormals();
  g.userData.hood = true;
  return g;
}

function buildPocket(torso, spec) {
  const yb = spec.hemRib + 0.35, yt = spec.hemRib + 6.9;
  const ROWS = 28, COLS = 40, pos = [], nrm = [], uv = [];
  const { W, H } = panelFrame(spec);
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let r = 0; r < ROWS; r++) {
    const t = r / (ROWS - 1), y = lerp(yb, yt, t);
    // straight bottom, slanted hand openings, straight top
    const hw = t > 0.32 ? lerp(6.7, 4.9, (t - 0.32) / 0.68) : 6.7;
    for (let c = 0; c < COLS; c++) {
      const s = c / (COLS - 1), x = lerp(-hw, hw, s);
      const th = torso.theta('front', x, y);
      const puff = 0.12 + 0.2 * Math.pow(Math.sin(Math.PI * s), 0.6) * Math.pow(Math.sin(Math.PI * t), 0.6);
      torso.normal(th, y, nn);
      torso.point(th, y, puff, v);
      pos.push(v.x, v.y, v.z); nrm.push(nn.x, nn.y, nn.z);
      uv.push((x + W / 2) / W, 1 - (spec.L - y) / H);
    }
  }
  const g = gridGeometry(ROWS, COLS, pos, nrm, uv);
  g.computeVertexNormals();
  return { geometry: g, yb, yt };
}

// Rolled hem edge on an open tube end.
function hemRoll(torso, spec) {
  const pts = [], normals = [];
  for (let i = 0; i < 120; i++) {
    const th = -Math.PI + (i / 120) * Math.PI * 2;
    const n = torso.normal(th, 0.05);
    pts.push(torso.point(th, 0.06, 0.02)); normals.push(n);
  }
  return tubeAlong(pts, 0.085, { closed: true, seg: 8, normals });
}

function armholeBinding(torso, spec) {
  const out = [];
  for (const sx of [1, -1]) {
    const pts = [];
    const N = 30;
    for (let i = 0; i <= N; i++) {                      // front: armpit -> strap top
      const y = lerp(spec.armpit, spec.L - 0.02, i / N), x = sx * sideEdge(spec, torso, y);
      pts.push(torso.point(torso.theta('front', x, y), y, 0.05));
    }
    for (let i = N; i >= 0; i--) {                      // back: strap top -> armpit
      const y = lerp(spec.armpit, spec.L - 0.02, i / N), x = -sx * sideEdge(spec, torso, y);
      pts.push(torso.point(torso.theta('back', x, y), y, 0.05));
    }
    out.push(tubeAlong(pts, 0.14, { closed: true, seg: 8 }));
  }
  return out;
}

// Tank: join the front and back straps over the shoulder.
function strapBridges(torso, spec) {
  const out = [];
  const w = spec.neck.w, s = spec.strap, y = spec.L - 0.001;
  for (const sx of [1, -1]) {
    const pos = [], nrm = [];
    const COLS = 10, ROWS = 5;
    for (let r = 0; r < ROWS; r++) {
      const t = r / (ROWS - 1);
      for (let c = 0; c < COLS; c++) {
        const x = lerp(w, s, c / (COLS - 1));
        const f = torso.point(torso.theta('front', sx * x, y), y);
        const b = torso.point(torso.theta('back', -sx * x, y), y);
        const p = f.clone().lerp(b, t);
        p.y += Math.sin(Math.PI * t) * 0.35;
        pos.push(p.x, p.y, p.z); nrm.push(0, 1, 0);
      }
    }
    const g = gridGeometry(ROWS, COLS, pos, nrm, null);
    g.computeVertexNormals();
    out.push(g);
  }
  return out;
}

function neckLabel(torso, spec) {
  const y = spec.L - spec.neck.back - 1.05;
  const th = torso.theta('back', 0, y), p = torso.point(th, y), n = torso.normal(th, y);
  const g = new THREE.PlaneGeometry(1.7, 0.95);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), n.clone().negate(), new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI));
  g.applyMatrix4(m);
  g.translate(p.x - n.x * 0.1, p.y, p.z - n.z * 0.1);
  return g;
}

// ---------------------------------------------------------------------
// Public: build all static geometry for a garment type (cached by caller)
// ---------------------------------------------------------------------
export function buildGarmentGeometry(type) {
  const spec = SPECS[type] || SPECS.default;
  const torso = createTorso(spec);
  const out = {
    type: SPECS[type] ? type : 'tee', spec, torso,
    panelFrame: panelFrame(spec), sleeveFrame: sleeveFrame(spec),
    front: buildPanel(torso, spec, 'front'),
    back: buildPanel(torso, spec, 'back'),
    label: neckLabel(torso, spec),
    plain: [], rib: [], trim: [],
  };
  if (spec.hemRib) out.rib.push(buildWaistband(torso, spec));
  else out.plain.push(hemRoll(torso, spec));
  if (spec.neck.band) out.rib.push(buildNeckBand(torso, spec));
  if (spec.strap) { out.plain.push(...armholeBinding(torso, spec), ...strapBridges(torso, spec)); out.plain.push(tubeAlong(neckLoop(torso, spec, 40).map(l => l.p.clone().addScaledVector(l.n, 0.05)), 0.13, { closed: true, seg: 8 })); }
  if (spec.hood) {
    const h = buildHood(torso, spec);
    out.plain.push(h.roll, h.skirt, h.bag, ...h.strings.map(s => s.cord));
    out.trim.push(...h.strings.map(s => s.tip));
    out.hoodUp = h.up;
  }
  if (spec.pocket) out.pocket = buildPocket(torso, spec);
  if (spec.sleeve) {
    out.arms = { l: defaultArm(torso, spec, 1), r: defaultArm(torso, spec, -1) };
    out.sleeves = { l: buildSleeve(spec, out.arms.l, 1, out.sleeveFrame), r: buildSleeve(spec, out.arms.r, -1, out.sleeveFrame) };
  }
  out.height = spec.L + (spec.hood ? 2.5 : 0.5);
  return out;
}
