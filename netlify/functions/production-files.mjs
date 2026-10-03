// GET /api/production-files?po=<production order id>
// Signed, 1-hour links to a production order's print files. The database
// decides who may see them (the assigned partner's users, or fulfillment
// staff) by running the check as the caller; only then are links minted.
import { rpcAs, configured, DbError } from '../lib/supabase.mjs';
import { json, fail, rateLimited } from '../lib/http.mjs';
import { signedUrl } from '../lib/fulfillment.mjs';

export default async (req) => {
  if (req.method !== 'GET') return fail(405, 'Use GET');
  if (!configured()) return fail(500, 'Files are not configured (Supabase service key missing).');
  if (rateLimited(req, 'po-files', 60)) return fail(429, 'Too many requests. Wait a minute.');
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return fail(401, 'Sign in again.');
  const po = new URL(req.url).searchParams.get('po') || '';
  if (!/^[0-9a-f-]{36}$/.test(po)) return fail(400, 'Missing production order.');

  let files;
  try { files = await rpcAs(token, 'production_files_for', { p_po_id: po }); }
  catch (e) { return fail(e.status === 401 ? 401 : 403, e instanceof DbError ? e.message : 'Not allowed.'); }
  if (!files) return fail(404, 'Production order not found.');

  const allowed = new Set(['designs', 'production']);
  const out = [];
  for (const f of files) {
    if (!allowed.has(f.bucket) || !f.path || f.path.includes('..')) continue;
    out.push({ placement: f.placement, item_id: f.item_id, name: f.name, url: await signedUrl(f.bucket, f.path, 3600) });
  }
  return json(200, { files: out, expires_in: 3600 });
};
