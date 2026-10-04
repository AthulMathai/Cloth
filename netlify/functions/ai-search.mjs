// GET /api/ai-search?q=...  Meaning-based product search.
// The query is turned into an embedding and matched against the product
// index together with ordinary keywords (search_products_smart). If the AI
// provider is unavailable it quietly falls back to keywords only.
import { rpc, configured } from '../lib/supabase.mjs';
import { json, fail, rateLimited } from '../lib/http.mjs';
import { embed, toVectorLiteral, isTestMode } from '../lib/ai.mjs';

const cache = new Map();   // per-instance: query -> vector literal

export default async (req) => {
  if (req.method !== 'GET') return fail(405, 'Use GET');
  if (!configured()) return fail(500, 'Search is not configured.');
  if (rateLimited(req, 'ai-search', 40)) return fail(429, 'Too many searches. Wait a moment.');
  const q = (new URL(req.url).searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 2) return json(200, { results: [], semantic: false });

  let vec = cache.get(q.toLowerCase()), semantic = true;
  if (!vec) {
    try {
      [vec] = (await embed([q])).map(toVectorLiteral);
      if (cache.size > 500) cache.clear();
      cache.set(q.toLowerCase(), vec);
    } catch (e) { console.warn('ai-search embed failed, keywords only', e.message); vec = null; semantic = false; }
  }
  const results = await rpc('search_products_smart', { p_q: q, p_embedding: vec, p_limit: 40 });
  return json(200, { results, semantic, test_mode: isTestMode() }, { 'Cache-Control': 'public, max-age=60' });
};
