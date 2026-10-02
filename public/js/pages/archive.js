// /archive — every sold-out limited edition, kept like a museum collection.
import { db } from '../lib/supabase.js';
import { themeForPage, money, pad3 } from '../lib/store.js';
import { esc, garmentSVG } from '../components/ui.js';
import { track } from '../lib/analytics.js';

export async function load(_, query) {
  const theme = await themeForPage('archive');
  const all = await db.from('archive_drops').select('*').order('drop_number', { ascending: false });

  const uniq = (key, label) => [...new Map(all.filter(d => d[key]).map(d => [d[key], d[label] ?? d[key]])).entries()];
  const years = uniq('release_year', 'release_year').sort((a, b) => b[0] - a[0]);
  const collections = uniq('collection_slug', 'collection_name');
  const categories = uniq('category_slug', 'category_name');
  const designers = uniq('designer_slug', 'designer_name');
  const f = { year: query.get('year') || '', collection: query.get('collection') || '', category: query.get('category') || '', designer: query.get('designer') || '', drop: query.get('drop') || '' };

  const select = (name, label, opts) => `<label><span class="sr-only">${label}</span><select name="${name}">
    <option value="">${label}: all</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(f[name]) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

  return {
    theme, title: 'Limited edition archive', description: 'Every limited drop that has sold out, preserved with its story, edition size and release date.',
    html: `<section class="hero hero--serif" style="min-height:auto;padding-block:110px 60px"><div class="hero-inner">
        <h1 class="serif-title">The Archive</h1>
        <p class="lede">Every limited edition that sold out, kept on record. Nothing here can be bought again.</p></div></section>
      <section class="section" style="padding-top:0"><div class="wrap">
        <form class="filters" data-filters>
          ${select('year', 'Year', years)}${select('collection', 'Collection', collections)}
          ${select('category', 'Category', categories)}${select('designer', 'Designer', designers)}
          <label><span class="sr-only">Drop number</span><input name="drop" inputmode="numeric" placeholder="Drop no." value="${esc(f.drop)}" size="8"></label>
        </form>
        <p class="muted" data-count role="status"></p>
        <div class="grid" data-exhibits style="row-gap:56px"></div>
      </div></section>`,
    mount(root) {
      track('archive_viewed');
      const form = root.querySelector('[data-filters]');
      const grid = root.querySelector('[data-exhibits]');
      const render = () => {
        const v = Object.fromEntries(new FormData(form));
        const list = all.filter(d =>
          (!v.year || String(d.release_year) === v.year) && (!v.collection || d.collection_slug === v.collection) &&
          (!v.category || d.category_slug === v.category) && (!v.designer || d.designer_slug === v.designer) &&
          (!v.drop || String(d.drop_number) === String(Number(v.drop))));
        root.querySelector('[data-count]').textContent = `${list.length} of ${all.length} drops`;
        grid.innerHTML = list.length ? list.map(d => `<a class="exhibit" href="/archive/${d.slug}">
          <div class="exhibit-frame">${garmentSVG({ type: d.product_type, color: d.colors?.[0]?.hex, mode: 'flat', label: d.product_name })}</div>
          <div class="plaque"><span class="plaque-no">DROP ${pad3(d.drop_number)} · ${d.release_year}</span>
            <span class="plaque-name">${esc(d.drop_name)}</span>
            <span class="plaque-meta">${d.units_sold} / ${d.edition_size} pieces · ${money(d.original_price_cents)}${d.designer_name ? ' · ' + esc(d.designer_name) : ''}</span></div></a>`).join('')
          : `<p class="muted">No archived drops match those filters. Clear one to see more.</p>`;
        const qs = new URLSearchParams([...new FormData(form)].filter(([, x]) => x)).toString();
        history.replaceState(history.state, '', '/archive' + (qs ? '?' + qs : ''));
      };
      form.addEventListener('input', render);
      form.addEventListener('submit', (e) => e.preventDefault());
      render();
    },
  };
}
