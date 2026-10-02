// /orders/:number — confirmation and tracking.
// /orders          — signed-in customer's order history.
import { auth, db } from '../lib/supabase.js';
import { themeForPage, money, pad3 } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';

// Customer-facing milestones, in order. Each lights up once the order has
// reached it (read from the append-only event history).
const STEPS = [
  ['placed', 'Order received', ['payment_pending', 'paid']],
  ['paid', 'Payment confirmed', ['paid']],
  ['approved', 'Design approved', ['approved'], 'custom'],
  ['assigned', 'Production partner assigned', ['assigned']],
  ['printing', 'Production started', ['production_queued', 'printing']],
  ['printed', 'Printing completed', ['quality_check']],
  ['packed', 'Packed', ['packed']],
  ['shipped', 'Shipped', ['shipped']],
  ['transit', 'In transit', ['in_transit', 'out_for_delivery']],
  ['delivered', 'Delivered', ['delivered']],
];
const LABEL = {
  payment_pending: 'Waiting for payment', paid: 'Paid', moderation_pending: 'Design in review', approved: 'Approved',
  fulfillment_pending: 'Preparing for production', assigned: 'With a production partner', production_queued: 'Queued for printing',
  printing: 'Printing', quality_check: 'Quality check', packed: 'Packed', shipped: 'Shipped', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
  failed: 'Payment failed', on_hold: 'On hold — we\'ll be in touch', backordered: 'Backordered', returned: 'Returned',
};

export async function load({ number }, query) {
  const theme = await themeForPage('account');
  if (!number) return listOrders(theme);

  const token = query.get('t') || sessionStorage.getItem(`th8rty.order.${number}`) || null;
  const o = await db.rpc('order_lookup', { p_number: number, p_token: token }).catch(() => null);
  if (!o) {
    return { theme, title: 'Order', html: `<section class="state"><h1>Order not found</h1>
      <p class="lede">Open the link from your confirmation email, or <a href="/account/sign-in">sign in</a> to see your orders.</p></section>` };
  }
  if (token) try { sessionStorage.setItem(`th8rty.order.${o.number}`, token); } catch {}

  const reached = new Set(o.events.map(e => e.status));
  const custom = false; // custom designs arrive in Phase 3
  const steps = STEPS.filter(s => s[3] !== 'custom' || custom);
  const lastIdx = steps.reduce((acc, s, i) => s[2].some(st => reached.has(st)) ? i : acc, -1);
  const stopped = ['cancelled', 'failed', 'refunded', 'returned', 'on_hold'].includes(o.status);
  const a = o.shipping_address || {};

  return {
    theme, title: `Order ${o.number}`,
    html: `<section class="section commerce"><div class="wrap">
      ${query.get('paid') ? `<p class="confirm-flash" role="status">Thank you — your order is confirmed. Bookmark this page: it's where you'll follow your order from printing to your door.</p>` : ''}
      <div class="order-head">
        <h1 class="h-section">Order ${esc(o.number)}</h1>
        <span class="status-pill${stopped ? ' is-stopped' : ''}">${esc(LABEL[o.status] || o.status)}</span>
      </div>
      <div class="checkout-layout">
        <div class="panel-box">
          <h2 class="sub-head">Progress</h2>
          <ol class="timeline">${steps.map((s, i) => {
            const at = o.events.find(e => s[2].includes(e.status))?.at;
            return `<li class="${i <= lastIdx && !stopped ? 'is-done' : ''}"><span class="tl-dot" aria-hidden="true"></span>
              <span>${s[1]}</span>${at && i <= lastIdx ? `<time datetime="${at}">${new Date(at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>` : ''}</li>`;
          }).join('')}</ol>
          <h2 class="sub-head">Items</h2>
          <ul class="bag-lines">${o.items.map(i => `<li class="bag-line bag-line--static">
            <span class="bag-thumb">${garmentSVG({ type: i.product_type, color: i.color_hex, mode: 'flat', label: i.name })}</span>
            <div class="bag-info"><span class="bag-name">${esc(i.name)}</span>
              <span class="muted">${esc(i.color || '')} / ${esc(i.size || '')} · Qty ${i.quantity}</span>
              ${i.edition_numbers?.length ? `<span class="edition-tag">Edition ${i.edition_numbers.map(n => `No. ${pad3(n)} / ${i.edition_size}`).join(', ')}</span>` : ''}
            </div><span class="bag-price">${money(i.line_total_cents)}</span></li>`).join('')}</ul>
        </div>
        <aside class="receipt">
          <h2 class="receipt-title">Receipt</h2>
          <dl class="receipt-lines">
            <dt>Subtotal</dt><dd>${money(o.subtotal_cents)}</dd>
            ${o.discount_cents > 0 ? `<dt>${esc(o.discount_code || 'Discount')}</dt><dd>−${money(o.discount_cents)}</dd>` : ''}
            <dt>${esc(o.shipping_rate?.label || 'Shipping')}</dt><dd>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</dd>
            ${(o.tax_lines || []).map(t => `<dt>${esc(t.label)}</dt><dd>${money(t.amount_cents)}</dd>`).join('')}
            <dt class="receipt-total">Total</dt><dd class="receipt-total">${money(o.total_cents)} <span class="muted small">CAD</span></dd>
          </dl>
          <h3 class="sub-head">Shipping to</h3>
          <address>${esc(a.full_name)}<br>${esc(a.line1)}${a.line2 ? '<br>' + esc(a.line2) : ''}<br>${esc(a.city)}, ${esc(a.province)} ${esc(a.postal_code)}</address>
          ${o.shipping_rate ? `<p class="muted small">Estimated ${o.shipping_rate.min_days}–${o.shipping_rate.max_days} business days after it ships. Tracking appears here once it's on its way.</p>` : ''}
          ${o.payment_provider === 'mock' ? '<p class="test-flag small">Paid with the development test provider — no real charge.</p>' : ''}
        </aside>
      </div>
    </div></section>`,
  };
}

async function listOrders(theme) {
  if (!auth.user) {
    return { theme, title: 'Orders', html: `<section class="state"><h1>Your orders</h1>
      <p class="lede">Sign in to see your order history, or use the link in your confirmation email.</p>
      <p><a class="btn" href="/account/sign-in">Sign in</a></p></section>` };
  }
  const orders = await db.from('orders').select('number,status,total_cents,created_at').neq('status', 'payment_pending').order('created_at', { ascending: false }).limit(50);
  return {
    theme, title: 'Your orders',
    html: `<section class="section commerce"><div class="wrap" style="max-width:820px">
      <h1 class="h-section">Your orders</h1>
      ${orders.length ? `<ul class="order-list panel-box">${orders.map(o => `<li><a href="/orders/${esc(o.number)}">
        <strong>${esc(o.number)}</strong><span class="muted">${new Date(o.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
        <span>${esc(LABEL[o.status] || o.status)}</span><span>${money(o.total_cents)}</span></a></li>`).join('')}</ul>`
        : '<p class="lede">No orders yet. <a href="/shop">Find something you like</a>.</p>'}
    </div></section>`,
  };
}
