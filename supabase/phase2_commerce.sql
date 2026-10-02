-- TH8RTY Phase 2 (cart, checkout, orders, taxes, shipping, discounts).
-- For a database that already ran the Phase 1 setup.
-- Paste into Supabase → SQL Editor → Run, once.

-- ===================== supabase/migrations/20261002000006_commerce.sql =====================
-- =====================================================================
-- 0006 COMMERCE: carts (guest + signed-in), addresses, tax rates by
-- province with effective dates, shipping zones & rates, discount codes,
-- orders with append-only event history, payments, webhook idempotency,
-- stock & edition reservations, and the single pricing function used by
-- cart, checkout and (later) admin.
--
-- Money is integer cents (CAD). Every price the customer pays is computed
-- here from database rows; the browser never submits a price.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Limited drops gain reservations: checkout holds pieces while payment is
-- in flight; numbers are only assigned when payment is confirmed, so
-- edition numbers stay contiguous with no gaps from abandoned checkouts.
-- ---------------------------------------------------------------------
alter table public.limited_drops
  add column units_reserved int not null default 0,
  add column max_per_order int not null default 2 check (max_per_order > 0);
alter table public.limited_drops drop constraint units_within_edition;
alter table public.limited_drops add constraint units_within_edition
  check (units_sold >= 0 and units_reserved >= 0 and units_sold + units_reserved <= edition_size);

-- ---------------------------------------------------------------------
-- Order status
-- ---------------------------------------------------------------------
create type public.order_status as enum (
  'created', 'payment_pending', 'paid', 'moderation_pending', 'approved',
  'fulfillment_pending', 'assigned', 'production_queued', 'printing',
  'quality_check', 'packed', 'shipped', 'in_transit', 'out_for_delivery',
  'delivered', 'cancelled', 'refunded', 'failed', 'on_hold', 'backordered', 'returned'
);

-- ---------------------------------------------------------------------
-- Addresses (customer address book)
-- ---------------------------------------------------------------------
create table public.addresses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  full_name    text not null check (char_length(full_name) between 1 and 120),
  line1        text not null check (char_length(line1) between 1 and 200),
  line2        text check (char_length(line2) <= 200),
  city         text not null check (char_length(city) between 1 and 100),
  province     char(2) not null,
  postal_code  text not null check (postal_code ~* '^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$'),
  country      char(2) not null default 'CA',
  phone        text check (char_length(phone) <= 40),
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index addresses_user on public.addresses (user_id);
create unique index addresses_one_default on public.addresses (user_id) where is_default;
create trigger addresses_touch before update on public.addresses for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Taxes: one row per tax component, effective-dated.
-- ---------------------------------------------------------------------
create table public.tax_rates (
  id              uuid primary key default gen_random_uuid(),
  province        char(2) not null,
  tax_type        text not null check (tax_type in ('GST', 'HST', 'PST', 'QST', 'RST')),
  label           text not null,
  rate            numeric(7,5) not null check (rate >= 0 and rate < 1),
  effective_from  date not null,
  effective_to    date,
  created_at      timestamptz not null default now(),
  constraint tax_dates check (effective_to is null or effective_to >= effective_from)
);
create index tax_rates_lookup on public.tax_rates (province, effective_from);

-- ---------------------------------------------------------------------
-- Shipping: zones are sets of provinces; each zone has rate options.
-- carrier stays null until a real carrier integration is configured.
-- ---------------------------------------------------------------------
create table public.shipping_zones (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  provinces  text[] not null,
  created_at timestamptz not null default now()
);
create table public.shipping_rates (
  id               uuid primary key default gen_random_uuid(),
  zone_id          uuid not null references public.shipping_zones(id) on delete cascade,
  code             text not null check (code ~ '^[a-z0-9_]+$'),
  label            text not null,
  carrier          text,
  price_cents      int not null check (price_cents >= 0),
  free_over_cents  int check (free_over_cents >= 0),
  min_days         int not null check (min_days >= 0),
  max_days         int not null,
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  unique (zone_id, code),
  constraint days_order check (max_days >= min_days)
);

-- ---------------------------------------------------------------------
-- Discounts
-- ---------------------------------------------------------------------
create table public.discounts (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,32}$'),
  description         text,
  kind                text not null check (kind in ('percent', 'fixed', 'free_shipping', 'bxgy')),
  value               numeric(10,2) not null default 0 check (value >= 0),   -- percent, or cents for fixed
  scope               text not null default 'all' check (scope in ('all', 'products', 'categories', 'collections')),
  scope_ids           uuid[] not null default '{}',
  exclude_limited     boolean not null default false,
  min_subtotal_cents  int not null default 0 check (min_subtotal_cents >= 0),
  buy_qty             int check (buy_qty > 0),
  get_qty             int check (get_qty > 0),
  starts_at           timestamptz,
  ends_at             timestamptz,
  max_uses            int check (max_uses > 0),
  uses_count          int not null default 0,
  per_customer_limit  int check (per_customer_limit > 0),
  first_order_only    boolean not null default false,
  customer_emails     text[] not null default '{}',         -- customer-specific codes
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint percent_range check (kind <> 'percent' or value <= 100),
  constraint bxgy_qty check (kind <> 'bxgy' or (buy_qty is not null and get_qty is not null)),
  constraint date_order check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create trigger discounts_touch before update on public.discounts for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Carts. Guests are identified by an opaque token (only its SHA-256 is
-- stored); signed-in customers by user_id. All access goes through the
-- cart_* functions below, so the tables have RLS with no public policies.
-- ---------------------------------------------------------------------
create table public.carts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  token_hash  text unique,
  status      text not null default 'open' check (status in ('open', 'converted', 'abandoned')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint cart_owner check (user_id is not null or token_hash is not null)
);
create unique index carts_one_open_per_user on public.carts (user_id) where status = 'open' and user_id is not null;
create trigger carts_touch before update on public.carts for each row execute function public.touch_updated_at();

create table public.cart_items (
  id                uuid primary key default gen_random_uuid(),
  cart_id           uuid not null references public.carts(id) on delete cascade,
  item_type         text not null default 'product' check (item_type in ('product', 'custom')),
  variant_id        uuid not null references public.product_variants(id) on delete cascade,
  custom_design_id  uuid,                 -- Phase 3
  price_snapshot    jsonb,                -- Phase 3: custom pricing snapshot
  quantity          int not null check (quantity between 1 and 99),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index cart_items_unique_product on public.cart_items (cart_id, variant_id) where item_type = 'product';
create index cart_items_cart on public.cart_items (cart_id);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create sequence public.order_number_seq start 10001;

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique default ('TH-' || nextval('public.order_number_seq')),
  user_id            uuid references auth.users(id) on delete set null,
  cart_id            uuid references public.carts(id) on delete set null,
  email              text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text,
  status             public.order_status not null default 'created',
  currency           char(3) not null default 'CAD',
  subtotal_cents     int not null check (subtotal_cents >= 0),
  discount_cents     int not null default 0 check (discount_cents >= 0),
  shipping_cents     int not null default 0 check (shipping_cents >= 0),
  tax_cents          int not null default 0 check (tax_cents >= 0),
  total_cents        int not null check (total_cents >= 0),
  tax_lines          jsonb not null default '[]',
  discount_id        uuid references public.discounts(id) on delete set null,
  discount_code      text,
  shipping_rate      jsonb,
  shipping_address   jsonb not null,
  billing_address    jsonb,
  pricing_snapshot   jsonb not null,
  payment_provider   text,
  payment_ref        text,
  access_token_hash  text not null,
  idempotency_key    text not null unique,
  reserved_until     timestamptz,
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint total_math check (total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents)
);
create index orders_user on public.orders (user_id, created_at desc);
create index orders_status on public.orders (status, created_at desc);
create index orders_email on public.orders (lower(email));
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

create table public.order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id) on delete cascade,
  item_type         text not null default 'product',
  product_id        uuid references public.products(id) on delete set null,
  variant_id        uuid references public.product_variants(id) on delete set null,
  drop_id           uuid references public.limited_drops(id) on delete set null,
  product_name      text not null,
  product_type      text,
  sku               text,
  color             text,
  color_hex         text,
  size              text,
  unit_price_cents  int not null check (unit_price_cents >= 0),
  quantity          int not null check (quantity > 0),
  line_total_cents  int not null check (line_total_cents >= 0),
  discount_cents    int not null default 0,
  edition_numbers   int[],
  snapshot          jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create index order_items_order on public.order_items (order_id);
create index order_items_product on public.order_items (product_id);

alter table public.edition_allocations
  add constraint edition_allocations_item_fk foreign key (order_item_id) references public.order_items(id) on delete restrict;

-- Append-only history: never updated, never deleted.
create table public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  status      public.order_status,
  event       text not null,
  note        text,
  actor_type  text not null default 'system' check (actor_type in ('system', 'customer', 'staff', 'partner', 'provider')),
  actor_id    uuid,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index order_events_order on public.order_events (order_id, created_at);

create or replace function public.order_events_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'order history is append-only';
end $$;
create trigger order_events_no_update before update or delete on public.order_events
  for each row execute function public.order_events_immutable();

-- Status changes are recorded automatically, whoever makes them.
create or replace function public.log_order_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into order_events (order_id, status, event, actor_id, actor_type)
    values (new.id, new.status, 'order_created', auth.uid(), case when auth.uid() is null then 'system' else 'customer' end);
  elsif new.status is distinct from old.status then
    insert into order_events (order_id, status, event, actor_id, actor_type,
                              note)
    values (new.id, new.status, 'status_changed', auth.uid(),
            coalesce(nullif(current_setting('app.actor_type', true), ''), case when auth.uid() is null then 'system' else 'staff' end),
            nullif(current_setting('app.status_note', true), ''));
  end if;
  return new;
end $$;
create trigger orders_log_status after insert or update of status on public.orders
  for each row execute function public.log_order_status();
revoke execute on function public.log_order_status() from public, anon, authenticated;

create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete restrict,
  provider      text not null,
  provider_ref  text not null,
  kind          text not null default 'charge' check (kind in ('charge', 'refund')),
  status        text not null,
  amount_cents  int not null,
  currency      char(3) not null default 'CAD',
  raw           jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (provider, provider_ref, kind)
);
create index payments_order on public.payments (order_id);

create table public.webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  event_id      text not null,
  event_type    text,
  payload       jsonb,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  unique (provider, event_id)
);

create table public.discount_redemptions (
  id            uuid primary key default gen_random_uuid(),
  discount_id   uuid not null references public.discounts(id) on delete cascade,
  order_id      uuid not null unique references public.orders(id) on delete cascade,
  email         text not null,
  user_id       uuid,
  amount_cents  int not null,
  created_at    timestamptz not null default now()
);
create index discount_redemptions_lookup on public.discount_redemptions (discount_id, lower(email));

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.token_hash(t text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex');
$$;

create or replace function public.new_token()
returns text language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function public.valid_province(p text)
returns boolean language sql immutable set search_path = public as $$
  select upper(coalesce(p, '')) in ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT');
$$;

-- Current unit price for a variant (variant override, sale, product price).
create or replace function public.variant_price(v public.product_variants, p public.products)
returns int language sql stable set search_path = public as $$
  select coalesce(v.sale_price_cents, v.price_cents, p.sale_price_cents, p.base_price_cents);
$$;

-- Normal products flip between active and out_of_stock with their stock.
create or replace function public.refresh_product_stock_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_avail int; v_status product_status; v_limited boolean;
begin
  select status, is_limited into v_status, v_limited from products where id = new.product_id;
  if v_limited or v_status not in ('active', 'out_of_stock') then return new; end if;
  select coalesce(sum(inventory_on_hand - inventory_reserved), 0) into v_avail
  from product_variants where product_id = new.product_id and is_active;
  if v_status = 'active' and v_avail <= 0 then
    update products set status = 'out_of_stock' where id = new.product_id;
  elsif v_status = 'out_of_stock' and v_avail > 0 then
    update products set status = 'active' where id = new.product_id;
  end if;
  return new;
end $$;
create trigger product_variants_stock_status after update of inventory_on_hand, inventory_reserved on public.product_variants
  for each row execute function public.refresh_product_stock_status();
revoke execute on function public.refresh_product_stock_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Edition allocation, now reservation-aware.
--   from_reservation = true : convert pieces held at checkout into
--                              numbered, sold pieces (payment confirmed)
--   from_reservation = false: direct allocation (admin/manual), must fit
--                              alongside outstanding reservations
-- ---------------------------------------------------------------------
drop function public.allocate_editions(uuid, int, uuid);
create or replace function public.allocate_editions(
  p_drop_id uuid, p_qty int, p_order_item_id uuid default null, p_from_reservation boolean default false)
returns int[] language plpgsql security definer set search_path = public as $$
declare
  v_after int; v_size int; v_product uuid; v_status product_status; v_release timestamptz; v_numbers int[];
begin
  if p_qty is null or p_qty < 1 then raise exception 'quantity must be positive'; end if;

  select d.product_id, p.status, d.release_at into v_product, v_status, v_release
  from limited_drops d join products p on p.id = d.product_id where d.id = p_drop_id;
  if not found then raise exception 'drop not found'; end if;

  if p_from_reservation then
    update limited_drops
       set units_sold = units_sold + p_qty, units_reserved = units_reserved - p_qty
     where id = p_drop_id and units_reserved >= p_qty and units_sold + p_qty <= edition_size
    returning units_sold, edition_size into v_after, v_size;
    if not found then raise exception 'no matching reservation for this drop' using errcode = 'check_violation'; end if;
  else
    if v_status <> 'active' then
      raise exception 'drop is not purchasable (status %)', v_status using errcode = 'check_violation';
    end if;
    if v_release > now() then
      raise exception 'drop has not been released yet' using errcode = 'check_violation';
    end if;
    update limited_drops
       set units_sold = units_sold + p_qty
     where id = p_drop_id and units_sold + units_reserved + p_qty <= edition_size
    returning units_sold, edition_size into v_after, v_size;
    if not found then raise exception 'not enough editions remaining' using errcode = 'check_violation'; end if;
  end if;

  select array_agg(n order by n) into v_numbers from generate_series(v_after - p_qty + 1, v_after) n;
  insert into edition_allocations (drop_id, edition_number, order_item_id)
  select p_drop_id, n, p_order_item_id from unnest(v_numbers) n;

  update limited_drops
     set original_price_cents = coalesce(original_price_cents,
           (select coalesce(sale_price_cents, base_price_cents) from products where id = v_product))
   where id = p_drop_id;

  if v_after >= v_size then
    update limited_drops set sold_out_at = now() where id = p_drop_id;
    update products set status = 'sold_out' where id = v_product;
    perform archive_due_drops();
  end if;
  return v_numbers;
end $$;
revoke execute on function public.allocate_editions(uuid, int, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Storefront view: remaining = size - sold - reserved
-- ---------------------------------------------------------------------
create or replace view public.storefront_products with (security_invoker = true) as
select
  p.id, p.slug, p.name, p.description, p.product_type, p.tags, p.currency,
  p.base_price_cents, p.sale_price_cents,
  coalesce(p.sale_price_cents, p.base_price_cents) as price_cents,
  p.status, p.publish_at, p.is_limited, p.is_customizable, p.is_featured,
  p.materials, p.print_locations, p.print_methods, p.sketch_callouts, p.seo, p.created_at,
  p.category_id, c.slug as category_slug, c.name as category_name,
  p.collection_id, co.slug as collection_slug, co.name as collection_name,
  p.designer_id, de.slug as designer_slug, de.name as designer_name,
  d.id as drop_id, d.slug as drop_slug, d.drop_name, d.drop_number, d.edition_size, d.units_sold,
  case when d.id is not null then d.edition_size - d.units_sold - d.units_reserved end as units_remaining,
  d.release_at, d.sold_out_at, d.archived_at,
  (select coalesce(sum(v.inventory_on_hand - v.inventory_reserved), 0)
     from product_variants v where v.product_id = p.id and v.is_active) as stock_available,
  (select jsonb_agg(jsonb_build_object('url', m.url, 'alt', m.alt, 'view', m.view, 'kind', m.kind) order by m.sort_order)
     from product_media m where m.product_id = p.id and not m.is_historical) as media,
  (select jsonb_agg(distinct jsonb_build_object('color', v.color, 'hex', v.color_hex))
     from product_variants v where v.product_id = p.id and v.is_active) as colors,
  (p.status = 'active'
     and (p.publish_at is null or p.publish_at <= now())
     and (d.id is null or (d.release_at <= now() and d.units_sold + d.units_reserved < d.edition_size))
  ) as is_purchasable,
  d.units_reserved,
  d.max_per_order
from products p
left join categories c on c.id = p.category_id
left join collections co on co.id = p.collection_id
left join designers de on de.id = p.designer_id
left join limited_drops d on d.product_id = p.id;

-- ---------------------------------------------------------------------
-- Cart resolution. Signed-in: the user's open cart (a guest cart from the
-- same browser is merged in on first use). Guest: by token hash.
-- ---------------------------------------------------------------------
create or replace function public.cart_resolve(p_token text, p_create boolean, out cart_id uuid, out token text)
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_guest uuid; v_hash text := case when p_token is null or p_token = '' then null else token_hash(p_token) end;
begin
  token := p_token;
  if v_hash is not null then
    select id into v_guest from carts where token_hash = v_hash and status = 'open' and user_id is null;
  end if;

  if v_uid is not null then
    select id into cart_id from carts where user_id = v_uid and status = 'open';
    if cart_id is null and v_guest is not null then
      update carts set user_id = v_uid where id = v_guest;          -- claim the guest cart
      cart_id := v_guest;
    elsif cart_id is not null and v_guest is not null and v_guest <> cart_id then
      insert into cart_items (cart_id, item_type, variant_id, quantity)
      select cart_id, item_type, variant_id, quantity from cart_items where cart_items.cart_id = v_guest and item_type = 'product'
      on conflict (cart_id, variant_id) where item_type = 'product'
      do update set quantity = least(99, cart_items.quantity + excluded.quantity);
      update carts set status = 'abandoned' where id = v_guest;
    end if;
    if cart_id is null and p_create then
      insert into carts (user_id) values (v_uid) returning id into cart_id;
    end if;
    return;
  end if;

  cart_id := v_guest;
  if cart_id is null and p_create then
    token := new_token();
    insert into carts (token_hash) values (token_hash(token)) returning id into cart_id;
  end if;
end $$;
revoke execute on function public.cart_resolve(text, boolean) from public, anon, authenticated;

-- Cart contents with live product data and availability.
create or replace function public.cart_contents(p_cart_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
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
      end
  ) order by ci.created_at), '[]'::jsonb)
  from cart_items ci
  join product_variants v on v.id = ci.variant_id
  join products p on p.id = v.product_id
  left join limited_drops d on d.product_id = p.id
  where ci.cart_id = p_cart_id;
$$;
revoke execute on function public.cart_contents(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Public cart API (anon + authenticated). Token-scoped; never trusts
-- prices from the client.
-- ---------------------------------------------------------------------
create or replace function public.cart_get(p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from cart_resolve(p_token, false);
  return jsonb_build_object('token', r.token, 'items',
    case when r.cart_id is null then '[]'::jsonb else cart_contents(r.cart_id) end);
end $$;

create or replace function public.cart_set_item(p_token text, p_variant_id uuid, p_quantity int, p_mode text default 'set')
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; v_current int; v_qty int; v_ok boolean;
begin
  if p_mode not in ('set', 'add') then raise exception 'mode must be set or add'; end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 99 then raise exception 'quantity must be between 0 and 99'; end if;

  select * into r from cart_resolve(p_token, p_quantity > 0);
  if r.cart_id is null then return jsonb_build_object('token', r.token, 'items', '[]'::jsonb); end if;

  select quantity into v_current from cart_items where cart_id = r.cart_id and variant_id = p_variant_id and item_type = 'product';
  v_qty := case when p_mode = 'add' then coalesce(v_current, 0) + p_quantity else p_quantity end;

  if v_qty <= 0 then
    delete from cart_items where cart_id = r.cart_id and variant_id = p_variant_id and item_type = 'product';
  else
    -- Only purchasable products can be added (archived/sold-out/unreleased never).
    select sp.is_purchasable into v_ok
    from product_variants v join storefront_products sp on sp.id = v.product_id
    where v.id = p_variant_id and v.is_active;
    if not coalesce(v_ok, false) then
      raise exception 'This item can''t be added to your bag right now.' using errcode = 'check_violation';
    end if;
    insert into cart_items (cart_id, variant_id, quantity) values (r.cart_id, p_variant_id, least(v_qty, 99))
    on conflict (cart_id, variant_id) where item_type = 'product' do update set quantity = excluded.quantity, updated_at = now();
  end if;
  update carts set updated_at = now() where id = r.cart_id;
  return jsonb_build_object('token', r.token, 'items', cart_contents(r.cart_id));
end $$;

-- ---------------------------------------------------------------------
-- Discount evaluation for a set of priced lines.
-- p_lines: [{product_id, category_id, collection_id, is_limited, unit, qty}]
-- ---------------------------------------------------------------------
create or replace function public.evaluate_discount(p_code text, p_lines jsonb, p_subtotal int, p_email text, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d discounts%rowtype; v_eligible int; v_amount int := 0; v_units int; v_free int; v_used int;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;
  select * into d from discounts where code = upper(btrim(p_code));
  if not found or not d.is_active then
    return jsonb_build_object('code', upper(btrim(p_code)), 'error', 'That code isn''t valid.');
  end if;
  if d.starts_at is not null and d.starts_at > now() then
    return jsonb_build_object('code', d.code, 'error', 'That code isn''t active yet.');
  end if;
  if d.ends_at is not null and d.ends_at <= now() then
    return jsonb_build_object('code', d.code, 'error', 'That code has expired.');
  end if;
  if d.max_uses is not null and d.uses_count >= d.max_uses then
    return jsonb_build_object('code', d.code, 'error', 'That code has reached its usage limit.');
  end if;
  if cardinality(d.customer_emails) > 0 and (p_email is null or lower(p_email) <> all (select lower(x) from unnest(d.customer_emails) x)) then
    return jsonb_build_object('code', d.code, 'error', 'That code isn''t available for this email address.', 'needs_email', p_email is null);
  end if;
  if d.per_customer_limit is not null and (p_email is not null or p_user is not null) then
    select count(*) into v_used from discount_redemptions
     where discount_id = d.id and (lower(email) = lower(p_email) or (p_user is not null and user_id = p_user));
    if v_used >= d.per_customer_limit then
      return jsonb_build_object('code', d.code, 'error', 'You''ve already used this code.');
    end if;
  end if;
  if d.first_order_only and (p_email is not null or p_user is not null) and exists (
      select 1 from orders o where o.paid_at is not null
        and (lower(o.email) = lower(p_email) or (p_user is not null and o.user_id = p_user))) then
    return jsonb_build_object('code', d.code, 'error', 'That code is for first orders only.');
  end if;
  if p_subtotal < d.min_subtotal_cents then
    return jsonb_build_object('code', d.code, 'error',
      'Add ' || to_char((d.min_subtotal_cents - p_subtotal) / 100.0, 'FM$999,990.00') || ' more to use this code.');
  end if;

  -- eligible lines by scope
  with l as (
    select (x->>'unit')::int unit, (x->>'qty')::int qty, (x->>'product_id')::uuid pid,
           nullif(x->>'category_id','')::uuid cid, nullif(x->>'collection_id','')::uuid coid, (x->>'is_limited')::boolean lim
    from jsonb_array_elements(p_lines) x
  ), e as (
    select * from l
    where (not d.exclude_limited or not lim)
      and (d.scope = 'all'
        or (d.scope = 'products' and pid = any(d.scope_ids))
        or (d.scope = 'categories' and cid = any(d.scope_ids))
        or (d.scope = 'collections' and coid = any(d.scope_ids)))
  )
  select coalesce(sum(unit * qty), 0), coalesce(sum(qty), 0) into v_eligible, v_units from e;

  if d.kind <> 'free_shipping' and v_eligible = 0 then
    return jsonb_build_object('code', d.code, 'error', 'That code doesn''t apply to anything in your bag.');
  end if;

  if d.kind = 'percent' then
    v_amount := round(v_eligible * d.value / 100.0);
  elsif d.kind = 'fixed' then
    v_amount := least(round(d.value)::int, v_eligible);
  elsif d.kind = 'bxgy' then
    v_free := (v_units / (d.buy_qty + d.get_qty)) * d.get_qty;
    if v_free = 0 then
      return jsonb_build_object('code', d.code, 'error',
        'Add ' || (d.buy_qty + d.get_qty - v_units) || ' more eligible item(s) to use this code.');
    end if;
    with l as (
      select (x->>'unit')::int unit, (x->>'qty')::int qty, (x->>'product_id')::uuid pid,
             nullif(x->>'category_id','')::uuid cid, nullif(x->>'collection_id','')::uuid coid, (x->>'is_limited')::boolean lim
      from jsonb_array_elements(p_lines) x
    ), units as (
      select unit from l, generate_series(1, qty)
      where (not d.exclude_limited or not lim)
        and (d.scope = 'all' or (d.scope = 'products' and pid = any(d.scope_ids))
          or (d.scope = 'categories' and cid = any(d.scope_ids)) or (d.scope = 'collections' and coid = any(d.scope_ids)))
      order by unit asc limit v_free
    )
    select coalesce(sum(unit), 0) into v_amount from units;
  end if;

  return jsonb_build_object('code', d.code, 'discount_id', d.id, 'kind', d.kind,
    'label', coalesce(d.description, d.code), 'amount_cents', v_amount,
    'free_shipping', d.kind = 'free_shipping');
end $$;
revoke execute on function public.evaluate_discount(text, jsonb, int, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- THE pricing function. Cart page, checkout quote and order creation all
-- call this, so what the customer sees is exactly what is charged.
-- ---------------------------------------------------------------------
create or replace function public.price_cart(
  p_cart_id uuid, p_province text, p_rate_code text, p_discount_code text, p_email text, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb; v_lines jsonb; v_subtotal int; v_issues jsonb;
  v_disc jsonb; v_disc_amt int := 0; v_free_ship boolean := false;
  v_prov text := upper(nullif(btrim(coalesce(p_province, '')), ''));
  v_options jsonb := '[]'; v_sel jsonb; v_ship int := 0;
  v_taxable int; v_taxes jsonb := '[]'; v_tax int := 0;
begin
  v_items := cart_contents(p_cart_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'category_id', p.category_id, 'collection_id', p.collection_id,
           'is_limited', p.is_limited, 'unit', (i->>'unit_price_cents')::int, 'qty', (i->>'quantity')::int)), '[]'),
         coalesce(sum((i->>'line_total_cents')::int), 0),
         coalesce(jsonb_agg(jsonb_build_object('item_id', i->>'item_id', 'name', i->>'name', 'issue', i->>'issue'))
                  filter (where i->>'issue' is not null), '[]')
    into v_lines, v_subtotal, v_issues
  from jsonb_array_elements(v_items) i join products p on p.id = (i->>'product_id')::uuid;

  v_disc := evaluate_discount(p_discount_code, v_lines, v_subtotal, p_email, p_user);
  if v_disc is not null and v_disc->>'error' is null then
    v_disc_amt := least((v_disc->>'amount_cents')::int, v_subtotal);
    v_free_ship := (v_disc->>'free_shipping')::boolean;
  end if;

  if v_prov is not null and valid_province(v_prov) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'code', r.code, 'label', r.label, 'carrier', r.carrier,
             'price_cents', case when v_free_ship or (r.free_over_cents is not null and v_subtotal - v_disc_amt >= r.free_over_cents) then 0 else r.price_cents end,
             'regular_cents', r.price_cents, 'free_over_cents', r.free_over_cents,
             'min_days', r.min_days, 'max_days', r.max_days) order by r.sort_order, r.price_cents), '[]')
      into v_options
    from shipping_rates r join shipping_zones z on z.id = r.zone_id
    where r.is_active and v_prov = any(z.provinces);

    select o into v_sel from jsonb_array_elements(v_options) o where o->>'code' = p_rate_code;
    if v_sel is null then v_sel := v_options -> 0; end if;
    v_ship := coalesce((v_sel->>'price_cents')::int, 0);

    -- tax base: discounted goods + shipping
    v_taxable := v_subtotal - v_disc_amt + v_ship;
    select coalesce(jsonb_agg(jsonb_build_object('type', t.tax_type, 'label', t.label, 'rate', t.rate,
                                                 'amount_cents', round(v_taxable * t.rate)::int) order by t.tax_type), '[]'),
           coalesce(sum(round(v_taxable * t.rate)::int), 0)
      into v_taxes, v_tax
    from tax_rates t
    where t.province = v_prov and t.effective_from <= current_date and (t.effective_to is null or t.effective_to >= current_date);
  end if;

  return jsonb_build_object(
    'items', v_items, 'issues', v_issues,
    'subtotal_cents', v_subtotal,
    'discount', v_disc, 'discount_cents', v_disc_amt,
    'province', v_prov,
    'shipping_options', v_options, 'shipping', v_sel, 'shipping_cents', v_ship,
    'taxes', v_taxes, 'tax_cents', v_tax,
    'total_cents', v_subtotal - v_disc_amt + v_ship + v_tax,
    'currency', 'CAD', 'priced_at', now());
end $$;
revoke execute on function public.price_cart(uuid, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.cart_quote(p_token text, p_province text default null, p_rate_code text default null,
                                             p_discount_code text default null, p_email text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from cart_resolve(p_token, false);
  if r.cart_id is null then
    return jsonb_build_object('token', r.token, 'items', '[]'::jsonb, 'subtotal_cents', 0, 'total_cents', 0);
  end if;
  return price_cart(r.cart_id, p_province, p_rate_code, p_discount_code, p_email, auth.uid())
         || jsonb_build_object('token', r.token);
end $$;

-- ---------------------------------------------------------------------
-- Order creation (service role only, called by netlify/functions/checkout).
-- Re-prices from the database, reserves stock and editions atomically,
-- and is idempotent on p_idempotency_key.
-- ---------------------------------------------------------------------
create or replace function public.create_order(
  p_cart_token text, p_user_id uuid, p_email text, p_phone text, p_address jsonb,
  p_rate_code text, p_discount_code text, p_idempotency_key text, p_hold_minutes int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_cart uuid; v_existing orders%rowtype; v_price jsonb; v_order_id uuid; v_number text;
  v_token text := new_token(); i jsonb; v_drop limited_drops%rowtype; v_item_id uuid;
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

  -- address validation
  if p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.' using errcode = 'check_violation'; end if;
  if coalesce(p_address->>'full_name', '') = '' or coalesce(p_address->>'line1', '') = '' or coalesce(p_address->>'city', '') = ''
     or not valid_province(p_address->>'province')
     or coalesce(p_address->>'postal_code', '') !~* '^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$' then
    raise exception 'Complete your shipping address (name, street, city, province and a valid postal code).' using errcode = 'check_violation';
  end if;

  -- cart (user cart wins; token only for guests)
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
    -- reserve stock (fails if someone else got the last one first)
    update product_variants
       set inventory_reserved = inventory_reserved + (i->>'quantity')::int
     where id = (i->>'variant_id')::uuid and inventory_on_hand - inventory_reserved >= (i->>'quantity')::int;
    get diagnostics v_ok = row_count;
    if v_ok = 0 then
      raise exception '% (%, %) just sold out.', i->>'name', i->>'color', i->>'size' using errcode = 'check_violation';
    end if;

    -- reserve limited editions
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

    -- spread the order discount across lines (remainder on the last)
    v_line_disc := case when v_k = v_n then v_disc_left
                        when (v_price->>'subtotal_cents')::int = 0 then 0
                        else (v_disc_total * (i->>'line_total_cents')::int / (v_price->>'subtotal_cents')::int) end;
    v_disc_left := v_disc_left - v_line_disc;

    insert into order_items (order_id, item_type, product_id, variant_id, drop_id, product_name, product_type, sku, color, color_hex, size,
                             unit_price_cents, quantity, line_total_cents, discount_cents, snapshot)
    values (v_order_id, i->>'item_type', (i->>'product_id')::uuid, (i->>'variant_id')::uuid,
            case when v_drop.id is not null and v_drop.product_id = (i->>'product_id')::uuid then v_drop.id end,
            i->>'name', i->>'product_type', i->>'sku', i->>'color', i->>'color_hex', i->>'size',
            (i->>'unit_price_cents')::int, (i->>'quantity')::int, (i->>'line_total_cents')::int, v_line_disc, i);
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

-- ---------------------------------------------------------------------
-- Payment confirmation (service role; called by the payment webhook or the
-- mock payment function). Idempotent per provider reference.
-- ---------------------------------------------------------------------
create or replace function public.confirm_order_payment(
  p_order_id uuid, p_provider text, p_provider_ref text, p_amount_cents int, p_raw jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; it order_items%rowtype; v_numbers int[]; v_next order_status; v_custom boolean;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;

  if exists (select 1 from payments where provider = p_provider and provider_ref = p_provider_ref and kind = 'charge') then
    return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', o.status, 'duplicate', true);
  end if;

  insert into payments (order_id, provider, provider_ref, kind, status, amount_cents, currency, raw)
  values (o.id, p_provider, p_provider_ref, 'charge', 'succeeded', p_amount_cents, o.currency, coalesce(p_raw, '{}'));

  -- The money arrived but we can't fulfil automatically: hold for a human.
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

  -- reservations -> sales
  for it in select * from order_items where order_id = o.id loop
    update product_variants
       set inventory_on_hand = inventory_on_hand - it.quantity, inventory_reserved = inventory_reserved - it.quantity
     where id = it.variant_id;
    insert into inventory_movements (variant_id, delta, reserved_delta, reason, reference, on_hand_after)
    select it.variant_id, -it.quantity, -it.quantity, 'sale', o.number, inventory_on_hand from product_variants where id = it.variant_id;

    if it.drop_id is not null then
      v_numbers := allocate_editions(it.drop_id, it.quantity, it.id, true);
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
  delete from cart_items where cart_id = o.cart_id;

  perform set_config('app.actor_type', 'provider', true);
  update orders set status = 'paid', paid_at = now(), payment_provider = p_provider, payment_ref = p_provider_ref, reserved_until = null
   where id = o.id;

  select exists (select 1 from order_items where order_id = o.id and item_type = 'custom') into v_custom;
  v_next := case when v_custom then 'moderation_pending' else 'fulfillment_pending' end;
  perform set_config('app.actor_type', 'system', true);
  update orders set status = v_next where id = o.id;

  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('purchase', o.user_id, 'order', o.id::text, jsonb_build_object('total_cents', o.total_cents, 'number', o.number));

  return jsonb_build_object('order_id', o.id, 'number', o.number, 'status', v_next);
end $$;
revoke execute on function public.confirm_order_payment(uuid, text, text, int, jsonb) from public, anon, authenticated;

-- Release a pending order's holds (declined payment, abandoned checkout).
create or replace function public.release_order(p_order_id uuid, p_status order_status, p_note text)
returns boolean language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; it order_items%rowtype;
begin
  if p_status not in ('cancelled', 'failed') then raise exception 'release status must be cancelled or failed'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found or o.status <> 'payment_pending' then return false; end if;
  for it in select * from order_items where order_id = o.id loop
    update product_variants set inventory_reserved = greatest(0, inventory_reserved - it.quantity) where id = it.variant_id;
    if it.drop_id is not null then
      update limited_drops set units_reserved = greatest(0, units_reserved - it.quantity) where id = it.drop_id;
    end if;
  end loop;
  perform set_config('app.status_note', p_note, true);
  update orders set status = p_status, cancelled_at = now(), reserved_until = null where id = o.id;
  return true;
end $$;
revoke execute on function public.release_order(uuid, order_status, text) from public, anon, authenticated;

create or replace function public.expire_pending_orders()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from orders where status = 'payment_pending' and reserved_until < now() for update skip locked loop
    if release_order(r.id, 'cancelled', 'Checkout expired before payment; items released.') then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke execute on function public.expire_pending_orders() from public, anon, authenticated;

-- Guest-safe order view: by number + access token (or owner / staff).
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
                'name', product_name, 'product_type', product_type, 'color', color, 'color_hex', color_hex, 'size', size,
                'quantity', quantity, 'unit_price_cents', unit_price_cents, 'line_total_cents', line_total_cents,
                'edition_numbers', edition_numbers, 'edition_size', (select edition_size from limited_drops where id = drop_id))
                order by created_at), '[]') from order_items where order_id = o.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'event', event, 'at', created_at) order by created_at), '[]')
               from order_events where order_id = o.id));
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.addresses            enable row level security;
alter table public.tax_rates            enable row level security;
alter table public.shipping_zones       enable row level security;
alter table public.shipping_rates       enable row level security;
alter table public.discounts            enable row level security;
alter table public.carts                enable row level security;
alter table public.cart_items           enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_events         enable row level security;
alter table public.payments             enable row level security;
alter table public.webhook_events       enable row level security;
alter table public.discount_redemptions enable row level security;

create policy "own addresses" on public.addresses for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "staff read addresses" on public.addresses for select using (public.has_permission('customers.read'));

create policy "tax public" on public.tax_rates for select using (true);
create policy "tax write" on public.tax_rates for all using (public.has_permission('settings.write')) with check (public.has_permission('settings.write'));
create policy "zones public" on public.shipping_zones for select using (true);
create policy "zones write" on public.shipping_zones for all using (public.has_permission('settings.write')) with check (public.has_permission('settings.write'));
create policy "rates public" on public.shipping_rates for select using (true);
create policy "rates write" on public.shipping_rates for all using (public.has_permission('settings.write')) with check (public.has_permission('settings.write'));

-- Discount codes are not browsable by the public (prevents code harvesting).
create policy "discounts staff" on public.discounts for all using (public.has_permission('marketing.write')) with check (public.has_permission('marketing.write'));
create policy "redemptions staff" on public.discount_redemptions for select using (public.has_permission('marketing.write') or public.has_permission('orders.read'));

create policy "carts staff" on public.carts for select using (public.has_permission('customers.read'));
create policy "cart items staff" on public.cart_items for select using (public.has_permission('customers.read'));

create policy "own orders" on public.orders for select using (user_id = auth.uid() or public.has_permission('orders.read'));
create policy "staff update orders" on public.orders for update using (public.has_permission('orders.write')) with check (public.has_permission('orders.write'));
create policy "own order items" on public.order_items for select using (
  exists (select 1 from orders o where o.id = order_id and (o.user_id = auth.uid() or public.has_permission('orders.read'))));
create policy "own order events" on public.order_events for select using (
  exists (select 1 from orders o where o.id = order_id and (o.user_id = auth.uid() or public.has_permission('orders.read'))));
create policy "staff add order events" on public.order_events for insert with check (public.has_permission('orders.write') and actor_type = 'staff');
create policy "payments staff" on public.payments for select using (public.has_permission('orders.read'));
create policy "webhooks staff" on public.webhook_events for select using (public.has_permission('settings.write'));

-- Audit trails
create trigger audit_discounts  after insert or update or delete on public.discounts      for each row execute function public.audit_row();
create trigger audit_tax_rates  after insert or update or delete on public.tax_rates      for each row execute function public.audit_row();
create trigger audit_ship_rates after insert or update or delete on public.shipping_rates for each row execute function public.audit_row();
create trigger audit_orders     after update on public.orders                             for each row execute function public.audit_row();
create trigger audit_payments   after insert or update on public.payments                 for each row execute function public.audit_row();

-- Helper functions not meant for the API
revoke execute on function public.order_events_immutable() from public, anon, authenticated;
revoke execute on function public.new_token() from public, anon, authenticated;

-- ===================== supabase/migrations/20261002000007_commerce_config.sql =====================
-- =====================================================================
-- 0007 COMMERCE CONFIG: Canadian tax rates and starter shipping rates.
-- Production configuration, editable later from the admin (settings.write).
--
-- Tax rates verified 2026-10-01 (GST 5%; HST ON 13%, NB/NL/PE 15%,
-- NS 14% since 2025-04-01; BC PST 7%, MB RST 7%, SK PST 6%, QC QST 9.975%).
-- Re-verify with an accountant before launch: provincial exemptions
-- (e.g. children's clothing in BC/ON point-of-sale rebate) are not modelled.
-- =====================================================================
insert into public.tax_rates (province, tax_type, label, rate, effective_from, effective_to) values
  ('AB','GST','GST',0.05,'2008-01-01',null),
  ('BC','GST','GST',0.05,'2008-01-01',null), ('BC','PST','BC PST',0.07,'2013-04-01',null),
  ('MB','GST','GST',0.05,'2008-01-01',null), ('MB','RST','MB RST',0.07,'2019-07-01',null),
  ('NB','HST','HST',0.15,'2016-07-01',null),
  ('NL','HST','HST',0.15,'2016-07-01',null),
  ('NS','HST','HST',0.15,'2010-07-01','2025-03-31'), ('NS','HST','HST',0.14,'2025-04-01',null),
  ('NT','GST','GST',0.05,'2008-01-01',null),
  ('NU','GST','GST',0.05,'2008-01-01',null),
  ('ON','HST','HST',0.13,'2010-07-01',null),
  ('PE','HST','HST',0.15,'2016-10-01',null),
  ('QC','GST','GST',0.05,'2008-01-01',null), ('QC','QST','QST',0.09975,'2013-01-01',null),
  ('SK','GST','GST',0.05,'2008-01-01',null), ('SK','PST','SK PST',0.06,'2017-03-23',null),
  ('YT','GST','GST',0.05,'2008-01-01',null);

-- Starter shipping. Carrier stays null until a carrier integration exists;
-- prices are placeholders the owner should set from real carrier quotes.
with z as (
  insert into public.shipping_zones (name, provinces) values
    ('Ontario & Quebec', array['ON','QC']),
    ('Atlantic',         array['NB','NS','PE','NL']),
    ('Prairies',         array['MB','SK','AB']),
    ('British Columbia', array['BC']),
    ('North',            array['YT','NT','NU'])
  returning id, name
)
insert into public.shipping_rates (zone_id, code, label, price_cents, free_over_cents, min_days, max_days, sort_order)
select z.id, r.code, r.label, r.price, r.free_over, r.min_d, r.max_d, r.sort
from z join (values
  ('Ontario & Quebec','standard','Standard',  900, 15000, 2, 5, 0), ('Ontario & Quebec','express','Express',  1900, null, 1, 2, 1),
  ('Atlantic',        'standard','Standard', 1200, 15000, 3, 7, 0), ('Atlantic',        'express','Express',  2400, null, 2, 3, 1),
  ('Prairies',        'standard','Standard', 1200, 15000, 3, 6, 0), ('Prairies',        'express','Express',  2400, null, 2, 3, 1),
  ('British Columbia','standard','Standard', 1400, 15000, 3, 7, 0), ('British Columbia','express','Express',  2600, null, 2, 3, 1),
  ('North',           'standard','Standard', 2500, null,  7,14, 0)
) as r(zone, code, label, price, free_over, min_d, max_d, sort) on r.zone = z.name;

-- ===================== supabase/seed_commerce.sql =====================
-- =====================================================================
-- DEVELOPMENT discount codes (fictional promotions for testing).
-- =====================================================================
insert into public.discounts (code, description, kind, value, scope, scope_ids, min_subtotal_cents, first_order_only, per_customer_limit, exclude_limited, buy_qty, get_qty, max_uses, ends_at) values
  ('WELCOME20', '20% off your first order', 'percent', 20, 'all', '{}', 0, true, 1, true, null, null, null, null),
  ('DROP10',    '$10 off orders over $50', 'fixed', 1000, 'all', '{}', 5000, false, null, false, null, null, 500, null),
  ('FREESHIP',  'Free shipping', 'free_shipping', 0, 'all', '{}', 0, false, null, false, null, null, null, null),
  ('ANIME15',   '15% off the Anime collection', 'percent', 15, 'categories',
     array[(select id from public.categories where slug = 'anime')], 0, false, null, true, null, null, null, null),
  ('BASICS3',   'Buy 2 essentials, get 1 free', 'bxgy', 0, 'collections',
     array[(select id from public.collections where slug = 'essentials')], 0, false, null, true, 2, 1, null, null),
  ('EXPIRED5',  'Old promo (expired, for testing)', 'percent', 5, 'all', '{}', 0, false, null, false, null, null, null, '2026-01-01')
on conflict (code) do nothing;
notify pgrst, 'reload schema';
