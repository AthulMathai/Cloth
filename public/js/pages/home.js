// Home: the house artist's page and the face of the brand.
import { db, auth } from '../lib/supabase.js';
import { loadBoot, themeForPage, money } from '../lib/store.js';
import { FONTS } from '../lib/theme.js';
import { esc, productGrid, dropCard, startCountdowns, varsityArch, scriptMark, calloutSVG, garmentSVG } from '../components/ui.js';
import { track } from '../lib/analytics.js';
import { recsSlot, mountRecs } from '../lib/recommend.js';

const HEADER_KEY = 'th8rty.headerPreview';

export async function load() {
  const boot = await loadBoot();
  const theme = await themeForPage('home');
  const s = boot.settings;
  const hero = s['home.hero'] || {};
  const story = s['home.story'] || {};

  const [featured, drops, arrivals, archivedCount] = await Promise.all([
    db.from('storefront_products').select('*').eq('is_featured', true).eq('category_slug', 'th8rty').neq('status', 'archived').order('created_at').limit(2),
    db.from('storefront_products').select('*').eq('is_limited', true).in('status', ['active', 'scheduled', 'sold_out']).order('release_at'),
    db.from('storefront_products').select('*').eq('status', 'active').eq('is_limited', false).order('created_at', { ascending: false }).limit(8),
    db.from('archive_drops').select('id'),
  ]);

  // Preview of either header style without touching the saved setting.
  let headerStyle = s['home.header_style'] || 'varsity-arch';
  try { headerStyle = sessionStorage.getItem(HEADER_KEY) || headerStyle; } catch {}

  const cats = boot.categories;
  const live = drops.filter(d => d.status !== 'scheduled');
  const upcoming = drops.filter(d => d.status === 'scheduled');
  const cardStyle = theme.config.cards.style;

  const html = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-inner" id="hero-title">
      <div data-header>${headerStyle === 'script' ? scriptMark(hero.headline || s['store.name']) : `<h1 class="sr-only">${esc(hero.headline || s['store.name'])}</h1>${varsityArch(hero.headline || s['store.name'])}`}</div>
      <p class="hero-sub">${esc(hero.sub || '')}</p>
      <div class="hero-actions">
        <a class="btn" href="${esc(hero.cta_href || '/custom')}">${esc(hero.cta_label || 'Start designing')}</a>
        <a class="btn btn--quiet" href="/category/th8rty">Shop the sketchbook</a>
      </div>
    </div>
    <div class="hero-header-switch" role="group" aria-label="Preview header style">
      <button data-style="varsity-arch" aria-pressed="${headerStyle !== 'script'}">Varsity</button>
      <button data-style="script" aria-pressed="${headerStyle === 'script'}">Script</button>
    </div>
  </section>

  ${featured.length ? `
  <section class="section" aria-label="From the sketchbook">
    <div class="wrap">
      <div class="sketchbook">
        ${featured.map((p, i) => `
        <a class="sketch-page" href="/product/${p.slug}">
          <span class="sketch-label">${i === 0 ? esc(p.collection_name || 'Sketchbook') : 'p. ' + (i + 1)}</span>
          ${calloutSVG({ type: p.product_type, color: p.colors?.[0]?.hex, callouts: p.sketch_callouts || [], label: `${p.name} sketch` })}
          <div class="sketch-meta"><span>${esc(p.name)}</span><span class="price">${money(p.price_cents)}</span></div>
        </a>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <section class="section panel">
    <div class="wrap custom-teaser">
      <div>
        <h2 class="h-section">Wear your idea.</h2>
        <p class="lede">Upload your artwork, place it on a hoodie or tee, and see it on the garment before you order. Every design is checked by a person before it's printed.</p>
        <p class="hero-actions" style="justify-content:flex-start"><a class="btn" href="/custom">Start designing</a></p>
      </div>
      <div class="canvas-demo" aria-hidden="true">
        ${garmentSVG({ type: 'hoodie', color: '#141414', mode: 'sketch' })}
        <div class="print-box">your<br>art<br>here</div>
      </div>
    </div>
  </section>

  ${live.length || upcoming.length ? `
  <section class="section panel">
    <div class="wrap">
      <div class="section-head"><h2 class="h-section">Limited drops</h2><a href="/drops">All drops</a></div>
      <div class="drops">${[...live, ...upcoming].map(dropCard).join('')}</div>
    </div>
  </section>` : ''}

  <section class="section panel" aria-label="Collections">
    <div class="wrap">
      <div class="section-head"><h2 class="h-section">Pick a world</h2></div>
      <div class="doors">
        ${await doorsHTML(cats, boot)}
      </div>
    </div>
  </section>

  ${recsSlot('home')}
  <section class="section">
    <div class="wrap">
      <div class="section-head"><h2 class="h-section">New in</h2><a href="/shop">Shop everything</a></div>
      ${productGrid(arrivals, cardStyle)}
    </div>
  </section>

  <section class="section panel">
    <div class="wrap" style="display:grid;gap:22px;justify-items:start">
      <h2 class="h-section">The archive</h2>
      <p class="lede">${archivedCount.length} sold-out drops, kept on record with their edition sizes, stories and release dates. You can visit them, but they're never coming back.</p>
      <a class="btn btn--quiet" href="/archive">Visit the archive</a>
    </div>
  </section>

  <section class="section">
    <div class="wrap story">
      <h2 class="h-section" style="margin-bottom:20px">${esc(story.title || '')}</h2>
      <p>${esc(story.body || '')}</p>
      <form class="form-row" data-newsletter style="margin-top:34px" novalidate>
        <label class="sr-only" for="nl-email">Email</label>
        <input id="nl-email" type="email" name="email" placeholder="you@email.com" autocomplete="email" required>
        <button class="btn" type="submit">Get drop alerts</button>
      </form>
      <p class="form-msg" role="status" data-nl-msg></p>
    </div>
  </section>`;

  return {
    theme, html, title: null,
    description: 'Clothing drawn by hand first. Shop limited drops, explore the archive, or design your own.',
    mount(root) {
      const stop = startCountdowns(root);
      if (auth.user) mountRecs(root, { slot: 'home', fn: 'recommend_for_me', args: { p_limit: 8 }, title: 'Picked for you',
        cardStyle, source: 'home', min: 3 });
      root.querySelectorAll('.hero-header-switch button').forEach(b => b.onclick = () => {
        const style = b.dataset.style;
        try { sessionStorage.setItem(HEADER_KEY, style); } catch {}
        const name = hero.headline || s['store.name'];
        root.querySelector('[data-header]').innerHTML = style === 'script' ? scriptMark(name) : `<h1 class="sr-only">${esc(name)}</h1>${varsityArch(name)}`;
        root.querySelectorAll('.hero-header-switch button').forEach(x => x.setAttribute('aria-pressed', x === b));
      });
      const form = root.querySelector('[data-newsletter]');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const msg = root.querySelector('[data-nl-msg]');
        const email = form.email.value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Enter an email address like name@example.com.'; return; }
        try {
          await db.rpc('subscribe_newsletter', { p_email: email, p_source: 'home' });
          msg.textContent = "You're on the list. We'll email you before each drop.";
          form.reset(); track('newsletter_signup', { source: 'home' });
        } catch { msg.textContent = "Couldn't sign you up right now. Try again in a minute."; }
      };
      return stop;
    },
  };
}

async function doorsHTML(cats, boot) {
  const { resolveTheme } = await import('../lib/theme.js');
  return cats.map(c => {
    const t = boot.themes.get(boot.themeIdToSlug.get(c.theme_id));
    const cfg = resolveTheme(t?.config, c.theme_overrides);
    const font = (FONTS[cfg.fonts.display] || FONTS.inter).family;
    return `<a class="door" href="/category/${c.slug}" style="--door-bg:${cfg.colors.bg};--door-fg:${cfg.colors.fg};--door-accent:${cfg.colors.accent};--door-font:${font}">
      <span class="door-name">${esc(c.name)}</span><span class="door-tag">${esc(c.tagline || '')}</span></a>`;
  }).join('');
}
