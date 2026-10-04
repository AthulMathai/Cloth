# M-Way — clothing platform

Storefront, custom designer, moderation, fulfillment routing and admin for a
print-on-demand clothing brand. Hosted on **Netlify**, backed by **Supabase**.

## Status

| Phase | Area | State |
|---|---|---|
| 1 | Foundation: schema, roles & permissions, RLS, audit log, analytics events, auth, theme engine, storefront | **Built** |
| 2 | Products & variants, categories, collections, product pages | **Built** (managed in admin) |
| 2 | Cart, checkout, payments (mock + Stripe adapter), taxes, shipping, discounts | **Built** — see docs/checkout.md |
| 3 | Custom designer + dynamic pricing engine, saved designs, quote requests | **Built** — see docs/custom-designer.md (pricing rules + calculator in admin) |
| 3 | Real-time 3D garments, drag-on-garment, 3D mockups, live camera try-on | **Built** — three.js r180 vendored in `public/vendor/three` |
| 4 | Orders, order history, customer tracking | **Built** (carrier tracking on the order page since Phase 7). Order emails need an email provider |
| — | Admin control center (`/admin`): dashboard, orders (hold/cancel/refund/notes), products, variants, inventory, drops, categories/collections/themes, discounts, custom pricing + calculator, quotes, moderation queue, customers, shipping, taxes, users & roles, audit log | **Built** — see docs/admin.md |
| — | Sign-in required to shop (bag + checkout) | **Built** |
| 5 | Limited drops, numbering, sold-out → archive | **Built**, including purchase with reservation-safe numbering |
| 6 | Moderation | **Built**: automated checks + human review queue in admin. Provider OCR / image classification are plug-in slots |
| 7 | Fulfillment: partners, automatic routing, production orders, partner portal (`/partner`), partner blank stock, shipments + tracking, alerts, partner webhooks | **Built** — see docs/fulfillment.md. Five fictional test partners are seeded |
| 8 | CRM: customer profiles with lifetime value, segments, tags, notes, activity; support desk + customer help pages; wishlist; abandoned bags | **Built** — see docs/crm.md |
| 9 | Analytics: sales, website (traffic, funnel, sources, searches), products, fulfillment, custom designer — date ranges, period comparison, charts + tables, CSV | **Built** — see docs/analytics.md |
| 10 | AI: “Describe it” design generation in the designer, browser background removal, meaning-based search, recommendations (product, bag, home), stock & drop forecasting, image descriptions for moderators, admin AI page | **Built** — see docs/ai.md. Runs free on Cloudflare Workers AI; labelled test mode until keys are added |

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
