// Theme engine. A theme is data (themes.config + per-category overrides);
// this module turns it into CSS custom properties, data-attributes that
// switch component styles, and a running background effect.
import { startBackground } from '../effects/backgrounds.js';

// Font registry: theme configs reference these keys, never raw font names,
// so admins pick from fonts that are actually shipped with the site.
export const FONTS = {
  anton:     { family: "'Anton', 'Impact', sans-serif", label: 'Anton (varsity condensed)' },
  monsieur:  { family: "'Monsieur La Doulaise', cursive", label: 'Monsieur La Doulaise (flourish script)' },
  pinyon:    { family: "'Pinyon Script', cursive", label: 'Pinyon Script' },
  inter:     { family: "'Inter', system-ui, sans-serif", label: 'Inter' },
  marker:    { family: "'Permanent Marker', 'Comic Sans MS', cursive", label: 'Permanent Marker (hand)' },
  dela:      { family: "'Dela Gothic One', 'Hiragino Sans', sans-serif", label: 'Dela Gothic One (anime)' },
  cormorant: { family: "'Cormorant Garamond', Georgia, serif", label: 'Cormorant Garamond' },
  mono:      { family: "'Space Mono', ui-monospace, monospace", label: 'Space Mono' },
  orbitron:  { family: "'Orbitron', 'Eurostile', sans-serif", label: 'Orbitron (techno display)' },
  sharetech: { family: "'Share Tech Mono', ui-monospace, monospace", label: 'Share Tech Mono (terminal)' },
};

export const DEFAULT_THEME = {
  colors: { bg: '#f7f7f5', fg: '#111111', muted: '#77756f', accent: '#111111', accent2: '#e6e5e1', surface: '#ffffff', surface_fg: '#111111', line: '#e2e1dc' },
  fonts: { display: 'inter', body: 'inter', bodyStyle: 'normal', hand: 'inter', script: 'monsieur' },
  background: { effect: 'none', intensity: 0.5 },
  hero: { style: 'stacked' },
  intro: { effect: 'fade', sound: null, duration_ms: 400 },
  cards: { style: 'plain' },
  buttons: { style: 'ghost' },
  motion: { level: 'normal' },
};

export function mergeDeep(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object'
      ? mergeDeep(a[k], v) : v;
  }
  return out;
}

/** theme row (+ optional overrides) -> complete config */
export function resolveTheme(themeConfig, overrides) {
  return mergeDeep(mergeDeep(DEFAULT_THEME, themeConfig || {}), overrides || {});
}

let stopBg = null;
let current = null;

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function applyTheme(theme, slug = 'default') {
  const root = document.documentElement;
  const c = theme.colors;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--bg', c.bg); set('--fg', c.fg); set('--muted', c.muted); set('--accent', c.accent);
  set('--accent-2', c.accent2); set('--surface', c.surface); set('--surface-fg', c.surface_fg || c.fg); set('--line', c.line);
  const f = (key) => (FONTS[key] || FONTS.inter).family;
  set('--font-display', f(theme.fonts.display));
  set('--font-body', f(theme.fonts.body));
  set('--font-hand', f(theme.fonts.hand));
  set('--font-script', f(theme.fonts.script || 'monsieur'));
  set('--body-style', theme.fonts.bodyStyle === 'italic' ? 'italic' : 'normal');
  root.dataset.theme = slug;
  root.dataset.cards = theme.cards.style;
  root.dataset.buttons = theme.buttons.style;
  root.dataset.hero = theme.hero.style;
  root.dataset.bg = theme.background.effect;
  root.dataset.motion = prefersReducedMotion() ? 'reduced' : theme.motion.level;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.bg);

  const bgKey = `${theme.background.effect}:${theme.background.intensity}:${slug}`;
  if (current !== bgKey) {
    stopBg?.();
    stopBg = startBackground(document.getElementById('bg-fx'), theme);
    current = bgKey;
  }
}
