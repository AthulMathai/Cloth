// Custom pricing: rules (database-driven, versioned, audited) and a
// calculator that runs the exact engine the designer and checkout use.
import { db } from '../lib/supabase.js';
import { esc, money, pill, table, label, dateTime, form, readForm, toast, bindRowLinks, errorText } from './ui.js';

const TYPES = ['base', 'size', 'placement', 'print_area', 'method', 'artwork', 'quantity', 'quote'];
const HELP = {
  base: 'Overrides the garment price for a product or product type.', size: 'Extra charge for a size (e.g. XXL +$3).',
  placement: 'Per print location (front, back, sleeve…).', print_area: 'By print size tier (small → full).',
  method: 'Per printing method (DTG, DTF, embroidery…); can include a setup fee and minimum quantity.',
  artwork: 'Artwork services (background removal, vectorizing…).', quantity: 'Volume discount per item for a quantity range.',
  quote: 'At or above this quantity, customers request a quote instead of checking out.',
};

export async function view(ctx) {
  if (ctx.segs[1]) return edit(ctx, ctx.segs[1]);
  const type = ctx.query.get('type') || '';
  const [rules, products, placements, methods] = await Promise.all([
    db.from('pricing_rules').select('*').order('rule_type').order('priority', { ascending: false }),
    db.from('products').select('id,name,product_type').eq('is_customizable', true).order('name'),
    db.from('print_placements').select('*').eq('is_active', true).order('sort_order'),
    db.from('print_methods').select('*').eq('is_active', true).order('sort_order'),
  ]);
  const shown = type ? rules.filter(r => r.rule_type === type) : rules;
  const now = Date.now(), live = (r) => r.is_active && new Date(r.effective_from) <= now && (!r.effective_to || new Date(r.effective_to) > now);
  const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  return {
    title: 'Custom pricing',
    html: `<header class="ad-head"><div><h1>Custom pricing</h1><p class="ad-muted">${rules.filter(live).length} live rules · placeholder amounts until the print partner's real costs are in</p></div>
        <a class="ad-btn ad-btn--primary" href="/admin/pricing/new">New rule</a></header>
      <section class="ad-card"><h2>Price calculator</h2>
        <p class="ad-muted ad-small">Runs the same pricing engine as the custom designer and checkout, with costs and margin.</p>
        <form class="ad-calc" data-calc>
          <label class="ad-field"><span>Product</span><select name="product">${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
          <label class="ad-field"><span>Size</span><select name="size">${sizes.map(s => `<option${s === 'M' ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="ad-field"><span>Quantity</span><input name="qty" type="number" min="1" value="1"></label>
          ${placements.map(p => `<fieldset class="ad-calc-place"><legend><label><input type="checkbox" name="on_${p.code}"${p.code === 'front' ? ' checked' : ''}> ${esc(p.label)}</label></legend>
            <label>W <input name="w_${p.code}" type="number" step="0.5" min="0.5" max="${p.max_w_in}" value="${Math.min(10, p.max_w_in)}"> in</label>
            <label>H <input name="h_${p.code}" type="number" step="0.5" min="0.5" max="${p.max_h_in}" value="${Math.min(10, p.max_h_in)}"> in</label>
            <select name="m_${p.code}" aria-label="${esc(p.label)} method">${methods.map(m => `<option value="${m.code}">${esc(m.label)}</option>`).join('')}</select></fieldset>`).join('')}
          <div class="ad-form-actions"><button class="ad-btn ad-btn--primary">Calculate</button></div>
        </form>
        <div data-calc-out></div></section>
      <nav class="ad-tabs"><a href="/admin/pricing"${!type ? ' aria-current="true"' : ''}>All</a>${TYPES.map(t => `<a href="/admin/pricing?type=${t}"${t === type ? ' aria-current="true"' : ''}>${label(t)}</a>`).join('')}</nav>
      ${type ? `<p class="ad-note">${esc(HELP[type])}</p>` : ''}
      <section class="ad-card ad-card--flush">${table(shown, [
        { label: 'Rule', render: r => `<strong>${esc(r.label || label(r.rule_type))}</strong><br><span class="ad-muted ad-small">${esc(label(r.rule_type))} · v${r.version}</span>` },
        { label: 'Applies to', render: r => esc([r.product_id && (products.find(p => p.id === r.product_id)?.name || 'a product'), r.product_type, r.size, r.placement, r.method, r.area_tier, r.service,
            r.min_qty || r.max_qty ? `qty ${r.min_qty || 1}–${r.max_qty || '∞'}` : null].filter(Boolean).join(' · ') || 'Everything') },
        { label: 'Customer', align: 'right', render: r => r.percent != null ? `${+r.percent}%` : r.customer_cents != null ? money(r.customer_cents) : '—' },
        { label: 'Cost', align: 'right', render: r => r.cost_cents != null ? money(r.cost_cents) : '—' },
        { label: 'Setup', align: 'right', render: r => r.setup_cents ? money(r.setup_cents) : '—' },
        { key: 'priority', label: 'Priority', align: 'right' },
        { label: 'Status', render: r => live(r) ? pill('active', 'Live') : !r.is_active ? pill('draft', 'Off') : pill('scheduled', 'Not in effect') },
        { label: 'Updated', render: r => dateTime(r.updated_at) }], { empty: 'No rules of this type.', rowHref: r => `/admin/pricing/${r.id}` })}</section>`,
    mount(root) {
      bindRowLinks(root, ctx.go);
      const f = root.querySelector('[data-calc]'), out = root.querySelector('[data-calc-out]');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const print = placements.filter(p => f[`on_${p.code}`].checked).map(p => ({ placement: p.code, method: f[`m_${p.code}`].value,
          width_in: Number(f[`w_${p.code}`].value), height_in: Number(f[`h_${p.code}`].value) }));
        if (!print.length) { out.innerHTML = '<p class="ad-empty">Tick at least one print area.</p>'; return; }
        try {
          const q = await db.rpc('price_custom_admin', { p_product_id: f.product.value, p_size: f.size.value, p_print: print, p_services: [], p_qty: Math.max(1, Number(f.qty.value) || 1) });
          if (q.error) { out.innerHTML = `<p class="ad-alert ad-alert--bad">${esc(q.error)}</p>`; return; }
          out.innerHTML = `<div class="ad-two"><dl class="ad-totals">
              <dt>Garment (${esc(q.size)})</dt><dd>${money(q.base_cents)}</dd>${q.size_cents ? `<dt>Size</dt><dd>+${money(q.size_cents)}</dd>` : ''}
              ${q.print.map(x => `<dt>${esc(x.placement_label)} · ${esc((x.area_label || '').split(' (')[0])} · ${esc(x.method_label)}</dt><dd>+${money(x.unit_cents)}</dd>`).join('')}
              ${q.volume_discount_cents ? `<dt>Volume discount</dt><dd>−${money(q.volume_discount_cents)}</dd>` : ''}
              <dt class="is-total">Per item</dt><dd class="is-total">${money(q.unit_cents)}</dd>
              ${q.setup_cents ? `<dt>Setup (one-time)</dt><dd>${money(q.setup_cents)}</dd>` : ''}
              <dt class="is-total">Total × ${q.quantity}</dt><dd class="is-total">${money(q.total_cents)}</dd></dl>
            <dl class="ad-totals"><dt>Garment cost</dt><dd>${money(q.cost.garment_cents)}</dd><dt>Print cost</dt><dd>${money(q.cost.print_cents)}</dd>
              <dt>Cost per item</dt><dd>${money(q.cost.unit_cents)}</dd><dt class="is-total">Total cost</dt><dd class="is-total">${money(q.cost.total_cents)}</dd>
              <dt class="is-total">Est. margin</dt><dd class="is-total">${money(q.margin_cents)} (${q.margin_pct ?? '—'}%)</dd></dl></div>
            ${q.quote_required ? `<p class="ad-alert ad-alert--warn">At ${q.quantity}+ customers request a quote instead of checking out.</p>` : ''}
            ${q.next_tier ? `<p class="ad-muted">Next tier: ${q.next_tier.add_qty} more for ${money(q.next_tier.per_unit_discount_cents)} off each.</p>` : ''}
            <details class="ad-small"><summary>Rules used (${(q.rules || []).length})</summary><pre class="ad-mono">${esc(JSON.stringify(q.rules, null, 2))}</pre></details>`;
        } catch (err) { out.innerHTML = `<p class="ad-alert ad-alert--bad">${esc(errorText(err))}</p>`; }
      };
      f.requestSubmit();
    },
  };
}

async function edit(ctx, id) {
  const isNew = id === 'new', copyOf = ctx.query.get('copy');
  const [products, placements, methods, tiers, services, src] = await Promise.all([
    db.from('products').select('id,name').eq('is_customizable', true).order('name'),
    db.from('print_placements').select('code,label').order('sort_order'), db.from('print_methods').select('code,label').order('sort_order'),
    db.from('print_area_tiers').select('code,label').catch(() => []), db.from('artwork_services').select('code,label').order('sort_order'),
    isNew ? (copyOf ? db.from('pricing_rules').select('*').eq('id', copyOf).single().catch(() => null) : null)
          : db.from('pricing_rules').select('*').eq('id', id).single().catch(() => null),
  ]);
  if (!isNew && !src) return { title: 'Not found', html: '<p class="ad-empty">Rule not found.</p>' };
  const opt = (rows) => [['', 'Any'], ...rows.map(r => [r.code ?? r.id, r.label ?? r.name])];
  const fields = [
    { name: 'rule_type', label: 'Rule type', type: 'select', required: true, options: TYPES.map(t => [t, label(t)]) },
    { name: 'label', label: 'Label', help: 'Shown to staff (and on quotes).' },
    { name: 'product_id', label: 'Product', type: 'select', options: opt(products) },
    { name: 'product_type', label: 'Product type', type: 'select', options: [['', 'Any'], ...['tee', 'hoodie', 'crewneck', 'longsleeve', 'tank'].map(t => [t, label(t)])] },
    { name: 'size', label: 'Size', type: 'select', options: [['', 'Any'], ...['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].map(s => [s, s])] },
    { name: 'placement', label: 'Placement', type: 'select', options: opt(placements) },
    { name: 'method', label: 'Print method', type: 'select', options: opt(methods) },
    { name: 'area_tier', label: 'Print area tier', type: 'select', options: opt(tiers) },
    { name: 'service', label: 'Artwork service', type: 'select', options: opt(services) },
    { name: 'min_qty', label: 'Min quantity', type: 'number', step: 1, min: 1 }, { name: 'max_qty', label: 'Max quantity', type: 'number', step: 1, min: 1 },
    { name: 'customer_cents', label: 'Customer price / discount per item', type: 'money', help: 'For quantity rules this is the discount per item.' },
    { name: 'percent', label: 'Or percent', type: 'number', min: 0, max: 100, help: 'Quantity rules: % off instead of a fixed amount.' },
    { name: 'cost_cents', label: 'Production cost (staff only)', type: 'money' },
    { name: 'setup_cents', label: 'Setup fee (one-time)', type: 'money' },
    { name: 'charge_per', label: 'Charged', type: 'select', options: [['unit', 'Per item'], ['order', 'Once per order']] },
    { name: 'priority', label: 'Priority', type: 'number', step: 1, help: 'Higher wins; then the most specific rule; then the newest.' },
    { name: 'effective_from', label: 'Effective from', type: 'datetime' }, { name: 'effective_to', label: 'Effective until', type: 'datetime' },
    { name: 'is_active', label: 'Active', type: 'checkbox' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
  ];
  const values = src ? { ...src, ...(isNew ? { label: `${src.label || label(src.rule_type)} (copy)`, is_active: false } : {}) }
                     : { rule_type: ctx.query.get('type') || 'placement', charge_per: 'unit', priority: 0, is_active: true };
  return {
    title: isNew ? 'New pricing rule' : (src.label || 'Pricing rule'),
    html: `<p class="ad-crumbs"><a href="/admin/pricing">Custom pricing</a> / ${isNew ? 'New rule' : esc(src.label || label(src.rule_type))}</p>
      <header class="ad-head"><div><h1>${isNew ? 'New pricing rule' : esc(src.label || label(src.rule_type))}</h1>
        ${isNew ? '' : `<p class="ad-muted">Version ${src.version} · updated ${dateTime(src.updated_at)}</p>`}</div>
        ${isNew ? '' : `<div class="ad-actions"><a class="ad-btn" href="/admin/pricing/new?copy=${src.id}">Duplicate</a>${ctx.can('audit.read') ? `<a class="ad-btn" href="/admin/audit?type=pricing_rules&id=${src.id}">History</a>` : ''}</div>`}</header>
      <p class="ad-note">Changing a rule never changes existing orders — each order keeps the price breakdown it was sold at. Every edit bumps the version and is written to the audit log.</p>
      <section class="ad-card">${form(fields, values, { submit: isNew ? 'Create rule' : 'Save rule' })}</section>`,
    mount(root) {
      const f = root.querySelector('[data-form]');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const msg = f.querySelector('[data-msg]');
        try {
          const v = readForm(f, fields);
          for (const k of ['product_id', 'product_type', 'size', 'placement', 'method', 'area_tier', 'service']) v[k] ||= null;
          v.effective_from ||= new Date().toISOString();
          msg.textContent = 'Saving…';
          const saved = isNew ? (await db.insert('pricing_rules', v))[0] : (await db.update('pricing_rules', { id: src.id }, v))[0];
          toast('Rule saved.'); ctx.go(`/admin/pricing/${saved.id}`);
        } catch (err) { msg.textContent = errorText(err); }
      };
    },
  };
}
