// Orders: search / filter list, and the full order view with actions.
import { db, auth, storage } from '../lib/supabase.js';
import { esc, money, num, pill, table, date, dateTime, label, toast, confirmDialog, bindRowLinks, errorText } from './ui.js';

const GROUPS = [['', 'All'], ['pending', 'Pending'], ['production', 'Production'], ['shipped', 'Shipped'], ['delivered', 'Delivered'],
  ['backorders', 'Backorders'], ['returns', 'Returns'], ['refunds', 'Refunds'], ['cancelled', 'Cancelled'], ['unpaid', 'Unpaid / abandoned']];
const PAGE = 50;

export async function view(ctx) {
  return ctx.segs[1] ? detail(ctx, ctx.segs[1]) : list(ctx);
}

async function list(ctx) {
  const q = ctx.query.get('q') || '', group = ctx.query.get('group') || '', page = Math.max(0, Number(ctx.query.get('page')) || 0);
  const r = await db.rpc('admin_orders', { p_q: q || null, p_group: group || null, p_limit: PAGE, p_offset: page * PAGE });
  const qs = (o) => '/admin/orders?' + new URLSearchParams(Object.entries({ q, group, page: 0, ...o }).filter(([, v]) => v !== '' && v !== 0)).toString();
  return {
    title: 'Orders',
    html: `<header class="cc-head"><div><h1>Orders</h1><p class="cc-muted">${num(r.total)} ${group ? label(GROUPS.find(g => g[0] === group)?.[1] || group).toLowerCase() : ''} orders</p></div>
      <form class="cc-search" data-search role="search"><input name="q" value="${esc(q)}" placeholder="Order number, email or name" aria-label="Search orders"><button class="cc-btn">Search</button></form></header>
      <nav class="cc-tabs">${GROUPS.map(([g, l]) => `<a href="${qs({ group: g })}"${g === group ? ' aria-current="true"' : ''}>${esc(l)}</a>`).join('')}</nav>
      <section class="cc-card cc-card--flush">${table(r.rows, [
        { label: 'Order', render: o => `<a href="/admin/orders/${o.id}"><strong>${esc(o.number)}</strong></a>${o.custom ? ' <span class="cc-tag">Custom</span>' : ''}${o.limited ? ' <span class="cc-tag">Limited</span>' : ''}` },
        { label: 'Customer', render: o => `${esc(o.name || '')}<br><span class="cc-muted cc-small">${esc(o.email)}</span>` },
        { key: 'province', label: 'Prov.' },
        { label: 'Items', align: 'right', render: o => num(o.units) },
        { label: 'Status', render: o => pill(o.status) },
        { label: 'Total', align: 'right', render: o => money(o.total_cents) },
        { label: 'Placed', render: o => dateTime(o.created_at) }],
        { empty: q ? 'No orders match that search.' : 'No orders here yet.', rowHref: o => `/admin/orders/${o.id}` })}</section>
      <nav class="cc-pager">${page > 0 ? `<a class="cc-btn" href="${qs({ page: page - 1 })}">← Newer</a>` : ''}
        ${(page + 1) * PAGE < r.total ? `<a class="cc-btn" href="${qs({ page: page + 1 })}">Older →</a>` : ''}</nav>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(qs({ q: e.target.q.value.trim() })); };
    },
  };
}

async function detail(ctx, id) {
  const d = await db.rpc('admin_order', { p_order_id: id });
  if (!d) return { title: 'Order not found', html: '<p class="cc-empty">Order not found.</p>' };
  const o = d.order, a = o.shipping_address || {}, c = d.customer;
  // artwork previews (private buckets; staff with orders.read may sign them)
  const mockPaths = d.items.flatMap(i => Object.values(i.design?.version_mockups || i.design?.mockups || {}));
  const prodPaths = d.items.flatMap(i => Object.values(i.design?.production_files || {}));
  const [mocks, prods] = await Promise.all([storage.sign('mockups', mockPaths).catch(() => ({})), storage.sign('designs', prodPaths).catch(() => ({}))]);
  const closed = ['cancelled', 'refunded', 'failed'].includes(o.status);
  const shipped = ['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'returned'].includes(o.status);
  const refundable = o.paid_at ? o.total_cents - d.refunded_cents : 0;
  const can = d.can;

  const actions = [
    can.write ? '<button class="cc-btn" data-act="note">Add note</button>' : '',
    can.write && !closed && !shipped && o.status !== 'on_hold' && o.status !== 'payment_pending' ? '<button class="cc-btn" data-act="hold">Put on hold</button>' : '',
    can.write && o.status === 'on_hold' && o.paid_at ? '<button class="cc-btn cc-btn--primary" data-act="resume">Release hold</button>' : '',
    can.write && !closed && !shipped ? '<button class="cc-btn cc-btn--danger" data-act="cancel">Cancel order</button>' : '',
    can.refund && refundable > 0 ? `<button class="cc-btn" data-act="refund">Refund…</button>` : '',
  ].join('');

  return {
    title: `Order ${o.number}`,
    html: `<p class="cc-crumbs"><a href="/admin/orders">Orders</a> / ${esc(o.number)}</p>
      <header class="cc-head"><div><h1>${esc(o.number)} ${pill(o.status)}</h1>
        <p class="cc-muted">Placed ${dateTime(o.created_at)}${o.paid_at ? ` · paid ${dateTime(o.paid_at)} via ${esc(o.payment_provider || '—')}` : ' · not paid'}${o.payment_provider === 'mock' ? ' <span class="cc-tag">test payment</span>' : ''}</p></div>
        <div class="cc-actions">${actions}</div></header>
      ${o.status === 'on_hold' ? `<div class="cc-alert cc-alert--bad"><strong>On hold.</strong> ${esc([...d.events].reverse().find(e => e.status === 'on_hold')?.note || 'Needs attention.')}</div>` : ''}
      ${o.status === 'cancelled' && refundable > 0 ? `<div class="cc-alert cc-alert--warn"><strong>Cancelled but not refunded.</strong> ${money(refundable)} is still to be refunded.</div>` : ''}
      <div class="cc-two cc-two--wide">
        <div>
          <section class="cc-card"><h2>Items</h2>
            <ul class="cc-items">${d.items.map(i => itemHTML(i, mocks, prods)).join('')}</ul>
            <dl class="cc-totals">
              <dt>Subtotal</dt><dd>${money(o.subtotal_cents)}</dd>
              ${o.discount_cents ? `<dt>Discount ${esc(o.discount_code || '')}</dt><dd>−${money(o.discount_cents)}</dd>` : ''}
              <dt>${esc(o.shipping_rate?.label || 'Shipping')}</dt><dd>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</dd>
              ${(o.tax_lines || []).map(t => `<dt>${esc(t.label)}</dt><dd>${money(t.amount_cents)}</dd>`).join('')}
              <dt class="is-total">Total</dt><dd class="is-total">${money(o.total_cents)}</dd>
              ${d.refunded_cents ? `<dt>Refunded</dt><dd>−${money(d.refunded_cents)}</dd>` : ''}
            </dl></section>
          <section class="cc-card"><h2>History</h2>
            <ol class="cc-timeline">${[...d.events].reverse().map(e => `<li class="cc-tl-${esc(e.actor_type)}">
              <div><strong>${esc(eventTitle(e))}</strong>${e.status && e.event !== 'note' ? ' ' + pill(e.status) : ''}
                ${e.note ? `<p>${esc(e.note)}</p>` : ''}</div>
              <span class="cc-muted cc-small">${dateTime(e.at)} · ${esc(e.actor || label(e.actor_type))}</span></li>`).join('')}</ol>
            <p class="cc-muted cc-small">History is append-only: entries can't be edited or deleted.</p></section>
        </div>
        <div>
          <section class="cc-card"><h2>Customer</h2>
            <p><strong>${esc(c.profile?.full_name || a.full_name || '')}</strong><br><a href="mailto:${esc(o.email)}">${esc(o.email)}</a>${o.phone ? `<br>${esc(o.phone)}` : ''}</p>
            <p class="cc-muted">${num(c.orders)} paid order${c.orders === 1 ? '' : 's'} · ${money(c.spent_cents)} lifetime${c.profile ? ` · customer since ${date(c.profile.created_at)}` : ' · guest'}</p>
            ${c.profile ? `<a class="cc-btn cc-btn--small" href="/admin/customers?q=${encodeURIComponent(o.email)}">Customer record</a>` : ''}</section>
          <section class="cc-card"><h2>Shipping</h2>
            <address>${esc(a.full_name)}<br>${esc(a.line1)}${a.line2 ? '<br>' + esc(a.line2) : ''}<br>${esc(a.city)}, ${esc(a.province)} ${esc(a.postal_code)}</address>
            <p class="cc-muted">${esc(o.shipping_rate?.label || '')}${o.shipping_rate ? ` · ${o.shipping_rate.min_days}–${o.shipping_rate.max_days} business days` : ''}</p>
            <p class="cc-muted cc-small">Carrier, tracking and the production partner appear here once fulfillment partners are connected (Phase 7).</p></section>
          <section class="cc-card"><h2>Payments</h2>${table(d.payments, [
            { label: 'Type', render: p => label(p.kind) }, { key: 'provider', label: 'Provider' },
            { label: 'Amount', align: 'right', render: p => (p.kind === 'refund' ? '−' : '') + money(p.amount_cents) }, { label: 'When', render: p => dateTime(p.at) },
            { label: 'Reference', render: p => `<code class="cc-small">${esc(p.ref)}</code>` }], { empty: 'No payments yet.' })}</section>
        </div>
      </div>`,
    mount(root) {
      const reload = () => ctx.go(location.pathname);
      const call = async (fn, args, ok) => {
        try { const r = await db.rpc(fn, args); toast(ok(r)); reload(); }
        catch (e) { toast(errorText(e), 'bad'); }
      };
      root.querySelector('.cc-actions')?.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'note') {
          const r = await confirmDialog({ title: 'Add a note', note: true, noteLabel: 'Internal note (staff only)', noteRequired: true, confirm: 'Add note' });
          if (r.ok) call('admin_order_note', { p_order_id: o.id, p_note: r.note }, () => 'Note added.');
        } else if (act === 'hold') {
          const r = await confirmDialog({ title: `Put ${o.number} on hold?`, body: '<p>Production stops until someone releases it.</p>', note: true, noteLabel: 'Reason', noteRequired: true, confirm: 'Put on hold', tone: 'danger' });
          if (r.ok) call('admin_order_hold', { p_order_id: o.id, p_note: r.note }, () => 'Order is on hold.');
        } else if (act === 'resume') {
          const r = await confirmDialog({ title: 'Release the hold?', body: '<p>The order goes back to where it was before the hold.</p>', note: true, noteLabel: 'Note (optional)', confirm: 'Release hold' });
          if (r.ok) call('admin_order_resume', { p_order_id: o.id, p_note: r.note || null }, (s) => `Order resumed (${label(s)}).`);
        } else if (act === 'cancel') {
          const paid = !!o.paid_at;
          const r = await confirmDialog({ title: `Cancel ${o.number}?`, tone: 'danger', confirm: 'Cancel order',
            body: `<p>${paid ? `The customer paid ${money(o.total_cents)}. Cancelling doesn't refund automatically — refund after cancelling.` : 'This order was never paid.'}</p>
                   ${d.items.some(i => i.edition_numbers?.length) ? '<p>Limited edition numbers already issued stay retired; they are never re-issued.</p>' : ''}`,
            note: true, noteLabel: 'Reason (kept in the order history)', noteRequired: true,
            checkbox: paid ? { label: 'Return the items to stock', checked: true } : null });
          if (r.ok) call('admin_order_cancel', { p_order_id: o.id, p_note: r.note, p_restock: r.checked ?? true },
            (x) => `Cancelled.${x.restocked ? ` ${x.restocked} item(s) back in stock.` : ''}${x.refund_due_cents ? ` ${money(x.refund_due_cents)} still to refund.` : ''}`);
        } else if (act === 'refund') {
          const r = await confirmDialog({ title: `Refund ${o.number}`, confirm: 'Refund', tone: 'danger',
            body: `<p>Money goes back to the customer's original payment method${o.payment_provider === 'mock' ? ' (test provider: no real money moves)' : ''}. Up to ${money(refundable)} can be refunded.</p>`,
            amount: { label: 'Amount (CAD)', value: refundable, max: refundable }, note: true, noteLabel: 'Reason', noteRequired: true });
          if (!r.ok) return;
          try {
            const res = await fetch('/api/admin-refund', { method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.session.access_token}` },
              body: JSON.stringify({ order_id: o.id, amount_cents: r.amount, note: r.note, key: crypto.randomUUID() + crypto.randomUUID() }) });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(out.error || 'Refund failed.');
            toast(`Refunded ${money(r.amount)}${out.test_mode ? ' (test)' : ''}.`); reload();
          } catch (err) { toast(errorText(err), 'bad'); }
        }
      });
    },
  };
}

function itemHTML(i, mocks, prods) {
  const d = i.design;
  const mock = d && Object.values(d.version_mockups || d.mockups || {})[0];
  const files = d ? Object.entries(d.production_files || {}) : [];
  return `<li class="cc-item">
    <div class="cc-item-thumb">${mock && mocks[mock] ? `<img src="${mocks[mock]}" alt="Mockup of ${esc(i.name)}">` : `<span style="background:${esc(i.color_hex || '#ccc')}"></span>`}</div>
    <div class="cc-item-info">
      <strong>${esc(i.name)}</strong> <span class="cc-muted">× ${i.quantity}</span>
      <div class="cc-muted cc-small">${esc([i.color, i.size, i.sku].filter(Boolean).join(' · '))}</div>
      ${i.edition_numbers?.length ? `<div class="cc-small">Edition ${i.edition_numbers.map(n => `No. ${String(n).padStart(3, '0')} / ${i.edition_size}`).join(', ')}</div>` : ''}
      ${d ? `<div class="cc-small">Custom design “${esc(d.name)}” v${i.design_version} · ${pill(d.approved_version === i.design_version ? 'approved' : d.status)}
          ${d.moderation ? ` · automated risk ${d.moderation.risk_score}/100` : ''}
          · <a href="/admin/designs?id=${i.design_id}">moderation</a></div>
        ${(d.print || []).length ? `<div class="cc-small cc-muted">${d.print.map(p => `${esc(p.placement_label || p.placement)} ${esc(p.area_label?.split(' (')[0] || '')} ${esc(p.method_label || '')}`).join(' + ')}</div>` : ''}
        ${files.length ? `<div class="cc-small">Print files: ${files.map(([k, p]) => prods[p] ? `<a href="${prods[p]}" target="_blank" rel="noopener">${esc(label(k))}</a>` : esc(label(k))).join(' · ')}</div>` : ''}` : ''}
      ${i.costs?.cost ? `<div class="cc-small cc-muted">Production cost ${money(i.costs.cost.unit_cents)}/item${i.costs.margin_pct != null ? ` · est. margin ${i.costs.margin_pct}% (${money(i.costs.margin_cents)})` : ''}</div>` : ''}
    </div>
    <div class="cc-item-price">${money(i.line_total_cents)}${i.discount_cents ? `<br><span class="cc-muted cc-small">−${money(i.discount_cents)} disc.</span>` : ''}</div></li>`;
}

function eventTitle(e) {
  const t = { order_created: 'Order created', status_changed: `Status: ${label(e.status)}`, stock_reserved: 'Stock reserved', note: 'Staff note', refund: `Refund ${money(e.data?.amount_cents)}` };
  return t[e.event] || label(e.event);
}
