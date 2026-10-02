// Page-transition intros, keyed by theme.intro.effect. Each intro covers
// the screen, calls swap() (which renders the destination page and applies
// its theme underneath), then reveals it.
import { prefersReducedMotion } from '../lib/theme.js';
import { drawPetal } from './petal.js';
import { sound } from './sound.js';

let running = false;

export async function runIntro(theme, swap) {
  const { effect = 'fade', sound: sfx, duration_ms } = theme.intro || {};
  if (running) { await swap(); return; }
  running = true;
  try {
    sound.play(sfx);
    if (prefersReducedMotion()) return await crossfade(swap, theme, 180);
    const fn = INTROS[effect] || INTROS.fade;
    await fn(swap, theme, duration_ms || 800);
  } finally {
    running = false;
  }
}

const INTROS = {
  'petal-storm': petalStorm,
  'static-cut': staticCut,
  'glitch': glitch,
  'light-bloom': lightBloom,
  'fade': (swap, theme, d) => crossfade(swap, theme, d / 2),
  'none': (swap) => swap(),
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const easeIn = (t) => t * t * t;

function overlay(cls) {
  const o = document.createElement('div');
  o.className = `intro ${cls}`;
  o.setAttribute('aria-hidden', 'true');
  document.body.append(o);
  return o;
}

async function crossfade(swap, theme, ms) {
  const o = overlay('intro-fade');
  o.style.background = theme.colors.bg;
  o.style.transitionDuration = `${ms}ms`;
  await new Promise(requestAnimationFrame);
  o.classList.add('is-on');
  await wait(ms);
  await swap();
  o.classList.remove('is-on');
  await wait(ms);
  o.remove();
}

// ---------------------------------------------------------------------
// Petal storm: a blade slash splits into thousands of blossom petals that
// spiral into a vortex, swallow the screen, then rush past the camera as
// the new page is revealed.
// ---------------------------------------------------------------------
async function petalStorm(swap, theme, duration) {
  const o = overlay('intro-petals');
  const canvas = document.createElement('canvas'); o.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const R = Math.hypot(W, H) / 2;
  const N = Math.round(Math.min(1400, Math.max(520, (W * H) / 1100)));
  const accent = theme.colors.accent;

  // Petals are born along the slash diagonal and orbit the centre.
  const petals = Array.from({ length: N }, (_, i) => {
    const along = Math.random() * 2 - 1;                       // position on slash
    const sx = cx + along * W * 0.6, sy = cy + along * H * 0.6;
    return {
      born: Math.abs(along) * 0.18 + Math.random() * 0.06,      // slash travels outward
      r0: Math.hypot(sx - cx, sy - cy) * (0.5 + Math.random() * 0.7) + Math.random() * 120,
      th0: Math.atan2(sy - cy, sx - cx) + (Math.random() - 0.5) * 0.5,
      spin: 2.4 + Math.random() * 2.2,
      size: 7 + Math.random() * 13,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 8,
      flip: Math.random() * 6.28, hue: 330 + Math.random() * 25,
      depth: 0.6 + Math.random() * 0.8,
    };
  });

  const COVER = 0.46;
  let swapped = false, swapPromise = null;
  const t0 = performance.now();

  await new Promise((resolve) => {
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      ctx.clearRect(0, 0, W, H);

      // pink wash: builds to near-opaque at cover, then clears
      const wash = t < COVER ? ease(t / COVER) * 0.94 : 0.94 * (1 - ease(Math.min(1, (t - COVER) / 0.3)));
      ctx.fillStyle = `rgba(28, 6, 20, ${wash})`; ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      glow.addColorStop(0, hexA(accent, wash * 0.55)); glow.addColorStop(1, hexA(accent, 0));
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

      // the blade slash (first ~20% of the intro)
      if (t < 0.24) {
        const k = Math.min(1, t / 0.12), fade = 1 - Math.max(0, (t - 0.12) / 0.12);
        ctx.save();
        ctx.strokeStyle = `rgba(255,255,255,${fade})`; ctx.lineWidth = 3 + 10 * fade;
        ctx.shadowColor = accent; ctx.shadowBlur = 30; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - W * 0.65 * k, cy - H * 0.65 * k);
        ctx.lineTo(cx + W * 0.65 * k, cy + H * 0.65 * k);
        ctx.stroke(); ctx.restore();
      }

      for (const p of petals) {
        const local = t - p.born;
        if (local <= 0) continue;
        let x, y, scale = 1, alpha = 1;
        if (t < COVER) {
          // vortex: spiral inward, accelerating
          const k = local / (COVER - p.born);
          const r = p.r0 * (1 - 0.32 * ease(Math.min(1, k)));
          const th = p.th0 + p.spin * k * k;
          x = cx + Math.cos(th) * r; y = cy + Math.sin(th) * r * 0.85;
          alpha = Math.min(1, local * 12);
        } else {
          // zoom: petals rush toward the camera and out of frame
          const k = (t - COVER) / (1 - COVER);
          const r = p.r0 * 0.68;
          const th = p.th0 + p.spin + k * 1.2;
          const z = Math.max(0.05, 1 - easeIn(k) * 0.97 * p.depth);
          x = cx + (Math.cos(th) * r) / z; y = cy + (Math.sin(th) * r * 0.85) / z;
          scale = 1 / z;
          alpha = Math.max(0, 1 - k * 1.1);
        }
        if (alpha <= 0.01) continue;
        drawPetal(ctx, x, y, p.size * scale, p.rot + p.vr * t, Math.cos(p.flip + t * 9), p.hue, alpha * 0.95);
      }

      if (!swapped && t >= COVER) { swapped = true; swapPromise = swap(); }
      if (t < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
  if (!swapped) await swap(); else await swapPromise;
  o.remove();
}

// ---------------------------------------------------------------------
// Static cut: the screen floods with static, then collapses like an old
// CRT switching off into the new page.
// ---------------------------------------------------------------------
async function staticCut(swap, theme, duration) {
  const o = overlay('intro-static');
  const canvas = document.createElement('canvas'); o.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const w = Math.ceil(innerWidth / 3), h = Math.ceil(innerHeight / 3);
  canvas.width = w; canvas.height = h;
  const img = ctx.createImageData(w, h); const buf = new Uint32Array(img.data.buffer);
  let alive = true;
  const draw = () => {
    if (!alive) return;
    for (let i = 0; i < buf.length; i++) { const v = Math.random() * 255 | 0; buf[i] = 0xff000000 | (v << 16) | (v << 8) | v; }
    ctx.putImageData(img, 0, 0); requestAnimationFrame(draw);
  };
  draw();
  o.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.25, fill: 'forwards' });
  await wait(duration * 0.45);
  await swap();
  await o.animate([
    { transform: 'scale(1, 1)', filter: 'brightness(1)' },
    { transform: 'scale(1, 0.006)', filter: 'brightness(3)', offset: 0.6 },
    { transform: 'scale(0, 0.006)', filter: 'brightness(4)' },
  ], { duration: duration * 0.55, easing: 'cubic-bezier(.6,0,.3,1)', fill: 'forwards' }).finished;
  alive = false; o.remove();
}

// Glitch: jittering slices of colour, hard cut.
async function glitch(swap, theme, duration) {
  const o = overlay('intro-glitch');
  const bands = Array.from({ length: 9 }, (_, i) => {
    const b = document.createElement('div');
    b.style.top = `${i * 11.2}%`;
    b.style.background = i % 3 === 0 ? theme.colors.accent : i % 3 === 1 ? theme.colors.bg : (theme.colors.accent2 || theme.colors.fg);
    o.append(b); return b;
  });
  const jitter = () => bands.forEach(b => { b.style.transform = `translateX(${(Math.random() - 0.5) * 30}%) scaleY(${0.6 + Math.random()})`; });
  const id = setInterval(jitter, 45); jitter();
  await wait(duration * 0.45);
  await swap();
  await wait(duration * 0.3);
  clearInterval(id);
  await o.animate([{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(50% 0 50% 0)' }], { duration: duration * 0.25, fill: 'forwards' }).finished;
  o.remove();
}

// Light bloom: a soft white glow swells and settles.
async function lightBloom(swap, theme, duration) {
  const o = overlay('intro-bloom');
  await o.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1.6)' }],
    { duration: duration * 0.45, easing: 'ease-in', fill: 'forwards' }).finished;
  await swap();
  await o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.55, easing: 'ease-out', fill: 'forwards' }).finished;
  o.remove();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${a})`;
}
