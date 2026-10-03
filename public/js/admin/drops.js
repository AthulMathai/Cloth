// Limited drops: create / edit, progress, release schedule.
import { db } from '../lib/supabase.js';
import { esc, money, num, pill, table, dateTime, form, readForm, toast, bindRowLinks, errorText } from './ui.js';

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export async function view(ctx) {
  const canWrite = ctx.can('products.write');
  if (ctx.segs[1]) return edit(ctx, ctx.segs[1], canWrite);
  const [drops, products] = await Promise.all([
    db.from('limited_drops').select('*').order('drop_number', { ascending: false }),
    db.from('products').select('id,name,slug,status'),
  ]);
  const prod = (id) => products.find(p => p.id === id);
  return {
    title: 'Limited drops',
    html: `<header class="ad-head"><div><h1>Limited drops</h1><p class="ad-muted">${drops.length} drops</p></div>
        ${canWrite ? '<a class="ad-btn ad-btn--primary" href="/admin/drops/new">New drop</a>' : ''}</header>
      <p class="ad-note">Edition numbers are assigned when payment is confirmed, never twice. When the last piece sells the product becomes sold out, then moves to the archive automatically.</p>
      <section class="ad-card ad-card--flush">${table(drops, [
        { label: 'Drop', render: d => `<strong>${String(d.drop_number).padStart(3, '0')} · ${esc(d.drop_name)}</strong><br><span class="ad-muted ad-small">${esc(prod(d.product_id)?.name || '')}</span>` },
        { label: 'Sold', render: d => `<div class="ad-meter" role="img" aria-label="${d.units_sold} of ${d.edition_size} sold"><span style="width:${Math.min(100, d.units_sold / d.edition_size * 100)}%"></span></div>
            <span class="ad-small">${num(d.units_sold)} / ${num(d.edition_size)}${d.units_reserved ? ` · ${d.units_reserved} in checkout` : ''}</span>` },
        { label: 'Release', render: d => dateTime(d.release_at) },
        { label: 'Price', align: 'right', render: d => d.original_price_cents ? money(d.original_price_cents) : '—' },
        { label: 'Status', render: d => d.archived_at ? pill('archived') : d.sold_out_at ? pill('sold_out') : pill(prod(d.product_id)?.status || 'draft') }],
        { empty: 'No drops yet.', rowHref: d => `/admin/drops/${d.id}` })}</section>`,
    mount(root) { bindRowLinks(root, ctx.go); },
  };
}

async function edit(ctx, id, canWrite) {
  const isNew = id === 'new';
  const [products, d, maxNo] = await Promise.all([
    db.from('products').select('id,name,status,base_price_cents').order('name'),
    isNew ? null : db.from('limited_drops').select('*').eq('id', id).single().catch(() => null),
    db.from('limited_drops').select('drop_number').order('drop_number', { ascending: false }).limit(1),
  ]);
  if (!isNew && !d) return { title: 'Not found', html: '<p class="ad-empty">Drop not found.</p>' };
  const taken = new Set((await db.from('limited_drops').select('product_id')).map(r => r.product_id));
  const fields = [
    { name: 'product_id', label: 'Product', type: 'select', required: true, help: 'The product sold in this drop (one drop per product).',
      options: [['', '— choose —'], ...products.filter(p => !taken.has(p.id) || p.id === d?.product_id).map(p => [p.id, `${p.name} (${p.status})`])] },
    { name: 'drop_name', label: 'Drop name', required: true }, { name: 'drop_number', label: 'Drop number', type: 'number', step: 1, min: 1, required: true },
    { name: 'slug', label: 'Archive URL slug', help: 'e.g. cyber-samurai-drop-001' },
    { name: 'edition_size', label: 'Edition size (pieces)', type: 'number', step: 1, min: 1, required: true },
    { name: 'max_per_order', label: 'Max per order', type: 'number', step: 1, min: 1 },
    { name: 'release_at', label: 'Release date & time', type: 'datetime', required: true },
    { name: 'original_price_cents', label: 'Original price (archive)', type: 'money' },
    { name: 'archive_hours', label: 'Move to archive after selling out (hours)', type: 'number', step: 1, min: 0 },
    { name: 'is_numbered', label: 'Numbered pieces (001 / 500)', type: 'checkbox' },
    { name: 'story', label: 'Design story', type: 'textarea', full: true, rows: 5 },
  ];
  const values = isNew ? { drop_number: (maxNo[0]?.drop_number || 0) + 1, edition_size: 100, max_per_order: 2, is_numbered: true, archive_hours: 48 }
    : { ...d, archive_hours: hours(d.archive_delay) };
  return {
    title: isNew ? 'New drop' : d.drop_name,
    html: `<p class="ad-crumbs"><a href="/admin/drops">Limited drops</a> / ${isNew ? 'New' : esc(d.drop_name)}</p>
      <header class="ad-head"><h1>${isNew ? 'New drop' : `${String(d.drop_number).padStart(3, '0')} · ${esc(d.drop_name)}`}</h1>
        ${!isNew ? `<div class="ad-actions"><a class="ad-btn" href="/admin/products/${d.product_id}">Product</a>${d.archived_at ? `<a class="ad-btn" href="/archive/${esc(d.slug)}" target="_blank" rel="noopener">Archive page ↗</a>` : ''}</div>` : ''}</header>
      ${!isNew ? `<div class="ad-kpis ad-kpis--small"><div class="ad-kpi"><span class="ad-kpi-label">Sold</span><strong>${num(d.units_sold)} / ${num(d.edition_size)}</strong></div>
        <div class="ad-kpi"><span class="ad-kpi-label">In checkout</span><strong>${num(d.units_reserved)}</strong></div>
        <div class="ad-kpi"><span class="ad-kpi-label">Sold out</span><strong>${d.sold_out_at ? dateTime(d.sold_out_at) : '—'}</strong></div>
        <div class="ad-kpi"><span class="ad-kpi-label">Archived</span><strong>${d.archived_at ? dateTime(d.archived_at) : '—'}</strong></div></div>` : ''}
      <p class="ad-note">To schedule the release, set the product's status to Scheduled with the same publish time. The edition size can't be set below pieces already sold or held.</p>
      <section class="ad-card">${canWrite ? form(fields, values, { submit: isNew ? 'Create drop' : 'Save drop' }) : '<p class="ad-empty">View only.</p>'}</section>`,
    mount(root) {
      const f = root.querySelector('[data-form]'); if (!f) return;
      f.onsubmit = async (e) => {
        e.preventDefault();
        const msg = f.querySelector('[data-msg]');
        try {
          const v = readForm(f, fields);
          v.slug ||= `${slugify(v.drop_name)}-drop-${String(v.drop_number).padStart(3, '0')}`;
          if (!/^[a-z0-9-]+$/.test(v.slug)) throw new Error('Slug: lowercase letters, numbers and dashes only.');
          if (!isNew && v.edition_size < d.units_sold + d.units_reserved) throw new Error(`Edition can't be smaller than ${d.units_sold + d.units_reserved} (sold + held).`);
          v.archive_delay = `${v.archive_hours ?? 48} hours`; delete v.archive_hours;
          msg.textContent = 'Saving…';
          const saved = isNew ? (await db.insert('limited_drops', v))[0] : (await db.update('limited_drops', { id: d.id }, v))[0];
          toast('Drop saved.'); ctx.go(`/admin/drops/${saved.id}`);
        } catch (err) { msg.textContent = errorText(err); }
      };
    },
  };
}
function hours(interval) {
  if (!interval) return 48;
  const m = String(interval).match(/(?:(\d+) days?)?\s*(\d+):(\d+)/);
  if (m) return (Number(m[1] || 0) * 24) + Number(m[2]);
  const h = String(interval).match(/(\d+)\s*hour/); return h ? Number(h[1]) : 48;
}
