// Small chart kit for the admin: a time-series chart (line or columns) with
// a crosshair tooltip, horizontal bar lists, and a funnel. One axis only,
// thin marks, recessive grid, values in text ink; every chart has a table
// view. Colors are the validated categorical slots (admin is light-only):
// series 1 blue, series 2 orange, series 3 aqua (aqua < 3:1 → always labelled).
import { esc } from './ui.js';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const NS = 'http://www.w3.org/2000/svg';

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/**
 * Time series. opts: { rows, x: row => label, series: [{ key, label, value: row => n, color?, dashed? }],
 *   kind: 'line' | 'column', yFormat: n => string, xFormat: label => string, height }
 * Mounted into `host` (re-renders on resize). Returns cleanup.
 */
export function timeSeries(host, opts) {
  const { rows, series, kind = 'line', yFormat = String, xFormat = String, height = 240 } = opts;
  host.classList.add('ch');
  host.innerHTML = '';
  if (!rows.length) { host.innerHTML = '<p class="cc-empty">No data in this range.</p>'; return () => {}; }
  const tip = document.createElement('div');
  tip.className = 'ch-tip'; tip.hidden = true; tip.setAttribute('role', 'status');
  const legend = series.length > 1 ? (() => {
    const l = document.createElement('div'); l.className = 'ch-legend';
    series.forEach((s, i) => {
      const it = document.createElement('span'); it.className = 'ch-key';
      const sw = document.createElement('i'); sw.className = kind === 'column' && i === 0 ? 'is-box' : (s.dashed ? 'is-dash' : 'is-line');
      sw.style.setProperty('--c', s.color || SERIES[i]);
      it.append(sw, document.createTextNode(s.label)); l.append(it);
    });
    return l;
  })() : null;

  const draw = () => {
    host.querySelector('svg')?.remove();
    const W = Math.max(280, host.clientWidth), H = height;
    const pad = { l: 56, r: 12, t: 12, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = niceMax(Math.max(...rows.flatMap(r => series.map(s => s.value(r) || 0))) / 4) * 4;   // 4 round-number gridlines
    const n = rows.length;
    const xAt = (i) => kind === 'column' ? pad.l + (i + 0.5) * (iw / n) : pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const yAt = (v) => pad.t + ih - (v / max) * ih;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${series.map(s => s.label).join(', ')} over time`);
    let g = '';
    for (let t = 0; t <= 4; t++) {
      const v = (max / 4) * t, y = yAt(v);
      g += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
      g += `<text class="ch-ylab" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${esc(yFormat(v))}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / Math.floor(iw / 74)));
    rows.forEach((r, i) => {
      if (i % step === 0 || i === n - 1 && (n - 1) % step > step / 2) {
        g += `<text class="ch-xlab" x="${xAt(i)}" y="${H - 8}" text-anchor="middle">${esc(xFormat(opts.x(r)))}</text>`;
      }
    });
    if (kind === 'column') {
      const bw = Math.max(2, Math.min(28, (iw / n) - 4));
      rows.forEach((r, i) => {
        const v = series[0].value(r) || 0, y = yAt(v), h = pad.t + ih - y;
        if (h > 0) g += `<path class="ch-col" data-i="${i}" fill="${series[0].color || SERIES[0]}" d="${roundedTop(xAt(i) - bw / 2, y, bw, h, Math.min(4, bw / 2))}"/>`;
      });
      series.slice(1).forEach((s, si) => {
        g += `<path class="ch-line${s.dashed ? ' is-dash' : ''}" stroke="${s.color || SERIES[si + 1]}" d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(s.value(r) || 0)}`).join('')}"/>`;
      });
    } else {
      const s0 = series[0];
      g += `<path class="ch-area" fill="${s0.color || SERIES[0]}" d="M${xAt(0)},${yAt(0)}${rows.map((r, i) => `L${xAt(i)},${yAt(s0.value(r) || 0)}`).join('')}L${xAt(n - 1)},${yAt(0)}Z"/>`;
      series.forEach((s, si) => {
        g += `<path class="ch-line${s.dashed ? ' is-dash' : ''}" stroke="${s.color || SERIES[si]}" d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(s.value(r) || 0)}`).join('')}"/>`;
      });
    }
    g += `<line class="ch-base" x1="${pad.l}" x2="${W - pad.r}" y1="${yAt(0)}" y2="${yAt(0)}"/>`;
    g += `<line class="ch-cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
    g += series.map((s, si) => `<circle class="ch-dot" r="4" fill="${s.color || SERIES[si]}" visibility="hidden" data-s="${si}"/>`).join('');
    g += `<rect class="ch-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" tabindex="0" aria-label="Chart: use arrow keys to read values"/>`;
    svg.innerHTML = g;
    if (legend) legend.after(svg); else host.prepend(svg);

    const cross = svg.querySelector('.ch-cross'), hit = svg.querySelector('.ch-hit'), dots = [...svg.querySelectorAll('.ch-dot')];
    let cur = -1;
    const show = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      const r = rows[cur], x = xAt(cur);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      dots.forEach((d, si) => {
        if (kind === 'column' && si === 0) { d.setAttribute('visibility', 'hidden'); return; }
        d.setAttribute('cx', x); d.setAttribute('cy', yAt(series[si].value(r) || 0)); d.setAttribute('visibility', 'visible');
      });
      svg.querySelectorAll('.ch-col').forEach(c => c.classList.toggle('is-hot', Number(c.dataset.i) === cur));
      tip.replaceChildren();
      const h = document.createElement('div'); h.className = 'ch-tip-h'; h.textContent = xFormat(opts.x(r), true); tip.append(h);
      series.forEach((s, si) => {
        const row = document.createElement('div'); row.className = 'ch-tip-r';
        const k = document.createElement('i'); k.style.setProperty('--c', s.color || SERIES[si]); if (s.dashed) k.className = 'is-dash';
        const v = document.createElement('strong'); v.textContent = (s.format || yFormat)(s.value(r) || 0);
        const l = document.createElement('span'); l.textContent = s.label;
        row.append(k, v, l); tip.append(row);
      });
      tip.hidden = false;
      const tw = tip.offsetWidth || 160;
      tip.style.left = `${Math.min(W - tw - 4, Math.max(4, x + 12 > W - tw ? x - tw - 12 : x + 12))}px`;
      tip.style.top = `${pad.t}px`;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); tip.hidden = true;
      svg.querySelectorAll('.ch-col.is-hot').forEach(c => c.classList.remove('is-hot')); };
    hit.addEventListener('pointermove', (e) => {
      const bx = svg.getBoundingClientRect(), px = (e.clientX - bx.left) * (W / bx.width);
      const i = kind === 'column' ? Math.floor((px - pad.l) / (iw / n)) : Math.round(((px - pad.l) / iw) * (n - 1));
      show(i);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(cur < 0 ? n - 1 : cur));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); }
      if (e.key === 'Escape') hide();
    });
  };
  if (legend) host.append(legend);
  host.append(tip);
  draw();
  let last = host.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - last) > 8) { last = host.clientWidth; draw(); } });
  ro.observe(host);
  return () => ro.disconnect();
}

function roundedTop(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Horizontal bars with direct labels. rows: [{ label, value, sub?, href? }] */
export function barList(rows, { format = String, empty = 'No data in this range.', color = SERIES[0], max } = {}) {
  if (!rows.length) return `<p class="cc-empty">${esc(empty)}</p>`;
  const m = max ?? Math.max(...rows.map(r => r.value), 1);
  return `<ul class="ch-bars">${rows.map(r => `<li>
      <span class="ch-bars-label">${r.href ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : esc(r.label)}${r.sub ? ` <span class="cc-muted cc-small">${esc(r.sub)}</span>` : ''}</span>
      <span class="ch-bars-track"><span class="ch-bars-fill" style="width:${Math.max(r.value > 0 ? 1.5 : 0, (r.value / m) * 100)}%;--c:${color}"></span></span>
      <strong class="ch-bars-value">${esc(format(r.value))}</strong></li>`).join('')}</ul>`;
}

/** Funnel: ordered steps, each bar relative to the first; step-to-step rate shown. */
export function funnel(steps, { format = String } = {}) {
  if (!steps.length || !steps[0].value) return '<p class="cc-empty">No visits in this range.</p>';
  const top = steps[0].value;
  return `<ol class="ch-funnel">${steps.map((s, i) => {
    const prev = i ? steps[i - 1].value : null;
    const rate = prev ? Math.round((s.value / prev) * 1000) / 10 : null;
    return `<li><div class="ch-funnel-head"><span>${esc(s.label)}</span><strong>${esc(format(s.value))}</strong>
        <span class="cc-muted cc-small">${i ? `${rate ?? 0}% of previous step · ${Math.round((s.value / top) * 1000) / 10}% of all` : '100%'}</span></div>
      <span class="ch-bars-track"><span class="ch-bars-fill" style="width:${Math.max(s.value ? 1 : 0, (s.value / top) * 100)}%;--c:var(--series-1)"></span></span></li>`;
  }).join('')}</ol>`;
}
