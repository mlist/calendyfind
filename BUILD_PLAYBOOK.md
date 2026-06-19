# Build Playbook — Self-Hosted Meeting Booking App

Everything needed to build the app with Claude Code, in one place. The companion
`CLAUDE.md` (also reproduced in §1 below) lives in the repo root and is the project's
source of truth; the six phase prompts in §2 are pasted, one at a time, into Claude Code.

---

## How to use this

1. Create an empty git repo/folder. Put `CLAUDE.md` (see §1) in its root.
2. Start Claude Code in that folder.
3. Paste the **Phase 0** prompt. Let it finish and report its acceptance checks. Review.
4. Only when a phase's acceptance criteria genuinely pass, move to the next phase prompt.
5. Each prompt deliberately ends with "STOP — do not proceed." If Claude Code drifts
   into the next phase, point it back to the "ONLY Phase N" line at the top of the prompt.
6. After each phase, eyeball the items in the **Review checklist** (§3) yourself — those
   are the spots where subtle, hard-to-see bugs (double-booking, leaked secrets) hide.

Order is load-bearing: each phase assumes the previous ones are complete and working.
Phase 2 (the availability engine) is the make-or-break phase; do not rush it.

Before Phase 2, confirm the **load-bearing prerequisite** in CLAUDE.md §11: that your
org permits internet calendar publishing so your Exchange calendar can be exposed as an
ICS URL. If it can't, the read side is blocked — resolve that first.

---

## 1. CLAUDE.md (repo root — source of truth)

````markdown
# CLAUDE.md — Self-Hosted Meeting Booking App

This file orients Claude Code (and humans) on how to build and work in this repo.
Read it fully before generating code. Keep it updated as decisions change.

---

## 1. What we are building

A self-hosted, privacy-preserving meeting-scheduling web app — like a private Calendly/Cal.com,
but where **no calendar data ever leaves the owner's server**.

Core problems it solves:
- A user's real availability is spread across many calendars (work/Exchange, private, teaching,
  research group, school). External people can only see one of them, so shared availability is useless.
- The user does not want to hand all their calendars to a third-party SaaS.

Headline features:
1. **User profiles** with N read-only ICS feeds added as **availability sources**.
2. **Working hours** per user (when slots may be offered), plus timezone.
3. A **public booking page** per user reachable via a **secret, unguessable link**. External people pick a free
   slot; the booking is written to a **target calendar** the user chose, and the visitor is **emailed an invite**
   (and can download an `.ics`).
4. **Internal multi-attendee booking**: logged-in users pick several other account holders and the app finds
   **shared availability**.
5. **No public signup.** An **admin** role creates accounts and assigns roles.

---

## 2. THE central architectural fact (do not forget)

**Reading availability and writing a booking are two different mechanisms.**

- **Availability sources** = many **read-only ICS feeds**. We pull, parse, and expand them into *busy* intervals.
  An ICS link can NEVER accept a new event.
- **Booking target** = ONE **writable calendar**, reached through a provider-specific **write adapter**:
  - `caldav`  → Nextcloud, iCloud, Fastmail, generic CalDAV servers, and Google-via-CalDAV (app password).
  - `msgraph` → **Exchange / Microsoft 365** (Microsoft does NOT support CalDAV — Graph/OAuth is required).
  - `google`  → Google Calendar API (OAuth), as an alternative to Google-over-CalDAV.

All write adapters implement one interface (see §6). Build ONE adapter first — the one we will actually write to.

### Scope decisions

- **Recurrence — READ side: REQUIRED.** Availability feeds (teaching, research-group, etc.) are full of
  recurring events (weekly lectures, group meetings). These MUST be expanded so recurring busy time blocks every
  occurrence — otherwise the app offers busy slots as free and double-books. ical.js + rrule do this for us, so
  keeping it is nearly free. Honor `RRULE`, `EXDATE`, and `RECURRENCE-ID` overrides.
- **Recurrence — CREATE side: OUT OF SCOPE.** We do NOT offer recurring *bookings*; each booking is a single
  one-off event. Keeps the booking page simple.
- **Timezones — UTC-internal is BASELINE (not optional).** Store all times in UTC; convert only at display using
  each user's timezone. This prevents DST off-by-one bugs at near-zero cost. *Optional nice-to-have:* detect and
  display the external visitor's local timezone on the public booking page.

---

## 3. Tech stack

| Concern            | Choice                                  | Notes |
|--------------------|-----------------------------------------|-------|
| Language/framework | **TypeScript + Next.js (App Router)**   | One language end to end. |
| DB                 | **SQLite + Drizzle ORM**                | Zero-ops self-host; Drizzle keeps a Postgres upgrade path open. |
| Auth               | **better-auth** + **admin plugin**      | No signup; admin creates users & roles; DB sessions; password hashing. |
| ICS parsing        | **ical.js** (Mozilla) + **rrule**       | Most battle-tested recurrence handling in JS. |
| CalDAV writes      | **tsdav**                               | Mature; used by Cal.com. |
| Email invites      | **nodemailer** + **ics**                | iMIP `METHOD:REQUEST` / `CANCEL`. |
| Deployment         | **Docker**                              | Single container + mounted SQLite volume. |

Fallback: if recurrence/timezone handling becomes painful, the availability engine (and only that) may be
extracted into a small **FastAPI** service using `icalendar` + `recurring-ical-events` + `caldav`, behind the
same Next.js frontend. Do NOT do this preemptively.

Reference for hard problems (study, do not copy wholesale): **Cal.diy** —
https://github.com/calcom/cal.diy — the MIT-licensed open-source successor to Cal.com (Cal.com renamed/relaunched
its OSS code as Cal.diy in April 2026; the paid edition went closed-source). Next.js + TS + Prisma. Useful for
CalDAV quirks and iMIP invites; far larger than we need, so do NOT fork it.

---

## 4. Repo layout

```
/app                 Next.js routes (App Router) — pages + route handlers (the API)
  /(public)/b/[token]  Public booking page (secret link). No auth.
  /(app)/...           Authenticated app (dashboards, settings, internal booking)
  /(admin)/...         Admin-only user management
/lib
  /availability        Availability engine (ICS fetch, parse, recurrence, free/busy, slotting)
  /adapters            Write adapters (caldav, msgraph, google) behind one interface
  /ics                 iMIP invite generation (REQUEST / CANCEL)
  /auth                better-auth config
  /db                  Drizzle schema + migrations + client
  /crypto              Encrypt/decrypt stored provider credentials
/test
  /fixtures            Real-world .ics files for recurrence/timezone tests
/Dockerfile
```

Keep business logic in `/lib` (pure, unit-testable). Route handlers stay thin.

---

## 5. Data model (Drizzle)

- **user**: id, email, name, role (`admin` | `user`), timezone, working_hours (JSON: per-weekday ranges),
  + better-auth's password/session fields.
- **availability_source**: id, user_id, label, ics_url, last_fetched_at, cached_busy (JSON), fetch_error.
  *(N per user; read-only.)*
- **write_target**: id, user_id, label, provider (`caldav`|`msgraph`|`google`), encrypted_credentials,
  calendar_id/url, is_default. *(Writable.)*
- **booking_page**: id, user_id, slug/secret_token (unguessable), title, duration_min, buffer_min,
  min_notice_min, max_advance_days, write_target_id, location, active.
- **booking**: id, booking_page_id (nullable), organizer_user_id, attendee_name, attendee_email, start_utc,
  end_utc, status (`pending_hold`|`confirmed`|`cancelled`), ics_uid, sequence, external_event_ref, created_at.
- **booking_attendee**: booking_id, user_id. *(For internal multi-attendee bookings.)*

---

## 6. Key interfaces

**Write adapter** (every provider implements this):
```ts
interface CalendarWriteAdapter {
  createEvent(target: WriteTarget, event: NewEvent): Promise<{ externalRef: string }>;
  cancelEvent(target: WriteTarget, externalRef: string, uid: string, sequence: number): Promise<void>;
}
```

**Availability engine** (pure functions, the heart of the app):
```ts
// Returns free slots for one user, or the INTERSECTION across several users.
computeFreeSlots(opts: {
  userIds: string[];
  range: { from: Date; to: Date };
  durationMin: number;
  bufferMin: number;
  minNoticeMin: number;
}): Promise<Slot[]>;
```
Algorithm: fetch each user's ICS sources → parse with ical.js → expand recurrences (rrule, honor EXDATE &
RECURRENCE-ID overrides & all-day & DST) → busy intervals → subtract from working hours within range →
intersect across users → subtract existing `pending_hold` + `confirmed` bookings → slice into slots.

---

## 7. Booking flows

**External (secret link):**
1. Visitor opens `/b/[token]` → app shows free slots (free/busy ONLY — never reveal event titles/details).
2. Visitor picks a slot + name/email → app creates a **`pending_hold`** (TTL ~10 min) and re-checks availability.
3. Visitor confirms → app **writes the event via the write adapter**, generates an **iMIP `METHOD:REQUEST`**
   invite, **emails the visitor** (+ offers `.ics` download), marks booking `confirmed`, releases the hold.
4. Cancellation → reuse the same `UID`, bump `SEQUENCE`, send `METHOD:CANCEL`, delete from the target calendar.

**Internal (multi-attendee):** logged-in user picks attendees (other accounts) → `computeFreeSlots` over all of
them → on confirm, write to organizer's target and send invites to every attendee.

---

## 8. Build phases (do them in order; each is a self-contained Claude Code task)

- **Phase 0 — Scaffold.** Next.js + TS + Drizzle + SQLite + better-auth (admin plugin, **signup disabled**),
  Docker, a seed script that creates the first admin. *Done = admin can log in; no user can self-register.*
- **Phase 1 — Profiles & calendars (CRUD only).** Admin creates users; users add/edit ICS availability sources,
  working hours, timezone, and write targets (store credentials **encrypted**). No availability logic yet.
- **Phase 2 — Availability engine (THE CORE).** ICS fetch + cache, ical.js parse, recurrence expansion,
  free/busy, working-hours intersection, slotting, multi-user intersection. **Fixture-driven unit tests first.**
  No writes. *This phase decides whether the app works.*
- **Phase 3 — Public booking page.** Secret link, slot picker UI, `pending_hold` + race handling, confirm flow
  that stores the booking and generates a downloadable `.ics` — **but does not write to a calendar yet.**
- **Phase 4 — Write-back + email.** First write adapter (start with whichever provider you actually use),
  iMIP invite email, cancellation flow with `SEQUENCE`/`UID`.
- **Phase 5 — Internal multi-attendee booking.** Attendee picker, shared-availability, invites to all.
- **Phase 6 — Hardening.** Admin dashboard, audit log, rate limiting on public endpoints, secret-link rotation,
  reminders, timezone display polish.
- **Phase 7 — (Optional, post-launch) Outbound free/busy feed + slot checker.** A merged free/busy ICS feed
  (busy-only, token-secured) usable in other calendar tools, plus a paste-the-slots checker for responding to
  external polls (e.g. Doodle, which has no usable public API). No scraping or auto-submit.

---

## 9. Non-negotiable rules (correctness & safety)

- **Fail closed.** If an ICS feed fails to fetch/parse, treat its time as **busy**, never free. Never risk a
  double-book from a missing feed. Surface the error to the owner.
- **Free/busy only on public pages.** Never leak event titles, attendees, or details of the owner's calendars.
- **Encrypt stored credentials** (write-target passwords/tokens) at rest (AES-GCM with a key from env / a KMS).
- **Unguessable secret links** — 32 bytes from a CSPRNG, base64url; support rotation/revocation.
- **Rate-limit** the public slot + booking endpoints.
- **Always test recurrence with real `.ics` fixtures** committed under `/test/fixtures`, including recurring
  events with overrides, all-day events, and multiple timezones.
- Store all times in **UTC** in the DB; convert at the edges using each user's timezone.

---

## 10. Working conventions for Claude Code

- Make small, reviewable changes — one phase (or sub-step) per task.
- For the availability engine, **write tests before/with the implementation**; it is the riskiest code.
- Keep `/lib` logic pure and framework-free so it can be unit-tested without spinning up Next.js.
- When a CalDAV/Graph/Google quirk appears, check the provider's docs and Cal.com's handling before guessing.
- Update this file when an architectural decision changes.

---

## 11. Decisions

Resolved: read-side recurrence = required; recurring bookings = out of scope; timezones = UTC-internal baseline
(see §2 "Scope decisions").

**Write target = private Google Calendar** (first and, for now, only adapter to build).
- Rationale: it is independent of the org's mail system, so it survives a possible future migration to M365.
  Exchange is a dead end here — on-prem 2019 has no CalDAV (EWS only, a legacy API), and on M365, EWS is
  disabled by default from 1 Oct 2026 / fully removed 1 Apr 2027, leaving only Microsoft Graph, which needs a
  tenant admin-consented app the org will not approve.
- Auth: start with **CalDAV via tsdav + a Google app password** (no token refresh). Verify Google still permits
  app passwords when building Phase 4; if not, fall back to the **Google Calendar API via OAuth** (also sends
  invites natively). Either way the adapter sits behind the §6 `CalendarWriteAdapter` interface.

### Read/write decoupling pattern (important)

- READ work availability from Exchange via a **published ICS feed** (read-only; no app approval needed).
- WRITE confirmed bookings into the **private Google calendar**.
- Add that Google calendar back as an **availability source** so the app sees its own bookings as busy.
- Optional: subscribe to the Google calendar's ICS from Outlook so bookings also appear in the work view.

### Load-bearing prerequisite to verify before building

Confirm the org permits **internet calendar publishing** in Outlook/OWA so the Exchange work calendar can be
exposed as an ICS URL. If publishing is disabled, the READ side is blocked — resolve this before Phase 2.
````

---

## 2. The six phase prompts

Paste these into Claude Code one at a time, in order, only advancing when the previous
phase's acceptance criteria pass.

### Phase 0 — Scaffold

Put `CLAUDE.md` in the repo root, start Claude Code in that folder, then paste:

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions.

Implement ONLY Phase 0 (Scaffold) from §8. Do NOT start Phase 1 or any later phase.
Do not build availability sources, booking pages, the availability engine, write
adapters, or any booking logic yet.

## Goal of Phase 0
A running Next.js app where:
- an admin can log in, and
- public self-registration is IMPOSSIBLE — accounts can only be created by an admin.

## Stack (per CLAUDE.md)
- Next.js (App Router) + TypeScript
- SQLite via better-sqlite3 + Drizzle ORM (+ drizzle-kit for migrations)
- better-auth with email+password and the admin plugin, using the Drizzle adapter
  (provider: sqlite), sessions stored in the DB
- pnpm (npm is fine if you prefer)
- Node 20+

The better-auth and Drizzle APIs change often — consult the CURRENT official docs
for exact config option names, the schema-generation CLI, and migration commands
rather than relying on memory. State any version-specific choices you make.

## Tasks
1. Initialize a Next.js + TypeScript app and set up the directory skeleton from
   CLAUDE.md §4 (create the /lib subfolders as placeholders even if empty for now).
2. Wire up Drizzle + better-sqlite3 with a SQLite file path from an env var, plus
   drizzle-kit config and a migration workflow.
3. Configure better-auth: email+password auth, the admin plugin (so roles are
   `admin`|`user` and admins can create users), Drizzle adapter (sqlite), DB sessions.
   Generate the auth tables (user, session, account, verification + the role field)
   and apply them as a migration.
4. DISABLE public signup. There must be no working public registration route, UI,
   or endpoint — verify the signup API path is actually rejected, not just hidden.
5. Build a login page and a minimal authed landing page that shows the logged-in
   user's email and role. Add an admin-only placeholder page (gated by role=admin).
6. Write an idempotent seed script that creates the first admin from ADMIN_EMAIL and
   ADMIN_PASSWORD env vars, with role=admin. This must work even though public signup
   is disabled (bootstrap path), and must use better-auth's own password hashing so
   the credentials are valid for login. Running it twice must not duplicate the user.
7. Env & secrets: create .env.example documenting DATABASE_URL/path,
   BETTER_AUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, and a placeholder ENCRYPTION_KEY
   (used later for write-target credentials). Gitignore .env. Show the openssl
   commands to generate the secret values.
8. Add a Dockerfile (and a simple docker-compose) that builds and runs the app with
   the SQLite file on a mounted volume so data persists across container restarts.

## Acceptance criteria — verify each actually passes before finishing
- The app starts with the documented dev command.
- Migrations create the better-auth tables including the role field.
- The seed creates the admin; re-running the seed does not create a duplicate.
- The seeded admin can log in with ADMIN_EMAIL / ADMIN_PASSWORD and lands on the
  authed page showing role=admin.
- There is NO way for a member of the public to register; hitting the signup
  endpoint fails/returns an error.
- `docker build` succeeds and the containerized app runs with a persisted DB.

## When done
Summarize what you built, the exact commands to install / migrate / seed / run
(both locally and via Docker), any version-specific decisions, and confirm each
acceptance criterion. Then STOP — do not proceed to Phase 1.
````

### Phase 1 — Profiles & calendars (CRUD only)

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phase 0 (scaffold,
auth, admin seed, signup disabled) is already complete and working.

Implement ONLY Phase 1 (Profiles & calendars — CRUD only) from §8. Do NOT start
Phase 2 or later. Specifically, in this phase do NOT:
- fetch, parse, or validate-by-connecting any ICS feed (Phase 2)
- compute any availability / free-busy / slots (Phase 2)
- build booking pages or secret links (Phase 3)
- make ANY live call to Google or CalDAV, or test stored credentials against a
  provider (Phase 4)
This phase only stores and edits configuration in the DB.

## Goal of Phase 1
- Admin can manage the account lifecycle of users (create, set role, disable,
  reset password) through an admin-only UI, using the better-auth admin plugin's
  server APIs (do not hand-roll user creation).
- Each logged-in user can manage their own: timezone, working hours, ICS
  availability sources (N of them), and write targets — including a Google write
  target whose secret credentials are stored ENCRYPTED at rest.

## Data model (extend the schema per CLAUDE.md §5; add migrations)
1. Extend `user` with: `timezone` (IANA string, e.g. "Europe/Berlin", sensible
   default) and `working_hours` (JSON). Use a clear documented shape, e.g.
   { "mon": [{ "start": "09:00", "end": "17:00" }], "tue": [...], ... } where times
   are interpreted in the user's timezone. Empty array = unavailable that day.
2. `availability_source`: id, user_id (FK), label, ics_url, created_at. Leave
   last_fetched_at / cached_busy / fetch_error as nullable columns for Phase 2 to
   use; do not populate them now.
3. `write_target`: id, user_id (FK), label, provider (enum caldav|msgraph|google),
   encrypted_credentials (blob/text), calendar_ref (calendar id or URL), is_default
   (bool), created_at. Only the `google` provider needs a working form this phase;
   keep the enum for future adapters.

## Security — non-negotiable (CLAUDE.md §9)
- Implement /lib/crypto with AES-256-GCM. Key comes from ENCRYPTION_KEY (32 bytes,
  base64-decoded). Validate the key length at startup and fail loudly if missing or
  wrong size. Store iv + authTag + ciphertext together. Provide encrypt()/decrypt().
- write_target credentials must be encrypted before they touch the DB. The plaintext
  secret must NEVER be sent back to the browser and never logged. When listing/showing
  a write target, return only non-secret metadata (label, provider, calendar_ref,
  is_default, "credentials set: yes/no").
- Store credentials as an encrypted JSON object so the shape is flexible. For the
  Google target form this phase, collect the fields for the CalDAV + app-password
  path (Google account email, app password, target calendar id/URL) per the §11
  decision — but keep storage generic so an OAuth variant can be added in Phase 4
  without a schema change. Do NOT verify these against Google now.
- Authorization: every read and mutation of availability_source / write_target /
  profile must be scoped to the owning user. A user must not be able to read or
  modify another user's resources. Enforce this in the server/route layer, not just
  by hiding UI. Admin-only pages/endpoints must reject non-admins.
- Public signup remains disabled (carry over from Phase 0; re-confirm).

## UI
- Authed user settings area: edit timezone + working hours; full CRUD list for ICS
  availability sources; full CRUD list for write targets (Google). Editing a write
  target lets the user replace credentials without ever displaying the old secret.
- Admin-only area: list users; create user (email, name, role, initial password);
  change a user's role; disable/enable a user; reset a user's password — all via the
  better-auth admin plugin.
- Keep validation to format-level only (valid IANA tz, well-formed URL, sane
  HH:MM ranges with start < end). No network calls.

## Acceptance criteria — verify each actually passes before finishing
- Migrations apply cleanly; new columns/tables exist.
- Admin creates a user in the UI; that user can log in and reach their settings.
- A user sets timezone + working hours; values persist across logout/login.
- A user can add several ICS sources and a Google write target; edit and delete them.
- Inspect the DB directly: the write_target credential column contains ciphertext,
  NOT plaintext, and the app can decrypt it server-side.
- The credential secret is never present in any API response sent to the client.
- Ownership: calling the source/target/profile APIs as user A against user B's record
  IDs is rejected (test the API directly, not just the UI).
- Admin-only pages/endpoints return forbidden for a normal user.
- Starting the app with a missing/invalid ENCRYPTION_KEY fails fast with a clear error.

## When done
Summarize what you built, the working_hours JSON shape you chose, how credentials are
encrypted, the new commands (migrate/run), and confirm each acceptance criterion with
how you verified it. Then STOP — do not proceed to Phase 2.
````

### Phase 2 — Availability engine (THE CORE)

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0 and 1 are
complete: auth + admin user management + signup disabled; CRUD for profile /
working hours / ICS sources / write targets (credentials encrypted).

Implement ONLY Phase 2 (Availability engine — THE CORE) from §8. Do NOT start Phase
3+. Specifically do NOT in this phase: build any public booking page or secret link,
create/hold/confirm any booking, call Google or CalDAV, or send any email. This phase
only READS ICS feeds and computes free/busy + slots. It performs no writes to any
calendar.

This is the make-or-break phase. Work TEST-FIRST: create real .ics fixture files and
failing tests BEFORE the implementation, then make them pass.

## Architecture — strict pure/impure split (per CLAUDE.md §6, §10)
Split the engine so the hard logic is pure and unit-testable with zero I/O:

PURE (no network, no DB, no wall-clock — all in /lib/availability, fully tested):
- parseIcsToBusyIntervals(icsText, range, fallbackTz) -> BusyInterval[]
  Parse with ical.js; expand recurrence with rrule.
- interval helpers: mergeIntervals, subtractIntervals, intersectIntervals,
  padIntervals(byMinutes).
- sliceFreeIntoSlots(freeIntervals, { durationMin, granularityMin, now, minNoticeMin })
- computeFreeSlots({ usersBusy, usersWorkingWindows, existingBookings, durationMin,
  bufferMin, minNoticeMin, now, range }) -> Slot[]
  Orchestrates the math only; receives already-gathered data.

IMPURE (thin wrappers, separately tested with mocked HTTP / a test DB):
- fetchIcsText(url) — HTTP with the safety rules below.
- gatherBusyForUser(userId, range) — load the user's sources, fetch-or-cache each,
  parse, plus pull this user's pending_hold + confirmed bookings from the DB.
- getFreeSlots(opts) — top-level: gather for all userIds, build working windows,
  call computeFreeSlots.

Inject `now` everywhere (a clock argument) — never call Date.now() inside engine
logic, so tests are deterministic. All internal times are UTC (CLAUDE.md §9).

## Libraries
- ical.js for parsing (VEVENT, VTIMEZONE), rrule for recurrence expansion, luxon for
  IANA-timezone conversion and date math. These APIs shift between versions — consult
  CURRENT official docs for exact API names; state any version-specific choices.

## Required parsing semantics (get these RIGHT — they are the test targets)
- Recurrence: expand RRULE across the range; honor EXDATE (excluded occurrences are
  free) and RECURRENCE-ID overrides (a moved/edited occurrence replaces the original).
- All-day events (DTSTART as DATE): block the whole day in the owner's timezone...
  UNLESS marked TRANSP:TRANSPARENT.
- TRANSP:TRANSPARENT events do NOT block. STATUS:CANCELLED events do NOT block.
- Timezones: honor VTIMEZONE and Z (UTC); convert everything to UTC. Handle events
  crossing DST boundaries correctly. Floating times (no tz) are interpreted in the
  calendar owner's timezone — document this choice.
- Multi-day events crossing the range edges are clipped to the range.
- Overlapping/adjacent busy intervals merge.

## Free/busy + slot logic
- working_hours (user tz) -> convert to UTC windows within the range using luxon.
- Multi-user: effective window = INTERSECTION of all attendees' working-hours windows;
  busy = UNION of all attendees' busy intervals (incl. their pending_hold + confirmed
  bookings). free = window minus busy. Single-user degenerates correctly.
- buffer: pad each busy interval by bufferMin on BOTH sides before subtracting.
- minNotice: no slot may start before now + minNoticeMin.
- Slice free blocks into durationMin slots on a configurable granularity
  (default = durationMin), only where the full duration fits inside the free block.

## Fetch safety + caching (fail-closed — CLAUDE.md §9)
- fetchIcsText: https only (http only if explicitly enabled), hard timeout, max
  response-size cap, and REJECT requests to loopback/private IP ranges (SSRF guard).
- Caching uses the Phase-1 columns: cache parsed busy in availability_source
  (cached_busy + last_fetched_at). Refetch when older than a configurable TTL.
- FAIL CLOSED: if a source cannot be fetched or parsed and there is no usable cache,
  treat that source as fully busy for the whole range (so it yields NO free slots),
  record fetch_error, and surface which source failed. Never silently drop a source —
  a missing feed must never cause time to appear free.

## Dev-only check (NOT the Phase 3 booking page)
Add ONE authenticated, dev-only way to eyeball output — a small internal route or a
script that runs getFreeSlots for the logged-in user (or a given set of user IDs) over
a date range and prints the slots. No secret links, no public page, no booking creation.

## Tests — create .ics fixtures under /test/fixtures and cover at minimum
1. Single timed event inside working hours -> that slot busy.
2. Weekly RRULE (a recurring lecture) -> every occurrence in range is busy.
3. RRULE + EXDATE -> the excluded occurrence is free again.
4. RRULE + RECURRENCE-ID override -> original time free, moved time busy.
5. Opaque all-day event blocks the day; a TRANSP:TRANSPARENT all-day event does NOT.
6. STATUS:CANCELLED event does not block.
7. Event in a non-UTC VTIMEZONE crossing a DST change -> correct UTC busy interval.
8. Multi-day event spanning a range edge -> clipped correctly.
9. Overlapping + adjacent events -> merged.
10. Event partially outside working hours -> only the overlap is busy.
11. Floating-time event -> interpreted in owner tz (assert the documented behavior).
12. Fetch failure / malformed ICS -> fail-closed: no slots, error surfaced.
13. Multi-user intersection: a slot busy for one attendee is excluded; a common-free
    slot is returned.
14. minNotice filters out too-soon slots; buffer pads around busy correctly.
Use a fixed injected `now` in every time-sensitive test.

## Acceptance criteria — verify each actually passes before finishing
- All fixture tests above pass; pure engine tests run WITHOUT network or DB.
- A deliberately broken/unreachable ICS source produces zero free slots for that user
  and a surfaced error — never extra availability.
- Two users with overlapping working hours but conflicting events yield only the
  genuinely-common free slots.
- DST and timezone fixtures produce the correct UTC intervals (assert exact times).
- The dev check prints sane slots for a seeded user with a couple of ICS fixtures
  served locally.

## When done
Summarize: the module layout, the libraries/versions chosen, how recurrence/all-day/
TRANSP/DST/floating-time are handled, the fail-closed behavior, the cache TTL, and the
slot/buffer/minNotice semantics. Confirm each acceptance criterion and how you verified
it. Then STOP — do not proceed to Phase 3.
````

### Phase 3 — Public booking page

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0–2 are complete:
auth + admin user management + signup disabled; CRUD for profile / working hours /
ICS sources / write targets (encrypted); and the tested availability engine
(getFreeSlots, fail-closed, multi-user, DST-correct).

Implement ONLY Phase 3 (Public booking page) from §8. Do NOT start Phase 4+.
Specifically do NOT in this phase:
- write any event to Google or CalDAV (Phase 4)
- send any email or generate a METHOD:REQUEST iMIP invite (Phase 4) — the .ics this
  phase produces is a download-only METHOD:PUBLISH file
- build internal multi-attendee booking (Phase 5)
- add heavy rate limiting or an audit log (Phase 6) — a basic abuse guard only
This phase: owners configure booking pages; external visitors view free slots and
book; bookings are stored in the DB and a downloadable .ics is produced. No calendar
write, no email.

## Goal of Phase 3
1. Owner (authed) can create/manage booking pages, each reachable at /b/[token] via an
   unguessable secret link, with rotate/revoke.
2. External visitor (NO auth) opens a valid link, sees genuinely-free slots (via the
   Phase 2 engine), picks one, enters name/email, and gets a confirmed booking + an
   .ics download — with race-safe holds so the same slot cannot be double-booked.

## Data model (extend schema + migrations, per CLAUDE.md §5)
- `booking_page`: id, user_id (FK=owner), secret_token (unique, indexed), title,
  duration_min, buffer_min, min_notice_min, max_advance_days, location, write_target_id
  (FK, nullable — STORED but NOT used this phase), active (bool, default true),
  created_at.
- `booking`: id, booking_page_id (FK), organizer_user_id (FK), attendee_name,
  attendee_email, start_utc, end_utc, status (enum: pending_hold|confirmed|cancelled),
  ics_uid (unique), sequence (default 0), external_event_ref (null this phase),
  expires_at (nullable — set for pending_hold only), cancel_token (unique), created_at.
  (Leave booking_attendee for Phase 5.)
- Index bookings by (organizer_user_id, start_utc) and by status for fast overlap
  checks.

## Engine integration (wire Phase 2 to real data)
- The engine's gather step must now read this user's bookings from the `booking`
  table: count a booking as busy when status=confirmed, OR status=pending_hold AND
  expires_at > now. Expired holds are NOT busy. Keep `now` injected (deterministic).
- All booking-page config (duration/buffer/min_notice) flows into getFreeSlots;
  max_advance_days bounds the upper end of the query range; min_notice bounds the lower.

## Owner side (authed)
- CRUD booking pages. secret_token = 32 bytes from a CSPRNG, base64url. Provide
  "rotate link" (new token, old link dies) and active/inactive toggle.
- Selecting the write_target for a page is allowed and stored, but unused this phase.
- Show the owner their page's public URL and a list of upcoming bookings (read-only
  here).

## Visitor side (public /b/[token])
- Resolve token -> page+owner. If not found or inactive: return a generic
  not-available response. Do NOT leak whether a token ever existed; do NOT expose
  owner identity beyond what the page title/owner-name intentionally shows.
- Show ONLY free slots (the engine returns slots, never event details) within
  [now+min_notice, now+max_advance_days], in the OWNER's timezone by default.
  Optional nice-to-have (per §2 scope): detect and additionally display the visitor's
  local timezone. Never reveal busy-time details.
- Booking flow with race-safe holds:
  1. Visitor picks a slot + enters name + email (validate email format only).
  2. CREATE HOLD atomically: in a single DB transaction (use BEGIN IMMEDIATE for
     SQLite so check-then-insert is a single write-locked unit), re-verify the chosen
     slot is a legitimate slot boundary for this page AND that NO overlapping booking
     exists for this owner with status=confirmed or (pending_hold AND expires_at>now).
     If clear, insert a pending_hold with expires_at = now + HOLD_TTL_MIN (configurable,
     default 10). If not clear, abort and tell the visitor the slot was just taken.
     NEVER trust the client's claim that a slot is free — always recompute server-side.
  3. CONFIRM: re-check the hold still exists and hasn't expired (re-acquire if needed);
     flip it to status=confirmed; generate ics_uid (stable, stored — Phase 4 reuses it
     for cancellation) and sequence=0; produce a downloadable .ics (METHOD:PUBLISH,
     single VEVENT: UID, DTSTART/DTEND in UTC, SUMMARY from page title, attendee as
     ATTENDEE, owner as ORGANIZER, LOCATION). Show a confirmation page with the .ics
     download link and a cancel link (using cancel_token).
- Visitor cancel (cancel_token): flips the booking to status=cancelled, which frees
  the slot. DB-only — NO email, NO calendar call this phase.

## Security (CLAUDE.md §9)
- secret_token and cancel_token: CSPRNG, unguessable, compared safely.
- Public endpoints (slot list, hold, confirm, cancel) require no auth but MUST be
  scoped strictly to the resolved page; one page's token can never touch another
  page's or owner's data. A basic per-IP/per-token abuse guard on the public
  endpoints is enough here (full rate limiting is Phase 6).
- Fail-closed carries over: if the engine can't compute availability (a feed is down
  with no cache), the page offers NO slots rather than risking a double-book.
- Never expose attendee PII or booking details across pages; the confirmation/cancel
  pages are reachable only via the per-booking tokens.

## Tests — add to the suite (keep `now` injected/deterministic)
1. Valid token + active page renders free slots from the engine; inactive/unknown
   token -> generic not-available, no info leak.
2. Slots respect duration/buffer/min_notice/max_advance from the page config.
3. RACE: two concurrent holds on the same slot -> exactly one succeeds, the other is
   rejected. (Simulate concurrency against the transaction.)
4. A pending_hold makes the slot disappear from the public slot list for others.
5. An EXPIRED hold frees the slot again (engine treats expires_at<now as not busy)
   and the slot reappears.
6. Confirm turns a hold into a confirmed booking; the slot stays unavailable.
7. Confirm after the hold expired is handled gracefully (re-acquire or clear error,
   never a silent double-book).
8. Generated .ics parses, is METHOD:PUBLISH, has a stable UID, and correct UTC times.
9. cancel_token cancellation frees the slot; a wrong/!owned token does nothing.
10. Cross-page isolation: page A's tokens cannot read or mutate page B's bookings.

## Acceptance criteria — verify each actually passes before finishing
- Owner creates a page, gets a working /b/[token] link, can rotate (old link dies)
  and deactivate it.
- A visitor can book end-to-end with no account and download a valid .ics.
- The race test proves the same slot cannot be confirmed twice.
- Expired holds reliably free their slot; confirmed bookings reliably block it.
- A down feed with no cache yields zero public slots (fail-closed), never extra ones.
- No calendar write and no email occur anywhere in this phase.

## When done
Summarize: the booking_page/booking schema, the hold lifecycle and TTL, exactly how
the create-hold/confirm transaction prevents double-booking (and the SQLite locking
used), the .ics shape, and the token/security model. Confirm each acceptance criterion
and how you verified it — especially the race test. Then STOP — do not proceed to
Phase 4.
````

### Phase 4 — Write-back + email

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0–3 are complete:
auth + admin user management + signup disabled; encrypted-credential CRUD for ICS
sources and write targets; the tested availability engine; and the public booking
page with race-safe holds that currently produces a download-only METHOD:PUBLISH .ics
and does NOT touch any calendar or send email.

Implement ONLY Phase 4 (Write-back + email) from §8. Do NOT start Phase 5+.
Specifically do NOT in this phase: build internal multi-attendee booking (Phase 5),
or add full rate limiting, audit logging, reminders, or the admin dashboard (Phase 6).

This phase makes bookings real: on confirm, write the event into the owner's
configured PRIVATE GOOGLE write target and send the external attendee a proper
METHOD:REQUEST invite; on cancel, remove it from the calendar and send METHOD:CANCEL.

## The write target (per CLAUDE.md §11 decision)
- Provider = `google`, behind the §6 `CalendarWriteAdapter` interface:
  createEvent(target, event) -> { externalRef }
  cancelEvent(target, externalRef, uid, sequence) -> void
  Keep the interface clean so msgraph/others can be added later — but implement ONLY
  the Google adapter now.
- Auth path: implement CalDAV via tsdav using the Google app password stored
  (encrypted) in the Phase-1 write_target. BEFORE building, verify whether Google
  still permits app passwords for CalDAV; if it no longer does, implement the Google
  Calendar API via OAuth instead. State which path you chose and why.
- tsdav / googleapis / Google's CalDAV endpoints change — consult CURRENT official
  docs for exact endpoints, auth, and method names. Note version-specific choices.
- Decrypt credentials with /lib/crypto only at the point of use. NEVER log the
  decrypted credentials or send them to the client. Apply a timeout and SSRF guard to
  outbound provider calls, consistent with Phase 2's fetch safety.

## Email / iMIP (separate, injectable service)
- Build an email sender using nodemailer + the `ics` package. SMTP config comes from
  env (host/port/user/pass/from) — do NOT hardcode a provider. Document the env vars
  in .env.example.
- Make email a SEPARATE service injected into the confirm/cancel flows, so the flow
  doesn't care how the event was created. (Note in code: if the Google API/OAuth path
  is ever used instead of CalDAV, Google can send invites natively via sendUpdates,
  making this iMIP sender optional. With the CalDAV path, a CalDAV PUT does NOT send
  invites, so THIS phase must send them itself.)
- REQUEST invite: a multipart email with a text/calendar; method=REQUEST; charset=UTF-8
  part AND an attached .ics, so mail clients render an RSVP UI. The VEVENT must use the
  stored ics_uid, the stored sequence, ORGANIZER = the owner's email, ATTENDEE = the
  external booker (RSVP=TRUE, PARTSTAT=NEEDS-ACTION), DTSTAMP, DTSTART/DTEND in UTC,
  SUMMARY (page title), LOCATION. Sent to the external attendee only.
- Set ORGANIZER and the SMTP From sensibly aligned (document the choice) to maximize
  deliverability and correct RSVP rendering.

## Confirm flow — replace Phase 3's download-only behavior
Inside the existing confirm step (hold already validated/re-acquired):
1. Re-verify server-side that no overlapping CONFIRMED booking exists for the owner
   (never trust the client; reuse the engine/overlap check).
2. Write the event to the write target via the Google adapter -> capture externalRef.
3. Persist external_event_ref AND flip status=confirmed (store the ref together with
   the status change so you don't orphan a calendar event).
4. Send the METHOD:REQUEST invite (best-effort): if it fails, the booking still stands
   (the event exists) — record an email_failed flag, surface it to the owner, and
   allow a resend; still offer the visitor the .ics download regardless.
5. Show the confirmation page with .ics download + cancel link (cancel_token).
Failure handling: if step 2 (calendar write) FAILS, do NOT confirm — keep/expire the
hold, write nothing, send no email, and tell the visitor it couldn't be completed.
Confirm must be idempotent: a double-submit must not create two calendar events.

## Cancel flow — give it teeth
For both the visitor (cancel_token) and an owner-initiated cancel:
- Increment sequence, set status=cancelled.
- Call adapter.cancelEvent(target, external_event_ref, ics_uid, sequence) to remove
  the event from Google (handle a missing external_event_ref gracefully — e.g., a
  booking that never got written).
- Send a METHOD:CANCEL iMIP email to the attendee: same UID, bumped SEQUENCE,
  STATUS:CANCELLED, METHOD:CANCEL.
- The freed slot must become bookable again (engine already excludes cancelled).

## Tests — add to the suite (keep `now` injected; mock SMTP and the provider)
1. Adapter createEvent: against a mocked CalDAV server (or mocked tsdav), produces a
   valid VEVENT and returns an externalRef; cancelEvent issues the delete.
2. REQUEST .ics: correct METHOD, stable UID = stored ics_uid, SEQUENCE, ORGANIZER,
   ATTENDEE with RSVP/PARTSTAT, UTC times.
3. CANCEL .ics: same UID, SEQUENCE incremented, STATUS:CANCELLED, METHOD:CANCEL.
4. Confirm happy path: event written (ref stored), status=confirmed, REQUEST email
   sent once.
5. Calendar-write-fails: booking NOT confirmed, no email, slot still free.
6. Email-fails-after-write: booking confirmed, event exists, email_failed surfaced,
   .ics still downloadable.
7. Idempotent confirm: a double confirm creates exactly ONE calendar event.
8. Cancel: calendar cancelEvent called, CANCEL email sent, SEQUENCE incremented, slot
   freed; cancel with a wrong/!owned token does nothing.
9. Credentials never appear in logs or any client response (assert).

## Acceptance criteria — verify each actually passes before finishing
- A real end-to-end booking writes an event into the configured Google calendar and
  the external attendee receives a METHOD:REQUEST invite that renders as an RSVP in a
  normal mail client.
- The booked time then appears as BUSY in the app if that same Google calendar is also
  added as an availability source (confirms the §11 decoupling loop works end to end).
- Cancelling removes the event from Google and sends a CANCEL that the mail client
  processes.
- Calendar-write failure never produces a confirmed-but-uncalendared booking; email
  failure never rolls back an already-written event.
- Decrypted credentials never logged or returned to the client.

## When done
Summarize: which Google auth path you implemented (CalDAV+app-password vs API/OAuth)
and why, the adapter interface, the iMIP REQUEST/CANCEL construction, the confirm/cancel
failure-handling and idempotency strategy, and the SMTP/env config. Confirm each
acceptance criterion and how you verified it. Then STOP — do not proceed to Phase 5.
````

### Phase 5 — Internal multi-attendee booking

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0–4 are complete:
auth + admin user management + signup disabled; encrypted-credential CRUD; the tested
availability engine (which ALREADY supports multi-user intersection); the public
booking page with race-safe holds; and real Google write-back + METHOD:REQUEST/CANCEL
iMIP email on confirm/cancel.

Implement ONLY Phase 5 (Internal multi-attendee booking) from §8. Do NOT start Phase 6
(rate limiting, audit log, reminders, admin dashboard polish).

This phase: a logged-in user (the organizer) picks several OTHER account holders as
attendees, sees their SHARED free time (intersection of everyone's availability), books
a slot, and each internal attendee is invited. Reuse — do not reinvent — the Phase 2
engine and the Phase 4 adapter/email services.

## Goal of Phase 5
- Organizer (authed) creates an internal meeting: title, duration, attendees (≥1 other
  internal user), a date range to search, and which write target the event lands in.
- App computes slots that are free for the organizer AND every selected attendee, using
  the existing multi-user getFreeSlots (UNION of busy, INTERSECTION of working-hours
  windows — already built and tested in Phase 2).
- Organizer picks a slot -> race-safe hold -> confirm -> event written + each internal
  attendee invited via METHOD:REQUEST. Cancellation cancels for everyone.

## Data model (extend + migrations, per CLAUDE.md §5)
- Use the `booking` table for internal meetings too. For these rows: booking_page_id is
  NULL, organizer_user_id = the organizer. Add a nullable `kind` (enum: external|internal,
  default external) if it helps distinguish them cleanly, OR rely on booking_page_id
  being NULL — pick one and document it.
- Implement the `booking_attendee` join table from §5: booking_id (FK), user_id (FK),
  invite_status (enum: needs_action|accepted|declined, default needs_action),
  email_failed (bool, default false). Unique (booking_id, user_id).
- The organizer is also an attendee for availability/visibility purposes — decide
  whether to store an organizer row in booking_attendee or treat organizer_user_id
  implicitly, and document it. Either way the organizer's calendar must be included in
  both the availability check AND the conflict re-check.

## Availability (reuse Phase 2 — do NOT rewrite the math)
- Call getFreeSlots with userIds = [organizer, ...attendees]. The engine already does
  intersection + fail-closed.
- Fail-closed is critical here: if ANY attendee's feed can't be fetched and has no
  cache, that attendee contributes "fully busy", so the shared result correctly shows
  no slots rather than risking a conflict for someone. Surface WHICH attendee's
  availability could not be determined so the organizer understands the empty result.
- Counting existing commitments: a slot is unavailable if it overlaps any attendee's
  confirmed booking or live pending_hold (the engine's booking-gather already does this
  per user — confirm it runs for every attendee, internal and external bookings alike).

## Booking flow (authed organizer)
1. Organizer UI: title, duration, multi-select of other internal users (exclude self
   from the pick list; self is added automatically), search range, write target.
2. Show shared free slots (organizer's timezone by default; show each attendee's tz if
   easy). Never reveal WHY a time is busy for an attendee — only free/busy, consistent
   with the privacy rule. Do not expose attendees' event details to each other.
3. CREATE HOLD atomically (reuse the Phase 3 BEGIN IMMEDIATE transaction pattern): in
   one write-locked unit, re-verify the slot is genuinely free for organizer AND every
   attendee (no overlapping confirmed/live-hold booking for ANY of them), then insert
   the booking (status=pending_hold, expires_at = now + HOLD_TTL) plus the
   booking_attendee rows. If any attendee conflicts, abort and report it. NEVER trust
   the client's claim of availability — always recompute server-side for all attendees.
4. CONFIRM: re-check the hold is valid; re-verify no conflict for any attendee; write
   the event ONCE to the organizer's write target via the Phase 4 Google adapter
   (capture external_event_ref); flip status=confirmed; send a METHOD:REQUEST invite to
   EACH internal attendee's email (organizer is ORGANIZER; each attendee is an ATTENDEE
   line). Reuse the Phase 4 iMIP builder — extend it to emit multiple ATTENDEE
   properties in the single VEVENT, and send the per-recipient REQUEST emails.
   - Per-attendee email is best-effort: if one attendee's email fails, set that
     attendee's email_failed, keep the booking, allow resend — do not roll back the
     calendar event. (Same posture as Phase 4.)
   - If the calendar WRITE fails: do NOT confirm (no event, no emails); keep/expire the
     hold. Confirm must stay idempotent — a double submit creates exactly one event and
     one invite per attendee.
5. Confirmation page lists attendees + their invite_status (all needs_action initially)
   and a cancel control for the organizer.

## Cancellation
- Organizer cancels -> increment sequence, status=cancelled, adapter.cancelEvent on the
  written event, and send METHOD:CANCEL (same UID, bumped SEQUENCE, STATUS:CANCELLED) to
  EVERY attendee. Freed time becomes available for all of them (engine already excludes
  cancelled).
- (RSVP intake — actually flipping invite_status from attendees' replies — is OUT OF
  SCOPE this phase; default everyone to needs_action. Note it as a future item.)

## Authorization & privacy (CLAUDE.md §9)
- Only authed users can create internal meetings. An organizer may select other users
  as attendees, but must NOT be able to read their calendars or event details — only
  free/busy via the engine. Enforce in the server layer.
- A user can only cancel/modify a meeting they organize. Attendees see meetings they're
  on (read-only) but cannot mutate another organizer's booking.
- Reuse encrypted credentials / no-secret-leak rules from earlier phases.

## Tests — add to the suite (keep `now` injected; mock SMTP + provider)
1. Three users, overlapping working hours, conflicting events -> only genuinely
   common-free slots returned; a slot busy for ONE attendee is excluded.
2. One attendee's feed unreachable + no cache -> shared result is empty AND that
   attendee is named as undetermined (fail-closed).
3. Hold inserts booking + all booking_attendee rows atomically; a conflict for any one
   attendee aborts the whole hold (no partial rows).
4. RACE: two organizers trying to book a slot that conflicts for a shared attendee ->
   exactly one succeeds.
5. Confirm writes exactly ONE calendar event and sends one REQUEST per attendee; the
   VEVENT contains all ATTENDEE lines with the stored UID/SEQUENCE.
6. One attendee's email fails -> their email_failed set, booking stands, others still
   invited, calendar event intact.
7. Idempotent confirm: double submit -> one event, one invite per attendee.
8. Cancel -> cancelEvent called once, CANCEL sent to every attendee, SEQUENCE bumped,
   slots freed for all.
9. Authorization: a non-organizer cannot cancel/modify; an organizer cannot read an
   attendee's event details (only free/busy).

## Acceptance criteria — verify each actually passes before finishing
- An organizer can select ≥2 other accounts and see only times free for everyone.
- Booking writes one event to the organizer's Google calendar and every internal
  attendee receives an RSVP invite.
- If any attendee's availability can't be determined, the shared result is empty and
  says which attendee — never a slot that conflicts for someone.
- Cancelling removes the event and notifies all attendees; freed time reopens for all.
- No partial holds, no double calendar events, no secret leaks.

## When done
Summarize: how internal vs external bookings are distinguished, the booking_attendee
model and organizer handling, how the multi-user hold transaction stays atomic across
attendees, the multi-ATTENDEE iMIP construction, and the failure/idempotency posture.
Confirm each acceptance criterion and how you verified it. Then STOP — do not proceed
to Phase 6.
````

### Phase 6 — Hardening (final phase)

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0–5 are complete:
auth + admin user management + signup disabled; encrypted-credential CRUD; the tested
availability engine; public booking pages with race-safe holds; real Google write-back
+ iMIP REQUEST/CANCEL email; and internal multi-attendee booking.

Implement ONLY Phase 6 (Hardening) from §8 — the final phase. Do NOT add new calendar
write adapters (msgraph/others stay out), and do NOT build attendee RSVP intake
(flipping invite_status from replies) — both are documented future items, not this
phase. This phase makes the existing app safe and operable on the public internet.

## Goal of Phase 6
Real rate limiting on public endpoints, an append-only audit log, polished
secret-link rotation, email reminders via a restart-safe scheduler, consistent
timezone display, and an admin dashboard for operational visibility — plus baseline
web hardening.

## 1. Rate limiting (public, unauthenticated endpoints)
- Replace Phase 3's basic guard with a real limiter (token-bucket or fixed-window) on:
  public slot-list, create-hold, confirm, cancel, AND the login endpoint
  (brute-force). Key by IP and, where applicable, by booking-page token.
- On limit: return 429 with Retry-After; never leak whether a token exists.
- HOLD-SPAM is a product-specific DoS: an attacker creating holds on every slot makes a
  page look fully booked. Mitigate explicitly — tight per-IP and per-email hold-creation
  limits, short TTL (already configured), and a cap on concurrent live holds per page
  per IP. Document the chosen limits.
- Storage: a SQLite-backed or in-memory limiter is fine for single-container self-host.
  Add a code comment that horizontal scaling would require shared storage (e.g. Redis).
  Limit values come from env with sane defaults.

## 2. Audit log (append-only)
- New `audit_log` table: id, ts, actor (user id or "public"/"system"), action,
  target_type, target_id, ip (nullable), metadata (JSON, NON-secret), created_at.
  Append-only — no update/delete paths.
- Record at minimum: admin actions (user create/disable/role change/password reset),
  write-target credential create/change, booking-page create/rotate/revoke,
  booking confirmed/cancelled, calendar write success/failure, email sent/failed,
  login success/failure, rate-limit blocks.
- NEVER write secrets, decrypted credentials, or attendee PII beyond what's necessary
  (store email only where it's the actual subject of the action). Admin-only viewer
  with filtering by actor/action/date.

## 3. Secret-link rotation polish
- Finalize page token rotate/revoke: confirm-before-rotate UX, show last-rotated time,
  and a test proving the OLD token is fully dead immediately after rotation.
- Optional per-page link expiry (env-defaulted off). Audit every rotation/revocation.

## 4. Reminders (restart-safe scheduler)
- Send reminder emails before a meeting (configurable offsets, e.g. 24h and 1h) to the
  attendee(s) and optionally the organizer. Reuse the Phase 4 email service. These are
  plain notification emails (no iMIP method), NOT new invites.
- Track sent reminders so they fire EXACTLY ONCE: a `reminder` table or a
  sent_reminders marker keyed by (booking_id, offset). The scheduler must be idempotent
  across restarts and overlapping runs — re-running must not resend.
- Skip cancelled bookings and bookings already past. For internal meetings, remind every
  attendee.
- Mechanism (self-hosted Node/Docker, not serverless): an in-process scheduler (e.g.
  node-cron) that ticks periodically and processes due reminders inside a transaction
  that claims them before sending. ALSO expose a protected (admin/secret-key) manual
  trigger endpoint so an external cron can drive it instead. Document both. Email
  failure marks the reminder for retry, not silent loss.

## 5. Timezone display polish (finalize §2 nice-to-have)
- Display all times in the viewer's local timezone with a clear tz label everywhere
  (public page, confirmation, admin, reminder emails). Detect the external visitor's
  local tz on the public page; let them override. Keep storage UTC; convert only at the
  edge. Assert DST-correct rendering.

## 6. Admin dashboard (operational visibility, read-mostly)
- One admin area surfacing: users (status/role), recent bookings system-wide,
  availability-source HEALTH (which sources have fetch_error / are stale),
  email failures (email_failed flags from Phases 4–5), and the audit log viewer.
- It reads existing data — do not change booking/availability logic. Admin-only,
  enforced server-side.

## 7. Baseline web hardening
- Security headers (a sensible CSP, HSTS, X-Content-Type-Options, Referrer-Policy,
  frame-ancestors). Confirm session cookies are httpOnly + secure + SameSite (verify
  better-auth's settings; assume HTTPS in production).
- Re-confirm the SSRF guard on ICS fetch (Phase 2) and outbound provider calls (Phase 4)
  are active. Re-confirm ENCRYPTION_KEY/secrets fail-fast at startup.
- Add a brief OPERATIONS.md: required env vars, how to run behind a reverse proxy with
  TLS, how to back up the SQLite file, and how reminders are driven.

## Tests — add to the suite (keep `now`/clock injected; mock SMTP)
1. Rate limiter: requests over the limit get 429 + Retry-After; under the limit pass;
   login brute-force is throttled.
2. Hold-spam: a single IP cannot create more than the configured number of live holds
   on a page; excess is rejected, slots stay bookable by others.
3. Audit log: a sampled set of actions each write exactly one append-only entry with no
   secrets; admin can filter them; non-admin cannot read them.
4. Rotation: after rotate, the OLD token returns the generic not-available response and
   the NEW token works; the rotation is audited.
5. Reminders: a due reminder sends once; re-running the scheduler does NOT resend;
   cancelled/past bookings get none; the claim-then-send transaction prevents duplicate
   sends under overlapping runs.
6. Timezone: the same UTC instant renders correctly across two viewer timezones,
   including across a DST boundary (assert exact local strings).
7. Hardening: security headers present; session cookie flags correct; startup still
   fails fast on a missing/invalid ENCRYPTION_KEY.

## Acceptance criteria — verify each actually passes before finishing
- Public endpoints are rate-limited and hold-spam cannot lock out a calendar.
- Security-relevant actions are recorded in an append-only, secret-free audit log
  viewable only by admins.
- Rotating a booking link instantly kills the old URL.
- Reminders fire exactly once and survive a process restart without resending.
- Times display in the viewer's timezone, DST-correct, storage still UTC.
- The admin dashboard shows users, recent bookings, feed-fetch health, and email
  failures. Security headers and secure session cookies are in place. OPERATIONS.md
  exists.

## When done
Summarize: the limiter strategy and chosen limits (incl. hold-spam), the audit-log
schema and what's recorded, the reminder scheduler design and how exactly-once + restart
safety are guaranteed, the timezone handling, the dashboard contents, and the hardening
applied. Confirm each acceptance criterion and how you verified it.

This is the final planned phase. In the summary, also list the deliberately-deferred
future items so they're on record: attendee RSVP intake (invite_status updates),
additional write adapters (msgraph/CalDAV-for-others), and any Graph parity work needed
if the org later migrates to M365.
````

### Phase 7 — Outbound free/busy feed + poll slot checker (OPTIONAL, post-launch)

Phase 6 completed the core product; Phase 7 is an optional enhancement. There is NO
Doodle integration here — Doodle has no usable public API, and automating its UI is
brittle and against its terms. This phase instead gives you two clean, supported-boundary
time-savers, both built on the Phase 2 engine.

````markdown
Read CLAUDE.md in the repo root fully before doing anything — it is the source of
truth for stack, architecture, data model, and conventions. Phases 0–6 are complete:
the full core product (auth, profiles, availability engine, public booking pages,
Google write-back + iMIP email, internal multi-attendee booking, hardening).

Implement ONLY Phase 7 (Outbound free/busy feed + poll slot checker). This is an
OPTIONAL post-launch enhancement built entirely on the existing Phase 2 engine and the
Phase 3 token + Phase 6 audit/rate-limit patterns.

Specifically do NOT in this phase:
- integrate with any Doodle API, or scrape / browser-automate doodle.com (Doodle has no
  usable public API; automating its UI is brittle and against its terms)
- auto-read a poll from a URL (this relies on unofficial endpoints — out of scope)
- auto-submit / auto-tick anything on any external site
- expose ANY event titles, attendees, descriptions, or locations in the outbound feed
- emit recurring events in the outbound feed (expand to concrete occurrences)

## Feature A — Outbound merged free/busy ICS feed
Goal: one read-only ICS URL per user that publishes their MERGED busy time as
free/busy ONLY (no details), so any tool that can subscribe to a calendar sees the
user's true cross-calendar conflicts. (Intended use: subscribe it into a Google calendar
that is connected to Doodle, so Doodle's response overlay reflects all calendars at once.
Whether Doodle includes a subscribed sub-calendar varies — see acceptance criteria.)

- Data model: add `freebusy_feed`: id, user_id (FK), secret_token (unique, CSPRNG
  base64url), active (bool), last_rotated_at, created_at. One default feed per user;
  support rotate + revoke (reuse the Phase 3 token approach).
- Endpoint: GET /fb/[token].ics — public, no auth, strictly token-scoped, returns
  text/calendar. Resolve token -> user; unknown/inactive -> generic 404, no info leak.
  - Build busy intervals via the engine's gatherBusyForUser over a rolling window
    [now - PAST_DAYS, now + FUTURE_DAYS] (env-config; defaults e.g. 7 / 90).
  - Busy = UNION of (all availability-source busy) + (this user's confirmed bookings) +
    (this user's live pending_holds). Exclude expired holds and cancelled bookings.
  - Do NOT apply working hours — a free/busy feed reports actual busy time, not offered
    hours.
  - Serialize via /lib/ics: a VCALENDAR (METHOD:PUBLISH) of OPAQUE VEVENTs, each with a
    stable UID, DTSTART/DTEND in UTC, TRANSP:OPAQUE, and a generic SUMMARY ("Busy") —
    NO other properties. Set X-PUBLISHED-TTL / sensible Cache-Control for pollers.
- Fail-closed: reuse engine behavior — a source that can't be fetched with no cache
  contributes fully-busy (safe: consumers never see false free time). Prefer cache on
  transient failure. Document that a prolonged source outage shows the feed fully busy.
- Security: token unguessable, rotatable, revocable; rate-limit /fb (reuse Phase 6).
  The feed reveals the user's busy *pattern* to anyone holding the URL (inherent to
  free/busy sharing) — state this clearly in the UI when generating the link. Audit
  feed create/rotate/revoke in the Phase 6 audit log.

## Feature B — Candidate-slot checker (authed)
Goal: paste candidate time slots (e.g. copied from a Doodle poll); the app classifies
each as free / busy / partial against the user's merged availability so they can tick
the right boxes themselves. No scraping, no auto-submit.

- Input: a textarea, one slot per line, in a DOCUMENTED format (e.g.
  `2026-07-13 10:00-10:30`), interpreted in the user's timezone (allow an explicit tz
  override). Optionally use a lenient natural-language parser (e.g. chrono-node) as a
  convenience, BUT always echo back how each line was interpreted (resolved start/end +
  tz) so misparses are caught before the verdict. Flag unparseable lines — never guess
  silently.
- Engine: add a PURE helper classifyIntervals(busyIntervals, candidates) ->
  per-candidate { status: free|busy|partial, overlap }. Impure wrapper
  classifyForUsers(userIds, candidates, range) reuses gatherBusyForUser. Keep `now`
  injected.
- Multi-user (optional — the engine already supports it): allow selecting internal
  attendees to classify SHARED availability for the pasted slots (free only if free for
  everyone). Fail-closed naming carries over: name any attendee whose availability is
  undetermined.
- Output: a table (slot | status) plus a copyable list of the free slots. Read-only —
  the user clicks in the external poll themselves.

## Tests (keep `now` injected; mock HTTP/DB)
A1. /fb/[token].ics is a valid VCALENDAR of opaque busy VEVENTs with NO titles /
    attendees / descriptions / locations.
A2. Feed busy = union of source busy + confirmed bookings + live holds; expired holds
    and cancelled bookings excluded.
A3. A down source with no cache -> feed shows fully busy for the window (fail-closed),
    never free.
A4. Rotating the feed token kills the old URL immediately; rotate/revoke is audited.
A5. /fb is rate-limited; unknown/inactive token -> generic 404, no info leak.
B1. The documented slot format parses to correct UTC intervals in the user's tz,
    including a slot crossing a DST boundary.
B2. Each pasted line is echoed with its interpreted start/end/tz; an unparseable line is
    flagged, not guessed.
B3. classifyIntervals labels free, fully-busy, and partially-overlapping candidates
    correctly.
B4. Multi-user (if built): a slot busy for one selected attendee is "busy"; an
    undetermined attendee is named.

## Acceptance criteria — verify each actually passes before finishing
- A user can generate a free/busy feed URL and subscribe it into a Google calendar; that
  calendar (connected to Doodle) reflects the merged busy times in Doodle's response
  overlay. NOTE: Doodle's handling of subscribed sub-calendars is inconsistent — verify
  with a real poll. If Doodle ignores the subscription, the feed still works in other
  calendar tools, which is acceptable.
- The feed contains busy blocks ONLY — confirm no event titles / attendees / locations
  leak (inspect the raw .ics).
- Pasting a poll's candidate slots returns a correct free/busy verdict per slot, with
  each slot's interpretation shown.
- Rotating the feed token invalidates the old URL; /fb is rate-limited; feed actions are
  audited.
- No Doodle API call, scraping, or auto-submission exists anywhere in this phase.

## When done
Summarize: the feed schema/endpoint and rolling window, how free/busy is stripped of all
PII, the fail-closed behavior, the slot-parsing approach and how misparses are surfaced,
the classify helper, and the security/audit. Confirm each acceptance criterion and how
you verified it. Note explicitly that Doodle has no public API, so this is the
supported-boundary approach (overlay + manual ticking), not auto-fill.
````

---

## 3. Per-phase review checklist (eyeball these yourself)

These are the spots where subtle bugs hide. After each phase, check the matching item
in addition to letting Claude Code report its own acceptance criteria.

- **Phase 0** — Confirm the signup endpoint is actually *rejected*, not merely hidden
  from the UI.
- **Phase 1** — Open the SQLite DB directly and confirm the credential column holds
  ciphertext, not plaintext. This is the security crux of the phase.
- **Phase 2** — Run the fail-closed case against the logic in your head: a dropped feed
  must show *zero* availability, never more. Check DST fixtures assert *exact* UTC
  timestamps, not "looks about right."
- **Phase 3** — The race test must exercise genuinely *concurrent* holds (two contending
  transactions), not two sequential calls. Confirm `BEGIN IMMEDIATE` is what makes the
  check-then-insert atomic.
- **Phase 4** — Do a live end-to-end with your real Google calendar and a real mail
  client: the invite must render as an RSVP *and* appear in Google, and that booked
  event must then show as busy via the ICS feed you subscribed back (the decoupling
  loop). Verify a calendar-write failure leaves the slot genuinely free — never a
  confirmed booking with no calendar entry behind it.
- **Phase 5** — A conflict for any *one* attendee must abort the *entire* hold with no
  orphaned `booking_attendee` rows. When an attendee's feed is down, the organizer must
  see *which* attendee is undetermined, so an empty result doesn't look like a bug.
- **Phase 6** — The hold-spam test must prove one IP can't silently fill your calendar
  with holds. The reminder scheduler must *claim* due reminders inside a transaction
  *before* sending (not "send then mark sent"), or it double-sends on a crash between
  the two steps.
- **Phase 7** — Open the raw `/fb/[token].ics` in a text viewer and confirm it contains
  busy blocks only — no event titles leak. Test the Google→Doodle overlay with a real
  poll before relying on it; Doodle's handling of subscribed sub-calendars is
  inconsistent, so confirm it actually reflects (the feed is still useful in other tools
  if it doesn't).

---

## 4. Deliberately deferred (future work, on the record)

- **Attendee RSVP intake** — updating `invite_status` from attendees' actual replies.
- **Additional write adapters** — `msgraph` (Microsoft Graph) and CalDAV-for-others,
  behind the existing `CalendarWriteAdapter` interface.
- **M365 migration path** — if the org later moves to Microsoft 365, the write target
  stays on private Google (unaffected), but reading the work calendar may need a Graph
  read path if ICS publishing is disabled post-migration. Revisit then.
- **Horizontal scaling** — the in-memory/SQLite rate limiter and in-process scheduler
  assume a single container; multi-instance would need shared storage (e.g. Redis).
