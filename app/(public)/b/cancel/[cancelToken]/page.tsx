import { db } from '@/lib/db';
import { getBookingByCancelToken, getPageByToken } from '@/lib/booking/holds';
import { bookingPage as bookingPageTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { user as userTable } from '@/lib/db/schema';
import { cancelAction } from './_actions';

export default async function CancelPage({
  params,
  searchParams,
}: {
  params: Promise<{ cancelToken: string }>;
  searchParams: Promise<{ error?: string; cancelled?: string }>;
}) {
  const { cancelToken } = await params;
  const sp = await searchParams;

  if (sp.cancelled === '1') {
    return (
      <main style={{ maxWidth: 400, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui', textAlign: 'center' }}>
        <h1>Booking cancelled</h1>
        <p>Your booking has been cancelled and the time slot is now free.</p>
      </main>
    );
  }

  const bk = getBookingByCancelToken(db, cancelToken);
  if (!bk || bk.status === 'cancelled') {
    return (
      <main style={{ maxWidth: 400, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui', textAlign: 'center' }}>
        <h1>Not found</h1>
        <p>This cancel link is invalid or the booking has already been cancelled.</p>
      </main>
    );
  }

  const page = bk.bookingPageId
    ? db.select().from(bookingPageTable).where(eq(bookingPageTable.id, bk.bookingPageId)).get()
    : null;
  const owner = page
    ? db.select({ timezone: userTable.timezone }).from(userTable).where(eq(userTable.id, page.userId)).get()
    : null;
  const ownerTz = owner?.timezone ?? 'UTC';

  const startLocal = DateTime.fromJSDate(bk.startUtc!, { zone: 'UTC' }).setZone(ownerTz);
  const endLocal   = DateTime.fromJSDate(bk.endUtc!,   { zone: 'UTC' }).setZone(ownerTz);

  const cancelWithToken = cancelAction.bind(null, cancelToken);

  return (
    <main style={{ maxWidth: 450, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Cancel booking</h1>

      {sp.error && <p style={{ color: 'crimson' }}>{decodeURIComponent(sp.error)}</p>}

      <p>Are you sure you want to cancel this booking?</p>
      <table style={{ marginBottom: '1.5rem', borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ padding: '6px', color: '#555' }}>Event</td><td style={{ padding: '6px' }}><strong>{page?.title}</strong></td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Date</td><td style={{ padding: '6px' }}>{startLocal.toFormat('cccc, LLLL d, yyyy')}</td></tr>
          <tr><td style={{ padding: '6px', color: '#555' }}>Time</td><td style={{ padding: '6px' }}>{startLocal.toFormat('h:mm a')} – {endLocal.toFormat('h:mm a ZZZZ')}</td></tr>
        </tbody>
      </table>

      <form action={cancelWithToken}>
        <button type="submit" style={{ padding: '0.6rem 1.5rem', background: 'crimson', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Yes, cancel this booking
        </button>
      </form>
    </main>
  );
}
