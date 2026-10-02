# TH8RTY — clothing platform

Storefront, custom designer, moderation, fulfillment routing and admin for a
print-on-demand clothing brand. Hosted on **Netlify**, backed by **Supabase**.

## Status

| Phase | Area | State |
|---|---|---|
| 1 | Foundation: schema, roles & permissions, RLS, audit log, analytics events, auth, theme engine, storefront | **Built** |
| 2 | Products & variants, categories, collections, product pages | **Built** (read side) |
| 2 | Cart, checkout, payments, taxes, shipping | Next |
| 3 | Custom designer + dynamic pricing engine | Planned |
| 4 | Orders, order history, customer tracking | Planned |
| 5 | Limited drops, numbering, sold-out → archive | **Built** (DB + storefront); purchase flow arrives with checkout |
| 6–10 | Moderation, fulfillment & partner portal, CRM, analytics dashboards, AI | Planned |

## Run it locally

```bash
supabase start                      # local Supabase (Docker)
supabase db reset                   # applies supabase/migrations + supabase/seed.sql
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon key from `supabase status`> \
  node scripts/write-env.mjs
netlify dev                         # serves public/ + functions on :8888
```

No npm install is needed: the front end is plain ES modules with no build step.

## Layout

```
public/                 static site (Netlify publish dir)
  index.html            app shell
  css/app.css           tokens + components; themes switch via data-attributes
  js/app.js             router, themed page transitions, header/footer
  js/lib/               supabase REST client, theme engine, analytics, cached lookups
  js/effects/           backgrounds (tv-static, anime-sky, grain, light-rays),
                        intros (petal-storm, static-cut, glitch, light-bloom), sound
  js/components/        garment illustrations, sketch callouts, cards, heroes
  js/pages/             one module per route
  assets/fonts/         self-hosted OFL/Apache fonts (subset WOFF)
netlify/functions/      server-side jobs (service role lives only here)
supabase/migrations/    schema, RLS, functions
supabase/seed.sql       development data (fictional)
supabase/tests/         SQL integrity checks
docs/                   architecture and operating notes
```

See `docs/` for architecture, database, themes, limited editions, deployment and environment variables.
