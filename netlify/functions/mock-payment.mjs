// POST /api/mock-payment   { number, token, outcome: "succeed" | "decline" }
// DEVELOPMENT ONLY: simulates the payment provider's callback so the full
// order flow can be tested without real money. Disabled unless
// PAYMENT_PROVIDER=mock and INTEGRATIONS_MODE is not "live".
import { rpc, configured } from '../lib/supabase.mjs';
import { json, fail, readJson, rateLimited } from '../lib/http.mjs';
import { providerName } from '../lib/payments.mjs';
import crypto from 'node:crypto';

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (providerName() !== 'mock' || process.env.INTEGRATIONS_MODE === 'live') return fail(404, 'Not found');
  if (!configured()) return fail(500, 'Supabase service key missing.');
  if (rateLimited(req, 'mockpay', 20)) return fail(429, 'Too many attempts.');

  let body;
  try { body = await readJson(req, 2048); } catch (e) { return fail(400, e.message); }
  const order = await rpc('order_lookup', { p_number: String(body.number || ''), p_token: String(body.token || '') });
  if (!order) return fail(404, 'Order not found.');
  if (order.status !== 'payment_pending') return json(200, { number: order.number, status: order.status, already: true });

  if (body.outcome === 'decline') {
    await rpc('release_order', { p_order_id: order.id, p_status: 'failed', p_note: 'Test payment declined (mock provider).' });
    return json(200, { number: order.number, status: 'failed' });
  }
  const result = await rpc('confirm_order_payment', {
    p_order_id: order.id, p_provider: 'mock', p_provider_ref: 'mock_' + crypto.randomUUID(),
    p_amount_cents: order.total_cents, p_raw: { note: 'development mock payment — no money moved' },
  });
  return json(200, { number: order.number, status: result.status });
};
