# Fulfillment (Phase 7)

Paid orders go to a print partner automatically. The database makes every
decision (who makes it, which step comes next, who may do what); Netlify
Functions only move messages. Migration: `supabase/migrations/20261003000014_fulfillment.sql`.

## Flow

```
paid ─▶ (custom designs approved) ─▶ fulfillment_pending
      ─▶ route_order() ─▶ production order PO-50xxx at the best partner  (order: assigned)
      ─▶ partner accepts ─▶ production_queued ─▶ start ─▶ printing ─▶ printed ─▶ quality_check
      ─▶ packed (blanks used up) ─▶ ship + tracking ─▶ shipped ─▶ carrier scans ─▶ in_transit ─▶ out_for_delivery ─▶ delivered
```

Every step writes the append-only order history (`order_events`, with actor
system / partner / staff / provider) and the production order's own history
(`production_order_events`).

## Routing

`route_order(order)` runs the moment an order reaches `fulfillment_pending`
(trigger `orders_status_fulfillment`), and again from the 5-minute sweep for
anything missed or backordered. For every **active** partner it checks:

| Check | Source |
|---|---|
| Ships to the customer's province | `partners.ships_to` (empty = all of Canada) |
| Makes every garment type | `partners.product_types` (empty = all) |
| Can print every placement with an allowed method | `partners.print_methods`, `partners.placements`; custom items need the exact method, catalog items any of the product's `print_methods` |
| Has the blanks free (on hand − reserved) | `partner_inventory` (skipped if `tracks_inventory` is off) |
| Has room in its queue | open units vs `capacity_per_day` |

Qualified partners are scored (lower wins):
`distance_km/400 + queue load × 2 + production_days × 0.5 + (1 − reliability) × 4 − 0.5 if same province`.
Distance uses the postal-code region centroids in `postal_regions`. Reliability
comes from the last 90 days (on time vs late + rejected, smoothed so a new
partner starts high). Every candidate and every reason is stored on the
production order (`routing`), shown to staff as “Why this partner?”.

- **Nobody can make it** → order `on_hold` + critical alert.
- **Capable partners lack blanks/room** → order `backordered` + warning; the sweep retries every 5 minutes.
- **Partner rejects** → its blanks are released and the order is re-routed, never back to a partner that said no.
- **Staff reassign** (order page → Reassign…) → only before printing starts; old PO cancelled, blanks released.
- **Order cancelled/refunded** → the live PO is cancelled and the partner notified.

A unique index allows only one live production order per order, so retries,
sweeps and webhooks can never produce a garment twice, and no step touches
payments.

## Partner blank stock

`partner_inventory` (partner × garment × colour × size): `on_hand`, `reserved`.
Routing reserves; packing consumes; rejection/cancel releases. Numbers can only
change through functions (guard trigger), and every change is logged in
`partner_inventory_movements`. Partners count / receive stock in the portal.

## Partner portal — `/partner`

Phone-first. Tabs: New, In production, Ready to ship, Done, Stock, Settings.
One-tap Accept / Start / Printed / Packed, Ship with carrier + tracking,
Reject with a reason, Reprint after a failed QC, print-file download links
(signed for an hour by `/api/production-files`), pause new orders, set queue
capacity and production time. Orders on hold at TH8RTY can't be advanced.

Give someone access: Admin → Fulfillment → Partners → partner → *Portal accounts*
(they create a normal account first). Partner accounts can't be staff accounts.

## Admin — `/admin/fulfillment`

Overview (KPIs, alerts, pipeline, partner load/on-time/reliability, routing
switches), production queue, partner profiles (capabilities, stock grid,
accounts, webhook endpoint + signing secret), partner inventory, shipments.
The order page has a Fulfillment panel: current PO, why that partner,
shipments + scans, Choose partner / Reassign.

## Integrations

- **Partners by API** (`integration = webhook`): the scheduled job POSTs
  `production_order.assigned` with `Idempotency-Key: PO-…` and
  `X-TH8RTY-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "t.body")>`,
  retrying with exponential backoff (critical alert after 5 failures).
  Partners report progress to `POST /api/partner-webhook` with
  `X-TH8RTY-Partner: <code>` and the same signature.
- **Carriers**: `POST /api/carrier-webhook` (bearer `CARRIER_WEBHOOK_SECRET`)
  with `{carrier, tracking_number, status, description, location, occurred_at, event_id}`.
  Scans are recorded once per `event_id` and never move an order backwards.
  Real carrier APIs (Canada Post, Purolator…) still need an adapter or a
  tracking aggregator pointed at this endpoint.
- **Test carrier**: shipments booked with “Test carrier” advance one scan
  every `fulfillment.test_carrier_step_minutes` (default 10) or on demand
  (“Simulate next carrier scan”).

## Test partners

Five fictional partners (`*-test`, “(test)” in the name, `is_test = true`) in
Toronto, Montréal, Ottawa, Calgary and Vancouver with different garments,
methods, provinces, capacity and stock. They are **not real businesses**.
Before going live: deactivate them, or untick *Route to test partners* on the
fulfillment overview (store setting `fulfillment.allow_test_partners`).

## Scheduled job

`scheduled-fulfillment` (every 5 min): `fulfillment_sweep()` (missed routing,
backorders, not-accepted-in-time and late alerts, test carrier) and the
partner webhook outbox.

## Not yet

Shipping labels / rates from carrier APIs, customer emails/SMS for shipping
updates (in-app notifications are recorded), returns processing, split
shipments across partners (an order goes to one partner).
