# Limited editions & the archive

## Lifecycle

```
draft → scheduled → active → sold_out → archived
```

- **scheduled → active**: `publish_due_products()` once `publish_at` passes.
- **active → sold_out**: inside `allocate_editions()` the moment the last
  number is claimed.
- **sold_out → archived**: `archive_due_drops()` once `sold_out_at +
  archive_delay` passes (default 48 h, per drop; `0` archives immediately).
- Both jobs run every 10 minutes from `netlify/functions/scheduled-lifecycle.mjs`.

Products are never deleted. `archived` products stay publicly readable, appear
in the `archive_drops` view and on `/archive`, and `/product/<slug>` for an
archived drop renders the archive page instead of a buy box.

## Numbering guarantees

`allocate_editions(drop_id, qty, order_item_id)`:

1. Rejects drops that aren't `active` or haven't been released.
2. Runs `UPDATE limited_drops SET units_sold = units_sold + qty WHERE
   units_sold + qty <= edition_size` — a single row lock serialises buyers, so
   each gets a distinct contiguous block of numbers and the count can't pass
   the edition size.
3. Inserts one `edition_allocations` row per number; its primary key
   `(drop_id, edition_number)` makes duplicates impossible even if the code
   above were wrong.
4. Freezes `original_price_cents` for the archive on first sale.

Further guards:

- `units_sold` and on-hand stock can't be edited through the API, only via
  these functions.
- A trigger blocks moving an exhausted edition back to `active`/`scheduled`.
- `storefront_products.is_purchasable` is the single definition of "can be
  bought now"; checkout (Phase 2) re-checks it server-side.

## Verified

- 50 concurrent buyers racing for the last 13 editions: exactly 13 succeeded,
  numbers 488–500, no duplicates, product flipped to `sold_out`.
- `supabase/tests/catalog_integrity.sql` covers sell-out, no purchase after
  sell-out, no reactivation, archive delay, pre-release block and negative stock.
