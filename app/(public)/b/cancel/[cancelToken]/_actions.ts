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

  // Get booking page to find the write target
  const page = booking.bookingPageId
    ? db
        .select({ writeTargetId: bookingPageTable.writeTargetId })
        .from(bookingPageTable)
        .where(eq(bookingPageTable.id, booking.bookingPageId))
        .get()
    : undefined;

  // Get organizer name + email for iMIP CANCEL
  const organizer = db
    .select({ name: userTable.name, email: userTable.email })
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

  // Best-effort: send iMIP METHOD:CANCEL email to attendee.
  if (organizer) {
    try {
      await sendCancelEmail({
        uid:            booking.icsUid,
        sequence:       booking.sequence,
        startUtc:       booking.startUtc!,
        endUtc:         booking.endUtc!,
        summary:        `Meeting with ${organizer.name}`,
        organizerName:  organizer.name,
        organizerEmail: organizer.email,
        attendeeName:   booking.attendeeName,
        attendeeEmail:  booking.attendeeEmail,
        createdAt:      booking.createdAt ?? now,
        now,
      });
    } catch { /* ignore */ }
  }

  appendAudit(db, { actor: 'public', action: 'booking.cancelled', targetType: 'booking', targetId: booking.id });
  redirect(`/b/cancel/${cancelToken}?cancelled=1`);
}
