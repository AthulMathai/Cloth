// /support            — your requests + start a new one
// /support/:id        — the conversation
// Signed-in only; replies from M-Way show up here and in your account.
import { db, auth } from '../lib/supabase.js';
import { themeForPage, fmtDate } from '../lib/store.js';
import { esc } from '../components/ui.js';
import { signInPage } from './cart.js';
import { track } from '../lib/analytics.js';

const TOPICS = [['order', 'An order'], ['shipping', 'Shipping & delivery'], ['custom_design', 'A custom design'], ['returns', 'Returns & exchanges'],
  ['product', 'A product'], ['account', 'My account'], ['general', 'Something else']];
const STATUS = { open: 'Received', pending: 'We’re on it', waiting_customer: 'Replied — over to you', resolved: 'Resolved', closed: 'Closed' };
const when = (d) => new Date(d).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function load({ id }, query) {
  const theme = await themeForPage('account');
  if (!auth.user) return signInPage(theme, 'Support', 'Help & support', 'Sign in so we can see your orders and reply to you.');
  return id ? thread(theme, id) : home(theme, query);
}

async function home(theme, query) {
  const [tickets, orders] = await Promise.all([
    db.rpc('support_my_tickets'),
    db.from('orders').select('number,created_at').eq('user_id', auth.user.id).neq('status', 'payment_pending').order('created_at', { ascending: false }).limit(20).catch(() => []),
  ]);
  const pre = (query.get('order') || '').toUpperCase();
  return {
    theme, title: 'Support',
    html: `<section class="section commerce"><div class="wrap" style="max-width:820px;display:grid;gap:28px">
      <h1 class="h-section">Help &amp; support</h1>
      ${tickets.length ? `<div class="panel-box"><h2 class="sub-head">Your requests</h2><ul class="sup-list">${tickets.map(t => `<li>
          <a href="/support/${t.id}"><strong>${esc(t.subject)}</strong></a>
          <span class="status-pill small${['resolved', 'closed'].includes(t.status) ? ' is-stopped' : ''}">${esc(STATUS[t.status] || t.status)}</span>
          <span class="muted small">${esc(t.number)}${t.order_number ? ` · ${esc(t.order_number)}` : ''} · ${when(t.last_message_at)}</span></li>`).join('')}</ul></div>` : ''}
      <form class="auth-card" data-new style="margin:0;max-width:none">
        <h2 class="sub-head" style="margin-top:0">${tickets.length ? 'Start a new request' : 'How can we help?'}</h2>
        <div class="field"><label for="topic">It’s about</label><select id="topic" name="topic">${TOPICS.map(([v, l]) => `<option value="${v}"${pre && v === 'order' ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="order">Order (optional)</label><select id="order" name="order"><option value="">—</option>${orders.map(o => `<option${o.number === pre ? ' selected' : ''}>${esc(o.number)}</option>`).join('')}</select></div>
        <div class="field"><label for="subject">Subject</label><input id="subject" name="subject" maxlength="160" required></div>
        <div class="field"><label for="body">Message</label><textarea id="body" name="body" rows="6" maxlength="8000" required></textarea></div>
        <div class="form-row"><button class="btn" type="submit">Send</button></div>
        <p class="form-msg" role="status" data-msg></p>
      </form>
    </div></section>`,
    mount(root) {
      const f = root.querySelector('[data-new]');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const msg = f.querySelector('[data-msg]');
        try {
          const r = await db.rpc('support_open', { p_subject: f.subject.value, p_category: f.topic.value, p_body: f.body.value, p_order_number: f.order.value || null });
          (await import('../app.js')).go(`/support/${r.id}?new=1`);
        } catch (err) { msg.textContent = err.message || 'Couldn’t send. Try again.'; }
      };
    },
  };
}

async function thread(theme, id) {
  const t = /^[0-9a-f-]{36}$/.test(id) ? await db.rpc('support_ticket', { p_ticket: id }).catch(() => null) : null;
  if (!t) return { theme, title: 'Support', html: `<section class="state"><h1>Request not found</h1><p><a class="btn" href="/support">Your requests</a></p></section>` };
  const closed = t.status === 'closed';
  return {
    theme, title: t.subject,
    html: `<section class="section commerce"><div class="wrap" style="max-width:820px;display:grid;gap:22px">
      <p><a href="/support" class="muted">← Your requests</a></p>
      ${new URLSearchParams(location.search).get('new') ? '<p class="confirm-flash" role="status">Thanks — we’ve got your message and will reply here.</p>' : ''}
      <div class="order-head"><h1 class="h-section">${esc(t.subject)}</h1><span class="status-pill${['resolved', 'closed'].includes(t.status) ? ' is-stopped' : ''}">${esc(STATUS[t.status] || t.status)}</span></div>
      <p class="muted">${esc(t.number)}${t.order_number ? ` · order <a href="/orders/${esc(t.order_number)}">${esc(t.order_number)}</a>` : ''} · opened ${fmtDate(t.created_at)}</p>
      <ol class="sup-thread">${t.messages.map(m => `<li class="sup-bubble ${m.author_type === 'customer' ? 'is-me' : m.author_type === 'system' ? 'is-system' : 'is-them'}">
          <span class="muted small">${m.author_type === 'customer' ? 'You' : esc(m.author || 'M-Way')} · ${when(m.at)}</span>
          <p>${esc(m.body).replace(/\n/g, '<br>')}</p></li>`).join('')}</ol>
      ${closed ? `<p class="muted">This request is closed. <a href="/support">Start a new one</a> if you need more help.</p>` : `
      <form class="auth-card" data-reply style="margin:0;max-width:none">
        <div class="field"><label for="reply">Reply</label><textarea id="reply" name="body" rows="4" maxlength="8000" required></textarea></div>
        <div class="form-row"><button class="btn" type="submit">Send reply</button></div><p class="form-msg" role="status" data-msg></p></form>`}
    </div></section>`,
    mount(root) {
      if (new URLSearchParams(location.search).get('new')) track('support_ticket_viewed', { entity_type: 'support_ticket', entity_id: t.id });
      const f = root.querySelector('[data-reply]');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        try { await db.rpc('support_reply', { p_ticket: t.id, p_body: f.body.value }); (await import('../app.js')).go(`/support/${t.id}`); }
        catch (err) { f.querySelector('[data-msg]').textContent = err.message || 'Couldn’t send.'; }
      };
    },
  };
}
