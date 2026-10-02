-- =====================================================================
-- 0010 Defence in depth: designer RPCs that require a signed-in user are
-- not executable by anon at all (they also check auth.uid() inside).
-- Postgres grants EXECUTE to PUBLIC by default, so revoke from PUBLIC
-- and grant back to signed-in users only.
-- =====================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.design_save(uuid, text, uuid, uuid, jsonb, jsonb, jsonb)',
    'public.design_submit(uuid)',
    'public.design_register_asset(text, text, text, text, int, int, int, text, text)',
    'public.design_get(uuid)',
    'public.design_price(uuid, int)',
    'public.cart_add_design(text, uuid, int)',
    'public.price_custom_admin(uuid, text, jsonb, text[], int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
