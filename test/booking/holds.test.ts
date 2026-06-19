import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/db/schema';
import type { DB } from '@/lib/booking/holds';
import {
  createHold,
  confirmHold,
  cancelBooking,
  getBookingsBusy,
  getPageByToken,
  getBookingByCancelToken,
  getBookingById,
} from '@/lib/booking/holds';
import { generatePublishIcs } from '@/lib/ics';
import ICAL from 'ical.js';

// ─── in-memory DB helpers ─────────────────────────────────────────────────────

function makeDb(): DB {
  const raw = new Database(':memory:');
  raw.pragma('busy_timeout = 3000');
  raw.pragma('foreign_keys = ON');
  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

const T_EPOCH = new Date('2024-06-01T09:00:00Z');   // "now" reference in all tests
const T_PLUS_1H  = new Date(T_EPOCH.getTime() + 60 * 60_000);
const T_PLUS_90  = new Date(T_EPOCH.getTime() + 90 * 60_000);
const T_PLUS_2H  = new Date(T_EPOCH.getTime() + 2 * 60 * 60_000);

function insertUser(db: DB, overrides: Partial<typeof schema.user.$inferInsert> = {}) {
  const id = `user-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.user).values({
    id,
    name: 'Test User',
    email: `test-${id}@example.com`,
    emailVerified: false,
    timezone: 'UTC',
    createdAt: T_EPOCH,
    updatedAt: T_EPOCH,
    ...overrides,
  }).run();
  return id;
}

function insertPage(
  db: DB,
  userId: string,
  overrides: Partial<typeof schema.bookingPage.$inferInsert> = {},
) {
  const id = `page-${Math.random().toString(36).slice(2)}`;
  const secretToken = `tok-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.bookingPage).values({
    id,
    userId,
    secretToken,
    title: 'Test Page',
    durationMin: 30,
    bufferMin: 0,
    minNoticeMin: 0,
    maxAdvanceDays: 30,
    active: true,
    createdAt: T_EPOCH,
    ...overrides,
  }).run();
  return { id, secretToken };
}

function makeSlotSet(...starts: Date[]): Set<number> {
  return new Set(starts.map(d => d.getTime()));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getPageByToken', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('returns page for valid active token', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken);
    expect(page).not.toBeUndefined();
    expect(page!.userId).toBe(userId);
    expect(page!.active).toBe(true);
  });

  it('returns undefined for unknown token', () => {
    expect(getPageByToken(db, 'no-such-token')).toBeUndefined();
  });

  it('still returns page for inactive token (caller checks .active)', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId, { active: false });
    const page = getPageByToken(db, secretToken);
    expect(page).not.toBeUndefined();
    expect(page!.active).toBe(false);
  });
});

describe('createHold — slot validation', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('rejects INVALID_SLOT when start not in validSlotStartMs', () => {
    const userId = insertUser(db);
    const { id: pageId, secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const result = createHold(db, {
      page,
      validSlotStartMs: makeSlotSet(T_PLUS_2H),   // only 2h slot is valid
      slotStart: T_PLUS_1H,                         // caller sends 1h — not valid
      attendeeName: 'Alice',
      attendeeEmail: 'alice@example.com',
      now: T_EPOCH,
    });
    expect(result).toEqual({ ok: false, reason: 'INVALID_SLOT' });

    // Nothing inserted
    const bk = db.select().from(schema.booking).all();
    expect(bk).toHaveLength(0);
    void pageId;
  });

  it('succeeds when start is in validSlotStartMs', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const result = createHold(db, {
      page,
      validSlotStartMs: makeSlotSet(T_PLUS_1H),
      slotStart: T_PLUS_1H,
      attendeeName: 'Alice',
      attendeeEmail: 'alice@example.com',
      now: T_EPOCH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.holdId).toBeTruthy();
      expect(result.cancelToken).toBeTruthy();
      expect(result.icsUid).toMatch(/@calendyfind\.local$/);
    }
  });
});

describe('createHold — pending_hold blocks the slot', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('second hold on same slot returns SLOT_TAKEN', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;
    const valid = makeSlotSet(T_PLUS_1H);

    const r1 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(r1.ok).toBe(true);

    const r2 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Bob', attendeeEmail: 'bob@example.com', now: T_EPOCH,
    });
    expect(r2).toEqual({ ok: false, reason: 'SLOT_TAKEN' });
  });
});

describe('createHold — expired hold frees the slot', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('hold past expiresAt is not counted as busy', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;
    const valid = makeSlotSet(T_PLUS_1H);

    // Create hold at T_EPOCH with 1-min TTL — expires at T_EPOCH + 1min
    const r1 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T_EPOCH, holdTtlMin: 1,
    });
    expect(r1.ok).toBe(true);

    // 2 minutes later: the hold is expired — slot should be available again
    const nowLater = new Date(T_EPOCH.getTime() + 2 * 60_000);
    const r2 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Bob', attendeeEmail: 'bob@example.com',
      now: nowLater, holdTtlMin: 10,
    });
    expect(r2.ok).toBe(true);
  });
});

describe('confirmHold', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('confirms a valid hold and marks it confirmed', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const hr = createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;

    const cr = confirmHold(db, hr.holdId, page.id, T_EPOCH);
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.booking.status).toBe('confirmed');
    expect(cr.booking.expiresAt).toBeNull();
  });

  it('confirmed booking keeps slot busy for a new hold', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;
    const valid = makeSlotSet(T_PLUS_1H);

    const hr = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;
    const cr = confirmHold(db, hr.holdId, page.id, T_EPOCH);
    expect(cr.ok).toBe(true);

    // Even well after original TTL, confirmed booking stays busy
    const nowLater = new Date(T_EPOCH.getTime() + 60 * 60_000);
    const r2 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Bob', attendeeEmail: 'bob@example.com', now: nowLater,
    });
    expect(r2).toEqual({ ok: false, reason: 'SLOT_TAKEN' });
  });

  it('fails with EXPIRED if hold TTL has elapsed', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const hr = createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T_EPOCH, holdTtlMin: 1,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;

    // Try to confirm 2 minutes later — after the TTL
    const nowLater = new Date(T_EPOCH.getTime() + 2 * 60_000);
    const cr = confirmHold(db, hr.holdId, page.id, nowLater);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.reason).toBe('EXPIRED');

    // Expired hold must NOT become confirmed in DB
    const bk = getBookingById(db, hr.holdId);
    expect(bk?.status).toBe('pending_hold');
  });
});

describe('cross-page isolation', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('cannot confirm a hold through a different page', () => {
    const userId = insertUser(db);
    const { secretToken: tokenA } = insertPage(db, userId);
    const { id: idB } = insertPage(db, userId);
    const pageA = getPageByToken(db, tokenA)!;

    const hr = createHold(db, {
      page: pageA, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;

    // Attempt confirmation with pageB's id
    const cr = confirmHold(db, hr.holdId, idB, T_EPOCH);
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.reason).toBe('WRONG_PAGE');
  });
});

describe('cancelBooking', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('cancels a confirmed booking and frees the slot', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;
    const valid = makeSlotSet(T_PLUS_1H);

    const hr = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;
    confirmHold(db, hr.holdId, page.id, T_EPOCH);

    const bk = getBookingById(db, hr.holdId)!;
    const cancel = cancelBooking(db, bk.cancelToken);
    expect(cancel.ok).toBe(true);

    // Slot is free — new hold should succeed
    const r2 = createHold(db, {
      page, validSlotStartMs: valid, slotStart: T_PLUS_1H,
      attendeeName: 'Bob', attendeeEmail: 'bob@example.com', now: T_EPOCH,
    });
    expect(r2.ok).toBe(true);
  });

  it('does nothing (NOT_FOUND) for an unknown cancel token', () => {
    const result = cancelBooking(db, 'no-such-token-aaa');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
  });
});

describe('getBookingsBusy', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('includes confirmed bookings', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const hr = createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;
    confirmHold(db, hr.holdId, page.id, T_EPOCH);

    const busy = getBookingsBusy(db, userId, { from: T_EPOCH, to: T_PLUS_2H }, T_EPOCH);
    expect(busy).toHaveLength(1);
    expect(busy[0].start.getTime()).toBe(T_PLUS_1H.getTime());
    expect(busy[0].end.getTime()).toBe(T_PLUS_90.getTime()); // 30-min duration
  });

  it('includes non-expired pending holds', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T_EPOCH, holdTtlMin: 10,
    });

    const busy = getBookingsBusy(db, userId, { from: T_EPOCH, to: T_PLUS_2H }, T_EPOCH);
    expect(busy).toHaveLength(1);
  });

  it('excludes expired holds', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T_EPOCH, holdTtlMin: 1,
    });

    // Ask 2 minutes later — hold has expired
    const nowLater = new Date(T_EPOCH.getTime() + 2 * 60_000);
    const busy = getBookingsBusy(db, userId, { from: T_EPOCH, to: T_PLUS_2H }, nowLater);
    expect(busy).toHaveLength(0);
  });

  it('excludes cancelled bookings', () => {
    const userId = insertUser(db);
    const { secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const hr = createHold(db, {
      page, validSlotStartMs: makeSlotSet(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com', now: T_EPOCH,
    });
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;
    confirmHold(db, hr.holdId, page.id, T_EPOCH);
    const bk = getBookingById(db, hr.holdId)!;
    cancelBooking(db, bk.cancelToken);

    const busy = getBookingsBusy(db, userId, { from: T_EPOCH, to: T_PLUS_2H }, T_EPOCH);
    expect(busy).toHaveLength(0);
  });
});

describe('generatePublishIcs', () => {
  const START = new Date('2024-06-15T10:00:00Z');
  const END   = new Date('2024-06-15T10:30:00Z');

  it('produces valid parseable VCALENDAR', () => {
    const ics = generatePublishIcs({
      uid: 'test-uid-123@calendyfind.local',
      startUtc: START,
      endUtc: END,
      summary: 'Test Meeting',
      organizerName: 'Organizer',
      organizerEmail: 'org@example.com',
      attendeeName: 'Guest',
      attendeeEmail: 'guest@example.com',
      createdAt: START,
      now: START,
    });

    const parsed = new ICAL.Component(ICAL.parse(ics));
    expect(parsed.name).toBe('vcalendar');
    expect(parsed.getFirstPropertyValue('method')).toBe('PUBLISH');

    const vevent = parsed.getFirstSubcomponent('vevent')!;
    expect(vevent).not.toBeNull();
    expect(vevent.getFirstPropertyValue('uid')).toBe('test-uid-123@calendyfind.local');
    expect(vevent.getFirstPropertyValue('summary')).toBe('Test Meeting');
  });

  it('has correct UTC start/end timestamps', () => {
    const ics = generatePublishIcs({
      uid: 'ts-test@calendyfind.local',
      startUtc: START,
      endUtc: END,
      summary: 'Time Test',
      organizerName: 'Org',
      organizerEmail: 'org@example.com',
      attendeeName: 'Guest',
      attendeeEmail: 'guest@example.com',
      createdAt: START,
      now: START,
    });

    const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!;
    const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time;
    const dtend   = vevent.getFirstPropertyValue('dtend') as ICAL.Time;

    expect(dtstart.toJSDate().getTime()).toBe(START.getTime());
    expect(dtend.toJSDate().getTime()).toBe(END.getTime());
  });

  it('uses CRLF line endings and folds long lines per RFC 5545', () => {
    const longSummary = 'A'.repeat(200);
    const ics = generatePublishIcs({
      uid: 'fold-test@calendyfind.local',
      startUtc: START, endUtc: END,
      summary: longSummary,
      organizerName: 'Org', organizerEmail: 'org@example.com',
      attendeeName: 'Guest', attendeeEmail: 'guest@example.com',
      createdAt: START, now: START,
    });

    expect(ics).toContain('\r\n');
    // Folded lines must not exceed 75 octets (continuation lines start with a space)
    const lines = ics.split('\r\n');
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf-8')).toBeLessThanOrEqual(75);
    }
  });

  it('UID is stable across calls with the same input', () => {
    const opts = {
      uid: 'stable-uid@calendyfind.local',
      startUtc: START, endUtc: END, summary: 'S',
      organizerName: 'O', organizerEmail: 'o@example.com',
      attendeeName: 'G', attendeeEmail: 'g@example.com',
      createdAt: START, now: START,
    };
    const ics1 = generatePublishIcs(opts);
    const ics2 = generatePublishIcs(opts);

    const uid1 = new ICAL.Component(ICAL.parse(ics1)).getFirstSubcomponent('vevent')!
      .getFirstPropertyValue('uid');
    const uid2 = new ICAL.Component(ICAL.parse(ics2)).getFirstSubcomponent('vevent')!
      .getFirstPropertyValue('uid');
    expect(uid1).toBe(uid2);
  });
});
