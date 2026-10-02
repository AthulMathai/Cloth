// /category/:slug — the whole page wears the category's theme.
import { db } from '../lib/supabase.js';
import { categoryBySlug, themeForCategory } from '../lib/store.js';
import { categoryHero, productGrid, dropCard, startCountdowns, esc } from '../components/ui.js';

export async function load({ slug }) {
  const cat = await categoryBySlug(slug);
  if (!cat) return (await import('./not-found.js')).load();
  const theme = await themeForCategory(cat);
  const [products, collections] = await Promise.all([
    db.from('storefront_products').select('*').eq('category_id', cat.id).in('status', ['active', 'out_of_stock', 'scheduled', 'sold_out']).order('is_featured', { ascending: false }).order('created_at', { ascending: false }),
    db.from('collections').select('slug,name,description').eq('category_id', cat.id).order('sort_order'),
  ]);
  const drops = products.filter(p => p.is_limited);
  const regular = products.filter(p => !p.is_limited);

  const html = `
    ${categoryHero(cat, theme.config, collections.length ? `<div class="chips" style="margin-top:12px">${collections.map(c => `<a class="chip" href="/collections/${c.slug}">${esc(c.name)}</a>`).join('')}</div>` : '')}
    ${drops.length ? `<section class="section panel" style="padding-top:0;background:transparent"><div class="wrap">
      <div class="section-head"><h2 class="h-section">Limited</h2></div>
      <div class="drops">${drops.map(dropCard).join('')}</div></div></section>` : ''}
    <section class="section" style="padding-top:${drops.length ? '0' : '24px'}"><div class="wrap">
      <div class="section-head"><h2 class="h-section">The ${esc(cat.name)} line</h2><span class="muted">${regular.length} pieces</span></div>
      ${productGrid(regular, theme.config.cards.style)}
    </div></section>`;

  return {
    theme, html, title: cat.seo?.title || cat.name, description: cat.seo?.description || cat.description,
    entity: { type: 'category', id: cat.id },
    mount: (root) => startCountdowns(root),
  };
}
