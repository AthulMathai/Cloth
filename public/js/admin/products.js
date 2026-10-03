// Products: list, create/edit, variants, stock, images, duplicate, archive.
import { db, storage, storageUrl } from '../lib/supabase.js';
import { esc, money, num, pill, table, label, dateTime, form, readForm, toast, confirmDialog, bindRowLinks, errorText } from './ui.js';

const STATUSES = ['draft', 'scheduled', 'active', 'out_of_stock', 'sold_out', 'discontinued', 'archived'];
const TYPES = ['tee', 'hoodie', 'crewneck', 'longsleeve', 'tank', 'accessory', 'other'];
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export async function view(ctx) {
  if (ctx.segs[1]) return edit(ctx, ctx.segs[1]);
  const q = ctx.query.get('q') || '', status = ctx.query.get('status') || '';
  const rows = await db.rpc('admin_products', { p_q: q || null, p_status: status || null });
  const tab = (s, l) => `<a href="/admin/products?${new URLSearchParams({ ...(q ? { q } : {}), ...(s ? { status: s } : {}) })}"${s === status ? ' aria-current="true"' : ''}>${l}</a>`;
  return {
    title: status === 'archived' ? 'Archive' : 'Products',
    html: `<header class="cc-head"><div><h1>${status === 'archived' ? 'Archive' : 'Products'}</h1><p class="cc-muted">${rows.length} products</p></div>
        <div class="cc-actions"><form class="cc-search" data-search role="search"><input name="q" value="${esc(q)}" placeholder="Name, slug or SKU" aria-label="Search products"><button class="cc-btn">Search</button></form>
        ${ctx.can('products.write') ? '<a class="cc-btn cc-btn--primary" href="/admin/products/new">New product</a>' : ''}</div></header>
      <nav class="cc-tabs">${tab('', 'All')}${STATUSES.map(s => tab(s, label(s))).join('')}</nav>
      ${status === 'archived' ? '<p class="cc-note">Archived products stay visible in the Limited Edition Archive but can never be bought. Sales history is kept.</p>' : ''}
      <section class="cc-card cc-card--flush">${table(rows, [
        { label: 'Product', render: p => `<strong>${esc(p.name)}</strong>${p.is_limited ? ' <span class="cc-tag">Limited</span>' : ''}${p.is_customizable ? ' <span class="cc-tag">Blank</span>' : ''}${p.is_featured ? ' <span class="cc-tag">Featured</span>' : ''}<br><span class="cc-muted cc-small">${esc(p.slug)}</span>` },
        { label: 'Type', render: p => esc(label(p.product_type)) },
        { label: 'Collection', render: p => esc(p.collection || p.category || '—') },
        { label: 'Price', align: 'right', render: p => p.sale_price_cents ? `<s class="cc-muted">${money(p.base_price_cents)}</s> ${money(p.sale_price_cents)}` : money(p.base_price_cents) },
        { label: 'Stock', align: 'right', render: p => `${num(p.available)}${p.low ? ` <span class="cc-tag cc-tag--warn">${p.low} low</span>` : ''}` },
        { label: 'Edition', render: p => p.drop_info ? `${p.drop_info.units_sold}/${p.drop_info.edition_size}` : '—' },
        { label: 'Status', render: p => pill(p.status) },
        { label: 'Updated', render: p => dateTime(p.updated_at) }], { empty: 'No products match.', rowHref: p => `/admin/products/${p.id}` })}</section>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(`/admin/products?${new URLSearchParams({ q: e.target.q.value.trim(), ...(status ? { status } : {}) })}`); };
    },
  };
}

async function edit(ctx, id) {
  const isNew = id === 'new';
  const [cats, cols, designers, p, variants, media, drop] = await Promise.all([
    db.from('categories').select('id,name').order('sort_order'), db.from('collections').select('id,name').order('name'),
    db.from('designers').select('id,name').order('name'),
    isNew ? Promise.resolve({ status: 'draft', product_type: 'tee', currency: 'CAD', tags: [], print_locations: [], print_methods: [] })
          : db.from('products').select('*').eq('id', id).single().catch(() => null),
    isNew ? [] : db.from('product_variants').select('*').eq('product_id', id).order('sort_order'),
    isNew ? [] : db.from('product_media').select('*').eq('product_id', id).order('sort_order'),
    isNew ? null : db.from('limited_drops').select('*').eq('product_id', id).single().catch(() => null),
  ]);
  if (!p) return { title: 'Not found', html: '<p class="cc-empty">Product not found.</p>' };
  const canWrite = ctx.can('products.write'), canStock = ctx.can('inventory.write');
  const fields = [
    { name: 'name', label: 'Name', required: true }, { name: 'slug', label: 'URL slug', help: 'Generated from the name if empty.' },
    { name: 'product_type', label: 'Product type', type: 'select', options: TYPES.map(t => [t, label(t)]) },
    { name: 'status', label: 'Status', type: 'select', options: STATUSES.map(s => [s, label(s)]), help: 'Scheduled products go live at the publish time.' },
    { name: 'publish_at', label: 'Publish at', type: 'datetime' },
    { name: 'sku', label: 'SKU (product)' },
    { name: 'category_id', label: 'Category', type: 'select', options: [['', '—'], ...cats.map(c => [c.id, c.name])] },
    { name: 'collection_id', label: 'Collection', type: 'select', options: [['', '—'], ...cols.map(c => [c.id, c.name])] },
    { name: 'designer_id', label: 'Designer / artist', type: 'select', options: [['', '—'], ...designers.map(c => [c.id, c.name])] },
    { name: 'base_price_cents', label: 'Price', type: 'money', required: true }, { name: 'sale_price_cents', label: 'Sale price', type: 'money', help: 'Must be below the price.' },
    { name: 'cost_cents', label: 'Unit cost (staff only)', type: 'money' },
    { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 5 },
    { name: 'materials', label: 'Materials' }, { name: 'weight_grams', label: 'Weight (g)', type: 'number', step: 1, min: 1 },
    { name: 'tags', label: 'Tags', type: 'tags', full: true, help: 'Products tagged “blank” are offered in the custom designer.' },
    { name: 'print_locations', label: 'Print locations', type: 'tags' }, { name: 'print_methods', label: 'Print methods', type: 'tags' },
    { name: 'production_requirements', label: 'Production requirements (JSON)', type: 'json', full: true },
    { name: 'dimensions', label: 'Dimensions (JSON)', type: 'json' },
    { name: 'is_customizable', label: 'Can be customized (custom designer blank)', type: 'checkbox' },
    { name: 'is_featured', label: 'Featured', type: 'checkbox' },
    { name: 'seo_title', label: 'SEO title' }, { name: 'seo_description', label: 'Meta description', type: 'textarea', rows: 2 },
  ];
  const values = { ...p, seo_title: p.seo?.title || '', seo_description: p.seo?.description || '' };
  const stockLeft = (v) => v.inventory_on_hand - v.inventory_reserved;

  return {
    title: isNew ? 'New product' : p.name,
    html: `<p class="cc-crumbs"><a href="/admin/products">Products</a> / ${isNew ? 'New' : esc(p.name)}</p>
      <header class="cc-head"><div><h1>${isNew ? 'New product' : esc(p.name)} ${isNew ? '' : pill(p.status)}</h1>
        ${isNew ? '' : `<p class="cc-muted">Updated ${dateTime(p.updated_at)}${p.is_limited ? ' · limited edition' : ''}</p>`}</div>
        ${isNew ? '' : `<div class="cc-actions"><a class="cc-btn" href="/product/${esc(p.slug)}" target="_blank" rel="noopener">View in store ↗</a>
          ${canWrite ? `<button class="cc-btn" data-act="dup">Duplicate</button>${p.status !== 'archived' ? '<button class="cc-btn cc-btn--danger" data-act="archive">Archive</button>' : ''}` : ''}</div>`}</header>
      ${drop ? `<div class="cc-alert cc-alert--info"><strong>Limited drop ${String(drop.drop_number).padStart(3, '0')}: ${esc(drop.drop_name)}</strong> — ${drop.units_sold}/${drop.edition_size} sold, ${drop.units_reserved} reserved.
        <a href="/admin/drops/${drop.id}">Edit drop</a></div>` : ''}
      <section class="cc-card"><h2>Details</h2>${canWrite ? form(fields, values, { submit: isNew ? 'Create product' : 'Save product' }) : '<p class="cc-empty">You can view but not edit products.</p>'}</section>
      ${isNew ? '<p class="cc-note">Save the product first, then add variants (sizes/colours), stock and images.</p>' : `
      <section class="cc-card"><div class="cc-card-head"><h2>Variants & stock</h2>
          ${canWrite ? '<button class="cc-btn cc-btn--small" data-act="grid">Add sizes × colours…</button>' : ''}</div>
        ${table(variants, [
          { label: 'Variant', render: v => `<span class="cc-swatch" style="background:${esc(v.color_hex || '#ccc')}"></span> ${esc(v.color || '')} / <strong>${esc(v.size || '')}</strong>` },
          { label: 'SKU', render: v => `<span class="cc-mono cc-small">${esc(v.sku || '—')}</span>` },
          { label: 'Price', align: 'right', render: v => v.price_cents == null ? '<span class="cc-muted">product price</span>' : money(v.price_cents) },
          { label: 'On hand', align: 'right', render: v => num(v.inventory_on_hand) },
          { label: 'Reserved', align: 'right', render: v => num(v.inventory_reserved) },
          { label: 'Available', align: 'right', render: v => `${num(stockLeft(v))}${stockLeft(v) <= v.low_stock_threshold ? ' <span class="cc-tag cc-tag--warn">low</span>' : ''}` },
          { label: '', render: v => `${v.is_active ? '' : pill('draft', 'Off') + ' '}${canStock ? `<button class="cc-btn cc-btn--small" data-stock="${v.id}">Adjust stock</button>` : ''}
              ${canWrite ? `<button class="cc-btn cc-btn--small" data-variant="${v.id}">Edit</button>` : ''}` }],
          { empty: 'No variants yet. Add sizes and colours so customers can buy it.' })}
        <p class="cc-muted cc-small">Stock only changes through recorded adjustments (restock, damage, count correction), so every change has a reason in the inventory history.</p></section>
      <section class="cc-card"><div class="cc-card-head"><h2>Images & video</h2>
          ${canWrite ? `<label class="cc-btn cc-btn--small">Upload image<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-upload></label>
            <button class="cc-btn cc-btn--small" data-act="media-url">Add by URL</button>` : ''}</div>
        <div class="cc-media">${media.map(m => `<figure>${m.kind === 'video' ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}" alt="${esc(m.alt || '')}">`}
          <figcaption>${esc(m.view || m.kind)}${m.is_historical ? ' · historical' : ''}${canWrite ? ` <button class="cc-link" data-rm-media="${m.id}">Remove</button>` : ''}</figcaption></figure>`).join('') || '<p class="cc-empty">No images yet — the store shows the drawn garment until there are photos.</p>'}</div></section>`}`,
    mount(root) {
      const f = root.querySelector('[data-form]');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const msg = f.querySelector('[data-msg]');
        try {
          const v = readForm(f, fields);
          v.slug ||= slugify(v.name);
          if (!/^[a-z0-9-]+$/.test(v.slug)) throw new Error('Slug: lowercase letters, numbers and dashes only.');
          if (v.sale_price_cents != null && v.sale_price_cents >= v.base_price_cents) throw new Error('Sale price must be below the price.');
          if (v.status === 'scheduled' && !v.publish_at) throw new Error('Scheduled products need a publish time.');
          v.seo = { ...(v.seo_title ? { title: v.seo_title } : {}), ...(v.seo_description ? { description: v.seo_description } : {}) };
          delete v.seo_title; delete v.seo_description;
          v.production_requirements ||= {}; v.dimensions ||= null;
          msg.textContent = 'Saving…';
          const saved = isNew ? (await db.insert('products', v))[0] : (await db.update('products', { id: p.id }, v))[0];
          toast('Product saved.');
          ctx.go(`/admin/products/${saved.id}`);
        } catch (err) { msg.textContent = errorText(err); }
      };
      root.addEventListener('click', async (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const reload = () => ctx.go(location.pathname);
        try {
          if (t.dataset.act === 'dup') {
            const nid = await db.rpc('admin_duplicate_product', { p_product_id: p.id });
            toast('Duplicated as a draft (stock starts at 0).'); ctx.go(`/admin/products/${nid}`);
          } else if (t.dataset.act === 'archive') {
            const r = await confirmDialog({ title: `Archive ${p.name}?`, tone: 'danger', confirm: 'Archive',
              body: '<p>It leaves the shop and can never be bought again. Limited editions appear in the archive with their history.</p>' });
            if (r.ok) { await db.update('products', { id: p.id }, { status: 'archived' }); toast('Archived.'); reload(); }
          } else if (t.dataset.stock) {
            const v = variants.find(x => x.id === t.dataset.stock);
            const out = await stockDialog(v);
            if (out) { const after = await db.rpc('adjust_inventory', out); toast(`Stock updated: ${after} on hand.`); reload(); }
          } else if (t.dataset.variant) {
            const v = variants.find(x => x.id === t.dataset.variant);
            if (await variantDialog(v)) reload();
          } else if (t.dataset.act === 'grid') {
            if (await gridDialog(p, variants)) reload();
          } else if (t.dataset.act === 'media-url') {
            const r = await confirmDialog({ title: 'Add image or video by URL', note: true, noteLabel: 'URL (https://…)', noteRequired: true, confirm: 'Add' });
            if (r.ok) {
              if (!/^https:\/\//.test(r.note)) throw new Error('Use an https:// link.');
              await db.insert('product_media', { product_id: p.id, url: r.note, kind: /\.(mp4|webm)(\?|$)/i.test(r.note) ? 'video' : 'image', alt: p.name, sort_order: media.length });
              reload();
            }
          } else if (t.dataset.rmMedia) {
            const r = await confirmDialog({ title: 'Remove this image?', tone: 'danger', confirm: 'Remove' });
            if (r.ok) { await db.remove('product_media', { id: t.dataset.rmMedia }); reload(); }
          }
        } catch (err) { toast(errorText(err), 'bad'); }
      });
      root.querySelector('[data-upload]')?.addEventListener('change', async (e) => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 15 * 1024 * 1024) { toast('Use a PNG, JPG or WebP under 15 MB.', 'bad'); return; }
        try {
          toast('Uploading…');
          const path = `${p.slug}/${Date.now()}-${slugify(file.name.replace(/\.[^.]+$/, ''))}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
          await storage.upload('products', path, file, file.type);
          await db.insert('product_media', { product_id: p.id, url: storageUrl('products', path), kind: 'image', alt: p.name, sort_order: media.length });
          toast('Image added.'); ctx.go(location.pathname);
        } catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}

async function stockDialog(v) {
  const d = document.createElement('dialog');
  d.className = 'cc-dialog';
  d.innerHTML = `<form method="dialog"><h2>Adjust stock — ${esc(v.color)} / ${esc(v.size)}</h2>
    <p class="cc-muted">On hand ${v.inventory_on_hand}, reserved ${v.inventory_reserved}.</p>
    <label class="cc-field"><span>Change (+ to add, − to remove)</span><input name="delta" type="number" step="1" required></label>
    <label class="cc-field"><span>Reason</span><select name="reason"><option value="restock">Restock (received)</option><option value="adjustment">Count correction</option>
      <option value="damage">Damaged / lost</option><option value="return">Customer return</option><option value="initial">Initial stock</option></select></label>
    <label class="cc-field"><span>Note</span><input name="note" maxlength="200"></label>
    <p class="cc-form-msg" data-msg></p>
    <div class="cc-form-actions"><button class="cc-btn" type="button" data-cancel>Cancel</button><button class="cc-btn cc-btn--primary">Save</button></div></form>`;
  document.body.append(d); d.showModal();
  return new Promise((resolve) => {
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done(null);
    d.addEventListener('cancel', () => done(null));
    f.onsubmit = (e) => {
      e.preventDefault();
      const delta = Math.round(Number(f.delta.value));
      if (!delta) { f.querySelector('[data-msg]').textContent = 'Enter a number other than 0.'; return; }
      if (v.inventory_on_hand + delta < v.inventory_reserved) { f.querySelector('[data-msg]').textContent = `Can't go below the ${v.inventory_reserved} reserved for open checkouts.`; return; }
      done({ p_variant_id: v.id, p_delta: delta, p_reason: f.reason.value, p_note: f.note.value.trim() || null, p_reference: 'admin' });
    };
  });
}

async function variantDialog(v) {
  const fields = [{ name: 'color', label: 'Colour name' }, { name: 'color_hex', label: 'Colour', type: 'color' }, { name: 'size', label: 'Size' },
    { name: 'sku', label: 'SKU' }, { name: 'price_cents', label: 'Price override', type: 'money', help: 'Empty = product price.' },
    { name: 'sale_price_cents', label: 'Sale price override', type: 'money' }, { name: 'cost_cents', label: 'Unit cost', type: 'money' },
    { name: 'low_stock_threshold', label: 'Low-stock alert at', type: 'number', step: 1, min: 0 }, { name: 'sort_order', label: 'Sort order', type: 'number', step: 1 },
    { name: 'is_active', label: 'Available', type: 'checkbox' }];
  const d = document.createElement('dialog');
  d.className = 'cc-dialog cc-dialog--wide';
  d.innerHTML = `<h2>Edit variant</h2>${form(fields, v, { submit: 'Save variant', extra: '<button class="cc-btn" type="button" data-cancel>Cancel</button>' })}`;
  document.body.append(d); d.showModal();
  const { bindColorMirrors } = await import('./ui.js'); bindColorMirrors(d);
  return new Promise((resolve) => {
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done(false);
    d.addEventListener('cancel', () => done(false));
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await db.update('product_variants', { id: v.id }, readForm(f, fields)); toast('Variant saved.'); done(true); }
      catch (err) { f.querySelector('[data-msg]').textContent = errorText(err); }
    };
  });
}

async function gridDialog(p, existing) {
  const d = document.createElement('dialog');
  d.className = 'cc-dialog';
  d.innerHTML = `<form method="dialog"><h2>Add sizes × colours</h2>
    <label class="cc-field"><span>Sizes</span><input name="sizes" value="S, M, L, XL, XXL"></label>
    <label class="cc-field"><span>Colours (name #hex, one per line)</span><textarea name="colors" rows="4">Black #141414</textarea></label>
    <label class="cc-field"><span>Starting stock per variant</span><input name="stock" type="number" min="0" step="1" value="0"></label>
    <p class="cc-muted cc-small">Existing combinations are skipped. SKUs are generated from the product SKU or slug.</p>
    <p class="cc-form-msg" data-msg></p>
    <div class="cc-form-actions"><button class="cc-btn" type="button" data-cancel>Cancel</button><button class="cc-btn cc-btn--primary">Create variants</button></div></form>`;
  document.body.append(d); d.showModal();
  return new Promise((resolve) => {
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done(false);
    d.addEventListener('cancel', () => done(false));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const msg = f.querySelector('[data-msg]');
      try {
        const sizes = f.sizes.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const colors = f.colors.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const m = l.match(/^(.*?)\s*(#[0-9a-f]{6})?$/i); return { name: m[1].trim(), hex: m[2] || null };
        });
        if (!sizes.length || !colors.length) throw new Error('Enter at least one size and one colour.');
        const have = new Set(existing.map(v => `${v.color}|${v.size}`));
        const base = (p.sku || p.slug).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24);
        const rows = [];
        let k = existing.length;
        for (const c of colors) for (const s of sizes) {
          if (have.has(`${c.name}|${s}`)) continue;
          rows.push({ product_id: p.id, color: c.name, color_hex: c.hex, size: s, sku: `${base}-${c.name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6)}-${s}`, sort_order: k++, is_active: true });
        }
        if (!rows.length) throw new Error('All of those combinations already exist.');
        msg.textContent = `Creating ${rows.length} variants…`;
        const made = await db.insert('product_variants', rows);
        const stock = Math.max(0, Math.round(Number(f.stock.value) || 0));
        if (stock) for (const v of made) await db.rpc('adjust_inventory', { p_variant_id: v.id, p_delta: stock, p_reason: 'initial', p_note: 'Initial stock', p_reference: 'admin' });
        toast(`${made.length} variants added.`); done(true);
      } catch (err) { msg.textContent = errorText(err); }
    };
  });
}
