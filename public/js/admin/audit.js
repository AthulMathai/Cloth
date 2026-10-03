// Audit log: who changed what, with before/after.
import { db } from '../lib/supabase.js';
import { esc, table, dateTime, label } from './ui.js';

export async function view(ctx) {
  const type = ctx.query.get('type') || null, id = ctx.query.get('id') || null;
  const rows = await db.rpc('admin_audit', { p_entity_type: type, p_entity_id: id, p_limit: 300 });
  const diff = (r) => {
    if (!r.before || !r.after) return `<code class="ad-small">${esc(JSON.stringify(r.after || r.before || {}).slice(0, 160))}</code>`;
    const keys = [...new Set([...Object.keys(r.before), ...Object.keys(r.after)])]
      .filter(k => !['updated_at', 'search_doc'].includes(k) && JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]));
    return keys.slice(0, 6).map(k => `<div class="ad-small"><strong>${esc(k)}</strong>: <s class="ad-muted">${esc(JSON.stringify(r.before[k]))?.slice(0, 60)}</s> → ${esc(JSON.stringify(r.after[k])?.slice(0, 60))}</div>`).join('') || '<span class="ad-muted ad-small">no field changes</span>';
  };
  return {
    title: 'Audit log',
    html: `<header class="ad-head"><div><h1>Audit log</h1><p class="ad-muted">${rows.length} most recent${type ? ` · ${esc(label(type))}` : ''}</p></div>
        ${type ? '<a class="ad-btn" href="/admin/audit">Show everything</a>' : ''}</header>
      <p class="ad-note">Product, price, inventory, discount, pricing-rule, role and moderation changes are recorded automatically and can't be edited.</p>
      <section class="ad-card ad-card--flush">${table(rows, [
        { label: 'When', render: r => dateTime(r.created_at) }, { label: 'Who', render: r => esc(r.actor || label(r.actor_role || 'system')) },
        { label: 'Action', render: r => esc(label(r.action)) },
        { label: 'What', render: r => `<a href="/admin/audit?type=${encodeURIComponent(r.entity_type)}&id=${encodeURIComponent(r.entity_id)}">${esc(label(r.entity_type))}</a>` },
        { label: 'Change', render: diff }], { empty: 'Nothing recorded yet.' })}</section>`,
  };
}
