// /checkout/pay/:number — DEVELOPMENT payment page for the mock provider.
// It says plainly that it's a test; in production customers are sent to the
// real provider's hosted payment page instead.
import { db } from '../lib/supabase.js';
import { themeForPage, money } from '../lib/store.js';
import { esc } from '../components/ui.js';
import { resetLocalBag } from '../lib/cart.js';

export async function load({ number }, query) {
  const theme = await themeForPage('account');
  const token = query.get('t') || sessionStorage.getItem(`th8rty.order.${number}`) || '';
  const o = await db.rpc('order_lookup', { p_number: number, p_token: token }).catch(() => null);
  if (!o) return (await import('./not-found.js')).load();
  if (o.status !== 'payment_pending') {
    return (await import('./order.js')).load({ number }, query);
  }
  return {
    theme, title: 'Test payment',
    html: `<section class="section commerce"><div class="wrap" style="max-width:620px">
      <div class="panel-box test-pay">
        <p class="test-flag" role="note">Test payment — development mode. No card is charged and no money moves.</p>
        <h1 class="h-section" style="font-size:44px">Order ${esc(o.number)}</h1>
        <p class="lede">Total ${money(o.total_cents)} CAD for ${o.items.reduce((n, i) => n + i.quantity, 0)} item(s).
          Items are held until ${new Date(o.reserved_until).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}.</p>
        <p class="hero-actions" style="justify-content:flex-start">
          <button class="btn" data-outcome="succeed">Pay ${money(o.total_cents)} (test)</button>
          <button class="btn btn--quiet" data-outcome="decline">Decline payment (test)</button>
        </p>
        <p class="form-msg" role="status" data-msg></p>
        <p class="muted small">When a real provider is connected (PAYMENT_PROVIDER=stripe), this step is replaced by the provider's secure payment page.</p>
      </div>
    </div></section>`,
    mount(root) {
      root.querySelectorAll('[data-outcome]').forEach(b => b.onclick = async () => {
        root.querySelectorAll('[data-outcome]').forEach(x => x.disabled = true);
        const msg = root.querySelector('[data-msg]');
        msg.textContent = 'Processing test payment…';
        try {
          const res = await fetch('/api/mock-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number, token, outcome: b.dataset.outcome }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Payment failed');
          if (data.status === 'failed') {
            msg.textContent = 'Payment declined. Nothing was charged and your items were released. Your bag is unchanged.';
            setTimeout(() => import('../app.js').then(m => m.go('/cart')), 1600);
            return;
          }
          resetLocalBag();
          (await import('../app.js')).go(`/orders/${encodeURIComponent(number)}?t=${encodeURIComponent(token)}&paid=1`);
        } catch (e) {
          msg.textContent = e.message;
          root.querySelectorAll('[data-outcome]').forEach(x => x.disabled = false);
        }
      });
    },
  };
}
