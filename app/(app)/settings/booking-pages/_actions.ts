'use server';

import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPage, writeTarget, booking as bookingTable, user as userTable } from '@/lib/db/schema';
import { getWriteTargetById } from '@/lib/booking/holds';
import { getAdapter } from '@/lib/adapters';
import { sendCancelEmail } from '@/lib/email';
import { appendAudit } from '@/lib/audit';

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session.user;
}

function getIp() {
  // headers() is async — callers that need IP must await headers() themselves
  return undefined;
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createPageAction(formData: FormData) {
  const user = await requireUser();

  const title       = (formData.get('title') as string)?.trim();
  const durationMin = Number(formData.get('durationMin') ?? '30');
  const bufferMin   = Number(formData.get('bufferMin')   ?? '0');
  const minNoticeMin = Number(formData.get('minNoticeMin') ?? '60');
  const maxAdvanceDays = Number(formData.get('maxAdvanceDays') ?? '30');
  const location    = (formData.get('location') as string)?.trim() || null;
  const writeTargetId = (formData.get('writeTargetId') as string)?.trim() || null;

  if (!title)        redirect('/settings/booking-pages?error=Title+is+required');
  if (durationMin < 5 || durationMin > 480) redirect('/settings/booking-pages?error=Duration+must+be+5–480+min');
  if (bufferMin < 0 || bufferMin > 120)     redirect('/settings/booking-pages?error=Buffer+must+be+0–120+min');
  if (minNoticeMin < 0)                     redirect('/settings/booking-pages?error=Min+notice+must+be+≥0');
  if (maxAdvanceDays < 1)                   redirect('/settings/booking-pages?error=Max+advance+must+be+≥1');

  // Verify writeTargetId belongs to this user
  if (writeTargetId) {
    const wt = db.select({ id: writeTarget.id }).from(writeTarget)
      .where(and(eq(writeTarget.id, writeTargetId), eq(writeTarget.userId, user.id)))
      .get();
    if (!wt) redirect('/settings/booking-pages?error=Invalid+write+target');
  }

  const id = crypto.randomUUID();
  db.insert(bookingPage).values({
    id,
    userId: user.id,
    secretToken: generateToken(),
    title,
    durationMin,
    bufferMin,
    minNoticeMin,
    maxAdvanceDays,
    location,
    writeTargetId,
    active: true,
  }).run();

  appendAudit(db, { actor: user.id, action: 'booking_page.create', targetType: 'booking_page', targetId: id });
  revalidatePath('/settings/booking-pages');
  redirect(`/settings/booking-pages/${id}?success=Page+created`);
}

export async function updatePageAction(formData: FormData) {
  const user = await requireUser();
  const id = formData.get('id') as string;

  const page = db.select().from(bookingPage)
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, user.id)))
    .get();
  if (!page) redirect('/settings/booking-pages?error=Not+found');

  const title       = (formData.get('title') as string)?.trim();
  const durationMin = Number(formData.get('durationMin'));
  const bufferMin   = Number(formData.get('bufferMin'));
  const minNoticeMin = Number(formData.get('minNoticeMin'));
  const maxAdvanceDays = Number(formData.get('maxAdvanceDays'));
  const location    = (formData.get('location') as string)?.trim() || null;
  const writeTargetId = (formData.get('writeTargetId') as string)?.trim() || null;

  if (!title) redirect(`/settings/booking-pages/${id}?error=Title+is+required`);

  if (writeTargetId) {
    const wt = db.select({ id: writeTarget.id }).from(writeTarget)
      .where(and(eq(writeTarget.id, writeTargetId), eq(writeTarget.userId, user.id)))
      .get();
    if (!wt) redirect(`/settings/booking-pages/${id}?error=Invalid+write+target`);
  }

  db.update(bookingPage).set({ title, durationMin, bufferMin, minNoticeMin, maxAdvanceDays, location, writeTargetId })
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, user.id)))
    .run();

  revalidatePath('/settings/booking-pages');
  redirect(`/settings/booking-pages/${id}?success=Saved`);
}

export async function toggleActiveAction(formData: FormData) {
  const user = await requireUser();
  const id = formData.get('id') as string;
  const active = formData.get('active') === '1';

  db.update(bookingPage).set({ active })
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, user.id)))
    .run();

  revalidatePath('/settings/booking-pages');
  redirect(`/settings/booking-pages/${id}?success=${active ? 'Page+activated' : 'Page+deactivated'}`);
}

export async function rotateTokenAction(formData: FormData) {
  const user = await requireUser();
  const id = formData.get('id') as string;

  const now = new Date();
  db.update(bookingPage).set({ secretToken: generateToken(), tokenRotatedAt: now })
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, user.id)))
    .run();

  appendAudit(db, { actor: user.id, action: 'booking_page.token_rotate', targetType: 'booking_page', targetId: id });
  revalidatePath('/settings/booking-pages');
  redirect(`/settings/booking-pages/${id}?success=Link+rotated+%E2%80%94+old+link+is+now+dead`);
}

export async function ownerCancelBookingAction(formData: FormData) {
  const user = await requireUser();
  const bookingId = formData.get('bookingId') as string;
  const pageId    = formData.get('pageId')    as string;

  // Verify this booking belongs to a page owned by the current user
  const b = db.select().from(bookingTable)
    .where(and(eq(bookingTable.id, bookingId), eq(bookingTable.organizerUserId, user.id)))
    .get();
  if (!b) redirect(`/settings/booking-pages/${pageId}?error=Booking+not+found`);
  if (b.status === 'cancelled') {
    redirect(`/settings/booking-pages/${pageId}?error=Already+cancelled`);
  }

  const now = new Date();
  const newSeq = (b.sequence ?? 0) + 1;
  db.update(bookingTable)
    .set({ status: 'cancelled', expiresAt: null, sequence: newSeq })
    .where(eq(bookingTable.id, bookingId))
    .run();

  // Get page for write target (bookingPageId is null for internal meetings)
  const page = b.bookingPageId
    ? db.select({ writeTargetId: bookingPage.writeTargetId })
      .from(bookingPage)
      .where(eq(bookingPage.id, b.bookingPageId))
      .get()
    : null;

  // Get organizer info for iMIP CANCEL
  const organizer = db.select({ name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, user.id))
    .get();

  // Best-effort: delete from calendar
  if (b.externalEventRef && page?.writeTargetId) {
    const target = getWriteTargetById(db, page.writeTargetId);
    if (target) {
      try {
        const adapter = getAdapter(target.provider);
        await adapter.cancelEvent(target, b.externalEventRef, b.icsUid, newSeq);
      } catch { /* ignore */ }
    }
  }

  // Best-effort: send iMIP CANCEL email to attendee
  if (organizer) {
    try {
      await sendCancelEmail({
        uid:            b.icsUid,
        sequence:       newSeq,
        startUtc:       b.startUtc!,
        endUtc:         b.endUtc!,
        summary:        `Meeting with ${organizer.name}`,
        organizerName:  organizer.name,
        organizerEmail: organizer.email,
        attendeeName:   b.attendeeName,
        attendeeEmail:  b.attendeeEmail,
        createdAt:      b.createdAt ?? now,
        now,
      });
    } catch { /* ignore */ }
  }

  revalidatePath(`/settings/booking-pages/${pageId}`);
  redirect(`/settings/booking-pages/${pageId}?success=Booking+cancelled`);
}

export async function deletePageAction(formData: FormData) {
  const user = await requireUser();
  const id = formData.get('id') as string;
  const confirm = formData.get('confirm') as string;

  if (confirm !== 'DELETE') redirect(`/settings/booking-pages/${id}?error=Type+DELETE+to+confirm`);

  db.delete(bookingPage)
    .where(and(eq(bookingPage.id, id), eq(bookingPage.userId, user.id)))
    .run();

  appendAudit(db, { actor: user.id, action: 'booking_page.delete', targetType: 'booking_page', targetId: id });
  revalidatePath('/settings/booking-pages');
  redirect('/settings/booking-pages?success=Page+deleted');
}
