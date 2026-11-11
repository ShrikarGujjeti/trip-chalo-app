-- 0019_security_hardening.sql
-- Phase 6 security hardening. Forward-only and idempotent: a clean "reset to intended state" for the
-- Data API grants, plus the missing database-level guard on messages. No historical migration is edited.
--
-- ROOT CAUSE (from Git history and the recorded hosted migration SQL): both problems predate Phase 6. 0007
-- (messages_update_sender, checks sender_id only) and 0008 (grants) were committed together in e5b39a8 (Phase 3).
-- 0008 granted `authenticated` its intended CRUD and ran `REVOKE ALL ... FROM anon`, which shows the author knew the
-- platform's default grants existed, but it never revoked them from `authenticated` or `service_role`, and it granted
-- UPDATE on messages for ALL columns. No later migration touched messages. Phase 6 (0012/0016) narrowed `media` only.
-- All 18 applied migrations on the hosted project match the committed files (comment/whitespace-insensitive).
--
-- WHAT THE INVESTIGATION ESTABLISHED (replayed against PostgreSQL 17 with the hosted project's roles and
-- default privileges, and read from the hosted catalogs; see supabase/tests/phase6_security_hardening_test.sql):
--
-- 1. Excess table privileges. Tables created by `postgres` in `public` automatically receive
--    TRUNCATE, REFERENCES, TRIGGER and MAINTAIN for anon/authenticated/service_role from the role's default
--    ACL (pg_default_acl). 0008 only GRANTs the intended CRUD to `authenticated` and REVOKEs ALL from `anon`;
--    it never removed those defaults from `authenticated` or `service_role`. TRUNCATE ignores RLS. It is not
--    exposed by PostgREST, so this is excess privilege / defence in depth, NOT a demonstrated browser exploit.
--
-- 2. Future tables. The same default ACL would hand the same four privileges to every table a later
--    migration creates as `postgres` (Phase 7+). Fixed here for `postgres` only. The platform-managed
--    `supabase_admin` defaults are deliberately NOT touched: application migrations do not create objects as that
--    role (all six tables are owned by `postgres`).
--    PostgreSQL ADDS a schema-scoped default ACL to the role's GLOBAL default ACL (pg_default_acl row with
--    defaclnamespace = 0); a schema-scoped REVOKE cannot remove a global grant. The hosted project has NO global
--    entry for `postgres` (catalog read 2026-11-12), but the migration also revokes at the global level so the
--    guarantee does not depend on that. With no global entry this statement is a no-op (it creates no row).
--
-- 2b. PUBLIC. PostgreSQL grants no table privileges to PUBLIC by default and the hosted project has none on these
--    tables (2026-11-12), but a PUBLIC grant would be effective for every API role, so the reset below includes
--    PUBLIC. A table-level REVOKE also removes that grantee's column-level grants.
--
-- 3. messages UPDATE. messages_update_sender checked only sender_id. The new row's trip_id was not required to
--    be a trip the sender belongs to, and `authenticated` could UPDATE every column. Verified on PG17:
--      - UPDATE ... WHERE <any column> that changes trip_id is refused, but only INCIDENTALLY: when SELECT
--        privilege is needed (any column in WHERE/RETURNING), PostgreSQL also applies the SELECT policy to the
--        new row, which fails for a foreign trip.
--      - UPDATE messages SET trip_id = <foreign trip> with NO WHERE clause succeeds: the message moves into a
--        trip the sender is not a member of and that trip's members can read it.
--    On the hosted project the second form is blocked in practice because the `authenticator` role preloads
--    `safeupdate` (UPDATE without WHERE is rejected) and PostgREST filters always reference a column. That is a
--    platform side effect, not an authorization rule, so it is not relied on: the policy now requires current
--    membership of the row's trip on both the old and the new row, and clients may update `content` only.
--    edited_at becomes server-controlled (trigger), so it cannot be forged.
--    A sender who has LEFT the trip can no longer edit its messages in ANY statement form (consistent with INSERT, which
--    requires membership; before this, an UPDATE with no column reference in it still matched on sender_id alone).
--    DELETE rules (messages_delete_sender_or_owner) are not changed by this migration.
--
-- INTENDED END STATE (authenticated; PUBLIC, anon and service_role have NO direct table privileges):
--   profiles, trips, trip_members : SELECT, INSERT, UPDATE, DELETE   (as 0008; row access is decided by RLS)
--   invitations                    : SELECT, INSERT                   (as 0008)
--   media                          : SELECT, DELETE                   (0008 + 0012/0016 removed INSERT/UPDATE)
--   messages                       : SELECT, INSERT, DELETE, UPDATE(content)
-- service_role needs no table privileges: the app only calls SECURITY DEFINER RPCs with it (confirm_media_upload,
-- fail_media_upload), and it already holds none on the hosted project.
--
-- FORWARD-ONLY. There is no generic down migration: the previous ACLs were not uniform (e.g. on the hosted project
-- `media` lacked TRUNCATE for authenticated/service_role), so "undo" cannot be written without the target's own
-- pre-apply state, and restoring it would reopen the vulnerabilities. The runbook captures that state (Q0) before
-- apply and holds a reversal generated from the hosted snapshot, for emergency use only.

-- ============ 1. Existing tables: reset to the intended grants ============
-- REVOKE ALL covers every privilege this server version defines (incl. MAINTAIN on PostgreSQL 17), so this
-- statement is correct on 16 and 17 and also normalises any drift (e.g. a table ACL changed outside migrations).
revoke all on table
  public.profiles, public.trips, public.trip_members,
  public.invitations, public.media, public.messages
from public, anon, authenticated, service_role;

grant select, insert, update, delete
  on public.profiles, public.trips, public.trip_members
  to authenticated;

grant select, insert
  on public.invitations
  to authenticated;

grant select, delete
  on public.media
  to authenticated;

grant select, insert, delete
  on public.messages
  to authenticated;

-- Column-level: clients may change message text only.
-- id / trip_id / sender_id / created_at stay immutable; edited_at is set by the trigger below.
grant update (content) on public.messages to authenticated;

-- ============ 2. Future tables: no automatic API privileges ============
-- Every future application table must GRANT what it needs explicitly (the pattern 0008 already follows).
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
-- Global level too (see header 2): a global default grant would otherwise still be added to every new table.
alter default privileges for role postgres
  revoke all on tables from public, anon, authenticated, service_role;

-- ============ 3. messages: membership on both the old and the new row ============
alter policy messages_update_sender
  on public.messages
  using (
    sender_id = auth.uid()
    and public.is_trip_member(trip_id)
  )
  with check (
    sender_id = auth.uid()
    and public.is_trip_member(trip_id)
  );

-- ============ 4. messages: edited_at is server-controlled ============
create or replace function public.set_message_edited_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.content is distinct from old.content then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.set_message_edited_at() from public, anon, authenticated, service_role;

drop trigger if exists messages_set_edited_at on public.messages;
create trigger messages_set_edited_at
  before update on public.messages
  for each row
  execute function public.set_message_edited_at();
