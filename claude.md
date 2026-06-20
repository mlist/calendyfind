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

### External cancellation handling (accepted limitation)

When the owner cancels a confirmed booking directly from their calendar client (e.g. deletes the event in
Google Calendar or declines in Outlook), calendyfind is **not notified**. The `booking` row stays `confirmed`
in the DB indefinitely.

Accepted trade-off — option 3 (do nothing):
- The visitor's calendar client receives a proper iMIP `METHOD:CANCEL` automatically from the owner's calendar
  app, so the visitor's side is handled correctly without calendyfind's involvement.
- The slot appears blocked in calendyfind's slot picker until the owner also cancels inside calendyfind.
- **Practical mitigation:** if the owner's Google Calendar is subscribed as an availability source (per the
  read/write decoupling pattern above), deleted events disappear from the ICS feed on the next cache refresh
  (~15 min). The slot opens up for new bookings even though the DB row stays `confirmed`.

Options that were explicitly ruled out:
- **CalDAV polling** (check `externalEventRef` existence on a schedule): works for CalDAV and Google-via-CalDAV,
  but adds polling complexity and only covers the current adapter.
- **iMIP REPLY processing** (parse `PARTSTAT=DECLINED` reply emails): requires an inbound mail pipeline — too
  much infrastructure for a self-hosted app.

### Load-bearing prerequisite to verify before building

Confirm the org permits **internet calendar publishing** in Outlook/OWA so the Exchange work calendar can be
exposed as an ICS URL. If publishing is disabled, the READ side is blocked — resolve this before Phase 2.
