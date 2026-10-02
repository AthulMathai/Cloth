// Shared storefront fragments. Every function returns an HTML string built
// from database rows; all text is escaped.
import { garmentSVG, calloutSVG, esc } from './garment.js';
import { money, pad3 } from '../lib/store.js';

export { esc };

const firstColor = (p) => p.colors?.[0]?.hex || '#141414';

export function priceHTML(p) {
  return p.sale_price_cents != null
    ? `${money(p.sale_price_cents)}<s>${money(p.base_price_cents)}</s>`
    : money(p.base_price_cents);
}

export function statusBadge(p) {
  if (p.status === 'archived') return '<span class="badge">Archived</span>';
  if (p.status === 'sold_out') return '<span class="badge">Sold out</span>';
  if (p.status === 'out_of_stock') return '<span class="badge">Out of stock</span>';
  if (p.status === 'scheduled') return '<span class="badge badge--accent">Coming soon</span>';
  if (p.drop_number) return `<span class="badge badge--accent">Drop ${pad3(p.drop_number)}</span>`;
  if (p.sale_price_cents != null) return '<span class="badge badge--accent">Sale</span>';
  return '';
}

/** Product card; illustration style follows the active theme's card style. */
export function productCard(p, cardStyle) {
  const sketch = cardStyle === 'sketch-callout';
  const href = p.status === 'archived' && p.drop_slug ? `/archive/${p.drop_slug}` : `/product/${p.slug}`;
  return `<a class="card" href="${href}">
    ${statusBadge(p)}
    <div class="card-media">${garmentSVG({ type: p.product_type, color: firstColor(p), mode: sketch ? 'sketch' : 'flat', label: p.name })}</div>
    <div class="card-body">
      <span class="card-name">${esc(p.name)}</span>
      <span class="card-price">${priceHTML(p)}</span>
      ${p.designer_name ? `<span class="muted" style="font-size:14px">${esc(p.designer_name)}</span>` : ''}
    </div>
  </a>`;
}

export function productGrid(products, cardStyle, empty = 'Nothing here yet — new pieces land with every drop.') {
  if (!products.length) return `<p class="muted">${empty}</p>`;
  return `<div class="grid">${products.map(p => productCard(p, cardStyle)).join('')}</div>`;
}

/** Limited drop tile with live edition meter or countdown. */
export function dropCard(p) {
  const upcoming = new Date(p.release_at) > new Date();
  const sold = p.units_sold || 0, size = p.edition_size || 1;
  const pct = Math.min(100, (sold / size) * 100);
  return `<a class="drop" href="/product/${p.slug}">
    <div class="drop-media">${garmentSVG({ type: p.product_type, color: firstColor(p), mode: 'flat', label: p.name })}</div>
    <div>
      <div class="drop-no">DROP ${pad3(p.drop_number)}</div>
      <div class="drop-name">${esc(p.drop_name)}</div>
      ${upcoming
        ? `<div class="muted" style="font-size:14px">Releases in</div><div class="countdown" data-countdown="${esc(p.release_at)}">--:--:--</div>
           <div class="muted" style="font-size:14px">${size} pieces · ${money(p.price_cents)}</div>`
        : p.status === 'sold_out'
          ? `<div class="drop-count">${size} / ${size} claimed</div><div class="muted" style="font-size:14px">Sold out — heading to the archive</div>`
          : `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${size}" aria-valuenow="${sold}" aria-label="Editions claimed"><span style="width:${pct}%"></span></div>
             <div class="drop-count">${sold} / ${size} claimed · ${p.units_remaining} left</div>
             <div class="muted" style="font-size:14px">${money(p.price_cents)}</div>`}
    </div>
  </a>`;
}

/** Ticks every [data-countdown] inside root. Returns a cleanup function. */
export function startCountdowns(root) {
  const els = [...root.querySelectorAll('[data-countdown]')];
  if (!els.length) return () => {};
  const tick = () => {
    for (const el of els) {
      const ms = new Date(el.dataset.countdown) - Date.now();
      if (ms <= 0) { el.textContent = 'Live now'; continue; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
      el.textContent = `${d ? d + 'd ' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------
// Heroes, chosen by theme.hero.style
// ---------------------------------------------------------------------
export function varsityArch(text) {
  // Text on an upward arc, like a collegiate chest print.
  const t = esc(String(text).toUpperCase());
  return `<svg class="arch" viewBox="0 0 1200 420" role="img" aria-label="${t}">
    <defs><path id="arc-path" d="M 40 400 Q 600 130 1160 400"/></defs>
    <text text-anchor="middle"><textPath href="#arc-path" startOffset="50%">${t}</textPath></text>
  </svg>`;
}

export function scriptMark(text) {
  const s = String(text);
  const title = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return `<h1 class="script-mark">${esc(title)}<sup aria-hidden="true">*</sup></h1>`;
}

export function categoryHero(cat, theme, extra = '') {
  const style = theme.hero.style;
  const name = esc(cat.name), tag = esc(cat.tagline || ''), desc = esc(cat.description || '');
  if (style === 'manga-slash') {
    return `<section class="hero hero--manga"><div class="hero-inner wrap">
      <span class="manga-jp" aria-hidden="true">アニメ・限定</span>
      <h1 class="manga-title">${name}</h1>
      <p class="manga-tag">${tag}</p><p class="lede">${desc}</p>${extra}</div></section>`;
  }
  if (style === 'serif-centered') {
    return `<section class="hero hero--serif"><div class="hero-inner">
      <h1 class="serif-title">${name}</h1><p class="lede">${tag} ${desc}</p>${extra}</div></section>`;
  }
  if (style === 'varsity-arch') {
    return `<section class="hero"><div class="hero-inner">${varsityArch(cat.name)}
      <p class="hero-sub">${tag}</p><p class="lede" style="text-align:center">${desc}</p>${extra}</div></section>`;
  }
  return `<section class="hero hero--stacked"><div class="hero-inner wrap">
    <h1 class="stack-title">${name}</h1><p class="lede">${tag} ${desc}</p>${extra}</div></section>`;
}

export { calloutSVG, garmentSVG };
