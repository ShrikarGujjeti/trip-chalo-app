# Trip Chalo Phase 7 — Single-Claude Implementation Plan

Nov 12, 2026 · @Shrikar

One Claude session builds Phase 7 chat batch by batch on top of Phase 6 (`phase6-integration` @ `3728041`), runs its own tests, and stops at four gates for your approval. Independent review is done by a fresh reviewer session, not by the session that wrote the code.

## 1. What changed since v2.1

The design from v2.1 stands. Three facts changed how it is run, and one changed the migration.

| Change | Effect on the plan |
| --- | --- |
| One Claude account instead of four workers and a reviewer | No file ownership split, no merge order. Work runs as sequential batches in one repo session that can run its own tests. The Realtime hook is built before the UI, so no stub is needed. |
| Independent review still required | The writing session cannot grade itself. At Gate 1 and Gate 3 a fresh session (or a fresh subagent) reviews with no access to the writer's reasoning. |
| Phase 6 added `0019_security_hardening.sql` (commit `3728041`, 2026-11-11) | Phase 7's migration becomes **0020**. 0019 already removed the excess default privileges (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) and narrowed messages to SELECT, INSERT, DELETE, UPDATE(content). So D13 from v2.1 is resolved, and 0020 only needs to revoke INSERT, UPDATE and DELETE. |
| `AGENTS.md` deleted on both branches | Prompts no longer reference it. The Next.js 16 rule (read `node_modules/next/dist/docs` before writing Next code) moves into the prompt. |
| Phase 6 treated as done | Phase 6 is not reopened. One closure step remains outside Phase 7: the merge into `main`. `0019` was applied on hosted (re-verified 2026-11-12). |

## 2. Starting point (checked 2026-11-12)

| Fact | Status |
| --- | --- |
| `phase6-integration` HEAD `3728041` "feat: add phase 6 security hardening migration", on top of `14c283e` (AGENTS.md deleted) and `4f3d8bd` (Phase 6 media) | VERIFIED |
| `main` HEAD `1049862` (AGENTS.md deleted) on top of `77edda3`. No pull request; Phase 6 is not merged into `main` | VERIFIED |
| Migrations in the repo: `0001`–`0019`. Next free number: `0020` | VERIFIED |
| Hosted Supabase `trip-chalo` (ap-south-1, Postgres 17): `0001`–`0019` applied (re-checked 2026-11-12), `0020` not applied | VERIFIED |
| `0019` on messages: revoke all, then grant SELECT, INSERT, DELETE and UPDATE(content) to `authenticated`; UPDATE policy requires membership on old and new row; `edited_at` set by trigger; future tables get no automatic API privileges | VERIFIED (read from source) |
| Hosted `messages`: 0 rows, RLS on, only constraint `char_length(content) > 0`, not in `supabase_realtime` | VERIFIED again 2026-11-12: the 0019 state is present on hosted (grants SELECT, INSERT, DELETE and UPDATE(content); trigger messages\_set\_edited\_at; four policies; 0 rows; no send\_message or list functions; still not in the Realtime publication). Batch 0 re-checks. |
| An owner can already delete another member's `trip_members` row (`trip_members_delete_self_or_owner`) | VERIFIED |
| `src/modules/chat/` holds only `.gitkeep`. Test runner: `npm run test:phase6` (tsc + `node:test`), SQL tests in `supabase/tests/` | VERIFIED |
| `CLAUDE.md` workflow: inspect, design, approval, implement, verify, review, document, commit. Graphify map in `graphify-out/wiki` | VERIFIED |
| No Trip Chalo deployment on Vercel. Live R2 not verified (Cloudflare account reports R2 not enabled) | VERIFIED. Outside Phase 7 |

**Preconditions before any Phase 7 migration reaches hosted:** `0019` is applied on hosted (re-verified 2026-11-12), so this precondition is met. Merging Phase 6 into `main` is recommended before Phase 7 merges, but does not block Phase 7 work.

## 3. Design of record

Carried over from v2.1 unchanged except where marked **(new)**.

**Scope.** One private text conversation per trip: persisted history, live delivery, sender and time shown, loading, empty, sending, failure, retry and reconnect states. Excluded: attachments, edit, delete, reactions, read receipts, typing, presence, notifications, unread counts, linkification, AI features, new infrastructure.

### 3.1 Migration `0020_chat.sql` (new number)

1. `revoke insert, update, delete on public.messages from authenticated;` leaving only SELECT from 0019. The 0007 policies and the 0019 trigger stay in place, unused. **(new: scoped to what 0019 left)**
2. `CHECK (char_length(content) between 1 and 2000)`. The table has 0 rows, so add and validate directly; Batch 0 confirms the count first.
3. Index `(trip_id, created_at, id)`. The old `(trip_id, created_at)` index stays.
4. `send_message(p_id uuid, p_trip_id uuid, p_content text) returns public.messages`: SECURITY DEFINER, `search_path = ''`. Steps in this order:
   1. `auth.uid()` is null → `not_signed_in`.
   2. Lock the caller's `trip_members` row `FOR NO KEY UPDATE`; none → `not_member`.
   3. Content rule (3.2) → `invalid_content`.
   4. Idempotent lookup: row with this `id`, same sender, same trip, same stored content → return it.
   5. Rate limit: more than 30 messages by this sender in this trip in the last minute → `rate_limited`.
   6. `insert ... on conflict (id) do nothing returning *`.
   7. Nothing inserted → re-select the step-4 predicate; found → return it.
   8. Otherwise `failed`, with no hint about who owns the colliding id.
5. `list_messages_page(p_trip_id, p_before_at timestamptz, p_before_id uuid, p_limit int)` and `list_messages_since(p_trip_id, p_newest_at timestamptz, p_limit int)`: SECURITY INVOKER (RLS applies), limit capped at 100, `limit+1` rows to detect more. `before`: `(created_at, id) < (p_before_at, p_before_id)`, newest first; both parts or neither. `since`: `created_at >= p_newest_at - interval '30 seconds'`, ascending.
6. Function grants: `revoke all ... from public, anon`, `grant execute ... to authenticated` (0017 explains why `revoke from public` alone is not enough).
7. Idempotent `supabase_realtime` add for `public.messages`, guarded by `pg_publication` / `pg_publication_tables`.

Error codes are raised as stable messages the server maps: `not_signed_in`, `not_member`, `invalid_content`, `rate_limited`, `failed`.

### 3.2 Content rule (one rule in SQL, server and client)

- Reject U+0000 and C0 controls other than tab, LF, CR.
- Raw length at most 2,000 code points, checked before trimming (`Array.from(s).length` in JS, `char_length` in SQL).
- Trim this explicit set only: U+0009–000D, 0020, 00A0, 1680, 2000–200A, 2028, 2029, 202F, 205F, 3000, FEFF.
- Store the trimmed text; it must be non-empty; no other normalization. SQL is authoritative.

### 3.3 Reading, cursor and reconciliation

- Initial page from the Server Component. Older pages and gap-fill call the two list RPCs from the browser client through RLS. Send uses a Server Action.
- Cursor `{ createdAt, id }`: `createdAt` is the exact text the database returned and never goes through `Date`. Wire form `v1.<base64url(createdAt|id)>`. Invalid cursor returns the same result as an empty page.
- On every `SUBSCRIBED` (first and each reconnect): `list_messages_since(newest.createdAt)`, merge by `id`. If `hasMoreNewer`, discard the list, reload the latest page, set `hasMoreOlder = true`. This also closes the gap between server render and subscribe.
- Realtime: Postgres Changes, INSERT on `public.messages`, filter `trip_id=eq.<id>`. Events are never treated as authorization. Unknown `senderId` → refresh members once, then "A former member".
- Send: `clientId` from `crypto.randomUUID()`, falling back to `getRandomValues` on insecure origins (phone testing over LAN IP). Optimistic row; retry reuses `clientId`. A `not_member` reply triggers a membership recheck before showing the permanent state.
- No "instant revocation" claim anywhere. Leaving and owner removal are both tested; the result decides what the docs say.

### 3.4 Interface and UI

- Route `src/app/(app)/trips/[tripId]/chat/page.tsx`; one "Chat" link added to the trip header, nothing else on the trip page.
- `role="log"`, chronological DOM, `MemberAvatar`, local time formatted client-side, day separators, own messages distinguishable without colour alone, pending and failed with Retry.
- Composer: 16px textarea, code-point counter near the limit, no send while empty or in flight. Enter does not send during IME composition. Touch: Enter is a newline, the button sends. Desktop: Enter sends, Shift+Enter newline.
- Scroll: open at bottom; auto-scroll only near the bottom, otherwise a "New messages" button; position kept when older messages are prepended.
- Phase 6 tokens from `globals.css`, light mode, 44px targets, visible focus, reduced motion, `dvh` and safe-area insets, plain-text rendering with preserved whitespace.

### 3.5 Files

| Area | Files |
| --- | --- |
| Database | `supabase/migrations/0020_chat.sql`, `supabase/tests/phase7_chat_security_test.sql` |
| Pure modules | `src/modules/chat/types.ts`, `validation.ts`, `cursor.ts`, `state/reducer.ts` |
| Server | `src/modules/chat/queries.ts`, `actions.ts` |
| Client | `src/modules/chat/clientApi.ts`, `realtime.ts`, `useTripChat.ts`, `components/*` |
| Route | `src/app/(app)/trips/[tripId]/chat/page.tsx`; one link in `trips/[tripId]/page.tsx` |
| Tests | `tests/phase7/run.mjs`, unit tests, `tests/phase7/realtime-e2e.mjs`; `package.json` gains `test:phase7` |

## 4. Batches and gates

Six batches on branch `phase7-chat` (from `phase6-integration` @ `3728041`). Each batch ends with its checks run, a short update to `TRIP_CHALO_HANDOFF.md`, and a local commit. Nothing is pushed until Gate 3.

| Batch | Work | Ends with |
| --- | --- | --- |
| 0 Audit (read-only) | Git state, the 0019 diff, local and hosted catalog for `messages` (columns, constraints, policies, grants, publication, row count), advisors baseline, existing patterns (`trips/actions.ts`, `media/actions.ts`, `listTripMembers`, `MemberAvatar`, Supabase clients), test setup | **Gate 0:** report baseline, conflicts, and the D2/D3 confirmation. Stop. |
| 1 Database | `0020_chat.sql`, SQL security tests, local Realtime spike S1 (three users, leave and owner removal on an open connection) | **Gate 1:** independent security review, then your approval. Stop. |
| 2 Server and pure modules | `types.ts`, `validation.ts`, `cursor.ts`, `queries.ts`, `actions.ts`, unit tests, `test:phase7` script | Checks green, commit, continue |
| 3 State and Realtime | reducer, `clientApi.ts`, `realtime.ts`, `useTripChat.ts`, convergence and reconnect tests | Checks green, commit, continue |
| 4 UI | chat route, components, one header link | Build green, local two-browser check, commit |
| 5 Hosted and closure | **Gate 2:** you apply 0020 to hosted (0019 is already there); hosted SQL tests and Realtime script; full regression; **Gate 3:** independent final review, docs, your approval to push | Pushed branch, recorded commit |

**Gate rules**

- **Gate 0 and Gate 1** stop the session until you reply.
- **Gate 1 and Gate 3** reviews run in a fresh session with the review prompt (section 7). The reviewer gets the diff, the plan, and test outputs only, not the writer's conversation. A critical or high finding blocks the gate.
- **Gate 2** is yours alone: Claude never applies migrations to hosted. You run `supabase db push`, then paste the hosted SQL test file into the SQL Editor and run the Realtime script with three hosted test accounts kept in an untracked env file.
- **Gate 3** covers docs, commit history and push. Merging into `main` is a separate approval.

**Model and effort.** Per-stage model and effort are in section 8. Start a fresh session after each gate (the resume prompt), as `CLAUDE.md` section 9 asks.

## 5. Tests and evidence

Every claim carries a status label and a tier. A test counts only if the session ran it and shows the command and output.

| Tier | What | Who runs it |
| --- | --- | --- |
| T0 | `node:test` on pure modules (`npm run test:phase7`) | Claude |
| T1 | SQL tests on the local Supabase stack | Claude |
| T2 | Realtime script on the local stack, three users | Claude |
| T3 | Same SQL tests in the hosted SQL Editor (BEGIN … ROLLBACK) | You |
| T4 | Realtime script on hosted plus two real browsers on a local dev server | You, with Claude reading the output |

**T0:** content rule (code points, NUL, the whitespace set, raw bound); cursor encode, decode and rejection; reducer converges under any order and duplication; optimistic row replaced by id; gap-fill merge and discard-and-reload; retry reuses `clientId`; UUID fallback.

**T1 / T3:** member sends; non-member and `anon` denied; sender cannot be forged; `authenticated` and `anon` hold no INSERT, UPDATE or DELETE on `messages` (`has_table_privilege`, `has_column_privilege`) and only `authenticated` holds SELECT; same `clientId` and content returns the existing row; same id from another user or with other content fails uniformly; 10 parallel same-id calls return one row; 10 parallel sends never exceed the rate limit; whitespace-only, over-length, raw-length bypass, Unicode whitespace and NUL rejected; pages at identical timestamps; page cap; half cursor rejected; microsecond timestamp round trip; overlap returns a row 20 s older and not one 40 s older; former member (left, and owner-removed) reads and sends nothing; trip delete cascades; profile delete sets `sender_id` null; publication statement idempotent; advisors show exactly one new warning, for `send_message`.

**T2 / T4:** A sends, B receives, outsider C receives nothing; B leaves, A sends, record what B's open connection gets; repeat with owner removal; token refresh; reconnect gap-fill; message sent between render and subscribe appears; strict-mode double mount gives one subscription; unmount unsubscribes; session past one hour.

**Browser:** IME Enter, scroll anchoring on prepend, 16px input, mobile keyboard, Hindi and mixed-script text, reduced motion, focus order, live region.

**Regression:** `tsc --noEmit`, `npm run lint`, `npm run build`, `npm run test:phase6` unchanged, Phase 6 SQL tests including `phase6_security_hardening_test.sql`, auth, trips, memberships, invitations, media. Trip-page diff is one link.

## 6. Decisions

Two decisions are still yours. The session asks for them at Gate 0 and proceeds with the recommended default only if you confirm.

| # | Decision | Value | Status |
| --- | --- | --- | --- |
| D1 | Base and Phase 6 | Phase 6 treated as done; base `phase6-integration` @ `3728041`; 0019 on hosted before 0020 | Settled |
| D2 | Write path | `send_message` RPC only; no direct INSERT | **Recommended, needs your yes** |
| D3 | Delete | Revoke all client delete, including the owner's delete-any-message policy that 0019 kept | **Recommended, needs your yes** |
| D4 | Revocation promise | Only what T2/T4 prove; no "instant" claim | Default |
| D5 | Realtime transport | Postgres Changes, INSERT, filtered by trip | Default |
| D6 | Reads | Browser client calls the RLS list RPCs; Server Action only for send | Default |
| D7 | Limits and placement | 2,000 code points raw; page size 50, cap 100; separate `/chat` route | Default |
| D8 | Rate limit | 30 per minute per sender per trip; retries exempt | Default |
| D9 | Notifications and unread | None in Phase 7; members see chat when they open it | Default, accepted limitation |
| D10 | Former members | Messages kept; shown as "A former member" | Default |
| D11 | Evidence | Status labels plus tiers T0 to T4 | Default |
| D12 | Git | Local commits per batch on `phase7-chat`; push only after Gate 3; merge into `main` separately | Default |
| D13 | Excess privileges on other tables | Resolved by 0019 | Closed |

## 7. Prompts

Use them in a work session that has the repository and a shell (Claude Code in your local clone, or a Claude session with the repo attached and command access). Paste sections 3 to 6 of this doc where marked, or keep this doc open and paste its link.

### 7.1 Work-mode prompt (start of Phase 7)

```
You are implementing Trip Chalo Phase 7: private, trip-scoped text chat with persisted history and Supabase Realtime. You are the only Claude on this phase. Work in the local clone of ShrikarGujjeti/trip-chalo-app.

Read first, in this order:
1. CLAUDE.md. Follow its workflow and evidence labels. The repository and database outrank every document, including this prompt; report any conflict instead of choosing silently.
2. TRIP_CHALO_CURRENT_STATE.md, TRIP_CHALO_HANDOFF.md, and the parts of TRIP_CHALO_DECISION_LOG.md and TRIP_CHALO_MASTER.md about chat, RLS and grants. Do not re-read whole documents you do not need.
3. supabase/migrations/0006, 0007, 0008, 0017, 0019 and supabase/tests/phase6_security_hardening_test.sql.
4. This repo uses Next.js 16. Before writing any Next.js code, read the relevant guide in node_modules/next/dist/docs (Server Actions, Route Handlers, Server and Client Components, caching). Do not rely on older Next.js knowledge.
5. Use graphify-out/wiki to find code, then read the real files.

Plan of record (follow it; propose changes, do not make them silently):
[PASTE sections 3, 4, 5 and 6 of the Phase 7 plan doc]

Hard rules:
- Phase 6 is closed. Do not reopen it or weaken anything 0016 to 0019 established.
- Never edit migrations 0001 to 0019. The Phase 7 migration is 0020_chat.sql unless the repo shows 0020 is taken.
- Never write to the hosted Supabase project. Read-only checks are allowed (SELECT queries, advisors, migration list). No apply_migration, no DDL or DML on hosted, no branch create, reset or rebase. I apply migrations myself at Gate 2.
- Authorization stays in PostgreSQL: RLS, grants and SECURITY DEFINER functions. Sender is auth.uid(), never input. No service-role client for chat.
- Out of scope: attachments, edit, delete, reactions, read receipts, typing, presence, notifications, unread counts, linkification, AI features, new infrastructure. No new npm dependency without asking.
- Git: create branch phase7-chat from phase6-integration. Commit locally at the end of each batch. Never push, merge, rebase main, force-push or delete branches without my explicit approval in chat.
- Test accounts and credentials: use the local Supabase stack's seed or test users you create locally. Never put credentials in tracked files or in chat.
- Evidence: label every claim VERIFIED, SUPPORTED, INFERRED, PROPOSED, UNKNOWN or CONTRADICTED with its tier (T0 to T4). Never say a test passed unless you ran it in this session and show the command and the relevant output. If a test fails, first decide whether the system, the test, or the environment is at fault.
- Keep a task list for the batch you are in and tick items as they finish.

How to work:
- Run Batch 0 now. It is read-only: state which model and effort level you are running on, and re-check with list_migrations that 0019 is applied on hosted. Then STOP at Gate 0 with: the verified baseline, any conflict with the plan, the advisors baseline, and the D2 and D3 questions. Wait for my answer.
- After my Gate 0 answer, run Batch 1 and STOP at Gate 1 with the migration, the SQL test output (T1) and the raw Realtime spike output (T2). Do not start Batch 2 until I approve.
- Batches 2, 3 and 4 run back to back unless a check fails or the plan turns out wrong; then stop and ask.
- Batch 5: stop before hosted steps and give me the exact commands for Gate 2. After I paste results, run the regression set, then stop for Gate 3.
- End every batch by running its checks, adding a short dated entry to TRIP_CHALO_HANDOFF.md (where you stopped, what is next, what is unverified), and making a local commit.
- If the conversation is getting long, finish the current batch cleanly and tell me to start a new session with the resume prompt.

Report at each stop: Completed; Not completed; Files created and modified; Commands run with results; Verified (with tier); Not verified; Assumptions; Risks; Decisions needed from me; Git state (branch and commit hash).
```

### 7.2 Independent review prompt (Gate 1 and Gate 3, fresh session)

```
You are an independent reviewer for Trip Chalo Phase 7 (private trip chat). You wrote none of this code and you have not seen the author's reasoning. Do not trust the author's report.

Scope: [Gate 1: migration 0020, supabase/tests/phase7_chat_security_test.sql, tests/phase7/realtime-e2e.mjs and its output] or [Gate 3: the full diff of phase7-chat against phase6-integration @ 3728041].
Inputs: the plan of record [PASTE sections 3 to 6], the diff, and the test outputs.

Read CLAUDE.md, then the real files. Re-run what you can (tsc, lint, build, test:phase6, test:phase7, the local SQL tests and the Realtime script).

Check:
1. Privileges: authenticated has only SELECT on messages; anon has nothing; send_message and the list functions are executable by authenticated only.
2. send_message: lock, step order, idempotency, re-select after conflict, uniform failure, content rule, rate limit under concurrency, search_path.
3. List functions: SECURITY INVOKER, tuple comparison, cap, overlap inside SQL, no Date conversion anywhere in the cursor path.
4. Membership loss: leave and owner removal, for reads, sends and an already-open Realtime connection. Nothing claims instant revocation unless it was demonstrated.
5. Contract match: types, cursor format, error codes and the 2,000 code-point limit identical in SQL, server and client.
6. Reliability: gap-fill and discard-and-reload, strict-mode double mount, unsubscribe, idempotent retry, session past one hour.
7. Regression and scope: Phase 6 behaviour and its security tests unchanged; trip page gains one link; nothing outside scope; no new dependency.
8. Docs (Gate 3): Current State, Decision Log and Handoff state only what was run, with tiers.

Return findings ordered by severity with file, evidence and the required fix. Critical or high findings block the gate. End with APPROVE, APPROVE WITH CONDITIONS or REJECT, and list what you executed versus only read. Change no files.
```

### 7.3 Resume prompt (new session after a gate or a long conversation)

```
Continue Trip Chalo Phase 7 on branch phase7-chat. Read CLAUDE.md, the latest entry in TRIP_CHALO_HANDOFF.md, and git log for phase7-chat. The plan of record is [PASTE sections 3 to 6 or the doc link]. My answer at the last gate: [PASTE]. All rules from the work-mode prompt still apply [PASTE its "Hard rules" and "How to work" blocks]. Confirm where you are in one paragraph, then continue with the next batch.
```

## 8. Model, effort and calendar (added 2026-11-12)

You will use Opus 5.5 or Fable 5.3, and Fable 5.3 leaves your plan after 16 November. I have no information about what Fable 5.3 changes; I only know Fable 5.2 as the Mythos-tier model with extra safeguards for cybersecurity. So treat its strength as unverified until its first session is judged against the Batch 0 checklist. If it refuses or waters down ordinary defensive work (RLS negative tests, forged-sender attempts, the open-connection Realtime test), switch that stage to Opus 5.5 instead of arguing with it.

**Recommendation:** use Fable 5.3 for the reasoning-heavy front of the phase before 16 November and Opus 5.5 for the rest. Fable is not required. The window is spare capacity, and Batches 0, 1 and 3 are where a mistake costs most.

| Stage | Model | Effort | Why |
| --- | --- | --- | --- |
| Batch 0 audit | Fable 5.3 | high | Breadth and conflict-spotting across migrations, hosted catalog and code |
| Batch 1 database and Realtime spike | Fable 5.3 | max | Locking, idempotency, privileges, and reading the raw Realtime output without over-claiming |
| Gate 1 review | Opus 5.5, fresh session | max | Different model from the writer, so the review is independent |
| Batch 2 server and pure modules | Fable 5.3 if Gate 1 is approved by 14 Nov, otherwise Opus 5.5 | medium | Mostly pattern work; it is the prerequisite for Batch 3 |
| Batch 3 state and Realtime | Fable 5.3 if before 16 Nov, otherwise Opus 5.5 | high | The reducer and reconnect logic are the subtlest client code |
| Batch 4 UI | Opus 5.5 | medium (low for pure styling) | Follows Phase 6 patterns |
| Batch 5 hosted and closure | Opus 5.5 | high | Reads your pasted hosted output; docs and regression |
| Gate 3 review | Opus 5.5, fresh session, max; optionally Codex as a third opinion | max | The writer is Opus by then, so a different reviewer family adds independence |

If the window runs short, the priority order is Batch 0, Batch 1, the Gate 1 review, then Batch 3.

**Calendar (flexible; every gate waits for you).**

| When | Work | Needs from you |
| --- | --- | --- |
| 12–13 Nov | Batch 0, then Batch 1 | Gate 0 answers (D2, D3); the local stack running |
| 13–14 Nov | Gate 1 review on Opus, fixes | Gate 1 approval |
| 14–16 Nov | Batches 2 and 3 on Fable if the gates have cleared | Local test runs pasted back if the session cannot run them |
| After 16 Nov | Batch 4 UI, Batch 5, Gate 2 (you apply 0020), Gate 3 | Hosted SQL and Realtime runs; push approval |

Phase 7 is roughly seven to nine working sessions. With your approvals and test runs in between, one to three weeks is realistic, longer only if the hosted Realtime test shows something unexpected. One to three months is a safe upper bound, not a target.

**Before the first session:** Docker running; `supabase start` works from the repo; the Supabase CLI is logged in and linked (Gate 2 needs `supabase db push`); dependencies installed; a session that has the repo and a shell (Claude Code in your clone), since the plan relies on it running tests itself.

**Phases 8 and 9.** The process carries over: gates, evidence tiers, a `tests/phaseN` harness, SQL test patterns, handoff entries, connector rules. A stronger model helps with reasoning-heavy steps, but what has caught real problems in this project was checking actual state (the hosted catalog, the repo, the migrations), not model strength. And from 17 November those phases run on Opus 5.5 anyway. So spend the Fable window on Phase 7's hardest parts, not on pre-building later phases. I have not looked at the scope of Phases 8 and 9; say so if you want a read-only pre-audit of them inside the Fable window.
