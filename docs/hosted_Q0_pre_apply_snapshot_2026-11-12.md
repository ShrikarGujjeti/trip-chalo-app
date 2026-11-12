# Hosted Q0 pre-apply snapshot (migration 0019 NOT applied)

- Project: `wfpcgrdgltogoeuofhdt` (PostgreSQL 17.6)
- Captured: 2026-11-11 22:06:50 UTC (2026-11-12 03:36 IST), read-only catalog SELECT, as role `postgres`
- Query: Q0 from `docs/PHASE6_0019_VERIFY_QUERIES.sql`, plus a migrations row and a timestamp row
- Migrations recorded: latest `0018`, 18 rows. `0019` is not applied.

## Table ACLs (public schema)

| table | ACL |
|---|---|
| invitations | `{postgres=arwdDxtm/postgres,authenticated=arDxtm/postgres,service_role=Dxtm/postgres}` |
| media | `{postgres=arwdDxtm/postgres,authenticated=rdxtm/postgres,service_role=xtm/postgres}` |
| messages | `{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` |
| profiles | `{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` |
| trip_members | `{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` |
| trips | `{postgres=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` |

Column-level ACLs: none. PUBLIC grants: none (no `=...` entry in any ACL).

## Default ACLs of role `postgres`

| schema | type | ACL |
|---|---|---|
| public | S (sequences) | `{postgres=rwU/postgres}` |
| public | f (functions) | `{postgres=X/postgres}` |
| public | r (tables) | `{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}` |
| storage | S | `{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}` |
| storage | f | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| storage | r | `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}` |
| GLOBAL | any | **no row** |

## messages policies

| policy | USING | WITH CHECK |
|---|---|---|
| messages_select_member | `is_trip_member(trip_id)` | |
| messages_insert_member | | `(is_trip_member(trip_id) AND (sender_id = auth.uid()))` |
| messages_update_sender | `(sender_id = auth.uid())` | `(sender_id = auth.uid())` |
| messages_delete_sender_or_owner | `((sender_id = auth.uid()) OR is_trip_owner(trip_id))` | |

Triggers on messages: none (so `messages_set_edited_at` is not present yet).

## Result vs expectation (runbook section 3)

Every value matches the expected pre-apply state. No `<GLOBAL>` default row, no PUBLIC grants, no column ACLs, no unexpected entries.
The `media` ACL still lacks TRUNCATE for `authenticated`/`service_role`, which is the known unexplained difference that 0019 normalises.

## Reversal

The emergency reversal SQL in runbook section 7 reproduces exactly this state (tested locally).
