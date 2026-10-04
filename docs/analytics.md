# Analytics (Phase 9)

`/admin/analytics` (permission `analytics.read`). Migration:
`supabase/migrations/20261004000016_analytics.sql`.

Every report is a database function computed from the source tables —
orders, payments, order items, production orders, shipments and
`analytics_events` — so the numbers always agree with the rest of the admin.
Days are bucketed in the store's time zone (`store.timezone`, default
America/Toronto). Each report compares the chosen period with the period of
the same length just before it.

Controls: period (7/30/90 days, 12 months, this month, last month, year to
date, custom), group by day/week/month, **Table** on every chart, **Export
CSV** for the current report.

| Report | What's in it |
|---|---|
| Sales (`analytics_sales`) | Net revenue (paid − refunds), orders, average order, items, customers, refund rate, discounts, estimated gross margin (only on lines with known costs — coverage shown); revenue & orders over time; catalog vs custom vs limited; by category; by province; new vs returning; discount codes; merchandise/shipping/tax breakdown |
| Website (`analytics_website`) | Visitors, page views, product views, conversion, bag adds, checkouts (and abandoned), new accounts, searches; traffic over time; shopping funnel; traffic sources and devices (first page of each visit); top pages; searches incl. ones with no results; every tracked event |
| Products (`analytics_products`) | Best sellers, most viewed with view→sale rate, low performers (active > 7 days, no sales), by category, most wishlisted, limited drops (sell-through, time to sell out, revenue), low stock now, sold out |
| Fulfillment (`analytics_fulfillment`) | Sent to partners, on-time %, time to accept, assigned→shipped, shipped→delivered, paid→door, rejections and reprints, problems; production over time; per-partner table; rejection reasons; deliveries |
| Custom designs (`analytics_designs`) | Designer funnel (opened → uploaded → saved → approved → ordered), revenue, average piece price, margin from pricing-rule costs, try-ons, quotes, garments, placements, methods, colours, moderation reasons, AI designs (Phase 10) |

**Visitors**: a signed-in person counts once; a browser session that later
signs in is attributed to that person; anyone else is counted by browser
session (no cookies beyond the session id, no third-party scripts).

**Tracking**: the first page of each visit now records the source
(`utm_source` or the referring site) and device class (mobile/tablet/desktop);
collection pages record `collection_view`. Earlier visits have no source
data.

**Rollup**: `analytics_rollup()` (run every 10 minutes by the lifecycle job)
keeps `analytics_daily` — events and distinct visitors per event type per
day — for fast trends as traffic grows. Reports currently read events
directly.

**Margins** are estimates: catalog lines use the variant/product cost, custom
lines the costs frozen from the pricing rules (placeholders until real
partner costs are entered).
