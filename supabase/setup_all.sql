-- TH8RTY: complete database setup (all migrations + development seed data).
-- Paste into Supabase → SQL Editor → New query → Run. Run ONCE on a fresh project.


-- ===================== supabase/migrations/20261001000001_foundation.sql =====================
-- =====================================================================
-- 0001 FOUNDATION: profiles, roles & permissions, settings, audit log,
-- analytics events.
--
-- Security model
--   * Every table has RLS enabled. The browser only ever holds the anon
--     key or a user JWT; RLS is the authority, never the frontend.
--   * Staff permissions are data (role_permissions), checked by
--     public.has_permission(), so roles can be tuned without code changes.
--   * Privileged multi-step operations (allocating editions, routing,
--     checkout) live in SECURITY DEFINER functions with EXECUTE revoked
--     from anon/authenticated and are called from Netlify Functions using
--     the service role.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Utility: updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------
create type public.app_role as enum (
  'super_admin', 'admin', 'order_manager', 'product_manager', 'moderator',
  'marketing_manager', 'fulfillment_manager', 'support_agent', 'partner_admin'
);

create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text,
  full_name        text check (char_length(full_name) <= 120),
  phone            text check (char_length(phone) <= 40),
  avatar_path      text,
  marketing_opt_in boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- A user can hold several roles. partner_id scopes partner_admin to one
-- fulfillment partner (FK added in the fulfillment migration).
create table public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.app_role not null,
  partner_id  uuid,
  granted_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  constraint partner_scope check ((role = 'partner_admin') = (partner_id is not null))
);
create unique index user_roles_unique on public.user_roles
  (user_id, role, coalesce(partner_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.role_permissions (
  role        public.app_role not null,
  permission  text not null check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  primary key (role, permission)
);

-- Least-privilege defaults. super_admin is implicitly granted everything.
insert into public.role_permissions (role, permission) values
  ('admin','orders.read'),('admin','orders.write'),('admin','orders.refund'),
  ('admin','products.write'),('admin','catalog.write'),('admin','inventory.write'),
  ('admin','moderation.review'),('admin','marketing.write'),('admin','fulfillment.write'),
  ('admin','customers.read'),('admin','customers.write'),('admin','support.write'),
  ('admin','analytics.read'),('admin','settings.write'),('admin','pricing.write'),
  ('admin','audit.read'),
  ('order_manager','orders.read'),('order_manager','orders.write'),('order_manager','orders.refund'),
  ('order_manager','customers.read'),('order_manager','fulfillment.read'),
  ('product_manager','products.write'),('product_manager','catalog.write'),
  ('product_manager','inventory.write'),('product_manager','pricing.write'),
  ('product_manager','analytics.read'),
  ('moderator','moderation.review'),('moderator','customers.read'),
  ('marketing_manager','marketing.write'),('marketing_manager','catalog.write'),
  ('marketing_manager','analytics.read'),('marketing_manager','customers.read'),
  ('fulfillment_manager','fulfillment.write'),('fulfillment_manager','fulfillment.read'),
  ('fulfillment_manager','orders.read'),('fulfillment_manager','inventory.write'),
  ('support_agent','orders.read'),('support_agent','customers.read'),('support_agent','support.write'),
  ('partner_admin','partner.portal');

-- ---------------------------------------------------------------------
-- Permission helpers (SECURITY DEFINER so they can read user_roles
-- regardless of the caller's RLS; they only ever answer about auth.uid()).
-- ---------------------------------------------------------------------
create or replace function public.has_role(r public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = r);
$$;

create or replace function public.has_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur
    where ur.user_id = auth.uid()
      and (ur.role = 'super_admin'
           or exists (select 1 from role_permissions rp
                      where rp.role = ur.role and rp.permission = perm))
  );
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles
                 where user_id = auth.uid() and role <> 'partner_admin');
$$;

create or replace function public.my_permissions()
returns table (permission text) language sql stable security definer set search_path = public as $$
  select distinct rp.permission
  from user_roles ur join role_permissions rp on rp.role = ur.role
  where ur.user_id = auth.uid()
  union
  select '*' where public.has_role('super_admin');
$$;

-- New auth user -> profile row
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Store settings (key/value). is_public rows are readable by anyone.
-- ---------------------------------------------------------------------
create table public.store_settings (
  key         text primary key check (key ~ '^[a-z0-9_.]+$'),
  value       jsonb not null,
  is_public   boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
create trigger store_settings_touch before update on public.store_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid,
  actor_role   text,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_entity on public.audit_log (entity_type, entity_id, created_at desc);
create index audit_log_actor on public.audit_log (actor_id, created_at desc);

-- Generic row-audit trigger: attach to any table that needs a trail.
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec_id text;
begin
  rec_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id', to_jsonb(new) ->> 'key', to_jsonb(old) ->> 'key');
  insert into audit_log (actor_id, actor_role, action, entity_type, entity_id, before, after)
  values (auth.uid(), coalesce(auth.role(), current_user), lower(tg_op), tg_table_name, rec_id,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_user_roles after insert or update or delete on public.user_roles
  for each row execute function public.audit_row();
create trigger audit_role_permissions after insert or update or delete on public.role_permissions
  for each row execute function public.audit_row();
create trigger audit_store_settings after insert or update or delete on public.store_settings
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------
-- Analytics events: open-ended event_type, JSON properties.
-- Writes go through track_event() so clients can't forge user_id.
-- ---------------------------------------------------------------------
create table public.analytics_events (
  id           bigint generated always as identity primary key,
  event_type   text not null check (event_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  session_id   text check (char_length(session_id) <= 64),
  user_id      uuid,
  path         text check (char_length(path) <= 512),
  entity_type  text check (char_length(entity_type) <= 40),
  entity_id    text check (char_length(entity_id) <= 64),
  properties   jsonb not null default '{}'::jsonb check (pg_column_size(properties) <= 4096),
  created_at   timestamptz not null default now()
);
create index analytics_events_type_time on public.analytics_events (event_type, created_at desc);
create index analytics_events_entity on public.analytics_events (entity_type, entity_id);
create index analytics_events_session on public.analytics_events (session_id, created_at);

create or replace function public.track_event(
  p_event_type text, p_session_id text, p_path text default null,
  p_entity_type text default null, p_entity_id text default null,
  p_properties jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- crude per-session flood guard: max 120 events/minute
  if (select count(*) from analytics_events
      where session_id = p_session_id and created_at > now() - interval '1 minute') >= 120 then
    return;
  end if;
  insert into analytics_events (event_type, session_id, user_id, path, entity_type, entity_id, properties)
  values (p_event_type, p_session_id, auth.uid(), p_path, p_entity_type, p_entity_id, coalesce(p_properties, '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.user_roles       enable row level security;
alter table public.role_permissions enable row level security;
alter table public.store_settings   enable row level security;
alter table public.audit_log        enable row level security;
alter table public.analytics_events enable row level security;

create policy "own profile read"   on public.profiles for select using (id = auth.uid() or public.has_permission('customers.read'));
create policy "own profile update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "staff profile update" on public.profiles for update using (public.has_permission('customers.write'));

create policy "see own roles"   on public.user_roles for select using (user_id = auth.uid() or public.has_permission('users.manage'));
create policy "manage roles"    on public.user_roles for all using (public.has_permission('users.manage')) with check (public.has_permission('users.manage'));
create policy "read perms"      on public.role_permissions for select using (public.is_staff());
create policy "manage perms"    on public.role_permissions for all using (public.has_role('super_admin')) with check (public.has_role('super_admin'));

create policy "public settings" on public.store_settings for select using (is_public or public.is_staff());
create policy "write settings"  on public.store_settings for all using (public.has_permission('settings.write')) with check (public.has_permission('settings.write'));

create policy "read audit"      on public.audit_log for select using (public.has_permission('audit.read'));
-- no insert/update/delete policies: only SECURITY DEFINER triggers write it.

create policy "read analytics"  on public.analytics_events for select using (public.has_permission('analytics.read'));

-- Email is mirrored from auth.users only; users can't rewrite it here.
create or replace function public.guard_profile_email()
returns trigger language plpgsql as $$
begin
  if new.email is distinct from old.email and coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'email is managed by authentication';
  end if;
  return new;
end $$;
create trigger profiles_guard_email before update on public.profiles
  for each row execute function public.guard_profile_email();

-- ===================== supabase/migrations/20261001000002_catalog.sql =====================
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

-- ===================== supabase/migrations/20261001000003_storage.sql =====================
-- =====================================================================
-- 0003 STORAGE: buckets + object policies.
--   Public buckets hold brand imagery. Customer artwork and mockups are
--   private: a customer may only touch objects under "<their uid>/...";
--   staff with moderation/order rights can read them; everyone else uses
--   short-lived signed URLs minted server-side.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('products',      'products',      true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm']),
  ('collections',   'collections',   true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4']),
  ('limited-drops', 'limited-drops', true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4']),
  ('archive',       'archive',       true,  10485760, array['image/jpeg','image/png','image/webp','image/avif']),
  ('avatars',       'avatars',       true,   2097152, array['image/jpeg','image/png','image/webp']),
  ('designs',       'designs',       false, 26214400, array['image/png','image/jpeg','image/webp','image/svg+xml']),
  ('mockups',       'mockups',       false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- Brand buckets: anyone reads (public buckets are served via CDN anyway),
-- catalog staff write.
create policy "brand media read" on storage.objects for select
  using (bucket_id in ('products','collections','limited-drops','archive','avatars'));
create policy "brand media write" on storage.objects for insert
  with check (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));
create policy "brand media update" on storage.objects for update
  using (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));
create policy "brand media delete" on storage.objects for delete
  using (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));

-- Avatars: users manage files in their own folder.
create policy "own avatar write" on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own avatar delete" on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Customer artwork & mockups: private, per-user folders.
create policy "own designs read" on storage.objects for select
  using (bucket_id in ('designs','mockups')
         and ((storage.foldername(name))[1] = auth.uid()::text
              or public.has_permission('moderation.review')
              or public.has_permission('orders.read')));
create policy "own designs upload" on storage.objects for insert
  with check (bucket_id in ('designs','mockups') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own designs delete" on storage.objects for delete
  using (bucket_id in ('designs','mockups') and (storage.foldername(name))[1] = auth.uid()::text);

-- ===================== supabase/migrations/20261001000004_storefront_extras.sql =====================
-- =====================================================================
-- 0004 STOREFRONT EXTRAS: product search RPC, newsletter sign-ups.
-- =====================================================================

-- Keyword search over name, SKU, tags, description, category, collection
-- and designer. Returns storefront rows ranked by relevance; RLS applies.
create or replace function public.search_products(q text, max_results int default 40)
returns setof public.storefront_products
language sql stable security invoker set search_path = public as $$
  select sp.*
  from storefront_products sp
  join products p on p.id = sp.id
  where p.search_doc @@ websearch_to_tsquery('simple', q)
     or p.name ilike '%' || q || '%'
     or p.sku ilike q || '%'
  order by ts_rank(p.search_doc, websearch_to_tsquery('simple', q)) desc, sp.name
  limit least(greatest(max_results, 1), 100);
$$;

create table public.newsletter_subscribers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  source      text check (char_length(source) <= 40),
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unsubscribed_at timestamptz
);
create unique index newsletter_email on public.newsletter_subscribers (lower(email));
alter table public.newsletter_subscribers enable row level security;
create policy "marketing reads list" on public.newsletter_subscribers for select using (public.has_permission('marketing.write'));

-- Insert through a function so duplicates are silent and the list itself
-- is never readable by the public.
create or replace function public.subscribe_newsletter(p_email text, p_source text default 'site')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into newsletter_subscribers (email, source, user_id)
  values (trim(p_email), left(p_source, 40), auth.uid())
  on conflict (lower(email)) do update set unsubscribed_at = null;
end $$;

-- ===================== supabase/seed.sql =====================
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

notify pgrst, 'reload schema';
