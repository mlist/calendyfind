/**
 * Reminder system.
 *
 * scheduleRemindersForBooking — called after a booking is confirmed.
 *   Inserts one reminder row per configured offset. Uses INSERT OR IGNORE so
 *   re-runs (server restart, idempotent re-confirm) are safe.
 *
 * processReminders — called by the scheduler on a regular interval.
 *   Claims due, unsent reminders one at a time via BEGIN IMMEDIATE, sends email,
 *   marks sentAt or failedAt. Idempotent: claiming is transactional so
 *   overlapping runs cannot double-send.
 *
 * REMINDER_OFFSETS_MIN — comma-separated offset list, e.g. "1440,60" (default 24h + 1h).
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { reminder as reminderTable, booking as bookingTable, bookingAttendee, user as userTable, bookingPage as bookingPageTable } from '@/lib/db/schema';
import { sendReminderEmail } from '@/lib/email';

function getReminderOffsets(): number[] {
  const raw = process.env.REMINDER_OFFSETS_MIN ?? '1440,60';
  return raw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);
}

export interface ReminderBookingInfo {
  bookingId: string;
  startUtc: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scheduleRemindersForBooking(db: BetterSQLite3Database<any>, info: ReminderBookingInfo): void {
  const offsets = getReminderOffsets();
  for (const offsetMin of offsets) {
    const scheduledFor = new Date(info.startUtc.getTime() - offsetMin * 60_000);
    if (scheduledFor <= new Date()) continue; // already past — skip

    try {
      db.insert(reminderTable).values({
        id: crypto.randomUUID(),
        bookingId: info.bookingId,
        offsetMin,
        scheduledFor,
      })
        .onConflictDoNothing()
        .run();
    } catch {
      // Silently ignore duplicate (idempotent)
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processReminders(db: BetterSQLite3Database<any>, now: Date): Promise<void> {
  // Find all due reminders: scheduledFor <= now AND sentAt IS NULL AND failedAt IS NULL (or retryCount < 3)
  const due = db
    .select()
    .from(reminderTable)
    .where(
      and(
        lte(reminderTable.scheduledFor, now),
        isNull(reminderTable.sentAt),
      ),
    )
    .all();

  for (const rem of due) {
    // Skip permanently failed (3+ retries)
    if (rem.retryCount >= 3 && rem.failedAt) continue;

    // Atomically claim: mark failedAt tentatively so concurrent runs skip it,
    // then clear it on success. We use a BEGIN IMMEDIATE transaction to claim.
    let claimed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).transaction((tx: any) => {
      // Re-read inside transaction to guard against concurrent runner
      const fresh = tx.select().from(reminderTable)
        .where(and(eq(reminderTable.id, rem.id), isNull(reminderTable.sentAt)))
        .get();
      if (!fresh) return; // already sent by another run
      if (fresh.retryCount >= 3 && fresh.failedAt) return;

      // Mark as in-progress by bumping retryCount; sentAt/failedAt stays null
      tx.update(reminderTable)
        .set({ retryCount: fresh.retryCount + 1 })
        .where(eq(reminderTable.id, rem.id))
        .run();
      claimed = true;
    }, { behavior: 'immediate' });

    if (!claimed) continue;

    // Load booking + recipient info outside transaction
    const bk = db.select().from(bookingTable).where(eq(bookingTable.id, rem.bookingId)).get();
    if (!bk || bk.status === 'cancelled') {
      // Don't send for cancelled bookings
      db.update(reminderTable).set({ sentAt: now }).where(eq(reminderTable.id, rem.id)).run();
      continue;
    }
    if (bk.startUtc && bk.startUtc <= now) {
      // Meeting already started — skip
      db.update(reminderTable).set({ sentAt: now }).where(eq(reminderTable.id, rem.id)).run();
      continue;
    }

    // Gather recipients: attendeeEmail + any bookingAttendee rows (internal meetings)
    const recipients: { name: string; email: string; cancelUrl?: string }[] = [];

    if (bk.attendeeEmail) {
      let cancelUrl: string | undefined;
      if (bk.cancelToken) {
        const base = process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL ?? '';
        cancelUrl = base ? `${base}/b/cancel/${bk.cancelToken}` : undefined;
      }
      recipients.push({ name: bk.attendeeName, email: bk.attendeeEmail, cancelUrl });
    }

    // For internal meetings also remind each attendee
    if (!bk.bookingPageId) {
      const attendeeRows = db
        .select({ name: userTable.name, email: userTable.email })
        .from(bookingAttendee)
        .innerJoin(userTable, eq(bookingAttendee.userId, userTable.id))
        .where(eq(bookingAttendee.bookingId, bk.id))
        .all();
      for (const a of attendeeRows) {
        recipients.push({ name: a.name ?? a.email, email: a.email });
      }
    }

    // Determine meeting summary
    let summary = bk.title ?? 'Meeting';
    if (bk.bookingPageId) {
      const page = db.select({ title: bookingPageTable.title }).from(bookingPageTable)
        .where(eq(bookingPageTable.id, bk.bookingPageId)).get();
      if (page) summary = page.title;
    }

    // Send to each recipient (best-effort; one failure doesn't block others)
    let anySuccess = false;
    let lastError: Error | null = null;
    for (const r of recipients) {
      try {
        await sendReminderEmail({
          recipientName: r.name,
          recipientEmail: r.email,
          summary,
          startUtc: bk.startUtc!,
          offsetMin: rem.offsetMin,
          cancelUrl: r.cancelUrl,
        });
        anySuccess = true;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (recipients.length === 0 || anySuccess) {
      db.update(reminderTable).set({ sentAt: now }).where(eq(reminderTable.id, rem.id)).run();
    } else {
      db.update(reminderTable)
        .set({ failedAt: now })
        .where(eq(reminderTable.id, rem.id))
        .run();
      if (lastError) console.error('[reminders] Failed to send reminder', rem.id, lastError);
    }
  }
}
