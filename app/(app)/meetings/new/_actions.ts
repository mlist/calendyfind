'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { writeTarget as writeTargetTable, user as userTable } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getFreeSlots } from '@/lib/availability';
import { createInternalHold } from '@/lib/booking/internal';

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return session;
}

export async function holdInternalAction(formData: FormData) {
  const session = await requireSession();
  const organizerUserId = session!.user.id;

  const title       = (formData.get('title') as string)?.trim();
  const slotStartMs = Number(formData.get('slotStartMs'));
  const durationMin = Number(formData.get('durationMin'));
  const attendeeIds = (formData.getAll('attendeeId') as string[]).filter(Boolean);
  const writeTargetId = (formData.get('writeTargetId') as string)?.trim() || null;

  if (!title)                              redirect('/meetings/new?error=Title+is+required');
  if (!slotStartMs || !durationMin)        redirect('/meetings/new?error=Invalid+slot');
  if (attendeeIds.length === 0)            redirect('/meetings/new?error=Select+at+least+one+attendee');

  // Attendee must not include the organizer
  if (attendeeIds.includes(organizerUserId)) redirect('/meetings/new?error=You+are+automatically+the+organizer');

  // Resolve attendee user rows
  const allUsers = db.select().from(userTable).all();
  const attendees = attendeeIds.map(uid => {
    const u = allUsers.find(u => u.id === uid);
    if (!u) redirect('/meetings/new?error=Unknown+attendee');
    return { userId: u!.id, name: u!.name ?? u!.email, email: u!.email };
  });

  const allUserIds = [organizerUserId, ...attendeeIds];
  const slotStart  = new Date(slotStartMs);
  const now        = new Date();

  // Server-side recompute: NEVER trust the client's claim of availability.
  const range = {
    from: new Date(slotStart.getTime() - durationMin * 60_000),
    to:   new Date(slotStart.getTime() + 2 * durationMin * 60_000),
  };

  const { slots } = await getFreeSlots({
    userIds:     allUserIds,
    range,
    durationMin,
    bufferMin:   0,
    minNoticeMin: 0,
    now,
  });

  const validSlotStartMs = new Set(slots.map(s => s.start.getTime()));

  // Resolve organizer info
  const organizer = allUsers.find(u => u.id === organizerUserId);
  if (!organizer) redirect('/meetings/new?error=Organizer+not+found');

  // Resolve write target (use specified one, or default)
  let resolvedWriteTargetId: string | null = writeTargetId;
  if (!resolvedWriteTargetId) {
    const defaultTarget = db.select({ id: writeTargetTable.id })
      .from(writeTargetTable)
      .where(and(eq(writeTargetTable.userId, organizerUserId), eq(writeTargetTable.isDefault, true)))
      .get();
    resolvedWriteTargetId = defaultTarget?.id ?? null;
  } else {
    const target = db.select({ id: writeTargetTable.id })
      .from(writeTargetTable)
      .where(and(eq(writeTargetTable.id, resolvedWriteTargetId), eq(writeTargetTable.userId, organizerUserId)))
      .get();
    if (!target) redirect('/meetings/new?error=Invalid+write+target');
  }

  const result = createInternalHold(db, {
    organizerUserId,
    organizerName:  organizer!.name ?? organizer!.email,
    organizerEmail: organizer!.email,
    title: title!,
    durationMin,
    slotStart,
    validSlotStartMs,
    attendees,
    writeTargetId: resolvedWriteTargetId,
    now,
  });

  if (!result.ok) {
    const msg = result.reason === 'ATTENDEE_CONFLICT'
      ? 'An+attendee+is+no+longer+available+for+that+slot'
      : 'That+slot+is+no+longer+available';
    redirect(`/meetings/new?error=${msg}`);
  }

  redirect(`/meetings/${result.holdId}`);
}
