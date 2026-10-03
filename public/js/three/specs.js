// Garment measurements, shared by the 3D models and the flat all-over
// pattern view. No three.js here, so the flat editor stays light.
// ---------------------------------------------------------------------
// Garment specs (inches). F = a quarter of the body circumference, i.e.
// half the width of the garment laid flat, at height y above the hem.
// ---------------------------------------------------------------------
const TEE_BODY = {
  L: 29.5, drop: 1.7, armpit: 21, n: 2.5,
  F: [[0, 9.45], [5, 9.25], [13, 9.12], [21, 9.25], [27.8, 8.75], [29.5, 5.0]],
  k: [[0, 0.62], [21, 0.63], [27.8, 0.5], [29.5, 0.86]],
  zc: [[0, 0], [22, 0], [27.8, -0.3], [29.5, -0.85]],
  neck: { front: 2.6, back: 0.85, band: 0.75 },
};

export const SPECS = {
  tee: { ...TEE_BODY, fabric: 'jersey', hemStitch: 0.9,
    sleeve: { len: 8.2, angle: 52, bend: 0, r: [[0, 3.35], [4, 3.2], [8.2, 3.05]], cuff: 0, hemStitch: 0.75 } },
  longsleeve: { ...TEE_BODY, fabric: 'jersey', hemStitch: 0.9,
    sleeve: { len: 24, angle: 19, bend: 10, r: [[0, 3.15], [4, 2.95], [12, 2.5], [19, 2.2], [21.6, 2.25], [22.1, 1.62], [24, 1.58]], cuff: 2.1 } },
  crewneck: { L: 28.5, drop: 1.8, armpit: 19.5, n: 2.4, fabric: 'fleece', hemRib: 2.6,
    F: [[0, 8.55], [2.6, 8.7], [3.5, 9.9], [8, 10.05], [19.5, 10.05], [26.7, 9.35], [28.5, 5.25]],
    k: [[0, 0.62], [19.5, 0.64], [26.7, 0.5], [28.5, 0.86]],
    zc: [[0, 0], [21, 0], [26.7, -0.3], [28.5, -0.85]],
    neck: { front: 2.7, back: 0.95, band: 1.0 },
    sleeve: { len: 24.5, angle: 20, bend: 10, r: [[0, 3.45], [4, 3.25], [12, 2.8], [19, 2.55], [21.6, 2.6], [22.1, 1.78], [24.5, 1.72]], cuff: 2.6 } },
  hoodie: { L: 28, drop: 1.8, armpit: 19, n: 2.4, fabric: 'fleece', hemRib: 2.8, hood: true, pocket: true,
    F: [[0, 8.8], [2.8, 8.95], [3.7, 10.35], [9, 10.5], [19, 10.45], [26.2, 9.8], [28, 5.45]],
    k: [[0, 0.62], [19, 0.65], [26.2, 0.5], [28, 0.86]],
    zc: [[0, 0], [21, 0], [26.2, -0.3], [28, -0.9]],
    neck: { front: 3.0, back: 1.0, band: 0 },
    sleeve: { len: 25, angle: 21, bend: 10, r: [[0, 3.6], [4, 3.4], [12, 2.95], [19, 2.7], [22.1, 2.78], [22.6, 1.85], [25, 1.78]], cuff: 2.6 } },
  tank: { L: 29, drop: 1.4, armpit: 19.5, n: 2.5, fabric: 'jersey', hemStitch: 0.9,
    F: [[0, 9.4], [6, 9.15], [14, 9.05], [19.5, 9.0], [25, 8.0], [29, 6.6]],
    k: [[0, 0.62], [19.5, 0.62], [25, 0.5], [29, 0.16]],
    zc: [[0, 0], [22, 0], [29, -0.5]],
    neck: { front: 5.2, back: 1.9, band: 0, w: 4.05 },
    strap: 6.05, sleeve: null },
};
SPECS.default = SPECS.tee;

// Monotone cubic interpolation through [x, y] keys (no overshoot).
export function profile(keys) {
  const xs = keys.map(k => k[0]), ys = keys.map(k => k[1]), n = xs.length;
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Wrap (all-over) helpers. Inches; y is measured down from the high point of the shoulder. */
export function wrapShape(type) {
  const spec = SPECS[type] || SPECS.default;
  const F = profile(spec.F);
  return {
    spec,
    L: spec.L,
    halfWidth: (yDown) => F(Math.max(0, Math.min(spec.L, spec.L - yDown))),      // panel half-width at a height
    sleeve: spec.sleeve ? { len: spec.sleeve.len, r: profile(spec.sleeve.r) } : null,
  };
}
