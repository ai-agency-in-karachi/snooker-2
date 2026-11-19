-- =============================================================================
-- FUSION 2100: the administrator password re-check (before exporting or
-- resetting business data) is limited to about one guess every two seconds
-- per account.
--
-- Impact on existing data: none (one function body changes).
--
-- Until now each wrong password cost one second, but requests sent in
-- parallel each got their own second: someone holding a stolen administrator
-- session could still try many passwords per second. Now every check for an
-- account waits its turn (an advisory lock per account, held until the
-- request ends) and a wrong password costs two seconds, so parallel requests
-- only queue — whatever is sent, guesses come one at a time. Signing in is
-- protected separately by Supabase Auth's own rate limits.
-- =============================================================================

create or replace function public.fusion_require_admin_password(p_password text)
returns public.app_users language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin();
begin
  -- One check at a time per account; parallel requests wait here.
  perform pg_catalog.pg_advisory_xact_lock(7317, pg_catalog.hashtext(v_me.id::text));
  if not public.fusion_verify_password(v_me.id, p_password) then
    perform pg_catalog.pg_sleep(2);
    raise exception 'The password is incorrect.' using errcode = 'P0001', hint = 'wrong_password';
  end if;
  return v_me;
end;
$$;
