-- =====================================================================
-- 0019 Promotions: automatic sales (flash, seasonal, collection, product)
-- with start/end dates — no code needed at checkout.
--   * applied inside variant_price(), the one pricing function used by the
--     bag, checkout and order creation, so the storefront, bag and order
--     can never disagree; the order line keeps the price actually paid
--   * the best single promotion wins (they don't stack with each other or
--     with a product's own sale price — the lowest price applies);
--     discount codes still apply on top at checkout
--   * limited drops are excluded unless a promotion opts them in
-- =====================================================================

create table if not exists public.promotions (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 2 and 80),
  label            text check (char_length(label) <= 24),        -- badge on cards, e.g. "Fall sale"
  kind             text not null check (kind in ('percent', 'fixed')),
  value            numeric(10,2) not null check (value > 0),      -- percent, or cents for fixed
  scope            text not null default 'all' check (scope in ('all', 'categories', 'collections', 'products')),
  scope_ids        uuid[] not null default '{}',
  include_limited  boolean not null default false,
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,
  show_banner      boolean not null default true,                 -- strip across the top of the store
  banner_text      text check (char_length(banner_text) <= 120),
  show_countdown   boolean not null default true,
  priority         int not null default 0,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint promo_percent check (kind <> 'percent' or value <= 90),
  constraint promo_dates check (ends_at is null or ends_at > starts_at),
  constraint promo_scope check (scope = 'all' or cardinality(scope_ids) > 0)
);
create index if not exists promotions_live on public.promotions (starts_at, ends_at) where is_active;
create or replace trigger promotions_touch before update on public.promotions for each row execute function public.touch_updated_at();
create or replace trigger audit_promotions after insert or update on public.promotions for each row execute function public.audit_row();
alter table public.promotions enable row level security;
-- Shoppers see promotions that are running (banner, badges, countdown); staff see all.
create policy "promotions public" on public.promotions for select
  using ((is_active and starts_at <= now() and (ends_at is null or ends_at > now())) or public.has_permission('marketing.write'));
create policy "promotions write" on public.promotions for all
  using (public.has_permission('marketing.write')) with check (public.has_permission('marketing.write'));

-- Price after a promotion (never below $0; rounds to the cent).
create or replace function public.promo_apply(p_price int, p_kind text, p_value numeric)
returns int language sql immutable as $$
  select case when p_price is null or p_kind is null then null
              when p_kind = 'percent' then greatest(0, round(p_price * (1 - p_value / 100.0))::int)
              else greatest(0, p_price - p_value::int) end;
$$;

-- The best running promotion for a product (largest saving on its base price).
create or replace function public.promo_for(p public.products)
returns public.promotions language sql stable security definer set search_path = public as $$
  select pr.* from promotions pr
   where pr.is_active and pr.starts_at <= now() and (pr.ends_at is null or pr.ends_at > now())
     and (pr.include_limited or not p.is_limited)
     and (pr.scope = 'all'
          or (pr.scope = 'categories' and p.category_id = any(pr.scope_ids))
          or (pr.scope = 'collections' and p.collection_id = any(pr.scope_ids))
          or (pr.scope = 'products' and p.id = any(pr.scope_ids)))
   order by p.base_price_cents - promo_apply(p.base_price_cents, pr.kind, pr.value) desc, pr.priority desc, pr.ends_at nulls last
   limit 1;
$$;

-- THE price of a variant (bag, checkout, order creation): its own price or
-- sale price, or the promotion price if that is lower.
create or replace function public.variant_price(v public.product_variants, p public.products)
returns int language sql stable security definer set search_path = public as $$
  select least(coalesce(v.sale_price_cents, v.price_cents, p.sale_price_cents, p.base_price_cents),
               coalesce((select promo_apply(coalesce(v.price_cents, p.base_price_cents), pr.kind, pr.value) from promo_for(p) pr where pr.id is not null),
                        2147483647));
$$;

-- Storefront rows show the promotion price and what it is.
create or replace view public.storefront_products with (security_invoker = true) as
 SELECT p.id, p.slug, p.name, p.description, p.product_type, p.tags, p.currency, p.base_price_cents, p.sale_price_cents,
    least(COALESCE(p.sale_price_cents, p.base_price_cents),
          coalesce(promo_apply(p.base_price_cents, pr.kind, pr.value), 2147483647)) AS price_cents,
    p.status, p.publish_at, p.is_limited, p.is_customizable, p.is_featured, p.materials, p.print_locations, p.print_methods,
    p.sketch_callouts, p.seo, p.created_at, p.category_id, c.slug AS category_slug, c.name AS category_name,
    p.collection_id, co.slug AS collection_slug, co.name AS collection_name, p.designer_id, de.slug AS designer_slug, de.name AS designer_name,
    d.id AS drop_id, d.slug AS drop_slug, d.drop_name, d.drop_number, d.edition_size, d.units_sold,
    CASE WHEN d.id IS NOT NULL THEN d.edition_size - d.units_sold - d.units_reserved ELSE NULL::integer END AS units_remaining,
    d.release_at, d.sold_out_at, d.archived_at,
    ( SELECT COALESCE(sum(v.inventory_on_hand - v.inventory_reserved), 0::bigint) FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS stock_available,
    ( SELECT jsonb_agg(jsonb_build_object('url', m.url, 'alt', m.alt, 'view', m.view, 'kind', m.kind) ORDER BY m.sort_order)
        FROM product_media m WHERE m.product_id = p.id AND NOT m.is_historical) AS media,
    ( SELECT jsonb_agg(DISTINCT jsonb_build_object('color', v.color, 'hex', v.color_hex)) FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS colors,
    p.status = 'active'::product_status AND (p.publish_at IS NULL OR p.publish_at <= now())
      AND (d.id IS NULL OR d.release_at <= now() AND (d.units_sold + d.units_reserved) < d.edition_size) AS is_purchasable,
    d.units_reserved, d.max_per_order,
    -- promotion actually lowering the price (null when the product's own sale price is already lower)
    case when promo_apply(p.base_price_cents, pr.kind, pr.value) < COALESCE(p.sale_price_cents, p.base_price_cents) then pr.id end AS promo_id,
    case when promo_apply(p.base_price_cents, pr.kind, pr.value) < COALESCE(p.sale_price_cents, p.base_price_cents) then coalesce(pr.label, pr.name) end AS promo_label,
    case when promo_apply(p.base_price_cents, pr.kind, pr.value) < COALESCE(p.sale_price_cents, p.base_price_cents) and pr.show_countdown then pr.ends_at end AS promo_ends_at
   FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN collections co ON co.id = p.collection_id
     LEFT JOIN designers de ON de.id = p.designer_id
     LEFT JOIN limited_drops d ON d.product_id = p.id
     LEFT JOIN LATERAL (select * from promo_for(p) x where x.id is not null) pr ON true;

-- Banner for the storefront: the running promotion to announce (if any).
create or replace function public.promo_banner()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'name', name, 'label', label, 'kind', kind, 'value', value, 'scope', scope,
           'text', banner_text, 'ends_at', case when show_countdown then ends_at end,
           'href', case scope when 'collections' then (select '/collections/' || slug from collections where id = scope_ids[1] and cardinality(scope_ids) = 1)
                              when 'categories' then (select '/category/' || slug from categories where id = scope_ids[1] and cardinality(scope_ids) = 1)
                              when 'products' then (select '/product/' || slug from products where id = scope_ids[1] and cardinality(scope_ids) = 1)
                              else '/shop' end)
    from promotions
   where is_active and show_banner and starts_at <= now() and (ends_at is null or ends_at > now())
   order by priority desc, case kind when 'percent' then value else 0 end desc, ends_at nulls last
   limit 1;
$$;
grant execute on function public.promo_banner() to anon, authenticated;

-- Admin: what a promotion would touch (count + examples), before or after saving.
create or replace function public.admin_promo_preview(p_kind text, p_value numeric, p_scope text, p_scope_ids uuid[], p_include_limited boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('marketing.write') then raise exception 'You don''t have permission to do that.' using errcode = '42501'; end if;
  return (with hit as (
    select p.id, p.name, p.base_price_cents, coalesce(p.sale_price_cents, p.base_price_cents) cur,
           promo_apply(p.base_price_cents, p_kind, p_value) promo
      from products p
     where p.status in ('active', 'out_of_stock', 'scheduled') and (p_include_limited or not p.is_limited)
       and (p_scope = 'all' or (p_scope = 'categories' and p.category_id = any(p_scope_ids))
            or (p_scope = 'collections' and p.collection_id = any(p_scope_ids)) or (p_scope = 'products' and p.id = any(p_scope_ids))))
    select jsonb_build_object('products', count(*), 'lowered', count(*) filter (where promo < cur),
             'already_lower', count(*) filter (where promo >= cur),
             'examples', coalesce(jsonb_agg(jsonb_build_object('name', name, 'was', cur, 'now', least(cur, promo)) order by base_price_cents desc)
                                  filter (where promo < cur), '[]'))
      from hit);
end $$;
revoke execute on function public.admin_promo_preview(text, numeric, text, uuid[], boolean) from public, anon;
grant execute on function public.admin_promo_preview(text, numeric, text, uuid[], boolean) to authenticated;

-- The exact price of each variant of a product (product page), from the
-- same function the bag and checkout use.
create or replace function public.variant_prices(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(v.id, variant_price(v, p)), '{}')
    from product_variants v join products p on p.id = v.product_id
   where p.id = p_product_id and v.is_active and p.status <> 'draft';
$$;
grant execute on function public.variant_prices(uuid) to anon, authenticated;
