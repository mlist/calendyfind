/**
 * Integration tests for the Phase 4 confirm flow logic.
 * Tests calendar write failure, idempotency, and orphan-event cleanup —
 * the three correctness requirements from the spec.
 *
 * We simulate the server action logic directly (without Next.js redirect)
 * using the underlying `finalizeBooking` + a mock adapter.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '@/lib/db/schema';
import type { DB } from '@/lib/booking/holds';
import {
  createHold,
  finalizeBooking,
  getBookingById,
  getPageByToken,
} from '@/lib/booking/holds';
import type { CalendarWriteAdapter } from '@/lib/adapters/interface';
import type { NewEvent } from '@/lib/adapters/interface';

// ─── in-memory DB helpers (same pattern as holds.test.ts) ─────────────────────

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

const T = new Date('2024-06-01T09:00:00Z');
const T_PLUS_1H = new Date(T.getTime() + 60 * 60_000);

function insertUser(db: DB) {
  const id = `user-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.user).values({
    id, name: 'Owner', email: `owner-${id}@example.com`,
    emailVerified: false, timezone: 'UTC', createdAt: T, updatedAt: T,
  }).run();
  return id;
}

function insertPage(db: DB, userId: string, writeTargetId: string | null = null) {
  const id = `page-${Math.random().toString(36).slice(2)}`;
  const secretToken = `tok-${Math.random().toString(36).slice(2)}`;
  db.insert(schema.bookingPage).values({
    id, userId, secretToken, title: 'Office Hours',
    durationMin: 30, bufferMin: 0, minNoticeMin: 0, maxAdvanceDays: 30,
    active: true, writeTargetId, createdAt: T,
  }).run();
  return { id, secretToken };
}

function makeSlot(...starts: Date[]) {
  return new Set(starts.map(d => d.getTime()));
}

function makeEvent(hold: ReturnType<typeof getBookingById>): NewEvent {
  return {
    uid:            hold!.icsUid,
    sequence:       hold!.sequence,
    startUtc:       hold!.startUtc!,
    endUtc:         hold!.endUtc!,
    summary:        'Test Meeting',
    organizerName:  'Owner',
    organizerEmail: 'owner@example.com',
    attendeeName:   hold!.attendeeName,
    attendeeEmail:  hold!.attendeeEmail,
    createdAt:      hold!.createdAt ?? T,
  };
}

// Simulates the core Phase 4 confirm flow logic (mirrors confirmAction, no Next.js redirect).
// checkNow is used for the pre-flight expiry check (before calendar write).
// finalizeNow is used when calling finalizeBooking — lets tests simulate the race window
// where the hold expires between the calendar write and the finalize.
async function simulateConfirmFlow(
  db: DB,
  holdId: string,
  pageId: string,
  adapter: CalendarWriteAdapter,
  checkNow: Date,
  finalizeNow: Date = checkNow,
) {
  const hold = getBookingById(db, holdId);
  if (!hold) return { outcome: 'NOT_FOUND' } as const;
  if (hold.status === 'confirmed') return { outcome: 'ALREADY_CONFIRMED', bookingId: holdId } as const;
  if (hold.bookingPageId !== pageId) return { outcome: 'WRONG_PAGE' } as const;
  if (hold.expiresAt && hold.expiresAt <= checkNow) return { outcome: 'EXPIRED' } as const;

  const event = makeEvent(hold);

  let externalRef: string;
  try {
    const r = await adapter.createEvent({} as never, event);
    externalRef = r.externalRef;
  } catch (e) {
    return { outcome: 'CALENDAR_WRITE_FAILED', error: e } as const;
  }

  // Use finalizeNow — may differ from checkNow to simulate hold expiring mid-flight
  const result = finalizeBooking(db, holdId, pageId, externalRef!, finalizeNow);
  if (!result.ok) {
    // Orphan cleanup: the calendar event was written but finalize failed
    try {
      await adapter.cancelEvent({} as never, externalRef!, event.uid, event.sequence + 1);
    } catch { /* ignore */ }
    return { outcome: 'FINALIZE_FAILED', reason: result.reason } as const;
  }

  return { outcome: 'CONFIRMED', bookingId: result.booking.id } as const;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('confirm flow — calendar write failure', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('keeps booking as pending_hold when createEvent throws', async () => {
    const userId = insertUser(db);
    const { id: pageId, secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const holdResult = createHold(db, {
      page,
      validSlotStartMs: makeSlot(T_PLUS_1H),
      slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T, holdTtlMin: 60,
    });
    expect(holdResult.ok).toBe(true);
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    const failingAdapter: CalendarWriteAdapter = {
      createEvent: vi.fn().mockRejectedValue(new Error('Network error')),
      cancelEvent: vi.fn(),
    };

    const result = await simulateConfirmFlow(db, holdId, pageId, failingAdapter, T);

    expect(result.outcome).toBe('CALENDAR_WRITE_FAILED');

    // Booking must still be pending_hold — never confirmed
    const booking = getBookingById(db, holdId);
    expect(booking?.status).toBe('pending_hold');
    expect(failingAdapter.cancelEvent).not.toHaveBeenCalled();
  });
});

describe('confirm flow — idempotency', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('second finalizeBooking call returns ALREADY_CONFIRMED', async () => {
    const userId = insertUser(db);
    const { id: pageId, secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const holdResult = createHold(db, {
      page, validSlotStartMs: makeSlot(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T, holdTtlMin: 60,
    });
    expect(holdResult.ok).toBe(true);
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    const first = finalizeBooking(db, holdId, pageId, 'gcal-event-1', T);
    expect(first.ok).toBe(true);

    const second = finalizeBooking(db, holdId, pageId, 'gcal-event-2', T);
    expect(second.ok).toBe(false);
    expect((second as Extract<typeof second, { ok: false }>).reason).toBe('ALREADY_CONFIRMED');
  });

  it('simulateConfirmFlow with already-confirmed hold returns ALREADY_CONFIRMED', async () => {
    const userId = insertUser(db);
    const { id: pageId, secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    const holdResult = createHold(db, {
      page, validSlotStartMs: makeSlot(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Alice', attendeeEmail: 'alice@example.com',
      now: T, holdTtlMin: 60,
    });
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    // Confirm once
    finalizeBooking(db, holdId, pageId, 'gcal-event-1', T);

    // Second attempt via simulate flow — must not call createEvent again
    const adapter: CalendarWriteAdapter = {
      createEvent: vi.fn(),
      cancelEvent: vi.fn(),
    };
    const result = await simulateConfirmFlow(db, holdId, pageId, adapter, T);

    expect(result.outcome).toBe('ALREADY_CONFIRMED');
    expect(adapter.createEvent).not.toHaveBeenCalled();
  });
});

describe('confirm flow — orphan cleanup on finalize failure', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('calls cancelEvent with the externalRef when finalizeBooking returns EXPIRED', async () => {
    const userId = insertUser(db);
    const { id: pageId, secretToken } = insertPage(db, userId);
    const page = getPageByToken(db, secretToken)!;

    // Hold TTL = 1 min, created at T → expires at T + 1 min
    const holdResult = createHold(db, {
      page, validSlotStartMs: makeSlot(T_PLUS_1H), slotStart: T_PLUS_1H,
      attendeeName: 'Bob', attendeeEmail: 'bob@example.com',
      now: T, holdTtlMin: 1,
    });
    expect(holdResult.ok).toBe(true);
    const holdId = (holdResult as Extract<typeof holdResult, { ok: true }>).holdId;

    const cancelEventSpy = vi.fn().mockResolvedValue(undefined);
    const adapter: CalendarWriteAdapter = {
      createEvent: vi.fn().mockResolvedValue({ externalRef: 'gcal-orphan-event-id' }),
      cancelEvent: cancelEventSpy,
    };

    // checkNow = T (hold valid — pre-check passes)
    // finalizeNow = T + 2 min (hold expired in the meantime — race window)
    const T_PLUS_2M = new Date(T.getTime() + 2 * 60_000);
    const result = await simulateConfirmFlow(db, holdId, pageId, adapter, T, T_PLUS_2M);

    expect(result.outcome).toBe('FINALIZE_FAILED');
    expect((result as Extract<typeof result, { outcome: 'FINALIZE_FAILED' }>).reason).toBe('EXPIRED');

    // Orphan cleanup: cancelEvent must have been called with the externalRef returned by createEvent
    expect(cancelEventSpy).toHaveBeenCalledOnce();
    expect(cancelEventSpy.mock.calls[0]![1]).toBe('gcal-orphan-event-id');
  });
});
