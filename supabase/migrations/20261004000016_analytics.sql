-- =====================================================================
-- 0016 ANALYTICS: reports for sales, website, products, fulfillment and
-- the custom designer, plus a daily event rollup.
--   * Every report is computed from the source tables (orders, payments,
--     order_items, production_orders, shipments, analytics_events); the
--     rollup only speeds up day-by-day event counts.
--   * Days are bucketed in the store's time zone (store setting
--     store.timezone, default America/Toronto).
--   * A visitor = the signed-in user when known (sessions that signed in
--     are attributed to that user), otherwise the browser session.
-- =====================================================================

insert into public.store_settings (key, value, is_public) values ('store.timezone', '"America/Toronto"', false)
on conflict (key) do nothing;

create or replace function public.store_tz()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from store_settings where key = 'store.timezone'), 'America/Toronto');
$$;

-- Daily rollup of events (event type × day): events + distinct visitors.
create table if not exists public.analytics_daily (
  day         date not null,
  event_type  text not null,
  events      int not null,
  visitors    int not null,
  updated_at  timestamptz not null default now(),
  primary key (day, event_type)
);
alter table public.analytics_daily enable row level security;
create policy "analytics daily read" on public.analytics_daily for select using (public.has_permission('analytics.read'));

create index if not exists analytics_events_time on public.analytics_events (created_at);
create index if not exists analytics_events_user on public.analytics_events (user_id, created_at) where user_id is not null;

-- Recompute the rollup for a range of local days (idempotent upsert).
create or replace function public.analytics_rollup(p_from date default null, p_to date default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_tz text := store_tz(); v_from date; v_to date; n int;
begin
  if not (is_service() or has_permission('analytics.read')) then raise exception 'Not allowed.' using errcode = '42501'; end if;
  v_to := coalesce(p_to, (now() at time zone v_tz)::date);
  v_from := coalesce(p_from, v_to - 1);
  with ev as (
    select (e.created_at at time zone v_tz)::date d, e.event_type,
           coalesce(e.user_id::text, su.uid, e.session_id, 'anon') visitor
      from analytics_events e
      left join lateral (select max(x.user_id::text) uid from analytics_events x
                          where e.session_id is not null and x.session_id = e.session_id and x.user_id is not null) su on true
     where e.created_at >= (v_from::timestamp at time zone v_tz) and e.created_at < ((v_to + 1)::timestamp at time zone v_tz))
  insert into analytics_daily (day, event_type, events, visitors, updated_at)
  select d, event_type, count(*), count(distinct visitor), now() from ev group by 1, 2
  on conflict (day, event_type) do update set events = excluded.events, visitors = excluded.visitors, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.analytics_rollup(date, date) from public, anon;
grant execute on function public.analytics_rollup(date, date) to authenticated, service_role;

-- Range helpers: [from, to] local days -> timestamptz bounds; previous period.
create or replace function public.an_bounds(p_from date, p_to date, out t0 timestamptz, out t1 timestamptz, out p0 timestamptz, out p1 timestamptz)
language sql stable security definer set search_path = public as $$
  select (p_from::timestamp at time zone store_tz()), ((p_to + 1)::timestamp at time zone store_tz()),
         ((p_from - (p_to - p_from + 1))::timestamp at time zone store_tz()), (p_from::timestamp at time zone store_tz());
$$;

create or replace function public.an_guard(p_from date, p_to date)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('analytics.read');
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a date range.' using errcode = 'check_violation'; end if;
  if p_to - p_from > 731 then raise exception 'Choose a range of two years or less.' using errcode = 'check_violation'; end if;
end $$;
revoke execute on function public.an_guard(date, date) from public, anon, authenticated;

-- Time buckets for a series.
create or replace function public.an_buckets(p_from date, p_to date, p_grain text)
returns table (k date, b0 timestamptz, b1 timestamptz) language sql stable security definer set search_path = public as $$
  select g::date,
         (g::timestamp at time zone store_tz()),
         ((case p_grain when 'week' then g + interval '1 week' when 'month' then g + interval '1 month' else g + interval '1 day' end)::timestamp at time zone store_tz())
    from generate_series(date_trunc(case when p_grain in ('week', 'month') then p_grain else 'day' end, p_from::timestamp),
                         p_to::timestamp,
                         case p_grain when 'week' then interval '1 week' when 'month' then interval '1 month' else interval '1 day' end) g;
$$;

-- ---------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------
create or replace function public.an_sales_totals(t0 timestamptz, t1 timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with paid as (select * from orders where paid_at >= t0 and paid_at < t1),
  items as (
    select oi.*, coalesce(oi.line_total_cents - oi.discount_cents, 0) net_line,
           case when oi.item_type = 'custom' then (oi.snapshot->'pricing'->'cost'->>'total_cents')::int
                else (select coalesce(v.cost_cents, p.cost_cents) from product_variants v join products p on p.id = v.product_id where v.id = oi.variant_id) * oi.quantity end cost
      from order_items oi join paid o on o.id = oi.order_id),
  refunds as (select coalesce(sum(amount_cents), 0) amt, count(*) n, count(distinct order_id) orders
                from payments where kind = 'refund' and created_at >= t0 and created_at < t1)
  select jsonb_build_object(
    'orders', (select count(*) from paid),
    'gross_cents', (select coalesce(sum(total_cents), 0) from paid),
    'refunded_cents', (select amt from refunds),
    'refunds', (select n from refunds),
    'net_cents', (select coalesce(sum(total_cents), 0) from paid) - (select amt from refunds),
    'aov_cents', (select coalesce(round(avg(total_cents)), 0)::int from paid),
    'units', (select coalesce(sum(quantity), 0) from items),
    'merch_cents', (select coalesce(sum(subtotal_cents), 0) from paid),
    'discount_cents', (select coalesce(sum(discount_cents), 0) from paid),
    'shipping_cents', (select coalesce(sum(shipping_cents), 0) from paid),
    'tax_cents', (select coalesce(sum(tax_cents), 0) from paid),
    'customers', (select count(distinct coalesce(user_id::text, lower(email))) from paid),
    'refund_rate', case when (select count(*) from paid) > 0
                        then round(100.0 * (select count(distinct order_id) from payments p join paid o on o.id = p.order_id where p.kind = 'refund') / (select count(*) from paid), 1) end,
    'cost_cents', (select coalesce(sum(cost), 0) from items where cost is not null),
    'costed_net_cents', (select coalesce(sum(net_line), 0) from items where cost is not null),
    'cost_coverage', case when (select coalesce(sum(net_line), 0) from items) > 0
                          then round(100.0 * (select coalesce(sum(net_line), 0) from items where cost is not null) / (select sum(net_line) from items)) end);
$$;
revoke execute on function public.an_sales_totals(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.analytics_sales(p_from date, p_to date, p_grain text default 'day')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record; v_tz text := store_tz();
begin
  perform an_guard(p_from, p_to);
  select * into b from an_bounds(p_from, p_to);
  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'grain', p_grain, 'tz', v_tz),
    'totals', an_sales_totals(b.t0, b.t1),
    'previous', an_sales_totals(b.p0, b.p1),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('k', k,
                  'gross_cents', (select coalesce(sum(total_cents), 0) from orders where paid_at >= b0 and paid_at < b1),
                  'refunded_cents', (select coalesce(sum(amount_cents), 0) from payments where kind = 'refund' and created_at >= b0 and created_at < b1),
                  'orders', (select count(*) from orders where paid_at >= b0 and paid_at < b1)) order by k), '[]')
               from an_buckets(p_from, p_to, p_grain)),
    'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', t, 'units', u, 'net_cents', n) order by n desc), '[]') from (
        select case when oi.drop_id is not null then 'limited' when oi.item_type = 'custom' then 'custom' else 'catalog' end t,
               sum(oi.quantity) u, sum(oi.line_total_cents - oi.discount_cents) n
          from order_items oi join orders o on o.id = oi.order_id where o.paid_at >= b.t0 and o.paid_at < b.t1 group by 1) x),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'units', u, 'net_cents', n) order by n desc), '[]') from (
        select coalesce(c.name, 'Uncategorised') name, sum(oi.quantity) u, sum(oi.line_total_cents - oi.discount_cents) n
          from order_items oi join orders o on o.id = oi.order_id left join products p on p.id = oi.product_id left join categories c on c.id = p.category_id
         where o.paid_at >= b.t0 and o.paid_at < b.t1 group by 1) x),
    'by_province', (select coalesce(jsonb_agg(jsonb_build_object('province', pr, 'orders', n, 'gross_cents', g) order by g desc), '[]') from (
        select upper(coalesce(shipping_address->>'province', '?')) pr, count(*) n, sum(total_cents) g
          from orders where paid_at >= b.t0 and paid_at < b.t1 group by 1) x),
    'discount_codes', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'orders', n, 'discount_cents', d, 'gross_cents', g) order by n desc), '[]') from (
        select discount_code code, count(*) n, sum(discount_cents) d, sum(total_cents) g
          from orders where paid_at >= b.t0 and paid_at < b.t1 and discount_code is not null group by 1) x),
    'new_vs_returning', (select jsonb_build_object(
        'new', count(*) filter (where first_paid >= b.t0), 'returning', count(*) filter (where first_paid < b.t0),
        'new_cents', coalesce(sum(g) filter (where first_paid >= b.t0), 0), 'returning_cents', coalesce(sum(g) filter (where first_paid < b.t0), 0))
        from (select coalesce(o.user_id::text, lower(o.email)) who, sum(o.total_cents) g
                from orders o where o.paid_at >= b.t0 and o.paid_at < b.t1 group by 1) c
        cross join lateral (select min(x.paid_at) first_paid from orders x
                             where coalesce(x.user_id::text, lower(x.email)) = c.who and x.paid_at is not null) f));
end $$;
revoke execute on function public.analytics_sales(date, date, text) from public, anon;
grant execute on function public.analytics_sales(date, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- Website (traffic, funnel, searches, pages)
-- ---------------------------------------------------------------------
create or replace function public.an_web_totals(t0 timestamptz, t1 timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with ev as (
    select e.*, coalesce(e.user_id::text, (select max(x.user_id::text) from analytics_events x where e.session_id is not null and x.session_id = e.session_id and x.user_id is not null),
                         e.session_id, 'anon') visitor
      from analytics_events e where e.created_at >= t0 and e.created_at < t1),
  st as (
    select count(distinct visitor) filter (where event_type = 'page_view') visited,
           count(distinct visitor) filter (where event_type in ('product_view', 'limited_drop_viewed')) viewed,
           count(distinct visitor) filter (where event_type = 'add_to_cart') carted,
           count(distinct visitor) filter (where event_type = 'checkout_started') checkout,
           count(distinct visitor) filter (where event_type = 'purchase') purchased
      from ev)
  select jsonb_build_object(
    'visitors', (select visited from st),
    'sessions', (select count(distinct session_id) from ev where event_type = 'page_view'),
    'page_views', (select count(*) from ev where event_type = 'page_view'),
    'product_views', (select count(*) from ev where event_type in ('product_view', 'limited_drop_viewed')),
    'collection_views', (select count(*) from ev where event_type = 'collection_view'),
    'searches', (select count(*) from ev where event_type = 'search'),
    'add_to_cart', (select count(*) from ev where event_type = 'add_to_cart'),
    'checkouts', (select count(*) from ev where event_type = 'checkout_started'),
    'purchases', (select count(*) from ev where event_type = 'purchase'),
    'signups', (select count(*) from profiles where created_at >= t0 and created_at < t1),
    'newsletter', (select count(*) from ev where event_type = 'newsletter_signup'),
    'funnel', (select jsonb_build_array(
        jsonb_build_object('step', 'Visited', 'visitors', visited), jsonb_build_object('step', 'Viewed a product', 'visitors', viewed),
        jsonb_build_object('step', 'Added to bag', 'visitors', carted), jsonb_build_object('step', 'Started checkout', 'visitors', checkout),
        jsonb_build_object('step', 'Purchased', 'visitors', purchased)) from st),
    'conversion', (select case when visited > 0 then round(100.0 * purchased / visited, 2) end from st),
    'abandoned_checkouts', (select count(*) from orders where created_at >= t0 and created_at < t1 and status in ('cancelled', 'failed') and paid_at is null));
$$;
revoke execute on function public.an_web_totals(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.analytics_website(p_from date, p_to date, p_grain text default 'day')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record;
begin
  perform an_guard(p_from, p_to);
  select * into b from an_bounds(p_from, p_to);
  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'grain', p_grain),
    'totals', an_web_totals(b.t0, b.t1),
    'previous', an_web_totals(b.p0, b.p1),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('k', k,
                  'visitors', (select count(distinct coalesce(user_id::text, session_id)) from analytics_events where event_type = 'page_view' and created_at >= b0 and created_at < b1),
                  'page_views', (select count(*) from analytics_events where event_type = 'page_view' and created_at >= b0 and created_at < b1),
                  'orders', (select count(*) from orders where paid_at >= b0 and paid_at < b1)) order by k), '[]')
               from an_buckets(p_from, p_to, p_grain)),
    'top_pages', (select coalesce(jsonb_agg(jsonb_build_object('path', path, 'views', n, 'visitors', v) order by n desc), '[]') from (
        select path, count(*) n, count(distinct coalesce(user_id::text, session_id)) v from analytics_events
         where event_type = 'page_view' and created_at >= b.t0 and created_at < b.t1 and path is not null group by 1 order by 2 desc limit 15) x),
    'searches', (select coalesce(jsonb_agg(jsonb_build_object('q', q, 'n', n, 'no_results', z) order by n desc), '[]') from (
        select lower(btrim(coalesce(properties->>'query', properties->>'q'))) q, count(*) n,
               count(*) filter (where properties->>'results' = '0') z from analytics_events
         where event_type = 'search' and created_at >= b.t0 and created_at < b.t1
           and coalesce(btrim(coalesce(properties->>'query', properties->>'q')), '') <> '' group by 1 order by 2 desc limit 15) x),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', s, 'visitors', n) order by n desc), '[]') from (
        select coalesce(nullif(properties->>'source', ''), 'direct') s, count(distinct session_id) n from analytics_events
         where event_type = 'page_view' and (properties->>'landing')::boolean and created_at >= b.t0 and created_at < b.t1 group by 1 order by 2 desc limit 12) x),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('device', d, 'visitors', n) order by n desc), '[]') from (
        select coalesce(properties->>'device', 'unknown') d, count(distinct session_id) n from analytics_events
         where event_type = 'page_view' and (properties->>'landing')::boolean and created_at >= b.t0 and created_at < b.t1 group by 1) x),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('event', event_type, 'n', n) order by n desc), '[]') from (
        select event_type, count(*) n from analytics_events where created_at >= b.t0 and created_at < b.t1 group by 1) x));
end $$;
revoke execute on function public.analytics_website(date, date, text) from public, anon;
grant execute on function public.analytics_website(date, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------
create or replace function public.analytics_products(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record;
begin
  perform an_guard(p_from, p_to);
  select * into b from an_bounds(p_from, p_to);
  return (with sold as (
            select oi.product_id, sum(oi.quantity) units, sum(oi.line_total_cents - oi.discount_cents) net
              from order_items oi join orders o on o.id = oi.order_id
             where o.paid_at >= b.t0 and o.paid_at < b.t1 and oi.product_id is not null group by 1),
          views as (
            select entity_id::uuid product_id, count(*) views, count(distinct coalesce(user_id::text, session_id)) viewers
              from analytics_events where event_type in ('product_view', 'limited_drop_viewed') and entity_type = 'product'
               and created_at >= b.t0 and created_at < b.t1 and entity_id ~ '^[0-9a-f-]{36}$' group by 1),
          carts as (
            select pv.product_id, count(*) n from analytics_events e join product_variants pv on pv.id::text = e.entity_id
             where e.event_type = 'add_to_cart' and e.entity_type = 'variant' and e.created_at >= b.t0 and e.created_at < b.t1 group by 1),
          wish as (select product_id, count(*) n from wishlist_items where product_id is not null and created_at >= b.t0 and created_at < b.t1 group by 1),
          perf as (
            select p.id, p.name, p.slug, p.status, p.product_type, p.is_limited, c.name category, p.created_at,
                   coalesce(s.units, 0) units, coalesce(s.net, 0) net, coalesce(v.views, 0) views, coalesce(v.viewers, 0) viewers,
                   coalesce(ca.n, 0) carts, coalesce(w.n, 0) wishlisted,
                   (select coalesce(sum(inventory_on_hand - inventory_reserved), 0) from product_variants pv where pv.product_id = p.id and pv.is_active) available
              from products p left join categories c on c.id = p.category_id
              left join sold s on s.product_id = p.id left join views v on v.product_id = p.id
              left join carts ca on ca.product_id = p.id left join wish w on w.product_id = p.id
             where p.status <> 'draft')
    select jsonb_build_object(
      'range', jsonb_build_object('from', p_from, 'to', p_to),
      'best_sellers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.net desc), '[]') from (select * from perf where units > 0 order by net desc limit 15) x),
      'low_performers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.views desc), '[]') from (
          select * from perf where status = 'active' and units = 0 and created_at < b.t1 - interval '7 days' order by views desc, created_at limit 15) x),
      'most_viewed', (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('conversion', case when x.viewers > 0 then round(100.0 * x.units / x.viewers, 1) end)
                        order by x.views desc), '[]') from (select * from perf where views > 0 order by views desc limit 15) x),
      'most_wishlisted', (select coalesce(jsonb_agg(to_jsonb(x) order by x.wishlisted desc), '[]') from (select * from perf where wishlisted > 0 order by wishlisted desc limit 10) x),
      'by_category', (select coalesce(jsonb_agg(jsonb_build_object('name', category, 'units', u, 'net_cents', n, 'views', v) order by n desc), '[]') from (
          select coalesce(category, 'Uncategorised') category, sum(units) u, sum(net) n, sum(views) v from perf group by 1) x),
      'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('product', p.name, 'slug', p.slug, 'sku', v.sku, 'color', v.color, 'size', v.size,
                        'available', v.inventory_on_hand - v.inventory_reserved, 'threshold', v.low_stock_threshold)
                        order by v.inventory_on_hand - v.inventory_reserved), '[]')
                    from product_variants v join products p on p.id = v.product_id
                   where v.is_active and p.status in ('active', 'out_of_stock') and not p.is_limited
                     and v.inventory_on_hand - v.inventory_reserved <= v.low_stock_threshold),
      'sold_out', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'slug', slug, 'status', status) order by name), '[]')
                   from products where status in ('out_of_stock', 'sold_out')),
      'drops', (select coalesce(jsonb_agg(jsonb_build_object('drop_name', d.drop_name, 'drop_number', d.drop_number, 'slug', d.slug, 'edition_size', d.edition_size,
                     'units_sold', d.units_sold, 'sell_through', round(100.0 * d.units_sold / nullif(d.edition_size, 0), 1),
                     'release_at', d.release_at, 'sold_out_at', d.sold_out_at, 'archived_at', d.archived_at,
                     'hours_to_sell_out', case when d.sold_out_at is not null and d.release_at is not null
                                               then round((extract(epoch from (d.sold_out_at - d.release_at)) / 3600)::numeric, 1) end,
                     'revenue_cents', (select coalesce(sum(oi.line_total_cents - oi.discount_cents), 0) from order_items oi join orders o on o.id = oi.order_id
                                        where oi.drop_id = d.id and o.paid_at is not null),
                     'status', p.status) order by d.drop_number desc), '[]')
                from limited_drops d join products p on p.id = d.product_id)));
end $$;
revoke execute on function public.analytics_products(date, date) from public, anon;
grant execute on function public.analytics_products(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- Fulfillment
-- ---------------------------------------------------------------------
create or replace function public.analytics_fulfillment(p_from date, p_to date, p_grain text default 'day')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record;
begin
  perform an_guard(p_from, p_to);
  select * into b from an_bounds(p_from, p_to);
  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'grain', p_grain),
    'totals', (select jsonb_build_object(
        'assigned', count(*), 'shipped', count(*) filter (where status = 'shipped'),
        'rejected', count(*) filter (where status = 'rejected'), 'cancelled', count(*) filter (where status = 'cancelled'),
        'reprints', coalesce(sum(reprint_count), 0),
        'late_open', count(*) filter (where status in ('assigned', 'accepted', 'in_production', 'printed', 'packed') and due_by < now()),
        'shipped_late', count(*) filter (where status = 'shipped' and shipped_at > due_by),
        'on_time_pct', case when count(*) filter (where status = 'shipped') > 0
                            then round(100.0 * count(*) filter (where status = 'shipped' and shipped_at <= due_by) / count(*) filter (where status = 'shipped')) end,
        'avg_accept_hours', round((avg(extract(epoch from (accepted_at - assigned_at))) / 3600)::numeric, 1),
        'avg_production_hours', round((avg(extract(epoch from (shipped_at - assigned_at))) filter (where status = 'shipped') / 3600)::numeric, 1))
      from production_orders where assigned_at >= b.t0 and assigned_at < b.t1),
    'delivery', (select jsonb_build_object(
        'shipments', count(*), 'delivered', count(*) filter (where status = 'delivered'),
        'exceptions', count(*) filter (where status = 'exception'), 'returned', count(*) filter (where status = 'returned'),
        'avg_transit_hours', round((avg(extract(epoch from (delivered_at - shipped_at))) filter (where delivered_at is not null) / 3600)::numeric, 1))
      from shipments where shipped_at >= b.t0 and shipped_at < b.t1),
    'order_to_door_hours', (select round((avg(extract(epoch from (s.delivered_at - o.paid_at))) / 3600)::numeric, 1)
                              from shipments s join orders o on o.id = s.order_id where s.delivered_at >= b.t0 and s.delivered_at < b.t1),
    'failed_orders', (select count(*) from orders where status in ('failed', 'on_hold', 'backordered') and updated_at >= b.t0 and updated_at < b.t1),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('k', k,
                  'assigned', (select count(*) from production_orders where assigned_at >= b0 and assigned_at < b1),
                  'shipped', (select count(*) from production_orders where shipped_at >= b0 and shipped_at < b1),
                  'delivered', (select count(*) from shipments where delivered_at >= b0 and delivered_at < b1)) order by k), '[]')
               from an_buckets(p_from, p_to, p_grain)),
    'partners', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'is_test', p.is_test, 'assigned', x.assigned, 'shipped', x.shipped,
                     'rejected', x.rejected, 'reprints', x.reprints, 'on_time_pct', x.on_time, 'avg_hours', x.avg_hours, 'units', x.units) order by x.assigned desc), '[]')
                 from (select partner_id, count(*) assigned, count(*) filter (where status = 'shipped') shipped,
                              count(*) filter (where status = 'rejected') rejected, coalesce(sum(reprint_count), 0) reprints, sum(units) units,
                              case when count(*) filter (where status = 'shipped') > 0
                                   then round(100.0 * count(*) filter (where status = 'shipped' and shipped_at <= due_by) / count(*) filter (where status = 'shipped')) end on_time,
                              round((avg(extract(epoch from (shipped_at - assigned_at))) filter (where status = 'shipped') / 3600)::numeric, 1) avg_hours
                         from production_orders where assigned_at >= b.t0 and assigned_at < b.t1 group by 1) x
                 join partners p on p.id = x.partner_id),
    'rejections', (select coalesce(jsonb_agg(jsonb_build_object('reason', rejection_reason, 'partner', (select name from partners where id = partner_id), 'at', closed_at)
                     order by closed_at desc), '[]')
                   from (select * from production_orders where status = 'rejected' and closed_at >= b.t0 and closed_at < b.t1 order by closed_at desc limit 20) r));
end $$;
revoke execute on function public.analytics_fulfillment(date, date, text) from public, anon;
grant execute on function public.analytics_fulfillment(date, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- Custom designer
-- ---------------------------------------------------------------------
create or replace function public.analytics_designs(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record;
begin
  perform an_guard(p_from, p_to);
  select * into b from an_bounds(p_from, p_to);
  return (with ev as (select * from analytics_events where created_at >= b.t0 and created_at < b.t1),
               ci as (select oi.*, o.paid_at from order_items oi join orders o on o.id = oi.order_id
                       where oi.item_type = 'custom' and o.paid_at >= b.t0 and o.paid_at < b.t1),
               mods as (select * from moderation_results where created_at >= b.t0 and created_at < b.t1)
    select jsonb_build_object(
      'range', jsonb_build_object('from', p_from, 'to', p_to),
      'funnel', jsonb_build_array(
         jsonb_build_object('step', 'Opened the designer', 'n', (select count(distinct coalesce(user_id::text, session_id)) from ev where event_type = 'custom_design_started')),
         jsonb_build_object('step', 'Uploaded artwork', 'n', (select count(distinct coalesce(user_id::text, session_id)) from ev where event_type = 'design_uploaded')),
         jsonb_build_object('step', 'Saved a design', 'n', (select count(distinct user_id) from custom_designs where created_at >= b.t0 and created_at < b.t1)),
         jsonb_build_object('step', 'Approved', 'n', (select count(distinct d.user_id) from custom_designs d where d.decided_at >= b.t0 and d.decided_at < b.t1 and d.status = 'approved')),
         jsonb_build_object('step', 'Ordered', 'n', (select count(distinct o.user_id) from ci join orders o on o.id = ci.order_id))),
      'totals', jsonb_build_object(
         'started', (select count(*) from ev where event_type = 'custom_design_started'),
         'uploads', (select count(*) from ev where event_type = 'design_uploaded'),
         'saved', (select count(*) from custom_designs where created_at >= b.t0 and created_at < b.t1),
         'versions', (select count(*) from design_versions where created_at >= b.t0 and created_at < b.t1),
         'submitted', (select count(*) from custom_designs where submitted_at >= b.t0 and submitted_at < b.t1),
         'approved', (select count(*) from mods where decision = 'approved'),
         'rejected', (select count(*) from mods where decision = 'rejected'),
         'needs_review', (select count(*) from mods where decision = 'needs_review'),
         'ai_designs', (select count(*) from ev where event_type = 'ai_design_generated'),
         'tryon_opened', (select count(*) from ev where event_type = 'tryon_opened'),
         'quotes', (select count(*) from quote_requests where created_at >= b.t0 and created_at < b.t1),
         'orders', (select count(distinct order_id) from ci),
         'units', (select coalesce(sum(quantity), 0) from ci),
         'net_cents', (select coalesce(sum(line_total_cents - discount_cents), 0) from ci),
         'avg_unit_cents', (select coalesce(round(avg(unit_price_cents)), 0)::int from ci),
         'margin_cents', (select coalesce(sum((snapshot->'pricing'->>'margin_cents')::int), 0) from ci)),
      'products', (select coalesce(jsonb_agg(jsonb_build_object('product_type', t, 'units', u, 'net_cents', n) order by u desc), '[]') from (
          select coalesce(product_type, '?') t, sum(quantity) u, sum(line_total_cents - discount_cents) n from ci group by 1) x),
      'placements', (select coalesce(jsonb_agg(jsonb_build_object('placement', l, 'n', n) order by n desc), '[]') from (
          select coalesce(p->>'placement_label', p->>'placement') l, sum(ci.quantity) n
            from ci, jsonb_array_elements(coalesce(ci.snapshot->'pricing'->'print', '[]')) p group by 1) x),
      'methods', (select coalesce(jsonb_agg(jsonb_build_object('method', l, 'n', n) order by n desc), '[]') from (
          select coalesce(p->>'method_label', p->>'method') l, sum(ci.quantity) n
            from ci, jsonb_array_elements(coalesce(ci.snapshot->'pricing'->'print', '[]')) p group by 1) x),
      'colors', (select coalesce(jsonb_agg(jsonb_build_object('color', c, 'n', n) order by n desc), '[]') from (
          select coalesce(color, '?') c, sum(quantity) n from ci group by 1 order by 2 desc limit 8) x),
      'moderation_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'n', n) order by n desc), '[]') from (
          select coalesce(f->>'category', f->>'code', f->>'message', f #>> '{}') r, count(*) n
            from mods, jsonb_array_elements(case when jsonb_typeof(mods.findings) = 'array' then mods.findings else '[]'::jsonb end) f
           where mods.decision <> 'approved' group by 1 order by 2 desc limit 10) x)));
end $$;
revoke execute on function public.analytics_designs(date, date) from public, anon;
grant execute on function public.analytics_designs(date, date) to authenticated;

revoke execute on function public.store_tz() from public, anon;
revoke execute on function public.an_bounds(date, date) from public, anon, authenticated;
revoke execute on function public.an_buckets(date, date, text) from public, anon, authenticated;
