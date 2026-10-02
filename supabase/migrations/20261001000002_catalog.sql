-- =====================================================================
-- 0002 CATALOG: themes, categories, designers, collections, products,
-- variants, media, inventory movements, limited drops, edition numbers,
-- lifecycle (active -> sold_out -> archived), storefront views, search.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Themes: a reusable visual identity. Categories and collections point at
-- a theme and may override individual keys (theme_overrides is deep-merged
-- over theme.config by the frontend and by public.resolve_theme()).
--
-- config shape (all keys optional, see docs/themes.md):
-- {
--   "colors":     {"bg","fg","muted","accent","accent2","surface","line"},
--   "fonts":      {"display","body","accent"},         -- font registry keys
--   "background": {"effect","intensity","image"},       -- tv-static | petal-drift | grain | light-rays | none
--   "hero":       {"style","eyebrow","headline","sub"}, -- varsity-arch | script | manga-slash | serif-centered | stacked
--   "intro":      {"effect","sound","duration_ms"},     -- petal-storm | static-cut | glitch | light-bloom | fade
--   "cards":      {"style"},                            -- sketch-callout | manga-panel | sticker | gallery | plain
--   "buttons":    {"style"},                            -- varsity-outline | slash | solid | ghost
--   "motion":     {"level"}                             -- calm | normal | energetic
-- }
-- ---------------------------------------------------------------------
create table public.themes (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name        text not null,
  config      jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger themes_touch before update on public.themes for each row execute function public.touch_updated_at();

create table public.categories (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name             text not null,
  tagline          text,
  description      text,
  theme_id         uuid references public.themes(id) on delete set null,
  theme_overrides  jsonb not null default '{}'::jsonb,
  hero_image       text,
  sort_order       int not null default 0,
  is_visible       boolean not null default true,
  seo              jsonb not null default '{}'::jsonb,   -- {title, description, og_image, noindex}
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger categories_touch before update on public.categories for each row execute function public.touch_updated_at();

-- Designers / artists. user_id lets an external designer log in later
-- (marketplace) without a schema change.
create table public.designers (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name        text not null,
  avatar_url  text,
  bio         text,
  website     text,
  socials     jsonb not null default '{}'::jsonb,
  is_house    boolean not null default false,
  user_id     uuid references auth.users(id) on delete set null,
  is_visible  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger designers_touch before update on public.designers for each row execute function public.touch_updated_at();

create table public.collections (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name             text not null,
  description      text,
  category_id      uuid references public.categories(id) on delete set null,
  designer_id      uuid references public.designers(id) on delete set null,
  theme_id         uuid references public.themes(id) on delete set null,
  theme_overrides  jsonb not null default '{}'::jsonb,
  hero_image       text,
  banner_image     text,
  sort_order       int not null default 0,
  is_featured      boolean not null default false,
  is_visible       boolean not null default true,
  seo              jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger collections_touch before update on public.collections for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------
create type public.product_status as enum
  ('draft', 'scheduled', 'active', 'out_of_stock', 'sold_out', 'discontinued', 'archived');

create table public.products (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name                     text not null,
  description              text,
  category_id              uuid references public.categories(id) on delete set null,
  collection_id            uuid references public.collections(id) on delete set null,
  designer_id              uuid references public.designers(id) on delete set null,
  product_type             text not null,                -- hoodie | tee | crewneck | longsleeve | tank | ...
  tags                     text[] not null default '{}',
  base_price_cents         int not null check (base_price_cents >= 0),
  sale_price_cents         int check (sale_price_cents >= 0),
  compare_note             text,
  currency                 char(3) not null default 'CAD',
  sku                      text unique,
  materials                text,
  weight_grams             int check (weight_grams > 0),
  dimensions               jsonb not null default '{}'::jsonb,
  print_locations          text[] not null default '{}', -- front | back | left_sleeve | ...
  print_methods            text[] not null default '{}', -- dtg | dtf | embroidery | screen | vinyl
  production_requirements  jsonb not null default '{}'::jsonb,
  -- Annotation bubbles drawn around the garment sketch (artist theme):
  -- [{"text":"450gsm fleece","x":0.18,"y":0.32,"side":"left"}], x/y are 0..1 garment coords.
  sketch_callouts          jsonb not null default '[]'::jsonb check (jsonb_typeof(sketch_callouts) = 'array'),
  status                   public.product_status not null default 'draft',
  publish_at               timestamptz,
  is_limited               boolean not null default false,
  is_customizable          boolean not null default false,
  is_featured              boolean not null default false,
  seo                      jsonb not null default '{}'::jsonb,
  search_doc               tsvector,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint sale_below_base check (sale_price_cents is null or sale_price_cents < base_price_cents),
  constraint scheduled_needs_date check (status <> 'scheduled' or publish_at is not null)
);
create index products_status on public.products (status);
create index products_category on public.products (category_id, status);
create index products_collection on public.products (collection_id);
create index products_designer on public.products (designer_id);
create index products_search on public.products using gin (search_doc);
create index products_tags on public.products using gin (tags);
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();

create table public.product_media (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  variant_id  uuid,
  kind        text not null default 'image' check (kind in ('image', 'video')),
  url         text not null,
  alt         text,
  view        text check (view in ('front', 'back', 'side', 'detail', 'lifestyle', 'campaign')),
  is_historical boolean not null default false,   -- campaign/archive imagery
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index product_media_product on public.product_media (product_id, sort_order);

create table public.product_variants (
  id                       uuid primary key default gen_random_uuid(),
  product_id               uuid not null references public.products(id) on delete cascade,
  sku                      text not null unique,
  size                     text,
  color                    text,
  color_hex                text check (color_hex ~ '^#[0-9a-fA-F]{6}$'),
  price_cents              int check (price_cents >= 0),       -- null = product price
  sale_price_cents         int check (sale_price_cents >= 0),
  inventory_on_hand        int not null default 0 check (inventory_on_hand >= 0),
  inventory_reserved       int not null default 0 check (inventory_reserved >= 0),
  low_stock_threshold      int not null default 5,
  production_requirements  jsonb not null default '{}'::jsonb,
  is_active                boolean not null default true,
  sort_order               int not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint reserved_le_on_hand check (inventory_reserved <= inventory_on_hand),
  unique (product_id, size, color)
);
create index product_variants_product on public.product_variants (product_id, sort_order);
create trigger product_variants_touch before update on public.product_variants for each row execute function public.touch_updated_at();

alter table public.product_media
  add constraint product_media_variant_fk foreign key (variant_id) references public.product_variants(id) on delete cascade;

-- Every stock change goes through adjust_inventory() and lands here.
create table public.inventory_movements (
  id          bigint generated always as identity primary key,
  variant_id  uuid not null references public.product_variants(id) on delete cascade,
  delta       int not null,
  reserved_delta int not null default 0,
  reason      text not null check (reason in ('restock','adjustment','sale','reservation','release','return','damage','initial')),
  reference   text,
  note        text,
  actor_id    uuid,
  on_hand_after int not null,
  created_at  timestamptz not null default now()
);
create index inventory_movements_variant on public.inventory_movements (variant_id, created_at desc);

-- ---------------------------------------------------------------------
-- Limited drops & numbered editions
-- ---------------------------------------------------------------------
create table public.limited_drops (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null unique references public.products(id) on delete restrict,
  slug              text not null unique check (slug ~ '^[a-z0-9-]+$'),  -- archive URL: /archive/<slug>
  drop_name         text not null,
  drop_number       int not null unique check (drop_number > 0),
  edition_size      int not null check (edition_size > 0),
  units_sold        int not null default 0,
  is_numbered       boolean not null default true,
  release_at        timestamptz not null,
  story             text,
  original_price_cents int,                 -- frozen at first sale for the archive
  sold_out_at       timestamptz,
  archive_delay     interval not null default interval '48 hours',
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint units_within_edition check (units_sold >= 0 and units_sold <= edition_size)
);
create index limited_drops_release on public.limited_drops (release_at);
create trigger limited_drops_touch before update on public.limited_drops for each row execute function public.touch_updated_at();

-- One row per physical numbered piece. PK makes duplicate numbers impossible.
create table public.edition_allocations (
  drop_id         uuid not null references public.limited_drops(id) on delete restrict,
  edition_number  int not null check (edition_number > 0),
  order_item_id   uuid,            -- FK added by the orders migration
  allocated_at    timestamptz not null default now(),
  primary key (drop_id, edition_number)
);
create index edition_allocations_item on public.edition_allocations (order_item_id);

-- Keep products.is_limited in sync with the existence of a drop row.
create or replace function public.sync_limited_flag()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    update products set is_limited = false where id = old.product_id;
    return old;
  end if;
  update products set is_limited = true where id = new.product_id and not is_limited;
  return new;
end $$;
create trigger limited_drops_flag after insert or delete on public.limited_drops
  for each row execute function public.sync_limited_flag();

-- ---------------------------------------------------------------------
-- Lifecycle guards
-- ---------------------------------------------------------------------
-- A limited product whose edition is exhausted can never become
-- purchasable again, whoever issues the update.
create or replace function public.guard_product_status()
returns trigger language plpgsql as $$
declare
  d record;
begin
  if new.status is distinct from old.status and new.status in ('active', 'scheduled', 'out_of_stock') then
    select * into d from limited_drops where product_id = new.id;
    if found and d.units_sold >= d.edition_size then
      raise exception 'Limited edition % is exhausted (%/%); it can only be sold_out or archived',
        d.drop_name, d.units_sold, d.edition_size using errcode = 'check_violation';
    end if;
  end if;
  if new.status = 'archived' and old.status is distinct from 'archived' then
    update limited_drops set archived_at = coalesce(archived_at, now()) where product_id = new.id;
  end if;
  return new;
end $$;
create trigger products_guard_status before update of status on public.products
  for each row execute function public.guard_product_status();

-- ---------------------------------------------------------------------
-- Edition allocation. The single UPDATE ... WHERE units_sold + n <= size
-- takes a row lock, so concurrent buyers serialize on the drop row: each
-- receives a distinct contiguous block of numbers, and nobody can push
-- the count past edition_size. Called by checkout (service role) only.
-- ---------------------------------------------------------------------
create or replace function public.allocate_editions(p_drop_id uuid, p_qty int, p_order_item_id uuid default null)
returns int[] language plpgsql security definer set search_path = public as $$
declare
  v_after int;
  v_size  int;
  v_product uuid;
  v_status product_status;
  v_release timestamptz;
  v_numbers int[];
begin
  if p_qty is null or p_qty < 1 then
    raise exception 'quantity must be positive';
  end if;

  select d.product_id, p.status, d.release_at into v_product, v_status, v_release
  from limited_drops d join products p on p.id = d.product_id
  where d.id = p_drop_id;
  if not found then raise exception 'drop not found'; end if;
  if v_status <> 'active' then
    raise exception 'drop is not purchasable (status %)', v_status using errcode = 'check_violation';
  end if;
  if v_release > now() then
    raise exception 'drop has not been released yet' using errcode = 'check_violation';
  end if;

  update limited_drops
     set units_sold = units_sold + p_qty
   where id = p_drop_id and units_sold + p_qty <= edition_size
  returning units_sold, edition_size into v_after, v_size;

  if not found then
    raise exception 'not enough editions remaining' using errcode = 'check_violation';
  end if;

  select array_agg(n order by n) into v_numbers
  from generate_series(v_after - p_qty + 1, v_after) n;

  insert into edition_allocations (drop_id, edition_number, order_item_id)
  select p_drop_id, n, p_order_item_id from unnest(v_numbers) n;

  update limited_drops
     set original_price_cents = coalesce(original_price_cents,
           (select coalesce(sale_price_cents, base_price_cents) from products where id = v_product))
   where id = p_drop_id;

  if v_after >= v_size then
    update limited_drops set sold_out_at = now() where id = p_drop_id;
    update products set status = 'sold_out' where id = v_product;
    -- zero-delay drops go straight to the archive
    perform archive_due_drops();
  end if;

  return v_numbers;
end $$;

-- Moves sold-out drops into the archive once their delay has passed.
-- Run on a schedule (netlify/functions/scheduled-lifecycle) and after sell-out.
create or replace function public.archive_due_drops()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with due as (
    select d.product_id from limited_drops d join products p on p.id = d.product_id
    where p.status = 'sold_out' and d.sold_out_at is not null
      and d.sold_out_at + d.archive_delay <= now()
  )
  update products p set status = 'archived' from due where p.id = due.product_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Scheduled products/drops go live when publish_at passes.
create or replace function public.publish_due_products()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update products set status = 'active'
   where status = 'scheduled' and publish_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Privileged functions: service role / staff only.
revoke execute on function public.allocate_editions(uuid, int, uuid) from public, anon, authenticated;
revoke execute on function public.archive_due_drops() from public, anon, authenticated;
revoke execute on function public.publish_due_products() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Search document (name, sku, tags, description + category/collection/
-- designer names). Kept in a column so a vector column can sit beside it
-- later for semantic search.
-- ---------------------------------------------------------------------
create or replace function public.refresh_product_search()
returns trigger language plpgsql as $$
begin
  new.search_doc :=
      setweight(to_tsvector('simple', coalesce(new.name, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(new.sku, '') || ' ' || array_to_string(new.tags, ' ')), 'A')
   || setweight(to_tsvector('simple', coalesce((select name from categories where id = new.category_id), '') || ' ' ||
                                     coalesce((select name from collections where id = new.collection_id), '') || ' ' ||
                                     coalesce((select name from designers where id = new.designer_id), '')), 'B')
   || setweight(to_tsvector('english', coalesce(new.description, '')), 'C');
  return new;
end $$;
create trigger products_search before insert or update of name, sku, tags, description, category_id, collection_id, designer_id
  on public.products for each row execute function public.refresh_product_search();

-- ---------------------------------------------------------------------
-- Storefront views (security_invoker => caller's RLS applies)
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
  case when d.id is not null then d.edition_size - d.units_sold end as units_remaining,
  d.release_at, d.sold_out_at, d.archived_at,
  (select coalesce(sum(v.inventory_on_hand - v.inventory_reserved), 0)
     from product_variants v where v.product_id = p.id and v.is_active) as stock_available,
  (select jsonb_agg(jsonb_build_object('url', m.url, 'alt', m.alt, 'view', m.view, 'kind', m.kind) order by m.sort_order)
     from product_media m where m.product_id = p.id and not m.is_historical) as media,
  (select jsonb_agg(distinct jsonb_build_object('color', v.color, 'hex', v.color_hex))
     from product_variants v where v.product_id = p.id and v.is_active) as colors,
  -- The single source of truth for "can this be bought right now?"
  (p.status = 'active'
     and (p.publish_at is null or p.publish_at <= now())
     and (d.id is null or (d.release_at <= now() and d.units_sold < d.edition_size))
  ) as is_purchasable
from products p
left join categories c on c.id = p.category_id
left join collections co on co.id = p.collection_id
left join designers de on de.id = p.designer_id
left join limited_drops d on d.product_id = p.id;

create or replace view public.archive_drops with (security_invoker = true) as
select
  d.id, d.slug, d.drop_name, d.drop_number, d.edition_size, d.units_sold, d.release_at,
  d.sold_out_at, d.archived_at, d.story,
  coalesce(d.original_price_cents, p.base_price_cents) as original_price_cents,
  extract(year from d.release_at)::int as release_year,
  p.id as product_id, p.slug as product_slug, p.name as product_name, p.description, p.product_type,
  p.materials, p.status, p.sketch_callouts,
  c.slug as category_slug, c.name as category_name,
  co.slug as collection_slug, co.name as collection_name,
  de.slug as designer_slug, de.name as designer_name,
  (select jsonb_agg(jsonb_build_object('url', m.url, 'alt', m.alt, 'view', m.view, 'historical', m.is_historical) order by m.sort_order)
     from product_media m where m.product_id = p.id) as media,
  (select jsonb_agg(distinct jsonb_build_object('color', v.color, 'hex', v.color_hex))
     from product_variants v where v.product_id = p.id) as colors
from limited_drops d
join products p on p.id = d.product_id
left join categories c on c.id = p.category_id
left join collections co on co.id = p.collection_id
left join designers de on de.id = p.designer_id
where p.status = 'archived';

-- Theme resolution for a category or collection: theme.config deep-merged
-- with the row's overrides (one level deep per section).
create or replace function public.jsonb_merge_deep(a jsonb, b jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k,
           case when jsonb_typeof(a -> k) = 'object' and jsonb_typeof(b -> k) = 'object'
                then public.jsonb_merge_deep(a -> k, b -> k)
                else coalesce(b -> k, a -> k) end), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(a, '{}')) k union select jsonb_object_keys(coalesce(b, '{}'))) keys;
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.themes               enable row level security;
alter table public.categories           enable row level security;
alter table public.designers            enable row level security;
alter table public.collections          enable row level security;
alter table public.products             enable row level security;
alter table public.product_media        enable row level security;
alter table public.product_variants     enable row level security;
alter table public.inventory_movements  enable row level security;
alter table public.limited_drops        enable row level security;
alter table public.edition_allocations  enable row level security;

create policy "themes public"       on public.themes for select using (true);
create policy "themes write"        on public.themes for all using (public.has_permission('catalog.write')) with check (public.has_permission('catalog.write'));

create policy "categories public"   on public.categories for select using (is_visible or public.is_staff());
create policy "categories write"    on public.categories for all using (public.has_permission('catalog.write')) with check (public.has_permission('catalog.write'));

create policy "designers public"    on public.designers for select using (is_visible or public.is_staff());
create policy "designers write"     on public.designers for all using (public.has_permission('catalog.write')) with check (public.has_permission('catalog.write'));

create policy "collections public"  on public.collections for select using (is_visible or public.is_staff());
create policy "collections write"   on public.collections for all using (public.has_permission('catalog.write')) with check (public.has_permission('catalog.write'));

-- Drafts are staff-only; everything else (incl. archived history) is public.
create policy "products public"     on public.products for select using (status <> 'draft' or public.is_staff());
create policy "products write"      on public.products for all using (public.has_permission('products.write')) with check (public.has_permission('products.write'));

create policy "media public"        on public.product_media for select using (exists (select 1 from products p where p.id = product_id));
create policy "media write"         on public.product_media for all using (public.has_permission('products.write')) with check (public.has_permission('products.write'));

create policy "variants public"     on public.product_variants for select using (exists (select 1 from products p where p.id = product_id));
-- Staff edit variant metadata; stock moves only via adjust_inventory().
create policy "variants write"      on public.product_variants for all using (public.has_permission('products.write')) with check (public.has_permission('products.write'));

create policy "movements read"      on public.inventory_movements for select using (public.has_permission('inventory.write') or public.has_permission('analytics.read'));

create policy "drops public"        on public.limited_drops for select using (exists (select 1 from products p where p.id = product_id));
create policy "drops write"         on public.limited_drops for all using (public.has_permission('products.write')) with check (public.has_permission('products.write'));

create policy "allocations staff"   on public.edition_allocations for select using (public.has_permission('orders.read'));

-- Customers (anon/authenticated without permission) may not touch counters:
-- units_sold changes only through allocate_editions().
create or replace function public.guard_drop_counters()
returns trigger language plpgsql as $$
begin
  if new.units_sold is distinct from old.units_sold
     and current_user not in ('postgres', 'service_role', 'supabase_admin')
     and coalesce(auth.role(), '') <> 'service_role'
     and pg_trigger_depth() = 1 then
    raise exception 'units_sold is maintained by checkout' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger limited_drops_guard before update on public.limited_drops
  for each row execute function public.guard_drop_counters();

-- Same for on-hand stock: only adjust_inventory() / checkout functions.
create or replace function public.guard_variant_stock()
returns trigger language plpgsql as $$
begin
  if (new.inventory_on_hand is distinct from old.inventory_on_hand
      or new.inventory_reserved is distinct from old.inventory_reserved)
     and pg_trigger_depth() = 1
     and current_user not in ('postgres', 'service_role', 'supabase_admin')
     and coalesce(auth.role(), '') <> 'service_role'
     and current_setting('app.stock_change', true) is distinct from 'on' then
    raise exception 'stock changes must go through adjust_inventory()' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger product_variants_guard before update on public.product_variants
  for each row execute function public.guard_variant_stock();

-- adjust_inventory flips the session flag for its own update.
create or replace function public.adjust_inventory(p_variant_id uuid, p_delta int, p_reason text, p_note text default null, p_reference text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_after int;
begin
  -- staff with inventory rights, the service role, or a direct DB session
  -- with no API claims at all (migrations / SQL editor).
  if not (public.has_permission('inventory.write') or coalesce(auth.role(), '') = 'service_role'
          or auth.jwt() = '{}'::jsonb) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  perform set_config('app.stock_change', 'on', true);
  update product_variants set inventory_on_hand = inventory_on_hand + p_delta
   where id = p_variant_id
  returning inventory_on_hand into v_after;
  perform set_config('app.stock_change', 'off', true);
  if not found then raise exception 'variant not found'; end if;
  insert into inventory_movements (variant_id, delta, reason, note, reference, actor_id, on_hand_after)
  values (p_variant_id, p_delta, p_reason, p_note, p_reference, auth.uid(), v_after);
  return v_after;
end $$;
revoke execute on function public.adjust_inventory(uuid, int, text, text, text) from public, anon;

-- ---------------------------------------------------------------------
-- Audit trails on catalog tables
-- ---------------------------------------------------------------------
create trigger audit_products      after insert or update or delete on public.products         for each row execute function public.audit_row();
create trigger audit_variants      after insert or update or delete on public.product_variants for each row execute function public.audit_row();
create trigger audit_drops         after insert or update or delete on public.limited_drops    for each row execute function public.audit_row();
create trigger audit_categories    after insert or update or delete on public.categories       for each row execute function public.audit_row();
create trigger audit_collections   after insert or update or delete on public.collections      for each row execute function public.audit_row();
create trigger audit_themes        after insert or update or delete on public.themes           for each row execute function public.audit_row();
