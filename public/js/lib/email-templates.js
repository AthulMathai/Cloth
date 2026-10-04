// Customer email templates. Pure functions (no browser or Node APIs), used
// by the sender (netlify/functions/scheduled-emails.mjs) AND the admin
// preview, so what staff preview is exactly what customers receive.
//
// render(template, data, { siteUrl }) -> { subject, html, text }
// `data` comes from the database function email_payload().

const money = (c) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format((c || 0) / 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (d) => d ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T12:00:00' : d).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
const pad3 = (n) => String(n).padStart(3, '0');

const C = { ink: '#151515', paper: '#f3efe6', line: '#ddd6c8', muted: '#6b665e', accent: '#d42a2f', dark: '#0b0b0c', white: '#ffffff' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const TEMPLATES = {
  welcome: 'Welcome',
  order_confirmed: 'Order confirmed',
  order_delayed: 'Order delayed (backordered)',
  order_shipped: 'Order shipped',
  order_out_for_delivery: 'Out for delivery',
  order_delivered: 'Order delivered',
  order_cancelled: 'Order cancelled',
  order_refunded: 'Order refunded',
  design_approved: 'Design approved',
  design_rejected: 'Design not approved',
  quote_ready: 'Quote ready',
  support_reply: 'Support reply',
};

export function render(template, data = {}, { siteUrl = '' } = {}) {
  const site = siteUrl.replace(/\/$/, '');
  const store = data.store?.name || 'TH8RTY';
  const hi = data.name ? `Hi ${String(data.name).split(' ')[0]},` : 'Hi,';
  const o = data.order;
  const orderUrl = o ? `${site}/orders/${encodeURIComponent(o.number)}` : `${site}/orders`;
  const ship = o?.shipments?.[0];
  const B = (title, paras, cta, extra = '') => ({ title, paras, cta, extra });
  let subject, b;

  switch (template) {
    case 'welcome':
      subject = `Welcome to ${store}`;
      b = B('Welcome in.', [hi, `Your ${store} account is ready. Save pieces to your wishlist, keep your designs, and follow every order from print to doorstep.`,
        'Got an idea? The Custom Designer turns it into something you can wear — upload artwork, or describe it and let AI draw it.'],
        ['Start designing', `${site}/custom`]);
      break;
    case 'order_confirmed':
      subject = `Order #${o.number} confirmed`;
      b = B('Thanks — your order is in.', [hi, `We've got order <strong>#${esc(o.number)}</strong>. ${o.items.some(i => i.custom) ? 'Custom pieces are checked, then printed to order. ' : ''}We'll email you when it ships.`],
        ['Track your order', orderUrl], orderTable(o) + addressBlock(o));
      break;
    case 'order_delayed':
      subject = `Order #${o.number}: a short delay`;
      b = B('A short delay.', [hi, `Something in order <strong>#${esc(o.number)}</strong> is waiting on stock at our print partner. It's still reserved for you and will ship as soon as it's in — no need to do anything.`,
        'If you\'d rather cancel, reply to this email and we\'ll sort it out.'], ['See order status', orderUrl]);
      break;
    case 'order_shipped':
      subject = `Order #${o.number} has shipped`;
      b = B('It\'s on the way.', [hi, `Order <strong>#${esc(o.number)}</strong> left the print shop${ship?.carrier ? ` with ${esc(ship.carrier)}` : ''}.`,
        ship?.tracking_number ? `Tracking number: <strong>${esc(ship.tracking_number)}</strong>${ship.estimated_delivery ? `<br>Estimated delivery: ${esc(date(ship.estimated_delivery))}` : ''}` : 'Tracking details will appear on your order page as soon as the carrier scans it.'],
        [ship?.tracking_url ? 'Track package' : 'Track your order', ship?.tracking_url || orderUrl], orderTable(o, { compact: true }));
      break;
    case 'order_out_for_delivery':
      subject = `Order #${o.number} is out for delivery`;
      b = B('Arriving today.', [hi, `Order <strong>#${esc(o.number)}</strong> is out for delivery${ship?.carrier ? ` with ${esc(ship.carrier)}` : ''}.`], ['Track your order', orderUrl]);
      break;
    case 'order_delivered':
      subject = `Order #${o.number} was delivered`;
      b = B('Delivered.', [hi, `Order <strong>#${esc(o.number)}</strong> has arrived. We hope it's exactly what you pictured.`,
        'Wash cold, inside out, and hang dry — prints last longer that way. Something not right? Reply to this email or open a request from your order page.'],
        ['View your order', orderUrl]);
      break;
    case 'order_cancelled':
      subject = `Order #${o.number} was cancelled`;
      b = B('Order cancelled.', [hi, `Order <strong>#${esc(o.number)}</strong> has been cancelled.${o.paid_at ? ' Any payment is refunded to your original payment method; banks usually show it within 5–10 business days.' : ''}`,
        'Questions? Just reply to this email.'], ['View order', orderUrl]);
      break;
    case 'order_refunded':
      subject = `Refund for order #${o.number}`;
      b = B('Your refund is on its way.', [hi, `We've refunded <strong>${money(o.refunded_cents || o.total_cents)}</strong> for order <strong>#${esc(o.number)}</strong> to your original payment method. Banks usually show it within 5–10 business days.`],
        ['View order', orderUrl]);
      break;
    case 'design_approved':
      subject = `Your design "${data.design?.name || 'Untitled'}" is approved`;
      b = B('Approved — ready to print.', [hi, `Your design <strong>${esc(data.design?.name || 'Untitled design')}</strong> passed review and can be ordered now.`],
        ['Order it', `${site}/custom/${data.design?.id}`]);
      break;
    case 'design_rejected':
      subject = `Your design "${data.design?.name || 'Untitled'}" needs changes`;
      b = B('This one needs changes.', [hi, `We couldn't approve <strong>${esc(data.design?.name || 'your design')}</strong> for printing as it is.`,
        data.design?.note ? `Reviewer's note: “${esc(data.design.note)}”` : 'Usually that means it may include someone else\'s logo, character or artwork, or the image is too small to print sharply.',
        'Edit it and submit again — most designs are approved on the second try.'], ['Edit design', `${site}/custom/${data.design?.id}`]);
      break;
    case 'quote_ready': {
      const q = data.quote || {};
      subject = `Your quote${q.number ? ` #${q.number}` : ''} is ready`;
      b = B('Your quote is ready.', [hi, `For ${q.quantity ? `<strong>${esc(q.quantity)}</strong> × ` : ''}${esc(q.product || 'your custom order')}: <strong>${money(q.unit_cents)}</strong> each, <strong>${money(q.total_cents)}</strong> in total.`,
        q.expires_at ? `This price is held until ${esc(date(q.expires_at))}.` : '',
        'To go ahead, just reply to this email (or message us from the help page) and we\'ll set up your order at this price.'], ['Message us', `${site}/support`]);
      break;
    }
    case 'support_reply': {
      const t = data.ticket || {};
      subject = `Re: ${t.subject || 'your request'}${t.number ? ` [#${t.number}]` : ''}`;
      b = B('We replied to your request.', [hi, `<span style="white-space:pre-wrap">${esc(data.message || '')}</span>`],
        ['View the conversation', `${site}/support/${t.id || ''}`]);
      break;
    }
    default:
      throw new Error(`Unknown email template: ${template}`);
  }
  return { subject, html: layout(b, { store, site, preheader: stripTags(b.paras[1] || b.title) }), text: toText(b, store, site) };
}

function orderTable(o, { compact = false } = {}) {
  const rows = (o.items || []).map(i => `<tr>
      <td style="padding:10px 0;border-bottom:1px solid ${C.line};font:15px/1.4 ${FONT};color:${C.ink}">
        <strong>${esc(i.name)}</strong>${i.custom ? ' · custom' : ''}<br>
        <span style="color:${C.muted};font-size:13px">${[i.color, i.size].filter(Boolean).map(esc).join(' / ')} · Qty ${i.quantity}${i.editions?.length ? ` · No. ${i.editions.map(pad3).join(', ')}` : ''}</span></td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid ${C.line};font:15px/1.4 ${FONT};color:${C.ink};white-space:nowrap">${money(i.line_total_cents)}</td></tr>`).join('');
  if (compact) return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">${rows}</table>`;
  const line = (l, v, strong) => `<tr><td style="padding:4px 0;font:${strong ? 'bold 16px' : '14px'}/1.4 ${FONT};color:${strong ? C.ink : C.muted}">${l}</td>
      <td align="right" style="padding:4px 0;font:${strong ? 'bold 16px' : '14px'}/1.4 ${FONT};color:${C.ink}">${v}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px">${rows}
    <tr><td colspan="2" style="height:8px"></td></tr>
    ${line('Subtotal', money(o.subtotal_cents))}
    ${o.discount_cents ? line(`Discount${o.discount_code ? ` (${esc(o.discount_code)})` : ''}`, '−' + money(o.discount_cents)) : ''}
    ${line('Shipping', o.shipping_cents ? money(o.shipping_cents) : 'Free')}
    ${line('Tax', money(o.tax_cents))}
    ${line('Total', money(o.total_cents), true)}</table>`;
}

function addressBlock(o) {
  const a = o.shipping_address || {};
  const lines = [a.name, a.line1, a.line2, [a.city, a.province, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean);
  if (!lines.length) return '';
  return `<p style="margin:22px 0 0;font:14px/1.5 ${FONT};color:${C.muted}"><strong style="color:${C.ink}">Shipping to</strong><br>${lines.map(esc).join('<br>')}</p>`;
}

function layout(b, { store, site, preheader }) {
  const [label, href] = b.cta || [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(b.title)}</title></head>
<body style="margin:0;padding:0;background:${C.paper}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader).slice(0, 140)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="background:${C.dark};padding:22px 28px">
      <a href="${esc(site || '#')}" style="font:900 26px/1 Impact, 'Arial Black', ${FONT};letter-spacing:.02em;color:${C.white};text-decoration:none">${esc(store)}</a></td></tr>
    <tr><td style="background:${C.white};padding:32px 28px 30px;border:1px solid ${C.line};border-top:0">
      <h1 style="margin:0 0 18px;font:800 26px/1.15 ${FONT};color:${C.ink}">${esc(b.title)}</h1>
      ${b.paras.filter(Boolean).map(p => `<p style="margin:0 0 14px;font:16px/1.55 ${FONT};color:${C.ink}">${p}</p>`).join('')}
      ${href ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${C.accent}">
        <a href="${esc(href)}" style="display:inline-block;padding:14px 24px;font:bold 15px/1 ${FONT};color:${C.white};text-decoration:none;letter-spacing:.02em">${esc(label)}</a></td></tr></table>` : ''}
      ${b.extra || ''}
    </td></tr>
    <tr><td style="padding:18px 28px;font:12px/1.5 ${FONT};color:${C.muted}">
      ${esc(store)} · Drawn by hand, printed to order in Canada.<br>
      You're getting this because of activity on your account. Reply to this email to reach us.
      ${site ? `<br><a href="${esc(site)}/account" style="color:${C.muted}">Your account</a> · <a href="${esc(site)}/support" style="color:${C.muted}">Help</a>` : ''}
    </td></tr>
  </table></td></tr></table></body></html>`;
}

const stripTags = (s) => String(s || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function toText(b, store, site) {
  const extra = stripTags((b.extra || '').replace(/<\/tr>/g, '\n').replace(/<\/td>\s*<td[^>]*>/g, '  ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return [b.title, '', b.paras.filter(Boolean).map(stripTags).join('\n\n'), b.cta ? `\n${b.cta[0]}: ${b.cta[1]}` : '', extra ? `\n${extra}` : '',
    `\n— ${store}${site ? ` · ${site}` : ''}`].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
