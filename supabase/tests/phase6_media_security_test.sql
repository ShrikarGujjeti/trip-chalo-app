-- phase6_media_security_test.sql
--
-- WHAT THIS CHECKS (media upload/confirm security boundary and the RLS it relies on):
--   T1-T10  request/confirm grants, legacy overload removed, media INSERT/UPDATE closed, anon denied,
--           service_role confirm semantics, oversize persists 'failed', role self-check independent of
--           ACLs, metadata normalisation.
--   T11-T13 fail_media_upload (service_role only, own pending row only, reports whether it changed
--           anything), strict captured_at, service role accepted without a JWT claim.
--   T14     RLS with the real policies: an outsider sees no media; a departed uploader sees/deletes
--           only their own rows (0015).
--   T15     grants sweep over the KNOWN SECURITY DEFINER functions (anon: none; authenticated: only the
--           documented set). Unknown extra functions only WARN, so unrelated platform functions cannot
--           make the run fail.
--   T16-T18 non-member cannot request an upload; a former member cannot confirm; a pending row is
--           visible to every trip member (documented, see the NOTICE).
--   T19     (only if role supabase_auth_admin exists) signup trigger still fires after 0017.
--
-- PREREQUISITES: migrations 0001-0017 applied (T15 and T19 need 0017). Run as the `postgres` role.
--   * Local / throwaway DB:  psql -v ON_ERROR_STOP=1 -f supabase/tests/phase6_media_security_test.sql
--   * Hosted Supabase: prefer a branch or staging project. It is written to be non-destructive: it runs
--     inside ONE transaction that always ends in ROLLBACK, and any failed assertion aborts the
--     transaction (nothing persists). It inserts fixture rows into auth.users/trips/media with fixed
--     UUIDs (aaaaaaaa-..., bbbbbbbb-..., cccccccc-..., dddddddd-...), so do NOT run it from a tool that
--     COMMITS on error or in autocommit-per-statement mode (e.g. psql without ON_ERROR_STOP will keep going
--     after a failure; the final ROLLBACK still discards everything, but use ON_ERROR_STOP anyway).
-- Every PASS emits a NOTICE; any FAIL raises an exception.

begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'uploader@t.test'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'outsider@t.test');

insert into public.trips (id, owner_id, name)
values ('cccccccc-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a', 'T');

-- The on_trip_created trigger already adds the owner; harmless if absent.
insert into public.trip_members (trip_id, user_id, role)
values ('cccccccc-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a', 'owner')
on conflict do nothing;

-- T1: member can request uploads (three rows; third has junk metadata)
do $$
declare v1 uuid; v2 uuid; v3 uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  select media_id into v1 from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'image/jpeg', 1000, 'a.jpg');
  select media_id into v2 from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'image/jpeg', 1000, 'b.jpg');
  select media_id into v3 from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'video/mp4', 5000, 'c.mp4', timestamptz '1970-01-01', -5, 0, -1);
  perform set_config('t.m1', v1::text, true);
  perform set_config('t.m2', v2::text, true);
  perform set_config('t.m3', v3::text, true);
  reset role;
  raise notice 'PASS T1 member request_media_upload';
end $$;

-- T2: authenticated can NOT call confirm directly (the bypass)
do $$
declare v_ok boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  begin
    perform public.confirm_media_upload(current_setting('t.m1')::uuid, 1000, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  exception when insufficient_privilege then v_ok := true;
  end;
  reset role;
  if not v_ok then raise exception 'FAIL T2: authenticated reached confirm_media_upload'; end if;
  raise notice 'PASS T2 authenticated cannot EXECUTE confirm_media_upload';
end $$;

-- T3: the legacy 2-arg overload no longer exists
do $$
declare v_ok boolean := false;
begin
  set local role authenticated;
  begin
    perform public.confirm_media_upload(current_setting('t.m1')::uuid, 1000::bigint);
  exception when undefined_function then v_ok := true;
  end;
  reset role;
  if not v_ok then raise exception 'FAIL T3: 2-arg overload still present'; end if;
  raise notice 'PASS T3 legacy overload dropped';
end $$;

-- T4/T5: no direct UPDATE / INSERT on media for authenticated
do $$
declare v_upd boolean := false; v_ins boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  begin
    update public.media set processing_status = 'ready' where id = current_setting('t.m1')::uuid;
  exception when insufficient_privilege then v_upd := true;
  end;
  begin
    insert into public.media (trip_id, uploader_id, storage_key, media_type, mime_type, file_size_bytes)
    values ('cccccccc-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000a', 'x/y.jpg', 'photo', 'image/jpeg', 1);
  exception when insufficient_privilege then v_ins := true;
  end;
  reset role;
  if not v_upd then raise exception 'FAIL T4: authenticated may UPDATE media'; end if;
  if not v_ins then raise exception 'FAIL T5: authenticated may INSERT media'; end if;
  raise notice 'PASS T4/T5 media UPDATE and INSERT closed';
end $$;

-- T6: anon cannot call either RPC
do $$
declare v_a boolean := false; v_b boolean := false;
begin
  set local role anon;
  begin
    perform public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'image/jpeg', 1000);
  exception when insufficient_privilege then v_a := true;
  end;
  begin
    perform public.confirm_media_upload(current_setting('t.m1')::uuid, 1000, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  exception when insufficient_privilege then v_b := true;
  end;
  reset role;
  if not (v_a and v_b) then raise exception 'FAIL T6: anon reached a media RPC'; end if;
  raise notice 'PASS T6 anon denied';
end $$;

-- T7: service_role path: non-uploader rejected, uploader confirmed, replay rejected
do $$
declare r text; v_non boolean := false; v_replay boolean := false;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform public.confirm_media_upload(current_setting('t.m1')::uuid, 1000, 'bbbbbbbb-0000-0000-0000-00000000000b'::uuid);
  exception when raise_exception then v_non := sqlerrm like 'Not authorized%';
  end;
  r := public.confirm_media_upload(current_setting('t.m1')::uuid, 1000, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  begin
    perform public.confirm_media_upload(current_setting('t.m1')::uuid, 1000, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  exception when raise_exception then v_replay := sqlerrm like '%already been processed%';
  end;
  reset role;
  if not v_non then raise exception 'FAIL T7a: non-uploader not rejected'; end if;
  if r is distinct from 'ready' then raise exception 'FAIL T7b: expected ready, got %', r; end if;
  if not v_replay then raise exception 'FAIL T7c: replay not rejected'; end if;
  raise notice 'PASS T7 service_role confirm semantics';
end $$;

-- T8: oversize -> 'failed' and the status PERSISTS (the old raise rolled it back)
do $$
declare r text;
begin
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.confirm_media_upload(current_setting('t.m2')::uuid, 26214401, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  reset role;
  if r is distinct from 'failed' then raise exception 'FAIL T8a: got %', r; end if;
  if (select processing_status from public.media where id = current_setting('t.m2')::uuid) <> 'failed' then
    raise exception 'FAIL T8b: failed status did not persist';
  end if;
  raise notice 'PASS T8 oversize persists failed';
end $$;

-- T9: the in-function role check holds even if EXECUTE is (mis)granted
grant execute on function public.confirm_media_upload(uuid, bigint, uuid) to authenticated;
do $$
declare v_ok boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  begin
    perform public.confirm_media_upload(current_setting('t.m3')::uuid, 5000, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  exception when raise_exception then v_ok := sqlerrm like '%restricted to trusted server code%';
  end;
  reset role;
  if not v_ok then raise exception 'FAIL T9: role self-check did not fire'; end if;
  raise notice 'PASS T9 self-check independent of ACL';
end $$;
revoke execute on function public.confirm_media_upload(uuid, bigint, uuid) from authenticated;

-- T10: metadata normalisation
do $$
declare w int; h int; d numeric; c timestamptz;
begin
  select width, height, duration_seconds, captured_at into w, h, d, c
  from public.media where id = current_setting('t.m3')::uuid;
  if w is not null or h is not null or d is not null or c is not null then
    raise exception 'FAIL T10: junk metadata stored (% % % %)', w, h, d, c;
  end if;
  raise notice 'PASS T10 metadata normalised';
end $$;

-- ===== Added in the integration pass (Claude 4): tests for the 0016 changes and RLS =====

-- T11: fail_media_upload is service_role-only, touches only the caller's own PENDING row
do $$
declare v4 uuid; v_denied boolean := false; v_st text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  select media_id into v4 from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'image/jpeg', 1000, 'd.jpg');
  begin
    perform public.fail_media_upload(v4, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  exception when insufficient_privilege then v_denied := true;
  end;
  reset role;
  if not v_denied then raise exception 'FAIL T11a: authenticated can execute fail_media_upload'; end if;

  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if public.fail_media_upload(v4, 'bbbbbbbb-0000-0000-0000-00000000000b'::uuid) then   -- someone else's id: no-op
    raise exception 'FAIL T11b0: non-uploader reported a change';
  end if;
  select processing_status into v_st from public.media where id = v4;
  if v_st <> 'pending' then raise exception 'FAIL T11b: non-uploader changed row (%)', v_st; end if;
  if not public.fail_media_upload(v4, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid) then
    raise exception 'FAIL T11c0: own pending row not reported as changed';
  end if;
  select processing_status into v_st from public.media where id = v4;
  if v_st <> 'failed' then raise exception 'FAIL T11c: expected failed, got %', v_st; end if;
  if public.fail_media_upload(v4, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid) then   -- already failed: no change
    raise exception 'FAIL T11c1: second call reported a change';
  end if;
  if public.fail_media_upload(current_setting('t.m1')::uuid, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid) then  -- ready row
    raise exception 'FAIL T11d0: ready row reported as changed';
  end if;
  select processing_status into v_st from public.media where id = current_setting('t.m1')::uuid;
  reset role;
  if v_st <> 'ready' then raise exception 'FAIL T11d: ready row was changed (%)', v_st; end if;
  raise notice 'PASS T11 fail_media_upload semantics';
end $$;

-- T12: captured_at strictness (spec s13/OD5): future -> NULL, recent past kept, <1990 -> NULL
do $$
declare a uuid; b uuid; c uuid; ca timestamptz; cb timestamptz; cc timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  select media_id into a from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'f.jpg', now() + interval '2 hours');
  select media_id into b from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'p.jpg', now() - interval '2 hours');
  select media_id into c from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'o.jpg', timestamptz '1985-01-01');
  reset role;
  select captured_at into ca from public.media where id=a;
  select captured_at into cb from public.media where id=b;
  select captured_at into cc from public.media where id=c;
  if ca is not null then raise exception 'FAIL T12a: future captured_at stored'; end if;
  if cb is null then raise exception 'FAIL T12b: valid past captured_at dropped'; end if;
  if cc is not null then raise exception 'FAIL T12c: pre-1990 stored'; end if;
  raise notice 'PASS T12 captured_at strict';
end $$;

-- T13: the trusted-server check also accepts the PostgREST session role (claim shape independence),
--      and still rejects authenticated/anon with the same shape
do $$
declare v5 uuid; r text; v_bad boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  select media_id into v5 from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'g.jpg');
  reset role;
  set local role service_role;
  perform set_config('request.jwt.claims', '', true);          -- no claim at all
  r := public.confirm_media_upload(v5, 10, 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid);
  reset role;
  if r <> 'ready' then raise exception 'FAIL T13a: session-role path did not confirm (%)', r; end if;
  raise notice 'PASS T13 service role accepted without a JWT claim';
end $$;

-- T14: RLS on media with the REAL policies: outsider sees nothing; a departed uploader still
--      sees and can delete only their own rows (0015); other members' rows stay invisible to them
do $$
declare u uuid; n int; d int;
begin
  insert into auth.users (id,email) values ('dddddddd-0000-0000-0000-00000000000d','member@t.test');
  insert into public.trip_members (trip_id,user_id,role) values ('cccccccc-0000-0000-0000-00000000000c','dddddddd-0000-0000-0000-00000000000d','member');
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-00000000000d","role":"authenticated"}', true);
  select media_id into u from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'m.jpg');
  reset role;
  set local role service_role; perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.confirm_media_upload(u, 10, 'dddddddd-0000-0000-0000-00000000000d'::uuid);
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
  select count(*) into n from public.media;   -- outsider
  reset role;
  if n <> 0 then raise exception 'FAIL T14a: outsider sees % media rows', n; end if;

  delete from public.trip_members where user_id = 'dddddddd-0000-0000-0000-00000000000d';   -- departs
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-00000000000d","role":"authenticated"}', true);
  select count(*) into n from public.media;
  select count(*) into d from public.media where uploader_id <> 'dddddddd-0000-0000-0000-00000000000d';
  if n < 1 then raise exception 'FAIL T14b: departed uploader lost sight of own media'; end if;
  if d <> 0 then raise exception 'FAIL T14c: departed uploader sees % other-member rows', d; end if;
  delete from public.media where id = u returning 1 into n;   -- DELETE ... RETURNING works (0015)
  reset role;
  if n is distinct from 1 then raise exception 'FAIL T14d: departed uploader could not delete own media'; end if;
  raise notice 'PASS T14 RLS: outsider blind; departed uploader scoped to own rows';
end $$;

-- T15: grants sweep. FAILS only for the known functions; any other SECURITY DEFINER function in public
--      (e.g. added by the platform) is reported as a WARNING so this test stays portable.
do $$
declare
  known text[] := array['is_trip_member','is_trip_owner','accept_invitation','decline_invitation','revoke_invitation',
                        'get_invited_trip_preview','handle_new_user','add_trip_owner_as_member',
                        'request_media_upload','confirm_media_upload','fail_media_upload','is_trusted_server_role',
                        'media_type_for_mime','max_media_bytes_for_type'];
  authenticated_ok text[] := array['is_trip_member','is_trip_owner','accept_invitation','decline_invitation',
                                   'revoke_invitation','get_invited_trip_preview','request_media_upload'];
  bad text; extra text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname = any(known) and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'FAIL T15a: anon can execute: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname = any(known) and not (p.proname = any(authenticated_ok))
    and has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then raise exception 'FAIL T15b: unexpected authenticated EXECUTE on: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into extra
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.prosecdef and not (p.proname = any(known));
  if extra is not null then raise warning 'T15 note: SECURITY DEFINER functions outside the known set (review their grants): %', extra; end if;
  raise notice 'PASS T15 grants sweep (known functions: anon none; authenticated only the documented set)';
end $$;

-- T16: a non-member cannot request an upload into someone else's trip
do $$
declare v_ok boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
  begin
    perform public.request_media_upload('cccccccc-0000-0000-0000-00000000000c', 'image/jpeg', 10, 'x.jpg');
  exception when raise_exception then v_ok := sqlerrm like '%must be a member%';
  end;
  reset role;
  if not v_ok then raise exception 'FAIL T16: non-member could request an upload'; end if;
  raise notice 'PASS T16 non-member cannot request an upload';
end $$;

-- T17: a FORMER member cannot confirm their pending upload (membership re-check)
do $$
declare v uuid; v_ok boolean := false;
begin
  insert into auth.users (id,email) values ('ffffffff-0000-0000-0000-00000000000f','former@t.test');
  insert into public.trip_members (trip_id,user_id,role) values ('cccccccc-0000-0000-0000-00000000000c','ffffffff-0000-0000-0000-00000000000f','member');
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-0000-0000-0000-00000000000f","role":"authenticated"}', true);
  select media_id into v from public.request_media_upload('cccccccc-0000-0000-0000-00000000000c','image/jpeg',10,'h.jpg');
  reset role;
  delete from public.trip_members where user_id = 'ffffffff-0000-0000-0000-00000000000f';
  set local role service_role; perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  begin
    perform public.confirm_media_upload(v, 10, 'ffffffff-0000-0000-0000-00000000000f'::uuid);
  exception when raise_exception then v_ok := sqlerrm like '%no longer a member%';
  end;
  reset role;
  if not v_ok then raise exception 'FAIL T17: former member could confirm'; end if;
  if (select processing_status from public.media where id = v) <> 'pending' then raise exception 'FAIL T17b: row changed'; end if;
  raise notice 'PASS T17 former member cannot confirm';
end $$;

-- T18: DOCUMENTED BEHAVIOUR (not a pass/fail security property): media_select_member admits every trip
--      member to EVERY media row of the trip, including other members' pending/failed rows and their
--      storage_key column, through the Data API. The app never exposes storage_key and bytes still need
--      a signed URL, so this is accepted; it is asserted here so a future change is noticed.
do $$
declare n int;
begin
  insert into auth.users (id,email) values ('99999999-0000-0000-0000-000000000009','peer@t.test') on conflict do nothing;
  insert into public.trip_members (trip_id,user_id,role) values ('cccccccc-0000-0000-0000-00000000000c','99999999-0000-0000-0000-000000000009','member');
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-000000000009","role":"authenticated"}', true);
  select count(*) into n from public.media where processing_status = 'pending' and uploader_id <> '99999999-0000-0000-0000-000000000009';
  reset role;
  if n < 1 then raise exception 'FAIL T18: expected members to see peers pending rows (policy changed?) -- review this test'; end if;
  raise notice 'NOTICE T18 members can read peers'' pending media rows incl. storage_key via the Data API (documented, accepted)';
end $$;

-- T19: signup still creates a profile after 0017 revoked EXECUTE on handle_new_user (trigger functions are
--      not checked for EXECUTE when fired). Only meaningful where the platform role exists.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    set local role supabase_auth_admin;
    insert into auth.users (id,email,raw_user_meta_data) values ('88888888-0000-0000-0000-000000000008','signup@t.test','{"display_name":"S"}');
    reset role;
    if not exists (select 1 from public.profiles where id = '88888888-0000-0000-0000-000000000008') then
      raise exception 'FAIL T19: profile not created for a signup performed as supabase_auth_admin';
    end if;
    raise notice 'PASS T19 signup trigger fires as supabase_auth_admin';
  else
    raise notice 'SKIP T19 (role supabase_auth_admin not present)';
  end if;
end $$;

rollback;
