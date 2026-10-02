// A single sakura petal: rounded body narrowing to the stem, with the
// characteristic notch at the tip. `flip` (-1..1) squashes the width to
// fake a 3D tumble. Petals are pre-rendered into small sprites (a few
// hues x front/back) so a storm of ~1000 petals stays cheap to draw.
const SPRITE = 64;
const cache = new Map();

function sprite(hue, back) {
  const key = `${hue}:${back}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const ctx = c.getContext('2d');
  const s = SPRITE / 2 - 2;
  ctx.translate(SPRITE / 2, SPRITE / 2);
  const g = ctx.createLinearGradient(0, -s, 0, s);
  g.addColorStop(0, `hsl(${hue} 100% ${back ? 88 : 94}%)`);
  g.addColorStop(1, `hsl(${hue} 85% ${back ? 60 : 70}%)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, s);
  ctx.bezierCurveTo(s * 0.9, s * 0.5, s * 0.75, -s * 0.8, s * 0.18, -s);
  ctx.lineTo(0, -s * 0.72);
  ctx.lineTo(-s * 0.18, -s);
  ctx.bezierCurveTo(-s * 0.75, -s * 0.8, -s * 0.9, s * 0.5, 0, s);
  ctx.fill();
  // faint centre vein
  ctx.strokeStyle = `hsla(${hue} 70% 55% / .35)`; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, s * 0.9); ctx.lineTo(0, -s * 0.5); ctx.stroke();
  cache.set(key, c);
  return c;
}

export function drawPetal(ctx, x, y, size, rot, flip, hue = 340, alpha = 0.9) {
  const h = Math.round(hue / 6) * 6;                 // quantise hues -> few sprites
  const img = sprite(h, flip < 0);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(Math.max(0.15, Math.abs(flip)), 1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, -size, -size, size * 2, size * 2);
  ctx.restore();
}
