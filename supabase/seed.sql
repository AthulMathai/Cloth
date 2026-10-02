-- =====================================================================
-- DEVELOPMENT SEED DATA — fictional products, designers and drops so the
-- whole storefront can be demonstrated. Do not run against production.
-- (Supabase runs supabase/seed.sql on `supabase db reset`.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Store settings
-- ---------------------------------------------------------------------
insert into public.store_settings (key, value, is_public) values
  ('store.name',        '"TH8RTY"', true),
  ('store.tagline',     '"Wear your idea."', true),
  ('store.currency',    '"CAD"', true),
  ('home.theme',        '"th8rty"', true),
  -- 'varsity-arch' (outlined collegiate arch) or 'script' (flourished calligraphy)
  ('home.header_style', '"varsity-arch"', true),
  ('home.hero', '{"headline":"TH8RTY","sub":"wear your idea...","cta_label":"Start designing","cta_href":"/custom"}', true),
  -- which theme each non-category page wears
  ('pages.themes', '{"home":"th8rty","shop":"th8rty","drops":"th8rty","archive":"archive","custom":"th8rty","account":"th8rty","search":"th8rty"}', true),
  ('home.story', '{"title":"Drawn before it''s sewn.","body":"Every piece starts in the sketchbook — circled, crossed out, redrawn — before it ever touches fabric. What you wear is the page we couldn''t stop drawing."}', true)
on conflict (key) do update set value = excluded.value, is_public = excluded.is_public;

-- ---------------------------------------------------------------------
-- Themes
-- ---------------------------------------------------------------------
insert into public.themes (slug, name, config) values
('th8rty', 'TH8RTY — house artist', '{
  "colors": {"bg":"#0b0b0c","fg":"#f2f0ec","muted":"#8f8b85","accent":"#d42a2f","accent2":"#efebe3","surface":"#f3efe6","surface_fg":"#151515","line":"#2a2a2a"},
  "fonts":  {"display":"anton","script":"monsieur","body":"inter","bodyStyle":"italic","hand":"marker"},
  "background": {"effect":"tv-static","intensity":0.5},
  "hero":   {"style":"varsity-arch"},
  "intro":  {"effect":"static-cut","sound":"tv-click","duration_ms":700},
  "cards":  {"style":"sketch-callout"},
  "buttons":{"style":"varsity-outline"},
  "motion": {"level":"normal"}
}'),
('anime', 'Anime', '{
  "colors": {"bg":"#0a0710","fg":"#fff3f6","muted":"#b59aaa","accent":"#ff4f8b","accent2":"#ffd1df","surface":"#150c1d","surface_fg":"#fff3f6","line":"#3a2134"},
  "fonts":  {"display":"dela","body":"inter","bodyStyle":"normal","hand":"dela"},
  "background": {"effect":"anime-sky","intensity":0.8},
  "hero":   {"style":"manga-slash"},
  "intro":  {"effect":"petal-storm","sound":"anime-whoosh","duration_ms":1900},
  "cards":  {"style":"manga-panel"},
  "buttons":{"style":"slash"},
  "motion": {"level":"energetic"}
}'),
('streetwear', 'Streetwear', '{
  "colors": {"bg":"#101010","fg":"#f4f4ef","muted":"#8a8a83","accent":"#c8ff00","accent2":"#ff3b1f","surface":"#1a1a1a","surface_fg":"#f4f4ef","line":"#2c2c2c"},
  "fonts":  {"display":"anton","body":"mono","bodyStyle":"normal","hand":"marker"},
  "background": {"effect":"grain","intensity":0.6},
  "hero":   {"style":"stacked"},
  "intro":  {"effect":"glitch","sound":"bass-hit","duration_ms":800},
  "cards":  {"style":"sticker"},
  "buttons":{"style":"solid"},
  "motion": {"level":"energetic"}
}'),
('faith', 'Faith', '{
  "colors": {"bg":"#f4efe4","fg":"#29241f","muted":"#7d7366","accent":"#a5803f","accent2":"#e8dcc4","surface":"#fbf8f1","surface_fg":"#29241f","line":"#d9cfbd"},
  "fonts":  {"display":"cormorant","body":"cormorant","bodyStyle":"normal","hand":"pinyon"},
  "background": {"effect":"light-rays","intensity":0.5},
  "hero":   {"style":"serif-centered"},
  "intro":  {"effect":"light-bloom","sound":"chime","duration_ms":1200},
  "cards":  {"style":"gallery"},
  "buttons":{"style":"ghost"},
  "motion": {"level":"calm"}
}'),
('minimal', 'Minimal', '{
  "colors": {"bg":"#f7f7f5","fg":"#111111","muted":"#77756f","accent":"#111111","accent2":"#e6e5e1","surface":"#ffffff","surface_fg":"#111111","line":"#e2e1dc"},
  "fonts":  {"display":"inter","body":"inter","bodyStyle":"normal","hand":"inter"},
  "background": {"effect":"none"},
  "hero":   {"style":"stacked"},
  "intro":  {"effect":"fade","sound":null,"duration_ms":400},
  "cards":  {"style":"plain"},
  "buttons":{"style":"ghost"},
  "motion": {"level":"calm"}
}'),
('archive', 'Archive — museum', '{
  "colors": {"bg":"#1c1b19","fg":"#ece6da","muted":"#8e877a","accent":"#c9b48a","accent2":"#2a2825","surface":"#252320","surface_fg":"#ece6da","line":"#3a3732"},
  "fonts":  {"display":"cormorant","body":"inter","bodyStyle":"normal","hand":"cormorant"},
  "background": {"effect":"none"},
  "hero":   {"style":"serif-centered"},
  "intro":  {"effect":"fade","sound":null,"duration_ms":700},
  "cards":  {"style":"gallery"},
  "buttons":{"style":"ghost"},
  "motion": {"level":"calm"}
}'),
('seasonal-fall', 'Seasonal — Fall', '{
  "colors": {"bg":"#1a110b","fg":"#f6ead9","muted":"#a8927a","accent":"#e0782c","accent2":"#7a3b1d","surface":"#24170f","surface_fg":"#f6ead9","line":"#3b2919"},
  "fonts":  {"display":"anton","body":"inter","bodyStyle":"normal","hand":"marker"},
  "background": {"effect":"grain","intensity":0.35},
  "hero":   {"style":"stacked"},
  "intro":  {"effect":"fade","sound":null,"duration_ms":600},
  "cards":  {"style":"gallery"},
  "buttons":{"style":"solid"},
  "motion": {"level":"normal"}
}');

-- ---------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------
insert into public.categories (slug, name, tagline, description, theme_id, sort_order, seo) values
('th8rty',     'TH8RTY',     'Straight out the sketchbook.', 'The house artist''s line — every piece drawn by hand first.', (select id from themes where slug='th8rty'), 0, '{"title":"TH8RTY — Artist Collection"}'),
('anime',      'Anime',      'Petals. Blades. Big feelings.', 'Original anime-inspired graphics, drawn in-house.', (select id from themes where slug='anime'), 1, '{"title":"Anime Collection"}'),
('streetwear', 'Streetwear', 'Loud by design.', 'Heavyweight blanks, bold prints, nothing quiet.', (select id from themes where slug='streetwear'), 2, '{"title":"Streetwear"}'),
('faith',      'Faith',      'Grace, worn daily.', 'Quiet pieces with meaning stitched in.', (select id from themes where slug='faith'), 3, '{"title":"Faith Collection"}'),
('minimal',    'Minimal',    'Less, but better.', 'Essentials without the noise.', (select id from themes where slug='minimal'), 4, '{"title":"Minimal Essentials"}'),
('seasonal',   'Seasonal',   'Fall ''26.', 'Limited seasonal colourways.', (select id from themes where slug='seasonal-fall'), 5, '{"title":"Seasonal"}');

-- ---------------------------------------------------------------------
-- Designers (fictional, development only)
-- ---------------------------------------------------------------------
insert into public.designers (slug, name, bio, is_house, socials) values
('th8rty',       'TH8RTY',        'House artist and the face of the brand. Works in ballpoint first, fabric second.', true, '{"instagram":"#"}'),
('kaze-studio',  'Kaze Studio',   'Fictional dev-seed illustration studio specialising in anime linework.', false, '{}'),
('lumen-atelier','Lumen Atelier', 'Fictional dev-seed designer for the Faith collection.', false, '{}');

-- ---------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------
insert into public.collections (slug, name, description, category_id, designer_id, is_featured, sort_order) values
('sketchbook-01', 'Sketchbook 01', 'Pages pulled straight from the notebook: circled, crossed out, kept.', (select id from categories where slug='th8rty'), (select id from designers where slug='th8rty'), true, 0),
('petal-storm',   'Petal Storm',   'A thousand blades of blossom.', (select id from categories where slug='anime'), (select id from designers where slug='kaze-studio'), true, 1),
('static-season', 'Static Season', 'Signal lost. Style found.', (select id from categories where slug='streetwear'), (select id from designers where slug='th8rty'), true, 2),
('grace-notes',   'Grace Notes',   'Small words, held close.', (select id from categories where slug='faith'), (select id from designers where slug='lumen-atelier'), false, 3),
('essentials',    'Essentials',    'The blanks everything else is built on.', (select id from categories where slug='minimal'), (select id from designers where slug='th8rty'), false, 4);

-- ---------------------------------------------------------------------
-- Products. Helper: insert product + size/colour variant grid.
-- ---------------------------------------------------------------------
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

-- TH8RTY / Sketchbook 01
select from pg_temp.add_product('sketchbook-hoodie', 'Sketchbook Hoodie', 'hoodie', 'th8rty', 'sketchbook-01', 'th8rty',
  9800, null, 'active', 'The first page of the notebook, puff-printed across the chest. Oversized, dropped shoulder, built to be lived in.',
  '450gsm brushed cotton fleece', array['th8rty','hoodie','puff print'],
  '[{"name":"Black","hex":"#141414"},{"name":"Bone","hex":"#e9e3d6"}]', array['S','M','L','XL','XXL'], 24,
  '[{"text":"puff print — arte detail","x":0.5,"y":0.36,"side":"right"},{"text":"oversized hood","x":0.5,"y":0.06,"side":"left"},{"text":"drop shoulder","x":0.18,"y":0.22,"side":"left"},{"text":"embroidered tag","x":0.62,"y":0.86,"side":"right"}]', true, true);

select from pg_temp.add_product('margin-notes-tee', 'Margin Notes Tee', 'tee', 'th8rty', 'sketchbook-01', 'th8rty',
  4800, null, 'active', 'Crossed-out lettering and circled notes, exactly as they were drawn. Back print, small chest hit.',
  '240gsm heavyweight cotton', array['th8rty','tee','back print'],
  '[{"name":"White","hex":"#f4f2ee"},{"name":"Black","hex":"#141414"}]', array['S','M','L','XL','XXL'], 40,
  '[{"text":"chest hit — 3 in","x":0.62,"y":0.3,"side":"right"},{"text":"heavyweight 240gsm","x":0.3,"y":0.6,"side":"left"},{"text":"boxy fit","x":0.84,"y":0.2,"side":"right"}]', true, true);

select from pg_temp.add_product('crossed-out-crewneck', 'Crossed Out Crewneck', 'crewneck', 'th8rty', 'sketchbook-01', 'th8rty',
  8200, 6900, 'active', 'The name we almost used, struck through and kept anyway. Embroidered front.',
  '400gsm loopback cotton', array['th8rty','crewneck','embroidery'],
  '[{"name":"Heather","hex":"#9b9a97"},{"name":"Black","hex":"#141414"}]', array['S','M','L','XL'], 18,
  '[{"text":"bordado — embroidery","x":0.5,"y":0.38,"side":"right"},{"text":"ribbed collar","x":0.5,"y":0.05,"side":"left"},{"text":"raglan sleeve","x":0.15,"y":0.4,"side":"left"}]', false, false);

-- Anime / Petal Storm
select from pg_temp.add_product('petal-storm-hoodie', 'Petal Storm Hoodie', 'hoodie', 'anime', 'petal-storm', 'kaze-studio',
  10400, null, 'active', 'A thousand blossom blades spiralling up the back. Original artwork by Kaze Studio.',
  '450gsm cotton fleece', array['anime','sakura','hoodie'],
  '[{"name":"Black","hex":"#141414"},{"name":"Plum","hex":"#3b1830"}]', array['S','M','L','XL','XXL'], 20,
  '[{"text":"full back petal spiral","x":0.5,"y":0.45,"side":"right"},{"text":"sleeve kanji","x":0.12,"y":0.55,"side":"left"}]', true, true);

select from pg_temp.add_product('rising-sun-tee', 'Rising Sun Tee', 'tee', 'anime', 'petal-storm', 'kaze-studio',
  5200, null, 'active', 'Speed lines breaking from a crimson sun. Front print.',
  '240gsm cotton', array['anime','tee'],
  '[{"name":"Black","hex":"#141414"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL','XXL'], 35,
  '[{"text":"speed-line front","x":0.5,"y":0.4,"side":"right"}]', false, true);

select from pg_temp.add_product('ronin-longsleeve', 'Ronin Longsleeve', 'longsleeve', 'anime', 'petal-storm', 'kaze-studio',
  6400, null, 'active', 'Brush-stroke ronin silhouette with sleeve script.',
  '220gsm cotton', array['anime','longsleeve'],
  '[{"name":"Black","hex":"#141414"}]', array['S','M','L','XL'], 14,
  '[{"text":"sleeve script","x":0.1,"y":0.6,"side":"left"}]');

-- Streetwear / Static Season
select from pg_temp.add_product('signal-lost-hoodie', 'Signal Lost Hoodie', 'hoodie', 'streetwear', 'static-season', 'th8rty',
  9600, null, 'active', 'Static-noise print with a dead-channel test card on the back.',
  '450gsm fleece', array['streetwear','hoodie','static'],
  '[{"name":"Black","hex":"#141414"},{"name":"Acid","hex":"#c8ff00"}]', array['S','M','L','XL','XXL'], 22,
  '[{"text":"test-card back","x":0.5,"y":0.45,"side":"right"}]', true, true);

select from pg_temp.add_product('channel-00-tee', 'Channel 00 Tee', 'tee', 'streetwear', 'static-season', 'th8rty',
  4600, null, 'out_of_stock', 'Channel zero. Back in soon.',
  '240gsm cotton', array['streetwear','tee'],
  '[{"name":"Black","hex":"#141414"}]', array['S','M','L','XL'], 0, '[]');

-- Faith / Grace Notes
select from pg_temp.add_product('grace-notes-crewneck', 'Grace Notes Crewneck', 'crewneck', 'faith', 'grace-notes', 'lumen-atelier',
  7800, null, 'active', 'A single line of script, embroidered small over the heart.',
  '400gsm loopback cotton', array['faith','crewneck','embroidery'],
  '[{"name":"Cream","hex":"#efe6d2"},{"name":"Sage","hex":"#a7b39a"}]', array['S','M','L','XL'], 16,
  '[{"text":"tonal script embroidery","x":0.62,"y":0.3,"side":"right"}]', true, false);

select from pg_temp.add_product('psalm-tee', 'Psalm Tee', 'tee', 'faith', 'grace-notes', 'lumen-atelier',
  4400, null, 'active', 'Quiet back print, soft hand feel.',
  '200gsm cotton', array['faith','tee'],
  '[{"name":"Cream","hex":"#efe6d2"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL'], 30, '[]');

-- Minimal
select from pg_temp.add_product('essential-tee', 'Essential Tee', 'tee', 'minimal', 'essentials', 'th8rty',
  3600, null, 'active', 'The blank. Also the base for the Custom Designer.',
  '240gsm cotton', array['minimal','tee','blank'],
  '[{"name":"White","hex":"#f4f2ee"},{"name":"Black","hex":"#141414"},{"name":"Heather","hex":"#9b9a97"}]', array['XS','S','M','L','XL','XXL'], 60, '[]', false, true);

select from pg_temp.add_product('essential-hoodie', 'Essential Hoodie', 'hoodie', 'minimal', 'essentials', 'th8rty',
  7800, null, 'active', 'Heavyweight blank hoodie. The Custom Designer''s favourite canvas.',
  '450gsm fleece', array['minimal','hoodie','blank'],
  '[{"name":"Black","hex":"#141414"},{"name":"White","hex":"#f4f2ee"},{"name":"Heather","hex":"#9b9a97"}]', array['S','M','L','XL','XXL'], 40, '[]', false, true);

-- Seasonal
select from pg_temp.add_product('ember-crewneck', 'Ember Crewneck', 'crewneck', 'seasonal', null, 'th8rty',
  8400, null, 'active', 'Fall ''26 colourway. Garment-dyed rust.',
  '400gsm cotton', array['seasonal','crewneck'],
  '[{"name":"Rust","hex":"#9a4a22"}]', array['S','M','L','XL'], 12, '[]');

-- ---------------------------------------------------------------------
-- Limited drops: 3 archived (history), 2 live, 1 upcoming
-- ---------------------------------------------------------------------
select from pg_temp.add_product('genesis-static-tee', 'Genesis Static Tee', 'tee', 'th8rty', 'sketchbook-01', 'th8rty',
  5500, null, 'archived', 'The very first numbered piece. TV static screen-printed edge to edge.', '240gsm cotton',
  array['limited','th8rty'], '[{"name":"Black","hex":"#141414"}]', array['S','M','L','XL'], 0,
  '[{"text":"edge-to-edge static","x":0.5,"y":0.45,"side":"right"},{"text":"numbered hem tag","x":0.7,"y":0.9,"side":"right"}]');
select from pg_temp.add_product('ink-monsoon-hoodie', 'Ink Monsoon Hoodie', 'hoodie', 'anime', 'petal-storm', 'kaze-studio',
  11000, null, 'archived', 'Sumi-ink rain over a lone swordsman. Sold out in 41 minutes.', '450gsm fleece',
  array['limited','anime'], '[{"name":"Black","hex":"#141414"}]', array['S','M','L','XL'], 0, '[]');
select from pg_temp.add_product('first-light-crewneck', 'First Light Crewneck', 'crewneck', 'faith', 'grace-notes', 'lumen-atelier',
  8800, null, 'archived', 'Gold-thread sunrise, embroidered by hand.', '400gsm cotton',
  array['limited','faith'], '[{"name":"Cream","hex":"#efe6d2"}]', array['S','M','L','XL'], 0, '[]');

select from pg_temp.add_product('cyber-samurai-hoodie', 'Cyber Samurai Hoodie', 'hoodie', 'streetwear', 'static-season', 'th8rty',
  12000, null, 'active', 'Chrome armour plates over a neon katana. 500 numbered pieces, never restocked.', '500gsm fleece',
  array['limited','streetwear','samurai'], '[{"name":"Black","hex":"#141414"}]', array['S','M','L','XL','XXL'], 40,
  '[{"text":"numbered sleeve patch","x":0.12,"y":0.55,"side":"left"},{"text":"chrome back plate","x":0.5,"y":0.42,"side":"right"}]', true);
select from pg_temp.add_product('sakura-blade-tee', 'Sakura Blade Tee', 'tee', 'anime', 'petal-storm', 'kaze-studio',
  6500, null, 'active', 'A blade dissolving into blossom. 300 numbered pieces.', '240gsm cotton',
  array['limited','anime','sakura'], '[{"name":"Black","hex":"#141414"},{"name":"White","hex":"#f4f2ee"}]', array['S','M','L','XL'], 30,
  '[{"text":"blossom-blade front","x":0.5,"y":0.4,"side":"right"}]', true);
select from pg_temp.add_product('static-halo-hoodie', 'Static Halo Hoodie', 'hoodie', 'th8rty', 'sketchbook-01', 'th8rty',
  11500, null, 'scheduled', 'A halo drawn in one line, broken by static. Dropping soon.', '450gsm fleece',
  array['limited','th8rty'], '[{"name":"Bone","hex":"#e9e3d6"}]', array['S','M','L','XL','XXL'], 30,
  '[{"text":"one-line halo","x":0.5,"y":0.3,"side":"right"},{"text":"static hem","x":0.4,"y":0.9,"side":"left"}]', true, false, now() + interval '9 days');

insert into public.limited_drops (product_id, slug, drop_name, drop_number, edition_size, units_sold, release_at, story, original_price_cents, sold_out_at, archive_delay, archived_at) values
((select id from products where slug='genesis-static-tee'),   'genesis-static-drop-001', 'GENESIS STATIC', 1, 100, 100, '2025-03-14 18:00-04', 'Where it started: one screen, one squeegee, one hundred shirts. The static came from a dead TV in the studio.', 5500, '2025-03-15 02:10-04', interval '48 hours', '2025-03-17 02:10-04'),
((select id from products where slug='ink-monsoon-hoodie'),   'ink-monsoon-drop-002',    'INK MONSOON',    2, 250, 250, '2025-08-22 18:00-04', 'Painted in a single night during a storm. 250 pieces gone in 41 minutes.', 11000, '2025-08-22 18:41-04', interval '48 hours', '2025-08-24 18:41-04'),
((select id from products where slug='first-light-crewneck'), 'first-light-drop-003',    'FIRST LIGHT',    3, 150, 150, '2026-02-01 09:00-05', 'A sunrise stitched in gold thread, released on the first morning of February.', 8800, '2026-02-03 11:00-05', interval '48 hours', '2026-02-05 11:00-05'),
((select id from products where slug='cyber-samurai-hoodie'), 'cyber-samurai-drop-004',  'CYBER SAMURAI',  4, 500, 487, now() - interval '6 days', 'Armour for a city that never sleeps. 500 numbered pieces. When they''re gone, they live in the archive.', null, null, interval '48 hours', null),
((select id from products where slug='sakura-blade-tee'),     'sakura-blade-drop-005',   'SAKURA BLADE',   5, 300, 112, now() - interval '2 days', 'The moment a blade lets go and becomes petals.', null, null, interval '48 hours', null),
((select id from products where slug='static-halo-hoodie'),   'static-halo-drop-006',    'STATIC HALO',    6, 200, 0, now() + interval '9 days', 'Drawn in one line. Broken by static.', null, null, interval '48 hours', null);

-- Historical edition numbers (no orders attached in seed data).
insert into public.edition_allocations (drop_id, edition_number, allocated_at)
select d.id, n, coalesce(d.release_at, now()) from public.limited_drops d, generate_series(1, d.units_sold) n;

-- Opening stock movements so inventory history starts at a known point.
insert into public.inventory_movements (variant_id, delta, reason, note, on_hand_after)
select id, inventory_on_hand, 'initial', 'dev seed', inventory_on_hand from public.product_variants;

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
