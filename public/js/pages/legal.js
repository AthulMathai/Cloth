// /legal/:slug — privacy, returns, shipping, terms. Written in admin
// (Settings → Launch checklist → Legal pages); stored in store_settings.
import { db } from '../lib/supabase.js';
import { themeForPage, fmtDate } from '../lib/store.js';
import { esc } from '../components/ui.js';
import { markdown } from '../lib/markdown.js';

export const LEGAL = [['privacy', 'Privacy'], ['returns', 'Returns & refunds'], ['shipping', 'Shipping'], ['terms', 'Terms of sale']];

export async function load({ slug }) {
  if (!LEGAL.some(([k]) => k === slug)) return (await import('./not-found.js')).load();
  const theme = await themeForPage('account');
  const [row] = await db.from('store_settings').select('value').eq('key', `legal.${slug}`).catch(() => []);
  const v = row?.value;
  if (!v) return (await import('./not-found.js')).load();
  return {
    theme, title: v.title, description: `${v.title} for orders from this store.`,
    html: `<section class="section legal"><div class="wrap legal-wrap">
      <nav class="legal-nav" aria-label="Policies">${LEGAL.map(([k, l]) => `<a href="/legal/${k}"${k === slug ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>
      <article class="legal-body">
        <h1 class="h-section">${esc(v.title)}</h1>
        ${v.updated_at ? `<p class="muted small">Last updated ${esc(fmtDate(v.updated_at))}</p>` : ''}
        ${markdown(v.body || '')}
        <p class="muted small legal-help">Questions? <a href="/support">Contact us</a>.</p>
      </article></div></section>`,
  };
}
