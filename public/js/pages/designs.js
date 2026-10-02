// /designs — the customer's saved custom designs.
import { db, auth, storage } from '../lib/supabase.js';
import { themeForPage, fmtDate } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';

const LABEL = { draft: 'Draft', pending: 'Checking', approved: 'Approved', needs_review: 'In review', rejected: 'Not approved' };

export async function load() {
  const theme = await themeForPage('custom');
  if (!auth.user) {
    return { theme, title: 'Saved designs', html: `<section class="state"><h1>Your designs</h1>
      <p class="lede">Sign in to see the designs you've saved.</p>
      <p class="hero-actions"><a class="btn" href="/account/sign-in">Sign in</a><a class="btn btn--quiet" href="/custom">Start designing</a></p></section>` };
  }
  const designs = await db.from('custom_designs')
    .select('id,name,status,version,approved_version,updated_at,mockups,product_id,variant_id,products(name,product_type),product_variants(color,color_hex,size)')
    .order('updated_at', { ascending: false }).limit(60);
  const urls = await storage.sign('mockups', designs.map(d => d.mockups?.front)).catch(() => ({}));
  return {
    theme, title: 'Saved designs',
    html: `<section class="section commerce"><div class="wrap">
      <div class="section-head"><h1 class="h-section">Your designs</h1><a class="btn" href="/custom">New design</a></div>
      ${designs.length ? `<div class="grid designs-grid">${designs.map(d => `
        <a class="card design-card" href="/custom/${d.id}">
          <span class="badge${d.status === 'approved' ? ' badge--accent' : ''}">${LABEL[d.status] || d.status}</span>
          <div class="card-media">${urls[d.mockups?.front] ? `<img src="${urls[d.mockups.front]}" alt="${esc(d.name)} preview" loading="lazy">`
            : garmentSVG({ type: d.products?.product_type, color: d.product_variants?.color_hex, mode: 'flat', label: d.name })}</div>
          <div class="card-body"><span class="card-name">${esc(d.name)}</span>
            <span class="muted small">${esc(d.products?.name || '')} · ${esc(d.product_variants?.color || '')} / ${esc(d.product_variants?.size || '')}</span>
            <span class="muted small">Version ${d.version} · ${fmtDate(d.updated_at)}</span></div>
        </a>`).join('')}</div>`
      : `<div class="panel-box"><p class="lede">No designs yet.</p><p><a class="btn" href="/custom">Start designing</a></p></div>`}
    </div></section>`,
  };
}
