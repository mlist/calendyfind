/**
 * Phase 7 — Feature B: Slot checker tests (B1–B4)
 *
 * B1: Slot format parses to correct UTC, including DST boundaries.
 * B2: Each line is echoed with interpreted start/end/tz; unparseable lines flagged, never guessed.
 * B3: classifyIntervals labels free/busy/partial correctly.
 * B4: Multi-user: a slot busy for one attendee is busy for the group.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/db/schema';
import type { DB } from '@/lib/booking/holds';
import { parseSlotLine, parseSlotLines } from '@/lib/freebusy/parse-slots';
import { classifyIntervals, classifyForUsers } from '@/lib/freebusy/classify';

// Mock gatherBusyForUser so classifyForUsers doesn't make real HTTP requests.
const mockGatherBusyForUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ busy: [], errors: [] }),
);
vi.mock('@/lib/availability/cache', () => ({
  gatherBusyForUser: mockGatherBusyForUser,
}));

const TEST_KEY = 'b'.repeat(64);
beforeAll(() => { process.env.ENCRYPTION_KEY = TEST_KEY; });

function makeDb(): DB {
  const raw = new Database(':memory:');
  raw.pragma('busy_timeout = 3000');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

const NOW = new Date('2026-07-01T12:00:00Z');

function insertUser(db: DB) {
  const id = `u-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.user).values({
    id, name: 'Test', email: `t-${id}@example.com`,
    emailVerified: false, timezone: 'UTC', createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

// ─── B1: Slot format parsing correctness ─────────────────────────────────────

describe('B1 — parseSlotLine UTC conversion', () => {
  it('parses basic slot in UTC', () => {
    const r = parseSlotLine('2026-07-15 10:00-10:30', 'UTC');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    expect(r.start.toISOString()).toBe('2026-07-15T10:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-07-15T10:30:00.000Z');
  });

  it('parses slot in Europe/Berlin (summer, UTC+2)', () => {
    const r = parseSlotLine('2026-07-15 14:00-15:00', 'Europe/Berlin');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    // CEST = UTC+2 → 14:00 CEST = 12:00 UTC
    expect(r.start.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('parses slot in Europe/Berlin (winter, UTC+1)', () => {
    const r = parseSlotLine('2026-01-15 09:00-09:30', 'Europe/Berlin');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    // CET = UTC+1 → 09:00 CET = 08:00 UTC
    expect(r.start.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-01-15T08:30:00.000Z');
  });

  it('parses slot in America/New_York (summer, UTC-4)', () => {
    const r = parseSlotLine('2026-07-13 10:00-10:30', 'America/New_York');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    // EDT = UTC-4 → 10:00 EDT = 14:00 UTC
    expect(r.start.toISOString()).toBe('2026-07-13T14:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-07-13T14:30:00.000Z');
  });

  it('handles DST spring-forward boundary in America/New_York (2026-03-08)', () => {
    // America/New_York springs forward at 2:00 AM → 3:00 AM on 2026-03-08
    // 01:00 EST (before jump) = 06:00 UTC
    const r = parseSlotLine('2026-03-08 01:00-01:30', 'America/New_York');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    expect(r.start.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-03-08T06:30:00.000Z');
  });

  it('handles midnight wrap when end time < start time', () => {
    const r = parseSlotLine('2026-07-15 23:30-00:30', 'UTC');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    expect(r.start.toISOString()).toBe('2026-07-15T23:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-07-16T00:30:00.000Z');
  });

  it('tolerates en-dash separator', () => {
    const r = parseSlotLine('2026-07-15 10:00–10:30', 'UTC');
    expect(r.ok).toBe(true);
  });

  it('tolerates spaces around the separator', () => {
    const r = parseSlotLine('2026-07-15 10:00 - 10:30', 'UTC');
    expect(r.ok).toBe(true);
  });
});

// ─── B2: Echo + flag unparseable lines ───────────────────────────────────────

describe('B2 — parseSlotLines echoes interpretation and flags errors', () => {
  it('ok lines include interpretedAs with local ISO timestamps and timezone name', () => {
    const results = parseSlotLines('2026-07-15 10:00-10:30', 'Europe/Berlin');
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unexpected');
    // interpretedAs shows local time + offset, e.g. "2026-07-15T10:00:00+02:00 → ... (Europe/Berlin)"
    expect(r.interpretedAs).toContain('2026-07-15T10:00:00');
    expect(r.interpretedAs).toContain('Europe/Berlin');
    // The UTC conversion must be correct (verified by start/end on the result)
    expect(r.start.toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });

  it('unparseable line is flagged with ok:false and an error message', () => {
    const r = parseSlotLine('next Monday at 3pm', 'UTC');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unexpected');
    expect(r.error).toBeTruthy();
    expect(r.raw).toBe('next Monday at 3pm');
  });

  it('unparseable line is NEVER silently assigned a guessed value', () => {
    const r = parseSlotLine('July 15 10am', 'UTC');
    expect(r.ok).toBe(false);
    // The discriminated union ensures ok:false has no start/end — verified by TS at compile time.
    // Runtime: only error and raw fields are present.
    if (!r.ok) {
      expect(r.error).toBeTruthy();
      expect(r.raw).toBe('July 15 10am');
    }
  });

  it('mixes ok and error lines in the same batch', () => {
    const text = [
      '2026-07-15 10:00-10:30',
      'this is garbage',
      '2026-07-16 14:00-15:00',
    ].join('\n');

    const results = parseSlotLines(text, 'UTC');
    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
  });

  it('blank lines are dropped silently', () => {
    const text = '2026-07-15 10:00-10:30\n\n\n2026-07-16 14:00-15:00\n';
    const results = parseSlotLines(text, 'UTC');
    expect(results).toHaveLength(2);
  });
});

// ─── B3: classifyIntervals ────────────────────────────────────────────────────

describe('B3 — classifyIntervals', () => {
  it('candidate with no overlap is free', () => {
    const busy = [{ start: new Date('2026-07-10T14:00:00Z'), end: new Date('2026-07-10T15:00:00Z') }];
    const [r] = classifyIntervals(busy, [
      { start: new Date('2026-07-10T10:00:00Z'), end: new Date('2026-07-10T11:00:00Z') },
    ]);
    expect(r.status).toBe('free');
    expect(r.overlapMs).toBe(0);
  });

  it('candidate fully covered by busy is "busy"', () => {
    const busy = [{ start: new Date('2026-07-10T09:00:00Z'), end: new Date('2026-07-10T12:00:00Z') }];
    const [r] = classifyIntervals(busy, [
      { start: new Date('2026-07-10T10:00:00Z'), end: new Date('2026-07-10T11:00:00Z') },
    ]);
    expect(r.status).toBe('busy');
  });

  it('candidate partially overlapping is "partial"', () => {
    const busy = [{ start: new Date('2026-07-10T10:30:00Z'), end: new Date('2026-07-10T12:00:00Z') }];
    const [r] = classifyIntervals(busy, [
      { start: new Date('2026-07-10T10:00:00Z'), end: new Date('2026-07-10T11:00:00Z') },
    ]);
    expect(r.status).toBe('partial');
    expect(r.overlapMs).toBe(30 * 60_000); // 30 min overlap
  });

  it('handles multiple busy intervals correctly', () => {
    const busy = [
      { start: new Date('2026-07-10T09:00:00Z'), end: new Date('2026-07-10T09:30:00Z') },
      { start: new Date('2026-07-10T10:30:00Z'), end: new Date('2026-07-10T11:00:00Z') },
    ];
    const candidates = [
      // Free — no overlap
      { start: new Date('2026-07-10T11:00:00Z'), end: new Date('2026-07-10T11:30:00Z') },
      // Busy — fully inside busy[0]
      { start: new Date('2026-07-10T09:05:00Z'), end: new Date('2026-07-10T09:25:00Z') },
      // Partial — overlaps busy[1]
      { start: new Date('2026-07-10T10:00:00Z'), end: new Date('2026-07-10T10:45:00Z') },
    ];
    const results = classifyIntervals(busy, candidates);
    expect(results[0].status).toBe('free');
    expect(results[1].status).toBe('busy');
    expect(results[2].status).toBe('partial');
  });

  it('empty busy list → all candidates are free', () => {
    const results = classifyIntervals([], [
      { start: new Date('2026-07-10T10:00:00Z'), end: new Date('2026-07-10T11:00:00Z') },
      { start: new Date('2026-07-10T14:00:00Z'), end: new Date('2026-07-10T15:00:00Z') },
    ]);
    expect(results.every(r => r.status === 'free')).toBe(true);
  });
});

// ─── B4: Multi-user classification ───────────────────────────────────────────

describe('B4 — classifyForUsers: slot busy for one attendee = busy for group', () => {
  it('slot free for all users → free', async () => {
    const db = makeDb();
    const u1 = insertUser(db);
    const u2 = insertUser(db);
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const candidate = { start: new Date('2026-07-15T10:00:00Z'), end: new Date('2026-07-15T10:30:00Z') };
    const range = { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-16T00:00:00Z') };

    const { results } = await classifyForUsers(db, [u1, u2], [candidate], range, NOW);
    expect(results[0].status).toBe('free');
  });

  it('slot busy for one user → busy for group', async () => {
    const db = makeDb();
    const u1 = insertUser(db);
    const u2 = insertUser(db);

    // u2 has a confirmed booking that overlaps the candidate
    const candidateStart = new Date('2026-07-15T10:00:00Z');
    const candidateEnd   = new Date('2026-07-15T10:30:00Z');

    db.insert(schema.booking).values({
      id: 'b-multi', organizerUserId: u2, attendeeName: 'X', attendeeEmail: 'x@x.com',
      startUtc: candidateStart, endUtc: candidateEnd, status: 'confirmed',
      icsUid: 'uid-multi', sequence: 0, cancelToken: 'ct-multi', createdAt: NOW,
    }).run();

    // gatherBusyForUser returns nothing (no ICS sources)
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const range = { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-16T00:00:00Z') };
    const { results } = await classifyForUsers(
      db, [u1, u2], [{ start: candidateStart, end: candidateEnd }], range, NOW,
    );
    expect(results[0].status).toBe('busy');
  });

  it('slot free for u1 but busy for u2 (via ICS source) → busy for group', async () => {
    const db = makeDb();
    const u1 = insertUser(db);
    const u2 = insertUser(db);

    const candidateStart = new Date('2026-07-15T14:00:00Z');
    const candidateEnd   = new Date('2026-07-15T15:00:00Z');

    // gatherBusyForUser returns busy for u2 (simulated ICS source), nothing for u1
    mockGatherBusyForUser.mockImplementation(async (userId: string) => {
      if (userId === u2) {
        return { busy: [{ start: candidateStart, end: candidateEnd }], errors: [] };
      }
      return { busy: [], errors: [] };
    });

    const range = { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-16T00:00:00Z') };
    const { results } = await classifyForUsers(
      db, [u1, u2], [{ start: candidateStart, end: candidateEnd }], range, NOW,
    );
    expect(results[0].status).toBe('busy');
  });
});
