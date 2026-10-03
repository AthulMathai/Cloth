// Small UI kit for the admin control center: formatting, tables, forms,
// toasts and confirm dialogs. Every number shown comes from the database.
import { esc } from '../components/ui.js';
export { esc };

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export const money = (c) => cad.format((c || 0) / 100);
export const num = (n) => new Intl.NumberFormat('en-CA').format(n || 0);
export const date = (d) => d ? new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const dateTime = (d) => d ? new Date(d).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const TONE = {
  paid: 'info', moderation_pending: 'warn', approved: 'info', fulfillment_pending: 'info', on_hold: 'bad', assigned: 'info',
  production_queued: 'info', printing: 'info', quality_check: 'info', packed: 'info', shipped: 'good', in_transit: 'good',
  out_for_delivery: 'good', delivered: 'good', cancelled: 'mute', refunded: 'mute', failed: 'bad', backordered: 'warn',
  returned: 'mute', payment_pending: 'mute', created: 'mute',
  active: 'good', draft: 'mute', scheduled: 'info', out_of_stock: 'warn', sold_out: 'warn', discontinued: 'mute', archived: 'mute',
  pending: 'warn', needs_review: 'warn', rejected: 'bad', new: 'warn', reviewing: 'info', quoted: 'info', accepted: 'good',
  declined: 'mute', expired: 'mute', converted: 'good',
};
export const pill = (s, text) => `<span class="cc-pill cc-pill--${TONE[s] || 'mute'}">${esc(text || label(s))}</span>`;

/** columns: [{ key, label, render?(row), align? }] */
export function table(rows, columns, { empty = 'Nothing here yet.', rowHref } = {}) {
  if (!rows?.length) return `<p class="cc-empty">${esc(empty)}</p>`;
  return `<div class="cc-table-wrap"><table class="cc-table">
    <thead><tr>${columns.map(c => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr${rowHref ? ` data-href="${esc(rowHref(r))}" tabindex="0"` : ''}>${columns.map(c =>
      `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}
export function bindRowLinks(root, go) {
  root.querySelectorAll('tr[data-href]').forEach(tr => {
    const open = () => go(tr.dataset.href);
    tr.addEventListener('click', (e) => { if (!e.target.closest('a, button, input, select')) open(); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

/**
 * Form from a field list. Field: { name, label, type: text|textarea|number|money|select|checkbox|date|datetime|tags|json|color,
 *   options: [[value, label]], required, help, min, max, step, full }
 */
export function form(fields, values = {}, { submit = 'Save', id = 'cc-form', extra = '' } = {}) {
  return `<form class="cc-form" data-form="${id}" novalidate>
    <div class="cc-fields">${fields.map(f => field(f, values[f.name])).join('')}</div>
    <div class="cc-form-actions"><button class="cc-btn cc-btn--primary" type="submit">${esc(submit)}</button>${extra}
      <span class="cc-form-msg" role="status" data-msg></span></div>
  </form>`;
}
function field(f, v) {
  const id = `f-${f.name}`, req = f.required ? ' required' : '';
  const wrap = (inner, cls = '') => `<label class="cc-field${f.full ? ' is-full' : ''}${cls}" for="${id}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${inner}${f.help ? `<small>${esc(f.help)}</small>` : ''}</label>`;
  switch (f.type) {
    case 'textarea': return wrap(`<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}"${req}>${esc(v ?? '')}</textarea>`);
    case 'select': return wrap(`<select id="${id}" name="${f.name}"${req}>${(f.options || []).map(([ov, ol]) =>
      `<option value="${esc(ov ?? '')}"${String(v ?? '') === String(ov ?? '') ? ' selected' : ''}>${esc(ol)}</option>`).join('')}</select>`);
    case 'checkbox': return `<label class="cc-check${f.full ? ' is-full' : ''}"><input type="checkbox" name="${f.name}"${v ? ' checked' : ''}> <span>${esc(f.label)}</span>${f.help ? `<small>${esc(f.help)}</small>` : ''}</label>`;
    case 'money': return wrap(`<input id="${id}" name="${f.name}" inputmode="decimal" value="${v == null || v === '' ? '' : (v / 100).toFixed(2)}" placeholder="0.00"${req}>`);
    case 'number': return wrap(`<input id="${id}" name="${f.name}" type="number" value="${esc(v ?? '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} step="${f.step || 'any'}"${req}>`);
    case 'date': return wrap(`<input id="${id}" name="${f.name}" type="date" value="${v ? String(v).slice(0, 10) : ''}"${req}>`);
    case 'datetime': return wrap(`<input id="${id}" name="${f.name}" type="datetime-local" value="${v ? toLocalInput(v) : ''}"${req}>`);
    case 'tags': return wrap(`<input id="${id}" name="${f.name}" value="${esc((v || []).join(', '))}" placeholder="comma, separated"${req}>`);
    case 'json': return wrap(`<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" class="cc-mono">${esc(v == null ? '' : JSON.stringify(v, null, 2))}</textarea>`);
    case 'color': return wrap(`<span class="cc-color"><input type="color" value="${esc(v || '#141414')}" data-mirror="${id}"><input id="${id}" name="${f.name}" value="${esc(v || '')}" placeholder="#141414"></span>`);
    default: return wrap(`<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${req}>`);
  }
}
function toLocalInput(v) {
  const d = new Date(v), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Reads a form built by form() back into typed values. Throws on bad input. */
export function readForm(formEl, fields) {
  const out = {};
  for (const f of fields) {
    const el = formEl.elements[f.name];
    if (!el) continue;
    let v = f.type === 'checkbox' ? el.checked : el.value.trim();
    if (f.type !== 'checkbox' && v === '') {
      if (f.required) throw new Error(`${f.label} is required.`);
      out[f.name] = f.type === 'tags' ? [] : null;
      continue;
    }
    if (f.type === 'money') { const n = Number(String(v).replace(/[$,\s]/g, '')); if (!Number.isFinite(n) || n < 0) throw new Error(`${f.label}: enter an amount like 49.00.`); v = Math.round(n * 100); }
    else if (f.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number.`); v = n; }
    else if (f.type === 'tags') v = v.split(',').map(s => s.trim()).filter(Boolean);
    else if (f.type === 'datetime') v = new Date(v).toISOString();
    else if (f.type === 'json') { try { v = JSON.parse(v); } catch { throw new Error(`${f.label} isn't valid JSON.`); } }
    else if (f.type === 'select' && f.numeric) v = Number(v);
    out[f.name] = v;
  }
  return out;
}
export function bindColorMirrors(root) {
  root.querySelectorAll('[data-mirror]').forEach(c => {
    const t = root.querySelector('#' + c.dataset.mirror);
    c.addEventListener('input', () => { t.value = c.value; });
    t.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(t.value)) c.value = t.value; });
  });
}

export function toast(msg, tone = 'good') {
  let host = document.querySelector('.cc-toasts');
  if (!host) { host = document.createElement('div'); host.className = 'cc-toasts'; host.setAttribute('aria-live', 'polite'); document.body.append(host); }
  const t = document.createElement('div');
  t.className = `cc-toast cc-toast--${tone}`; t.textContent = msg;
  host.append(t);
  setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, tone === 'bad' ? 6000 : 3200);
}

/** Modal with an optional note/amount input. Resolves to { ok, note, amount, checked } */
export function confirmDialog({ title, body = '', confirm = 'Confirm', tone = 'primary', note = false, noteLabel = 'Note', noteRequired = false,
                                amount = null, checkbox = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'cc-dialog';
    d.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>${body ? `<div class="cc-dialog-body">${body}</div>` : ''}
      ${amount ? `<label class="cc-field"><span>${esc(amount.label)}</span><input name="amount" inputmode="decimal" value="${(amount.value / 100).toFixed(2)}"></label>` : ''}
      ${note ? `<label class="cc-field"><span>${esc(noteLabel)}${noteRequired ? ' *' : ''}</span><textarea name="note" rows="3"></textarea></label>` : ''}
      ${checkbox ? `<label class="cc-check"><input type="checkbox" name="cb"${checkbox.checked ? ' checked' : ''}> <span>${esc(checkbox.label)}</span></label>` : ''}
      <p class="cc-form-msg" data-msg></p>
      <div class="cc-form-actions"><button class="cc-btn" value="cancel" type="button" data-cancel>Cancel</button>
        <button class="cc-btn cc-btn--${tone}" value="ok">${esc(confirm)}</button></div></form>`;
    document.body.append(d);
    const f = d.querySelector('form');
    const done = (r) => { d.close(); d.remove(); resolve(r); };
    d.querySelector('[data-cancel]').onclick = () => done({ ok: false });
    d.addEventListener('cancel', () => done({ ok: false }));
    f.onsubmit = (e) => {
      e.preventDefault();
      const n = f.note?.value.trim() || '';
      if (noteRequired && n.length < 3) { d.querySelector('[data-msg]').textContent = 'Add a short note.'; return; }
      let a = null;
      if (amount) {
        a = Math.round(Number(f.amount.value.replace(/[$,\s]/g, '')) * 100);
        if (!Number.isFinite(a) || a <= 0 || a > amount.max) { d.querySelector('[data-msg]').textContent = `Enter an amount up to ${money(amount.max)}.`; return; }
      }
      done({ ok: true, note: n, amount: a, checked: f.cb?.checked });
    };
    d.showModal();
    (f.note || f.amount || d.querySelector('.cc-btn--' + tone)).focus();
  });
}

export const kpi = (labelText, value, sub = '', href = '') =>
  `<${href ? `a href="${esc(href)}"` : 'div'} class="cc-kpi"><span class="cc-kpi-label">${esc(labelText)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</${href ? 'a' : 'div'}>`;

export function errorText(e) {
  const m = e?.message || String(e);
  if (/JWT expired|401/.test(m)) return 'Your session expired. Sign in again.';
  return m;
}
