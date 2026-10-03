// Bulk / custom quote requests (250+ pieces).
import { db } from '../lib/supabase.js';
import { esc, money, num, pill, table, date, dateTime, label, form, readForm, toast, bindRowLinks, errorText } from './ui.js';

const STATUSES = ['new', 'reviewing', 'quoted', 'accepted', 'declined', 'expired', 'converted'];

export async function view(ctx) {
  if (ctx.segs[1]) return edit(ctx, ctx.segs[1]);
  const status = ctx.query.get('status') || '';
  let q = db.from('quote_requests').select('*').order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('status', status);
  const rows = await q;
  return {
    title: 'Quotes',
    html: `<header class="cc-head"><div><h1>Quote requests</h1><p class="cc-muted">${rows.length} shown</p></div></header>
      <nav class="cc-tabs"><a href="/admin/quotes"${!status ? ' aria-current="true"' : ''}>All</a>${STATUSES.map(s => `<a href="/admin/quotes?status=${s}"${s === status ? ' aria-current="true"' : ''}>${label(s)}</a>`).join('')}</nav>
      <section class="cc-card cc-card--flush">${table(rows, [
        { label: 'Quote', render: r => `<strong>${esc(r.number)}</strong>` },
        { label: 'Customer', render: r => `${esc(r.name)}<br><span class="cc-muted cc-small">${esc(r.email)}</span>` },
        { label: 'Pieces', align: 'right', render: r => num(r.quantity) },
        { label: 'Estimate', align: 'right', render: r => r.estimate?.total_cents ? money(r.estimate.total_cents) : '—' },
        { label: 'Proposed', align: 'right', render: r => r.proposed_total_cents ? money(r.proposed_total_cents) : '—' },
        { label: 'Needed by', render: r => date(r.desired_date) },
        { label: 'Status', render: r => pill(r.status) }, { label: 'Received', render: r => dateTime(r.created_at) }],
        { empty: 'No quote requests.', rowHref: r => `/admin/quotes/${r.id}` })}</section>`,
    mount(root) { bindRowLinks(root, ctx.go); },
  };
}

async function edit(ctx, id) {
  const r = await db.from('quote_requests').select('*').eq('id', id).single().catch(() => null);
  if (!r) return { title: 'Not found', html: '<p class="cc-empty">Quote not found.</p>' };
  const fields = [
    { name: 'status', label: 'Status', type: 'select', options: STATUSES.map(s => [s, label(s)]) },
    { name: 'proposed_unit_cents', label: 'Price per item', type: 'money' },
    { name: 'discount_cents', label: 'Discount (total)', type: 'money' },
    { name: 'proposed_total_cents', label: 'Quote total', type: 'money', help: 'Leave empty to use price × pieces − discount.' },
    { name: 'expires_at', label: 'Quote valid until', type: 'datetime' },
    { name: 'admin_notes', label: 'Internal notes', type: 'textarea', full: true },
  ];
  const e = r.estimate || {};
  return {
    title: `Quote ${r.number}`,
    html: `<p class="cc-crumbs"><a href="/admin/quotes">Quotes</a> / ${esc(r.number)}</p>
      <header class="cc-head"><h1>${esc(r.number)} ${pill(r.status)}</h1></header>
      <div class="cc-two">
        <section class="cc-card"><h2>Request</h2><dl class="cc-dl">
          <dt>Customer</dt><dd>${esc(r.name)} · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? ` · ${esc(r.phone)}` : ''}</dd>
          <dt>Pieces</dt><dd>${num(r.quantity)}</dd>
          <dt>Sizes</dt><dd>${esc(Object.entries(r.size_breakdown || {}).map(([s, n]) => `${n} ${s}`).join(', ') || '—')}</dd>
          <dt>Colours</dt><dd>${esc(r.colors || '—')}</dd><dt>Print</dt><dd>${esc(r.placements || '—')}</dd>
          <dt>Needed by</dt><dd>${date(r.desired_date)}</dd><dt>Notes</dt><dd>${esc(r.notes || '—')}</dd>
          ${r.design_id ? `<dt>Design</dt><dd><a href="/admin/designs?id=${r.design_id}">Open artwork & moderation</a></dd>` : ''}
          <dt>Engine estimate</dt><dd>${e.total_cents ? `${money(e.unit_cents)} each · ${money(e.total_cents)} total (standard tiers, before quote pricing)` : '—'}</dd>
        </dl></section>
        <section class="cc-card"><h2>Your quote</h2>${form(fields, r, { submit: 'Save quote' })}
          <p class="cc-muted cc-small">Email the customer the quote from your inbox for now; sending from the store needs an email provider. Converting an accepted quote into an order arrives with the CRM phase.</p></section>
      </div>`,
    mount(root) {
      const f = root.querySelector('[data-form]');
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const msg = f.querySelector('[data-msg]');
        try {
          const v = readForm(f, fields);
          if (v.proposed_total_cents == null && v.proposed_unit_cents != null) v.proposed_total_cents = Math.max(0, v.proposed_unit_cents * r.quantity - (v.discount_cents || 0));
          v.discount_cents ??= 0;
          await db.update('quote_requests', { id: r.id }, v);
          toast('Quote saved.'); ctx.go(location.pathname);
        } catch (err) { msg.textContent = errorText(err); }
      };
    },
  };
}
