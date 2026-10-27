# TRIP_CHALO_DECISION_LOG

# TRIP CHALO — DECISION LOG

> This file records durable product, architectural, security, and implementation
> decisions and the reasoning behind them.
>
> **Source-of-truth rule:** the actual repository, database, migrations, tests,
> and Git state are authoritative. This log is persistent context, not proof
> that a current implementation still exists or works.
>
> ## Status legend
>
> **VERIFIED** — directly supported by actual evidence in the project history,
> repository, database, or user-run verification.
>
> **CURRENT DECISION** — an accepted project decision that is part of the
> intended/current architecture, but the specific implementation or runtime
> behavior is not independently re-verified in the current record.
>
> **SUPPORTED** — supported by inspected evidence, but not itself directly
> runtime-tested.
>
> **INFERRED** — logically concluded from available evidence; not directly
> tested.
>
> **PROPOSED** — a suggestion or candidate approach, not an approved decision.
>
> **UNKNOWN / UNCERTAIN** — evidence is insufficient and requires inspection or
> testing.
>
> **SUPERSEDED** — an earlier decision or plan that was replaced; retained so
> future sessions understand why the project changed direction.
>
> This log should preserve historical reasoning. When a decision changes, mark
> the old decision **SUPERSEDED** and record the replacement rather than
> silently rewriting history.

---

## Product / Architecture (Phase 0)

### Modular monolith

**Decision:** Use a modular monolith built around Next.js, Supabase, Cloudflare
R2, and Vercel rather than microservices.

**Why:** The project is greenfield and does not currently need the operational
complexity of distributed services. Module boundaries (`auth`, `trips`,
`memberships`, `invitations`, `media`, `storage`, `chat`) preserve future
extraction options without paying the complexity cost now.

**Status:** CURRENT DECISION.

### Private product by default

**Decision:** No public social features or public trip discovery in the MVP.

**Why:** Trip Chalo is intended to be a private shared-memory space. Public
discovery would change the product's authorization and privacy model.

**Status:** CURRENT DECISION.

### Near-zero infrastructure cost

**Decision:** Prefer near-zero infrastructure cost during MVP development.

**Why:** This was an explicit project requirement. The initial architecture was
chosen around free/low-cost tiers rather than premature infrastructure.

**Status:** CURRENT DECISION — re-evaluate if usage materially exceeds free-tier
assumptions.

---

## Database / Authorization (Phase 2)

### Six core application tables

**Decision:** The core schema consists of `profiles`, `trips`, `trip_members`,
`invitations`, `media`, and `messages`.

**Why:** These correspond directly to the MVP's core entities. Avoid adding
tables without a current product or architectural purpose.

**Status:** VERIFIED for the established schema through migration 0008.

### Profiles identity model

**Decision:** `profiles.id` is both the primary key and a foreign key to
`auth.users.id` with `ON DELETE CASCADE`. Profile creation is handled by the
`handle_new_user` SECURITY DEFINER trigger.

**Why:** Supabase Auth remains the owner of credentials while `profiles` owns
application display data.

**Status:** VERIFIED.

### Membership is the trip authorization gate

**Decision:** `trip_members` is the authoritative membership gate for
trip-scoped data.

**Decision:** There is no direct client `INSERT` policy on `trip_members`.
Membership rows are created by the trip-owner trigger or the controlled
invitation-acceptance function.

**Why:** A user must not be able to add themselves to an arbitrary trip.

**Status:** VERIFIED.

### Owner membership cannot currently be removed

**Decision:** The trip owner's membership row is currently undeletable. A
non-owner may leave their own trip, and an authorized owner may remove another
member, but the owner cannot remove themselves through the current membership
lifecycle.

**Why:** Ownership transfer does not exist yet. Allowing the owner membership
to disappear without a transfer mechanism would leave the ownership model
undefined.

**Status:** VERIFIED. Ownership transfer remains a future decision.

### Email-targeted invitations

**Decision:** Invitations target `invitee_email`, not a user ID. `invitee_id`
is resolved when an invitation is accepted by matching the authenticated
user's verified email claim.

**Why:** A person can be invited before they have a Trip Chalo account. The
acceptance path can resolve the account only when the invitee authenticates.

**Status:** VERIFIED for the database design and implemented acceptance path.

### No direct invitation status mutation

**Decision:** Invitations have no client-facing `UPDATE` policy or grant.
Accept, decline, and revoke operations go through dedicated SECURITY DEFINER
functions.

**Why:** Direct client updates could otherwise expose mutable authorization-
sensitive fields such as `trip_id`, `inviter_id`, `invitee_email`, or
`invitee_id`. Centralizing state transitions makes caller and status checks
explicit.

**Status:** VERIFIED.

### SECURITY DEFINER hardening

**Decision:** SECURITY DEFINER functions use `search_path = ''`, fully
qualified object references, and explicit EXECUTE grants restricted to the
roles that legitimately call them.

**Why:** This reduces privileged-function attack surface and prevents caller-
controlled `search_path` manipulation from redirecting unqualified references.

**Status:** VERIFIED for the established database functions.

### Anonymous database access

**Decision:** The `anon` role receives no grants on the private application
tables.

**Why:** The MVP has no unauthenticated private-data access path.

**Status:** VERIFIED.

---

## Authentication / Server Authorization (Phase 3)

### Next.js proxy convention

**Decision:** The project uses `proxy.ts` rather than the deprecated
`middleware.ts` convention, including the Supabase proxy helper.

**Why:** The project uses Next.js 16.3.1, where the previous middleware
convention was no longer being discovered.

**Status:** VERIFIED — implemented, built, manually tested, and committed in
`e5b39a8` ("Complete Phase 3 authentication").

### Trusted server authentication

**Decision:** Server-side page/data protection uses the project's established
trusted Supabase auth pattern with `getClaims()`. `getSession()` is not used
as an authorization primitive.

**Why:** Authorization must rely on a server-verified authentication context,
not merely local session-cookie contents.

**Status:** VERIFIED for the Phase 3 implementation. Re-check current Supabase
guidance before making future authentication architecture changes.

### Redirect validation

**Decision:** Request-controlled login/callback redirect targets are validated
with `isSafeRedirectPath` before use.

**Why:** Prevents open-redirect behavior through attacker-controlled external
targets.

**Status:** VERIFIED — implemented and manually tested in Phase 3.

### Signup confirmation redirect

**Decision:** Signup confirmation URLs are derived from
`NEXT_PUBLIC_SITE_URL`, with `VERCEL_URL` as the deployment fallback. The
request `Origin` header is not used as the authority for the emailed link.

**Why:** A client-controlled request header must not determine a security-
sensitive destination that is subsequently emailed.

**Status:** VERIFIED — implemented and manually tested in Phase 3.

### Password reset

**Decision:** Password reset is outside the completed Phase 3 scope.

**Status:** FUTURE PLAN / unassigned.

---

## Phase 4 — Trips / Trip Lifecycle

**Status:** VERIFIED — COMPLETED, IMPLEMENTED, VERIFIED, COMMITTED, PUSHED, AND
CLOSED.

### Scope and authorization

**Decision:** Phase 4 supports trip creation, listing, viewing, owner-only
update, and owner-only hard deletion.

**Decision:** `owner_id` is derived from the authenticated user's
server-verified identity and is never trusted from client input.

**Decision:** Existing RLS remains the authorization boundary; no service-role
bypass is required for normal application operations.

**Status:** VERIFIED.

### Migration 0009

**Decision:** Add `0009_trips_select_owner.sql` so the authenticated trip owner
can satisfy the trips SELECT policy during the `INSERT ... RETURNING` flow,
before the owner-membership trigger has created the membership row.

**Why:** The owner-membership trigger runs after trip insertion. Without the
owner clause, the creation flow could fail its SELECT authorization even
though the caller had just created the trip.

**Status:** VERIFIED — applied to the live Supabase project and trip creation
was successfully tested.

### Trip deletion

**Decision:** Trip deletion is owner-only and uses the existing database
cascade for relational rows.

**Status:** VERIFIED.

**Known limitation:** PostgreSQL cascade deletes media metadata, not external
Cloudflare R2 objects. R2 object cleanup belongs to the later media/storage
phase.

### Phase 4 verification

The completed Phase 4 record includes:

- runtime/functional verification — COMPLETE
- security/authorization verification — COMPLETE
- TypeScript — PASSED
- build — PASSED
- ESLint — PASSED
- migration 0009 — APPLIED
- local/remote migration history — SYNCHRONIZED at 0009

**Status:** VERIFIED / CLOSED.

---

## Phase 5 — Membership & Invitations

### Original Phase 5 plan — now superseded

**Original status:** FUTURE PLAN.

The original scope covered invitation creation, pending invitations,
acceptance, decline, revocation, membership visibility, invitee resolution,
owner/member authorization boundaries, and two-user security verification.

**Status:** SUPERSEDED BY THE COMPLETED PHASE 5 IMPLEMENTATION BELOW.

The original plan is retained here because it explains the starting point and
prevents future sessions from confusing the original hypothesis with the
final implementation.

### Final Phase 5 authorization decision: any current member may invite

**Decision:** Any current trip member may create an invitation for that trip.
Owner-only invitation creation is intentionally not required.

**Why:** The existing authorization model permits invitation insertion when
`inviter_id = auth.uid()` and the caller is a current trip member. Restricting
this to owners would be a new product/authorization decision rather than a
necessary security correction.

**Status:** VERIFIED by implementation and live authorization testing.

### Invitation email normalization

**Decision:** Invitation email addresses are normalized to trimmed lowercase
form, with database-side normalization and case-insensitive pending-invitation
handling.

**Why:** Email addresses are used as the invitation identity boundary. A
case-only variation must not create a second pending invitation or bypass the
intended invitee match.

**Status:** VERIFIED through migration 0011 and the Phase 5 verification work.

### Pending invitee preview

**Decision:** A pending invitee who is authorized by the invitation may obtain
a narrow trip preview through `get_invited_trip_preview(invitation_id)` rather
than receiving direct access to the trip row.

**Returned shape:** `trip_id`, `name`, `start_date`, `end_date`.

**Why:** The invitee needs enough information to make an accept/decline
decision, but pending invitation status must not itself grant general trip
access.

**Security properties:** SECURITY DEFINER, fixed empty `search_path`, fully
qualified database references, authenticated-only EXECUTE, and a deliberately
narrow return shape.

**Status:** VERIFIED by migration 0010 and live SQL Editor testing.

### Profile visibility for co-members

**Decision:** A user may see safe profile display information for users who
share a trip with them, while unrelated profiles remain inaccessible.

**Why:** Member lists need display information, but profile visibility must not
become a general user-enumeration mechanism.

**Status:** VERIFIED through migration 0010 and the Phase 5 security tests.

### Invitation state transitions

**Decision:** Accept, decline, and revoke remain controlled by their dedicated
SECURITY DEFINER functions. The functions independently verify the invitation,
caller identity/authorization, and pending status.

**Status:** VERIFIED by live authorization testing.

### Membership lifecycle

**Decision:** Accepting an authorized invitation creates the invitee's trip
membership through the controlled database function. Direct client membership
insertion remains prohibited.

**Status:** VERIFIED by Phase 5 implementation and lifecycle testing.

### Leave-trip behavior

**Decision:** A non-owner member may leave their own trip. The owner cannot
leave until ownership transfer exists.

**Why:** This preserves the current ownership invariant.

**Status:** VERIFIED by implementation and the Phase 5 authorization model.

---

## Phase 5 Implementation Record

The Phase 5 application layer added the following established areas:

- `src/modules/invitations/validation.ts`
- `src/modules/invitations/queries.ts`
- `src/modules/invitations/action.ts`
- invitation UI/presentational components
- `src/modules/memberships/queries.ts`
- `src/modules/memberships/action.ts`
- membership UI/presentational components
- migration `0010_profile_and_invitation_visibility.sql`
- migration `0011_invitation_email_case_insensitivity.sql`

The server actions use server-side authenticated identity, shared validation,
safe error mapping, and path revalidation where required.

**Status:** VERIFIED at implementation level through TypeScript/build checks
and the completed Phase 5 verification process.

---

## Phase 5 Security Verification Record

### Independent isolated PostgreSQL harness

An earlier verification harness applied migrations 0001–0011 to an isolated
PostgreSQL 16.15 environment with an authentication shim.

**Result:** 26/26 assertions passed, 0 failed, 0 skipped.

**Important limitation:** This was not the live hosted Supabase project.

**Status:** VERIFIED as isolated database verification; not treated as proof
of live deployment.

### Hosted Supabase verification

The hosted Supabase project initially had migrations only through 0009.
This was explicitly detected through linked migration history.

Migrations 0010 and 0011 were then deployed with:

`npx supabase db push`

The deployment completed successfully.

Three independent SQL Editor tests were then run against the hosted project:

1. **Invitation lifecycle** — PASS.
2. **Unrelated-user authorization** — PASS.
3. **Member invite + revoke authorization** — PASS.

These tests exercised both positive lifecycle behavior and negative
authorization boundaries.

**Status:** VERIFIED.

### Verification limitations

The following are not claimed as complete merely because Phase 5 security
tests passed:

- full production signup/login journey
- every browser/UI interaction
- full automated unit/integration/E2E suite
- production Vercel deployment
- Cloudflare R2 integration
- chat/Realtime
- ownership transfer
- future-phase functionality

These remain separate verification scopes.

---

## Phase 5 Git / Closure Record

**Implementation checkpoint:** `858bd7d`

**Commit message:** `Complete Phase 5 membership and invitation implementation`

This checkpoint predates the final hosted-database verification and therefore
must be treated as the **implementation checkpoint**, not as proof that the
entire Phase 5 closure process was complete.

After the checkpoint:

1. hosted migration history was inspected;
2. missing migrations 0010 and 0011 were deployed;
3. live security/lifecycle tests were run and passed;
4. project documentation is being reconciled with that verified state.

**Final closure status:** Phase 5 implementation and hosted security
verification are VERIFIED. The final documentation/Git closure checkpoint
must still be established from the actual current repository state.

---

## Graphify

**Decision:** Graphify may be used as supplementary codebase structure and
dependency context.

**Why:** It can make repository relationships easier to inspect without
replacing direct repository/database analysis.

**Status:** CURRENT DECISION.

**Important:** Generated Graphify output is derived data and may be stale after
code changes. The repository, database, migrations, tests, and project-control
documents remain authoritative.

The previously recorded Graphify source commit `21532f0f` predates the Phase 6
working tree and should therefore be treated as **STALE relative to the current
media implementation** until the graph is regenerated.

---

## Phase 6 — Media implementation decisions

These decisions are supported by migrations `0016`–`0018` and the current
application code. The user reports that the local PostgreSQL 17/Supabase reset
and security suite T1–T19 passed; this task did not rerun those checks. Hosted
Supabase behavior and live R2 behavior remain unverified.

### Upload confirmation stays behind trusted server code

**Decision:** `confirm_media_upload` and `fail_media_upload` require the
trusted server role, with EXECUTE granted to `service_role` and revoked from
`PUBLIC`, `anon`, and `authenticated`. Confirmation also verifies uploader,
current trip membership, pending state, and actual size. The application checks
the stored object before confirmation.

**Why:** A client must not mark a pending row ready without the server
verifying the corresponding uploaded object. Explicit grants and the function
role check provide separate enforcement layers.

**Status:** Supported by migrations `0016` and `0018`; local SQL test success is
user-reported. The hosted project’s service-role claim/session shape has not
been verified.

### Failed-upload state is committed before object cleanup

**Decision:** Oversize or content-type-mismatched uploads transition their
pending database row to `failed` through the server-only failure path before
best-effort R2 deletion. The function reports whether it changed the row so a
late failure call does not delete an object after another call made the row
ready.

**Why:** Raising an exception after updating inside the same RPC would roll
back the update. The ordering also avoids deleting an object when a concurrent
confirmation already succeeded.

**Status:** Supported by migration `0018` and the confirmation action; local
application/SQL test success is user-reported.

### Revoke unnecessary anonymous function execution

**Decision:** Migration `0017` explicitly revokes `anon` EXECUTE on the Phase 2
and Phase 5 SECURITY DEFINER functions, and revokes API-role execution on
trigger functions.

**Why:** Revoking from `PUBLIC` alone does not remove direct grants inherited
from database default privileges. The explicit revoke makes the intended
function boundary independent of whether those default privileges were
configured.

**Status:** Supported by migration `0017`; local SQL test success is
user-reported. Hosted grants have not been inspected in this task.

### User-facing media navigation and signed URL boundary

**Decision:** Viewer selection is represented by the `media` query parameter;
the media URL API is a batched Route Handler that performs a user-scoped lookup.
Storage keys and R2 signing stay server-side.

**Why:** A shareable/deep-linkable viewer state can coexist with user-scoped
authorization, while signed URLs and internal storage references remain out of
client route state.

**Status:** Supported by current application code and the approved Phase 6
Experience Specification. Browser and live R2 behavior remain unverified.

## Open / Future Decisions

### Ownership transfer

**Status:** FUTURE PLAN.

No ownership-transfer mechanism has been designed or implemented. This is why
the owner cannot currently leave their own trip.

### Cloudflare R2 operations

Application integration is present in the Phase 6 working tree. **Live
verification remains open** for bucket CORS, presigned PUT/Content-Type and
checksum behavior, signed GET, HEAD/confirm, deletion, and bulk deletion.
Reconciliation and stale pending-object cleanup remain future operational
decisions.

### Media chronology fallback

The schema keeps `captured_at` and `uploaded_at` separate. The Phase 6 timeline
uses capture time where valid and upload time as the fallback; invalid or
future capture timestamps are treated as unknown.

**Status:** Supported by the application and migration code. Local tests are
reported passed; browser chronology behavior has not been verified.

### Chat / Realtime

**Status:** FUTURE PLAN.

### Public discovery / social features

**Status:** OUT OF MVP SCOPE.

### Notifications

**Status:** FUTURE / not separately approved as a Phase 5 requirement.

### Password reset

**Status:** FUTURE PLAN / currently unassigned.

### Formal test tooling

**Status:** FUTURE PLAN.

Formal unit/integration/E2E tooling remains deferred. The Phase 5 SQL security
verification is a verified regression/security check, but it should not be
misrepresented as a complete application-wide automated test suite.

---

## Documentation Governance

Keep the project documents distinct:

| File | Purpose |
|---|---|
| `CLAUDE.md` | How the AI should operate |
| `TRIP_CHALO_MASTER.md` | Long-term WHAT / durable architecture |
| `TRIP_CHALO_CURRENT_STATE.md` | Current WHERE / verified project state |
| `TRIP_CHALO_DECISION_LOG.md` | Historical and architectural WHY |
| `TRIP_CHALO_HANDOFF.md` | Short-term NEXT / session handoff |

Do not copy entire documents into one another.

When implementation changes a decision, update this log with the reason and
status. When verification changes the confidence level, update the status.
Never turn an inference into a verified claim merely because it appears in an
older document.
