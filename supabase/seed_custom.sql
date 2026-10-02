
-- =====================================================================
-- DEVELOPMENT blanks for the Custom Designer (fictional catalogue).
-- =====================================================================
create or replace function pg_temp.add_product(
  p_slug text, p_name text, p_type text, p_cat text, p_coll text, p_designer text,
  p_price int, p_sale int, p_status product_status, p_desc text, p_materials text,
  p_tags text[], p_colors jsonb, p_sizes text[], p_stock int, p_callouts jsonb,
  p_featured boolean default false, p_customizable boolean default false, p_publish_at timestamptz default null)
returns uuid language plpgsql as $$
declare v_id uuid; c jsonb; s text; i int := 0;
begin
  insert into products (slug, name, product_type, category_id, collection_id, designer_id,
      base_price_cents, sale_price_cents, status, description, materials, tags,
      print_locations, print_methods, sku, sketch_callouts, is_featured, is_customizable, publish_at, weight_grams)
  values (p_slug, p_name, p_type,
      (select id from categories where slug = p_cat), (select id from collections where slug = p_coll),
      (select id from designers where slug = p_designer),
      p_price, p_sale, p_status, p_desc, p_materials, p_tags,
      case p_type when 'hoodie' then array['front','back','left_sleeve','right_sleeve','left_chest'] else array['front','back','left_chest'] end,
      array['dtg','dtf'], upper(replace(p_slug, '-', '')), p_callouts, p_featured, p_customizable, p_publish_at,
      case p_type when 'hoodie' then 780 when 'crewneck' then 620 else 240 end)
  returning id into v_id;

  for c in select * from jsonb_array_elements(p_colors) loop
    foreach s in array p_sizes loop
      i := i + 1;
      insert into product_variants (product_id, sku, size, color, color_hex, price_cents, inventory_on_hand, sort_order)
      values (v_id, upper(replace(p_slug,'-','')) || '-' || upper(left(c->>'name', 3)) || '-' || s, s, c->>'name', c->>'hex',
              case when s in ('XXL','3XL') then p_price + 300 else null end,
              greatest(0, p_stock - (i % 4) * 3), i);
    end loop;
  end loop;
  return v_id;
end $$;

select from pg_temp.add_product('essential-crewneck', 'Essential Crewneck', 'crewneck', 'minimal', 'essentials', 'th8rty',
  6800, null, 'active', 'Heavyweight blank crewneck for custom prints.', '400gsm loopback cotton', array['minimal','crewneck','blank'],
  '[{"name":"Black","hex":"#141414"},{"name":"Heather","hex":"#9b9a97"},{"name":"Cream","hex":"#efe6d2"}]', array['S','M','L','XL','XXL'], 40, '[]', false, true)
where not exists (select 1 from products where slug = 'essential-crewneck');

select from pg_temp.add_product('essential-longsleeve', 'Essential Longsleeve', 'longsleeve', 'minimal', 'essentials', 'th8rty',
  4600, null, 'active', 'Blank longsleeve with room for sleeve prints.', '220gsm cotton', array['minimal','longsleeve','blank'],
  '[{"name":"Black","hex":"#141414"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL','XXL'], 40, '[]', false, true)
where not exists (select 1 from products where slug = 'essential-longsleeve');

select from pg_temp.add_product('essential-tank', 'Essential Tank', 'tank', 'minimal', 'essentials', 'th8rty',
  3000, null, 'active', 'Lightweight blank tank.', '180gsm cotton', array['minimal','tank','blank'],
  '[{"name":"Black","hex":"#141414"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL'], 30, '[]', false, true)
where not exists (select 1 from products where slug = 'essential-tank');

-- Deeper blank stock so bulk custom orders can be tested.
update public.product_variants v set inventory_on_hand = greatest(inventory_on_hand, 400)
from public.products p where p.id = v.product_id and p.slug in ('essential-tee','essential-hoodie','essential-crewneck','essential-longsleeve','essential-tank')
;
update public.products set cost_cents = case product_type when 'hoodie' then 1850 when 'crewneck' then 1500 when 'longsleeve' then 950 when 'tank' then 650 else 700 end
 where cost_cents is null;
