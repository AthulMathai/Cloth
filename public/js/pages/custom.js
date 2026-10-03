// /custom and /custom/:id — the Custom Designer.
import { db, auth, storage } from '../lib/supabase.js';
import { themeForPage, money } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';
import { isDark } from '../components/garment.js';
import { track } from '../lib/analytics.js';
import { addDesignToBag } from '../lib/cart.js';
import { webglAvailable } from '../three/studio.js';
import {
  loadCatalogue, placementsFor, areaGeometry, printSummary, readArtwork, uploadArtwork, renderMockup, renderProduction,
  measureText, FONTS, TEXT_FONT_SIZE, UNITS_PER_INCH, VIEWBOX,
} from '../lib/designs.js';

const STATUS = {
  draft: ['Draft', 'Save and submit when you\'re happy with it.'],
  pending: ['Checking…', 'Running automated checks on your design.'],
  approved: ['Approved', 'Ready to order.'],
  needs_review: ['In review', 'A person will review this design before it can be printed. We\'ll update this page.'],
  rejected: ['Not approved', 'This design can\'t be printed as is. Edit it and submit again.'],
};
const TEXT_COLORS = ['#ffffff', '#141414', '#d42a2f', '#efebe3', '#ff4f8b', '#00f0ff', '#c8ff00', '#a5803f'];

export async function load({ id }) {
  const theme = await themeForPage('custom');
  const cat = await loadCatalogue();
  let saved = null;
  if (id) {
    if (!auth.user) return { theme, title: 'Custom designer', html: `<section class="state"><h1>Sign in to open this design</h1>
      <p><a class="btn" href="/account/sign-in">Sign in</a></p></section>` };
    saved = await db.rpc('design_get', { p_design_id: id }).catch(() => null);
    if (!saved) return (await import('./not-found.js')).load();
  }
  return {
    theme, title: saved ? saved.name : 'Custom designer',
    description: 'Upload your artwork, place it on a hoodie or tee, see the price live, and order.',
    html: `<section class="designer" data-designer>
      <header class="dz-head wrap">
        <div><h1 class="h-section">Wear your idea.</h1>
        <p class="muted">Pick a garment, add your artwork, and see the exact price as you go.</p></div>
        <label class="dz-name"><span class="sr-only">Design name</span><input data-name maxlength="80" value="${esc(saved?.name || 'Untitled design')}"></label>
      </header>
      <div class="dz-grid">
        <aside class="dz-panel" data-panel aria-label="Design options"></aside>
        <div class="dz-stage-col">
          <div class="dz-toolbar" role="toolbar" aria-label="Canvas">
            <div class="seg dz-mode" role="group" aria-label="Preview">
              <button data-mode="3d" aria-pressed="false">3D</button><button data-mode="2d" aria-pressed="false">Flat</button><button data-mode="tryon" aria-pressed="false" class="dz-tryon-btn">Try on</button>
            </div>
            <div class="seg" role="group" aria-label="View">
              <button data-view="front" aria-pressed="true">Front</button><button data-view="back" aria-pressed="false">Back</button>
            </div>
            <div class="seg">
              <button data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
              <button data-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">↷</button>
            </div>
            <div class="seg">
              <button data-act="zoom-out" aria-label="Zoom out">−</button>
              <button data-act="zoom-in" aria-label="Zoom in">+</button>
            </div>
            <button class="linklike" data-act="reset">Reset</button>
          </div>
          <div class="dz-stage" data-stage tabindex="0" aria-label="Design canvas. Arrow keys move the selected layer.">
            <div class="dz-canvas" data-canvas></div>
            <div class="dz-3d" data-3d hidden><p class="dz-3d-status" data-3d-status>Loading 3D…</p></div>
            <div class="dz-drop" aria-hidden="true">Drop your image here</div>
          </div>
          <p class="dz-hint muted small" data-hint>Drag to move. Pull the corner to resize, the top dot to rotate.</p>
        </div>
        <aside class="dz-side">
          <div class="receipt dz-receipt" data-receipt aria-live="polite"></div>
          <div class="dz-actions" data-actions></div>
        </aside>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-file hidden>
    </section>`,
    mount: (root) => mountDesigner(root, cat, saved),
  };
}

function mountDesigner(root, cat, saved) {
  const $ = (s) => root.querySelector(s);
  const firstProduct = cat.products.find(p => p.slug === 'essential-hoodie') || cat.products[0];
  const S = {
    product: saved ? cat.products.find(p => p.id === saved.product_id) || firstProduct : firstProduct,
    color: null, size: null, view: 'front', active: 'front', selected: null,
    config: saved ? structuredClone(saved.config) : { layers: [], methods: {}, services: [] },
    qty: 1, designId: saved?.id || null, designKey: saved?.id || crypto.randomUUID(), version: saved?.version || 0,
    status: saved?.status || null, approvedVersion: saved?.approved_version || null, moderation: saved?.moderation || null,
    decision: saved?.decision_note || null,
    dirty: false, art: {}, history: [], future: [], zoom: 1, quote: null, tiers: null, busy: false, msg: '',
    mode: webglAvailable() ? (sessionStorage.getItem('dz-mode') || '3d') : '2d',
  };
  if (S.mode === 'tryon') S.mode = '3d';
  S.config.methods ||= {}; S.config.services ||= [];
  if (saved) {
    const v = S.product.variants.find(v => v.id === saved.variant_id);
    S.color = v?.color; S.size = v?.size;
  }
  S.color ||= S.product.variants[0].color;
  S.size ||= (S.product.variants.find(v => v.color === S.color && v.size === 'M') || S.product.variants[0]).size;
  let unloaded = false, priceTimer = 0, scale = 1;
  let kit = null, studio = null, tryon = null, three = null, syncRaf = 0;

  const placements = () => placementsFor(cat, S.product.product_type);
  const pl = (code) => cat.placements.find(p => p.code === code);
  const variant = () => S.product.variants.find(v => v.color === S.color && v.size === S.size);
  const colorHex = () => S.product.variants.find(v => v.color === S.color)?.color_hex || '#141414';
  const layer = (id) => S.config.layers.find(l => l.id === id);
  const isApproved = () => S.status === 'approved' && S.approvedVersion === S.version && !S.dirty;

  // ---------- history ----------
  const snapshot = () => JSON.stringify({ config: S.config, product: S.product.id, color: S.color, size: S.size });
  let lastSnap = snapshot();
  function commit() {
    const now = snapshot();
    if (now === lastSnap) return;
    S.history.push(lastSnap); if (S.history.length > 80) S.history.shift();
    S.future = []; lastSnap = now; S.dirty = true;
    schedulePrice(); renderPanel(); renderActions();
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    S.config = o.config; S.product = cat.products.find(p => p.id === o.product) || S.product; S.color = o.color; S.size = o.size;
    lastSnap = snap; S.dirty = true;
    if (S.selected && !layer(S.selected)) S.selected = null;
    renderAll(); schedulePrice();
  }
  const undo = () => { if (S.history.length) { S.future.push(lastSnap); restore(S.history.pop()); } };
  const redo = () => { if (S.future.length) { S.history.push(lastSnap); restore(S.future.pop()); } };

  // ---------- stage ----------
  function stageScale() {
    const box = $('[data-stage]');
    const byWidth = Math.min(box.clientWidth - 24, 640) / VIEWBOX.w;
    const byHeight = (innerWidth > 820 ? innerHeight - 230 : innerHeight * 0.62) / VIEWBOX.h;   // whole garment visible
    return Math.max(200 / VIEWBOX.w, Math.min(byWidth, byHeight));
  }
  function renderStage() {
    scale = stageScale();
    const c = $('[data-canvas]');
    c.style.width = `${VIEWBOX.w * scale}px`; c.style.height = `${VIEWBOX.h * scale}px`;
    c.style.transform = `scale(${S.zoom})`;
    const areas = placements().filter(p => p.view === S.view);
    c.innerHTML = garmentSVG({ type: S.product.product_type, color: colorHex(), mode: 'flat', view: S.view, label: `${S.product.name} ${S.view}` }) +
      areas.map(p => {
        const g = areaGeometry(S.product.product_type, p);
        const used = S.config.layers.some(l => l.placement === p.code);
        return `<div class="dz-area${S.active === p.code ? ' is-active' : ''}${used ? ' is-used' : ''}" data-area="${p.code}"
          style="left:${(g.cx - g.w / 2 - VIEWBOX.x) * scale}px;top:${(g.cy - g.h / 2 - VIEWBOX.y) * scale}px;width:${g.w * scale}px;height:${g.h * scale}px;transform:rotate(${g.rot}deg)"
          role="button" tabindex="-1" aria-label="${esc(p.label)} print area, ${p.max_w_in} by ${p.max_h_in} inches">
          <span class="dz-area-label">${esc(p.label)} · ${+p.max_w_in}×${+p.max_h_in} in</span>
          ${S.config.layers.filter(l => l.placement === p.code).map(layerHTML).join('')}
        </div>`;
      }).join('');
    c.classList.toggle('is-dark', isDark(colorHex()));
    root.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === S.view));
    renderMode();
    sync3d();
  }
  function layerStyle(l) {
    const u = UNITS_PER_INCH * scale;
    return `left:${(l.x_in - l.w_in / 2) * u}px;top:${(l.y_in - l.h_in / 2) * u}px;width:${l.w_in * u}px;height:${l.h_in * u}px;transform:rotate(${l.rotation || 0}deg)`;
  }
  function layerHTML(l) {
    const a = S.art[l.asset_id || l.local];
    const inner = l.type === 'image'
      ? (a ? `<img src="${a.url}" alt="" draggable="false">` : '<span class="dz-missing">Image unavailable</span>')
      : `<span class="dz-text" style="font-family:${FONTS[l.font] || FONTS.inter};color:${esc(l.color)};font-size:${l.h_in * UNITS_PER_INCH * scale * TEXT_FONT_SIZE}px;${l.font === 'inter' || l.font === 'orbitron' ? 'font-weight:800;' : ''}">${esc(l.text)}</span>`;
    const sel = S.selected === l.id;
    return `<div class="dz-layer${sel ? ' is-selected' : ''}" data-layer="${l.id}" style="${layerStyle(l)}" tabindex="0"
      aria-label="${l.type === 'image' ? 'Image' : 'Text: ' + esc(l.text)} on ${esc(pl(l.placement)?.label || '')}">${inner}
      ${sel ? `<span class="dz-h dz-h-rot" data-handle="rotate" aria-label="Rotate"></span><span class="dz-h dz-h-size" data-handle="resize" aria-label="Resize"></span>` : ''}</div>`;
  }
  function updateLayerEl(l) {
    const el = root.querySelector(`[data-layer="${l.id}"]`);
    if (!el) return;
    el.setAttribute('style', layerStyle(l));
    const t = el.querySelector('.dz-text');
    if (t) t.style.fontSize = `${l.h_in * UNITS_PER_INCH * scale * TEXT_FONT_SIZE}px`;
    sync3dSoon();
  }

  // pointer interactions (mouse, pen and touch)
  let drag = null;
  root.querySelector('[data-stage]').addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-3d]')) return;
    const handle = e.target.closest('[data-handle]');
    const lel = e.target.closest('[data-layer]');
    const ael = e.target.closest('[data-area]');
    if (!lel) {
      if (ael) { S.active = ael.dataset.area; S.selected = null; renderStage(); renderPanel(); }
      else if (S.selected) { S.selected = null; renderStage(); renderPanel(); }
      return;
    }
    const l = layer(lel.dataset.layer);
    if (S.selected !== l.id || S.active !== l.placement) {
      S.selected = l.id; S.active = l.placement; renderStage(); renderPanel();
    }
    const el = root.querySelector(`[data-layer="${l.id}"]`);
    const r = el.getBoundingClientRect();
    const g = areaGeometry(S.product.product_type, pl(l.placement));
    drag = { mode: handle?.dataset.handle || 'move', id: l.id, x0: e.clientX, y0: e.clientY, l0: { ...l },
             cx: r.left + r.width / 2, cy: r.top + r.height / 2, rot: g.rot, max: pl(l.placement) };
    drag.d0 = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) || 1;
    root.querySelector('[data-stage]').setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  root.querySelector('[data-stage]').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const l = layer(drag.id), m = drag.max;
    if (drag.mode === 'move') {
      const k = 1 / (UNITS_PER_INCH * scale * S.zoom);
      const a = -drag.rot * Math.PI / 180;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      l.x_in = clamp(drag.l0.x_in + (dx * Math.cos(a) - dy * Math.sin(a)) * k, 0, +m.max_w_in);
      l.y_in = clamp(drag.l0.y_in + (dx * Math.sin(a) + dy * Math.cos(a)) * k, 0, +m.max_h_in);
    } else if (drag.mode === 'resize') {
      const f = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) / drag.d0;
      const maxF = Math.min(m.max_w_in / drag.l0.w_in, m.max_h_in / drag.l0.h_in) * 1.0001;
      const minF = 0.4 / Math.min(drag.l0.w_in, drag.l0.h_in);
      const k = clamp(f, minF, maxF);
      l.w_in = round2(drag.l0.w_in * k); l.h_in = round2(drag.l0.h_in * k);
    } else if (drag.mode === 'rotate') {
      let deg = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI + 90 - drag.rot;
      deg = ((deg % 360) + 360) % 360;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else for (const snap of [0, 90, 180, 270, 360]) if (Math.abs(deg - snap) < 4) deg = snap;
      l.rotation = Math.round(deg % 360);
    }
    updateLayerEl(l);
  });
  const endDrag = () => { if (drag) { drag = null; commit(); renderPanel(); } };
  root.querySelector('[data-stage]').addEventListener('pointerup', endDrag);
  root.querySelector('[data-stage]').addEventListener('pointercancel', endDrag);

  // keyboard
  root.querySelector('[data-stage]').addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    const l = layer(S.selected); if (!l) return;
    const step = e.shiftKey ? 1 : 0.1, m = pl(l.placement);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      l.x_in = clamp(l.x_in + moves[e.key][0], 0, +m.max_w_in); l.y_in = clamp(l.y_in + moves[e.key][1], 0, +m.max_h_in);
      updateLayerEl(l); clearTimeout(kbTimer); kbTimer = setTimeout(commit, 300);
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLayer(l.id); }
  });
  let kbTimer = 0;

  // drag & drop files
  const stage = root.querySelector('[data-stage]');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('is-dropping'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('is-dropping'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault(); stage.classList.remove('is-dropping');
    const f = e.dataTransfer.files?.[0]; if (f) addImage(f);
  });

  // ---------- layer operations ----------
  function ensureActiveInView() {
    const ok = placements().find(p => p.code === S.active);
    if (!ok) S.active = placements()[0].code;
    S.view = pl(S.active).view;
  }
  async function addImage(file) {
    ensureActiveInView();
    let art;
    try { art = await readArtwork(file); } catch (e) { flash(e.message); return; }
    const key = 'local:' + crypto.randomUUID();
    S.art[key] = art;
    const m = pl(S.active), ratio = art.width / art.height;
    let w = m.max_w_in * 0.8, h = w / ratio;
    if (h > m.max_h_in * 0.8) { h = m.max_h_in * 0.8; w = h * ratio; }
    const l = { id: 'l' + Math.random().toString(36).slice(2, 9), type: 'image', placement: S.active, local: key,
                x_in: round2(m.max_w_in / 2), y_in: round2(Math.min(m.max_h_in / 2, h / 2 + m.max_h_in * 0.08)),
                w_in: round2(w), h_in: round2(h), rotation: 0 };
    S.config.layers.push(l); S.selected = l.id;
    renderStage(); commit();
    track('design_uploaded', { mime: file.type, bytes: file.size });
  }
  function addText() {
    ensureActiveInView();
    const m = pl(S.active);
    const color = isDark(colorHex()) ? '#ffffff' : '#141414';
    const text = 'YOUR TEXT', font = 'anton';
    let h = Math.min(1.6, m.max_h_in * 0.3), w = measureText(text, font) * h;
    if (w > m.max_w_in * 0.9) { w = m.max_w_in * 0.9; h = w / measureText(text, font); }
    const l = { id: 'l' + Math.random().toString(36).slice(2, 9), type: 'text', placement: S.active, text, font, color,
                x_in: round2(m.max_w_in / 2), y_in: round2(Math.min(m.max_h_in / 2, 2.5)), w_in: round2(w), h_in: round2(h), rotation: 0 };
    S.config.layers.push(l); S.selected = l.id;
    renderStage(); commit();
  }
  function removeLayer(id) {
    S.config.layers = S.config.layers.filter(l => l.id !== id);
    if (S.selected === id) S.selected = null;
    renderStage(); commit();
  }
  function moveLayer(id, dir) {
    const i = S.config.layers.findIndex(l => l.id === id), j = i + dir;
    if (j < 0 || j >= S.config.layers.length) return;
    [S.config.layers[i], S.config.layers[j]] = [S.config.layers[j], S.config.layers[i]];
    renderStage(); commit();
  }
  function refitText(l) {
    const m = pl(l.placement), ratio = measureText(l.text, l.font);
    let h = l.h_in, w = ratio * h;
    if (w > m.max_w_in) { w = +m.max_w_in; h = w / ratio; }
    l.w_in = round2(w); l.h_in = round2(h);
  }

  // ---------- 3D studio + try-on ----------
  function renderMode() {
    const is3d = S.mode === '3d';
    $('[data-canvas]').hidden = is3d;
    $('[data-3d]').hidden = !is3d;
    $('[data-stage]').classList.toggle('is-3d', is3d);
    root.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === S.mode || (b.dataset.mode === '3d' && S.mode === 'tryon')));
    const hint = $('[data-hint]');
    if (hint) hint.textContent = is3d
      ? 'Drag to turn the garment. Drag your artwork to move it; resize and rotate in the panel.'
      : 'Drag to move. Pull the corner to resize, the top dot to rotate.';
    if (is3d && !studio) start3d();
  }
  async function loadThree() {
    three ||= Promise.all([import('../three/kit.js'), import('../three/studio.js')]).then(([k, s]) => ({ ...k, ...s }));
    return three;
  }
  async function ensureKit() {
    const m = await loadThree();
    if (!kit) {
      kit = new m.GarmentKit({ ppi: matchMedia('(max-width: 820px)').matches ? 30 : 40 });
      sync3d();
    }
    return { m, kit };
  }
  async function start3d() {
    const host = $('[data-3d]');
    try {
      const { m } = await ensureKit();
      if (unloaded || studio) return;
      studio = m.createStudio(host, kit, {
        onPick(id) {
          const l = layer(id); if (!l) return;
          if (S.selected !== id) { S.selected = id; S.active = l.placement; S.view = pl(l.placement).view; renderPanel(); sync3d(); }
        },
        onMove(id, x, y) { const l = layer(id); if (!l) return; l.x_in = round2(x); l.y_in = round2(y); updateLayerEl(l); },
        onDragEnd(id, moved) { if (moved) commit(); renderStage(); renderPanel(); },
      });
      host.querySelector('[data-3d-status]')?.remove();
      studio.setView(viewFor(S.active), { instant: true });
      track('design_3d_viewed', { product_type: S.product.product_type });
    } catch (e) {
      console.error(e);
      host.querySelector('[data-3d-status]').textContent = '3D preview isn\'t available on this device. Showing the flat view.';
      setTimeout(() => setMode('2d'), 1600);
    }
  }
  function sync3d() {
    if (!kit) return;
    kit.setGarment({ type: S.product.product_type, color: colorHex(), size: S.size });
    kit.setDesign({ layers: S.config.layers, placements: placements(), art: S.art, methods: S.config.methods,
                    selected: S.selected, active: S.active, guides: S.mode === '3d' && !tryon });
  }
  function sync3dSoon() {
    if (!kit || syncRaf) return;
    syncRaf = requestAnimationFrame(() => { syncRaf = 0; sync3d(); });
  }
  const viewFor = (code) => /sleeve/.test(code || '') ? code.replace(/^(left|right)_sleeve$/, (m0, side) => `sleeve_${side[0]}`) : (pl(code)?.view || S.view);
  function setMode(mode) {
    if (mode === 'tryon') { openTryOn(); return; }
    S.mode = mode;
    try { sessionStorage.setItem('dz-mode', mode); } catch {}
    renderStage();
  }
  async function openTryOn() {
    if (tryon) return;
    try {
      const { kit: k } = await ensureKit();
      sync3d();
      const { openTryOn: open } = await import('../three/tryon.js');
      const colors = [...new Map(S.product.variants.map(v => [v.color, v])).values()].map(v => ({ name: v.color, hex: v.color_hex }));
      tryon = open(k, {
        title: `${S.product.name} · ${S.color}`, colors, color: S.color,
        onColor(name) { S.color = name; if (!variant()) S.size = S.product.variants.find(v => v.color === S.color).size; renderStage(); commit(); renderPanel(); return `${S.product.name} · ${S.color}`; },
        onClose() { tryon = null; studio?.invalidate(); sync3d(); },
      });
      track('tryon_opened', { product_type: S.product.product_type });
    } catch (e) { console.error(e); flash('Try-on couldn\'t start on this device.'); }
  }

  // ---------- left panel ----------
  function renderPanel() {
    const p = S.product, sizes = p.variants.filter(v => v.color === S.color);
    const colors = [...new Map(p.variants.map(v => [v.color, v])).values()];
    const used = printSummary(S.config, placements());
    const sel = layer(S.selected);
    const dpi = sel?.type === 'image' && S.art[sel.asset_id || sel.local] ? (() => {
      const a = S.art[sel.asset_id || sel.local];
      return Math.round(Math.min(a.width / sel.w_in, a.height / sel.h_in));
    })() : null;
    $('[data-panel]').innerHTML = `
      <section class="dz-step"><h2><span class="dz-n">1</span> Garment</h2>
        <div class="dz-products">${cat.products.map(x => `<button class="dz-product${x.id === p.id ? ' is-on' : ''}" data-product="${x.id}" aria-pressed="${x.id === p.id}">
          ${garmentSVG({ type: x.product_type, color: x.id === p.id ? colorHex() : '#3a3a3a', mode: 'flat', label: '' })}
          <span>${esc(x.name.replace(/^Essential /, ''))}</span><span class="muted">from ${money(x.base_price_cents)}</span></button>`).join('')}</div>
      </section>
      <section class="dz-step"><h2><span class="dz-n">2</span> Colour & size</h2>
        <div class="swatches">${colors.map(c => `<button class="swatch" style="background:${c.color_hex}" data-color="${esc(c.color)}" aria-label="${esc(c.color)}" aria-pressed="${c.color === S.color}"></button>`).join('')}</div>
        <p class="small muted" style="margin:6px 0 10px">${esc(S.color)}</p>
        <div class="sizes">${sizes.map(v => {
          const out = v.inventory_on_hand - v.inventory_reserved <= 0;
          return `<button class="size" data-size="${esc(v.size)}" aria-pressed="${v.size === S.size}" ${out ? 'disabled' : ''}>${esc(v.size)}</button>`;
        }).join('')}</div>
      </section>
      <section class="dz-step"><h2><span class="dz-n">3</span> Print areas</h2>
        <div class="dz-areas">${placements().map(x => {
          const u = used.find(s => s.placement === x.code);
          return `<button class="dz-area-btn${S.active === x.code ? ' is-on' : ''}" data-pick-area="${x.code}" aria-pressed="${S.active === x.code}">
            <strong>${esc(x.label)}</strong><span class="muted small">${u ? `${u.width_in}×${u.height_in} in used` : `up to ${+x.max_w_in}×${+x.max_h_in} in`}</span></button>`;
        }).join('')}</div>
        ${used.map(u => `<label class="dz-method"><span>${esc(pl(u.placement).label)} print method</span>
          <select data-method="${u.placement}">${cat.methods.map(m => `<option value="${m.code}"${u.method === m.code ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>`).join('')}
        ${used.length ? `<p class="small muted">${esc(cat.methods.find(m => m.code === (S.config.methods[S.active] || 'dtg'))?.description || '')}</p>` : ''}
      </section>
      <section class="dz-step"><h2><span class="dz-n">4</span> Artwork</h2>
        <div class="dz-add">
          <button class="btn" data-act="upload">Upload image</button>
          <button class="btn btn--quiet" data-act="text">Add text</button>
        </div>
        <p class="small muted">PNG, JPG, WebP or SVG up to 25 MB. Transparent PNGs print best. Adding to: <strong>${esc(pl(S.active)?.label || '')}</strong>.</p>
        ${S.config.layers.length ? `<ol class="dz-layers" aria-label="Layers, top first">${[...S.config.layers].reverse().map(l => `
          <li class="${S.selected === l.id ? 'is-on' : ''}">
            <button class="dz-layer-pick" data-select="${l.id}">${l.type === 'image' ? 'Image' : `“${esc(l.text.slice(0, 18))}”`}
              <span class="muted small">${esc(pl(l.placement)?.label || '')}</span></button>
            <button data-move="${l.id}" data-dir="1" aria-label="Bring forward">↑</button>
            <button data-move="${l.id}" data-dir="-1" aria-label="Send backward">↓</button>
            <button data-remove-layer="${l.id}" aria-label="Delete layer">✕</button></li>`).join('')}</ol>` : ''}
        ${sel ? `<div class="dz-props">
          ${sel.type === 'text' ? `
            <label class="field"><span>Text</span><input data-prop="text" maxlength="200" value="${esc(sel.text)}"></label>
            <label class="field"><span>Font</span><select data-prop="font">${Object.keys(FONTS).map(f => `<option value="${f}"${sel.font === f ? ' selected' : ''} style="font-family:${FONTS[f]}">${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}</select></label>
            <div class="dz-colors" role="group" aria-label="Text colour">${TEXT_COLORS.map(c => `<button class="swatch swatch--sm" style="background:${c}" data-text-color="${c}" aria-label="Colour ${c}" aria-pressed="${sel.color === c}"></button>`).join('')}
              <input type="color" data-prop="color" value="${esc(sel.color)}" aria-label="Custom colour"></div>` : ''}
          <label class="dz-range"><span>Size</span><input type="range" data-prop="width" min="0.5" step="0.1" max="${maxWidth(sel).toFixed(1)}" value="${sel.w_in}" aria-label="Artwork width in inches"></label>
          <div class="dz-readout"><span data-size-readout>${sel.w_in.toFixed(1)} × ${sel.h_in.toFixed(1)} in</span>
            <label>Rotate <input type="number" data-prop="rotation" min="0" max="359" value="${sel.rotation || 0}">°</label>
            <button class="linklike" data-act="center">Center</button></div>
          ${dpi ? `<p class="small ${dpi < 90 ? 'dz-warn' : dpi < 150 ? 'dz-caution' : 'muted'}">${dpi} DPI at this size${dpi < 90 ? ' — will print blurry. Make it smaller or use a bigger image.' : dpi < 150 ? ' — edges may look soft.' : ' — prints sharp.'}</p>` : ''}
        </div>` : ''}
      </section>
      <section class="dz-step"><h2><span class="dz-n">5</span> Extras</h2>
        ${cat.services.map(s => `<label class="check"><input type="checkbox" data-service="${s.code}" ${S.config.services.includes(s.code) ? 'checked' : ''}>
          <span><strong>${esc(s.label)}</strong><br><span class="small muted">${esc(s.description || '')}</span></span></label>`).join('')}
      </section>`;
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-view]');
    if (!t || !root.contains(t)) return;
    const d = t.dataset;
    if (d.product && d.product !== S.product.id) {
      const np = cat.products.find(p => p.id === d.product);
      const allowed = placementsFor(cat, np.product_type).map(p => p.code);
      const dropped = S.config.layers.filter(l => !allowed.includes(l.placement)).length;
      S.config.layers = S.config.layers.filter(l => allowed.includes(l.placement));
      S.product = np;
      if (!np.variants.some(v => v.color === S.color)) S.color = np.variants[0].color;
      if (!np.variants.some(v => v.color === S.color && v.size === S.size)) S.size = np.variants.find(v => v.color === S.color).size;
      if (!allowed.includes(S.active)) S.active = 'front';
      if (dropped) flash(`${dropped} layer(s) removed: that print area isn't available on the ${np.name.toLowerCase()}.`);
      renderStage(); commit(); renderPanel();
    } else if (d.color) { S.color = d.color;
      if (!variant()) S.size = S.product.variants.find(v => v.color === S.color).size;
      renderStage(); commit(); renderPanel();
    } else if (d.size) { S.size = d.size; commit(); renderPanel(); }
    else if (d.mode) setMode(d.mode);
    else if (d.pickArea) { S.active = d.pickArea; S.view = pl(d.pickArea).view; S.selected = null; renderStage(); renderPanel(); studio?.setView(viewFor(d.pickArea)); }
    else if (d.view) { S.view = d.view; S.active = placements().find(p => p.view === S.view)?.code || S.active; S.selected = null; renderStage(); renderPanel(); studio?.setView(d.view); }
    else if (d.select) { const l = layer(d.select); S.selected = l.id; S.active = l.placement; S.view = pl(l.placement).view; renderStage(); renderPanel(); studio?.setView(viewFor(l.placement)); }
    else if (d.move) moveLayer(d.move, Number(d.dir));
    else if (d.removeLayer) removeLayer(d.removeLayer);
    else if (d.textColor) { const l = layer(S.selected); l.color = d.textColor; renderStage(); commit(); renderPanel(); }
    else if (d.act === 'upload') $('[data-file]').click();
    else if (d.act === 'text') addText();
    else if (d.act === 'undo') undo();
    else if (d.act === 'redo') redo();
    else if (d.act === 'zoom-in') { if (S.mode === '3d' && studio) studio.zoom(0.82); else { S.zoom = Math.min(2.5, S.zoom + 0.25); renderStage(); } }
    else if (d.act === 'zoom-out') { if (S.mode === '3d' && studio) studio.zoom(1.22); else { S.zoom = Math.max(0.75, S.zoom - 0.25); renderStage(); } }
    else if (d.act === 'reset') { if (S.config.layers.length && !confirmInline(t, 'Remove all artwork?')) return;
      S.config.layers = []; S.selected = null; renderStage(); commit(); }
    else if (d.act === 'center') { const l = layer(S.selected), m = pl(l.placement); l.x_in = round2(m.max_w_in / 2); renderStage(); commit(); }
    else if (d.act === 'save') save().catch(showError);
    else if (d.act === 'submit') submit().catch(showError);
    else if (d.act === 'bag') toBag().catch(showError);
    else if (d.act === 'quote') renderQuoteForm();
    else if (d.qty) setQty(S.qty + Number(d.qty));
  });

  root.addEventListener('change', (e) => {
    const t = e.target, d = t.dataset;
    if (d.method) { S.config.methods[d.method] = t.value; commit(); }
    else if (d.service) {
      S.config.services = t.checked ? [...new Set([...S.config.services, d.service])] : S.config.services.filter(s => s !== d.service);
      commit();
    } else if (d.prop === 'font') { const l = layer(S.selected); l.font = t.value; refitText(l); renderStage(); commit(); renderPanel(); }
    else if (d.prop === 'color') { const l = layer(S.selected); l.color = t.value; renderStage(); commit(); }
    else if (d.prop === 'rotation') { const l = layer(S.selected); l.rotation = ((Number(t.value) || 0) % 360 + 360) % 360; renderStage(); commit(); }
    else if (t.matches('[data-qty-input]')) setQty(Number(t.value));
    else if (t.matches('[data-file]')) { const f = t.files[0]; t.value = ''; if (f) addImage(f); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.prop === 'text') {
      const l = layer(S.selected); l.text = t.value || ' '; refitText(l);
      const el = root.querySelector(`[data-layer="${l.id}"] .dz-text`); if (el) el.textContent = l.text;
      updateLayerEl(l); clearTimeout(kbTimer); kbTimer = setTimeout(commit, 400);
    } else if (t.dataset.prop === 'width') {
      const l = layer(S.selected); if (!l) return;
      const w = clamp(Number(t.value) || l.w_in, 0.5, maxWidth(l)), k = w / l.w_in;
      l.w_in = round2(w); l.h_in = round2(l.h_in * k);
      const ro = root.querySelector('[data-size-readout]'); if (ro) ro.textContent = `${l.w_in.toFixed(1)} × ${l.h_in.toFixed(1)} in`;
      updateLayerEl(l); clearTimeout(kbTimer); kbTimer = setTimeout(() => { commit(); renderPanel(); }, 350);
    } else if (t.matches('[data-name]')) { S.dirty = true; renderActions(); }
  });
  function maxWidth(l) {
    const m = pl(l.placement);
    return Math.max(0.5, Math.min(+m.max_w_in, +m.max_h_in * (l.w_in / l.h_in)));
  }

  // ---------- price ----------
  function setQty(n) {
    S.qty = clamp(Math.round(n) || 1, 1, 100000);
    schedulePrice(); renderActions();
  }
  function schedulePrice() { clearTimeout(priceTimer); priceTimer = setTimeout(price, 220); }
  async function price() {
    const summary = printSummary(S.config, placements());
    if (!summary.length) { S.quote = null; renderReceipt(); return; }
    try {
      S.quote = await db.rpc('price_custom', { p_product_id: S.product.id, p_size: S.size, p_print: summary,
                                               p_services: S.config.services, p_qty: S.qty });
    } catch (e) { S.quote = { error: e.message }; }
    if (!unloaded) { renderReceipt(); renderActions(); }
  }
  function renderReceipt() {
    const q = S.quote, el = $('[data-receipt]');
    const qtyRow = `<div class="dz-qty"><span>Quantity</span><div class="qty"><button data-qty="-1" aria-label="One fewer">−</button>
      <input data-qty-input type="number" min="1" value="${S.qty}" aria-label="Quantity"><button data-qty="1" aria-label="One more">+</button></div></div>`;
    if (!q) {
      el.innerHTML = `<h2 class="receipt-title">Your price</h2>${qtyRow}
        <dl class="receipt-lines"><dt>${esc(S.product.name)}</dt><dd>${money(S.product.base_price_cents)}</dd></dl>
        <p class="small">Add artwork or text to see the full price.</p>`;
      return;
    }
    if (q.error) {
      el.innerHTML = `<h2 class="receipt-title">Your price</h2>${qtyRow}<p class="dz-warn" role="alert">${esc(q.error)}</p>`;
      return;
    }
    const next = q.next_tier;
    el.innerHTML = `<h2 class="receipt-title">Your price</h2>${qtyRow}
      <dl class="receipt-lines">
        <dt>${esc(q.product_name)} (${esc(S.size)})</dt><dd>${money(q.base_cents)}</dd>
        ${q.size_cents ? `<dt>Size ${esc(S.size)}</dt><dd>+${money(q.size_cents)}</dd>` : ''}
        ${q.print.map(x => `<dt>${esc(x.placement_label)} · ${esc(x.area_label.split(' (')[0])} · ${esc(x.method_label)}</dt><dd>+${money(x.unit_cents)}</dd>`).join('')}
        ${q.artwork.filter(a => a.charge_per === 'unit').map(a => `<dt>${esc(a.label)}</dt><dd>+${money(a.cents)}</dd>`).join('')}
        ${q.volume_discount_cents ? `<dt>Volume discount</dt><dd>−${money(q.volume_discount_cents)}</dd>` : ''}
        <dt class="receipt-total">Per item</dt><dd class="receipt-total">${money(q.unit_cents)}</dd>
        <dt>× ${S.qty}</dt><dd>${money(q.unit_cents * S.qty)}</dd>
        ${q.setup_cents ? `<dt>Setup (one-time)</dt><dd>+${money(q.setup_cents)}</dd>` : ''}
        ${q.artwork.filter(a => a.charge_per === 'order').map(a => `<dt>${esc(a.label)} (one-time)</dt><dd>+${money(a.cents)}</dd>`).join('')}
        <dt class="receipt-total">Total</dt><dd class="receipt-total">${money(q.total_cents)}</dd>
      </dl>
      ${q.quote_required ? `<p class="dz-nudge">Orders of ${q.quote_threshold}+ get custom pricing. Request a quote below.</p>`
        : next ? `<p class="dz-nudge">Add ${next.add_qty} more to unlock <strong>${money(next.per_unit_discount_cents)} off per item</strong>.</p>` : ''}
      ${S.tiers?.tiers?.length ? `<details class="dz-tiers"><summary>Volume pricing</summary>
        <table><tbody>${S.tiers.tiers.map(t => `<tr${S.qty >= t.min_qty && (!t.max_qty || S.qty <= t.max_qty) ? ' class="is-on"' : ''}><td>${t.min_qty}${t.max_qty ? '–' + t.max_qty : '+'}</td><td>${money(t.per_unit_discount_cents)} off each</td></tr>`).join('')}
        ${S.tiers.quote_threshold ? `<tr><td>${S.tiers.quote_threshold}+</td><td>Request a quote</td></tr>` : ''}</tbody></table></details>` : ''}
      <p class="small muted" style="margin:10px 0 0">Prices in CAD before shipping and tax. Checkout uses this same calculation.</p>`;
  }

  // ---------- actions ----------
  function renderActions() {
    const el = $('[data-actions]');
    const st = S.status && !S.dirty ? S.status : (S.designId ? 'draft' : null);
    const info = st ? STATUS[st] : null;
    const findings = S.moderation?.findings || [];
    const quote = S.quote?.quote_required;
    const hasArt = S.config.layers.length > 0;
    el.innerHTML = `
      ${info ? `<div class="dz-status dz-status--${st}"><strong>${info[0]}</strong> <span>${S.decision && !S.dirty ? esc(S.decision) : info[1]}</span>
        ${findings.length && !S.dirty ? `<ul>${findings.map(f => `<li>${esc(typeof f === 'string' ? f : f.message)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      ${S.dirty && S.designId ? '<p class="small muted">Unsaved changes. Saving creates a new version, which needs approval again.</p>' : ''}
      ${!auth.user ? authBox() : `
        ${quote ? `<button class="btn btn--block" data-act="quote" ${hasArt ? '' : 'disabled'}>Request a quote</button>`
          : isApproved() ? `<button class="btn btn--block" data-act="bag" ${S.busy ? 'disabled' : ''}>Add ${S.qty} to bag · ${S.quote?.total_cents != null ? money(S.quote.total_cents) : ''}</button>`
          : `<button class="btn btn--block" data-act="submit" ${!hasArt || S.busy || S.quote?.error ? 'disabled' : ''}>${S.status === 'needs_review' && !S.dirty ? 'Waiting for review' : 'Submit for approval'}</button>`}
        <button class="btn btn--quiet btn--block" data-act="save" ${!hasArt || S.busy ? 'disabled' : ''}>${S.designId ? 'Save changes' : 'Save design'}</button>
        <p class="small muted">Every design is checked before printing. Approved designs can be ordered right away.</p>`}
      <p class="form-msg" role="status" data-msg>${esc(S.msg)}</p>
      <div data-quote-form></div>`;
    el.querySelector('[data-auth]')?.addEventListener('submit', signIn);
  }
  function authBox() {
    return `<form class="dz-auth" data-auth novalidate>
      <p><strong>Sign in to save and order your design.</strong> Your work stays on this page while you do.</p>
      <div class="field"><label for="dz-email">Email</label><input id="dz-email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="dz-pass">Password</label><input id="dz-pass" name="password" type="password" minlength="8" autocomplete="current-password" required></div>
      <div class="form-row"><button class="btn" type="submit" name="mode" value="in">Sign in</button><button class="btn btn--quiet" type="submit" name="mode" value="up">Create account</button></div>
    </form>`;
  }
  async function signIn(e) {
    e.preventDefault();
    const f = e.target, mode = e.submitter?.value || 'in';
    try {
      flash(mode === 'up' ? 'Creating your account…' : 'Signing in…');
      if (mode === 'up') {
        const r = await auth.signUp(f.email.value.trim(), f.password.value);
        if (!r.access_token) { flash('Check your email to confirm your account, then sign in here.'); return; }
      } else await auth.signIn(f.email.value.trim(), f.password.value);
      flash(''); renderActions();
    } catch (err) { flash(err.message); }
  }
  function flash(m) { S.msg = m; const el = root.querySelector('[data-msg]'); if (el) el.textContent = m; }
  function showError(e) { S.busy = false; flash(e.message || String(e)); renderActions(); }
  function confirmInline(btn, text) {
    if (btn.dataset.confirm) return true;
    btn.dataset.confirm = '1'; const prev = btn.textContent; btn.textContent = text + ' Click again';
    setTimeout(() => { btn.textContent = prev; delete btn.dataset.confirm; }, 2500);
    return false;
  }

  async function save() {
    if (!auth.user) { flash('Sign in first.'); return; }
    S.busy = true; renderActions(); flash('Uploading artwork…');
    const uid = auth.user.id;
    for (const l of S.config.layers) {
      if (l.type === 'image' && l.local) {
        const art = S.art[l.local];
        l.asset_id = await uploadArtwork(art);
        S.art[l.asset_id] = art; delete l.local;
      }
    }
    flash('Rendering previews…');
    const v = (S.version || 0) + 1;
    const used = placements().filter(p => S.config.layers.some(l => l.placement === p.code));
    const mockups = {}, production = {};
    for (const view of ['front', 'back']) {
      if (view === 'back' && !used.some(p => p.view === 'back')) continue;
      let blob = null;
      if (studio) { try { sync3d(); blob = await studio.mockup(view); } catch (e) { console.warn('3D mockup failed, using flat', e); } }
      blob ||= await renderMockup(S.config, S.product, colorHex(), view, placements(), S.art);
      const path = `${uid}/${S.designKey}/v${v}-${view}.png`;
      await storage.upload('mockups', path, blob, 'image/png');
      mockups[view] = path;
    }
    const files = await renderProduction(S.config, used, S.art, 150);
    for (const [code, blob] of Object.entries(files)) {
      const path = `${uid}/${S.designKey}/v${v}-print-${code}.png`;
      await storage.upload('designs', path, blob, 'image/png');
      await db.rpc('design_register_asset', { p_bucket: 'designs', p_path: path, p_kind: 'production', p_mime: 'image/png', p_bytes: blob.size });
      production[code] = path;
    }
    flash('Saving…');
    const r = await db.rpc('design_save', {
      p_design_id: S.designId, p_name: $('[data-name]').value, p_product_id: S.product.id, p_variant_id: variant().id,
      p_config: S.config, p_mockups: mockups, p_production: production });
    S.designId = r.id; S.version = r.version; S.status = r.status; S.moderation = null; S.decision = null;
    S.dirty = false; S.busy = false; lastSnap = snapshot();
    history.replaceState(history.state, '', `/custom/${r.id}`);
    flash(`Saved (version ${r.version}).`);
    renderActions();
  }

  async function submit() {
    if (S.dirty || !S.designId) await save();
    S.busy = true; S.status = 'pending'; S.moderation = null; S.decision = null; renderActions(); flash('');
    await db.rpc('design_submit', { p_design_id: S.designId });
    const res = await fetch('/api/moderate-design', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.session.access_token}` },
      body: JSON.stringify({ design_id: S.designId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The automated check didn\'t run. Try submitting again.');
    S.status = data.status; S.moderation = { findings: data.findings }; S.busy = false;
    if (data.status === 'approved') S.approvedVersion = S.version;
    S.decision = data.status === 'approved' ? null : STATUS[data.status]?.[1];
    renderActions();
  }

  async function toBag() {
    S.busy = true; renderActions();
    await addDesignToBag(S.designId, S.qty);
    S.busy = false;
    flash('');
    renderActions();
    root.querySelector('[data-msg]').innerHTML = `Added to your bag. <a href="/cart">View bag</a> or <a href="/checkout">check out</a>.`;
  }

  function renderQuoteForm() {
    const host = root.querySelector('[data-quote-form]');
    host.innerHTML = `<form class="dz-quote panel-box" data-qf novalidate>
      <h3 class="sub-head">Request a quote for ${S.qty} pieces</h3>
      <div class="field"><label for="qf-name">Name</label><input id="qf-name" name="name" required autocomplete="name"></div>
      <div class="field"><label for="qf-email">Email</label><input id="qf-email" name="email" type="email" required value="${esc(auth.user?.email || '')}"></div>
      <div class="field"><label for="qf-phone">Phone (optional)</label><input id="qf-phone" name="phone" type="tel"></div>
      <div class="field"><label for="qf-sizes">Sizes (e.g. 100 M, 100 L, 50 XL)</label><input id="qf-sizes" name="sizes"></div>
      <div class="field"><label for="qf-date">Needed by (optional)</label><input id="qf-date" name="date" type="date"></div>
      <div class="field"><label for="qf-notes">Notes</label><textarea id="qf-notes" name="notes" rows="3" maxlength="2000"></textarea></div>
      <button class="btn btn--block" type="submit">Send request</button>
    </form>`;
    host.querySelector('[data-qf]').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!f.name.value.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value)) { flash('Enter your name and email.'); return; }
      try {
        if (S.dirty || !S.designId) await save();
        const sizes = Object.fromEntries((f.sizes.value.match(/(\d+)\s*([A-Za-z0-9]+)/g) || []).map(s => { const m = s.match(/(\d+)\s*(\S+)/); return [m[2].toUpperCase(), +m[1]]; }));
        const r = await db.rpc('submit_quote_request', {
          p_name: f.name.value, p_email: f.email.value, p_phone: f.phone.value, p_product_id: S.product.id, p_design_id: S.designId,
          p_quantity: S.qty, p_size_breakdown: sizes, p_colors: S.color,
          p_placements: printSummary(S.config, placements()).map(s => pl(s.placement).label).join(', '),
          p_desired_date: f.date.value || null, p_notes: f.notes.value });
        host.innerHTML = `<p class="dz-status dz-status--approved"><strong>Quote ${esc(r.number)} sent.</strong> We'll reply by email with pricing.</p>`;
      } catch (err) { flash(err.message); }
    };
    host.querySelector('input').focus();
  }

  // ---------- boot ----------
  function renderAll() { renderStage(); renderPanel(); renderReceipt(); renderActions(); }
  (async () => {
    if (saved) {
      const ids = Object.keys(saved.assets || {});
      const byPath = await storage.sign('designs', ids.map(i => saved.assets[i].path));
      for (const i of ids) {
        const a = saved.assets[i];
        S.art[i] = { assetId: i, url: byPath[a.path], width: a.width_px || 1000, height: a.height_px || 1000, name: a.name };
      }
    }
    S.tiers = await db.rpc('custom_quantity_tiers', { p_product_id: S.product.id }).catch(() => null);
    renderAll(); schedulePrice();
    if (!saved) track('custom_design_started');
  })();
  const onResize = () => renderStage();
  addEventListener('resize', onResize);
  const onUnload = (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', onUnload);
  return () => {
    unloaded = true; removeEventListener('resize', onResize); removeEventListener('beforeunload', onUnload); clearTimeout(priceTimer);
    cancelAnimationFrame(syncRaf); tryon?.close(); studio?.dispose(); studio = null;
  };
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const round2 = (n) => Math.round(n * 100) / 100;
