// Small pages: search, not found, error, and areas still under construction.
import { db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { productGrid, esc } from '../components/ui.js';
import { track } from '../lib/analytics.js';

export async function load(_, query) {
  const theme = await themeForPage('search');
  const q = (query.get('q') || '').trim().slice(0, 80);
  const results = q ? await db.rpc('search_products', { q }) : [];
  if (q) track('search', { query: q, results: results.length });
  return {
    theme, title: q ? `Search: ${q}` : 'Search',
    html: `<section class="section" style="padding-top:56px"><div class="wrap">
      <h1 class="h-section" style="margin-bottom:24px">Search</h1>
      <form class="form-row" action="/search" role="search" data-search style="margin-bottom:36px">
        <label class="sr-only" for="q">Search products</label>
        <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Hoodie, anime, DROP 004, SKU…" autofocus>
        <button class="btn" type="submit">Search</button>
      </form>
      ${q ? `<p class="muted">${results.length} result${results.length === 1 ? '' : 's'} for “${esc(q)}”</p>${productGrid(results, theme.config.cards.style, 'No matches. Try a product type, a collection or a designer.')}` : ''}
    </div></section>`,
    mount(root) {
      root.querySelector('[data-search]').onsubmit = (e) => {
        e.preventDefault();
        const v = e.target.q.value.trim();
        import('../app.js').then(m => m.go(`/search?q=${encodeURIComponent(v)}`));
      };
    },
  };
}
