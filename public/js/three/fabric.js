// Procedural fabric textures (generated once in the browser, no image
// downloads) and the fabric material used for every garment part.
import * as THREE from 'three';

const cache = new Map();

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Tileable value noise on a size x size lattice.
function tileNoise(size, cells, seed) {
  const r = rng(seed), lat = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(size * size);
  const f = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = x / size * cells, gy = y / size * cells;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = f(gx - x0), ty = f(gy - y0);
    const g = (i, j) => lat[((j % cells) * cells) + (i % cells)];
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
    out[y * size + x] = a + (b - a) * ty;
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function normalTexture(H, size, strength, repeat = true) {
  const c = canvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const h = (i, j) => H[((j + size) % size) * size + ((i + size) % size)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
    const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), k = (y * size + x) * 4;
    img.data[k] = (-dx / l * 0.5 + 0.5) * 255;
    img.data[k + 1] = (dy / l * 0.5 + 0.5) * 255;
    img.data[k + 2] = (1 / l * 0.5 + 0.5) * 255;
    img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Normal maps. One tile = 1 inch of fabric.
 *  jersey  – fine knit wales + fibre noise (tees, tanks, longsleeves)
 *  fleece  – soft brushed surface (hoodies, crewnecks)
 *  rib     – 1x1 rib knit (cuffs, waistbands, collars)
 */
export function fabricNormal(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const S = 256, H = new Float32Array(S * S);
  const n1 = tileNoise(S, 16, 7), n2 = tileNoise(S, 64, 13), n3 = tileNoise(S, 5, 21);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    if (kind === 'rib') {
      const ribs = 8;                                  // ribs per inch
      const p = (x / S) * ribs % 1;
      H[i] = Math.pow(Math.sin(p * Math.PI), 0.7) * 1.0 + n2[i] * 0.12;
    } else if (kind === 'fleece') {
      const wale = Math.sin((x / S) * 18 * Math.PI * 2) * 0.08;
      H[i] = n2[i] * 0.55 + n1[i] * 0.35 + wale + n3[i] * 0.2;
    } else {
      const wales = 20, courses = 26;                  // per inch
      const wx = (x / S) * wales, cy = (y / S) * courses;
      const col = Math.floor(wx), lean = (col % 2 ? 1 : -1);
      const loop = Math.sin(((wx % 1) + (cy % 1) * 0.5 * lean) * Math.PI);
      H[i] = Math.abs(loop) * 0.55 + n2[i] * 0.3 + n1[i] * 0.15;
    }
  }
  const strength = kind === 'rib' ? 6 : kind === 'fleece' ? 3 : 4.5;
  const tex = normalTexture(H, S, strength);
  cache.set(kind, tex);
  return tex;
}

/** Diagonal satin-stitch pattern used to make embroidery read as thread. */
export function stitchPattern(ctx) {
  if (cache.has('stitch-pattern')) return cache.get('stitch-pattern');
  const c = canvas(24), g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
  for (let i = -24; i < 48; i += 6) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 24, 24); g.stroke(); }
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1;
  for (let i = -21; i < 51; i += 6) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 24, 24); g.stroke(); }
  const p = ctx.createPattern(c, 'repeat');
  cache.set('stitch-pattern', p);
  return p;
}

/**
 * Fabric material. The outside shows `map` (fabric colour + prints); the
 * inside of the garment (seen through the neck, hem and sleeves) is plain,
 * slightly darker fabric and never shows the print.
 */
export function fabricMaterial({ map = null, roughnessMap = null, normalKind = 'jersey', repeat = [1, 1], normalScale = 0.55 } = {}) {
  const normalMap = fabricNormal(normalKind).clone();
  normalMap.needsUpdate = true;
  normalMap.repeat.set(repeat[0], repeat[1]);
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map, roughnessMap, roughness: 1, metalness: 0,
    normalMap, normalScale: new THREE.Vector2(normalScale, normalScale),
    sheen: 1, sheenRoughness: 0.72, sheenColor: new THREE.Color(0x777777),
    side: THREE.DoubleSide,
  });
  const inside = { value: new THREE.Color(0x222222) };
  m.userData.inside = inside;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uInside = inside;
    sh.fragmentShader = 'uniform vec3 uInside;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n  if (!gl_FrontFacing) diffuseColor.rgb = uInside;');
  };
  m.customProgramCacheKey = () => 'fabric-inside';
  return m;
}

/** Sets the fabric colour on a material (used where no colour map is baked). */
export function tintFabric(m, hex, { useColor = false } = {}) {
  const c = new THREE.Color(hex);
  if (useColor) m.color.copy(c);
  // Cotton sheen: a soft, lighter haze at grazing angles.
  m.sheenColor.copy(c).lerp(new THREE.Color(0xffffff), luminance(hex) < 0.2 ? 0.28 : 0.12);
  m.userData.inside.value.copy(c).multiplyScalar(0.62);
}

export function luminance(hex) {
  const n = parseInt((hex || '#777777').slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
}
