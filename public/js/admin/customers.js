// Customers (basic list; full CRM — segments, support — is Phase 8).
import { db } from '../lib/supabase.js';
import { esc, money, num, table, date, label } from './ui.js';

export async function view(ctx) {
  const q = ctx.query.get('q') || '';
  const rows = await db.rpc('admin_customers', { p_q: q || null, p_limit: 200 });
  const segment = (c) => c.orders === 0 ? 'No orders yet' : c.orders === 1 ? 'New customer' : c.spent_cents >= 50000 ? 'High value' : 'Returning';
  return {
    title: 'Customers',
    html: `<header class="ad-head"><div><h1>Customers</h1><p class="ad-muted">${rows.length} accounts</p></div>
        <form class="ad-search" data-search role="search"><input name="q" value="${esc(q)}" placeholder="Name or email" aria-label="Search customers"><button class="ad-btn">Search</button></form></header>
      <p class="ad-note">Customer profiles, segments and support tickets are the CRM phase (8). This list already reads from live accounts and orders.</p>
      <section class="ad-card ad-card--flush">${table(rows, [
        { label: 'Customer', render: c => `<strong>${esc(c.full_name || '—')}</strong><br><span class="ad-muted ad-small">${esc(c.email)}</span>` },
        { label: 'Orders', align: 'right', render: c => num(c.orders) },
        { label: 'Spent', align: 'right', render: c => money(c.spent_cents) },
        { label: 'Last order', render: c => date(c.last_order_at) },
        { label: 'Designs', align: 'right', render: c => num(c.designs) },
        { label: 'Segment', render: c => esc(segment(c)) + (c.designs ? ' · custom' : '') },
        { label: 'Marketing', render: c => c.marketing_opt_in ? 'Opted in' : '—' },
        { label: 'Joined', render: c => date(c.created_at) },
        { label: '', render: c => (c.roles || []).map(r => `<span class="ad-tag">${esc(label(r))}</span>`).join(' ') + ` <a class="ad-btn ad-btn--small" href="/admin/orders?q=${encodeURIComponent(c.email)}">Orders</a>` }],
        { empty: q ? 'No customers match.' : 'No customer accounts yet.' })}</section>`,
    mount(root) {
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(`/admin/customers?q=${encodeURIComponent(e.target.q.value.trim())}`); };
    },
  };
}
