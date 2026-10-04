// Wishlist: save products (incl. limited and archived drops) and
// collections. Rows are the customer's own (RLS); signed-out shoppers are
// sent to sign in.
import { db, auth } from './supabase.js';
import { track } from './analytics.js';
import { signInUrl } from './cart.js';
import { esc } from '../components/ui.js';

const key = (t) => (t.productId ? { product_id: t.productId } : { collection_id: t.collectionId });

export function wishlistButtonHTML(label = 'Save') {
  return `<button type="button" class="btn btn--quiet wish-btn" data-wish aria-pressed="false"><span class="wish-heart" aria-hidden="true">♡</span> <span data-wish-label>${esc(label)}</span></button>`;
}

/** target: { productId } or { collectionId } */
export async function bindWishlist(root, target) {
  const btn = root.querySelector('[data-wish]');
  if (!btn) return;
  const set = (on) => {
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('.wish-heart').textContent = on ? '♥' : '♡';
    btn.querySelector('[data-wish-label]').textContent = on ? 'Saved' : 'Save';
  };
  let rowId = null;
  if (auth.user) {
    const [k, v] = Object.entries(key(target))[0];
    const rows = await db.from('wishlist_items').select('id').eq(k, v).eq('user_id', auth.user.id).limit(1).catch(() => []);
    rowId = rows[0]?.id || null;
    set(!!rowId);
  }
  btn.addEventListener('click', async () => {
    if (!auth.user) { location.href = signInUrl(); return; }
    btn.disabled = true;
    try {
      if (rowId) { await db.remove('wishlist_items', { id: rowId }); rowId = null; set(false); }
      else {
        const [row] = await db.insert('wishlist_items', { user_id: auth.user.id, ...key(target) });
        rowId = row.id; set(true);
        track('wishlist_add', { entity_type: target.productId ? 'product' : 'collection', entity_id: target.productId || target.collectionId });
      }
    } catch { /* leave state as it was */ } finally { btn.disabled = false; }
  });
}
