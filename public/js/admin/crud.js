// Generic list + create/edit screens for simpler tables. Each table is
// described by data below; security is the table's Row Level Security.
import { db } from '../lib/supabase.js';
import { FONTS } from '../lib/theme.js';
import { esc, money, pill, table, date, label, form, readForm, toast, bindRowLinks, bindColorMirrors, errorText, confirmDialog } from './ui.js';

const slugRe = /^[a-z0-9-]+$/;
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// Theme override editor (categories & collections): a few common knobs that
// map into theme_overrides; anything else can go in the JSON box.
const BG = ['', 'none', 'tv-static', 'anime-sky', 'grain', 'light-rays', 'cyber-rain'];
const INTRO = ['', 'none', 'fade', 'petal-storm', 'static-cut', 'glitch', 'light-bloom', 'boot-sequence'];
const themeFields = (themes) => [
  { name: 'theme_id', label: 'Theme', type: 'select', options: [['', '— store default —'], ...themes.map(t => [t.id, t.name])] },
  { name: 'ov_accent', label: 'Accent colour', type: 'color', help: 'Leave empty to use the theme’s.' },
  { name: 'ov_bg', label: 'Background colour', type: 'color' },
  { name: 'ov_fg', label: 'Text colour', type: 'color' },
  { name: 'ov_display', label: 'Headline font', type: 'select', options: [['', '— theme —'], ...Object.entries(FONTS).map(([k, f]) => [k, f.label])] },
  { name: 'ov_effect', label: 'Background effect', type: 'select', options: BG.map(b => [b, b ? label(b) : '— theme —']) },
  { name: 'ov_intro', label: 'Page transition', type: 'select', options: INTRO.map(b => [b, b ? label(b) : '— theme —']) },
  { name: 'ov_motion', label: 'Animation level', type: 'select', options: [['', '— theme —'], ['calm', 'Calm'], ['normal', 'Normal'], ['energetic', 'Energetic']] },
  { name: 'theme_overrides', label: 'Other theme overrides (JSON)', type: 'json', full: true, help: 'Advanced. Merged on top of the theme.' },
];
function splitOverrides(row) {
  const o = structuredClone(row.theme_overrides || {});
  const take = (path) => { const [a, b] = path; const v = o[a]?.[b]; if (o[a]) { delete o[a][b]; if (!Object.keys(o[a]).length) delete o[a]; } return v ?? ''; };
  return { ...row, ov_accent: take(['colors', 'accent']), ov_bg: take(['colors', 'bg']), ov_fg: take(['colors', 'fg']), ov_display: take(['fonts', 'display']),
           ov_effect: take(['background', 'effect']), ov_intro: take(['intro', 'effect']), ov_motion: take(['motion', 'level']),
           theme_overrides: Object.keys(o).length ? o : null };
}
function joinOverrides(v) {
  const o = v.theme_overrides && typeof v.theme_overrides === 'object' ? structuredClone(v.theme_overrides) : {};
  const put = (a, b, val) => { if (val) { o[a] ||= {}; o[a][b] = val; } };
  put('colors', 'accent', v.ov_accent); put('colors', 'bg', v.ov_bg); put('colors', 'fg', v.ov_fg); put('fonts', 'display', v.ov_display);
  put('background', 'effect', v.ov_effect); put('intro', 'effect', v.ov_intro); put('motion', 'level', v.ov_motion);
  for (const k of Object.keys(v)) if (k.startsWith('ov_')) delete v[k];
  v.theme_overrides = o;
  return v;
}
const seoFields = [
  { name: 'seo_title', label: 'SEO title', help: 'Shown in search results. Defaults to the name.' },
  { name: 'seo_description', label: 'Meta description', type: 'textarea', rows: 2 },
];
const seoIn = (r) => ({ ...r, seo_title: r.seo?.title || '', seo_description: r.seo?.description || '' });
const seoOut = (v) => { v.seo = { ...(v.seo_title ? { title: v.seo_title } : {}), ...(v.seo_description ? { description: v.seo_description } : {}) }; delete v.seo_title; delete v.seo_description; return v; };
const checkSlug = (v) => { v.slug ||= slugify(v.name); if (!slugRe.test(v.slug)) throw new Error('Slug: lowercase letters, numbers and dashes only.'); return v; };

const CONFIG = {
  categories: {
    title: 'Categories', one: 'category', perm: 'catalog.write', order: 'sort_order',
    lookups: async () => ({ themes: await db.from('themes').select('id,name').order('name') }),
    columns: (L) => [{ key: 'name', label: 'Name', render: r => `<strong>${esc(r.name)}</strong><br><span class="cc-muted cc-small">/category/${esc(r.slug)}</span>` },
      { label: 'Theme', render: r => esc(L.themes.find(t => t.id === r.theme_id)?.name || 'Default') }, { key: 'sort_order', label: 'Order', align: 'right' },
      { label: 'Visible', render: r => r.is_visible ? pill('active', 'Visible') : pill('draft', 'Hidden') }],
    fields: (L) => [{ name: 'name', label: 'Name', required: true }, { name: 'slug', label: 'URL slug', help: 'Generated from the name if empty.' },
      { name: 'tagline', label: 'Tagline' }, { name: 'sort_order', label: 'Sort order', type: 'number', step: 1 },
      { name: 'description', label: 'Description', type: 'textarea', full: true }, { name: 'hero_image', label: 'Hero image URL', full: true },
      { name: 'is_visible', label: 'Visible in the store', type: 'checkbox' }, ...themeFields(L.themes), ...seoFields],
    load: (r) => seoIn(splitOverrides(r)), save: (v) => seoOut(joinOverrides(checkSlug(v))), defaults: { is_visible: true, sort_order: 0 },
  },
  collections: {
    title: 'Collections', one: 'collection', perm: 'catalog.write', order: 'sort_order',
    lookups: async () => ({ themes: await db.from('themes').select('id,name').order('name'),
      categories: await db.from('categories').select('id,name').order('sort_order'), designers: await db.from('designers').select('id,name').order('name') }),
    columns: (L) => [{ label: 'Name', render: r => `<strong>${esc(r.name)}</strong><br><span class="cc-muted cc-small">/collections/${esc(r.slug)}</span>` },
      { label: 'Category', render: r => esc(L.categories.find(c => c.id === r.category_id)?.name || '—') },
      { label: 'Designer', render: r => esc(L.designers.find(c => c.id === r.designer_id)?.name || '—') },
      { label: 'Theme', render: r => esc(L.themes.find(t => t.id === r.theme_id)?.name || 'Default') },
      { label: 'Status', render: r => (r.is_visible ? pill('active', 'Visible') : pill('draft', 'Hidden')) + (r.is_featured ? ' <span class="cc-tag">Featured</span>' : '') }],
    fields: (L) => [{ name: 'name', label: 'Name', required: true }, { name: 'slug', label: 'URL slug' },
      { name: 'category_id', label: 'Category', type: 'select', options: [['', '—'], ...L.categories.map(c => [c.id, c.name])] },
      { name: 'designer_id', label: 'Designer / artist', type: 'select', options: [['', '—'], ...L.designers.map(c => [c.id, c.name])] },
      { name: 'description', label: 'Description', type: 'textarea', full: true },
      { name: 'hero_image', label: 'Hero image URL' }, { name: 'banner_image', label: 'Banner image URL' },
      { name: 'sort_order', label: 'Sort order', type: 'number', step: 1 },
      { name: 'is_visible', label: 'Visible in the store', type: 'checkbox' }, { name: 'is_featured', label: 'Feature on the homepage', type: 'checkbox' },
      ...themeFields(L.themes), ...seoFields],
    load: (r) => seoIn(splitOverrides(r)), save: (v) => seoOut(joinOverrides(checkSlug(v))), defaults: { is_visible: true, sort_order: 0 },
  },
  designers: {
    title: 'Designers & artists', one: 'designer', perm: 'catalog.write', order: 'name',
    columns: () => [{ label: 'Name', render: r => `<strong>${esc(r.name)}</strong>${r.is_house ? ' <span class="cc-tag">House</span>' : ''}` },
      { key: 'website', label: 'Website' }, { label: 'Visible', render: r => r.is_visible ? pill('active', 'Visible') : pill('draft', 'Hidden') }],
    fields: () => [{ name: 'name', label: 'Name', required: true }, { name: 'slug', label: 'URL slug' },
      { name: 'avatar_url', label: 'Profile image URL' }, { name: 'website', label: 'Website' },
      { name: 'bio', label: 'Bio', type: 'textarea', full: true },
      { name: 'socials', label: 'Social links (JSON)', type: 'json', full: true, help: 'e.g. {"instagram": "https://instagram.com/…"}' },
      { name: 'is_house', label: 'House designer (in-house)', type: 'checkbox' }, { name: 'is_visible', label: 'Visible in the store', type: 'checkbox' }],
    save: (v) => { checkSlug(v); v.socials ||= {}; return v; }, defaults: { is_visible: true, socials: {} },
  },
  discounts: {
    title: 'Discount codes', one: 'discount code', perm: 'marketing.write', order: 'created_at', desc: true,
    lookups: async () => ({ categories: await db.from('categories').select('id,name').order('sort_order'),
      collections: await db.from('collections').select('id,name').order('name'), products: await db.from('products').select('id,name').order('name') }),
    columns: () => [{ label: 'Code', render: r => `<strong class="cc-mono">${esc(r.code)}</strong><br><span class="cc-muted cc-small">${esc(r.description || '')}</span>` },
      { label: 'Discount', render: r => r.kind === 'percent' ? `${+r.value}% off` : r.kind === 'fixed' ? `${money(r.value)} off` : r.kind === 'free_shipping' ? 'Free shipping' : `Buy ${r.buy_qty} get ${r.get_qty}` },
      { label: 'Applies to', render: r => r.scope === 'all' ? 'Everything' : `${label(r.scope)} (${(r.scope_ids || []).length})` },
      { label: 'Used', align: 'right', render: r => `${r.uses_count}${r.max_uses ? ` / ${r.max_uses}` : ''}` },
      { label: 'Dates', render: r => `${r.starts_at ? date(r.starts_at) : 'now'} → ${r.ends_at ? date(r.ends_at) : 'no end'}` },
      { label: 'Status', render: r => !r.is_active ? pill('draft', 'Off') : r.ends_at && new Date(r.ends_at) < new Date() ? pill('expired') : pill('active', 'Active') }],
    fields: (L) => [{ name: 'code', label: 'Code', required: true, help: 'Capitals, numbers, - or _ (3–32).' },
      { name: 'description', label: 'Description (staff)' },
      { name: 'kind', label: 'Type', type: 'select', required: true, options: [['percent', 'Percent off'], ['fixed', 'Fixed amount off'], ['free_shipping', 'Free shipping'], ['bxgy', 'Buy X get Y (cheapest free)']] },
      { name: 'value', label: 'Value', type: 'number', min: 0, help: 'Percent (e.g. 20) or dollars (e.g. 10). Not used for free shipping / buy X get Y.' },
      { name: 'buy_qty', label: 'Buy (X)', type: 'number', min: 1, step: 1 }, { name: 'get_qty', label: 'Get free (Y)', type: 'number', min: 1, step: 1 },
      { name: 'scope', label: 'Applies to', type: 'select', options: [['all', 'Everything'], ['products', 'Selected products'], ['categories', 'Selected categories'], ['collections', 'Selected collections']] },
      { name: 'scope_pick', label: 'Selected items', type: 'multi', full: true, help: 'Used when “Applies to” isn’t Everything.',
        groups: { products: L.products, categories: L.categories, collections: L.collections } },
      { name: 'min_subtotal_cents', label: 'Minimum order', type: 'money' },
      { name: 'starts_at', label: 'Starts', type: 'datetime' }, { name: 'ends_at', label: 'Ends', type: 'datetime' },
      { name: 'max_uses', label: 'Max total uses', type: 'number', min: 1, step: 1 }, { name: 'per_customer_limit', label: 'Uses per customer', type: 'number', min: 1, step: 1 },
      { name: 'customer_emails', label: 'Only these customers (emails)', type: 'tags', full: true },
      { name: 'first_order_only', label: 'First order only', type: 'checkbox' }, { name: 'exclude_limited', label: 'Exclude limited editions', type: 'checkbox' },
      { name: 'is_active', label: 'Active', type: 'checkbox' }],
    load: (r) => ({ ...r, value: r.kind === 'fixed' ? Number(r.value) / 100 : r.value, scope_pick: r.scope_ids || [] }),
    save: (v) => {
      v.code = String(v.code || '').toUpperCase();
      if (!/^[A-Z0-9_-]{3,32}$/.test(v.code)) throw new Error('Code: 3–32 capitals, numbers, - or _.');
      if (v.kind === 'percent' && !(v.value > 0 && v.value <= 100)) throw new Error('Percent must be between 1 and 100.');
      if (v.kind === 'fixed') { if (!(v.value > 0)) throw new Error('Enter the dollar amount.'); v.value = Math.round(v.value * 100); }
      if (['free_shipping', 'bxgy'].includes(v.kind)) v.value = 0;
      if (v.kind === 'bxgy' && !(v.buy_qty && v.get_qty)) throw new Error('Buy X get Y needs both quantities.');
      v.scope_ids = v.scope === 'all' ? [] : (v.scope_pick || []);
      if (v.scope !== 'all' && !v.scope_ids.length) throw new Error('Pick at least one item for this discount.');
      delete v.scope_pick;
      v.min_subtotal_cents ??= 0;
      v.customer_emails = (v.customer_emails || []).map(e => e.toLowerCase());
      if (!v.customer_emails.length) v.customer_emails = null;
      return v;
    },
    defaults: { kind: 'percent', scope: 'all', is_active: true, exclude_limited: false, min_subtotal_cents: 0 },
    note: 'Codes are never listed publicly; customers type them at checkout. Every change is in the audit log.',
  },
  shipping: {
    title: 'Shipping rates', one: 'shipping rate', perm: 'settings.write', table: 'shipping_rates', order: 'sort_order',
    lookups: async () => ({ zones: await db.from('shipping_zones').select('id,name,provinces').order('name') }),
    columns: (L) => [{ label: 'Rate', render: r => `<strong>${esc(r.label)}</strong> <span class="cc-muted cc-small">${esc(r.code)}</span>` },
      { label: 'Zone', render: r => { const z = L.zones.find(z => z.id === r.zone_id); return z ? `${esc(z.name)}<br><span class="cc-muted cc-small">${esc(z.provinces.join(', '))}</span>` : '—'; } },
      { label: 'Price', align: 'right', render: r => money(r.price_cents) }, { label: 'Free over', align: 'right', render: r => r.free_over_cents ? money(r.free_over_cents) : '—' },
      { label: 'Days', render: r => `${r.min_days}–${r.max_days}` }, { label: 'Carrier', render: r => esc(r.carrier || '—') },
      { label: 'Status', render: r => r.is_active ? pill('active', 'On') : pill('draft', 'Off') }],
    fields: (L) => [{ name: 'label', label: 'Name shown at checkout', required: true }, { name: 'code', label: 'Code', required: true, help: 'e.g. standard, express' },
      { name: 'zone_id', label: 'Zone', type: 'select', required: true, options: L.zones.map(z => [z.id, `${z.name} (${z.provinces.join(', ')})`]) },
      { name: 'carrier', label: 'Carrier' }, { name: 'price_cents', label: 'Price', type: 'money', required: true },
      { name: 'free_over_cents', label: 'Free over (order subtotal)', type: 'money' },
      { name: 'min_days', label: 'Min business days', type: 'number', step: 1, min: 0, required: true }, { name: 'max_days', label: 'Max business days', type: 'number', step: 1, min: 0, required: true },
      { name: 'sort_order', label: 'Sort order', type: 'number', step: 1 }, { name: 'is_active', label: 'Offered at checkout', type: 'checkbox' }],
    save: (v) => { if (!/^[a-z0-9_]+$/.test(v.code)) throw new Error('Code: lowercase letters, numbers and _ only.'); return v; },
    defaults: { is_active: true, sort_order: 0, min_days: 2, max_days: 7 },
  },
  taxes: {
    title: 'Tax rates', one: 'tax rate', perm: 'settings.write', table: 'tax_rates', order: 'province',
    columns: () => [{ key: 'province', label: 'Province' }, { key: 'label', label: 'Label' }, { key: 'tax_type', label: 'Type' },
      { label: 'Rate', align: 'right', render: r => `${(Number(r.rate) * 100).toFixed(3).replace(/\.?0+$/, '')}%` },
      { label: 'Effective', render: r => `${date(r.effective_from)} → ${r.effective_to ? date(r.effective_to) : 'current'}` },
      { label: '', render: r => r.effective_to && new Date(r.effective_to) < new Date() ? pill('expired', 'Past') : pill('active', 'Current') }],
    fields: () => [{ name: 'province', label: 'Province (2 letters)', required: true }, { name: 'tax_type', label: 'Type', type: 'select', options: ['GST', 'HST', 'PST', 'QST', 'RST'].map(t => [t, t]) },
      { name: 'label', label: 'Label on receipts', required: true }, { name: 'rate_pct', label: 'Rate (%)', type: 'number', min: 0, max: 99, required: true },
      { name: 'effective_from', label: 'Effective from', type: 'date', required: true }, { name: 'effective_to', label: 'Effective to (last day)', type: 'date' }],
    load: (r) => ({ ...r, rate_pct: +(Number(r.rate) * 100).toFixed(4) }),
    save: (v) => { v.province = String(v.province).toUpperCase(); v.rate = v.rate_pct / 100; delete v.rate_pct; return v; },
    note: 'A rate change is a new row with a start date — end the old one with “Effective to” rather than editing its rate, so past orders stay explainable. Have an accountant confirm rates before launch.',
  },
  store: {
    title: 'Store settings', one: 'setting', perm: 'settings.write', table: 'store_settings', idKey: 'key', order: 'key',
    columns: () => [{ label: 'Setting', render: r => `<strong class="cc-mono">${esc(r.key)}</strong>` },
      { label: 'Value', render: r => `<code class="cc-small">${esc(JSON.stringify(r.value).slice(0, 120))}</code>` },
      { label: 'Public', render: r => r.is_public ? 'Yes' : 'Staff only' }],
    fields: () => [{ name: 'key', label: 'Key', required: true, help: 'e.g. store.tagline' }, { name: 'value', label: 'Value (JSON)', type: 'json', full: true, rows: 6 },
      { name: 'is_public', label: 'Readable by the storefront', type: 'checkbox' }],
    save: (v) => { if (v.value === null) throw new Error('Value is required (use "" for text).'); return v; },
  },
  themes: {
    title: 'Themes', one: 'theme', perm: 'catalog.write', table: 'themes', order: 'name',
    columns: () => [{ key: 'name', label: 'Theme' }, { key: 'slug', label: 'Slug' },
      { label: 'Look', render: r => { const c = r.config?.colors || {}; return ['bg', 'fg', 'accent', 'surface'].map(k => c[k] ? `<span class="cc-swatch" style="background:${esc(c[k])}" title="${k} ${esc(c[k])}"></span>` : '').join(''); } },
      { label: 'Background', render: r => esc(label(r.config?.background?.effect || 'none')) }],
    fields: () => [{ name: 'name', label: 'Name', required: true }, { name: 'slug', label: 'Slug' },
      { name: 'config', label: 'Theme config (JSON): colors, fonts, background, hero, intro, cards, buttons, motion', type: 'json', full: true, rows: 18 }],
    save: (v) => { v.slug ||= slugify(v.name); v.config ||= {}; return v; },
  },
};

export async function view(ctx) {
  const key = ctx.key, cfg = CONFIG[key];
  const tableName = cfg.table || key, idKey = cfg.idKey || 'id';
  const L = cfg.lookups ? await cfg.lookups() : {};
  const canWrite = ctx.can(cfg.perm);
  const editing = ctx.segs[1];

  if (editing) {
    const isNew = editing === 'new';
    const row = isNew ? { ...(cfg.defaults || {}) }
      : await db.from(tableName).select('*').eq(idKey, decodeURIComponent(editing)).single().catch(() => null);
    if (!row) return { title: cfg.title, html: '<p class="cc-empty">Not found.</p>' };
    const fields = cfg.fields(L);
    const values = cfg.load ? cfg.load(row) : row;
    return {
      title: isNew ? `New ${cfg.one}` : `Edit ${cfg.one}`,
      html: `<p class="cc-crumbs"><a href="/admin/${key}">${esc(cfg.title)}</a> / ${isNew ? 'New' : esc(row.name || row.code || row.label || row.key || '')}</p>
        <header class="cc-head"><h1>${isNew ? `New ${esc(cfg.one)}` : esc(row.name || row.code || row.label || row.key)}</h1></header>
        ${cfg.note ? `<p class="cc-note">${esc(cfg.note)}</p>` : ''}
        <section class="cc-card">${canWrite ? formWithMulti(fields, values) : '<p class="cc-empty">You can view but not edit this.</p>'}</section>`,
      mount(root) {
        bindColorMirrors(root);
        bindMulti(root);
        const f = root.querySelector('[data-form]'); if (!f) return;
        f.onsubmit = async (e) => {
          e.preventDefault();
          const msg = f.querySelector('[data-msg]');
          try {
            let v = readForm(f, fields.filter(x => x.type !== 'multi'));
            for (const m of fields.filter(x => x.type === 'multi')) v[m.name] = [...f.querySelectorAll(`[data-multi="${m.name}"] input:checked`)].filter(i => i.closest('[data-group]').dataset.group === f.elements.scope?.value).map(i => i.value);
            v = cfg.save ? cfg.save(v) : v;
            msg.textContent = 'Saving…';
            const saved = isNew ? (await db.insert(tableName, v))[0] : (await db.update(tableName, { [idKey]: row[idKey] }, v))[0];
            toast(`${label(cfg.one)} saved.`);
            ctx.go(`/admin/${key}/${encodeURIComponent(saved?.[idKey] ?? row[idKey])}`);
          } catch (err) { msg.textContent = errorText(err); }
        };
      },
    };
  }

  let q = db.from(tableName).select('*').order(cfg.order || idKey, { ascending: !cfg.desc });
  const rows = await q;
  return {
    title: cfg.title,
    html: `<header class="cc-head"><div><h1>${esc(cfg.title)}</h1><p class="cc-muted">${rows.length} total</p></div>
        ${canWrite ? `<a class="cc-btn cc-btn--primary" href="/admin/${key}/new">New ${esc(cfg.one)}</a>` : ''}</header>
      ${cfg.note ? `<p class="cc-note">${esc(cfg.note)}</p>` : ''}
      <section class="cc-card cc-card--flush">${table(rows, cfg.columns(L), { rowHref: r => `/admin/${key}/${encodeURIComponent(r[idKey])}` })}</section>`,
    mount(root) { bindRowLinks(root, ctx.go); },
  };
}

// Multi-select of products / categories / collections for discount scope.
function formWithMulti(fields, values) {
  const multi = fields.filter(f => f.type === 'multi');
  if (!multi.length) return form(fields, values);
  let html = form(fields.filter(f => f.type !== 'multi'), values);
  const m = multi[0], picked = new Set(values[m.name] || []);
  const box = `<div class="cc-field is-full"><span>${esc(m.label)}</span><div class="cc-multi" data-multi="${m.name}">${Object.entries(m.groups).map(([g, items]) =>
    `<div data-group="${g}" ${values.scope === g ? '' : 'hidden'}>${items.map(i => `<label class="cc-check"><input type="checkbox" value="${i.id}"${picked.has(i.id) ? ' checked' : ''}> ${esc(i.name)}</label>`).join('') || '<p class="cc-muted">None yet.</p>'}</div>`).join('')}
    </div><small>${esc(m.help || '')}</small></div>`;
  return html.replace('</div>\n    <div class="cc-form-actions">', box + '</div>\n    <div class="cc-form-actions">');
}
function bindMulti(root) {
  const f = root.querySelector('[data-form]'), sc = f?.elements.scope;
  if (!sc) return;
  sc.addEventListener('change', () => root.querySelectorAll('[data-group]').forEach(g => { g.hidden = g.dataset.group !== sc.value; }));
}

export { CONFIG, confirmDialog };
