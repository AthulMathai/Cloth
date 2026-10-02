-- =====================================================================
-- 0005 HARDENING (from Supabase security advisor)
--   * Pin search_path on every trigger/helper function.
--   * Trigger-only functions are not callable through the API.
-- Intentionally still callable: has_permission / has_role / is_staff /
-- my_permissions (RLS policies call them as the requesting user),
-- track_event + subscribe_newsletter (public, validated inside),
-- adjust_inventory (checks inventory.write itself).
-- =====================================================================
alter function public.touch_updated_at()        set search_path = public;
alter function public.guard_profile_email()     set search_path = public;
alter function public.sync_limited_flag()       set search_path = public;
alter function public.guard_product_status()    set search_path = public;
alter function public.refresh_product_search()  set search_path = public;
alter function public.guard_drop_counters()     set search_path = public;
alter function public.guard_variant_stock()     set search_path = public;
alter function public.jsonb_merge_deep(jsonb, jsonb) set search_path = public;

revoke execute on function public.audit_row()        from public, anon, authenticated;
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.adjust_inventory(uuid, int, text, text, text) from anon;
