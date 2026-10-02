# Themes: one site, many worlds

Every category (and optionally every collection) points at a row in `themes`
and can override any key in `theme_overrides`. Admins change the look of a
world by editing data — no code, no separate sites.

## Config shape

```jsonc
{
  "colors":     { "bg", "fg", "muted", "accent", "accent2", "surface", "surface_fg", "line" },
  "fonts":      { "display", "body", "bodyStyle": "normal|italic", "hand", "script" },
  "background": { "effect": "tv-static|anime-sky|cyber-rain|grain|light-rays|none", "intensity": 0..1 },
  "hero":       { "style": "varsity-arch|script|manga-slash|holo|stacked|serif-centered" },
  "intro":      { "effect": "petal-storm|static-cut|boot-sequence|glitch|light-bloom|fade|none",
                  "sound": "anime-whoosh|tv-click|synth-boot|bass-hit|chime|null", "duration_ms": 1900 },
  "cards":      { "style": "sketch-callout|manga-panel|hud|sticker|gallery|plain" },
  "buttons":    { "style": "varsity-outline|slash|chamfer|solid|ghost" },
  "motion":     { "level": "calm|normal|energetic" }
}
```

Font keys come from the registry in `public/js/lib/theme.js` (only fonts that
ship with the site): `anton`, `monsieur`, `pinyon`, `inter`, `marker`, `dela`,
`cormorant`, `mono`, `orbitron`, `sharetech`.

## The seeded worlds

| Theme | Background | Entrance | Cards |
|---|---|---|---|
| **th8rty** (home, the artist) | live TV static with scanlines and rolling band | static flood → CRT switch-off, channel click | paper sketch scraps; product notes in hand-drawn ovals with arrows |
| **anime** | dusk sky, rising sun with speed lines, outlined brush kanji, drifting petals | blade slash → petal vortex → petals rush past the camera, blade + gust + shimmer sound | manga panels with halftone |
| **cyberpunk** | falling katakana/hex data rain over a neon perspective grid | terminal boot log → scan line → screen splits open, synth power-up | chamfered HUD panels with neon edges |
| **streetwear** | film grain | glitch slices, bass hit | die-cut stickers |
| **faith** | slow light rays | light bloom, soft chime | framed gallery |
| **minimal** | none | fade | plain |
| **archive** | none | fade | museum frames with plaques |

Home header: `store_settings.home.header_style` is `varsity-arch` (outlined
collegiate arch) or `script` (flourished calligraphy). The toggle on the home
hero previews either one for the current visitor only.

## Adding a new effect

1. Background: add a starter to `registry` in `js/effects/backgrounds.js`
   returning a `stop()`; draw a still frame when reduced motion is on.
2. Intro: add a function to `INTROS` in `js/effects/intros.js` that covers the
   screen, `await swap()`, then reveals.
3. Sound: add a synth recipe to `SOUNDS` in `js/effects/sound.js`.
4. Reference it from a theme's config.

## Accessibility & performance

- `prefers-reduced-motion`: backgrounds render one still frame; intros become a
  180 ms crossfade.
- Sounds only play after a click, and the speaker button in the header mutes
  them (remembered per browser).
- Static renders at 1/2.5 resolution from 6 pre-baked noise frames at ~22 fps;
  petals are pre-rendered sprites; all loops pause when the tab is hidden.
- All sounds are synthesized (Web Audio) and all artwork is original; no
  licensed characters, clips or imagery.
