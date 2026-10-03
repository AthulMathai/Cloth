# Deployment & environment variables

## Supabase

1. Create a project. In **SQL editor** (or `supabase db push`) run the files in
   `supabase/migrations` in order. Run `supabase/seed.sql` only on dev/staging.
2. Auth → URL configuration: set the site URL to your Netlify domain.
3. Grant yourself `super_admin` (see docs/database.md).

## Netlify

1. New site from this repo. `netlify.toml` already sets publish dir `public`,
   build command `node scripts/write-env.mjs`, functions dir and the SPA redirect.
2. Set environment variables (Site settings → Environment variables):

| Variable | Exposed to browser | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | project URL |
| `SUPABASE_ANON_KEY` | yes | public anon key (safe: RLS enforces access) |
| `SUPABASE_SERVICE_ROLE_KEY` | **never** | used only by Netlify Functions |
| `INTEGRATIONS_MODE` | yes | `mock` shows the development banner; `live` hides it |
| `CRON_SECRET` | no | protects manually-triggered job endpoints |
| `PAYMENT_PROVIDER` | no | `mock` (default, test page) or `stripe` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | needed when `PAYMENT_PROVIDER=stripe` (see docs/checkout.md) |
| `CARRIER_WEBHOOK_SECRET` | no | bearer secret for `/api/carrier-webhook` (tracking scans from a carrier or tracking aggregator) |
| `AI_PROVIDER`, `MODERATION_PROVIDER`, `SHIPPING_PROVIDER`, `EMAIL_PROVIDER` | no | `mock` until real adapters are configured. Design moderation uses the built-in checks; with `INTEGRATIONS_MODE=live` images are sent to human review rather than auto-approved |

`scripts/write-env.mjs` writes only the public values into
`public/js/lib/env.js` at build time. That file is git-ignored.

3. Deploy. The scheduled function `scheduled-lifecycle` starts running every
   10 minutes automatically.

## Before going live

- Verify current Canadian GST/HST/PST/QST rates when the tax tables land.
- Replace mock adapters with real providers and set `INTEGRATIONS_MODE=live`.
- Add the SEO edge function + sitemap (see architecture.md).
