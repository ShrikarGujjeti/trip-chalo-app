# Phase 6 — migration 0019 deployment runbook

Status: **`0019` is applied to the hosted project** (by the project owner; hosted
`schema_migrations` records `0019`) and catalog-verified (Q0–Q9, 2026-11-12). Section 6
(real Data API check on hosted) is not done (planned for the next dedicated security-testing pass) and the R2 flow is deliberately deferred (R2 not enabled); a local two-user Data API
test is recorded in `TRIP_CHALO_CURRENT_STATE.md`. The steps below are kept as the
record. Any command that changes the hosted database still requires explicit approval first.

## 0. What 0019 changes (and does not)

Changes:
- table privileges on the six application tables, reset to the intended grants for PUBLIC, `anon`, `authenticated`
  and `service_role` (a table-level REVOKE also clears column-level grants);
- the default privileges for future tables created by `postgres`, both scoped to `public` and at the global level
  (PostgreSQL adds a schema-scoped default to the global one, so the schema-scoped revoke alone cannot cancel a
  global grant; hosted has no global entry today, so that statement is a no-op there);
- the `messages_update_sender` policy (membership required on the old and the new row);
- `UPDATE` on `messages` limited to the `content` column;
- a trigger that sets `messages.edited_at`.

Nothing else changes: no function, policy, constraint or index of the media, invitation or membership design is
modified, and no rows are touched. Hosted tables had 0 rows in messages, media and trips on 2026-11-12.

Product behaviour change to confirm: **a member who has left a trip can no longer edit its messages.** No app code
edits messages today (the chat module is empty), so nothing in the app changes now. Phase 7 chat must edit
`content` only, never move a message, and leave `edited_at` to the database.

Not changed: `supabase_admin` default privileges (platform-managed; application migrations do not run as that role);
the global PUBLIC EXECUTE default on functions (see H4b in the test); `profiles`/`trip_members` grants that exceed
their policies (RLS already denies them).

Forward-only: there is no down migration. See section 7.

## 1. Before touching anything

1. Working-tree sanity (local): the repository blobs on `phase6-integration` use LF; a Windows checkout with CRLF
   makes every tracked text file look modified. Check:
   `git diff --stat` versus `git diff --ignore-cr-at-eol --stat`. If the second is empty/small, the "modified
   migrations 0001-0015" are line endings only. Do not `git reset`/`checkout .`. Consider adding a
   `.gitattributes` (`* text=auto eol=lf`) in a separate commit.
2. Copy the overlay files in. Do not re-run earlier overlays.

## 2. Local verification (PostgreSQL 17, same as hosted)

```
npx supabase db reset                      # applies 0001-0019 as role postgres
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_media_security_test.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_security_hardening_test.sql
```

Both must run as the **`postgres`** role; the hardening test fails immediately under any other role (it never
skips). Expect 17 `PASS` lines from the media suite (T18 is a documented NOTICE, not a PASS) and 11 from the
hardening suite (H1, H2/H3, H4/H5, H4b, H6, H6g, H7, H8, H9, H10, H11), and no `FAIL`. Both files end in `ROLLBACK`.
Then run `docs/PHASE6_0019_VERIFY_QUERIES.sql` locally and compare with section 5.

## 3. Hosted pre-checks (read-only; SQL Editor)

1. Run **Q0** from `docs/PHASE6_0019_VERIFY_QUERIES.sql` and **save its output**. It is the exact pre-apply record
   and the input for any reversal. Expected (state read on 2026-11-12; ACL entry order may differ):

   | object | ACL |
   |---|---|
   | invitations | `{postgres=arwdDxtm/postgres,authenticated=arDxtm/postgres,service_role=Dxtm/postgres}` |
   | media | `{postgres=arwdDxtm/postgres,authenticated=rdxtm/postgres,service_role=xtm/postgres}` |
   | messages, profiles, trip_members, trips | `{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` |
   | column ACLs | none |
   | postgres default, `public`, `r` | `{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}` |
   | postgres default, `<GLOBAL>` | **no row** |
   | messages_update_sender | `(sender_id = auth.uid()) | (sender_id = auth.uid())` |

   If Q0 shows a `<GLOBAL>` row for `postgres`, PUBLIC entries, column ACLs or anything else not listed, stop and
   review before applying. 0019 would still normalise them, but the database has drifted in a way nobody expected.
2. Migrations and row counts:

```sql
select version, name from supabase_migrations.schema_migrations order by version;   -- expect 0001 ... 0018, no 0019
select (select count(*) from public.messages) messages, (select count(*) from public.media) media, (select count(*) from public.trips) trips;
```

## 4. Apply (needs your approval)

```
npx supabase db push --dry-run      # must list only 0019
npx supabase db push
```

The migration is one transaction (no statement requires its own). If it fails nothing is applied; re-run
`npx supabase migration list --linked` and compare with the hosted `schema_migrations` before doing anything
else. Do not mark a migration as applied or repaired without establishing the real database state.

## 5. Post-apply verification (read-only; SQL Editor)

Run Q1-Q9 in `docs/PHASE6_0019_VERIFY_QUERIES.sql`. Q1, Q3 and Q8 measure EFFECTIVE access (`has_table_privilege` /
`has_column_privilege`), so grants via PUBLIC or role membership are included. Expected:

| Query | Expected |
|---|---|
| Q1 | for each of the six tables: `public`, `anon`, `service_role` empty; `authenticated`: invitations `INSERT, SELECT`; media `DELETE, SELECT`; messages `DELETE, INSERT, SELECT`; profiles/trip_members/trips `DELETE, INSERT, SELECT, UPDATE`. **No TRUNCATE/REFERENCES/TRIGGER/MAINTAIN anywhere.** |
| Q2 | `public` / `r` is `{postgres=arwdDxtm/postgres}` only; `public` / `S` and `f` unchanged; `storage` rows unchanged (platform-owned schema, not touched); **no `<GLOBAL>` row** |
| Q3 | exactly one row: `authenticated` / `content` |
| Q4 | `messages_update_sender`: `qual` and `with_check` both `((sender_id = auth.uid()) AND is_trip_member(trip_id))` |
| Q5 | one trigger `messages_set_edited_at`, enabled `O`, `security_definer` false, `anon_x`/`auth_x`/`service_x` all false |
| Q6 | zero rows |
| Q7 | same counts as before |
| Q8 | six rows: owner `postgres`, `rls` true, `anon_any` false, `public_any` false |
| Q9 | `confirm_media_upload(uuid,bigint,uuid)` and `fail_media_upload(uuid,uuid)`: `security_definer` true, owner `postgres`, `service_x` true, `auth_x` false, `anon_x` false |

If anything differs, stop and report it; do not "fix" by hand.

## 6. Behavioural check through the real Data API (not executed; recommended before calling Phase 6 closed)

This is the only test that exercises the real PostgREST/JWT path; the SQL suites run as database roles with a
simulated JWT. Use a **branch/staging** project if one is available. Otherwise use two throwaway accounts on hosted
right after applying, with your approval, and delete them afterwards.

With user A (member of TA only) and user B (owner of TB):
- `PATCH /rest/v1/messages?id=eq.<A's message>` with `{"trip_id": "<TB>"}` → permission denied for column `trip_id`;
- the same with `?sender_id=eq.<A>` → denied;
- `PATCH` of `{"content": "..."}` on A's own message → 200; `edited_at` is now set;
- `PATCH` of `{"edited_at": "2000-01-01"}` → denied;
- B lists messages of TB → never sees A's message.
- With the service-role key: the media confirm flow still works end to end. This needs R2, which is deliberately
  not enabled (deferred); it is not part of this checkpoint.

## 7. Reversal (emergency only)

0019 is forward-only. Its rollback is not a down migration: the pre-apply ACLs were not uniform (`media` differs), so
the only correct reversal is one derived from the target's own Q0 output. The SQL below was derived from the hosted
Q0 of 2026-11-12. It was replayed locally on top of 0019 and reproduced that snapshot exactly (ACL entry order
aside). **It reopens the cross-trip message path and the excess privileges.** Use it only if 0019 breaks something
and the forward fix cannot wait, and only after re-checking it against the Q0 you saved in section 3.

```sql
begin;
revoke all on table public.profiles, public.trips, public.trip_members, public.invitations, public.media, public.messages
  from public, anon, authenticated, service_role;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on public.profiles, public.trips, public.trip_members, public.messages to authenticated;
grant select, insert, truncate, references, trigger, maintain on public.invitations to authenticated;
grant select, delete, references, trigger, maintain on public.media to authenticated;
grant truncate, references, trigger, maintain
  on public.profiles, public.trips, public.trip_members, public.invitations, public.messages to service_role;
grant references, trigger, maintain on public.media to service_role;
alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;
alter policy messages_update_sender on public.messages using (sender_id = auth.uid()) with check (sender_id = auth.uid());
drop trigger if exists messages_set_edited_at on public.messages;
drop function if exists public.set_message_edited_at();
commit;
```

This changes the database outside the migration history, so it leaves `0019` recorded as applied. Ship the real
fix as `0020`. Do not delete the `0019` row from `schema_migrations`.

## 8. Not covered here

R2 (deliberately not enabled; its upload/confirm lifecycle testing is deferred to a later Phase 6 stage), real browser/device
checks, the Phase 5 invitation UI, and the origin of the hosted `media` ACL difference (no `TRUNCATE` for
`authenticated`/`service_role`; no recorded migration statement explains it). 0019 normalises it, and the local
replay confirmed that normalising from that state gives the same final ACLs as a clean replay.
