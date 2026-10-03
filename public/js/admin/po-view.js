// One production order, shared by the partner portal and the admin
// fulfillment screens: what to make, where it goes, the next step, and
// its history. Every button calls partner_po_action, which enforces the
// state machine and who may act.
import { db, auth } from '../lib/supabase.js';
import { esc, pill, dateTime, label, toast, confirmDialog, errorText } from './ui.js';

export const PO_STAGE = { assigned: 'New', accepted: 'Accepted', in_production: 'Printing', printed: 'Quality check', packed: 'Packed',
  shipped: 'Shipped', rejected: 'Rejected', cancelled: 'Cancelled' };
export const CARRIERS = ['Canada Post', 'Purolator', 'UPS', 'FedEx', 'Canpar', 'Test carrier'];

const NEXT = {
  assigned: [['accept', 'Accept order', 'primary'], ['reject', 'Can’t make it…', 'danger']],
  accepted: [['start', 'Start production', 'primary'], ['reject', 'Can’t make it…', 'danger']],
  in_production: [['printed', 'Printing done', 'primary']],
  printed: [['packed', 'Passed QC — packed', 'primary'], ['reprint', 'Failed QC — reprint…', '']],
  packed: [['ship', 'Ship + tracking…', 'primary']],
};

export const poStagePill = (s) => pill(s, PO_STAGE[s] || label(s));

export function poItemsHTML(po) {
  const items = po.spec?.items || [];
  return `<ul class="po-items">${items.map(i => `<li>
      <span class="po-swatch" style="background:${esc(i.color_hex || '#ccc')}"></span>
      <div><strong>${i.quantity}× ${esc(i.color)} ${esc(label(i.product_type))} — ${esc(i.size)}</strong>
        <div class="cc-small">${esc(i.name)}${i.sku ? ` · <code>${esc(i.sku)}</code>` : ''}${i.kind === 'custom' ? ' · <span class="cc-tag">Custom</span>' : ''}</div>
        ${(i.edition_numbers || []).length ? `<div class="cc-small">Edition ${i.edition_numbers.map(n => `No. ${String(n).padStart(3, '0')}/${i.edition_size}`).join(', ')} — print the number on the label</div>` : ''}
        ${(i.prints || []).length ? `<div class="cc-small cc-muted">${i.prints.map(p => `${esc(p.placement_label || label(p.placement))}${p.width_in ? ` ${p.width_in}×${p.height_in} in` : ''} · ${esc(p.method_label || p.method || '')}`).join('<br>')}</div>` : '<div class="cc-small cc-muted">Blank — no print</div>'}
      </div></li>`).join('')}</ul>`;
}

export function poShipToHTML(po) {
  const t = po.spec?.ship_to || {};
  return `<address class="po-addr">${esc(t.name || '')}<br>${esc(t.line1 || '')}${t.line2 ? '<br>' + esc(t.line2) : ''}<br>
    ${esc(t.city || '')}, ${esc(t.province || '')} ${esc(t.postal_code || '')}${t.phone ? `<br>${esc(t.phone)}` : ''}</address>
    ${po.spec?.shipping?.service ? `<p class="cc-small cc-muted">Customer chose: ${esc(po.spec.shipping.service)}</p>` : ''}`;
}

export function poActionsHTML(po) {
  if (po.on_hold) return `<div class="cc-alert cc-alert--bad"><strong>On hold.</strong> TH8RTY paused this order. Don’t continue until it’s released.</div>`;
  const btns = (NEXT[po.status] || []).map(([a, l, tone]) => `<button class="cc-btn ${tone ? 'cc-btn--' + tone : ''}" data-po-act="${a}">${esc(l)}</button>`);
  if (po.shipment && po.shipment.carrier?.toLowerCase() === 'test carrier' && !['delivered', 'returned'].includes(po.shipment.status)) {
    btns.push(`<button class="cc-btn" data-po-act="test-scan" title="Only for the built-in test carrier">Simulate next carrier scan</button>`);
  }
  btns.push('<button class="cc-btn" data-po-act="note">Add note</button>');
  return `<div class="cc-actions po-actions">${btns.join('')}</div>`;
}

const EVENT = { assigned: 'Assigned', accept: 'Accepted', reject: 'Rejected', rejected: 'Rejected', cancelled: 'Cancelled', start: 'Production started',
  printed: 'Printing done', reprint: 'Sent back for reprint', packed: 'Packed', ship: 'Shipped', note: 'Note', dispatched: 'Sent to partner’s system' };
export function poTimelineHTML(events) {
  return `<ol class="cc-timeline">${[...(events || [])].reverse().map(e => `<li class="cc-tl-${esc(e.actor_type)}">
    <div><strong>${esc(EVENT[e.event] || label(e.event))}</strong>${e.note ? `<p>${esc(e.note)}</p>` : ''}
      ${e.data?.carrier ? `<p class="cc-small">${esc(e.data.carrier)} ${esc(e.data.tracking_number || '')}</p>` : ''}</div>
    <span class="cc-muted cc-small">${dateTime(e.at)} · ${esc(e.actor || label(e.actor_type))}</span></li>`).join('')}</ol>`;
}

function shipDialog() {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'cc-dialog';
    d.innerHTML = `<form method="dialog"><h2>Ship it</h2>
      <label class="cc-field"><span>Carrier *</span><select name="carrier">${CARRIERS.map(c => `<option>${c}</option>`).join('')}</select></label>
      <label class="cc-field"><span>Tracking number *</span><input name="tracking" autocomplete="off" autocapitalize="characters" required></label>
      <label class="cc-field"><span>Service (optional)</span><input name="service" placeholder="e.g. Expedited Parcel"></label>
      <label class="cc-field"><span>Estimated delivery (optional)</span><input name="eta" type="date"></label>
      <p class="cc-small cc-muted">The customer gets the tracking link right away. “Test carrier” is for trying the flow without a real parcel.</p>
      <p class="cc-form-msg" data-msg></p>
      <div class="cc-form-actions"><button class="cc-btn" type="button" data-cancel>Cancel</button><button class="cc-btn cc-btn--primary">Mark shipped</button></div></form>`;
    document.body.append(d);
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done(null);
    d.addEventListener('cancel', () => done(null));
    f.onsubmit = (e) => {
      e.preventDefault();
      const t = f.tracking.value.replace(/\s/g, '');
      if (t.length < 4) { d.querySelector('[data-msg]').textContent = 'Enter the tracking number.'; return; }
      done({ carrier: f.carrier.value, tracking_number: t, service: f.service.value.trim() || null, estimated_delivery: f.eta.value || null });
    };
    d.showModal(); f.tracking.focus();
  });
}

/** Wire the action buttons + file button inside `root` for `po`. `after` reloads. */
export function bindPoActions(root, po, after) {
  root.querySelectorAll('[data-po-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.poAct;
    let data = {};
    if (act === 'reject') {
      const r = await confirmDialog({ title: `Can’t make ${po.number}?`, tone: 'danger', confirm: 'Send it back',
        body: '<p>TH8RTY re-routes it to another partner straight away. Blanks reserved for it are released.</p>', note: true, noteLabel: 'Why?', noteRequired: true });
      if (!r.ok) return; data.note = r.note;
    } else if (act === 'reprint') {
      const r = await confirmDialog({ title: 'Send back for a reprint?', note: true, noteLabel: 'What failed quality check?', noteRequired: true, confirm: 'Reprint' });
      if (!r.ok) return; data.note = r.note;
    } else if (act === 'note') {
      const r = await confirmDialog({ title: 'Add a note', note: true, noteLabel: 'Note (TH8RTY staff and your team see it)', noteRequired: true, confirm: 'Add note' });
      if (!r.ok) return; data.note = r.note;
    } else if (act === 'ship') {
      const r = await shipDialog(); if (!r) return; data = r;
    }
    b.disabled = true;
    try {
      if (act === 'test-scan') {
        await db.rpc('test_carrier_advance', { p_shipment_id: po.shipment.id });
        toast('Test carrier scan recorded.');
      } else {
        const out = await db.rpc('partner_po_action', { p_po_id: po.id, p_action: act, p_data: data });
        toast(act === 'reject' ? 'Sent back to TH8RTY for re-routing.' : act === 'note' ? 'Note added.' : `${po.number}: ${PO_STAGE[out.status] || label(out.status)}`);
      }
      after();
    } catch (e) { toast(errorText(e), 'bad'); b.disabled = false; }
  }));
  root.querySelector('[data-po-files]')?.addEventListener('click', async (e) => {
    const box = root.querySelector('[data-files-list]');
    e.currentTarget.disabled = true;
    try {
      const res = await fetch(`/api/production-files?po=${po.id}`, { headers: { Authorization: `Bearer ${auth.session?.access_token}` } });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Couldn’t load files.');
      box.innerHTML = out.files.length
        ? `<ul class="po-files">${out.files.map(f => `<li>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" download>${esc(label(f.placement))}</a>` : esc(label(f.placement))} <span class="cc-muted cc-small">${esc(f.name)}</span></li>`).join('')}</ul>
           <p class="cc-small cc-muted">Links expire in an hour.</p>`
        : '<p class="cc-small cc-muted">No print files attached (catalog print files are uploaded per product).</p>';
    } catch (err) { box.innerHTML = `<p class="cc-small">${esc(errorText(err))}</p>`; e.currentTarget.disabled = false; }
  });
}

/** Full PO card body: summary, actions, items, ship-to, files, shipment, history. */
export function poDetailHTML(po, { showPartner = false } = {}) {
  const sh = po.shipment;
  return `<header class="cc-head"><div><h1>${esc(po.number)} ${poStagePill(po.status)} ${po.late ? pill('on_hold', 'Late') : ''}</h1>
      <p class="cc-muted">Order ${esc(po.order_number)} · ${po.units} unit${po.units === 1 ? '' : 's'} · assigned ${dateTime(po.assigned_at)}${po.due_by ? ` · ship by <strong>${dateTime(po.due_by)}</strong>` : ''}
        ${showPartner ? ` · ${esc(po.partner.name)}${po.partner.is_test ? ' <span class="cc-tag">test</span>' : ''}` : ''}${po.reprint_count ? ` · ${po.reprint_count} reprint${po.reprint_count > 1 ? 's' : ''}` : ''}</p></div></header>
    ${po.status === 'rejected' ? `<div class="cc-alert cc-alert--warn"><strong>Rejected.</strong> ${esc(po.rejection_reason || '')}</div>` : ''}
    ${po.status === 'cancelled' ? `<div class="cc-alert cc-alert--warn"><strong>Cancelled.</strong> Stop work on this order.</div>` : ''}
    ${['rejected', 'cancelled', 'shipped'].includes(po.status) ? (sh && po.status === 'shipped' ? poActionsHTML(po) : '') : poActionsHTML(po)}
    <div class="cc-two cc-two--wide">
      <div>
        <section class="cc-card"><h2>Make</h2>${poItemsHTML(po)}</section>
        <section class="cc-card"><div class="cc-card-head"><h2>Print files</h2><button class="cc-btn cc-btn--small" data-po-files>Get download links</button></div>
          <div data-files-list><p class="cc-small cc-muted">Full-resolution files, signed for one hour.</p></div></section>
        <section class="cc-card"><h2>History</h2>${poTimelineHTML(po.events)}</section>
      </div>
      <div>
        <section class="cc-card"><h2>Ship to</h2>${poShipToHTML(po)}</section>
        ${sh ? `<section class="cc-card"><h2>Shipment ${pill(sh.status)}</h2>
          <p>${esc(sh.carrier)} · ${sh.tracking_url ? `<a href="${esc(sh.tracking_url)}" target="_blank" rel="noopener">${esc(sh.tracking_number)}</a>` : `<code>${esc(sh.tracking_number)}</code>`}</p>
          ${(po.shipment_events || []).length ? `<ul class="po-scans">${[...po.shipment_events].reverse().map(e => `<li><strong>${esc(label(e.status))}</strong> ${esc(e.description || '')}${e.location ? ` — ${esc(e.location)}` : ''}<br><span class="cc-small cc-muted">${dateTime(e.at)}</span></li>`).join('')}</ul>` : ''}
          </section>` : ''}
      </div>
    </div>`;
}
