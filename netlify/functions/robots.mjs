// GET /robots.txt — let search engines index the store, keep them out of
// private areas, and point them at the sitemap.
export default async (req) => {
  const site = (process.env.SITE_URL || process.env.URL || new URL(req.url).origin).replace(/\/$/, '');
  const live = process.env.INTEGRATIONS_MODE === 'live';
  const body = live ? `User-agent: *
Disallow: /admin
Disallow: /partner
Disallow: /api/
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /wishlist
Disallow: /designs
Disallow: /support

Sitemap: ${site}/sitemap.xml
` : `# Development build (INTEGRATIONS_MODE is not "live"): keep test data out of search engines.
User-agent: *
Disallow: /
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
};
