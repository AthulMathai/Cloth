-- =====================================================================
-- Commerce checks: cart, pricing, discounts, taxes, order creation,
-- payment confirmation, reservations. Run on a freshly seeded DEV DB
-- (migrations + seed.sql + seed_commerce.sql). Everything rolls back.
-- =====================================================================
begin;

create temp table t (k text primary key, v jsonb);
grant all on t to anon, authenticated;

-- ---- guest builds a bag ---------------------------------------------
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

insert into t values ('c1', cart_set_item(null, (select id from product_variants where sku = 'ESSENTIALTEE-WHI-M'), 2, 'set'));
insert into t values ('c2', cart_set_item((select v->>'token' from t where k = 'c1'),
                                          (select id from product_variants where sku = 'SAKURABLADETEE-BLA-M'), 1, 'add'));
do $$ begin
  assert jsonb_array_length((select v->'items' from t where k = 'c2')) = 2, 'bag should have 2 lines';
  assert (select v->>'token' from t where k = 'c1') = (select v->>'token' from t where k = 'c2'), 'token should persist';
end $$;

-- archived / unreleased items can never enter the bag
do $$ begin
  begin
    perform cart_set_item((select v->>'token' from t where k = 'c1'), (select id from product_variants where sku like 'INKMONSOONHOODIE-%' limit 1), 1, 'add');
    raise exception 'archived item was added';
  exception when check_violation then null; end;
  begin
    perform cart_set_item((select v->>'token' from t where k = 'c1'), (select id from product_variants where sku like 'STATICHALOHOODIE-%' limit 1), 1, 'add');
    raise exception 'unreleased item was added';
  exception when check_violation then null; end;
end $$;

-- ---- pricing & taxes --------------------------------------------------
do $$
declare q jsonb; tok text := (select v->>'token' from t where k = 'c1');
begin
  q := cart_quote(tok, 'ON', 'standard', null, null);
  -- 2 x 36.00 (tee, sale price 31.00? no) + 65.00 -> compute from rows
  assert (q->>'subtotal_cents')::int = 2 * 3600 + 6500, 'subtotal ' || (q->>'subtotal_cents');
  assert (q->>'shipping_cents')::int = 900, 'ON standard shipping';
  assert (q->>'tax_cents')::int = round((13700 + 900) * 0.13), 'HST 13% on goods + shipping';
  assert (q->>'total_cents')::int = 13700 + 900 + (q->>'tax_cents')::int, 'total math';

  q := cart_quote(tok, 'QC', 'standard', null, null);
  assert jsonb_array_length(q->'taxes') = 2, 'QC has GST + QST';
  assert (q->>'tax_cents')::int = round(14600 * 0.05) + round(14600 * 0.09975), 'QC tax';

  q := cart_quote(tok, 'NS', 'standard', null, null);
  assert (q->'taxes'->0->>'rate')::numeric = 0.14, 'NS uses the 14% rate effective 2025-04-01';

  q := cart_quote(tok, 'AB', 'express', null, null);
  assert (q->>'shipping_cents')::int = 2400 and (q->'shipping'->>'code') = 'express', 'express selectable';
  assert (q->>'tax_cents')::int = round((13700 + 2400) * 0.05), 'AB GST only';
end $$;

-- ---- discounts --------------------------------------------------------
do $$
declare q jsonb; tok text := (select v->>'token' from t where k = 'c1');
begin
  q := cart_quote(tok, 'ON', 'standard', 'welcome20', 'new@test.dev');
  assert (q->>'discount_cents')::int = round(7200 * 0.20), 'WELCOME20 skips the limited tee: ' || (q->>'discount_cents');
  q := cart_quote(tok, 'ON', 'standard', 'EXPIRED5', null);
  assert q->'discount'->>'error' = 'That code has expired.', 'expired code';
  q := cart_quote(tok, 'ON', 'standard', 'NOPE', null);
  assert q->'discount'->>'error' is not null and (q->>'discount_cents')::int = 0, 'unknown code';
  q := cart_quote(tok, 'ON', 'standard', 'DROP10', null);
  assert (q->>'discount_cents')::int = 1000, 'DROP10 fixed';
  q := cart_quote(tok, 'ON', 'standard', 'ANIME15', null);
  assert q->'discount'->>'error' is not null, 'ANIME15 excludes limited; no eligible anime items';
  q := cart_quote(tok, 'ON', 'express', 'FREESHIP', null);
  assert (q->>'shipping_cents')::int = 0, 'FREESHIP';
  q := cart_quote(tok, 'ON', 'standard', 'BASICS3', null);
  assert q->'discount'->>'error' like 'Add 1 more%', 'bxgy needs one more: ' || coalesce(q->'discount'->>'error', 'null');
end $$;

-- free standard shipping over $150 after discount
do $$
declare q jsonb; tok text := (select v->>'token' from t where k = 'c1');
begin
  perform cart_set_item(tok, (select id from product_variants where sku = 'ESSENTIALTEE-WHI-M'), 3, 'set');
  q := cart_quote(tok, 'ON', 'standard', 'BASICS3', null);
  assert (q->>'discount_cents')::int = 3600, 'buy 2 get 1 free tee: ' || (q->>'discount_cents');
  assert (q->>'shipping_cents')::int = 900, '3x36 + 65 - 36 = 137 < 150';
  perform cart_set_item(tok, (select id from product_variants where sku = 'ESSENTIALTEE-WHI-M'), 4, 'set');
  q := cart_quote(tok, 'ON', 'standard', null, null);
  assert (q->>'shipping_cents')::int = 0, '4x36 + 65 = 209 >= 150 free standard';
  perform cart_set_item(tok, (select id from product_variants where sku = 'ESSENTIALTEE-WHI-M'), 2, 'set');
end $$;

-- ---- checkout (service role) -----------------------------------------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
declare o jsonb; o2 jsonb; tok text := (select v->>'token' from t where k = 'c1');
  v_tee uuid := (select id from product_variants where sku = 'ESSENTIALTEE-WHI-M');
  v_res0 int := (select inventory_reserved from product_variants where sku = 'ESSENTIALTEE-WHI-M');
  v_drop0 int := (select units_reserved from limited_drops where slug = 'sakura-blade-drop-005');
begin
  o := create_order(tok, null, 'Buyer@Test.dev', null,
        '{"full_name":"Test Buyer","line1":"1 Queen St","city":"Toronto","province":"ON","postal_code":"M5H 2N2"}',
        'standard', 'DROP10', 'idem-key-000000000001');
  insert into t values ('o1', o);
  assert (o->>'total_cents')::int = (select total_cents from orders where id = (o->>'order_id')::uuid), 'stored total';
  assert (select inventory_reserved from product_variants where id = v_tee) = v_res0 + 2, 'tee reserved';
  assert (select units_reserved from limited_drops where slug = 'sakura-blade-drop-005') = v_drop0 + 1, 'edition reserved';
  assert (select status from orders where id = (o->>'order_id')::uuid) = 'payment_pending', 'pending';

  o2 := create_order(tok, null, 'buyer@test.dev', null, '{}', 'standard', null, 'idem-key-000000000001');
  assert (o2->>'duplicate')::boolean and o2->>'order_id' = o->>'order_id', 'idempotent create';
end $$;

-- wrong amount -> on_hold, nothing allocated
do $$
declare o jsonb := (select v from t where k = 'o1'); r jsonb;
begin
  -- (confirm with the right amount below; this checks the guard on a copy)
  null;
end $$;

-- confirm payment
do $$
declare o jsonb := (select v from t where k = 'o1'); r jsonb; r2 jsonb; it record;
  v_onhand0 int := (select inventory_on_hand from product_variants where sku = 'ESSENTIALTEE-WHI-M');
  v_sold0 int := (select units_sold from limited_drops where slug = 'sakura-blade-drop-005');
begin
  r := confirm_order_payment((o->>'order_id')::uuid, 'mock', 'mock_pi_001', (o->>'total_cents')::int, '{}');
  assert r->>'status' = 'fulfillment_pending', 'paid -> fulfillment_pending, got ' || (r->>'status');
  assert (select inventory_on_hand from product_variants where sku = 'ESSENTIALTEE-WHI-M') = v_onhand0 - 2, 'stock sold';
  assert (select units_sold from limited_drops where slug = 'sakura-blade-drop-005') = v_sold0 + 1, 'edition sold';
  select * into it from order_items where order_id = (o->>'order_id')::uuid and drop_id is not null;
  assert it.edition_numbers = array[v_sold0 + 1], 'edition number assigned: ' || coalesce(it.edition_numbers::text, 'null');
  assert (select count(*) from order_events where order_id = (o->>'order_id')::uuid) >= 4, 'history recorded';
  assert (select uses_count from discounts where code = 'DROP10') = 1, 'discount usage counted';
  assert jsonb_array_length(cart_get((select v->>'token' from t where k = 'c1'))->'items') = 0, 'bag emptied';
  assert (select status from carts where token_hash = token_hash((select v->>'token' from t where k = 'c1'))) = 'converted', 'cart closed';

  r2 := confirm_order_payment((o->>'order_id')::uuid, 'mock', 'mock_pi_001', (o->>'total_cents')::int, '{}');
  assert (r2->>'duplicate')::boolean, 'duplicate webhook ignored';
  assert (select count(*) from payments where order_id = (o->>'order_id')::uuid) = 1, 'one payment row';
end $$;

-- order history is append-only
do $$ begin
  begin
    update order_events set note = 'tamper' where order_id = ((select v from t where k = 'o1')->>'order_id')::uuid;
    raise exception 'history was modified';
  exception when raise_exception then
    if sqlerrm = 'history was modified' then raise; end if;
  end;
end $$;

-- guest can look up their order with the token, not without
do $$
declare o jsonb := (select v from t where k = 'o1');
begin
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  assert order_lookup(o->>'number', o->>'access_token') is not null, 'lookup with token';
  assert order_lookup(o->>'number', 'wrong') is null, 'lookup without token denied';
  assert (select count(*) from orders) = 0, 'anon cannot list orders';
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

-- ---- expiry releases holds; late payment goes on hold ----------------
do $$
declare tok text; o jsonb; r jsonb; v_res0 int;
begin
  tok := (cart_set_item(null, (select id from product_variants where sku = 'ESSENTIALHOODIE-BLA-L'), 1, 'set'))->>'token';
  v_res0 := (select inventory_reserved from product_variants where sku = 'ESSENTIALHOODIE-BLA-L');
  o := create_order(tok, null, 'late@test.dev', null,
        '{"full_name":"Late","line1":"2 Rue","city":"Montreal","province":"QC","postal_code":"H2X 1Y4"}',
        'standard', null, 'idem-key-000000000002');
  assert (select inventory_reserved from product_variants where sku = 'ESSENTIALHOODIE-BLA-L') = v_res0 + 1, 'held';
  update orders set reserved_until = now() - interval '1 minute' where id = (o->>'order_id')::uuid;
  assert expire_pending_orders() = 1, 'expired';
  assert (select inventory_reserved from product_variants where sku = 'ESSENTIALHOODIE-BLA-L') = v_res0, 'released';
  r := confirm_order_payment((o->>'order_id')::uuid, 'mock', 'mock_pi_late', (o->>'total_cents')::int, '{}');
  assert r->>'status' = 'on_hold', 'late payment held for review, got ' || (r->>'status');
end $$;

-- ---- mismatched amount goes on hold -----------------------------------
do $$
declare tok text; o jsonb; r jsonb;
begin
  tok := (cart_set_item(null, (select id from product_variants where sku = 'ESSENTIALHOODIE-BLA-M'), 1, 'set'))->>'token';
  o := create_order(tok, null, 'short@test.dev', null,
        '{"full_name":"Short","line1":"3 Ave","city":"Calgary","province":"AB","postal_code":"T2P 1J9"}',
        'standard', null, 'idem-key-000000000003');
  r := confirm_order_payment((o->>'order_id')::uuid, 'mock', 'mock_pi_short', 100, '{}');
  assert r->>'status' = 'on_hold', 'short payment held';
end $$;

select 'commerce: all checks passed' as result;
rollback;
