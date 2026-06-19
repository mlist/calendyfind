import { describe, it, expect } from 'vitest';
import { sliceFreeIntoSlots, computeFreeSlots } from '../../lib/availability/slots';
import type { BusyInterval, FreeInterval } from '../../lib/availability/types';

function iv(startIso: string, endIso: string): BusyInterval {
  return { start: new Date(startIso), end: new Date(endIso) };
}

const NOW = new Date('2024-01-15T07:00:00Z');

// ─── Test 10: event partially outside working hours ───────────────────────────
describe('sliceFreeIntoSlots', () => {
  it('yields slots only within free windows', () => {
    // Free 08:00-18:00, busy 10:00-11:00 → free: 08:00-10:00 and 11:00-18:00
    const free: FreeInterval[] = [iv('2024-01-15T08:00Z', '2024-01-15T10:00Z'), iv('2024-01-15T11:00Z', '2024-01-15T18:00Z')];
    const slots = sliceFreeIntoSlots(free, { durationMin: 60, now: NOW, minNoticeMin: 0 });
    // 08:00-09:00, 09:00-10:00, 11:00-12:00, ..., 17:00-18:00
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const inFirstWindow  = slot.start >= new Date('2024-01-15T08:00Z') && slot.end <= new Date('2024-01-15T10:00Z');
      const inSecondWindow = slot.start >= new Date('2024-01-15T11:00Z') && slot.end <= new Date('2024-01-15T18:00Z');
      expect(inFirstWindow || inSecondWindow).toBe(true);
    }
  });

  it('respects minNoticeMin', () => {
    // now = 07:00 UTC, minNotice = 120 min → earliest slot start = 09:00 UTC
    const free: FreeInterval[] = [iv('2024-01-15T07:00Z', '2024-01-15T18:00Z')];
    const slots = sliceFreeIntoSlots(free, { durationMin: 60, now: NOW, minNoticeMin: 120 });
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(new Date('2024-01-15T09:00:00Z').getTime());
    }
  });

  it('returns no slots when free window is shorter than duration', () => {
    const free: FreeInterval[] = [iv('2024-01-15T10:00Z', '2024-01-15T10:30Z')];
    expect(sliceFreeIntoSlots(free, { durationMin: 60, now: NOW, minNoticeMin: 0 })).toHaveLength(0);
  });
});

// ─── Test 14: buffer padding ──────────────────────────────────────────────────
describe('computeFreeSlots — buffer', () => {
  it('pads busy intervals so nearby slots are excluded', () => {
    // Working 08:00-18:00; busy 10:00-11:00; buffer 15 min
    // → effective busy 09:45-11:15, free: 08:00-09:45 and 11:15-18:00
    const workingWindows: FreeInterval[][] = [[iv('2024-01-15T08:00Z', '2024-01-15T18:00Z')]];
    const usersBusy: BusyInterval[][] = [[iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')]];
    const slots = computeFreeSlots({
      usersBusy,
      usersWorkingWindows: workingWindows,
      existingBookings: [],
      durationMin: 60,
      bufferMin: 15,
      minNoticeMin: 0,
      now: NOW,
    });
    for (const slot of slots) {
      // No slot should start inside 09:45-11:15 or end inside that window
      expect(slot.start.getTime() >= new Date('2024-01-15T11:15:00Z').getTime() ||
             slot.end.getTime() <= new Date('2024-01-15T09:45:00Z').getTime()).toBe(true);
    }
  });

  it('with bufferMin=0 slot can start immediately after busy interval', () => {
    const workingWindows: FreeInterval[][] = [[iv('2024-01-15T08:00Z', '2024-01-15T18:00Z')]];
    const usersBusy: BusyInterval[][] = [[iv('2024-01-15T10:00Z', '2024-01-15T11:00Z')]];
    const slots = computeFreeSlots({
      usersBusy,
      usersWorkingWindows: workingWindows,
      existingBookings: [],
      durationMin: 60,
      bufferMin: 0,
      minNoticeMin: 0,
      now: NOW,
    });
    expect(slots.some(s => s.start.toISOString() === '2024-01-15T11:00:00.000Z')).toBe(true);
  });
});
