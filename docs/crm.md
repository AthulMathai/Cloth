# CRM (Phase 8)

Migration: `supabase/migrations/20261004000015_crm.sql`.

## Customer profiles — `/admin/customers`

Every number is computed live from orders and payments by `crm_stats()` —
nothing is stored, so it can't drift:

| Figure | Definition |
|---|---|
| Orders | paid orders (`paid_at` set) |
| Lifetime value | sum of paid order totals − refunds |
| Average order | paid total ÷ paid orders |
| First / last purchase | first / last `paid_at` |
| Refunds / returns | orders with a refund payment / orders marked returned |
| Custom / limited | paid orders containing a custom design / a limited drop |
| Abandoned bag | open bag with items, untouched for `crm.abandoned_hours` |

The profile page shows orders, support requests, tracked activity
(analytics events), staff tags and notes (notes are permanent), marketing
consent and newsletter status, favourite categories, the current or
abandoned bag, wishlist, saved designs and addresses. **Log a contact…**
records a phone call or email as a support request.

### Segments

A customer can be in several at once. Thresholds are store settings,
editable under *How segments work* on the customer list (settings
permission):

- **New** — one paid order, placed within `crm.new_days` (60)
- **Returning** — 2+ paid orders
- **High value** — lifetime value ≥ `crm.high_value_cents` ($500)
- **Inactive** — bought before, nothing for `crm.inactive_days` (120)
- **Custom design** — bought or submitted a custom design
- **Limited collectors** — bought a limited drop
- **Abandoned bag**, **Email opt-in**, **No orders yet**

Staff accounts are left out of the list. Any view exports to CSV.

## Support desk — `/admin/support`, customers at `/support`

- Signed-in customers open requests (topic, optional order of theirs,
  message) and reply in a thread. Limit: 5 new requests an hour.
- Staff reply (status after sending: waiting on customer / in progress /
  resolved) or add **internal notes**, which customers never receive (the
  database filters them out). Status, priority, assignee and topic are
  editable; changes are logged in the thread as internal system lines.
- Views: needs reply, open, mine, unassigned, waiting on customer, resolved.
  Average first-response time over 30 days is shown.
- Threads are append-only.
- A staff reply creates an update on the customer's account page
  (`my_notifications`). **Emails are not sent yet** — that needs an email
  provider.

Permissions: `support.write` (admin, support agent) to reply and change
requests; `customers.read` to view; `customers.write` for tags and notes.

## Wishlist — `/wishlist`

“Save” on product pages, archived drop pages and collections. Archived or
sold-out pieces stay in the wishlist with their status and link to the
archive page; they can never be bought from there. Rows belong to the
customer (RLS); staff can read them on the profile.

## Abandoned bags — `/admin/customers/abandoned`

Signed-in shoppers whose bag has been untouched for the configured hours,
with contents, value, whether checkout was started and email consent.
Automatic reminder emails need an email provider.
