-- TH8RTY Phase 3: Custom Designer + dynamic pricing engine.
-- Only for a project that already ran Phase 1 + 2. Run ONCE in Supabase → SQL Editor.
-- (Already applied to the live project by Claude on 2026-10-02.)


-- ===================== supabase/migrations/20261002000008_custom_designer.sql =====================
-- =====================================================================
-- 0008 CUSTOM DESIGNER + DYNAMIC PRICING ENGINE
--
-- Pricing is data. Every billable dimension (base garment, size,
-- placement, print area, method, artwork service, quantity tier, quote
-- threshold) is a row in pricing_rules. For each dimension the engine
-- picks ONE rule: highest priority first, then the most specific match
-- (product > product type > size > placement > method > area tier), then
-- the newest. Rules are effective-dated and versioned; edits are audited.
--
-- price_custom_internal() is the single engine. The customer designer,
-- the bag, checkout and the admin calculator all call it (customers get
-- a copy with costs removed). Checkout re-prices server-side and freezes
-- the full breakdown, including rule ids + versions, on the order line.
--
-- Additive only: no tables or functions are dropped.
-- =====================================================================

alter table public.products         add column if not exists cost_cents int check (cost_cents >= 0);
alter table public.product_variants add column if not exists cost_cents int check (cost_cents >= 0);

-- ---------------------------------------------------------------------
-- Print catalogue (what can be printed where), admin-editable.
-- ---------------------------------------------------------------------
create table public.print_placements (
  code           text primary key check (code ~ '^[a-z_]+$'),
  label          text not null,
  view           text not null check (view in ('front', 'back')),
  max_w_in       numeric(5,2) not null check (max_w_in > 0),
  max_h_in       numeric(5,2) not null check (max_h_in > 0),
  product_types  text[] not null default '{}',     -- empty = all garment types
  sort_order     int not null default 0,
  is_active      boolean not null default true
);

create table public.print_methods (
  code         text primary key check (code ~ '^[a-z_]+$'),
  label        text not null,
  description  text,
  sort_order   int not null default 0,
  is_active    boolean not null default true
);

create table public.print_area_tiers (
  code        text primary key check (code ~ '^[a-z_]+$'),
  label       text not null,
  max_sq_in   numeric(7,2),                         -- null = no upper bound
  sort_order  int not null default 0
);

create table public.artwork_services (
  code         text primary key check (code ~ '^[a-z_]+$'),
  label        text not null,
  description  text,
  sort_order   int not null default 0,
  is_active    boolean not null default true
);

-- ---------------------------------------------------------------------
-- Pricing rules
-- ---------------------------------------------------------------------
create table public.pricing_rules (
  id              uuid primary key default gen_random_uuid(),
  rule_type       text not null check (rule_type in ('base', 'size', 'placement', 'print_area', 'method', 'artwork', 'quantity', 'quote')),
  label           text not null,
  -- conditions (null = matches anything)
  product_id      uuid references public.products(id) on delete cascade,
  product_type    text,
  size            text,
  placement       text references public.print_placements(code),
  method          text references public.print_methods(code),
  area_tier       text references public.print_area_tiers(code),
  service         text references public.artwork_services(code),
  min_qty         int check (min_qty > 0),
  max_qty         int check (max_qty > 0),
  -- amounts
  customer_cents  int not null default 0,        -- price (or per-unit discount for 'quantity')
  cost_cents      int not null default 0,        -- production cost
  setup_cents     int not null default 0,        -- one-time per order line
  percent         numeric(5,2) check (percent between 0 and 100),   -- 'quantity': % off the unit price
  charge_per      text not null default 'unit' check (charge_per in ('unit', 'order')),
  -- control
  priority        int not null default 0,
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz,
  is_active       boolean not null default true,
  version         int not null default 1,
  notes           text,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint qty_order check (max_qty is null or min_qty is null or max_qty >= min_qty),
  constraint date_order check (effective_to is null or effective_to > effective_from)
);
create index pricing_rules_lookup on public.pricing_rules (rule_type, is_active);

create or replace function public.pricing_rule_versioning()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    new.updated_at := now();
    new.updated_by := auth.uid();
  else
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end $$;
create trigger pricing_rules_version before insert or update on public.pricing_rules
  for each row execute function public.pricing_rule_versioning();
create trigger audit_pricing_rules after insert or update or delete on public.pricing_rules
  for each row execute function public.audit_row();
revoke execute on function public.pricing_rule_versioning() from public, anon, authenticated;

-- Picks the single best rule for a dimension.
create or replace function public.pick_pricing_rule(
  p_type text, p_product uuid, p_product_type text, p_size text, p_placement text,
  p_method text, p_tier text, p_service text, p_qty int)
returns public.pricing_rules language sql stable security definer set search_path = public as $$
  select r.* from pricing_rules r
  where r.rule_type = p_type and r.is_active
    and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
    and (r.product_id   is null or r.product_id   = p_product)
    and (r.product_type is null or r.product_type = p_product_type)
    and (r.size         is null or r.size         = p_size)
    and (r.placement    is null or r.placement    = p_placement)
    and (r.method       is null or r.method       = p_method)
    and (r.area_tier    is null or r.area_tier    = p_tier)
    and (r.service      is null or r.service      = p_service)
    and (r.min_qty is null or p_qty >= r.min_qty)
    and (r.max_qty is null or p_qty <= r.max_qty)
  order by r.priority desc,
           ((r.product_id is not null)::int * 32 + (r.product_type is not null)::int * 16 + (r.size is not null)::int * 8
            + (r.placement is not null)::int * 4 + (r.method is not null)::int * 2 + (r.area_tier is not null)::int
            + (r.service is not null)::int) desc,
           r.effective_from desc
  limit 1;
$$;
revoke execute on function public.pick_pricing_rule(text, uuid, text, text, text, text, text, text, int) from public, anon, authenticated;

create or replace function public.rule_ref(r public.pricing_rules)
returns jsonb language sql immutable set search_path = public as $$
  select case when r.id is null then null else jsonb_build_object('id', r.id, 'version', r.version, 'label', r.label) end;
$$;

-- ---------------------------------------------------------------------
-- THE engine.
-- p_print: [{placement, method, width_in, height_in}]
-- p_services: artwork service codes
-- Returns the full breakdown including production cost and margin.
-- ---------------------------------------------------------------------
create or replace function public.price_custom_internal(
  p_product_id uuid, p_size text, p_print jsonb, p_services text[], p_qty int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p products%rowtype; v product_variants%rowtype;
  r pricing_rules; rq pricing_rules; rn pricing_rules;
  el jsonb; pl print_placements%rowtype; v_tier text; v_area numeric; v_w numeric; v_h numeric; v_method text;
  v_base int; v_base_cost int; v_size int := 0; v_size_cost int := 0;
  v_lines jsonb := '[]'; v_line jsonb; v_rules jsonb := '[]';
  v_print_unit int := 0; v_print_cost int := 0; v_setup int := 0;
  v_art_unit int := 0; v_art_order int := 0; v_art_cost_unit int := 0; v_art_cost_order int := 0; v_art jsonb := '[]';
  v_pre int; v_disc int := 0; v_unit int; v_total int; v_cost_unit int; v_cost_total int;
  v_next jsonb; v_threshold int; s text; seen text[] := '{}';
begin
  if p_qty is null or p_qty < 1 or p_qty > 100000 then
    return jsonb_build_object('error', 'Quantity must be between 1 and 100,000.');
  end if;
  select * into p from products where id = p_product_id;
  if not found or not p.is_customizable or p.status not in ('active', 'out_of_stock') then
    return jsonb_build_object('error', 'That garment isn''t available for custom designs.');
  end if;
  select * into v from product_variants where product_id = p.id and size = p_size and is_active order by sort_order limit 1;
  if not found then
    return jsonb_build_object('error', 'Choose an available size.');
  end if;
  if p_print is null or jsonb_typeof(p_print) <> 'array' or jsonb_array_length(p_print) = 0 then
    return jsonb_build_object('error', 'Add artwork or text to at least one print area.');
  end if;

  -- quote threshold
  r := pick_pricing_rule('quote', p.id, p.product_type, p_size, null, null, null, null, 2147483647);
  v_threshold := r.min_qty;

  -- base garment: a 'base' rule, else the blank's regular price (size
  -- upcharges come from 'size' rules, never from variant overrides)
  r := pick_pricing_rule('base', p.id, p.product_type, p_size, null, null, null, null, p_qty);
  v_base := coalesce(case when r.id is not null then r.customer_cents end, p.base_price_cents);
  v_base_cost := coalesce(case when r.id is not null then r.cost_cents end, v.cost_cents, p.cost_cents, 0);
  if r.id is not null then v_rules := v_rules || rule_ref(r); end if;

  -- size adjustment
  r := pick_pricing_rule('size', p.id, p.product_type, p_size, null, null, null, null, p_qty);
  if r.id is not null then
    v_size := r.customer_cents; v_size_cost := r.cost_cents; v_rules := v_rules || rule_ref(r);
  end if;

  -- print locations
  for el in select * from jsonb_array_elements(p_print) loop
    select * into pl from print_placements where code = el->>'placement' and is_active;
    if not found or (cardinality(pl.product_types) > 0 and not p.product_type = any(pl.product_types)) then
      return jsonb_build_object('error', format('%s printing isn''t offered on this garment.',
        coalesce((select label from print_placements where code = el->>'placement'), 'That')));
    end if;
    if pl.code = any(seen) then
      return jsonb_build_object('error', format('%s is listed twice.', pl.label));
    end if;
    seen := seen || pl.code;
    v_w := least(greatest(coalesce((el->>'width_in')::numeric, 0), 0), pl.max_w_in);
    v_h := least(greatest(coalesce((el->>'height_in')::numeric, 0), 0), pl.max_h_in);
    if v_w <= 0 or v_h <= 0 then
      return jsonb_build_object('error', format('The %s artwork has no size.', lower(pl.label)));
    end if;
    v_area := round(v_w * v_h, 2);
    select code into v_tier from print_area_tiers where max_sq_in is null or v_area <= max_sq_in
      order by (max_sq_in is null), max_sq_in limit 1;
    v_method := coalesce(nullif(el->>'method', ''), 'dtg');

    r := pick_pricing_rule('placement', p.id, p.product_type, p_size, pl.code, v_method, v_tier, null, p_qty);
    if r.id is null then
      return jsonb_build_object('error', format('%s printing isn''t priced yet.', pl.label));
    end if;
    rq := pick_pricing_rule('method', p.id, p.product_type, p_size, pl.code, v_method, v_tier, null, p_qty);
    if rq.id is null then
      -- distinguish "needs a bigger order" from "not offered"
      rn := pick_pricing_rule('method', p.id, p.product_type, p_size, pl.code, v_method, v_tier, null, 1000000);
      if rn.id is not null and rn.min_qty is not null then
        return jsonb_build_object('error', format('%s needs at least %s pieces.',
          (select label from print_methods where code = v_method), rn.min_qty), 'min_qty', rn.min_qty);
      end if;
      return jsonb_build_object('error', format('%s isn''t available for the %s.',
        coalesce((select label from print_methods where code = v_method), v_method), lower(pl.label)));
    end if;
    rn := pick_pricing_rule('print_area', p.id, p.product_type, p_size, pl.code, v_method, v_tier, null, p_qty);

    v_line := jsonb_build_object(
      'placement', pl.code, 'placement_label', pl.label, 'method', v_method,
      'method_label', (select label from print_methods where code = v_method),
      'width_in', v_w, 'height_in', v_h, 'area_sq_in', v_area, 'area_tier', v_tier,
      'area_label', (select label from print_area_tiers where code = v_tier),
      'placement_cents', r.customer_cents, 'area_cents', coalesce(rn.customer_cents, 0), 'method_cents', rq.customer_cents,
      'unit_cents', r.customer_cents + coalesce(rn.customer_cents, 0) + rq.customer_cents,
      'setup_cents', r.setup_cents + rq.setup_cents + coalesce(rn.setup_cents, 0),
      'cost_cents', r.cost_cents + coalesce(rn.cost_cents, 0) + rq.cost_cents);
    v_lines := v_lines || v_line;
    v_print_unit := v_print_unit + (v_line->>'unit_cents')::int;
    v_print_cost := v_print_cost + (v_line->>'cost_cents')::int;
    v_setup := v_setup + (v_line->>'setup_cents')::int;
    v_rules := v_rules || rule_ref(r) || rule_ref(rq);
    if rn.id is not null then v_rules := v_rules || rule_ref(rn); end if;
  end loop;

  -- artwork services
  foreach s in array coalesce(p_services, '{}') loop
    if not exists (select 1 from artwork_services where code = s and is_active) then
      return jsonb_build_object('error', 'Unknown artwork service.');
    end if;
    r := pick_pricing_rule('artwork', p.id, p.product_type, p_size, null, null, null, s, p_qty);
    if r.id is null then continue; end if;
    v_art := v_art || jsonb_build_object('service', s, 'label', (select label from artwork_services where code = s),
                                         'cents', r.customer_cents, 'charge_per', r.charge_per, 'cost_cents', r.cost_cents);
    if r.charge_per = 'order' then
      v_art_order := v_art_order + r.customer_cents; v_art_cost_order := v_art_cost_order + r.cost_cents;
    else
      v_art_unit := v_art_unit + r.customer_cents; v_art_cost_unit := v_art_cost_unit + r.cost_cents;
    end if;
    v_rules := v_rules || rule_ref(r);
  end loop;

  v_pre := v_base + v_size + v_print_unit + v_art_unit;

  -- volume discount
  r := pick_pricing_rule('quantity', p.id, p.product_type, p_size, null, null, null, null, p_qty);
  if r.id is not null then
    v_disc := coalesce(round(v_pre * r.percent / 100.0)::int, 0) + r.customer_cents;
    v_disc := least(v_disc, v_pre - v_base);          -- never discount below the blank garment price
    v_rules := v_rules || rule_ref(r);
  end if;

  -- next tier (for "add N more to unlock")
  select jsonb_build_object('min_qty', q.min_qty, 'add_qty', q.min_qty - p_qty,
           'per_unit_discount_cents', least(coalesce(round(v_pre * q.percent / 100.0)::int, 0) + q.customer_cents, v_pre - v_base))
    into v_next
  from pricing_rules q
  where q.rule_type = 'quantity' and q.is_active and q.min_qty > p_qty
    and q.effective_from <= now() and (q.effective_to is null or q.effective_to > now())
    and (q.product_id is null or q.product_id = p.id) and (q.product_type is null or q.product_type = p.product_type)
    and (v_threshold is null or q.min_qty < v_threshold)
  order by q.min_qty limit 1;

  v_unit := v_pre - v_disc;
  v_total := v_unit * p_qty + v_setup + v_art_order;
  v_cost_unit := v_base_cost + v_size_cost + v_print_cost + v_art_cost_unit;
  v_cost_total := v_cost_unit * p_qty + v_art_cost_order;

  return jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_type', p.product_type, 'size', p_size, 'quantity', p_qty,
    'base_cents', v_base, 'size_cents', v_size, 'print', v_lines, 'print_unit_cents', v_print_unit,
    'artwork', v_art, 'artwork_unit_cents', v_art_unit, 'artwork_order_cents', v_art_order,
    'unit_before_discount_cents', v_pre, 'volume_discount_cents', v_disc,
    'unit_cents', v_unit, 'setup_cents', v_setup, 'one_time_cents', v_setup + v_art_order,
    'total_cents', v_total, 'next_tier', v_next,
    'quote_threshold', v_threshold, 'quote_required', v_threshold is not null and p_qty >= v_threshold,
    'cost', jsonb_build_object('garment_cents', v_base_cost + v_size_cost, 'print_cents', v_print_cost,
                               'artwork_unit_cents', v_art_cost_unit, 'artwork_order_cents', v_art_cost_order,
                               'unit_cents', v_cost_unit, 'total_cents', v_cost_total),
    'margin_cents', v_total - v_cost_total,
    'margin_pct', case when v_total > 0 then round((v_total - v_cost_total) * 100.0 / v_total, 1) end,
    'rules', v_rules, 'priced_at', now(), 'currency', 'CAD');
end $$;
revoke execute on function public.price_custom_internal(uuid, text, jsonb, text[], int) from public, anon, authenticated;

create or replace function public.strip_costs(b jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case when b is null then null else
    (b - 'cost' - 'margin_cents' - 'margin_pct' - 'rules')
    || jsonb_build_object('print', coalesce((select jsonb_agg(x - 'cost_cents') from jsonb_array_elements(b->'print') x), '[]'::jsonb),
                          'artwork', coalesce((select jsonb_agg(x - 'cost_cents') from jsonb_array_elements(b->'artwork') x), '[]'::jsonb))
  end;
$$;

-- Customer-facing price (no costs or margins).
create or replace function public.price_custom(p_product_id uuid, p_size text, p_print jsonb, p_services text[] default '{}', p_qty int default 1)
returns jsonb language sql stable security definer set search_path = public as $$
  select strip_costs(price_custom_internal(p_product_id, p_size, p_print, p_services, p_qty));
$$;

-- Staff calculator: same engine, full breakdown.
create or replace function public.price_custom_admin(p_product_id uuid, p_size text, p_print jsonb, p_services text[] default '{}', p_qty int default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('pricing.write') or has_permission('orders.read')) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return price_custom_internal(p_product_id, p_size, p_print, p_services, p_qty);
end $$;

-- Public: quantity tiers for the designer's "order more, pay less" table
-- (per-item discounts only; no costs).
create or replace function public.custom_quantity_tiers(p_product_id uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('min_qty', min_qty, 'max_qty', max_qty, 'per_unit_discount_cents', customer_cents,
                         'percent', percent, 'label', label) order by min_qty)
              from pricing_rules q
              where q.rule_type = 'quantity' and q.is_active and q.effective_from <= now() and (q.effective_to is null or q.effective_to > now())
                and (q.product_id is null or q.product_id = p_product_id)), '[]'),
    'quote_threshold', (select min(min_qty) from pricing_rules where rule_type = 'quote' and is_active
                          and effective_from <= now() and (effective_to is null or effective_to > now())
                          and (product_id is null or product_id = p_product_id)));
$$;

-- ---------------------------------------------------------------------
-- Designs
-- config: {
--   "layers": [{ "id", "type": "image"|"text", "placement", "asset_id", "text", "font", "color",
--                "x_in", "y_in", "w_in", "h_in", "rotation" }],   -- x/y = layer centre, inches from the
--                                                                 -- print area's top-left corner
--   "methods":  { "<placement>": "dtg" | "dtf" | "embroidery" | "screen" },
--   "services": ["background_removal", ...]
-- }
-- ---------------------------------------------------------------------
create table public.custom_designs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  name              text not null default 'Untitled design' check (char_length(name) between 1 and 80),
  product_id        uuid not null references public.products(id),
  variant_id        uuid not null references public.product_variants(id),
  config            jsonb not null,
  version           int not null default 1,
  status            text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'needs_review', 'rejected')),
  approved_version  int,
  mockups           jsonb not null default '{}',     -- {"front": "<mockups bucket path>", "back": ...}
  production_files  jsonb not null default '{}',     -- {"front": "<designs bucket path>", ...}
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index custom_designs_user on public.custom_designs (user_id, updated_at desc);
create index custom_designs_status on public.custom_designs (status, submitted_at);
create trigger custom_designs_touch before update on public.custom_designs for each row execute function public.touch_updated_at();

create or replace function public.forbid_change()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
revoke execute on function public.forbid_change() from public, anon, authenticated;

create table public.design_versions (
  design_id         uuid not null references public.custom_designs(id) on delete cascade,
  version           int not null,
  product_id        uuid not null,
  variant_id        uuid not null,
  config            jsonb not null,
  mockups           jsonb not null default '{}',
  production_files  jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  primary key (design_id, version)
);
create trigger design_versions_immutable before update or delete on public.design_versions
  for each row execute function public.forbid_change();

create table public.design_assets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('original', 'processed', 'production', 'mockup')),
  bucket         text not null check (bucket in ('designs', 'mockups')),
  path           text not null,
  mime           text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  bytes          int not null check (bytes > 0 and bytes <= 26214400),
  width_px       int check (width_px > 0),
  height_px      int check (height_px > 0),
  sha256         text check (sha256 ~ '^[0-9a-f]{64}$'),
  original_name  text check (char_length(original_name) <= 200),
  verified       boolean not null default false,     -- server checked the real file bytes
  created_at     timestamptz not null default now(),
  unique (bucket, path)
);
create index design_assets_user on public.design_assets (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Moderation (automated results now; human queue arrives in Phase 6)
-- ---------------------------------------------------------------------
create table public.moderation_terms (
  id        uuid primary key default gen_random_uuid(),
  term      text not null unique check (term = lower(term) and char_length(term) between 2 and 60),
  category  text not null check (category in ('trademark', 'sports', 'character', 'celebrity', 'hate', 'explicit', 'violence', 'other')),
  action    text not null default 'review' check (action in ('review', 'reject'))
);

create table public.moderation_results (
  id              uuid primary key default gen_random_uuid(),
  design_id       uuid not null references public.custom_designs(id) on delete cascade,
  design_version  int not null,
  provider        text not null,
  risk_score      int not null check (risk_score between 0 and 100),
  decision        text not null check (decision in ('approved', 'needs_review', 'rejected')),
  findings        jsonb not null default '[]',
  created_at      timestamptz not null default now()
);
create index moderation_results_design on public.moderation_results (design_id, created_at desc);
create trigger moderation_results_immutable before update or delete on public.moderation_results
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------
-- Quote requests (orders at or above the quote threshold)
-- ---------------------------------------------------------------------
create table public.quote_requests (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique default ('Q-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(md5(random()::text), 1, 4))),
  user_id              uuid references auth.users(id) on delete set null,
  name                 text not null check (char_length(name) between 1 and 120),
  email                text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                text check (char_length(phone) <= 40),
  product_id           uuid references public.products(id),
  design_id            uuid references public.custom_designs(id) on delete set null,
  quantity             int not null check (quantity > 0),
  size_breakdown       jsonb not null default '{}',
  colors               text check (char_length(colors) <= 200),
  placements           text check (char_length(placements) <= 300),
  desired_date         date,
  notes                text check (char_length(notes) <= 2000),
  estimate             jsonb,                       -- engine estimate at the time of request
  status               text not null default 'new' check (status in ('new', 'reviewing', 'quoted', 'accepted', 'declined', 'expired', 'converted')),
  proposed_unit_cents  int check (proposed_unit_cents >= 0),
  proposed_total_cents int check (proposed_total_cents >= 0),
  discount_cents       int check (discount_cents >= 0),
  expires_at           timestamptz,
  admin_notes          text,
  order_id             uuid references public.orders(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index quote_requests_status on public.quote_requests (status, created_at desc);
create trigger quote_requests_touch before update on public.quote_requests for each row execute function public.touch_updated_at();
create trigger audit_quote_requests after insert or update on public.quote_requests for each row execute function public.audit_row();

-- Cart & order lines learn about designs
alter table public.cart_items  add column if not exists design_version int;
alter table public.order_items add column if not exists custom_design_id uuid references public.custom_designs(id);
alter table public.order_items add column if not exists design_version int;
create unique index if not exists cart_items_unique_design on public.cart_items (cart_id, custom_design_id) where item_type = 'custom';

-- ---------------------------------------------------------------------
-- Design helpers
-- ---------------------------------------------------------------------
-- Per print area: the bounding box of everything placed there (rotation
-- aware), clamped to the area's maximum, plus the chosen method.
create or replace function public.design_print_summary(p_config jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  with l as (
    select x->>'placement' placement,
           (x->>'x_in')::numeric cx, (x->>'y_in')::numeric cy,
           (abs((x->>'w_in')::numeric * cos(radians(coalesce((x->>'rotation')::numeric, 0)))::numeric)
             + abs((x->>'h_in')::numeric * sin(radians(coalesce((x->>'rotation')::numeric, 0)))::numeric)) bw,
           (abs((x->>'w_in')::numeric * sin(radians(coalesce((x->>'rotation')::numeric, 0)))::numeric)
             + abs((x->>'h_in')::numeric * cos(radians(coalesce((x->>'rotation')::numeric, 0)))::numeric)) bh
    from jsonb_array_elements(coalesce(p_config->'layers', '[]')) x
  ), b as (
    select placement,
           greatest(0, min(cx - bw / 2)) x0, max(cx + bw / 2) x1,
           greatest(0, min(cy - bh / 2)) y0, max(cy + bh / 2) y1
    from l group by placement
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'placement', b.placement,
           'method', coalesce(p_config->'methods'->>b.placement, 'dtg'),
           'width_in', round((least(b.x1, pl.max_w_in) - b.x0)::numeric, 2),
           'height_in', round((least(b.y1, pl.max_h_in) - b.y0)::numeric, 2))
         order by pl.sort_order), '[]')
  from b join print_placements pl on pl.code = b.placement;
$$;

create or replace function public.design_services(p_config jsonb)
returns text[] language sql immutable set search_path = public as $$
  select coalesce(array(select jsonb_array_elements_text(coalesce(p_config->'services', '[]'))), '{}');
$$;

create or replace function public.price_design_internal(p_design_id uuid, p_qty int)
returns jsonb language sql stable security definer set search_path = public as $$
  select price_custom_internal(d.product_id, v.size, design_print_summary(d.config), design_services(d.config), p_qty)
  from custom_designs d join product_variants v on v.id = d.variant_id where d.id = p_design_id;
$$;
revoke execute on function public.price_design_internal(uuid, int) from public, anon, authenticated;

-- Validates a design config against the catalogue and the caller's assets.
create or replace function public.validate_design_config(p_config jsonb, p_product products, p_user uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare x jsonb; pl print_placements%rowtype; n int := 0; k text;
begin
  if jsonb_typeof(p_config) <> 'object' or jsonb_typeof(coalesce(p_config->'layers', '[]')) <> 'array' then
    return 'Design data is malformed.';
  end if;
  if pg_column_size(p_config) > 65536 then return 'Design is too large.'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_config->'layers', '[]')) loop
    n := n + 1;
    if n > 30 then return 'A design can have up to 30 layers.'; end if;
    select * into pl from print_placements where code = x->>'placement' and is_active;
    if not found or (cardinality(pl.product_types) > 0 and not p_product.product_type = any(pl.product_types)) then
      return 'A layer is on a print area this garment doesn''t have.';
    end if;
    if coalesce(x->>'type', '') not in ('image', 'text') then return 'Unknown layer type.'; end if;
    if (x->>'w_in') is null or (x->>'h_in') is null or (x->>'x_in') is null or (x->>'y_in') is null
       or (x->>'w_in')::numeric <= 0 or (x->>'h_in')::numeric <= 0
       or (x->>'w_in')::numeric > 40 or (x->>'h_in')::numeric > 40 then
      return 'A layer has an invalid size.';
    end if;
    if x->>'type' = 'image' and not exists (
         select 1 from design_assets a where a.id = (x->>'asset_id')::uuid and a.user_id = p_user and a.kind in ('original', 'processed')) then
      return 'A layer uses artwork that isn''t yours or wasn''t uploaded.';
    end if;
    if x->>'type' = 'text' and (char_length(coalesce(x->>'text', '')) not between 1 and 200) then
      return 'Text layers need 1–200 characters.';
    end if;
  end loop;
  for k in select jsonb_object_keys(coalesce(p_config->'methods', '{}')) loop
    if not exists (select 1 from print_methods where code = p_config->'methods'->>k and is_active) then return 'Unknown print method.'; end if;
  end loop;
  if exists (select 1 from unnest(design_services(p_config)) s where not exists (select 1 from artwork_services a where a.code = s and a.is_active)) then
    return 'Unknown artwork service.';
  end if;
  return null;
end $$;
revoke execute on function public.validate_design_config(jsonb, products, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Designer API (signed-in customers)
-- ---------------------------------------------------------------------
create or replace function public.design_register_asset(
  p_bucket text, p_path text, p_kind text, p_mime text, p_bytes int,
  p_width int default null, p_height int default null, p_sha256 text default null, p_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Sign in to upload artwork.' using errcode = '42501'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> v_uid::text or p_path like '%..%' then
    raise exception 'Invalid upload path.' using errcode = '42501';
  end if;
  insert into design_assets (user_id, kind, bucket, path, mime, bytes, width_px, height_px, sha256, original_name)
  values (v_uid, p_kind, p_bucket, p_path, p_mime, p_bytes, p_width, p_height, lower(p_sha256), left(p_name, 200))
  on conflict (bucket, path) do update set bytes = excluded.bytes, width_px = excluded.width_px, height_px = excluded.height_px,
    sha256 = excluded.sha256, verified = false
  returning id into v_id;
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('design_uploaded', v_uid, 'design_asset', v_id::text, jsonb_build_object('kind', p_kind, 'mime', p_mime, 'bytes', p_bytes));
  return v_id;
end $$;

create or replace function public.design_save(
  p_design_id uuid, p_name text, p_product_id uuid, p_variant_id uuid, p_config jsonb,
  p_mockups jsonb default '{}', p_production jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); p products%rowtype; d custom_designs%rowtype; v_err text;
begin
  if v_uid is null then raise exception 'Sign in to save your design.' using errcode = '42501'; end if;
  select * into p from products where id = p_product_id and is_customizable;
  if not found then raise exception 'That garment can''t be customized.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from product_variants where id = p_variant_id and product_id = p.id and is_active) then
    raise exception 'Choose an available colour and size.' using errcode = 'check_violation';
  end if;
  v_err := validate_design_config(p_config, p, v_uid);
  if v_err is not null then raise exception '%', v_err using errcode = 'check_violation'; end if;

  if p_design_id is null then
    insert into custom_designs (user_id, name, product_id, variant_id, config, mockups, production_files)
    values (v_uid, coalesce(nullif(btrim(p_name), ''), 'Untitled design'), p.id, p_variant_id, p_config,
            coalesce(p_mockups, '{}'), coalesce(p_production, '{}'))
    returning * into d;
    insert into analytics_events (event_type, user_id, entity_type, entity_id) values ('custom_design_started', v_uid, 'design', d.id::text);
  else
    update custom_designs
       set name = coalesce(nullif(btrim(p_name), ''), name), product_id = p.id, variant_id = p_variant_id, config = p_config,
           mockups = coalesce(p_mockups, '{}'), production_files = coalesce(p_production, '{}'),
           version = version + 1, status = 'draft', submitted_at = null, decided_at = null, decision_note = null
     where id = p_design_id and user_id = v_uid
    returning * into d;
    if not found then raise exception 'Design not found.' using errcode = 'check_violation'; end if;
  end if;

  insert into design_versions (design_id, version, product_id, variant_id, config, mockups, production_files)
  values (d.id, d.version, d.product_id, d.variant_id, d.config, d.mockups, d.production_files);
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('design_saved', v_uid, 'design', d.id::text, jsonb_build_object('version', d.version));
  return jsonb_build_object('id', d.id, 'version', d.version, 'status', d.status);
end $$;

-- Sends the current version for moderation. Returns the version to check.
create or replace function public.design_submit(p_design_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d custom_designs%rowtype;
begin
  update custom_designs set status = 'pending', submitted_at = now(), decided_at = null, decision_note = null
   where id = p_design_id and user_id = auth.uid() and status in ('draft', 'rejected', 'pending')
  returning * into d;
  if not found then raise exception 'This design can''t be submitted right now.' using errcode = 'check_violation'; end if;
  if jsonb_array_length(design_print_summary(d.config)) = 0 then
    raise exception 'Add artwork or text before submitting.' using errcode = 'check_violation';
  end if;
  return jsonb_build_object('id', d.id, 'version', d.version, 'status', d.status);
end $$;

create or replace function public.design_get(p_design_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'name', d.name, 'product_id', d.product_id, 'variant_id', d.variant_id, 'config', d.config,
    'version', d.version, 'status', d.status, 'approved_version', d.approved_version, 'mockups', d.mockups,
    'decision_note', d.decision_note, 'updated_at', d.updated_at,
    'assets', (select coalesce(jsonb_object_agg(a.id, jsonb_build_object('bucket', a.bucket, 'path', a.path, 'mime', a.mime,
                 'width_px', a.width_px, 'height_px', a.height_px, 'name', a.original_name)), '{}')
               from design_assets a where a.user_id = d.user_id
                 and a.id::text in (select x->>'asset_id' from jsonb_array_elements(d.config->'layers') x)),
    'moderation', (select jsonb_build_object('decision', m.decision, 'risk_score', m.risk_score, 'provider', m.provider,
                     'findings', (select coalesce(jsonb_agg(f->>'message'), '[]') from jsonb_array_elements(m.findings) f))
                   from moderation_results m where m.design_id = d.id and m.design_version = d.version order by m.created_at desc limit 1))
  from custom_designs d
  where d.id = p_design_id and (d.user_id = auth.uid() or has_permission('moderation.review'));
$$;

create or replace function public.design_price(p_design_id uuid, p_qty int default 1)
returns jsonb language sql stable security definer set search_path = public as $$
  select strip_costs(price_design_internal(d.id, p_qty))
  from custom_designs d where d.id = p_design_id and (d.user_id = auth.uid() or has_permission('orders.read'));
$$;

-- Service role (moderation function) records the automated decision.
create or replace function public.record_moderation(
  p_design_id uuid, p_version int, p_provider text, p_score int, p_decision text, p_findings jsonb, p_asset_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare d custom_designs%rowtype; v_status text;
begin
  select * into d from custom_designs where id = p_design_id for update;
  if not found then raise exception 'design not found'; end if;
  insert into moderation_results (design_id, design_version, provider, risk_score, decision, findings)
  values (d.id, p_version, p_provider, p_score, p_decision, coalesce(p_findings, '[]'));
  update design_assets set verified = true where id = any(p_asset_ids);

  -- A newer version was saved meanwhile: keep the result, don't change status.
  if d.version <> p_version or d.status <> 'pending' then
    return jsonb_build_object('id', d.id, 'status', d.status, 'stale', true);
  end if;
  v_status := p_decision;
  update custom_designs
     set status = v_status, decided_at = now(),
         approved_version = case when v_status = 'approved' then p_version else approved_version end,
         decision_note = case v_status
           when 'approved' then null
           when 'needs_review' then 'Our team will review this design before it can be printed. We''ll update you here.'
           else 'This design can''t be printed. Edit it and submit again.' end
   where id = d.id;
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values (case v_status when 'approved' then 'design_approved' when 'rejected' then 'design_rejected' else 'design_flagged' end,
          d.user_id, 'design', d.id::text, jsonb_build_object('version', p_version, 'risk', p_score));
  return jsonb_build_object('id', d.id, 'status', v_status);
end $$;
revoke execute on function public.record_moderation(uuid, int, text, int, text, jsonb, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Quote requests
-- ---------------------------------------------------------------------
create or replace function public.submit_quote_request(
  p_name text, p_email text, p_phone text, p_product_id uuid, p_design_id uuid, p_quantity int,
  p_size_breakdown jsonb, p_colors text, p_placements text, p_desired_date date, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_number text; v_est jsonb; v_uid uuid := auth.uid();
begin
  if p_design_id is not null and not exists (select 1 from custom_designs where id = p_design_id and user_id = v_uid) then
    raise exception 'Design not found.' using errcode = 'check_violation';
  end if;
  if (select count(*) from quote_requests where lower(email) = lower(p_email) and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many quote requests. Try again later.' using errcode = 'check_violation';
  end if;
  if p_design_id is not null then v_est := strip_costs(price_design_internal(p_design_id, p_quantity)); end if;
  insert into quote_requests (user_id, name, email, phone, product_id, design_id, quantity, size_breakdown, colors, placements,
                              desired_date, notes, estimate)
  values (v_uid, btrim(p_name), lower(btrim(p_email)), nullif(btrim(p_phone), ''), p_product_id, p_design_id, p_quantity,
          coalesce(p_size_breakdown, '{}'), p_colors, p_placements, p_desired_date, p_notes, v_est)
  returning id, number into v_id, v_number;
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('quote_requested', v_uid, 'quote', v_id::text, jsonb_build_object('quantity', p_quantity));
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;

-- ---------------------------------------------------------------------
-- Cart: custom lines are priced live by the engine (volume tier follows
-- the line quantity). The bag only ever accepts approved designs.
-- ---------------------------------------------------------------------
create or replace function public.cart_contents(p_cart_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with lines as (
    -- ready-made products
    select ci.created_at, jsonb_build_object(
      'item_id', ci.id, 'item_type', ci.item_type, 'variant_id', v.id, 'product_id', p.id,
      'product_slug', p.slug, 'name', p.name, 'product_type', p.product_type,
      'sku', v.sku, 'size', v.size, 'color', v.color, 'color_hex', v.color_hex,
      'quantity', ci.quantity,
      'unit_price_cents', variant_price(v, p),
      'line_total_cents', variant_price(v, p) * ci.quantity,
      'is_limited', d.id is not null, 'drop_name', d.drop_name, 'drop_number', d.drop_number,
      'max_quantity', least(99,
          v.inventory_on_hand - v.inventory_reserved,
          case when d.id is not null then least(d.max_per_order, d.edition_size - d.units_sold - d.units_reserved) else 99 end),
      'issue', case
          when p.status = 'archived' then 'Archived — no longer available'
          when p.status = 'sold_out' or (d.id is not null and d.units_sold + d.units_reserved >= d.edition_size) then 'Sold out'
          when p.status not in ('active', 'out_of_stock') or not v.is_active then 'No longer available'
          when d.id is not null and d.release_at > now() then 'Not released yet'
          when v.inventory_on_hand - v.inventory_reserved <= 0 then 'Out of stock in this size'
          when ci.quantity > v.inventory_on_hand - v.inventory_reserved then 'Only ' || (v.inventory_on_hand - v.inventory_reserved) || ' left'
          when d.id is not null and ci.quantity > least(d.max_per_order, d.edition_size - d.units_sold - d.units_reserved)
            then 'Limit ' || least(d.max_per_order, d.edition_size - d.units_sold - d.units_reserved) || ' per order'
        end) j
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products p on p.id = v.product_id
    left join limited_drops d on d.product_id = p.id
    where ci.cart_id = p_cart_id and ci.item_type = 'product'
    union all
    -- custom designs
    select ci.created_at, jsonb_build_object(
      'item_id', ci.id, 'item_type', 'custom', 'variant_id', v.id, 'product_id', p.id,
      'product_slug', p.slug, 'name', cd.name || ' — custom ' || lower(p.name), 'design_id', cd.id, 'design_version', ci.design_version,
      'design_name', cd.name, 'mockups', cd.mockups, 'product_type', p.product_type,
      'sku', v.sku, 'size', v.size, 'color', v.color, 'color_hex', v.color_hex,
      'quantity', ci.quantity,
      'unit_price_cents', coalesce((pr->>'unit_cents')::int, 0),
      'line_total_cents', coalesce((pr->>'total_cents')::int, 0),
      'one_time_cents', coalesce((pr->>'one_time_cents')::int, 0),
      'pricing', strip_costs(pr),
      'is_limited', false,
      'max_quantity', least(coalesce((pr->>'quote_threshold')::int - 1, 9999), v.inventory_on_hand - v.inventory_reserved),
      'issue', case
          when cd.id is null or cd.status <> 'approved' or cd.approved_version is distinct from ci.design_version
            then 'Design changed — submit it again, then re-add it'
          when pr->>'error' is not null then pr->>'error'
          when (pr->>'quote_required')::boolean then 'Large order — request a quote'
          when not v.is_active or p.status not in ('active', 'out_of_stock') then 'Garment no longer available'
          when v.inventory_on_hand - v.inventory_reserved < ci.quantity then
            'Only ' || greatest(0, v.inventory_on_hand - v.inventory_reserved) || ' blanks left in this colour/size'
        end) j
    from cart_items ci
    join product_variants v on v.id = ci.variant_id
    join products p on p.id = v.product_id
    left join custom_designs cd on cd.id = ci.custom_design_id
    left join lateral (select price_design_internal(cd.id, ci.quantity) pr) x on true
    where ci.cart_id = p_cart_id and ci.item_type = 'custom'
  )
  select coalesce(jsonb_agg(j order by created_at), '[]'::jsonb) from lines;
$$;
revoke execute on function public.cart_contents(uuid) from public, anon, authenticated;

create or replace function public.cart_add_design(p_token text, p_design_id uuid, p_quantity int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; d custom_designs%rowtype; pr jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to order custom designs.' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'Choose a quantity.' using errcode = 'check_violation'; end if;
  select * into d from custom_designs where id = p_design_id and user_id = auth.uid();
  if not found then raise exception 'Design not found.' using errcode = 'check_violation'; end if;
  if d.status <> 'approved' or d.approved_version is distinct from d.version then
    raise exception 'This design needs to be approved before it can be ordered.' using errcode = 'check_violation';
  end if;
  pr := price_design_internal(d.id, p_quantity);
  if pr->>'error' is not null then raise exception '%', pr->>'error' using errcode = 'check_violation'; end if;
  if (pr->>'quote_required')::boolean then
    raise exception 'Orders of % or more need a quote.', pr->>'quote_threshold' using errcode = 'check_violation';
  end if;

  select * into r from cart_resolve(p_token, true);
  insert into cart_items (cart_id, item_type, variant_id, custom_design_id, design_version, price_snapshot, quantity)
  values (r.cart_id, 'custom', d.variant_id, d.id, d.version, strip_costs(pr), p_quantity)
  on conflict (cart_id, custom_design_id) where item_type = 'custom'
  do update set quantity = excluded.quantity, design_version = excluded.design_version, variant_id = excluded.variant_id,
                price_snapshot = excluded.price_snapshot, updated_at = now();
  update carts set updated_at = now() where id = r.cart_id;
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('add_to_cart', auth.uid(), 'design', d.id::text, jsonb_build_object('quantity', p_quantity, 'custom', true));
  return jsonb_build_object('token', r.token, 'items', cart_contents(r.cart_id));
end $$;

-- Change quantity of any bag line by id (custom lines; 0 removes it).
create or replace function public.cart_set_line(p_token text, p_item_id uuid, p_quantity int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; it cart_items%rowtype;
begin
  if p_quantity is null or p_quantity < 0 or p_quantity > 9999 then raise exception 'Quantity must be between 0 and 9,999.'; end if;
  select * into r from cart_resolve(p_token, false);
  if r.cart_id is null then return jsonb_build_object('token', r.token, 'items', '[]'::jsonb); end if;
  select * into it from cart_items where id = p_item_id and cart_id = r.cart_id;
  if not found then return jsonb_build_object('token', r.token, 'items', cart_contents(r.cart_id)); end if;
  if it.item_type = 'product' then
    return cart_set_item(p_token, it.variant_id, least(p_quantity, 99), 'set');
  end if;
  if p_quantity = 0 then
    delete from cart_items where id = it.id;
  else
    update cart_items set quantity = p_quantity, updated_at = now() where id = it.id;
  end if;
  return jsonb_build_object('token', r.token, 'items', cart_contents(r.cart_id));
end $$;

-- cart_items.quantity allowed up to 99 for products; custom lines may be bigger.
alter table public.cart_items drop constraint if exists cart_items_quantity_check;
alter table public.cart_items add constraint cart_items_quantity_check
  check (quantity >= 1 and (quantity <= 99 or item_type = 'custom') and quantity <= 9999);

-- ---------------------------------------------------------------------
-- Order creation: custom lines are re-priced by the engine and the FULL
-- breakdown (incl. costs, rule ids and versions) is frozen on the line.
-- ---------------------------------------------------------------------
create or replace function public.create_order(
  p_cart_token text, p_user_id uuid, p_email text, p_phone text, p_address jsonb,
  p_rate_code text, p_discount_code text, p_idempotency_key text, p_hold_minutes int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cart uuid; v_existing orders%rowtype; v_price jsonb; v_order_id uuid; v_number text;
  v_token text := new_token(); i jsonb; v_drop limited_drops%rowtype; v_pricing jsonb;
  v_disc_total int; v_disc_left int; v_line_disc int; v_n int; v_k int := 0; v_ok int;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) < 16 then
    raise exception 'missing idempotency key';
  end if;
  select * into v_existing from orders where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'number', v_existing.number, 'total_cents', v_existing.total_cents,
                              'status', v_existing.status, 'duplicate', true);
  end if;

  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.' using errcode = 'check_violation'; end if;
  if coalesce(p_address->>'full_name', '') = '' or coalesce(p_address->>'line1', '') = '' or coalesce(p_address->>'city', '') = ''
     or not valid_province(p_address->>'province')
     or coalesce(p_address->>'postal_code', '') !~* '^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$' then
    raise exception 'Complete your shipping address (name, street, city, province and a valid postal code).' using errcode = 'check_violation';
  end if;

  if p_user_id is not null then
    select id into v_cart from carts where user_id = p_user_id and status = 'open' for update;
  else
    select id into v_cart from carts where token_hash = token_hash(p_cart_token) and status = 'open' and user_id is null for update;
  end if;
  if v_cart is null then raise exception 'Your bag is empty.' using errcode = 'check_violation'; end if;

  v_price := price_cart(v_cart, p_address->>'province', p_rate_code, p_discount_code, p_email, p_user_id);
  if jsonb_array_length(v_price->'items') = 0 then raise exception 'Your bag is empty.' using errcode = 'check_violation'; end if;
  if jsonb_array_length(v_price->'issues') > 0 then
    raise exception 'Some items in your bag need attention: %',
      (select string_agg((x->>'name') || ' (' || (x->>'issue') || ')', ', ') from jsonb_array_elements(v_price->'issues') x)
      using errcode = 'check_violation';
  end if;
  if v_price->'discount' is not null and v_price->'discount'->>'error' is not null then
    raise exception '%', v_price->'discount'->>'error' using errcode = 'check_violation';
  end if;
  if v_price->'shipping' is null then raise exception 'We don''t ship to that province yet.' using errcode = 'check_violation'; end if;

  insert into orders (user_id, cart_id, email, phone, status, subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
                      tax_lines, discount_id, discount_code, shipping_rate, shipping_address, billing_address, pricing_snapshot,
                      access_token_hash, idempotency_key, reserved_until)
  values (p_user_id, v_cart, lower(btrim(p_email)), nullif(p_phone, ''), 'payment_pending',
          (v_price->>'subtotal_cents')::int, (v_price->>'discount_cents')::int, (v_price->>'shipping_cents')::int,
          (v_price->>'tax_cents')::int, (v_price->>'total_cents')::int,
          v_price->'taxes', nullif(v_price->'discount'->>'discount_id', '')::uuid,
          case when (v_price->>'discount_cents')::int > 0 or (v_price->'discount'->>'free_shipping')::boolean then v_price->'discount'->>'code' end,
          v_price->'shipping', p_address, p_address, v_price, token_hash(v_token), p_idempotency_key,
          now() + make_interval(mins => p_hold_minutes))
  returning id, number into v_order_id, v_number;

  v_disc_total := (v_price->>'discount_cents')::int;
  v_disc_left := v_disc_total;
  v_n := jsonb_array_length(v_price->'items');

  for i in select * from jsonb_array_elements(v_price->'items') loop
    v_k := v_k + 1;
    update product_variants
       set inventory_reserved = inventory_reserved + (i->>'quantity')::int
     where id = (i->>'variant_id')::uuid and inventory_on_hand - inventory_reserved >= (i->>'quantity')::int;
    get diagnostics v_ok = row_count;
    if v_ok = 0 then
      raise exception '% (%, %) just sold out.', i->>'name', i->>'color', i->>'size' using errcode = 'check_violation';
    end if;

    v_pricing := null;
    if i->>'item_type' = 'custom' then
      v_pricing := price_design_internal((i->>'design_id')::uuid, (i->>'quantity')::int);
      if v_pricing->>'error' is not null or (v_pricing->>'total_cents')::int <> (i->>'line_total_cents')::int then
        raise exception 'The price of % changed. Review your bag and try again.', i->>'name' using errcode = 'check_violation';
      end if;
    else
      select d.* into v_drop from limited_drops d where d.product_id = (i->>'product_id')::uuid;
      if found then
        if (i->>'quantity')::int > v_drop.max_per_order then
          raise exception 'Limit % per order for %.', v_drop.max_per_order, v_drop.drop_name using errcode = 'check_violation';
        end if;
        update limited_drops set units_reserved = units_reserved + (i->>'quantity')::int
         where id = v_drop.id and units_sold + units_reserved + (i->>'quantity')::int <= edition_size and release_at <= now()
           and exists (select 1 from products where id = v_drop.product_id and status = 'active');
        get diagnostics v_ok = row_count;
        if v_ok = 0 then
          raise exception '% just sold out.', v_drop.drop_name using errcode = 'check_violation';
        end if;
      end if;
    end if;

    v_line_disc := case when v_k = v_n then v_disc_left
                        when (v_price->>'subtotal_cents')::int = 0 then 0
                        else (v_disc_total * (i->>'line_total_cents')::int / (v_price->>'subtotal_cents')::int) end;
    v_disc_left := v_disc_left - v_line_disc;

    insert into order_items (order_id, item_type, product_id, variant_id, drop_id, custom_design_id, design_version,
                             product_name, product_type, sku, color, color_hex, size,
                             unit_price_cents, quantity, line_total_cents, discount_cents, snapshot)
    values (v_order_id, i->>'item_type', (i->>'product_id')::uuid, (i->>'variant_id')::uuid,
            case when v_drop.id is not null and v_drop.product_id = (i->>'product_id')::uuid then v_drop.id end,
            nullif(i->>'design_id', '')::uuid, nullif(i->>'design_version', '')::int,
            i->>'name', i->>'product_type', i->>'sku', i->>'color', i->>'color_hex', i->>'size',
            (i->>'unit_price_cents')::int, (i->>'quantity')::int, (i->>'line_total_cents')::int, v_line_disc,
            case when v_pricing is null then i else (i - 'pricing') || jsonb_build_object('pricing', v_pricing,
              'design_config', (select config from design_versions where design_id = (i->>'design_id')::uuid and version = (i->>'design_version')::int),
              'production_files', (select production_files from design_versions where design_id = (i->>'design_id')::uuid and version = (i->>'design_version')::int)) end);
    v_drop := null;
  end loop;

  insert into order_events (order_id, status, event, note, data)
  values (v_order_id, 'payment_pending', 'stock_reserved', 'Items held for ' || p_hold_minutes || ' minutes while payment completes.',
          jsonb_build_object('reserved_until', now() + make_interval(mins => p_hold_minutes)));

  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('checkout_started', p_user_id, 'order', v_order_id::text, jsonb_build_object('total_cents', (v_price->>'total_cents')::int));

  return jsonb_build_object('order_id', v_order_id, 'number', v_number, 'total_cents', (v_price->>'total_cents')::int,
                            'currency', 'CAD', 'access_token', v_token, 'status', 'payment_pending', 'items', v_price->'items');
end $$;
revoke execute on function public.create_order(text, uuid, text, text, jsonb, text, text, text, int) from public, anon, authenticated;

-- Payment confirmed: designs were approved before they could enter the bag,
-- so custom orders record the approval and move to fulfillment.
create or replace function public.confirm_order_payment(
  p_order_id uuid, p_provider text, p_provider_ref text, p_amount_cents int, p_raw jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; it order_items%rowtype; v_numbers int[]; v_custom boolean; v_unapproved boolean;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;

  if exists (select 1 from payments where provider = p_provider and provider_ref = p_provider_ref and kind = 'charge') then
    return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', o.status, 'duplicate', true);
  end if;

  insert into payments (order_id, provider, provider_ref, kind, status, amount_cents, currency, raw)
  values (o.id, p_provider, p_provider_ref, 'charge', 'succeeded', p_amount_cents, o.currency, coalesce(p_raw, '{}'));

  if o.status <> 'payment_pending' then
    perform set_config('app.status_note', 'Payment received while order was ' || o.status || '; needs review (refund or re-reserve).', true);
    update orders set status = 'on_hold', payment_provider = p_provider, payment_ref = p_provider_ref where id = o.id;
    return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', 'on_hold');
  end if;
  if p_amount_cents <> o.total_cents then
    perform set_config('app.status_note', 'Paid amount ' || p_amount_cents || ' does not match order total ' || o.total_cents || '.', true);
    update orders set status = 'on_hold', payment_provider = p_provider, payment_ref = p_provider_ref where id = o.id;
    return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', 'on_hold');
  end if;

  for it in select * from order_items where order_id = o.id loop
    update product_variants
       set inventory_on_hand = inventory_on_hand - it.quantity, inventory_reserved = inventory_reserved - it.quantity
     where id = it.variant_id;
    insert into inventory_movements (variant_id, delta, reserved_delta, reason, reference, on_hand_after)
    select it.variant_id, -it.quantity, -it.quantity, 'sale', o.number, inventory_on_hand from product_variants where id = it.variant_id;

    if it.drop_id is not null then
      v_numbers := claim_reserved_editions(it.drop_id, it.quantity, it.id);
      update order_items set edition_numbers = v_numbers where id = it.id;
      insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
      values ('limited_drop_purchase', o.user_id, 'limited_drop', it.drop_id::text, jsonb_build_object('editions', v_numbers, 'order', o.number));
    end if;
  end loop;

  if o.discount_id is not null then
    insert into discount_redemptions (discount_id, order_id, email, user_id, amount_cents)
    values (o.discount_id, o.id, o.email, o.user_id, o.discount_cents) on conflict (order_id) do nothing;
    update discounts set uses_count = uses_count + 1 where id = o.discount_id;
  end if;

  update carts set status = 'converted' where id = o.cart_id;

  perform set_config('app.actor_type', 'provider', true);
  update orders set status = 'paid', paid_at = now(), payment_provider = p_provider, payment_ref = p_provider_ref, reserved_until = null
   where id = o.id;

  select exists (select 1 from order_items where order_id = o.id and item_type = 'custom'),
         exists (select 1 from order_items oi left join custom_designs cd on cd.id = oi.custom_design_id
                 where oi.order_id = o.id and oi.item_type = 'custom'
                   and (cd.approved_version is distinct from oi.design_version))
    into v_custom, v_unapproved;
  perform set_config('app.actor_type', 'system', true);
  if v_custom and v_unapproved then
    update orders set status = 'moderation_pending' where id = o.id;
  elsif v_custom then
    perform set_config('app.status_note', 'Custom designs were approved before checkout.', true);
    update orders set status = 'approved' where id = o.id;
    perform set_config('app.status_note', '', true);
    update orders set status = 'fulfillment_pending' where id = o.id;
  else
    update orders set status = 'fulfillment_pending' where id = o.id;
  end if;

  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('purchase', o.user_id, 'order', o.id::text, jsonb_build_object('total_cents', o.total_cents, 'number', o.number));

  select status into o.status from orders where id = o.id;
  return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', o.status);
end $$;
revoke execute on function public.confirm_order_payment(uuid, text, text, int, jsonb) from public, anon, authenticated;

-- Order lookup now describes custom lines too.
create or replace function public.order_lookup(p_number text, p_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o orders%rowtype;
begin
  select * into o from orders where number = upper(btrim(p_number));
  if not found then return null; end if;
  if not ((p_token is not null and o.access_token_hash = token_hash(p_token))
          or (auth.uid() is not null and o.user_id = auth.uid())
          or has_permission('orders.read')) then
    return null;
  end if;
  return jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'email', o.email, 'created_at', o.created_at, 'paid_at', o.paid_at,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'discount_code', o.discount_code,
    'shipping_cents', o.shipping_cents, 'tax_cents', o.tax_cents, 'tax_lines', o.tax_lines, 'total_cents', o.total_cents,
    'shipping_rate', o.shipping_rate, 'shipping_address', o.shipping_address, 'reserved_until', o.reserved_until,
    'payment_provider', o.payment_provider,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', product_name, 'item_type', item_type, 'product_type', product_type, 'color', color, 'color_hex', color_hex, 'size', size,
                'quantity', quantity, 'unit_price_cents', unit_price_cents, 'line_total_cents', line_total_cents,
                'edition_numbers', edition_numbers, 'edition_size', (select edition_size from limited_drops where id = drop_id),
                'design_id', custom_design_id, 'design_version', design_version,
                'print', (select coalesce(jsonb_agg(jsonb_build_object('label', x->>'placement_label', 'method', x->>'method_label',
                            'width_in', x->'width_in', 'height_in', x->'height_in')), '[]')
                          from jsonb_array_elements(snapshot->'pricing'->'print') x),
                'one_time_cents', (snapshot->'pricing'->>'one_time_cents')::int)
                order by created_at), '[]') from order_items where order_id = o.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'event', event, 'at', created_at) order by created_at), '[]')
               from order_events where order_id = o.id));
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.print_placements   enable row level security;
alter table public.print_methods      enable row level security;
alter table public.print_area_tiers   enable row level security;
alter table public.artwork_services   enable row level security;
alter table public.pricing_rules      enable row level security;
alter table public.custom_designs     enable row level security;
alter table public.design_versions    enable row level security;
alter table public.design_assets      enable row level security;
alter table public.moderation_terms   enable row level security;
alter table public.moderation_results enable row level security;
alter table public.quote_requests     enable row level security;

create policy "placements public" on public.print_placements for select using (true);
create policy "placements write" on public.print_placements for all using (public.has_permission('pricing.write')) with check (public.has_permission('pricing.write'));
create policy "methods public" on public.print_methods for select using (true);
create policy "methods write" on public.print_methods for all using (public.has_permission('pricing.write')) with check (public.has_permission('pricing.write'));
create policy "tiers public" on public.print_area_tiers for select using (true);
create policy "tiers write" on public.print_area_tiers for all using (public.has_permission('pricing.write')) with check (public.has_permission('pricing.write'));
create policy "services public" on public.artwork_services for select using (true);
create policy "services write" on public.artwork_services for all using (public.has_permission('pricing.write')) with check (public.has_permission('pricing.write'));
-- Rules include production costs: staff only.
create policy "rules staff" on public.pricing_rules for select using (public.has_permission('pricing.write') or public.has_permission('analytics.read'));
create policy "rules write" on public.pricing_rules for all using (public.has_permission('pricing.write')) with check (public.has_permission('pricing.write'));

create policy "own designs" on public.custom_designs for select using (user_id = auth.uid() or public.has_permission('moderation.review') or public.has_permission('orders.read'));
create policy "own design versions" on public.design_versions for select using (
  exists (select 1 from custom_designs d where d.id = design_id and (d.user_id = auth.uid() or public.has_permission('moderation.review') or public.has_permission('orders.read'))));
create policy "own assets" on public.design_assets for select using (user_id = auth.uid() or public.has_permission('moderation.review') or public.has_permission('orders.read'));
create policy "terms staff" on public.moderation_terms for all using (public.has_permission('moderation.review')) with check (public.has_permission('moderation.review'));
create policy "moderation staff" on public.moderation_results for select using (public.has_permission('moderation.review'));
create policy "own quotes" on public.quote_requests for select using (user_id = auth.uid() or public.has_permission('orders.read') or public.has_permission('customers.read'));
create policy "staff quotes" on public.quote_requests for update using (public.has_permission('orders.write')) with check (public.has_permission('orders.write'));


-- ===================== supabase/migrations/20261002000009_custom_pricing_config.sql =====================
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


-- ===================== supabase/migrations/20261002000010_custom_hardening.sql =====================
-- =====================================================================
-- 0010 Defence in depth: designer RPCs that require a signed-in user are
-- not executable by anon at all (they also check auth.uid() inside).
-- Postgres grants EXECUTE to PUBLIC by default, so revoke from PUBLIC
-- and grant back to signed-in users only.
-- =====================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.design_save(uuid, text, uuid, uuid, jsonb, jsonb, jsonb)',
    'public.design_submit(uuid)',
    'public.design_register_asset(text, text, text, text, int, int, int, text, text)',
    'public.design_get(uuid)',
    'public.design_price(uuid, int)',
    'public.cart_add_design(text, uuid, int)',
    'public.price_custom_admin(uuid, text, jsonb, text[], int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;


-- ===================== supabase/seed_custom.sql =====================

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
