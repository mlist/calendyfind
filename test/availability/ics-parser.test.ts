import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIcsToBusyIntervals } from '../../lib/availability/ics-parser';

const FIXTURE = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf-8');

const FULL_RANGE = {
  from: new Date('2024-01-01T00:00:00Z'),
  to:   new Date('2024-12-31T23:59:59Z'),
};

// ─── Test 1: simple single event ──────────────────────────────────────────────
describe('simple-event.ics', () => {
  it('produces one busy interval covering the event', () => {
    const busy = parseIcsToBusyIntervals(FIXTURE('simple-event.ics'), FULL_RANGE, 'UTC');
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-15T11:00:00.000Z');
  });
});

// ─── Test 2: weekly RRULE ─────────────────────────────────────────────────────
describe('weekly-rrule.ics', () => {
  it('expands weekly recurrence within the range', () => {
    const range = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-29T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('weekly-rrule.ics'), range, 'UTC');
    // Mondays Jan 1, 8, 15, 22
    expect(busy).toHaveLength(4);
    expect(busy[0].start.toISOString()).toBe('2024-01-01T09:00:00.000Z');
    expect(busy[1].start.toISOString()).toBe('2024-01-08T09:00:00.000Z');
    expect(busy[2].start.toISOString()).toBe('2024-01-15T09:00:00.000Z');
    expect(busy[3].start.toISOString()).toBe('2024-01-22T09:00:00.000Z');
  });
});

// ─── Test 3: RRULE + EXDATE ───────────────────────────────────────────────────
describe('rrule-exdate.ics', () => {
  it('skips the excluded occurrence (Jan 8)', () => {
    const range = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-29T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('rrule-exdate.ics'), range, 'UTC');
    // Mondays Jan 1, 15, 22 — Jan 8 excluded
    expect(busy).toHaveLength(3);
    const starts = busy.map(b => b.start.toISOString());
    expect(starts).not.toContain('2024-01-08T09:00:00.000Z');
    expect(starts).toContain('2024-01-01T09:00:00.000Z');
    expect(starts).toContain('2024-01-15T09:00:00.000Z');
    expect(starts).toContain('2024-01-22T09:00:00.000Z');
  });
});

// ─── Test 4: RECURRENCE-ID override ──────────────────────────────────────────
describe('rrule-recurrence-id.ics', () => {
  it('original Jan-8 09:00-11:00 is NOT busy; override 14:00-15:00 IS busy', () => {
    const range = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-29T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('rrule-recurrence-id.ics'), range, 'UTC');

    const jan8Starts = busy.map(b => b.start.toISOString());
    expect(jan8Starts).not.toContain('2024-01-08T09:00:00.000Z');
    expect(jan8Starts).toContain('2024-01-08T14:00:00.000Z');

    const override = busy.find(b => b.start.toISOString() === '2024-01-08T14:00:00.000Z')!;
    expect(override.end.toISOString()).toBe('2024-01-08T15:00:00.000Z');
  });
});

// ─── Test 5: all-day events ───────────────────────────────────────────────────
describe('allday-events.ics', () => {
  it('OPAQUE all-day blocks the full day in fallbackTz; TRANSPARENT does not block', () => {
    // fallbackTz = UTC: Jan 15 00:00 UTC → Jan 16 00:00 UTC
    const busy = parseIcsToBusyIntervals(FIXTURE('allday-events.ics'), FULL_RANGE, 'UTC');
    // Only the opaque event should appear
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('OPAQUE all-day shifts in non-UTC timezone (Europe/Berlin = UTC+1 in Jan)', () => {
    // Jan 15 in Berlin = Jan 14 23:00 UTC → Jan 15 23:00 UTC
    const busy = parseIcsToBusyIntervals(FIXTURE('allday-events.ics'), FULL_RANGE, 'Europe/Berlin');
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-14T23:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-15T23:00:00.000Z');
  });
});

// ─── Test 6: STATUS:CANCELLED ─────────────────────────────────────────────────
describe('cancelled-event.ics', () => {
  it('produces no busy intervals', () => {
    const busy = parseIcsToBusyIntervals(FIXTURE('cancelled-event.ics'), FULL_RANGE, 'UTC');
    expect(busy).toHaveLength(0);
  });
});

// ─── Test 7: DST timezone ─────────────────────────────────────────────────────
describe('dst-timezone.ics', () => {
  it('converts across DST boundary correctly (Berlin CEST→CET)', () => {
    const range = { from: new Date('2024-10-01T00:00:00Z'), to: new Date('2024-11-30T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('dst-timezone.ics'), range, 'Europe/Berlin');
    // COUNT=3: Oct 21 (CEST UTC+2), Oct 28 (CET UTC+1), Nov 4 (CET UTC+1)
    expect(busy).toHaveLength(3);
    expect(busy[0].start.toISOString()).toBe('2024-10-21T08:00:00.000Z'); // 10:00 CEST
    expect(busy[1].start.toISOString()).toBe('2024-10-28T09:00:00.000Z'); // 10:00 CET
    expect(busy[2].start.toISOString()).toBe('2024-11-04T09:00:00.000Z'); // 10:00 CET
  });
});

// ─── Test 8: multi-day range edge clipping ────────────────────────────────────
describe('multiday-range-edge.ics', () => {
  it('clips multi-day event to the queried range', () => {
    const range = { from: new Date('2024-01-14T00:00:00Z'), to: new Date('2024-01-16T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('multiday-range-edge.ics'), range, 'UTC');
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-14T00:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-16T00:00:00.000Z');
  });

  it('includes the event when range fully covers it', () => {
    const range = { from: new Date('2024-01-10T00:00:00Z'), to: new Date('2024-01-20T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('multiday-range-edge.ics'), range, 'UTC');
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-13T10:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-17T16:00:00.000Z');
  });
});

// ─── Test 9: overlapping events merged ───────────────────────────────────────
describe('overlapping-events.ics', () => {
  it('merges overlapping and adjacent events into one interval', () => {
    const range = { from: new Date('2024-01-15T00:00:00Z'), to: new Date('2024-01-16T00:00:00Z') };
    const busy = parseIcsToBusyIntervals(FIXTURE('overlapping-events.ics'), range, 'UTC');
    expect(busy).toHaveLength(1);
    expect(busy[0].start.toISOString()).toBe('2024-01-15T09:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-15T16:00:00.000Z');
  });
});

// ─── Test 11: floating time ───────────────────────────────────────────────────
describe('floating-time.ics', () => {
  it('interprets floating time in America/New_York (UTC-5 in January)', () => {
    const busy = parseIcsToBusyIntervals(FIXTURE('floating-time.ics'), FULL_RANGE, 'America/New_York');
    expect(busy).toHaveLength(1);
    // 10:00 New York (UTC-5) = 15:00 UTC
    expect(busy[0].start.toISOString()).toBe('2024-01-15T15:00:00.000Z');
    expect(busy[0].end.toISOString()).toBe('2024-01-15T16:00:00.000Z');
  });

  it('interprets floating time in UTC when fallbackTz is UTC', () => {
    const busy = parseIcsToBusyIntervals(FIXTURE('floating-time.ics'), FULL_RANGE, 'UTC');
    expect(busy[0].start.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });
});

// ─── Test 12: malformed ICS → throws ─────────────────────────────────────────
describe('malformed.ics', () => {
  it('throws on invalid ICS data', () => {
    expect(() =>
      parseIcsToBusyIntervals(FIXTURE('malformed.ics'), FULL_RANGE, 'UTC')
    ).toThrow();
  });
});
