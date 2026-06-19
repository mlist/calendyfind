import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/lib/db/schema';
import { booking as bookingTable, bookingAttendee as bookingAttendeeTable, bookingPage as bookingPageTable, writeTarget as writeTargetTable } from '@/lib/db/schema';
import type { HoldError, ConfirmError, CancelError } from './types';

export type DB = BetterSQLite3Database<typeof schema>;

export type BookingPageRow  = typeof bookingPageTable.$inferSelect;
export type BookingRow      = typeof bookingTable.$inferSelect;
export type WriteTargetRow  = typeof writeTargetTable.$inferSelect;

const HOLD_TTL_MIN = Number(process.env.HOLD_TTL_MIN ?? '10');

function generateToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

// ─── Page helpers ─────────────────────────────────────────────────────────────

export function getPageByToken(db: DB, token: string): BookingPageRow | undefined {
  return db.select().from(bookingPageTable)
    .where(eq(bookingPageTable.secretToken, token))
    .get();
}

export function getPageById(db: DB, id: string, userId: string): BookingPageRow | undefined {
  return db.select().from(bookingPageTable)
    .where(and(eq(bookingPageTable.id, id), eq(bookingPageTable.userId, userId)))
    .get();
}

export function getOwnerPages(db: DB, userId: string): BookingPageRow[] {
  return db.select().from(bookingPageTable)
    .where(eq(bookingPageTable.userId, userId))
    .all();
}

export function getUpcomingBookings(db: DB, organizerUserId: string, limit = 50): BookingRow[] {
  return db.select().from(bookingTable)
    .where(and(
      eq(bookingTable.organizerUserId, organizerUserId),
      or(eq(bookingTable.status, 'confirmed'), eq(bookingTable.status, 'pending_hold')),
    ))
    .all()
    .filter(b => b.startUtc !== null)
    .sort((a, b) => (a.startUtc?.getTime() ?? 0) - (b.startUtc?.getTime() ?? 0))
    .slice(0, limit);
}

// ─── Booking helpers ──────────────────────────────────────────────────────────

export function getBookingById(db: DB, id: string): BookingRow | undefined {
  return db.select().from(bookingTable).where(eq(bookingTable.id, id)).get();
}

export function getBookingByCancelToken(db: DB, cancelToken: string): BookingRow | undefined {
  return db.select().from(bookingTable)
    .where(eq(bookingTable.cancelToken, cancelToken))
    .get();
}

export function getWriteTargetById(db: DB, id: string): WriteTargetRow | undefined {
  return db.select().from(writeTargetTable).where(eq(writeTargetTable.id, id)).get();
}

export function getWriteTargetForUser(db: DB, userId: string, id: string): WriteTargetRow | undefined {
  return db.select().from(writeTargetTable)
    .where(and(eq(writeTargetTable.id, id), eq(writeTargetTable.userId, userId)))
    .get();
}

// Returns busy intervals from confirmed + non-expired holds for a given user+range.
// Covers bookings where the user is organizer OR an invited attendee.
export function getBookingsBusy(
  db: DB,
  userId: string,
  range: { from: Date; to: Date },
  now: Date,
): { start: Date; end: Date }[] {
  const activeWhere = or(
    eq(bookingTable.status, 'confirmed'),
    and(eq(bookingTable.status, 'pending_hold'), gt(bookingTable.expiresAt, now)),
  );
  const rangeWhere = and(lt(bookingTable.startUtc, range.to), gt(bookingTable.endUtc, range.from));

  const asOrganizer = db.select({ startUtc: bookingTable.startUtc, endUtc: bookingTable.endUtc })
    .from(bookingTable)
    .where(and(eq(bookingTable.organizerUserId, userId), activeWhere!, rangeWhere!))
    .all()
    .map(r => ({ start: r.startUtc!, end: r.endUtc! }));

  // Bookings where the user is an invited attendee (not organizer)
  const attendeeBookingIds = db.select({ bookingId: bookingAttendeeTable.bookingId })
    .from(bookingAttendeeTable)
    .where(eq(bookingAttendeeTable.userId, userId))
    .all()
    .map(r => r.bookingId);

  if (attendeeBookingIds.length === 0) return asOrganizer;

  const asAttendee = db.select({ startUtc: bookingTable.startUtc, endUtc: bookingTable.endUtc })
    .from(bookingTable)
    .where(and(inArray(bookingTable.id, attendeeBookingIds), activeWhere!, rangeWhere!))
    .all()
    .map(r => ({ start: r.startUtc!, end: r.endUtc! }));

  return [...asOrganizer, ...asAttendee];
}

// ─── createHold ───────────────────────────────────────────────────────────────
// Uses db.transaction({ behavior: 'immediate' }) so two concurrent holds on
// the same slot serialize: the loser gets SLOT_TAKEN, never a double-book.

export interface CreateHoldOpts {
  page: BookingPageRow;
  /** Pre-computed valid slot starts (Unix ms). Computed by caller via getFreeSlots. */
  validSlotStartMs: Set<number>;
  slotStart: Date;
  attendeeName: string;
  attendeeEmail: string;
  now: Date;
  holdTtlMin?: number;
}

export type CreateHoldResult =
  | { ok: true; holdId: string; cancelToken: string; icsUid: string }
  | { ok: false; reason: HoldError };

export function createHold(db: DB, opts: CreateHoldOpts): CreateHoldResult {
  const { page, validSlotStartMs, slotStart, attendeeName, attendeeEmail, now } = opts;
  const ttl = opts.holdTtlMin ?? HOLD_TTL_MIN;
  const slotEnd   = new Date(slotStart.getTime() + page.durationMin * 60_000);
  const expiresAt = new Date(now.getTime() + ttl * 60_000);

  // Slot boundary check (before the transaction — pure math)
  if (!validSlotStartMs.has(slotStart.getTime())) {
    return { ok: false, reason: 'INVALID_SLOT' };
  }

  const id          = randomUUID();
  const icsUid      = `${randomUUID()}@calendyfind.local`;
  const cancelToken = generateToken();

  try {
    // BEGIN IMMEDIATE acquires the write lock immediately so two concurrent
    // holds cannot both pass the overlap check and both insert.
    const result = db.transaction((tx): CreateHoldResult => {
      const overlap = tx.select({ id: bookingTable.id })
        .from(bookingTable)
        .where(and(
          eq(bookingTable.organizerUserId, page.userId),
          or(
            eq(bookingTable.status, 'confirmed'),
            and(eq(bookingTable.status, 'pending_hold'), gt(bookingTable.expiresAt, now)),
          ),
          lt(bookingTable.startUtc, slotEnd),
          gt(bookingTable.endUtc, slotStart),
        ))
        .get();

      if (overlap) return { ok: false, reason: 'SLOT_TAKEN' };

      tx.insert(bookingTable).values({
        id,
        bookingPageId: page.id,
        organizerUserId: page.userId,
        attendeeName,
        attendeeEmail,
        startUtc: slotStart,
        endUtc: slotEnd,
        status: 'pending_hold',
        icsUid,
        cancelToken,
        expiresAt,
        sequence: 0,
        createdAt: now,
      }).run();

      return { ok: true, holdId: id, cancelToken, icsUid };
    }, { behavior: 'immediate' });

    return result;
  } catch {
    // SQLITE_BUSY under high contention — treat as SLOT_TAKEN (safe fallback)
    return { ok: false, reason: 'SLOT_TAKEN' };
  }
}

// ─── confirmHold ──────────────────────────────────────────────────────────────

export type ConfirmResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; reason: ConfirmError };

export function confirmHold(db: DB, holdId: string, pageId: string, now: Date): ConfirmResult {
  const result = db.transaction((tx): ConfirmResult => {
    const hold = tx.select().from(bookingTable)
      .where(eq(bookingTable.id, holdId))
      .get();

    if (!hold) return { ok: false, reason: 'NOT_FOUND' };
    if (hold.bookingPageId !== pageId) return { ok: false, reason: 'WRONG_PAGE' };
    if (hold.status === 'confirmed') return { ok: false, reason: 'ALREADY_CONFIRMED' };
    if (hold.status !== 'pending_hold') return { ok: false, reason: 'NOT_FOUND' };
    if (hold.expiresAt && hold.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };

    tx.update(bookingTable)
      .set({ status: 'confirmed', expiresAt: null })
      .where(eq(bookingTable.id, holdId))
      .run();

    return { ok: true, booking: { ...hold, status: 'confirmed' as const, expiresAt: null } };
  }, { behavior: 'immediate' });

  return result;
}

// ─── finalizeBooking ──────────────────────────────────────────────────────────
// Phase 4: atomically sets status=confirmed + externalEventRef after calendar write.
// Replaces the Phase 3 confirmHold for flows that include calendar writes.
// confirmHold remains for contexts without calendar writes.

export type FinalizeResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; reason: ConfirmError };

export function finalizeBooking(
  db: DB,
  holdId: string,
  pageId: string,
  externalRef: string | null,
  now: Date,
): FinalizeResult {
  return db.transaction((tx): FinalizeResult => {
    const hold = tx.select().from(bookingTable)
      .where(eq(bookingTable.id, holdId)).get();

    if (!hold) return { ok: false, reason: 'NOT_FOUND' };
    if (hold.bookingPageId !== pageId) return { ok: false, reason: 'WRONG_PAGE' };
    if (hold.status === 'confirmed') return { ok: false, reason: 'ALREADY_CONFIRMED' };
    if (hold.status !== 'pending_hold') return { ok: false, reason: 'NOT_FOUND' };
    if (hold.expiresAt && hold.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };

    tx.update(bookingTable)
      .set({ status: 'confirmed', expiresAt: null, externalEventRef: externalRef })
      .where(eq(bookingTable.id, holdId)).run();

    return {
      ok: true,
      booking: { ...hold, status: 'confirmed' as const, expiresAt: null, externalEventRef: externalRef },
    };
  }, { behavior: 'immediate' });
}

// ─── setEmailFailed ───────────────────────────────────────────────────────────

export function setEmailFailed(db: DB, bookingId: string): void {
  db.update(bookingTable)
    .set({ emailFailed: true })
    .where(eq(bookingTable.id, bookingId))
    .run();
}

// ─── cancelBooking ────────────────────────────────────────────────────────────
// Returns the full booking row (with incremented sequence) for Phase 4 to use
// in calling cancelEvent and sending CANCEL email.

export type CancelResult =
  | { ok: true; booking: BookingRow }
  | { ok: false; reason: CancelError };

export function cancelBooking(db: DB, cancelToken: string): CancelResult {
  const hold = db.select().from(bookingTable)
    .where(and(
      eq(bookingTable.cancelToken, cancelToken),
      or(eq(bookingTable.status, 'confirmed'), eq(bookingTable.status, 'pending_hold')),
    ))
    .get();

  if (!hold) return { ok: false, reason: 'NOT_FOUND' };

  const newSequence = (hold.sequence ?? 0) + 1;

  db.update(bookingTable)
    .set({ status: 'cancelled', expiresAt: null, sequence: newSequence })
    .where(eq(bookingTable.id, hold.id))
    .run();

  return {
    ok: true,
    booking: { ...hold, status: 'cancelled' as const, expiresAt: null, sequence: newSequence },
  };
}
