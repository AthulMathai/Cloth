// Staff users & roles (super admins, or anyone with users.manage).
import { db, auth } from '../lib/supabase.js';
import { esc, table, date, label, toast, confirmDialog, errorText } from './ui.js';

const ROLE_HELP = {
  super_admin: 'Everything, including staff and permissions.', admin: 'Runs the store day to day.',
  order_manager: 'Orders, refunds, customers.', product_manager: 'Products, inventory, pricing.', moderator: 'Reviews customer artwork.',
  marketing_manager: 'Discounts, promotions, collections.', fulfillment_manager: 'Production and partners.',
  support_agent: 'Reads orders and customers, writes support notes.', partner_admin: 'A print partner’s own portal (Phase 7).',
};

export async function view(ctx) {
  const d = await db.rpc('admin_staff');
  const supers = d.staff.filter(s => s.role === 'super_admin').length;
  return {
    title: 'Users & roles',
    html: `<header class="cc-head"><div><h1>Users & roles</h1><p class="cc-muted">${d.staff.length} role assignments</p></div></header>
      <section class="cc-card"><h2>Add staff</h2>
        <form class="cc-inline cc-inline--wide" data-grant><input name="email" type="email" placeholder="their account email" required aria-label="Email">
          <select name="role" aria-label="Role">${d.roles.filter(r => r !== 'partner_admin').map(r => `<option value="${r}"${r === 'admin' ? ' selected' : ''}>${esc(label(r))}</option>`).join('')}</select>
          <button class="cc-btn cc-btn--primary">Add role</button></form>
        <p class="cc-muted cc-small">They need a store account first (they can sign up at /account/sign-up). Each person only gets the permissions their job needs.</p></section>
      <section class="cc-card cc-card--flush">${table(d.staff, [
        { label: 'Person', render: s => `<strong>${esc(s.name || s.email)}</strong><br><span class="cc-muted cc-small">${esc(s.email)}</span>` },
        { label: 'Role', render: s => `<span class="cc-tag">${esc(label(s.role))}</span>` },
        { label: 'Can', render: s => `<span class="cc-small">${esc(ROLE_HELP[s.role] || '')}</span>` },
        { label: 'Since', render: s => date(s.granted_at) },
        { label: '', render: s => (s.role === 'super_admin' && supers <= 1) ? '<span class="cc-muted cc-small">last super admin</span>'
            : `<button class="cc-btn cc-btn--small cc-btn--danger" data-revoke="${s.id}" data-who="${esc(s.email)}" data-role="${esc(s.role)}">Remove</button>` }])}</section>
      <section class="cc-card"><h2>What each role can do</h2>${table(Object.entries(d.permissions).map(([role, perms]) => ({ role, perms })), [
        { label: 'Role', render: r => esc(label(r.role)) }, { label: 'Permissions', render: r => r.perms.map(p => `<code class="cc-small">${esc(p)}</code>`).join(' ') }])}
        <p class="cc-muted cc-small">Super admins have every permission. Permissions are data in the database, so roles can be tuned without code changes.</p></section>`,
    mount(root) {
      root.querySelector('[data-grant]').onsubmit = async (e) => {
        e.preventDefault();
        try { await db.rpc('admin_grant_role', { p_email: e.target.email.value.trim(), p_role: e.target.role.value }); toast('Role added.'); ctx.go(location.pathname); }
        catch (err) { toast(errorText(err), 'bad'); }
      };
      root.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-revoke]'); if (!b) return;
        const self = d.staff.find(s => s.id === b.dataset.revoke)?.user_id === auth.user.id;
        const r = await confirmDialog({ title: `Remove ${label(b.dataset.role)} from ${b.dataset.who}?`, tone: 'danger', confirm: 'Remove',
          body: self ? '<p><strong>This is your own access.</strong> You may lose access to parts of the admin.</p>' : '' });
        if (!r.ok) return;
        try { await db.remove('user_roles', { id: b.dataset.revoke }); toast('Role removed.'); ctx.go(location.pathname); }
        catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}
