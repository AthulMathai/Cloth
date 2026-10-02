// /shop — everything currently in the store, filterable by category.
import { db } from '../lib/supabase.js';
import { loadBoot, themeForPage } from '../lib/store.js';
import { productGrid, esc } from '../components/ui.js';

export async function load(_, query) {
  const boot = await loadBoot();
  const theme = await themeForPage('shop');
  const cat = query.get('category');
  let q = db.from('storefront_products').select('*').in('status', ['active', 'out_of_stock', 'sold_out']).order('created_at', { ascending: false });
  if (cat) q = q.eq('category_slug', cat);
  const products = await q;
  return {
    theme, title: 'Shop', description: 'Every piece currently in the store.',
    html: `<section class="section" style="padding-top:56px"><div class="wrap">
      <div class="section-head"><h1 class="h-section">Shop</h1><span class="muted">${products.length} pieces</span></div>
      <nav class="chips" aria-label="Filter by category" style="margin-bottom:32px">
        <a class="chip" href="/shop"${!cat ? ' aria-current="page"' : ''}>All</a>
        ${boot.categories.map(c => `<a class="chip" href="/shop?category=${c.slug}"${cat === c.slug ? ' aria-current="page"' : ''}>${esc(c.name)}</a>`).join('')}
      </nav>
      ${productGrid(products, theme.config.cards.style)}
    </div></section>`,
  };
}
