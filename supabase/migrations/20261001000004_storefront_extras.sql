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
