-- 0018_media_confirm_hardening.sql
-- Phase 6 integration-review hardening. A NEW migration (rather than an edit of 0016) so it is correct
-- whether or not 0016 has already been applied to a given database; every statement is idempotent.
--
-- Changes (each verified against the real 0001-0018 chain; see supabase/tests/phase6_media_security_test.sql):
--
-- 1. is_trusted_server_role(): the service-role check used by the service-only functions accepts the
--    verified JWT `role` claim OR the session role PostgREST sets for the request (so a different
--    claim shape from the project's key type cannot silently break every confirm). `authenticated` and
--    `anon` can never satisfy it. Which signal the hosted project produces is UNKNOWN from the repo.
-- 2. confirm_media_upload(): uses that helper instead of an inline claim check. Logic otherwise as 0016.
-- 3. fail_media_upload(): marks the caller's own PENDING row 'failed' and now RETURNS WHETHER IT CHANGED
--    ANYTHING (boolean). confirmMediaUploadAction deletes the R2 object only when it did, and marks the
--    row failed BEFORE deleting, so a database failure can never leave a 'pending' row whose object is
--    gone (the upload client would retry confirm for it forever). Return type changes, hence drop+create.
-- 4. request_media_upload(): captured_at in the future is NULL (spec s13 / OD5; 0016 allowed +1 day, the
--    client code already treated any future time as unknown). Before 1990 is NULL as before.

-- ============ 1. trusted-server check ============
create or replace function public.is_trusted_server_role()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims text;
  v_role text;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  v_role := coalesce(v_claims::jsonb ->> 'role', nullif(current_setting('request.jwt.claim.role', true), ''));
  return v_role = 'service_role' or current_setting('role', true) = 'service_role';
end;
$$;

revoke all on function public.is_trusted_server_role() from public, anon, authenticated;

-- ============ 2. confirm_media_upload (same signature as 0016) ============
create or replace function public.confirm_media_upload(
  p_media_id uuid,
  p_actual_file_size_bytes bigint,
  p_caller_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media public.media;
  v_max_bytes bigint;
  v_is_member boolean;
begin
  -- Defence in depth (layer b): independent of EXECUTE grants.
  if not public.is_trusted_server_role() then
    raise exception 'confirm_media_upload is restricted to trusted server code';
  end if;

  if p_caller_id is null then
    raise exception 'Caller id is required';
  end if;

  select * into v_media
  from public.media
  where id = p_media_id
  for update;

  if v_media is null then
    raise exception 'Media not found';
  end if;

  if v_media.uploader_id is distinct from p_caller_id then
    raise exception 'Not authorized to confirm this upload';
  end if;

  select exists (
    select 1 from public.trip_members
    where trip_id = v_media.trip_id and user_id = p_caller_id
  ) into v_is_member;

  if not v_is_member then
    raise exception 'You are no longer a member of this trip';
  end if;

  if v_media.processing_status <> 'pending' then
    raise exception 'This upload has already been processed';
  end if;

  if p_actual_file_size_bytes is null or p_actual_file_size_bytes <= 0 then
    raise exception 'Invalid confirmed file size';
  end if;

  v_max_bytes := public.max_media_bytes_for_type(v_media.media_type);
  if p_actual_file_size_bytes > v_max_bytes then
    -- Return, do not raise: a raise would roll this UPDATE back (issue 2).
    update public.media set processing_status = 'failed' where id = p_media_id;
    return 'failed';
  end if;

  update public.media
  set processing_status = 'ready',
      file_size_bytes = p_actual_file_size_bytes,
      uploaded_at = now()
  where id = p_media_id;

  return 'ready';
end;
$$;

revoke all on function public.confirm_media_upload(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.confirm_media_upload(uuid, bigint, uuid) to service_role;

-- ============ 3. fail_media_upload (boolean) ============
drop function if exists public.fail_media_upload(uuid, uuid);

create function public.fail_media_upload(p_media_id uuid, p_caller_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_trusted_server_role() then
    raise exception 'fail_media_upload is restricted to trusted server code';
  end if;
  update public.media
  set processing_status = 'failed'
  where id = p_media_id
    and uploader_id = p_caller_id
    and processing_status = 'pending';
  -- true only if THIS call changed the row. The caller deletes the R2 object only in that case, so a
  -- concurrent confirm that already made the row 'ready' (or another caller that already failed it)
  -- never has its object deleted by a late, redundant call.
  return found;
end;
$$;

revoke all on function public.fail_media_upload(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fail_media_upload(uuid, uuid) to service_role;

-- ============ 4. request_media_upload: strict captured_at ============
create or replace function public.request_media_upload(
  p_trip_id uuid,
  p_mime_type text,
  p_file_size_bytes bigint,
  p_original_filename text default null,
  p_captured_at timestamptz default null,
  p_width integer default null,
  p_height integer default null,
  p_duration_seconds numeric default null
)
returns table (media_id uuid, storage_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_media_type text;
  v_max_bytes bigint;
  v_media_id uuid;
  v_storage_key text;
  v_extension text;
  v_safe_filename text;
  v_width integer;
  v_height integer;
  v_duration numeric;
  v_captured timestamptz;
begin
  if not public.is_trip_member(p_trip_id) then
    raise exception 'You must be a member of this trip to upload media';
  end if;

  v_media_type := public.media_type_for_mime(p_mime_type);
  if v_media_type is null then
    raise exception 'Unsupported file type: %', p_mime_type;
  end if;

  if p_file_size_bytes is null or p_file_size_bytes <= 0 then
    raise exception 'Invalid file size';
  end if;

  v_max_bytes := public.max_media_bytes_for_type(v_media_type);
  if p_file_size_bytes > v_max_bytes then
    raise exception 'File exceeds the % byte limit for %', v_max_bytes, v_media_type;
  end if;

  v_safe_filename := left(nullif(trim(p_original_filename), ''), 255);

  -- Data-quality normalisation (NULL comparisons yield NULL -> CASE gives NULL).
  -- captured_at: before 1990 or in the future -> NULL (spec s13/OD5; no tolerance).
  v_width := case when p_width between 1 and 100000 then p_width end;
  v_height := case when p_height between 1 and 100000 then p_height end;
  v_duration := case when p_duration_seconds > 0 and p_duration_seconds <= 86400 then p_duration_seconds end;
  v_captured := case
    when p_captured_at >= timestamptz '1990-01-01 00:00:00+00'
     and p_captured_at <= now() then p_captured_at
  end;

  v_extension := case p_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/heic' then 'heic'
    when 'image/heif' then 'heif'
    when 'video/mp4' then 'mp4'
    when 'video/quicktime' then 'mov'
    when 'video/webm' then 'webm'
  end;

  v_media_id := gen_random_uuid();
  v_storage_key := p_trip_id::text || '/' || v_media_id::text || '.' || v_extension;

  insert into public.media (
    id, trip_id, uploader_id, storage_key, media_type, original_filename,
    mime_type, file_size_bytes, width, height, duration_seconds,
    captured_at, processing_status
  )
  values (
    v_media_id, p_trip_id, auth.uid(), v_storage_key, v_media_type, v_safe_filename,
    p_mime_type, p_file_size_bytes, v_width, v_height, v_duration,
    v_captured, 'pending'
  );

  return query select v_media_id, v_storage_key;
end;
$$;

revoke all on function public.request_media_upload(uuid, text, bigint, text, timestamptz, integer, integer, numeric) from public, anon;
grant execute on function public.request_media_upload(uuid, text, bigint, text, timestamptz, integer, integer, numeric) to authenticated;
