-- 0017_function_grants_hardening.sql
-- Phase 6 integration finding (reproduced against the real 0001-0016 chain on PostgreSQL 16
-- with Supabase-style LEGACY default privileges):
--
-- 0007/0009/0010/0011 end their SECURITY DEFINER functions with
--   revoke execute ... from public;  grant execute ... to authenticated;
-- and 0007's comment calls that "authenticated only". It is not: REVOKE FROM PUBLIC removes only
-- the implicit PUBLIC grant. On a project whose default privileges grant EXECUTE on new functions
-- to anon / authenticated / service_role (Supabase's long-standing default; the repo's
-- config.toml notes newer projects no longer do), `anon` can still execute them.
--
-- Practical impact today is LOW: each body independently fails for anon (auth.uid() / the JWT
-- email are null, so membership/ownership/identity checks are false or raise), and trigger
-- functions cannot be invoked as RPCs. This migration removes the unnecessary surface anyway,
-- consistent with 0008's explicit anon revoke on tables and with 0016 for the media functions.
--
-- Safe to apply whether or not the hosted project has those default privileges (REVOKE of a
-- privilege that is not held is a no-op). It does not touch any grant to `authenticated` that a
-- policy or RPC needs, and it never touches service_role.

-- Called from RLS policies and RPCs by signed-in users only.
revoke execute on function public.is_trip_member(uuid) from anon;
revoke execute on function public.is_trip_owner(uuid) from anon;

-- Invitation RPCs: signed-in users only.
revoke execute on function public.accept_invitation(uuid) from anon;
revoke execute on function public.decline_invitation(uuid) from anon;
revoke execute on function public.revoke_invitation(uuid) from anon;
revoke execute on function public.get_invited_trip_preview(uuid) from anon;

-- Trigger functions are fired by triggers, never called by API roles.
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.add_trip_owner_as_member() from anon, authenticated;
