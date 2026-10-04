// App shell: router, themed transitions, header/footer, analytics.
import { env } from './lib/env.js';
import { auth, db } from './lib/supabase.js';
import { applyTheme } from './lib/theme.js';
import { loadBoot } from './lib/store.js';
import { runIntro } from './effects/intros.js';
import { sound } from './effects/sound.js';
import { track } from './lib/analytics.js';
import { getBag, bagCount } from './lib/cart.js';

const routes = [
  [/^\/$/,                          () => import('./pages/home.js')],
  [/^\/shop\/?$/,                   () => import('./pages/shop.js')],
  [/^\/category\/([a-z0-9-]+)\/?$/, () => import('./pages/category.js'), ['slug']],
  [/^\/collections\/([a-z0-9-]+)\/?$/, () => import('./pages/collection.js'), ['slug']],
  [/^\/product\/([a-z0-9-]+)\/?$/,  () => import('./pages/product.js'), ['slug']],
  [/^\/drops\/?$/,                  () => import('./pages/drops.js')],
  [/^\/archive\/?$/,                () => import('./pages/archive.js')],
  [/^\/archive\/([a-z0-9-]+)\/?$/,  () => import('./pages/archive-drop.js'), ['slug']],
  [/^\/search\/?$/,                 () => import('./pages/search.js')],
  [/^\/account(?:\/(sign-in|sign-up))?\/?$/, () => import('./pages/account.js'), ['mode']],
  [/^\/cart\/?$/,                   () => import('./pages/cart.js')],
  [/^\/checkout\/?$/,               () => import('./pages/checkout.js')],
  [/^\/checkout\/pay\/([A-Za-z0-9-]+)\/?$/, () => import('./pages/pay.js'), ['number']],
  [/^\/orders(?:\/([A-Za-z0-9-]+))?\/?$/, () => import('./pages/order.js'), ['number']],
  [/^\/custom(?:\/([0-9a-f-]{36}))?\/?$/, () => import('./pages/custom.js'), ['id']],
  [/^\/designs\/?$/,                () => import('./pages/designs.js')],
  [/^\/admin(?:\/(.*?))?\/?$/,       () => import('./admin/shell.js'), ['rest']],
  [/^\/partner(?:\/(.*?))?\/?$/,     () => import('./partner/portal.js'), ['rest']],
  [/^\/wishlist\/?$/,               () => import('./pages/wishlist.js')],
  [/^\/support(?:\/([0-9a-f-]{36}))?\/?$/, () => import('./pages/support.js'), ['id']],
];

const main = document.getElementById('main');
let currentThemeSlug = null;
let cleanup = null;
let navToken = 0;

function match(pathname) {
  for (const [re, loader, keys = []] of routes) {
    const m = pathname.match(re);
    if (m) return { loader, params: Object.fromEntries(keys.map((k, i) => [k, m[i + 1]])) };
  }
  return { loader: () => import('./pages/not-found.js'), params: {} };
}

async function navigate(url, { push = true, initial = false } = {}) {
  const u = new URL(url, location.origin);
  const token = ++navToken;
  document.documentElement.classList.add('is-loading');
  let page;
  try {
    const { loader, params } = match(u.pathname);
    const mod = await loader();
    page = await mod.load(params, u.searchParams);
  } catch (err) {
    console.error(err);
    page = await (await import('./pages/error.js')).load({ error: err });
  }
  document.documentElement.classList.remove('is-loading');
  if (token !== navToken) return;                       // a newer navigation won

  if (push && !initial) history.pushState({}, '', u.pathname + u.search + u.hash);

  const swap = async () => {
    cleanup?.(); cleanup = null;
    applyTheme(page.theme.config, page.theme.slug);
    currentThemeSlug = page.theme.slug;
    document.title = page.title ? `${page.title} — ${storeName}` : storeName;
    setMeta('description', page.description || '');
    if (!initial) document.querySelectorAll('script[data-seo], meta[name="robots"]').forEach(el => el.remove());   // server-added data was for the first page only
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', page.title || storeName);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', (env.SITE_URL || location.origin) + u.pathname);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', (env.SITE_URL || location.origin) + u.pathname);
    document.body.classList.toggle('is-admin', /^\/(admin|partner)(\/|$)/.test(u.pathname));
    main.innerHTML = page.html;
    renderHeader(u.pathname);
    if (promo !== null) renderPromoBanner().catch(() => {});
    window.scrollTo(0, 0);
    const c = page.mount?.(main);
    cleanup = typeof c === 'function' ? c : null;
    if (!initial) main.focus({ preventScroll: true });
  };

  const themeChanges = currentThemeSlug !== null && currentThemeSlug !== page.theme.slug;
  if (themeChanges) await runIntro(page.theme.config, swap);
  else await swap();

  track('page_view', { path: u.pathname, entity_type: page.entity?.type, entity_id: page.entity?.id });
}

function setMeta(name, content) {
  let m = document.querySelector(`meta[name="${name}"]`);
  if (!m) { m = document.createElement('meta'); m.name = name; document.head.append(m); }
  m.content = content;
}

// ---------------------------------------------------------------------
// Header & footer
// ---------------------------------------------------------------------
let storeName = 'TH8RTY';
const NAV = [['/shop', 'Shop'], ['/custom', 'Custom'], ['/drops', 'Drops'], ['/archive', 'Archive']];
const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8h14l-1 13H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  soundOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};

function renderHeader(path) {
  const h = document.getElementById('site-header');
  const on = sound.enabled;
  h.innerHTML = `<div class="bar">
    <button class="icon-btn menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">${ICONS.menu}</button>
    <a class="wordmark" href="/" aria-label="${storeName} home">${storeName}</a>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      ${NAV.map(([href, label]) => `<a href="${href}"${path.startsWith(href) ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <div class="bar-tools">
      <a class="icon-btn" href="/search" aria-label="Search">${ICONS.search}</a>
      <button class="icon-btn" data-sound aria-pressed="${on}" aria-label="${on ? 'Mute transition sounds' : 'Turn transition sounds on'}">${on ? ICONS.soundOn : ICONS.soundOff}</button>
      <a class="icon-btn" href="/account" aria-label="${auth.user ? 'Your account' : 'Sign in'}">${ICONS.user}</a>
      <a class="icon-btn bag-btn" href="/cart" aria-label="Bag${bagCount() ? `, ${bagCount()} items` : ''}">${ICONS.bag}${bagCount() ? `<span class="bag-count" aria-hidden="true">${bagCount()}</span>` : ''}</a>
    </div></div>`;
  h.querySelector('[data-sound]').onclick = () => { sound.enabled = !sound.enabled; renderHeader(location.pathname); };
  const menu = h.querySelector('.menu-btn'), nav = h.querySelector('.site-nav');
  menu.onclick = () => { const open = nav.classList.toggle('is-open'); menu.setAttribute('aria-expanded', open); };
}

async function renderFooter() {
  const { categories } = await loadBoot();
  document.getElementById('site-footer').innerHTML = `<div class="footer-grid">
    <div><a class="wordmark" href="/">${storeName}</a><p class="muted" style="max-width:34ch">Drawn by hand, printed to order in Canada.</p></div>
    <div><h3>Shop</h3><ul>${categories.map(c => `<li><a href="/category/${c.slug}">${c.name}</a></li>`).join('')}</ul></div>
    <div><h3>Drops</h3><ul><li><a href="/drops">Current & upcoming</a></li><li><a href="/archive">Limited edition archive</a></li><li><a href="/custom">Custom designer</a></li></ul></div>
    <div><h3>You</h3><ul><li><a href="/account">Account</a></li><li><a href="/orders">Orders</a></li><li><a href="/wishlist">Wishlist</a></li><li><a href="/support">Help &amp; support</a></li></ul></div>
  </div>`;
}

// Promotion strip (Admin → Marketing → Promotions). Hidden in the admin and
// partner portal, dismissible for the visit, and removed when the sale ends.
let promo = null, promoTimer = 0;
async function renderPromoBanner() {
  promo ??= await db.rpc('promo_banner').catch(() => null);
  const host = document.getElementById('promo-banner');
  clearInterval(promoTimer);
  let dismissed = null; try { dismissed = sessionStorage.getItem('th8rty.promo.hide'); } catch {}
  if (!promo || dismissed === promo.id || /^\/(admin|partner)/.test(location.pathname) || (promo.ends_at && new Date(promo.ends_at) <= Date.now())) { host.innerHTML = ''; return; }
  const off = promo.kind === 'percent' ? `${+promo.value}% off` : `$${(promo.value / 100).toFixed(promo.value % 100 ? 2 : 0)} off`;
  const text = promo.text || `${promo.label || promo.name} — ${off}${promo.scope === 'all' ? ' everything' : ''}`;
  host.innerHTML = `<div class="promo-banner" role="region" aria-label="Sale">
    <a href="${promo.href || '/shop'}"><strong>${text.replace(/[<>&]/g, '')}</strong>${promo.ends_at ? ` <span class="promo-time">· ends in <span data-promo-left></span></span>` : ''} <span aria-hidden="true">→</span></a>
    <button class="promo-x" aria-label="Hide sale banner">×</button></div>`;
  host.querySelector('.promo-x').onclick = () => { try { sessionStorage.setItem('th8rty.promo.hide', promo.id); } catch {} host.innerHTML = ''; clearInterval(promoTimer); };
  const left = host.querySelector('[data-promo-left]');
  if (left) {
    const tick = () => {
      const ms = new Date(promo.ends_at) - Date.now();
      if (ms <= 0) { host.innerHTML = ''; clearInterval(promoTimer); return; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
      left.textContent = `${d ? d + 'd ' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    tick(); promoTimer = setInterval(tick, 1000);
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//') || a.target || a.hasAttribute('download')) return;
  e.preventDefault();
  if (href === location.pathname + location.search) return;
  document.getElementById('site-nav')?.classList.remove('is-open');
  navigate(href);
});
addEventListener('popstate', () => navigate(location.href, { push: false }));

export function go(url) { return navigate(url); }

(async function start() {
  auth.consumeRedirect();
  if (env.INTEGRATIONS_MODE !== 'live') {
    document.getElementById('dev-banner').innerHTML =
      '<div class="dev-banner">Development build: catalogue is seeded test data, and payments, fulfillment and shipping are not live.</div>';
  }
  if (!env.SUPABASE_URL) {
    main.innerHTML = `<section class="state"><h1>Connect Supabase</h1><p class="lede">Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in Netlify, then redeploy. See docs/deployment.md.</p></section>`;
    return;
  }
  try {
    const b = await loadBoot();
    storeName = b.settings['store.name'] || storeName;
  } catch (e) { console.error(e); }
  renderFooter().catch(() => {});
  auth.onChange(() => renderHeader(location.pathname));
  document.addEventListener('bag:change', () => renderHeader(location.pathname));
  getBag().catch(() => {});
  await navigate(location.href, { initial: true });
  renderPromoBanner().catch(() => {});
})();
