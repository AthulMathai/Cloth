// Runs every 10 minutes (see netlify.toml):
//   * scheduled products/drops whose publish_at has passed go live
//   * sold-out limited drops move to the archive after their archive_delay
// Uses the service role, which never leaves the server.
export default async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response('Supabase service credentials missing', { status: 500 });
  const call = async (fn) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) throw new Error(`${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const published = await call('publish_due_products');
  const archived = await call('archive_due_drops');
  console.log(JSON.stringify({ published, archived }));
  return new Response(JSON.stringify({ published, archived }), { headers: { 'Content-Type': 'application/json' } });
};
