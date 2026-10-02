-- =====================================================================
-- 0009 CUSTOM PRICING CONFIG — starter catalogue and price rules.
-- All amounts are PLACEHOLDERS for the owner to adjust from the admin
-- (pricing.write). Customer prices and production costs in cents, CAD.
-- =====================================================================

insert into public.print_placements (code, label, view, max_w_in, max_h_in, product_types, sort_order) values
  ('front',        'Front',        'front', 12, 14, '{}', 1),
  ('left_chest',   'Left chest',   'front', 4,  4,  '{}', 2),
  ('back',         'Back',         'back',  12, 16, '{}', 3),
  ('left_sleeve',  'Left sleeve',  'front', 3,  12, array['hoodie','longsleeve','crewneck'], 4),
  ('right_sleeve', 'Right sleeve', 'front', 3,  12, array['hoodie','longsleeve','crewneck'], 5)
on conflict (code) do nothing;

insert into public.print_methods (code, label, description, sort_order) values
  ('dtg',        'DTG',            'Direct-to-garment: soft, full colour, best for photos and detail.', 1),
  ('dtf',        'DTF',            'Direct-to-film transfer: vivid, durable, great on dark garments.', 2),
  ('embroidery', 'Embroidery',     'Stitched thread for small marks and logos. Includes a one-time digitizing fee.', 3),
  ('screen',     'Screen print',   'Best value for big runs of simple artwork. Minimum 24 pieces.', 4)
on conflict (code) do nothing;

insert into public.print_area_tiers (code, label, max_sq_in, sort_order) values
  ('small',  'Small (up to 16 sq in)',   16,   1),
  ('medium', 'Medium (up to 80 sq in)',  80,   2),
  ('large',  'Large (up to 168 sq in)',  168,  3),
  ('full',   'Full area',                null, 4)
on conflict (code) do nothing;

insert into public.artwork_services (code, label, description, sort_order) values
  ('background_removal', 'Background removal', 'We remove the background from your image before printing.', 1),
  ('cleanup',            'Artwork cleanup',    'Fix edges, colours and small flaws by hand.', 2),
  ('vectorization',      'Vectorization',      'Redraw your image as sharp vector art for the cleanest print.', 3)
on conflict (code) do nothing;

-- Garment production costs (placeholders)
update public.products set cost_cents = case product_type when 'hoodie' then 1850 when 'crewneck' then 1500 when 'longsleeve' then 950 when 'tank' then 650 else 700 end
 where cost_cents is null;

insert into public.pricing_rules (rule_type, label, size, placement, method, area_tier, service, min_qty, max_qty, customer_cents, cost_cents, setup_cents, percent, charge_per, priority, notes) values
  -- size adjustments (all garments)
  ('size', 'XXL upcharge', 'XXL', null, null, null, null, null, null, 300, 150, 0, null, 'unit', 0, null),
  ('size', '3XL upcharge', '3XL', null, null, null, null, null, null, 500, 250, 0, null, 'unit', 0, null),
  -- placements
  ('placement', 'Front print',      null, 'front',        null, null, null, null, null, 800, 300, 0, null, 'unit', 0, null),
  ('placement', 'Back print',       null, 'back',         null, null, null, null, null, 800, 300, 0, null, 'unit', 0, null),
  ('placement', 'Left chest print', null, 'left_chest',   null, null, null, null, null, 500, 180, 0, null, 'unit', 0, null),
  ('placement', 'Left sleeve',      null, 'left_sleeve',  null, null, null, null, null, 600, 220, 0, null, 'unit', 0, null),
  ('placement', 'Right sleeve',     null, 'right_sleeve', null, null, null, null, null, 600, 220, 0, null, 'unit', 0, null),
  -- print area (applies to any placement)
  ('print_area', 'Small print',  null, null, null, 'small',  null, null, null, 0,   0,   0, null, 'unit', 0, null),
  ('print_area', 'Medium print', null, null, null, 'medium', null, null, null, 300, 80,  0, null, 'unit', 0, null),
  ('print_area', 'Large print',  null, null, null, 'large',  null, null, null, 600, 160, 0, null, 'unit', 0, null),
  ('print_area', 'Full print',   null, null, null, 'full',   null, null, null, 900, 240, 0, null, 'unit', 0, null),
  -- methods
  ('method', 'DTG',                  null, null, 'dtg',        null, null, null, null, 0,   0,   0,    null, 'unit', 0, null),
  ('method', 'DTF',                  null, null, 'dtf',        null, null, null, null, 200, 60,  0,    null, 'unit', 0, null),
  ('method', 'Embroidery (small)',   null, null, 'embroidery', 'small',  null, null, null, 600, 250, 1500, null, 'unit', 0, 'One-time digitizing fee per location'),
  ('method', 'Embroidery (medium)',  null, null, 'embroidery', 'medium', null, null, null, 1200, 500, 2500, null, 'unit', 0, null),
  ('method', 'Screen print',         null, null, 'screen',     null, null, 24,   null, -150, 40, 3500, null, 'unit', 0, 'Setup per location; minimum 24 pieces'),
  -- artwork services (one-time per design line)
  ('artwork', 'Background removal', null, null, null, null, 'background_removal', null, null, 500,  300,  0, null, 'order', 0, null),
  ('artwork', 'Artwork cleanup',    null, null, null, null, 'cleanup',            null, null, 1000, 700,  0, null, 'order', 0, null),
  ('artwork', 'Vectorization',      null, null, null, null, 'vectorization',      null, null, 1500, 1000, 0, null, 'order', 0, null),
  -- volume discounts (per item off)
  ('quantity', '5–9 pieces',     null, null, null, null, null, 5,   9,   200,  0, 0, null, 'unit', 0, null),
  ('quantity', '10–24 pieces',   null, null, null, null, null, 10,  24,  400,  0, 0, null, 'unit', 0, null),
  ('quantity', '25–49 pieces',   null, null, null, null, null, 25,  49,  700,  0, 0, null, 'unit', 0, null),
  ('quantity', '50–99 pieces',   null, null, null, null, null, 50,  99,  900,  0, 0, null, 'unit', 0, null),
  ('quantity', '100–249 pieces', null, null, null, null, null, 100, 249, 1100, 0, 0, null, 'unit', 0, null),
  -- quote threshold
  ('quote', 'Quote required from 250 pieces', null, null, null, null, null, 250, null, 0, 0, 0, null, 'unit', 0, null);

-- Starter moderation terms: flag for human review, never auto-approve.
insert into public.moderation_terms (term, category, action) values
  ('nike','trademark','review'), ('adidas','trademark','review'), ('supreme','trademark','review'), ('gucci','trademark','review'),
  ('louis vuitton','trademark','review'), ('chanel','trademark','review'), ('balenciaga','trademark','review'), ('off-white','trademark','review'),
  ('coca-cola','trademark','review'), ('starbucks','trademark','review'), ('apple','trademark','review'), ('jordan','trademark','review'),
  ('disney','character','review'), ('marvel','character','review'), ('pokemon','character','review'), ('pikachu','character','review'),
  ('nintendo','character','review'), ('naruto','character','review'), ('one piece','character','review'), ('dragon ball','character','review'),
  ('bleach','character','review'), ('hello kitty','character','review'), ('star wars','character','review'), ('spider-man','character','review'),
  ('nba','sports','review'), ('nfl','sports','review'), ('nhl','sports','review'), ('mlb','sports','review'), ('fifa','sports','review'),
  ('raptors','sports','review'), ('maple leafs','sports','review'), ('blue jays','sports','review'), ('canadiens','sports','review')
on conflict (term) do nothing;
