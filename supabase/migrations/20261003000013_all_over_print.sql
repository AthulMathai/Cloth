-- All-over print: the whole garment as one canvas (cut & sew / sublimation).
-- Additive: new columns with defaults, new rows, function bodies patched in place.

-- Which canvas a placement is drawn on in the designer:
--   'garment' = a print area on the front/back drawing (existing behaviour)
--   'wrap'    = the unrolled all-over pattern (body wrap + full sleeves)
alter table public.print_placements add column if not exists canvas text not null default 'garment';
alter table public.print_placements add column if not exists methods text[] not null default '{}';   -- allowed methods; empty = any unrestricted method
alter table public.print_methods add column if not exists restricted boolean not null default false; -- only usable where a placement lists it

insert into public.print_methods (code, label, description, sort_order, restricted) values
  ('sublimation', 'All-over (sublimation, cut & sew)',
   'The whole panel is printed edge to edge before the garment is sewn, so art can wrap around seams. Bright colours on a white base.', 5, true)
on conflict (code) do nothing;

insert into public.print_placements (code, label, view, max_w_in, max_h_in, product_types, sort_order, canvas, methods) values
  ('all_over',           'All-over body wrap',     'front', 44, 32, '{}', 6, 'wrap', array['sublimation']),
  ('left_sleeve_full',   'Left sleeve (full wrap)',  'front', 22, 26, array['hoodie','longsleeve','crewneck','tee'], 7, 'wrap', array['sublimation']),
  ('right_sleeve_full',  'Right sleeve (full wrap)', 'front', 22, 26, array['hoodie','longsleeve','crewneck','tee'], 8, 'wrap', array['sublimation'])
on conflict (code) do nothing;

-- Placeholder prices (customer / cost, cents), editable in Admin → Custom pricing.
insert into public.pricing_rules (rule_type, label, placement, customer_cents, cost_cents, priority, notes)
select * from (values
  ('placement', 'All-over body wrap', 'all_over', 3800, 1500, 0, 'Placeholder — confirm with the print partner'),
  ('placement', 'Full sleeve wrap (left)', 'left_sleeve_full', 1200, 450, 0, 'Placeholder'),
  ('placement', 'Full sleeve wrap (right)', 'right_sleeve_full', 1200, 450, 0, 'Placeholder')
) v(rule_type, label, placement, customer_cents, cost_cents, priority, notes)
where not exists (select 1 from public.pricing_rules r where r.rule_type = 'placement' and r.placement = v.placement);

insert into public.pricing_rules (rule_type, label, method, customer_cents, cost_cents, priority, notes)
select 'method', 'Sublimation (all-over)', 'sublimation', 0, 0, 0, 'Coverage is priced on the placement rule'
where not exists (select 1 from public.pricing_rules where rule_type = 'method' and method = 'sublimation');

-- Pricing engine: default + allowed methods per placement.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.price_custom_internal(uuid,text,jsonb,text[],integer)'::regprocedure);
  n := replace(d, $x$    v_method := coalesce(nullif(el->>'method', ''), 'dtg');$x$,
$x$    v_method := coalesce(nullif(el->>'method', ''), pl.methods[1], 'dtg');
    if (cardinality(pl.methods) > 0 and not v_method = any(pl.methods))
       or (cardinality(pl.methods) = 0 and exists (select 1 from print_methods m where m.code = v_method and m.restricted)) then
      return jsonb_build_object('error', format('%s can''t be printed with %s.', pl.label,
        coalesce((select label from print_methods where code = v_method), v_method)));
    end if;$x$);
  if n = d then raise exception 'price_custom_internal patch did not apply'; end if;
  execute n;

  d := pg_get_functiondef('public.design_print_summary(jsonb)'::regprocedure);
  n := replace(d, $x$'method', coalesce(p_config->'methods'->>b.placement, 'dtg'),$x$,
                  $x$'method', coalesce(p_config->'methods'->>b.placement, pl.methods[1], 'dtg'),$x$);
  if n = d then raise exception 'design_print_summary patch did not apply'; end if;
  execute n;
end $$;
