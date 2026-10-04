// Runs every 10 minutes (see netlify.toml):
//   * scheduled products/drops whose publish_at has passed go live
//   * sold-out limited drops move to the archive after their archive_delay
//   * unpaid checkouts past their hold time release their stock
//   * analytics: refresh the daily event rollup for today and yesterday
// Uses the service role, which never leaves the server.
export default async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response('Supabase service credentials missing', { status: 500 });
  const call = async (fn) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) throw new Error(`${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const published = await call('publish_due_products');
  const archived = await call('archive_due_drops');
  const expired = await call('expire_pending_orders');   // release stock from abandoned checkouts
  let rolled = null;
  try { rolled = await call('analytics_rollup'); } catch (e) { console.error('analytics rollup failed', e); }   // daily event counts (today + yesterday)
  console.log(JSON.stringify({ published, archived, expired, rolled }));
  return new Response(JSON.stringify({ published, archived, expired }), { headers: { 'Content-Type': 'application/json' } });
};
