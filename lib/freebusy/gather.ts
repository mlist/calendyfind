import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/lib/db/schema';
import { user as userTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { BusyInterval } from '@/lib/availability/types';
import { gatherBusyForUser } from '@/lib/availability/cache';
import { getBookingsBusy } from '@/lib/booking/holds';
import { mergeIntervals } from '@/lib/availability/intervals';

type DB = BetterSQLite3Database<typeof schema>;

/**
 * Returns the merged union of ALL busy time for `userId` within `range`:
 *   ICS sources (fail-closed) + confirmed bookings + live pending_holds.
 *
 * Working hours are NOT subtracted — this is raw busy, for the free/busy feed.
 * Expired holds and cancelled bookings are excluded automatically via getBookingsBusy.
 */
export async function gatherBusyForFeed(
  db: DB,
  userId: string,
  range: { from: Date; to: Date },
  now: Date,
): Promise<BusyInterval[]> {
  const userRow = db.select({ timezone: userTable.timezone })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get();
  const tz = userRow?.timezone ?? 'UTC';

  const { busy: icsBusy } = await gatherBusyForUser(userId, range, now, tz);
  const bookingBusy = getBookingsBusy(db, userId, range, now);

  return mergeIntervals([...icsBusy, ...bookingBusy]);
}
