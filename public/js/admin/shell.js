// /admin — the control center. Signed-in staff only; every section and
// action is also enforced by the database (RLS + permission-checked
// functions), so hiding a menu item is convenience, not security.
import { auth, db } from '../lib/supabase.js';
import { themeForPage } from '../lib/store.js';
import { esc } from './ui.js';

const NAV = [
  { label: 'Dashboard', href: '/admin', perm: 'staff', match: /^$/ },
  { group: 'Orders', perm: 'orders.read', items: [
    ['All orders', '/admin/orders'], ['Pending', '/admin/orders?group=pending'], ['Production', '/admin/orders?group=production'],
    ['Shipped', '/admin/orders?group=shipped'], ['Delivered', '/admin/orders?group=delivered'], ['Backorders', '/admin/orders?group=backorders'],
    ['Returns', '/admin/orders?group=returns'], ['Refunds', '/admin/orders?group=refunds'], ['Quotes', '/admin/quotes']] },
  { group: 'Products', perm: 'staff', items: [
    ['Products', '/admin/products'], ['Categories', '/admin/categories', 'catalog.write'], ['Collections', '/admin/collections', 'catalog.write'],
    ['Designers', '/admin/designers', 'catalog.write'], ['Limited drops', '/admin/drops'], ['Archive', '/admin/products?status=archived'],
    ['Inventory', '/admin/inventory', 'inventory.write']] },
  { group: 'Custom designs', perm: 'moderation.review', items: [
    ['Moderation', '/admin/designs'], ['Approved', '/admin/designs?status=approved'], ['Rejected', '/admin/designs?status=rejected'],
    ['All designs', '/admin/designs?status=all'], ['Custom pricing', '/admin/pricing', 'pricing.write']] },
  { group: 'Fulfillment', perm: 'fulfil', items: [
    ['Overview & alerts', '/admin/fulfillment'], ['Production queue', '/admin/fulfillment/production'], ['Partners', '/admin/fulfillment/partners'],
    ['Partner inventory', '/admin/fulfillment/stock'], ['Shipments', '/admin/fulfillment/shipments']] },
  { group: 'Customers', perm: 'customers.read', items: [
    ['All customers', '/admin/customers'], ['High value', '/admin/customers?segment=high_value'], ['Inactive', '/admin/customers?segment=inactive'],
    ['Custom-design customers', '/admin/customers?segment=custom_design'], ['Abandoned bags', '/admin/customers/abandoned'], ['Support', '/admin/support']] },
  { group: 'Analytics', perm: 'analytics.read', items: [
    ['Sales', '/admin/analytics?tab=sales'], ['Website', '/admin/analytics?tab=website'], ['Products', '/admin/analytics?tab=products'],
    ['Fulfillment', '/admin/analytics?tab=fulfillment'], ['Custom designs', '/admin/analytics?tab=designs'], ['Forecast', '/admin/analytics?tab=forecast'],
    ['AI', '/admin/ai']] },
  { group: 'Marketing', perm: 'marketing.write', items: [['Discounts', '/admin/discounts'], ['Promotions', '/admin/promotions']] },
  { group: 'Settings', perm: 'staff', items: [
    ['Shipping', '/admin/shipping', 'settings.write'], ['Taxes', '/admin/taxes', 'settings.write'], ['Store', '/admin/store', 'settings.write'],
    ['Themes', '/admin/themes', 'catalog.write'],
    ['Users & roles', '/admin/users', 'users.manage'], ['Audit log', '/admin/audit', 'audit.read']] },
];

const MODULES = {
  '': () => import('./dashboard.js'),
  orders: () => import('./orders.js'),
  quotes: () => import('./quotes.js'),
  products: () => import('./products.js'),
  drops: () => import('./drops.js'),
  inventory: () => import('./inventory.js'),
  designs: () => import('./moderation.js'),
  pricing: () => import('./pricing.js'),
  customers: () => import('./customers.js'),
  support: () => import('./support.js'),
  analytics: () => import('./analytics.js'),
  ai: () => import('./ai.js'),
  users: () => import('./users.js'),
  audit: () => import('./audit.js'),
  categories: () => import('./crud.js'), collections: () => import('./crud.js'), designers: () => import('./crud.js'),
  discounts: () => import('./crud.js'), themes: () => import('./crud.js'), shipping: () => import('./crud.js'), taxes: () => import('./crud.js'), store: () => import('./crud.js'),
  fulfillment: () => import('./fulfillment.js'), promotions: () => import('./later.js'),
};

let permsCache = null;
async function loadPerms() {
  if (permsCache?.uid === auth.user?.id) return permsCache.set;
  let rows = await db.rpc('my_permissions').catch(() => []);
  if (!rows.length && await db.rpc('claim_owner').catch(() => false)) rows = await db.rpc('my_permissions');
  const set = new Set(rows.map(r => r.permission ?? r));
  permsCache = { uid: auth.user?.id, set };
  return set;
}
auth.onChange(() => { permsCache = null; });

function ensureCss() {
  if (document.querySelector('link[data-admin-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = '/css/admin.css'; l.dataset.adminCss = '';
  document.head.append(l);
}

export async function load({ rest = '' }, query) {
  ensureCss();
  const theme = await themeForPage('account');
  if (!auth.user) {
    return { theme, title: 'Admin', html: `<section class="cc-gate"><h1>Admin</h1><p>Sign in with your staff account.</p>
      <p><a class="cc-btn cc-btn--primary" href="/account/sign-in?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a></p></section>` };
  }
  const perms = await loadPerms();
  if (!perms.size) {
    return { theme, title: 'Admin', html: `<section class="cc-gate"><h1>No admin access</h1>
      <p>This account (${esc(auth.user.email)}) isn't on the staff list. Ask an admin to add you under Users &amp; roles.</p>
      <p class="cc-muted">Store owner setting this up for the first time? Confirm your email address, then reload this page.</p>
      <p><a class="cc-btn" href="/">Back to the store</a></p></section>` };
  }
  if (perms.size === 1 && perms.has('partner.portal')) {
    return { theme, title: 'Admin', html: `<section class="cc-gate"><h1>This is a partner account</h1>
      <p>${esc(auth.user.email)} is linked to a production partner. Your work is in the partner portal.</p>
      <p><a class="cc-btn cc-btn--primary" href="/partner">Open the partner portal</a></p></section>` };
  }
  const can = (p) => perms.has('*') || p === 'staff' || perms.has(p)
    || (p === 'fulfil' && ['fulfillment.read', 'fulfillment.write', 'orders.read'].some(x => perms.has(x)));
  const segs = rest.split('/').filter(Boolean);
  const key = segs[0] || '';
  const loader = MODULES[key];
  const go = async (url) => (await import('../app.js')).go(url);
  const ctx = { segs, key, query, perms, can, go, user: auth.user };
  let view;
  try {
    view = loader ? await (await loader()).view(ctx) : { title: 'Not found', html: '<p class="cc-empty">That admin page doesn\'t exist.</p>' };
  } catch (e) {
    console.error(e);
    view = { title: 'Error', html: `<div class="cc-alert cc-alert--bad"><strong>Couldn't load this page.</strong> ${esc(e.message || e)}</div>` };
  }
  const here = location.pathname + location.search;
  return {
    theme, title: `${view.title || 'Admin'} · Admin`,
    html: `<div class="cc">
      <aside class="cc-side" aria-label="Admin">
        <a class="cc-brand" href="/admin">Control center</a>
        <nav>${NAV.filter(n => can(n.perm)).map(n => n.href
          ? `<a class="cc-nav-top" href="${n.href}"${key === '' ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`
          : `<details class="cc-nav-group" ${n.items.some(([, h]) => here === h || (here.startsWith(h.split('?')[0]) && h.split('?')[0] !== '/admin')) ? 'open' : ''}>
              <summary>${esc(n.group)}</summary>
              ${n.items.filter(([, , p]) => !p || can(p)).map(([l, h]) => `<a href="${h}"${here === h ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}
            </details>`).join('')}</nav>
        <div class="cc-side-foot"><span>${esc(auth.user.email)}</span><a href="/">View store ↗</a></div>
      </aside>
      <main class="cc-main">${view.html}</main>
    </div>`,
    mount(root) {
      root.querySelector('.cc-side').addEventListener('toggle', () => {}, true);
      return view.mount?.(root.querySelector('.cc-main'), ctx);
    },
  };
}
