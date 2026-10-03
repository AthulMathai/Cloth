// POST /api/admin-refund { order_id, amount_cents, note, key }
// Staff refunds. The database decides who may refund (orders.refund) and how
// much is still refundable; the money goes back through the provider that
// took it; only then is the refund recorded. Same key = same refund.
import { rpc, rpcAs, configured, DbError } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited } from '../lib/http.mjs';
import { adapterFor } from '../lib/payments.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'Refunds are not configured (Supabase service key missing).');
  if (rateLimited(req, 'refund', 10)) return fail(429, 'Too many attempts. Wait a minute.');
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return fail(401, 'Sign in again.');

  let body;
  try { body = await readJson(req); } catch (e) { return fail(e.status || 400, e.message); }
  const orderId = String(body.order_id || ''), amount = Math.round(Number(body.amount_cents));
  const note = String(body.note || '').trim().slice(0, 500), key = String(body.key || '').slice(0, 80);
  if (!/^[0-9a-f-]{36}$/.test(orderId)) return fail(400, 'Missing order.');
  if (!Number.isFinite(amount) || amount <= 0) return fail(400, 'Enter a refund amount.');
  if (note.length < 3) return fail(400, 'Give a reason for the refund.');
  if (key.length < 16) return fail(400, 'Missing request key; reload and try again.');

  let check;
  try { check = await rpcAs(token, 'admin_refund_check', { p_order_id: orderId }); }
  catch (e) { return fail(e.status === 401 ? 401 : 403, e instanceof DbError ? e.message : 'Not allowed.'); }
  if (amount > check.refundable_cents) return fail(409, `Only ${(check.refundable_cents / 100).toFixed(2)} can still be refunded.`);

  let r;
  try {
    r = await adapterFor(check.provider).refund({ payment_ref: check.payment_ref, amount_cents: amount, order_id: orderId, idempotency: `refund-${key}` });
  } catch (e) {
    console.error('refund failed at provider', e);
    return fail(502, `The payment provider didn't refund: ${e.message}. Nothing was recorded.`);
  }
  try {
    const out = await rpc('record_refund', { p_order_id: orderId, p_provider: r.provider, p_ref: r.ref, p_amount_cents: r.amount_cents,
                                              p_actor: check.actor, p_note: note, p_raw: r.raw });
    return json(200, { ...out, test_mode: r.provider === 'mock' });
  } catch (e) {
    // Money went back but bookkeeping failed: say so loudly so staff can reconcile.
    console.error('refund recorded at provider but not in DB', r, e);
    return fail(500, `Refunded at ${r.provider} (ref ${r.ref}) but saving it failed. Note this reference and contact support.`);
  }
};
