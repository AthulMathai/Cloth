import { themeForPage } from '../lib/store.js';
export async function load() {
  return {
    theme: await themeForPage('home'), title: 'Page not found',
    html: `<section class="state"><h1>Lost signal.</h1><p class="lede">That page doesn't exist, or it moved.</p>
      <p class="hero-actions"><a class="btn" href="/shop">Go to the shop</a><a class="btn btn--quiet" href="/archive">Search the archive</a></p></section>`,
  };
}
