// /search — finds products by meaning as well as by words ("something warm
// for winter", "samurai"), via /api/ai-search. Falls back to plain keyword
// search if that service isn't reachable.
import { db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { productGrid, esc } from '../components/ui.js';
import { track } from '../lib/analytics.js';

async function find(q) {
  try {
    const res = await fetch(`/api/ai-search?q=${encodeURIComponent(q)}`);
    if (res.ok) { const d = await res.json(); if (Array.isArray(d.results)) return { results: d.results, semantic: d.semantic }; }
  } catch { /* offline or no functions in local dev */ }
  return { results: await db.rpc('search_products', { q }), semantic: false };
}

export async function load(_, query) {
  const theme = await themeForPage('search');
  const q = (query.get('q') || '').trim().slice(0, 80);
  const { results, semantic } = q ? await find(q) : { results: [], semantic: false };
  if (q) track('search', { query: q, results: results.length, semantic });
  return {
    theme, title: q ? `Search: ${q}` : 'Search',
    html: `<section class="section" style="padding-top:56px"><div class="wrap">
      <h1 class="h-section" style="margin-bottom:24px">Search</h1>
      <form class="form-row" action="/search" role="search" data-search style="margin-bottom:36px">
        <label class="sr-only" for="q">Search products</label>
        <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Try “warm hoodie for winter”, anime, DROP 004, a SKU…" autofocus>
        <button class="btn" type="submit">Search</button>
      </form>
      ${q ? `<p class="muted">${results.length} result${results.length === 1 ? '' : 's'} for “${esc(q)}”${semantic && results.length ? ' · closest matches first' : ''}</p>${productGrid(results, theme.config.cards.style, 'No matches. Try a product type, a collection or a designer.')}` : ''}
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
