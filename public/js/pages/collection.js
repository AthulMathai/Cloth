// /collections/:slug — wears the collection's own theme if set, else its category's.
import { db } from '../lib/supabase.js';
import { categoryById, themeForCategory, themeForSlug, loadBoot } from '../lib/store.js';
import { categoryHero, productGrid } from '../components/ui.js';

export async function load({ slug }) {
  const coll = await db.from('collections').select('*').eq('slug', slug).single().catch(() => null);
  if (!coll) return (await import('./not-found.js')).load();
  const cat = await categoryById(coll.category_id);
  let theme;
  if (coll.theme_id) {
    const b = await loadBoot();
    theme = await themeForSlug(b.themeIdToSlug.get(coll.theme_id), coll.theme_overrides);
  } else theme = await themeForCategory(cat ? { ...cat, theme_overrides: { ...cat.theme_overrides, ...coll.theme_overrides } } : null);

  const products = await db.from('storefront_products').select('*').eq('collection_id', coll.id).neq('status', 'archived').order('created_at', { ascending: false });
  return {
    theme, title: coll.seo?.title || coll.name, description: coll.seo?.description || coll.description,
    entity: { type: 'collection', id: coll.id },
    html: `${categoryHero({ name: coll.name, tagline: cat?.name || '', description: coll.description }, theme.config)}
      <section class="section" style="padding-top:24px"><div class="wrap">${productGrid(products, theme.config.cards.style)}</div></section>`,
  };
}
