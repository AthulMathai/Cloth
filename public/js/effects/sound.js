// Transition sounds, synthesized with Web Audio (no audio files, nothing
// licensed). Only ever played in response to a click, and muted with the
// header toggle (remembered per browser).
const KEY = 'th8rty.sound';
let ctx = null;

export const sound = {
  get enabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } },
  set enabled(v) { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch {} },
  play(name) {
    if (!this.enabled || !name || !SOUNDS[name]) return;
    try {
      ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      SOUNDS[name](ctx, ctx.currentTime + 0.01);
    } catch { /* audio unavailable: transitions still run silently */ }
  },
};

function noiseBuffer(ac, seconds) {
  const b = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function env(ac, t, peak, attack, decay) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function bell(ac, out, t, freq, peak, decay, type = 'sine') {
  const o = ac.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = env(ac, t, peak, 0.004, decay);
  o.connect(g).connect(out); o.start(t); o.stop(t + decay + 0.05);
}

const SOUNDS = {
  // Blade draw + petal gust + a bright pentatonic shimmer.
  'anime-whoosh'(ac, t) {
    const out = ac.createGain(); out.gain.value = 0.55; out.connect(ac.destination);
    // gust: band-passed noise sweeping up then down
    const n = ac.createBufferSource(); n.buffer = noiseBuffer(ac, 1.6);
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 0.45);
    bp.frequency.exponentialRampToValueAtTime(500, t + 1.5);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.9, t + 0.35);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.55);
    n.connect(bp).connect(ng).connect(out); n.start(t); n.stop(t + 1.6);
    // "shing": inharmonic metallic partials
    [2093, 3135, 4412, 5587, 7040].forEach((f, i) => bell(ac, out, t + 0.02, f, 0.09 / (i + 1), 1.1 - i * 0.12));
    // shimmer: rising pentatonic sparkle
    [1318.5, 1568, 1760, 2093, 2637, 3136].forEach((f, i) => bell(ac, out, t + 0.25 + i * 0.07, f, 0.05, 0.6, 'triangle'));
  },
  // CRT channel change: click + short burst of static.
  'tv-click'(ac, t) {
    const out = ac.createGain(); out.gain.value = 0.45; out.connect(ac.destination);
    bell(ac, out, t, 90, 0.6, 0.05, 'square');
    const n = ac.createBufferSource(); n.buffer = noiseBuffer(ac, 0.4);
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = env(ac, t + 0.01, 0.5, 0.01, 0.32);
    n.connect(hp).connect(g).connect(out); n.start(t); n.stop(t + 0.4);
  },
  // Sub drop with a noisy transient.
  'bass-hit'(ac, t) {
    const out = ac.createGain(); out.gain.value = 0.6; out.connect(ac.destination);
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.35);
    const g = env(ac, t, 0.9, 0.005, 0.5);
    o.connect(g).connect(out); o.start(t); o.stop(t + 0.6);
    const n = ac.createBufferSource(); n.buffer = noiseBuffer(ac, 0.15);
    n.connect(env(ac, t, 0.3, 0.002, 0.1)).connect(out); n.start(t);
  },
  // Terminal boot: data blips, a filtered saw power-up, a low impact.
  'synth-boot'(ac, t) {
    const out = ac.createGain(); out.gain.value = 0.4; out.connect(ac.destination);
    [880, 1318.5, 1046.5, 1568, 1318.5, 2093, 1760, 2637].forEach((f, i) =>
      bell(ac, out, t + i * 0.055, f, 0.12, 0.05, 'square'));
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t + 0.35); o.frequency.exponentialRampToValueAtTime(220, t + 0.95);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 9;
    lp.frequency.setValueAtTime(200, t + 0.35); lp.frequency.exponentialRampToValueAtTime(4200, t + 0.95);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.35); g.gain.exponentialRampToValueAtTime(0.35, t + 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(lp).connect(g).connect(out); o.start(t + 0.35); o.stop(t + 1.15);
    const k = ac.createOscillator(); k.type = 'sine';
    k.frequency.setValueAtTime(90, t + 0.95); k.frequency.exponentialRampToValueAtTime(38, t + 1.3);
    k.connect(env(ac, t + 0.95, 0.8, 0.005, 0.4)).connect(out); k.start(t + 0.95); k.stop(t + 1.4);
  },
  // Soft bell for calm themes.
  'chime'(ac, t) {
    const out = ac.createGain(); out.gain.value = 0.35; out.connect(ac.destination);
    [[659.3, 0], [987.8, 0.12], [1318.5, 0.24]].forEach(([f, d]) => {
      bell(ac, out, t + d, f, 0.12, 2.2); bell(ac, out, t + d, f * 2.01, 0.03, 1.4);
    });
  },
};
