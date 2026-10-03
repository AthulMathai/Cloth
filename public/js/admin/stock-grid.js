// Partner blank stock: a colour × size grid per garment, and the count /
// receive dialog. Changes go through partner_adjust_inventory (logged).
import { db } from '../lib/supabase.js';
import { esc, label, toast, errorText } from './ui.js';

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

export function stockGridHTML(rows, { editable = true } = {}) {
  if (!rows?.length) return '<p class="cc-empty">No blanks recorded yet. Use “Count / receive stock” to add them.</p>';
  const types = [...new Set(rows.map(r => r.product_type))].sort();
  return types.map(t => {
    const own = rows.filter(r => r.product_type === t);
    const sizes = SIZES.filter(s => own.some(r => r.size === s)).concat([...new Set(own.map(r => r.size))].filter(s => !SIZES.includes(s)));
    const colors = [...new Set(own.map(r => r.color))].sort();
    return `<section class="stock-block"><h3>${esc(label(t))}</h3><div class="cc-table-wrap"><table class="cc-table stock-grid">
      <thead><tr><th>Colour</th>${sizes.map(s => `<th style="text-align:center">${esc(s)}</th>`).join('')}</tr></thead>
      <tbody>${colors.map(c => `<tr><th scope="row">${esc(c)}</th>${sizes.map(s => {
        const r = own.find(x => x.color === c && x.size === s);
        if (!r) return '<td class="stock-cell is-none">—</td>';
        const free = r.on_hand - r.reserved;
        const tone = free <= 0 ? 'is-out' : free <= r.low_threshold ? 'is-low' : '';
        return `<td class="stock-cell ${tone}">${editable ? `<button type="button" data-stock="${esc(JSON.stringify({ t, c, s, on: r.on_hand, res: r.reserved }))}"` : '<span'}
          title="${r.on_hand} on hand, ${r.reserved} reserved for open orders"><strong>${free}</strong>${r.reserved ? `<small>+${r.reserved}</small>` : ''}${editable ? '</button>' : '</span>'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  }).join('') + '<p class="cc-small cc-muted">Big number = free to assign. “+n” = reserved for open production orders. Amber = low, red = out.</p>';
}

/** prefill: { t, c, s, on } — returns true when something changed */
export function stockDialog(partnerId, prefill = {}, types = ['tee', 'hoodie', 'crewneck', 'longsleeve', 'tank']) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'cc-dialog';
    d.innerHTML = `<form method="dialog"><h2>Count / receive stock</h2>
      <div class="cc-fields">
        <label class="cc-field"><span>Garment</span><select name="t">${types.map(t => `<option value="${t}"${prefill.t === t ? ' selected' : ''}>${esc(label(t))}</option>`).join('')}</select></label>
        <label class="cc-field"><span>Colour</span><input name="c" value="${esc(prefill.c || '')}" placeholder="Black" required></label>
        <label class="cc-field"><span>Size</span><select name="s">${SIZES.map(s => `<option${prefill.s === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="cc-field"><span>What happened</span><select name="mode">
          <option value="count">Counted — set on hand to</option><option value="receipt">Received — add</option><option value="damage">Damaged / lost — remove</option></select></label>
        <label class="cc-field"><span>Quantity</span><input name="q" type="number" min="0" step="1" inputmode="numeric" value="${prefill.on ?? ''}" required></label>
        <label class="cc-field"><span>Note (optional)</span><input name="note"></label>
      </div>
      ${prefill.res ? `<p class="cc-small cc-muted">${prefill.res} are reserved for open orders — on hand can’t go below that.</p>` : ''}
      <p class="cc-form-msg" data-msg></p>
      <div class="cc-form-actions"><button class="cc-btn" type="button" data-cancel>Cancel</button><button class="cc-btn cc-btn--primary">Save</button></div></form>`;
    document.body.append(d);
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done(false);
    d.addEventListener('cancel', () => done(false));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const q = Math.round(Number(f.q.value));
      if (!Number.isFinite(q) || q < 0) { d.querySelector('[data-msg]').textContent = 'Enter a quantity.'; return; }
      const mode = f.mode.value;
      try {
        await db.rpc('partner_adjust_inventory', { p_partner_id: partnerId, p_product_type: f.t.value, p_color: f.c.value.trim(), p_size: f.s.value,
          p_mode: mode === 'count' ? 'set' : 'add', p_qty: mode === 'damage' ? -q : q,
          p_reason: mode === 'count' ? 'count' : mode, p_note: f.note.value.trim() || null });
        toast('Stock saved.'); done(true);
      } catch (err) { d.querySelector('[data-msg]').textContent = errorText(err); }
    };
    d.showModal(); f.q.focus();
  });
}

export function bindStockGrid(root, partnerId, types, after) {
  root.querySelectorAll('[data-stock]').forEach(b => b.addEventListener('click', async () => {
    if (await stockDialog(partnerId, JSON.parse(b.dataset.stock), types)) after();
  }));
  root.querySelector('[data-stock-add]')?.addEventListener('click', async () => { if (await stockDialog(partnerId, {}, types)) after(); });
}
