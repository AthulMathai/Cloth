# Cart, checkout & payments (Phase 2)

## Flow

```
Product page ──add──▶ cart_set_item()          bag lives in Supabase (guest token or account)
Bag / Checkout ─────▶ cart_quote()              live totals: price_cart() — one pricing function
"Continue to payment" POST /api/checkout
      └▶ create_order()   re-prices in the DB, validates address, reserves stock
                          + limited editions, order = payment_pending (30-min hold)
      └▶ payment adapter  mock → /checkout/pay/<no>   |   stripe → Stripe Checkout
Payment succeeds ───▶ confirm_order_payment()  reservations → sales, edition numbers
                                                assigned, discount counted, bag emptied,
                                                order → paid → fulfillment_pending
Abandoned / declined ▶ release_order() / expire_pending_orders() (every 10 min)
```

## Guarantees

| Risk | How it's prevented |
|---|---|
| Customer edits the price | The browser never sends prices. `create_order` re-prices from database rows. |
| Overselling | Stock is reserved with `UPDATE … WHERE on_hand - reserved >= qty`; the last piece can only be taken once. Tested with 6 simultaneous buyers for 2 limited pieces: exactly 2 succeeded. |
| Duplicate orders (double click, retry) | Each checkout carries an idempotency key; a repeat returns the same order. |
| Duplicate payments (webhook retries) | `payments` is unique per provider reference; `webhook_events` records each provider event once. |
| Gaps in edition numbers | Numbers are assigned only when payment is confirmed, from reserved pieces, so abandoned checkouts never burn a number. |
| Stock stuck in abandoned checkouts | Holds expire after 30 minutes (`expire_pending_orders`, run by `scheduled-lifecycle`). |
| Payment arrives after the hold expired, or for the wrong amount | Order goes to `on_hold` with a note for staff instead of shipping unpaid/oversold goods. |
| Lost history | `order_events` is append-only (update/delete raise errors); every status change is logged automatically. |
| Archived product bought by accident | `cart_set_item` only accepts `is_purchasable` products; checkout re-checks. |

## Taxes

`tax_rates` holds one row per component per province, with `effective_from` /
`effective_to`, so a rate change is a new row, not an edit. Seeded rates were
verified on 2026-10-01 (NS HST 14% since 2025-04-01). Tax is charged on
discounted goods + shipping. **Before launch, confirm with an accountant**:
provincial exemptions (e.g. children's clothing) and PST/QST registration
thresholds aren't modelled.

## Shipping

`shipping_zones` (sets of provinces) → `shipping_rates` (Standard / Express,
price, free-over threshold, delivery days). Seeded prices are placeholders;
set them from real carrier quotes. `carrier` is filled once a carrier
integration exists.

## Discounts

Kinds: `percent`, `fixed` (cents), `free_shipping`, `bxgy` (buy X get Y, cheapest
free). Rules: scope (all / products / categories / collections), exclude
limited editions, minimum subtotal, start/end dates, max uses, per-customer
limit, first order only, customer-specific emails. Codes aren't publicly
listable. Dev codes: `WELCOME20`, `DROP10`, `FREESHIP`, `ANIME15`, `BASICS3`,
`EXPIRED5`.

## Payments

`PAYMENT_PROVIDER=mock` (default): a clearly labelled test page; no money moves.
The mock endpoint refuses to run when `INTEGRATIONS_MODE=live`.

`PAYMENT_PROVIDER=stripe`: set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`,
then in Stripe add a webhook to `https://<site>/api/payments-webhook` for
`checkout.session.completed` and `checkout.session.expired`. Customers pay on
Stripe's hosted page; card data never reaches this site.

## Not yet

- Order confirmation emails (needs an email provider).
- Refunds and staff order actions (admin, later phase).
- Custom-design line items and their pricing snapshot (Phase 3; the cart
  schema already has `item_type`, `custom_design_id`, `price_snapshot`).
