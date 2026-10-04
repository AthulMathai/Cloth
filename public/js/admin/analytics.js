// Analytics: sales, website, products, fulfillment and the custom
// designer. Every number comes from the report functions in the database
// (orders, payments, events, production orders, shipments); nothing is
// sampled or estimated except where a card says so.
import { db } from '../lib/supabase.js';
import { esc, money, num, table, dateTime, label, toast, errorText } from './ui.js';
import { timeSeries, barList, funnel } from './charts.js';

const TABS = [['sales', 'Sales'], ['website', 'Website'], ['products', 'Products'], ['fulfillment', 'Fulfillment'], ['designs', 'Custom designs'], ['forecast', 'Forecast']];
const WINDOWS = [[14, 'last 14 days'], [28, 'last 28 days'], [56, 'last 8 weeks'], [90, 'last 90 days']];
const RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months'],
  ['mtd', 'This month'], ['lastmonth', 'Last month'], ['ytd', 'Year to date'], ['custom', 'Custom…']];
const RPC = { sales: 'analytics_sales', website: 'analytics_website', products: 'analytics_products', fulfillment: 'analytics_fulfillment', designs: 'analytics_designs', forecast: 'analytics_forecast' };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
function resolveRange(q) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  const r = q.get('range') || '30d';
  let from, to = today;
  switch (r) {
    case '7d': from = back(6); break;
    case '90d': from = back(89); break;
    case '12m': from = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1); break;
    case 'mtd': from = new Date(today.getFullYear(), today.getMonth(), 1); break;
    case 'lastmonth': from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); break;
    case 'ytd': from = new Date(today.getFullYear(), 0, 1); break;
    case 'custom': {
      const f = q.get('from'), t = q.get('to');
      if (/^\d{4}-\d{2}-\d{2}$/.test(f || '') && /^\d{4}-\d{2}-\d{2}$/.test(t || '')) { from = parse(f); to = parse(t); }
      else from = back(29);
      if (to < from) [from, to] = [to, from];
      break;
    }
    default: from = back(29);
  }
  const days = Math.round((to - from) / 86400000) + 1;
  const g = q.get('grain');
  const grain = ['day', 'week', 'month'].includes(g) ? g : days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
  return { key: RANGES.some(x => x[0] === r) ? r : '30d', from: iso(from), to: iso(to), days, grain };
}

const xFmt = (grain) => (k, long) => {
  const d = parse(k);
  if (grain === 'month') return d.toLocaleDateString('en-CA', { month: long ? 'long' : 'short', year: 'numeric' });
  const s = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(long ? { weekday: 'short', year: 'numeric' } : {}) });
  return grain === 'week' ? `${long ? 'Week of ' : ''}${s}` : s;
};
const moneyShort = (c) => {
  const v = c / 100;
  return v >= 10000 ? `$${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k` : `$${Math.round(v).toLocaleString('en-CA')}`;
};
const pct = (v) => v == null ? '—' : `${v}%`;
const hours = (h) => h == null ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h} h`;

// KPI tile with a comparison to the previous period of equal length.
function stat(labelText, value, { now, prev, fmt = num, better = 'up', sub = '' } = {}) {
  let delta = '';
  if (now != null && prev != null) {
    if (prev === 0 && now === 0) delta = '<span class="an-delta">no change</span>';
    else if (prev === 0) delta = '<span class="an-delta">new — nothing in the previous period</span>';
    else {
      const ch = Math.round(((now - prev) / Math.abs(prev)) * 1000) / 10;
      const good = ch === 0 ? null : (ch > 0) === (better === 'up');
      delta = `<span class="an-delta ${good == null ? '' : good ? 'is-good' : 'is-bad'}"><span aria-hidden="true">${ch > 0 ? '▲' : ch < 0 ? '▼' : '■'}</span>
        ${ch > 0 ? '+' : ''}${ch}% <span class="cc-muted">vs ${esc(fmt(prev))}</span></span>`;
    }
  }
  return `<div class="cc-kpi"><span class="cc-kpi-label">${esc(labelText)}</span><strong>${value}</strong>${delta}${sub ? `<small>${sub}</small>` : ''}</div>`;
}

function card(title, body, { id, tableHtml, note, wide } = {}) {
  return `<section class="cc-card an-card${wide ? ' is-wide' : ''}"><div class="cc-card-head"><h2>${esc(title)}</h2>
      ${id ? `<button class="cc-btn cc-btn--small" data-table-toggle="${id}" aria-pressed="false">Table</button>` : ''}</div>
    ${id ? `<div data-chart="${id}"></div><div data-table="${id}" hidden>${tableHtml}</div>` : body}
    ${note ? `<p class="cc-small cc-muted">${note}</p>` : ''}</section>`;
}

export async function view(ctx) {
  const tab = TABS.some(t => t[0] === ctx.query.get('tab')) ? ctx.query.get('tab') : 'sales';
  const range = resolveRange(ctx.query);
  const isForecast = tab === 'forecast';
  const win = WINDOWS.some(w => String(w[0]) === ctx.query.get('window')) ? Number(ctx.query.get('window')) : 28;
  const args = isForecast ? { p_days: win } : { p_from: range.from, p_to: range.to };
  if (['sales', 'website', 'fulfillment'].includes(tab)) args.p_grain = range.grain;
  const d = await db.rpc(RPC[tab], args);
  const qs = (o) => '/admin/analytics?' + new URLSearchParams(Object.entries({ tab, range: range.key, ...(range.key === 'custom' ? { from: range.from, to: range.to } : {}),
    ...(ctx.query.get('grain') ? { grain: range.grain } : {}), ...o }).filter(([, v]) => v)).toString();
  const built = TAB_VIEWS[tab](d, range);
  const fmtRange = `${parse(range.from).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })} – ${parse(range.to).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return {
    title: `Analytics · ${TABS.find(t => t[0] === tab)[1]}`,
    html: `<header class="cc-head"><div><h1>Analytics</h1><p class="cc-muted">${isForecast ? `Projections from the sales pace over the ${esc(WINDOWS.find(w => w[0] === win)[1])}` : `${esc(fmtRange)} · ${num(range.days)} days · compared with the ${num(range.days)} days before`}</p></div>
        <div class="cc-actions"><button class="cc-btn" data-export>Export CSV</button></div></header>
      <form class="an-filters" data-filters>
        <nav class="cc-tabs" aria-label="Report">${TABS.map(([k, l]) => `<a href="${qs({ tab: k })}"${k === tab ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>
        ${isForecast ? `<label class="an-field"><span>Based on</span><select name="window">${WINDOWS.map(([k, l]) => `<option value="${k}"${k === win ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` : `<label class="an-field"><span>Period</span><select name="range">${RANGES.map(([k, l]) => `<option value="${k}"${k === range.key ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="an-custom"${range.key === 'custom' ? '' : ' hidden'}><input type="date" name="from" value="${range.from}" aria-label="From"> – <input type="date" name="to" value="${range.to}" aria-label="To">
          <button class="cc-btn cc-btn--small">Apply</button></span>`}
        ${['sales', 'website', 'fulfillment'].includes(tab) ? `<label class="an-field"><span>Group by</span><select name="grain">${['day', 'week', 'month'].map(g => `<option value="${g}"${g === range.grain ? ' selected' : ''}>${label(g)}</option>`).join('')}</select></label>` : ''}
      </form>
      <div class="an-body">${built.html}</div>`,
    mount(root) {
      const f = root.querySelector('[data-filters]');
      if (f.window) f.window.onchange = () => ctx.go(`/admin/analytics?tab=forecast&window=${f.window.value}`);
      if (f.range) f.range.onchange = () => {
        if (f.range.value === 'custom') { root.querySelector('.an-custom').hidden = false; return; }
        ctx.go(qs({ range: f.range.value, from: '', to: '' }));
      };
      f.onsubmit = (e) => { e.preventDefault(); if (f.from && f.from.value && f.to.value) ctx.go(qs({ range: 'custom', from: f.from.value, to: f.to.value })); };
      if (f.grain) f.grain.onchange = () => ctx.go(qs({ grain: f.grain.value }));
      root.querySelectorAll('[data-table-toggle]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.tableToggle, t = root.querySelector(`[data-table="${id}"]`), c = root.querySelector(`[data-chart="${id}"]`);
        const show = t.hidden; t.hidden = !show; c.hidden = show;
        b.setAttribute('aria-pressed', String(show)); b.textContent = show ? 'Chart' : 'Table';
      }));
      root.querySelector('[data-export]').onclick = () => {
        try { download(isForecast ? `forecast-${win}d.csv` : `${tab}-${range.from}-to-${range.to}.csv`, built.csv()); } catch (e) { toast(errorText(e), 'bad'); }
      };
      const cleanups = (built.charts || []).map(([id, opts]) => timeSeries(root.querySelector(`[data-chart="${id}"]`), opts));
      return () => cleanups.forEach(c => c());
    },
  };
}

function download(name, csv) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const toCsv = (cols, rows) => [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(([, f]) => {
  const v = f(r); const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(','))].join('\n');
const dollars = (c) => (c / 100).toFixed(2);

// ---------------------------------------------------------------------
const TAB_VIEWS = {
  forecast(d) {
    const soon = d.variants.filter(v => v.days_left != null && v.days_left <= 14);
    const reorder = d.variants.reduce((n, v) => n + (v.reorder || 0), 0);
    const dropsSoon = d.drops.filter(x => x.eta_hours != null && x.eta_hours <= 48);
    const blanksSoon = d.blanks.filter(b => b.days_left != null && b.days_left <= 14);
    const days = (v) => v == null ? '<span class="cc-muted">no recent sales</span>'
      : v <= 7 ? `<span class="cc-pill cc-pill--bad">${v} days</span>` : v <= 14 ? `<span class="cc-pill cc-pill--warn">${v} days</span>` : `${v} days`;
    const eta = (h) => h == null ? '<span class="cc-muted">no sales this week</span>' : h < 1 ? 'within the hour'
      : h <= 48 ? `<span class="cc-pill cc-pill--warn">~${Math.round(h)} h</span>` : `~${Math.round(h / 24)} days`;
    return {
      html: `<div class="cc-kpis an-kpis">
          ${stat('Store SKUs out within 14 days', num(soon.length), { sub: soon.length ? esc(soon.slice(0, 2).map(v => `${v.product} ${v.color} ${v.size}`).join(', ')) : 'none at the current pace' })}
          ${stat('Units to reorder', num(reorder), { sub: 'to cover the next 30 days' })}
          ${stat('Partner blanks out within 14 days', num(blanksSoon.length), { sub: 'by partner, colour and size' })}
          ${stat('Drops selling out within 48 h', num(dropsSoon.length), { sub: dropsSoon.length ? esc(dropsSoon.map(x => x.drop_name).join(', ')) : 'none at the current pace' })}
        </div>
        <div class="an-grid">
          ${card('Items sold per week', '', { id: 'demand', wide: true, note: 'All paid items, last 12 weeks, by order week.',
              tableHtml: table([...d.demand].reverse(), [{ label: 'Week of', render: r => esc(r.week) }, { label: 'Items', align: 'right', render: r => num(r.units) }]) })}
          ${card('Store stock running out', table(d.variants, [
              { label: 'Product', render: r => `<a href="/product/${esc(r.slug)}" target="_blank" rel="noopener">${esc(r.product)}</a><br><span class="cc-muted cc-small">${esc(r.color)} / ${esc(r.size)} · ${esc(r.sku)}</span>` },
              { label: 'In stock', align: 'right', render: r => num(r.available) }, { label: 'Sells / day', align: 'right', render: r => r.per_day },
              { label: 'Runs out in', align: 'right', render: r => days(r.days_left) }, { label: 'Reorder', align: 'right', render: r => r.reorder ? num(r.reorder) : '—' }],
              { empty: 'Nothing sold in this window, so there\'s nothing to project.' }),
              { wide: true, note: 'Runs out in = stock available ÷ average daily sales in the window. Reorder = 30 days of sales minus stock on hand. Limited drops are excluded (they never restock).' })}
          ${card('Live drops', table(d.drops, [
              { label: 'Drop', render: r => `${esc(r.drop_name)} <span class="cc-muted">#${String(r.drop_number).padStart(3, '0')}</span>` },
              { label: 'Left', align: 'right', render: r => `${num(r.left)} / ${num(r.edition_size)}` },
              { label: 'Sold 24 h', align: 'right', render: r => num(r.sold_24h) }, { label: 'Sold 7 d', align: 'right', render: r => num(r.sold_7d) },
              { label: 'Sells out in', align: 'right', render: r => eta(r.eta_hours) }], { empty: 'No live drops.' }),
              { note: 'Uses the last 24 hours\' pace when there were sales, otherwise the last 7 days.' })}
          ${card('Partner blanks', table(d.blanks, [
              { label: 'Partner', render: r => `${esc(r.partner)}${r.is_test && !/test/i.test(r.partner) ? ' <span class="cc-tag">test</span>' : ''}` },
              { label: 'Blank', render: r => `${esc(label(r.product_type))} · ${esc(r.color)} / ${esc(r.size)}` },
              { label: 'Free', align: 'right', render: r => num(r.free) }, { label: 'Used / day', align: 'right', render: r => r.per_day },
              { label: 'Runs out in', align: 'right', render: r => days(r.days_left) }], { empty: 'No production in this window.' }),
              { note: 'Blanks used by production orders assigned to each partner.' })}
        </div>`,
      charts: [
        ['demand', { rows: d.demand, x: r => r.week, xFormat: (k, long) => new Date(k + 'T12:00:00').toLocaleDateString('en-CA', long ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }),
          kind: 'column', height: 200, yFormat: (v) => num(Math.round(v)), series: [{ key: 'u', label: 'Items sold', value: r => r.units }] }],
      ],
      csv: () => toCsv([['product', r => r.product], ['sku', r => r.sku], ['color', r => r.color], ['size', r => r.size], ['available', r => r.available],
        ['sold_in_window', r => r.sold], ['per_day', r => r.per_day], ['days_left', r => r.days_left], ['reorder_30d', r => r.reorder]], d.variants),
    };
  },
  sales(d, range) {
    const t = d.totals, p = d.previous;
    const margin = t.costed_net_cents ? t.costed_net_cents - t.cost_cents : null;
    const marginPct = t.costed_net_cents ? Math.round((margin / t.costed_net_cents) * 1000) / 10 : null;
    const xf = xFmt(range.grain);
    const TYPE = { catalog: 'Catalog pieces', custom: 'Custom designs', limited: 'Limited drops' };
    return {
      html: `<div class="cc-kpis an-kpis">
          ${stat('Net revenue', money(t.net_cents), { now: t.net_cents, prev: p.net_cents, fmt: money, sub: t.refunded_cents ? `${money(t.gross_cents)} paid − ${money(t.refunded_cents)} refunded` : 'paid orders, after refunds' })}
          ${stat('Orders', num(t.orders), { now: t.orders, prev: p.orders })}
          ${stat('Average order', money(t.aov_cents), { now: t.aov_cents, prev: p.aov_cents, fmt: money })}
          ${stat('Items sold', num(t.units), { now: t.units, prev: p.units })}
          ${stat('Customers', num(t.customers), { now: t.customers, prev: p.customers })}
          ${stat('Refund rate', pct(t.refund_rate), { now: t.refund_rate, prev: p.refund_rate, fmt: pct, better: 'down', sub: `${num(t.refunds)} refunds` })}
          ${stat('Discounts given', money(t.discount_cents), { now: t.discount_cents, prev: p.discount_cents, fmt: money, better: 'down' })}
          ${stat('Est. gross margin', marginPct == null ? '—' : `${marginPct}%`, { sub: marginPct == null ? 'add product costs to see margin' : `${money(margin)} on ${t.cost_coverage}% of sales with known costs` })}
        </div>
        <div class="an-grid">
          ${card('Revenue', '', { id: 'rev', wide: true, note: 'Paid order totals (incl. shipping and tax) by the day they were paid; refunds by the day they were issued.',
              tableHtml: table([...d.series].reverse(), [{ label: 'Period', render: r => esc(xf(r.k, true)) }, { label: 'Paid', align: 'right', render: r => money(r.gross_cents) },
                { label: 'Refunded', align: 'right', render: r => money(r.refunded_cents) }, { label: 'Net', align: 'right', render: r => money(r.gross_cents - r.refunded_cents) }]) })}
          ${card('Orders', '', { id: 'ord', tableHtml: table([...d.series].reverse(), [{ label: 'Period', render: r => esc(xf(r.k, true)) }, { label: 'Orders', align: 'right', render: r => num(r.orders) }]) })}
          ${card('What sold', barList(d.by_type.map(r => ({ label: TYPE[r.type] || r.type, value: r.net_cents, sub: `${num(r.units)} items` })), { format: money }),
              { note: 'Merchandise after discounts, before shipping and tax.' })}
          ${card('By category', barList(d.by_category.map(r => ({ label: r.name, value: r.net_cents, sub: `${num(r.units)} items` })), { format: money }))}
          ${card('By province', barList(d.by_province.map(r => ({ label: r.province, value: r.gross_cents, sub: `${num(r.orders)} orders` })), { format: money }))}
          ${card('New vs returning customers', barList([
              { label: 'New customers', value: d.new_vs_returning.new_cents || 0, sub: `${num(d.new_vs_returning.new || 0)} people` },
              { label: 'Returning customers', value: d.new_vs_returning.returning_cents || 0, sub: `${num(d.new_vs_returning.returning || 0)} people` }], { format: money }),
              { note: 'New = first ever paid order falls in this period.' })}
          ${card('Discount codes', table(d.discount_codes, [{ label: 'Code', render: r => `<code>${esc(r.code)}</code>` }, { label: 'Orders', align: 'right', render: r => num(r.orders) },
              { label: 'Discount given', align: 'right', render: r => money(r.discount_cents) }, { label: 'Order revenue', align: 'right', render: r => money(r.gross_cents) }], { empty: 'No codes used.' }))}
          ${card('Where the money went', `<dl class="an-dl"><dt>Merchandise</dt><dd>${money(t.merch_cents)}</dd><dt>Discounts</dt><dd>−${money(t.discount_cents)}</dd>
              <dt>Shipping charged</dt><dd>${money(t.shipping_cents)}</dd><dt>Sales tax collected</dt><dd>${money(t.tax_cents)}</dd>
              <dt>Paid</dt><dd>${money(t.gross_cents)}</dd><dt>Refunded</dt><dd>−${money(t.refunded_cents)}</dd><dt class="is-total">Net</dt><dd class="is-total">${money(t.net_cents)}</dd></dl>`,
              { note: 'Tax is collected for the provinces, not revenue.' })}
        </div>`,
      charts: [
        ['rev', { rows: d.series, x: r => r.k, xFormat: xf, kind: 'column', yFormat: moneyShort,
          series: [{ key: 'gross', label: 'Paid', value: r => r.gross_cents, format: money }, { key: 'ref', label: 'Refunded', value: r => r.refunded_cents, format: money }] }],
        ['ord', { rows: d.series, x: r => r.k, xFormat: xf, kind: 'column', height: 180, yFormat: (v) => num(Math.round(v)),
          series: [{ key: 'o', label: 'Orders', value: r => r.orders }] }],
      ],
      csv: () => toCsv([['period', r => r.k], ['paid', r => dollars(r.gross_cents)], ['refunded', r => dollars(r.refunded_cents)],
        ['net', r => dollars(r.gross_cents - r.refunded_cents)], ['orders', r => r.orders]], d.series),
    };
  },

  website(d, range) {
    const t = d.totals, p = d.previous, xf = xFmt(range.grain);
    return {
      html: `<div class="cc-kpis an-kpis">
          ${stat('Visitors', num(t.visitors), { now: t.visitors, prev: p.visitors })}
          ${stat('Page views', num(t.page_views), { now: t.page_views, prev: p.page_views })}
          ${stat('Product views', num(t.product_views), { now: t.product_views, prev: p.product_views })}
          ${stat('Conversion', pct(t.conversion), { now: t.conversion, prev: p.conversion, fmt: pct, sub: 'visitors who bought' })}
          ${stat('Added to bag', num(t.add_to_cart), { now: t.add_to_cart, prev: p.add_to_cart })}
          ${stat('Checkouts started', num(t.checkouts), { now: t.checkouts, prev: p.checkouts, sub: `${num(t.abandoned_checkouts)} abandoned` })}
          ${stat('New accounts', num(t.signups), { now: t.signups, prev: p.signups })}
          ${stat('Searches', num(t.searches), { now: t.searches, prev: p.searches })}
        </div>
        <div class="an-grid">
          ${card('Traffic', '', { id: 'traffic', wide: true, note: 'Visitors = signed-in people, or browser sessions for visitors who never signed in.',
              tableHtml: table([...d.series].reverse(), [{ label: 'Period', render: r => esc(xf(r.k, true)) }, { label: 'Visitors', align: 'right', render: r => num(r.visitors) },
                { label: 'Page views', align: 'right', render: r => num(r.page_views) }, { label: 'Orders', align: 'right', render: r => num(r.orders) }]) })}
          ${card('Shopping funnel', funnel(t.funnel.map(s => ({ label: s.step, value: s.visitors })), { format: num }),
              { note: 'Unique visitors reaching each step in this period.' })}
          ${card('Where visitors came from', barList(d.sources.map(s => ({ label: s.source, value: s.visitors })), { format: num, empty: 'No landing data yet (recorded from today onwards).' }),
              { note: 'From the referring site or utm_source on the first page of a visit.' })}
          ${card('Devices', barList(d.devices.map(s => ({ label: label(s.device), value: s.visitors })), { format: num, empty: 'No device data yet.' }))}
          ${card('Top pages', table(d.top_pages, [{ label: 'Page', render: r => `<a href="${esc(r.path)}" target="_blank" rel="noopener"><code>${esc(r.path)}</code></a>` },
              { label: 'Views', align: 'right', render: r => num(r.views) }, { label: 'Visitors', align: 'right', render: r => num(r.visitors) }], { empty: 'No page views.' }))}
          ${card('What people searched for', table(d.searches, [{ label: 'Search', render: r => esc(r.q) }, { label: 'Times', align: 'right', render: r => num(r.n) },
              { label: 'No results', align: 'right', render: r => r.no_results ? `<span class="an-flag">${num(r.no_results)}</span>` : '0' }], { empty: 'No searches.' }),
              { note: 'Searches that found nothing are product ideas.' })}
          ${card('All tracked events', table(d.events, [{ label: 'Event', render: r => `<code>${esc(r.event)}</code>` }, { label: 'Count', align: 'right', render: r => num(r.n) }], { empty: 'No events.' }))}
        </div>`,
      charts: [['traffic', { rows: d.series, x: r => r.k, xFormat: xf, kind: 'line', yFormat: (v) => num(Math.round(v)),
        series: [{ key: 'v', label: 'Visitors', value: r => r.visitors }, { key: 'pv', label: 'Page views', value: r => r.page_views }] }]],
      csv: () => toCsv([['period', r => r.k], ['visitors', r => r.visitors], ['page_views', r => r.page_views], ['orders', r => r.orders]], d.series),
    };
  },

  products(d) {
    const prodLink = (r) => `<a href="/admin/products?q=${encodeURIComponent(r.name)}">${esc(r.name)}</a>${r.is_limited ? ' <span class="cc-tag">limited</span>' : ''}`;
    return {
      html: `<div class="an-grid">
          ${card('Best sellers', table(d.best_sellers, [{ label: 'Product', render: prodLink }, { label: 'Items', align: 'right', render: r => num(r.units) },
              { label: 'Revenue', align: 'right', render: r => money(r.net) }, { label: 'Views', align: 'right', render: r => num(r.views) },
              { label: 'In stock', align: 'right', render: r => r.is_limited ? '—' : num(r.available) }], { empty: 'No sales in this period.' }), { wide: true })}
          ${card('Most viewed', table(d.most_viewed, [{ label: 'Product', render: prodLink }, { label: 'Views', align: 'right', render: r => num(r.views) },
              { label: 'Added to bag', align: 'right', render: r => num(r.carts) }, { label: 'Items sold', align: 'right', render: r => num(r.units) },
              { label: 'Sold per 100 viewers', align: 'right', render: r => r.conversion ?? '—' }], { empty: 'No product views recorded.' }))}
          ${card('Low performers', table(d.low_performers, [{ label: 'Product', render: prodLink }, { label: 'Views', align: 'right', render: r => num(r.views) },
              { label: 'Added to bag', align: 'right', render: r => num(r.carts) }, { label: 'Status', render: r => esc(label(r.status)) }], { empty: 'Every active product sold at least once.' }),
              { note: 'Active for more than a week, no sales in this period. Many views and no sales usually means price, photos or sizes.' })}
          ${card('By category', barList(d.by_category.map(r => ({ label: r.name, value: r.net_cents, sub: `${num(r.units)} items · ${num(r.views)} views` })), { format: money }))}
          ${card('Most wishlisted', barList(d.most_wishlisted.map(r => ({ label: r.name, value: r.wishlisted })), { format: num, empty: 'Nothing saved in this period.' }))}
          ${card('Limited drops', table(d.drops, [{ label: 'Drop', render: r => `<strong>${String(r.drop_number).padStart(3, '0')}</strong> ${esc(r.drop_name)}` },
              { label: 'Sold', render: r => `<span class="an-meter"><span style="width:${r.sell_through || 0}%"></span></span> ${num(r.units_sold)}/${num(r.edition_size)}` },
              { label: 'Sold out in', align: 'right', render: r => hours(r.hours_to_sell_out) }, { label: 'Revenue', align: 'right', render: r => money(r.revenue_cents) },
              { label: 'Status', render: r => esc(r.archived_at ? 'Archived' : label(r.status)) }], { empty: 'No drops yet.' }), { wide: true, note: 'All-time, not limited to the period.' })}
          ${card('Low stock right now', table(d.low_stock, [{ label: 'Product', render: r => esc(r.product) }, { label: 'Variant', render: r => esc([r.color, r.size].join(' / ')) },
              { label: 'Free', align: 'right', render: r => `<strong${r.available <= 0 ? ' class="an-flag"' : ''}>${num(r.available)}</strong>` },
              { label: 'Alert at', align: 'right', render: r => num(r.threshold) }], { empty: 'Nothing is low.' }))}
          ${card('Sold out', d.sold_out.length ? `<ul class="crm-list">${d.sold_out.map(r => `<li>${esc(r.name)} <span class="cc-small cc-muted">${esc(label(r.status))}</span></li>`).join('')}</ul>` : '<p class="cc-empty">Nothing sold out.</p>')}
        </div>`,
      csv: () => toCsv([['product', r => r.name], ['category', r => r.category], ['items_sold', r => r.units], ['revenue', r => dollars(r.net)],
        ['views', r => r.views], ['added_to_bag', r => r.carts], ['wishlisted', r => r.wishlisted]], [...d.best_sellers, ...d.low_performers]),
    };
  },

  fulfillment(d, range) {
    const t = d.totals, dv = d.delivery, xf = xFmt(range.grain);
    return {
      html: `<div class="cc-kpis an-kpis">
          ${stat('Sent to partners', num(t.assigned), { sub: `${num(t.shipped)} shipped so far` })}
          ${stat('Shipped on time', pct(t.on_time_pct), { sub: `${num(t.shipped_late)} late` })}
          ${stat('Partner accepts in', hours(t.avg_accept_hours))}
          ${stat('Assigned → shipped', hours(t.avg_production_hours))}
          ${stat('Shipped → delivered', hours(dv.avg_transit_hours), { sub: `${num(dv.delivered)} of ${num(dv.shipments)} delivered` })}
          ${stat('Paid → at the door', hours(d.order_to_door_hours))}
          ${stat('Rejected by partners', num(t.rejected), { sub: `${num(t.reprints)} reprints` })}
          ${stat('Problems', num(t.late_open + dv.exceptions + d.failed_orders), { sub: `${num(t.late_open)} late now · ${num(dv.exceptions)} delivery exceptions · ${num(d.failed_orders)} held/backordered` })}
        </div>
        <div class="an-grid">
          ${card('Production', '', { id: 'prod', wide: true,
              tableHtml: table([...d.series].reverse(), [{ label: 'Period', render: r => esc(xf(r.k, true)) }, { label: 'Sent to partners', align: 'right', render: r => num(r.assigned) },
                { label: 'Shipped', align: 'right', render: r => num(r.shipped) }, { label: 'Delivered', align: 'right', render: r => num(r.delivered) }]) })}
          ${card('Partners', table(d.partners, [{ label: 'Partner', render: r => `${esc(r.name)}${r.is_test ? ' <span class="cc-tag">test</span>' : ''}` },
              { label: 'Orders', align: 'right', render: r => num(r.assigned) }, { label: 'Items', align: 'right', render: r => num(r.units) },
              { label: 'Shipped', align: 'right', render: r => num(r.shipped) }, { label: 'On time', align: 'right', render: r => pct(r.on_time_pct) },
              { label: 'Avg. time', align: 'right', render: r => hours(r.avg_hours) }, { label: 'Rejected', align: 'right', render: r => num(r.rejected) },
              { label: 'Reprints', align: 'right', render: r => num(r.reprints) }], { empty: 'Nothing sent to partners in this period.' }), { wide: true })}
          ${card('Why partners said no', d.rejections.length ? `<ul class="crm-list">${d.rejections.map(r => `<li><span>“${esc(r.reason || '')}”</span> <span class="cc-small cc-muted">${esc(r.partner || '')} · ${dateTime(r.at)}</span></li>`).join('')}</ul>` : '<p class="cc-empty">No rejections.</p>')}
          ${card('Deliveries', `<dl class="an-dl"><dt>Shipments</dt><dd>${num(dv.shipments)}</dd><dt>Delivered</dt><dd>${num(dv.delivered)}</dd>
              <dt>Exceptions</dt><dd>${num(dv.exceptions)}</dd><dt>Returned to sender</dt><dd>${num(dv.returned)}</dd></dl>`)}
        </div>`,
      charts: [['prod', { rows: d.series, x: r => r.k, xFormat: xf, kind: 'column', yFormat: (v) => num(Math.round(v)),
        series: [{ key: 's', label: 'Shipped', value: r => r.shipped }, { key: 'a', label: 'Sent to partners', value: r => r.assigned }] }]],
      csv: () => toCsv([['period', r => r.k], ['sent_to_partners', r => r.assigned], ['shipped', r => r.shipped], ['delivered', r => r.delivered]], d.series),
    };
  },

  designs(d) {
    const t = d.totals;
    return {
      html: `<div class="cc-kpis an-kpis">
          ${stat('Custom revenue', money(t.net_cents), { sub: `${num(t.orders)} orders · ${num(t.units)} items` })}
          ${stat('Avg. price per piece', money(t.avg_unit_cents))}
          ${stat('Est. margin', money(t.margin_cents), { sub: 'from the pricing rules’ costs' })}
          ${stat('Designer opened', num(t.started), { sub: `${num(t.tryon_opened)} camera try-ons` })}
          ${stat('Artwork uploaded', num(t.uploads))}
          ${stat('Designs saved', num(t.saved), { sub: `${num(t.versions)} versions` })}
          ${stat('Approved / rejected', `${num(t.approved)} / ${num(t.rejected)}`, { sub: `${num(t.needs_review)} sent to a person` })}
          ${stat('Bulk quotes', num(t.quotes))}
        </div>
        <div class="an-grid">
          ${card('Designer funnel', funnel(d.funnel.map(s => ({ label: s.step, value: s.n })), { format: num }), { note: 'Unique people reaching each step in this period.' })}
          ${card('Garments', barList(d.products.map(r => ({ label: label(r.product_type), value: r.units, sub: money(r.net_cents) })), { format: num, empty: 'No custom orders in this period.' }))}
          ${card('Print placements', barList(d.placements.map(r => ({ label: r.placement, value: r.n })), { format: num, empty: 'No custom orders in this period.' }))}
          ${card('Print methods', barList(d.methods.map(r => ({ label: r.method, value: r.n })), { format: num, empty: 'No custom orders in this period.' }))}
          ${card('Garment colours', barList(d.colors.map(r => ({ label: r.color, value: r.n })), { format: num, empty: 'No custom orders in this period.' }))}
          ${card('Why designs were stopped', barList(d.moderation_reasons.map(r => ({ label: label(r.reason), value: r.n })), { format: num, empty: 'Nothing flagged.' }))}
          ${card('AI designs', `<p class="an-big">${num(t.ai_designs)}</p>`, { note: 'Artwork made with “Describe it” in this period. Details on the <a href="/admin/ai">AI page</a>.' })}
        </div>`,
      csv: () => toCsv([['step', r => r.step], ['people', r => r.n]], d.funnel),
    };
  },
};
