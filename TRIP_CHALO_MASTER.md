# TRIP_CHALO_MASTER

# TRIP CHALO — MASTER PROJECT KNOWLEDGE

> This document is CONTEXT, not absolute truth. Before implementing anything,
> inspect the actual repository (code, migrations, `package.json`, Git state).
> Treat the repo/database/tests as the source of truth. If this document
> disagrees with actual evidence, flag the contradiction rather than silently
> choosing one.

---

## 1. Project purpose

Trip Chalo is a private, shared travel-memory platform for groups (friends/family)
who travel together. It solves the problem of trip media being scattered across
individual phones, compressed by chat apps, and disconnected from who captured
what and when.

Core statement: **create a private, high-quality, chronological memory of a
trip that belongs to the people who experienced it.**

Not a public social network. No public trip discovery. No feed. No followers.

Priority order:

**Correctness → Security → Maintainability → Reliability → UX → Performance → Scale**

---

## 2. Architecture

**Modular monolith**, not microservices. One Next.js application with clearly
separated domain modules under `src/modules/`:

```text
auth · trips · memberships · invitations · media · storage · chat
```

Rationale: the project does not currently justify microservice operational
overhead. Modules remain separately organized so extraction is possible later
if an actual bottleneck justifies it.

### Media storage boundary

- **PostgreSQL** = metadata, relationships, and storage references only.
- **Cloudflare R2** = original photo/video bytes.
- Never store media files in Postgres.

---

## 3. Technology stack

| Layer | Choice | Verified version / status |
| --- | --- | --- |
| Framework | Next.js, App Router, `src/` layout | 16.3.1 |
| UI | React | 19.2.8 |
| Language | TypeScript | 5.9.3 |
| Runtime | Node | 22.20.0 |
| Styling | Tailwind CSS | scaffolded; version not independently re-verified since Phase 1 |
| DB/Auth/Realtime | Supabase | `@supabase/ssr` 0.12.4, `@supabase/supabase-js` 2.112.3 |
| Object storage | Cloudflare R2 | Application integration is present in the uncommitted Phase 6 working tree; live R2 end-to-end behavior is not verified |
| Hosting | Vercel | not yet deployed |
| Source control | GitHub | project repository is pushed to `origin/main` |

Cost constraint: **stay as close to ₹0/month as possible** for as long as
possible. Check cost implications before introducing paid services or tier
upgrades.

---

## 4. Complete phase roadmap

| Phase | Name | Scope |
| --- | --- | --- |
| 0 | Product + Architecture | Product definition, stack selection, architecture decisions |
| 1 | Application Foundation | Next.js + TypeScript scaffold, project structure, Supabase helpers |
| 2 | Database + Security Foundation | Schema, migrations, RLS, grants, SECURITY DEFINER functions |
| 3 | Authentication + User Identity | Signup/login/logout, sessions, protected routes, profile integration |
| 4 | Trips | Create/view/update/hard-delete trips |
| 5 | Membership & Invitations | Invitation and membership application integration/UI |
| 6 | Media | R2 integration, upload flow, metadata pipeline, chronology timeline |
| 7 | Chat | Trip chat UI, Supabase Realtime |
| 8 | UX Refinement | Responsive layout, loading/empty/error states, navigation polish |
| 9 | Testing & Security | Unit/integration/E2E tests, authorization test suite |
| 10 | Deployment | Vercel + Supabase + R2 production configuration |
| 11 | Performance & Scale | Only after MVP works and real bottlenecks are identified |

**Current status:** Phase 6 media implementation (backend, upload, timeline,
gallery, and viewer) is present in an uncommitted working tree. Local checks
are recorded in `TRIP_CHALO_CURRENT_STATE.md`; hosted Supabase, live R2, and
device verification remain open. The approved Phase 6 Experience Specification
is the product contract and is not itself evidence of implementation or
verification.

---

## 5. Phase boundaries — explicitly OUT of MVP scope

Unless explicitly revisited:

- Public social feed, public profiles, followers/following, public trip discovery
- AI features — not until Phase 11 at the earliest, and only if explicitly revisited
- Payments/subscriptions — no payment code now
- Microservices, Kubernetes, Kafka, Redis, multi-database setups, complex event buses
- Native mobile app
- Advanced video editing and complex social features

---

## 6. Core security/engineering principles

1. **RLS + explicit Data API grants are both required.** RLS restricts rows;
   grants restrict table reachability. `anon` gets no grants on private
   application tables.
2. **Authorization is enforced at the database level**, never solely in
   frontend/client code.
3. **`trip_members` is the authorization gate** for trip data.
4. **Never allow direct client-side membership insertion.** Membership is
   created by the trip-creation trigger or controlled invitation acceptance.
5. **SECURITY DEFINER functions must use `search_path = ''`**, fully qualified
   references, and deliberately scoped EXECUTE grants.
6. **Use the established trusted Supabase auth pattern server-side.** The
   current application protection pattern uses `getClaims()`.
7. **Never expose Supabase service-role or R2 secret keys to the browser.**
8. **Validate redirect targets** as safe internal paths.
9. **Capture time and upload time are distinct** and must not overwrite each
   other.
10. **Build the smallest correct version first.** Avoid speculative fields,
    roles, and infrastructure.

---

## 7. Stable architectural decisions

These should not be silently redesigned:

- Next.js App Router + TypeScript + Tailwind
- Supabase for Postgres + Auth + Realtime
- Cloudflare R2 for original media
- Vercel for hosting
- Modular monolith with domain modules under `src/modules/`
- Six core tables: `profiles`, `trips`, `trip_members`, `invitations`,
  `media`, `messages`
- RLS + explicit Data API grants as the normal authorization boundary
- Server-side application protection using the trusted Supabase auth context,
  currently `getClaims()`
- Email-targeted invitations, because invitees may not yet have accounts
- Owner membership row is currently undeletable because ownership transfer does
  not exist yet

---

## 8. Phase 5 — Established decisions

Phase 5 is no longer a design hypothesis. The following decisions were
implemented and security-tested:

### Membership and invitation authority

**Any current trip member may invite.**

This is intentional. The invitation INSERT policy checks current membership;
it does not require owner status.

Do not silently tighten this to owner-only.

### Invitation email identity

Invitation email identity is canonicalized as:

**trim → lowercase**

Migration `0011_invitation_email_case_insensitivity.sql` makes this a database
guarantee through a trigger and also applies case-insensitive comparisons to the
relevant invitation authorization paths.

The database guarantee is authoritative; application normalization is
defense-in-depth/convenience, not the security boundary.

### Pending invitee preview

A pending invitee may receive a deliberately narrow trip preview through:

`get_invited_trip_preview(invitation_id)`

The function is `SECURITY DEFINER` and returns exactly:

- `trip_id`
- `name`
- `start_date`
- `end_date`

It does **not** grant general `trips` SELECT access to a pending invitee.

### Profile visibility

Co-members may see the limited profile data required by membership UI, within
the established same-trip membership boundary. This does not create general
profile discovery.

### Invitation state transitions

Invitation status changes remain behind the established
`SECURITY DEFINER` functions:

- `accept_invitation()`
- `decline_invitation()`
- `revoke_invitation()`

There is no direct client UPDATE/DELETE path for invitations.

### Membership lifecycle

- Direct client INSERT into `trip_members` remains blocked.
- Accepting an invitation creates the membership through the trusted database
  function.
- A non-owner may leave.
- The owner cannot leave through the normal leave path.
- Ownership transfer is not implemented.

---

## 9. Phase 5 — Database state

Phase 5 added/deployed:

- `0010_profile_and_invitation_visibility.sql`
- `0011_invitation_email_case_insensitivity.sql`

The hosted Supabase migration history was initially at `0009`. Both Phase 5
migrations were subsequently applied successfully with:

`npx supabase db push`

The deployed database state must still be treated as authoritative and checked
with the actual Supabase project when making future changes.

---

## 10. Phase 5 — Verification record

### Application verification

- `npx tsc --noEmit` — PASS
- `npm run build` — PASS

### Live hosted Supabase verification

Three independent SQL Editor tests were run against the hosted Supabase project:

- **Test 1 — Invitation lifecycle:** PASS
- **Test 2 — Unrelated-user authorization:** PASS
- **Test 3 — Member invite + revoke authorization:** PASS

The tests used throwaway fixtures and `BEGIN ... ROLLBACK`.

### Supplementary isolated verification

An isolated PostgreSQL/PostgREST harness applied migrations `0001` through
`0011` and completed:

- **26/26 assertions PASS**
- **0 FAIL**
- **0 skipped**

This is supplementary evidence and does not replace the live hosted-Supabase
tests.

### Verification boundary

Do not infer from the Phase 5 tests that the following are already verified:

- every browser/UI interaction;
- production deployment;
- R2 behavior;
- chat;
- ownership transfer;
- password reset;
- every future phase;
- a complete production signup/login E2E suite.

---

## 11. Current Git / project-control state

At the documentation update, the repository is on branch `phase6-integration`
at `77edda3` (`docs: add phase 6 experience spec`) with uncommitted Phase 6
changes. This is a point-in-time report; inspect Git before consequential work.
No Phase 6 commit, push, hosted migration, or deployment is reported.

---

## 12. Documentation governance

The canonical documents have distinct responsibilities:

- `CLAUDE.md` — operating rules for AI-assisted work
- `TRIP_CHALO_MASTER.md` — durable architecture, principles, roadmap, and
  established decisions
- `TRIP_CHALO_CURRENT_STATE.md` — current verified project state
- `TRIP_CHALO_DECISION_LOG.md` — historical reasoning and decision record
- `TRIP_CHALO_HANDOFF.md` — short-lived fresh-session bridge

Do not turn one document into a duplicate of the others.

When an old decision is changed, preserve the historical record and clearly mark
the superseded decision rather than rewriting history invisibly.

---

## 13. Codebase Structural Analysis

Trip Chalo may use Graphify as supplementary codebase-structure and
dependency-analysis context.

Graphify is **not** an architectural authority and does not replace repository
inspection, database inspection, tests, or persistent project documentation.

The currently known Graphify output reflects older commit `21532f0f` and is
therefore **stale relative to the Phase 6 working tree** until regenerated.

Any important Graphify finding must be checked against the actual repository and
database.

---

## 14. Future work / open decisions

These remain outside the current verified Phase 6 work:

- Password reset flow
- Ownership transfer
- Hosted Supabase verification/deployment for migrations `0016`–`0018`
- Live Cloudflare R2 end-to-end verification
- Browser/device and two-account verification
- R2 reconciliation and stale pending-media cleanup strategy
- Chat / Realtime
- Broader testing strategy for Phase 9
- Production deployment
- Performance/scale work based on real bottlenecks

Future architectural changes should be proposed with evidence, alternatives,
impact, and explicit approval where the project process requires it.

---

## 15. Final operating principle

**The repository, database, tests, and Git state establish technical truth.
These documents preserve context and decisions around that truth.**

When evidence conflicts with documentation:

**inspect → identify the discrepancy → verify → update the appropriate document**

Never allow stale documentation to reopen completed work or weaken established
security properties.
