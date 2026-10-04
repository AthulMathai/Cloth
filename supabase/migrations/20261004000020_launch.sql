-- =====================================================================
-- 0020 Launch readiness: legal pages (editable drafts) and a go-live
-- checklist that reads the real state of the store.
-- =====================================================================

-- Legal pages live in store_settings (public) so they can be edited in
-- admin without a deploy. They start as DRAFTS with [[placeholders]];
-- the checklist stays red until every placeholder is replaced and a person
-- marks the page reviewed. Not legal advice — have a lawyer check them.
insert into public.store_settings (key, value, is_public) values
('legal.privacy', jsonb_build_object('title', 'Privacy policy', 'reviewed', false, 'updated_at', now(), 'body', $md$
We collect only what we need to make and deliver your order, and we never sell your personal information. This policy explains what we collect, why, and your rights under Canada's Personal Information Protection and Electronic Documents Act (PIPEDA).

## Who we are
[[Legal business name]], [[business address]], Canada. Privacy questions: [[privacy contact email]].

## What we collect
- **Account and order details:** name, email, phone, shipping and billing address, order history.
- **Payment:** card payments are handled by our payment processor. We never see or store your full card number.
- **Designs you upload or generate:** artwork, text and design settings, kept privately in your account.
- **Support messages** you send us.
- **Site activity:** pages and products viewed, searches, items added to your bag — used to run and improve the store. We don't use advertising trackers.

## Why we use it
To make, ship and support your order; to check custom designs before printing; to send order updates; to prevent fraud; and to understand what is working in the store. Marketing emails only go to people who opt in, and every one has an unsubscribe link.

## Who we share it with
Only the service providers who help run the store, and only what each needs: our print and fulfillment partners (your name, shipping address and the items to print), shipping carriers, our payment processor, our hosting and database provider (Supabase), our email provider, and our AI provider when you use the AI design tool (your description is sent to create the image). Some providers may store data outside Canada.

## How long we keep it
Order records are kept as long as tax law requires (usually six years). Designs stay in your account until you remove them or close your account. Activity data is kept in summarised form.

## Your rights
You can ask to see, correct or erase your personal information, or withdraw consent for marketing, by emailing [[privacy contact email]]. If you're not satisfied with our answer you can contact the Office of the Privacy Commissioner of Canada.
$md$), true),
('legal.returns', jsonb_build_object('title', 'Returns & refunds', 'reviewed', false, 'updated_at', now(), 'body', $md$
## Store pieces
Unworn, unwashed pieces from the regular collection can be returned within **[[30]] days** of delivery for a refund to your original payment method. Return shipping is [[paid by you / free]] unless the item is faulty.

## Custom designs and limited drops
Custom pieces are printed just for you, and limited-drop pieces are individually numbered, so they're **final sale** — we can't take them back for change of mind or size.

## Faulty or wrong items
If anything arrives misprinted, damaged or different from what you ordered — custom or not — tell us within **[[14]] days** of delivery with a photo and we'll reprint it or refund you, at no cost to you.

## How to start
Open a request from your order page or the help page and choose "Return or exchange". Refunds are issued within [[5]] business days of us receiving the return; your bank may take another 5–10 business days to show it.
$md$), true),
('legal.shipping', jsonb_build_object('title', 'Shipping', 'reviewed', false, 'updated_at', now(), 'body', $md$
## Where we ship
We ship within Canada. [[International shipping is not available yet.]]

## When it ships
Every piece is printed to order by one of our Canadian print partners, usually within **[[2–5]] business days**. Limited drops and custom designs may take a little longer while they are checked and numbered. You'll get an email with tracking when your order ships.

## Rates
Shipping rates and delivery estimates are shown at checkout before you pay. [[Free shipping on orders over $X.]]

## Lost or late parcels
If tracking hasn't moved for [[7]] business days, or a parcel is marked delivered but you can't find it, contact us and we'll work it out with the carrier — and reprint if needed.
$md$), true),
('legal.terms', jsonb_build_object('title', 'Terms of sale', 'reviewed', false, 'updated_at', now(), 'body', $md$
These terms apply to purchases from [[Legal business name]] ("we") through this website.

## Prices and payment
Prices are in Canadian dollars. Sales tax is calculated at checkout based on your shipping province. We may correct obvious pricing errors before an order ships, and will refund you if we do.

## Custom designs
When you upload artwork or text, you confirm you own it or have permission to print it, and that it doesn't infringe anyone's rights. You keep ownership of your design and give us permission to reproduce it only to make, show and deliver your order. Every design is reviewed before printing; we may decline designs that may include someone else's logos, characters or artwork, or hateful, explicit or violent content — and refund you if we do.

## AI-generated artwork
Artwork made with the AI design tool is created from your description. You're responsible for what you ask it to create. We refuse descriptions naming brands, characters, real people or prohibited content.

## Limited editions
Limited drops have a fixed edition size. Edition numbers are assigned when payment completes and can't be chosen. Once a drop sells out it is never restocked.

## Colours and fit
Screens show colours differently and printed colours can vary slightly from your preview. Size guides are approximate.

## Liability
Our responsibility for any order is limited to the amount you paid for it, except where the law says otherwise.

## Governing law
These terms are governed by the laws of [[Ontario]] and the federal laws of Canada that apply there.

Questions: [[contact email]].
$md$), true),
('launch.done', '{}'::jsonb, false)
on conflict (key) do nothing;

-- Automatic checks (everything that can be read from the database).
create or replace function public.admin_launch_checks()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('settings.write') or has_permission('users.manage')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'super_admin_guard', exists (select 1 from pg_trigger where tgname = 'user_roles_keep_super_admin'),
    'super_admins', (select count(*) from user_roles where role = 'super_admin'),
    'test_partners_active', (select count(*) from partners where is_test and status = 'active'),
    'real_partners_active', (select count(*) from partners where not is_test and status = 'active'),
    'test_partner_routing', setting_bool('fulfillment.allow_test_partners', true),
    'live_products', (select count(*) from products where status in ('active', 'out_of_stock')),
    'products_without_photos', (select count(*) from products p where status in ('active', 'out_of_stock')
                                  and not exists (select 1 from product_media m where m.product_id = p.id and not m.is_historical)),
    'products_without_cost', (select count(*) from products where status in ('active', 'out_of_stock') and coalesce(cost_cents, 0) = 0),
    'tax_rates', (select count(distinct province) from tax_rates where effective_from <= current_date and (effective_to is null or effective_to >= current_date)),
    'shipping_rates', (select count(*) from shipping_rates where is_active),
    'pricing_rules_without_cost', (select count(*) from pricing_rules where is_active and coalesce(cost_cents, 0) = 0 and rule_type in ('placement', 'method', 'print_area', 'artwork')),
    'moderation_terms', (select count(*) from moderation_terms),
    'legal', (select jsonb_object_agg(replace(key, 'legal.', ''), jsonb_build_object('title', value->>'title', 'reviewed', coalesce((value->>'reviewed')::boolean, false),
                'placeholders', (select count(*) from regexp_matches(value->>'body', '\[\[[^\]]*\]\]', 'g')), 'updated_at', value->>'updated_at'))
              from store_settings where key like 'legal.%'),
    'emails_failed_7d', (select count(*) from email_outbox where status = 'failed' and created_at > now() - interval '7 days'),
    'orders_paid', (select count(*) from orders where paid_at is not null),
    'done', coalesce((select value from store_settings where key = 'launch.done'), '{}'));
end $$;
revoke execute on function public.admin_launch_checks() from public, anon;
grant execute on function public.admin_launch_checks() to authenticated;

-- Tick / untick a manual checklist item (who and when are kept).
create or replace function public.admin_launch_mark(p_key text, p_done boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not has_permission('settings.write') then raise exception 'You don''t have permission to do that.' using errcode = '42501'; end if;
  if p_key !~ '^[a-z0-9_]{2,40}$' then raise exception 'Bad key.' using errcode = 'P0001'; end if;
  insert into store_settings (key, value, is_public) values ('launch.done', '{}', false) on conflict (key) do nothing;
  update store_settings set value = case when p_done
      then value || jsonb_build_object(p_key, jsonb_build_object('by', (select email from profiles where id = auth.uid()), 'at', now()))
      else value - p_key end
   where key = 'launch.done' returning value into v;
  return v;
end $$;
revoke execute on function public.admin_launch_mark(text, boolean) from public, anon;
grant execute on function public.admin_launch_mark(text, boolean) to authenticated;

-- Performance tidy-ups flagged by the Supabase advisor.
alter policy "own generations" on public.ai_generations
  using (user_id = (select auth.uid()) or public.has_permission('moderation.review') or public.has_permission('analytics.read'));
create index if not exists ai_generations_asset on public.ai_generations (asset_id);
create index if not exists ai_generations_used_asset on public.ai_generations (used_asset_id);
create index if not exists promotions_created_by on public.promotions (created_by);
