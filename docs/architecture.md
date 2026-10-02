# Architecture

```
Browser (static ES modules, no build)
   │  anon key / user JWT only
   ▼
Supabase ── Postgres (RLS on every table) ── Auth ── Storage ── Realtime
   ▲
   │  service-role key (server only)
Netlify Functions ── scheduled jobs, checkout, webhooks, integrations (mock → real adapters)
```

**Why no framework build:** the sandbox this was started in couldn't reach npm,
so the front end is dependency-free modern JavaScript. That keeps it fast and
deployable as-is on Netlify. All business rules live in Postgres (constraints,
triggers, `SECURITY DEFINER` functions) and Netlify Functions, so moving the
UI to Next.js or another framework later doesn't touch them.

## Trust boundaries

- The browser is untrusted. It reads public data through RLS-filtered views and
  writes only where a policy allows (own profile, newsletter RPC, analytics RPC).
- Anything that changes money, stock or edition counters runs in a database
  function whose `EXECUTE` is revoked from `anon`/`authenticated`, called by a
  Netlify Function holding the service-role key.
- Staff permissions are rows in `role_permissions`, checked by
  `has_permission()` inside RLS policies — never by hiding buttons.

## Request flow (storefront)

1. `app.js` matches the URL to a page module and calls its `load()`, which
   fetches rows from views like `storefront_products` and resolves the page theme.
2. If the destination theme differs from the current one, the destination
   theme's **intro** plays (e.g. petal storm into Anime); the page swaps in
   while the screen is covered.
3. `applyTheme()` writes CSS tokens and `data-*` switches on `<html>` and starts
   the theme's background effect.
4. A `page_view` analytics event is recorded through `track_event()`.

## Scaling notes

- Product search uses a weighted `tsvector`; a `vector` column can sit beside it
  for semantic search without changing callers (`search_products()` RPC).
- Analytics events are an append-only table with open-ended `event_type`;
  aggregate into rollup tables on a schedule once volume grows.
- SEO: pages set title/description/canonical client-side. Before launch, add a
  Netlify Edge Function that injects per-URL meta + JSON-LD and serves a
  generated sitemap (planned with Phase 2).
