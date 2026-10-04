// /partner — the production partner portal. Built for a phone on the
// shop floor: new orders, what's printing, what's ready to ship, blank
// stock and capacity. A partner account only ever sees its own partner's
// production orders (RLS + permission-checked functions).
import { auth, db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { esc, pill, dateTime, label, toast, errorText, num } from '../admin/ui.js';
import { poDetailHTML, bindPoActions, poStagePill, PO_STAGE } from '../admin/po-view.js';
import { stockGridHTML, bindStockGrid } from '../admin/stock-grid.js';

const TABS = [['new', 'New'], ['production', 'In production'], ['shipping', 'Ready to ship'], ['done', 'Done'], ['stock', 'Stock'], ['settings', 'Settings']];
const QUICK = { assigned: ['accept', 'Accept'], accepted: ['start', 'Start'], in_production: ['printed', 'Printed'], printed: ['packed', 'Packed'] };

function ensureCss() {
  if (document.querySelector('link[data-admin-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = '/css/admin.css'; l.dataset.adminCss = '';
  document.head.append(l);
}

export async function load({ rest = '' }, query) {
  ensureCss();
  const theme = await themeForPage('account');
  const gate = (h) => ({ theme, title: 'Partner portal', html: `<div class="cc pp"><main class="cc-main"><section class="cc-gate">${h}</section></main></div>` });
  if (!auth.user) {
    return gate(`<h1>Partner portal</h1><p>Sign in with the account M-Way linked to your print shop.</p>
      <p><a class="cc-btn cc-btn--primary" href="/account/sign-in?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a></p>`);
  }
  let partners;
  try { partners = await db.rpc('partner_me'); } catch (e) { return gate(`<h1>Partner portal</h1><p>${esc(errorText(e))}</p>`); }
  if (!partners.length) {
    return gate(`<h1>No partner access</h1><p>${esc(auth.user.email)} isn’t linked to a production partner. Ask M-Way to add this email to your partner account.</p>
      <p><a class="cc-btn" href="/">Back to the store</a></p>`);
  }
  const p = partners.find(x => x.code === query.get('p')) || partners[0];
  const pq = partners.length > 1 ? `p=${encodeURIComponent(p.code)}` : '';
  const href = (path, extra = '') => `/partner${path}${pq || extra ? '?' + [pq, extra].filter(Boolean).join('&') : ''}`;
  const go = async (url) => (await import('../app.js')).go(url);
  const segs = rest.split('/').filter(Boolean);
  const tab = segs[0] === 'po' ? 'po' : (TABS.find(t => t[0] === segs[0])?.[0] || 'new');

  let body = '', mount = () => {};
  try {
    if (tab === 'po') ({ body, mount } = await poPage(segs[1], href));
    else if (tab === 'stock') ({ body, mount } = await stockPage(p));
    else if (tab === 'settings') ({ body, mount } = settingsPage(p));
    else ({ body, mount } = await queuePage(p, tab, href));
  } catch (e) {
    body = `<div class="cc-alert cc-alert--bad">${esc(errorText(e))}</div>`;
  }
  const alerts = await db.from('notifications').select('id,kind,severity,title,body,created_at').eq('audience', 'partner').eq('partner_id', p.id)
    .is('resolved_at', 'null').order('created_at', { ascending: false }).limit(5).catch(() => []);
  const s = p.stats || {};
  const count = (k) => (p.counts?.[k] ? ` <b>${p.counts[k]}</b>` : '');

  return {
    theme, title: `${p.name} · Partner portal`,
    html: `<div class="cc pp">
      <header class="pp-top">
        <div><span class="pp-kicker">M-Way partner portal</span>
          <h1>${esc(p.name)} ${p.is_test ? '<span class="cc-tag">test partner</span>' : ''} ${p.status !== 'active' ? pill(p.status) : ''}</h1>
          <p class="cc-muted cc-small">${esc(p.city || '')}${p.province ? ', ' + esc(p.province) : ''} · queue ${num(s.load)}/${num(p.capacity_per_day)} units${s.late_open ? ` · <strong class="pp-late">${s.late_open} late</strong>` : ''}</p></div>
        <div class="pp-who">${partners.length > 1 ? `<select aria-label="Partner" data-switch>${partners.map(x => `<option value="${esc(x.code)}"${x.id === p.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
          <span class="cc-small cc-muted">${esc(auth.user.email)}</span></div>
      </header>
      <nav class="cc-tabs pp-tabs">${TABS.map(([k, l]) => `<a href="${href('/' + k)}"${k === tab ? ' aria-current="true"' : ''}>${esc(l)}${count(k)}</a>`).join('')}</nav>
      ${alerts.length ? `<ul class="pp-alerts">${alerts.map(a => `<li class="pp-alert pp-alert--${esc(a.severity)}"><div><strong>${esc(a.title)}</strong>${a.body ? `<br><span class="cc-small">${esc(a.body)}</span>` : ''}</div>
        <button class="cc-btn cc-btn--small" data-dismiss="${a.id}">Dismiss</button></li>`).join('')}</ul>` : ''}
      <main class="cc-main pp-main">${body}</main></div>`,
    mount(root) {
      root.querySelector('[data-switch]')?.addEventListener('change', (e) => go(`/partner/${tab === 'po' ? 'new' : tab}?p=${encodeURIComponent(e.target.value)}`));
      root.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
        try { await db.rpc('notification_resolve', { p_id: b.dataset.dismiss }); b.closest('li').remove(); } catch (e) { toast(errorText(e), 'bad'); }
      }));
      return mount(root.querySelector('.pp-main'), { go, reload: () => go(location.pathname + location.search) });
    },
  };
}

async function queuePage(p, tab, href) {
  const rows = await db.rpc('partner_queue', { p_partner_id: p.id, p_bucket: tab });
  const empty = { new: 'No new orders. New production orders show up here the moment they’re routed to you.', production: 'Nothing in production.',
    shipping: 'Nothing waiting to ship.', done: 'Nothing finished in the last 60 days.' }[tab];
  return {
    body: rows.length ? `<ul class="pp-list">${rows.map(po => `<li class="pp-card${po.late ? ' is-late' : ''}${po.on_hold ? ' is-hold' : ''}" data-id="${po.id}">
        <a class="pp-card-main" href="${href('/po/' + po.id)}">
          <span class="pp-card-top"><strong>${esc(po.number)}</strong> ${poStagePill(po.status)}${po.on_hold ? ' ' + pill('on_hold', 'On hold') : ''}${po.late ? ' ' + pill('on_hold', 'Late') : ''}</span>
          <span>${esc(po.summary || '')}</span>
          <span class="cc-small cc-muted">${esc(po.ship_to?.city || '')}, ${esc(po.ship_to?.province || '')} · ${tab === 'done' ? `${label(po.status)} ${dateTime(po.shipped_at || po.closed_at)}` : `ship by ${dateTime(po.due_by)}`}${po.shipment ? ` · ${esc(po.shipment.carrier)} ${esc(po.shipment.tracking_number)}` : ''}</span>
        </a>
        ${QUICK[po.status] && !po.on_hold ? `<button class="cc-btn cc-btn--primary pp-quick" data-quick="${QUICK[po.status][0]}">${QUICK[po.status][1]}</button>` : ''}
        ${po.status === 'packed' && !po.on_hold ? `<a class="cc-btn cc-btn--primary pp-quick" href="${href('/po/' + po.id)}">Ship…</a>` : ''}
      </li>`).join('')}</ul>` : `<p class="cc-empty">${esc(empty)}</p>`,
    mount(root, { reload }) {
      root.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', async () => {
        const id = b.closest('[data-id]').dataset.id;
        b.disabled = true;
        try {
          const out = await db.rpc('partner_po_action', { p_po_id: id, p_action: b.dataset.quick, p_data: {} });
          toast(`${PO_STAGE[out.status] || label(out.status)}.`); reload();
        } catch (e) { toast(errorText(e), 'bad'); b.disabled = false; }
      }));
    },
  };
}

async function poPage(id, href) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return { body: '<p class="cc-empty">Production order not found.</p>', mount() {} };
  const po = await db.rpc('partner_po', { p_po_id: id });
  if (!po) return { body: '<p class="cc-empty">Production order not found.</p>', mount() {} };
  return {
    body: `<p class="cc-crumbs"><a href="${href('/' + ({ assigned: 'new', packed: 'shipping', shipped: 'done', rejected: 'done', cancelled: 'done' }[po.status] || 'production'))}">← Back</a></p>
      ${poDetailHTML(po)}`,
    mount(root, { reload }) { bindPoActions(root, po, reload); },
  };
}

async function stockPage(p) {
  const rows = await db.from('partner_inventory').select('product_type,color,size,on_hand,reserved,low_threshold').eq('partner_id', p.id);
  const types = p.product_types?.length ? p.product_types : ['tee', 'hoodie', 'crewneck', 'longsleeve', 'tank'];
  return {
    body: `<header class="cc-head"><div><h2>Blank stock</h2><p class="cc-muted cc-small">${p.tracks_inventory ? 'Orders are only routed to you when the blank is free here.' : 'M-Way doesn’t check your blank stock before routing.'}</p></div>
        <button class="cc-btn cc-btn--primary" data-stock-add>Count / receive stock</button></header>
      ${stockGridHTML(rows)}`,
    mount(root, { reload }) { bindStockGrid(root, p.id, types, reload); },
  };
}

function settingsPage(p) {
  return {
    body: `<section class="cc-card"><h2>Capacity</h2>
      <form class="cc-form" data-settings>
        <div class="cc-fields">
          <label class="cc-field"><span>Units you can have in your queue</span><input name="cap" type="number" min="1" step="1" value="${p.capacity_per_day}"><small>When your open work reaches this, new orders go to other partners.</small></label>
          <label class="cc-field"><span>Usual production time (days)</span><input name="days" type="number" min="0.1" step="0.1" value="${p.production_days}"><small>Sets the ship-by time on new orders (plus a day of buffer).</small></label>
        </div>
        <div class="cc-form-actions"><button class="cc-btn cc-btn--primary">Save</button><span class="cc-form-msg" data-msg></span></div>
      </form></section>
      ${['active', 'inactive'].includes(p.status) ? `<section class="cc-card"><h2>${p.status === 'active' ? 'Pause new orders' : 'Paused'}</h2>
        <p>${p.status === 'active' ? 'Closed for a holiday or a machine is down? Pause and M-Way routes new orders elsewhere. Orders you already have stay with you.' : 'You’re not receiving new orders.'}</p>
        <button class="cc-btn ${p.status === 'active' ? 'cc-btn--danger' : 'cc-btn--primary'}" data-pause="${p.status === 'active'}">${p.status === 'active' ? 'Pause new orders' : 'Start receiving orders'}</button></section>` : ''}
      <section class="cc-card"><h2>What M-Way routes to you</h2>
        <p class="cc-small">Garments: ${p.product_types?.length ? p.product_types.map(t => esc(label(t))).join(', ') : 'all'} · Methods: ${(p.print_methods || []).map(m => esc(m.toUpperCase())).join(', ') || '—'}</p>
        <p class="cc-small cc-muted">To change these, contact M-Way.</p></section>`,
    mount(root, { reload }) {
      root.querySelector('[data-settings]').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await db.rpc('partner_update_settings', { p_partner_id: p.id, p_capacity: Number(e.target.cap.value), p_production_days: Number(e.target.days.value) });
          toast('Saved.'); reload();
        } catch (err) { e.target.querySelector('[data-msg]').textContent = errorText(err); }
      };
      root.querySelector('[data-pause]')?.addEventListener('click', async (e) => {
        try { await db.rpc('partner_update_settings', { p_partner_id: p.id, p_paused: e.currentTarget.dataset.pause === 'true' }); toast('Updated.'); reload(); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}
