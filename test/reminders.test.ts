import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'path';
import * as schema from '@/lib/db/schema';
import { scheduleRemindersForBooking, processReminders } from '@/lib/reminders';
import { reminder as reminderTable, booking as bookingTable, user as userTable, bookingPage as bookingPageTable } from '@/lib/db/schema';
import { eq, isNull } from 'drizzle-orm';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return db;
}

function makeUser(db: ReturnType<typeof makeDb>) {
  db.insert(userTable).values({
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run();
}

function makePage(db: ReturnType<typeof makeDb>) {
  db.insert(bookingPageTable).values({
    id: 'page-1',
    userId: 'user-1',
    secretToken: 'tok-abc',
    title: 'Test Page',
    durationMin: 30,
    bufferMin: 0,
    minNoticeMin: 60,
    maxAdvanceDays: 30,
    active: true,
  }).run();
}

function makeBooking(db: ReturnType<typeof makeDb>, startUtc: Date) {
  const id = 'bk-' + Math.random().toString(36).slice(2);
  db.insert(bookingTable).values({
    id,
    bookingPageId: 'page-1',
    organizerUserId: 'user-1',
    attendeeName: 'Alice',
    attendeeEmail: 'alice@example.com',
    startUtc,
    endUtc: new Date(startUtc.getTime() + 30 * 60_000),
    status: 'confirmed',
    icsUid: `uid-${id}`,
    cancelToken: `ct-${id}`,
    sequence: 0,
  }).run();
  return id;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env.REMINDER_OFFSETS_MIN = '';
});

describe('reminder scheduling', () => {
  it('inserts one reminder row per offset', () => {
    const db = makeDb();
    makeUser(db);
    makePage(db);
    process.env.REMINDER_OFFSETS_MIN = '1440,60';
    const startUtc = new Date(Date.now() + 3 * 24 * 60 * 60_000); // 3 days from now
    const bookingId = makeBooking(db, startUtc);

    scheduleRemindersForBooking(db, { bookingId, startUtc });

    const rows = db.select().from(reminderTable).where(eq(reminderTable.bookingId, bookingId)).all();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.offsetMin).sort((a, b) => a - b)).toEqual([60, 1440]);
  });

  it('is idempotent — double scheduling inserts no duplicates', () => {
    const db = makeDb();
    makeUser(db);
    makePage(db);
    process.env.REMINDER_OFFSETS_MIN = '1440';
    const startUtc = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    const bookingId = makeBooking(db, startUtc);

    scheduleRemindersForBooking(db, { bookingId, startUtc });
    scheduleRemindersForBooking(db, { bookingId, startUtc }); // duplicate

    const rows = db.select().from(reminderTable).where(eq(reminderTable.bookingId, bookingId)).all();
    expect(rows).toHaveLength(1);
  });

  it('skips past offsets', () => {
    const db = makeDb();
    makeUser(db);
    makePage(db);
    process.env.REMINDER_OFFSETS_MIN = '60,1440';
    // Booking 90 minutes from now — 24h offset is in the past
    const startUtc = new Date(Date.now() + 90 * 60_000);
    const bookingId = makeBooking(db, startUtc);

    scheduleRemindersForBooking(db, { bookingId, startUtc });

    const rows = db.select().from(reminderTable).where(eq(reminderTable.bookingId, bookingId)).all();
    // 1440 min = 24h ago from now+90min is past → skipped; only 60 min remains
    expect(rows).toHaveLength(1);
    expect(rows[0].offsetMin).toBe(60);
  });

  it('processReminders: skips cancelled bookings', async () => {
    const db = makeDb();
    makeUser(db);
    makePage(db);
    process.env.REMINDER_OFFSETS_MIN = '60';

    const startUtc = new Date(Date.now() + 30 * 60_000);
    const bookingId = makeBooking(db, startUtc);

    // Cancel the booking
    db.update(bookingTable).set({ status: 'cancelled' }).where(eq(bookingTable.id, bookingId)).run();

    // Insert a due reminder manually
    db.insert(reminderTable).values({
      id: 'rem-1',
      bookingId,
      offsetMin: 60,
      scheduledFor: new Date(Date.now() - 5000), // already due
    }).run();

    const mockSend = vi.fn();
    vi.doMock('@/lib/email', () => ({ sendReminderEmail: mockSend }));

    await processReminders(db, new Date());

    // sentAt should be set (silently "sent" — booking cancelled), but email not called
    const rem = db.select().from(reminderTable).where(eq(reminderTable.id, 'rem-1')).get();
    expect(rem!.sentAt).not.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('processReminders: does not re-send already-sent reminders', async () => {
    const db = makeDb();
    makeUser(db);
    makePage(db);

    const startUtc = new Date(Date.now() + 2 * 60 * 60_000);
    const bookingId = makeBooking(db, startUtc);

    const sentAt = new Date();
    db.insert(reminderTable).values({
      id: 'rem-already-sent',
      bookingId,
      offsetMin: 60,
      scheduledFor: new Date(Date.now() - 5000),
      sentAt,
    }).run();

    const mockSend = vi.fn();
    vi.doMock('@/lib/email', () => ({ sendReminderEmail: mockSend }));

    await processReminders(db, new Date());

    // sentAt should remain unchanged (within SQLite's 1s timestamp resolution); email not called again
    const rem = db.select().from(reminderTable).where(eq(reminderTable.id, 'rem-already-sent')).get();
    expect(rem!.sentAt).toBeTruthy();
    // SQLite stores timestamps as integer seconds; allow ±1s tolerance
    expect(Math.abs(rem!.sentAt!.getTime() - sentAt.getTime())).toBeLessThan(2000);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
