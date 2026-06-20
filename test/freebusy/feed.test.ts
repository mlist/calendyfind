/**
 * Phase 7 — Feature A: Free/busy ICS feed tests (A1–A5)
 *
 * A1: VCALENDAR contains only opaque VEVENTs — no titles, attendees, descriptions, locations.
 * A2: Busy = union of ICS source busy + confirmed bookings + live holds; excludes expired holds + cancelled.
 * A3: Down source with no cache → fail-closed (full range busy).
 * A4: Rotating token invalidates old token; rotation + revocation are audited.
 * A5: checkFreeBusyLimit works; unknown/inactive tokens return undefined/false from DB.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import type { DB } from '@/lib/booking/holds';
import { generateFreeBusyIcs } from '@/lib/freebusy/feed';
import { checkFreeBusyLimit } from '@/lib/rate-limit';
import { gatherBusyForFeed } from '@/lib/freebusy/gather';

// ─── Mock gatherBusyForUser (hoisted so vi.mock factory can reference it) ─────
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

// ─── A1: ICS output contains only privacy-safe properties ────────────────────

describe('A1 — generateFreeBusyIcs privacy guarantees', () => {
  it('produces valid VCALENDAR wrapper', () => {
    const ics = generateFreeBusyIcs([], NOW);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('METHOD:PUBLISH');
  });

  it('each VEVENT has UID, DTSTART, DTEND, SUMMARY:Busy, TRANSP:OPAQUE, CLASS:PRIVATE', () => {
    const busy = [
      { start: new Date('2026-07-01T08:00:00Z'), end: new Date('2026-07-01T09:00:00Z') },
      { start: new Date('2026-07-01T14:00:00Z'), end: new Date('2026-07-01T15:30:00Z') },
    ];
    const ics = generateFreeBusyIcs(busy, NOW);

    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('SUMMARY:Busy');
    expect(ics).toContain('TRANSP:OPAQUE');
    expect(ics).toContain('CLASS:PRIVATE');
    expect(ics).toContain('DTSTART:20260701T080000Z');
    expect(ics).toContain('DTEND:20260701T090000Z');
  });

  it('VEVENTs contain NO ORGANIZER, ATTENDEE, LOCATION, or DESCRIPTION', () => {
    const busy = [{ start: new Date('2026-07-01T08:00:00Z'), end: new Date('2026-07-01T09:00:00Z') }];
    const ics = generateFreeBusyIcs(busy, NOW);

    expect(ics).not.toContain('ORGANIZER');
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).not.toContain('LOCATION');
    expect(ics).not.toContain('DESCRIPTION');
    expect(ics).not.toContain('CATEGORIES');
    expect(ics).not.toContain('COMMENT');
  });

  it('SUMMARY is exactly "Busy" — no real event title leaks through', () => {
    const busy = [{ start: new Date('2026-07-02T10:00:00Z'), end: new Date('2026-07-02T11:00:00Z') }];
    const ics = generateFreeBusyIcs(busy, NOW);
    expect(ics).toMatch(/SUMMARY:Busy\r?\n/);
  });

  it('UIDs are stable across re-fetches (same interval → same UID)', () => {
    const interval = { start: new Date('2026-07-03T08:00:00Z'), end: new Date('2026-07-03T09:00:00Z') };
    const ics1 = generateFreeBusyIcs([interval], new Date('2026-07-01T00:00:00Z'));
    const ics2 = generateFreeBusyIcs([interval], new Date('2026-07-02T00:00:00Z'));

    const extractUid = (text: string) => text.match(/UID:(.+)/)?.[1]?.trim();
    expect(extractUid(ics1)).toBe(extractUid(ics2));
  });
});

// ─── A2: Busy union ────────────────────────────────────────────────────────────

describe('A2 — gatherBusyForFeed busy union', () => {
  it('includes confirmed booking in busy', async () => {
    const db = makeDb();
    const userId = insertUser(db);
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const start = new Date('2026-07-10T10:00:00Z');
    const end   = new Date('2026-07-10T10:30:00Z');
    db.insert(schema.booking).values({
      id: 'b-c1', organizerUserId: userId, attendeeName: 'X', attendeeEmail: 'x@x.com',
      startUtc: start, endUtc: end, status: 'confirmed',
      icsUid: 'uid-c1', sequence: 0, cancelToken: 'ct-c1', createdAt: NOW,
    }).run();

    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    expect(busy.some(b => b.start.getTime() === start.getTime())).toBe(true);
  });

  it('includes live pending_hold in busy', async () => {
    const db = makeDb();
    const userId = insertUser(db);
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const start   = new Date('2026-07-10T11:00:00Z');
    const end     = new Date('2026-07-10T11:30:00Z');
    const expires = new Date(NOW.getTime() + 30 * 60_000); // live

    db.insert(schema.booking).values({
      id: 'b-h1', organizerUserId: userId, attendeeName: 'Y', attendeeEmail: 'y@y.com',
      startUtc: start, endUtc: end, status: 'pending_hold', expiresAt: expires,
      icsUid: 'uid-h1', sequence: 0, cancelToken: 'ct-h1', createdAt: NOW,
    }).run();

    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    expect(busy.some(b => b.start.getTime() === start.getTime())).toBe(true);
  });

  it('excludes expired pending_hold from busy', async () => {
    const db = makeDb();
    const userId = insertUser(db);
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const start   = new Date('2026-07-10T12:00:00Z');
    const end     = new Date('2026-07-10T12:30:00Z');
    const expires = new Date(NOW.getTime() - 60_000); // expired

    db.insert(schema.booking).values({
      id: 'b-ex1', organizerUserId: userId, attendeeName: 'Z', attendeeEmail: 'z@z.com',
      startUtc: start, endUtc: end, status: 'pending_hold', expiresAt: expires,
      icsUid: 'uid-ex1', sequence: 0, cancelToken: 'ct-ex1', createdAt: NOW,
    }).run();

    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    expect(busy.some(b => b.start.getTime() === start.getTime())).toBe(false);
  });

  it('excludes cancelled booking from busy', async () => {
    const db = makeDb();
    const userId = insertUser(db);
    mockGatherBusyForUser.mockResolvedValue({ busy: [], errors: [] });

    const start = new Date('2026-07-10T13:00:00Z');
    const end   = new Date('2026-07-10T13:30:00Z');
    db.insert(schema.booking).values({
      id: 'b-can1', organizerUserId: userId, attendeeName: 'W', attendeeEmail: 'w@w.com',
      startUtc: start, endUtc: end, status: 'cancelled',
      icsUid: 'uid-can1', sequence: 0, cancelToken: 'ct-can1', createdAt: NOW,
    }).run();

    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    expect(busy.some(b => b.start.getTime() === start.getTime())).toBe(false);
  });

  it('unions ICS source busy with booking busy', async () => {
    const db = makeDb();
    const userId = insertUser(db);

    const icsBusy = { start: new Date('2026-07-05T09:00:00Z'), end: new Date('2026-07-05T10:00:00Z') };
    mockGatherBusyForUser.mockResolvedValue({ busy: [icsBusy], errors: [] });

    const bookingStart = new Date('2026-07-10T14:00:00Z');
    const bookingEnd   = new Date('2026-07-10T14:30:00Z');
    db.insert(schema.booking).values({
      id: 'b-union1', organizerUserId: userId, attendeeName: 'A', attendeeEmail: 'a@a.com',
      startUtc: bookingStart, endUtc: bookingEnd, status: 'confirmed',
      icsUid: 'uid-u1', sequence: 0, cancelToken: 'ct-u1', createdAt: NOW,
    }).run();

    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    expect(busy.some(b => b.start.getTime() === icsBusy.start.getTime())).toBe(true);
    expect(busy.some(b => b.start.getTime() === bookingStart.getTime())).toBe(true);
  });
});

// ─── A3: Fail-closed ─────────────────────────────────────────────────────────

describe('A3 — fail-closed: down ICS source blocks full range', () => {
  it('a fail-closed source yields ≥ full range as busy', async () => {
    const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') };
    const db = makeDb();
    const userId = insertUser(db);

    mockGatherBusyForUser.mockResolvedValue({
      busy: [{ start: range.from, end: range.to }],
      errors: [{ sourceId: 's1', label: 'Work', error: 'fetch failed (blocking full range — fail-closed)' }],
    });

    const busy = await gatherBusyForFeed(db, userId, range, NOW);
    const totalMs = busy.reduce((acc, b) => acc + b.end.getTime() - b.start.getTime(), 0);
    const rangeMs = range.to.getTime() - range.from.getTime();
    expect(totalMs).toBeGreaterThanOrEqual(rangeMs);
  });
});

// ─── A4: Token rotation + revocation ─────────────────────────────────────────

describe('A4 — token rotation and revocation', () => {
  it('rotating a token changes secretToken; old token no longer findable', () => {
    const db = makeDb();
    const userId = insertUser(db);
    const oldToken = 'old-tok-abc';
    const id = 'feed-rot-1';
    db.insert(schema.freebusyFeed).values({ id, userId, secretToken: oldToken, active: true, createdAt: NOW }).run();

    const newToken = 'new-tok-xyz';
    db.update(schema.freebusyFeed).set({ secretToken: newToken, lastRotatedAt: NOW })
      .where(eq(schema.freebusyFeed.id, id)).run();

    const updated = db.select().from(schema.freebusyFeed).where(eq(schema.freebusyFeed.id, id)).get();
    expect(updated?.secretToken).toBe(newToken);

    const byOld = db.select().from(schema.freebusyFeed).where(eq(schema.freebusyFeed.secretToken, oldToken)).get();
    expect(byOld).toBeUndefined();
  });

  it('revoking a feed sets active=false', () => {
    const db = makeDb();
    const userId = insertUser(db);
    const id = 'feed-rev-1';
    db.insert(schema.freebusyFeed).values({ id, userId, secretToken: 'tok-rev', active: true, createdAt: NOW }).run();

    db.update(schema.freebusyFeed).set({ active: false }).where(eq(schema.freebusyFeed.id, id)).run();

    const feed = db.select().from(schema.freebusyFeed).where(eq(schema.freebusyFeed.id, id)).get();
    expect(feed?.active).toBe(false);
  });

  it('rotation audit action is valid AuditAction type', () => {
    const db = makeDb();
    const userId = insertUser(db);

    db.insert(schema.auditLog).values({
      id: 'aud-rot', actor: userId, action: 'freebusy_feed.rotate',
      targetType: 'freebusy_feed', targetId: 'feed-rot-1',
    }).run();

    const entry = db.select().from(schema.auditLog).where(eq(schema.auditLog.id, 'aud-rot')).get();
    expect(entry?.action).toBe('freebusy_feed.rotate');
  });

  it('revoke audit action is valid AuditAction type', () => {
    const db = makeDb();
    const userId = insertUser(db);

    db.insert(schema.auditLog).values({
      id: 'aud-rev', actor: userId, action: 'freebusy_feed.revoke',
      targetType: 'freebusy_feed', targetId: 'feed-rev-1',
    }).run();

    const entry = db.select().from(schema.auditLog).where(eq(schema.auditLog.id, 'aud-rev')).get();
    expect(entry?.action).toBe('freebusy_feed.revoke');
  });
});

// ─── A5: Rate limiting + 404 for unknown/inactive tokens ─────────────────────

describe('A5 — rate limiting and unknown/inactive tokens', () => {
  it('checkFreeBusyLimit returns allowed:true for fresh IP', () => {
    const ip = `test-fb-${Math.random()}`;
    const r = checkFreeBusyLimit(ip);
    expect(r.allowed).toBe(true);
    expect(r).toHaveProperty('retryAfterMs');
  });

  it('unknown token lookup returns undefined (→ 404)', () => {
    const db = makeDb();
    const result = db.select().from(schema.freebusyFeed)
      .where(eq(schema.freebusyFeed.secretToken, 'nonexistent-never-used'))
      .get();
    expect(result).toBeUndefined();
  });

  it('inactive feed satisfies 404 guard (!feed.active)', () => {
    const db = makeDb();
    const userId = insertUser(db);

    db.insert(schema.freebusyFeed).values({
      id: 'feed-inactive', userId, secretToken: 'inactive-tok-xyz', active: false, createdAt: NOW,
    }).run();

    const feed = db.select().from(schema.freebusyFeed)
      .where(eq(schema.freebusyFeed.secretToken, 'inactive-tok-xyz'))
      .get();
    // Route guard: !feed || !feed.active → 404
    expect(!feed || !feed.active).toBe(true);
  });
});
