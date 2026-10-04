# Customer emails

The store emails customers automatically. Nothing is sent from the browser:
the **database** decides what to send (it writes a row to `email_outbox` when
something happens), and a **scheduled Netlify function** sends queued rows
every 2 minutes. Emails are never lost (they wait in the outbox if the
provider is down), never sent twice (rows are claimed under a lock and the
provider gets an idempotency key), and every one is visible in
**Admin → Customers → Emails**.

## What gets sent

| Email | When |
|---|---|
| Welcome | an account is created (1 minute later) |
| Order confirmed | payment succeeds — items, totals, edition numbers, address |
| Order delayed | an order is backordered |
| Order shipped | the partner marks it shipped (2-minute wait so tracking is included) |
| Out for delivery / Delivered | carrier updates |
| Order cancelled | a **paid** order is cancelled (abandoned checkouts don't email) |
| Order refunded | refund issued — amount refunded |
| Design approved | a person approves a design (instant automatic approvals don't email; the customer is on the page) |
| Design not approved | a design is rejected — includes the reviewer's note |
| Quote ready | staff send a quote price |
| Support reply | staff reply to a support request (internal notes never email) |

Each type can be switched off in **Admin → Emails → Settings**, where you also
set the sender name and the reply-to address. Every type has a **preview**.

Account emails — *confirm your email* and *reset password* — are sent by
Supabase Auth, not by this outbox (see "Supabase Auth emails" below).

## Provider: Resend (free tier)

Free plan: 3,000 emails a month, 100 a day, up to 3 domains — plenty for
launch. Without a key the store runs in **test mode**: emails are prepared
and logged as "Test mode" so you can preview them, but nothing is sent.

1. Sign up at resend.com.
2. **Domains → Add domain** — use a domain you own (e.g. `th8rty.ca`), add the
   DNS records Resend shows (at your domain registrar), wait for "Verified".
   A `*.netlify.app` address can't be verified, so real sending needs your
   own domain.
3. **API Keys → Create API key** (Sending access).
4. Netlify → Site configuration → Environment variables:
   - `RESEND_API_KEY` = the key
   - `EMAIL_FROM` = an address on the verified domain, e.g. `orders@th8rty.ca`
   then redeploy.
5. In Admin → Emails set **Replies go to** to an inbox you read.

Without `EMAIL_FROM`, Resend's shared `onboarding@resend.dev` is used, which
only delivers to the Resend account owner — the admin page warns about this.

`EMAIL_PROVIDER=mock` forces test mode even with a key.

## Supabase Auth emails (confirm address, reset password)

Supabase's built-in sender is rate-limited and meant for testing. To send
these from your own address through the same Resend account:
Supabase dashboard → **Authentication → Emails → SMTP Settings** → enable
custom SMTP:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your Resend API key |
| Sender email / name | e.g. `hello@mway.ca` / `M-Way` |

## How it works

| Object | Purpose |
|---|---|
| `email_outbox` | one row per email: template, recipient, status (`queued` → `sending` → `sent` / `skipped` / `failed`), attempts, provider id, error. Staff with customer or order access can read it; customers can't |
| triggers on `orders`, `custom_designs`, `quote_requests`, `support_messages`, `profiles` | queue the right email (deduplicated per event) |
| `email_payload(id)` | gathers what the email shows at send time (order lines, totals, tracking…) |
| `email_claim(limit)` / `email_result(...)` | sender API, service role only. Temporary failures retry 5 times (2, 4, 8, 16 min…); permanent ones (bad address) stop at once and raise an admin alert |
| `admin_emails`, `admin_email_preview`, `admin_email_resend` | admin page |
| `public/js/lib/email-templates.js` | the templates — shared by the sender and the admin preview, so the preview is exactly what customers get. HTML (table layout, inline styles, works in Gmail/Outlook/Apple Mail) + plain-text version |
| `netlify/lib/email.mjs`, `netlify/functions/scheduled-emails.mjs` | provider adapter and sender |

Marketing emails (newsletters, drop announcements) are not sent from here —
they need unsubscribe handling and consent tracking; use a newsletter tool
with the `marketing_opt_in` list when you're ready.
