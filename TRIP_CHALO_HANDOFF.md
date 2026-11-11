# Trip Chalo — Session Handoff

> Short-lived bridge between sessions. The repository, database, tests, and Git state are authoritative.

## Current state

- **Phase:** 6 — Media.
- **Repository:** branch `phase6-integration`, HEAD `77edda3` (`docs: add phase 6 experience spec`). The Phase 6 implementation and verification changes are uncommitted.
- **Hosted systems:** no hosted Supabase migration, production R2 action, deployment, commit, or push is reported.
- **Experience specification:** `TRIP_CHALO_PHASE6_EXPERIENCE_SPEC_v2.md` remains the product contract; it is not evidence of runtime verification.

## Phase 6 verification

The following is **user-reported and was not rerun during this documentation update**:

- `npm run test:phase6`: 56/56 passed.
- Local Supabase reset applied migrations `0001`–`0018`; SQL security tests T1–T19 passed on local PostgreSQL 17 as `supabase_admin`.
- Lint: 0 errors and 1 warning about `<img>` in `MemberAvatar.tsx`. Whether the warning predates the Phase 6 work is unknown.

Local database tests do not establish hosted Supabase behavior. Live Cloudflare R2, browser/device, and two-account UI behavior are not verified here.

## Database security hardening (0019) — prepared, not applied

- `supabase/migrations/0019_security_hardening.sql` and
  `supabase/tests/phase6_security_hardening_test.sql` are in the working tree.
- Replay evidence (PostgreSQL 17, hosted-like roles/defaults) is recorded in
  `TRIP_CHALO_CURRENT_STATE.md`. Hosted state was inspected read-only: `0001`–`0018`
  recorded, tables empty.
- Apply order: run `npx supabase db reset` locally, run both SQL suites as `postgres`
  (17 + 11 PASS lines), run hosted Q0 and save its output, then (with explicit approval)
  `npx supabase db push`, then the read-only Q1–Q9 in
  `docs/PHASE6_0019_DEPLOYMENT_RUNBOOK.md`, then the two-user Data API check (runbook §6).
- `0019` is forward-only; the runbook's §7 reversal is for emergencies only.
- Phase 7 rule: new tables are created by `postgres`, enable RLS and GRANT explicitly
  (no automatic grants any more); chat edits `content` only. H11 enforces the first part.

## Next steps

0. Apply and verify `0019` as above (nothing else is blocked on it except calling Phase 6 security-closed).

1. Review the full uncommitted application and migration changes before any deployment.
2. If proceeding to hosted verification, first inspect the linked project’s migration state and use an appropriate staging/branch database.
3. Exercise the real R2 upload, confirmation, URL, and deletion flows.
4. Run browser/device and two-account checks; record results separately from local test results.
5. Recheck Git status and diff before deciding on commit/push.

## Guardrails

- Preserve the existing working tree; do not reset, restore, or replace implementation changes with the downloaded overlay.
- Do not edit already-applied migrations; add a new migration for future schema changes.
- Do not treat user-reported results as independently reproduced.
- Keep `storage_key` and R2 signing credentials server-side.
- Keep the Phase 6 Experience Specification unchanged unless the user asks for a spec revision.

## Fresh-session reading order

Read `CLAUDE.md`, this handoff, `TRIP_CHALO_CURRENT_STATE.md`, and the relevant Phase 6 sections of `TRIP_CHALO_DECISION_LOG.md` and `TRIP_CHALO_MASTER.md`. Then inspect current Git and repository state before consequential work.
