// Bag (cart) client. The bag lives in Supabase; this module only keeps the
// guest token and a cached item count for the header badge. Prices always
// come back from the database.
import { db, auth } from './supabase.js';
import { track } from './analytics.js';

const KEY = 'th8rty.bag';
let count = 0;

export function cartToken() {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}
function saveToken(t) {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {}
}

function emit(items) {
  count = items.reduce((n, i) => n + i.quantity, 0);
  document.dispatchEvent(new CustomEvent('bag:change', { detail: { count, items } }));
}

export const bagCount = () => count;

export async function getBag() {
  const r = await db.rpc('cart_get', { p_token: cartToken() });
  if (r.token && !auth.user) saveToken(r.token);
  emit(r.items);
  return r.items;
}

export async function setItem(variantId, quantity, mode = 'set') {
  const r = await db.rpc('cart_set_item', { p_token: cartToken(), p_variant_id: variantId, p_quantity: quantity, p_mode: mode });
  if (r.token) saveToken(r.token);
  emit(r.items);
  return r.items;
}

export async function addToBag(variantId, qty = 1, meta = {}) {
  const items = await setItem(variantId, qty, 'add');
  track('add_to_cart', { entity_type: 'variant', entity_id: variantId, quantity: qty, ...meta });
  return items;
}

export async function removeFromBag(variantId) {
  const items = await setItem(variantId, 0, 'set');
  track('remove_from_cart', { entity_type: 'variant', entity_id: variantId });
  return items;
}

export async function quote({ province = null, rate = null, code = null, email = null } = {}) {
  return db.rpc('cart_quote', { p_token: cartToken(), p_province: province, p_rate_code: rate, p_discount_code: code, p_email: email });
}

// After a successful order the bag is emptied server-side.
export function resetLocalBag() { emit([]); }

// When a guest signs in, their bag merges into the account bag on the next read.
auth.onChange(() => getBag().catch(() => {}));
