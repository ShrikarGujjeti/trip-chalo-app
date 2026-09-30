# Trip Chalo — Product Experience + Interaction Specification (Final, Phase 6, v2)

**Status:** Final. Incorporates the independent audit of the pre-implementation draft (v1) and a second review pass covering editorial composition, gallery density, day/chapter pacing, viewer continuity, motion technique and accessibility sourcing (v2).
**Audience:** the implementation agent. This document is the implementation contract for Phase 6 (web). It is self-contained — it does not require the v1 document or prior conversation to be read alongside it.
**Scope:** experience and interaction only. No code, no dependency changes, no schema changes are made by this document.

**What changed in v2 (see the Change Log at the end for full detail):** the viewer's routing/continuity technique is now a firm recommendation (Next.js intercepting + parallel routes) rather than an open question; video tiles get a real first-frame preview in Core rather than a deferred placeholder; motion technique for the open/close transition is now a firm recommendation (the View Transitions API, used as a zero-cost progressive enhancement); the touch-target size is now correctly sourced; a deterministic, non-AI gallery-density rule ("featured" tiles after a time gap) is added as a testable hypothesis; day-as-chapter orientation gets two small additions; an invitation state machine and an explicit chat non-scope note are added. Every v1 decision not listed above is unchanged and is restated here for completeness, not re-derived.

---

## 0. How to read this

### 0.1 Tags

| Tag | Meaning | How to treat it |
|---|---|---|
| **[D]** | DECIDED — established product direction | Binding |
| **[R]** | RECOMMENDED — strong proposal, not yet a permanent product decision | Binding unless the owner overrides |
| **[H]** | HYPOTHESIS — validate with real users and devices | A starting value. Implement as a named constant or token so it can change without rework. Never a requirement |
| **[F]** | FUTURE — outside Phase 6 | Do not implement. Do not block |

Priority tiers: **Core** (must ship in Phase 6) and **Tier 2** (ship only after all Core is done, in the listed order). "Tier 2" is a priority label. It is unrelated to design principle P2.

### 0.2 Evidence basis and limits

This specification was written from a snapshot of the repository (migrations 0001–0015; the media, storage, trips, invitations and memberships modules; `project-tree.txt`; the project documents). The repository HEAD was **not** available when this was written. Anything marked "verify" below must be checked against HEAD before it is relied on.

### 0.3 Preflight — do this before writing any code

1. **Inspect HEAD for Phase 5 UI.** Does any route or component invoke `acceptInvitationAction`, `declineInvitationAction`, `revokeInvitationAction`, `inviteMemberAction` or `leaveTripAction`? Does any page render `MemberList`, `PendingInvitationsList` or `InvitedTripPreviewCard`? Record the result. It decides whether C17 exists (OD4). At snapshot time the answer was no: components and actions existed but nothing wired them.
2. **Inspect the current trip page** (`src/app/(app)/trips/[tripId]/page.tsx`) and record what it renders today.
3. **Verify the hosted PostgREST max-rows setting.** Locally `supabase/config.toml` sets `max_rows = 1000`. The hosted value is not in the repository.
4. **Verify R2 bucket CORS** allows a browser PUT (origin, `PUT`, `Content-Type` header) for the local and deployed origins. Run the request → PUT → confirm flow once end to end with a real file. The snapshot contains no evidence that this has been exercised.
5. **Confirm how the repo's Next.js version dispatches concurrent Server Action calls** before choosing the OD3 mechanism. My understanding, not verified here, is that client-invoked Server Actions are dispatched one at a time.
6. **Check on a real iPhone** how the file input's `accept` value affects HEIC handling (converted to JPEG, or delivered as HEIC).
7. **Create at least two test accounts in one trip** (via the existing invite/accept actions or SQL). Attribution and the person filter cannot be tested with one member.

### 0.4 Backend reality (what exists — do not invent beyond it)

| Area | What exists | Design consequence |
|---|---|---|
| Media list | `listTripMedia`: `ready` rows only, ordered by `chronology_at` (= `coalesce(captured_at, uploaded_at)`) then `id`. Metadata only, no URLs. Columns include width, height, duration, mime, size, filename, nullable `uploader_id`. No limit or range is applied. | Grouping, ordering and attribution need no extra queries. The API row cap applies (local config 1000; hosted **unverified**). |
| Image bytes | Originals only (≤ 25 MiB photo, ≤ 200 MiB video). No thumbnails, derivatives or placeholder data. | Sets the ceiling on grid performance (§18, OD2). |
| Download URLs | `getMediaDownloadUrl(id)`: re-runs an RLS-checked lookup on every call and presigns a URL valid 300 s. It is a server-side function and cannot be called from the browser. It does **not** validate the id shape. Presigned GETs carry no cache headers. | A URL from a page render expires after 5 minutes. Tiles and the viewer need URLs obtained close to use (OD3). |
| Access rule for media | `media_select_member` (as amended by 0015) admits the **uploader or a current member**. | A departed uploader can still read and delete their own uploads by id. Intentional (0015), and unreachable from the UI. |
| Upload | Request action → browser PUT to a signed URL (Content-Type is part of the signature) → confirm action (server verifies the R2 object; the only path to `ready`). Pending rows are hidden from the timeline. | The client owns the queue. Confirm does not revalidate the page. |
| Retry / cleanup | A request always creates a **new** row. There is no server-side sweeper for abandoned pending rows. The client holds the `mediaId`, and the existing `deleteMediaAction` can delete the uploader's own pending row (best effort). | Retry semantics depend on which step failed (§13). |
| Untrusted metadata | Width, height, duration and `captured_at` are client-supplied and not validated server-side. Only the filename is length-capped. | The client treats them as untrusted when laying out (§5). |
| Delete | Uploader or owner (RLS). The database is authoritative; R2 cleanup is best effort. `deleteMediaAction` revalidates the trip path. | Show Remove only to uploader or owner (presentation only). |
| Members | `listTripMembers` returns name, role, joined date and `avatar_url` (nothing observed setting it, so initials only). Profiles are visible to co-members only. | An uploader who left cannot be named: "A former member". An invitee cannot see the inviter's name. |
| Not present | Cover photo or colour, trip time zone, capture offset, last-seen, captions, places, favourites, video posters, forced download, member-removal action, batch member or count queries, typed error codes, realtime UI, pending-row sweeper, pagination. | Not in Phase 6. Do not fake them. |

### 0.5 Open decisions (owner approval needed)

| # | Decision | Recommendation |
|---|---|---|
| **OD1** | Time zone for time-of-day labels and day grouping: viewer-local, or UTC (the current convention, labelled). | **Viewer-local.** UTC would show a Mumbai 6:40 pm photo as 1:10 pm. Cost: grouping happens in the browser behind a height-stable skeleton, and viewers in different zones may see different day splits. A trip time zone [F] later replaces this. |
| **OD2** | The Phase 6 grid must load originals because no derivatives exist. | Proceed with originals, with strict windowing and capped concurrency (§18). Approve derivatives as the first post-Phase-6 item before any real-group or mobile use. |
| **OD3** | Two thin server-side additions. **(a)** An **authenticated server entry point** for obtaining signed URLs (browser → app server → the existing RLS-checked lookup → short-lived signed URL). It accepts multiple media ids per call (bounded by window size), validates each with `isMediaId`, returns `{id, url, ttlSeconds}` or a uniform "unavailable", and never exposes storage keys or R2 credentials. A Route Handler is preferred [R] (batching, future native reuse); a Server Action is acceptable for the single-item viewer. **(b)** A client-triggered, coalesced list refresh after confirms (preferred over `revalidatePath` inside every confirm). | Approve both. Neither adds a new capability. |
| **OD4** | Phase 5 people, invite and inbox UI. | Verify per §0.3. It is "absent" if no route or component invokes the Phase 5 actions and no page renders the Phase 5 list/preview components. If absent, building it is a **separate, approved addition with a single owner** (C17). It is not part of Phase 6 Core. |
| **OD5** | Source of `captured_at` when uploading. | **EXIF `DateTimeOriginal` when readable** (using `OffsetTimeOriginal` if present, otherwise interpreted in the uploader's browser zone, a known approximation), **else null.** `File.lastModified` is **not** used unless the owner explicitly accepts that wrong values are permanent and unlabelled (no source column exists and media rows cannot be updated). Without an EXIF reader, most photos, and all videos, appear under Undated, so the owner must decide whether a small EXIF reader dependency is approved for Phase 6. |
| **OD6** | Dark-mode phasing. | Define tokens for both modes now. Ship Phase 6 light-only app-wide (this fixes the inferred dark-mode breakage in Phase 3–5 screens, which use fixed `text-gray-*` classes over a background that switches dark), with an always-dark viewer. Enable dark mode app-wide when the Phase 8 retheme has tokenised every screen. |

---

## 1. Overall product experience

- **[D]** The concept is **"the trip, told by everyone."** Photos, people and time are the experience. Everything else is support. Privacy is felt as intimacy, not security UI.
- **[R]** Opening a trip should feel like re-entering a room the group left the lights on in: quiet, immediate and complete. One continuous chronological flow merges every phone. Attribution is always one gesture away and never loud. Photographs are the only saturated thing on screen.
- **[R]** "Trip as a book" survives in three small ways: a considered arrival (the title block), days as headings, and a finished trip that can end [F]. No page turns, spines, paper texture or shelf.
- **[D]** The web app is the current product. A genuine native app comes later. Interaction quality is a first-class requirement on both.
- **Scope note:** this document describes the target experience. Appendix C defines what Phase 6 ships: the media core (timeline, viewer, upload, delete) inside the existing trip page. Home restyle, the full visual system, dark mode and header polish belong to Phase 8.

## 2. Design principles

| ID | Principle | Tag |
|---|---|---|
| P1 | The trip, told by everyone. Chronology merges all contributors. Attribution is always one gesture away. | D |
| P2 | Photos are the only saturated thing. The interface has no brand colour. | R |
| P3 | Time as people remember it. Whitespace expresses gaps in time. The exact rules are tunable. | R (principle), H (rules) |
| P4 | Privacy is warmth. No padlocks, shields, "secure" or "encrypted" language. | D |
| P5 | Nothing performs. Motion communicates what changed and never decorates. | D |
| P6 | Stability. Space is reserved before content arrives. Layouts never jump. | D |
| P7 | Never hide or crop a photo to tidy a layout. | R |
| P8 | Immediate response. Feedback lands within a frame. Optimism only where failure is recoverable. | D |
| P9 | Honest about limits: undated photos, unavailable previews, uploads that need the tab open. | R |
| P10 | Every state is designed: loading, empty, error, permission. | D |
| P11 | Share rules, tokens and semantics across web and native. Never lock in shared components. | D |

## 3. Visual language

- **[R] The room.** Two designed neutral modes. Photos sit on the most neutral surfaces. Tints are allowed only on typographic surfaces away from photos. No gradients, glass, glow or decorative shadow. Separation is by luminance step or a 1px hairline. Shadows only on floating elements.
- **[R] Surfaces.** Three levels: page, raised (sheets, menus, tray), overlay (viewer). Cards only for real objects (an invitation, the upload tray, a member), never for content.
- **[H] The lamp.** One warm accent, used only as a dot or hairline for "active" (upload in progress, "you are here" in the day index). It never carries meaning alone and is never used for buttons or links. If it reads as decoration, drop it and use plain ink.
- **[R] Trip colour.** A muted ink per trip, derived deterministically from the trip id, for typographic covers (Phase 8). A cover-photo-derived colour is [F] (no cover reference exists).
- **[R] Radii, icons, imagery.** Photo tiles 2–4px. Floating sheets and menus 14–16px, concentric with their content. One outline icon family at a single stroke weight, few icons, with text labels wherever meaning matters (library unchosen [H]). Only user photographs as imagery: no illustration, mascots or emoji stickers.
- **[R] Buttons and focus.** Primary button is ink on paper in light mode and paper on ink in dark. Danger is one muted brick tone, used sparingly. Success is words plus a check, with no colour. Focus ring: 2px in the ink colour with a 2px offset, in both modes.

**Token roles** (intent, shareable with native as data). The values are **[H] starting points** with a hand-computed AA spot-check for secondary text, danger and the light lamp. Re-verify with tooling using the real palette. Text ≥ 4.5:1, non-text ≥ 3:1.

| Role | Light | Dark |
|---|---|---|
| `surface.page` | #F8F7F5 | #0E0E0F |
| `surface.raised` | #FFFFFF | #1A1A1B |
| `media.placeholder` | #E6E5E2 | #232324 |
| `ink.primary` | #171716 | #EDEDEB |
| `ink.secondary` (also timestamps, which must pass AA) | #5C5B56 | #A6A5A0 |
| `hairline` | #E2E1DD | #2C2C2D |
| `lamp` | #B7791F | #E0B45A |
| `danger` | #A63D2F | #E88C80 |
| `viewer.backdrop` | #000 (always) | #000 |

## 4. Typography

- **[R] Sans.** The project loads Geist, but `globals.css` sets `body` to Arial, so Geist is not applied. Applying it globally changes every existing screen, so it is a deliberate, approved change, not a side effect.
- **[R] Two-voice rule.** Text a person wrote or named (trip title, description, future captions and notes) is serif. Everything the app says (day headings, timestamps, buttons, counts) is sans.
- **[H] Serif family.** Undecided. Choose by testing candidates with real Latin and Devanagari titles. Phase 6 introduces no serif and only defines a `font.voice` token that falls back to the sans.
- **[R] Devanagari.** Users will plausibly write names and titles in Hindi. Every font stack needs an explicit Devanagari fallback and about 10% extra line height for mixed-script text. Test mixed-script baselines with real names.
- **[R] Numerals and inputs.** Tabular numerals for times, dates and counts. Inputs are at least 16px, which avoids iOS focus-zoom.
- **[R] Truncation.** Titles wrap and never truncate. Names truncate with an ellipsis only in dense UI.

**Scale roles** (mobile / desktop, **[H]** starting values):

| Role | Mobile | Desktop |
|---|---|---|
| Trip title | 32/38 | 44/48 |
| Day heading | 22/28 | 28/34 |
| Body | 16/24 | 16/24 |
| UI label | 14/20 | 14/20 |
| Meta (timestamps, counts) | 13/18 | 13/18 |

## 5. Spacing and layout

- **[R]** 4px base unit. Scale 4, 8, 12, 16, 24, 32, 48, 64, 96. Prose measure about 60–66 characters.
- **[R] Photos.** Justified rows at true aspect ratios, never cropped, with a 2px gap.
  - **[H]** Target row height about 160–200px on phones and 220–280px on desktop. The last row is not stretched beyond about 1.3×.
  - **[R] Untrusted dimensions.** Width and height are client-supplied. A non-finite or ≤ 0 value is treated as null. The layout clamps the aspect ratio to a tunable range (**[H]** about 1:4 to 8:1). The viewer always shows the true image. A tile with null dimensions reserves a 4:3 box and shows the image contained, so it never reflows on load.
  - **[R] Measuring.** When the client measures dimensions, it does so via browser decode (orientation-applied), not raw EXIF dimensions, which can be pre-rotation. If the browser cannot decode the file (for example HEIC outside Safari), dimensions are null.
- **[H] Featured tiles (gallery density, editorial composition).** A single photo may be laid out larger than the baseline column width, to give the gallery occasional editorial weight without inventing curation or ranking. The rule is deterministic and derived only from data already in the schema:
  - **Trigger:** the first photo (never a video) in a cluster that starts a day, or that follows a time gap at or above the T6 threshold (§10).
  - **Size:** about 1.6–2× the baseline column width, at the photo's true aspect ratio. This is a width allocation inside the justified layout, never a crop — it does not conflict with "never crop or hide a photo" (P7), because the photo is simply given more of the row, not trimmed to fit a fixed frame.
  - **Limits:** at most one featured tile per day and one per gap-triggered cluster. If honoring it would push the row past the existing last-row stretch cap (1.3×, above), skip the feature for that instance rather than compromise the layout.
  - **Implementation shape:** a pure function `isFeatured(gapSeconds, isFirstOfDay, isPhoto) → boolean`, kept outside any DOM or Next.js-specific code so it can be reused by a future native layout engine (Appendix G).
  - **Status:** unvalidated. Ship behind a single named constant so it can be disabled with no other change if it reads as arbitrary rather than editorial once tested against real trips.
- **[R] Whitespace is chronology.** Within a day, clusters are separated by more space than photos within a cluster, and days by much more than clusters. **[H]** Starting values: 24–32px between clusters, 64–96px between days.
- **[R] Phones.** Media edge to edge, text at 16px inset, safe-area insets respected. The existing shell adds about 40px of horizontal padding (`main p-6` plus `px-4`), so full-bleed is a layout decision on the trip page, never a global change and never a cause of horizontal scroll.
- **[D]** Space is reserved before load. No layout shift in the media area.

## 6. Light and dark mode

- **[R]** Both modes are designed, not inverted. Text is never pure black or white. The viewer is always dark, in both modes, and the light grid fades into it without a white flash.
- **[R]** Follow the system setting once dark is enabled (OD6). Phasing per OD6.
- **[H]** Contrast values in §3 must be verified with real photos in both modes.

## 7. Motion and interaction principles

- **[D] Motion communicates change.** No decorative motion, parallax, bounce or scroll-jacking. Stillness is the default.
- **[D] Spatial coherence.** Opening a photo must feel continuous with its tile, and closing must return to it. **[R]** Recommended technique: the browser's native View Transitions API (`document.startViewTransition()`), called as a progressive enhancement wrapping the DOM update that opens or closes the viewer (see §11 for the routing this pairs with). It is feature-detected (`if (!document.startViewTransition) { …update normally… }`), so unsupported browsers pay no cost and get exactly the specified fallback below for free — this is not a separate code path to maintain, it is the natural behaviour of calling an API that doesn't exist. Same-document view transitions have been supported in Chromium browsers since 2023; Firefox and Safari support is newer, so verify current coverage at build time, but because the fallback is free this can be adopted now regardless of the exact matrix. Exact choreography (which elements get a `view-transition-name`, duration, easing) is **[H]**. The fallback for everyone else, and for reduced-motion users regardless of support, is a crossfade or instant change.
- **[D] Immediate feedback.** Pressed state within one frame. No hover-only affordances: every hover action has a touch and keyboard equivalent. **[R]** Touch targets are at least 44×44 CSS px. This is the Apple HIG / Material Design convention (and WCAG's AAA-level 2.5.5), chosen because it matches "comparable to a well-designed iPhone app" — it is stricter than the WCAG Level AA floor (SC 2.5.8: 24×24 CSS px), which this design deliberately exceeds rather than merely meets.
- **[R] Interruptible.** Open, close and sheet transitions can be cancelled or reversed mid-way.
- **[R] Motion tokens as intent, not implementation.** Named roles: press (≤ 100ms), quick (about 150–200ms), standard (about 250–320ms), and a release spring for drag. One easing family. All values **[H]**. Native will realise the same intent with platform physics.
- **[R] Optimism only where failure is recoverable.** Upload placeholders are optimistic. Delete is not (there is no undo), so it shows a pending state.
- **[R] History.** The viewer participates in browser history, so back and swipe-back close it.
- **[R]** Scroll position is never lost. Closing the viewer, finishing an upload or a refresh must not reset scroll.

## 8. Home (`/trips`) — Phase 8 target, no Phase 6 change

- **[R]** Pending invitations lead, because most people in a group arrive by invitation. Each shows the trip name and dates only (the preview RPC's shape). The copy cannot name the inviter, because the invitee cannot read the inviter's profile. Copy **[H]**: "You've been invited to Hampi · 14–19 Feb", with Accept and Decline.
- **[R]** Below that, the person's trips as large typographic covers in a single column (trip colour field, serif title, dates). Order is the existing newest-first. "Trip in progress rises to the top" **[H]** is derivable from dates.
- **[F]** Face stacks, "N new" and memory counts on home need batch queries and last-seen data that do not exist.
- **[R]** Empty state: a single primary action. Copy **[H]**: "No trips yet. Start one when you're ready."

## 9. Trip overview (`/trips/[tripId]`)

**Phase 6 Core touches the trip header only to add the "Add memories" action.** The existing header (title, dates, description, owner Edit/Delete) is otherwise unchanged. The Memories section is new.

Target composition (Phase 8 unless listed as Tier 2):
1. Title block: title, dates and length ("14–19 Feb · 6 days", computed from the date-only columns; existing "No dates set" fallback), description (clamp long ones with a "more" control).
2. People line: overlapping initials avatars (max 4–5 plus "+N") and a privacy line built from the member count: "Just the five of you." At one member: "Just you, for now." Wording **[H]**. No lock iconography.
3. Actions: **Add memories** (primary). Owner Edit and Delete secondary (moving them into an overflow menu is Phase 8).
4. Memories section: count, person filter, day index, days.

**Tier 2:** people line and privacy line, trip-length text, description clamp, and the sticky bar. **Sticky bar [R]:** when the title block scrolls away, a slim top bar shows the trip title and the Add action. It is top-placed for stability on mobile browsers whose toolbars resize. Bottom or thumb-zone placement is a native concern **[F]**.

**[R] Cover.** Phase 6 has no cover image (no cover reference exists), so the title block is a typographic cover. A hero photo, cover-derived colour and a finished-trip colophon are **[F]**. "In progress" and "ended" postures are **[H]/[F]**.

## 10. Chronological timeline and day experience

- **T1 [D]** The flow is ordered by **capture time**. Items without a capture time are **never placed by upload time inside a day**. They appear only in Undated (T5), ordered by upload time. The list is partitioned by `captured_at IS NULL`, **not** by `chronology_at`. `id` is the deterministic tie-break.
- **T2 [R]** Grouping is by calendar day in the display time zone (OD1). The boundary is one named constant, initially midnight. A late-night offset such as 04:00 is **[H]**, unvalidated, and must stay a constant, never hard-coded logic.
- **T3 [R]** Days without media do not render. Phase 6 shows no "quiet day" markers.
- **T4 [R]** Day heading: "Day 3" (only if the trip has a start date and the day falls within it), the date, and a memory count. App-generated, so sans.
- **T5 [R] Undated.** Items with a null capture time go into a final "Undated" section, ordered by upload time. It is honest about not knowing their place.
- **T6 [R] Time markers.** A quiet time label appears at the start of each cluster separated by a gap. The gap threshold is a tunable constant, initially 30 minutes **[H]**. Time is shown precisely ("6:42 pm"). Human buckets such as "Tuesday evening" are **[H]** (Phase 8, validate).
- **T7 [H] Contributors (Tier 2).** The marker also shows overlapping avatars and a count when two or more people contributed to the cluster ("3 of you"), derived from `uploader_id`. Full display names appear in accessible labels and the viewer.
- **T8 [R] Person filter (Tier 2).** "Sana's photos · 84", with one control to return to everyone. Client-side over the loaded list. It also scopes viewer navigation.
- **T9 [R] Day index (Tier 2).** A compact list of days that jumps to a day, with the lamp on the current day. **[R]** "Current day" is determined by an `IntersectionObserver` on the day headings as the user scrolls, not by scroll-position math — this gives chapter-like orientation with no motion, consistent with "stillness is the default" (§7). A photo still per day is **[F]** (needs derivatives).
- **T10 [R] Sticky day heading (Tier 2).** While a day's content is in view, its heading may stick to the top edge of the scroll container (`position: sticky`, no JavaScript animation) before yielding to the next day's heading. Presentation-only; no data or state implications.

**[H] Featured tiles (Tier 2).** The deterministic "featured photo after a gap or at day-start" rule is specified in §5. It replaces the earlier, unresolved "scale follows silence" idea with a concrete, testable mechanism — ship it disabled-by-default behind one constant until validated against real trips.
**[H]** Still not Phase 6: morning/afternoon/evening/night segments as a visual treatment, and the 4 am day boundary as actual behaviour (§10 T2 keeps midnight as the constant until validated).
**[F]** A "since your last visit" divider (needs per-user last-seen), day notes, and chat lines in the timeline.

## 11. Photo/video viewer

**Structure.** A full-viewport dark overlay with dialog semantics. It contains the media (contained, never cropped), a top bar (close, "12 / 84", details toggle), previous/next controls, and a details panel.

- **Open/close [D principle].** Continuous with the tapped tile. Close returns to the last-viewed tile, and the grid scrolls to keep it visible (nearest edge). See "Routing and continuity technique" below for the recommended mechanism.
- **Close [R].** Close button, Esc, browser back or swipe-back, and pull-down on touch (Tier 2; feasibility and quality on mobile browsers are **[H]**). The backdrop follows the finger during pull-down. If the gesture proves poor, the other paths must still work.
- **Navigate [R].** Arrow keys, swipe, and buttons. No wrap-around. Order equals timeline order, scoped by the active person filter. Prefetch at most the adjacent next and previous items, and only after the current one has settled **[H]**.
- **Zoom [R], Tier 2.** Double-tap or click zooms with pan. Pinch is an enhancement. Never disable the browser's own zoom.
- **Chrome [R].** It fades after idle (about 2–3s **[H]**) and returns on tap. It never auto-hides while keyboard or assistive focus is inside it.
- **Sizing [R].** The image is bounded to a soft maximum (about 85% of viewport width/height **[H]**) and is never upscaled past the source's natural pixel size at that bound. This keeps "contained, never cropped" from reading as "arbitrarily enormous" on a large or ultrawide monitor — it is a display cap, not a crop.
- **Orientation changes [R].** Rotating the device re-flows the contained layout in place. It never resets the current index, closes the viewer, discards the details-panel open/closed state, or triggers a new URL fetch (a held URL, below, survives a layout change).
- **Video [R], Core.** Native controls, plays inline, sound on because the user tapped, no autoplay. Pause on navigation or close. Never preload full video for neighbouring items. **First-frame preview (Core, not deferred):** render the tile itself as `<video preload="metadata" muted playsinline src="{freshURL}#t=0.001">`, overlaid with the play glyph and duration; fall back to the neutral placeholder on load error. The `#t=0.001` fragment exists because at least one major mobile browser shows a blank rectangle instead of the first frame when no `poster` is set — the fragment forces a near-zero-timestamp seek that produces a real thumbnail with no server-side processing. This must obey the same load-window and concurrency budget as images (§18): only tiles inside the visible window fetch metadata, never the whole trip at once, or the fix becomes a mobile-data cost of its own.
- **Details panel [R].** "Added by {name}" (or "A former member"), the time (precise, in the display zone), and a secondary reveal with filename, dimensions and size. If the capture time is null: "No capture time, shown by upload time." Actions: **Open original** and **Remove** (uploader or owner only).
- **Open original [R].** Opens a **fresh** signed URL in a new tab (with `noopener`). Whether the browser downloads or displays it is the browser's choice, since no forced download exists **[F]**. It is also the fallback for previews the browser cannot render.
- **Remove [R].** Inline confirmation, same pattern as the existing trip-delete panel: "Remove this photo for everyone in {trip}? This can't be undone." A pending state, then the viewer advances to the next item (or closes if none).

**Routing and continuity technique [R, upgraded from a v1 open question].** Recommended baseline: **Next.js parallel + intercepting routes** — a `@modal` slot intercepting `/trips/[tripId]/media/[mediaId]` from the trip page (the `(.)` convention, sibling-level interception). This is Next's documented, purpose-built pattern for exactly this UI shape: opening a photo from a feed shows a modal and updates the URL; navigating to that URL directly, or refreshing while it's open, renders the full page instead of the modal; back navigation closes the modal rather than leaving the route; and the underlying feed's scroll position is preserved because it stays mounted rather than being replaced. One recommendation therefore answers four previously-separate open questions (shareable deep links, refresh safety, back-button behaviour, scroll preservation) at once.
- **Verify before relying on it [H]:** this pattern has documented edge cases in the wider ecosystem — it can interfere with direct navigation to the non-intercepted route from certain other pages, and parallel-route segments can re-render unexpectedly if data fetching isn't hoisted to a shared layout rather than fetched inside the modal route itself. Test it against the installed Next.js version before committing to it.
- **Fallback [R], no functionality lost:** if verification fails, fall back to reflecting the open item as a query parameter on the existing route (for example `?media=<id>`) so that back still closes the viewer and the id is still deep-linkable, without the "true separate route" refresh behaviour. A deep link to an item the viewer cannot access shows "This memory was removed" either way.
- **Motion pairing [R]:** wrap the modal's open/close DOM update in `document.startViewTransition()` where available (§7). This is independent of which routing technique is used — it works the same way whether the modal comes from an intercepted route or from query-parameter state.

**URL rules for images and video.**
- **[D]** Every URL issuance re-checks authorization server-side. URLs are short-lived (300 s) and are never persisted, and never memoised server-side.
- **[R]** The client may **reuse an issued URL for the same media within its lifetime minus a safety margin** (about 60 s **[H]**). That includes the viewer's full image and video range requests, and showing the tile's already-loaded image as the viewer's placeholder. It requests a new URL when the held one is near expiry, after a load error, and **always for Open original**.
- **[R]** Issued URLs are held in memory only, with their issue time. Never in browser storage, and never in the URL bar of the app (the `?media=` value is the media id, never a signed URL).

## 12. People and member experience

Implement only per Appendix C (C17 is conditional, OD4).

- **[R] People sheet** from the face stack: members (name, joined date, "Owner" as role), and for the owner or an inviter, pending invitations with revoke.
- **[R] Invite form** (email). Because RLS lets any new member see the whole trip history, the copy must say so: "They'll see everything in this trip, including what's already here."
- **[R] Invite state machine:** `Idle → Sending → Sent`. There is no realtime layer and no read/delivery signal, so **"Sent" is the only state the inviter's own session can confirm.** Whether the invitation was later accepted is visible only on a subsequent load of the existing pending-invitations list, not as a live update. Do not imply a smoother "Accepted" transition inside this same session — that would show something the system hasn't actually confirmed (§14 truth rule).
- **[R] Leave.** Non-owners can leave, with a confirmation: "Your photos and videos stay in the trip." This is accurate: leaving removes only the membership row. Owners cannot leave (existing message).
- **[R]** Tapping a person offers "See the trip through {name}'s photos" (T8). No profile page, contribution counts or leaderboards.
- **[F]** Member removal (the policy exists but no action does), avatar upload, batch member queries.

## 13. Add-memory / upload experience

**Entry [R].** One **Add memories** action opens the native file picker directly (multiple; accept list from the existing allowlist). No intermediate modal. On phones the system picker offers library or camera. (Verify how `accept` affects iOS HEIC handling — §0.3.)

**Pipeline per file [D]** (the existing contract): pre-check → request action → browser PUT of the file with the same content type → confirm action → visible in the timeline.
- Pre-checks use the existing validators for type and size. A file that fails is rejected locally and never sent.
- The client measures width, height and (for video) duration itself. Capture time follows OD5. Values that fail sanity checks are dropped to null: non-finite or ≤ 0 dimensions, and `captured_at` in the future or before 1990 **[H]**.

**Queue states [R]:** `queued → requesting → uploading (progress) → confirming → done`; `failed (retryable)`; `rejected (local)`. The queue is in-memory only and is lost on reload **[F]** persistence. **Request a URL only when an upload slot is free** (the URL lives 300 s). Never request URLs for the whole batch up front.

**Retry depends on the step that failed [R].**
- Failure in `requesting` or `uploading`: retry makes a new request and a new PUT.
- Failure in `confirming`: refresh the list. If the item is present, mark it done. Otherwise call confirm again with the **same `mediaId`**. Never re-upload bytes for a confirm failure.
- Server-returned messages are shown as-is. Do not string-match them to invent distinct states.

**Cancel [R].** A queued item can be cancelled (Core). An item in `uploading` can be cancelled by aborting the PUT (Tier 2). Items in `requesting` or `confirming` are not cancellable. An aborted single PUT leaves no object in R2.

**Abandoned pending rows.** They are invisible and harmless. A server-side sweeper is **[F]**. **[R, optional]** The client may delete a known pending row it created (cancel or failed PUT) by calling the existing `deleteMediaAction` with its `mediaId`, as a best-effort cleanup.

**Tray [R].** A single quiet pill ("Adding 3 of 14") that expands into a tray. Each row shows a local preview, name, progress and, when needed, Retry. The lamp marks active progress. Byte-level progress if the technique allows, otherwise indeterminate. Concurrency is capped low (2–3 **[H]**). Files stream to the request and are never loaded fully into memory.

**Completion [R].** The timeline refreshes with a trailing debounce (about 1–2 s **[H]**) and once when the queue drains, preserving scroll (OD3b). Final line: "Added. Everyone in {trip} can see these." No confetti.

**Honesty [R].** While uploads are active: "Keep Trip Chalo open until this finishes." A leave-page warning is shown. The design does not pretend the web can upload in the background.

**[H]** Ghost tiles at the item's chronological position, dimmed and clearing when done, are the target, not Core (Tier 2). Core is the tray plus refresh.

**[R] Tier 2:** Desktop drag-and-drop with a "Drop to add to {trip}" veil. The button remains the primary and accessible path.

**Copy [R], wording [H]:** "Couldn't add this one. Check your connection and try again." "That's a big one. Clips can be up to 200 MB." "This file type isn't supported."

## 14. Loading, empty, error and permission states

| Surface | State | Behaviour |
|---|---|---|
| Trip page | Loading | The header renders first. The Memories area reserves height with a quiet skeleton, so nothing jumps when grouping resolves (OD1). |
| Trip page | Media load failure | Inline, in the Memories section only: "Couldn't load memories." with Retry. The header stays visible. Do not send it to the full-page `trips` error boundary. |
| Timeline | **Truncated list** | The list query uses an explicit limit at or below the verified row cap and detects truncation by exact count or limit+1, **never by comparing with a hardcoded number.** If truncated, show "Showing the earliest {N} memories; newer ones aren't shown yet.", with N the returned count. Filters and viewer navigation operate on the loaded set only. Pagination is [F]. |
| Timeline | Empty trip | Two actions: "Add the first memory" and, if the C17 UI exists, "Invite the others." |
| Timeline | Filter empty | "No photos from {name} yet." plus a return-to-everyone control. |
| Tile | Loading | Reserved aspect box, neutral fill, fade-in on load. |
| Tile | Image fails (expired URL, network) | One silent retry with a fresh URL, then a neutral tile with a retry affordance. |
| Tile/viewer | Preview unavailable (HEIC/HEIF, some MOV, unsupported in the browser) | "Can't preview this here." with **Open original**. Never a broken image. |
| Viewer | Loading | The tile's loaded image shows instantly, then the full image swaps in with no flash. |
| Viewer | Item no longer available | "This memory was removed." with Next. |
| Upload | Rejected locally / failed / cannot confirm | Per §13. |
| Upload | Session ended | "Your session ended. Sign in to continue." Return to the trip after login. The queue does not survive navigation. |
| Delete | Not permitted / not found | The existing single message (the two cases are indistinguishable by design). |
| Trip | Not a member | Existing not-found, unchanged **[D]**. |

**Tone rules [R]:** plain, warm, sentence case, no exclamation marks, no technical terms, no blame. Errors offer a next action and never use an alarm box.

## 15. Responsive web behaviour

Breakpoints follow Tailwind defaults (640, 1024) **[H]**.

| | Phone | Tablet | Desktop |
|---|---|---|---|
| Media width | Edge to edge | Contained | Contained, wider than prose (**[H]** about 1100–1200px); prose about 640–720px |
| Viewer | Full-bleed, swipe, pull-down | Same, with visible arrows | Arrows on hover/focus, keyboard (arrows, Esc, `i` for details) |
| Details | Bottom sheet | Bottom sheet | Side panel within the viewer **[H]** |
| Sheets | Bottom | Bottom | Bottom or centred (**[H]**) |
| Add | Header button, native picker | Same | Same, plus drag-and-drop (Tier 2) |

- **[R]** Same content model everywhere: one stream, wider on desktop. No permanent inspector, three-pane or dashboard layout.
- **[R]** Use `dvh` units and respect safe-area insets. Never place essential controls where mobile browser toolbars overlap.

## 16. Future native mobile (experience intent, all [F])

Native should feel like a genuine iPhone- or Android-grade product, not this web UI in a shell.
- **Native for controls, ours for content [R].** System sheets, pickers, context menus, share sheet, haptics and platform navigation (back-stack, large titles) are native. The cover, grid, viewer, typography and face stack are ours.
- **Photos.** System photo picker, background uploads that survive backgrounding, "Save to Photos", and share extension intake.
- **Viewer.** Native gestures and shared-element transitions, validated on real devices before commitment **[H]**.
- **Time.** Device capture time with offset, feeding the trip time zone.
- **Navigation.** A bottom tab bar arrives only if chat creates a second top-level destination. The trip-scoped flow uses back-stack navigation.
- **Also:** push notifications, offline reading, Dynamic Type and VoiceOver as first-class.
- **Preconditions.** Derivatives and placeholder data, a native-callable upload contract, and a token-authenticated signed-URL entry point must exist before native ships.

## 17. Accessibility

- **[D]** The experience must be usable by keyboard, screen reader and touch, at 200% text size.
- **[R] Structure.** Each day is a heading. Media is an ordered list in chronological DOM order (the visual justified layout is presentation only). Tiles are buttons with names like "Photo, 6:42 pm, added by {name}" and "Video, 0:42, …".
- **[R] Viewer.** Dialog role with a labelled title, focus trap, focus returns to the originating tile, Esc closes, arrows navigate, and a polite live region announces "Photo 12 of 84". Chrome is reachable without a pointer.
- **[R] Upload.** Announce by summary through a polite status region, not per-percent. Errors use an alert region.
- **[R] Contrast and colour.** Timestamps and meta text meet AA. Nothing depends on colour alone (the lamp always has a shape or text).
- **[R] Reduced motion** is respected everywhere. **Zoom:** never disable browser zoom.
- **[R] Alt text.** No captions exist, so use the descriptive accessible name above. Future captions replace it **[F]**.

## 18. Performance expectations

**Phase 6 (originals only), design constraints [R]:** 25 MiB originals can exhaust mobile browser memory.
- Only a bounded window of items near the viewport may have loaded image sources. Off-window tiles stay as reserved placeholders and release their image.
- Cap concurrent image loads (starting about 6 **[H]**) and cancel loads for tiles scrolled far out of the window.
- No layout shift in the media area. Input feedback within a frame.
- Obtain URLs per window in batches via the OD3 entry point, never for the whole trip at once. Reuse held URLs within their lifetime (§11) so re-entering the window does not need a new issuance.
- Uploads: stream, never buffer files in memory, keep the small concurrency cap, and coalesce refreshes (§13).
- Presigned GETs carry no cache headers, so HTTP-cache hits are not guaranteed. Do not design around them. Cacheable image URLs are [F] with derivatives.

**Targets once derivatives exist [F]:** small tiles for the grid, a mid-size image for the viewer, originals only for "Open original", placeholder data for instant colour, browser-cacheable image URLs, and pagination for trips above the row cap.

**[H] Budgets to validate on real devices**, including a mid-range and a low-end Android phone given the user base: smooth scroll under normal load, no visible jank while an upload runs, and stable memory across a long scroll of a large trip.

---

## Appendix A — Final design principles

P1–P11 as tagged in §2. Binding: P1, P4, P5, P6, P8, P10, P11 [D]; P2, P3, P7, P9 [R]. All exact values (spacing, colours, timings, thresholds) are [H].

## Appendix B — Final interaction principles

1. Feedback within a frame; targets ≥ 44×44 CSS px (the Apple HIG / iPhone-app convention, deliberately stricter than the WCAG AA floor of 24×24). **[D/R]**
2. Motion communicates change and is interruptible; reduced-motion respected. Recommended technique: `document.startViewTransition()` as a zero-cost, feature-detected progressive enhancement. **[D principle, R technique, H exact values]**
3. The viewer is spatially continuous with its tile and is part of browser history. Recommended baseline routing: Next.js parallel + intercepting routes, with a query-parameter fallback if verification against the installed Next.js version fails. **[D principle, R technique + history]**
4. Never crop, hide or reflow photos. Size variation (featured tiles, §5) changes width allocation, never framing. **[R/D]**
5. Optimistic only where failure is recoverable. **[R]**
6. No hover-only actions; every action has touch and keyboard equivalents. **[R]**
7. Never lose scroll position (a direct benefit of the recommended routing technique in #3). **[R]**
8. Be honest about limits (upload needs the tab open, previews can be unavailable, undated photos, truncated lists, invitation acceptance isn't visible until a later load). **[R]**
9. Remaining technique and library choices (exact motion values, featured-tile thresholds, justified-layout implementation) are open. **[H]**

## Appendix C — Exact Phase 6 web screens and components

**Core (must ship):**

| ID | Component |
|---|---|
| C1 | Memories section on `/trips/[tripId]`, plus the **Add memories** action in the header (header otherwise unchanged) |
| C2 | Day section (heading and items) |
| C3 | Media grid (justified rows) |
| C4 | Media tile — photo, video (Core: `preload="metadata"` + `#t=0.001` first-frame preview per §11, budgeted by the load window), unavailable-preview, loading, failed |
| C5 | Time marker (time label only) |
| C6 | Undated section |
| C9–C11 | Viewer: dialog shell, media, details panel with Open original and Remove. **Routing:** attempt Next.js parallel + intercepting routes first; fall back to query-parameter state if verification against the installed Next.js version fails (§11). **Motion:** wrap the open/close DOM update in `document.startViewTransition()` where available. |
| C12 | Remove confirmation |
| C13 | Add-memories action + picker |
| C14 | Upload tray |
| C15 | Upload queue logic — pure, framework-independent (states and retry rules in §13) |
| C16 | Attribution using the existing member avatar component and a member-name lookup, including "A former member" |
| C19 | Token layer (both modes defined; Phase 6 surfaces built on it) |
| C20 | Authenticated server entry point for signed URLs (OD3a) and coalesced refresh (OD3b), once approved |

**Tier 2 (only after all Core is done, in this order):** person filter (C8); contributor avatars on markers; day index with `IntersectionObserver` current-day highlight and sticky day heading (C7, T9/T10); featured-tile rule (§5, ship disabled by default); viewer zoom; pull-down dismiss; drag-and-drop veil; in-timeline ghost tiles; sticky trip bar (C18); people line, privacy line, trip-length text and description clamp; best-effort client cleanup of pending rows.

**C17 People / invite / inbox (conditional):** compose the existing Phase 5 components and actions **only if** the OD4 test shows the Phase 5 UI is absent **and** the owner separately approves it. C17 has a single owner. Phase 6 itself only reads members for attribution.

## Appendix D — Required states and interactions

| Component | Required states | Required interactions |
|---|---|---|
| C1 Memories | Loading skeleton, empty, inline error with retry, truncated-list note | Refresh after upload and after delete, preserving scroll |
| C2/C6 Days | Populated; Undated appears only when items exist | Sticky day heading (R) |
| C3/C4 Grid/tile | Loading, loaded, failed with retry, preview-unavailable, video (duration + play glyph) | Press feedback, open viewer, keyboard focus and Enter/Space |
| C5 Markers | Time only | None |
| C9–C11 Viewer | Loading, loaded, failed, unavailable preview, item removed | Close (button, Esc, back), prev/next (arrows, buttons), details, Open original (fresh URL), Remove |
| C12 Remove | Idle, confirming, pending, error | Confirm/cancel inline; owner and uploader only |
| C13/C14 Upload | Queue states per §13, tray collapsed and expanded, session ended | Pick multiple, retry by failed step, cancel queued, leave-page warning |
| C16 Attribution | Resolved name, "A former member" | None |
| C20 URL entry point | Issued, expired-near, unavailable | Batch request for a window; per-item request for the viewer; fresh URL for Open original |

## Appendix E — Existing backend capabilities each screen uses

| Screen/component | Uses (existing) | Needs approval |
|---|---|---|
| Memories / timeline | `listTripMedia` (with an explicit limit and truncation detection), `listTripMembers`, `getCurrentUserId`, trip `owner_id` from `getTripById` | Explicit limit and truncation detection (§14) |
| Tiles and viewer images | `getMediaDownloadUrl` (server-side only) | OD3(a): authenticated server entry point |
| Viewer details / Open original | Media metadata, the member lookup, the same signed-URL lookup | OD3(a) |
| Remove | `deleteMediaAction` (RLS enforced; revalidates the trip path) | None |
| Upload | Existing validators, `requestMediaUploadAction`, browser PUT to the signed URL, `confirmMediaUploadAction` | OD3(b) coalesced refresh; OD5 for capture time |
| Pending-row cleanup (optional) | `deleteMediaAction` on a known pending `mediaId` | None |
| People (C17, if approved) | `listTripMembers`, `leaveTripAction`, `listInvitationsForTrip`, `inviteMemberAction`, `revokeInvitationAction`, existing components | OD4 |
| Home (Phase 8) | `listMyTrips`, `listMyPendingInvitations`, `getInvitedTripPreview`, accept/decline actions | None |

## Appendix F — Explicitly NOT in Phase 6

Derivatives, placeholder or blurhash data, cover photo or cover-derived colour, trip time zone or capture offset, last-seen or "new" dividers, captions or day notes, chat or realtime, favourites or reactions, batch or forced download, share links, member removal, ownership transfer, resumable or persistent upload queues, background upload, a server-side pending-row sweeper, HEIC conversion, generated video posters, GPS or places, pagination, PWA or share target, "Play the trip", notifications, avatar upload, search, maps, AI features, a tab bar, a three-pane desktop layout, a shared web/native component library, typed error codes, a full retheme of Phase 3–5 screens or enabling app-wide dark mode (OD6), header polish (people/privacy line, trip-length text, description clamp — Tier 2 / Phase 8), and any invented API or database capability beyond the two OD3 additions.

## Appendix G — Future mobile requirements Phase 6 must not block

1. **Pure product rules.** Grouping, time-marker and cluster rules, permission rules (who can delete), the upload state machine and retry rules, and user-facing state copy live in framework-independent modules with no DOM or Next imports.
2. **Tokens as data.** Colour roles, type scale, spacing and motion intent are defined as data first and projected to CSS variables on web.
3. **Business rules stay in the database or pure modules.** Not in React components, and not only in Next-specific code paths.
4. **Upload contract is protocol-shaped** (request → PUT → confirm). Do not couple media identity to browser-only objects such as object URLs. Server Actions are web-coupled, so a native-callable confirm endpoint and a token-authenticated signed-URL endpoint will be needed later. Flag them; do not build them. Prefer a Route Handler for OD3(a) so the same contract can be reused.
5. **The viewer's data contract is DOM-independent:** an ordered list of media ids, a current index, a URL provider and metadata.
6. **Deep-linkable ids** for trip and media (the `?media=` choice in §11 must map to universal links).
7. **No web-only affordances as the only path** (hover, right-click, drag-and-drop).
8. **Semantic structure** (day headings, ordered items) maps directly onto native accessibility containers.
9. **Native preconditions to keep visible:** derivatives and placeholder data, a trip time zone plus capture offset, and last-seen.
10. **Record the decision.** Master §5 currently lists a native mobile app as out of MVP scope. Log the future-mobile constraint in the Decision Log without changing the phase plan.

## Appendix H — Phase 6 acceptance checks

1. Two accounts in one trip: each sees the other's uploads, correctly attributed; a departed uploader shows as "A former member".
2. A photo with EXIF time lands in the right day; a photo without lands under Undated and is never mixed into a day (T1/T5).
3. A trip with more items than the row cap shows the truncation note, with the count taken from the returned data, not a constant.
4. Upload: a failed PUT retries with a new request; a failed confirm retries confirm on the same `mediaId` and does not re-upload or duplicate; a slot-limited queue never holds a stale URL.
5. Viewer: opens continuously from its tile, closes to the same tile, works with keyboard, and closing preserves scroll.
6. Reusing a held URL within its lifetime works (image and video); an expired or failed URL is replaced; "Open original" always uses a fresh URL.
7. Remove is offered only to the uploader or owner, and is confirmed before running.
8. HEIC, oversized and unsupported files show their designed states, never a broken image.
9. Both modes' tokens exist; Phase 6 ships light-only app-wide with an always-dark viewer (OD6).
10. Real-device pass on a mid-range and a low-end Android phone with a large trip of originals.
11. **(v2)** Opening a photo from the feed updates the URL to a deep-linkable form; opening that URL directly (or refreshing while the viewer is open) renders a full, working page rather than a broken or blank state; pressing back closes the viewer and lands on the feed at its prior scroll position.
12. **(v2)** A video tile shows a real first frame (not a blank rectangle) on at least one iOS Safari device, without eagerly fetching metadata for every video tile on the page at once.
13. **(v2)** With `prefers-reduced-motion` enabled, and separately with a browser that lacks `document.startViewTransition`, the viewer still opens and closes correctly — instantly or with a crossfade, never broken.
14. **(v2)** Sending an invitation (if C17 ships) never claims a state stronger than "Sent" within the same session.

---

## Change log — v1 → v2

| Area | v1 | v2 | Prompted by |
|---|---|---|---|
| Viewer routing/continuity | "Technique is open [H]" | Recommended: Next.js parallel + intercepting routes, with a named fallback | Independent research into Next.js's documented modal-photo-gallery pattern; doc 95 §12/§22/§23 (continuity, deep-linking, back-button behaviour) |
| Spatial-continuity motion | "Technique is open [H]" | Recommended: `document.startViewTransition()` as a zero-cost progressive enhancement | Same research pass; doc 95 §11/§13 |
| Touch target size | "≥ 44px [R]" with no sourcing | 44×44 CSS px, sourced to Apple HIG / Material convergence, explicitly distinguished from the WCAG AA floor (24×24) | WCAG 2.2 verification; doc 95 §20 (accessibility) |
| Video tiles | No poster in Phase 6; deferred as best-effort | Core: `preload="metadata"` + `#t=0.001` fragment for a real first-frame preview, budgeted against the load window | Research into iOS Safari's no-poster blank-rectangle behaviour; doc 95 §11 (media viewer) and §21 (performance) |
| Gallery density / photo hierarchy | Named as an idea ("scale follows silence") with no concrete rule | Concrete, deterministic, data-derived "featured tile" rule, disabled by default pending validation | Doc 95 §6/§7, resolved without the AI-ranking or manual-curation paths doc 95 itself warns against |
| Day-as-chapter orientation | Day heading only | Added: `IntersectionObserver`-based current-day highlight, optional sticky day heading, both presentation-only | Doc 95 §9 |
| Invitation feedback | Not specified (C17 was conditional and undetailed) | Explicit `Idle → Sending → Sent` state machine, with an explicit note that acceptance isn't visible in the same session | Doc 95 §14 (interaction feedback), §32 (UI must reflect real system state) |
| Chat state machine | Not mentioned | Explicitly out of scope — no chat UI exists to attach it to | Doc 95 §14 uses chat as an example; flagged here so it isn't mistaken for a Phase 6 requirement |
| Viewer on large/ultrawide screens | Not addressed | Soft maximum size, never upscaled past natural resolution | Independently discovered during this review |
| Viewer on orientation change | Not addressed | Re-flow in place; no state or index reset; no re-fetch | Doc 95 §16 (mobile-first / orientation changes) |

---

## Revision notes — pre-audit draft → v1 (carried forward for history)

- **OD3** rewritten as an authenticated server entry point with batching, id validation and a uniform "unavailable"; coalesced refresh replaces per-confirm refresh.
- **§11 URL rule** split into a [D] server-side rule (per-issuance authorization, 300 s TTL, no persistence) and an [R] client rule (reuse within lifetime minus margin; fresh URL for Open original).
- **§14 / §0.4 truncation:** explicit limit and detection by count; no hardcoded 1,000; newest items are dropped when the ascending list is truncated.
- **OD5:** the default is EXIF-or-null; `lastModified` is excluded unless the owner accepts permanent unlabelled approximations; the EXIF zone assumption is stated.
- **§13:** retry depends on the failed step; URLs requested just in time; cancel scoped to `queued` and `uploading`; best-effort pending-row cleanup via the existing `deleteMediaAction` (the previous "no cleanup exists" was over-broad).
- **T1** aligned with T5.
- **§9 / Appendix C:** Phase 6 header scope narrowed to the Add action; header polish moved to Tier 2 / Phase 8; C17 given a concrete "absent" test and a single owner.
- **Priority label** renamed "Tier 2" (the previous "P2" collided with principle P2).
- Added: untrusted-metadata rules (§5), preflight checklist (§0.3), access-rule accuracy for the uploader disjunct (§0.4), acceptance checks (Appendix H).
