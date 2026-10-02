# Database, auth & roles

Migrations live in `supabase/migrations` and run in filename order.

| Migration | Contents |
|---|---|
| `…01_foundation` | profiles, `app_role` enum, `user_roles`, `role_permissions`, `has_permission()`, store settings, append-only `audit_log` + `audit_row()` trigger, `analytics_events` + `track_event()` |
| `…02_catalog` | themes, categories, designers, collections, products, variants, media, inventory movements, limited drops, edition allocations, lifecycle functions, storefront views, search document |
| `…03_storage` | buckets and object policies |
| `…04_storefront_extras` | `search_products()` RPC, newsletter sign-ups |

## Auth

Supabase Auth (email + password, password reset). A trigger creates a
`profiles` row for each new user. The browser keeps the session in
localStorage and refreshes it before expiry (`js/lib/supabase.js`).

## Roles & permissions

Roles: `super_admin`, `admin`, `order_manager`, `product_manager`, `moderator`,
`marketing_manager`, `fulfillment_manager`, `support_agent`, `partner_admin`.

Permissions are data in `role_permissions` (e.g. `products.write`,
`orders.refund`, `moderation.review`). `super_admin` implicitly has all of them.
RLS policies call `has_permission('…')`, so changing what a role may do is an
`insert`/`delete` on `role_permissions` — audited automatically.

`partner_admin` rows carry a `partner_id` (constraint-enforced) so partner
users only ever see their own partner's data once the fulfillment tables land.

Grant the first super admin from the SQL editor:

```sql
insert into user_roles (user_id, role)
select id, 'super_admin' from auth.users where email = 'you@example.com';
```

## Row Level Security summary

| Data | Public | Customer | Staff |
|---|---|---|---|
| themes, visible categories/collections/designers | read | read | write with `catalog.write` |
| products (non-draft), variants, media, drops | read | read | write with `products.write` |
| draft products | — | — | read (any staff) |
| stock levels | read | read | change only via `adjust_inventory()` |
| edition counters | read | read | change only via `allocate_editions()` |
| profiles | — | own row | read with `customers.read` |
| audit log | — | — | read with `audit.read`; nobody writes directly |
| analytics events | insert via RPC | insert via RPC | read with `analytics.read` |
| customer artwork (storage) | — | own folder | read with `moderation.review` / `orders.read` |

## Audit log

`audit_row()` records actor, action, table, id, and full before/after JSON for
products, variants, drops, categories, collections, themes, roles, permissions
and settings. Price changes, inventory edits and role grants are therefore
traceable without extra code.

## Storage buckets

Public: `products`, `collections`, `limited-drops`, `archive`, `avatars`.
Private: `designs` (customer artwork, 25 MB, PNG/JPEG/WebP/SVG) and `mockups`.
Customers write only under `<their user id>/…`.
