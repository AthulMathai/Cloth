-- =====================================================================
-- Integrity checks for the catalog / limited-edition layer.
-- Run against a freshly seeded DEV database:
--   psql "$DATABASE_URL" -f supabase/tests/catalog_integrity.sql
-- Each block raises an exception if an invariant is broken.
-- (Concurrency is covered by scripts in docs/limited-editions.md.)
-- =====================================================================
begin;

-- 1. Selling the last editions flips the product to sold_out, numbers are unique.
do $$
declare d uuid; remaining int; got int[];
begin
  select id, edition_size - units_sold into d, remaining from limited_drops where slug = 'cyber-samurai-drop-004';
  got := allocate_editions(d, remaining);
  assert got[array_length(got, 1)] = 500, 'last number should be 500';
  assert (select count(distinct edition_number) from edition_allocations where drop_id = d) = 500, 'duplicate edition numbers';
  assert (select status from products p join limited_drops l on l.product_id = p.id where l.id = d) = 'sold_out', 'not sold_out';
end $$;

-- 2. No further purchase is possible.
do $$
declare d uuid;
begin
  select id into d from limited_drops where slug = 'cyber-samurai-drop-004';
  begin
    perform allocate_editions(d, 1);
    raise exception 'allocation after sell-out should fail';
  exception when check_violation then null;
  end;
end $$;

-- 3. An exhausted edition can't be reactivated by any update.
do $$
begin
  begin
    update products set status = 'active' where slug = 'cyber-samurai-hoodie';
    raise exception 'reactivating an exhausted drop should fail';
  exception when check_violation then null;
  end;
end $$;

-- 4. Archive transition honours archive_delay and keeps the record.
do $$
begin
  assert archive_due_drops() = 0, 'archived before delay';
  update limited_drops set archive_delay = interval '0' where slug = 'cyber-samurai-drop-004';
  assert archive_due_drops() = 1, 'not archived after delay';
  assert exists (select 1 from archive_drops where slug = 'cyber-samurai-drop-004'), 'missing from archive';
  assert not (select is_purchasable from storefront_products where slug = 'cyber-samurai-hoodie'), 'archived product purchasable';
end $$;

-- 5. Unreleased drops can't be bought early.
do $$
declare d uuid;
begin
  select id into d from limited_drops where slug = 'static-halo-drop-006';
  begin
    perform allocate_editions(d, 1);
    raise exception 'pre-release allocation should fail';
  exception when check_violation then null;
  end;
end $$;

-- 6. Stock can't go negative.
do $$
begin
  begin
    perform adjust_inventory((select id from product_variants where sku = 'ESSENTIALTEE-WHI-M'), -100000, 'adjustment');
    raise exception 'negative stock should fail';
  exception when check_violation then null;
  end;
end $$;

select 'catalog integrity: all checks passed' as result;
rollback;
