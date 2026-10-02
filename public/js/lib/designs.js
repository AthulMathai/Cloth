// Custom designer: catalogue, geometry, uploads, rendering, saving.
// Prices always come from the database engine (price_custom); the print
// summary below mirrors design_print_summary() so the live quote matches
// what checkout will charge for the saved design.
import { db, auth, storage } from './supabase.js';
import { garmentPaths, isDark } from '../components/garment.js';

export const UNITS_PER_INCH = 10;             // garment drawings: 10 units = 1 inch
export const VIEWBOX = { x: -10, y: -12, w: 320, h: 352 };

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
      method: config.methods?.[p.code] || 'dtg',
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

function drawLayer(ctx, l, img, ppi) {
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
    const c = document.createElement('canvas');
    c.width = Math.round(p.max_w_in * dpi); c.height = Math.round(p.max_h_in * dpi);
    const ctx = c.getContext('2d');
    for (const l of layers) drawLayer(ctx, l, imgs[l.id], dpi);
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
  for (const p of placements.filter(p => p.view === view)) {
    const g = areaGeometry(product.product_type, p);
    ctx.save();
    ctx.translate(g.cx, g.cy); ctx.rotate(g.rot * Math.PI / 180); ctx.translate(-g.w / 2, -g.h / 2);
    for (const l of config.layers.filter(l => l.placement === p.code)) drawLayer(ctx, l, imgs[l.id], UNITS_PER_INCH);
    ctx.restore();
  }
  return new Promise(r => c.toBlob(r, 'image/png'));
}
