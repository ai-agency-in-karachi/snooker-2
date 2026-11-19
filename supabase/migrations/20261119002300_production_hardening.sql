-- =============================================================================
-- FUSION 2300: production hardening for a fresh Supabase project.
--
-- Impact on existing data: none. No table, column or row is added, changed or
-- deleted. Only privileges, one read policy and the cleanup schedule are
-- touched, and every statement is idempotent (safe to apply again).
--
-- Found by applying every migration to a database that carries Supabase's own
-- default privileges (the API roles are granted everything new in `public`),
-- then auditing what `anon` and `authenticated` can reach:
--
-- 1. Sequences. `stock_adjustments` (1400) was created before that migration
--    revoked the default privileges, so its identity sequence kept USAGE /
--    SELECT / UPDATE for `anon` and `authenticated`. The API roles never need
--    a sequence (every insert runs inside a SECURITY DEFINER function as the
--    owner), so all sequence privileges are removed.
-- 2. Belt and braces for the allow-list from 0500 / 1400: `anon` holds nothing
--    in `public`; `authenticated` holds SELECT (through RLS) and nothing else on
--    any table; no function is executable by PUBLIC or `anon`. These revokes
--    change nothing on a correctly migrated database and close any grant made
--    by hand in the dashboard.
-- 3. app_users: a deactivated account could still read its own profile row
--    (every other policy already requires an active account). The row is now
--    visible only to its active owner and to administrators. The app reads
--    profiles through get_my_profile() (which already refused deactivated
--    accounts) and lists staff as an administrator, so nothing visible changes.
-- 4. Automatic invoice cleanup: if pg_cron was not enabled when 0700 ran, the
--    hourly job was never scheduled. Schedule it now when pg_cron is available
--    and the job is missing (an existing job is left exactly as it is).
-- =============================================================================

-- 1 + 2. Least privilege ------------------------------------------------------------------------------
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
revoke all on all functions in schema public from public, anon;

-- Keep future objects closed as well (repeats 1400; harmless when already set).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- 3. Profiles: only active accounts read their own row --------------------------------------------------
drop policy if exists app_users_read on public.app_users;
create policy app_users_read on public.app_users
  for select to authenticated
  using ((id = (select auth.uid()) and (select public.fusion_is_active_user()))
         or (select public.fusion_is_admin()));

-- 4. Hourly invoice cleanup -------------------------------------------------------------------------------
do $$
begin
  if pg_catalog.to_regclass('cron.job') is null
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise warning 'FUSION: pg_cron could not be enabled (%). Enable it under Database → Extensions.', sqlerrm;
    end;
  end if;
  if pg_catalog.to_regclass('cron.job') is not null then
    begin
      if not exists (select 1 from cron.job where jobname = 'fusion-sales-retention') then
        perform cron.schedule('fusion-sales-retention', '17 * * * *', 'select public.fusion_retention_job()');
      end if;
    exception when others then
      raise warning 'FUSION: automatic sales cleanup could not be scheduled (%). See README.', sqlerrm;
    end;
  else
    raise notice 'FUSION: pg_cron is not available; automatic sales cleanup is not scheduled.';
  end if;
end;
$$;

notify pgrst, 'reload schema';
