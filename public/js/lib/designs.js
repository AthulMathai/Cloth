// Custom designer: catalogue, geometry, uploads, rendering, saving.
// Prices always come from the database engine (price_custom); the print
// summary below mirrors design_print_summary() so the live quote matches
// what checkout will charge for the saved design.
import { db, auth, storage } from './supabase.js';
import { garmentPaths, isDark } from '../components/garment.js';
import { wrapShape } from '../three/specs.js';

export const UNITS_PER_INCH = 10;             // garment drawings: 10 units = 1 inch
export const VIEWBOX = { x: -10, y: -12, w: 320, h: 352 };
// The all-over view: the garment unrolled like a cut-and-sew pattern.
// Body wrap on top (centre front in the middle, centre back at both edges),
// the two full sleeves below. 10 units = 1 inch.
export const WRAP_VIEWBOX = { x: -236, y: -16, w: 472, h: 632 };
const WRAP_GEOMETRY = { all_over: { cx: 0, cy: 160 }, left_sleeve_full: { cx: 116, cy: 470 }, right_sleeve_full: { cx: -116, cy: 470 } };

/** Which canvas/view a placement is edited on: 'front' | 'back' | 'allover'. */
export const viewOf = (p) => p?.canvas === 'wrap' ? 'allover' : p?.view;
export const viewBoxFor = (view) => view === 'allover' ? WRAP_VIEWBOX : VIEWBOX;
/** Print methods offered for a placement (restricted ones only where listed). */
export const methodsFor = (cat, p) => cat.methods.filter(m => p?.methods?.length ? p.methods.includes(m.code) : !m.restricted);

// Print area centres/sizes in garment units (width/height come from the
// placement's max inches). Sleeves sit on the sleeve, slightly angled.
// Front view is the garment facing you: the wearer's LEFT sleeve is on
// your right.
const AREA_GEOMETRY = {
  default: {
    front:        { cx: 150, cy: 150, rot: 0 },
    left_chest:   { cx: 186, cy: 96,  rot: 0 },
    back:         { cx: 150, cy: 158, rot: 0 },
    left_sleeve:  { cx: 266, cy: 176, rot: -7 },
    right_sleeve: { cx: 34,  cy: 176, rot: 7 },
  },
  hoodie: { front: { cx: 150, cy: 158, rot: 0 }, left_chest: { cx: 186, cy: 104, rot: 0 }, back: { cx: 150, cy: 168, rot: 0 } },
  tank: { front: { cx: 150, cy: 168, rot: 0 }, left_chest: { cx: 180, cy: 118, rot: 0 }, back: { cx: 150, cy: 168, rot: 0 } },
};

export function areaGeometry(productType, placement) {
  if (placement.canvas === 'wrap') {
    const w = WRAP_GEOMETRY[placement.code] || { cx: 0, cy: 160 };
    return { ...w, rot: 0, w: placement.max_w_in * UNITS_PER_INCH, h: placement.max_h_in * UNITS_PER_INCH };
  }
  const g = { ...AREA_GEOMETRY.default, ...(AREA_GEOMETRY[productType] || {}) }[placement.code];
  return { ...g, w: placement.max_w_in * UNITS_PER_INCH, h: placement.max_h_in * UNITS_PER_INCH };
}

let catalogue = null;
export function loadCatalogue() {
  catalogue ||= Promise.all([
    db.from('storefront_products').select('id,slug,name,product_type,base_price_cents,status,colors,description,materials,tags')
      .eq('is_customizable', true).in('status', ['active', 'out_of_stock']).order('base_price_cents'),
    db.from('product_variants').select('id,product_id,size,color,color_hex,inventory_on_hand,inventory_reserved,sort_order').eq('is_active', true).order('sort_order'),
    db.from('print_placements').select('*').eq('is_active', true).order('sort_order'),
    db.from('print_methods').select('*').eq('is_active', true).order('sort_order'),
    db.from('artwork_services').select('*').eq('is_active', true).order('sort_order'),
  ]).then(([products, variants, placements, methods, services]) => {
    for (const p of products) p.variants = variants.filter(v => v.product_id === p.id);
    // The designer prints on blanks (products tagged "blank"); fall back to
    // every customizable product if no blanks are set up.
    const usable = products.filter(p => p.variants.length);
    const blanks = usable.filter(p => p.tags?.includes('blank'));
    return { products: blanks.length ? blanks : usable, placements, methods, services };
  }).catch(e => { catalogue = null; throw e; });
  return catalogue;
}

export const placementsFor = (cat, productType) =>
  cat.placements.filter(p => !p.product_types?.length || p.product_types.includes(productType));

// ---------------------------------------------------------------------
// Print summary (mirror of SQL design_print_summary)
// ---------------------------------------------------------------------
export function printSummary(config, placements) {
  const by = new Map();
  for (const l of config.layers) {
    const r = (l.rotation || 0) * Math.PI / 180;
    const bw = Math.abs(l.w_in * Math.cos(r)) + Math.abs(l.h_in * Math.sin(r));
    const bh = Math.abs(l.w_in * Math.sin(r)) + Math.abs(l.h_in * Math.cos(r));
    const b = by.get(l.placement) || { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, l.x_in - bw / 2); b.x1 = Math.max(b.x1, l.x_in + bw / 2);
    b.y0 = Math.min(b.y0, l.y_in - bh / 2); b.y1 = Math.max(b.y1, l.y_in + bh / 2);
    by.set(l.placement, b);
  }
  return placements.filter(p => by.has(p.code)).map(p => {
    const b = by.get(p.code);
    const round2 = (n) => Math.round(n * 100) / 100;
    return {
      placement: p.code,
      method: config.methods?.[p.code] || p.methods?.[0] || 'dtg',
      width_in: round2(Math.min(b.x1, p.max_w_in) - Math.max(0, b.x0)),
      height_in: round2(Math.min(b.y1, p.max_h_in) - Math.max(0, b.y0)),
    };
  });
}

// ---------------------------------------------------------------------
// Artwork intake: validate, normalise ("processed" copy), measure.
// ---------------------------------------------------------------------
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
export const MAX_BYTES = 25 * 1024 * 1024;

export async function readArtwork(file) {
  if (!OK_TYPES.includes(file.type)) throw new Error('Use a PNG, JPG, WebP or SVG image.');
  if (file.size > MAX_BYTES) throw new Error('Images must be under 25 MB.');
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  let width = img.naturalWidth, height = img.naturalHeight;
  if (file.type === 'image/svg+xml' && (!width || !height)) { width = 1000; height = 1000; }
  if (file.type !== 'image/svg+xml' && Math.min(width, height) < 200) {
    URL.revokeObjectURL(url);
    throw new Error('That image is too small to print (under 200 px). Use a larger file.');
  }
  // Processed copy: re-encoded PNG (drops hidden metadata), capped at 4000 px.
  const scale = Math.min(1, 4000 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const processed = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const processedUrl = URL.createObjectURL(processed);
  URL.revokeObjectURL(url);
  return { file, processed, url: processedUrl, width, height, name: file.name };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file couldn\'t be opened as an image.'));
    img.src = src;
  });
}

async function sha256(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

// Uploads original + processed copies once; returns the processed asset id.
export async function uploadArtwork(art) {
  if (art.assetId) return art.assetId;
  const uid = auth.user.id, key = crypto.randomUUID();
  const origPath = `${uid}/uploads/${key}.${EXT[art.file.type]}`;
  const procPath = `${uid}/uploads/${key}-processed.png`;
  await storage.upload('designs', origPath, art.file, art.file.type);
  await storage.upload('designs', procPath, art.processed, 'image/png');
  await db.rpc('design_register_asset', { p_bucket: 'designs', p_path: origPath, p_kind: 'original', p_mime: art.file.type,
    p_bytes: art.file.size, p_width: art.width, p_height: art.height, p_sha256: await sha256(art.file), p_name: art.name });
  art.assetId = await db.rpc('design_register_asset', { p_bucket: 'designs', p_path: procPath, p_kind: 'processed', p_mime: 'image/png',
    p_bytes: art.processed.size, p_width: art.width, p_height: art.height, p_sha256: await sha256(art.processed), p_name: art.name });
  // the moderation check reads the ORIGINAL bytes
  art.originalAssetPath = origPath;
  return art.assetId;
}

// ---------------------------------------------------------------------
// Rendering (mockups + production files) to canvas
// ---------------------------------------------------------------------
export const FONTS = {
  anton: "'Anton', Impact, sans-serif", marker: "'Permanent Marker', cursive", monsieur: "'Monsieur La Doulaise', cursive",
  inter: "'Inter', system-ui, sans-serif", dela: "'Dela Gothic One', sans-serif", orbitron: "'Orbitron', sans-serif",
  cormorant: "'Cormorant Garamond', serif",
};
export const TEXT_FONT_SIZE = 0.82;           // font size as a share of the text box height

export function measureText(text, font) {
  const c = measureText.c ||= document.createElement('canvas').getContext('2d');
  c.font = `${font === 'inter' || font === 'orbitron' ? '800 ' : ''}100px ${FONTS[font] || FONTS.inter}`;
  const w = c.measureText(text || ' ').width;
  return Math.max(0.3, w / (100 / TEXT_FONT_SIZE));      // width : height ratio of the box
}

export function drawLayer(ctx, l, img, ppi) {
  ctx.save();
  ctx.translate(l.x_in * ppi, l.y_in * ppi);
  ctx.rotate((l.rotation || 0) * Math.PI / 180);
  const w = l.w_in * ppi, h = l.h_in * ppi;
  if (l.type === 'image' && img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
  if (l.type === 'text') {
    ctx.fillStyle = l.color || '#ffffff';
    ctx.font = `${l.font === 'inter' || l.font === 'orbitron' ? '800 ' : ''}${h * TEXT_FONT_SIZE}px ${FONTS[l.font] || FONTS.inter}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(l.text, 0, 0, w);
  }
  ctx.restore();
}

async function imagesFor(config, art) {
  const out = {};
  for (const l of config.layers) if (l.type === 'image' && art[l.asset_id || l.local]) {
    const a = art[l.asset_id || l.local];
    out[l.id] = a.img ||= await loadImage(a.url);
  }
  return out;
}

/** Print-ready PNG per placement at `dpi` (transparent, exact size). */
export async function renderProduction(config, placements, art, dpi = 150) {
  const imgs = await imagesFor(config, art), files = {};
  await document.fonts?.ready;
  for (const p of placements) {
    const layers = config.layers.filter(l => l.placement === p.code);
    if (!layers.length) continue;
    // Big all-over panels are capped to ~9 megapixels in the browser; the saved
    // design (inches + original uploads) lets production re-render at full DPI.
    const d = Math.min(dpi, Math.floor(Math.sqrt(9e6 / (p.max_w_in * p.max_h_in))));
    const c = document.createElement('canvas');
    c.width = Math.round(p.max_w_in * d); c.height = Math.round(p.max_h_in * d);
    const ctx = c.getContext('2d');
    for (const l of layers) drawLayer(ctx, l, imgs[l.id], d);
    files[p.code] = await new Promise(r => c.toBlob(r, 'image/png'));
  }
  return files;
}

/** Mockup PNG of one view: garment in its colour + artwork. */
export async function renderMockup(config, product, color, view, placements, art, size = 900) {
  const imgs = await imagesFor(config, art);
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  const s = size / VIEWBOX.w;
  c.width = size; c.height = Math.round(VIEWBOX.h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#efe9dd'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(s, s); ctx.translate(-VIEWBOX.x, -VIEWBOX.y);
  const { body, details } = garmentPaths(product.product_type, view);
  const dark = isDark(color);
  ctx.fillStyle = color; ctx.strokeStyle = dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)'; ctx.lineWidth = 1.5;
  const bp = new Path2D(body); ctx.fill(bp); ctx.stroke(bp);
  ctx.lineWidth = 1.4; for (const d of details) ctx.stroke(new Path2D(d));
  for (const p of placements.filter(p => p.view === view && p.canvas !== 'wrap')) {
    const g = areaGeometry(product.product_type, p);
    ctx.save();
    ctx.translate(g.cx, g.cy); ctx.rotate(g.rot * Math.PI / 180); ctx.translate(-g.w / 2, -g.h / 2);
    for (const l of config.layers.filter(l => l.placement === p.code)) drawLayer(ctx, l, imgs[l.id], UNITS_PER_INCH);
    ctx.restore();
  }
  return new Promise(r => c.toBlob(r, 'image/png'));
}

// ---------------------------------------------------------------------
// All-over pattern drawing (flat editor). Shows where the art lands on the
// garment: centre front, side seams, centre back, neck, hem rib, sleeves.
// ---------------------------------------------------------------------
export function wrapPatternSVG({ type = 'tee', color = '#141414', placements = [], overlay = false }) {
  const sh = wrapShape(type), spec = sh.spec, U = UNITS_PER_INCH, dark = isDark(color);
  // overlay sits on top of the artwork: guides in a neutral ink with a halo so they read on any art
  const ink = overlay ? 'rgba(255,255,255,.95)' : (dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.45)');
  const faint = overlay ? 'rgba(255,255,255,.7)' : (dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.18)');
  const r = (n) => Math.round(n * 10) / 10;
  const has = (code) => placements.some(p => p.code === code);
  const fills = [], lines = [], labels = [], shapes = [], cuts = [];
  const lab = (x, y, t, anchor = 'middle') => labels.push(`<text x="${r(x)}" y="${r(y)}" text-anchor="${anchor}" class="wrap-label">${t}</text>`);
  if (has('all_over')) {
    const L = spec.L, rows = [];
    for (let y = 0; y <= L + 1e-6; y += 0.5) rows.push(y);
    const body = [...rows.map(y => `${r(2 * sh.halfWidth(y) * U)},${r(y * U)}`), ...rows.slice().reverse().map(y => `${r(-2 * sh.halfWidth(y) * U)},${r(y * U)}`)].join(' ');
    shapes.push(`M${body.replace(/ /g, ' L')} Z`);
    fills.push(`<polygon points="${body}" fill="${color}" stroke="${ink}" stroke-width="1.4"/>`);
    const side = (sx) => rows.map(y => `${r(sx * sh.halfWidth(y) * U)},${r(y * U)}`).join(' ');
    const nw = (spec.neck.w ?? sh.halfWidth(0)) * U, nf = spec.neck.front * U, nb = spec.neck.back * U, w0 = 2 * sh.halfWidth(0) * U;
    cuts.push(`M${-nw},0 A${nw},${nf} 0 0 0 ${nw},0 Z`, `M${w0},0 A${nw},${nb} 0 0 0 ${w0 - nw},0 Z`, `M${-w0},0 A${nw},${nb} 0 0 1 ${-w0 + nw},0 Z`);
    lines.push(`<polyline points="${side(1)}" stroke-dasharray="6 5"/>`, `<polyline points="${side(-1)}" stroke-dasharray="6 5"/>`,
      `<line x1="0" y1="${r(nf)}" x2="0" y2="${r(L * U)}" stroke-dasharray="2 6" class="faint"/>`);
    if (spec.hemRib) {
      const y0 = (L - spec.hemRib) * U, hw = 2 * sh.halfWidth(L) * U;
      cuts.push(`M${-hw},${r(y0)} H${hw} V${r(L * U)} H${-hw} Z`);
      lab(0, (L - spec.hemRib / 2) * U + 4, 'RIB WAISTBAND — NOT PRINTED');
    }
    lab(0, (spec.neck.front + 2) * U, 'CENTRE FRONT'); lab(sh.halfWidth(6) * U, 6 * U - 6, 'SIDE'); lab(-sh.halfWidth(6) * U, 6 * U - 6, 'SIDE');
    lab(2 * sh.halfWidth(10) * U - 6, 10 * U, 'CENTRE BACK', 'end'); lab(-2 * sh.halfWidth(10) * U + 6, 10 * U, 'CENTRE BACK', 'start');
    lab(sh.halfWidth(14) * U * 1.5, 14 * U, 'BACK'); lab(-sh.halfWidth(14) * U * 1.5, 14 * U, 'BACK');
  }
  if (sh.sleeve) {
    for (const [code, name] of [['left_sleeve_full', 'LEFT SLEEVE'], ['right_sleeve_full', 'RIGHT SLEEVE']]) {
      if (!has(code)) continue;
      const cx = WRAP_GEOMETRY[code].cx, top = WRAP_GEOMETRY[code].cy - 130, len = sh.sleeve.len, rows = [];
      for (let d = 0; d <= len + 1e-6; d += 0.5) rows.push(d);
      const circ = (d) => Math.PI * 2 * sh.sleeve.r(d) * 0.975 / 2 * U;
      const pts = [...rows.map(d => `${r(cx + circ(d))},${r(top + d * U)}`), ...rows.slice().reverse().map(d => `${r(cx - circ(d))},${r(top + d * U)}`)].join(' ');
      shapes.push(`M${pts.replace(/ /g, ' L')} Z`);
      fills.push(`<polygon points="${pts}" fill="${color}" stroke="${ink}" stroke-width="1.4"/>`);
      lines.push(`<line x1="${cx}" y1="${top}" x2="${cx}" y2="${r(top + len * U)}" stroke-dasharray="2 6" class="faint"/>`);
      lab(cx, top + 16, `${name} · OUTER ARM`); lab(cx, r(top + len * U) + 14, 'UNDERARM SEAM AT BOTH EDGES');
      if (spec.sleeve.cuff) {
        const y0 = top + (len - spec.sleeve.cuff) * U, hw = circ(len);
        cuts.push(`M${r(cx - hw)},${r(y0)} H${r(cx + hw)} V${r(top + len * U)} H${r(cx - hw)} Z`);
      }
    }
  }
  const vb = WRAP_VIEWBOX;
  const g = (inner) => `<g fill="none" stroke="${ink}" stroke-width="1.2">${inner}</g>`;
  if (overlay) {
    // dim everything that won't be printed: outside the garment, neck openings, rib bands
    const outside = `M${vb.x},${vb.y} h${vb.w} v${vb.h} h${-vb.w} Z ${shapes.join(' ')}`;
    return `<svg class="wrap-overlay" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" aria-hidden="true">
      <path d="${outside}" fill-rule="evenodd" fill="var(--surface, #f3efe6)" opacity=".72"/>
      <path d="${cuts.join(' ')}" fill="var(--surface, #f3efe6)" opacity=".8"/>
      <g style="filter: drop-shadow(0 0 1.5px rgba(0,0,0,.9))">${g(lines.join('').replace(/class="faint"/g, `stroke="${faint}"`))}
        <g fill="#fff">${labels.join('')}</g></g></svg>`;
  }
  return `<svg class="garment garment--wrap" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="All-over print pattern">
    ${fills.join('')}<path d="${cuts.join(' ')}" fill="var(--surface, #f3efe6)" opacity=".6"/>
    ${g(lines.join('').replace(/class="faint"/g, `stroke="${faint}"`))}<g fill="${ink}">${labels.join('')}</g></svg>`;
}

// ---------------------------------------------------------------------
// Background removal (in the browser, free): clears a plain background
// that touches the image edges — typical for AI art and product photos on
// white. Returns a PNG blob, or null if the background isn't one colour.
// ---------------------------------------------------------------------
export async function removeBackground(source, { tolerance = 40 } = {}) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const img = await loadImage(url);
  if (typeof source !== 'string') URL.revokeObjectURL(url);
  const scale = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H), px = data.data;

  // Background colour = median of the border pixels; give up if the border varies a lot.
  const border = [];
  for (let x = 0; x < W; x += 2) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 2) border.push(y * W, y * W + W - 1);
  const opaque = border.filter(i => px[i * 4 + 3] > 200);
  if (opaque.length < border.length * 0.5) return null;                 // already transparent
  const med = (k) => opaque.map(i => px[i * 4 + k]).sort((a, b) => a - b)[opaque.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const dist = (i) => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
  if (opaque.filter(i => dist(i) < tolerance).length < opaque.length * 0.7) return null;

  // Flood fill from the edges through pixels close to the background colour.
  const seen = new Uint8Array(W * H), queue = new Int32Array(W * H);
  let head = 0, tail = 0, cleared = 0;
  for (const i of border) if (!seen[i] && dist(i) < tolerance) { seen[i] = 1; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++], x = i % W;
    px[i * 4 + 3] = 0; cleared++;
    const n = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (const j of n) {
      if (j < 0 || j >= W * H || seen[j]) continue;
      seen[j] = 1;
      const d = dist(j);
      if (d < tolerance) queue[tail++] = j;
      else if (d < tolerance * 1.8) px[j * 4 + 3] = Math.min(px[j * 4 + 3], Math.round(255 * (d - tolerance) / (tolerance * 0.8)));   // soft edge
    }
  }
  if (cleared < W * H * 0.02) return null;
  ctx.putImageData(data, 0, 0);
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}
