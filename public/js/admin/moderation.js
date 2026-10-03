// Human moderation queue: review customer artwork flagged by the automated
// checks (or anything, by status). Every decision is logged.
import { db, storage } from '../lib/supabase.js';
import { esc, pill, dateTime, label, toast, confirmDialog, errorText } from './ui.js';

const TABS = [['review', 'Needs review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];

export async function view(ctx) {
  const status = TABS.some(t => t[0] === ctx.query.get('status')) ? ctx.query.get('status') : 'review';
  const focus = ctx.query.get('id');
  let rows = await db.rpc('admin_moderation_queue', { p_status: focus ? 'all' : status, p_limit: 100 });
  if (focus) rows = rows.filter(r => r.id === focus);
  const mockups = rows.flatMap(r => Object.values(r.mockups || {}));
  const originals = rows.flatMap(r => (r.assets || []).map(a => a.path));
  const [mk, og] = await Promise.all([storage.sign('mockups', mockups).catch(() => ({})), storage.sign('designs', originals).catch(() => ({}))]);
  return {
    title: 'Moderation',
    html: `<header class="ad-head"><div><h1>Custom design moderation</h1><p class="ad-muted">${rows.length} design${rows.length === 1 ? '' : 's'}${focus ? '' : ` · ${label(TABS.find(t => t[0] === status)[1]).toLowerCase()}`}</p></div></header>
      <nav class="ad-tabs">${TABS.map(([s, l]) => `<a href="/admin/designs${s === 'review' ? '' : `?status=${s}`}"${s === status && !focus ? ' aria-current="true"' : ''}>${l}</a>`).join('')}</nav>
      <p class="ad-note">Automated checks flag <em>possible</em> problems (brands, characters, low resolution, unsafe files). They are not legal findings — you decide. Approving releases any orders waiting on this design to production; rejecting puts them on hold so the customer can be contacted.</p>
      ${rows.length ? rows.map(r => card(r, mk, og, ctx.can('moderation.review'))).join('') : '<p class="ad-empty">Nothing waiting for review. 🎉</p>'}`,
    mount(root) {
      root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-decide]'); if (!b) return;
        const id = b.closest('[data-design]').dataset.design, decision = b.dataset.decide;
        const titles = { approve: 'Approve this design?', reject: 'Reject this design?', request_changes: 'Ask the customer for changes?', escalate: 'Escalate for a second opinion?' };
        const r = await confirmDialog({ title: titles[decision], confirm: label(decision), tone: decision === 'approve' ? 'primary' : 'danger',
          note: true, noteRequired: decision !== 'approve', noteLabel: decision === 'approve' ? 'Note (optional)' : decision === 'request_changes' ? 'What should they change? (the customer sees this)' : decision === 'reject' ? 'Reason (the customer sees this)' : 'Why escalate? (staff only)' });
        if (!r.ok) return;
        try {
          const out = await db.rpc('admin_moderate', { p_design_id: id, p_decision: decision, p_note: r.note || null });
          toast(`Design ${label(out.status).toLowerCase()}.${out.orders_updated ? ` ${out.orders_updated} order(s) updated.` : ''}`);
          ctx.go(location.pathname + location.search);
        } catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}

function card(r, mk, og, canDecide) {
  const latest = r.latest, findings = latest?.findings || [];
  const layers = r.config?.layers || [];
  return `<article class="ad-card ad-mod" data-design="${r.id}">
    <div class="ad-mod-media">
      ${Object.entries(r.mockups || {}).map(([v, p]) => mk[p] ? `<figure><img src="${mk[p]}" alt="${esc(v)} mockup"><figcaption>${esc(label(v))}</figcaption></figure>` : '').join('') || '<p class="ad-empty">No mockup.</p>'}
      ${(r.assets || []).filter(a => a.kind === 'original').map(a => og[a.path] ? `<figure><a href="${og[a.path]}" target="_blank" rel="noopener"><img src="${og[a.path]}" alt="Uploaded artwork" class="is-art"></a><figcaption>Original: ${esc(a.name || '')}</figcaption></figure>` : '').join('')}
    </div>
    <div class="ad-mod-info">
      <h2>${esc(r.name)} ${pill(r.status)} <span class="ad-muted ad-small">v${r.version}${r.approved_version ? ` · approved v${r.approved_version}` : ''}</span></h2>
      <p class="ad-muted">${esc(r.product_name || '')} · ${esc(r.customer_name || '')} &lt;${esc(r.customer_email || '')}&gt; · submitted ${dateTime(r.submitted_at)}</p>
      ${latest ? `<p><strong>${esc(latest.provider === 'human' ? 'Last reviewer decision' : 'Automated check')}:</strong> ${pill(latest.decision)} risk ${latest.risk_score}/100</p>` : ''}
      ${findings.length ? `<ul class="ad-findings">${findings.map(f => `<li class="is-${esc(f.severity || f.kind || 'info')}"><strong>${esc(label(f.category || f.kind || f.severity || ''))}</strong> ${esc(f.message || '')}</li>`).join('')}</ul>` : ''}
      ${layers.filter(l => l.type === 'text').length ? `<p class="ad-small"><strong>Text on the design (OCR not needed):</strong> ${layers.filter(l => l.type === 'text').map(l => `“${esc(l.text)}”`).join(', ')}</p>` : ''}
      <p class="ad-small"><strong>Layers:</strong> ${layers.map(l => `${esc(label(l.type))} on ${esc(label(l.placement))} (${(+l.w_in).toFixed(1)}×${(+l.h_in).toFixed(1)} in)`).join(' · ') || '—'}</p>
      ${r.orders?.length ? `<p class="ad-small"><strong>Orders:</strong> ${r.orders.map(o => `<a href="/admin/orders/${o.id}">${esc(o.number)}</a> ${pill(o.status)}`).join(' ')}</p>` : ''}
      ${r.decision_note ? `<p class="ad-small"><strong>Note to customer:</strong> ${esc(r.decision_note)}</p>` : ''}
      ${canDecide ? `<div class="ad-actions">
        <button class="ad-btn ad-btn--primary" data-decide="approve">Approve</button>
        <button class="ad-btn" data-decide="request_changes">Request changes</button>
        <button class="ad-btn ad-btn--danger" data-decide="reject">Reject</button>
        <button class="ad-btn" data-decide="escalate">Escalate</button></div>` : ''}
      ${r.history?.length > 1 ? `<details class="ad-small"><summary>Review history (${r.history.length})</summary><ol class="ad-timeline">${r.history.map(h => `<li><div><strong>${esc(h.provider === 'human' ? 'Reviewer' : 'Automated')}</strong> ${pill(h.decision)} v${h.version} · risk ${h.risk}
          ${(h.findings || []).map(f => `<p>${esc(f.message || '')}${f.reviewer ? ` — ${esc(f.reviewer)}` : ''}</p>`).join('')}</div><span class="ad-muted">${dateTime(h.at)}</span></li>`).join('')}</ol></details>` : ''}
    </div></article>`;
}
