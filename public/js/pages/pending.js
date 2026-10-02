// Areas whose build phase hasn't landed yet. Says so plainly instead of
// showing fake screens.
import { themeForPage } from '../lib/store.js';
const AREAS = {
  custom:   ['Custom designer', 'Upload artwork, place it on a garment, preview it and order it.', 'Phase 3'],
  designs:  ['Saved designs', 'Your saved custom designs and their history.', 'Phase 3'],
  wishlist: ['Wishlist', 'Save products, collections and drops — archived ones stay visible.', 'a later phase'],
};
export async function load({ area }) {
  const [title, what, phase] = AREAS[area] || AREAS.custom;
  return {
    theme: await themeForPage(area === 'custom' || area === 'designs' ? 'custom' : 'account'), title,
    html: `<section class="state"><h1>${title}</h1><p class="lede">${what}</p>
      <p class="muted">This part of the store arrives in ${phase} of the build.</p>
      <p class="hero-actions"><a class="btn" href="/shop">Browse the shop</a></p></section>`,
  };
}
