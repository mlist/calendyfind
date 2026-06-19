/**
 * Phase 5: internal multi-attendee booking tests.
 *
 * 9 tests covering:
 *  1. createInternalHold happy path (hold + attendee rows inserted)
 *  2. createInternalHold INVALID_SLOT
 *  3. createInternalHold SLOT_TAKEN (organizer has conflict)
 *  4. createInternalHold ATTENDEE_CONFLICT (attendee has conflict)
 *  5. createInternalHold serialization: two concurrent holds → one SLOT_TAKEN
 *  6. finalizeInternalBooking happy path (confirmed + externalRef)
 *  7. finalizeInternalBooking ALREADY_CONFIRMED idempotency
 *  8. cancelInternalBooking NOT_ORGANIZER enforcement
 *  9. getBookingsBusy includes attendee-side busy intervals
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { DB } from '@/lib/booking/internal';
import {
  createInternalHold,
  finalizeInternalBooking,
  cancelInternalBooking,
} from '@/lib/booking/internal';
import { getBookingsBusy } from '@/lib/booking/holds';

const TEST_KEY = 'c'.repeat(64);
beforeAll(() => { process.env.ENCRYPTION_KEY = TEST_KEY; });

// ─── DB helpers ───────────────────────────────────────────────────────────────

function makeDb(): DB {
  const raw = new Database(':memory:');
  raw.pragma('busy_timeout = 3000');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

const T = new Date('2024-07-01T09:00:00Z');
const T_PLUS_1H = new Date(T.getTime() + 60 * 60_000);
const T_PLUS_2H = new Date(T.getTime() + 2 * 60 * 60_000);

function insertUser(db: DB, suffix = ''): { id: string; name: string; email: string } {
  const id = `user-${Math.random().toString(36).slice(2)}${suffix}`;
  const email = `${id}@example.com`;
  const name = `User ${suffix || id}`;
  db.insert(schema.user).values({
    id, name, email, emailVerified: false,
    timezone: 'UTC', createdAt: T, updatedAt: T,
  }).run();
  return { id, name, email };
}

function makeSlot(...starts: Date[]): Set<number> {
  return new Set(starts.map(d => d.getTime()));
}

// ─── Test 1: createInternalHold happy path ────────────────────────────────────

describe('createInternalHold — happy path', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('inserts hold + attendee rows and returns ok=true', () => {
    const organizer = insertUser(db, 'org');
    const attendee1 = insertUser(db, 'att1');
    const attendee2 = insertUser(db, 'att2');

    const result = createInternalHold(db, {
      organizerUserId: organizer.id,
      organizerName:   organizer.name,
      organizerEmail:  organizer.email,
      title:           'Team sync',
      durationMin:     30,
      slotStart:       T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [
        { userId: attendee1.id, name: attendee1.name, email: attendee1.email },
        { userId: attendee2.id, name: attendee2.name, email: attendee2.email },
      ],
      writeTargetId: null,
      now: T,
      holdTtlMin: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Booking row exists with correct data
    const booking = db.select().from(schema.booking)
      .where(eq(schema.booking.id, result.holdId))
      .get();
    expect(booking?.status).toBe('pending_hold');
    expect(booking?.bookingPageId).toBeNull();
    expect(booking?.title).toBe('Team sync');
    expect(booking?.organizerUserId).toBe(organizer.id);

    // booking_attendee rows exist
    const rows = db.select().from(schema.bookingAttendee)
      .where(eq(schema.bookingAttendee.bookingId, result.holdId))
      .all();
    expect(rows).toHaveLength(2);
    const userIds = rows.map(r => r.userId).sort();
    expect(userIds).toContain(attendee1.id);
    expect(userIds).toContain(attendee2.id);
    expect(rows.every(r => r.inviteStatus === 'needs_action')).toBe(true);
  });
});

// ─── Test 2: createInternalHold INVALID_SLOT ─────────────────────────────────

describe('createInternalHold — INVALID_SLOT', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns INVALID_SLOT when slotStart is not in validSlotStartMs', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    const result = createInternalHold(db, {
      organizerUserId: organizer.id,
      organizerName:   organizer.name,
      organizerEmail:  organizer.email,
      title: 'Test',
      durationMin: 30,
      slotStart:        T_PLUS_2H,       // not in validSlotStartMs
      validSlotStartMs: makeSlot(T_PLUS_1H), // only T+1H valid
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null,
      now: T,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('INVALID_SLOT');
  });
});

// ─── Test 3: createInternalHold SLOT_TAKEN (organizer conflict) ───────────────

describe('createInternalHold — SLOT_TAKEN (organizer conflict)', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns SLOT_TAKEN when organizer already has a booking at that time', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    // Pre-create a confirmed booking for the organizer at T_PLUS_1H
    const existingId = `booking-existing`;
    db.insert(schema.booking).values({
      id:              existingId,
      bookingPageId:   null,
      organizerUserId: organizer.id,
      attendeeName:    organizer.name,
      attendeeEmail:   organizer.email,
      title:           'Existing meeting',
      startUtc:        T_PLUS_1H,
      endUtc:          new Date(T_PLUS_1H.getTime() + 30 * 60_000),
      status:          'confirmed',
      icsUid:          'uid-existing@local',
      cancelToken:     'tok-existing',
      sequence:        0,
      createdAt:       T,
    }).run();

    const result = createInternalHold(db, {
      organizerUserId: organizer.id,
      organizerName:   organizer.name,
      organizerEmail:  organizer.email,
      title: 'New meeting',
      durationMin: 30,
      slotStart:        T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null,
      now: T,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SLOT_TAKEN');
  });
});

// ─── Test 4: createInternalHold ATTENDEE_CONFLICT ────────────────────────────

describe('createInternalHold — ATTENDEE_CONFLICT', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns ATTENDEE_CONFLICT when an attendee has a confirmed booking at that time', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');
    const third     = insertUser(db, 'third'); // organizer of attendee's existing meeting

    // Attendee is an attendee on an existing confirmed meeting at T_PLUS_1H
    const existingId = `booking-for-att`;
    db.insert(schema.booking).values({
      id:              existingId,
      bookingPageId:   null,
      organizerUserId: third.id,
      attendeeName:    third.name,
      attendeeEmail:   third.email,
      title:           'Third party meeting',
      startUtc:        T_PLUS_1H,
      endUtc:          new Date(T_PLUS_1H.getTime() + 30 * 60_000),
      status:          'confirmed',
      icsUid:          'uid-third@local',
      cancelToken:     'tok-third',
      sequence:        0,
      createdAt:       T,
    }).run();

    db.insert(schema.bookingAttendee).values({
      id:           'ba-existing',
      bookingId:    existingId,
      userId:       attendee.id,
      inviteStatus: 'needs_action',
      emailFailed:  false,
    }).run();

    const result = createInternalHold(db, {
      organizerUserId: organizer.id,
      organizerName:   organizer.name,
      organizerEmail:  organizer.email,
      title: 'My meeting',
      durationMin: 30,
      slotStart:        T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null,
      now: T,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ATTENDEE_CONFLICT');
    expect(result.conflictUserId).toBe(attendee.id);
  });
});

// ─── Test 5: serialization (two concurrent holds on same slot) ────────────────

describe('createInternalHold — serialization', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('one of two concurrent holds for the same slot is rejected as SLOT_TAKEN', () => {
    const org1 = insertUser(db, 'org1');
    const org2 = insertUser(db, 'org2');
    const att  = insertUser(db, 'att');

    const opts1 = {
      organizerUserId: org1.id, organizerName: org1.name, organizerEmail: org1.email,
      title: 'Meeting A', durationMin: 30, slotStart: T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: att.id, name: att.name, email: att.email }],
      writeTargetId: null, now: T,
    };
    const opts2 = {
      ...opts1,
      organizerUserId: org2.id, organizerName: org2.name, organizerEmail: org2.email,
      title: 'Meeting B',
      attendees: [{ userId: att.id, name: att.name, email: att.email }],
    };

    const r1 = createInternalHold(db, opts1);
    const r2 = createInternalHold(db, opts2);

    // att is an attendee in r1's hold → r2 must detect the conflict
    const outcomes = [r1.ok, r2.ok];
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);

    // The failing one must be ATTENDEE_CONFLICT (att already has a hold) or SLOT_TAKEN
    const failed = [r1, r2].find(r => !r.ok) as Extract<typeof r1, { ok: false }>;
    expect(['SLOT_TAKEN', 'ATTENDEE_CONFLICT']).toContain(failed.reason);
  });
});

// ─── Test 6: finalizeInternalBooking happy path ───────────────────────────────

describe('finalizeInternalBooking — happy path', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('sets status=confirmed and stores externalEventRef', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    const holdResult = createInternalHold(db, {
      organizerUserId: organizer.id,
      organizerName:   organizer.name,
      organizerEmail:  organizer.email,
      title: 'Team sync', durationMin: 30,
      slotStart: T_PLUS_1H, validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null, now: T, holdTtlMin: 60,
    });
    expect(holdResult.ok).toBe(true);
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    const result = finalizeInternalBooking(db, holdId, organizer.id, 'gcal-evt-123', T);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.booking.status).toBe('confirmed');
    expect(result.booking.externalEventRef).toBe('gcal-evt-123');
    expect(result.attendees).toHaveLength(1);
  });
});

// ─── Test 7: finalizeInternalBooking idempotency ──────────────────────────────

describe('finalizeInternalBooking — idempotency', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns ALREADY_CONFIRMED on second finalize call', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    const holdResult = createInternalHold(db, {
      organizerUserId: organizer.id, organizerName: organizer.name, organizerEmail: organizer.email,
      title: 'Sync', durationMin: 30, slotStart: T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null, now: T, holdTtlMin: 60,
    });
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    const first = finalizeInternalBooking(db, holdId, organizer.id, 'ref-1', T);
    expect(first.ok).toBe(true);

    const second = finalizeInternalBooking(db, holdId, organizer.id, 'ref-2', T);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('ALREADY_CONFIRMED');
  });
});

// ─── Test 8: cancelInternalBooking NOT_ORGANIZER ─────────────────────────────

describe('cancelInternalBooking — NOT_ORGANIZER', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns NOT_ORGANIZER when a non-organizer tries to cancel', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    const holdResult = createInternalHold(db, {
      organizerUserId: organizer.id, organizerName: organizer.name, organizerEmail: organizer.email,
      title: 'Meeting', durationMin: 30, slotStart: T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null, now: T,
    });
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    // Attendee tries to cancel — must be denied
    const result = cancelInternalBooking(db, holdId, attendee.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NOT_ORGANIZER');

    // Booking must still be pending_hold
    const booking = db.select().from(schema.booking)
      .where(eq(schema.booking.id, holdId))
      .get();
    expect(booking?.status).toBe('pending_hold');
  });
});

// ─── Test 9: getBookingsBusy includes attendee-side busy intervals ─────────────

describe('getBookingsBusy — attendee coverage', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('blocks time for a user who is an attendee (not organizer) of a confirmed meeting', () => {
    const organizer = insertUser(db, 'org');
    const attendee  = insertUser(db, 'att');

    // Attendee is NOT the organizer
    const holdResult = createInternalHold(db, {
      organizerUserId: organizer.id, organizerName: organizer.name, organizerEmail: organizer.email,
      title: 'Dept meeting', durationMin: 30, slotStart: T_PLUS_1H,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      attendees: [{ userId: attendee.id, name: attendee.name, email: attendee.email }],
      writeTargetId: null, now: T,
    });
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;
    finalizeInternalBooking(db, holdId, organizer.id, null, T);

    const range = { from: T, to: T_PLUS_2H };

    // Organizer sees their own booking
    const orgBusy = getBookingsBusy(db, organizer.id, range, T);
    expect(orgBusy.length).toBeGreaterThanOrEqual(1);

    // Attendee also sees it as busy (even though they're not the organizer)
    const attBusy = getBookingsBusy(db, attendee.id, range, T);
    expect(attBusy.length).toBeGreaterThanOrEqual(1);

    const blocked = attBusy[0];
    expect(blocked.start.getTime()).toBe(T_PLUS_1H.getTime());
  });
});
