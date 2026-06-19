'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { booking as bookingTable, bookingAttendee as bookingAttendeeTable, user as userTable } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  finalizeInternalBooking,
  cancelInternalBooking,
  setAttendeeEmailFailed,
} from '@/lib/booking/internal';
import { getWriteTargetById } from '@/lib/booking/holds';
import { getAdapter } from '@/lib/adapters';
import { sendInternalInviteEmails, sendInternalCancelEmails } from '@/lib/email';
import type { NewEvent } from '@/lib/adapters/interface';
import { appendAudit } from '@/lib/audit';
import { scheduleRemindersForBooking } from '@/lib/reminders';

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session;
}

export async function confirmInternalAction(formData: FormData) {
  const session = await requireSession();
  const organizerUserId = session!.user.id;
  const bookingId = formData.get('bookingId') as string;
  if (!bookingId) redirect('/meetings?error=Invalid+request');

  const now = new Date();

  const holdRow = db.select().from(bookingTable)
    .where(and(eq(bookingTable.id, bookingId), eq(bookingTable.organizerUserId, organizerUserId)))
    .get();

  if (!holdRow)                          redirect(`/meetings/${bookingId}?error=Meeting+not+found`);
  if (holdRow!.status === 'confirmed')   redirect(`/meetings/${bookingId}`);
  if (holdRow!.status !== 'pending_hold') redirect(`/meetings/${bookingId}?error=Cannot+confirm+this+meeting`);
  if (holdRow!.expiresAt && holdRow!.expiresAt <= now) redirect(`/meetings/${bookingId}?error=Hold+expired`);

  const attendeeRows = db.select({
    userId: bookingAttendeeTable.userId,
    name:   userTable.name,
    email:  userTable.email,
  })
    .from(bookingAttendeeTable)
    .innerJoin(userTable, eq(bookingAttendeeTable.userId, userTable.id))
    .where(eq(bookingAttendeeTable.bookingId, bookingId))
    .all();

  const organizer = db.select().from(userTable)
    .where(eq(userTable.id, organizerUserId))
    .get();
  if (!organizer) redirect(`/meetings/${bookingId}?error=Organizer+not+found`);

  let externalRef: string | null = null;
  if (holdRow!.writeTargetId) {
    const target = getWriteTargetById(db, holdRow!.writeTargetId);
    if (target) {
      const adapter = getAdapter(target.provider);
      const event: NewEvent = {
        uid:            holdRow!.icsUid,
        sequence:       holdRow!.sequence ?? 0,
        startUtc:       holdRow!.startUtc!,
        endUtc:         holdRow!.endUtc!,
        summary:        holdRow!.title ?? 'Meeting',
        organizerName:  organizer!.name ?? organizer!.email,
        organizerEmail: organizer!.email,
        attendeeName:   attendeeRows[0]?.name ?? attendeeRows[0]?.email ?? '',
        attendeeEmail:  attendeeRows[0]?.email ?? '',
        createdAt:      holdRow!.createdAt ?? now,
      };
      try {
        const calResult = await adapter.createEvent(target, event);
        externalRef = calResult.externalRef;
      } catch {
        redirect(`/meetings/${bookingId}?error=Could+not+write+to+calendar`);
      }
    }
  }

  const finalizeResult = finalizeInternalBooking(db, bookingId, organizerUserId, externalRef, now);
  if (!finalizeResult.ok) {
    if (externalRef && holdRow!.writeTargetId) {
      const target = getWriteTargetById(db, holdRow!.writeTargetId);
      if (target) {
        try {
          await getAdapter(target.provider).cancelEvent(
            target, externalRef, holdRow!.icsUid, (holdRow!.sequence ?? 0) + 1,
          );
        } catch { /* best-effort orphan cleanup */ }
      }
    }
    redirect(`/meetings/${bookingId}?error=Hold+expired+or+already+confirmed`);
  }

  appendAudit(db, {
    actor: organizerUserId,
    action: 'booking.confirmed',
    targetType: 'booking',
    targetId: bookingId,
    metadata: { type: 'internal' },
  });

  // Schedule reminder emails for all attendees
  scheduleRemindersForBooking(db, { bookingId, startUtc: finalizeResult.booking.startUtc! });

  if (attendeeRows.length > 0) {
    const multiOpts = {
      uid:            holdRow!.icsUid,
      sequence:       finalizeResult.booking.sequence ?? 0,
      startUtc:       finalizeResult.booking.startUtc!,
      endUtc:         finalizeResult.booking.endUtc!,
      summary:        finalizeResult.booking.title ?? 'Meeting',
      organizerName:  organizer!.name ?? organizer!.email,
      organizerEmail: organizer!.email,
      attendees:      attendeeRows.map(a => ({ name: a.name ?? a.email, email: a.email })),
      createdAt:      finalizeResult.booking.createdAt ?? now,
      now,
    };
    try {
      const emailResults = await sendInternalInviteEmails(
        multiOpts,
        attendeeRows.map(a => ({ userId: a.userId, name: a.name ?? a.email, email: a.email })),
      );
      for (const r of emailResults) {
        if (r.error) setAttendeeEmailFailed(db, bookingId, r.userId);
      }
    } catch { /* best-effort */ }
  }

  redirect(`/meetings/${bookingId}`);
}

export async function cancelInternalAction(formData: FormData) {
  const session = await requireSession();
  const organizerUserId = session!.user.id;
  const bookingId = formData.get('bookingId') as string;
  if (!bookingId) redirect('/meetings?error=Invalid+request');

  const attendeeRows = db.select({
    userId: bookingAttendeeTable.userId,
    name:   userTable.name,
    email:  userTable.email,
  })
    .from(bookingAttendeeTable)
    .innerJoin(userTable, eq(bookingAttendeeTable.userId, userTable.id))
    .where(eq(bookingAttendeeTable.bookingId, bookingId))
    .all();

  const organizer = db.select().from(userTable)
    .where(eq(userTable.id, organizerUserId))
    .get();

  const result = cancelInternalBooking(db, bookingId, organizerUserId);
  if (!result.ok) {
    const msg = result.reason === 'NOT_ORGANIZER' ? 'Not+authorized' : 'Meeting+not+found';
    redirect(`/meetings/${bookingId}?error=${msg}`);
  }

  appendAudit(db, { actor: organizerUserId, action: 'booking.cancelled', targetType: 'booking', targetId: bookingId, metadata: { type: 'internal' } });

  if (result.booking.externalEventRef && result.booking.writeTargetId) {
    const target = getWriteTargetById(db, result.booking.writeTargetId);
    if (target) {
      try {
        await getAdapter(target.provider).cancelEvent(
          target,
          result.booking.externalEventRef,
          result.booking.icsUid,
          result.booking.sequence,
        );
      } catch { /* best-effort */ }
    }
  }

  if (attendeeRows.length > 0 && organizer) {
    const multiOpts = {
      uid:            result.booking.icsUid,
      sequence:       result.booking.sequence,
      startUtc:       result.booking.startUtc!,
      endUtc:         result.booking.endUtc!,
      summary:        result.booking.title ?? 'Meeting',
      organizerName:  organizer.name ?? organizer.email,
      organizerEmail: organizer.email,
      attendees:      attendeeRows.map(a => ({ name: a.name ?? a.email, email: a.email })),
      createdAt:      result.booking.createdAt ?? new Date(),
      now:            new Date(),
    };
    try {
      await sendInternalCancelEmails(
        multiOpts,
        attendeeRows.map(a => ({ userId: a.userId, name: a.name ?? a.email, email: a.email })),
      );
    } catch { /* best-effort */ }
  }

  redirect('/meetings');
}
