// GET /sitemap.xml — every public page search engines should know about:
// store pages, categories, collections, products and archived drops.
import { rest, configured } from '../lib/supabase.mjs';

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export default async (req) => {
  const site = (process.env.SITE_URL || process.env.URL || new URL(req.url).origin).replace(/\/$/, '');
  const urls = [['/', null, '1.0'], ['/shop', null, '0.9'], ['/drops', null, '0.8'], ['/custom', null, '0.8'], ['/archive', null, '0.6'],
    ...['shipping', 'returns', 'privacy', 'terms'].map(k => [`/legal/${k}`, null, '0.3'])];
  if (configured()) {
    const [cats, cols, prods, drops] = await Promise.all([
      rest('categories?is_visible=eq.true&select=slug,updated_at'),
      rest('collections?is_visible=eq.true&select=slug,updated_at'),
      rest("products?status=in.(active,out_of_stock,scheduled)&select=slug,updated_at"),
      rest('limited_drops?archived_at=not.is.null&select=slug,updated_at'),
    ]);
    urls.push(...cats.map(c => [`/category/${c.slug}`, c.updated_at, '0.8']), ...cols.map(c => [`/collections/${c.slug}`, c.updated_at, '0.7']),
      ...prods.map(p => [`/product/${p.slug}`, p.updated_at, '0.7']), ...drops.map(d => [`/archive/${d.slug}`, d.updated_at, '0.5']));
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, mod, pri]) => `  <url><loc>${xmlEsc(site + path)}</loc>${mod ? `<lastmod>${mod.slice(0, 10)}</lastmod>` : ''}<priority>${pri}</priority></url>`).join('\n')}
</urlset>`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
};
