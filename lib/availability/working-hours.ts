import { DateTime } from 'luxon';
import type { FreeInterval, WorkingHoursConfig, Day } from './types';

// Luxon ISO weekday: 1=Mon ... 7=Sun
const LUXON_TO_DAY: Record<number, Day> = {
  1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun',
};

export function workingHoursToUTCWindows(
  workingHours: WorkingHoursConfig,
  timezone: string,
  range: { from: Date; to: Date },
): FreeInterval[] {
  const result: FreeInterval[] = [];
  let day = DateTime.fromJSDate(range.from, { zone: timezone }).startOf('day');
  const rangeEnd = DateTime.fromJSDate(range.to, { zone: timezone });

  while (day < rangeEnd) {
    const dayKey = LUXON_TO_DAY[day.weekday];
    const ranges = dayKey ? (workingHours[dayKey] ?? []) : [];

    for (const tr of ranges) {
      const [sh, sm] = tr.start.split(':').map(Number);
      const [eh, em] = tr.end.split(':').map(Number);
      const windowStart = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 }).toUTC().toJSDate();
      const windowEnd   = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 }).toUTC().toJSDate();
      if (windowEnd > windowStart) result.push({ start: windowStart, end: windowEnd });
    }

    day = day.plus({ days: 1 });
  }

  return result;
}
