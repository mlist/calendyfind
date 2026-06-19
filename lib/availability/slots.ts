import type { BusyInterval, FreeInterval, Slot, WorkingHoursConfig } from './types';
import { mergeIntervals, subtractIntervals, intersectIntervals, padIntervals } from './intervals';
import { workingHoursToUTCWindows } from './working-hours';

export function sliceFreeIntoSlots(
  freeIntervals: FreeInterval[],
  opts: { durationMin: number; granularityMin?: number; now: Date; minNoticeMin: number },
): Slot[] {
  const { durationMin, now, minNoticeMin } = opts;
  const granularityMin = opts.granularityMin ?? durationMin;
  const durationMs     = durationMin * 60_000;
  const granularityMs  = granularityMin * 60_000;
  const earliestMs     = now.getTime() + minNoticeMin * 60_000;

  const slots: Slot[] = [];

  for (const free of freeIntervals) {
    const freeStartMs = free.start.getTime();
    const freeEndMs   = free.end.getTime();

    // Step through the free window in granularity increments
    let slotStart = freeStartMs;
    while (slotStart + durationMs <= freeEndMs) {
      if (slotStart >= earliestMs) {
        slots.push({ start: new Date(slotStart), end: new Date(slotStart + durationMs) });
      }
      slotStart += granularityMs;
    }
  }

  return slots;
}

export function computeFreeSlots(opts: {
  usersBusy: BusyInterval[][];
  usersWorkingWindows: FreeInterval[][];
  existingBookings: BusyInterval[];
  durationMin: number;
  bufferMin: number;
  minNoticeMin: number;
  now: Date;
  granularityMin?: number;
}): Slot[] {
  const { usersBusy, usersWorkingWindows, existingBookings, durationMin, bufferMin, minNoticeMin, now, granularityMin } = opts;

  if (usersWorkingWindows.length === 0) return [];

  // Intersect working windows across all users
  let windows = usersWorkingWindows[0];
  for (let i = 1; i < usersWorkingWindows.length; i++) {
    windows = intersectIntervals(windows, usersWorkingWindows[i]);
  }

  // Merge all busy intervals (all users + existing bookings)
  const allBusy = mergeIntervals([...usersBusy.flat(), ...existingBookings]);

  // Pad busy by bufferMin on both sides, then subtract from working windows
  const paddedBusy  = padIntervals(allBusy, bufferMin);
  const freeWindows = subtractIntervals(windows, paddedBusy);

  return sliceFreeIntoSlots(freeWindows, { durationMin, now, minNoticeMin, granularityMin });
}

export function computeFreeSlotsForUsers(opts: {
  userIds: string[];
  workingHoursPerUser: Map<string, WorkingHoursConfig>;
  timezonesPerUser: Map<string, string>;
  busyPerUser: Map<string, BusyInterval[]>;
  existingBookings: BusyInterval[];
  range: { from: Date; to: Date };
  durationMin: number;
  bufferMin: number;
  minNoticeMin: number;
  now: Date;
  granularityMin?: number;
}): Slot[] {
  const { userIds, workingHoursPerUser, timezonesPerUser, busyPerUser, existingBookings, range, durationMin, bufferMin, minNoticeMin, now, granularityMin } = opts;

  const usersBusy: BusyInterval[][] = [];
  const usersWorkingWindows: FreeInterval[][] = [];

  for (const uid of userIds) {
    usersBusy.push(busyPerUser.get(uid) ?? []);
    const tz = timezonesPerUser.get(uid) ?? 'UTC';
    const wh = workingHoursPerUser.get(uid) ?? {};
    usersWorkingWindows.push(workingHoursToUTCWindows(wh, tz, range));
  }

  return computeFreeSlots({ usersBusy, usersWorkingWindows, existingBookings, durationMin, bufferMin, minNoticeMin, now, granularityMin });
}
