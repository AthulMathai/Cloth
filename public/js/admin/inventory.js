// Inventory: every variant's stock, low-stock filter, adjustments, history.
import { db } from '../lib/supabase.js';
import { esc, num, table, dateTime, label, toast, errorText } from './ui.js';

export async function view(ctx) {
  const low = ctx.query.get('low') === '1', q = (ctx.query.get('q') || '').toLowerCase();
  const [variants, products, moves] = await Promise.all([
    db.from('product_variants').select('id,product_id,sku,color,color_hex,size,inventory_on_hand,inventory_reserved,low_stock_threshold,is_active').order('sort_order'),
    db.from('products').select('id,name,status'),
    db.from('inventory_movements').select('*').order('created_at', { ascending: false }).limit(40),
  ]);
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  const vmap = Object.fromEntries(variants.map(v => [v.id, v]));
  let rows = variants.filter(v => pmap[v.product_id] && !['archived', 'discontinued'].includes(pmap[v.product_id].status))
    .map(v => ({ ...v, product: pmap[v.product_id].name, available: v.inventory_on_hand - v.inventory_reserved }));
  if (low) rows = rows.filter(v => v.is_active && v.available <= v.low_stock_threshold);
  if (q) rows = rows.filter(v => `${v.product} ${v.sku} ${v.color} ${v.size}`.toLowerCase().includes(q));
  rows.sort((a, b) => a.available - b.available);
  return {
    title: 'Inventory',
    html: `<header class="ad-head"><div><h1>Inventory</h1><p class="ad-muted">${rows.length} variants${low ? ' at or below their low-stock alert' : ''}</p></div>
        <form class="ad-search" data-search role="search"><input name="q" value="${esc(q)}" placeholder="Product, SKU, colour, size" aria-label="Search stock"><button class="ad-btn">Search</button></form></header>
      <nav class="ad-tabs"><a href="/admin/inventory"${!low ? ' aria-current="true"' : ''}>All</a><a href="/admin/inventory?low=1"${low ? ' aria-current="true"' : ''}>Low stock</a></nav>
      <section class="ad-card ad-card--flush">${table(rows, [
        { label: 'Product', render: v => `<a href="/admin/products/${v.product_id}"><strong>${esc(v.product)}</strong></a>` },
        { label: 'Variant', render: v => `<span class="ad-swatch" style="background:${esc(v.color_hex || '#ccc')}"></span> ${esc(v.color || '')} / ${esc(v.size || '')}` },
        { label: 'SKU', render: v => `<span class="ad-mono ad-small">${esc(v.sku || '—')}</span>` },
        { label: 'On hand', align: 'right', render: v => num(v.inventory_on_hand) },
        { label: 'Reserved', align: 'right', render: v => num(v.inventory_reserved) },
        { label: 'Available', align: 'right', render: v => `<strong>${num(v.available)}</strong>${v.available <= v.low_stock_threshold ? ' <span class="ad-tag ad-tag--warn">low</span>' : ''}` },
        { label: '', render: v => `<form class="ad-inline" data-adjust="${v.id}"><input name="d" type="number" step="1" placeholder="±" aria-label="Change for ${esc(v.product)} ${esc(v.size)}">
            <select name="r" aria-label="Reason"><option value="restock">Restock</option><option value="adjustment">Count fix</option><option value="damage">Damage</option><option value="return">Return</option></select>
            <button class="ad-btn ad-btn--small">Apply</button></form>` }], { empty: low ? 'Nothing is low on stock.' : 'No variants.' })}</section>
      <section class="ad-card"><h2>Recent stock changes</h2>${table(moves, [
        { label: 'When', render: m => dateTime(m.created_at) },
        { label: 'Variant', render: m => { const v = vmap[m.variant_id]; return v ? `${esc(pmap[v.product_id]?.name || '')} · ${esc(v.color)} / ${esc(v.size)}` : '—'; } },
        { label: 'Change', align: 'right', render: m => `${m.delta > 0 ? '+' : ''}${m.delta}${m.reserved_delta ? ` <span class="ad-muted ad-small">(held ${m.reserved_delta > 0 ? '+' : ''}${m.reserved_delta})</span>` : ''}` },
        { label: 'After', align: 'right', render: m => num(m.on_hand_after) },
        { label: 'Reason', render: m => esc(label(m.reason)) }, { label: 'Ref', render: m => esc(m.reference || m.note || '') }], { empty: 'No changes yet.' })}</section>`,
    mount(root) {
      root.querySelector('[data-search]').onsubmit = (e) => { e.preventDefault(); ctx.go(`/admin/inventory?${new URLSearchParams({ q: e.target.q.value.trim(), ...(low ? { low: 1 } : {}) })}`); };
      root.querySelectorAll('[data-adjust]').forEach(f => f.onsubmit = async (e) => {
        e.preventDefault();
        const delta = Math.round(Number(f.d.value));
        if (!delta) { toast('Enter a change, e.g. 12 or -2.', 'bad'); return; }
        try {
          const after = await db.rpc('adjust_inventory', { p_variant_id: f.dataset.adjust, p_delta: delta, p_reason: f.r.value, p_note: null, p_reference: 'admin' });
          toast(`Saved: ${after} on hand.`); ctx.go(location.pathname + location.search);
        } catch (err) { toast(errorText(err), 'bad'); }
      });
    },
  };
}
