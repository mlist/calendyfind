import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { user as userTable } from '@/lib/db/schema';
import { getBookingByCancelToken } from '@/lib/booking/holds';
import { generatePublishIcs } from '@/lib/ics';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cancelToken: string }> },
) {
  const { cancelToken } = await params;

  const bk = getBookingByCancelToken(db, cancelToken);
  if (!bk || bk.status === 'cancelled') {
    return new NextResponse('Not found', { status: 404 });
  }

  const owner = db.select({ name: userTable.name, email: userTable.email })
    .from(userTable).where(eq(userTable.id, bk.organizerUserId)).get();

  const icsText = generatePublishIcs({
    uid:            bk.icsUid,
    startUtc:       bk.startUtc!,
    endUtc:         bk.endUtc!,
    summary:        bk.attendeeName ? `Meeting with ${bk.attendeeName}` : 'Booking',
    organizerName:  owner?.name ?? 'Organizer',
    organizerEmail: owner?.email ?? 'noreply@calendyfind.local',
    attendeeName:   bk.attendeeName,
    attendeeEmail:  bk.attendeeEmail,
    createdAt:      bk.createdAt!,
    now:            new Date(),
  });

  return new NextResponse(icsText, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="booking-${bk.id.slice(0, 8)}.ics"`,
    },
  });
}
