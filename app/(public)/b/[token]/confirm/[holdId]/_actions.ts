'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { user as userTable, bookingPage as bookingPageTable } from '@/lib/db/schema';
import {
  getPageByToken,
  getBookingById,
  getWriteTargetById,
  finalizeBooking,
  setEmailFailed,
} from '@/lib/booking/holds';
import { getAdapter } from '@/lib/adapters';
import type { NewEvent } from '@/lib/adapters/interface';
import { sendInviteEmail } from '@/lib/email';
import { appendAudit } from '@/lib/audit';
import { scheduleRemindersForBooking } from '@/lib/reminders';

export async function confirmAction(token: string, holdId: string, visitorTz = '') {
  const now = new Date();
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? hdrs.get('x-real-ip') ?? undefined;

  const page = getPageByToken(db, token);
  if (!page || !page.active) redirect(`/b/${token}?error=Page+not+available`);

  // Idempotency: if already confirmed (double-submit), skip straight to success
  const hold = getBookingById(db, holdId);
  if (!hold || hold.bookingPageId !== page!.id) redirect(`/b/${token}?error=Invalid+request`);
  if (hold.status === 'confirmed') redirect(`/b/${token}/success/${holdId}`);
  if (hold.status !== 'pending_hold') redirect(`/b/${token}?error=Reservation+not+found`);
  if (hold.expiresAt && hold.expiresAt <= now) {
    redirect(`/b/${token}?error=Your+reservation+expired.+Please+choose+a+new+slot.`);
  }

  // Write target must be configured on this booking page
  if (!page!.writeTargetId) {
    redirect(`/b/${token}?error=Booking+not+configured+(no+write+target)`);
  }
  const target = getWriteTargetById(db, page!.writeTargetId);
  if (!target) {
    redirect(`/b/${token}?error=Booking+not+configured+(write+target+missing)`);
  }

  // Organizer name + email for iMIP (NEVER sent to client; used only for calendar/email)
  const organizer = db
    .select({ name: userTable.name, email: userTable.email, notificationEmail: userTable.notificationEmail })
    .from(userTable)
    .where(eq(userTable.id, page!.userId))
    .get();
  if (!organizer) redirect(`/b/${token}?error=Internal+error`);

  // Extra attendees: organizer's notification email + booking page's extra guests
  const extraAttendees: { name: string; email: string }[] = [];
  const extraRecipients: { name: string; email: string }[] = [];

  if (organizer!.notificationEmail) {
    const entry = { name: organizer!.name, email: organizer!.notificationEmail };
    extraAttendees.push(entry);
    extraRecipients.push(entry);
  }

  if (page!.extraGuests) {
    for (const raw of page!.extraGuests.split(',')) {
      const email = raw.trim();
      if (email) {
        const entry = { name: email, email };
        extraAttendees.push(entry);
        extraRecipients.push(entry);
      }
    }
  }

  const event: NewEvent = {
    uid:            hold.icsUid,
    sequence:       hold.sequence,
    startUtc:       hold.startUtc!,
    endUtc:         hold.endUtc!,
    summary:        page!.title,
    location:       page!.location ?? undefined,
    organizerName:  organizer!.name,
    organizerEmail: organizer!.email,
    attendeeName:   hold.attendeeName,
    attendeeEmail:  hold.attendeeEmail,
    extraAttendees: extraAttendees.length > 0 ? extraAttendees : undefined,
    createdAt:      hold.createdAt ?? now,
  };

  // Step 1 — Write to calendar.
  // If this fails the booking stays as pending_hold (expires naturally).
  // NEVER log decrypted credentials; the adapter decrypts internally.
  const adapter = getAdapter(target!.provider);
  let externalRef!: string;
  try {
    const calResult = await adapter.createEvent(target!, event);
    externalRef = calResult.externalRef;
    appendAudit(db, { actor: 'public', action: 'calendar.write_success', targetType: 'booking', targetId: holdId, ip });
  } catch {
    appendAudit(db, { actor: 'public', action: 'calendar.write_failure', targetType: 'booking', targetId: holdId, ip });
    redirect(`/b/${token}/confirm/${holdId}?error=Could+not+write+to+calendar.+Please+try+again.`);
  }

  // Step 2 — Atomically confirm + record externalRef.
  const finalizeResult = finalizeBooking(db, holdId, page!.id, externalRef, now);
  if (!finalizeResult.ok) {
    // Hold expired in the narrow window between calendar write and finalize.
    // Clean up the orphaned calendar event best-effort.
    try {
      await adapter.cancelEvent(target!, externalRef, event.uid, event.sequence + 1);
    } catch { /* ignore — it's a best-effort rollback */ }

    if (finalizeResult.reason === 'EXPIRED') {
      redirect(`/b/${token}?error=Your+reservation+expired.+Please+choose+a+new+slot.`);
    }
    redirect(`/b/${token}?error=Could+not+confirm+booking+(${finalizeResult.reason})`);
  }

  const bookingId = finalizeResult.booking.id;
  appendAudit(db, {
    actor: 'public',
    action: 'booking.confirmed',
    targetType: 'booking',
    targetId: bookingId,
    ip,
    metadata: { pageId: page!.id },
  });

  // Step 3 — Schedule reminder emails (idempotent; won't double-insert on retry).
  scheduleRemindersForBooking(db, { bookingId, startUtc: hold.startUtc! });

  // Step 4 — Best-effort: send iMIP METHOD:REQUEST invite.
  // Email failure does NOT roll back the booking — only sets emailFailed flag.
  try {
    await sendInviteEmail({ ...event, now, pageTitle: page!.title, extraRecipients });
    appendAudit(db, { actor: 'public', action: 'email.sent', targetType: 'booking', targetId: bookingId, ip });
  } catch {
    setEmailFailed(db, bookingId);
    appendAudit(db, { actor: 'public', action: 'email.failed', targetType: 'booking', targetId: bookingId, ip });
  }

  const tzParam = visitorTz ? `?tz=${encodeURIComponent(visitorTz)}` : '';
  redirect(`/b/${token}/success/${bookingId}${tzParam}`);
}
