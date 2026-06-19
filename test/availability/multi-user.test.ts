import { describe, it, expect } from 'vitest';
import { computeFreeSlots } from '../../lib/availability/slots';
import { workingHoursToUTCWindows } from '../../lib/availability/working-hours';
import { parseIcsToBusyIntervals } from '../../lib/availability/ics-parser';
import type { BusyInterval, FreeInterval, WorkingHoursConfig } from '../../lib/availability/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf-8');

function iv(startIso: string, endIso: string): BusyInterval {
  return { start: new Date(startIso), end: new Date(endIso) };
}

const RANGE = { from: new Date('2024-01-15T00:00:00Z'), to: new Date('2024-01-16T00:00:00Z') };
const NOW   = new Date('2024-01-15T07:00:00Z');

const WORKING_HOURS: WorkingHoursConfig = {
  mon: [{ start: '08:00', end: '18:00' }],
  tue: [{ start: '08:00', end: '18:00' }],
  wed: [{ start: '08:00', end: '18:00' }],
  thu: [{ start: '08:00', end: '18:00' }],
  fri: [{ start: '08:00', end: '18:00' }],
};

// ─── Test 13: multi-user intersection ─────────────────────────────────────────
describe('multi-user intersection', () => {
  it('only offers slots free for ALL users', () => {
    // User A is busy 10:00-11:00; User B is busy 14:00-15:00
    // Shared free: 08:00-10:00, 11:00-14:00, 15:00-18:00 (on Jan 15 = Monday)
    const user1Busy: BusyInterval[] = [iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')];
    const user2Busy: BusyInterval[] = [iv('2024-01-15T14:00Z', '2024-01-15T15:00Z')];

    const windows1 = workingHoursToUTCWindows(WORKING_HOURS, 'UTC', RANGE);
    const windows2 = workingHoursToUTCWindows(WORKING_HOURS, 'UTC', RANGE);

    const slots = computeFreeSlots({
      usersBusy: [user1Busy, user2Busy],
      usersWorkingWindows: [windows1, windows2],
      existingBookings: [],
      durationMin: 60,
      bufferMin: 0,
      minNoticeMin: 0,
      now: NOW,
    });

    // No slot should overlap user1 busy OR user2 busy
    for (const slot of slots) {
      const overlapsUser1 = slot.start < new Date('2024-01-15T11:00Z') && slot.end > new Date('2024-01-15T10:00Z');
      const overlapsUser2 = slot.start < new Date('2024-01-15T15:00Z') && slot.end > new Date('2024-01-15T14:00Z');
      expect(overlapsUser1 || overlapsUser2).toBe(false);
    }
    expect(slots.length).toBeGreaterThan(0);
  });

  it('returns empty when one user has no working hours', () => {
    const windows1 = workingHoursToUTCWindows(WORKING_HOURS, 'UTC', RANGE);
    const windows2 = workingHoursToUTCWindows({}, 'UTC', RANGE); // no working hours
    const slots = computeFreeSlots({
      usersBusy: [[], []],
      usersWorkingWindows: [windows1, windows2],
      existingBookings: [],
      durationMin: 60,
      bufferMin: 0,
      minNoticeMin: 0,
      now: NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it('uses real ICS fixtures for user busy intervals', () => {
    // User A busy from simple-event.ics (Jan 15 10:00-11:00 UTC)
    const user1Busy = parseIcsToBusyIntervals(FIXTURE('simple-event.ics'), RANGE, 'UTC');
    // User B has no events
    const user2Busy: BusyInterval[] = [];

    const windows = workingHoursToUTCWindows(WORKING_HOURS, 'UTC', RANGE);
    const slots = computeFreeSlots({
      usersBusy: [user1Busy, user2Busy],
      usersWorkingWindows: [windows, windows],
      existingBookings: [],
      durationMin: 60,
      bufferMin: 0,
      minNoticeMin: 0,
      now: NOW,
    });

    // No slot should overlap 10:00-11:00
    for (const slot of slots) {
      expect(!(slot.start < new Date('2024-01-15T11:00Z') && slot.end > new Date('2024-01-15T10:00Z'))).toBe(true);
    }
  });
});
