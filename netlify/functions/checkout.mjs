// POST /api/checkout
// Creates an order from the customer's bag (prices recomputed in the
// database), holds stock, and returns where to pay.
import { rpc, getUser, configured, DbError } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited, siteOrigin } from '../lib/http.mjs';
import { getAdapter, providerName } from '../lib/payments.mjs';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'Checkout is not configured (Supabase service key missing).');
  if (rateLimited(req, 'checkout', 10)) return fail(429, 'Too many attempts. Wait a minute and try again.');

  let body;
  try { body = await readJson(req); } catch (e) { return fail(e.status || 400, e.message); }

  const user = await getUser(req);
  const a = body.address || {};
  const address = {
    full_name: str(a.full_name, 120), line1: str(a.line1, 200), line2: str(a.line2, 200),
    city: str(a.city, 100), province: str(a.province, 2).toUpperCase(),
    postal_code: str(a.postal_code, 7).toUpperCase(), country: 'CA', phone: str(body.phone, 40),
  };
  const idem = str(body.idempotency_key, 80);
  if (idem.length < 16) return fail(400, 'Missing checkout key; reload the page and try again.');

  let order;
  try {
    order = await rpc('create_order', {
      p_cart_token: str(body.cart_token, 128) || null,
      p_user_id: user?.id || null,
      p_email: str(body.email, 254) || user?.email || '',
      p_phone: address.phone || null,
      p_address: address,
      p_rate_code: str(body.rate_code, 40) || null,
      p_discount_code: str(body.discount_code, 32) || null,
      p_idempotency_key: idem,
    });
  } catch (e) {
    if (e instanceof DbError && e.isUserFacing) return fail(409, e.message);
    console.error('create_order failed', e);
    return fail(500, 'We couldn\'t place your order. Nothing was charged. Please try again.');
  }

  if (order.duplicate) {
    // Same checkout submitted twice (double click / retry): don't create another payment.
    return json(200, { number: order.number, duplicate: true, status: order.status });
  }

  try {
    const pay = await getAdapter().createPayment({ ...order, email: str(body.email, 254) || user?.email }, { origin: siteOrigin(req) });
    return json(200, { number: order.number, total_cents: order.total_cents, access_token: order.access_token,
                       redirect_url: pay.redirect_url, provider: pay.provider, test_mode: providerName() === 'mock' });
  } catch (e) {
    // Order exists with stock held; release it so items aren't stuck.
    console.error('payment start failed', e);
    await rpc('release_order', { p_order_id: order.order_id, p_status: 'failed', p_note: 'Payment could not be started: ' + e.message }).catch(() => {});
    return fail(502, 'The payment service didn\'t respond. Nothing was charged. Please try again.');
  }
};
