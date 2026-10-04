-- =====================================================================
-- 0015 CRM: wishlist, customer tags + notes, support tickets, customer
-- stats and segments, abandoned carts.
--   * Customer numbers (lifetime value, segments...) are computed from
--     orders/payments every time — never stored, so they can't drift.
--   * Segment thresholds are store settings, editable without code.
--   * Support threads are append-only; internal notes never reach the
--     customer.
-- Additive only; removals (wishlist) go through RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Wishlist: products (incl. limited / archived drops) and collections.
-- ---------------------------------------------------------------------
create table if not exists public.wishlist_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id),
  product_id     uuid references public.products(id),
  collection_id  uuid references public.collections(id),
  created_at     timestamptz not null default now(),
  constraint wishlist_one_target check ((product_id is null) <> (collection_id is null))
);
create unique index if not exists wishlist_unique_product on public.wishlist_items (user_id, product_id) where product_id is not null;
create unique index if not exists wishlist_unique_collection on public.wishlist_items (user_id, collection_id) where collection_id is not null;
alter table public.wishlist_items enable row level security;
create policy "own wishlist" on public.wishlist_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "staff read wishlists" on public.wishlist_items for select using (public.has_permission('customers.read'));

-- Wishlist with everything the page needs; archived items stay visible.
create or replace function public.wishlist_get()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'saved_at' desc), '[]') from (
    select jsonb_build_object('id', w.id, 'kind', 'product', 'saved_at', w.created_at,
      'product', jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'product_type', p.product_type, 'status', p.status,
        'price_cents', coalesce(p.sale_price_cents, p.base_price_cents), 'base_price_cents', p.base_price_cents, 'is_limited', p.is_limited,
        'color_hex', (select v.color_hex from product_variants v where v.product_id = p.id and v.is_active order by v.sort_order limit 1),
        'image', (select m.url from product_media m where m.product_id = p.id and m.kind = 'image' order by m.sort_order limit 1),
        'in_stock', exists (select 1 from product_variants v where v.product_id = p.id and v.is_active and v.inventory_on_hand - v.inventory_reserved > 0),
        'drop', (select jsonb_build_object('slug', d.slug, 'drop_name', d.drop_name, 'drop_number', d.drop_number, 'edition_size', d.edition_size,
                   'units_sold', d.units_sold, 'archived_at', d.archived_at, 'sold_out_at', d.sold_out_at, 'release_at', d.release_at)
                 from limited_drops d where d.product_id = p.id))) x
    from wishlist_items w join products p on p.id = w.product_id where w.user_id = auth.uid()
    union all
    select jsonb_build_object('id', w.id, 'kind', 'collection', 'saved_at', w.created_at,
      'collection', jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name))
    from wishlist_items w join collections c on c.id = w.collection_id where w.user_id = auth.uid()) t(x);
$$;
revoke execute on function public.wishlist_get() from public, anon;
grant execute on function public.wishlist_get() to authenticated;

-- ---------------------------------------------------------------------
-- CRM data owned by staff: tags (current set) + notes (append-only).
-- ---------------------------------------------------------------------
create table if not exists public.customer_crm (
  user_id     uuid primary key references auth.users(id),
  tags        text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create trigger customer_crm_touch before update on public.customer_crm for each row execute function public.touch_updated_at();
create trigger audit_customer_crm after insert or update on public.customer_crm for each row execute function public.audit_row();
alter table public.customer_crm enable row level security;
create policy "crm read" on public.customer_crm for select using (public.has_permission('customers.read'));

create table if not exists public.crm_notes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id),
  author_id   uuid,
  body        text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index if not exists crm_notes_user on public.crm_notes (user_id, created_at desc);
create trigger crm_notes_append_only before update or delete on public.crm_notes for each row execute function public.append_only();
alter table public.crm_notes enable row level security;
create policy "crm notes read" on public.crm_notes for select using (public.has_permission('customers.read'));

insert into public.store_settings (key, value, is_public) values
  ('crm.high_value_cents', '50000', false),     -- lifetime spend (net of refunds) for "High value"
  ('crm.inactive_days', '120', false),          -- no purchase for this long = "Inactive"
  ('crm.new_days', '60', false),                -- first purchase within this many days = "New"
  ('crm.abandoned_hours', '2', false)           -- an untouched bag older than this = abandoned
on conflict (key) do nothing;

create or replace function public.cart_line_cents(ci public.cart_items)
returns int language sql stable security definer set search_path = public as $$
  select case when ci.item_type = 'custom' then coalesce((ci.price_snapshot->>'total_cents')::int, 0)
              else coalesce((select variant_price(v, p) from product_variants v join products p on p.id = v.product_id where v.id = ci.variant_id), 0) * ci.quantity end;
$$;
revoke execute on function public.cart_line_cents(public.cart_items) from public, anon, authenticated;

create or replace function public.setting_int(p_key text, p_default int)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from store_settings where key = p_key), p_default);
$$;
revoke execute on function public.setting_int(text, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------
create sequence if not exists public.support_number_seq start 2001;

create table if not exists public.support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique default ('SUP-' || nextval('public.support_number_seq')),
  user_id            uuid references auth.users(id),
  email              text not null,
  name               text,
  order_id           uuid references public.orders(id),
  subject            text not null check (char_length(btrim(subject)) between 3 and 160),
  category           text not null default 'general'
                     check (category in ('order', 'shipping', 'custom_design', 'returns', 'product', 'account', 'general')),
  status             text not null default 'open' check (status in ('open', 'pending', 'waiting_customer', 'resolved', 'closed')),
  priority           text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id        uuid references auth.users(id),
  channel            text not null default 'web' check (channel in ('web', 'email', 'phone', 'staff')),
  first_response_at  timestamptz,
  last_message_at    timestamptz not null default now(),
  last_message_by    text not null default 'customer' check (last_message_by in ('customer', 'staff', 'system')),
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists support_tickets_user on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status on public.support_tickets (status, last_message_at desc);
create trigger support_tickets_touch before update on public.support_tickets for each row execute function public.touch_updated_at();

create table if not exists public.support_messages (
  id           bigint generated always as identity primary key,
  ticket_id    uuid not null references public.support_tickets(id),
  author_type  text not null check (author_type in ('customer', 'staff', 'system')),
  author_id    uuid,
  body         text not null check (char_length(btrim(body)) between 1 and 8000),
  internal     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists support_messages_ticket on public.support_messages (ticket_id, created_at);
create trigger support_messages_append_only before update or delete on public.support_messages for each row execute function public.append_only();

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
create policy "own tickets" on public.support_tickets for select
  using (user_id = auth.uid() or public.has_permission('support.write') or public.has_permission('customers.read'));
create policy "ticket messages" on public.support_messages for select using (
  exists (select 1 from support_tickets t where t.id = ticket_id
          and ((t.user_id = auth.uid() and not internal) or public.has_permission('support.write') or public.has_permission('customers.read'))));

create or replace function public.can_support()
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('support.write');
$$;

-- Customer opens a ticket (signed in). Optional order must be theirs.
create or replace function public.support_open(p_subject text, p_category text, p_body text, p_order_number text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_name text; v_order uuid; v_id uuid; v_number text; v_recent int;
begin
  if v_uid is null then raise exception 'Sign in to contact support.' using errcode = '42501'; end if;
  select email, full_name into v_email, v_name from profiles where id = v_uid;
  if char_length(btrim(coalesce(p_subject, ''))) < 3 then raise exception 'Add a short subject.' using errcode = 'check_violation'; end if;
  if char_length(btrim(coalesce(p_body, ''))) < 5 then raise exception 'Tell us a bit more.' using errcode = 'check_violation'; end if;
  if char_length(p_body) > 8000 then raise exception 'That message is too long.' using errcode = 'check_violation'; end if;
  if coalesce(p_category, 'general') not in ('order', 'shipping', 'custom_design', 'returns', 'product', 'account', 'general') then
    raise exception 'Choose a topic.' using errcode = 'check_violation';
  end if;
  select count(*) into v_recent from support_tickets where user_id = v_uid and created_at > now() - interval '1 hour';
  if v_recent >= 5 then raise exception 'You''ve opened several requests in the last hour — we''ll get to them soon.' using errcode = 'check_violation'; end if;
  if nullif(btrim(coalesce(p_order_number, '')), '') is not null then
    select id into v_order from orders where number = upper(btrim(p_order_number)) and user_id = v_uid;
    if v_order is null then raise exception 'That order isn''t on your account.' using errcode = 'check_violation'; end if;
  end if;
  insert into support_tickets (user_id, email, name, order_id, subject, category, last_message_by)
  values (v_uid, v_email, v_name, v_order, btrim(p_subject), coalesce(p_category, 'general'), 'customer')
  returning id, number into v_id, v_number;
  insert into support_messages (ticket_id, author_type, author_id, body) values (v_id, 'customer', v_uid, btrim(p_body));
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values ('support_ticket_opened', v_uid, 'support_ticket', v_id::text, jsonb_build_object('category', coalesce(p_category, 'general')));
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;
revoke execute on function public.support_open(text, text, text, text) from public, anon;
grant execute on function public.support_open(text, text, text, text) to authenticated;

-- Reply: the customer on their own ticket, or support staff (optionally internal).
create or replace function public.support_reply(p_ticket uuid, p_body text, p_internal boolean default false, p_status text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t support_tickets%rowtype; v_staff boolean := can_support(); v_author text; v_status text;
begin
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'Request not found.'; end if;
  if not (v_staff or (auth.uid() is not null and t.user_id = auth.uid())) then
    raise exception 'You don''t have access to this request.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) < 1 then raise exception 'Write a message first.' using errcode = 'check_violation'; end if;
  if char_length(p_body) > 8000 then raise exception 'That message is too long.' using errcode = 'check_violation'; end if;
  v_author := case when v_staff and (t.user_id is distinct from auth.uid()) then 'staff' else 'customer' end;
  if v_author = 'customer' and t.status = 'closed' then
    raise exception 'This request is closed. Open a new one and mention %.', t.number using errcode = 'check_violation';
  end if;
  insert into support_messages (ticket_id, author_type, author_id, body, internal)
  values (t.id, v_author, auth.uid(), btrim(p_body), v_author = 'staff' and coalesce(p_internal, false));

  if v_author = 'staff' and coalesce(p_internal, false) then
    return jsonb_build_object('status', t.status, 'internal', true);
  end if;
  v_status := case
    when v_author = 'customer' then 'open'
    when p_status in ('open', 'pending', 'waiting_customer', 'resolved', 'closed') then p_status
    else 'waiting_customer' end;
  update support_tickets
     set status = v_status, last_message_at = now(), last_message_by = v_author,
         first_response_at = case when v_author = 'staff' then coalesce(first_response_at, now()) else first_response_at end,
         assignee_id = case when v_author = 'staff' then coalesce(assignee_id, auth.uid()) else assignee_id end,
         resolved_at = case when v_status in ('resolved', 'closed') then coalesce(resolved_at, now()) else null end
   where id = t.id;
  if v_author = 'staff' and t.user_id is not null then
    perform notify('customer', 'support_reply', 'info', 'New reply on ' || t.number, left(btrim(p_body), 140),
                   t.order_id, null, null, t.user_id, 'support:' || t.id);
  end if;
  return jsonb_build_object('status', v_status);
end $$;
revoke execute on function public.support_reply(uuid, text, boolean, text) from public, anon;
grant execute on function public.support_reply(uuid, text, boolean, text) to authenticated;

-- Staff: status / priority / assignee / topic / linked order.
create or replace function public.support_update(p_ticket uuid, p_status text default null, p_priority text default null,
  p_assignee uuid default null, p_unassign boolean default false, p_category text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t support_tickets%rowtype;
begin
  perform require_permission('support.write');
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'Request not found.'; end if;
  if p_assignee is not null and not exists (select 1 from user_roles where user_id = p_assignee and role <> 'partner_admin') then
    raise exception 'Assign it to a staff member.' using errcode = 'check_violation';
  end if;
  update support_tickets set
    status = coalesce(p_status, status), priority = coalesce(p_priority, priority), category = coalesce(p_category, category),
    assignee_id = case when p_unassign then null else coalesce(p_assignee, assignee_id) end,
    resolved_at = case when coalesce(p_status, status) in ('resolved', 'closed') then coalesce(resolved_at, now()) else null end
  where id = t.id returning * into t;
  if p_status is not null then
    insert into support_messages (ticket_id, author_type, author_id, body, internal)
    values (t.id, 'system', auth.uid(), 'Status: ' || replace(t.status, '_', ' '), true);
  end if;
  return to_jsonb(t);
end $$;
revoke execute on function public.support_update(uuid, text, text, uuid, boolean, text) from public, anon;
grant execute on function public.support_update(uuid, text, text, uuid, boolean, text) to authenticated;

-- One ticket with its thread. Customers never see internal notes.
create or replace function public.support_ticket(p_ticket uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare t support_tickets%rowtype; v_staff boolean := can_support() or has_permission('customers.read');
begin
  select * into t from support_tickets where id = p_ticket;
  if not found then return null; end if;
  if not (v_staff or (auth.uid() is not null and t.user_id = auth.uid())) then return null; end if;
  if not v_staff then
    update notifications set read_at = coalesce(read_at, now()), resolved_at = coalesce(resolved_at, now())
     where dedupe_key = 'support:' || t.id and user_id = auth.uid() and resolved_at is null;
  end if;
  return to_jsonb(t) || jsonb_build_object(
    'order_number', (select number from orders where id = t.order_id),
    'assignee', (select jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email) from profiles p where p.id = t.assignee_id),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'author_type', m.author_type, 'internal', m.internal, 'body', m.body, 'at', m.created_at,
                   'author', case when v_staff then (select coalesce(full_name, email) from profiles where id = m.author_id)
                                  when m.author_type = 'staff' then 'TH8RTY support' end) order by m.created_at, m.id), '[]')
                 from support_messages m where m.ticket_id = t.id and (v_staff or not m.internal)),
    'staff_view', v_staff);
end $$;
revoke execute on function public.support_ticket(uuid) from public, anon;
grant execute on function public.support_ticket(uuid) to authenticated;

create or replace function public.support_my_tickets()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject, 'category', t.category,
           'status', t.status, 'created_at', t.created_at, 'last_message_at', t.last_message_at, 'last_message_by', t.last_message_by,
           'order_number', (select number from orders where id = t.order_id)) order by t.last_message_at desc), '[]')
  from support_tickets t where t.user_id = auth.uid();
$$;
revoke execute on function public.support_my_tickets() from public, anon;
grant execute on function public.support_my_tickets() to authenticated;

create or replace function public.admin_support_tickets(p_view text default 'open', p_q text default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  if not (can_support() or has_permission('customers.read')) then raise exception 'You don''t have permission to do that (support.write).' using errcode = '42501'; end if;
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'open', count(*) filter (where status in ('open', 'pending')),
        'mine', count(*) filter (where status in ('open', 'pending', 'waiting_customer') and assignee_id = auth.uid()),
        'unassigned', count(*) filter (where status in ('open', 'pending') and assignee_id is null),
        'needs_reply', count(*) filter (where status in ('open', 'pending') and last_message_by = 'customer'),
        'waiting_customer', count(*) filter (where status = 'waiting_customer'),
        'resolved', count(*) filter (where status in ('resolved', 'closed'))) from support_tickets),
    'avg_first_response_hours', (select round(avg(extract(epoch from (first_response_at - created_at)) / 3600)::numeric, 1)
                                   from support_tickets where first_response_at is not null and created_at > now() - interval '30 days'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject, 'category', t.category,
               'status', t.status, 'priority', t.priority, 'email', t.email, 'name', t.name, 'user_id', t.user_id,
               'order_number', (select number from orders where id = t.order_id),
               'assignee', (select coalesce(full_name, email) from profiles where id = t.assignee_id),
               'last_message_at', t.last_message_at, 'last_message_by', t.last_message_by, 'created_at', t.created_at,
               'messages', (select count(*) from support_messages m where m.ticket_id = t.id and not m.internal))
               order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.last_message_at desc), '[]')
             from (select * from support_tickets t
                    where case coalesce(p_view, 'open')
                            when 'open' then status in ('open', 'pending')
                            when 'mine' then status in ('open', 'pending', 'waiting_customer') and assignee_id = auth.uid()
                            when 'unassigned' then status in ('open', 'pending') and assignee_id is null
                            when 'needs_reply' then status in ('open', 'pending') and last_message_by = 'customer'
                            when 'waiting_customer' then status = 'waiting_customer'
                            when 'resolved' then status in ('resolved', 'closed')
                            else true end
                      and (v_q is null or number ilike '%' || v_q || '%' or email ilike '%' || v_q || '%' or subject ilike '%' || v_q || '%'
                           or name ilike '%' || v_q || '%')
                    order by last_message_at desc limit least(coalesce(p_limit, 200), 500)) t),
    'staff', (select coalesce(jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', coalesce(p.full_name, p.email))), '[]')
                from user_roles r join profiles p on p.id = r.user_id where r.role <> 'partner_admin'),
    'can_write', can_support());
end $$;
revoke execute on function public.admin_support_tickets(text, text, int) from public, anon;
grant execute on function public.admin_support_tickets(text, text, int) to authenticated;

-- Staff opens a ticket on a customer's behalf (phone / email contact).
create or replace function public.admin_support_open(p_user uuid, p_subject text, p_category text, p_body text, p_channel text default 'phone')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_number text; pr profiles%rowtype;
begin
  perform require_permission('support.write');
  select * into pr from profiles where id = p_user;
  if not found then raise exception 'Customer not found.'; end if;
  if p_channel not in ('email', 'phone', 'staff') then raise exception 'Unknown channel.' using errcode = 'check_violation'; end if;
  insert into support_tickets (user_id, email, name, subject, category, channel, assignee_id, last_message_by, status)
  values (pr.id, pr.email, pr.full_name, btrim(p_subject), coalesce(p_category, 'general'), p_channel, auth.uid(), 'staff', 'pending')
  returning id, number into v_id, v_number;
  insert into support_messages (ticket_id, author_type, author_id, body, internal) values (v_id, 'staff', auth.uid(), btrim(p_body), true);
  return jsonb_build_object('id', v_id, 'number', v_number);
end $$;
revoke execute on function public.admin_support_open(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_support_open(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Customer stats + segments (one definition, used by list and profile)
-- ---------------------------------------------------------------------
create or replace function public.crm_stats(p_user uuid default null)
returns table (
  user_id uuid, email text, full_name text, phone text, marketing_opt_in boolean, created_at timestamptz,
  orders int, units int, gross_cents bigint, refunded_cents bigint, ltv_cents bigint, aov_cents int,
  first_order_at timestamptz, last_order_at timestamptz, refunds int, returns int, custom_orders int, limited_orders int,
  designs int, wishlist int, open_tickets int, tickets int, province text, abandoned_cart_cents int, abandoned_cart_at timestamptz,
  is_staff boolean, tags text[], segments text[])
language sql stable security definer set search_path = public as $$
  with s as (select setting_int('crm.high_value_cents', 50000) hv, setting_int('crm.inactive_days', 120) inact,
                    setting_int('crm.new_days', 60) newd, setting_int('crm.abandoned_hours', 2) ab),
  paid as (
    select o.user_id, o.id, o.total_cents, o.paid_at, o.status, o.shipping_address->>'province' prov
      from orders o where o.paid_at is not null and o.user_id is not null and (p_user is null or o.user_id = p_user)),
  agg as (
    select p.user_id,
           count(*)::int orders,
           sum(p.total_cents)::bigint gross,
           min(p.paid_at) first_at, max(p.paid_at) last_at,
           count(*) filter (where p.status = 'returned')::int returns,
           (array_agg(p.prov order by p.paid_at desc))[1] prov
      from paid p group by p.user_id),
  refunds as (
    select o.user_id, sum(pm.amount_cents)::bigint amt, count(distinct o.id)::int n
      from payments pm join orders o on o.id = pm.order_id
     where pm.kind = 'refund' and o.user_id is not null and (p_user is null or o.user_id = p_user) group by o.user_id),
  items as (
    select p.user_id, sum(oi.quantity)::int units,
           count(distinct p.id) filter (where oi.item_type = 'custom')::int custom_orders,
           count(distinct p.id) filter (where oi.drop_id is not null)::int limited_orders
      from paid p join order_items oi on oi.order_id = p.id group by p.user_id),
  open_carts as (
    select c.user_id, max(c.updated_at) at,
           sum(cart_line_cents(ci))::int cents
      from carts c join cart_items ci on ci.cart_id = c.id, s
     where c.status = 'open' and c.user_id is not null and c.updated_at < now() - make_interval(hours => s.ab)
       and (p_user is null or c.user_id = p_user)
     group by c.user_id)
  select pr.id, pr.email, pr.full_name, pr.phone, pr.marketing_opt_in, pr.created_at,
         coalesce(a.orders, 0), coalesce(i.units, 0), coalesce(a.gross, 0), coalesce(r.amt, 0),
         coalesce(a.gross, 0) - coalesce(r.amt, 0),
         case when coalesce(a.orders, 0) > 0 then (a.gross / a.orders)::int else 0 end,
         a.first_at, a.last_at, coalesce(r.n, 0), coalesce(a.returns, 0), coalesce(i.custom_orders, 0), coalesce(i.limited_orders, 0),
         (select count(*)::int from custom_designs d where d.user_id = pr.id),
         (select count(*)::int from wishlist_items w where w.user_id = pr.id),
         (select count(*)::int from support_tickets t where t.user_id = pr.id and t.status in ('open', 'pending', 'waiting_customer')),
         (select count(*)::int from support_tickets t where t.user_id = pr.id),
         a.prov, ca.cents, ca.at,
         exists (select 1 from user_roles ur where ur.user_id = pr.id),
         coalesce(cc.tags, '{}'),
         array_remove(array[
           case when coalesce(a.orders, 0) = 0 then 'prospect' end,
           case when a.orders >= 1 and a.first_at > now() - make_interval(days => s.newd) and a.orders = 1 then 'new' end,
           case when a.orders >= 2 then 'returning' end,
           case when coalesce(a.gross, 0) - coalesce(r.amt, 0) >= s.hv then 'high_value' end,
           case when a.orders >= 1 and a.last_at < now() - make_interval(days => s.inact) then 'inactive' end,
           case when coalesce(i.custom_orders, 0) > 0
                  or exists (select 1 from custom_designs d where d.user_id = pr.id and d.status <> 'draft') then 'custom_design' end,
           case when coalesce(i.limited_orders, 0) > 0 then 'collector' end,
           case when ca.cents is not null then 'abandoned_cart' end,
           case when pr.marketing_opt_in then 'subscribed' end], null)
    from profiles pr cross join s
    left join agg a on a.user_id = pr.id
    left join refunds r on r.user_id = pr.id
    left join items i on i.user_id = pr.id
    left join open_carts ca on ca.user_id = pr.id
    left join customer_crm cc on cc.user_id = pr.id
   where p_user is null or pr.id = p_user;
$$;
revoke execute on function public.crm_stats(uuid) from public, anon, authenticated;

create or replace function public.admin_crm_customers(p_q text default null, p_segment text default null, p_sort text default 'ltv',
  p_limit int default 100, p_offset int default 0, p_include_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  perform require_permission('customers.read');
  return (with base as (
            select * from crm_stats(null) c where (p_include_staff or not c.is_staff)),
          filtered as (
            select * from base c
             where (v_q is null or c.email ilike '%' || v_q || '%' or c.full_name ilike '%' || v_q || '%' or c.phone ilike '%' || v_q || '%'
                    or v_q = any(c.tags))
               and (p_segment is null or p_segment = '' or p_segment = any(c.segments))),
          ranked as (
            select f.*, row_number() over (order by
                     case when p_sort = 'recent' then coalesce(f.last_order_at, '1970-01-01') end desc nulls last,
                     case when p_sort = 'orders' then f.orders end desc nulls last,
                     case when p_sort = 'joined' then f.created_at end desc nulls last,
                     case when p_sort = 'name' then lower(coalesce(f.full_name, f.email)) end asc nulls last,
                     f.ltv_cents desc, f.created_at desc) rn
              from filtered f)
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'segments', (select jsonb_build_object('all', count(*),
          'prospect', count(*) filter (where 'prospect' = any(segments)), 'new', count(*) filter (where 'new' = any(segments)),
          'returning', count(*) filter (where 'returning' = any(segments)), 'high_value', count(*) filter (where 'high_value' = any(segments)),
          'inactive', count(*) filter (where 'inactive' = any(segments)), 'custom_design', count(*) filter (where 'custom_design' = any(segments)),
          'collector', count(*) filter (where 'collector' = any(segments)), 'abandoned_cart', count(*) filter (where 'abandoned_cart' = any(segments)),
          'subscribed', count(*) filter (where 'subscribed' = any(segments))) from base),
      'totals', (select jsonb_build_object('ltv_cents', coalesce(sum(ltv_cents), 0), 'orders', coalesce(sum(orders), 0),
          'repeat_rate', case when count(*) filter (where orders >= 1) > 0
                              then round(100.0 * count(*) filter (where orders >= 2) / count(*) filter (where orders >= 1)) end,
          'avg_ltv_cents', coalesce((avg(ltv_cents) filter (where orders >= 1))::int, 0)) from base),
      'settings', jsonb_build_object('high_value_cents', setting_int('crm.high_value_cents', 50000), 'inactive_days', setting_int('crm.inactive_days', 120),
                                     'new_days', setting_int('crm.new_days', 60), 'abandoned_hours', setting_int('crm.abandoned_hours', 2)),
      'rows', (select coalesce(jsonb_agg(to_jsonb(r) - 'rn' order by r.rn), '[]') from ranked r
                where r.rn > greatest(0, coalesce(p_offset, 0)) and r.rn <= greatest(0, coalesce(p_offset, 0)) + greatest(1, least(coalesce(p_limit, 100), 1000)))));
end $$;
revoke execute on function public.admin_crm_customers(text, text, text, int, int, boolean) from public, anon;
grant execute on function public.admin_crm_customers(text, text, text, int, int, boolean) to authenticated;

-- One customer, everything staff need.
create or replace function public.admin_crm_customer(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare st jsonb;
begin
  perform require_permission('customers.read');
  select to_jsonb(c) into st from crm_stats(p_user) c;
  if st is null then return null; end if;
  return jsonb_build_object(
    'customer', st,
    'roles', (select coalesce(jsonb_agg(role), '[]') from user_roles where user_id = p_user),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'total_cents', o.total_cents,
                 'paid_at', o.paid_at, 'created_at', o.created_at,
                 'units', (select coalesce(sum(quantity), 0) from order_items where order_id = o.id),
                 'summary', (select string_agg(product_name || case when quantity > 1 then ' ×' || quantity else '' end, ', ') from order_items where order_id = o.id),
                 'refunded_cents', (select coalesce(sum(amount_cents), 0) from payments where order_id = o.id and kind = 'refund'))
                 order by o.created_at desc), '[]') from orders o where o.user_id = p_user),
    'addresses', (select coalesce(jsonb_agg(to_jsonb(a) order by a.is_default desc, a.created_at desc), '[]') from addresses a where a.user_id = p_user),
    'designs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'status', d.status, 'version', d.version, 'updated_at', d.updated_at)
                 order by d.updated_at desc), '[]') from (select * from custom_designs where user_id = p_user order by updated_at desc limit 20) d),
    'wishlist', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(p.name, c.name), 'kind', case when p.id is not null then 'product' else 'collection' end,
                   'slug', coalesce(p.slug, c.slug), 'status', p.status, 'saved_at', w.created_at) order by w.created_at desc), '[]')
                 from wishlist_items w left join products p on p.id = w.product_id left join collections c on c.id = w.collection_id where w.user_id = p_user),
    'cart', (select jsonb_build_object('updated_at', c.updated_at, 'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', coalesce(pr.name, 'Custom design'), 'quantity', ci.quantity, 'line_cents', cart_line_cents(ci),
                'variant', concat_ws(' / ', v.color, v.size), 'item_type', ci.item_type)), '[]')
                from cart_items ci left join product_variants v on v.id = ci.variant_id left join products pr on pr.id = v.product_id where ci.cart_id = c.id))
             from carts c where c.user_id = p_user and c.status = 'open' and exists (select 1 from cart_items where cart_id = c.id)
             order by c.updated_at desc limit 1),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject, 'status', t.status,
                  'priority', t.priority, 'last_message_at', t.last_message_at) order by t.last_message_at desc), '[]') from support_tickets t where t.user_id = p_user),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'at', n.created_at,
                'author', (select coalesce(full_name, email) from profiles where id = n.author_id)) order by n.created_at desc), '[]')
              from crm_notes n where n.user_id = p_user),
    'activity', (select coalesce(jsonb_agg(jsonb_build_object('type', e.event_type, 'path', e.path, 'entity_type', e.entity_type, 'entity_id', e.entity_id,
                   'properties', e.properties, 'at', e.created_at) order by e.created_at desc), '[]')
                 from (select * from analytics_events where user_id = p_user order by created_at desc limit 40) e),
    'top_categories', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'units', units) order by units desc), '[]') from (
                   select cat.name, sum(oi.quantity) units from orders o join order_items oi on oi.order_id = o.id
                     join products p on p.id = oi.product_id join categories cat on cat.id = p.category_id
                    where o.user_id = p_user and o.paid_at is not null group by cat.name order by 2 desc limit 4) x),
    'newsletter', (select jsonb_build_object('subscribed_at', created_at, 'unsubscribed_at', unsubscribed_at, 'source', source)
                   from newsletter_subscribers where user_id = p_user or lower(email) = lower(st->>'email') order by created_at desc limit 1),
    'can', jsonb_build_object('write', has_permission('customers.write'), 'support', can_support(), 'orders', has_permission('orders.read')));
end $$;
revoke execute on function public.admin_crm_customer(uuid) from public, anon;
grant execute on function public.admin_crm_customer(uuid) to authenticated;

create or replace function public.admin_crm_note(p_user uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.write');
  if char_length(btrim(coalesce(p_body, ''))) < 2 then raise exception 'Write a note first.' using errcode = 'check_violation'; end if;
  insert into crm_notes (user_id, author_id, body) values (p_user, auth.uid(), btrim(p_body));
end $$;
revoke execute on function public.admin_crm_note(uuid, text) from public, anon;
grant execute on function public.admin_crm_note(uuid, text) to authenticated;

create or replace function public.admin_crm_tags(p_user uuid, p_tags text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  perform require_permission('customers.write');
  select coalesce(array_agg(distinct t order by t), '{}') into v
    from (select lower(left(regexp_replace(btrim(x), '\s+', '-', 'g'), 30)) t from unnest(coalesce(p_tags, '{}')) x where btrim(x) <> '') y;
  if cardinality(v) > 20 then raise exception 'Up to 20 tags.' using errcode = 'check_violation'; end if;
  insert into customer_crm (user_id, tags, updated_by) values (p_user, v, auth.uid())
  on conflict (user_id) do update set tags = excluded.tags, updated_by = excluded.updated_by;
  return v;
end $$;
revoke execute on function public.admin_crm_tags(uuid, text[]) from public, anon;
grant execute on function public.admin_crm_tags(uuid, text[]) to authenticated;

-- Abandoned bags (signed-in shoppers) for follow-up.
create or replace function public.admin_abandoned_carts(p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.read');
  return (select coalesce(jsonb_agg(x order by x->>'updated_at' desc), '[]') from (
    select jsonb_build_object('user_id', c.user_id, 'email', p.email, 'name', p.full_name, 'marketing_opt_in', p.marketing_opt_in,
             'updated_at', c.updated_at,
             'units', (select sum(quantity) from cart_items where cart_id = c.id),
             'value_cents', (select sum(cart_line_cents(ci)) from cart_items ci where ci.cart_id = c.id),
             'items', (select string_agg(coalesce(pr.name, 'Custom design') || ' ×' || ci.quantity, ', ')
                       from cart_items ci left join product_variants v on v.id = ci.variant_id left join products pr on pr.id = v.product_id where ci.cart_id = c.id),
             'checkout_started', exists (select 1 from orders o where o.cart_id = c.id)) x
      from carts c join profiles p on p.id = c.user_id
     where c.status = 'open' and c.updated_at < now() - make_interval(hours => setting_int('crm.abandoned_hours', 2))
       and exists (select 1 from cart_items where cart_id = c.id)
     order by c.updated_at desc limit least(coalesce(p_limit, 200), 500)) t);
end $$;
revoke execute on function public.admin_abandoned_carts(int) from public, anon;
grant execute on function public.admin_abandoned_carts(int) to authenticated;

-- Customer's own updates (support replies, shipping) for the account page.
create or replace function public.my_notifications(p_limit int default 20)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'at', n.created_at,
           'read', n.read_at is not null or n.resolved_at is not null,
           'order_number', (select number from orders where id = n.order_id),
           'ticket_id', case when n.dedupe_key like 'support:%' then substr(n.dedupe_key, 9) end) order by n.created_at desc), '[]')
  from (select * from notifications where audience = 'customer' and user_id = auth.uid() order by created_at desc limit least(coalesce(p_limit, 20), 100)) n;
$$;
revoke execute on function public.my_notifications(int) from public, anon;
grant execute on function public.my_notifications(int) to authenticated;
