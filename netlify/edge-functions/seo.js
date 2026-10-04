// Edge function: gives every public page real <title>, description,
// canonical URL, social-preview tags (Open Graph / Twitter) and Google
// structured data in the HTML itself — so search engines and link previews
// (iMessage, WhatsApp, Instagram, Slack…) see the product, not an empty app
// shell. The browser app still renders the page as before.
//
// Reads only public storefront data with the public (anon) key. If the
// database is slow or down, the page is served unchanged.

const STATIC = {
  '/': { title: null, description: null },
  '/shop': { title: 'Shop', description: 'Every piece in the store — hoodies, tees, crewnecks and more, drawn by hand and printed to order in Canada.' },
  '/drops': { title: 'Limited drops', description: 'Numbered limited-edition drops. When they sell out, they move to the archive for good.' },
  '/archive': { title: 'Limited edition archive', description: 'Every limited drop we have released: edition sizes, stories and the pieces that sold out.' },
  '/custom': { title: 'Custom designer', description: 'Design your own hoodie or tee: upload artwork or describe it for AI, place it, see the price live, and order.' },
  '/search': { title: 'Search', description: null },
};
const PRIVATE = /^\/(cart|checkout|account|orders|wishlist|support|designs|custom\/[0-9a-f-]{36})(\/|$)/;

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const res = await context.next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const site = (Netlify.env.get('SITE_URL') || Netlify.env.get('URL') || url.origin).replace(/\/$/, '');

  let meta, status = res.status;
  try {
    meta = await Promise.race([pageMeta(path, url), new Promise((r) => setTimeout(() => r(null), 1500))]);
  } catch (e) { console.error('seo', path, e.message); meta = null; }
  if (meta === undefined) return res;                       // not a page we describe
  const store = meta?.store || 'TH8RTY';
  if (meta?.notFound) status = 404;
  const m = meta && !meta.notFound ? meta : { title: meta?.notFound ? 'Not found' : null, description: null, noindex: !!meta?.notFound };
  const title = m.title ? `${m.title} · ${store}` : `${store} — ${m.tagline || 'Wear your idea.'}`;
  const desc = (m.description || 'Clothing drawn by hand first. Shop limited drops, explore the archive, or design your own.').replace(/\s+/g, ' ').slice(0, 300);
  const canonical = site + (path === '/' ? '/' : path);
  const image = absolute(m.image, site) || `${site}/og/default.jpg`;
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    m.noindex || PRIVATE.test(path) ? '<meta name="robots" content="noindex, follow">' : '',
    `<meta property="og:site_name" content="${esc(store)}">`,
    `<meta property="og:type" content="${m.ogType || 'website'}">`,
    `<meta property="og:title" content="${esc(m.title || store)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    image.endsWith('/og/default.jpg') ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : '',
    `<meta property="og:locale" content="en_CA">`,
    m.price != null ? `<meta property="product:price:amount" content="${(m.price / 100).toFixed(2)}"><meta property="product:price:currency" content="CAD">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
    ...(m.jsonld || []).map(j => `<script type="application/ld+json" data-seo>${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`),
  ].filter(Boolean).join('\n  ');
  const html = (await res.text()).replace(/<!--seo-->[\s\S]*?<!--\/seo-->/, `<!--seo-->\n  ${head}\n  <!--/seo-->`);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('Netlify-CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return new Response(html, { status, headers });

  async function pageMeta(path, url) {
    const db = rest();
    const settings = await db('store_settings?select=key,value&key=in.(store.name,store.tagline)').catch(() => []);
    const S = Object.fromEntries(settings.map(r => [r.key, r.value]));
    const store = S['store.name'] || 'TH8RTY';
    const base = { store, tagline: S['store.tagline'] };
    let mm;
    if (path === '/') {
      return { ...base, jsonld: [
        { '@context': 'https://schema.org', '@type': 'Organization', name: store, url: site, logo: `${site}/og/default.jpg` },
        { '@context': 'https://schema.org', '@type': 'WebSite', name: store, url: site,
          potentialAction: { '@type': 'SearchAction', target: `${site}/search?q={search_term_string}`, 'query-input': 'required name=search_term_string' } }] };
    }
    if (PRIVATE.test(path)) return { ...base, noindex: true };
    if ((mm = path.match(/^\/legal\/(privacy|returns|shipping|terms)$/))) {
      const [row] = await db(`store_settings?key=eq.legal.${mm[1]}&select=value`);
      return row ? { ...base, title: row.value.title, description: `${row.value.title} — ${store}.` } : { ...base, notFound: true };
    }
    if (STATIC[path]) return { ...base, ...STATIC[path], noindex: path === '/search' };
    if ((mm = path.match(/^\/product\/([a-z0-9-]+)$/))) {
      const [p] = await db(`storefront_products?slug=eq.${mm[1]}&select=id,slug,name,description,product_type,price_cents,base_price_cents,status,is_purchasable,stock_available,media,colors,category_name,category_slug,collection_name,collection_slug,designer_name,drop_number,drop_slug,units_remaining,seo,release_at,promo_ends_at&status=neq.draft`);
      if (!p) return { ...base, notFound: true };
      const avail = p.status === 'archived' || p.status === 'discontinued' ? 'Discontinued'
        : p.drop_number && p.units_remaining === 0 ? 'SoldOut'
        : p.status === 'scheduled' || (p.release_at && new Date(p.release_at) > Date.now()) ? 'PreOrder'
        : p.is_purchasable && p.stock_available > 0 ? 'InStock' : 'OutOfStock';
      const img = p.media?.find(x => x.kind !== 'video')?.url;
      return { ...base, title: p.seo?.title || p.name, description: p.seo?.description || p.description, image: img, ogType: 'product', price: p.price_cents,
        jsonld: [{ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.description || undefined, image: img ? [absolute(img, site)] : undefined,
          sku: p.slug, brand: { '@type': 'Brand', name: store }, category: p.category_name || undefined,
          color: p.colors?.map(c => c.color).join(', ') || undefined,
          offers: { '@type': 'Offer', url: `${site}/product/${p.slug}`, priceCurrency: 'CAD', price: (p.price_cents / 100).toFixed(2),
            availability: `https://schema.org/${avail}`, itemCondition: 'https://schema.org/NewCondition',
            ...(p.promo_ends_at ? { priceValidUntil: p.promo_ends_at.slice(0, 10) } : {}) } },
          crumbs([['Shop', '/shop'], ...(p.category_slug ? [[p.category_name, `/category/${p.category_slug}`]] : []), [p.name, `/product/${p.slug}`]])] };
    }
    if ((mm = path.match(/^\/(category|collections)\/([a-z0-9-]+)$/))) {
      const table = mm[1] === 'category' ? 'categories' : 'collections';
      const [c] = await db(`${table}?slug=eq.${mm[2]}&is_visible=eq.true&select=name,description,${mm[1] === 'category' ? 'tagline,' : ''}hero_image,seo`);
      if (!c) return { ...base, notFound: true };
      return { ...base, title: c.seo?.title || c.name, description: c.seo?.description || c.tagline || c.description, image: c.hero_image,
        jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: c.name, description: c.description || undefined, url: site + path },
          crumbs([['Shop', '/shop'], [c.name, path]])] };
    }
    if ((mm = path.match(/^\/archive\/([a-z0-9-]+)$/))) {
      const [d] = await db(`limited_drops?slug=eq.${mm[1]}&select=drop_name,drop_number,edition_size,units_sold,story,release_at,products(name,description,seo)`);
      if (!d) return { ...base, notFound: true };
      const n = String(d.drop_number).padStart(3, '0');
      return { ...base, title: `${d.drop_name} — Drop ${n}`, description: d.story || d.products?.description || `Limited drop ${n}: ${d.edition_size} numbered pieces.`,
        jsonld: [crumbs([['Archive', '/archive'], [`${d.drop_name} — Drop ${n}`, path]])] };
    }
    return undefined;
  }

  function crumbs(items) {
    return { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: items.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + href })) };
  }
};

function rest() {
  const base = Netlify.env.get('SUPABASE_URL'), key = Netlify.env.get('SUPABASE_ANON_KEY');
  if (!base || !key) throw new Error('Supabase not configured');
  return async (q) => {
    const r = await fetch(`${base}/rest/v1/${q}`, { headers: { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) } });
    if (!r.ok) throw new Error(`REST ${r.status}`);
    return r.json();
  };
}
const absolute = (u, site) => !u ? null : /^https?:\/\//.test(u) ? u : `${site}${u.startsWith('/') ? '' : '/'}${u}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*', '/admin', '/admin/*', '/partner', '/partner/*', '/js/*', '/css/*', '/vendor/*', '/assets/*', '/og/*',
    '/sitemap.xml', '/robots.txt', '/favicon.ico'],
};
