// /checkout — contact, shipping address, shipping method, discount, live
// totals from the database, then hand-off to the payment provider.
import { auth, db } from '../lib/supabase.js';
import { themeForPage, money } from '../lib/store.js';
import { cartToken, quote } from '../lib/cart.js';
import { esc } from '../components/ui.js';
import { track } from '../lib/analytics.js';

const PROVINCES = [['AB','Alberta'],['BC','British Columbia'],['MB','Manitoba'],['NB','New Brunswick'],['NL','Newfoundland and Labrador'],
  ['NS','Nova Scotia'],['NT','Northwest Territories'],['NU','Nunavut'],['ON','Ontario'],['PE','Prince Edward Island'],
  ['QC','Quebec'],['SK','Saskatchewan'],['YT','Yukon']];
const KEY = 'th8rty.checkoutKey';

// One key per checkout attempt: a double click or a retry after a network
// hiccup reuses it, so the server never creates two orders.
function checkoutKey(reset = false) {
  try {
    let k = sessionStorage.getItem(KEY);
    if (!k || reset) { k = crypto.randomUUID() + crypto.randomUUID(); sessionStorage.setItem(KEY, k); }
    return k;
  } catch { return crypto.randomUUID() + crypto.randomUUID(); }
}

export async function load(_, query) {
  const theme = await themeForPage('account');
  const user = auth.user;
  if (!user) return (await import('./cart.js')).signInPage(theme, 'Checkout', 'Sign in to check out', 'Orders are linked to your account so you can track them and see your history.');
  const [profile, addresses] = user ? await Promise.all([
    db.from('profiles').select('full_name,email,phone').eq('id', user.id).single().catch(() => null),
    db.from('addresses').select('*').eq('user_id', user.id).order('is_default', { ascending: false }).catch(() => []),
  ]) : [null, []];
  const a = addresses[0] || {};
  const cancelled = query.get('cancelled');

  return {
    theme, title: 'Checkout',
    html: `<section class="section commerce"><div class="wrap">
      <h1 class="h-section">Checkout</h1>
      ${cancelled ? `<p class="notice" role="status">Payment for ${esc(cancelled)} wasn't completed, so nothing was charged. Your bag is still here.</p>` : ''}
      <div class="checkout-layout">
        <form class="panel-box checkout-form" data-form novalidate>
          <fieldset><legend>Contact</legend>
            <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(profile?.email || user?.email || '')}"></div>
            ${user ? '' : '<p class="muted small">Have an account? <a href="/account/sign-in">Sign in</a> to use saved addresses.</p>'}
          </fieldset>
          <fieldset><legend>Shipping address</legend>
            ${addresses.length > 1 ? `<div class="field"><label for="saved">Saved addresses</label><select id="saved">${addresses.map((x, i) =>
              `<option value="${i}">${esc(x.full_name)}, ${esc(x.line1)}, ${esc(x.city)}</option>`).join('')}</select></div>` : ''}
            <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" autocomplete="name" required value="${esc(a.full_name || profile?.full_name || '')}"></div>
            <div class="field"><label for="line1">Street address</label><input id="line1" name="line1" autocomplete="address-line1" required value="${esc(a.line1 || '')}"></div>
            <div class="field"><label for="line2">Apartment, suite (optional)</label><input id="line2" name="line2" autocomplete="address-line2" value="${esc(a.line2 || '')}"></div>
            <div class="field-row">
              <div class="field"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2" required value="${esc(a.city || '')}"></div>
              <div class="field"><label for="province">Province</label><select id="province" name="province" autocomplete="address-level1" required>
                <option value="">Choose…</option>${PROVINCES.map(([c, n]) => `<option value="${c}"${a.province === c ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
              <div class="field"><label for="postal_code">Postal code</label><input id="postal_code" name="postal_code" autocomplete="postal-code" required maxlength="7" value="${esc(a.postal_code || '')}" placeholder="M5V 2T6"></div>
            </div>
            <div class="field"><label for="phone">Phone (for delivery questions, optional)</label><input id="phone" name="phone" type="tel" autocomplete="tel" value="${esc(a.phone || profile?.phone || '')}"></div>
            ${user ? `<label class="check"><input type="checkbox" name="save_address" ${addresses.length ? '' : 'checked'}> Save this address to my account</label>` : ''}
          </fieldset>
          <fieldset><legend>Shipping method</legend><div data-rates class="rates"><p class="muted">Choose your province to see shipping options.</p></div></fieldset>
          <fieldset><legend>Discount code</legend>
            <div class="form-row"><input name="code" autocomplete="off" spellcheck="false" value="${esc(query.get('code') || '')}" placeholder="Code"><button class="btn btn--quiet" type="button" data-apply>Apply</button></div>
            <p class="form-msg" data-code-msg role="status"></p>
          </fieldset>
          <p class="form-msg" data-error role="alert"></p>
          <button class="btn btn--block" type="submit" data-pay disabled>Continue to payment</button>
          <p class="muted small">Card details are entered on the payment provider's secure page; this site never sees or stores them.</p>
        </form>
        <aside class="receipt" data-summary aria-live="polite"><p class="muted">Calculating…</p></aside>
      </div>
    </div></section>`,

    mount(root) {
      const form = root.querySelector('[data-form]');
      const summary = root.querySelector('[data-summary]');
      const payBtn = root.querySelector('[data-pay]');
      let rate = null, code = (form.code.value || '').trim().toUpperCase(), last = null, timer = 0;
      track('checkout_started');

      root.querySelector('#saved')?.addEventListener('change', (e) => {
        const x = addresses[Number(e.target.value)];
        for (const k of ['full_name', 'line1', 'line2', 'city', 'province', 'postal_code', 'phone']) form[k].value = x[k] || '';
        refresh();
      });

      const refresh = () => { clearTimeout(timer); timer = setTimeout(update, 150); };
      async function update() {
        const province = form.province.value || null;
        let q;
        try { q = await quote({ province, rate, code: code || null, email: form.email.value.trim() || null }); }
        catch (e) { summary.innerHTML = `<p class="form-msg">${esc(e.message)}</p>`; return; }
        last = q;
        if (!q.items?.length) { summary.innerHTML = '<p>Your bag is empty. <a href="/shop">Keep shopping</a>.</p>'; payBtn.disabled = true; return; }

        // shipping options
        const ratesEl = root.querySelector('[data-rates]');
        if (province && q.shipping_options?.length) {
          rate = q.shipping?.code || rate;
          ratesEl.innerHTML = q.shipping_options.map(o => `<label class="rate">
            <input type="radio" name="rate" value="${esc(o.code)}" ${o.code === rate ? 'checked' : ''}>
            <span><strong>${esc(o.label)}</strong> <span class="muted">${o.min_days}–${o.max_days} business days</span>
            ${o.free_over_cents && o.price_cents > 0 ? `<span class="muted small">Free over ${money(o.free_over_cents)}</span>` : ''}</span>
            <span>${o.price_cents === 0 ? 'Free' : money(o.price_cents)}</span></label>`).join('');
          ratesEl.querySelectorAll('input').forEach(i => i.onchange = () => { rate = i.value; refresh(); });
        } else if (province) {
          ratesEl.innerHTML = '<p class="form-msg">We don\'t ship to that province yet.</p>';
        }

        const msg = root.querySelector('[data-code-msg]');
        msg.textContent = q.discount?.error ? q.discount.error : (q.discount && (q.discount_cents > 0 || q.discount.free_shipping)) ? `${q.discount.label} applied.` : '';

        const blocking = q.issues?.length;
        summary.innerHTML = `<h2 class="receipt-title">Order</h2>
          <ul class="receipt-items">${q.items.map(i => `<li><span>${i.quantity} × ${esc(i.name)} <span class="muted">${esc(i.color || '')} / ${esc(i.size || '')}</span>
            ${i.issue ? `<span class="bag-issue">${esc(i.issue)}</span>` : ''}</span><span>${money(i.line_total_cents)}</span></li>`).join('')}</ul>
          <dl class="receipt-lines">
            <dt>Subtotal</dt><dd>${money(q.subtotal_cents)}</dd>
            ${q.discount_cents > 0 ? `<dt>${esc(q.discount.code)}</dt><dd>−${money(q.discount_cents)}</dd>` : ''}
            <dt>Shipping</dt><dd>${province ? (q.shipping_cents === 0 ? 'Free' : money(q.shipping_cents)) : '—'}</dd>
            ${(q.taxes || []).map(t => `<dt>${esc(t.label)} ${+(Number(t.rate) * 100).toFixed(3)}%</dt><dd>${money(t.amount_cents)}</dd>`).join('')}
            ${province ? '' : '<dt>Tax</dt><dd class="muted">By province</dd>'}
            <dt class="receipt-total">Total</dt><dd class="receipt-total">${money(q.total_cents)} <span class="muted small">CAD</span></dd>
          </dl>
          ${blocking ? '<p class="form-msg">Some items need attention. <a href="/cart">Review your bag</a>.</p>' : ''}`;
        payBtn.disabled = !province || !q.shipping || blocking;
        payBtn.textContent = province ? `Continue to payment · ${money(q.total_cents)}` : 'Continue to payment';
      }

      form.province.addEventListener('change', () => { rate = null; refresh(); });
      form.email.addEventListener('change', refresh);
      root.querySelector('[data-apply]').onclick = () => { code = form.code.value.trim().toUpperCase(); refresh(); };
      form.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-apply]').click(); } });

      form.onsubmit = async (e) => {
        e.preventDefault();
        const err = root.querySelector('[data-error]');
        err.textContent = '';
        const f = Object.fromEntries(new FormData(form));
        const missing = ['email', 'full_name', 'line1', 'city', 'province', 'postal_code'].filter(k => !String(f[k] || '').trim());
        if (missing.length) { err.textContent = 'Fill in your email and full shipping address.'; form[missing[0]].focus(); return; }
        if (!/^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/.test(f.postal_code.trim())) { err.textContent = 'Enter a Canadian postal code like M5V 2T6.'; form.postal_code.focus(); return; }

        payBtn.disabled = true; payBtn.textContent = 'Placing your order…';
        const address = { full_name: f.full_name, line1: f.line1, line2: f.line2, city: f.city, province: f.province, postal_code: f.postal_code };
        try {
          if (auth.user && f.save_address && !addresses.some(x => x.line1 === f.line1 && x.postal_code.replace(' ', '') === f.postal_code.replace(' ', '').toUpperCase())) {
            await saveAddress(address, f.phone, !addresses.length).catch(() => {});
          }
          const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(auth.session?.access_token ? { Authorization: `Bearer ${auth.session.access_token}` } : {}) },
            body: JSON.stringify({ cart_token: cartToken(), email: f.email, phone: f.phone, address, rate_code: rate,
                                   discount_code: code || null, idempotency_key: checkoutKey() }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Checkout failed. Nothing was charged.');
          if (data.duplicate) { location.href = `/orders/${encodeURIComponent(data.number)}`; return; }
          checkoutKey(true);   // next attempt is a new checkout
          sessionStorage.setItem(`th8rty.order.${data.number}`, data.access_token);
          location.href = data.redirect_url;
        } catch (ex) {
          err.textContent = ex.message;
          checkoutKey(true);
          payBtn.disabled = false; payBtn.textContent = `Continue to payment · ${money(last?.total_cents)}`;
          refresh();
        }
      };

      update();
      return () => clearTimeout(timer);
    },
  };
}

async function saveAddress(address, phone, isDefault) {
  const { env } = await import('../lib/env.js');
  await fetch(`${env.SUPABASE_URL}/rest/v1/addresses`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${auth.session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...address, postal_code: address.postal_code.toUpperCase(), phone: phone || null, user_id: auth.user.id, is_default: isDefault }),
  });
}
