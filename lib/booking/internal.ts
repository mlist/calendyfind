import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/lib/db/schema';
import {
  booking as bookingTable,
  bookingAttendee as bookingAttendeeTable,
  writeTarget as writeTargetTable,
  user as userTable,
} from '@/lib/db/schema';

export type DB = BetterSQLite3Database<typeof schema>;

export type BookingRow       = typeof bookingTable.$inferSelect;
export type BookingAttendeeRow = typeof bookingAttendeeTable.$inferSelect;
export type WriteTargetRow   = typeof writeTargetTable.$inferSelect;
export type UserRow          = typeof userTable.$inferSelect;

const HOLD_TTL_MIN = Number(process.env.HOLD_TTL_MIN ?? '10');

function generateToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

// ─── Attendee input ───────────────────────────────────────────────────────────

export interface InternalAttendeeInput {
  userId: string;
  name: string;
  email: string;
}

// ─── createInternalHold ───────────────────────────────────────────────────────
// BEGIN IMMEDIATE transaction: checks all attendees + organizer for overlap,
// then inserts the hold and booking_attendee rows atomically.

export interface CreateInternalHoldOpts {
  organizerUserId: string;
  organizerName: string;
  organizerEmail: string;
  title: string;
  durationMin: number;
  location?: string;
  slotStart: Date;
  /** Pre-computed valid slot starts (Unix ms) from the availability engine. */
  validSlotStartMs: Set<number>;
  attendees: InternalAttendeeInput[];
  writeTargetId: string | null;
  now: Date;
  holdTtlMin?: number;
}

export type InternalHoldError =
  | 'INVALID_SLOT'
  | 'SLOT_TAKEN'
  | 'ATTENDEE_CONFLICT';

export type CreateInternalHoldResult =
  | { ok: true; holdId: string; cancelToken: string; icsUid: string }
  | { ok: false; reason: InternalHoldError; conflictUserId?: string };

export function createInternalHold(
  db: DB,
  opts: CreateInternalHoldOpts,
): CreateInternalHoldResult {
  const {
    organizerUserId, organizerName, organizerEmail,
    title, durationMin, slotStart, validSlotStartMs,
    attendees, writeTargetId, now,
  } = opts;
  const ttl = opts.holdTtlMin ?? HOLD_TTL_MIN;

  if (!validSlotStartMs.has(slotStart.getTime())) {
    return { ok: false, reason: 'INVALID_SLOT' };
  }

  const allUserIds = [organizerUserId, ...attendees.map(a => a.userId)];
  const slotEnd    = new Date(slotStart.getTime() + durationMin * 60_000);
  const expiresAt  = new Date(now.getTime() + ttl * 60_000);

  const id          = randomUUID();
  const icsUid      = `${randomUUID()}@calendyfind.local`;
  const cancelToken = generateToken();

  try {
    return db.transaction((tx): CreateInternalHoldResult => {
      const activeWhere = or(
        eq(bookingTable.status, 'confirmed'),
        and(eq(bookingTable.status, 'pending_hold'), gt(bookingTable.expiresAt, now)),
      );

      for (const uid of allUserIds) {
        // Check as organizer of any overlapping booking
        const asOrganizer = tx.select({ id: bookingTable.id })
          .from(bookingTable)
          .where(and(
            eq(bookingTable.organizerUserId, uid),
            activeWhere!,
            lt(bookingTable.startUtc, slotEnd),
            gt(bookingTable.endUtc, slotStart),
          ))
          .get();
        if (asOrganizer) {
          return { ok: false, reason: uid === organizerUserId ? 'SLOT_TAKEN' : 'ATTENDEE_CONFLICT', conflictUserId: uid };
        }

        // Check as attendee of any overlapping booking
        const attendeeBookingIds = tx.select({ bookingId: bookingAttendeeTable.bookingId })
          .from(bookingAttendeeTable)
          .where(eq(bookingAttendeeTable.userId, uid))
          .all()
          .map(r => r.bookingId);

        if (attendeeBookingIds.length > 0) {
          const asAttendee = tx.select({ id: bookingTable.id })
            .from(bookingTable)
            .where(and(
              inArray(bookingTable.id, attendeeBookingIds),
              activeWhere!,
              lt(bookingTable.startUtc, slotEnd),
              gt(bookingTable.endUtc, slotStart),
            ))
            .get();
          if (asAttendee) {
            return { ok: false, reason: uid === organizerUserId ? 'SLOT_TAKEN' : 'ATTENDEE_CONFLICT', conflictUserId: uid };
          }
        }
      }

      tx.insert(bookingTable).values({
        id,
        bookingPageId: null,
        organizerUserId,
        attendeeName: organizerName,
        attendeeEmail: organizerEmail,
        title,
        startUtc: slotStart,
        endUtc: slotEnd,
        status: 'pending_hold',
        icsUid,
        cancelToken,
        expiresAt,
        sequence: 0,
        writeTargetId,
        createdAt: now,
      }).run();

      for (const attendee of attendees) {
        tx.insert(bookingAttendeeTable).values({
          id: randomUUID(),
          bookingId: id,
          userId: attendee.userId,
          inviteStatus: 'needs_action',
          emailFailed: false,
        }).run();
      }

      return { ok: true, holdId: id, cancelToken, icsUid };
    }, { behavior: 'immediate' });
  } catch {
    return { ok: false, reason: 'SLOT_TAKEN' };
  }
}

// ─── finalizeInternalBooking ──────────────────────────────────────────────────
// Atomically confirms the hold and stores the externalEventRef after calendar write.

export type FinalizeInternalError = 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_CONFIRMED';

export type FinalizeInternalResult =
  | { ok: true; booking: BookingRow; attendees: BookingAttendeeRow[] }
  | { ok: false; reason: FinalizeInternalError };

export function finalizeInternalBooking(
  db: DB,
  holdId: string,
  organizerUserId: string,
  externalRef: string | null,
  now: Date,
): FinalizeInternalResult {
  return db.transaction((tx): FinalizeInternalResult => {
    const hold = tx.select().from(bookingTable)
      .where(and(eq(bookingTable.id, holdId), eq(bookingTable.organizerUserId, organizerUserId)))
      .get();

    if (!hold) return { ok: false, reason: 'NOT_FOUND' };
    if (hold.status === 'confirmed') return { ok: false, reason: 'ALREADY_CONFIRMED' };
    if (hold.status !== 'pending_hold') return { ok: false, reason: 'NOT_FOUND' };
    if (hold.expiresAt && hold.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };

    tx.update(bookingTable)
      .set({ status: 'confirmed', expiresAt: null, externalEventRef: externalRef })
      .where(eq(bookingTable.id, holdId))
      .run();

    const attendees = tx.select().from(bookingAttendeeTable)
      .where(eq(bookingAttendeeTable.bookingId, holdId))
      .all();

    return {
      ok: true,
      booking: { ...hold, status: 'confirmed' as const, expiresAt: null, externalEventRef: externalRef },
      attendees,
    };
  }, { behavior: 'immediate' });
}

// ─── cancelInternalBooking ────────────────────────────────────────────────────
// Cancels a booking. Caller must be the organizer (enforced by the server action).

export type CancelInternalError = 'NOT_FOUND' | 'NOT_ORGANIZER';

export type CancelInternalResult =
  | { ok: true; booking: BookingRow; attendees: BookingAttendeeRow[] }
  | { ok: false; reason: CancelInternalError };

export function cancelInternalBooking(
  db: DB,
  bookingId: string,
  organizerUserId: string,
): CancelInternalResult {
  const hold = db.select().from(bookingTable)
    .where(and(
      eq(bookingTable.id, bookingId),
      or(eq(bookingTable.status, 'confirmed'), eq(bookingTable.status, 'pending_hold')),
    ))
    .get();

  if (!hold) return { ok: false, reason: 'NOT_FOUND' };
  if (hold.organizerUserId !== organizerUserId) return { ok: false, reason: 'NOT_ORGANIZER' };

  const newSequence = (hold.sequence ?? 0) + 1;

  db.update(bookingTable)
    .set({ status: 'cancelled', expiresAt: null, sequence: newSequence })
    .where(eq(bookingTable.id, bookingId))
    .run();

  const attendees = db.select().from(bookingAttendeeTable)
    .where(eq(bookingAttendeeTable.bookingId, bookingId))
    .all();

  return {
    ok: true,
    booking: { ...hold, status: 'cancelled' as const, expiresAt: null, sequence: newSequence },
    attendees,
  };
}

// ─── getInternalBooking ───────────────────────────────────────────────────────

export function getInternalBookingById(
  db: DB,
  bookingId: string,
): { booking: BookingRow; attendees: BookingAttendeeRow[] } | null {
  const booking = db.select().from(bookingTable)
    .where(and(eq(bookingTable.id, bookingId), isNull(bookingTable.bookingPageId)))
    .get();
  if (!booking) return null;
  const attendees = db.select().from(bookingAttendeeTable)
    .where(eq(bookingAttendeeTable.bookingId, bookingId))
    .all();
  return { booking, attendees };
}

// ─── Organizer-accessible meetings ───────────────────────────────────────────

export function getOrganizedMeetings(
  db: DB,
  organizerUserId: string,
): BookingRow[] {
  return db.select().from(bookingTable)
    .where(and(
      eq(bookingTable.organizerUserId, organizerUserId),
      isNull(bookingTable.bookingPageId),
    ))
    .all()
    .sort((a, b) => (a.startUtc?.getTime() ?? 0) - (b.startUtc?.getTime() ?? 0));
}

// Meetings where userId is an attendee (not organizer)
export function getAttendingMeetings(
  db: DB,
  userId: string,
): BookingRow[] {
  const bookingIds = db.select({ bookingId: bookingAttendeeTable.bookingId })
    .from(bookingAttendeeTable)
    .where(eq(bookingAttendeeTable.userId, userId))
    .all()
    .map(r => r.bookingId);

  if (bookingIds.length === 0) return [];

  return db.select().from(bookingTable)
    .where(and(
      inArray(bookingTable.id, bookingIds),
      isNull(bookingTable.bookingPageId),
    ))
    .all()
    .sort((a, b) => (a.startUtc?.getTime() ?? 0) - (b.startUtc?.getTime() ?? 0));
}

// ─── setAttendeeEmailFailed ───────────────────────────────────────────────────

export function setAttendeeEmailFailed(
  db: DB,
  bookingId: string,
  userId: string,
): void {
  db.update(bookingAttendeeTable)
    .set({ emailFailed: true })
    .where(and(
      eq(bookingAttendeeTable.bookingId, bookingId),
      eq(bookingAttendeeTable.userId, userId),
    ))
    .run();
}

// ─── User helpers (for building attendee lists) ───────────────────────────────

export function getAllUsers(db: DB): UserRow[] {
  return db.select().from(userTable).all();
}

export function getUserById(db: DB, id: string): UserRow | undefined {
  return db.select().from(userTable).where(eq(userTable.id, id)).get();
}
