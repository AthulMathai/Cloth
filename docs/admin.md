# Admin control center

`/admin` — staff only. Every screen reads live database rows; every action is
enforced by the database (Row Level Security + permission-checked functions), so
hiding a menu item is convenience, never the security boundary.

## Getting in (first time)

1. Create a store account with the owner email set in `store_settings`
   (`admin.owner_email`, currently `athulmathai333@gmail.com`) and confirm the email.
2. Open `/admin`. While **no super admin exists**, that confirmed account is made
   super admin automatically (`claim_owner()`, logged in the audit log). After that,
   claiming is closed — add staff under **Settings → Users & roles**.
3. Run `supabase/migrations/20261003000012_last_super_admin_guard.sql` once in the
   Supabase SQL editor (it stops anyone removing the last super admin; the MCP
   connector refuses SQL containing DELETE, so it wasn't applied automatically).

## Sections

| Section | What you can do | Permission |
|---|---|---|
| Dashboard | Revenue (after refunds), orders, AOV, visitors/conversion, revenue-per-day chart (+ table view), pipeline counts, low stock, drops, moderation, quotes, latest orders, best sellers. 7/30/90 days. | any staff |
| Orders | Search by number/email/name; tabs Pending, Production, Shipped, Delivered, Backorders, Returns, Refunds, Cancelled, Unpaid. Order view: items, custom artwork + print files, edition numbers, cost/margin, totals, customer summary, shipping, payments, full append-only history. Actions: note, hold, release hold, cancel (optional restock), refund. | orders.read / orders.write / orders.refund |
| Quotes | Bulk requests (250+): set price per item, discount, total, expiry, notes, status. | orders.write |
| Products | List/search/filter by status; create, edit, duplicate (as draft, stock 0), archive; variants (sizes × colours generator, per-variant price/sale/cost/SKU/low-stock alert); stock adjustments with a reason; images (upload to `products` bucket or URL). | products.write, inventory.write |
| Categories / Collections | Name, slug, description, images, visibility, featured, SEO, **theme + overrides** (accent/bg/text colour, headline font, background effect, page transition, animation level, raw JSON). | catalog.write |
| Designers, Themes | Artist profiles; theme configs (JSON). | catalog.write |
| Limited drops | Create/edit drops (product, number, edition size, max per order, release time, archive delay, story, original price); progress; can't shrink below sold + held. | products.write |
| Inventory | All variants, low-stock tab, inline +/− with reason, recent stock movements. | inventory.write |
| Moderation | Human review queue: mockups, original upload, automated findings & risk, text layers, layer sizes, linked orders, review history. Approve / request changes / reject / escalate (note required except approve). Approving releases waiting orders to fulfillment; rejecting puts them on hold. | moderation.review |
| Custom pricing | All pricing rules by type, live/off/not-in-effect; create, edit, duplicate; **calculator** running the same engine as the designer and checkout, with cost and margin. | pricing.write |
| Customers | Accounts with orders, spend, last order, designs, simple segment. (Full CRM = Phase 8.) | customers.read |
| Discounts | Percent / fixed / free shipping / buy X get Y; scope (all, products, categories, collections); min order, dates, max uses, per-customer, customer emails, first order only, exclude limited. | marketing.write |
| Shipping, Taxes, Store | Rates per zone; effective-dated tax rows; raw store settings. | settings.write |
| Users & roles | Add a role by account email, remove roles, see each role's permissions. Only super admins can add/remove super admins; partner logins come with Phase 7. | users.manage |
| Audit log | Who changed what, field-level before → after. | audit.read |

Fulfillment (Phase 7) and automatic Promotions show as "coming" rather than fake data.

## Order actions — rules

- **Hold**: any open, paid, not-yet-shipped order. **Release** returns it to the status it had before the hold.
- **Cancel**: not after shipping. Paid orders can return items to stock (limited edition numbers stay retired — never re-issued). Cancelling doesn't refund by itself; the order page then shows "cancelled but not refunded".
- **Refund** (`POST /api/admin-refund`): the database checks `orders.refund` and the refundable amount; the money goes back through the provider that took it (mock or Stripe, idempotent); then `record_refund()` writes the payment row, a history entry and the audit log, and marks the order Refunded when fully refunded. If the provider refunds but saving fails, the error shows the provider reference for reconciliation.
- Every action writes to the append-only order history with the staff member's email.

## Shopping now requires an account

Adding to the bag, viewing the bag and checking out require sign-in (database
functions refuse guests; signed-out visitors can't call the bag functions; the
checkout function returns 401). Shoppers are sent to sign in and brought back to
the page they were on (`?next=`, same-site paths only). Order tracking links in
existing confirmation emails keep working.

## Promotions (Marketing → Promotions)

Automatic sales with a start and end — flash sales, seasonal sales, a
collection or category on sale, single products. No code is needed: the
price drops everywhere (cards, product page, bag, checkout) while the
promotion runs, through the same `variant_price()` function the order uses.

- **Discount:** percent (up to 90%) or a dollar amount off each item.
- **Applies to:** everything, or picked collections / categories / products.
  Limited drops are left out unless "Include limited drops" is ticked.
- **Badge:** short label on product cards and the product page.
- **Banner:** optional strip across the top of the store with a live
  countdown; customers can hide it for their visit.
- **Rules:** the single biggest saving wins (promotions never stack); a
  product's own sale price wins if lower; discount codes still apply on top
  at checkout; paid orders keep the price paid.
- **What changes** (on the edit page) lists exactly which prices will drop
  before you save. Every change is in the audit log.
