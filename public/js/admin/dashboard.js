// Dashboard: live numbers from admin_dashboard().
import { db } from '../lib/supabase.js';
import { esc, money, num, kpi, table, pill, dateTime, bindRowLinks } from './ui.js';

export async function view(ctx) {
  const days = [7, 30, 90].includes(Number(ctx.query.get('days'))) ? Number(ctx.query.get('days')) : 30;
  const d = await db.rpc('admin_dashboard', { p_days: days });
  const range = `<div class="ad-seg" role="group" aria-label="Period">${[7, 30, 90].map(n =>
    `<a href="/admin?days=${n}"${n === days ? ' aria-current="true"' : ''}>${n} days</a>`).join('')}</div>`;
  const conv = d.conversion == null ? '—' : `${d.conversion}%`;
  return {
    title: 'Dashboard',
    html: `<header class="ad-head"><div><h1>Dashboard</h1><p class="ad-muted">Last ${days} days · live from the database</p></div>${range}</header>
      <section class="ad-kpis">
        ${kpi('Revenue', money(d.revenue_cents), d.refunded_cents ? `${money(d.gross_cents)} gross · ${money(d.refunded_cents)} refunded` : 'after refunds')}
        ${kpi('Orders', num(d.orders), `${num(d.customers)} customers`, '/admin/orders')}
        ${kpi('Average order', money(d.aov_cents))}
        ${kpi('Visitors', num(d.visitors), `conversion ${conv}`)}
      </section>
      <section class="ad-card">
        <div class="ad-card-head"><h2>Revenue per day</h2>
          <button class="ad-btn ad-btn--small" data-toggle-table aria-pressed="false">Show as table</button></div>
        <div data-chart>${chart(d.daily || [])}</div>
        <div data-chart-table hidden>${table([...(d.daily || [])].reverse(), [
          { key: 'day', label: 'Day' }, { label: 'Orders', align: 'right', render: r => num(r.orders) },
          { label: 'Revenue', align: 'right', render: r => money(r.revenue_cents) }])}</div>
      </section>
      <section class="ad-kpis ad-kpis--small">
        ${kpi('Needs action', num(d.pending), `${num(d.on_hold)} on hold`, '/admin/orders?group=pending')}
        ${kpi('In production', num(d.production), '', '/admin/orders?group=production')}
        ${kpi('Shipped', num(d.shipped), '', '/admin/orders?group=shipped')}
        ${kpi('Delivered', num(d.delivered), '', '/admin/orders?group=delivered')}
        ${kpi('Backorders', num(d.backordered), '', '/admin/orders?group=backorders')}
        ${kpi('Refunds', num(d.refunds), `last ${days} days`, '/admin/orders?group=refunds')}
        ${kpi('Pending moderation', num(d.pending_moderation), '', '/admin/designs')}
        ${kpi('Open quotes', num(d.open_quotes), '', '/admin/quotes')}
        ${kpi('Active products', num(d.active_products), '', '/admin/products?status=active')}
        ${kpi('Low stock', num(d.low_stock), 'variants at or under threshold', '/admin/inventory?low=1')}
        ${kpi('Limited drops', num(d.live_drops), `${num(d.upcoming_drops)} upcoming`, '/admin/drops')}
        ${kpi('Archived drops', num(d.archived_drops), '', '/admin/products?status=archived')}
      </section>
      <div class="ad-two">
        <section class="ad-card"><h2>Latest orders</h2>${table(d.recent, [
          { key: 'number', label: 'Order', render: r => `<strong>${esc(r.number)}</strong>` },
          { key: 'email', label: 'Customer' }, { label: 'Status', render: r => pill(r.status) },
          { label: 'Total', align: 'right', render: r => money(r.total_cents) }, { label: 'Placed', render: r => dateTime(r.created_at) }],
          { empty: 'No orders yet.', rowHref: r => `/admin/orders/${r.id}` })}</section>
        <section class="ad-card"><h2>Best sellers</h2>${table(d.top_products, [
          { key: 'name', label: 'Product' }, { label: 'Units', align: 'right', render: r => num(r.units) },
          { label: 'Revenue', align: 'right', render: r => money(r.revenue_cents) }], { empty: `No sales in the last ${days} days.` })}
          <p class="ad-muted ad-small">Partner performance appears here once fulfillment partners are set up (Phase 7).</p></section>
      </div>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      const btn = root.querySelector('[data-toggle-table]');
      btn.onclick = () => {
        const t = root.querySelector('[data-chart-table]'), show = t.hidden;
        t.hidden = !show; root.querySelector('[data-chart]').hidden = show;
        btn.setAttribute('aria-pressed', show); btn.textContent = show ? 'Show as chart' : 'Show as table';
      };
      const tip = root.querySelector('.ad-chart-tip');
      root.querySelectorAll('.ad-bar-hit').forEach(h => {
        const show = () => {
          tip.hidden = false;
          tip.innerHTML = `<strong>${esc(h.dataset.day)}</strong><br>${h.dataset.rev} · ${h.dataset.orders} orders`;
          const r = h.getBoundingClientRect(), p = tip.parentElement.getBoundingClientRect();
          tip.style.left = `${Math.min(p.width - 150, Math.max(0, r.left - p.left + r.width / 2 - 70))}px`;
          tip.style.top = '4px';
          root.querySelectorAll('.ad-bar').forEach(b => b.classList.toggle('is-hot', b.dataset.i === h.dataset.i));
        };
        h.addEventListener('mouseenter', show); h.addEventListener('focus', show);
        h.addEventListener('mouseleave', () => { tip.hidden = true; root.querySelectorAll('.ad-bar').forEach(b => b.classList.remove('is-hot')); });
      });
    },
  };
}

// One series, one hue; thin bars with rounded tops on a quiet baseline.
function chart(rows) {
  if (!rows.length) return '<p class="ad-empty">No data.</p>';
  const W = 800, H = 200, pad = { l: 56, r: 8, t: 28, b: 24 };
  const max = Math.max(1, ...rows.map(r => r.revenue_cents));
  const nice = niceMax(max), iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const step = iw / rows.length, bw = Math.max(2, Math.min(18, step - 2));
  const y = (v) => pad.t + ih - (v / nice) * ih;
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(rows.length / 8);
  return `<div class="ad-chart"><div class="ad-chart-tip" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day, ${rows.length} days. Peak ${money(max)}.">
      ${ticks.map(t => `<line class="ad-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="ad-axis" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${money(t).replace(/\.00$/, '')}</text>`).join('')}
      ${rows.map((r, i) => {
        const x = pad.l + i * step + (step - bw) / 2, h = Math.max(0, ih - (y(r.revenue_cents) - pad.t));
        const rx = Math.min(4, bw / 2, h / 2);
        return `${h > 0 ? `<path class="ad-bar" data-i="${i}" d="M${x},${pad.t + ih}V${pad.t + ih - h + rx}q0,-${rx} ${rx},-${rx}h${bw - 2 * rx}q${rx},0 ${rx},${rx}V${pad.t + ih}Z"/>` : ''}
          <rect class="ad-bar-hit" data-i="${i}" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${ih}" tabindex="0"
            data-day="${r.day}" data-rev="${money(r.revenue_cents)}" data-orders="${r.orders}" aria-label="${r.day}: ${money(r.revenue_cents)}, ${r.orders} orders"/>
          ${i % labelEvery === 0 ? `<text class="ad-axis" x="${pad.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${r.day.slice(5)}</text>` : ''}`;
      }).join('')}
      <line class="ad-baseline" x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>
    </svg></div>`;
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
