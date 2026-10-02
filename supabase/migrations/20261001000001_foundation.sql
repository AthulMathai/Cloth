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
