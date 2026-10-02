// /cart — the bag.
import { themeForPage, money } from '../lib/store.js';
import { getBag, setItem, removeFromBag, quote } from '../lib/cart.js';
import { esc, garmentSVG } from '../components/ui.js';

export async function load() {
  const theme = await themeForPage('account');
  return {
    theme, title: 'Your bag',
    html: `<section class="section commerce"><div class="wrap">
      <h1 class="h-section">Your bag</h1>
      <div class="bag-layout" data-bag><p class="muted">Loading your bag…</p></div>
    </div></section>`,
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
        host.innerHTML = `
          <ul class="bag-lines panel-box">${items.map(i => `
            <li class="bag-line" data-variant="${i.variant_id}">
              <a class="bag-thumb" href="/product/${esc(i.product_slug)}">${garmentSVG({ type: i.product_type, color: i.color_hex, mode: 'flat', label: i.name })}</a>
              <div class="bag-info">
                <a class="bag-name" href="/product/${esc(i.product_slug)}">${esc(i.name)}</a>
                <span class="muted">${esc(i.color || '')}${i.size ? ' / ' + esc(i.size) : ''}${i.is_limited ? ` · Limited, numbered at payment` : ''}</span>
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
          const v = li.dataset.variant, item = items.find(i => i.variant_id === v);
          li.querySelectorAll('[data-step]').forEach(b => b.onclick = async () => {
            b.disabled = true;
            try { await setItem(v, Math.max(0, item.quantity + Number(b.dataset.step))); } catch (e) { alert(e.message); }
            render();
          });
          li.querySelector('[data-remove]').onclick = async () => { await removeFromBag(v); render(); };
        });
        host.querySelector('[data-code]').onsubmit = (e) => { e.preventDefault(); code = e.target.code.value.trim().toUpperCase(); render(); };
        host.querySelector('[data-blocked]')?.addEventListener('click', (e) => e.preventDefault());
      };
      render();
    },
  };
}
