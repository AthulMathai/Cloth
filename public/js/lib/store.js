// Shared, cached catalog lookups (settings, themes, categories) and
// formatting helpers used across pages.
import { db } from './supabase.js';
import { resolveTheme } from './theme.js';

let boot = null;

export function loadBoot() {
  boot ||= Promise.all([
    db.from('store_settings').select('key,value'),
    db.from('themes').select('id,slug,name,config'),
    db.from('categories').select('id,slug,name,tagline,description,theme_id,theme_overrides,sort_order,seo').order('sort_order'),
  ]).then(([settings, themes, categories]) => {
    const s = Object.fromEntries(settings.map(r => [r.key, r.value]));
    const byId = new Map(), bySlug = new Map();
    for (const t of themes) { bySlug.set(t.slug, t); byId.set(t.id, t.slug); }
    return { settings: s, themes: bySlug, categories, themeIdToSlug: byId };
  }).catch(e => { boot = null; throw e; });
  return boot;
}

export async function themeForSlug(slug, overrides) {
  const b = await loadBoot();
  const t = b.themes.get(slug);
  return { slug: t ? slug : 'default', config: resolveTheme(t?.config, overrides) };
}

export async function themeForPage(page) {
  const b = await loadBoot();
  const slug = b.settings['pages.themes']?.[page] || b.settings['home.theme'] || 'th8rty';
  return themeForSlug(slug);
}

export async function themeForCategory(cat) {
  const b = await loadBoot();
  const slug = cat?.theme_id && b.themeIdToSlug.get(cat.theme_id);
  return slug ? themeForSlug(slug, cat.theme_overrides) : themeForPage('shop');
}

export async function categoryBySlug(slug) {
  const b = await loadBoot();
  return b.categories.find(c => c.slug === slug) || null;
}
export async function categoryById(id) {
  const b = await loadBoot();
  return b.categories.find(c => c.id === id) || null;
}

const fmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export const money = (cents) => fmt.format((cents || 0) / 100);
export const pad3 = (n) => String(n).padStart(3, '0');
export const fmtDate = (d) => new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
