// /admin/launch — go-live checklist. Automatic checks read the real state
// of the database and of the Netlify configuration (/api/launch-status);
// the rest are things only a person can confirm, ticked here with who/when.
// /admin/launch/legal/:slug edits the legal pages.
import { db, auth } from '../lib/supabase.js';
import { esc, num, dateTime, toast, errorText } from './ui.js';
import { markdown } from '../lib/markdown.js';

const LEGAL = [['privacy', 'Privacy policy'], ['returns', 'Returns & refunds'], ['shipping', 'Shipping'], ['terms', 'Terms of sale']];

// status: 'ok' | 'todo' | 'warn' | null (manual). Each item says how to fix it.
function items(c, s) {
  const S = s || {};
  return [
    ['Payments', [
      { key: 'payments', title: 'Real payments switched on', status: !s ? null : S.payments.provider === 'stripe' && S.payments.stripe_keys ? (S.payments.test_key ? 'warn' : 'ok') : 'todo',
        detail: !s ? 'Status unavailable.' : S.payments.provider !== 'stripe' ? 'Using test payments. Set PAYMENT_PROVIDER=stripe with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Netlify (docs/checkout.md).'
          : !S.payments.stripe_keys ? 'Stripe selected but a key is missing.' : S.payments.test_key ? 'Stripe is in TEST mode (sk_test_ key). Switch to your live key at launch.' : 'Stripe live.' },
      { key: 'test_order', title: 'One real order placed and refunded end to end', manual: true, detail: 'Buy something cheap with a real card, watch it reach a partner, then refund it from the order page.' },
    ]],
    ['Emails', [
      { key: 'emails', title: 'Customer emails sending from your domain', status: !s ? null : S.email.provider === 'resend' && S.email.from ? 'ok' : S.email.provider === 'resend' ? 'warn' : 'todo',
        detail: !s ? '' : S.email.provider !== 'resend' ? 'Test mode — add RESEND_API_KEY and EMAIL_FROM (docs/emails.md).' : !S.email.from ? 'EMAIL_FROM not set: emails only reach the Resend account owner.' : 'Resend connected.', href: '/admin/emails' },
      { key: 'auth_smtp', title: 'Account emails (sign-up, password reset) use your own address', manual: true, detail: 'Supabase → Authentication → Emails → SMTP settings → smtp.resend.com (docs/emails.md).' },
      { key: 'emails_failed', title: 'No failed emails this week', status: c.emails_failed_7d ? 'warn' : 'ok', detail: c.emails_failed_7d ? `${c.emails_failed_7d} failed — open Emails to see why.` : 'None.', href: '/admin/emails?status=failed' },
    ]],
    ['Fulfillment', [
      { key: 'real_partner', title: 'At least one real print partner is active', status: c.real_partners_active ? 'ok' : 'todo',
        detail: c.real_partners_active ? `${c.real_partners_active} active.` : 'Add your printer under Fulfillment → Partners and set it to Active.', href: '/admin/fulfillment/partners' },
      { key: 'test_partners', title: 'Test partners switched off', status: c.test_partners_active || c.test_partner_routing ? 'todo' : 'ok',
        detail: c.test_partners_active ? `${c.test_partners_active} fictional test partners are still active${c.test_partner_routing ? ' and routing to test partners is on' : ''}. Set them Inactive and untick “Route to test partners”.` : 'Done.', href: '/admin/fulfillment' },
      { key: 'shipping_rates', title: 'Real shipping prices', manual: true, detail: `${num(c.shipping_rates)} active rates. The seeded prices are placeholders — set what your carrier charges.`, href: '/admin/shipping' },
    ]],
    ['Catalogue & prices', [
      { key: 'catalogue', title: 'Real products (seeded test catalogue replaced or confirmed)', manual: true, detail: `${num(c.live_products)} products are live.`, href: '/admin/products' },
      { key: 'photos', title: 'Product photos', status: c.products_without_photos ? 'warn' : 'ok',
        detail: c.products_without_photos ? `${c.products_without_photos} of ${c.live_products} live products have no photo (they show the drawn garment). Photos also become the link-preview image.` : 'Every live product has a photo.', href: '/admin/products' },
      { key: 'costs', title: 'Production costs filled in (for margin reports)', status: c.products_without_cost || c.pricing_rules_without_cost ? 'warn' : 'ok',
        detail: `${c.products_without_cost} products and ${c.pricing_rules_without_cost} custom pricing rules have no cost.`, href: '/admin/pricing' },
      { key: 'custom_prices', title: 'Custom-design prices confirmed with your printer', manual: true, detail: 'The pricing rules were seeded with placeholder numbers.', href: '/admin/pricing' },
      { key: 'tax_reviewed', title: 'Tax rates checked by an accountant', manual: true, detail: `${c.tax_rates} provinces/territories have rates.`, href: '/admin/taxes' },
    ]],
    ['Legal & trust', [
      ...LEGAL.map(([k, t]) => { const L = c.legal?.[k] || {};
        return { key: `legal_${k}`, title: t, status: L.placeholders ? 'todo' : L.reviewed ? 'ok' : 'warn',
          detail: L.placeholders ? `${L.placeholders} [[blanks]] to fill in.` : L.reviewed ? 'Reviewed.' : 'Filled in — mark it reviewed once you (ideally a lawyer) have read it.', href: `/admin/launch/legal/${k}` }; }),
      { key: 'moderation_terms', title: 'Moderation word list reviewed', manual: true, detail: `${c.moderation_terms} brand/character/team terms send designs to review.`, href: '/admin/designs' },
    ]],
    ['Security', [
      { key: 'super_admin_guard', title: 'Last-super-admin protection installed', status: c.super_admin_guard ? 'ok' : 'todo',
        detail: c.super_admin_guard ? 'Installed.' : 'Run supabase/migrations/20261003000012_last_super_admin_guard.sql once in the Supabase SQL editor.' },
      { key: 'leaked_passwords', title: 'Supabase leaked-password protection on', manual: true, detail: 'Supabase → Authentication → Sign in / Providers → Email → “Prevent use of leaked passwords”.' },
      { key: 'backups', title: 'Database backups confirmed', manual: true, detail: 'Supabase → Database → Backups. Daily backups come with the Pro plan; consider point-in-time recovery once orders flow.' },
      { key: 'carrier_webhook', title: 'Carrier tracking webhook secret set', status: !s ? null : S.carrier_webhook ? 'ok' : 'warn', detail: 'CARRIER_WEBHOOK_SECRET — only needed when a tracking service posts updates.' },
    ]],
    ['Go live', [
      { key: 'domain', title: 'Your own domain', status: !s ? null : S.custom_domain ? 'ok' : 'warn', detail: !s ? '' : S.custom_domain ? S.site : `Still on ${S.site || 'the netlify.app address'}. Add a domain in Netlify → Domain management, then set SITE_URL.` },
      { key: 'live_mode', title: 'Store switched to live', status: !s ? null : S.integrations_live ? 'ok' : 'todo',
        detail: !s ? '' : S.integrations_live ? 'Live: the development banner is gone and search engines may index the store.' : 'Last step: set INTEGRATIONS_MODE=live in Netlify and redeploy. This hides the development banner, opens robots.txt to search engines, and sends uploaded images to human review.' },
    ]],
  ];
}

export async function view(ctx) {
  if (ctx.segs[1] === 'legal') return legalEditor(ctx, ctx.segs[2]);
  const [c, s] = await Promise.all([
    db.rpc('admin_launch_checks'),
    fetch('/api/launch-status', { headers: { Authorization: `Bearer ${await auth.token()}` } }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const groups = items(c, s), done = c.done || {}, can = ctx.can('settings.write');
  const all = groups.flatMap(([, list]) => list);
  const isOk = (i) => i.manual ? !!done[i.key] : i.status === 'ok';
  const okCount = all.filter(isOk).length;
  const blockers = all.filter(i => !i.manual && i.status === 'todo').length;
  return {
    title: 'Launch checklist',
    html: `<header class="cc-head"><div><h1>Launch checklist</h1>
        <p class="cc-muted">${okCount} of ${all.length} done${blockers ? ` · ${blockers} must-fix` : ''}. Automatic items update themselves; tick the others when they're done.</p></div></header>
      ${s == null ? '<p class="cc-note cc-note--warn">Couldn\'t read the Netlify configuration (the functions may not be running locally), so some items show as unknown.</p>' : ''}
      <div class="ln-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${all.length}" aria-valuenow="${okCount}" aria-label="Launch progress"><span style="width:${(okCount / all.length) * 100}%"></span></div>
      ${groups.map(([g, list]) => `<section class="cc-card ln-group"><h2>${esc(g)}</h2><ul class="ln-list">${list.map(i => {
        const st = i.manual ? (done[i.key] ? 'ok' : 'manual') : (i.status || 'unknown');
        return `<li class="ln-item is-${st}">
          <span class="ln-mark" aria-hidden="true">${st === 'ok' ? '✓' : st === 'todo' ? '!' : st === 'warn' ? '–' : st === 'manual' ? '' : '?'}</span>
          <div><strong>${esc(i.title)}</strong> <span class="sr-only">(${st === 'ok' ? 'done' : st === 'todo' ? 'must fix' : st === 'warn' ? 'recommended' : st === 'manual' ? 'not ticked' : 'unknown'})</span>
            <p class="cc-small cc-muted">${esc(i.detail || '')}${i.manual && done[i.key] ? ` <span>· ticked by ${esc(done[i.key].by || 'staff')} ${esc(dateTime(done[i.key].at))}</span>` : ''}</p></div>
          <div class="ln-act">${i.href ? `<a class="cc-btn cc-btn--small" href="${i.href}">Open</a>` : ''}
            ${i.manual && can ? `<label class="cc-check"><input type="checkbox" data-mark="${i.key}"${done[i.key] ? ' checked' : ''}> <span>Done</span></label>` : ''}</div></li>`;
      }).join('')}</ul></section>`).join('')}`,
    mount(root) {
      root.querySelectorAll('[data-mark]').forEach(cb => cb.addEventListener('change', async () => {
        try { await db.rpc('admin_launch_mark', { p_key: cb.dataset.mark, p_done: cb.checked }); ctx.go(location.pathname); }
        catch (e) { cb.checked = !cb.checked; toast(errorText(e), 'bad'); }
      }));
    },
  };
}

async function legalEditor(ctx, slug) {
  const meta = LEGAL.find(([k]) => k === slug);
  if (!meta) return { title: 'Not found', html: '<p class="cc-empty">Not found.</p>' };
  const [row] = await db.from('store_settings').select('value').eq('key', `legal.${slug}`);
  const v = row?.value || { title: meta[1], body: '' };
  const can = ctx.can('settings.write');
  return {
    title: v.title,
    html: `<p class="cc-crumbs"><a href="/admin/launch">Launch checklist</a> / Legal pages</p>
      <header class="cc-head"><div><h1>${esc(v.title)}</h1><p class="cc-muted">Shown at <a href="/legal/${slug}" target="_blank" rel="noopener">/legal/${slug}</a>${v.updated_at ? ` · saved ${esc(dateTime(v.updated_at))}` : ''}</p></div>
        <nav class="cc-tabs" aria-label="Legal pages">${LEGAL.map(([k, l]) => `<a href="/admin/launch/legal/${k}"${k === slug ? ' aria-current="true"' : ''}>${esc(l)}</a>`).join('')}</nav></header>
      <p class="cc-note">A starting draft written for a Canadian print-on-demand store. Replace every <mark class="md-todo">[[highlighted blank]]</mark> with your details, adjust anything that doesn't match how you work, and have a lawyer look it over — this isn't legal advice.</p>
      <div class="cc-two lg-two">
        <section class="cc-card"><form data-legal class="lg-form">
          <div class="cc-field"><label for="lg-title">Title</label><input id="lg-title" name="title" value="${esc(v.title)}" maxlength="80" ${can ? '' : 'disabled'}></div>
          <div class="cc-field"><label for="lg-body">Text</label><textarea id="lg-body" name="body" rows="24" ${can ? '' : 'disabled'}>${esc(v.body || '')}</textarea>
            <small>## Heading · - list item · **bold** · [link](https://…) · blank line between paragraphs</small></div>
          <label class="cc-check"><input type="checkbox" name="reviewed"${v.reviewed ? ' checked' : ''} ${can ? '' : 'disabled'}> <span>Reviewed and ready to publish</span></label>
          <p class="cc-form-msg" data-msg></p>
          ${can ? '<button class="cc-btn cc-btn--primary">Save</button>' : ''}</form></section>
        <section class="cc-card lg-preview"><h2 class="cc-small cc-muted">Preview</h2><div class="legal-body" data-preview>${markdown(v.body || '')}</div></section>
      </div>`,
    mount(root) {
      const f = root.querySelector('[data-legal]'), pv = root.querySelector('[data-preview]');
      f.body.addEventListener('input', () => { pv.innerHTML = markdown(f.body.value); });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const msg = f.querySelector('[data-msg]');
        const body = f.body.value.trim(), title = f.title.value.trim();
        if (!title || body.length < 40) { msg.textContent = 'Add a title and the text.'; return; }
        if (f.reviewed.checked && /\[\[[^\]]+\]\]/.test(body)) { msg.textContent = 'Fill in every [[blank]] before marking it reviewed.'; return; }
        try {
          await db.update('store_settings', { key: `legal.${slug}` }, { value: { title, body, reviewed: f.reviewed.checked, updated_at: new Date().toISOString() } });
          toast('Saved.'); ctx.go(location.pathname);
        } catch (err) { msg.textContent = errorText(err); }
      };
    },
  };
}
