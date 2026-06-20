'use server';

import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { user as userTable, bookingPage as bookingPageTable } from '@/lib/db/schema';
import { cancelBooking, getWriteTargetById } from '@/lib/booking/holds';
import { getAdapter } from '@/lib/adapters';
import { sendCancelEmail } from '@/lib/email';
import { appendAudit } from '@/lib/audit';

export async function cancelAction(cancelToken: string) {
  const result = cancelBooking(db, cancelToken);
  if (!result.ok) {
    redirect(`/b/cancel/${cancelToken}?error=Booking+not+found+or+already+cancelled`);
  }

  const booking = result.booking;
  const now = new Date();

  // Get booking page to find the write target and extra guests
  const page = booking.bookingPageId
    ? db
        .select({ writeTargetId: bookingPageTable.writeTargetId, extraGuests: bookingPageTable.extraGuests })
        .from(bookingPageTable)
        .where(eq(bookingPageTable.id, booking.bookingPageId))
        .get()
    : undefined;

  // Get organizer name + email + notification email for iMIP CANCEL
  const organizer = db
    .select({ name: userTable.name, email: userTable.email, notificationEmail: userTable.notificationEmail })
    .from(userTable)
    .where(eq(userTable.id, booking.organizerUserId))
    .get();

  // Best-effort: delete event from the write target calendar.
  // Failure here is non-fatal; the booking is already cancelled in the DB.
  if (booking.externalEventRef && page?.writeTargetId) {
    const target = getWriteTargetById(db, page.writeTargetId);
    if (target) {
      try {
        const adapter = getAdapter(target.provider);
        await adapter.cancelEvent(
          target,
          booking.externalEventRef,
          booking.icsUid,
          booking.sequence,
        );
      } catch { /* ignore */ }
    }
  }

  // Best-effort: send iMIP METHOD:CANCEL email to attendee + extra recipients.
  if (organizer) {
    const extraRecipients: { name: string; email: string }[] = [];
    if (organizer.notificationEmail) {
      extraRecipients.push({ name: organizer.name, email: organizer.notificationEmail });
    }
    if (page?.extraGuests) {
      for (const raw of page.extraGuests.split(',')) {
        const email = raw.trim();
        if (email) extraRecipients.push({ name: email, email });
      }
    }

    try {
      await sendCancelEmail({
        uid:            booking.icsUid,
        sequence:       booking.sequence,
        startUtc:       booking.startUtc!,
        endUtc:         booking.endUtc!,
        summary:        booking.title ? `${booking.title}` : `Meeting with ${organizer.name}`,
        organizerName:  organizer.name,
        organizerEmail: organizer.email,
        attendeeName:   booking.attendeeName,
        attendeeEmail:  booking.attendeeEmail,
        createdAt:      booking.createdAt ?? now,
        now,
        extraRecipients,
      });
    } catch { /* ignore */ }
  }

  appendAudit(db, { actor: 'public', action: 'booking.cancelled', targetType: 'booking', targetId: booking.id });
  redirect(`/b/cancel/${cancelToken}?cancelled=1`);
}
