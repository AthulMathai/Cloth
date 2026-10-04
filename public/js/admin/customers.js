// CRM: customer list with segments, the customer profile (orders, value,
// designs, wishlist, bag, support, notes, tags, activity), abandoned bags.
// Every figure is computed by the database from orders and payments.
import { db } from '../lib/supabase.js';
import { esc, money, num, pill, table, date, dateTime, label, toast, confirmDialog, kpi, errorText, bindRowLinks } from './ui.js';

export const SEGMENTS = [
  ['', 'All'], ['new', 'New'], ['returning', 'Returning'], ['high_value', 'High value'], ['inactive', 'Inactive'],
  ['custom_design', 'Custom design'], ['collector', 'Limited collectors'], ['abandoned_cart', 'Abandoned bag'],
  ['subscribed', 'Email opt-in'], ['prospect', 'No orders yet'],
];
const SEG_LABEL = Object.fromEntries(SEGMENTS.filter(s => s[0]));
const SEG_TONE = { new: 'info', returning: 'good', high_value: 'good', inactive: 'warn', custom_design: 'info', collector: 'info',
  abandoned_cart: 'warn', subscribed: 'mute', prospect: 'mute' };
export const segPill = (s) => `<span class="cc-pill cc-pill--${SEG_TONE[s] || 'mute'}">${esc(SEG_LABEL[s] || label(s))}</span>`;
const SORTS = [['ltv', 'Lifetime value'], ['recent', 'Last purchase'], ['orders', 'Orders'], ['joined', 'Newest account'], ['name', 'Name']];
const PAGE = 100;

export async function view(ctx) {
  if (ctx.segs[1] === 'abandoned') return abandoned(ctx);
  if (ctx.segs[1]) return profile(ctx, ctx.segs[1]);
  return list(ctx);
}

async function list(ctx) {
  const q = ctx.query.get('q') || '', segment = ctx.query.get('segment') || '', sort = ctx.query.get('sort') || 'ltv';
  const page = Math.max(0, Number(ctx.query.get('page')) || 0);
  const r = await db.rpc('admin_crm_customers', { p_q: q || null, p_segment: segment || null, p_sort: sort, p_limit: PAGE, p_offset: page * PAGE });
  const qs = (o) => '/admin/customers?' + new URLSearchParams(Object.entries({ q, segment, sort, page: 0, ...o }).filter(([k, v]) => v !== '' && !(k === 'page' && !v) && !(k === 'sort' && v === 'ltv'))).toString();
  const st = r.settings, t = r.totals;
  return {
    title: 'Customers',
    html: `<header class="cc-head"><div><h1>Customers</h1><p class="cc-muted">${num(r.segments.all)} customer accounts (staff excluded)</p></div>
        <div class="cc-actions"><a class="cc-btn" href="/admin/customers/abandoned">Abandoned bags</a><button class="cc-btn" data-export>Export CSV</button></div></header>
      <div class="cc-kpis cc-kpis--small">
        ${kpi('Lifetime value (all)', money(t.ltv_cents), 'paid orders minus refunds')}
        ${kpi('Avg. lifetime value', money(t.avg_ltv_cents), 'per buying customer')}
        ${kpi('Repeat rate', t.repeat_rate != null ? `${t.repeat_rate}%` : '—', 'buyers with 2+ orders')}
        ${kpi('High value', num(r.segments.high_value), `≥ ${money(st.high_value_cents)} lifetime`, qs({ segment: 'high_value' }))}
        ${kpi('Inactive', num(r.segments.inactive), `no order in ${st.inactive_days} days`, qs({ segment: 'inactive' }))}
        ${kpi('Abandoned bags', num(r.segments.abandoned_cart), `untouched ${st.abandoned_hours}h+`, '/admin/customers/abandoned')}
      </div>
      <nav class="cc-tabs">${SEGMENTS.map(([s, l]) => `<a href="${qs({ segment: s })}"${s === segment ? ' aria-current="true"' : ''}>${esc(l)} <span class="crm-count">${num(s ? r.segments[s] : r.segments.all)}</span></a>`).join('')}</nav>
      <form class="cc-search crm-filters" data-search role="search">
        <input name="q" value="${esc(q)}" placeholder="Name, email, phone or tag" aria-label="Search customers">
        <select name="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === sort ? ' selected' : ''}>Sort: ${l}</option>`).join('')}</select>
        <button class="cc-btn">Apply</button></form>
      <section class="cc-card cc-card--flush">${table(r.rows, [
        { label: 'Customer', render: c => `<a href="/admin/customers/${c.user_id}"><strong>${esc(c.full_name || c.email)}</strong></a><br><span class="cc-muted cc-small">${esc(c.full_name ? c.email : '')}${c.province ? ` · ${esc(c.province)}` : ''}</span>` },
        { label: 'Segments', render: c => (c.segments || []).filter(s => s !== 'subscribed').map(segPill).join(' ') + (c.tags || []).map(x => ` <span class="cc-tag">#${esc(x)}</span>`).join('') },
        { label: 'Orders', align: 'right', render: c => num(c.orders) },
        { label: 'Lifetime value', align: 'right', render: c => `<strong>${money(c.ltv_cents)}</strong>${c.refunded_cents ? `<br><span class="cc-muted cc-small">−${money(c.refunded_cents)} refunded</span>` : ''}` },
        { label: 'AOV', align: 'right', render: c => c.orders ? money(c.aov_cents) : '—' },
        { label: 'Last order', render: c => date(c.last_order_at) },
        { label: 'Support', align: 'right', render: c => c.open_tickets ? `<span class="cc-pill cc-pill--warn">${c.open_tickets} open</span>` : (c.tickets ? num(c.tickets) : '') },
        { label: 'Email', render: c => c.marketing_opt_in ? 'Opted in' : '—' },
        { label: 'Joined', render: c => date(c.created_at) }],
        { empty: q || segment ? 'No customers match.' : 'No customer accounts yet.', rowHref: c => `/admin/customers/${c.user_id}` })}</section>
      <nav class="cc-pager">${page > 0 ? `<a class="cc-btn" href="${qs({ page: page - 1 })}">← Previous</a>` : ''}
        ${(page + 1) * PAGE < r.total ? `<a class="cc-btn" href="${qs({ page: page + 1 })}">Next →</a>` : ''}</nav>
      <details class="cc-card crm-rules"><summary><strong>How segments work</strong></summary>
        <ul class="cc-small">
          <li><b>New</b> — first and only paid order within ${st.new_days} days. <b>Returning</b> — 2+ paid orders.</li>
          <li><b>High value</b> — lifetime value (paid orders minus refunds) of ${money(st.high_value_cents)} or more.</li>
          <li><b>Inactive</b> — has bought before, nothing in ${st.inactive_days} days. <b>Custom design</b> — bought or submitted a custom design.</li>
          <li><b>Limited collectors</b> — bought a limited drop. <b>Abandoned bag</b> — bag untouched for ${st.abandoned_hours}+ hours. <b>Email opt-in</b> — agreed to marketing emails.</li>
        </ul>
        ${ctx.can('settings.write') ? `<form class="crm-settings" data-settings>
          <label class="cc-field"><span>High value from ($)</span><input name="hv" type="number" min="1" step="1" value="${st.high_value_cents / 100}"></label>
          <label class="cc-field"><span>Inactive after (days)</span><input name="inact" type="number" min="7" step="1" value="${st.inactive_days}"></label>
          <label class="cc-field"><span>“New” window (days)</span><input name="newd" type="number" min="1" step="1" value="${st.new_days}"></label>
          <label class="cc-field"><span>Abandoned after (hours)</span><input name="ab" type="number" min="1" step="1" value="${st.abandoned_hours}"></label>
          <button class="cc-btn">Save rules</button></form>` : ''}
      </details>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(qs({ q: e.target.q.value.trim(), sort: e.target.sort.value })); };
      root.querySelector('[data-export]').onclick = async () => {
        try {
          const all = await db.rpc('admin_crm_customers', { p_q: q || null, p_segment: segment || null, p_sort: sort, p_limit: 1000, p_offset: 0 });
          const cols = ['email', 'full_name', 'phone', 'province', 'orders', 'units', 'ltv_cents', 'refunded_cents', 'aov_cents', 'first_order_at', 'last_order_at',
            'custom_orders', 'limited_orders', 'designs', 'wishlist', 'tickets', 'marketing_opt_in', 'segments', 'tags', 'created_at'];
          const cell = (v) => { const s = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
          const csv = [cols.join(','), ...all.rows.map(c => cols.map(k => cell(k.endsWith('_cents') ? (c[k] / 100).toFixed(2) : c[k])).join(','))].join('\n');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
          a.download = `customers${segment ? '-' + segment : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch (e) { toast(errorText(e), 'bad'); }
      };
      root.querySelector('[data-settings]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const vals = { 'crm.high_value_cents': Math.round(Number(f.hv.value) * 100), 'crm.inactive_days': Math.round(Number(f.inact.value)),
                       'crm.new_days': Math.round(Number(f.newd.value)), 'crm.abandoned_hours': Math.round(Number(f.ab.value)) };
        if (Object.values(vals).some(v => !Number.isFinite(v) || v < 1)) { toast('Enter whole numbers above zero.', 'bad'); return; }
        try { for (const [key, value] of Object.entries(vals)) await db.update('store_settings', { key }, { value }); toast('Segment rules saved.'); ctx.go(location.pathname + location.search); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}

const ACTIVITY = { page_view: 'Viewed', product_view: 'Viewed product', collection_view: 'Viewed collection', search: 'Searched', add_to_cart: 'Added to bag',
  remove_from_cart: 'Removed from bag', checkout_started: 'Started checkout', purchase: 'Purchased', custom_design_started: 'Started a design',
  design_uploaded: 'Uploaded artwork', design_saved: 'Saved a design', design_approved: 'Design approved', design_rejected: 'Design rejected',
  limited_drop_viewed: 'Viewed a drop', limited_drop_purchase: 'Bought a limited piece', archive_viewed: 'Browsed the archive',
  support_ticket_opened: 'Contacted support', wishlist_add: 'Saved to wishlist' };

async function profile(ctx, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { title: 'Not found', html: '<p class="cc-empty">Customer not found.</p>' };
  const d = await db.rpc('admin_crm_customer', { p_user: id });
  if (!d) return { title: 'Not found', html: '<p class="cc-empty">Customer not found.</p>' };
  const c = d.customer, can = d.can, a = d.addresses[0];
  return {
    title: c.full_name || c.email,
    html: `<p class="cc-crumbs"><a href="/admin/customers">Customers</a> / ${esc(c.full_name || c.email)}</p>
      <header class="cc-head"><div><h1>${esc(c.full_name || c.email)} ${(c.segments || []).map(segPill).join(' ')}</h1>
        <p class="cc-muted"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>${c.phone ? ` · ${esc(c.phone)}` : ''}${a ? ` · ${esc(a.city)}, ${esc(a.province)}` : c.province ? ` · ${esc(c.province)}` : ''}
          · customer since ${date(c.created_at)}${d.roles.length ? ` · <span class="cc-tag">staff: ${d.roles.map(esc).join(', ')}</span>` : ''}</p></div>
        <div class="cc-actions">${can.support ? '<button class="cc-btn" data-new-ticket>Log a contact…</button>' : ''}
          ${can.orders ? `<a class="cc-btn" href="/admin/orders?q=${encodeURIComponent(c.email)}">Orders</a>` : ''}</div></header>
      <div class="cc-kpis cc-kpis--small">
        ${kpi('Lifetime value', money(c.ltv_cents), c.refunded_cents ? `${money(c.gross_cents)} paid − ${money(c.refunded_cents)} refunded` : 'paid orders')}
        ${kpi('Orders', num(c.orders), `${num(c.units)} items`)}
        ${kpi('Average order', c.orders ? money(c.aov_cents) : '—')}
        ${kpi('Last purchase', c.last_order_at ? date(c.last_order_at) : '—', c.first_order_at ? `first ${date(c.first_order_at)}` : 'no purchases yet')}
        ${kpi('Refunds / returns', `${num(c.refunds)} / ${num(c.returns)}`)}
        ${kpi('Custom designs', num(c.designs), `${num(c.custom_orders)} ordered`)}
      </div>
      <div class="cc-two cc-two--wide">
        <div>
          <section class="cc-card cc-card--flush"><div class="cc-card-head ff-pad"><h2>Orders</h2></div>${table(d.orders, [
            { label: 'Order', render: o => can.orders ? `<a href="/admin/orders/${o.id}"><strong>${esc(o.number)}</strong></a>` : esc(o.number) },
            { label: 'Items', render: o => `<span class="cc-small">${esc(o.summary || '')}</span>` },
            { label: 'Status', render: o => pill(o.status) },
            { label: 'Total', align: 'right', render: o => money(o.total_cents) + (o.refunded_cents ? `<br><span class="cc-small cc-muted">−${money(o.refunded_cents)}</span>` : '') },
            { label: 'Placed', render: o => date(o.created_at) }], { empty: 'No orders yet.' })}</section>
          <section class="cc-card"><div class="cc-card-head"><h2>Support</h2>${can.support ? '<a class="cc-btn cc-btn--small" href="/admin/support">Support desk</a>' : ''}</div>
            ${d.tickets.length ? `<ul class="crm-list">${d.tickets.map(t => `<li><a href="/admin/support/${t.id}"><strong>${esc(t.number)}</strong> ${esc(t.subject)}</a> ${ticketPill(t.status)}
              <span class="cc-small cc-muted">${dateTime(t.last_message_at)}</span></li>`).join('')}</ul>` : '<p class="cc-muted">No support requests.</p>'}</section>
          <section class="cc-card"><h2>Activity</h2>
            ${d.activity.length ? `<ul class="crm-activity">${d.activity.map(e => `<li><span>${esc(ACTIVITY[e.type] || label(e.type))}${e.properties?.number ? ` ${esc(e.properties.number)}` : ''}${e.path && e.type === 'page_view' ? ` <code class="cc-small">${esc(e.path)}</code>` : ''}</span>
              <time class="cc-small cc-muted">${dateTime(e.at)}</time></li>`).join('')}</ul>` : '<p class="cc-muted">No tracked activity yet.</p>'}</section>
        </div>
        <div>
          <section class="cc-card"><h2>Tags</h2>
            <p>${c.tags.length ? c.tags.map(x => `<span class="cc-tag">#${esc(x)}</span>`).join(' ') : '<span class="cc-muted">No tags.</span>'}</p>
            ${can.write ? `<form class="ff-inline" data-tags><input name="tags" value="${esc(c.tags.join(', '))}" placeholder="vip, wholesale, influencer" aria-label="Tags"><button class="cc-btn">Save tags</button></form>` : ''}</section>
          <section class="cc-card"><h2>Notes</h2>
            ${can.write ? `<form class="crm-note-form" data-note><textarea name="body" rows="2" placeholder="Staff-only note about this customer" aria-label="New note"></textarea><button class="cc-btn cc-btn--small">Add note</button></form>` : ''}
            ${d.notes.length ? `<ul class="crm-notes">${d.notes.map(n => `<li><p>${esc(n.body)}</p><span class="cc-small cc-muted">${esc(n.author || 'Staff')} · ${dateTime(n.at)}</span></li>`).join('')}</ul>` : '<p class="cc-muted cc-small">No notes yet. Notes are kept permanently.</p>'}</section>
          <section class="cc-card"><h2>Marketing</h2>
            <p>${c.marketing_opt_in ? pill('active', 'Opted in to emails') : pill('mute', 'Not opted in')}</p>
            ${d.newsletter ? `<p class="cc-small cc-muted">Newsletter: ${d.newsletter.unsubscribed_at ? `unsubscribed ${date(d.newsletter.unsubscribed_at)}` : `subscribed ${date(d.newsletter.subscribed_at)} (${esc(d.newsletter.source || 'site')})`}</p>` : ''}
            ${d.top_categories.length ? `<p class="cc-small">Favourite categories: ${d.top_categories.map(t => `${esc(t.name)} (${t.units})`).join(', ')}</p>` : ''}</section>
          ${d.cart ? `<section class="cc-card"><h2>${c.abandoned_cart_cents != null ? 'Abandoned bag' : 'Bag right now'}</h2>
            <ul class="crm-list">${d.cart.items.map(i => `<li><span>${esc(i.name)} <span class="cc-muted cc-small">${esc(i.variant || '')} × ${i.quantity}</span></span> <span>${money(i.line_cents)}</span></li>`).join('')}</ul>
            <p class="cc-small cc-muted">Last touched ${dateTime(d.cart.updated_at)}</p></section>` : ''}
          <section class="cc-card"><h2>Wishlist <span class="cc-muted">${num(d.wishlist.length)}</span></h2>
            ${d.wishlist.length ? `<ul class="crm-list">${d.wishlist.map(w => `<li><a href="/${w.kind === 'product' ? 'product' : 'collections'}/${esc(w.slug)}" target="_blank" rel="noopener">${esc(w.name)}</a>${w.status && w.status !== 'active' ? ' ' + pill(w.status) : ''}</li>`).join('')}</ul>` : '<p class="cc-muted">Empty.</p>'}</section>
          <section class="cc-card"><h2>Saved designs <span class="cc-muted">${num(c.designs)}</span></h2>
            ${d.designs.length ? `<ul class="crm-list">${d.designs.map(x => `<li><a href="/admin/designs?id=${x.id}">${esc(x.name || 'Untitled')}</a> <span>v${x.version} ${pill(x.status)}</span></li>`).join('')}</ul>` : '<p class="cc-muted">None.</p>'}</section>
          <section class="cc-card"><h2>Addresses</h2>
            ${d.addresses.length ? d.addresses.map(x => `<address class="crm-addr">${esc(x.full_name)}<br>${esc(x.line1)}${x.line2 ? '<br>' + esc(x.line2) : ''}<br>${esc(x.city)}, ${esc(x.province)} ${esc(x.postal_code)}${x.is_default ? ' <span class="cc-tag">default</span>' : ''}</address>`).join('') : '<p class="cc-muted">No saved addresses.</p>'}</section>
        </div>
      </div>`,
    mount(root) {
      const reload = () => ctx.go(location.pathname);
      root.querySelector('[data-tags]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await db.rpc('admin_crm_tags', { p_user: id, p_tags: e.target.tags.value.split(',').map(s => s.trim()).filter(Boolean) }); toast('Tags saved.'); reload(); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
      root.querySelector('[data-note]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await db.rpc('admin_crm_note', { p_user: id, p_body: e.target.body.value }); toast('Note added.'); reload(); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
      root.querySelector('[data-new-ticket]')?.addEventListener('click', async () => {
        const r = await confirmDialog({ title: 'Log a contact', body: '<p>Record a phone call or email as a support request on this customer. Your note stays internal.</p>',
          note: true, noteLabel: 'What was it about? (first line becomes the subject)', noteRequired: true, confirm: 'Create request' });
        if (!r.ok) return;
        const subject = r.note.split('\n')[0].slice(0, 160);
        try {
          const t = await db.rpc('admin_support_open', { p_user: id, p_subject: subject.length >= 3 ? subject : `Contact: ${subject}`, p_category: 'general', p_body: r.note, p_channel: 'phone' });
          ctx.go(`/admin/support/${t.id}`);
        } catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}

export const TICKET_TONE = { open: 'warn', pending: 'info', waiting_customer: 'mute', resolved: 'good', closed: 'mute' };
export const TICKET_LABEL = { open: 'Open', pending: 'In progress', waiting_customer: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed' };
export const ticketPill = (s) => `<span class="cc-pill cc-pill--${TICKET_TONE[s] || 'mute'}">${esc(TICKET_LABEL[s] || label(s))}</span>`;

async function abandoned(ctx) {
  const rows = await db.rpc('admin_abandoned_carts', { p_limit: 300 });
  const total = rows.reduce((s, r) => s + (r.value_cents || 0), 0);
  return {
    title: 'Abandoned bags',
    html: `<p class="cc-crumbs"><a href="/admin/customers">Customers</a> / Abandoned bags</p>
      <header class="cc-head"><div><h1>Abandoned bags</h1><p class="cc-muted">${num(rows.length)} signed-in shoppers left ${money(total)} in their bags.</p></div></header>
      <p class="cc-note">Only contact people who opted in to emails. Automatic reminder emails need an email provider (not connected yet).</p>
      <section class="cc-card cc-card--flush">${table(rows, [
        { label: 'Customer', render: r => `<a href="/admin/customers/${r.user_id}"><strong>${esc(r.name || r.email)}</strong></a><br><span class="cc-muted cc-small">${esc(r.email)}</span>` },
        { label: 'In the bag', render: r => `<span class="cc-small">${esc(r.items || '')}</span>` },
        { label: 'Value', align: 'right', render: r => money(r.value_cents) },
        { label: 'Checkout', render: r => r.checkout_started ? pill('pending', 'Started, not paid') : '—' },
        { label: 'Emails', render: r => r.marketing_opt_in ? 'Opted in' : '—' },
        { label: 'Last touched', render: r => dateTime(r.updated_at) }], { empty: 'No abandoned bags right now.', rowHref: r => `/admin/customers/${r.user_id}` })}</section>`,
    mount(root) { bindRowLinks(root, ctx.go); },
  };
}
