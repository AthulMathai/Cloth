// POST /api/payments-webhook   (Stripe)
// Signature-verified, idempotent: each provider event is recorded once in
// webhook_events; confirm_order_payment is itself idempotent per payment.
import { rpc, rest, configured } from '../lib/supabase.mjs';
import { json, fail } from '../lib/http.mjs';
import { verifyStripeSignature } from '../lib/payments.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Use POST');
  if (!configured()) return fail(500, 'not configured');
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
    return fail(400, 'invalid signature');
  }
  const event = JSON.parse(raw);

  const inserted = await rest('webhook_events?on_conflict=provider,event_id', {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: { provider: 'stripe', event_id: event.id, event_type: event.type, payload: event },
  });
  if (!inserted?.length) return json(200, { received: true, duplicate: true });

  let error = null;
  try {
    const s = event.data?.object || {};
    const orderId = s.metadata?.order_id;
    if (event.type === 'checkout.session.completed' && s.payment_status === 'paid' && orderId) {
      await rpc('confirm_order_payment', {
        p_order_id: orderId, p_provider: 'stripe', p_provider_ref: s.payment_intent || s.id,
        p_amount_cents: s.amount_total, p_raw: { session: s.id, customer_email: s.customer_details?.email },
      });
    } else if (event.type === 'checkout.session.expired' && orderId) {
      await rpc('release_order', { p_order_id: orderId, p_status: 'cancelled', p_note: 'Stripe checkout session expired.' });
    }
  } catch (e) {
    error = e.message;
    console.error('webhook processing failed', event.id, e);
  }
  await rest(`webhook_events?provider=eq.stripe&event_id=eq.${encodeURIComponent(event.id)}`, {
    method: 'PATCH', body: { processed_at: error ? null : new Date().toISOString(), error },
  }).catch(() => {});
  // 500 makes Stripe retry; the stored event lets a retry re-run processing.
  if (error) {
    await rest(`webhook_events?provider=eq.stripe&event_id=eq.${encodeURIComponent(event.id)}`, { method: 'DELETE' }).catch(() => {});
    return fail(500, 'processing failed, will retry');
  }
  return json(200, { received: true });
};
