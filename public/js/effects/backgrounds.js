// Ambient background effects, keyed by theme.background.effect.
// Each starter returns a stop() function. All effects:
//   * draw one still frame when prefers-reduced-motion is set
//   * pause while the tab is hidden
//   * render at reduced resolution and frame rate to stay cheap
import { prefersReducedMotion } from '../lib/theme.js';
import { drawPetal } from './petal.js';

const registry = {
  'tv-static': tvStatic,
  'anime-sky': animeSky,
  'grain': grain,
  'light-rays': lightRays,
  'none': () => () => {},
};

export function startBackground(host, theme) {
  if (!host) return () => {};
  host.replaceChildren();
  host.className = `bg-fx bg-${theme.background.effect}`;
  host.style.setProperty('--fx-intensity', theme.background.intensity ?? 0.5);
  const start = registry[theme.background.effect] || registry.none;
  return start(host, theme);
}

function loop(fps, draw) {
  const reduced = prefersReducedMotion();
  let raf = 0, last = 0, running = true;
  const frame = (t) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 1000 / fps) return;
    last = t; draw(t);
  };
  draw(0);
  if (!reduced) raf = requestAnimationFrame(frame);
  return () => { running = false; cancelAnimationFrame(raf); };
}

// ---------------------------------------------------------------------
// TV static: pre-baked noise frames blitted with random offsets, a slow
// rolling brightness band, scanlines and vignette (CSS overlays).
// ---------------------------------------------------------------------
function tvStatic(host) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  host.append(canvas, el('div', 'fx-scanlines'), el('div', 'fx-roll'), el('div', 'fx-vignette'));

  const SCALE = 2.5;                     // render at 1/2.5 resolution
  const FRAMES = 6;
  let w = 0, h = 0, frames = [];
  const resize = () => {
    w = Math.max(160, Math.ceil(innerWidth / SCALE));
    h = Math.max(90, Math.ceil(innerHeight / SCALE));
    canvas.width = w; canvas.height = h;
    frames = Array.from({ length: FRAMES }, () => {
      const img = ctx.createImageData(w, h);
      const buf = new Uint32Array(img.data.buffer);
      for (let i = 0; i < buf.length; i++) {
        // slightly cool, low-contrast grey noise reads as analog static
        const v = (Math.random() ** 1.6) * 205 | 0;
        buf[i] = 0xff000000 | (v + 6 << 16) | (v << 8) | v;
      }
      return img;
    });
  };
  resize();
  let f = 0;
  const stop = loop(22, () => {
    f = (f + 1 + (Math.random() * 3 | 0)) % FRAMES;
    const dx = (Math.random() * 8 | 0) - 4, dy = (Math.random() * 8 | 0) - 4;
    ctx.putImageData(frames[f], dx, dy);
  });
  addEventListener('resize', resize);
  return () => { stop(); removeEventListener('resize', resize); };
}

// ---------------------------------------------------------------------
// Anime sky: dusk gradient, a rising sun with radiating speed lines,
// giant outlined brush kanji (CSS), and slowly drifting sakura petals.
// ---------------------------------------------------------------------
function animeSky(host) {
  host.append(el('div', 'fx-sun'), el('div', 'fx-speedlines'));
  const kanji = el('div', 'fx-kanji'); kanji.setAttribute('aria-hidden', 'true'); kanji.textContent = '桜嵐';
  host.append(kanji, el('div', 'fx-halftone'));
  const canvas = document.createElement('canvas');
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  let W = 0, H = 0;
  const resize = () => { W = innerWidth; H = innerHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  resize();
  const count = Math.min(46, Math.round(innerWidth / 30));
  const petals = Array.from({ length: count }, () => newPetal(true));
  function newPetal(anywhere) {
    return {
      x: Math.random() * W, y: anywhere ? Math.random() * H : -20,
      s: 6 + Math.random() * 10, vx: 0.3 + Math.random() * 0.9, vy: 0.5 + Math.random() * 1.1,
      r: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.04, flip: Math.random() * Math.PI * 2,
      hue: 335 + Math.random() * 18, a: 0.55 + Math.random() * 0.4,
    };
  }
  const stop = loop(40, (t) => {
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.x += p.vx + Math.sin(t / 900 + p.flip) * 0.4; p.y += p.vy; p.r += p.vr; p.flip += 0.03;
      if (p.y > H + 20 || p.x > W + 20) Object.assign(p, newPetal(false), { x: Math.random() * W * 0.8 - 40 });
      drawPetal(ctx, p.x, p.y, p.s, p.r, Math.cos(p.flip), p.hue, p.a);
    }
  });
  addEventListener('resize', resize);
  return () => { stop(); removeEventListener('resize', resize); };
}

// Film grain: an SVG turbulence tile shifted in steps (CSS animation).
function grain(host) {
  host.append(el('div', 'fx-grain'), el('div', 'fx-vignette'));
  return () => {};
}

// Soft light rays turning slowly behind the content (CSS animation).
function lightRays(host) {
  host.append(el('div', 'fx-rays'), el('div', 'fx-rays fx-rays--2'), el('div', 'fx-glow'));
  return () => {};
}

function el(tag, cls) { const n = document.createElement(tag); n.className = cls; return n; }
