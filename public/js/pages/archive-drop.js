// /archive/:slug — a single historical drop. Never purchasable.
import { db } from '../lib/supabase.js';
import { themeForPage, money, pad3, fmtDate } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';
import { wishlistButtonHTML, bindWishlist } from '../lib/wishlist.js';

export async function load({ slug }) {
  const d = await db.from('archive_drops').select('*').eq('slug', slug).single().catch(() => null);
  if (!d) {
    // A drop that exists but isn't archived yet: send people to the live page.
    const live = await db.from('storefront_products').select('slug').eq('drop_slug', slug).single().catch(() => null);
    if (live) return (await import('./product.js')).load({ slug: live.slug });
    return (await import('./not-found.js')).load();
  }
  const theme = await themeForPage('archive');
  const color = d.colors?.[0]?.hex || '#141414';
  const historical = (d.media || []).filter(m => m.historical);

  return {
    theme, title: `${d.drop_name} — Drop ${pad3(d.drop_number)}`, description: d.story,
    entity: { type: 'limited_drop', id: d.id },
    html: `<div class="wrap pdp">
      <div class="pdp-media">${garmentSVG({ type: d.product_type, color, mode: 'flat', label: d.product_name })}</div>
      <div class="pdp-info">
        <a href="/archive" class="muted" style="font-size:14px">The Archive</a>
        <div class="plaque-no">DROP ${pad3(d.drop_number)}</div>
        <h1 class="pdp-title">${esc(d.drop_name)}</h1>
        <p class="lede" style="margin:0">${esc(d.story || d.description || '')}</p>
        <div class="archived-lock"><strong>Archived</strong><span>No longer available</span></div>
        <div class="wish-row">${wishlistButtonHTML('Save')}<span class="muted small">Keep it in your collection history</span></div>
        <dl class="specs">
          <dt>Piece</dt><dd>${esc(d.product_name)}</dd>
          <dt>Released</dt><dd>${fmtDate(d.release_at)}</dd>
          <dt>Edition</dt><dd>${d.edition_size} numbered pieces</dd>
          <dt>Sold</dt><dd>${d.units_sold} of ${d.edition_size}${d.sold_out_at ? `, sold out ${fmtDate(d.sold_out_at)}` : ''}</dd>
          <dt>Original price</dt><dd>${money(d.original_price_cents)}</dd>
          ${d.designer_name ? `<dt>Designer</dt><dd>${esc(d.designer_name)}</dd>` : ''}
          ${d.collection_name ? `<dt>Collection</dt><dd>${esc(d.collection_name)}</dd>` : ''}
          ${d.category_name ? `<dt>Category</dt><dd>${esc(d.category_name)}</dd>` : ''}
          ${d.materials ? `<dt>Fabric</dt><dd>${esc(d.materials)}</dd>` : ''}
        </dl>
        ${historical.length ? `<div class="grid">${historical.map(m => `<img src="${esc(m.url)}" alt="${esc(m.alt || '')}" loading="lazy">`).join('')}</div>` : ''}
      </div></div>`,
    mount(root) { bindWishlist(root, { productId: d.product_id }); },
  };
}
