-- Adds the Cyberpunk world to a database that already ran setup_all.sql.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.

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

-- ---------------------------------------------------------------------
-- Cyberpunk world (theme, category, collection, products, drop)
-- ---------------------------------------------------------------------
insert into public.themes (slug, name, config) values
('cyberpunk', 'Cyberpunk', '{
  "colors": {"bg":"#05060b","fg":"#dffcff","muted":"#7d93a6","accent":"#00f0ff","accent2":"#ff2bd6","surface":"#0b0f1a","surface_fg":"#dffcff","line":"#16314a"},
  "fonts":  {"display":"orbitron","body":"sharetech","bodyStyle":"normal","hand":"sharetech"},
  "background": {"effect":"cyber-rain","intensity":0.7},
  "hero":   {"style":"holo"},
  "intro":  {"effect":"boot-sequence","sound":"synth-boot","duration_ms":1500},
  "cards":  {"style":"hud"},
  "buttons":{"style":"chamfer"},
  "motion": {"level":"energetic"}
}')
on conflict (slug) do update set config = excluded.config, name = excluded.name;

insert into public.categories (slug, name, tagline, description, theme_id, sort_order, seo) values
('cyberpunk', 'Cyberpunk', 'Neon after midnight.', 'Chrome, rain and glowing signal — techwear graphics from a city that never logs off.',
 (select id from themes where slug = 'cyberpunk'), 2, '{"title":"Cyberpunk Collection"}')
on conflict (slug) do nothing;
-- keep it next to Anime in the menu
update public.categories set sort_order = sort_order + 1 where slug <> 'cyberpunk' and sort_order >= 2
  and exists (select 1 from categories c where c.slug <> 'cyberpunk' and c.sort_order = 2);

insert into public.collections (slug, name, description, category_id, designer_id, is_featured, sort_order) values
('night-market', 'Night Market', 'Signals picked up between the noodle stalls and the neon.', (select id from categories where slug='cyberpunk'), (select id from designers where slug='th8rty'), true, 5)
on conflict (slug) do nothing;

select from pg_temp.add_product('neon-ronin-hoodie', 'Neon Ronin Hoodie', 'hoodie', 'cyberpunk', 'night-market', 'th8rty',
  10800, null, 'active', 'A visor-masked ronin under cyan rain. Reflective back print that lights up under flash.',
  '450gsm fleece, reflective ink', array['cyberpunk','hoodie','reflective'],
  '[{"name":"Black","hex":"#0b0b10"},{"name":"Gunmetal","hex":"#3a3f48"}]', array['S','M','L','XL','XXL'], 22,
  '[{"text":"reflective back print","x":0.5,"y":0.45,"side":"right"},{"text":"sleeve barcode","x":0.12,"y":0.55,"side":"left"}]', true, true)
where not exists (select 1 from products where slug = 'neon-ronin-hoodie');

select from pg_temp.add_product('grid-runner-tee', 'Grid Runner Tee', 'tee', 'cyberpunk', 'night-market', 'th8rty',
  5400, null, 'active', 'Perspective grid running into a magenta horizon. Glow-in-the-dark front print.',
  '240gsm cotton, glow ink', array['cyberpunk','tee','glow'],
  '[{"name":"Black","hex":"#0b0b10"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL','XXL'], 34, '[]', false, true)
where not exists (select 1 from products where slug = 'grid-runner-tee');

select from pg_temp.add_product('data-rain-longsleeve', 'Data Rain Longsleeve', 'longsleeve', 'cyberpunk', 'night-market', 'th8rty',
  6800, null, 'active', 'Falling glyph columns down both sleeves.',
  '220gsm cotton', array['cyberpunk','longsleeve'],
  '[{"name":"Black","hex":"#0b0b10"}]', array['S','M','L','XL'], 18, '[]')
where not exists (select 1 from products where slug = 'data-rain-longsleeve');

select from pg_temp.add_product('neon-ghost-hoodie', 'Neon Ghost Hoodie', 'hoodie', 'cyberpunk', 'night-market', 'th8rty',
  12500, null, 'active', 'A ghost in the signal: holographic foil over black fleece. 300 numbered pieces.',
  '500gsm fleece, holographic foil', array['limited','cyberpunk'],
  '[{"name":"Black","hex":"#0b0b10"}]', array['S','M','L','XL','XXL'], 30,
  '[{"text":"holo foil chest","x":0.5,"y":0.36,"side":"right"}]', true)
where not exists (select 1 from products where slug = 'neon-ghost-hoodie');

insert into public.limited_drops (product_id, slug, drop_name, drop_number, edition_size, units_sold, release_at, story)
select id, 'neon-ghost-drop-007', 'NEON GHOST', 7, 300, 0, now() - interval '1 day', 'Seen only in reflections. 300 numbered pieces, then it vanishes into the archive.'
from public.products where slug = 'neon-ghost-hoodie'
on conflict (product_id) do nothing;

notify pgrst, 'reload schema';
