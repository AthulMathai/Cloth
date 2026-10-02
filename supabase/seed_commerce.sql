-- =====================================================================
-- DEVELOPMENT discount codes (fictional promotions for testing).
-- =====================================================================
insert into public.discounts (code, description, kind, value, scope, scope_ids, min_subtotal_cents, first_order_only, per_customer_limit, exclude_limited, buy_qty, get_qty, max_uses, ends_at) values
  ('WELCOME20', '20% off your first order', 'percent', 20, 'all', '{}', 0, true, 1, true, null, null, null, null),
  ('DROP10',    '$10 off orders over $50', 'fixed', 1000, 'all', '{}', 5000, false, null, false, null, null, 500, null),
  ('FREESHIP',  'Free shipping', 'free_shipping', 0, 'all', '{}', 0, false, null, false, null, null, null, null),
  ('ANIME15',   '15% off the Anime collection', 'percent', 15, 'categories',
     array[(select id from public.categories where slug = 'anime')], 0, false, null, true, null, null, null, null),
  ('BASICS3',   'Buy 2 essentials, get 1 free', 'bxgy', 0, 'collections',
     array[(select id from public.collections where slug = 'essentials')], 0, false, null, true, 2, 1, null, null),
  ('EXPIRED5',  'Old promo (expired, for testing)', 'percent', 5, 'all', '{}', 0, false, null, false, null, null, null, '2026-01-01')
on conflict (code) do nothing;
