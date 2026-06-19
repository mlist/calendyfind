import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { inArray } from 'drizzle-orm';
import { getBookingsBusy } from '@/lib/booking/holds';
import type { BusyInterval, FreeInterval, Slot, WorkingHoursConfig } from './types';
import { gatherBusyForUser } from './cache';
import { workingHoursToUTCWindows } from './working-hours';
import { computeFreeSlots } from './slots';

export type { BusyInterval, FreeInterval, Slot, WorkingHoursConfig };
export { parseIcsToBusyIntervals } from './ics-parser';
export { mergeIntervals, subtractIntervals, intersectIntervals, padIntervals } from './intervals';
export { workingHoursToUTCWindows } from './working-hours';
export { computeFreeSlots, sliceFreeIntoSlots } from './slots';

export interface GetFreeSlotsOpts {
  userIds: string[];
  range: { from: Date; to: Date };
  durationMin: number;
  bufferMin: number;
  minNoticeMin: number;
  now: Date;
  granularityMin?: number;
}

export interface GetFreeSlotsResult {
  slots: Slot[];
  errors: { userId: string; sourceId: string; label: string; error: string }[];
}

export async function getFreeSlots(opts: GetFreeSlotsOpts): Promise<GetFreeSlotsResult> {
  const { userIds, range, durationMin, bufferMin, minNoticeMin, now, granularityMin } = opts;

  const users = await db
    .select({ id: userTable.id, timezone: userTable.timezone, workingHours: userTable.workingHours })
    .from(userTable)
    .where(inArray(userTable.id, userIds));

  const allErrors: { userId: string; sourceId: string; label: string; error: string }[] = [];
  const usersBusy: BusyInterval[][] = [];
  const usersWorkingWindows: FreeInterval[][] = [];

  for (const userId of userIds) {
    const profile = users.find(u => u.id === userId);

    if (!profile) {
      usersBusy.push([{ start: range.from, end: range.to }]);
      usersWorkingWindows.push([]);
      allErrors.push({ userId, sourceId: '', label: 'unknown user', error: 'User not found' });
      continue;
    }

    const timezone = profile.timezone ?? 'UTC';
    let workingHours: WorkingHoursConfig = {};
    try { workingHours = JSON.parse(profile.workingHours ?? '{}'); } catch { /* empty → no slots */ }

    const { busy, errors } = await gatherBusyForUser(userId, range, now, timezone);
    const dbBusy = getBookingsBusy(db, userId, range, now);
    usersBusy.push([...busy, ...dbBusy]);
    allErrors.push(...errors.map(e => ({ userId, ...e })));

    usersWorkingWindows.push(workingHoursToUTCWindows(workingHours, timezone, range));
  }

  const existingBookings: BusyInterval[] = [];

  const slots = computeFreeSlots({ usersBusy, usersWorkingWindows, existingBookings, durationMin, bufferMin, minNoticeMin, now, granularityMin });

  return { slots, errors: allErrors };
}
