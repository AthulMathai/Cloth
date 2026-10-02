// Payment provider adapters. The rest of the system only knows:
//   createPayment(order, ctx) -> { redirect_url, provider, provider_session }
// Switch providers with PAYMENT_PROVIDER (mock | stripe).
//
// MOCK is a development adapter: no money moves, and the payment page says
// so in plain words. Never run it with INTEGRATIONS_MODE=live.
import crypto from 'node:crypto';

export function providerName() {
  return (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
}

const adapters = {
  mock: {
    async createPayment(order, { origin }) {
      return {
        provider: 'mock',
        redirect_url: `${origin}/checkout/pay/${encodeURIComponent(order.number)}?t=${encodeURIComponent(order.access_token)}`,
      };
    },
  },

  // Stripe Checkout via the REST API (no SDK needed). Card data never touches
  // our servers: the customer pays on Stripe's hosted page.
  stripe: {
    async createPayment(order, { origin }) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
      const form = new URLSearchParams({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'cad',
        'line_items[0][price_data][unit_amount]': String(order.total_cents),
        'line_items[0][price_data][product_data][name]': `Order ${order.number}`,
        'line_items[0][price_data][product_data][description]': 'Includes shipping and taxes',
        customer_email: order.email,
        client_reference_id: order.order_id,
        'metadata[order_id]': order.order_id,
        'metadata[order_number]': order.number,
        'payment_intent_data[metadata][order_id]': order.order_id,
        success_url: `${origin}/orders/${encodeURIComponent(order.number)}?t=${encodeURIComponent(order.access_token)}&paid=1`,
        cancel_url: `${origin}/checkout?cancelled=${encodeURIComponent(order.number)}`,
        expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60 + 60),
      });
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded',
                   'Idempotency-Key': `order-${order.order_id}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Stripe: ${data?.error?.message || res.status}`);
      return { provider: 'stripe', redirect_url: data.url, provider_session: data.id };
    },
  },
};

export function getAdapter() {
  const a = adapters[providerName()];
  if (!a) throw new Error(`Unknown PAYMENT_PROVIDER "${providerName()}"`);
  return a;
}

/** Verifies a Stripe-Signature header (v1 scheme, 5-minute tolerance). */
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
