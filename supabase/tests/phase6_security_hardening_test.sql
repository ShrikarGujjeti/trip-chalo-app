-- phase6_security_hardening_test.sql
--
-- WHAT THIS CHECKS (migration 0019 and the properties it establishes):
--   H1  exact EFFECTIVE privilege matrix (has_table_privilege / has_column_privilege, so grants via PUBLIC or role
--       membership count) for PUBLIC / anon / authenticated / service_role on the six application tables: every
--       table privilege incl. REFERENCES/TRIGGER/MAINTAIN, and every column for SELECT/INSERT/UPDATE/REFERENCES
--       (only authenticated UPDATE(messages.content) beyond the table-level set)
--   H2  anon has no access at runtime; H3 TRUNCATE executed and denied to authenticated (REFERENCES/TRIGGER/MAINTAIN
--       are asserted absent by H1; they are not exercised as statements)
--   H4  future TABLES created by `postgres` in `public` receive NO privileges for PUBLIC or any API role (an actual
--       probe table, so global AND schema-scoped default ACLs are both covered), and no default-ACL row for `postgres`
--       (global or public) grants tables to them; H4b every SECURITY DEFINER function in public is closed to anon
--       (functions are NOT covered by a default ACL, see the note at H4b)
--   H5  the six tables are owned by `postgres` (so the default ACL under test is the one that applies)
--   H6  messages: edit own content (edited_at is server-set); protected columns immutable; no cross-trip move in
--       ANY statement form; non-sender / outsider / departed member cannot edit; non-member cannot insert;
--       owner and sender delete behaviour unchanged; trip isolation holds after every attack
--   H7  the RLS policy blocks the cross-trip move BY ITSELF (column privilege deliberately re-granted in-transaction)
--   H8  intended CRUD still works (trips, profiles, invitations, trip_members leave, media read/delete rules)
--   H9  service_role still works through SECURITY DEFINER RPCs with no table privileges: it may EXECUTE both
--       confirm_media_upload and fail_media_upload, both are SECURITY DEFINER and owned by `postgres` (so their table
--       access is the owner's), fail_media_upload is called for real; confirm_media_upload is exercised end to end by
--       T7/T8/T13/T14 in phase6_media_security_test.sql
--   H10 signup / trip-creation triggers still fire
--   H11 forward guard for Phase 7+: EVERY table in public is owned by `postgres`, has RLS enabled, and gives PUBLIC/anon
--       no privileges (a new table that forgets RLS or is created by another role fails here)
--
-- PREREQUISITES: migrations 0001-0019 applied. MUST run as the `postgres` role (the role that owns the tables and runs
--   migrations): the test FAILS (it does not skip) under any other role.
--     local:   psql -v ON_ERROR_STOP=1 -f supabase/tests/phase6_security_hardening_test.sql
--     hosted:  use a branch/staging project first. It is written to be non-destructive: ONE transaction that always
--              ends in ROLLBACK, fixed fixture UUIDs (a1/a2/a3/a4 prefixes), a temporary table for H4.
--              Do not run it in a mode that commits on error.
-- NOTE: the MAINTAIN privilege exists only on PostgreSQL 17+; the matrix checks it only when available.
-- Every check emits a NOTICE "PASS ..."; any failure raises an exception.

begin;

do $$ begin
  if current_user <> 'postgres' then
    raise exception 'FAIL setup: run this test as the postgres role (current_user = %); H4/H5/H11 depend on it', current_user;
  end if;
end $$;

-- ---------- helpers (pg_temp; callable only while running as the migration role) ----------
create function pg_temp.run_as(p_role text, p_user uuid, p_stmt text) returns text
language plpgsql as $$
declare n bigint; v text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  execute format('set local role %I', p_role);
  begin
    if p_stmt ~* '^\s*select' then
      execute p_stmt into n;
    else
      execute p_stmt;
      get diagnostics n = row_count;
    end if;
    v := 'OK:' || coalesce(n::text, 'null');
  exception when others then
    v := 'ERR:' || sqlstate;
  end;
  reset role;
  return v;
end $$;

create function pg_temp.auth_as(p_user uuid, p_stmt text) returns text
language sql as $$ select pg_temp.run_as('authenticated', p_user, p_stmt) $$;

create function pg_temp.expect(p_label text, p_actual text, p_expected text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;

-- ---------- fixtures: four users, two trips, messages ----------
insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-000000000001', 'u1@t.test'),   -- owner of TA, sender
  ('a2000000-0000-0000-0000-000000000002', 'u2@t.test'),   -- owner of TB
  ('a3000000-0000-0000-0000-000000000003', 'u3@t.test'),   -- member of TA (added as accept_invitation would)
  ('a4000000-0000-0000-0000-000000000004', 'u4@t.test');   -- outsider

select pg_temp.expect('setup TA', pg_temp.auth_as('a1000000-0000-0000-0000-000000000001',
  $s$insert into public.trips (id, owner_id, name) values ('b1000000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-000000000001','TA')$s$), 'OK:1');
select pg_temp.expect('setup TB', pg_temp.auth_as('a2000000-0000-0000-0000-000000000002',
  $s$insert into public.trips (id, owner_id, name) values ('b2000000-0000-0000-0000-00000000000b','a2000000-0000-0000-0000-000000000002','TB')$s$), 'OK:1');
insert into public.trip_members (trip_id, user_id, role) values ('b1000000-0000-0000-0000-00000000000a','a3000000-0000-0000-0000-000000000003','member');

select pg_temp.expect('msg U1 in TA', pg_temp.auth_as('a1000000-0000-0000-0000-000000000001',
  $s$insert into public.messages (id, trip_id, sender_id, content) values ('c1000000-0000-0000-0000-0000000000a1','b1000000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-000000000001','hello from U1')$s$), 'OK:1');
select pg_temp.expect('msg U3 in TA', pg_temp.auth_as('a3000000-0000-0000-0000-000000000003',
  $s$insert into public.messages (id, trip_id, sender_id, content) values ('c3000000-0000-0000-0000-0000000000a3','b1000000-0000-0000-0000-00000000000a','a3000000-0000-0000-0000-000000000003','hello from U3')$s$), 'OK:1');
select pg_temp.expect('msg U2 in TB', pg_temp.auth_as('a2000000-0000-0000-0000-000000000002',
  $s$insert into public.messages (id, trip_id, sender_id, content) values ('c2000000-0000-0000-0000-0000000000b2','b2000000-0000-0000-0000-00000000000b','a2000000-0000-0000-0000-000000000002','hello from U2')$s$), 'OK:1');

-- ===== H1: privilege matrix =====
do $$
declare
  v17 boolean := current_setting('server_version_num')::int >= 170000;
  privs text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || case when v17 then array['MAINTAIN'] else array[]::text[] end;
  expect jsonb := '{
    "profiles":     {"authenticated": ["SELECT","INSERT","UPDATE","DELETE"]},
    "trips":        {"authenticated": ["SELECT","INSERT","UPDATE","DELETE"]},
    "trip_members": {"authenticated": ["SELECT","INSERT","UPDATE","DELETE"]},
    "invitations":  {"authenticated": ["SELECT","INSERT"]},
    "media":        {"authenticated": ["SELECT","DELETE"]},
    "messages":     {"authenticated": ["SELECT","INSERT","DELETE"]}
  }';
  t text; r text; p text; have text[]; want text[]; col text; eff boolean; exp_col boolean;
begin
  foreach t in array array['profiles','trips','trip_members','invitations','media','messages'] loop
    foreach r in array array['public','anon','authenticated','service_role'] loop
      have := '{}';
      foreach p in array privs loop
        if has_table_privilege(r, 'public.'||t, p) then have := have || p; end if;
      end loop;
      select coalesce(array_agg(x order by x), '{}') into want from jsonb_array_elements_text(coalesce(expect->t->r, '[]')) x;
      select coalesce(array_agg(x order by x), '{}') into have from unnest(have) x;
      if have is distinct from want then
        raise exception 'FAIL H1: % on % has {%}, expected {%}', r, t, have, want;
      end if;
    end loop;
  end loop;
  -- EFFECTIVE column privileges, every column of every table: a column privilege is expected exactly when the role holds
  -- it at table level, plus authenticated UPDATE(messages.content). This catches column grants to PUBLIC or a role.
  foreach t in array array['profiles','trips','trip_members','invitations','media','messages'] loop
    foreach r in array array['public','anon','authenticated','service_role'] loop
      for col in select attname from pg_attribute where attrelid = ('public.'||t)::regclass and attnum > 0 and not attisdropped loop
        foreach p in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
          eff := has_column_privilege(r, 'public.'||t, col, p);
          exp_col := coalesce((expect->t->r) ? p, false)
                     or (t = 'messages' and col = 'content' and r = 'authenticated' and p = 'UPDATE');
          if eff <> exp_col then
            raise exception 'FAIL H1: % % on %.% is %, expected %', r, p, t, col, eff, exp_col;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  raise notice 'PASS H1 effective table and column privilege matrix incl. PUBLIC (MAINTAIN checked: %)', v17;
end $$;

-- ===== H2 / H3: anon blind; authenticated cannot TRUNCATE =====
do $$
declare t text;
begin
  foreach t in array array['profiles','trips','trip_members','invitations','media','messages'] loop
    perform pg_temp.expect('H2 anon select '||t, pg_temp.run_as('anon', null, format('select count(*) from public.%I', t)), 'ERR:42501');
    perform pg_temp.expect('H3 truncate '||t, pg_temp.auth_as('a1000000-0000-0000-0000-000000000001', format('truncate public.%I', t)), 'ERR:42501');
  end loop;
  raise notice 'PASS H2/H3 anon denied; authenticated TRUNCATE denied on all six tables';
end $$;

-- ===== H4 / H5: future objects and ownership =====
do $$
declare p text; r text; bad text := '';
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename in ('profiles','trips','trip_members','invitations','media','messages') and tableowner <> 'postgres') then
    raise exception 'FAIL H5: an application table is not owned by postgres';
  end if;
  create table public._acl_probe_table (id int);
  foreach r in array array['public','anon','authenticated','service_role'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                       || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end loop
      if has_table_privilege(r, 'public._acl_probe_table', p) then bad := bad || format(' %s:%s', r, p); end if;
    end loop;
  end loop;
  if bad <> '' then raise exception 'FAIL H4: a new table created by postgres in public was granted:%', bad; end if;
  -- catalog: neither the GLOBAL (defaclnamespace = 0) nor the public-scoped default ACL of postgres grants tables to them
  select string_agg(format('%s:%s', case when d.defaclnamespace = 0 then 'GLOBAL' else d.defaclnamespace::regnamespace::text end,
                           case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end), ' ')
    into bad
  from pg_default_acl d, aclexplode(d.defaclacl) a
  where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'r'
    and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
    and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated','service_role'));
  if bad is not null then raise exception 'FAIL H4: postgres default ACL for tables still grants to: %', bad; end if;
  drop table public._acl_probe_table;
  raise notice 'PASS H4/H5 future tables get no privileges for PUBLIC/API roles (global + public defaults); tables owned by postgres';
end $$;

-- H4b: FUNCTIONS. `ALTER DEFAULT PRIVILEGES ... IN SCHEMA` can only ADD privileges to the global default, so a function
--      created in public keeps PUBLIC EXECUTE unless the migration revokes it (the project convention: revoke from public,
--      grant to the roles that need it). Nothing here changes that default (it is platform-adjacent and global); this
--      guard makes a forgotten REVOKE fail loudly: no SECURITY DEFINER function in public may be executable by anon.
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'FAIL H4b: SECURITY DEFINER function(s) executable by anon: %', bad; end if;
  raise notice 'PASS H4b no SECURITY DEFINER function in public is executable by anon';
end $$;

-- ===== H6: messages =====
do $$
declare
  u1 constant uuid := 'a1000000-0000-0000-0000-000000000001'; u2 constant uuid := 'a2000000-0000-0000-0000-000000000002';
  u3 constant uuid := 'a3000000-0000-0000-0000-000000000003'; u4 constant uuid := 'a4000000-0000-0000-0000-000000000004';
  ta constant text := 'b1000000-0000-0000-0000-00000000000a'; tb constant text := 'b2000000-0000-0000-0000-00000000000b';
  m1 constant text := 'c1000000-0000-0000-0000-0000000000a1'; m3 constant text := 'c3000000-0000-0000-0000-0000000000a3';
  edited timestamptz; created_before timestamptz; created_after timestamptz; f text;
begin
  -- (a) edit own content; edited_at is set by the server, created_at untouched
  select created_at into created_before from public.messages where id = m1::uuid;
  perform pg_temp.expect('H6a edit own', pg_temp.auth_as(u1, format($s$update public.messages set content = 'edited by U1' where id = %L$s$, m1)), 'OK:1');
  select edited_at, created_at into edited, created_after from public.messages where id = m1::uuid;
  if edited is null then raise exception 'FAIL H6a: edited_at was not set by the trigger'; end if;
  if created_after <> created_before then raise exception 'FAIL H6a: created_at changed'; end if;

  -- (b) every protected column is immutable for clients, in every statement form
  foreach f in array array[
    format($s$update public.messages set trip_id = %L where id = %L$s$, tb, m1),
    format($s$update public.messages set trip_id = %L where sender_id = auth.uid()$s$, tb),
    format($s$update public.messages set trip_id = %L where true$s$, tb),
    format($s$update public.messages set trip_id = %L$s$, tb),
    format($s$update public.messages set trip_id = %L$s$, ta),
    format($s$update public.messages set sender_id = %L where id = %L$s$, u2, m1),
    format($s$update public.messages set id = gen_random_uuid() where id = %L$s$, m1),
    format($s$update public.messages set created_at = now() - interval '5 years' where id = %L$s$, m1),
    format($s$update public.messages set edited_at = now() - interval '5 years' where id = %L$s$, m1),
    format($s$update public.messages set content = 'x', trip_id = %L where id = %L$s$, tb, m1)
  ] loop
    perform pg_temp.expect('H6b '||f, pg_temp.auth_as(u1, f), 'ERR:42501');
  end loop;
  if (select content from public.messages where id = m1::uuid) <> 'edited by U1' then raise exception 'FAIL H6b: a rejected statement changed the message'; end if;
  if (select trip_id::text from public.messages where id = m1::uuid) <> ta then raise exception 'FAIL H6b: message left its trip'; end if;

  -- (c) other members / outsiders cannot edit someone else's message
  perform pg_temp.expect('H6c member edits other', pg_temp.auth_as(u3, format($s$update public.messages set content = 'hijack' where id = %L$s$, m1)), 'OK:0');
  perform pg_temp.expect('H6c outsider edits',     pg_temp.auth_as(u4, format($s$update public.messages set content = 'hijack' where id = %L$s$, m1)), 'OK:0');
  perform pg_temp.expect('H6c other-trip owner',   pg_temp.auth_as(u2, format($s$update public.messages set content = 'hijack' where id = %L$s$, m1)), 'OK:0');
  perform pg_temp.expect('H6c edit with no WHERE only touches own rows', pg_temp.auth_as(u3, $s$update public.messages set content = 'only mine'$s$), 'OK:1');
  perform pg_temp.expect('H6c U1 text intact', (select 'OK:' || (content = 'edited by U1')::text from public.messages where id = m1::uuid), 'OK:true');

  -- (d) non-members cannot insert into a trip
  perform pg_temp.expect('H6d outsider insert', pg_temp.auth_as(u4, format($s$insert into public.messages (trip_id, sender_id, content) values (%L, %L, 'x')$s$, ta, u4)), 'ERR:42501');
  perform pg_temp.expect('H6d other-trip member insert', pg_temp.auth_as(u2, format($s$insert into public.messages (trip_id, sender_id, content) values (%L, %L, 'x')$s$, ta, u2)), 'ERR:42501');
  perform pg_temp.expect('H6d spoofed sender', pg_temp.auth_as(u3, format($s$insert into public.messages (trip_id, sender_id, content) values (%L, %L, 'x')$s$, ta, u1)), 'ERR:42501');

  -- (e) trip isolation after all attacks
  perform pg_temp.expect('H6e TB sees only its own', pg_temp.auth_as(u2, format($s$select count(*) from public.messages where trip_id = %L$s$, tb)), 'OK:1');
  perform pg_temp.expect('H6e TB sees nothing of TA', pg_temp.auth_as(u2, format($s$select count(*) from public.messages where trip_id = %L$s$, ta)), 'OK:0');
  perform pg_temp.expect('H6e outsider sees nothing', pg_temp.auth_as(u4, $s$select count(*) from public.messages$s$), 'OK:0');
  perform pg_temp.expect('H6e TA members see both TA messages', pg_temp.auth_as(u3, format($s$select count(*) from public.messages where trip_id = %L$s$, ta)), 'OK:2');

  -- (f) owner and sender deletion unchanged
  perform pg_temp.expect('H6f member cannot delete others', pg_temp.auth_as(u3, format($s$delete from public.messages where id = %L$s$, m1)), 'OK:0');
  perform pg_temp.expect('H6f owner deletes a member message', pg_temp.auth_as(u1, format($s$delete from public.messages where id = %L$s$, m3)), 'OK:1');
  raise notice 'PASS H6 messages: own edit ok, edited_at server-set, protected columns immutable, no cross-trip move, isolation holds';
end $$;

-- departed member: cannot edit any more, can still delete their own (policy unchanged)
do $$
declare
  u3 constant uuid := 'a3000000-0000-0000-0000-000000000003'; ta constant text := 'b1000000-0000-0000-0000-00000000000a';
begin
  perform pg_temp.expect('H6g U3 posts', pg_temp.auth_as(u3, format($s$insert into public.messages (id, trip_id, sender_id, content) values ('c3000000-0000-0000-0000-0000000000a4', %L, %L, 'before leaving')$s$, ta, u3)), 'OK:1');
  perform pg_temp.expect('H6g U3 leaves', pg_temp.auth_as(u3, format($s$delete from public.trip_members where trip_id = %L and user_id = auth.uid()$s$, ta)), 'OK:1');
  perform pg_temp.expect('H6g departed cannot edit', pg_temp.auth_as(u3, $s$update public.messages set content = 'edit after leaving' where id = 'c3000000-0000-0000-0000-0000000000a4'$s$), 'OK:0');
  -- the form with no column reference does not apply the SELECT policy; before 0019 the UPDATE policy alone let a
  -- departed sender edit here (OK:1). It must now be refused by the policy itself.
  perform pg_temp.expect('H6g departed cannot edit (no WHERE)', pg_temp.auth_as(u3, $s$update public.messages set content = 'edit after leaving'$s$), 'OK:0');
  perform pg_temp.expect('H6g departed cannot read the trip', pg_temp.auth_as(u3, format($s$select count(*) from public.messages where trip_id = %L$s$, ta)), 'OK:0');
  -- DELETE rules are not changed by 0019 (a filtered DELETE is already hidden by the SELECT policy once membership is gone)
  perform pg_temp.expect('H6g departed delete (filtered) unchanged', pg_temp.auth_as(u3, $s$delete from public.messages where id = 'c3000000-0000-0000-0000-0000000000a4'$s$), 'OK:0');
  raise notice 'PASS H6g departed member cannot edit in either statement form; read/delete behaviour unchanged';
end $$;

-- ===== H7: the RLS policy blocks the cross-trip move BY ITSELF =====
-- Re-grant the column privilege inside this transaction to prove layer 1 (policy) does not depend on layer 2 (column grants).
grant update (trip_id) on public.messages to authenticated;
do $$
declare
  u1 constant uuid := 'a1000000-0000-0000-0000-000000000001'; tb constant text := 'b2000000-0000-0000-0000-00000000000b';
  m1 constant text := 'c1000000-0000-0000-0000-0000000000a1'; f text;
begin
  foreach f in array array[
    format($s$update public.messages set trip_id = %L where id = %L$s$, tb, m1),
    format($s$update public.messages set trip_id = %L where sender_id = auth.uid()$s$, tb),
    format($s$update public.messages set trip_id = %L$s$, tb)         -- the form that moved messages before 0019
  ] loop
    perform pg_temp.expect('H7 '||f, pg_temp.auth_as(u1, f), 'ERR:42501');
  end loop;
  if (select trip_id::text from public.messages where id = m1::uuid) <> 'b1000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL H7: message moved although only the policy was in force';
  end if;
  raise notice 'PASS H7 policy alone refuses cross-trip moves (all three statement forms)';
end $$;
revoke update (trip_id) on public.messages from authenticated;

-- ===== H8: intended CRUD still works =====
do $$
declare
  u1 constant uuid := 'a1000000-0000-0000-0000-000000000001'; u2 constant uuid := 'a2000000-0000-0000-0000-000000000002';
  u4 constant uuid := 'a4000000-0000-0000-0000-000000000004'; ta constant text := 'b1000000-0000-0000-0000-00000000000a';
begin
  perform pg_temp.expect('H8 owner updates trip', pg_temp.auth_as(u1, format($s$update public.trips set name = 'TA renamed' where id = %L$s$, ta)), 'OK:1');
  perform pg_temp.expect('H8 non-owner updates trip', pg_temp.auth_as(u2, format($s$update public.trips set name = 'x' where id = %L$s$, ta)), 'OK:0');
  perform pg_temp.expect('H8 trip select (member)', pg_temp.auth_as(u1, format($s$select count(*) from public.trips where id = %L$s$, ta)), 'OK:1');
  perform pg_temp.expect('H8 trip select (outsider)', pg_temp.auth_as(u4, format($s$select count(*) from public.trips where id = %L$s$, ta)), 'OK:0');
  perform pg_temp.expect('H8 profile update own', pg_temp.auth_as(u1, format($s$update public.profiles set display_name = 'U1' where id = %L$s$, u1)), 'OK:1');
  perform pg_temp.expect('H8 profile update other', pg_temp.auth_as(u1, format($s$update public.profiles set display_name = 'x' where id = %L$s$, u2)), 'OK:0');
  perform pg_temp.expect('H8 member invites', pg_temp.auth_as(u1, format($s$insert into public.invitations (trip_id, inviter_id, invitee_email) values (%L, %L, 'New@T.test')$s$, ta, u1)), 'OK:1');
  perform pg_temp.expect('H8 inviter reads invitation', pg_temp.auth_as(u1, $s$select count(*) from public.invitations$s$), 'OK:1');
  perform pg_temp.expect('H8 invitation UPDATE still not possible', pg_temp.auth_as(u1, $s$update public.invitations set status = 'accepted'$s$), 'ERR:42501');
  perform pg_temp.expect('H8 direct trip_members insert blocked by RLS', pg_temp.auth_as(u4, format($s$insert into public.trip_members (trip_id, user_id, role) values (%L, %L, 'member')$s$, ta, u4)), 'ERR:42501');
  perform pg_temp.expect('H8 media select allowed', pg_temp.auth_as(u1, $s$select count(*) from public.media$s$), 'OK:0');
  perform pg_temp.expect('H8 media direct INSERT closed', pg_temp.auth_as(u1, format($s$insert into public.media (trip_id, uploader_id, storage_key, media_type, mime_type, file_size_bytes) values (%L, %L, 'k', 'photo', 'image/jpeg', 1)$s$, ta, u1)), 'ERR:42501');
  perform pg_temp.expect('H8 media direct UPDATE closed', pg_temp.auth_as(u1, $s$update public.media set processing_status = 'ready'$s$), 'ERR:42501');
  perform pg_temp.expect('H8 owner deletes trip', pg_temp.auth_as(u2, $s$delete from public.trips where id = 'b2000000-0000-0000-0000-00000000000b'$s$), 'OK:1');
  raise notice 'PASS H8 intended CRUD and RLS behaviour preserved (trips, profiles, invitations, trip_members, media)';
end $$;

-- ===== H9: service_role works through RPCs with no table privileges =====
do $$
declare r text;
begin
  r := pg_temp.run_as('service_role', null, $s$select (public.fail_media_upload('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid))::int$s$);
  -- the function must be callable; with no matching row it reports "nothing changed" (false -> 0)
  if r <> 'OK:0' then raise exception 'FAIL H9: service_role could not use the RPC path (%)', r; end if;
  perform pg_temp.expect('H9 service_role has no direct table access', pg_temp.run_as('service_role', null, 'select count(*) from public.media'), 'ERR:42501');
  -- both RPCs the app calls with the service-role key: EXECUTE granted, SECURITY DEFINER, owned by postgres
  select string_agg(format('%s(x=%s,sd=%s,owner=%s)', p::regprocedure, has_function_privilege('service_role', p, 'execute'),
                           pr.prosecdef, pg_get_userbyid(pr.proowner)), ' ')
    into r
  from (values ('public.confirm_media_upload(uuid,bigint,uuid)'::regprocedure), ('public.fail_media_upload(uuid,uuid)'::regprocedure)) v(p)
  join pg_proc pr on pr.oid = v.p
  where not (has_function_privilege('service_role', p, 'execute') and pr.prosecdef and pr.proowner = 'postgres'::regrole);
  if r is not null then raise exception 'FAIL H9: service-role RPC not usable as designed: %', r; end if;
  raise notice 'PASS H9 service_role operates through SECURITY DEFINER RPCs only (confirm + fail: EXECUTE, definer, owner postgres)';
end $$;

-- ===== H10: triggers still fire =====
do $$
begin
  if not exists (select 1 from public.profiles where id = 'a1000000-0000-0000-0000-000000000001') then raise exception 'FAIL H10: signup trigger did not create a profile'; end if;
  if (select count(*) from public.trip_members where trip_id = 'b1000000-0000-0000-0000-00000000000a' and role = 'owner') <> 1 then raise exception 'FAIL H10: trip-owner trigger did not run'; end if;
  raise notice 'PASS H10 profile and owner-membership triggers fire';
end $$;

-- ===== H11: forward guard for every table in public (Phase 7+) =====
do $$
declare bad text;
begin
  select string_agg(format('%s(owner=%s,rls=%s,anon=%s,public=%s)', c.relname, pg_get_userbyid(c.relowner), c.relrowsecurity,
                           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
                           has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')), ' ')
    into bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
    and (c.relowner <> 'postgres'::regrole or not c.relrowsecurity
         or has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  if bad is not null then raise exception 'FAIL H11: table(s) in public violate owner/RLS/no-anon rule: %', bad; end if;
  raise notice 'PASS H11 every table in public: owned by postgres, RLS enabled, nothing for PUBLIC/anon';
end $$;

rollback;
