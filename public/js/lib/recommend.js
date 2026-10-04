// Recommendation rows ("You might also like", "Goes well with", "Picked for
// you"). Computed in the database from the store's own orders, views and
// wishlists — no outside service. Rows load after the page so they never
// slow it down, and simply don't appear if there's nothing good to show.
import { db } from './supabase.js';
import { productCard, esc } from '../components/ui.js';
import { track } from './analytics.js';

export function recsSlot(id) { return `<section class="section recs" data-recs="${id}" hidden aria-live="polite"></section>`; }

/** fn: rpc name; args: rpc args; source: label for analytics. */
export async function mountRecs(root, { slot, fn, args = {}, title, cardStyle, source, min = 2, max = 4 }) {
  const host = root.querySelector(`[data-recs="${slot}"]`);
  if (!host) return;
  const rows = await db.rpc(fn, args).catch(() => []);
  if (!host.isConnected || !Array.isArray(rows) || rows.length < min) { host.hidden = true; return; }
  const list = rows.slice(0, max);
  host.innerHTML = `<div class="wrap"><div class="section-head"><h2 class="h-section recs-title">${esc(title)}</h2></div>
    <div class="grid recs-grid">${list.map(p => productCard(p, cardStyle)).join('')}</div></div>`;
  host.hidden = false;
  host.querySelectorAll('.card').forEach((a, i) => a.addEventListener('click', () =>
    track('recommendation_click', { source, position: i + 1, entity_type: 'product', entity_id: list[i].id })));
}
