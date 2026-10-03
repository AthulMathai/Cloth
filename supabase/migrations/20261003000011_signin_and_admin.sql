-- Phase: sign-in required to shop + admin control center back end.
-- Additive: patches function bodies in place and adds new staff functions.

-- ---------------------------------------------------------------------
-- 1. Shoppers must be signed in to add to the bag or check out.
--    (Existing guest bags still merge into the account bag on sign-in;
--    guest order links from earlier orders keep working.)
-- ---------------------------------------------------------------------
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.cart_set_item(text,uuid,integer,text)'::regprocedure);
  n := replace(d, E'begin\n  if p_mode not in',
    E'begin\n  if auth.uid() is null and coalesce(p_quantity, 0) > 0 then\n    raise exception ''Sign in to add items to your bag.'' using errcode = ''42501'';\n  end if;\n  if p_mode not in');
  if n = d and position('Sign in to add items' in d) = 0 then raise exception 'cart_set_item patch did not apply'; end if;
  execute n;

  d := pg_get_functiondef('public.cart_set_line(text,uuid,integer)'::regprocedure);
  n := replace(d, E'begin\n  if p_quantity is null',
    E'begin\n  if auth.uid() is null then raise exception ''Sign in to change your bag.'' using errcode = ''42501''; end if;\n  if p_quantity is null');
  if n = d and position('Sign in to change your bag' in d) = 0 then raise exception 'cart_set_line patch did not apply'; end if;
  execute n;

  d := pg_get_functiondef('public.create_order(text,uuid,text,text,jsonb,text,text,text,integer)'::regprocedure);
  n := replace(d, E'begin\n  if p_idempotency_key is null',
    E'begin\n  if p_user_id is null then raise exception ''Sign in to check out.'' using errcode = ''42501''; end if;\n  if p_idempotency_key is null');
  if n = d and position('Sign in to check out' in d) = 0 then raise exception 'create_order patch did not apply'; end if;
  execute n;
end $$;

-- ---------------------------------------------------------------------
-- 2. First owner: the confirmed account whose email matches the
--    'admin.owner_email' setting becomes super_admin — only while no
--    super_admin exists. Afterwards staff are added from the admin panel.
-- ---------------------------------------------------------------------
insert into public.store_settings (key, value, is_public)
values ('admin.owner_email', to_jsonb('athulmathai333@gmail.com'::text), false)
on conflict (key) do nothing;

create or replace function public.claim_owner()
returns boolean language plpgsql security definer set search_path = public as $$
declare v_email text; v_owner text;
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from user_roles where role = 'super_admin') then return false; end if;
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  select lower(value #>> '{}') into v_owner from store_settings where key = 'admin.owner_email';
  if v_email is null or v_owner is null or v_email <> v_owner then return false; end if;
  insert into user_roles (user_id, role, granted_by) values (auth.uid(), 'super_admin', auth.uid());
  insert into audit_log (actor_id, actor_role, action, entity_type, entity_id, after)
  values (auth.uid(), 'super_admin', 'owner_claimed', 'user', auth.uid()::text, jsonb_build_object('email', v_email));
  return true;
end $$;
revoke execute on function public.claim_owner() from public, anon;
grant execute on function public.claim_owner() to authenticated;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.require_permission(p text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission(p) then raise exception 'You don''t have permission to do that (%).', p using errcode = '42501'; end if;
end $$;
revoke execute on function public.require_permission(text) from public, anon, authenticated;

create or replace function public.staff_note(p_order_id uuid, p_event text, p_note text, p_data jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into order_events (order_id, status, event, note, actor_type, actor_id, data)
  select id, status, p_event, nullif(btrim(p_note), ''), 'staff', auth.uid(), coalesce(p_data, '{}') from orders where id = p_order_id;
$$;
revoke execute on function public.staff_note(uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Dashboard (every number comes from live rows)
-- ---------------------------------------------------------------------
create or replace function public.admin_dashboard(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365))); r jsonb;
begin
  if not is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  with paid as (
    select * from orders where paid_at is not null and paid_at >= v_from
  ), money as (
    select coalesce(sum(case when kind = 'charge' then amount_cents else 0 end), 0) charged,
           coalesce(sum(case when kind = 'refund' then amount_cents else 0 end), 0) refunded
    from payments where created_at >= v_from and status in ('succeeded', 'refunded')
  ), sessions as (
    select count(distinct coalesce(session_id, user_id::text)) n from analytics_events where event_type = 'page_view' and created_at >= v_from
  ), daily as (
    select to_char(g.d, 'YYYY-MM-DD') as dkey,
           coalesce((select sum(total_cents) from orders o where o.paid_at >= g.d and o.paid_at < g.d + interval '1 day'), 0) as drev,
           (select count(*) from orders o where o.paid_at >= g.d and o.paid_at < g.d + interval '1 day') as dorders
    from generate_series(date_trunc('day', v_from), date_trunc('day', now()), interval '1 day') as g(d)
  )
  select jsonb_build_object(
    'days', p_days,
    'revenue_cents', (select charged - refunded from money),
    'gross_cents', (select charged from money),
    'refunded_cents', (select refunded from money),
    'orders', (select count(*) from paid),
    'customers', (select count(distinct coalesce(user_id::text, email)) from paid),
    'aov_cents', (select coalesce(round(avg(total_cents)), 0) from paid),
    'visitors', (select n from sessions),
    'conversion', (select case when n > 0 then round((select count(*) from paid)::numeric / n * 100, 2) else null end from sessions),
    'status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from orders group by status) s),
    'pending', (select count(*) from orders where status in ('paid', 'moderation_pending', 'approved', 'fulfillment_pending', 'on_hold')),
    'production', (select count(*) from orders where status in ('assigned', 'production_queued', 'printing', 'quality_check', 'packed')),
    'shipped', (select count(*) from orders where status in ('shipped', 'in_transit', 'out_for_delivery')),
    'delivered', (select count(*) from orders where status = 'delivered'),
    'backordered', (select count(*) from orders where status = 'backordered'),
    'on_hold', (select count(*) from orders where status = 'on_hold'),
    'refunds', (select count(*) from payments where kind = 'refund' and created_at >= v_from),
    'active_products', (select count(*) from products where status = 'active'),
    'low_stock', (select count(*) from product_variants v join products p on p.id = v.product_id
                  where v.is_active and p.status in ('active', 'out_of_stock') and v.inventory_on_hand - v.inventory_reserved <= v.low_stock_threshold),
    'live_drops', (select count(*) from limited_drops d join products p on p.id = d.product_id where p.status = 'active'),
    'upcoming_drops', (select count(*) from limited_drops d join products p on p.id = d.product_id where p.status = 'scheduled'),
    'archived_drops', (select count(*) from limited_drops where archived_at is not null),
    'pending_moderation', (select count(*) from custom_designs where status in ('pending', 'needs_review')),
    'open_quotes', (select count(*) from quote_requests where status in ('new', 'reviewing')),
    'daily', (select jsonb_agg(jsonb_build_object('day', dkey, 'revenue_cents', drev, 'orders', dorders) order by dkey) from daily),
    'top_products', (select coalesce(jsonb_agg(t), '[]') from (
        select oi.product_name as name, sum(oi.quantity) as units, sum(oi.line_total_cents) as revenue_cents
        from order_items oi join paid o on o.id = oi.order_id group by 1 order by 2 desc limit 5) t),
    'recent', (select coalesce(jsonb_agg(t), '[]') from (
        select id, number, email, status, total_cents, created_at from orders where status <> 'payment_pending' order by created_at desc limit 8) t)
  ) into r;
  return r;
end $$;
revoke execute on function public.admin_dashboard(int) from public, anon;
grant execute on function public.admin_dashboard(int) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Orders
-- ---------------------------------------------------------------------
create or replace function public.admin_orders(p_q text default null, p_group text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), ''); v_st order_status[];
begin
  perform require_permission('orders.read');
  v_st := case p_group
    when 'pending' then array['paid', 'moderation_pending', 'approved', 'fulfillment_pending', 'on_hold']::order_status[]
    when 'production' then array['assigned', 'production_queued', 'printing', 'quality_check', 'packed']::order_status[]
    when 'shipped' then array['shipped', 'in_transit', 'out_for_delivery']::order_status[]
    when 'delivered' then array['delivered']::order_status[]
    when 'backorders' then array['backordered']::order_status[]
    when 'returns' then array['returned']::order_status[]
    when 'refunds' then array['refunded']::order_status[]
    when 'cancelled' then array['cancelled', 'failed']::order_status[]
    when 'unpaid' then array['created', 'payment_pending']::order_status[]
    else null end;
  return jsonb_build_object(
    'total', (select count(*) from orders o
              where (v_st is null and o.status not in ('created', 'payment_pending') or o.status = any(v_st))
                and (v_q is null or o.number ilike '%' || v_q || '%' or o.email ilike '%' || v_q || '%'
                     or o.shipping_address->>'full_name' ilike '%' || v_q || '%')),
    'rows', (select coalesce(jsonb_agg(t order by t.created_at desc), '[]') from (
      select o.id, o.number, o.email, o.shipping_address->>'full_name' as name, o.shipping_address->>'province' as province,
             o.status, o.total_cents, o.created_at, o.paid_at,
             (select sum(quantity) from order_items where order_id = o.id) as units,
             exists (select 1 from order_items where order_id = o.id and item_type = 'custom') as custom,
             exists (select 1 from order_items where order_id = o.id and drop_id is not null) as limited
      from orders o
      where (v_st is null and o.status not in ('created', 'payment_pending') or o.status = any(v_st))
        and (v_q is null or o.number ilike '%' || v_q || '%' or o.email ilike '%' || v_q || '%'
             or o.shipping_address->>'full_name' ilike '%' || v_q || '%')
      order by o.created_at desc
      limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) t));
end $$;
revoke execute on function public.admin_orders(text, text, int, int) from public, anon;
grant execute on function public.admin_orders(text, text, int, int) to authenticated;

create or replace function public.admin_order(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o orders%rowtype;
begin
  perform require_permission('orders.read');
  select * into o from orders where id = p_order_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'order', to_jsonb(o) - 'access_token_hash' - 'idempotency_key' - 'pricing_snapshot',
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', oi.id, 'item_type', oi.item_type, 'name', oi.product_name, 'product_id', oi.product_id, 'product_type', oi.product_type,
        'sku', oi.sku, 'color', oi.color, 'color_hex', oi.color_hex, 'size', oi.size, 'quantity', oi.quantity,
        'unit_price_cents', oi.unit_price_cents, 'line_total_cents', oi.line_total_cents, 'discount_cents', oi.discount_cents,
        'edition_numbers', oi.edition_numbers, 'edition_size', (select edition_size from limited_drops where id = oi.drop_id),
        'design_id', oi.custom_design_id, 'design_version', oi.design_version,
        'design', case when oi.custom_design_id is null then null else (
          select jsonb_build_object('name', d.name, 'status', d.status, 'approved_version', d.approved_version, 'mockups', d.mockups,
                                    'version_mockups', dv.mockups, 'production_files', dv.production_files,
                                    'print', oi.snapshot->'pricing'->'print',
                                    'moderation', (select to_jsonb(m) from moderation_results m where m.design_id = d.id order by m.created_at desc limit 1))
          from custom_designs d left join design_versions dv on dv.design_id = d.id and dv.version = oi.design_version
          where d.id = oi.custom_design_id) end,
        'costs', case when has_permission('pricing.write') or has_permission('analytics.read') then jsonb_build_object('cost', oi.snapshot->'pricing'->'cost', 'margin_cents', oi.snapshot->'pricing'->'margin_cents', 'margin_pct', oi.snapshot->'pricing'->'margin_pct') end)
        order by oi.created_at), '[]') from order_items oi where oi.order_id = o.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'event', e.event, 'note', e.note, 'actor_type', e.actor_type,
                 'actor', (select email from profiles where id = e.actor_id), 'data', e.data, 'at', e.created_at) order by e.created_at, e.id), '[]')
               from order_events e where e.order_id = o.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('provider', provider, 'ref', provider_ref, 'kind', kind, 'status', status,
                 'amount_cents', amount_cents, 'at', created_at) order by created_at), '[]') from payments where order_id = o.id),
    'refunded_cents', (select coalesce(sum(amount_cents), 0) from payments where order_id = o.id and kind = 'refund'),
    'customer', jsonb_build_object(
        'profile', (select to_jsonb(p) - 'avatar_path' from profiles p where p.id = o.user_id),
        'orders', (select count(*) from orders x where (x.user_id = o.user_id or lower(x.email) = lower(o.email)) and x.paid_at is not null),
        'spent_cents', (select coalesce(sum(total_cents), 0) from orders x where (x.user_id = o.user_id or lower(x.email) = lower(o.email)) and x.paid_at is not null)),
    'can', jsonb_build_object('write', has_permission('orders.write'), 'refund', has_permission('orders.refund')));
end $$;
revoke execute on function public.admin_order(uuid) from public, anon;
grant execute on function public.admin_order(uuid) to authenticated;

create or replace function public.admin_order_note(p_order_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('orders.write');
  if char_length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'Write a note first.' using errcode = 'check_violation'; end if;
  perform staff_note(p_order_id, 'note', left(p_note, 2000));
end $$;
revoke execute on function public.admin_order_note(uuid, text) from public, anon;
grant execute on function public.admin_order_note(uuid, text) to authenticated;

create or replace function public.admin_order_hold(p_order_id uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  perform require_permission('orders.write');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('on_hold', 'delivered', 'cancelled', 'refunded', 'failed', 'returned', 'created', 'payment_pending') then
    raise exception 'An order that is % can''t be put on hold.', replace(o.status::text, '_', ' ') using errcode = 'check_violation';
  end if;
  perform set_config('app.actor_type', 'staff', true);
  perform set_config('app.status_note', coalesce(nullif(btrim(p_note), ''), 'Put on hold by staff.'), true);
  update orders set status = 'on_hold' where id = o.id;
  perform set_config('app.status_note', '', true);
  return 'on_hold';
end $$;
revoke execute on function public.admin_order_hold(uuid, text) from public, anon;
grant execute on function public.admin_order_hold(uuid, text) to authenticated;

-- Resume a held order to where it was (or a chosen pre-shipping status).
create or replace function public.admin_order_resume(p_order_id uuid, p_note text default null, p_to order_status default null)
returns text language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; v_to order_status;
begin
  perform require_permission('orders.write');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status <> 'on_hold' then raise exception 'Only orders on hold can be resumed.' using errcode = 'check_violation'; end if;
  if o.paid_at is null then raise exception 'This order was never paid; cancel it instead.' using errcode = 'check_violation'; end if;
  v_to := coalesce(p_to, (select e.status from order_events e
                          where e.order_id = o.id and e.status is not null and e.status not in ('on_hold', 'paid')
                            and e.event in ('status_changed', 'order_created')
                          order by e.created_at desc, e.id desc limit 1), 'fulfillment_pending');
  if v_to in ('payment_pending', 'created', 'on_hold', 'cancelled', 'refunded', 'failed') then v_to := 'fulfillment_pending'; end if;
  perform set_config('app.actor_type', 'staff', true);
  perform set_config('app.status_note', coalesce(nullif(btrim(p_note), ''), 'Hold released by staff.'), true);
  update orders set status = v_to where id = o.id;
  perform set_config('app.status_note', '', true);
  return v_to::text;
end $$;
revoke execute on function public.admin_order_resume(uuid, text, order_status) from public, anon;
grant execute on function public.admin_order_resume(uuid, text, order_status) to authenticated;

-- Cancel before it ships. Paid orders: stock goes back (limited edition
-- numbers already issued stay retired, never re-issued); a refund is a
-- separate step through the payment provider.
create or replace function public.admin_order_cancel(p_order_id uuid, p_note text, p_restock boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; it order_items%rowtype; v_restocked int := 0;
begin
  perform require_permission('orders.write');
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('shipped', 'in_transit', 'out_for_delivery', 'delivered', 'returned') then
    raise exception 'This order has already shipped; record a return instead.' using errcode = 'check_violation';
  end if;
  if o.status in ('cancelled', 'refunded', 'failed') then raise exception 'This order is already closed.' using errcode = 'check_violation'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Give a reason for cancelling.' using errcode = 'check_violation'; end if;

  if o.status = 'payment_pending' then
    perform release_order(o.id, 'cancelled', 'Cancelled by staff: ' || p_note);
    return jsonb_build_object('status', 'cancelled', 'restocked', 0, 'refund_due_cents', 0);
  end if;

  if p_restock then
    for it in select * from order_items where order_id = o.id and variant_id is not null and drop_id is null loop
      perform set_config('app.stock_change', 'on', true);
      update product_variants set inventory_on_hand = inventory_on_hand + it.quantity where id = it.variant_id;
      perform set_config('app.stock_change', 'off', true);
      insert into inventory_movements (variant_id, delta, reason, note, reference, actor_id, on_hand_after)
      select it.variant_id, it.quantity, 'return', 'Order cancelled', o.number, auth.uid(), inventory_on_hand from product_variants where id = it.variant_id;
      v_restocked := v_restocked + it.quantity;
    end loop;
  end if;
  perform set_config('app.actor_type', 'staff', true);
  perform set_config('app.status_note', 'Cancelled: ' || p_note, true);
  update orders set status = 'cancelled', cancelled_at = now() where id = o.id;
  perform set_config('app.status_note', '', true);
  return jsonb_build_object('status', 'cancelled', 'restocked', v_restocked,
    'refund_due_cents', case when o.paid_at is null then 0 else o.total_cents - coalesce((select sum(amount_cents) from payments where order_id = o.id and kind = 'refund'), 0) end);
end $$;
revoke execute on function public.admin_order_cancel(uuid, text, boolean) from public, anon;
grant execute on function public.admin_order_cancel(uuid, text, boolean) to authenticated;

-- Refund bookkeeping: only the server (after the provider confirms).
create or replace function public.record_refund(p_order_id uuid, p_provider text, p_ref text, p_amount_cents int, p_actor uuid, p_note text, p_raw jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; v_refunded int;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if exists (select 1 from payments where provider = p_provider and provider_ref = p_ref and kind = 'refund') then
    return jsonb_build_object('duplicate', true, 'status', o.status);
  end if;
  insert into payments (order_id, provider, provider_ref, kind, status, amount_cents, currency, raw)
  values (o.id, p_provider, p_ref, 'refund', 'refunded', p_amount_cents, o.currency, coalesce(p_raw, '{}'));
  select coalesce(sum(amount_cents), 0) into v_refunded from payments where order_id = o.id and kind = 'refund';
  insert into order_events (order_id, status, event, note, actor_type, actor_id, data)
  values (o.id, o.status, 'refund', p_note, 'staff', p_actor, jsonb_build_object('amount_cents', p_amount_cents, 'provider', p_provider, 'ref', p_ref));
  if v_refunded >= o.total_cents then
    perform set_config('app.actor_type', 'staff', true);
    perform set_config('app.status_note', 'Refunded in full.', true);
    update orders set status = 'refunded' where id = o.id;
    perform set_config('app.status_note', '', true);
  end if;
  insert into audit_log (actor_id, actor_role, action, entity_type, entity_id, after)
  values (p_actor, 'staff', 'refund', 'order', o.id::text, jsonb_build_object('amount_cents', p_amount_cents, 'total_refunded', v_refunded));
  return jsonb_build_object('refunded_cents', v_refunded, 'status', (select status from orders where id = o.id));
end $$;
revoke execute on function public.record_refund(uuid, text, text, int, uuid, text, jsonb) from public, anon, authenticated;

-- Lets the refund function check the caller's permission and the refundable amount.
create or replace function public.admin_refund_check(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare o orders%rowtype;
begin
  perform require_permission('orders.refund');
  select * into o from orders where id = p_order_id;
  if not found or o.paid_at is null then raise exception 'Only paid orders can be refunded.' using errcode = 'check_violation'; end if;
  return jsonb_build_object('order_id', o.id, 'number', o.number, 'provider', o.payment_provider, 'payment_ref', o.payment_ref,
    'total_cents', o.total_cents, 'actor', auth.uid(),
    'refundable_cents', o.total_cents - coalesce((select sum(amount_cents) from payments where order_id = o.id and kind = 'refund'), 0));
end $$;
revoke execute on function public.admin_refund_check(uuid) from public, anon;
grant execute on function public.admin_refund_check(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Moderation queue (human review)
-- ---------------------------------------------------------------------
create or replace function public.admin_moderation_queue(p_status text default 'review', p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('moderation.review');
  return (select coalesce(jsonb_agg(t order by t.submitted_at nulls last), '[]') from (
    select d.id, d.name, d.status, d.version, d.approved_version, d.submitted_at, d.decided_at, d.decision_note, d.mockups, d.config,
           pr.name as product_name, pr.product_type,
           (select email from profiles where id = d.user_id) as customer_email,
           (select full_name from profiles where id = d.user_id) as customer_name,
           (select to_jsonb(m) from moderation_results m where m.design_id = d.id order by m.created_at desc limit 1) as latest,
           (select coalesce(jsonb_agg(jsonb_build_object('provider', m.provider, 'decision', m.decision, 'risk', m.risk_score,
                     'findings', m.findings, 'version', m.design_version, 'at', m.created_at) order by m.created_at desc), '[]')
              from moderation_results m where m.design_id = d.id) as history,
           (select coalesce(jsonb_agg(jsonb_build_object('path', a.path, 'kind', a.kind, 'name', a.original_name)), '[]')
              from design_assets a where a.id::text in (select l->>'asset_id' from jsonb_array_elements(d.config->'layers') l)) as assets,
           (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status)), '[]')
              from orders o where exists (select 1 from order_items oi where oi.order_id = o.id and oi.custom_design_id = d.id)) as orders
    from custom_designs d left join products pr on pr.id = d.product_id
    where case p_status when 'review' then d.status in ('pending', 'needs_review')
                        when 'approved' then d.status = 'approved'
                        when 'rejected' then d.status = 'rejected'
                        else true end
    order by d.submitted_at desc nulls last
    limit greatest(1, least(p_limit, 200))) t);
end $$;
revoke execute on function public.admin_moderation_queue(text, int) from public, anon;
grant execute on function public.admin_moderation_queue(text, int) to authenticated;

-- decision: approve | reject | request_changes | escalate
create or replace function public.admin_moderate(p_design_id uuid, p_decision text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d custom_designs%rowtype; o record; v_ready boolean; v_status text; v_mod text; v_moved int := 0;
begin
  perform require_permission('moderation.review');
  if p_decision not in ('approve', 'reject', 'request_changes', 'escalate') then raise exception 'Unknown decision.'; end if;
  if p_decision <> 'approve' and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Add a note explaining the decision.' using errcode = 'check_violation';
  end if;
  select * into d from custom_designs where id = p_design_id for update;
  if not found then raise exception 'Design not found.'; end if;

  v_status := case p_decision when 'approve' then 'approved' when 'escalate' then 'needs_review' else 'rejected' end;
  v_mod := case p_decision when 'approve' then 'approved' when 'escalate' then 'needs_review' else 'rejected' end;
  update custom_designs set status = v_status, decided_at = now(),
         approved_version = case when p_decision = 'approve' then version else approved_version end,
         decision_note = case p_decision
           when 'approve' then nullif(btrim(p_note), '')
           when 'request_changes' then 'Changes requested: ' || btrim(p_note)
           when 'reject' then btrim(p_note)
           else decision_note end
   where id = d.id;
  insert into moderation_results (design_id, design_version, provider, risk_score, decision, findings)
  values (d.id, d.version, 'human', case p_decision when 'approve' then 0 when 'escalate' then 50 else 90 end, v_mod,
          jsonb_build_array(jsonb_build_object('kind', p_decision, 'message', coalesce(nullif(btrim(p_note), ''), 'Approved by reviewer'),
                                               'reviewer', (select email from profiles where id = auth.uid()))));
  insert into audit_log (actor_id, actor_role, action, entity_type, entity_id, before, after)
  values (auth.uid(), 'staff', 'moderation_' || p_decision, 'custom_design', d.id::text,
          jsonb_build_object('status', d.status), jsonb_build_object('status', v_status, 'note', p_note, 'version', d.version));

  -- orders waiting on this design
  for o in select distinct ord.id from orders ord join order_items oi on oi.order_id = ord.id
           where oi.custom_design_id = d.id and ord.status = 'moderation_pending' loop
    if p_decision = 'approve' then
      select not exists (select 1 from order_items oi join custom_designs cd on cd.id = oi.custom_design_id
                         where oi.order_id = o.id and oi.item_type = 'custom' and cd.approved_version is distinct from oi.design_version)
        into v_ready;
      if v_ready then
        perform set_config('app.actor_type', 'staff', true);
        perform set_config('app.status_note', 'Design approved by a reviewer.', true);
        update orders set status = 'approved' where id = o.id;
        perform set_config('app.status_note', '', true);
        perform set_config('app.actor_type', 'system', true);
        update orders set status = 'fulfillment_pending' where id = o.id;
        v_moved := v_moved + 1;
      end if;
    elsif p_decision in ('reject', 'request_changes') then
      perform set_config('app.actor_type', 'staff', true);
      perform set_config('app.status_note', 'Design not approved (' || btrim(p_note) || '). Contact the customer: new artwork or refund.', true);
      update orders set status = 'on_hold' where id = o.id;
      perform set_config('app.status_note', '', true);
      v_moved := v_moved + 1;
    end if;
  end loop;
  insert into analytics_events (event_type, user_id, entity_type, entity_id, properties)
  values (case when p_decision = 'approve' then 'design_approved' when p_decision = 'escalate' then 'design_escalated' else 'design_rejected' end,
          d.user_id, 'design', d.id::text, jsonb_build_object('by', 'human'));
  return jsonb_build_object('status', v_status, 'orders_updated', v_moved);
end $$;
revoke execute on function public.admin_moderate(uuid, text, text) from public, anon;
grant execute on function public.admin_moderate(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Catalog helpers
-- ---------------------------------------------------------------------
create or replace function public.admin_products(p_q text default null, p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  if not is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(t order by t.updated_at desc), '[]') from (
    select p.id, p.slug, p.name, p.product_type, p.status, p.base_price_cents, p.sale_price_cents, p.is_limited, p.is_customizable,
           p.is_featured, p.updated_at, p.publish_at, c.name category, col.name collection,
           (select count(*) from product_variants v where v.product_id = p.id) variants,
           (select coalesce(sum(v.inventory_on_hand - v.inventory_reserved), 0) from product_variants v where v.product_id = p.id and v.is_active) available,
           (select count(*) from product_variants v where v.product_id = p.id and v.is_active and v.inventory_on_hand - v.inventory_reserved <= v.low_stock_threshold) low,
           (select jsonb_build_object('drop_name', d.drop_name, 'drop_number', d.drop_number, 'edition_size', d.edition_size, 'units_sold', d.units_sold)
              from limited_drops d where d.product_id = p.id) drop_info
    from products p left join categories c on c.id = p.category_id left join collections col on col.id = p.collection_id
    where (p_status is null or p.status::text = p_status)
      and (v_q is null or p.name ilike '%' || v_q || '%' or p.slug ilike '%' || v_q || '%' or p.sku ilike '%' || v_q || '%'
           or exists (select 1 from product_variants v where v.product_id = p.id and v.sku ilike '%' || v_q || '%'))) t);
end $$;
revoke execute on function public.admin_products(text, text) from public, anon;
grant execute on function public.admin_products(text, text) to authenticated;

create or replace function public.admin_duplicate_product(p_product_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare p products%rowtype; v_new uuid; v_slug text; n int := 1;
begin
  perform require_permission('products.write');
  select * into p from products where id = p_product_id;
  if not found then raise exception 'Product not found.'; end if;
  loop
    v_slug := left(p.slug, 70) || '-copy' || case when n > 1 then '-' || n else '' end;
    exit when not exists (select 1 from products where slug = v_slug);
    n := n + 1;
  end loop;
  insert into products (slug, name, description, category_id, collection_id, designer_id, product_type, tags, base_price_cents,
                        sale_price_cents, compare_note, currency, sku, materials, weight_grams, dimensions, print_locations, print_methods,
                        production_requirements, sketch_callouts, status, is_customizable, is_featured, seo, cost_cents)
  values (v_slug, p.name || ' (copy)', p.description, p.category_id, p.collection_id, p.designer_id, p.product_type, p.tags, p.base_price_cents,
          p.sale_price_cents, p.compare_note, p.currency, case when p.sku is null then null else p.sku || '-COPY' || n end, p.materials, p.weight_grams,
          p.dimensions, p.print_locations, p.print_methods, p.production_requirements, p.sketch_callouts, 'draft', p.is_customizable, false, p.seo, p.cost_cents)
  returning id into v_new;
  insert into product_variants (product_id, sku, size, color, color_hex, price_cents, sale_price_cents, inventory_on_hand, low_stock_threshold,
                                production_requirements, is_active, sort_order, cost_cents)
  select v_new, case when sku is null then null else sku || '-COPY' || n end, size, color, color_hex, price_cents, sale_price_cents, 0, low_stock_threshold,
         production_requirements, is_active, sort_order, cost_cents
  from product_variants where product_id = p.id;
  return v_new;
end $$;
revoke execute on function public.admin_duplicate_product(uuid) from public, anon;
grant execute on function public.admin_duplicate_product(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Customers (basic list; full CRM is Phase 8) and staff
-- ---------------------------------------------------------------------
create or replace function public.admin_customers(p_q text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  perform require_permission('customers.read');
  return (select coalesce(jsonb_agg(t order by t.spent_cents desc, t.created_at desc), '[]') from (
    select pr.id, pr.email, pr.full_name, pr.phone, pr.marketing_opt_in, pr.created_at,
           (select count(*) from orders o where o.user_id = pr.id and o.paid_at is not null) orders,
           (select coalesce(sum(total_cents), 0) from orders o where o.user_id = pr.id and o.paid_at is not null) spent_cents,
           (select max(paid_at) from orders o where o.user_id = pr.id) last_order_at,
           (select count(*) from custom_designs d where d.user_id = pr.id) designs,
           (select coalesce(jsonb_agg(role), '[]') from user_roles r where r.user_id = pr.id) roles
    from profiles pr
    where v_q is null or pr.email ilike '%' || v_q || '%' or pr.full_name ilike '%' || v_q || '%'
    limit greatest(1, least(p_limit, 500))) t);
end $$;
revoke execute on function public.admin_customers(text, int) from public, anon;
grant execute on function public.admin_customers(text, int) to authenticated;

create or replace function public.admin_staff()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('users.manage');
  return jsonb_build_object(
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'user_id', r.user_id, 'role', r.role, 'email', p.email, 'name', p.full_name,
               'granted_at', r.created_at) order by p.email, r.role), '[]') from user_roles r join profiles p on p.id = r.user_id),
    'roles', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'app_role'),
    'permissions', (select coalesce(jsonb_object_agg(role, perms), '{}') from (select role, jsonb_agg(permission order by permission) perms from role_permissions group by role) x));
end $$;
revoke execute on function public.admin_staff() from public, anon;
grant execute on function public.admin_staff() to authenticated;

create or replace function public.admin_grant_role(p_email text, p_role app_role)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform require_permission('users.manage');
  if p_role = 'super_admin' and not has_role('super_admin') then raise exception 'Only a super admin can add super admins.' using errcode = '42501'; end if;
  if p_role = 'partner_admin' then raise exception 'Partner logins are set up with the partner (Phase 7).' using errcode = 'check_violation'; end if;
  select id into v_user from profiles where lower(email) = lower(btrim(p_email));
  if v_user is null then raise exception 'No account with that email. Ask them to create an account first.' using errcode = 'check_violation'; end if;
  insert into user_roles (user_id, role, granted_by) select v_user, p_role, auth.uid()
  where not exists (select 1 from user_roles where user_id = v_user and role = p_role and partner_id is null);
end $$;
revoke execute on function public.admin_grant_role(text, app_role) from public, anon;
grant execute on function public.admin_grant_role(text, app_role) to authenticated;

-- Audit trail viewer
create or replace function public.admin_audit(p_entity_type text default null, p_entity_id text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('audit.read');
  return (select coalesce(jsonb_agg(t order by t.created_at desc), '[]') from (
    select a.id, a.action, a.entity_type, a.entity_id, a.before, a.after, a.created_at, a.actor_role,
           (select email from profiles where id = a.actor_id) actor
    from audit_log a
    where (p_entity_type is null or a.entity_type = p_entity_type) and (p_entity_id is null or a.entity_id = p_entity_id)
    order by a.created_at desc limit greatest(1, least(p_limit, 500))) t);
end $$;
revoke execute on function public.admin_audit(text, text, int) from public, anon;
grant execute on function public.admin_audit(text, text, int) to authenticated;

-- Signed-out visitors can't call the bag functions at all.
revoke execute on function public.cart_get(text) from anon, public;
revoke execute on function public.cart_set_item(text, uuid, integer, text) from anon, public;
revoke execute on function public.cart_set_line(text, uuid, integer) from anon, public;
revoke execute on function public.cart_quote(text, text, text, text, text) from anon, public;
grant execute on function public.cart_get(text) to authenticated;
grant execute on function public.cart_set_item(text, uuid, integer, text) to authenticated;
grant execute on function public.cart_set_line(text, uuid, integer) to authenticated;
grant execute on function public.cart_quote(text, text, text, text, text) to authenticated;
