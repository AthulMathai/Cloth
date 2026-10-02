-- =====================================================================
-- Custom designer checks: design save/versions, ownership, moderation
-- decision, bag, live pricing, checkout snapshot, frozen prices.
-- Run on a freshly seeded DEV DB. Everything rolls back.
-- =====================================================================
begin;
create temp table t (k text primary key, v jsonb);
grant all on t to anon, authenticated;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'designer@test.dev'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'other@test.dev');

-- ---- customer uploads artwork and saves a design ----------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

do $$
declare a uuid; d jsonb; v uuid;
begin
  a := design_register_asset('designs', 'aaaaaaaa-0000-0000-0000-000000000001/art-1.png', 'original', 'image/png', 120000, 2400, 2400, repeat('a', 64), 'my-dragon.png');
  v := (select pv.id from product_variants pv join products p on p.id = pv.product_id where p.slug = 'essential-hoodie' and pv.color = 'Black' and pv.size = 'XL');
  d := design_save(null, 'Moon dragon', (select id from products where slug = 'essential-hoodie'), v,
        jsonb_build_object(
          'layers', jsonb_build_array(
            jsonb_build_object('id','l1','type','image','placement','front','asset_id',a,'x_in',6,'y_in',6,'w_in',10,'h_in',10,'rotation',0),
            jsonb_build_object('id','l2','type','text','placement','back','text','TH8RTY CREW','font','anton','color','#ffffff','x_in',6,'y_in',3,'w_in',10,'h_in',2,'rotation',0)),
          'methods', jsonb_build_object('front','dtg','back','dtf'),
          'services', jsonb_build_array()));
  insert into t values ('design', d), ('asset', to_jsonb(a::text));
  assert (d->>'version')::int = 1 and d->>'status' = 'draft', 'saved v1 draft';
  assert (select count(*) from design_versions where design_id = (d->>'id')::uuid) = 1, 'version recorded';
end $$;

-- the print summary feeds the engine: front 10x10 (medium? 100 sq in = large), back 10x2
do $$
declare s jsonb := design_print_summary((select config from custom_designs where id = ((select v from t where k='design')->>'id')::uuid));
begin
  assert jsonb_array_length(s) = 2, 'two print areas';
  assert (s->0->>'placement') = 'front' and (s->0->>'width_in')::numeric = 10, 'front bbox';
end $$;

-- rotation widens the bounding box (10x2 rotated 90° -> 2x10)
do $$
declare s jsonb := design_print_summary('{"layers":[{"placement":"back","type":"text","text":"x","x_in":6,"y_in":8,"w_in":10,"h_in":2,"rotation":90}]}');
begin
  assert (s->0->>'width_in')::numeric = 2 and (s->0->>'height_in')::numeric = 10, 'rotated bbox ' || s::text;
end $$;

-- another customer can't use my artwork or see my design
set local request.jwt.claims = '{"role":"authenticated","sub":"aaaaaaaa-0000-0000-0000-000000000002"}';
do $$
begin
  begin
    perform design_save(null, 'stolen', (select id from products where slug = 'essential-tee'),
      (select pv.id from product_variants pv join products p on p.id = pv.product_id where p.slug = 'essential-tee' limit 1),
      jsonb_build_object('layers', jsonb_build_array(jsonb_build_object('type','image','placement','front',
        'asset_id', (select v #>> '{}' from t where k='asset'), 'x_in',5,'y_in',5,'w_in',4,'h_in',4))));
    raise exception 'used someone else''s artwork';
  exception when check_violation then null; end;
  assert design_get(((select v from t where k='design')->>'id')::uuid) is null, 'cannot read others'' designs';
  assert (select count(*) from custom_designs) = 0, 'RLS hides others'' designs';
  begin
    perform design_register_asset('designs', 'aaaaaaaa-0000-0000-0000-000000000001/x.png', 'original', 'image/png', 10);
    raise exception 'wrote into someone else''s folder';
  exception when insufficient_privilege then null; end;
end $$;

-- unapproved designs can't go in the bag
set local request.jwt.claims = '{"role":"authenticated","sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$ begin
  begin
    perform cart_add_design(null, ((select v from t where k='design')->>'id')::uuid, 1);
    raise exception 'draft design added to bag';
  exception when check_violation then null; end;
end $$;

-- submit -> moderation approves (service role)
do $$ begin perform design_submit(((select v from t where k='design')->>'id')::uuid); end $$;
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
declare r jsonb;
begin
  r := record_moderation(((select v from t where k='design')->>'id')::uuid, 1, 'mock', 5, 'approved', '[]',
                         array[((select v #>> '{}' from t where k='asset'))::uuid]);
  assert r->>'status' = 'approved', 'approved';
  assert (select verified from design_assets where id = ((select v #>> '{}' from t where k='asset'))::uuid), 'asset verified';
end $$;

-- ---- bag: live price follows quantity tiers ---------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
declare c jsonb; line jsonb; one int; ten int;
begin
  c := cart_add_design(null, ((select v from t where k='design')->>'id')::uuid, 1);
  line := c->'items'->0;
  assert line->>'item_type' = 'custom' and line->>'issue' is null, 'custom line ok: ' || coalesce(line->>'issue', '');
  one := (line->>'unit_price_cents')::int;
  -- expected below
  assert one = 10500, 'unit at qty 1: ' || one;  -- hoodie 78 + front 8 + large(100 sq in) 6 + back 8 + medium(20 sq in) 3 + DTF 2
  c := cart_set_line(null, (line->>'item_id')::uuid, 10);
  ten := (c->'items'->0->>'unit_price_cents')::int;
  assert ten = one - 400, '10+ tier takes $4 off: ' || ten;
  assert (c->'items'->0->>'line_total_cents')::int = ten * 10, 'line total';
  assert (c->'items'->0->'pricing') ? 'cost' = false, 'bag never shows costs';
  insert into t values ('line', c->'items'->0);
end $$;

-- quote threshold blocks the bag
do $$ begin
  begin
    perform cart_add_design(null, ((select v from t where k='design')->>'id')::uuid, 250);
    raise exception 'quote-size order added to bag';
  exception when check_violation then null; end;
end $$;

-- ---- checkout freezes the full breakdown ------------------------------
reset role;
set local request.jwt.claims = '{"role":"service_role"}';
do $$
declare o jsonb; p jsonb; snap jsonb;
begin
  o := create_order(null, 'aaaaaaaa-0000-0000-0000-000000000001', 'designer@test.dev', null,
        '{"full_name":"Des Igner","line1":"1 Queen St","city":"Toronto","province":"ON","postal_code":"M5H 2N2"}',
        'standard', null, 'custom-order-key-000001');
  insert into t values ('order', o);
  select snapshot into snap from order_items where order_id = (o->>'order_id')::uuid;
  assert snap->'pricing' ? 'cost' and snap->'pricing' ? 'rules', 'order keeps costs + rule versions';
  assert jsonb_array_length(snap->'pricing'->'rules') >= 5, 'rules recorded';
  assert snap ? 'design_config', 'design config frozen on the line';
  p := confirm_order_payment((o->>'order_id')::uuid, 'mock', 'pi_custom_1', (o->>'total_cents')::int, '{}');
  assert p->>'status' = 'fulfillment_pending', 'custom order -> fulfillment, got ' || (p->>'status');
  assert exists (select 1 from order_events where order_id = (o->>'order_id')::uuid and status = 'approved'), 'approval recorded in history';
end $$;

-- price rule changes don't touch the existing order
do $$
declare before int; after_ int;
begin
  before := (select line_total_cents from order_items where order_id = ((select v from t where k='order')->>'order_id')::uuid);
  update pricing_rules set customer_cents = 9999 where rule_type = 'placement' and placement = 'front';
  assert (select version from pricing_rules where rule_type = 'placement' and placement = 'front') = 2, 'rule version bumped';
  after_ := (select line_total_cents from order_items where order_id = ((select v from t where k='order')->>'order_id')::uuid);
  assert before = after_, 'order price frozen';
  assert (price_design_internal(((select v from t where k='design')->>'id')::uuid, 1)->>'unit_cents')::int > 10500, 'new price applies to new quotes';
end $$;

-- ---- editing an approved design sends it back for review --------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
do $$
declare d jsonb; c jsonb;
begin
  c := cart_add_design(null, ((select v from t where k='design')->>'id')::uuid, 2);
  d := design_save(((select v from t where k='design')->>'id')::uuid, 'Moon dragon v2',
        (select product_id from custom_designs where id = ((select v from t where k='design')->>'id')::uuid),
        (select variant_id from custom_designs where id = ((select v from t where k='design')->>'id')::uuid),
        (select config from custom_designs where id = ((select v from t where k='design')->>'id')::uuid));
  assert (d->>'version')::int = 2 and d->>'status' = 'draft', 'v2 draft';
  c := cart_get(null);
  assert (c->'items'->0->>'issue') like 'Design changed%', 'bag flags the changed design: ' || coalesce(c->'items'->0->>'issue', 'none');
  c := cart_set_line(null, (c->'items'->0->>'item_id')::uuid, 0);
  assert jsonb_array_length(c->'items') = 0, 'line removed';
end $$;

-- ---- quote request ----------------------------------------------------
do $$
declare q jsonb;
begin
  q := submit_quote_request('Des Igner', 'designer@test.dev', null, (select id from products where slug = 'essential-hoodie'),
        ((select v from t where k='design')->>'id')::uuid, 400, '{"M":150,"L":150,"XL":100}', 'Black', 'Front + back', null, 'Team order');
  assert q->>'number' like 'Q-%', 'quote created';
  assert (select estimate->>'quote_required' from quote_requests where id = (q->>'id')::uuid) = 'true', 'estimate stored';
end $$;

select 'custom designer: all checks passed' as result;
rollback;
