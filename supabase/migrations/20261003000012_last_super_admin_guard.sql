-- Run once in the Supabase SQL editor (the MCP connector refuses statements
-- that mention DELETE). Stops anyone removing the last super admin.
create or replace function public.guard_last_super_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'super_admin'
     and not exists (select 1 from user_roles where role = 'super_admin' and id <> old.id) then
    raise exception 'You can''t remove the last super admin.' using errcode = 'check_violation';
  end if;
  return old;
end $$;
drop trigger if exists user_roles_keep_super_admin on public.user_roles;
create trigger user_roles_keep_super_admin before delete on public.user_roles
  for each row execute function public.guard_last_super_admin();
