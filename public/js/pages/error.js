import { resolveTheme } from '../lib/theme.js';
import { esc } from '../components/ui.js';
export async function load({ error }) {
  return {
    theme: { slug: 'error', config: resolveTheme({ colors: { bg: '#0b0b0c', fg: '#f2f0ec', accent: '#d42a2f', accent2: '#efebe3', surface: '#1a1a1a', line: '#2a2a2a', muted: '#8f8b85' } }) },
    title: 'Something went wrong',
    html: `<section class="state"><h1>Couldn't load this page.</h1>
      <p class="lede">The store couldn't reach its database. Check your connection and reload.</p>
      <p class="muted" style="font-size:14px">${esc(error?.message || '')}</p>
      <p><a class="btn" href="${esc(location.pathname)}">Reload</a></p></section>`,
  };
}
