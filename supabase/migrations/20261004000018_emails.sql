-- =====================================================================
-- 0018 Customer emails: an outbox the database fills when something
-- happens (order paid, shipped, delivered, design decided, quote ready,
-- support reply, welcome) and a scheduled Netlify function drains.
--   * one row per email, deduplicated, retried with back-off, never lost
--   * the provider (Resend) is optional: without a key, rows are marked
--     "skipped (test mode)" and can still be previewed in admin
--   * account emails (confirm address, reset password) are sent by
--     Supabase Auth itself — see docs/emails.md for pointing its SMTP at
--     the same provider
-- =====================================================================

insert into public.store_settings (key, value, is_public) values
  ('email.enabled', 'true', false),
  ('email.from_name', '"TH8RTY"', false),
  ('email.reply_to', 'null', false),
  ('email.disabled_templates', '[]', false)    -- e.g. ["welcome"]
on conflict (key) do nothing;

create table if not exists public.email_outbox (
  id            uuid primary key default gen_random_uuid(),
  template      text not null check (template ~ '^[a-z][a-z0-9_]{1,40}$'),
  to_email      text not null check (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_id       uuid references auth.users(id),
  order_id      uuid references public.orders(id),
  ref_id        uuid,                          -- design / quote / ticket / message
  data          jsonb not null default '{}',
  dedupe_key    text unique,
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts      int not null default 0,
  send_after    timestamptz not null default now(),
  provider      text,
  provider_id   text,
  last_error    text,
  subject       text,                          -- filled when sent (for the admin log)
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists email_outbox_due on public.email_outbox (send_after) where status = 'queued';
create index if not exists email_outbox_time on public.email_outbox (created_at desc);
create index if not exists email_outbox_order on public.email_outbox (order_id);
create index if not exists email_outbox_user on public.email_outbox (user_id);
alter table public.email_outbox enable row level security;
create policy "email log staff" on public.email_outbox for select
  using (public.has_permission('customers.read') or public.has_permission('orders.read'));

-- Queue an email (internal; called by triggers and staff actions).
create or replace function public.email_enqueue(p_template text, p_to text, p_user uuid, p_order uuid, p_ref uuid,
                                                p_data jsonb default '{}', p_dedupe text default null, p_delay interval default '0')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_to is null or p_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return null; end if;
  if not setting_bool('email.enabled', true) then return null; end if;
  if coalesce((select value from store_settings where key = 'email.disabled_templates'), '[]'::jsonb) ? p_template then return null; end if;
  insert into email_outbox (template, to_email, user_id, order_id, ref_id, data, dedupe_key, send_after)
  values (p_template, lower(p_to), p_user, p_order, p_ref, coalesce(p_data, '{}'), p_dedupe, now() + coalesce(p_delay, '0'))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.email_enqueue(text, text, uuid, uuid, uuid, jsonb, text, interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function public.email_on_order_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tpl text;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_tpl := case new.status
    when 'paid' then 'order_confirmed'
    when 'backordered' then 'order_delayed'
    when 'shipped' then 'order_shipped'
    when 'out_for_delivery' then 'order_out_for_delivery'
    when 'delivered' then 'order_delivered'
    when 'cancelled' then case when old.paid_at is not null or old.status not in ('created', 'payment_pending') then 'order_cancelled' end
    when 'refunded' then 'order_refunded'
  end;
  if v_tpl is not null then
    perform email_enqueue(v_tpl, coalesce(new.email, (select email from profiles where id = new.user_id)), new.user_id, new.id, null,
                          '{}', v_tpl || ':' || new.id,
                          case when v_tpl = 'order_shipped' then interval '2 minutes' else interval '0' end);   -- let tracking land first
  end if;
  return new;
end $$;
create or replace trigger orders_email after update of status on public.orders
  for each row execute function public.email_on_order_status();

create or replace function public.email_on_design_decision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is not distinct from old.status or new.status not in ('approved', 'rejected') then return new; end if;
  -- the customer is on the page when the automated check approves instantly; only email decisions made later by a person
  if new.status = 'approved' and new.decided_at is not null and new.submitted_at is not null
     and new.decided_at - new.submitted_at < interval '2 minutes' then return new; end if;
  perform email_enqueue('design_' || new.status, (select email from profiles where id = new.user_id), new.user_id, null, new.id,
                        jsonb_build_object('version', new.version), 'design_' || new.status || ':' || new.id || ':' || new.version);
  return new;
end $$;
create or replace trigger custom_designs_email after update of status on public.custom_designs
  for each row execute function public.email_on_design_decision();

create or replace function public.email_on_quote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'quoted' and old.status is distinct from 'quoted' then
    perform email_enqueue('quote_ready', coalesce(new.email, (select email from profiles where id = new.user_id)), new.user_id, null, new.id,
                          '{}', 'quote_ready:' || new.id || ':' || coalesce(new.proposed_total_cents, 0));
  end if;
  return new;
end $$;
create or replace trigger quote_requests_email after update of status on public.quote_requests
  for each row execute function public.email_on_quote();

create or replace function public.email_on_support_reply()
returns trigger language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if new.internal or new.author_type <> 'staff' then return new; end if;
  select * into t from support_tickets where id = new.ticket_id;
  perform email_enqueue('support_reply', coalesce(t.email, (select email from profiles where id = t.user_id)), t.user_id, t.order_id, new.id,
                        '{}', 'support_reply:' || new.id);
  return new;
end $$;
create or replace trigger support_messages_email after insert on public.support_messages
  for each row execute function public.email_on_support_reply();

create or replace function public.email_on_welcome()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform email_enqueue('welcome', new.email, new.id, null, null, '{}', 'welcome:' || new.id, interval '1 minute');
  return new;
end $$;
create or replace trigger profiles_email after insert on public.profiles
  for each row execute function public.email_on_welcome();

-- ---------------------------------------------------------------------
-- What each email needs, gathered when it is sent (so it is current)
-- ---------------------------------------------------------------------
create or replace function public.email_payload(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e email_outbox; o orders; v jsonb := '{}';
begin
  select * into e from email_outbox where id = p_id;
  if e.id is null then return null; end if;
  v := jsonb_build_object('store', jsonb_build_object('name', (select value#>>'{}' from store_settings where key = 'store.name')),
         'name', (select coalesce(nullif(full_name, ''), null) from profiles where id = e.user_id)) || e.data;
  if e.order_id is not null then
    select * into o from orders where id = e.order_id;
    v := v || jsonb_build_object('order', jsonb_build_object(
      'id', o.id, 'number', o.number, 'status', o.status, 'paid_at', o.paid_at,
      'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'discount_code', o.discount_code,
      'shipping_cents', o.shipping_cents, 'tax_cents', o.tax_cents, 'total_cents', o.total_cents,
      'shipping_address', o.shipping_address, 'shipping_rate', o.shipping_rate,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('name', product_name, 'color', color, 'size', size, 'quantity', quantity,
                  'line_total_cents', line_total_cents, 'custom', item_type = 'custom', 'editions', edition_numbers) order by created_at), '[]')
                from order_items where order_id = o.id),
      'refunded_cents', (select coalesce(sum(amount_cents), 0) from payments where order_id = o.id and kind = 'refund'),
      'shipments', (select coalesce(jsonb_agg(jsonb_build_object('carrier', carrier, 'service', service, 'tracking_number', tracking_number,
                  'tracking_url', tracking_url, 'estimated_delivery', estimated_delivery) order by created_at), '[]')
                from shipments where order_id = o.id and tracking_number is not null)));
    if v->>'name' is null then v := v || jsonb_build_object('name', o.shipping_address->>'name'); end if;
  end if;
  if e.template like 'design_%' then
    v := v || (select jsonb_build_object('design', jsonb_build_object('id', id, 'name', name, 'note', decision_note)) from custom_designs where id = e.ref_id);
  elsif e.template = 'quote_ready' then
    v := v || (select jsonb_build_object('quote', jsonb_build_object('id', id, 'number', number, 'quantity', quantity,
              'unit_cents', proposed_unit_cents, 'total_cents', proposed_total_cents, 'expires_at', expires_at,
              'product', (select name from products where id = q.product_id))) from quote_requests q where id = e.ref_id);
    if v->>'name' is null then v := v || (select jsonb_build_object('name', name) from quote_requests where id = e.ref_id); end if;
  elsif e.template = 'support_reply' then
    v := v || (select jsonb_build_object('ticket', jsonb_build_object('id', t.id, 'number', t.number, 'subject', t.subject), 'message', m.body)
                 from support_messages m join support_tickets t on t.id = m.ticket_id where m.id = e.ref_id);
  end if;
  return v;
end $$;
revoke execute on function public.email_payload(uuid) from public, anon, authenticated;

-- Sender: claim due emails (row-locked so two runs never send the same one).
create or replace function public.email_claim(p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  -- anything stuck mid-send for 10 minutes goes back in the queue
  update email_outbox set status = 'queued', updated_at = now() where status = 'sending' and updated_at < now() - interval '10 minutes';
  with picked as (
    select id from email_outbox where status = 'queued' and send_after <= now()
     order by send_after limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked),
  upd as (
    update email_outbox e set status = 'sending', attempts = attempts + 1, updated_at = now()
      from picked where e.id = picked.id returning e.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'template', template, 'to', to_email, 'attempts', attempts,
           'data', email_payload(id))), '[]') into v from upd;
  return v;
end $$;
revoke execute on function public.email_claim(int) from public, anon, authenticated;
grant execute on function public.email_claim(int) to service_role;

create or replace function public.email_result(p_id uuid, p_status text, p_provider text, p_provider_id text, p_subject text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare a int;
begin
  if not is_service() then raise exception 'Service only.' using errcode = '42501'; end if;
  select attempts into a from email_outbox where id = p_id;
  if p_status = 'failed_final' then p_status := 'failed'; a := 99; end if;   -- permanent errors (bad address, rejected) don't retry
  if p_status = 'failed' and a < 5 then
    update email_outbox set status = 'queued', send_after = now() + make_interval(mins => (2 ^ a)::int), last_error = left(p_error, 500),
           provider = p_provider, subject = coalesce(p_subject, subject), updated_at = now() where id = p_id;
  else
    update email_outbox set status = p_status, provider = p_provider, provider_id = p_provider_id, subject = coalesce(p_subject, subject),
           last_error = left(p_error, 500), sent_at = case when p_status = 'sent' then now() end, updated_at = now() where id = p_id;
    if p_status = 'failed' then
      insert into notifications (audience, kind, severity, title, body, order_id, dedupe_key)
      values ('admin', 'email_failed', 'warning', 'An email couldn''t be sent',
              coalesce((select template || ' to ' || to_email from email_outbox where id = p_id), '') || ': ' || left(coalesce(p_error, ''), 200),
              (select order_id from email_outbox where id = p_id), 'email_failed:' || p_id)
      on conflict do nothing;
    end if;
  end if;
end $$;
revoke execute on function public.email_result(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.email_result(uuid, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------
create or replace function public.admin_emails(p_status text default null, p_q text default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('customers.read') or has_permission('orders.read')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'counts', (select jsonb_object_agg(status, n) from (select status, count(*) n from email_outbox where created_at > now() - interval '30 days' group by 1) c),
    'settings', jsonb_build_object('enabled', setting_bool('email.enabled', true),
       'from_name', (select value#>>'{}' from store_settings where key = 'email.from_name'),
       'reply_to', (select value#>>'{}' from store_settings where key = 'email.reply_to'),
       'disabled', coalesce((select value from store_settings where key = 'email.disabled_templates'), '[]')),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'template', e.template, 'to', e.to_email, 'status', e.status,
               'attempts', e.attempts, 'provider', e.provider, 'subject', e.subject, 'last_error', e.last_error, 'created_at', e.created_at,
               'sent_at', e.sent_at, 'order_id', e.order_id, 'order_number', (select number from orders where id = e.order_id), 'user_id', e.user_id)
               order by e.created_at desc), '[]')
             from (select * from email_outbox
                    where (p_status is null or status = p_status)
                      and (p_q is null or to_email ilike '%' || p_q || '%' or template ilike '%' || p_q || '%'
                           or order_id in (select id from orders where number::text ilike '%' || p_q || '%'))
                    order by created_at desc limit least(coalesce(p_limit, 100), 300)) e));
end $$;
revoke execute on function public.admin_emails(text, text, int) from public, anon;
grant execute on function public.admin_emails(text, text, int) to authenticated;

-- Preview data for one email (admin) — the browser renders the same template the sender uses.
create or replace function public.admin_email_preview(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('customers.read') or has_permission('orders.read')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  return (select jsonb_build_object('id', id, 'template', template, 'to', to_email, 'data', email_payload(id)) from email_outbox where id = p_id);
end $$;
revoke execute on function public.admin_email_preview(uuid) from public, anon;
grant execute on function public.admin_email_preview(uuid) to authenticated;

-- Send again (a new outbox row; the original stays in the log).
create or replace function public.admin_email_resend(p_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare e email_outbox; v uuid;
begin
  if not (has_permission('customers.write') or has_permission('orders.write')) then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  select * into e from email_outbox where id = p_id;
  if e.id is null then raise exception 'Email not found.' using errcode = 'P0001'; end if;
  insert into email_outbox (template, to_email, user_id, order_id, ref_id, data)
  values (e.template, e.to_email, e.user_id, e.order_id, e.ref_id, e.data || jsonb_build_object('resent_by', auth.uid()))
  returning id into v;
  insert into audit_log (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'email.resend', 'email_outbox', p_id::text, jsonb_build_object('new_id', v));
  return v;
end $$;
revoke execute on function public.admin_email_resend(uuid) from public, anon;
grant execute on function public.admin_email_resend(uuid) to authenticated;
