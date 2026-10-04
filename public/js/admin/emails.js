// /admin/emails — every customer email the store sends: status, preview
// (rendered by the same template code the sender uses), resend, and the
// switches for which emails go out.
import { db } from '../lib/supabase.js';
import { render, TEMPLATES } from '../lib/email-templates.js';
import { esc, num, dateTime, pill, table, toast, errorText, kpi, confirmDialog, bindRowLinks } from './ui.js';

const STATUS = [['', 'All'], ['queued', 'Waiting'], ['sent', 'Sent'], ['skipped', 'Test mode'], ['failed', 'Failed']];
const TONE = { queued: ['pending', 'Waiting'], sending: ['pending', 'Sending'], sent: ['active', 'Sent'], skipped: ['draft', 'Test mode'], failed: ['failed', 'Failed'] };

export async function view(ctx) {
  const status = STATUS.some(s => s[0] === ctx.query.get('status')) ? ctx.query.get('status') : '';
  const q = (ctx.query.get('q') || '').trim().slice(0, 80);
  const [d, st] = await Promise.all([
    db.rpc('admin_emails', { p_status: status || null, p_q: q || null, p_limit: 150 }),
    fetch('/api/email-status').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const c = d.counts || {}, s = d.settings, canSettings = ctx.can('settings.write'), canResend = ctx.can('customers.write') || ctx.can('orders.write');
  const qs = (o) => '/admin/emails?' + new URLSearchParams(Object.entries({ status, q, ...o }).filter(([, v]) => v)).toString();
  return {
    title: 'Emails',
    html: `<header class="cc-head"><div><h1>Emails</h1><p class="cc-muted">Order updates, design decisions, quotes, support replies and welcome emails — sent automatically.</p></div></header>
      ${st == null ? '<p class="cc-note">Couldn\'t reach the email service status (the Netlify functions may not be running locally).</p>'
        : st.test_mode ? `<p class="cc-note cc-note--warn"><strong>Test mode.</strong> No email provider is connected, so emails are prepared and logged here (open one to preview it) but not sent.
            Add <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> in Netlify to start sending — see docs/emails.md.</p>`
        : st.shared_sender ? `<p class="cc-note cc-note--warn"><strong>Almost there.</strong> Resend is connected but no <code>EMAIL_FROM</code> is set, so emails go from Resend's shared test address and only reach the Resend account owner. Verify your domain in Resend and set <code>EMAIL_FROM</code>.</p>`
        : `<p class="cc-note">Sending through <strong>Resend</strong> from <code>${esc(st.from)}</code>.</p>`}
      <div class="cc-kpis">
        ${kpi('Sent (30 days)', num(c.sent), '', qs({ status: 'sent' }))}
        ${kpi('Waiting', num((c.queued || 0) + (c.sending || 0)), 'sent every 2 minutes', qs({ status: 'queued' }))}
        ${kpi('Failed', num(c.failed), c.failed ? 'retried 5 times, then stopped' : 'none', qs({ status: 'failed' }))}
        ${kpi('Test mode (not sent)', num(c.skipped), '', qs({ status: 'skipped' }))}
      </div>
      <section class="cc-card cc-card--flush">
        <form class="cc-toolbar em-tools" data-search>
          <nav class="cc-tabs" aria-label="Status">${STATUS.map(([k, l]) => `<a href="${qs({ status: k })}"${k === status ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>
          <input type="search" name="q" value="${esc(q)}" placeholder="Email, order number or type" aria-label="Search emails">
        </form>
        ${table(d.rows, [
          { label: 'Email', render: r => `<button class="linklike em-open" data-preview="${r.id}">${esc(r.subject || TEMPLATES[r.template] || r.template)}</button><br><span class="cc-muted cc-small">${esc(TEMPLATES[r.template] || r.template)}</span>` },
          { label: 'To', render: r => r.user_id ? `<a href="/admin/customers/${r.user_id}">${esc(r.to)}</a>` : esc(r.to) },
          { label: 'Order', render: r => r.order_number ? `<a href="/admin/orders/${r.order_id}">#${esc(r.order_number)}</a>` : '—' },
          { label: 'Status', render: r => `${pill(...TONE[r.status])}${r.attempts > 1 ? ` <span class="cc-small cc-muted">${r.attempts} tries</span>` : ''}${r.last_error && r.status !== 'skipped' ? `<br><span class="cc-small ff-bad">${esc(r.last_error)}</span>` : ''}` },
          { label: 'When', render: r => dateTime(r.sent_at || r.created_at) },
          ...(canResend ? [{ label: '', render: r => r.status === 'queued' || r.status === 'sending' ? '' : `<button class="cc-btn cc-btn--small" data-resend="${r.id}">Send again</button>` }] : []),
        ], { empty: q || status ? 'No emails match.' : 'No emails yet. They appear here as orders, designs and support requests happen.' })}
      </section>
      ${canSettings ? `<section class="cc-card"><h2>Settings</h2>
        <form class="em-settings" data-settings>
          <label class="cc-check"><input type="checkbox" name="enabled"${s.enabled ? ' checked' : ''}> <span>Send customer emails</span></label>
          <div class="cc-fields">
            <div class="cc-field"><label for="em-from">Sender name</label><input id="em-from" name="from_name" maxlength="60" value="${esc(s.from_name || '')}"></div>
            <div class="cc-field"><label for="em-reply">Replies go to</label><input id="em-reply" name="reply_to" type="email" value="${esc(s.reply_to || '')}" placeholder="you@yourdomain.ca">
              <small>Customers who reply land here. Leave empty to use the sending address.</small></div>
          </div>
          <fieldset class="em-types"><legend>Which emails to send</legend>
            ${Object.entries(TEMPLATES).map(([k, l]) => `<label class="cc-check"><input type="checkbox" name="tpl" value="${k}"${(s.disabled || []).includes(k) ? '' : ' checked'}> <span>${esc(l)}</span>
              <button type="button" class="linklike cc-small" data-sample="${k}">preview</button></label>`).join('')}
          </fieldset>
          <p class="cc-small cc-muted">Account emails (confirm your address, reset password) are sent by Supabase Auth. To send those from your own address too, point Supabase's SMTP settings at Resend — steps in docs/emails.md.</p>
          <button class="cc-btn cc-btn--primary">Save</button>
        </form></section>` : ''}`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      const f = root.querySelector('[data-search]');
      f.onsubmit = (e) => { e.preventDefault(); ctx.go(qs({ q: f.q.value.trim() })); };
      root.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', async () => {
        try { const p = await db.rpc('admin_email_preview', { p_id: b.dataset.preview }); showPreview(p.template, p.data, p.to); }
        catch (e) { toast(errorText(e), 'bad'); }
      }));
      root.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => showPreview(b.dataset.sample, sample(b.dataset.sample), 'customer@example.com')));
      root.querySelectorAll('[data-resend]').forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Send this email again?', body: '<p>A new copy is queued and goes out within two minutes. The original stays in the log.</p>', confirm: 'Send again' });
        if (!ok.ok) return;
        try { await db.rpc('admin_email_resend', { p_id: b.dataset.resend }); toast('Queued.'); ctx.go(location.pathname + location.search); }
        catch (e) { toast(errorText(e), 'bad'); }
      }));
      const sf = root.querySelector('[data-settings]');
      if (sf) sf.onsubmit = async (e) => {
        e.preventDefault();
        const reply = sf.reply_to.value.trim();
        if (reply && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reply)) { toast('Enter a valid reply-to address.', 'bad'); return; }
        const vals = {
          'email.enabled': sf.enabled.checked, 'email.from_name': sf.from_name.value.trim() || 'M-Way', 'email.reply_to': reply || null,
          'email.disabled_templates': [...sf.querySelectorAll('[name="tpl"]')].filter(x => !x.checked).map(x => x.value),
        };
        try { for (const [key, value] of Object.entries(vals)) await db.update('store_settings', { key }, { value }); toast('Email settings saved.'); }
        catch (err) { toast(errorText(err), 'bad'); }
      };
    },
  };
}

function showPreview(template, data, to) {
  let msg;
  try { msg = render(template, data || {}, { siteUrl: location.origin }); } catch (e) { toast(e.message, 'bad'); return; }
  const d = document.createElement('dialog');
  d.className = 'cc-dialog em-preview';
  d.innerHTML = `<form method="dialog"><div class="em-preview-head"><div><h2>${esc(msg.subject)}</h2><p class="cc-small cc-muted">To ${esc(to)}</p></div>
      <div class="cc-seg" role="group" aria-label="Version"><button type="button" class="cc-btn cc-btn--small" aria-pressed="true" data-v="html">Email</button>
      <button type="button" class="cc-btn cc-btn--small" aria-pressed="false" data-v="text">Plain text</button></div></div>
    <iframe title="Email preview" sandbox="" class="em-frame"></iframe><pre class="em-text" hidden></pre>
    <div class="cc-form-actions"><button class="cc-btn" value="close">Close</button></div></form>`;
  document.body.append(d);
  d.querySelector('iframe').srcdoc = msg.html;
  d.querySelector('pre').textContent = msg.text;
  d.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
    const html = b.dataset.v === 'html';
    d.querySelector('iframe').hidden = !html; d.querySelector('pre').hidden = html;
    d.querySelectorAll('[data-v]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

// Sample data for previewing a template before any real email exists.
function sample(t) {
  const order = { id: 'x', number: 'AER-10492', status: 'paid', paid_at: new Date().toISOString(), subtotal_cents: 16700, discount_cents: 1670, discount_code: 'WELCOME10',
    shipping_cents: 0, tax_cents: 1954, total_cents: 16984, refunded_cents: 16984,
    shipping_address: { name: 'Maya Chen', line1: '123 Queen St W', city: 'Toronto', province: 'ON', postal_code: 'M5H 2M9', country: 'Canada' },
    items: [{ name: 'Cyber Samurai Hoodie', color: 'Black', size: 'XL', quantity: 1, line_total_cents: 8900, editions: [184] },
            { name: 'Custom Essential Tee', color: 'White', size: 'M', quantity: 2, line_total_cents: 7800, custom: true }],
    shipments: [{ carrier: 'Canada Post', tracking_number: '7023 4567 8912 3456', tracking_url: 'https://www.canadapost-postescanada.ca/track-reperage/en', estimated_delivery: new Date(Date.now() + 3 * 864e5).toISOString() }] };
  return { store: { name: 'M-Way' }, name: 'Maya Chen', order,
    design: { id: 'x', name: 'Moon dragon', note: t === 'design_rejected' ? 'The sleeve text looks like a sports team logo. Swap it for your own lettering.' : null },
    quote: { id: 'x', number: 1042, quantity: 120, product: 'Essential Hoodie', unit_cents: 4200, total_cents: 504000, expires_at: new Date(Date.now() + 14 * 864e5).toISOString() },
    ticket: { id: 'x', number: 311, subject: 'Can I change my size?' }, message: 'Hi Maya — yes! I\'ve switched your hoodie to XL. Nothing else to do on your side.\n\n— Sam at M-Way' };
}
