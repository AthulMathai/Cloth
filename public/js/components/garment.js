// Garment illustrations drawn from product data (type + colour), used
// wherever no photography exists yet, and as the base for sketch callouts.
// Coordinates live in a 300 x 340 box.

const BODY = {
  tee: 'M100,22 C114,36 186,36 200,22 L262,46 L294,112 L252,130 L240,106 L242,322 L58,322 L60,106 L48,130 L6,112 L38,46 Z',
  longsleeve: 'M100,22 C114,36 186,36 200,22 L258,42 L292,300 L258,308 L238,124 L240,322 L60,322 L62,124 L42,308 L8,300 L42,42 Z',
  crewneck: 'M98,24 C112,40 188,40 202,24 L258,44 L290,292 L292,312 L258,318 L254,302 L238,128 L242,308 L244,326 L56,326 L58,308 L62,128 L46,302 L42,318 L8,312 L10,292 L42,44 Z',
  hoodie: 'M96,40 L60,52 L42,48 L8,300 L10,314 L44,320 L46,306 L62,132 L58,306 L56,326 L244,326 L242,306 L238,132 L254,306 L256,320 L290,314 L292,300 L258,48 L240,52 L204,40',
  tank: 'M104,22 C112,70 188,70 196,22 L222,22 C220,70 236,98 246,110 L242,322 L58,322 L54,110 C64,98 80,70 78,22 Z',
};

const DETAILS = {
  tee: ['M100,22 C114,52 186,52 200,22', 'M60,312 L240,312'],
  longsleeve: ['M100,22 C114,52 186,52 200,22', 'M42,296 L8,290', 'M258,296 L292,290'],
  crewneck: ['M98,24 C112,58 188,58 202,24', 'M106,30 C118,50 182,50 194,30', 'M58,308 L242,308', 'M10,292 L44,300', 'M290,292 L256,300'],
  hoodie: [
    'M96,40 C82,-6 218,-6 204,40 C190,74 110,74 96,40 Z',            // hood
    'M112,44 C126,66 174,66 188,44',                                  // hood opening
    'M136,64 L132,112 M164,64 L168,112',                               // drawstrings
    'M100,232 L200,232 L218,294 L82,294 Z',                            // pocket
    'M58,306 L242,306', 'M10,300 L46,306', 'M290,300 L254,306',
  ],
  tank: ['M58,312 L240,312'],
};

// Back view: same silhouette, back neckline / hood, no pocket or drawstrings.
const DETAILS_BACK = {
  tee: ['M100,22 C114,32 186,32 200,22', 'M60,312 L240,312'],
  longsleeve: ['M100,22 C114,32 186,32 200,22', 'M42,296 L8,290', 'M258,296 L292,290'],
  crewneck: ['M98,24 C112,36 188,36 202,24', 'M58,308 L242,308', 'M10,292 L44,300', 'M290,292 L256,300'],
  hoodie: ['M96,40 C82,-6 218,-6 204,40 C190,58 110,58 96,40 Z', 'M150,0 L150,50', 'M58,306 L242,306', 'M10,300 L46,306', 'M290,300 L254,306'],
  tank: ['M104,22 C112,40 188,40 196,22', 'M58,312 L240,312'],
};

export function garmentPaths(type, view = 'front') {
  const t = BODY[type] ? type : 'tee';
  return { body: BODY[t], details: (view === 'back' ? DETAILS_BACK : DETAILS)[t] };
}

let fid = 0;

/**
 * mode 'sketch': ballpoint lines on paper (artist theme)
 * mode 'flat':   filled garment in the variant colour
 */
export function garmentSVG({ type = 'tee', color = '#141414', mode = 'flat', label = '', view = 'front' } = {}) {
  const { body, details } = garmentPaths(type, view);
  const id = `g${++fid}`;
  const dark = isDark(color);
  if (mode === 'sketch') {
    return `<svg class="garment garment--sketch" viewBox="-10 -12 320 352" role="img" aria-label="${esc(label)}">
      <defs><filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${fid % 9}"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter></defs>
      <g filter="url(#${id})" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        <path d="${body}" fill="${color}" fill-opacity=".1" stroke-width="2.2"/>
        <path d="${body}" stroke-width="1" transform="translate(1.6 1.2)" opacity=".55"/>
        ${details.map(d => `<path d="${d}" stroke-width="1.6"/>`).join('')}
      </g></svg>`;
  }
  return `<svg class="garment garment--flat" viewBox="-10 -12 320 352" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${shade(color, dark ? 0.16 : 0.04)}"/><stop offset="1" stop-color="${shade(color, dark ? -0.02 : -0.1)}"/>
    </linearGradient></defs>
    <path d="${body}" fill="url(#${id})" stroke="${shade(color, dark ? 0.22 : -0.22)}" stroke-width="1.5" stroke-linejoin="round"/>
    <g fill="none" stroke="${shade(color, dark ? 0.26 : -0.26)}" stroke-width="1.4" stroke-linecap="round">${details.map(d => `<path d="${d}"/>`).join('')}</g>
  </svg>`;
}

// ---------------------------------------------------------------------
// Sketch callouts: hand-drawn ovals with marker notes and curved arrows
// pointing at garment features, like annotations in a design notebook.
// callouts: [{text, x, y, side}] with x/y in 0..1 garment space.
// ---------------------------------------------------------------------
export function calloutSVG({ type = 'tee', color = '#141414', callouts = [], label = '', compact = matchMedia('(max-width: 700px)').matches } = {}) {
  // compact (phones): smaller garment, larger handwriting so notes stay legible
  const k = compact ? 1.32 : 1, wrapAt = compact ? 11 : 15;
  const VB_W = 640, VB_H = 420, GS = compact ? 0.86 : 1.0, GX = (VB_W - 300 * GS) / 2, GY = compact ? 46 : 34;
  const { body, details } = garmentPaths(type);
  const id = `c${++fid}`;
  const pts = callouts.slice(0, 6).map((c, i) => ({
    ...c, side: c.side === 'left' ? 'left' : 'right',
    tx: GX + c.x * 300 * GS, ty: GY + c.y * 340 * GS, i,
  }));
  // place bubbles on each side, top-to-bottom, with a minimum gap
  for (const side of ['left', 'right']) {
    const group = pts.filter(p => p.side === side).sort((a, b) => a.ty - b.ty);
    let cursor = 40;
    for (const p of group) {
      p.lines = wrap(p.text, wrapAt);
      const h = 26 + p.lines.length * 22 * k;
      p.by = Math.max(cursor + h / 2, Math.min(p.ty, VB_H - h / 2 - 10));
      cursor = p.by + h / 2 + 14;
      p.rx = Math.max(...p.lines.map(l => l.length)) * 6.6 * k + 24;
      p.ry = h / 2;
      p.bx = side === 'left' ? 12 + p.rx : VB_W - 12 - p.rx;
    }
  }
  const bubbles = pts.map(p => {
    const startX = p.side === 'left' ? p.bx + p.rx * 0.92 : p.bx - p.rx * 0.92;
    const midX = (startX + p.tx) / 2, midY = Math.min(p.by, p.ty) - 24;
    const ang = Math.atan2(p.ty - midY, p.tx - midX);
    const ah = (a) => `${p.tx - 12 * Math.cos(ang + a)},${p.ty - 12 * Math.sin(ang + a)}`;
    return `<g class="callout">
      <path class="callout-oval" d="${handOval(p.bx, p.by, p.rx, p.ry, p.i)}"/>
      <text x="${p.bx}" y="${p.by - (p.lines.length - 1) * 11 * k + 6 * k}" text-anchor="middle" font-size="${17 * k}">${p.lines.map((l, n) => `<tspan x="${p.bx}" dy="${n ? 22 * k : 0}">${esc(l)}</tspan>`).join('')}</text>
      <path class="callout-arrow" d="M${startX},${p.by} Q${midX},${midY} ${p.tx},${p.ty}"/>
      <path class="callout-arrow" d="M${ah(0.45)} L${p.tx},${p.ty} L${ah(-0.45)}"/>
    </g>`;
  }).join('');

  return `<svg class="sketch-callouts" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="${esc(label)}">
    <defs><filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="${fid % 7}"/><feDisplacementMap in="SourceGraphic" scale="3"/></filter></defs>
    <g filter="url(#${id})" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" transform="translate(${GX} ${GY}) scale(${GS})">
      <path d="${body}" fill="${color}" fill-opacity=".09" stroke-width="2.3"/>
      <path d="${body}" stroke-width="1" transform="translate(1.8 1.3)" opacity=".5"/>
      ${details.map(d => `<path d="${d}" stroke-width="1.6"/>`).join('')}
    </g>
    <g filter="url(#${id})">${bubbles}</g>
  </svg>`;
}

// An ellipse drawn the way a pen does it: starts off-centre and overshoots.
function handOval(cx, cy, rx, ry, seed) {
  const steps = 28, start = -0.6 + (seed % 3) * 0.3, sweep = Math.PI * 2 + 0.55;
  let d = '';
  for (let s = 0; s <= steps; s++) {
    const a = start + (sweep * s) / steps;
    const wob = 1 + 0.035 * Math.sin(a * 3 + seed) + (s / steps) * 0.06;
    const x = cx + Math.cos(a) * rx * wob, y = cy + Math.sin(a) * ry * wob;
    d += `${s ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

function wrap(text, max) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export function isDark(hex) {
  const n = parseInt((hex || '#000').slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) < 140;
}

function shade(hex, amt) {
  const n = parseInt((hex || '#777777').slice(1), 16);
  const f = (c) => Math.round(Math.min(255, Math.max(0, amt > 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return `rgb(${f(n >> 16 & 255)}, ${f(n >> 8 & 255)}, ${f(n & 255)})`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
