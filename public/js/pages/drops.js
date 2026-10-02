// /drops — live, upcoming and sold-out (not yet archived) limited drops.
import { db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { dropCard, startCountdowns } from '../components/ui.js';

export async function load() {
  const theme = await themeForPage('drops');
  const drops = await db.from('storefront_products').select('*').eq('is_limited', true)
    .in('status', ['active', 'scheduled', 'sold_out']).order('release_at');
  const now = Date.now();
  const live = drops.filter(d => d.status === 'active' && new Date(d.release_at) <= now);
  const upcoming = drops.filter(d => d.status === 'scheduled' || new Date(d.release_at) > now);
  const soldOut = drops.filter(d => d.status === 'sold_out');
  const block = (title, list, empty) => `<section class="section" style="padding-block:40px"><div class="wrap">
    <div class="section-head"><h2 class="h-section">${title}</h2></div>
    ${list.length ? `<div class="drops">${list.map(dropCard).join('')}</div>` : `<p class="muted">${empty}</p>`}</div></section>`;
  return {
    theme, title: 'Limited drops', description: 'Numbered limited editions. When they sell out, they move to the archive.',
    html: `<section class="section" style="padding-bottom:0"><div class="wrap">
        <h1 class="h-section">Limited drops</h1>
        <p class="lede">Every piece is numbered. When an edition sells out it goes to the <a href="/archive">archive</a> for good.</p></div></section>
      ${block('Live now', live, 'Nothing live right now. Check upcoming drops below.')}
      ${block('Upcoming', upcoming, 'No drops announced yet. Join the list on the home page to hear first.')}
      ${soldOut.length ? block('Just sold out', soldOut, '') : ''}`,
    mount: (root) => startCountdowns(root),
  };
}
