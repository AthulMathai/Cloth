-- =====================================================================
-- 0014 FULFILLMENT: partners, partner inventory (blanks), production
-- orders, automatic routing, partner actions, shipments, alerts.
--
-- Flow:  order -> fulfillment_pending -> route_order() picks the best
--        qualified partner -> production order (PO) + blank reservation
--        -> partner accepts / prints / packs / ships -> carrier events
--        -> delivered.  Rejection re-routes to the next partner; no
--        qualified partner = backordered (stock) or on_hold (capability)
--        + an admin alert.  Nothing here touches payments, so a retry or
--        a re-route can never charge a customer twice.
--
-- Additive only.  Applied in parts (a..e) through the MCP connector.
-- =====================================================================

-- ---------------------------------------------------------------------
-- (a) Schema
-- ---------------------------------------------------------------------
create or replace function public.append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

-- Trusted callers: the service role over the API, or a direct database
-- session with no signed-in user (migrations, SQL editor, cron).  API traffic always arrives as
-- "authenticator", so a browser can never pass this check.
create or replace function public.is_service()
returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (auth.uid() is null and session_user not in ('authenticator', 'anon', 'authenticated'));
$$;

-- Canadian postal regions (first letter of the postal code) -> rough
-- centroid.  Used for distance when routing.  Editable data, not code.
create table if not exists public.postal_regions (
  letter    char(1) primary key check (letter ~ '^[A-Z]$'),
  province  text not null,
  label     text not null,
  lat       numeric(8,5) not null,
  lng       numeric(8,5) not null
);
insert into public.postal_regions (letter, province, label, lat, lng) values
  ('A','NL','Newfoundland and Labrador',47.56,-52.71), ('B','NS','Nova Scotia',44.65,-63.57),
  ('C','PE','Prince Edward Island',46.24,-63.13),      ('E','NB','New Brunswick',45.96,-66.64),
  ('G','QC','Eastern Quebec',46.81,-71.21),            ('H','QC','Montréal',45.50,-73.57),
  ('J','QC','Western Quebec',45.90,-73.20),            ('K','ON','Eastern Ontario',45.10,-76.00),
  ('L','ON','Central Ontario',43.60,-79.70),           ('M','ON','Toronto',43.65,-79.38),
  ('N','ON','Southwestern Ontario',42.98,-81.25),      ('P','ON','Northern Ontario',46.49,-80.99),
  ('R','MB','Manitoba',49.90,-97.14),                  ('S','SK','Saskatchewan',51.50,-106.00),
  ('T','AB','Alberta',52.00,-114.00),                  ('V','BC','British Columbia',49.28,-123.12),
  ('X','NT','Northwest Territories / Nunavut',62.45,-114.37), ('Y','YT','Yukon',60.72,-135.05)
on conflict (letter) do nothing;

create table if not exists public.partners (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name              text not null check (char_length(btrim(name)) between 2 and 120),
  status            text not null default 'onboarding' check (status in ('onboarding', 'active', 'inactive', 'suspended')),
  is_test           boolean not null default false,
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  address_line1     text,
  city              text,
  province          text check (province is null or public.valid_province(province)),
  postal_code       text,
  lat               numeric(8,5),
  lng               numeric(8,5),
  product_types     text[] not null default '{}',   -- empty = every garment type
  print_methods     text[] not null default '{}',   -- must be listed (empty = can't print)
  placements        text[] not null default '{}',   -- empty = every placement its methods allow
  ships_to          text[] not null default '{}',   -- provinces; empty = all of Canada
  capacity_per_day  int not null default 50 check (capacity_per_day > 0),   -- open units it can hold in its queue
  production_days   numeric(4,1) not null default 2 check (production_days > 0),
  tracks_inventory  boolean not null default true,  -- false = partner sources its own blanks
  accept_sla_hours  int not null default 24 check (accept_sla_hours between 1 and 240),
  integration       text not null default 'portal' check (integration in ('portal', 'webhook')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger partners_touch before update on public.partners for each row execute function public.touch_updated_at();
create trigger audit_partners after insert or update on public.partners for each row execute function public.audit_row();

-- Webhook endpoint + signing secret: fulfillment staff only (never partners' browsers).
create table if not exists public.partner_integrations (
  partner_id   uuid primary key references public.partners(id),
  webhook_url  text check (webhook_url is null or webhook_url ~ '^https://'),
  secret       text not null default public.new_token(),
  updated_at   timestamptz not null default now()
);
create trigger partner_integrations_touch before update on public.partner_integrations for each row execute function public.touch_updated_at();

-- Partner accounts are partner_admin roles scoped to one partner.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_roles_partner_fk') then
    alter table public.user_roles add constraint user_roles_partner_fk foreign key (partner_id) references public.partners(id);
  end if;
end $$;

-- Blank garments each partner holds.
create table if not exists public.partner_inventory (
  id             uuid primary key default gen_random_uuid(),
  partner_id     uuid not null references public.partners(id),
  product_type   text not null,
  color          text not null,
  size           text not null,
  on_hand        int not null default 0 check (on_hand >= 0),
  reserved       int not null default 0 check (reserved >= 0),
  low_threshold  int not null default 5 check (low_threshold >= 0),
  updated_at     timestamptz not null default now()
);
create unique index if not exists partner_inventory_key on public.partner_inventory (partner_id, product_type, lower(color), size);
create trigger partner_inventory_touch before update on public.partner_inventory for each row execute function public.touch_updated_at();

create table if not exists public.partner_inventory_movements (
  id              bigint generated always as identity primary key,
  inventory_id    uuid not null references public.partner_inventory(id),
  partner_id      uuid not null references public.partners(id),
  delta           int not null default 0,
  reserved_delta  int not null default 0,
  reason          text not null check (reason in ('count', 'receipt', 'adjustment', 'damage', 'reserve', 'release', 'consume')),
  reference       text,
  note            text,
  actor_id        uuid,
  on_hand_after   int,
  created_at      timestamptz not null default now()
);
create index if not exists partner_inv_mov on public.partner_inventory_movements (inventory_id, created_at desc);
create trigger partner_inv_mov_append_only before update or delete on public.partner_inventory_movements
  for each row execute function public.append_only();

-- Stock numbers only move through the functions below (which log a movement).
create or replace function public.guard_partner_stock()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.on_hand is distinct from old.on_hand or new.reserved is distinct from old.reserved)
     and current_setting('app.partner_stock', true) is distinct from 'on' then
    raise exception 'Partner stock changes go through partner_adjust_inventory().' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger partner_inventory_guard before update on public.partner_inventory
  for each row execute function public.guard_partner_stock();

create sequence if not exists public.production_number_seq start 50001;

create table if not exists public.production_orders (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique default ('PO-' || nextval('public.production_number_seq')),
  order_id          uuid not null references public.orders(id),
  partner_id        uuid not null references public.partners(id),
  attempt           int not null default 1,
  status            text not null default 'assigned'
                    check (status in ('assigned', 'accepted', 'in_production', 'printed', 'packed', 'shipped', 'rejected', 'cancelled')),
  units             int not null check (units > 0),
  spec              jsonb not null,
  routing           jsonb not null default '{}',
  stock_state       text not null default 'none' check (stock_state in ('none', 'reserved', 'consumed', 'released')),
  due_by            timestamptz,
  rejection_reason  text,
  reprint_count     int not null default 0,
  assigned_at       timestamptz not null default now(),
  accepted_at       timestamptz,
  started_at        timestamptz,
  printed_at        timestamptz,
  packed_at         timestamptz,
  shipped_at        timestamptz,
  closed_at         timestamptz,
  dispatch_status   text not null default 'not_required' check (dispatch_status in ('not_required', 'pending', 'sent', 'failed')),
  dispatch_attempts int not null default 0,
  next_dispatch_at  timestamptz,
  dispatch_error    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- At most one live production order per customer order: retries and
-- re-routes can never produce a garment twice.
create unique index if not exists production_orders_one_active on public.production_orders (order_id)
  where status not in ('rejected', 'cancelled');
create index if not exists production_orders_partner on public.production_orders (partner_id, status, assigned_at desc);
create index if not exists production_orders_status on public.production_orders (status, assigned_at desc);
create index if not exists production_orders_dispatch on public.production_orders (next_dispatch_at) where dispatch_status in ('pending', 'failed');
create trigger production_orders_touch before update on public.production_orders for each row execute function public.touch_updated_at();

create table if not exists public.production_order_events (
  id                   bigint generated always as identity primary key,
  production_order_id  uuid not null references public.production_orders(id),
  order_id             uuid not null references public.orders(id),
  status               text,
  event                text not null,
  note                 text,
  actor_type           text not null default 'system' check (actor_type in ('system', 'staff', 'partner', 'provider')),
  actor_id             uuid,
  data                 jsonb not null default '{}',
  created_at           timestamptz not null default now()
);
create index if not exists po_events_po on public.production_order_events (production_order_id, created_at);
create trigger po_events_append_only before update or delete on public.production_order_events
  for each row execute function public.append_only();

create table if not exists public.shipments (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id),
  production_order_id  uuid references public.production_orders(id),
  partner_id           uuid references public.partners(id),
  carrier              text not null,
  service              text,
  tracking_number      text not null check (char_length(btrim(tracking_number)) between 4 and 60),
  tracking_url         text,
  status               text not null default 'label_created'
                       check (status in ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned')),
  estimated_delivery   date,
  shipped_at           timestamptz not null default now(),
  delivered_at         timestamptz,
  last_event_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists shipments_tracking on public.shipments (lower(carrier), tracking_number);
create index if not exists shipments_order on public.shipments (order_id);
create trigger shipments_touch before update on public.shipments for each row execute function public.touch_updated_at();

create table if not exists public.shipment_events (
  id           bigint generated always as identity primary key,
  shipment_id  uuid not null references public.shipments(id),
  status       text not null,
  description  text,
  location     text,
  occurred_at  timestamptz not null default now(),
  source       text not null default 'carrier' check (source in ('carrier', 'partner', 'staff', 'test')),
  external_id  text not null,
  created_at   timestamptz not null default now(),
  unique (shipment_id, external_id)              -- carriers resend; we record once
);
create trigger shipment_events_append_only before update or delete on public.shipment_events
  for each row execute function public.append_only();

create table if not exists public.notifications (
  id                   uuid primary key default gen_random_uuid(),
  audience             text not null check (audience in ('admin', 'partner', 'customer')),
  partner_id           uuid references public.partners(id),
  user_id              uuid references auth.users(id),
  kind                 text not null,
  severity             text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title                text not null,
  body                 text,
  order_id             uuid references public.orders(id),
  production_order_id  uuid references public.production_orders(id),
  dedupe_key           text,
  data                 jsonb not null default '{}',
  read_at              timestamptz,
  resolved_at          timestamptz,
  resolved_by          uuid,
  created_at           timestamptz not null default now()
);
create unique index if not exists notifications_open_dedupe on public.notifications (dedupe_key)
  where resolved_at is null and dedupe_key is not null;
create index if not exists notifications_audience on public.notifications (audience, resolved_at, created_at desc);

-- Catalog products carry their own print files (production bucket).
alter table public.products add column if not exists production_files jsonb not null default '{}';

insert into public.store_settings (key, value, is_public) values
  ('fulfillment.allow_test_partners', 'true', false),
  ('fulfillment.auto_route', 'true', false),
  ('fulfillment.test_carrier_step_minutes', '10', false)
on conflict (key) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('production', 'production', false, 52428800, array['image/png', 'image/tiff', 'application/pdf', 'image/svg+xml'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- (b) Helpers + RLS
-- ---------------------------------------------------------------------
create or replace function public.is_partner_member(p_partner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = 'partner_admin' and partner_id = p_partner);
$$;

create or replace function public.can_fulfil_read()
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('fulfillment.read') or has_permission('fulfillment.write') or has_permission('orders.read');
$$;

create or replace function public.notify(p_audience text, p_kind text, p_severity text, p_title text, p_body text,
  p_order uuid default null, p_po uuid default null, p_partner uuid default null, p_user uuid default null,
  p_dedupe text default null, p_data jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into notifications (audience, kind, severity, title, body, order_id, production_order_id, partner_id, user_id, dedupe_key, data)
  values (p_audience, p_kind, p_severity, p_title, p_body, p_order, p_po, p_partner, p_user, p_dedupe, coalesce(p_data, '{}'))
  on conflict (dedupe_key) where resolved_at is null and dedupe_key is not null do nothing;
$$;
revoke execute on function public.notify(text, text, text, text, text, uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from store_settings where key = p_key), p_default);
$$;

create or replace function public.tracking_url(p_carrier text, p_number text)
returns text language sql immutable as $$
  select case lower(coalesce(p_carrier, ''))
    when 'canada post' then 'https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=' || p_number
    when 'purolator'   then 'https://www.purolator.com/en/shipping/tracker?pin=' || p_number
    when 'ups'         then 'https://www.ups.com/track?tracknum=' || p_number
    when 'fedex'       then 'https://www.fedex.com/fedextrack/?trknbr=' || p_number
    when 'canpar'      then 'https://www.canpar.com/en/tracking/delivery_options.htm?barcode=' || p_number
    else null end;
$$;

alter table public.postal_regions              enable row level security;
alter table public.partners                    enable row level security;
alter table public.partner_integrations        enable row level security;
alter table public.partner_inventory           enable row level security;
alter table public.partner_inventory_movements enable row level security;
alter table public.production_orders           enable row level security;
alter table public.production_order_events     enable row level security;
alter table public.shipments                   enable row level security;
alter table public.shipment_events             enable row level security;
alter table public.notifications               enable row level security;

create policy "regions read" on public.postal_regions for select using (public.is_staff());
create policy "regions write" on public.postal_regions for all using (public.has_permission('fulfillment.write')) with check (public.has_permission('fulfillment.write'));

create policy "partners read" on public.partners for select using (public.can_fulfil_read() or public.is_partner_member(id));
create policy "partners insert" on public.partners for insert with check (public.has_permission('fulfillment.write'));
create policy "partners update" on public.partners for update using (public.has_permission('fulfillment.write')) with check (public.has_permission('fulfillment.write'));

create policy "integrations staff" on public.partner_integrations for all
  using (public.has_permission('fulfillment.write')) with check (public.has_permission('fulfillment.write'));

-- Stock rows are read-only to clients; every change goes through partner_adjust_inventory().
create policy "partner stock read" on public.partner_inventory for select using (public.can_fulfil_read() or public.is_partner_member(partner_id));
create policy "partner movements read" on public.partner_inventory_movements for select using (public.can_fulfil_read() or public.is_partner_member(partner_id));

create policy "po read" on public.production_orders for select using (public.can_fulfil_read() or public.is_partner_member(partner_id));
create policy "po events read" on public.production_order_events for select using (
  public.can_fulfil_read() or exists (select 1 from production_orders p where p.id = production_order_id and public.is_partner_member(p.partner_id)));
create policy "shipments read" on public.shipments for select using (
  public.can_fulfil_read() or public.is_partner_member(partner_id)
  or exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid()));
create policy "shipment events read" on public.shipment_events for select using (
  exists (select 1 from shipments s where s.id = shipment_id and (public.can_fulfil_read() or public.is_partner_member(s.partner_id)
          or exists (select 1 from orders o where o.id = s.order_id and o.user_id = auth.uid()))));

create policy "notifications read" on public.notifications for select using (
  (audience = 'admin' and public.can_fulfil_read())
  or (audience = 'partner' and public.is_partner_member(partner_id))
  or (audience = 'customer' and user_id = auth.uid()));

-- Production print files: catalog staff upload; reads are signed server-side.
create policy "production files read" on storage.objects for select
  using (bucket_id = 'production' and (public.has_permission('catalog.write') or public.can_fulfil_read()));
create policy "production files write" on storage.objects for insert
  with check (bucket_id = 'production' and public.has_permission('catalog.write'));
create policy "production files update" on storage.objects for update
  using (bucket_id = 'production' and public.has_permission('catalog.write'));

-- Stock mover used by everything (reserve / release / consume / counts).
create or replace function public.partner_stock_move(p_inv uuid, p_delta int, p_reserved_delta int, p_reason text,
  p_reference text, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_on int; v_partner uuid;
begin
  perform set_config('app.partner_stock', 'on', true);
  update partner_inventory set on_hand = on_hand + p_delta, reserved = greatest(0, reserved + p_reserved_delta)
   where id = p_inv returning on_hand, partner_id into v_on, v_partner;
  perform set_config('app.partner_stock', 'off', true);
  insert into partner_inventory_movements (inventory_id, partner_id, delta, reserved_delta, reason, reference, note, actor_id, on_hand_after)
  values (p_inv, v_partner, p_delta, p_reserved_delta, p_reason, p_reference, p_note, auth.uid(), v_on);
  return v_on;
end $$;
revoke execute on function public.partner_stock_move(uuid, int, int, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- (c) Production spec + routing engine
-- ---------------------------------------------------------------------
create or replace function public.geo_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable as $$
  select case when lat1 is null or lat2 is null then null else round((6371 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1) / 2)), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lng2 - lng1) / 2)), 2))))::numeric, 0) end;
$$;

-- Order status that mirrors a production order's stage.
create or replace function public.po_order_status(p text)
returns public.order_status language sql immutable as $$
  select (case p when 'assigned' then 'assigned' when 'accepted' then 'production_queued' when 'in_production' then 'printing'
                 when 'printed' then 'quality_check' when 'packed' then 'packed' when 'shipped' then 'shipped'
                 else 'fulfillment_pending' end)::public.order_status;
$$;

-- Everything a partner needs to make and ship the order — and nothing
-- more (no prices, no customer email).
create or replace function public.order_production_spec(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o orders%rowtype; it record; v_items jsonb := '[]'; v_prints jsonb; v_files jsonb; v_methods text[]; v_loc text; k text;
begin
  select * into o from orders where id = p_order_id;
  if not found then return null; end if;
  for it in select oi.*, p.print_locations, p.print_methods as p_methods, p.production_files as p_files, p.slug
              from order_items oi left join products p on p.id = oi.product_id
             where oi.order_id = o.id order by oi.created_at loop
    v_prints := '[]'; v_files := '[]';
    if it.item_type = 'custom' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'placement', x->>'placement', 'placement_label', x->>'placement_label',
               'method', x->>'method', 'method_label', x->>'method_label', 'methods_any', jsonb_build_array(x->>'method'),
               'width_in', x->'width_in', 'height_in', x->'height_in')), '[]')
        into v_prints from jsonb_array_elements(coalesce(it.snapshot->'pricing'->'print', '[]')) x;
      for k in select jsonb_object_keys(coalesce(it.snapshot->'production_files', '{}')) loop
        v_files := v_files || jsonb_build_object('placement', k, 'bucket', 'designs', 'path', it.snapshot->'production_files'->>k);
      end loop;
    else
      v_methods := case when cardinality(coalesce(it.p_methods, '{}')) > 0 then it.p_methods else array['dtg'] end;
      foreach v_loc in array coalesce(it.print_locations, '{}') loop
        v_prints := v_prints || jsonb_build_object('placement', v_loc,
          'placement_label', coalesce((select label from print_placements where code = v_loc), v_loc),
          'method', v_methods[1], 'method_label', (select label from print_methods where code = v_methods[1]),
          'methods_any', to_jsonb(v_methods));
      end loop;
      for k in select jsonb_object_keys(coalesce(it.p_files, '{}')) loop
        v_files := v_files || jsonb_build_object('placement', k, 'bucket', 'production', 'path', it.p_files->>k);
      end loop;
    end if;
    v_items := v_items || jsonb_build_object(
      'item_id', it.id, 'kind', case when it.item_type = 'custom' then 'custom' else 'catalog' end,
      'name', it.product_name, 'product_type', coalesce(it.product_type, 'tee'), 'sku', it.sku,
      'color', it.color, 'color_hex', it.color_hex, 'size', it.size, 'quantity', it.quantity,
      'edition_numbers', it.edition_numbers, 'edition_size', (select edition_size from limited_drops where id = it.drop_id),
      'design_id', it.custom_design_id, 'design_version', it.design_version,
      'prints', v_prints, 'files', v_files);
  end loop;

  return jsonb_build_object(
    'order_number', o.number,
    'ship_to', jsonb_build_object(
      'name', o.shipping_address->>'full_name', 'line1', o.shipping_address->>'line1', 'line2', o.shipping_address->>'line2',
      'city', o.shipping_address->>'city', 'province', upper(o.shipping_address->>'province'),
      'postal_code', upper(o.shipping_address->>'postal_code'), 'country', 'CA',
      'phone', coalesce(o.shipping_address->>'phone', o.phone)),
    'shipping', jsonb_build_object('service', coalesce(o.shipping_rate->>'label', o.shipping_rate->>'name'), 'code', o.shipping_rate->>'code'),
    'items', v_items,
    'units', (select coalesce(sum((x->>'quantity')::int), 0) from jsonb_array_elements(v_items) x),
    'blanks', (select coalesce(jsonb_agg(jsonb_build_object('product_type', t, 'color', c, 'size', s, 'quantity', q) order by t, c, s), '[]')
               from (select x->>'product_type' t, x->>'color' c, x->>'size' s, sum((x->>'quantity')::int) q
                       from jsonb_array_elements(v_items) x group by 1, 2, 3) b),
    'prints', (select coalesce(jsonb_agg(distinct pr), '[]')
               from jsonb_array_elements(v_items) x, jsonb_array_elements(x->'prints') p0,
                    lateral (select jsonb_build_object('placement', p0->>'placement', 'placement_label', p0->>'placement_label',
                                                       'method_label', p0->>'method_label', 'methods_any', p0->'methods_any') pr) z));
end $$;
revoke execute on function public.order_production_spec(uuid) from public, anon, authenticated;

-- Reliability over the last 90 days, smoothed so a new partner starts high.
create or replace function public.partner_stats(p_partner uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with po as (select * from production_orders where partner_id = p_partner),
  recent as (select * from po where assigned_at > now() - interval '90 days'),
  agg as (
    select
      (select coalesce(sum(units), 0) from po where status in ('assigned', 'accepted', 'in_production', 'printed')) as load,
      (select count(*) from po where status in ('assigned', 'accepted', 'in_production', 'printed', 'packed')) as open_orders,
      (select count(*) from po where status = 'assigned') as awaiting_accept,
      (select count(*) from po where status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and due_by < now()) as late_open,
      (select count(*) from recent where status = 'shipped') as shipped_90,
      (select count(*) from recent where status = 'shipped' and shipped_at <= due_by) as on_time_90,
      (select count(*) from recent where status = 'rejected') as rejected_90,
      (select count(*) from po where status = 'shipped' and shipped_at > now() - interval '30 days') as shipped_30,
      (select round(avg(extract(epoch from (shipped_at - assigned_at)) / 3600)::numeric, 1) from recent where status = 'shipped') as avg_hours,
      (select coalesce(sum(reprint_count), 0) from recent) as reprints_90,
      (select count(*) from partner_inventory i where i.partner_id = p_partner and i.on_hand - i.reserved <= i.low_threshold and i.on_hand - i.reserved > 0) as low_stock,
      (select count(*) from partner_inventory i where i.partner_id = p_partner and i.on_hand - i.reserved <= 0) as out_of_stock)
  select jsonb_build_object(
    'load', a.load, 'capacity', p.capacity_per_day,
    'utilisation', round(a.load::numeric / p.capacity_per_day, 3),
    'open_orders', a.open_orders, 'awaiting_accept', a.awaiting_accept, 'late_open', a.late_open,
    'shipped_30', a.shipped_30, 'shipped_90', a.shipped_90, 'rejected_90', a.rejected_90, 'reprints_90', a.reprints_90,
    'on_time_pct', case when a.shipped_90 > 0 then round(100.0 * a.on_time_90 / a.shipped_90) end,
    'avg_hours', a.avg_hours,
    'reliability', round(((a.on_time_90 + 8)::numeric) / (a.shipped_90 + a.rejected_90 + 8), 3),
    'low_stock', a.low_stock, 'out_of_stock', a.out_of_stock)
  from agg a, partners p where p.id = p_partner;
$$;
revoke execute on function public.partner_stats(uuid) from public, anon, authenticated;

-- Score every partner for an order.  Lower score = better.  Every reason a
-- partner can't take the order is spelled out for the admin.
create or replace function public.route_candidates(p_order_id uuid, p_spec jsonb, p_exclude uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  o orders%rowtype; p partners%rowtype; v_out jsonb := '[]'; v_reasons text[]; v_capable boolean; v_stock_ok boolean; v_cap_ok boolean;
  v_prov text; v_cust record; v_plat numeric; v_plng numeric; v_km numeric; v_stats jsonb; v_util numeric; v_rel numeric;
  v_score numeric; b jsonb; pr jsonb; v_avail int; v_units int; v_tests boolean; t text;
begin
  select * into o from orders where id = p_order_id;
  v_prov := upper(o.shipping_address->>'province');
  select * into v_cust from postal_regions where letter = upper(left(o.shipping_address->>'postal_code', 1));
  v_units := (p_spec->>'units')::int;
  v_tests := setting_bool('fulfillment.allow_test_partners', true);

  for p in select * from partners where status = 'active' and (v_tests or not is_test) order by code loop
    v_reasons := '{}'; v_capable := true; v_stock_ok := true; v_cap_ok := true;

    if p.id = any(coalesce(p_exclude, '{}')) then
      v_reasons := v_reasons || 'Already rejected this order'::text; v_capable := false;
    end if;
    if cardinality(p.ships_to) > 0 and not v_prov = any(p.ships_to) then
      v_reasons := v_reasons || format('Doesn''t ship to %s', v_prov); v_capable := false;
    end if;
    for t in select distinct x->>'product_type' from jsonb_array_elements(p_spec->'blanks') x loop
      if cardinality(p.product_types) > 0 and not t = any(p.product_types) then
        v_reasons := v_reasons || format('Doesn''t make %ss', t); v_capable := false;
      end if;
    end loop;
    for pr in select * from jsonb_array_elements(p_spec->'prints') loop
      if not exists (select 1 from jsonb_array_elements_text(pr->'methods_any') m where m = any(p.print_methods)) then
        v_reasons := v_reasons || format('No %s printing', coalesce(pr->>'method_label', pr->'methods_any'->>0)); v_capable := false;
      elsif cardinality(p.placements) > 0 and not (pr->>'placement') = any(p.placements) then
        v_reasons := v_reasons || format('Can''t print %s', lower(pr->>'placement_label')); v_capable := false;
      end if;
    end loop;
    if p.tracks_inventory then
      for b in select * from jsonb_array_elements(p_spec->'blanks') loop
        select coalesce(sum(on_hand - reserved), 0) into v_avail from partner_inventory
         where partner_id = p.id and product_type = b->>'product_type' and lower(color) = lower(b->>'color') and size = b->>'size';
        if v_avail < (b->>'quantity')::int then
          v_reasons := v_reasons || format('Out of %s %s %s (%s free, needs %s)', b->>'color', b->>'product_type', b->>'size', v_avail, b->>'quantity');
          v_stock_ok := false;
        end if;
      end loop;
    end if;
    v_stats := partner_stats(p.id);
    if (v_stats->>'load')::int + v_units > p.capacity_per_day then
      v_reasons := v_reasons || format('At capacity (%s of %s units queued)', v_stats->>'load', p.capacity_per_day);
      v_cap_ok := false;
    end if;

    if p.lat is not null then v_plat := p.lat; v_plng := p.lng;
    else select lat, lng into v_plat, v_plng from postal_regions where letter = upper(left(p.postal_code, 1)); end if;
    v_km := geo_km(v_plat, v_plng, v_cust.lat, v_cust.lng);
    v_util := ((v_stats->>'load')::int + v_units)::numeric / p.capacity_per_day;
    v_rel := (v_stats->>'reliability')::numeric;
    v_score := round(coalesce(v_km, 2500) / 400 + v_util * 2 + p.production_days * 0.5 + (1 - v_rel) * 4
                     - case when p.province = v_prov then 0.5 else 0 end, 3);

    v_out := v_out || jsonb_build_object(
      'partner_id', p.id, 'code', p.code, 'name', p.name, 'city', p.city, 'province', p.province, 'is_test', p.is_test,
      'ok', v_capable and v_stock_ok and v_cap_ok, 'capable', v_capable, 'stock_ok', v_stock_ok, 'capacity_ok', v_cap_ok,
      'reasons', to_jsonb(v_reasons), 'distance_km', v_km, 'load', (v_stats->>'load')::int, 'capacity', p.capacity_per_day,
      'utilisation', round(v_util, 3), 'production_days', p.production_days, 'reliability', v_rel,
      'est_transit_days', case when v_km is null then null else 1 + ceil(v_km / 800) end, 'score', v_score);
  end loop;

  return (select coalesce(jsonb_agg(c order by (c->>'ok')::boolean desc, (c->>'capable')::boolean desc, (c->>'score')::numeric), '[]')
            from jsonb_array_elements(v_out) c);
end $$;
revoke execute on function public.route_candidates(uuid, jsonb, uuid[]) from public, anon, authenticated;

-- Set an order's status with an actor + note on the history line.
create or replace function public.fulfil_set_order_status(p_order_id uuid, p_status public.order_status, p_actor text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.actor_type', p_actor, true);
  perform set_config('app.status_note', coalesce(p_note, ''), true);
  update orders set status = p_status where id = p_order_id and status is distinct from p_status;
  perform set_config('app.status_note', '', true);
end $$;
revoke execute on function public.fulfil_set_order_status(uuid, public.order_status, text, text) from public, anon, authenticated;

-- Close a production order (rejected / cancelled) and give back its blanks.
create or replace function public.po_close(p_po uuid, p_status text, p_note text, p_actor text default 'system')
returns void language plpgsql security definer set search_path = public as $$
declare po production_orders%rowtype; b jsonb; v_inv uuid;
begin
  select * into po from production_orders where id = p_po for update;
  if not found or po.status in ('rejected', 'cancelled', 'shipped') then return; end if;
  if po.stock_state = 'reserved' then
    for b in select * from jsonb_array_elements(po.spec->'blanks') loop
      select id into v_inv from partner_inventory
       where partner_id = po.partner_id and product_type = b->>'product_type' and lower(color) = lower(b->>'color') and size = b->>'size'
       for update;
      if v_inv is not null then
        perform partner_stock_move(v_inv, 0, -(b->>'quantity')::int, 'release', po.number, p_note);
      end if;
    end loop;
  end if;
  update production_orders
     set status = p_status, closed_at = now(),
         stock_state = case when stock_state = 'reserved' then 'released' else stock_state end,
         rejection_reason = case when p_status = 'rejected' then p_note else rejection_reason end,
         dispatch_status = case when dispatch_status in ('pending', 'failed') then 'not_required' else dispatch_status end
   where id = po.id;
  insert into production_order_events (production_order_id, order_id, status, event, note, actor_type, actor_id)
  values (po.id, po.order_id, p_status, p_status, p_note, p_actor, auth.uid());
  update notifications set resolved_at = now()
   where production_order_id = po.id and resolved_at is null and audience = 'admin' and kind in ('accept_overdue', 'late', 'dispatch_failed');
  if p_status = 'cancelled' then
    perform notify('partner', 'po_cancelled', 'warning', po.number || ' was cancelled', p_note, po.order_id, po.id, po.partner_id);
  end if;
end $$;
revoke execute on function public.po_close(uuid, text, text, text) from public, anon, authenticated;

-- The router.  Idempotent: an order with a live production order is never
-- routed twice.  p_force_partner = staff reassignment / manual pick.
create or replace function public.route_order(p_order_id uuid, p_force_partner uuid default null, p_note text default null,
                                              p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype; po production_orders%rowtype; pt partners%rowtype; v_spec jsonb; v_cands jsonb; v_pick jsonb;
  v_exclude uuid[]; v_new_po uuid; v_number text; b jsonb; v_inv uuid; v_free int; v_to order_status; v_why text;
  v_actor text := case when p_force_partner is not null and auth.uid() is not null then 'staff' else 'system' end;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;

  select * into po from production_orders where order_id = o.id and status not in ('rejected', 'cancelled');
  if found and not p_dry_run then
    if p_force_partner is null then
      if o.status in ('fulfillment_pending', 'backordered') then
        perform fulfil_set_order_status(o.id, po_order_status(po.status), 'system', 'Already in production at the assigned partner.');
      end if;
      return jsonb_build_object('status', 'already_assigned', 'production_order', po.number, 'partner_id', po.partner_id);
    end if;
    if po.partner_id = p_force_partner then
      return jsonb_build_object('status', 'already_assigned', 'production_order', po.number, 'partner_id', po.partner_id);
    end if;
    if po.status not in ('assigned', 'accepted') then
      raise exception 'Production has already started at the current partner, so it can''t be moved.' using errcode = 'check_violation';
    end if;
    perform po_close(po.id, 'cancelled', 'Reassigned by TH8RTY' || coalesce(': ' || nullif(btrim(p_note), ''), '.'), v_actor);
  elsif not p_dry_run then
    if o.paid_at is null or o.status not in ('fulfillment_pending', 'backordered', 'on_hold', 'assigned') then
      if p_force_partner is null then
        return jsonb_build_object('status', 'skipped', 'reason', 'Order is ' || o.status);
      end if;
      if o.paid_at is null or o.status in ('cancelled', 'refunded', 'failed', 'payment_pending', 'created', 'moderation_pending', 'delivered', 'returned') then
        raise exception 'An order that is % can''t be sent to production.', replace(o.status::text, '_', ' ') using errcode = 'check_violation';
      end if;
    end if;
    if o.status = 'on_hold' and p_force_partner is null then
      return jsonb_build_object('status', 'skipped', 'reason', 'Order is on hold');
    end if;
  end if;

  select coalesce(array_agg(distinct partner_id), '{}') into v_exclude
    from production_orders where order_id = o.id and status = 'rejected' and partner_id is distinct from p_force_partner;
  v_spec := order_production_spec(o.id);
  v_cands := route_candidates(o.id, v_spec, v_exclude);
  if p_dry_run then
    return jsonb_build_object('spec', v_spec, 'candidates', v_cands,
      'current', case when po.id is not null then jsonb_build_object('production_order', po.number, 'partner_id', po.partner_id, 'status', po.status) end);
  end if;

  if p_force_partner is not null then
    select c into v_pick from jsonb_array_elements(v_cands) c where (c->>'partner_id')::uuid = p_force_partner;
    if v_pick is null then raise exception 'That partner isn''t active.' using errcode = 'check_violation'; end if;
    if not (v_pick->>'capable')::boolean or not (v_pick->>'stock_ok')::boolean then
      raise exception '% can''t take this order: %', v_pick->>'name',
        (select string_agg(r, '; ') from jsonb_array_elements_text(v_pick->'reasons') r) using errcode = 'check_violation';
    end if;
  else
    select c into v_pick from jsonb_array_elements(v_cands) c where (c->>'ok')::boolean limit 1;
  end if;

  if v_pick is null then
    if exists (select 1 from jsonb_array_elements(v_cands) c where (c->>'capable')::boolean) then
      v_to := 'backordered';
      v_why := 'Waiting for blanks or capacity at a partner that can make it.';
    else
      v_to := 'on_hold';
      v_why := 'No active partner can make this order' || coalesce(': ' || (
        select string_agg(distinct r, '; ') from jsonb_array_elements(v_cands) c, jsonb_array_elements_text(c->'reasons') r
         where r not like 'Out of %' and r not like 'At capacity%'), '') || '.';
    end if;
    if o.status <> v_to then perform fulfil_set_order_status(o.id, v_to, 'system', v_why); end if;
    -- one open alert per order, kept current
    update notifications
       set severity = case when v_to = 'on_hold' then 'critical' else 'warning' end,
           title = o.number || case when v_to = 'on_hold' then ' needs a fulfillment partner' else ' is backordered' end,
           body = v_why, data = jsonb_build_object('candidates', v_cands)
     where dedupe_key = 'route:' || o.id and resolved_at is null;
    if not found then
      perform notify('admin', 'fulfillment_exception', case when v_to = 'on_hold' then 'critical' else 'warning' end,
                     o.number || case when v_to = 'on_hold' then ' needs a fulfillment partner' else ' is backordered' end,
                     v_why, o.id, null, null, null, 'route:' || o.id, jsonb_build_object('candidates', v_cands));
    end if;
    return jsonb_build_object('status', v_to, 'reason', v_why, 'candidates', v_cands);
  end if;

  select * into pt from partners where id = (v_pick->>'partner_id')::uuid;
  insert into production_orders (order_id, partner_id, attempt, units, spec, routing, due_by, dispatch_status, next_dispatch_at)
  values (o.id, pt.id, (select count(*) + 1 from production_orders where order_id = o.id), (v_spec->>'units')::int, v_spec,
          jsonb_build_object('picked', v_pick, 'candidates', v_cands, 'forced', p_force_partner is not null, 'note', p_note, 'at', now()),
          now() + make_interval(hours => (ceil(pt.production_days * 24) + 24)::int),
          case when pt.integration = 'webhook' then 'pending' else 'not_required' end,
          case when pt.integration = 'webhook' then now() end)
  returning id, number into v_new_po, v_number;

  if pt.tracks_inventory then
    for b in select * from jsonb_array_elements(v_spec->'blanks') loop
      select id, on_hand - reserved into v_inv, v_free from partner_inventory
       where partner_id = pt.id and product_type = b->>'product_type' and lower(color) = lower(b->>'color') and size = b->>'size'
       for update;
      if v_inv is null or v_free < (b->>'quantity')::int then
        raise exception 'Stock at % changed while routing; try again.', pt.name;
      end if;
      perform partner_stock_move(v_inv, 0, (b->>'quantity')::int, 'reserve', v_number, o.number);
    end loop;
    update production_orders set stock_state = 'reserved' where id = v_new_po;
  end if;

  insert into production_order_events (production_order_id, order_id, status, event, note, actor_type, actor_id, data)
  values (v_new_po, o.id, 'assigned', 'assigned', coalesce(nullif(btrim(p_note), ''), 'Routed automatically'), v_actor, auth.uid(),
          jsonb_build_object('score', v_pick->'score', 'distance_km', v_pick->'distance_km'));
  perform fulfil_set_order_status(o.id, 'assigned', v_actor,
    format('Sent to %s (%s, %s) as %s', pt.name, pt.city, pt.province, v_number));
  update notifications set resolved_at = now() where dedupe_key = 'route:' || o.id and resolved_at is null;
  perform notify('partner', 'po_assigned', 'info', 'New production order ' || v_number,
                 format('%s unit(s) for %s, %s', v_spec->>'units', v_spec->'ship_to'->>'city', v_spec->'ship_to'->>'province'),
                 o.id, v_new_po, pt.id);
  return jsonb_build_object('status', 'assigned', 'production_order', v_number, 'production_order_id', v_new_po,
                            'partner_id', pt.id, 'partner', pt.name, 'score', v_pick->'score');
end $$;
revoke execute on function public.route_order(uuid, uuid, text, boolean) from public, anon, authenticated;

-- Hooks on the order itself: paid & approved -> route; cancelled -> stop production.
create or replace function public.orders_fulfillment_hooks()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'fulfillment_pending' and setting_bool('fulfillment.auto_route', true) then
    begin
      perform route_order(new.id);
    exception when others then
      perform notify('admin', 'routing_error', 'critical', 'Routing failed for ' || new.number, sqlerrm,
                     new.id, null, null, null, 'route-error:' || new.id);
    end;
  elsif new.status in ('cancelled', 'refunded', 'failed') then
    for r in select id from production_orders where order_id = new.id and status not in ('rejected', 'cancelled', 'shipped') loop
      perform po_close(r.id, 'cancelled', 'Order ' || new.status::text || ' by TH8RTY. Stop work on it.', 'system');
    end loop;
  end if;
  return new;
end $$;
revoke execute on function public.orders_fulfillment_hooks() from public, anon, authenticated;
-- Named so it fires after orders_log_status (triggers run in name order),
-- keeping the history in the order things happened.
create trigger orders_status_fulfillment after update of status on public.orders
  for each row execute function public.orders_fulfillment_hooks();

-- ---------------------------------------------------------------------
-- (d) Partner actions, shipments, outbox, sweep
-- ---------------------------------------------------------------------
create or replace function public.partner_po_action(p_po_id uuid, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  po production_orders%rowtype; o orders%rowtype; pt partners%rowtype; v_actor text; v_note text; b jsonb; v_inv uuid;
  v_ship uuid; v_carrier text; v_track text; v_to text;
begin
  select * into po from production_orders where id = p_po_id for update;
  if not found then raise exception 'Production order not found.'; end if;
  v_actor := case when is_partner_member(po.partner_id) then 'partner'
                  when has_permission('fulfillment.write') then 'staff'
                  when is_service() then coalesce(nullif(p_data->>'as', ''), 'system') end;
  if v_actor is null or v_actor not in ('partner', 'staff', 'system') then
    raise exception 'You don''t have access to this production order.' using errcode = '42501';
  end if;
  select * into o from orders where id = po.order_id for update;
  select * into pt from partners where id = po.partner_id;
  v_note := nullif(btrim(coalesce(p_data->>'note', '')), '');

  if p_action = 'note' then
    if v_note is null then raise exception 'Write a note first.' using errcode = 'check_violation'; end if;
    insert into production_order_events (production_order_id, order_id, status, event, note, actor_type, actor_id)
    values (po.id, po.order_id, po.status, 'note', v_note, v_actor, auth.uid());
    return jsonb_build_object('status', po.status);
  end if;

  if po.status in ('rejected', 'cancelled') then
    raise exception 'This production order is closed (%).', po.status using errcode = 'check_violation';
  end if;
  if o.status = 'on_hold' then
    raise exception 'TH8RTY has put this order on hold. Pause work until it''s released.' using errcode = 'check_violation';
  end if;

  case p_action
  when 'accept' then
    if po.status <> 'assigned' then raise exception 'Only new orders can be accepted.' using errcode = 'check_violation'; end if;
    update production_orders set status = 'accepted', accepted_at = now() where id = po.id;
    v_to := 'accepted';
    perform fulfil_set_order_status(o.id, 'production_queued', v_actor, format('%s accepted %s', pt.name, po.number));
    update notifications set resolved_at = now() where production_order_id = po.id and kind = 'accept_overdue' and resolved_at is null;

  when 'reject' then
    if po.status not in ('assigned', 'accepted') then
      raise exception 'Production has started; contact TH8RTY instead of rejecting.' using errcode = 'check_violation';
    end if;
    if char_length(coalesce(v_note, '')) < 3 then raise exception 'Tell us why you can''t make it.' using errcode = 'check_violation'; end if;
    perform po_close(po.id, 'rejected', v_note, v_actor);
    v_to := 'rejected';
    perform notify('admin', 'po_rejected', 'warning', format('%s rejected %s (%s)', pt.name, po.number, o.number), v_note, o.id, po.id, pt.id);
    -- back to the router, which skips partners that already said no
    perform fulfil_set_order_status(o.id, 'fulfillment_pending', v_actor, format('%s couldn''t make it: %s — re-routing', pt.name, v_note));
    select status into o.status from orders where id = o.id;
    return jsonb_build_object('status', 'rejected', 'order_status', o.status);

  when 'start' then
    if po.status <> 'accepted' then raise exception 'Accept the order before starting.' using errcode = 'check_violation'; end if;
    update production_orders set status = 'in_production', started_at = now() where id = po.id;
    v_to := 'in_production';
    perform fulfil_set_order_status(o.id, 'printing', v_actor, 'Production started');

  when 'printed' then
    if po.status <> 'in_production' then raise exception 'Start production first.' using errcode = 'check_violation'; end if;
    update production_orders set status = 'printed', printed_at = now() where id = po.id;
    v_to := 'printed';
    perform fulfil_set_order_status(o.id, 'quality_check', v_actor, 'Printing completed; quality check');

  when 'reprint' then
    if po.status <> 'printed' then raise exception 'Only printed garments can be sent back for a reprint.' using errcode = 'check_violation'; end if;
    if char_length(coalesce(v_note, '')) < 3 then raise exception 'Say what failed quality check.' using errcode = 'check_violation'; end if;
    update production_orders set status = 'in_production', reprint_count = reprint_count + 1 where id = po.id;
    v_to := 'in_production';
    perform fulfil_set_order_status(o.id, 'printing', v_actor, 'Reprint: ' || v_note);

  when 'packed' then
    if po.status <> 'printed' then raise exception 'Finish printing and quality check first.' using errcode = 'check_violation'; end if;
    if po.stock_state = 'reserved' then
      for b in select * from jsonb_array_elements(po.spec->'blanks') loop
        select id into v_inv from partner_inventory
         where partner_id = po.partner_id and product_type = b->>'product_type' and lower(color) = lower(b->>'color') and size = b->>'size'
         for update;
        perform partner_stock_move(v_inv, -(b->>'quantity')::int, -(b->>'quantity')::int, 'consume', po.number, o.number);
      end loop;
    end if;
    update production_orders set status = 'packed', packed_at = now(),
           stock_state = case when stock_state = 'reserved' then 'consumed' else stock_state end where id = po.id;
    v_to := 'packed';
    perform fulfil_set_order_status(o.id, 'packed', v_actor, 'Packed');

  when 'ship' then
    if po.status <> 'packed' then raise exception 'Pack the order before shipping.' using errcode = 'check_violation'; end if;
    v_carrier := nullif(btrim(coalesce(p_data->>'carrier', '')), '');
    v_track := upper(regexp_replace(coalesce(p_data->>'tracking_number', ''), '\s', '', 'g'));
    if v_carrier is null then raise exception 'Choose the carrier.' using errcode = 'check_violation'; end if;
    if char_length(v_track) < 4 then raise exception 'Enter the tracking number.' using errcode = 'check_violation'; end if;
    if exists (select 1 from shipments where lower(carrier) = lower(v_carrier) and tracking_number = v_track) then
      raise exception 'That tracking number is already used on another shipment.' using errcode = 'check_violation';
    end if;
    insert into shipments (order_id, production_order_id, partner_id, carrier, service, tracking_number, tracking_url, estimated_delivery, last_event_at)
    values (o.id, po.id, po.partner_id, v_carrier, nullif(btrim(coalesce(p_data->>'service', '')), ''), v_track,
            coalesce(nullif(p_data->>'tracking_url', ''), tracking_url(v_carrier, v_track)),
            nullif(p_data->>'estimated_delivery', '')::date, now())
    returning id into v_ship;
    insert into shipment_events (shipment_id, status, description, source, external_id)
    values (v_ship, 'label_created', 'Shipping label created', case when v_actor = 'partner' then 'partner' else 'staff' end, 'label');
    update production_orders set status = 'shipped', shipped_at = now() where id = po.id;
    v_to := 'shipped';
    perform fulfil_set_order_status(o.id, 'shipped', v_actor, format('Shipped with %s, tracking %s', v_carrier, v_track));
    if o.user_id is not null then
      perform notify('customer', 'order_shipped', 'info', 'Your order ' || o.number || ' has shipped',
                     format('%s tracking %s', v_carrier, v_track), o.id, po.id, null, o.user_id);
    end if;

  else
    raise exception 'Unknown action %.', p_action using errcode = 'check_violation';
  end case;

  insert into production_order_events (production_order_id, order_id, status, event, note, actor_type, actor_id, data)
  values (po.id, po.order_id, v_to, p_action, v_note, v_actor, auth.uid(), coalesce(p_data, '{}') - 'note' - 'as');
  return jsonb_build_object('status', v_to);
end $$;
revoke execute on function public.partner_po_action(uuid, text, jsonb) from public, anon;
grant execute on function public.partner_po_action(uuid, text, jsonb) to authenticated;

-- Carrier scans.  Idempotent per (shipment, external id); never moves backwards.
create or replace function public.shipment_record_event(p_shipment_id uuid, p_status text, p_description text default null,
  p_location text default null, p_occurred_at timestamptz default null, p_external_id text default null, p_source text default 'carrier')
returns jsonb language plpgsql security definer set search_path = public as $$
declare s shipments%rowtype; o orders%rowtype; v_rank_new int; v_rank_old int; v_ext text; v_rows int; v_at timestamptz;
begin
  select * into s from shipments where id = p_shipment_id for update;
  if not found then raise exception 'Shipment not found.'; end if;
  if not (is_service() or has_permission('fulfillment.write') or is_partner_member(s.partner_id)) then
    raise exception 'You don''t have access to this shipment.' using errcode = '42501';
  end if;
  if p_status not in ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned') then
    raise exception 'Unknown shipment status %.', p_status using errcode = 'check_violation';
  end if;
  v_at := coalesce(p_occurred_at, now());
  v_ext := coalesce(nullif(p_external_id, ''), p_status || '@' || to_char(v_at at time zone 'UTC', 'YYYYMMDDHH24MISS'));
  insert into shipment_events (shipment_id, status, description, location, occurred_at, source, external_id)
  values (s.id, p_status, p_description, p_location, v_at, p_source, v_ext)
  on conflict (shipment_id, external_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('duplicate', true, 'status', s.status); end if;

  update shipments set last_event_at = greatest(coalesce(last_event_at, v_at), v_at) where id = s.id;
  select * into o from orders where id = s.order_id for update;

  if p_status = 'exception' then
    update shipments set status = 'exception' where id = s.id;
    perform notify('admin', 'shipment_exception', 'warning', 'Delivery problem on ' || o.number,
                   coalesce(p_description, 'Carrier reported an exception') || coalesce(' — ' || p_location, ''), o.id, s.production_order_id,
                   null, null, 'ship-exc:' || s.id);
    return jsonb_build_object('status', 'exception');
  end if;
  if p_status = 'returned' then
    update shipments set status = 'returned' where id = s.id;
    if o.status not in ('cancelled', 'refunded') then perform fulfil_set_order_status(o.id, 'returned', 'provider', coalesce(p_description, 'Returned to sender')); end if;
    perform notify('admin', 'shipment_returned', 'warning', o.number || ' was returned to sender', p_description, o.id, s.production_order_id);
    return jsonb_build_object('status', 'returned');
  end if;

  v_rank_new := array_position(array['label_created', 'in_transit', 'out_for_delivery', 'delivered'], p_status);
  v_rank_old := coalesce(array_position(array['label_created', 'in_transit', 'out_for_delivery', 'delivered'], s.status), 1);
  if s.status in ('exception') or v_rank_new > v_rank_old then
    update shipments set status = p_status, delivered_at = case when p_status = 'delivered' then v_at else delivered_at end where id = s.id;
    update notifications set resolved_at = now() where dedupe_key = 'ship-exc:' || s.id and resolved_at is null;
    if o.status in ('shipped', 'in_transit', 'out_for_delivery') and p_status <> 'label_created' then
      perform fulfil_set_order_status(o.id, p_status::order_status, 'provider',
        coalesce(p_description, initcap(replace(p_status, '_', ' '))) || coalesce(' — ' || p_location, ''));
      if p_status in ('out_for_delivery', 'delivered') and o.user_id is not null then
        perform notify('customer', 'order_' || p_status, 'info',
          case p_status when 'delivered' then 'Your order ' || o.number || ' was delivered' else 'Your order ' || o.number || ' is out for delivery' end,
          null, o.id, s.production_order_id, null, o.user_id);
      end if;
    end if;
    if p_status = 'delivered' then
      update production_orders set closed_at = coalesce(closed_at, v_at) where id = s.production_order_id;
    end if;
    return jsonb_build_object('status', p_status);
  end if;
  return jsonb_build_object('status', s.status, 'ignored', true);
end $$;
revoke execute on function public.shipment_record_event(uuid, text, text, text, timestamptz, text, text) from public, anon;
grant execute on function public.shipment_record_event(uuid, text, text, text, timestamptz, text, text) to authenticated;

-- Test carrier: shipments booked with "Test carrier" advance one scan per
-- step (button in the portal/admin, or the scheduled sweep).  Real
-- carriers report through webhooks instead.
create or replace function public.test_carrier_advance(p_shipment_id uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare s record; v_next text; n int := 0; v_step int;
begin
  if p_shipment_id is null and not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  v_step := coalesce((select (value #>> '{}')::int from store_settings where key = 'fulfillment.test_carrier_step_minutes'), 10);
  for s in select * from shipments
            where lower(carrier) = 'test carrier' and status in ('label_created', 'in_transit', 'out_for_delivery')
              and (id = p_shipment_id or (p_shipment_id is null and coalesce(last_event_at, shipped_at) < now() - make_interval(mins => v_step)))
            order by shipped_at limit 200 loop
    v_next := case s.status when 'label_created' then 'in_transit' when 'in_transit' then 'out_for_delivery' else 'delivered' end;
    perform shipment_record_event(s.id, v_next,
      case v_next when 'in_transit' then 'Picked up — in transit (test carrier)' when 'out_for_delivery' then 'Out for delivery (test carrier)'
                  else 'Delivered (test carrier)' end,
      case v_next when 'delivered' then (select o.shipping_address->>'city' from orders o where o.id = s.order_id) end,
      now(), 'test-' || v_next, 'test');
    n := n + 1;
  end loop;
  if p_shipment_id is not null and n = 0 then
    raise exception 'Only open shipments with the test carrier can be advanced.' using errcode = 'check_violation';
  end if;
  return n;
end $$;
revoke execute on function public.test_carrier_advance(uuid) from public, anon;
grant execute on function public.test_carrier_advance(uuid) to authenticated;

-- Webhook outbox for partners that integrate by API.  Leased so two
-- workers never send the same order; the PO number is the idempotency key.
create or replace function public.fulfillment_dispatch_due(p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  with due as (
    select po.id from production_orders po
     where po.dispatch_status in ('pending', 'failed') and po.status = 'assigned'
       and coalesce(po.next_dispatch_at, now()) <= now()
     order by po.next_dispatch_at nulls first limit p_limit for update skip locked),
  leased as (
    update production_orders po set next_dispatch_at = now() + interval '5 minutes'
      from due where po.id = due.id returning po.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'po_id', l.id, 'number', l.number, 'attempt', l.dispatch_attempts + 1,
           'url', i.webhook_url, 'secret', i.secret,
           'payload', jsonb_build_object('event', 'production_order.assigned', 'idempotency_key', l.number,
                                         'production_order', l.number, 'partner', p.code, 'due_by', l.due_by, 'spec', l.spec))), '[]')
    into v
    from leased l join partners p on p.id = l.partner_id left join partner_integrations i on i.partner_id = l.partner_id;
  return v;
end $$;
revoke execute on function public.fulfillment_dispatch_due(int) from public, anon, authenticated;

create or replace function public.fulfillment_dispatch_result(p_po_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
declare po production_orders%rowtype;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  select * into po from production_orders where id = p_po_id for update;
  if not found or po.dispatch_status not in ('pending', 'failed') then return; end if;
  if p_ok then
    update production_orders set dispatch_status = 'sent', dispatch_attempts = dispatch_attempts + 1, dispatch_error = null, next_dispatch_at = null
     where id = po.id;
    insert into production_order_events (production_order_id, order_id, status, event, note)
    values (po.id, po.order_id, po.status, 'dispatched', 'Sent to the partner''s system');
    update notifications set resolved_at = now() where dedupe_key = 'dispatch:' || po.id and resolved_at is null;
  else
    update production_orders
       set dispatch_status = 'failed', dispatch_attempts = dispatch_attempts + 1, dispatch_error = left(p_error, 500),
           next_dispatch_at = now() + least(interval '6 hours', make_interval(mins => power(2, least(po.dispatch_attempts + 1, 9))::int))
     where id = po.id;
    if po.dispatch_attempts + 1 >= 5 then
      perform notify('admin', 'dispatch_failed', 'critical', 'Can''t reach the partner system for ' || po.number,
                     coalesce(p_error, 'Unknown error') || ' (still retrying)', po.order_id, po.id, po.partner_id, null, 'dispatch:' || po.id);
    end if;
  end if;
end $$;
revoke execute on function public.fulfillment_dispatch_result(uuid, boolean, text) from public, anon, authenticated;

-- Every few minutes: route anything missed, retry backorders, chase
-- partners who haven't accepted, flag late work, tick the test carrier.
create or replace function public.fulfillment_sweep()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v jsonb; n_routed int := 0; n_back int := 0; n_sla int := 0; n_late int := 0; n_test int := 0;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  if setting_bool('fulfillment.auto_route', true) then
    for r in select o.id, o.number from orders o
              where o.status in ('fulfillment_pending', 'backordered') and o.paid_at is not null
                and o.updated_at < now() - interval '2 minutes'
              order by o.paid_at limit 50 loop
      begin
        v := route_order(r.id);
        if v->>'status' = 'assigned' then n_routed := n_routed + 1; elsif v->>'status' = 'backordered' then n_back := n_back + 1; end if;
      exception when others then
        perform notify('admin', 'routing_error', 'critical', 'Routing failed for ' || r.number, sqlerrm, r.id, null, null, null, 'route-error:' || r.id);
      end;
    end loop;
  end if;
  for r in select po.id, po.number, po.order_id, po.partner_id, p.name, p.accept_sla_hours
             from production_orders po join partners p on p.id = po.partner_id
            where po.status = 'assigned' and po.assigned_at < now() - make_interval(hours => p.accept_sla_hours)
              and not exists (select 1 from notifications n where n.dedupe_key = 'accept-sla:' || po.id) loop
    perform notify('admin', 'accept_overdue', 'warning', format('%s hasn''t accepted %s', r.name, r.number),
                   format('Waiting more than %s hours. Reassign it if the partner is unavailable.', r.accept_sla_hours),
                   r.order_id, r.id, r.partner_id, null, 'accept-sla:' || r.id);
    n_sla := n_sla + 1;
  end loop;
  for r in select po.id, po.number, po.order_id, po.partner_id, p.name from production_orders po join partners p on p.id = po.partner_id
            where po.status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and po.due_by < now()
              and not exists (select 1 from notifications n where n.dedupe_key = 'late:' || po.id) loop
    perform notify('admin', 'late', 'warning', format('%s is late at %s', r.number, r.name), 'Past its ship-by time.',
                   r.order_id, r.id, r.partner_id, null, 'late:' || r.id);
    perform notify('partner', 'late', 'warning', r.number || ' is past its ship-by time', null, r.order_id, r.id, r.partner_id, null, 'p-late:' || r.id);
    n_late := n_late + 1;
  end loop;
  n_test := test_carrier_advance(null);
  return jsonb_build_object('routed', n_routed, 'backordered', n_back, 'accept_overdue', n_sla, 'late', n_late, 'test_scans', n_test);
end $$;
revoke execute on function public.fulfillment_sweep() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- (e) Admin, partner and customer read/write functions
-- ---------------------------------------------------------------------
create or replace function public.require_fulfil_read()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not can_fulfil_read() then raise exception 'You don''t have permission to do that (fulfillment.read).' using errcode = '42501'; end if;
end $$;
revoke execute on function public.require_fulfil_read() from public, anon, authenticated;

create or replace function public.po_json(po production_orders, p_detail boolean default false)
returns jsonb language sql stable security definer set search_path = public as $$
  select (to_jsonb(po) - 'routing' - case when p_detail then '' else 'spec' end)
    || jsonb_build_object(
      'order_number', o.number, 'order_status', o.status, 'on_hold', o.status = 'on_hold',
      'partner', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'city', p.city, 'province', p.province, 'is_test', p.is_test),
      'late', po.status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and po.due_by < now(),
      'ship_to', jsonb_build_object('city', po.spec->'ship_to'->>'city', 'province', po.spec->'ship_to'->>'province'),
      'summary', (select string_agg(format('%s× %s %s %s', x->>'quantity', x->>'color', x->>'product_type', x->>'size'), ', ')
                    from jsonb_array_elements(po.spec->'items') x),
      'shipment', (select jsonb_build_object('id', s.id, 'carrier', s.carrier, 'tracking_number', s.tracking_number,
                     'tracking_url', s.tracking_url, 'status', s.status) from shipments s where s.production_order_id = po.id
                    order by s.created_at desc limit 1))
  from orders o, partners p where o.id = po.order_id and p.id = po.partner_id;
$$;
revoke execute on function public.po_json(production_orders, boolean) from public, anon, authenticated;

create or replace function public.admin_fulfillment_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_fulfil_read();
  return jsonb_build_object(
    'po_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from production_orders
                    where status not in ('rejected', 'cancelled', 'shipped') or closed_at > now() - interval '30 days' or shipped_at > now() - interval '30 days'
                    group by status) x),
    'awaiting_route', (select count(*) from orders where status = 'fulfillment_pending'),
    'backordered', (select count(*) from orders where status = 'backordered'),
    'exceptions', (select count(*) from notifications where audience = 'admin' and resolved_at is null and kind in ('fulfillment_exception', 'routing_error')),
    'late', (select count(*) from production_orders where status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and due_by < now()),
    'dispatch_failed', (select count(*) from production_orders where dispatch_status = 'failed'),
    'alerts', (select count(*) from notifications where audience = 'admin' and resolved_at is null),
    'critical', (select count(*) from notifications where audience = 'admin' and resolved_at is null and severity = 'critical'),
    'in_transit', (select count(*) from shipments where status in ('label_created', 'in_transit', 'out_for_delivery')),
    'delivered_30', (select count(*) from shipments where status = 'delivered' and delivered_at > now() - interval '30 days'),
    'avg_hours_30', (select round(avg(extract(epoch from (shipped_at - assigned_at)) / 3600)::numeric, 1) from production_orders
                      where status = 'shipped' and shipped_at > now() - interval '30 days'),
    'avg_delivery_hours_30', (select round(avg(extract(epoch from (delivered_at - shipped_at)) / 3600)::numeric, 1) from shipments
                      where delivered_at > now() - interval '30 days'),
    'partners', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'city', p.city, 'province', p.province,
                    'status', p.status, 'is_test', p.is_test, 'stats', partner_stats(p.id)) order by p.status = 'active' desc, p.name), '[]') from partners p),
    'test_partners_allowed', setting_bool('fulfillment.allow_test_partners', true),
    'auto_route', setting_bool('fulfillment.auto_route', true),
    'can_write', has_permission('fulfillment.write'));
end $$;
revoke execute on function public.admin_fulfillment_overview() from public, anon;
grant execute on function public.admin_fulfillment_overview() to authenticated;

create or replace function public.admin_partner(p_partner_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p partners%rowtype;
begin
  perform require_fulfil_read();
  select * into p from partners where id = p_partner_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'partner', to_jsonb(p), 'stats', partner_stats(p.id),
    'integration', (select jsonb_build_object('webhook_url', i.webhook_url,
                      'secret', case when has_permission('fulfillment.write') then i.secret end) from partner_integrations i where i.partner_id = p.id),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', ur.user_id, 'email', pr.email, 'name', pr.full_name, 'since', ur.created_at)), '[]')
                  from user_roles ur left join profiles pr on pr.id = ur.user_id where ur.role = 'partner_admin' and ur.partner_id = p.id),
    'inventory', (select coalesce(jsonb_agg(to_jsonb(i) order by i.product_type, i.color, array_position(array['XS','S','M','L','XL','XXL','3XL'], i.size)), '[]')
                    from partner_inventory i where i.partner_id = p.id),
    'recent', (select coalesce(jsonb_agg(po_json(po) order by po.assigned_at desc), '[]')
                 from production_orders po where po.id in (select id from production_orders where partner_id = p.id order by assigned_at desc limit 50)),
    'can_write', has_permission('fulfillment.write'), 'can_manage_users', has_permission('users.manage') or has_permission('fulfillment.write'));
end $$;
revoke execute on function public.admin_partner(uuid) from public, anon;
grant execute on function public.admin_partner(uuid) to authenticated;

create or replace function public.admin_production_orders(p_status text default null, p_partner uuid default null, p_q text default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_fulfil_read();
  return (select coalesce(jsonb_agg(po_json(po) order by po.assigned_at desc), '[]') from production_orders po where po.id in (
    select po.id from production_orders po join orders o on o.id = po.order_id
     where (p_partner is null or po.partner_id = p_partner)
       and (p_status is null or p_status = '' or
            case p_status when 'open' then po.status in ('assigned', 'accepted', 'in_production', 'printed', 'packed')
                          when 'late' then po.status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and po.due_by < now()
                          when 'closed' then po.status in ('shipped', 'rejected', 'cancelled')
                          else po.status = p_status end)
       and (p_q is null or p_q = '' or po.number ilike '%' || p_q || '%' or o.number ilike '%' || p_q || '%')
     order by po.assigned_at desc limit least(coalesce(p_limit, 200), 500)));
end $$;
revoke execute on function public.admin_production_orders(text, uuid, text, int) from public, anon;
grant execute on function public.admin_production_orders(text, uuid, text, int) to authenticated;

-- Everything fulfillment-related for one customer order (order page panel).
create or replace function public.admin_order_fulfillment(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_fulfil_read();
  return jsonb_build_object(
    'production_orders', (select coalesce(jsonb_agg(po_json(po, true) || jsonb_build_object('routing', po.routing,
        'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'event', e.event, 'note', e.note, 'actor_type', e.actor_type,
                     'actor', (select email from profiles where id = e.actor_id), 'data', e.data, 'at', e.created_at) order by e.created_at, e.id), '[]')
                   from production_order_events e where e.production_order_id = po.id)) order by po.assigned_at), '[]')
      from production_orders po where po.order_id = p_order_id),
    'shipments', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
        'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'description', e.description, 'location', e.location,
                     'source', e.source, 'at', e.occurred_at) order by e.occurred_at, e.id), '[]') from shipment_events e where e.shipment_id = s.id))
        order by s.created_at), '[]') from shipments s where s.order_id = p_order_id),
    'alerts', (select coalesce(jsonb_agg(to_jsonb(n) - 'data' order by n.created_at desc), '[]') from notifications n
                where n.order_id = p_order_id and n.audience = 'admin' and n.resolved_at is null),
    'can_write', has_permission('fulfillment.write'));
end $$;
revoke execute on function public.admin_order_fulfillment(uuid) from public, anon;
grant execute on function public.admin_order_fulfillment(uuid) to authenticated;

-- Staff routing: preview candidates, route now, or move to a chosen partner.
create or replace function public.admin_route_order(p_order_id uuid, p_partner_id uuid default null, p_note text default null, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_dry_run then perform require_fulfil_read(); else perform require_permission('fulfillment.write'); end if;
  return route_order(p_order_id, p_partner_id, p_note, p_dry_run);
end $$;
revoke execute on function public.admin_route_order(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.admin_route_order(uuid, uuid, text, boolean) to authenticated;

create or replace function public.admin_alerts(p_open boolean default true, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_fulfil_read();
  return (select coalesce(jsonb_agg(to_jsonb(n) - 'data' || jsonb_build_object('order_number', (select number from orders where id = n.order_id),
            'po_number', (select number from production_orders where id = n.production_order_id),
            'partner_name', (select name from partners where id = n.partner_id)) order by n.created_at desc), '[]')
          from (select * from notifications where audience = 'admin' and (not p_open or resolved_at is null)
                 order by created_at desc limit least(coalesce(p_limit, 100), 500)) n);
end $$;
revoke execute on function public.admin_alerts(boolean, int) from public, anon;
grant execute on function public.admin_alerts(boolean, int) to authenticated;

create or replace function public.notification_resolve(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare n notifications%rowtype;
begin
  select * into n from notifications where id = p_id for update;
  if not found then raise exception 'Alert not found.'; end if;
  if not ((n.audience = 'admin' and (has_permission('fulfillment.write') or has_permission('orders.write')))
          or (n.audience = 'partner' and is_partner_member(n.partner_id))
          or (n.audience = 'customer' and n.user_id = auth.uid())) then
    raise exception 'You can''t change that alert.' using errcode = '42501';
  end if;
  update notifications set resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()),
         read_at = coalesce(read_at, now()) where id = p_id;
end $$;
revoke execute on function public.notification_resolve(uuid) from public, anon;
grant execute on function public.notification_resolve(uuid) to authenticated;

-- Give a signed-up account access to one partner's portal.
create or replace function public.admin_add_partner_user(p_partner_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_name text;
begin
  if not (has_permission('users.manage') or has_permission('fulfillment.write')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  select name into v_name from partners where id = p_partner_id;
  if v_name is null then raise exception 'Partner not found.'; end if;
  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'No account uses %. Ask them to create one at /account first.', btrim(p_email) using errcode = 'check_violation';
  end if;
  if exists (select 1 from user_roles where user_id = v_user and role <> 'partner_admin') then
    raise exception 'That account is TH8RTY staff; use a separate account for the partner portal.' using errcode = 'check_violation';
  end if;
  insert into user_roles (user_id, role, partner_id, granted_by) values (v_user, 'partner_admin', p_partner_id, auth.uid())
  on conflict do nothing;
  return jsonb_build_object('user_id', v_user, 'email', lower(btrim(p_email)), 'partner', v_name);
end $$;
revoke execute on function public.admin_add_partner_user(uuid, text) from public, anon;
grant execute on function public.admin_add_partner_user(uuid, text) to authenticated;

-- ---- Partner portal ----
create or replace function public.partner_me()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'city', p.city, 'province', p.province,
           'status', p.status, 'is_test', p.is_test, 'capacity_per_day', p.capacity_per_day, 'production_days', p.production_days,
           'tracks_inventory', p.tracks_inventory, 'print_methods', p.print_methods, 'product_types', p.product_types,
           'stats', partner_stats(p.id),
           'counts', (select jsonb_build_object(
               'new', count(*) filter (where status = 'assigned'),
               'production', count(*) filter (where status in ('accepted', 'in_production', 'printed')),
               'shipping', count(*) filter (where status = 'packed')) from production_orders where partner_id = p.id),
           'alerts', (select count(*) from notifications n where n.audience = 'partner' and n.partner_id = p.id and n.resolved_at is null))
           order by p.name), '[]')
  from partners p where is_partner_member(p.id);
$$;
revoke execute on function public.partner_me() from public, anon;
grant execute on function public.partner_me() to authenticated;

create or replace function public.partner_guard(p_partner uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_partner_member(p_partner) or can_fulfil_read()) then
    raise exception 'You don''t have access to this partner.' using errcode = '42501';
  end if;
end $$;
revoke execute on function public.partner_guard(uuid) from public, anon, authenticated;

create or replace function public.partner_queue(p_partner_id uuid, p_bucket text default 'new', p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform partner_guard(p_partner_id);
  return (select coalesce(jsonb_agg(po_json(po, true) order by
            case when p_bucket = 'done' then extract(epoch from coalesce(po.closed_at, po.shipped_at, po.assigned_at)) * -1
                 else extract(epoch from coalesce(po.due_by, po.assigned_at)) end), '[]')
          from production_orders po where po.id in (select id from production_orders where partner_id = p_partner_id
                  and case p_bucket
                        when 'new' then status = 'assigned'
                        when 'production' then status in ('accepted', 'in_production', 'printed')
                        when 'shipping' then status = 'packed'
                        when 'done' then status in ('shipped', 'rejected', 'cancelled') and assigned_at > now() - interval '60 days'
                        else true end
                order by assigned_at desc limit least(coalesce(p_limit, 100), 300)));
end $$;
revoke execute on function public.partner_queue(uuid, text, int) from public, anon;
grant execute on function public.partner_queue(uuid, text, int) to authenticated;

create or replace function public.partner_po(p_po_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare po production_orders%rowtype;
begin
  select * into po from production_orders where id = p_po_id;
  if not found then return null; end if;
  perform partner_guard(po.partner_id);
  return po_json(po, true) || jsonb_build_object(
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'event', e.event, 'note', e.note, 'actor_type', e.actor_type, 'at', e.created_at)
                 order by e.created_at, e.id), '[]') from production_order_events e where e.production_order_id = po.id),
    'shipment_events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'description', e.description, 'location', e.location, 'at', e.occurred_at)
                 order by e.occurred_at, e.id), '[]') from shipment_events e join shipments s on s.id = e.shipment_id where s.production_order_id = po.id));
end $$;
revoke execute on function public.partner_po(uuid) from public, anon;
grant execute on function public.partner_po(uuid) to authenticated;

create or replace function public.partner_adjust_inventory(p_partner_id uuid, p_product_type text, p_color text, p_size text,
  p_mode text, p_qty int, p_reason text default 'count', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i partner_inventory%rowtype; v_delta int;
begin
  if not (is_partner_member(p_partner_id) or has_permission('fulfillment.write') or has_permission('inventory.write')) then
    raise exception 'You don''t have access to this partner''s stock.' using errcode = '42501';
  end if;
  if coalesce(p_product_type, '') !~ '^[a-z_]{2,30}$' or char_length(btrim(coalesce(p_color, ''))) < 2 or coalesce(p_size, '') !~ '^[A-Z0-9]{1,5}$' then
    raise exception 'Choose a garment, colour and size.' using errcode = 'check_violation';
  end if;
  if p_mode not in ('set', 'add') or p_qty is null then raise exception 'Enter a quantity.' using errcode = 'check_violation'; end if;
  if p_reason not in ('count', 'receipt', 'adjustment', 'damage') then raise exception 'Unknown reason.' using errcode = 'check_violation'; end if;

  insert into partner_inventory (partner_id, product_type, color, size) values (p_partner_id, p_product_type, initcap(btrim(p_color)), p_size)
  on conflict (partner_id, product_type, lower(color), size) do nothing;
  select * into i from partner_inventory
   where partner_id = p_partner_id and product_type = p_product_type and lower(color) = lower(btrim(p_color)) and size = p_size for update;
  v_delta := case p_mode when 'set' then p_qty - i.on_hand else p_qty end;
  if i.on_hand + v_delta < i.reserved then
    raise exception '% are reserved for open orders, so on hand can''t go below that.', i.reserved using errcode = 'check_violation';
  end if;
  if v_delta <> 0 then
    perform partner_stock_move(i.id, v_delta, 0, p_reason, null, nullif(btrim(coalesce(p_note, '')), ''));
  end if;
  select * into i from partner_inventory where id = i.id;
  return to_jsonb(i);
end $$;
revoke execute on function public.partner_adjust_inventory(uuid, text, text, text, text, int, text, text) from public, anon;
grant execute on function public.partner_adjust_inventory(uuid, text, text, text, text, int, text, text) to authenticated;

create or replace function public.partner_update_settings(p_partner_id uuid, p_capacity int default null, p_production_days numeric default null,
  p_paused boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p partners%rowtype;
begin
  if not (is_partner_member(p_partner_id) or has_permission('fulfillment.write')) then
    raise exception 'You don''t have access to this partner.' using errcode = '42501';
  end if;
  select * into p from partners where id = p_partner_id for update;
  if p_capacity is not null and (p_capacity < 1 or p_capacity > 100000) then raise exception 'Capacity must be at least 1.' using errcode = 'check_violation'; end if;
  if p_production_days is not null and (p_production_days <= 0 or p_production_days > 60) then
    raise exception 'Production time must be between a few hours and 60 days.' using errcode = 'check_violation';
  end if;
  if p_paused is not null and p.status not in ('active', 'inactive') then
    raise exception 'This partner is % — contact TH8RTY to change that.', p.status using errcode = 'check_violation';
  end if;
  update partners set capacity_per_day = coalesce(p_capacity, capacity_per_day),
                      production_days = coalesce(p_production_days, production_days),
                      status = case when p_paused is null then status when p_paused then 'inactive' else 'active' end
   where id = p.id returning * into p;
  return to_jsonb(p);
end $$;
revoke execute on function public.partner_update_settings(uuid, int, numeric, boolean) from public, anon;
grant execute on function public.partner_update_settings(uuid, int, numeric, boolean) to authenticated;

-- Server-side file signing asks this first (as the caller), so only people
-- allowed to see the production order get links to its print files.
create or replace function public.production_files_for(p_po_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare po production_orders%rowtype;
begin
  select * into po from production_orders where id = p_po_id;
  if not found then return null; end if;
  perform partner_guard(po.partner_id);
  if po.status in ('rejected', 'cancelled') and not can_fulfil_read() then return '[]'; end if;
  return (select coalesce(jsonb_agg(f || jsonb_build_object('item_id', x->>'item_id', 'name', x->>'name')), '[]')
            from jsonb_array_elements(po.spec->'items') x, jsonb_array_elements(x->'files') f);
end $$;
revoke execute on function public.production_files_for(uuid) from public, anon;
grant execute on function public.production_files_for(uuid) to authenticated;

-- Customer tracking: shipments + where it's being made (city only).
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.order_lookup(text,text)'::regprocedure);
  n := replace(d, $x$'payment_provider', o.payment_provider,$x$,
$x$'payment_provider', o.payment_provider,
    'production', (select jsonb_build_object('city', p.city, 'province', p.province, 'stage', po.status,
                     'assigned_at', po.assigned_at, 'shipped_at', po.shipped_at, 'due_by', po.due_by)
                     from production_orders po join partners p on p.id = po.partner_id
                    where po.order_id = o.id and po.status not in ('rejected', 'cancelled') limit 1),
    'shipments', (select coalesce(jsonb_agg(jsonb_build_object('carrier', s.carrier, 'service', s.service, 'tracking_number', s.tracking_number,
                    'tracking_url', s.tracking_url, 'status', s.status, 'estimated_delivery', s.estimated_delivery,
                    'shipped_at', s.shipped_at, 'delivered_at', s.delivered_at,
                    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'description', e.description,
                                 'location', e.location, 'at', e.occurred_at) order by e.occurred_at desc, e.id desc), '[]')
                               from shipment_events e where e.shipment_id = s.id)) order by s.created_at), '[]')
                  from shipments s where s.order_id = o.id),$x$);
  if n = d then raise exception 'order_lookup patch did not apply'; end if;
  execute n;
end $$;

-- ---------------------------------------------------------------------
-- (f) Development test partners (fictional; is_test = true).
--     Turn them off with store setting fulfillment.allow_test_partners.
-- ---------------------------------------------------------------------
insert into public.partners (code, name, status, is_test, contact_name, contact_email, city, province, postal_code, lat, lng,
                             product_types, print_methods, placements, ships_to, capacity_per_day, production_days, notes) values
  ('toronto-test',   'Toronto Fulfillment (test)',   'active', true, 'Test contact', 'toronto-partner@example.test',   'Toronto',   'ON', 'M5V 2T6', 43.6426, -79.3871,
   '{}', array['dtg','dtf','sublimation'], '{}', '{}', 120, 1.5, 'Fictional development partner. Not a real business.'),
  ('montreal-test',  'Montréal Fulfillment (test)',  'active', true, 'Test contact', 'montreal-partner@example.test',  'Montréal',  'QC', 'H2X 1Y4', 45.5088, -73.5617,
   array['tee','hoodie','crewneck','longsleeve'], array['dtg','dtf'], '{}', array['QC','ON','NB','NS','PE','NL'], 80, 1.2, 'Fictional development partner. Not a real business.'),
  ('ottawa-test',    'Ottawa Fulfillment (test)',    'active', true, 'Test contact', 'ottawa-partner@example.test',    'Ottawa',    'ON', 'K1P 1J1', 45.4215, -75.6972,
   array['tee','hoodie'], array['dtf'], array['front','back','left_chest'], array['ON','QC'], 30, 2.0, 'Fictional development partner. Not a real business.'),
  ('calgary-test',   'Calgary Fulfillment (test)',   'active', true, 'Test contact', 'calgary-partner@example.test',   'Calgary',   'AB', 'T2P 1J9', 51.0447, -114.0719,
   array['tee','hoodie','crewneck','longsleeve'], array['dtg','dtf','sublimation'], '{}', array['AB','BC','SK','MB','NT','YT','NU'], 60, 2.0, 'Fictional development partner. Not a real business.'),
  ('vancouver-test', 'Vancouver Fulfillment (test)', 'active', true, 'Test contact', 'vancouver-partner@example.test', 'Vancouver', 'BC', 'V6B 1A1', 49.2827, -123.1207,
   '{}', array['dtg','dtf','embroidery'], '{}', array['BC','AB','YT'], 50, 1.8, 'Fictional development partner. Not a real business.')
on conflict (code) do nothing;

-- Blanks: every type/colour/size each partner makes, with varied counts
-- (deterministic), a few gaps, and Ottawa out of XL black hoodies.
insert into public.partner_inventory (partner_id, product_type, color, size, on_hand, low_threshold)
select p.id, b.product_type, b.color, b.size,
       case when p.code = 'ottawa-test' and b.product_type = 'hoodie' and b.color = 'Black' and b.size = 'XL' then 0
            when abs(hashtext(p.code || b.product_type || b.color || b.size)) % 11 = 0 then 0
            else 6 + abs(hashtext(b.size || p.code || b.color || b.product_type)) % 140 end,
       5
from public.partners p
cross join (select distinct pr.product_type, v.color, v.size from public.product_variants v join public.products pr on pr.id = v.product_id
             where pr.product_type is not null and v.color is not null and v.size is not null) b
where p.is_test and (cardinality(p.product_types) = 0 or b.product_type = any(p.product_types))
on conflict (partner_id, product_type, lower(color), size) do nothing;

insert into public.partner_integrations (partner_id) select id from public.partners where is_test on conflict do nothing;

-- Scheduled sweep (Netlify) also calls these as the service role.
grant execute on function public.fulfillment_sweep() to service_role;
grant execute on function public.fulfillment_dispatch_due(int) to service_role;
grant execute on function public.fulfillment_dispatch_result(uuid, boolean, text) to service_role;
grant execute on function public.partner_po_action(uuid, text, jsonb) to service_role;
grant execute on function public.shipment_record_event(uuid, text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.route_order(uuid, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------
-- (g) Hardening (security advisor)
-- ---------------------------------------------------------------------
alter function public.tracking_url(text, text) set search_path = public;
alter function public.geo_km(numeric, numeric, numeric, numeric) set search_path = public;
alter function public.po_order_status(text) set search_path = public;
revoke execute on function public.setting_bool(text, boolean) from public, anon, authenticated;
