// Hourly (see netlify.toml): keeps the product meaning index fresh.
// Only products that are new, changed, or were indexed by a different model
// are embedded, in small batches, so the free AI allowance is barely touched.
import { rpc, configured } from '../lib/supabase.mjs';
import { embed, models, toVectorLiteral } from '../lib/ai.mjs';

export default async () => {
  if (!configured()) return new Response('Supabase service credentials missing', { status: 500 });
  const model = models().embed;
  let total = 0;
  for (let round = 0; round < 5; round++) {
    const todo = await rpc('ai_products_to_embed', { p_limit: 25, p_model: model });
    if (!todo.length) break;
    let vectors;
    try { vectors = await embed(todo.map(t => t.text)); }
    catch (e) { console.error('embedding failed', e.message, e.detail || ''); break; }
    total += await rpc('ai_save_embeddings', {
      p_rows: todo.map((t, i) => ({ id: t.id, hash: t.hash, embedding: toVectorLiteral(vectors[i]) })), p_model: model });
  }
  console.log(JSON.stringify({ embedded: total, model }));
  return new Response(JSON.stringify({ embedded: total, model }), { headers: { 'Content-Type': 'application/json' } });
};
