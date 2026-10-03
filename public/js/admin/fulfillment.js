// Fulfillment: overview + alerts, production queue, partners (profile,
// capabilities, accounts, webhook), partner stock, shipments. Also exports
// the order-page panel (where an order is being made, why that partner,
// reassign) used by orders.js.
import { db } from '../lib/supabase.js';
import { esc, money, num, pill, table, dateTime, date, label, toast, confirmDialog, kpi, errorText, form, readForm, bindRowLinks } from './ui.js';
import { poDetailHTML, bindPoActions, poStagePill, PO_STAGE } from './po-view.js';
import { stockGridHTML, bindStockGrid } from './stock-grid.js';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

export async function view(ctx) {
  const [, sub, id] = ctx.segs;
  if (!sub) return overview(ctx);
  if (sub === 'production') return production(ctx);
  if (sub === 'po' && id) return poDetail(ctx, id);
  if (sub === 'partners' && id) return partnerDetail(ctx, id);
  if (sub === 'partners') return partners(ctx);
  if (sub === 'stock') return stock(ctx);
  if (sub === 'shipments') return shipments(ctx);
  return { title: 'Not found', html: '<p class="cc-empty">That page doesn’t exist.</p>' };
}

const utilBar = (s) => {
  const pct = Math.min(100, Math.round((s.utilisation || 0) * 100));
  return `<span class="ff-bar" title="${s.load} of ${s.capacity} units queued"><span style="width:${pct}%" class="${pct >= 90 ? 'is-hot' : pct >= 70 ? 'is-warm' : ''}"></span></span>
    <span class="cc-small">${num(s.load)}/${num(s.capacity)}</span>`;
};

function alertsHTML(alerts, canResolve) {
  if (!alerts.length) return '<p class="cc-empty">No open alerts. Routing, partners and shipments are on track.</p>';
  return `<ul class="ff-alerts">${alerts.map(a => `<li class="ff-alert ff-alert--${esc(a.severity)}">
      <div>${pill(a.severity)} <strong>${esc(a.title)}</strong>${a.body ? `<p>${esc(a.body)}</p>` : ''}
        <span class="cc-small cc-muted">${dateTime(a.created_at)}${a.order_id ? ` · <a href="/admin/orders/${a.order_id}">${esc(a.order_number || 'order')}</a>` : ''}
        ${a.production_order_id ? ` · <a href="/admin/fulfillment/po/${a.production_order_id}">${esc(a.po_number || 'PO')}</a>` : ''}${a.partner_name ? ` · ${esc(a.partner_name)}` : ''}</span></div>
      ${canResolve ? `<button class="cc-btn cc-btn--small" data-resolve="${a.id}">Resolve</button>` : ''}</li>`).join('')}</ul>`;
}

async function overview(ctx) {
  const [o, alerts] = await Promise.all([db.rpc('admin_fulfillment_overview'), db.rpc('admin_alerts', { p_open: true, p_limit: 50 })]);
  const st = o.po_status || {};
  const open = ['assigned', 'accepted', 'in_production', 'printed', 'packed'].reduce((n, k) => n + (st[k] || 0), 0);
  const canSettings = ctx.can('settings.write');
  return {
    title: 'Fulfillment',
    html: `<header class="cc-head"><div><h1>Fulfillment</h1>
        <p class="cc-muted">Paid orders are routed automatically to the best partner that can make them${o.auto_route ? '' : ' — <strong>automatic routing is OFF</strong>'}.</p></div>
        <div class="cc-actions"><a class="cc-btn" href="/admin/fulfillment/production">Production queue</a><a class="cc-btn" href="/admin/fulfillment/partners">Partners</a></div></header>
      ${o.test_partners_allowed && o.partners.some(p => p.is_test && p.status === 'active') ? `<div class="cc-alert cc-alert--info"><strong>Test partners are active.</strong> The five “(test)” partners are fictional, for trying the flow. Deactivate them (or turn off “Route to test partners” below) before taking real orders.</div>` : ''}
      <div class="cc-kpis cc-kpis--small">
        ${kpi('Waiting for a partner', num(o.awaiting_route + o.backordered), o.backordered ? `${o.backordered} backordered` : 'routing is instant', '/admin/orders?group=backorders')}
        ${kpi('In production', num(open), `${st.assigned || 0} not yet accepted`, '/admin/fulfillment/production?status=open')}
        ${kpi('Late', num(o.late), 'past ship-by time', '/admin/fulfillment/production?status=late')}
        ${kpi('In transit', num(o.in_transit), `${num(o.delivered_30)} delivered in 30 days`, '/admin/fulfillment/shipments')}
        ${kpi('Avg. production', o.avg_hours_30 != null ? `${o.avg_hours_30} h` : '—', 'assigned → shipped, 30 days')}
        ${kpi('Avg. delivery', o.avg_delivery_hours_30 != null ? `${(o.avg_delivery_hours_30 / 24).toFixed(1)} d` : '—', 'shipped → delivered, 30 days')}
        ${kpi('Open alerts', num(o.alerts), o.critical ? `<span class="ff-bad">${o.critical} critical</span>` : 'none critical')}
        ${kpi('Webhook failures', num(o.dispatch_failed), 'partners not reachable')}
      </div>
      <div class="cc-two cc-two--wide">
        <section class="cc-card"><h2>Alerts</h2>${alertsHTML(alerts, ctx.can('fulfillment.write') || ctx.can('orders.write'))}</section>
        <div>
          <section class="cc-card"><h2>Pipeline</h2>
            <dl class="ff-pipe">${['assigned', 'accepted', 'in_production', 'printed', 'packed'].map(k =>
              `<div><dt>${poStagePill(k)}</dt><dd><a href="/admin/fulfillment/production?status=${k}">${num(st[k] || 0)}</a></dd></div>`).join('')}</dl>
            <p class="cc-small cc-muted">Last 30 days: ${num(st.shipped || 0)} shipped · ${num(st.rejected || 0)} rejected by partners · ${num(st.cancelled || 0)} cancelled.</p></section>
          ${canSettings ? `<section class="cc-card"><h2>Routing settings</h2>
            <label class="cc-check"><input type="checkbox" data-setting="fulfillment.auto_route"${o.auto_route ? ' checked' : ''}> <span>Route paid orders automatically</span></label>
            <label class="cc-check"><input type="checkbox" data-setting="fulfillment.allow_test_partners"${o.test_partners_allowed ? ' checked' : ''}> <span>Route to test partners</span></label>
            <p class="cc-small cc-muted">With automatic routing off, paid orders wait in “Pending” for someone to choose a partner on the order page.</p></section>` : ''}
        </div>
      </div>
      <section class="cc-card cc-card--flush"><div class="cc-card-head ff-pad"><h2>Partners</h2><a class="cc-btn cc-btn--small" href="/admin/fulfillment/partners">Manage</a></div>
        ${partnersTable(o.partners)}</section>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      bindResolve(root, ctx);
      root.querySelectorAll('[data-setting]').forEach(cb => cb.addEventListener('change', async () => {
        try { await db.update('store_settings', { key: cb.dataset.setting }, { value: cb.checked }); toast('Saved.'); }
        catch (e) { cb.checked = !cb.checked; toast(errorText(e), 'bad'); }
      }));
    },
  };
}

function bindResolve(root, ctx) {
  root.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', async () => {
    try { await db.rpc('notification_resolve', { p_id: b.dataset.resolve }); b.closest('li').remove(); toast('Resolved.'); }
    catch (e) { toast(errorText(e), 'bad'); }
  }));
}

function partnersTable(rows) {
  return table(rows, [
    { label: 'Partner', render: p => `<a href="/admin/fulfillment/partners/${p.id}"><strong>${esc(p.name)}</strong></a>${p.is_test ? ' <span class="cc-tag">test</span>' : ''}<br><span class="cc-muted cc-small">${esc(p.city || '')}${p.province ? ', ' + esc(p.province) : ''}</span>` },
    { label: 'Status', render: p => pill(p.status) },
    { label: 'Queue', render: p => utilBar(p.stats) },
    { label: 'New / open', align: 'right', render: p => `${num(p.stats.awaiting_accept)} / ${num(p.stats.open_orders)}` },
    { label: 'Late', align: 'right', render: p => p.stats.late_open ? `<strong class="ff-bad">${p.stats.late_open}</strong>` : '0' },
    { label: 'On time (90d)', align: 'right', render: p => p.stats.on_time_pct != null ? `${p.stats.on_time_pct}%` : '—' },
    { label: 'Avg. hours', align: 'right', render: p => p.stats.avg_hours ?? '—' },
    { label: 'Rejected (90d)', align: 'right', render: p => num(p.stats.rejected_90) },
    { label: 'Reliability', align: 'right', render: p => `${Math.round((p.stats.reliability || 0) * 100)}%` },
    { label: 'Stock', render: p => `${p.stats.out_of_stock ? `<span class="ff-bad">${p.stats.out_of_stock} out</span>` : ''}${p.stats.low_stock ? ` ${p.stats.low_stock} low` : ''}` || '—' },
  ], { empty: 'No partners yet.', rowHref: p => `/admin/fulfillment/partners/${p.id}` });
}

const STATUS_TABS = [['open', 'Open'], ['late', 'Late'], ['assigned', 'New'], ['accepted', 'Accepted'], ['in_production', 'Printing'], ['printed', 'QC'],
  ['packed', 'Packed'], ['shipped', 'Shipped'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['', 'All']];

async function production(ctx) {
  const status = ctx.query.has('status') ? ctx.query.get('status') : 'open', partner = ctx.query.get('partner') || '', q = ctx.query.get('q') || '';
  const [rows, ps] = await Promise.all([
    db.rpc('admin_production_orders', { p_status: status || null, p_partner: partner || null, p_q: q || null, p_limit: 300 }),
    db.from('partners').select('id,name').order('name')]);
  const qs = (o) => '/admin/fulfillment/production?' + new URLSearchParams(Object.entries({ status, partner, q, ...o }).filter(([k, v]) => v !== '' || k === 'status')).toString();
  return {
    title: 'Production queue',
    html: `<header class="cc-head"><div><h1>Production queue</h1><p class="cc-muted">${num(rows.length)} production orders</p></div>
        <form class="cc-search" data-search role="search">
          <select name="partner" aria-label="Partner"><option value="">All partners</option>${ps.map(p => `<option value="${p.id}"${p.id === partner ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <input name="q" value="${esc(q)}" placeholder="PO or order number" aria-label="Search"><button class="cc-btn">Filter</button></form></header>
      <nav class="cc-tabs">${STATUS_TABS.map(([s, l]) => `<a href="${qs({ status: s })}"${s === status ? ' aria-current="true"' : ''}>${esc(l)}</a>`).join('')}</nav>
      <section class="cc-card cc-card--flush">${table(rows, [
        { label: 'PO', render: p => `<a href="/admin/fulfillment/po/${p.id}"><strong>${esc(p.number)}</strong></a>${p.attempt > 1 ? ` <span class="cc-tag">try ${p.attempt}</span>` : ''}` },
        { label: 'Order', render: p => `<a href="/admin/orders/${p.order_id}">${esc(p.order_number)}</a>${p.on_hold ? ' ' + pill('on_hold') : ''}` },
        { label: 'Partner', render: p => `${esc(p.partner.name)}` },
        { label: 'Make', render: p => `<span class="cc-small">${esc(p.summary || '')}</span>` },
        { label: 'Ship to', render: p => `${esc(p.ship_to.city || '')}, ${esc(p.ship_to.province || '')}` },
        { label: 'Stage', render: p => poStagePill(p.status) + (p.late ? ' ' + pill('on_hold', 'Late') : '') + (p.dispatch_status === 'failed' ? ' ' + pill('failed', 'Webhook failing') : '') },
        { label: 'Assigned', render: p => dateTime(p.assigned_at) },
        { label: 'Ship by', render: p => dateTime(p.due_by) },
        { label: 'Tracking', render: p => p.shipment ? `${esc(p.shipment.carrier)} <code class="cc-small">${esc(p.shipment.tracking_number)}</code>` : '' },
      ], { empty: 'No production orders here.', rowHref: p => `/admin/fulfillment/po/${p.id}` })}</section>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(qs({ q: e.target.q.value.trim(), partner: e.target.partner.value })); };
    },
  };
}

async function poDetail(ctx, id) {
  const po = await db.rpc('partner_po', { p_po_id: id });
  if (!po) return { title: 'Not found', html: '<p class="cc-empty">Production order not found.</p>' };
  return {
    title: po.number,
    html: `<p class="cc-crumbs"><a href="/admin/fulfillment/production">Production</a> / ${esc(po.number)} · <a href="/admin/orders/${po.order_id}">order ${esc(po.order_number)}</a></p>
      ${ctx.can('fulfillment.write') ? '' : '<p class="cc-note">You can view production orders; changing them needs fulfillment access.</p>'}
      ${poDetailHTML(po, { showPartner: true })}`,
    mount(root) { bindPoActions(root, po, () => ctx.go(location.pathname)); },
  };
}

async function partners(ctx) {
  const o = await db.rpc('admin_fulfillment_overview');
  return {
    title: 'Partners',
    html: `<header class="cc-head"><div><h1>Partners</h1><p class="cc-muted">Print and fulfillment partners. Routing only uses partners that are <strong>active</strong>.</p></div>
        ${ctx.can('fulfillment.write') ? '<a class="cc-btn cc-btn--primary" href="/admin/fulfillment/partners/new">Add partner</a>' : ''}</header>
      <section class="cc-card cc-card--flush">${partnersTable(o.partners)}</section>`,
    mount(root) { bindRowLinks(root, ctx.go); },
  };
}

const PARTNER_FIELDS = [
  { name: 'name', label: 'Business name', required: true },
  { name: 'code', label: 'Code', required: true, help: 'Short id, lowercase with dashes (used by their API integration).' },
  { name: 'status', label: 'Status', type: 'select', options: [['onboarding', 'Onboarding'], ['active', 'Active — receives orders'], ['inactive', 'Inactive (paused)'], ['suspended', 'Suspended']] },
  { name: 'is_test', label: 'Test partner (fictional, for trying the flow)', type: 'checkbox' },
  { name: 'contact_name', label: 'Contact name' }, { name: 'contact_email', label: 'Contact email', type: 'email' }, { name: 'contact_phone', label: 'Contact phone' },
  { name: 'address_line1', label: 'Street address' }, { name: 'city', label: 'City' },
  { name: 'province', label: 'Province', type: 'select', options: [['', '—'], ...PROVINCES.map(p => [p, p])] },
  { name: 'postal_code', label: 'Postal code', help: 'Used for distance when routing.' },
  { name: 'lat', label: 'Latitude (optional)', type: 'number' }, { name: 'lng', label: 'Longitude (optional)', type: 'number' },
  { name: 'product_types', label: 'Garments they make', type: 'tags', help: 'tee, hoodie, crewneck, longsleeve, tank — empty = all.' },
  { name: 'print_methods', label: 'Print methods', type: 'tags', help: 'dtg, dtf, screen, embroidery, sublimation. Required.' },
  { name: 'placements', label: 'Print placements', type: 'tags', help: 'e.g. front, back, left_chest, left_sleeve, all_over — empty = any.' },
  { name: 'ships_to', label: 'Ships to provinces', type: 'tags', help: 'e.g. ON, QC — empty = all of Canada.' },
  { name: 'capacity_per_day', label: 'Queue capacity (units)', type: 'number', min: 1, step: 1, required: true },
  { name: 'production_days', label: 'Production time (days)', type: 'number', min: 0.1, step: 0.1, required: true },
  { name: 'accept_sla_hours', label: 'Must accept within (hours)', type: 'number', min: 1, step: 1, required: true },
  { name: 'tracks_inventory', label: 'Check their blank stock before routing', type: 'checkbox' },
  { name: 'integration', label: 'How they receive orders', type: 'select', options: [['portal', 'Partner portal'], ['webhook', 'Webhook to their system (plus portal)']] },
  { name: 'notes', label: 'Internal notes', type: 'textarea', full: true },
];

async function partnerDetail(ctx, id) {
  const isNew = id === 'new';
  const d = isNew ? null : await db.rpc('admin_partner', { p_partner_id: id });
  if (!isNew && !d) return { title: 'Not found', html: '<p class="cc-empty">Partner not found.</p>' };
  const p = d?.partner || { status: 'onboarding', capacity_per_day: 50, production_days: 2, accept_sla_hours: 24, tracks_inventory: true, integration: 'portal', print_methods: ['dtg', 'dtf'] };
  const canWrite = ctx.can('fulfillment.write');
  const s = d?.stats || {};
  const types = p.product_types?.length ? p.product_types : ['tee', 'hoodie', 'crewneck', 'longsleeve', 'tank'];
  return {
    title: isNew ? 'New partner' : p.name,
    html: `<p class="cc-crumbs"><a href="/admin/fulfillment/partners">Partners</a> / ${esc(isNew ? 'New' : p.name)}</p>
      <header class="cc-head"><div><h1>${esc(isNew ? 'New partner' : p.name)} ${isNew ? '' : pill(p.status)} ${p.is_test ? '<span class="cc-tag">test</span>' : ''}</h1>
        ${isNew ? '' : `<p class="cc-muted">${esc(p.city || '')}${p.province ? ', ' + esc(p.province) : ''} · queue ${num(s.load)}/${num(s.capacity)} · ${num(s.open_orders)} open · on time ${s.on_time_pct ?? '—'}% · reliability ${Math.round((s.reliability || 0) * 100)}%</p>`}</div></header>
      ${p.is_test ? '<div class="cc-alert cc-alert--info">Fictional development partner — not a real business. Orders routed here are for testing the flow.</div>' : ''}
      <div class="cc-two cc-two--wide">
        <div>
          <section class="cc-card"><h2>Profile & capabilities</h2>${canWrite ? form(PARTNER_FIELDS, p, { submit: isNew ? 'Create partner' : 'Save' }) : `<pre class="cc-mono cc-small">${esc(JSON.stringify(p, null, 2))}</pre>`}</section>
          ${isNew ? '' : `<section class="cc-card"><div class="cc-card-head"><h2>Blank stock</h2>${canWrite || ctx.can('inventory.write') ? '<button class="cc-btn cc-btn--small" data-stock-add>Count / receive</button>' : ''}</div>
            ${p.tracks_inventory ? stockGridHTML(d.inventory, { editable: canWrite || ctx.can('inventory.write') }) : '<p class="cc-muted">Stock isn’t checked for this partner (they source their own blanks).</p>'}</section>
          <section class="cc-card cc-card--flush"><div class="cc-card-head ff-pad"><h2>Recent production orders</h2><a class="cc-btn cc-btn--small" href="/admin/fulfillment/production?status=&partner=${p.id}">All</a></div>
            ${table(d.recent, [
              { label: 'PO', render: x => `<a href="/admin/fulfillment/po/${x.id}">${esc(x.number)}</a>` }, { label: 'Order', render: x => esc(x.order_number) },
              { label: 'Make', render: x => `<span class="cc-small">${esc(x.summary || '')}</span>` }, { label: 'Stage', render: x => poStagePill(x.status) + (x.late ? ' ' + pill('on_hold', 'Late') : '') },
              { label: 'Assigned', render: x => dateTime(x.assigned_at) }], { empty: 'Nothing routed here yet.', rowHref: x => `/admin/fulfillment/po/${x.id}` })}</section>`}
        </div>
        ${isNew ? '<div></div>' : `<div>
          <section class="cc-card"><h2>Portal accounts</h2>
            ${d.members.length ? `<ul class="ff-members">${d.members.map(m => `<li><span>${esc(m.name || '')} <span class="cc-muted">${esc(m.email || '')}</span></span>
              ${ctx.can('users.manage') ? `<button class="cc-btn cc-btn--small cc-btn--danger" data-unlink="${m.user_id}">Remove</button>` : ''}</li>`).join('')}</ul>` : '<p class="cc-muted">No one can sign in for this partner yet.</p>'}
            ${d.can_manage_users ? `<form class="ff-inline" data-add-member><input name="email" type="email" placeholder="their@email.com" required aria-label="Email of an existing account"><button class="cc-btn">Give portal access</button></form>
              <p class="cc-small cc-muted">They create a normal account first, then sign in at <code>/partner</code>. Partner accounts can’t be staff accounts.</p>` : ''}</section>
          <section class="cc-card"><h2>Webhook integration</h2>
            ${p.integration === 'webhook' ? '' : '<p class="cc-small cc-muted">This partner uses the portal. Switch “How they receive orders” to webhook to also push orders to their system.</p>'}
            ${canWrite ? `<form data-webhook class="cc-form"><label class="cc-field"><span>Their endpoint (https)</span><input name="url" type="url" value="${esc(d.integration?.webhook_url || '')}" placeholder="https://…"></label>
              <div class="cc-form-actions"><button class="cc-btn">Save endpoint</button></div></form>
              <p class="cc-small">Signing secret: <code class="ff-secret" data-secret="${esc(d.integration?.secret || '')}">••••••••</code> <button class="cc-btn cc-btn--small" data-reveal>Show</button></p>
              <details class="cc-small"><summary>How partners integrate</summary>
                <p>We POST <code>production_order.assigned</code> to their endpoint with <code>Idempotency-Key: PO-…</code> and <code>X-TH8RTY-Signature: t=…,v1=hmac_sha256(secret, "t.body")</code>, retrying with backoff until they answer 2xx.</p>
                <p>They report progress by POSTing <code>{"production_order":"PO-…","action":"accept|reject|start|printed|reprint|packed|ship|note", …}</code> to <code>/api/partner-webhook</code> with header <code>X-TH8RTY-Partner: ${esc(p.code)}</code> and the same signature.</p></details>` : ''}
          </section>
          <section class="cc-card"><h2>Performance</h2>
            <dl class="ff-stats"><dt>Shipped (30 days)</dt><dd>${num(s.shipped_30)}</dd><dt>On time (90 days)</dt><dd>${s.on_time_pct ?? '—'}%</dd>
              <dt>Avg. assigned → shipped</dt><dd>${s.avg_hours ?? '—'} h</dd><dt>Rejected (90 days)</dt><dd>${num(s.rejected_90)}</dd>
              <dt>Reprints (90 days)</dt><dd>${num(s.reprints_90)}</dd><dt>Late right now</dt><dd>${num(s.late_open)}</dd>
              <dt>Routing reliability score</dt><dd>${Math.round((s.reliability || 0) * 100)}%</dd></dl>
            <p class="cc-small cc-muted">Reliability = on-time shipments vs. late + rejected, smoothed so a new partner starts near 100%. It feeds the routing score.</p></section>
        </div>`}
      </div>`,
    mount(root) {
      const reload = () => ctx.go(location.pathname);
      root.querySelector('[data-form]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = e.target.querySelector('[data-msg]');
        try {
          const v = readForm(e.target, PARTNER_FIELDS);
          v.code = String(v.code || '').toLowerCase();
          if (!v.print_methods?.length) throw new Error('List at least one print method.');
          if (!isNew) {
            await db.update('partners', { id: p.id }, v); toast('Saved.'); reload();
          } else {
            const [row] = await db.insert('partners', v);
            await db.insert('partner_integrations', { partner_id: row.id }).catch(() => {});
            toast('Partner created.'); ctx.go(`/admin/fulfillment/partners/${row.id}`);
          }
        } catch (err) { msg.textContent = errorText(err); }
      });
      if (isNew) return;
      bindStockGrid(root, p.id, types, reload);
      root.querySelector('[data-add-member]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { const r = await db.rpc('admin_add_partner_user', { p_partner_id: p.id, p_email: e.target.email.value }); toast(`${r.email} can now use the partner portal.`); reload(); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
      root.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
        const r = await confirmDialog({ title: 'Remove portal access?', body: '<p>They’ll no longer see this partner’s orders.</p>', confirm: 'Remove', tone: 'danger' });
        if (!r.ok) return;
        try { await db.remove('user_roles', { user_id: b.dataset.unlink, role: 'partner_admin', partner_id: p.id }); toast('Removed.'); reload(); }
        catch (err) { toast(errorText(err), 'bad'); }
      }));
      root.querySelector('[data-webhook]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = e.target.url.value.trim() || null;
        try {
          const rows = await db.update('partner_integrations', { partner_id: p.id }, { webhook_url: url });
          if (!rows?.length) await db.insert('partner_integrations', { partner_id: p.id, webhook_url: url });
          toast('Endpoint saved.');
        } catch (err) { toast(errorText(err), 'bad'); }
      });
      root.querySelector('[data-reveal]')?.addEventListener('click', (e) => {
        const c = root.querySelector('[data-secret]'); c.textContent = c.dataset.secret || '(none)'; e.currentTarget.remove();
      });
    },
  };
}

async function stock(ctx) {
  const ps = await db.from('partners').select('id,name,is_test,tracks_inventory,product_types').order('name');
  const pid = ctx.query.get('partner') || ps[0]?.id;
  const p = ps.find(x => x.id === pid);
  const rows = p ? await db.from('partner_inventory').select('product_type,color,size,on_hand,reserved,low_threshold').eq('partner_id', p.id) : [];
  const editable = ctx.can('fulfillment.write') || ctx.can('inventory.write');
  return {
    title: 'Partner inventory',
    html: `<header class="cc-head"><div><h1>Partner inventory</h1><p class="cc-muted">Blank garments at each partner. Routing reserves blanks when it assigns an order and uses them up when it’s packed.</p></div>
        ${editable && p ? '<button class="cc-btn cc-btn--primary" data-stock-add>Count / receive</button>' : ''}</header>
      <nav class="cc-tabs">${ps.map(x => `<a href="/admin/fulfillment/stock?partner=${x.id}"${x.id === pid ? ' aria-current="true"' : ''}>${esc(x.name)}</a>`).join('')}</nav>
      <section class="cc-card">${p ? (p.tracks_inventory ? stockGridHTML(rows, { editable }) : '<p class="cc-muted">This partner sources its own blanks; stock isn’t checked.</p>') : '<p class="cc-empty">No partners yet.</p>'}</section>`,
    mount(root) { if (p) bindStockGrid(root, p.id, p.product_types?.length ? p.product_types : undefined, () => ctx.go(location.pathname + location.search)); },
  };
}

async function shipments(ctx) {
  const st = ctx.query.get('status') || '';
  let q = db.from('shipments').select('id,carrier,tracking_number,tracking_url,status,shipped_at,delivered_at,last_event_at,order_id,production_order_id,orders(number),partners(name,is_test)')
    .order('shipped_at', { ascending: false }).limit(300);
  if (st === 'open') q = q.in('status', ['label_created', 'in_transit', 'out_for_delivery']);
  else if (st) q = q.eq('status', st);
  const rows = await q;
  const tabs = [['', 'All'], ['open', 'Moving'], ['exception', 'Exceptions'], ['delivered', 'Delivered'], ['returned', 'Returned']];
  return {
    title: 'Shipments',
    html: `<header class="cc-head"><div><h1>Shipments</h1><p class="cc-muted">Carrier scans arrive by webhook; shipments with “Test carrier” advance on their own every few minutes.</p></div></header>
      <nav class="cc-tabs">${tabs.map(([s, l]) => `<a href="/admin/fulfillment/shipments${s ? '?status=' + s : ''}"${s === st ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>
      <section class="cc-card cc-card--flush">${table(rows, [
        { label: 'Order', render: s => `<a href="/admin/orders/${s.order_id}">${esc(s.orders?.number || '')}</a>` },
        { label: 'Carrier', render: s => esc(s.carrier) },
        { label: 'Tracking', render: s => s.tracking_url ? `<a href="${esc(s.tracking_url)}" target="_blank" rel="noopener">${esc(s.tracking_number)}</a>` : `<code>${esc(s.tracking_number)}</code>` },
        { label: 'Status', render: s => pill(s.status) },
        { label: 'From', render: s => esc(s.partners?.name || '') },
        { label: 'Shipped', render: s => dateTime(s.shipped_at) },
        { label: 'Delivered', render: s => dateTime(s.delivered_at) },
        { label: 'Last scan', render: s => dateTime(s.last_event_at) },
      ], { empty: 'No shipments here yet.' })}</section>`,
  };
}

// ---------------------------------------------------------------------
// Order page panel
// ---------------------------------------------------------------------
export async function orderPanel(order, ctx) {
  const f = await db.rpc('admin_order_fulfillment', { p_order_id: order.id });
  const active = f.production_orders.find(p => !['rejected', 'cancelled'].includes(p.status));
  const routable = order.paid_at && ['fulfillment_pending', 'backordered', 'on_hold'].includes(order.status) && !active;
  const movable = active && ['assigned', 'accepted'].includes(active.status);
  const canWrite = f.can_write;
  const pick = active?.routing?.picked;
  const html = `<section class="cc-card" data-ff-panel><div class="cc-card-head"><h2>Fulfillment</h2>
      <div class="cc-actions">${canWrite && routable ? '<button class="cc-btn cc-btn--small cc-btn--primary" data-route>Choose partner…</button>' : ''}
        ${canWrite && movable ? '<button class="cc-btn cc-btn--small" data-route>Reassign…</button>' : ''}</div></div>
      ${f.alerts.map(a => `<div class="cc-alert cc-alert--${a.severity === 'critical' ? 'bad' : 'warn'}"><strong>${esc(a.title)}</strong>${a.body ? `<br>${esc(a.body)}` : ''}</div>`).join('')}
      ${active ? `<p><a href="/admin/fulfillment/po/${active.id}"><strong>${esc(active.number)}</strong></a> ${poStagePill(active.status)}${active.late ? ' ' + pill('on_hold', 'Late') : ''}<br>
          ${esc(active.partner.name)}${active.partner.is_test ? ' <span class="cc-tag">test</span>' : ''} · ship by ${dateTime(active.due_by)}</p>
        ${pick ? `<details class="cc-small"><summary>Why ${esc(active.partner.name)}?</summary>${candidatesTable(active.routing.candidates, active.partner_id)}
          ${active.routing.forced ? '<p>Chosen by staff.</p>' : '<p>Lowest score among partners that can make it, ship there, have the blanks and have room. Score = distance + queue load + production time + reliability.</p>'}</details>` : ''}`
      : order.paid_at ? `<p class="cc-muted">${['fulfillment_pending', 'backordered', 'on_hold'].includes(order.status) ? 'Not with a partner yet.' : order.status === 'moderation_pending' ? 'Waiting for design approval before production.' : 'No production order.'}</p>` : '<p class="cc-muted">Goes to a partner once paid.</p>'}
      ${f.shipments.map(s => `<div class="ff-ship"><strong>${esc(s.carrier)}</strong> ${s.tracking_url ? `<a href="${esc(s.tracking_url)}" target="_blank" rel="noopener">${esc(s.tracking_number)}</a>` : `<code>${esc(s.tracking_number)}</code>`} ${pill(s.status)}
          <ul class="po-scans">${[...s.events].reverse().map(e => `<li>${esc(label(e.status))} ${esc(e.description || '')}${e.location ? ` — ${esc(e.location)}` : ''} <span class="cc-muted cc-small">${dateTime(e.at)}</span></li>`).join('')}</ul></div>`).join('')}
      ${f.production_orders.filter(p => p !== active).length ? `<details class="cc-small"><summary>Earlier production orders</summary><ul>${f.production_orders.filter(p => p !== active).map(p =>
        `<li><a href="/admin/fulfillment/po/${p.id}">${esc(p.number)}</a> · ${esc(p.partner.name)} · ${poStagePill(p.status)} ${esc(p.rejection_reason || '')}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  return {
    html,
    mount(root) {
      root.querySelector('[data-ff-panel] [data-route]')?.addEventListener('click', () => routeDialog(order, active, ctx));
    },
  };
}

function candidatesTable(cands = [], chosen) {
  return `<div class="cc-table-wrap"><table class="cc-table ff-cands"><thead><tr><th>Partner</th><th>Can take it?</th><th style="text-align:right">km</th><th style="text-align:right">Queue</th><th style="text-align:right">Score</th></tr></thead>
    <tbody>${cands.map(c => `<tr${c.partner_id === chosen ? ' class="is-chosen"' : ''}><td>${esc(c.name)}</td>
      <td>${c.ok ? '✓' : `<span class="cc-small">${(c.reasons || []).map(esc).join('<br>')}</span>`}</td>
      <td style="text-align:right">${c.distance_km ?? '—'}</td><td style="text-align:right">${c.load}/${c.capacity}</td><td style="text-align:right">${c.score}</td></tr>`).join('')}</tbody></table></div>`;
}

async function routeDialog(order, active, ctx) {
  let preview;
  try { preview = await db.rpc('admin_route_order', { p_order_id: order.id, p_dry_run: true }); }
  catch (e) { toast(errorText(e), 'bad'); return; }
  const cands = preview.candidates.filter(c => c.partner_id !== active?.partner_id);
  const d = document.createElement('dialog');
  d.className = 'cc-dialog cc-dialog--wide';
  d.innerHTML = `<form method="dialog"><h2>${active ? `Move ${esc(active.number)} to another partner` : `Send ${esc(order.number)} to production`}</h2>
    ${active ? `<p class="cc-small">The current production order at ${esc(active.partner.name)} is cancelled and its blanks released.</p>` : ''}
    ${order.status === 'on_hold' ? '<p class="cc-small"><strong>This also releases the hold</strong> on the order.</p>' : ''}
    <ul class="ff-choose">${cands.map((c, i) => `<li><label><input type="radio" name="p" value="${c.partner_id}"${(c.capable && c.stock_ok) ? '' : ' disabled'}${i === 0 && c.ok ? ' checked' : ''}>
      <span><strong>${esc(c.name)}</strong> ${c.ok ? pill('active', 'Ready') : c.capable && c.stock_ok ? pill('warning', 'Over capacity') : pill('rejected', 'Can’t')}
        <br><span class="cc-small cc-muted">${c.distance_km ?? '—'} km · queue ${c.load}/${c.capacity} · score ${c.score}</span>
        ${(c.reasons || []).length ? `<br><span class="cc-small">${c.reasons.map(esc).join(' · ')}</span>` : ''}</span></label></li>`).join('')}</ul>
    ${!active ? '<label class="cc-check"><input type="radio" name="p" value="__auto"> <span>Let routing pick the best ready partner</span></label>' : ''}
    <label class="cc-field"><span>Note (kept in the history)</span><input name="note"></label>
    <p class="cc-form-msg" data-msg></p>
    <div class="cc-form-actions"><button class="cc-btn" type="button" data-cancel>Cancel</button><button class="cc-btn cc-btn--primary">Send to partner</button></div></form>`;
  document.body.append(d);
  const f = d.querySelector('form');
  const close = () => { d.close(); d.remove(); };
  d.querySelector('[data-cancel]').onclick = close;
  d.addEventListener('cancel', close);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = f.p.value;
    if (!v) { d.querySelector('[data-msg]').textContent = 'Choose a partner.'; return; }
    try {
      if (v === '__auto' && order.status === 'on_hold') {
        const to = await db.rpc('admin_order_resume', { p_order_id: order.id, p_note: f.note.value.trim() || 'Sent back to routing', p_to: 'fulfillment_pending' });
        toast(`Released to routing (${label(to)}).`); close(); ctx.go(location.pathname); return;
      }
      const r = await db.rpc('admin_route_order', { p_order_id: order.id, p_partner_id: v === '__auto' ? null : v, p_note: f.note.value.trim() || null });
      if (r.status === 'assigned') { toast(`Sent to ${r.partner} as ${r.production_order}.`); close(); ctx.go(location.pathname); }
      else d.querySelector('[data-msg]').textContent = r.reason || `Routing result: ${label(r.status)}`;
    } catch (err) { d.querySelector('[data-msg]').textContent = errorText(err); }
  };
  d.showModal();
}
