// /product/:slug
import { db } from '../lib/supabase.js';
import { categoryById, themeForCategory, money, pad3, fmtDate } from '../lib/store.js';
import { esc, garmentSVG, calloutSVG, priceHTML, startCountdowns } from '../components/ui.js';
import { track } from '../lib/analytics.js';

export async function load({ slug }) {
  const p = await db.from('storefront_products').select('*').eq('slug', slug).single().catch(() => null);
  if (!p) return (await import('./not-found.js')).load();
  // Archived drops live at their archive URL; never show a buy box for them.
  if (p.status === 'archived' && p.drop_slug) return (await import('./archive-drop.js')).load({ slug: p.drop_slug });

  const [cat, variants] = await Promise.all([
    categoryById(p.category_id),
    db.from('product_variants').select('id,sku,size,color,color_hex,price_cents,sale_price_cents,inventory_on_hand,inventory_reserved,sort_order').eq('product_id', p.id).eq('is_active', true).order('sort_order'),
  ]);
  const theme = await themeForCategory(cat);
  const sketch = theme.config.cards.style === 'sketch-callout';
  const colors = [...new Map(variants.map(v => [v.color, v])).values()];
  const firstColor = colors[0]?.color_hex || '#141414';
  const upcoming = p.release_at && new Date(p.release_at) > new Date() || p.status === 'scheduled';

  const media = sketch && p.sketch_callouts?.length
    ? calloutSVG({ type: p.product_type, color: firstColor, callouts: p.sketch_callouts, label: p.name })
    : garmentSVG({ type: p.product_type, color: firstColor, mode: sketch ? 'sketch' : 'flat', label: p.name });

  let buyBox;
  if (p.status === 'sold_out') {
    buyBox = `<div class="archived-lock"><strong>Sold out</strong><span class="muted">All ${p.edition_size} pieces are claimed. This drop moves to the archive soon.</span></div>`;
  } else if (upcoming) {
    buyBox = `<div class="notice"><div class="muted" style="font-size:14px">Releases ${fmtDate(p.release_at || p.publish_at)}</div>
      <div class="countdown" data-countdown="${esc(p.release_at || p.publish_at)}">--:--:--</div></div>`;
  } else if (p.status === 'discontinued') {
    buyBox = `<div class="notice">This piece has been discontinued.</div>`;
  } else {
    buyBox = `
      <div><div class="option-label">Colour: <span data-color-name>${esc(colors[0]?.color || '')}</span></div>
        <div class="swatches">${colors.map((c, i) => `<button class="swatch" style="background:${c.color_hex}" data-color="${esc(c.color)}" data-hex="${c.color_hex}" aria-label="${esc(c.color)}" aria-pressed="${i === 0}"></button>`).join('')}</div></div>
      <div><div class="option-label">Size</div><div class="sizes" data-sizes></div></div>
      <div class="form-msg" data-stock role="status"></div>
      <button class="btn" data-add disabled>Add to bag</button>
      <p class="muted" style="font-size:14px;margin:0">Bag and checkout are being built next; this page already reads live stock.</p>`;
  }

  const html = `<div class="wrap pdp">
    <div class="pdp-media" data-media>${media}</div>
    <div class="pdp-info">
      ${p.drop_number ? `<div class="drop-no">DROP ${pad3(p.drop_number)} · ${esc(p.drop_name)}</div>` : ''}
      <h1 class="pdp-title">${esc(p.name)}</h1>
      <div class="pdp-price">${priceHTML(p)}</div>
      ${p.drop_id && !upcoming ? `<div><div class="meter"><span style="width:${(p.units_sold / p.edition_size) * 100}%"></span></div>
        <div class="drop-count">${p.units_sold} / ${p.edition_size} claimed · ${p.units_remaining} left · each piece individually numbered</div></div>` : ''}
      <p class="lede" style="margin:0">${esc(p.description || '')}</p>
      ${buyBox}
      <dl class="specs">
        ${p.materials ? `<dt>Fabric</dt><dd>${esc(p.materials)}</dd>` : ''}
        ${p.designer_name ? `<dt>Designer</dt><dd>${esc(p.designer_name)}</dd>` : ''}
        ${p.collection_name ? `<dt>Collection</dt><dd><a href="/collections/${p.collection_slug}">${esc(p.collection_name)}</a></dd>` : ''}
        ${p.print_methods?.length ? `<dt>Print</dt><dd>${p.print_methods.map(m => m.toUpperCase()).join(', ')}</dd>` : ''}
      </dl>
    </div></div>`;

  return {
    theme, html, title: p.seo?.title || p.name, description: p.seo?.description || p.description,
    entity: { type: 'product', id: p.id },
    mount(root) {
      track(p.is_limited ? 'limited_drop_viewed' : 'product_view', { entity_type: 'product', entity_id: p.id });
      const stop = startCountdowns(root);
      const sizesEl = root.querySelector('[data-sizes]');
      if (!sizesEl) return stop;
      let color = colors[0]?.color, size = null;
      const stockMsg = root.querySelector('[data-stock]'), add = root.querySelector('[data-add]');
      const renderSizes = () => {
        const vs = variants.filter(v => v.color === color);
        sizesEl.innerHTML = vs.map(v => {
          const avail = v.inventory_on_hand - v.inventory_reserved;
          return `<button class="size" data-size="${esc(v.size)}" aria-pressed="${v.size === size}" ${avail <= 0 ? 'disabled' : ''}>${esc(v.size)}</button>`;
        }).join('');
        sizesEl.querySelectorAll('.size').forEach(b => b.onclick = () => { size = b.dataset.size; renderSizes(); });
        const v = vs.find(x => x.size === size);
        const avail = v ? v.inventory_on_hand - v.inventory_reserved : 0;
        stockMsg.textContent = !v ? 'Pick a size.' : avail <= 0 ? 'Out of stock in this size.' : avail <= 5 ? `Only ${avail} left in ${v.size}.` : 'In stock.';
        add.disabled = true; // enabled once the cart ships
        if (v) add.textContent = `Add to bag · ${money(v.sale_price_cents ?? v.price_cents ?? p.price_cents)}`;
      };
      root.querySelectorAll('.swatch').forEach(b => b.onclick = () => {
        color = b.dataset.color; size = null;
        root.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', x === b));
        root.querySelector('[data-color-name]').textContent = color;
        root.querySelector('[data-media]').innerHTML = sketch && p.sketch_callouts?.length
          ? calloutSVG({ type: p.product_type, color: b.dataset.hex, callouts: p.sketch_callouts, label: p.name })
          : garmentSVG({ type: p.product_type, color: b.dataset.hex, mode: sketch ? 'sketch' : 'flat', label: p.name });
        renderSizes();
      });
      renderSizes();
      return stop;
    },
  };
}
