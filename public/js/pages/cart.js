// /cart — the bag.
import { themeForPage, money } from '../lib/store.js';
import { getBag, setLine, quote, signInUrl } from '../lib/cart.js';
import { auth } from '../lib/supabase.js';
import { storage } from '../lib/supabase.js';
import { esc, garmentSVG } from '../components/ui.js';
import { recsSlot, mountRecs } from '../lib/recommend.js';

export async function load() {
  const theme = await themeForPage('account');
  if (!auth.user) return signInPage(theme, 'Your bag', 'Sign in to see your bag', 'Your bag is saved to your account, so it follows you to any device.');
  return {
    theme, title: 'Your bag',
    html: `<section class="section commerce"><div class="wrap">
      <h1 class="h-section">Your bag</h1>
      <div class="bag-layout" data-bag><p class="muted">Loading your bag…</p></div>
    </div></section>${recsSlot('bag')}`,
    async mount(root) {
      const host = root.querySelector('[data-bag]');
      let code = '';
      const render = async () => {
        let items, q;
        try {
          items = await getBag();
          q = items.length ? await quote({ code: code || null }) : null;
        } catch (e) {
          host.innerHTML = `<p class="form-msg">Couldn't load your bag: ${esc(e.message)}</p>`; return;
        }
        if (!items.length) {
          host.innerHTML = `<div class="panel-box empty-bag"><p class="lede">Your bag is empty.</p>
            <p class="hero-actions" style="justify-content:flex-start"><a class="btn" href="/shop">Browse the shop</a><a class="btn btn--quiet" href="/drops">See live drops</a></p></div>`;
          return;
        }
        const blocked = items.some(i => i.issue && !/^Only|^Limit/.test(i.issue));
        const thumbs = await storage.sign('mockups', items.filter(i => i.item_type === 'custom').map(i => i.mockups?.front)).catch(() => ({}));
        host.innerHTML = `
          <ul class="bag-lines panel-box">${items.map(i => `
            <li class="bag-line" data-item="${i.item_id}">
              <a class="bag-thumb" href="${i.item_type === 'custom' ? `/custom/${i.design_id}` : `/product/${esc(i.product_slug)}`}">${
                i.item_type === 'custom' && thumbs[i.mockups?.front] ? `<img src="${thumbs[i.mockups.front]}" alt="">` : garmentSVG({ type: i.product_type, color: i.color_hex, mode: 'flat', label: i.name })}</a>
              <div class="bag-info">
                <a class="bag-name" href="${i.item_type === 'custom' ? `/custom/${i.design_id}` : `/product/${esc(i.product_slug)}`}">${esc(i.name)}</a>
                <span class="muted">${esc(i.color || '')}${i.size ? ' / ' + esc(i.size) : ''}${i.is_limited ? ` · Limited, numbered at payment` : ''}</span>
                ${i.item_type === 'custom' && i.pricing?.print ? `<span class="muted small">${i.pricing.print.map(x => `${esc(x.placement_label)} (${esc(x.method_label)})`).join(' + ')} · ${money(i.unit_price_cents)} each${i.one_time_cents ? ` + ${money(i.one_time_cents)} one-time` : ''}</span>` : ''}
                ${i.item_type === 'custom' && i.pricing?.next_tier ? `<span class="small">Add ${i.pricing.next_tier.add_qty} more for ${money(i.pricing.next_tier.per_unit_discount_cents)} off each</span>` : ''}
                ${i.issue ? `<span class="bag-issue" role="status">${esc(i.issue)}</span>` : ''}
              </div>
              <div class="qty" role="group" aria-label="Quantity for ${esc(i.name)}">
                <button type="button" data-step="-1" aria-label="One fewer">−</button>
                <output aria-live="polite">${i.quantity}</output>
                <button type="button" data-step="1" aria-label="One more" ${i.quantity >= i.max_quantity ? 'disabled' : ''}>+</button>
              </div>
              <span class="bag-price">${money(i.line_total_cents)}</span>
              <button type="button" class="linklike" data-remove>Remove</button>
            </li>`).join('')}
          </ul>
          <aside class="receipt">
            <h2 class="receipt-title">Summary</h2>
            <dl class="receipt-lines">
              <dt>Subtotal</dt><dd>${money(q.subtotal_cents)}</dd>
              ${q.discount_cents > 0 ? `<dt>${esc(q.discount.label)}</dt><dd>−${money(q.discount_cents)}</dd>` : ''}
              <dt>Shipping & tax</dt><dd class="muted">At checkout</dd>
            </dl>
            <form class="code-form" data-code>
              <label for="code">Discount code</label>
              <div class="form-row"><input id="code" name="code" value="${esc(code)}" autocomplete="off" spellcheck="false" placeholder="WELCOME20"><button class="btn btn--quiet" type="submit">Apply</button></div>
              <p class="form-msg" role="status">${q.discount?.error ? esc(q.discount.error) : q.discount_cents > 0 ? 'Code applied.' : ''}</p>
            </form>
            <a class="btn btn--block" href="/checkout${code ? '?code=' + encodeURIComponent(code) : ''}" ${blocked ? 'aria-disabled="true" data-blocked' : ''}>Checkout</a>
            ${blocked ? '<p class="form-msg">Remove the unavailable items to continue.</p>' : ''}
          </aside>`;

        host.querySelectorAll('.bag-line').forEach(li => {
          const id = li.dataset.item, item = items.find(i => i.item_id === id);
          li.querySelectorAll('[data-step]').forEach(b => b.onclick = async () => {
            b.disabled = true;
            try { await setLine(id, Math.max(0, item.quantity + Number(b.dataset.step))); } catch (e) { li.querySelector('.bag-info').insertAdjacentHTML('beforeend', `<span class="bag-issue">${esc(e.message)}</span>`); }
            render();
          });
          li.querySelector('[data-remove]').onclick = async () => { await setLine(id, 0); render(); };
        });
        host.querySelector('[data-code]').onsubmit = (e) => { e.preventDefault(); code = e.target.code.value.trim().toUpperCase(); render(); };
        host.querySelector('[data-blocked]')?.addEventListener('click', (e) => e.preventDefault());
        const ids = [...new Set(items.map(i => i.product_id).filter(Boolean))].sort().join(',');
        if (ids !== lastIds) {
          lastIds = ids;
          mountRecs(root, { slot: 'bag', fn: 'recommend_for_bag', args: { p_product_ids: ids.split(','), p_limit: 6 },
            title: 'Goes well with', cardStyle: theme.config?.cards?.style, source: 'bag' });
        }
      };
      let lastIds = '';
      render();
    },
  };
}

export function signInPage(theme, title, heading, text) {
  return { theme, title, html: `<section class="state"><h1>${esc(heading)}</h1>
    <p class="lede">${esc(text)}</p>
    <p class="hero-actions" style="justify-content:center"><a class="btn" href="${signInUrl()}">Sign in</a>
      <a class="btn btn--quiet" href="/account/sign-up?next=${encodeURIComponent(location.pathname)}">Create an account</a></p></section>` };
}
