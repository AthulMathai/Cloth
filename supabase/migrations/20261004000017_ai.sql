-- =====================================================================
-- 0017 AI: generation log + quotas, product embeddings (pgvector) for
-- meaning-based search, recommendations, stock & drop forecasting.
--   * Providers are swappable (Netlify env AI_PROVIDER); the database only
--     records what was asked, what came back and who asked.
--   * Recommendations and forecasts are computed from the store's own
--     orders, views, wishlists and stock — no outside service.
-- =====================================================================

create extension if not exists vector with schema extensions;

insert into public.store_settings (key, value, is_public) values
  ('ai.enabled', 'true', false),
  ('ai.daily_user_limit', '15', false),       -- generations per customer per day
  ('ai.daily_global_limit', '300', false),    -- all customers per day (protects the free allowance)
  ('ai.vision_moderation', 'true', false)     -- describe uploaded images for the moderation queue
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Generation log (every request, including refused ones)
-- ---------------------------------------------------------------------
create table if not exists public.ai_generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  prompt        text not null check (char_length(prompt) between 1 and 600),
  style         text,
  provider      text not null,
  model         text,
  status        text not null check (status in ('pending', 'succeeded', 'blocked', 'failed')),
  reason        text,
  asset_id      uuid references public.design_assets(id),
  used_asset_id uuid references public.design_assets(id),   -- the copy placed in the designer (may have its background removed)
  width_px      int,
  height_px     int,
  duration_ms   int,
  created_at    timestamptz not null default now()
);
create index if not exists ai_generations_user on public.ai_generations (user_id, created_at desc);
create index if not exists ai_generations_time on public.ai_generations (created_at desc);
alter table public.ai_generations enable row level security;
create policy "own generations" on public.ai_generations for select
  using (user_id = auth.uid() or public.has_permission('moderation.review') or public.has_permission('analytics.read'));

-- Called by the server before generating: may this user generate now?
create or replace function public.ai_quota(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled', setting_bool('ai.enabled', true),
    'user_used', (select count(*) from ai_generations where user_id = p_user and status in ('pending', 'succeeded')
                    and created_at > date_trunc('day', now() at time zone store_tz()) at time zone store_tz()),
    'user_limit', setting_int('ai.daily_user_limit', 15),
    'global_used', (select count(*) from ai_generations where status in ('pending', 'succeeded')
                      and created_at > date_trunc('day', now() at time zone store_tz()) at time zone store_tz()),
    'global_limit', setting_int('ai.daily_global_limit', 300));
$$;
revoke execute on function public.ai_quota(uuid) from public, anon, authenticated;
grant execute on function public.ai_quota(uuid) to service_role;

-- Customers see their own remaining generations in the designer.
create or replace function public.ai_my_quota()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('enabled', false); end if;
  q := ai_quota(auth.uid());
  return jsonb_build_object('enabled', (q->>'enabled')::boolean and (q->>'global_used')::int < (q->>'global_limit')::int,
    'left', greatest(0, (q->>'user_limit')::int - (q->>'user_used')::int), 'limit', (q->>'user_limit')::int);
end $$;
revoke execute on function public.ai_my_quota() from public, anon;
grant execute on function public.ai_my_quota() to authenticated;

create or replace function public.admin_ai_overview(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('moderation.review') or has_permission('analytics.read')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'settings', jsonb_build_object('enabled', setting_bool('ai.enabled', true), 'daily_user_limit', setting_int('ai.daily_user_limit', 15),
                                   'daily_global_limit', setting_int('ai.daily_global_limit', 300), 'vision_moderation', setting_bool('ai.vision_moderation', true)),
    'today', (select jsonb_build_object('succeeded', count(*) filter (where status = 'succeeded'), 'blocked', count(*) filter (where status = 'blocked'),
                'failed', count(*) filter (where status = 'failed'))
              from ai_generations where created_at > date_trunc('day', now() at time zone store_tz()) at time zone store_tz()),
    'last_30', (select jsonb_build_object('succeeded', count(*) filter (where status = 'succeeded'), 'blocked', count(*) filter (where status = 'blocked'),
                'failed', count(*) filter (where status = 'failed'), 'people', count(distinct user_id),
                'ordered', (select count(*) from order_items oi join orders o on o.id = oi.order_id
                             join design_versions dv on dv.design_id = oi.custom_design_id and dv.version = oi.design_version
                            where o.paid_at > now() - interval '30 days'
                              and exists (select 1 from jsonb_array_elements(coalesce(dv.config->'layers', '[]')) l
                                           join ai_generations g on l->>'asset_id' in (g.asset_id::text, g.used_asset_id::text))))
              from ai_generations where created_at > now() - interval '30 days'),
    'embeddings', (select jsonb_build_object('products', (select count(*) from products where status <> 'draft'),
                     'indexed', (select count(*) from product_embeddings), 'updated_at', (select max(updated_at) from product_embeddings))),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'prompt', g.prompt, 'style', g.style, 'status', g.status, 'reason', g.reason,
                  'provider', g.provider, 'model', g.model, 'duration_ms', g.duration_ms, 'created_at', g.created_at,
                  'email', (select email from profiles where id = g.user_id), 'user_id', g.user_id,
                  'path', (select path from design_assets where id = g.asset_id)) order by g.created_at desc), '[]')
               from (select * from ai_generations order by created_at desc limit least(coalesce(p_limit, 100), 300)) g));
end $$;
revoke execute on function public.admin_ai_overview(int) from public, anon;
grant execute on function public.admin_ai_overview(int) to authenticated;

-- ---------------------------------------------------------------------
-- Product embeddings for meaning-based search
-- ---------------------------------------------------------------------
create table if not exists public.product_embeddings (
  product_id    uuid primary key references public.products(id),
  embedding     extensions.vector(384) not null,
  content_hash  text not null,
  model         text not null,
  updated_at    timestamptz not null default now()
);
alter table public.product_embeddings enable row level security;
create policy "embeddings read" on public.product_embeddings for select using (true);

-- The text a product is understood by (name, category, collection, tags, story).
create or replace function public.product_embed_text(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select left(concat_ws('. ', p.name, p.product_type, c.name, co.name, de.name, array_to_string(p.tags, ', '), p.materials,
                         d.drop_name, d.story, p.description), 2000)
    from products p left join categories c on c.id = p.category_id left join collections co on co.id = p.collection_id
    left join designers de on de.id = p.designer_id left join limited_drops d on d.product_id = p.id
   where p.id = p_id;
$$;

create or replace function public.ai_products_to_embed(p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', t, 'hash', h)), '[]') from (
    select p.id, product_embed_text(p.id) t, md5(product_embed_text(p.id)) h
      from products p left join product_embeddings e on e.product_id = p.id
     where p.status <> 'draft' and (e.product_id is null or e.content_hash <> md5(product_embed_text(p.id)))
     limit least(coalesce(p_limit, 50), 200)) x;
$$;
revoke execute on function public.ai_products_to_embed(int) from public, anon, authenticated;
grant execute on function public.ai_products_to_embed(int) to service_role;

create or replace function public.ai_save_embeddings(p_rows jsonb, p_model text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; n int := 0;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into product_embeddings (product_id, embedding, content_hash, model, updated_at)
    values ((r->>'id')::uuid, (r->>'embedding')::extensions.vector, r->>'hash', p_model, now())
    on conflict (product_id) do update set embedding = excluded.embedding, content_hash = excluded.content_hash, model = excluded.model, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.ai_save_embeddings(jsonb, text) from public, anon, authenticated;
grant execute on function public.ai_save_embeddings(jsonb, text) to service_role;

-- Hybrid search: meaning (cosine similarity) + keywords. Shoppers only
-- ever get storefront rows (archived drops included; they link to the archive).
create or replace function public.search_products_smart(p_q text, p_embedding text default null, p_limit int default 40)
returns setof public.storefront_products
language sql stable security definer set search_path = public, extensions as $$
  with kw as (
    select p.id, ts_rank(p.search_doc, websearch_to_tsquery('simple', p_q)) + case when p.name ilike '%' || p_q || '%' then 2 else 0.4 end r
      from products p
     where p.status <> 'draft' and (p.search_doc @@ websearch_to_tsquery('simple', p_q) or p.name ilike '%' || p_q || '%' or p.sku ilike p_q || '%')),
  sem as (
    select e.product_id id, 1 - (e.embedding <=> p_embedding::extensions.vector) sim
      from product_embeddings e where p_embedding is not null
     order by e.embedding <=> p_embedding::extensions.vector limit 60),
  scored as (
    select coalesce(k.id, s.id) id, coalesce(k.r, 0) * 1.0 + greatest(coalesce(s.sim, 0) - 0.55, 0) * 6 score
      from kw k full join sem s on s.id = k.id)
  select sp.* from scored x join storefront_products sp on sp.id = x.id
   where x.score > 0 and sp.status <> 'draft'
   order by x.score desc, sp.is_purchasable desc, sp.name
   limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;
grant execute on function public.search_products_smart(text, text, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Recommendations
-- ---------------------------------------------------------------------
-- "You might also like" for a product: bought together, viewed together
-- in the same visit, same collection/category, then overall popularity.
create or replace function public.recommend_for_product(p_product_id uuid, p_limit int default 8)
returns setof public.storefront_products
language sql stable security definer set search_path = public as $$
  with me as (select id, category_id, collection_id, designer_id, product_type from products where id = p_product_id),
  bought as (
    select oi2.product_id id, count(*) * 5.0 s
      from order_items oi join orders o on o.id = oi.order_id and o.paid_at is not null
      join order_items oi2 on oi2.order_id = oi.order_id and oi2.product_id is not null and oi2.product_id <> p_product_id
     where oi.product_id = p_product_id group by 1),
  viewed as (
    select e2.entity_id::uuid id, count(distinct e2.session_id) * 1.0 s
      from analytics_events e join analytics_events e2 on e2.session_id = e.session_id
     where e.event_type in ('product_view', 'limited_drop_viewed') and e.entity_id = p_product_id::text
       and e2.event_type in ('product_view', 'limited_drop_viewed') and e2.entity_type = 'product' and e2.entity_id <> p_product_id::text
       and e2.entity_id ~ '^[0-9a-f-]{36}$' and e.session_id is not null and e.created_at > now() - interval '120 days'
     group by 1),
  pop as (
    select oi.product_id id, ln(1 + sum(oi.quantity)) s from order_items oi join orders o on o.id = oi.order_id
     where o.paid_at > now() - interval '60 days' and oi.product_id is not null group by 1),
  cand as (
    select sp.id,
           coalesce(b.s, 0) + coalesce(v.s, 0) + coalesce(pp.s, 0) * 0.5
           + case when sp.collection_id is not null and sp.collection_id = me.collection_id then 3 else 0 end
           + case when sp.category_id = me.category_id then 2 else 0 end
           + case when sp.designer_id is not null and sp.designer_id = me.designer_id then 1 else 0 end
           + case when sp.product_type = me.product_type then 0.3 else 0 end score
      from storefront_products sp cross join me
      left join bought b on b.id = sp.id left join viewed v on v.id = sp.id left join pop pp on pp.id = sp.id
     where sp.id <> me.id and sp.is_purchasable and (sp.drop_id is not null or sp.stock_available > 0))
  select sp.* from cand c join storefront_products sp on sp.id = c.id
   order by c.score desc, sp.is_featured desc, sp.created_at desc
   limit least(greatest(coalesce(p_limit, 8), 1), 24);
$$;
grant execute on function public.recommend_for_product(uuid, int) to anon, authenticated;

-- "Picked for you" for the signed-in shopper (falls back to best sellers).
create or replace function public.recommend_for_me(p_limit int default 8)
returns setof public.storefront_products
language sql stable security definer set search_path = public as $$
  with mine as (
    select p.category_id, p.collection_id, w from (
      select product_id, 4.0 w from order_items oi join orders o on o.id = oi.order_id where o.user_id = auth.uid() and o.paid_at is not null
      union all select product_id, 3.0 from wishlist_items where user_id = auth.uid() and product_id is not null
      union all select entity_id::uuid, 1.0 from analytics_events
       where user_id = auth.uid() and event_type in ('product_view', 'limited_drop_viewed') and entity_id ~ '^[0-9a-f-]{36}$'
         and created_at > now() - interval '90 days') x join products p on p.id = x.product_id),
  aff as (
    select sp.id, coalesce((select sum(w) from mine where mine.category_id = sp.category_id), 0)
                + coalesce((select sum(w) from mine where mine.collection_id = sp.collection_id), 0) * 1.5 s
      from storefront_products sp),
  owned as (select product_id from order_items oi join orders o on o.id = oi.order_id where o.user_id = auth.uid() and o.paid_at is not null),
  pop as (
    select oi.product_id id, sum(oi.quantity) n from order_items oi join orders o on o.id = oi.order_id
     where o.paid_at > now() - interval '60 days' group by 1)
  select sp.* from storefront_products sp join aff a on a.id = sp.id left join pop on pop.id = sp.id
   where sp.is_purchasable and (sp.drop_id is not null or sp.stock_available > 0)
     and sp.id not in (select product_id from owned where product_id is not null)
   order by a.s desc, coalesce(pop.n, 0) desc, sp.is_featured desc, sp.created_at desc
   limit least(greatest(coalesce(p_limit, 8), 1), 24);
$$;
grant execute on function public.recommend_for_me(int) to anon, authenticated;

-- "Goes well with" for the bag: products bought with what's in it.
create or replace function public.recommend_for_bag(p_product_ids uuid[], p_limit int default 6)
returns setof public.storefront_products
language sql stable security definer set search_path = public as $$
  with bought as (
    select oi2.product_id id, count(*) s
      from order_items oi join orders o on o.id = oi.order_id and o.paid_at is not null
      join order_items oi2 on oi2.order_id = oi.order_id and oi2.product_id is not null
     where oi.product_id = any(p_product_ids) and not oi2.product_id = any(p_product_ids) group by 1),
  near as (
    select sp.id, case when sp.collection_id in (select collection_id from products where id = any(p_product_ids)) then 2 else 0 end
                + case when sp.category_id in (select category_id from products where id = any(p_product_ids)) then 1 else 0 end s
      from storefront_products sp)
  select sp.* from storefront_products sp join near n on n.id = sp.id left join bought b on b.id = sp.id
   where not sp.id = any(p_product_ids) and sp.is_purchasable and (sp.drop_id is not null or sp.stock_available > 0)
     and (b.s is not null or n.s > 0)
   order by coalesce(b.s, 0) * 5 + n.s desc, sp.is_featured desc
   limit least(greatest(coalesce(p_limit, 6), 1), 12);
$$;
grant execute on function public.recommend_for_bag(uuid[], int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Forecasting (simple, explainable: recent sales pace vs stock)
-- ---------------------------------------------------------------------
create or replace function public.analytics_forecast(p_days int default 28)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_days int := greatest(7, least(coalesce(p_days, 28), 180));
begin
  perform require_permission('analytics.read');
  return jsonb_build_object(
    'window_days', v_days,
    'variants', (select coalesce(jsonb_agg(x order by (x->>'days_left')::numeric nulls last), '[]') from (
        select jsonb_build_object('product', p.name, 'slug', p.slug, 'sku', v.sku, 'color', v.color, 'size', v.size,
                 'available', v.inventory_on_hand - v.inventory_reserved, 'sold', s.n,
                 'per_day', round(s.n::numeric / v_days, 2),
                 'days_left', case when s.n > 0 then round((v.inventory_on_hand - v.inventory_reserved) / (s.n::numeric / v_days), 1) end,
                 'reorder', greatest(0, ceil(s.n::numeric / v_days * 30) - (v.inventory_on_hand - v.inventory_reserved))) x
          from product_variants v join products p on p.id = v.product_id
          join (select oi.variant_id, sum(oi.quantity) n from order_items oi join orders o on o.id = oi.order_id
                 where o.paid_at > now() - make_interval(days => v_days) and oi.variant_id is not null group by 1) s on s.variant_id = v.id
         where v.is_active and p.status in ('active', 'out_of_stock') and not p.is_limited
         order by case when s.n > 0 then (v.inventory_on_hand - v.inventory_reserved) / (s.n::numeric / v_days) end nulls last
         limit 60) t),
    'blanks', (select coalesce(jsonb_agg(x order by (x->>'days_left')::numeric nulls last), '[]') from (
        select jsonb_build_object('partner', pa.name, 'is_test', pa.is_test, 'product_type', i.product_type, 'color', i.color, 'size', i.size,
                 'free', i.on_hand - i.reserved, 'used', u.n, 'per_day', round(u.n::numeric / v_days, 2),
                 'days_left', case when u.n > 0 then round((i.on_hand - i.reserved) / (u.n::numeric / v_days), 1) end) x
          from partner_inventory i join partners pa on pa.id = i.partner_id
          join (select partner_id, b->>'product_type' t, lower(b->>'color') c, b->>'size' s, sum((b->>'quantity')::int) n
                  from production_orders po, jsonb_array_elements(po.spec->'blanks') b
                 where po.assigned_at > now() - make_interval(days => v_days) and po.status not in ('rejected', 'cancelled')
                 group by 1, 2, 3, 4) u on u.partner_id = i.partner_id and u.t = i.product_type and u.c = lower(i.color) and u.s = i.size
         where pa.status = 'active'
         order by case when u.n > 0 then (i.on_hand - i.reserved) / (u.n::numeric / v_days) end nulls last limit 40) t),
    'drops', (select coalesce(jsonb_agg(jsonb_build_object('drop_name', d.drop_name, 'drop_number', d.drop_number, 'edition_size', d.edition_size,
                 'units_sold', d.units_sold, 'left', d.edition_size - d.units_sold - d.units_reserved,
                 'sold_24h', s.h24, 'sold_7d', s.d7, 'release_at', d.release_at,
                 'eta_hours', case when s.h24 > 0 then round((d.edition_size - d.units_sold - d.units_reserved) / (s.h24::numeric / 24), 1)
                                   when s.d7 > 0 then round((d.edition_size - d.units_sold - d.units_reserved) / (s.d7::numeric / 168), 1) end)
                 order by d.drop_number desc), '[]')
              from limited_drops d join products p on p.id = d.product_id
              cross join lateral (select coalesce(sum(oi.quantity) filter (where o.paid_at > now() - interval '24 hours'), 0) h24,
                                         coalesce(sum(oi.quantity) filter (where o.paid_at > now() - interval '7 days'), 0) d7
                                    from order_items oi join orders o on o.id = oi.order_id where oi.drop_id = d.id and o.paid_at is not null) s
             where p.status = 'active' and d.archived_at is null),
    'demand', (select coalesce(jsonb_agg(jsonb_build_object('week', w, 'units', n) order by w), '[]') from (
        select to_char(date_trunc('week', o.paid_at at time zone store_tz()), 'YYYY-MM-DD') w, sum(oi.quantity) n
          from order_items oi join orders o on o.id = oi.order_id where o.paid_at > now() - interval '12 weeks' group by 1) z));
end $$;
revoke execute on function public.analytics_forecast(int) from public, anon;
grant execute on function public.analytics_forecast(int) to authenticated;

-- Model-aware variant: products embedded by a different model are redone,
-- so switching AI_EMBED_MODEL / provider re-indexes the catalogue.
create or replace function public.ai_products_to_embed(p_limit int, p_model text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', t, 'hash', h)), '[]') from (
    select p.id, product_embed_text(p.id) t, md5(product_embed_text(p.id)) h
      from products p left join product_embeddings e on e.product_id = p.id
     where p.status <> 'draft'
       and (e.product_id is null or e.model is distinct from p_model or e.content_hash <> md5(product_embed_text(p.id)))
     limit least(coalesce(p_limit, 50), 200)) x;
$$;
revoke execute on function public.ai_products_to_embed(int, text) from public, anon, authenticated;
grant execute on function public.ai_products_to_embed(int, text) to service_role;

alter table public.ai_generations add column if not exists used_asset_id uuid references public.design_assets(id);

-- The designer links the processed copy it placed on the garment back to
-- the generation, so the admin can see which AI designs were ordered.
create or replace function public.ai_attach(p_generation uuid, p_asset uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from design_assets where id = p_asset and user_id = auth.uid()) then
    raise exception 'Not your artwork.' using errcode = '42501';
  end if;
  update ai_generations set used_asset_id = p_asset where id = p_generation and user_id = auth.uid() and status = 'succeeded';
end $$;
revoke execute on function public.ai_attach(uuid, uuid) from public, anon;
grant execute on function public.ai_attach(uuid, uuid) to authenticated;

-- Internal helper only (called by the security-definer indexer functions).
revoke execute on function public.product_embed_text(uuid) from public, anon, authenticated;
grant execute on function public.product_embed_text(uuid) to service_role;
