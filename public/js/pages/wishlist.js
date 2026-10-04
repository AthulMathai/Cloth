// /wishlist — saved products, limited drops (archived ones stay visible,
// never buyable) and collections.
import { db, auth } from '../lib/supabase.js';
import { themeForPage, money, pad3, fmtDate } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';
import { signInPage } from './cart.js';

function state(p) {
  const d = p.drop;
  if (p.status === 'archived' || d?.archived_at) return ['Archived — no longer available', 'is-stopped'];
  if (p.status === 'sold_out' || d?.sold_out_at) return ['Sold out', 'is-stopped'];
  if (p.status === 'scheduled' || (d?.release_at && new Date(d.release_at) > new Date())) return [`Releases ${fmtDate(d?.release_at)}`, ''];
  if (p.status === 'discontinued') return ['Discontinued', 'is-stopped'];
  if (!p.in_stock) return ['Out of stock', 'is-stopped'];
  return ['Available', ''];
}
const href = (p) => (p.status === 'archived' || p.drop?.archived_at) && p.drop?.slug ? `/archive/${p.drop.slug}` : `/product/${p.slug}`;

export async function load() {
  const theme = await themeForPage('account');
  if (!auth.user) return signInPage(theme, 'Wishlist', 'Your wishlist', 'Sign in to save pieces, drops and collections for later.');
  const items = await db.rpc('wishlist_get');
  const products = items.filter(i => i.kind === 'product'), collections = items.filter(i => i.kind === 'collection');
  return {
    theme, title: 'Wishlist',
    html: `<section class="section commerce"><div class="wrap">
      <div class="section-head"><h1 class="h-section">Wishlist</h1><span class="muted">${items.length} saved</span></div>
      ${!items.length ? `<div class="panel-box"><p class="lede">Nothing saved yet. Tap “Save” on any piece, drop or collection.</p><p><a class="btn" href="/shop">Shop</a></p></div>` : ''}
      ${products.length ? `<div class="grid wish-grid">${products.map(i => { const p = i.product, [txt, cls] = state(p); return `
        <article class="card wish-card" data-id="${i.id}">
          <a href="${href(p)}" class="card-media">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : garmentSVG({ type: p.product_type, color: p.color_hex, mode: 'flat', label: p.name })}</a>
          <div class="card-body">
            ${p.drop ? `<span class="drop-no small">DROP ${pad3(p.drop.drop_number)}${p.drop.edition_size ? ` · ${p.drop.units_sold}/${p.drop.edition_size}` : ''}</span>` : ''}
            <a class="card-name" href="${href(p)}">${esc(p.name)}</a>
            <span>${money(p.price_cents)}</span>
            <span class="status-pill small${cls ? ' ' + cls : ''}">${esc(txt)}</span>
            <button class="btn btn--quiet small" data-remove>Remove</button>
          </div></article>`; }).join('')}</div>` : ''}
      ${collections.length ? `<h2 class="sub-head">Collections</h2><div class="chips">${collections.map(i => `<span class="chip wish-chip" data-id="${i.id}"><a href="/collections/${esc(i.collection.slug)}">${esc(i.collection.name)}</a> <button class="link-btn" data-remove aria-label="Remove ${esc(i.collection.name)}">×</button></span>`).join('')}</div>` : ''}
    </div></section>`,
    mount(root) {
      root.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
        const el = b.closest('[data-id]');
        b.disabled = true;
        try { await db.remove('wishlist_items', { id: el.dataset.id }); el.remove(); } catch { b.disabled = false; }
      }));
    },
  };
}
