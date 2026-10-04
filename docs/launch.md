# Going live

**Admin → Settings → Launch checklist** (`/admin/launch`) tracks everything
below. Automatic items read the database and the Netlify configuration (as
true/false only; values are never shown); manual items are ticked by a person
and record who and when.

| Area | What it checks |
|---|---|
| Payments | Stripe selected with keys (warns while it is a `sk_test_` key); one real order placed and refunded |
| Emails | Resend + `EMAIL_FROM`; Supabase Auth SMTP; no failed emails this week |
| Fulfillment | a real partner active; fictional test partners off and test routing off; real shipping prices |
| Catalogue & prices | real catalogue; product photos; production costs; custom-design prices; tax rates checked |
| Legal & trust | privacy, returns, shipping, terms — no `[[blanks]]` left and marked reviewed; moderation word list |
| Security | last-super-admin guard installed; leaked-password protection; backups; carrier webhook secret |
| Go live | own domain; `INTEGRATIONS_MODE=live` |

## Legal pages

`/legal/privacy`, `/legal/returns`, `/legal/shipping`, `/legal/terms`, linked
from the footer. They start as drafts written for a Canadian print-on-demand
store, with `[[blanks]]` highlighted in yellow. Edit them at
`/admin/launch/legal/<page>` (live preview). A page can't be marked reviewed
while it still has blanks. **Not legal advice — have a lawyer review them.**

## Search engines and link previews

- An edge function (`netlify/edge-functions/seo.js`) writes the real title,
  description, canonical URL, Open Graph tags and Google structured data
  (Product with price and availability, breadcrumbs, organisation, site
  search) into the HTML of public pages, so Google and link previews in
  iMessage/WhatsApp/Instagram show the product. Missing products return 404;
  private pages (bag, checkout, account, orders…) are `noindex`.
- `/sitemap.xml` lists store pages, categories, collections, products,
  archived drops and legal pages.
- `/robots.txt` **blocks all crawling until `INTEGRATIONS_MODE=live`**, so
  test data never lands in Google; once live it allows the store and blocks
  private areas.
- Share image: product photo when there is one, else `public/og/default.jpg`.

## The switch

1. Work through the checklist until only "Store switched to live" is left.
2. Netlify → Environment variables: `INTEGRATIONS_MODE=live`, redeploy.
3. Submit `https://<your domain>/sitemap.xml` in Google Search Console.
