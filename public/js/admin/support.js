// Support desk: request queue and the conversation view. Replies notify
// the customer in their account; internal notes are never shown to them.
import { db } from '../lib/supabase.js';
import { esc, num, table, dateTime, label, toast, errorText, bindRowLinks, kpi } from './ui.js';
import { ticketPill, TICKET_LABEL } from './customers.js';

const VIEWS = [['needs_reply', 'Needs reply'], ['open', 'Open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['waiting_customer', 'Waiting on customer'], ['resolved', 'Resolved'], ['all', 'All']];
export const CATEGORIES = { order: 'Order', shipping: 'Shipping & delivery', custom_design: 'Custom design', returns: 'Returns & exchanges', product: 'Product question', account: 'Account', general: 'Something else' };
const PRIORITY_TONE = { urgent: 'bad', high: 'warn', normal: 'mute', low: 'mute' };
const prio = (p) => p === 'normal' ? '' : `<span class="cc-pill cc-pill--${PRIORITY_TONE[p]}">${esc(label(p))}</span>`;

export async function view(ctx) {
  return ctx.segs[1] ? ticket(ctx, ctx.segs[1]) : list(ctx);
}

async function list(ctx) {
  const v = ctx.query.get('view') || 'needs_reply', q = ctx.query.get('q') || '';
  const r = await db.rpc('admin_support_tickets', { p_view: v, p_q: q || null, p_limit: 300 });
  const c = r.counts;
  return {
    title: 'Support',
    html: `<header class="cc-head"><div><h1>Support</h1><p class="cc-muted">Requests from customers' accounts, plus calls and emails logged by staff.</p></div>
        <form class="cc-search" data-search role="search"><input name="q" value="${esc(q)}" placeholder="SUP number, email, name or subject" aria-label="Search requests"><button class="cc-btn">Search</button></form></header>
      <div class="cc-kpis cc-kpis--small">
        ${kpi('Needs a reply', num(c.needs_reply), 'customer wrote last', '/admin/support?view=needs_reply')}
        ${kpi('Open', num(c.open), `${num(c.unassigned)} unassigned`, '/admin/support?view=open')}
        ${kpi('Waiting on customer', num(c.waiting_customer), '', '/admin/support?view=waiting_customer')}
        ${kpi('First response', r.avg_first_response_hours != null ? `${r.avg_first_response_hours} h` : '—', 'average, last 30 days')}
      </div>
      <nav class="cc-tabs">${VIEWS.map(([k, l]) => `<a href="/admin/support?view=${k}${q ? '&q=' + encodeURIComponent(q) : ''}"${k === v ? ' aria-current="true"' : ''}>${esc(l)}${c[k] != null ? ` <span class="crm-count">${num(c[k])}</span>` : ''}</a>`).join('')}</nav>
      <section class="cc-card cc-card--flush">${table(r.rows, [
        { label: 'Request', render: t => `<a href="/admin/support/${t.id}"><strong>${esc(t.number)}</strong></a> ${prio(t.priority)}<br><span>${esc(t.subject)}</span>` },
        { label: 'Customer', render: t => `${esc(t.name || '')}<br><span class="cc-muted cc-small">${esc(t.email)}</span>` },
        { label: 'Topic', render: t => `${esc(CATEGORIES[t.category] || t.category)}${t.order_number ? `<br><span class="cc-small cc-muted">${esc(t.order_number)}</span>` : ''}` },
        { label: 'Status', render: t => ticketPill(t.status) + (t.last_message_by === 'customer' && ['open', 'pending'].includes(t.status) ? ' <span class="cc-tag">customer replied</span>' : '') },
        { label: 'Assigned', render: t => esc(t.assignee || '—') },
        { label: 'Messages', align: 'right', render: t => num(t.messages) },
        { label: 'Last activity', render: t => dateTime(t.last_message_at) }],
        { empty: v === 'needs_reply' ? 'Nobody is waiting on a reply.' : 'No requests here.', rowHref: t => `/admin/support/${t.id}` })}</section>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(`/admin/support?view=all&q=${encodeURIComponent(e.target.q.value.trim())}`); };
    },
  };
}

async function ticket(ctx, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { title: 'Not found', html: '<p class="cc-empty">Request not found.</p>' };
  const [t, meta] = await Promise.all([db.rpc('support_ticket', { p_ticket: id }), db.rpc('admin_support_tickets', { p_view: 'mine', p_limit: 1 })]);
  if (!t) return { title: 'Not found', html: '<p class="cc-empty">Request not found.</p>' };
  const canWrite = meta.can_write;
  const sel = (name, opts, cur) => `<select name="${name}" aria-label="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return {
    title: t.number,
    html: `<p class="cc-crumbs"><a href="/admin/support">Support</a> / ${esc(t.number)}</p>
      <header class="cc-head"><div><h1>${esc(t.subject)} ${ticketPill(t.status)} ${prio(t.priority)}</h1>
        <p class="cc-muted">${esc(t.number)} · ${esc(CATEGORIES[t.category] || t.category)} · via ${esc(label(t.channel))} · opened ${dateTime(t.created_at)}</p></div></header>
      <div class="cc-two cc-two--wide">
        <div>
          <section class="cc-card"><ol class="sup-thread">${t.messages.map(m => `<li class="sup-msg sup-msg--${esc(m.author_type)}${m.internal ? ' is-internal' : ''}">
              <div class="sup-meta"><strong>${esc(m.author_type === 'customer' ? (t.name || t.email) : m.author || 'Staff')}</strong>
                ${m.internal ? '<span class="cc-tag">internal</span>' : ''}<span class="cc-small cc-muted">${dateTime(m.at)}</span></div>
              <p>${esc(m.body).replace(/\n/g, '<br>')}</p></li>`).join('')}</ol></section>
          ${canWrite ? `<section class="cc-card"><form class="sup-reply" data-reply>
              <div class="cc-seg sup-mode" role="radiogroup" aria-label="Reply type">
                <label><input type="radio" name="mode" value="reply" checked> Reply to customer</label>
                <label><input type="radio" name="mode" value="internal"> Internal note</label></div>
              <textarea name="body" rows="5" placeholder="Write a reply…" aria-label="Message"></textarea>
              <div class="cc-form-actions">
                <label class="cc-small">After sending: ${sel('after', [['waiting_customer', 'Waiting on customer'], ['pending', 'Keep in progress'], ['resolved', 'Resolved']], 'waiting_customer')}</label>
                <button class="cc-btn cc-btn--primary">Send</button><span class="cc-form-msg" data-msg></span></div>
              <p class="cc-small cc-muted" data-hint>The customer sees replies in their account (support page). Email delivery needs an email provider.</p>
            </form></section>` : ''}
        </div>
        <div>
          <section class="cc-card"><h2>Customer</h2>
            <p><strong>${esc(t.name || '')}</strong><br><a href="mailto:${esc(t.email)}">${esc(t.email)}</a></p>
            ${t.user_id ? `<a class="cc-btn cc-btn--small" href="/admin/customers/${t.user_id}">Customer profile</a>` : ''}
            ${t.order_number ? `<p class="cc-small">About order <a href="/admin/orders?q=${encodeURIComponent(t.order_number)}">${esc(t.order_number)}</a></p>` : ''}</section>
          ${canWrite ? `<section class="cc-card"><h2>Details</h2><form class="cc-form" data-details>
              <label class="cc-field"><span>Status</span>${sel('status', Object.entries(TICKET_LABEL), t.status)}</label>
              <label class="cc-field"><span>Priority</span>${sel('priority', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], t.priority)}</label>
              <label class="cc-field"><span>Assigned to</span>${sel('assignee', [['', 'Nobody'], ...meta.staff.map(s => [s.id, s.name])], t.assignee?.id)}</label>
              <label class="cc-field"><span>Topic</span>${sel('category', Object.entries(CATEGORIES), t.category)}</label>
              <div class="cc-form-actions"><button class="cc-btn">Update</button></div></form>
            <p class="cc-small cc-muted">${t.first_response_at ? `First reply ${dateTime(t.first_response_at)}` : 'No reply yet.'}${t.resolved_at ? ` · resolved ${dateTime(t.resolved_at)}` : ''}</p></section>` : ''}
        </div>
      </div>`,
    mount(root) {
      const reload = () => ctx.go(location.pathname);
      const f = root.querySelector('[data-reply]');
      f?.addEventListener('change', () => {
        const internal = f.mode.value === 'internal';
        f.classList.toggle('is-internal', internal);
        f.after.disabled = internal;
        f.body.placeholder = internal ? 'Only staff see internal notes…' : 'Write a reply…';
      });
      f?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const internal = f.mode.value === 'internal';
        if (!f.body.value.trim()) { f.querySelector('[data-msg]').textContent = 'Write a message first.'; return; }
        try {
          await db.rpc('support_reply', { p_ticket: t.id, p_body: f.body.value, p_internal: internal, p_status: internal ? null : f.after.value });
          toast(internal ? 'Note added.' : 'Reply sent.'); reload();
        } catch (err) { f.querySelector('[data-msg]').textContent = errorText(err); }
      });
      root.querySelector('[data-details]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const d = e.target;
        try {
          await db.rpc('support_update', { p_ticket: t.id, p_status: d.status.value !== t.status ? d.status.value : null, p_priority: d.priority.value,
            p_assignee: d.assignee.value || null, p_unassign: !d.assignee.value, p_category: d.category.value });
          toast('Updated.'); reload();
        } catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}
